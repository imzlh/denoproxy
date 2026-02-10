import ProxyClient from "../core/client.ts";
import { HTTPProxyHandler } from "./http.ts";
import { SOCKS5Handler } from "./socks5.ts";
import { ProxyDecision } from "./proxy-decision.ts";
import { Log } from "@cross/log";
import { getErrMsg } from "../utils/error.ts";

export enum Protocol {
    HTTP,
    SOCKS5,
    UNKNOWN,
}

export function detectProtocol(buffer: Uint8Array): Protocol {
    if (buffer.length < 3) return Protocol.UNKNOWN;

    // Check SOCKS5: first byte is 0x05
    if (buffer[0] === 0x05) {
        return Protocol.SOCKS5;
    }

    // Check HTTP: starts with HTTP method
    const text = new TextDecoder().decode(buffer.slice(0, 8));
    const httpMethods = ["GET ", "POST", "PUT ", "DELE", "HEAD", "OPTI", "PATC", "CONN", "TRAC"];

    for (const method of httpMethods) {
        if (text.startsWith(method)) {
            return Protocol.HTTP;
        }
    }

    return Protocol.UNKNOWN;
}

export class MixedProxyServer {
    private httpHandler: HTTPProxyHandler;
    private socks5Handler: SOCKS5Handler;
    private isRunning = false;
    private connections = new Set<Deno.Conn>();

    constructor(
        private client: ProxyClient,
        private decision: ProxyDecision,
        private logger: Log
    ) {
        this.httpHandler = new HTTPProxyHandler(client, decision, logger);
        this.socks5Handler = new SOCKS5Handler(client, decision, logger);
    }

    async listen(port: number, hostname = "0.0.0.0") {
        // 尝试监听端口
        let listener: Deno.Listener;
        try {
            listener = Deno.listen({ port, hostname });
            this.logger.info(`Mixed proxy (HTTP/SOCKS5) listening on ${hostname}:${port}`);
        } catch (err) {
            this.logger.error(`Failed to listen on ${hostname}:${port}`, { error: getErrMsg(err) });
            throw err;
        }

        this.isRunning = true;

        try {
            for await (const conn of listener) {
                if (!this.isRunning) {
                    conn.close();
                    break;
                }
                this.handleConnection(conn);
            }
        } finally {
            this.isRunning = false;
            listener.close();
        }
    }

    stop() {
        this.isRunning = false;
        // 关闭所有活跃连接
        for (const conn of this.connections) {
            try { conn.close(); } catch { /* ignore */ }
        }
        this.connections.clear();
    }

    private async handleConnection(conn: Deno.Conn) {
        this.connections.add(conn);
        const remoteAddr = (conn.remoteAddr as Deno.NetAddr).hostname;
        
        try {
            // Peek first few bytes to detect protocol
            const peekBuffer = new Uint8Array(16);
            const n = await conn.read(peekBuffer);

            if (!n) {
                this.logger.debug("Connection closed immediately", { remoteAddr });
                return;
            }

            const firstChunk = peekBuffer.slice(0, n);
            const protocol = detectProtocol(firstChunk);

            this.logger.debug("Protocol detected", {
                remoteAddr,
                protocol: protocol === Protocol.HTTP ? "HTTP" : 
                         protocol === Protocol.SOCKS5 ? "SOCKS5" : "UNKNOWN"
            });

            if (protocol === Protocol.SOCKS5) {
                await this.socks5Handler.handle(conn, firstChunk);
            } else if (protocol === Protocol.HTTP) {
                // HTTP handler 内部支持 keep-alive，处理多个请求
                await this.httpHandler.handle(conn, firstChunk);
            } else {
                this.logger.warn("Unknown protocol", {
                    remoteAddr,
                    firstBytes: Array.from(firstChunk.slice(0, 8)).map(b => b.toString(16)).join(' ')
                });
            }
        } catch (err) {
            this.logger.error("Connection error", {
                remoteAddr,
                error: getErrMsg(err)
            });
        } finally {
            this.connections.delete(conn);
            try { conn.close(); } catch { /* ignore */ }
        }
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            activeConnections: this.connections.size
        };
    }
}
