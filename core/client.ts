import { DnsType, HTTPResponse, MessageType, type ProxyMessage } from "./protocol.ts";
import { decodeMessage, encodeMessage } from "./codec.ts";
import { CommandHandler } from "./command.ts";
import { Log } from "@cross/log";
import { decode, encode } from "../utils/bjson.ts";
import { getErrMsg } from "../utils/error.ts";

const DEFAULT_TIMEOUT = 30000;
const MAX_QUEUE_SIZE = 1000;
const MAX_PENDING_REQUESTS = 10000;
const RESOURCE_ID_MAX = 0xFFFFFFFF;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 60000;
const MAX_BUFFERED_AMOUNT = 1024 * 1024;

type QueuedMessage = {
    type: MessageType;
    resourceId: number;
    data: Uint8Array;
};

type PendingHandler = {
    resolve: (data: Uint8Array) => any;
    reject: (err: Error) => void;
    stream?: ReadableStreamDefaultController<Uint8Array>;
    createdAt: number;
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
    private pendingCleanupInterval?: number;

    constructor(private logger: Log) {
        const sendTextFn = this.sendText.bind(this);
        this.commandHandler = new CommandHandler(sendTextFn, logger, false);
        
        this.pendingCleanupInterval = setInterval(() => {
            this.cleanupPendingRequests();
        }, 30000);
    }

    assign(ws: WebSocket) {
        if (this.ws) {
            this.logger.debug("Reassigning WebSocket to client");
            this.cleanupWebSocketListeners();
        }

        this.ws = ws;
        this.isClosed = false; // reset on reassign
        this.connectionState = 'connected';
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
        if (this.connectionState === 'disconnected') return;
        this.connectionState = 'disconnected';
        // NOTE: do NOT set isClosed=true here - that's only for close()
        // so that assign() can be called again for reconnection

        if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = undefined; }
        if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = undefined; }

        const queueSize = this.messageQueue.length;
        if (queueSize > 0) {
            this.logger.debug(`Cleaning up ${queueSize} queued messages due to disconnect`);
            this.messageQueue = [];
        }

        const pendingCount = this.pending.size;
        if (pendingCount > 0) {
            this.logger.warn(`Cleaning up ${pendingCount} pending requests due to disconnect`);
        }

        for (const [id, handler] of this.pending) {
            try {
                handler.stream?.error(new Error("Connection closed"));
            } catch { /* ignore */ }
            handler.reject(new Error("Connection closed"));
        }
        this.pending.clear();
    }

    private flushQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const queue = this.messageQueue;
        // FIX: 清空队列前先检查大小，避免在发送过程中队列被修改
        this.messageQueue = [];

        if (queue.length > 0) {
            this.logger.debug("Flushing client message queue", {
                messageCount: queue.length
            });
        }

        let sentCount = 0;
        let failedCount = 0;

        for (const msg of queue) {
            try {
                // FIX: 检查WebSocket是否仍然打开
                if (this.ws.readyState !== WebSocket.OPEN) {
                    // 将剩余消息放回队列
                    this.messageQueue.push(...queue.slice(sentCount + failedCount));
                    this.logger.warn("WebSocket closed during flush, re-queued messages", {
                        requeued: this.messageQueue.length
                    });
                    break;
                }
                const encoded = encodeMessage(msg);
                this.ws.send(encoded);
                sentCount++;
            } catch (err) {
                failedCount++;
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

        if (this.pending.size >= MAX_PENDING_REQUESTS) {
            throw new Error("Too many pending requests");
        }

        const id = this.nextResourceId();
        this.logger.debug("Connecting TCP", { id, host, port });

        const stream = this.createReadStream(id);

        try {
            await this.request(MessageType.TCP_CONNECT, id, encode([host, port]), timeout);
            this.logger.debug("TCP connected", { id, host, port });
            return new TCPStream(id, this.send.bind(this), stream);
        } catch (err) {
            this.pending.delete(id);
            throw err;
        }
    }

    private nextResourceId(): number {
        const id = this.nextId++;
        if (this.nextId >= RESOURCE_ID_MAX) {
            this.nextId = 1;
            this.logger.debug("Resource ID wrapped around");
        }
        return id;
    }

    async queryDNS(name: string, recordType: keyof typeof DnsType = "A", timeout = DEFAULT_TIMEOUT): Promise<string[]> {
        if (this.isClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
        }

        // 检查pending请求数量
        if (this.pending.size >= MAX_PENDING_REQUESTS) {
            throw new Error("Too many pending requests");
        }

        const id = this.nextResourceId();
        const recId = DnsType[recordType] as unknown as number;

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

        if (this.pending.size >= MAX_PENDING_REQUESTS) {
            throw new Error("Too many pending requests");
        }

        const id = this.nextResourceId();
        const header = new Headers(init?.headers);
        const req = {
            method: init?.method || "GET",
            url,
            headers: Object.fromEntries(header.entries()),
        };

        const responsePromise = this.receiveResponse(id, timeout);

        try {
            this.send(MessageType.HTTP_REQUEST, id, encode(req));

            if (init?.body) {
                this.sendBody(id, init.body).catch(err => {
                    this.logger.debug("sendBody error", { error: getErrMsg(err) });
                });
            }

            const response = await responsePromise;
            return response;
        } catch (err) {
            this.pending.delete(id);
            throw err;
        }
    }

    private createReadStream(id: number): ReadableStream<Uint8Array> {
        this.pending.set(id, {
            resolve: () => { },
            reject: () => { },
            createdAt: Date.now()
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

    /**
     * 清理超时的pending请求
     */
    private cleanupPendingRequests() {
        const now = Date.now();
        const maxAge = 120000; // 2分钟
        let cleaned = 0;

        for (const [id, handler] of this.pending) {
            if (now - handler.createdAt > maxAge) {
                handler.reject(new Error("Request timeout (cleanup)"));
                this.pending.delete(id);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.logger.debug("Cleaned up stale pending requests", { cleaned, remaining: this.pending.size });
        }
    }

    private async sendBody(id: number, body: BodyInit) {
        const stream = body instanceof ReadableStream ? body : new Response(body).body!;
        const reader = stream.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
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

            // We pre-create the body stream and capture its controller synchronously
            // so it's ready before the first HTTP_BODY_CHUNK arrives.
            let bodyCtrl: ReadableStreamDefaultController<Uint8Array>;
            const bodyStream = new ReadableStream<Uint8Array>({
                start: (ctrl) => { bodyCtrl = ctrl; }
            });

            this.pending.set(id, {
                resolve: (data) => {
                    clearTimeout(timeoutId);
                    try {
                        const resp = decode<HTTPResponse>(data);
                        // Reuse the same pending entry; just upgrade resolve/reject to no-ops
                        // and wire the already-created stream controller.
                        const entry = this.pending.get(id)!;
                        entry.resolve = () => {};
                        entry.reject = () => {};
                        entry.stream = bodyCtrl;

                        const response = new Response(resp.body ? bodyStream : null, resp);
                        Reflect.defineProperty(response, "url", {
                            configurable: true, enumerable: true, writable: false,
                            value: resp.url
                        });
                        resolve(response);
                    } catch (err) {
                        reject(new Error(`Failed to decode response: ${getErrMsg(err)}`));
                    }
                },
                reject: (err) => {
                    clearTimeout(timeoutId);
                    // close bodyStream on reject too
                    try { bodyCtrl?.error(err); } catch { /* ignore */ }
                    reject(err);
                },
                stream: undefined as unknown as ReadableStreamDefaultController<Uint8Array>,
                createdAt: Date.now()
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
        if (msg.type === MessageType.HEARTBEAT) {
            this.lastHeartbeat = Date.now();
            this.resetHeartbeatTimeout();
            // Client initiated the heartbeat; server replied. Do NOT echo back (would loop).
            return;
        }

        const handler = this.pending.get(msg.resourceId);
        if (!handler) {
            this.logger.warn(`No handler for message ${msg.type}, id=${msg.resourceId}`);
            // close connection
            switch (msg.type) {
                case MessageType.TCP_CONNECT:
                case MessageType.TCP_CONNECT_ACK:
                case MessageType.TCP_DATA:
                    this.send(MessageType.TCP_CLOSE, msg.resourceId, new Uint8Array(0));
                break;
                case MessageType.UDP_BIND:
                case MessageType.UDP_BIND_ACK:
                case MessageType.UDP_DATA:
                case MessageType.UDP_CLOSE:
                    this.send(MessageType.UDP_CLOSE, msg.resourceId, new Uint8Array(0));
                break;
                case MessageType.HTTP_BODY_CHUNK:
                    this.send(MessageType.HTTP_BODY_END, msg.resourceId, new Uint8Array(0));
                break;
            }
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
                handler.resolve(msg.data);
                break;

            case MessageType.HTTP_BODY_CHUNK:
                try {
                    handler.stream!.enqueue(msg.data);
                } catch (err) {
                    this.logger.debug("HTTP body enqueue failed", { 
                        error: getErrMsg(err),
                        resourceId: msg.resourceId 
                    });
                }
                break;

            case MessageType.HTTP_BODY_END:
                try {
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
                try {
                    handler.stream?.error(new Error(errMsg));
                } catch { /* ignore */ }
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

            const existing = this.pending.get(id);
            if (existing) {
                existing.resolve = (data) => { clearTimeout(timeoutId); resolve(data); };
                existing.reject = (err) => { clearTimeout(timeoutId); reject(err); };
            } else {
                this.pending.set(id, {
                    resolve: (data) => { clearTimeout(timeoutId); resolve(data); },
                    reject: (err) => { clearTimeout(timeoutId); reject(err); },
                    createdAt: Date.now()
                });
            }
            this.send(type, id, data);
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
        // FIX: 清理pending清理定时器
        if (this.pendingCleanupInterval) clearInterval(this.pendingCleanupInterval);

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

        const checkHeartbeat = () => {
            if (this.isClosed) return;
            this.send(MessageType.HEARTBEAT, 0, new Uint8Array(0));
        };

        this.heartbeatInterval = setInterval(checkHeartbeat, HEARTBEAT_INTERVAL);
        this.resetHeartbeatTimeout();
    }

    private resetHeartbeatTimeout() {
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        
        this.heartbeatTimeout = setTimeout(() => {
            this.logger.warn("Heartbeat timeout, closing connection");
            this.handleDisconnect();
        }, HEARTBEAT_TIMEOUT);
    }
}

export class TCPStream {
    private _writable: WritableStream<Uint8Array>;

    constructor(
        private id: number,
        private sendFn: (type: MessageType, id: number, data: Uint8Array) => void,
        public readable: ReadableStream<Uint8Array>
    ) {
        // Must be created once; pipeTo locks the stream and re-creating breaks it
        this._writable = new WritableStream({
            write: (chunk) => {
                this.sendFn(MessageType.TCP_DATA, this.id, chunk);
            },
            close: () => {
                this.sendFn(MessageType.TCP_CLOSE, this.id, new Uint8Array(0));
            },
            abort: () => {
                this.sendFn(MessageType.TCP_CLOSE, this.id, new Uint8Array(0));
            }
        });
    }

    get writable(): WritableStream<Uint8Array> {
        return this._writable;
    }
}
