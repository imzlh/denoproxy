import { MessageType } from "../protocol.ts";
import { getErrMsg } from "../../utils/error.ts";
import { Log } from "@cross/log";
import { decode } from "../../utils/bjson.ts";

const BUFFER_SIZE = 16384;
const CONNECT_TIMEOUT = 30000;
const MAX_WS_BUFFERED_AMOUNT = 1024 * 1024;

export class TCPProxy {
    private connections = new Map<number, Deno.TcpConn>();
    private closingConnections = new Set<number>();
    private getBufferedAmount: () => number;

    constructor(
        private sendMessage: (type: MessageType, id: number, data: Uint8Array) => void,
        private logger?: Log,
        getBufferedAmount?: () => number
    ) {
        this.getBufferedAmount = getBufferedAmount || (() => 0);
    }

    async handleConnect(resourceId: number, data: Uint8Array) {
        let conn: Deno.TcpConn | null = null;
        const decoded = decode<[string, number]>(data);
        try {
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

            conn = await Promise.race([
                Deno.connect({ hostname: host, port }),
                new Promise<Deno.TcpConn>((_, reject) => 
                    setTimeout(() => reject(new Error("Connection timeout")), CONNECT_TIMEOUT)
                )
            ]);

            this.connections.set(resourceId, conn);
            this.sendMessage(MessageType.TCP_CONNECT_ACK, resourceId, new Uint8Array(0));

            this.logger?.debug("TCP connection established", {
                resourceId: resourceId.toString(),
                host,
                port,
                remoteAddr: (conn.remoteAddr as Deno.NetAddr).hostname
            });

            this.pipeToWebSocket(resourceId, conn, host, port);
        } catch (err) {
            this.logger?.error("TCP connect failed", {
                resourceId: resourceId.toString(),
                host: (decoded?.[0]) || 'unknown',
                port: (decoded?.[1]) || 'unknown',
                error: getErrMsg(err)
            });
            if (conn) {
                try { conn.close(); } catch { /* ignore */ }
            }
            this.sendError(resourceId, getErrMsg(err));
        }
    }

    handleData(resourceId: number, data: Uint8Array) {
        const conn = this.connections.get(resourceId);
        if (!conn) {
            this.logger?.debug("TCP data for unknown connection (likely closed)", {
                resourceId: resourceId.toString(),
                dataSize: data.length
            });
            return;
        }

        if (this.closingConnections.has(resourceId)) {
            return;
        }

        conn.write(data).catch((err) => {
            const msg = getErrMsg(err).toLowerCase();
            if (!msg.includes("closed") && !msg.includes("broken pipe")) {
                this.logger?.debug("TCP write failed", {
                    resourceId: resourceId.toString(),
                    error: getErrMsg(err)
                });
            }
            this.close(resourceId);
        });
    }

    close(resourceId: number) {
        if (this.closingConnections.has(resourceId)) {
            return;
        }

        const conn = this.connections.get(resourceId);
        if (!conn) return;

        this.closingConnections.add(resourceId);

        try {
            conn.close();
        } catch { /* ignore */ }

        this.connections.delete(resourceId);
        this.closingConnections.delete(resourceId);

        try {
            this.sendMessage(MessageType.TCP_CLOSE, resourceId, new Uint8Array(0));
        } catch { /* ignore */ }
    }

    private async pipeToWebSocket(resourceId: number, conn: Deno.TcpConn, host: string, port: number) {
        const buffer = new Uint8Array(65536); // 64KB read buffer
        
        try {
            while (!this.closingConnections.has(resourceId)) {
                if (!this.connections.has(resourceId)) break;

                // Backpressure: wait if WS buffer is saturated
                if (this.getBufferedAmount() > MAX_WS_BUFFERED_AMOUNT) {
                    await new Promise(r => setTimeout(r, 5));
                    continue;
                }
                
                const n = await conn.read(buffer);
                if (n === null) break;
                if (n === 0) continue;
                
                // Use subarray (no allocation) for small reads, slice only for large
                this.sendMessage(MessageType.TCP_DATA, resourceId,
                    n === buffer.length ? buffer.slice() : buffer.subarray(0, n));
            }
        } catch (err) {
            const errorMsg = getErrMsg(err);
            if (!errorMsg.includes("closed") && !errorMsg.includes("broken pipe") && !errorMsg.includes("Bad resource")) {
                this.logger?.debug("TCP pipe error", { resourceId: resourceId.toString(), host, port, error: errorMsg });
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

        this.logger?.debug("Closing all TCP connections", { count });
        
        const ids = [...this.connections.keys()];
        for (const id of ids) {
            this.close(id);
        }
    }
}
