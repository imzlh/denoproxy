import ProxyClient from "../core/client.ts"
import { ProxyDecision } from "./proxy-decision.ts";
import { Log } from "@cross/log";
import { createParser, TYPE, METHODS } from "llhttp-wasm";
import { getErrMsg } from "../utils/error.ts";

const CONNECT_TIMEOUT = 30000;
const MAX_HEADER_SIZE = 8192;
const KEEP_ALIVE_TIMEOUT = 30000;

interface HTTPData {
    method: string;
    url: string;
    host: string;
    port: number;
    headers: Headers;
    bodyStream: ReadableStream<Uint8Array>;
    proxy: boolean;
    keepAlive: boolean;
}

export class HTTPProxyHandler {
    constructor(
        private client: ProxyClient,
        private decision: ProxyDecision,
        private logger: Log
    ) { }

    async handle(conn: Deno.Conn, firstChunk: Uint8Array) {
        const remoteAddr = (conn.remoteAddr as Deno.NetAddr).hostname;
        let buffer = firstChunk;
        let keepAlive = true;

        while (keepAlive) {
            try {
                const req = await this.readHTTPRequest(conn, buffer);
                
                if (!req) {
                    break;
                }

                keepAlive = req.keepAlive;
                buffer = new Uint8Array(0);

                if (!req.proxy) {
                    await this.handleLocalRequest(req, conn);
                    if (!req.keepAlive) break;
                    continue;
                }

                if (req.method === "CONNECT") {
                    await this.handleConnect(req, conn, remoteAddr);
                    break;
                } else {
                    const shouldContinue = await this.handleHTTP(req, conn, remoteAddr);
                    if (!shouldContinue) break;
                }
            } catch (err) {
                this.logger.error("HTTP handler error", {
                    remoteAddr,
                    error: getErrMsg(err)
                });
                break;
            }
        }

        conn.close();
    }

    private async handleLocalRequest(req: HTTPData, conn: Deno.Conn) {
        try {
            const connection = req.keepAlive ? 'keep-alive' : 'close';
            await conn.write(new TextEncoder().encode(
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/plain\r\n" +
                `Connection: ${connection}\r\n` +
                "\r\n" +
                "DenoProxy HTTP Handler\r\n"
            ));
        } catch (err) {
            this.logger.debug("Write local response failed", { error: getErrMsg(err) });
        }
    }

