import type ProxyClient from "../core/client.ts"
import type { ProxyDecision } from "./proxy-decision.ts";
import type { Log } from "@cross/log";
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
        // leftover accumulates bytes read from conn but not yet consumed by a request
        let leftover = firstChunk;

        while (true) {
            try {
                const result = await this.readHTTPRequest(conn, leftover);
                
                if (!result) break;

                const { req, remaining } = result;
                leftover = remaining;

                if (!req.proxy) {
                    await this.handleLocalRequest(req, conn);
                    if (!req.keepAlive) break;
                    continue;
                }

                if (req.method === "CONNECT") {
                    await this.handleConnect(req, conn, remoteAddr);
                    return;
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

        try {
            conn.close();
        } catch { /* ignore Bad resource ID */ }
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

    private readHTTPRequest(
        conn: Deno.Conn,
        firstChunk: Uint8Array
    ): Promise<{ req: HTTPData; remaining: Uint8Array } | null> {
        return new Promise((resolve, reject) => {
            const parser = createParser(TYPE.REQUEST);
            let resolved = false;
            let bodyWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
            let timeoutId: number | null = null;
            // We accumulate ALL bytes fed to the parser so we can slice off
            // whatever the parser did not consume (= next request's bytes).
            const fed: Uint8Array[] = [];
            let fedTotal = 0;
            // Byte offset inside the accumulated buffer where the parser paused.
            // -1 means "parser consumed everything so far".
            let pauseOffset = -1;

            const cleanup = () => {
                resolved = true;
                if (timeoutId) clearTimeout(timeoutId);
                if (bodyWriter) {
                    try { bodyWriter.close(); } catch { /* ignore */ }
                    bodyWriter = null;
                }
            };

            const safeReject = (reason: unknown) => {
                if (!resolved) { cleanup(); reject(reason); }
            };

            const safeResolve = (data: HTTPData | null) => {
                if (!resolved) {
                    cleanup();
                    if (data === null) {
                        resolve(null);
                        return;
                    }
                    // Compute remaining bytes: everything after pauseOffset
                    let remaining: Uint8Array;
                    if (pauseOffset >= 0 && pauseOffset < fedTotal) {
                        // Flatten accumulated chunks into one buffer then slice
                        const all = new Uint8Array(fedTotal);
                        let pos = 0;
                        for (const c of fed) { all.set(c, pos); pos += c.length; }
                        remaining = all.slice(pauseOffset);
                    } else {
                        remaining = new Uint8Array(0);
                    }
                    resolve({ req: data, remaining });
                }
            };

            // Track bytes fed to parser; record pause position when errno===22
            const feedParser = (buf: Uint8Array): number => {
                const offsetBefore = fedTotal;
                fed.push(buf);
                fedTotal += buf.length;
                const errno = parser.execute(buf);
                if (errno === 22) {
                    // HPE_PAUSED: parser stopped somewhere inside buf.
                    // Use getErrorPos() if available, otherwise assume it consumed
                    // exactly up to the end of headers (we'll get extra bytes which
                    // is fine - llhttp will reject them on next parse if wrong).
                    try {
                        // getErrorPos returns offset relative to the buffer passed to execute
                        const posInBuf: number = (parser as any).getErrorPos?.() ?? buf.length;
                        pauseOffset = offsetBefore + posInBuf;
                    } catch {
                        pauseOffset = offsetBefore + buf.length;
                    }
                }
                return errno;
            };

            timeoutId = setTimeout(() => {
                safeReject(new Error("Keep-alive timeout"));
            }, KEEP_ALIVE_TIMEOUT);

            (async () => {
                const chunk = new Uint8Array(MAX_HEADER_SIZE);
                let errno = 0;
                
                if (firstChunk.length) {
                    errno = feedParser(firstChunk);
                }
                
                while (!resolved && errno !== 22) {
                    if (errno !== 0) {
                        safeReject(new Error(`HTTP parse error: ${parser.getErrorReason(errno)}`));
                        return;
                    }
                    try {
                        const n = await conn.read(chunk);
                        if (n === null) { if (!resolved) safeResolve(null); return; }
                        if (n === 0) continue;
                        errno = feedParser(chunk.subarray(0, n));
                    } catch (err) {
                        safeReject(err);
                        return;
                    }
                }

                // Feed body bytes (POST/PUT with body); keepAlive is forced false
                // for requests with body so there's no next-request race.
                while (bodyWriter) {
                    try {
                        const n = await conn.read(chunk);
                        if (n === null) break;
                        if (n === 0) continue;
                        parser.execute(chunk.subarray(0, n));
                    } catch { break; }
                }
            })();

            const stream = new TransformStream<Uint8Array, Uint8Array>({
                start: () => {},
                transform: (chunk, controller) => { controller.enqueue(chunk); }
            });

            parser.onBody = (data: Uint8Array) => {
                if (!bodyWriter) bodyWriter = stream.writable.getWriter();
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
                    
                    const connection = headers.get('connection') || '';
                    const proxyConnection = headers.get('proxy-connection') || '';
                    const isKeepAlive = h.versionMajor === 1 && h.versionMinor === 1 
                        ? (connection.toLowerCase() !== 'close' && proxyConnection.toLowerCase() !== 'close')
                        : (connection.toLowerCase() === 'keep-alive' || proxyConnection.toLowerCase() === 'keep-alive');
                    
                    if (h.method === METHODS.CONNECT) {
                        const match = connectUrl.match(/^([a-z0-9\-\.]+):(\d{1,5})$/i);
                        if (!match) {
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
                            method: "CONNECT", url: '/', host, port, headers,
                            bodyStream: conn.readable, proxy: true, keepAlive: false
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
                            // Direct request: GET /path HTTP/1.1
                            const hostHeader = headers.get("host");
                            if (!hostHeader) { safeReject(new Error("Missing Host header")); return 24; }
                            const [h2, p] = hostHeader.split(':');
                            host = h2; port = p ? parseInt(p) : 80;
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
                        method, url: url.toString(), host, port, headers,
                        bodyStream: stream.readable, proxy: true,
                        // Disable keep-alive when request has body to avoid conn.read race
                        keepAlive: isKeepAlive && !headers.get('content-length') && !headers.get('transfer-encoding')
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

        this.logger.debug("HTTP CONNECT routing decision", {
            remoteAddr,
            host: req.host,
            port: req.port,
            route: shouldProxy ? "proxy" : "direct"
        });

        try {
            if (shouldProxy) {
                this.logger.debug("Establishing proxy connection", {
                    remoteAddr,
                    host: req.host,
                    port: req.port
                });

                const stream = await this.client.connectTCP(req.host, req.port, CONNECT_TIMEOUT);

                await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));

                const clientToProxy = req.bodyStream.pipeTo(stream.writable, { preventClose: true }).catch((err) => {
                    this.logger.debug("Client to proxy pipe closed", { error: getErrMsg(err) });
                });

                const proxyToClient = stream.readable.pipeTo(conn.writable, { preventClose: true }).catch((err) => {
                    this.logger.debug("Proxy to client pipe closed", { error: getErrMsg(err) });
                });

                await Promise.all([clientToProxy, proxyToClient]);

                this.logger.debug("Proxy connection closed", {
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

                await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));

                const clientToRemote = req.bodyStream.pipeTo(remote.writable, { preventClose: true }).catch((err) => {
                    this.logger.debug("Client to remote pipe closed", { error: getErrMsg(err) });
                });

                const remoteToClient = remote.readable.pipeTo(conn.writable, { preventClose: true }).catch((err) => {
                    this.logger.debug("Remote to client pipe closed", { error: getErrMsg(err) });
                });

                await Promise.all([clientToRemote, remoteToClient]);

                this.logger.debug("Direct connection closed", {
                    remoteAddr,
                    host: req.host,
                    port: req.port
                });
            }
        } catch (err) {
            const errMsg = getErrMsg(err);
            this.logger.error("Connection error", {
                remoteAddr,
                host: req.host,
                port: req.port,
                error: errMsg
            });
            
            try {
                if (errMsg.includes("refused") || errMsg.includes("10061")) {
                    await conn.write(new TextEncoder().encode("HTTP/1.1 502 Bad Gateway\r\n\r\nConnection refused by target\r\n"));
                } else if (errMsg.includes("timeout")) {
                    await conn.write(new TextEncoder().encode("HTTP/1.1 504 Gateway Timeout\r\n\r\nConnection timeout\r\n"));
                } else {
                    await conn.write(new TextEncoder().encode("HTTP/1.1 502 Bad Gateway\r\n\r\nProxy error\r\n"));
                }
            } catch { /* ignore */ }
        } finally {
            try {
                conn.close();
            } catch { /* ignore Bad resource ID */ }
        }
    }

    // WebSocket upgrade: replay the HTTP handshake over a raw TCP tunnel,
    // then pipe the upgraded connection bidirectionally.
    private async handleWebSocketTunnel(
        req: HTTPData, conn: Deno.Conn, remoteAddr: string,
        fullUrl: string, shouldProxy: boolean
    ): Promise<boolean> {
        this.logger.debug("WebSocket tunnel", { remoteAddr, url: fullUrl });

        try {
            // Reconstruct the original GET request to replay to the upstream
            let reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
            req.headers.forEach((v, k) => { reqLine += `${k}: ${v}\r\n`; });
            reqLine += '\r\n';
            const reqBytes = new TextEncoder().encode(reqLine);

            if (shouldProxy) {
                const stream = await this.client.connectTCP(req.host, req.port, CONNECT_TIMEOUT);
                // Send the original WS upgrade request upstream
                const writer = stream.writable.getWriter();
                await writer.write(reqBytes);
                writer.releaseLock();

                // Pipe bidirectionally
                await Promise.all([
                    conn.readable.pipeTo(stream.writable, { preventClose: true }).catch(() => {}),
                    stream.readable.pipeTo(conn.writable, { preventClose: true }).catch(() => {}),
                ]);
            } else {
                const remote = await Deno.connect({ hostname: req.host, port: req.port });
                await remote.write(reqBytes);
                await Promise.all([
                    conn.readable.pipeTo(remote.writable, { preventClose: true }).catch(() => {}),
                    remote.readable.pipeTo(conn.writable, { preventClose: true }).catch(() => {}),
                ]);
            }
        } catch (err) {
            this.logger.debug("WebSocket tunnel error", { remoteAddr, error: getErrMsg(err) });
        }
        return false; // connection consumed, don't keep-alive
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

        // WebSocket upgrade: must tunnel as raw TCP, not HTTP fetch
        const upgrade = req.headers.get('upgrade')?.toLowerCase();
        if (upgrade === 'websocket') {
            return await this.handleWebSocketTunnel(req, conn, remoteAddr, fullUrl, shouldProxy);
        }

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
                    body: hasBody ? req.bodyStream : undefined,
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

        // Write response - buffer headers into single write
        try {
            const responseConnection = response.headers.get('connection')?.toLowerCase() || '';
            const isResponseKeepAlive = responseConnection !== 'close';
            const connectionHeader = req.keepAlive && isResponseKeepAlive ? 'keep-alive' : 'close';

            // Check if response already has a definite length
            const contentLength = response.headers.get('content-length');
            const hasDefiniteLength = !!contentLength;
            // Use chunked encoding when keep-alive and no content-length, so client
            // knows where body ends without closing the connection.
            const useChunked = connectionHeader === 'keep-alive' && !hasDefiniteLength && !!response.body;

            let headerStr = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
            for (const [key, value] of response.headers) {
                const lk = key.toLowerCase();
                if (lk === 'connection' || lk === 'transfer-encoding') continue;
                headerStr += `${key}: ${value}\r\n`;
            }
            if (useChunked) headerStr += `Transfer-Encoding: chunked\r\n`;
            headerStr += `Connection: ${connectionHeader}\r\n\r\n`;
            await conn.write(new TextEncoder().encode(headerStr));

            if (response.body) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (useChunked) {
                            // chunked format: <hex-length>\r\n<data>\r\n
                            await conn.write(new TextEncoder().encode(value.length.toString(16) + '\r\n'));
                            await conn.write(value);
                            await conn.write(new TextEncoder().encode('\r\n'));
                        } else {
                            await conn.write(value);
                        }
                    }
                    if (useChunked) {
                        await conn.write(new TextEncoder().encode('0\r\n\r\n'));
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
