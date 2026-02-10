import { MessageType, type ProxyMessage } from "./protocol.ts";
import { decodeMessage, encodeMessage } from "./codec.ts";
import { TCPProxy } from "./protocol/tcp.ts";
import { UDPProxy } from "./protocol/udp.ts";
import { DNSProxy } from "./protocol/dns.ts";
import { HTTPProxy } from "./protocol/http-proxy.ts";
import { CommandHandler } from "./command.ts";
import { Log } from "@cross/log";
import { getErrMsg } from "../utils/error.ts";
import { TextDecoder } from "node:util";

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 60000;
const RECONNECT_TIMEOUT = 60000;
const MAX_QUEUE_SIZE = 1000;

type QueuedMessage = {
    type: MessageType;
    resourceId: number;
    data: Uint8Array;
};

export class ProxyTransport extends EventTarget {
    private tcpProxy: TCPProxy;
    private udpProxy: UDPProxy;
    private dnsProxy: DNSProxy;
    private httpProxy: HTTPProxy;
    private commandHandler: CommandHandler;
    private lastHeartbeat = Date.now();
    private heartbeatInterval?: number;
    private heartbeatTimeout?: number;
    private reconnectTimeout?: number;
    private ws: WebSocket | null = null;
    private messageQueue: QueuedMessage[] = [];
    private isClosed = false;
    private connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
    readonly clientUUID = crypto.randomUUID();

    constructor(private logger: Log) {
        super();
        const sendFn = this.send.bind(this);
        const sendTextFn = this.sendText.bind(this);
        this.tcpProxy = new TCPProxy(sendFn, logger);
        this.udpProxy = new UDPProxy(sendFn, logger);
        this.dnsProxy = new DNSProxy(sendFn, logger);
        this.httpProxy = new HTTPProxy(sendFn, logger);
        this.commandHandler = new CommandHandler(sendTextFn, logger, true);
    }

    get socket() {
        return this.ws;
    }

    getConnectionState() {
        return {
            state: this.connectionState,
            isClosed: this.isClosed,
            queuedMessages: this.messageQueue.length,
            clientUUID: this.clientUUID
        };
    }

    assign(ws: WebSocket) {
        if (this.ws) {
            this.logger.debug("Reassigning WebSocket");
            this.cleanupWebSocketListeners();
        }

        this.ws = ws;
        this.isClosed = false;
        this.connectionState = 'connected';
        ws.binaryType = "arraybuffer";

        ws.addEventListener("message", this.onMessage);
        ws.addEventListener("error", this.onError);
        ws.addEventListener("close", this.onClose);

        this.flushQueue();
        this.startHeartbeat();

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        this.logger.info("Transport assigned to WebSocket", {
            clientUUID: this.clientUUID,
            queuedMessages: this.messageQueue.length
        });

        this.dispatchEvent(new Event("connect"));

        // send UUID as text command
        try {
            this.sendText("SET UUID " + this.clientUUID);
        } catch (err) {
            this.logger.error("Failed to send UUID", { error: getErrMsg(err) });
        }
    }

