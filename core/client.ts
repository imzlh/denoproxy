import { DnsType, HTTPResponse, MessageType, type ProxyMessage } from "./protocol.ts";
import { decodeMessage, encodeMessage } from "./codec.ts";
import { CommandHandler } from "./command.ts";
import { Log } from "@cross/log";
import { decode, encode } from "../utils/bjson.ts";
import { getErrMsg } from "../utils/error.ts";

const DEFAULT_TIMEOUT = 30000; // 30秒默认超时
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 60000;
const MAX_QUEUE_SIZE = 1000; // 最大消息队列大小

type QueuedMessage = {
    type: MessageType;
    resourceId: number;
    data: Uint8Array;
};

type PendingHandler = {
    resolve: (data: Uint8Array) => any;
    reject: (err: Error) => void;
    stream?: ReadableStreamDefaultController<Uint8Array>;
    timeout?: number;
    chunked?: boolean
};

export default class ProxyClient {
    private nextId = 1;
    private pending = new Map<number, PendingHandler>();
    private commandHandler: CommandHandler;
    private ws: WebSocket | null = null;
    private messageQueue: QueuedMessage[] = [];
    private isClosed = false;
    private heartbeatInterval?: number;
    private heartbeatTimeout?: number;
    private lastHeartbeat = 0;
    private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

    constructor(private logger: Log) {
        const sendTextFn = this.sendText.bind(this);
        this.commandHandler = new CommandHandler(sendTextFn, logger, false);
    }

    assign(ws: WebSocket) {
        if (this.ws) {
            this.logger.debug("Reassigning WebSocket to client");
            this.cleanupWebSocketListeners();
        }

        this.ws = ws;
        this.isClosed = false;
        this.connectionState = 'connecting';
        ws.binaryType = "arraybuffer";

        ws.addEventListener("message", this.onMessage);
        ws.addEventListener("close", this.onClose);
        ws.addEventListener("error", this.onError);

        this.flushQueue();
        this.startHeartbeat();

        this.logger.info("ProxyClient assigned to WebSocket", {
            queuedMessages: this.messageQueue.length
        });
    }

    private cleanupWebSocketListeners() {
        if (!this.ws) return;
        this.ws.removeEventListener("message", this.onMessage);
        this.ws.removeEventListener("close", this.onClose);
        this.ws.removeEventListener("error", this.onError);
    }

    private onMessage = (event: MessageEvent) => {
        // Check if it's a text message (commands)
        if (typeof event.data === "string") {
            this.handleTextCommand(event.data);
            return;
        }
        
        // Binary message
        const data = new Uint8Array(event.data as ArrayBuffer);
        this.handleMessage(data);
    };

    private onError = (event: Event) => {
        this.logger.error("WebSocket error", { 
            state: this.connectionState,
            readyState: this.ws?.readyState 
        });
        this.handleDisconnect();
    };

    private handleTextCommand(text: string) {
        this.logger.debug(`Received command: ${text}`);

        const handled = this.commandHandler.handleCommand(text);
        if (!handled) {
            this.logger.warn(`Unknown command format: ${text}`);
        }
    }

    private onClose = () => this.handleDisconnect();

    private handleDisconnect() {
        if (this.isClosed) return;
        this.isClosed = true;
        this.connectionState = 'disconnected';

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);

        const pendingCount = this.pending.size;
        if (pendingCount > 0) {
            this.logger.warn(`Cleaning up ${pendingCount} pending requests due to disconnect`);
        }

