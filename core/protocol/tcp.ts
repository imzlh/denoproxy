import { MessageType } from "../protocol.ts";
import { getErrMsg } from "../../utils/error.ts";
import { Log } from "@cross/log";
import { decode } from "../../utils/bjson.ts";

const BUFFER_SIZE = 16384;
const CONNECT_TIMEOUT = 30000;

export class TCPProxy {
    private connections = new Map<number, Deno.TcpConn>();
    private closingConnections = new Set<number>();

    constructor(
        private sendMessage: (type: MessageType, id: number, data: Uint8Array) => void,
        private logger?: Log
    ) { }

    async handleConnect(resourceId: number, data: Uint8Array) {
        let conn: Deno.TcpConn | null = null;
        try {
            const decoded = decode<[string, number]>(data);
            if (!Array.isArray(decoded) || decoded.length !== 2) {
                throw new Error("Invalid connect data format");
            }
            const [host, port] = decoded;

            if (typeof host !== 'string' || typeof port !== 'number') {
                throw new Error("Invalid host or port type");
            }

            this.logger?.info("TCP connect request", {
                resourceId: resourceId.toString(),
                host,
                port
            });

            // 设置连接超时
            conn = await Promise.race([
                Deno.connect({ hostname: host, port }),
                new Promise<Deno.TcpConn>((_, reject) => 
                    setTimeout(() => reject(new Error("Connection timeout")), CONNECT_TIMEOUT)
                )
            ]);

            this.connections.set(resourceId, conn);
            this.sendMessage(MessageType.TCP_CONNECT_ACK, resourceId, new Uint8Array(0));

            this.logger?.info("TCP connection established", {
                resourceId: resourceId.toString(),
                host,
                port,
                remoteAddr: (conn.remoteAddr as Deno.NetAddr).hostname
            });

            this.pipeToWebSocket(resourceId, conn, host, port);
        } catch (err) {
            this.logger?.error("TCP connect failed", getErrMsg(err));
            if (conn) {
                try { conn.close(); } catch { /* ignore */ }
            }
            this.sendError(resourceId, getErrMsg(err));
        }
    }

    handleData(resourceId: number, data: Uint8Array) {
        const conn = this.connections.get(resourceId);
        if (!conn) {
            this.logger?.warn("TCP data for unknown connection", {
                resourceId: resourceId.toString(),
                dataSize: data.length
            });
            return;
        }

        if (this.closingConnections.has(resourceId)) {
            this.logger?.debug("Ignoring data for closing connection", {
                resourceId: resourceId.toString()
            });
            return;
        }

        conn.write(data).catch((err) => {
            this.logger?.debug("TCP write failed", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
            this.close(resourceId);
        });
    }

    close(resourceId: number) {
        if (this.closingConnections.has(resourceId)) {
            return; // Already closing
        }

        const conn = this.connections.get(resourceId);
        if (!conn) return;

        this.closingConnections.add(resourceId);

        try {
            this.logger?.debug("Closing TCP connection", {
                resourceId: resourceId.toString()
            });
            conn.close();
        } catch (err) {
            this.logger?.debug("Error closing TCP connection", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }

        this.connections.delete(resourceId);
        this.closingConnections.delete(resourceId);

        // 通知对端连接已关闭
        try {
            this.sendMessage(MessageType.TCP_CLOSE, resourceId, new Uint8Array(0));
        } catch (err) {
            this.logger?.debug("Error sending TCP_CLOSE", {
                error: getErrMsg(err)
            });
        }
    }

    private async pipeToWebSocket(resourceId: number, conn: Deno.TcpConn, host: string, port: number) {
        // 每个连接使用独立的 buffer，避免数据竞争
        const buffer = new Uint8Array(BUFFER_SIZE);
        
        try {
            while (!this.closingConnections.has(resourceId)) {
                const n = await conn.read(buffer);
                if (n === null) {
                    this.logger?.debug("TCP connection closed by remote", {
                        resourceId: resourceId.toString(),
                        host,
                        port
                    });
                    break;
                }
                this.sendMessage(MessageType.TCP_DATA, resourceId, buffer.slice(0, n));
            }
        } catch (err) {
            const errorMsg = getErrMsg(err);
            // 忽略预期的错误
            if (!errorMsg.includes("closed") && !errorMsg.includes("broken pipe")) {
                this.logger?.debug("TCP pipe error", {
                    resourceId: resourceId.toString(),
                    host,
                    port,
                    error: errorMsg
                });
            }
        } finally {
            this.close(resourceId);
        }
    }

    private sendError(resourceId: number, message: string) {
        try {
            const data = new TextEncoder().encode(message);
            this.sendMessage(MessageType.ERROR, resourceId, data);
        } catch (err) {
            this.logger?.error("Failed to send TCP error", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
    }

    closeAll() {
        const count = this.connections.size;
        if (count === 0) return;

        this.logger?.info("Closing all TCP connections", { count });
        
        // 复制 keys 避免在迭代过程中修改
        const ids = [...this.connections.keys()];
        for (const id of ids) {
            this.close(id);
        }
    }
}