    private cleanupWebSocketListeners() {
        if (!this.ws) return;
        this.ws.removeEventListener("message", this.onMessage);
        this.ws.removeEventListener("error", this.onError);
        this.ws.removeEventListener("close", this.onClose);
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

    private handleTextCommand(text: string) {
        this.logger.debug(`Received command: ${text}`);

        const handled = this.commandHandler.handleCommand(text);
        if (!handled) {
            this.logger.warn(`Unknown command format: ${text}`);
        }
    }

    private sendText(text: string) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.debug("Cannot send text, WebSocket not open");
            return;
        }
        try {
            this.ws.send(text);
        } catch (err) {
            this.logger.error("Failed to send text", { error: getErrMsg(err), text });
        }
    }

    private onError = () => {
        this.logger.error("WebSocket error", {
            state: this.connectionState,
            readyState: this.ws?.readyState
        });
        this.handleDisconnect();
    };

    private onClose = () => this.handleDisconnect();

    private handleMessage(data: Uint8Array) {
        try {
            const msg = decodeMessage(data);
            this.logger.debug("Received message", {
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

    private handleDisconnect() {
        if (this.isClosed) return;
        
        this.connectionState = 'disconnected';

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = undefined;
        }
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = undefined;
        }

        this.logger.warn("Transport disconnected", {
            clientUUID: this.clientUUID,
            queuedMessages: this.messageQueue.length
        });

        this.dispatchEvent(new Event("disconnect"));

        // wait for reconnect: 60s
        this.logger.info("Waiting for reconnection (60s timeout)...");
        this.reconnectTimeout = setTimeout(() => {
            this.logger.warn("Reconnection timeout, closing transport");
            this.dispatchEvent(new Event("timeout"));
            this.close();
        }, RECONNECT_TIMEOUT);
    }

    private flushQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const queue = this.messageQueue;
        this.messageQueue = [];

        if (queue.length > 0) {
            this.logger.debug("Flushing message queue", {
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

    private send(type: MessageType, resourceId: number, data: Uint8Array) {
        if (this.isClosed) {
            this.logger.debug("Dropping message (transport closed)", {
                type,
                resourceId: resourceId.toString()
            });
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // 检查队列大小限制
            if (this.messageQueue.length >= MAX_QUEUE_SIZE) {
                this.logger.error("Message queue full, dropping message", {
                    type,
                    resourceId: resourceId.toString(),
                    queueSize: this.messageQueue.length
                });
                return;
            }
            this.messageQueue.push({ type, resourceId, data });
            this.logger.debug("Message queued (WebSocket not ready)", {
                type,
                resourceId: resourceId.toString(),
                queueSize: this.messageQueue.length
            });
            return;
        }

        try {
            const msg = encodeMessage({ type, resourceId, data });
            this.ws.send(msg);
        } catch (err) {
            this.logger.error("Failed to send message", {
                error: getErrMsg(err),
                type,
                resourceId: resourceId.toString()
            });
        }
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

    private dispatch(msg: ProxyMessage) {
        // Handle heartbeat messages immediately
        if (msg.type === MessageType.HEARTBEAT) {
            this.lastHeartbeat = Date.now();
            this.resetHeartbeatTimeout();
            this.send(MessageType.HEARTBEAT, msg.resourceId, msg.data);
            return;
        }

        const { type, resourceId, data } = msg;

        try {
            switch (type) {
                case MessageType.TCP_CONNECT:
                    this.tcpProxy.handleConnect(resourceId, data);
                    break;
                case MessageType.TCP_DATA:
                    this.tcpProxy.handleData(resourceId, data);
                    break;
                case MessageType.TCP_CLOSE:
                    this.tcpProxy.close(resourceId);
                    break;

                case MessageType.UDP_BIND:
                    this.udpProxy.handleBind(resourceId, data);
                    break;
                case MessageType.UDP_DATA:
                    this.udpProxy.handleData(resourceId, data);
                    break;
                case MessageType.UDP_CLOSE:
                    this.udpProxy.close(resourceId);
                    break;

                case MessageType.DNS_QUERY:
                    this.dnsProxy.handleQuery(resourceId, data);
                    break;

                case MessageType.HTTP_REQUEST:
                    this.httpProxy.handleRequest(resourceId, data);
                    break;
                case MessageType.HTTP_BODY_CHUNK:
                    this.httpProxy.handleBodyChunk(resourceId, data);
                    break;
                case MessageType.HTTP_BODY_END:
                    this.httpProxy.handleBodyEnd(resourceId);
                    break;

                case MessageType.ERROR:
                    this.logger.error("Received error message", new TextDecoder().decode(data));
                    break;

                default:
                    this.logger.warn(`Unhandled message type: ${MessageType[type]}`);
            }
        } catch (err) {
            this.logger.error("Error dispatching message", {
                error: getErrMsg(err),
                type,
                resourceId
            });
        }
    }

    close() {
        if (this.isClosed) return;
        this.isClosed = true;
        this.connectionState = 'disconnected';
        this.messageQueue = [];

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = undefined;
        }
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = undefined;
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        this.cleanupWebSocketListeners();

        // Close all proxies
        try {
            this.tcpProxy.closeAll();
        } catch (err) {
            this.logger.debug("Error closing TCP proxy", { error: getErrMsg(err) });
        }
        try {
            this.udpProxy.closeAll();
        } catch (err) {
            this.logger.debug("Error closing UDP proxy", { error: getErrMsg(err) });
        }
        try {
            this.httpProxy.abortAll();
        } catch (err) {
            this.logger.debug("Error aborting HTTP proxy", { error: getErrMsg(err) });
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.close();
            } catch (err) {
                this.logger.debug("Error closing WebSocket", { error: getErrMsg(err) });
            }
        }
        this.ws = null;

        this.dispatchEvent(new Event("close"));
    }
}