    private readHTTPRequest(conn: Deno.Conn, firstChunk: Uint8Array): Promise<HTTPData | null> {
        return new Promise((resolve, reject) => {
            const parser = createParser(TYPE.REQUEST);
            let resolved = false;
            let bodyWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
            let timeoutId: number | null = null;
            
            const cleanup = () => {
                resolved = true;
                if (timeoutId) clearTimeout(timeoutId);
                if (bodyWriter) {
                    try { bodyWriter.releaseLock(); } catch { /* ignore */ }
                }
            };

            const safeReject = (reason: unknown) => {
                if (!resolved) {
                    cleanup();
                    reject(reason);
                }
            };

            const safeResolve = (data: HTTPData | null) => {
                if (!resolved) {
                    cleanup();
                    resolve(data);
                }
            };

            timeoutId = setTimeout(() => {
                safeReject(new Error("Keep-alive timeout"));
            }, KEEP_ALIVE_TIMEOUT);

            (async () => {
                const chunk = new Uint8Array(MAX_HEADER_SIZE);
                let errno = 0;
                
                if (firstChunk.length) {
                    errno = parser.execute(firstChunk);
                }
                
                while (!resolved && errno !== 22) {
                    if (errno !== 0) {
                        safeReject(new Error(`HTTP parse error: ${parser.getErrorReason(errno)}`));
                        return;
                    }
                    
                    try {
                        const n = await conn.read(chunk);
                        if (n === null) {
                            if (!resolved) safeResolve(null);
                            return;
                        }
                        if (n === 0) continue;
                        
                        errno = parser.execute(chunk.subarray(0, n));
                    } catch (err) {
                        safeReject(err);
                        return;
                    }
                }
            })();

            const stream = new TransformStream<Uint8Array, Uint8Array>({
                start: () => {},
                transform: (chunk, controller) => {
                    controller.enqueue(chunk);
                }
            });

            parser.onBody = (data: Uint8Array) => {
                if (!bodyWriter) {
                    bodyWriter = stream.writable.getWriter();
                }
                bodyWriter.write(data).catch((e) => {
                    this.logger.debug("HTTP body write error", { error: getErrMsg(e) });
                    safeReject(e);
                });
                return 0;
            };

            parser.onHeadersComplete = (h: { method?: number; url?: string; versionMajor?: number; versionMinor?: number }) => {
                try {
                    const headers = new Headers();
                    for (let i = 0; i < parser.headerFields.length; i++) {
                        headers.set(parser.headerFields[i].toLowerCase(), parser.headerValues[i]);
                    }
                    
                    const connectUrl = headers.get('host') || h.url!;
                    
                    // 检查 keep-alive (处理 Proxy-Connection 和 Connection)
                    const connection = headers.get('connection') || '';
                    const proxyConnection = headers.get('proxy-connection') || '';
                    const isKeepAlive = h.versionMajor === 1 && h.versionMinor === 1 
                        ? (connection.toLowerCase() !== 'close' && proxyConnection.toLowerCase() !== 'close')
                        : (connection.toLowerCase() === 'keep-alive' || proxyConnection.toLowerCase() === 'keep-alive');
                    
                    if (h.method === METHODS.CONNECT) {
                        const match = connectUrl.match(/^([a-z0-9\-\.]+):(\d{1,5})$/i);
                        if (!match) {
                            this.logger.error("Invalid CONNECT request", { connectUrl });
                            safeReject(new Error("Invalid CONNECT request"));
                            return 24;
                        }
                        
                        const [, host, portStr] = match;
                        const port = Number(portStr);
                        
                        if (port < 1 || port > 65535) {
                            safeReject(new Error("Invalid port in CONNECT request"));
                            return 24;
                        }
                        
                        safeResolve({
                            method: "CONNECT",
                            url: '/',
                            host,
                            port,
                            headers,
                            bodyStream: conn.readable,
                            proxy: true,
                            keepAlive: false
                        });
                        return 0;
                    }
                    
                    const method = this.getMethodString(h.method);
                    if (!method) {
                        safeReject(new Error(`Unknown HTTP method: ${h.method}`));
                        return 24;
                    }

                    let url: URL;
                    let host: string;
                    let port: number;
                    
                    try {
                        if (parser.url.startsWith('/')) {
                            const hostHeader = headers.get("host");
                            if (!hostHeader) {
                                safeReject(new Error("Missing Host header"));
                                return 24;
                            }
                            const [h, p] = hostHeader.split(':');
                            host = h;
                            port = p ? parseInt(p) : 80;
                            url = new URL(parser.url, `http://${hostHeader}`);
                        } else {
                            // FIXME: bug: llhttp cannot parse proxy URL
                            const path = parser.url.substring(parser.url.indexOf('/'));
                            host = headers.get('Host')!;
                            url = new URL(path, `http://${host}`);
                            port = parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
                        }
                    } catch (err) {
                        safeReject(new Error(`URL parse error: ${getErrMsg(err)}`));
                        return 24;
                    }

                    safeResolve({
                        method,
                        url: url.toString(),
                        host,
                        port,
                        headers,
                        bodyStream: stream.readable,
                        proxy: true,
                        keepAlive: isKeepAlive
                    });
                    return 0;
                } catch (err) {
                    safeReject(err);
                    return 24;
                }
            };
        });
    }

    private getMethodString(methodCode?: number): string | null {
        if (!methodCode) return null;
        for (const [name, code] of Object.entries(METHODS)) {
            if (code === methodCode) return name;
        }
        return null;
    }