        for (const [id, handler] of this.pending) {
            handler.reject(new Error("Connection closed"));
        }
        this.pending.clear();
    }

    private flushQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const queue = this.messageQueue;
        this.messageQueue = [];

        if (queue.length > 0) {
            this.logger.debug("Flushing client message queue", {
                messageCount: queue.length
            });
        }

        for (const msg of queue) {
            try {
                const encoded = encodeMessage(msg);
                this.ws.send(encoded);
            } catch (err) {
                this.logger.error("Failed to send queued message", {
                    error: getErrMsg(err),
                    type: msg.type,
                    resourceId: msg.resourceId
                });
            }
        }
    }

    async connectTCP(host: string, port: number, timeout = DEFAULT_TIMEOUT): Promise<TCPStream> {
        if (this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }

        const id = this.nextId++;
        this.logger.debug("Connecting TCP", { id, host, port });

        const stream = this.createReadStream(id);

        try {
            // 使用特殊的请求方法，不会覆盖 createReadStream 创建的 handler
            await this.requestForConnect(id, encode([host, port]), timeout);
            this.logger.debug("TCP connected", { id, host, port });
            return new TCPStream(id, this.send.bind(this), stream);
        } catch (err) {
            this.pending.delete(id);
            throw err;
        }
    }

    async queryDNS(name: string, recordType: keyof typeof DnsType = "A", timeout = DEFAULT_TIMEOUT): Promise<string[]> {
        if (this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }

        const id = this.nextId++;
        const recId = DnsType[recordType] as unknown as number;

        // 裸二进制编码：nameLen(2字节小端) + name + recordType(1字节)
        const nameBytes = new TextEncoder().encode(name);
        if (nameBytes.length > 65535) {
            throw new Error("DNS name too long");
        }
        
        const data = new Uint8Array(2 + nameBytes.length + 1);
        let pos = 0;
        data[pos++] = nameBytes.length & 0xff;
        data[pos++] = (nameBytes.length >> 8) & 0xff;
        data.set(nameBytes, pos);
        pos += nameBytes.length;
        data[pos] = recId;

        let response: Uint8Array;
        try {
            response = await this.request(MessageType.DNS_QUERY, id, data, timeout);
        } catch (err) {
            this.pending.delete(id);
            throw err;
        }

        // 裸二进制解码：count(2字节小端) + [ipLen(2字节小端) + ip]...
        let respPos = 0;
        if (response.length < 2) {
            throw new Error("Invalid DNS response: too short");
        }
        const count = response[respPos] | (response[respPos + 1] << 8);
        respPos += 2;

        const ips: string[] = [];
        for (let i = 0; i < count; i++) {
            if (respPos + 2 > response.length) {
                throw new Error("Invalid DNS response: truncated");
            }
            const ipLen = response[respPos] | (response[respPos + 1] << 8);
            respPos += 2;
            if (respPos + ipLen > response.length) {
                throw new Error("Invalid DNS response: IP truncated");
            }
            const ip = new TextDecoder().decode(response.subarray(respPos, respPos + ipLen));
            respPos += ipLen;
            ips.push(ip);
        }

        this.pending.delete(id);
        return ips;
    }

    async fetchHTTP(url: string, init?: RequestInit, timeout = DEFAULT_TIMEOUT): Promise<Response> {
        if (this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }

        const id = this.nextId++;
        const header = new Headers(init?.headers);
        const req = {
            method: init?.method || "GET",
            url,
            headers: Object.fromEntries(header.entries()),
        };

        const responsePromise = this.receiveResponse(id, timeout);

        // whether to enable chunked?
        let chunked = true;
        if (header.get('Content-Length')?.match(/^[0-9]+$/)) {
            chunked = false;
        }

        try {
            this.send(MessageType.HTTP_REQUEST, id, encode(req));

            if (init?.body) {
                await this.sendBody(id, init.body, chunked);
            }

            return await responsePromise;
        } catch (err) {
            this.pending.delete(id);
            throw err;
        }
    }

    private createReadStream(id: number): ReadableStream<Uint8Array> {
        // 立即创建一个pending handler，避免被覆盖
        this.pending.set(id, {
            resolve: () => { },
            reject: () => { },
        });

        return new ReadableStream({
            start: (controller) => {
                const handler = this.pending.get(id);
                if (handler) {
                    handler.stream = controller;
                }
            },
            cancel: () => {
                // 流被取消时清理
                this.pending.delete(id);
                this.send(MessageType.TCP_CLOSE, id, new Uint8Array(0));
            }
        });
    }

    private async sendBody(id: number, body: BodyInit, chunked: boolean) {
        const stream = body instanceof ReadableStream ? body :
            new Response(body).body!;
        const reader = stream.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                if (chunked){
                    const hex = value.length.toString(16);
                    this.send(MessageType.HTTP_BODY_CHUNK, id, new TextEncoder().encode(hex + '\r\n'));
                }

                this.send(MessageType.HTTP_BODY_CHUNK, id, value);
            }
        } finally {
            reader.releaseLock();
            this.send(MessageType.HTTP_BODY_END, id, new Uint8Array(0));
        }
    }

    private receiveResponse(id: number, timeout: number): Promise<Response> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`HTTP request timeout after ${timeout}ms`));
            }, timeout);

            this.pending.set(id, {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    try {
                        const resp = decode<HTTPResponse>(data);
                        const bodyStream = new ReadableStream({
                            start: (ctrl) => {
                                const existing = this.pending.get(id);
                                if (existing) {
                                    existing.stream = ctrl;
                                } else {
                                    this.pending.set(id, {
                                        resolve: () => { },
                                        reject: () => { },
                                        stream: ctrl,
                                    });
                                }
                            }
                        });

                        // create Response
                        const response = new Response(bodyStream, resp);
                        Reflect.defineProperty(response, "url", {
                            configurable: true,
                            enumerable: true,
                            writable: false,
                            value: resp.url
                        }); // overwrite URL
                        resolve(response);

                        // return state: chunked?
                        if (response.headers.get('transfer-encoding') == 'chunked')
                            return true;
                    } catch (err) {
                        reject(new Error(`Failed to decode response: ${getErrMsg(err)}`));
                    }
                },
                reject: (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                },
            });
        });
    }

    private handleMessage(data: Uint8Array) {
        try {
            const msg = decodeMessage(data);
            this.logger.debug("Client received message", {
                type: msg.type,
                resourceId: msg.resourceId.toString(),
                dataSize: msg.data.length
            });
            this.dispatch(msg);
        } catch (err) {
            this.logger.error("Failed to decode message", {
                error: getErrMsg(err),
                dataSize: data.length
            });
        }
    }

    private dispatch(msg: ProxyMessage) {
        // Handle heartbeat messages without a handler
        if (msg.type === MessageType.HEARTBEAT) {
            this.lastHeartbeat = Date.now();
            this.resetHeartbeatTimeout();
            this.send(MessageType.HEARTBEAT, msg.resourceId, msg.data);
            return;
        }

        const handler = this.pending.get(msg.resourceId);
        if (!handler) {
            this.logger.warn(`No handler for message ${msg.type}, id=${msg.resourceId}`);
            return;
        }

        switch (msg.type) {
            case MessageType.TCP_CONNECT_ACK:
                this.logger.debug(`TCP connect ack, id=${msg.resourceId}`);
                handler.resolve(msg.data);
                break;

            case MessageType.DNS_RESPONSE:
                handler.resolve(msg.data);
                break;

            case MessageType.TCP_DATA:
                try {
                    handler.stream!.enqueue(msg.data);
                } catch (err) {
                    this.logger.debug("Stream enqueue failed", { 
                        error: getErrMsg(err),
                        resourceId: msg.resourceId 
                    });
                    this.pending.delete(msg.resourceId);
                    this.send(MessageType.TCP_CLOSE, msg.resourceId, new Uint8Array(0));
                }
                break;

            case MessageType.TCP_CLOSE:
                this.logger.debug(`TCP close, id=${msg.resourceId}`);
                try {
                    handler.stream?.close();
                } catch (err) {
                    this.logger.debug("Stream close failed", { 
                        error: getErrMsg(err),
                        resourceId: msg.resourceId 
                    });
                }
                this.pending.delete(msg.resourceId);
                break;

            case MessageType.HTTP_RESPONSE:
                // Note: here we would check whether a chunked response.
                handler.chunked = handler.resolve(msg.data);
                break;

            case MessageType.HTTP_BODY_CHUNK:
                try {
                    if (handler.chunked) {
                        const lenHex = msg.data.length.toString(16);
                        handler.stream!.enqueue(new TextEncoder().encode(lenHex + '\r\n'));
                    }
                    handler.stream!.enqueue(msg.data);
                    if (handler.chunked)
                        handler.stream!.enqueue(new TextEncoder().encode('\r\n'));
                } catch (err) {
                    this.logger.debug("HTTP body enqueue failed", { 
                        error: getErrMsg(err),
                        resourceId: msg.resourceId 
                    });
                }
                break;

            case MessageType.HTTP_BODY_END:
                try {
                    if (handler.chunked)
                        handler.stream!.enqueue(new TextEncoder().encode('0\r\n\r\n'));
                    handler.stream!.close();
                } catch (err) {
                    this.logger.debug("HTTP body close failed", { 
                        error: getErrMsg(err),
                        resourceId: msg.resourceId 
                    });
                }
                this.pending.delete(msg.resourceId);
                break;

            case MessageType.ERROR: {
                const errMsg = new TextDecoder().decode(msg.data);
                this.logger.error(`Error for id=${msg.resourceId}: ${errMsg}`);
                handler.reject(new Error(errMsg));
                this.pending.delete(msg.resourceId);
                break;
            }

            default:
                this.logger.warn(`Unhandled message type: ${msg.type}`);
        }
    }

    private request(type: MessageType, id: number, data: Uint8Array, timeout = DEFAULT_TIMEOUT): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request timeout after ${timeout}ms`));
            }, timeout);

            this.pending.set(id, {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    resolve(data);
                },
                reject: (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                }
            });
            this.send(type, id, data);
        });
    }

    private requestForConnect(id: number, data: Uint8Array, timeout = DEFAULT_TIMEOUT): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request timeout after ${timeout}ms`));
            }, timeout);

            // 保留现有的 handler（可能包含 stream），只更新 resolve/reject
            const existing = this.pending.get(id);
            if (existing) {
                existing.resolve = (data) => {
                    clearTimeout(timeoutId);
                    resolve(data);
                };
                existing.reject = (err) => {
                    clearTimeout(timeoutId);
                    reject(err);
                };
                existing.timeout = timeoutId;
            } else {
                this.pending.set(id, {
                    resolve: (data) => {
                        clearTimeout(timeoutId);
                        resolve(data);
                    },
                    reject: (err) => {
                        clearTimeout(timeoutId);
                        reject(err);
                    },
                    timeout: timeoutId
                });
            }
            this.send(MessageType.TCP_CONNECT, id, data);
        });
    }

    private sendText(text: string) {
        if (this.isClosed) {
            this.logger.debug("Dropping text message (closed)");
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.debug("Cannot send text, WebSocket not open");
            return;
        }

        try {
            this.ws.send(text);
        } catch (err) {
            this.logger.error("Failed to send text", { error: getErrMsg(err) });
        }
    }

    private send(type: MessageType, id: number, data: Uint8Array) {
        if (this.isClosed) {
            this.logger.debug("Dropping client message (closed)", {
                type,
                id
            });
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // 检查队列大小限制
            if (this.messageQueue.length >= MAX_QUEUE_SIZE) {
                this.logger.error("Message queue full, dropping message", {
                    type,
                    id: id.toString(),
                    queueSize: this.messageQueue.length
                });
                return;
            }
            this.messageQueue.push({ type, resourceId: id, data });
            this.logger.debug("Client message queued (WebSocket not ready)", {
                type,
                id: id.toString(),
                queueSize: this.messageQueue.length
            });
            return;
        }

        try {
            const msg = encodeMessage({ type, resourceId: id, data });
            this.ws.send(msg);
        } catch (err) {
            this.logger.error("Failed to send message", {
                error: getErrMsg(err),
                type,
                id: id.toString()
            });
        }
    }

    close() {
        if (this.isClosed) return;
        this.isClosed = true;
        this.connectionState = 'disconnected';
        this.messageQueue = [];

        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);

        const pendingCount = this.pending.size;
        if (pendingCount > 0) {
            this.logger.debug(`Rejecting ${pendingCount} pending requests`);
        }

        for (const [id, handler] of this.pending) {
            handler.reject(new Error("Client closed"));
        }
        this.pending.clear();

        this.cleanupWebSocketListeners();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.close();
            } catch (err) {
                this.logger.debug("Error closing WebSocket", { error: getErrMsg(err) });
            }
        }
        this.ws = null;
    }

    private startHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);

        this.heartbeatInterval = setInterval(() => {
            if (this.isClosed) return;
            this.send(MessageType.HEARTBEAT, 0, new Uint8Array([Date.now()]));
        }, HEARTBEAT_INTERVAL);

        this.resetHeartbeatTimeout();
    }

    private resetHeartbeatTimeout() {
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn("Heartbeat timeout, closing connection");
            this.handleDisconnect();
        }, HEARTBEAT_TIMEOUT);
    }

    getConnectionState() {
        return {
            state: this.connectionState,
            isClosed: this.isClosed,
            pendingRequests: this.pending.size,
            queuedMessages: this.messageQueue.length,
            webSocketState: this.ws?.readyState
        };
    }
}

export class TCPStream {
    constructor(
        private id: number,
        private sendFn: (type: MessageType, id: number, data: Uint8Array) => void,
        public readable: ReadableStream<Uint8Array>
    ) { }

    get writable(): WritableStream<Uint8Array> {
        return new WritableStream({
            write: (chunk) => {
                this.sendFn(MessageType.TCP_DATA, this.id, chunk);
            },
            close: () => {
                this.sendFn(MessageType.TCP_CLOSE, this.id, new Uint8Array(0));
            },
            abort: (reason) => {
                this.sendFn(MessageType.TCP_CLOSE, this.id, new Uint8Array(0));
            }
        });
    }
}