    private async handleConnect(req: HTTPData, conn: Deno.Conn, remoteAddr: string) {
        let shouldProxy: boolean;
        try {
            shouldProxy = await this.decision.shouldProxy(req.host);
        } catch (err) {
            this.logger.error("Proxy decision failed", { host: req.host, error: getErrMsg(err) });
            shouldProxy = true;
        }

        this.logger.info("HTTP CONNECT routing decision", {
            remoteAddr,
            host: req.host,
            port: req.port,
            route: shouldProxy ? "proxy" : "direct"
        });

        try {
            await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
        } catch (err) {
            this.logger.error("Failed to send CONNECT response", { error: getErrMsg(err) });
            return;
        }

        try {
            if (shouldProxy) {
                this.logger.debug("Establishing proxy connection", {
                    remoteAddr,
                    host: req.host,
                    port: req.port
                });

                const stream = await this.client.connectTCP(req.host, req.port, CONNECT_TIMEOUT);

                const clientToProxy = req.bodyStream.pipeTo(stream.writable).catch((err) => {
                    this.logger.debug("Client to proxy pipe closed", { error: getErrMsg(err) });
                });

                const proxyToClient = stream.readable.pipeTo(conn.writable).catch((err) => {
                    this.logger.debug("Proxy to client pipe closed", { error: getErrMsg(err) });
                });

                await Promise.all([clientToProxy, proxyToClient]);

                this.logger.info("Proxy connection closed", {
                    remoteAddr,
                    host: req.host,
                    port: req.port
                });
            } else {
                this.logger.debug("Establishing direct connection", {
                    remoteAddr,
                    host: req.host,
                    port: req.port
                });

                const remote = await Deno.connect({ hostname: req.host, port: req.port });

                const clientToRemote = req.bodyStream.pipeTo(remote.writable).catch((err) => {
                    this.logger.debug("Client to remote pipe closed", { error: getErrMsg(err) });
                });

                const remoteToClient = remote.readable.pipeTo(conn.writable).catch((err) => {
                    this.logger.debug("Remote to client pipe closed", { error: getErrMsg(err) });
                });

                await Promise.all([clientToRemote, remoteToClient]);

                this.logger.info("Direct connection closed", {
                    remoteAddr,
                    host: req.host,
                    port: req.port
                });
            }
        } catch (err) {
            this.logger.error("Connection error", {
                remoteAddr,
                host: req.host,
                port: req.port,
                error: getErrMsg(err)
            });
        }
    }

    private async handleHTTP(req: HTTPData, conn: Deno.Conn, remoteAddr: string): Promise<boolean> {
        let shouldProxy: boolean;
        try {
            shouldProxy = await this.decision.shouldProxy(req.host);
        } catch (err) {
            this.logger.error("Proxy decision failed", { host: req.host, error: getErrMsg(err) });
            shouldProxy = true;
        }

        const fullUrl = req.url.startsWith("http") ? req.url : `http://${req.host}${req.url}`;

        this.logger.debug("HTTP request", {
            remoteAddr,
            method: req.method,
            url: fullUrl,
            keepAlive: req.keepAlive,
            route: shouldProxy ? "proxy" : "direct"
        });

        // GET/HEAD 请求不应该有 body
        const hasBody = req.method !== "GET" && req.method !== "HEAD" && 
                       (req.headers.get("content-length") || req.headers.get("transfer-encoding"));

        let response: Response;
        try {
            if (shouldProxy) {
                response = await this.client.fetchHTTP(fullUrl, {
                    method: req.method,
                    headers: Object.fromEntries(req.headers),
                    ...(hasBody && { body: req.bodyStream }),
                }, CONNECT_TIMEOUT);
            } else {
                response = await fetch(fullUrl, {
                    method: req.method,
                    headers: Object.fromEntries(req.headers),
                    body: req.bodyStream,
                });
            }
        } catch (err) {
            this.logger.error("HTTP fetch failed", {
                remoteAddr,
                url: fullUrl,
                error: getErrMsg(err)
            });
            
            try {
                await conn.write(new TextEncoder().encode(
                    `HTTP/1.1 502 Bad Gateway\r\n` +
                    `Content-Type: text/plain\r\n` +
                    `Connection: ${req.keepAlive ? 'keep-alive' : 'close'}\r\n` +
                    `\r\n` +
                    `Proxy Error: ${getErrMsg(err)}\r\n`
                ));
            } catch { /* ignore */ }
            return req.keepAlive;
        }

        // 写入响应
        try {
            const connectionHeader = req.keepAlive && response.headers.get('connection') !== 'close'
                ? 'keep-alive' 
                : 'close';
            
            const statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
            await conn.write(new TextEncoder().encode(statusLine));

            for (const [key, value] of response.headers) {
                if (key.toLowerCase() === 'connection') continue;
                await conn.write(new TextEncoder().encode(`${key}: ${value}\r\n`));
            }
            await conn.write(new TextEncoder().encode(`Connection: ${connectionHeader}\r\n`));
            await conn.write(new TextEncoder().encode("\r\n"));

            if (response.body) {
                // 手动读取并写入，不使用 pipeTo，以便正确处理 keep-alive
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        await conn.write(value);
                    }
                } finally {
                    reader.releaseLock();
                }
            }
            
            return connectionHeader === 'keep-alive';
        } catch (err) {
            this.logger.debug("Write HTTP response failed", { error: getErrMsg(err) });
            return false;
        }
    }
}
