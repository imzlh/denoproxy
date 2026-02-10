import { Log } from "@cross/log";
import ProxyClient from "../core/client.ts";
import { ProxyDecision } from "./proxy-decision.ts";
import { getErrMsg } from "../utils/error.ts";

const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const CMD_CONNECT = 0x01;
const CMD_UDP = 0x03;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONNECTION_REFUSED = 0x05;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_NOT_SUPPORTED = 0x08;

const CONNECTION_TIMEOUT = 30000;

export async function readExact(reader: ReadableStreamDefaultReader<Uint8Array>, n: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(n);
    let offset = 0;

    while (offset < n) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Connection closed unexpectedly");
        const toCopy = Math.min(value.length, n - offset);
        buffer.set(value.slice(0, toCopy), offset);
        offset += toCopy;
    }

    return buffer;
}

export async function handshake(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>) {
    const greeting = await readExact(reader, 2);
    if (greeting[0] !== SOCKS_VERSION) throw new Error(`Invalid SOCKS version: ${greeting[0]}`);

    const nMethods = greeting[1];
    if (nMethods === 0) throw new Error("No authentication methods provided");
    
    await readExact(reader, nMethods); // Read methods

    // Response: use no auth
    await writer.write(new Uint8Array([SOCKS_VERSION, AUTH_NONE]));
}

export async function readRequest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{
    cmd: number;
    host: string;
    port: number;
}> {
    const header = await readExact(reader, 4);
    if (header[0] !== SOCKS_VERSION) throw new Error(`Invalid SOCKS version: ${header[0]}`);

    const cmd = header[1];
    const atyp = header[3];

    let host: string;

    if (atyp === ATYP_IPV4) {
        const addr = await readExact(reader, 4);
        host = Array.from(addr).join(".");
    } else if (atyp === ATYP_DOMAIN) {
        const len = (await readExact(reader, 1))[0];
        if (len === 0) throw new Error("Empty domain name");
        const domain = await readExact(reader, len);
        host = new TextDecoder().decode(domain);
    } else if (atyp === ATYP_IPV6) {
        const addr = await readExact(reader, 16);
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(((addr[i] << 8) | addr[i + 1]).toString(16));
        }
        host = parts.join(":");
    } else {
        throw new Error(`Unsupported address type: ${atyp}`);
    }

    const portBytes = await readExact(reader, 2);
    const port = (portBytes[0] << 8) | portBytes[1];

    if (port === 0) throw new Error("Invalid port: 0");

    return { cmd, host, port };
}

export async function sendReply(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    rep: number,
    bindAddr = "0.0.0.0",
    bindPort = 0
) {
    const addrParts = bindAddr.split(".");
    if (addrParts.length !== 4) throw new Error("Invalid bind address");
    
    const response = new Uint8Array([
        SOCKS_VERSION,
        rep,
        0x00, // Reserved
        ATYP_IPV4,
        ...addrParts.map(Number),
        (bindPort >> 8) & 0xff,
        bindPort & 0xff,
    ]);

    await writer.write(response);
}


export class SOCKS5Handler {
    constructor(
        private client: ProxyClient,
        private decision: ProxyDecision,
        private logger: Log
    ) { }

    async handle(conn: Deno.Conn, firstChunk: Uint8Array) {
        const remoteAddr = (conn.remoteAddr as Deno.NetAddr).hostname;
        this.logger.info("New SOCKS5 connection", { remoteAddr });

        const prefixedReader = new PrefixedReader(conn.readable, firstChunk);
        const reader = prefixedReader.getReader();
        const writer = conn.writable.getWriter();

        try {
            this.logger.debug("SOCKS5 handshake", { remoteAddr });
            await handshake(reader, writer);

            const req = await readRequest(reader);
            this.logger.info("SOCKS5 request", {
                remoteAddr,
                cmd: req.cmd === CMD_CONNECT ? "CONNECT" : req.cmd === CMD_UDP ? "UDP" : `UNKNOWN(${req.cmd})`,
                host: req.host,
                port: req.port
            });

            if (req.cmd === CMD_CONNECT) {
                await this.handleTCP(req.host, req.port, reader, writer, conn, remoteAddr);
            } else if (req.cmd === CMD_UDP) {
                await this.handleUDP(req.host, req.port, writer, remoteAddr);
            } else {
                this.logger.warn("SOCKS5 command not supported", {
                    remoteAddr,
                    cmd: req.cmd
                });
                await sendReply(writer, REP_COMMAND_NOT_SUPPORTED);
                conn.close();
            }
        } catch (err) {
            this.logger.error("SOCKS5 handler error", {
                remoteAddr,
                error: getErrMsg(err)
            });
            try {
                await sendReply(writer, REP_GENERAL_FAILURE);
            } catch { /* ignore */ }
            conn.close();
        }
    }

    private async handleTCP(
        host: string,
        port: number,
        reader: ReadableStreamDefaultReader<Uint8Array>,
        writer: WritableStreamDefaultWriter<Uint8Array>,
        conn: Deno.Conn,
        remoteAddr: string
    ) {
        let shouldProxy: boolean;
        try {
            shouldProxy = await this.decision.shouldProxy(host);
        } catch (err) {
            this.logger.error("Proxy decision failed", { host, error: getErrMsg(err) });
            shouldProxy = true; // 默认使用代理
        }

        this.logger.info("SOCKS5 routing decision", {
            remoteAddr,
            host,
            port,
            route: shouldProxy ? "proxy" : "direct"
        });

        await sendReply(writer, REP_SUCCESS);
        reader.releaseLock();
        writer.releaseLock();

        try {
            if (shouldProxy) {
                this.logger.debug("SOCKS5 establishing proxy connection", {
                    remoteAddr,
                    host,
                    port
                });

                const stream = await this.client.connectTCP(host, port, CONNECTION_TIMEOUT);

                // Bidirectional pipe
                const clientToProxy = conn.readable.pipeTo(stream.writable).catch((err) => {
                    this.logger.debug("SOCKS5 client to proxy pipe closed", {
                        remoteAddr,
                        host,
                        port,
                        error: getErrMsg(err)
                    });
                });

                const proxyToClient = stream.readable.pipeTo(conn.writable).catch((err) => {
                    this.logger.debug("SOCKS5 proxy to client pipe closed", {
                        remoteAddr,
                        host,
                        port,
                        error: getErrMsg(err)
                    });
                });

                await Promise.all([clientToProxy, proxyToClient]);

                this.logger.info("SOCKS5 proxy connection closed", {
                    remoteAddr,
                    host,
                    port
                });
            } else {
                this.logger.debug("SOCKS5 establishing direct connection", {
                    remoteAddr,
                    host,
                    port
                });

                const remote = await Deno.connect({ hostname: host, port });

                // Bidirectional pipe
                const clientToRemote = conn.readable.pipeTo(remote.writable).catch((err) => {
                    this.logger.debug("SOCKS5 client to remote pipe closed", {
                        remoteAddr,
                        host,
                        port,
                        error: getErrMsg(err)
                    });
                });

                const remoteToClient = remote.readable.pipeTo(conn.writable).catch((err) => {
                    this.logger.debug("SOCKS5 remote to client pipe closed", {
                        remoteAddr,
                        host,
                        port,
                        error: getErrMsg(err)
                    });
                });

                await Promise.all([clientToRemote, remoteToClient]);

                this.logger.info("SOCKS5 direct connection closed", {
                    remoteAddr,
                    host,
                    port
                });
            }
        } catch (err) {
            this.logger.error("SOCKS5 connection error", {
                remoteAddr,
                host,
                port,
                error: getErrMsg(err)
            });
        } finally {
            conn.close();
        }
    }

    private async handleUDP(
        host: string,
        port: number,
        writer: WritableStreamDefaultWriter<Uint8Array>,
        remoteAddr: string
    ) {
        let udpConn: Deno.DatagramConn | null = null;
        
        try {
            udpConn = Deno.listenDatagram({
                hostname: "127.0.0.1",
                port: 0,
                transport: "udp",
            });

            this.logger.info("SOCKS5 UDP relay started", {
                remoteAddr,
                host,
                port,
                localAddr: udpConn.addr
            });

            const addr = udpConn.addr as Deno.NetAddr;
            await sendReply(writer, REP_SUCCESS, addr.hostname, addr.port);
            writer.releaseLock();

            await this.relayUDP(udpConn, host, port, remoteAddr);
        } catch (err) {
            this.logger.error("SOCKS5 UDP relay error", {
                remoteAddr,
                host,
                port,
                error: getErrMsg(err)
            });
            try {
                await sendReply(writer, REP_GENERAL_FAILURE);
            } catch { /* ignore */ }
            udpConn?.close();
        }
    }

    private async relayUDP(conn: Deno.DatagramConn, host: string, port: number, remoteAddr: string) {
        const sessions = new Map<string, { hostname: string; port: number; lastActivity: number }>();
        const SESSION_TIMEOUT = 60000; // 60秒会话超时
        
        // 清理过期会话的定时器
        const cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, session] of sessions) {
                if (now - session.lastActivity > SESSION_TIMEOUT) {
                    this.logger.debug("SOCKS5 UDP session timeout", { remoteAddr, key });
                    sessions.delete(key);
                }
            }
        }, 30000);

        try {
            while (true) {
                const [data, sender] = await conn.receive();

                if (data.length < 10) continue;

                const frag = data[2];
                if (frag !== 0) continue; // 不支持分片

                const atyp = data[3];
                let targetHost: string;
                let targetPort: number;
                let offset = 4;

                if (atyp === ATYP_IPV4) {
                    if (data.length < 10) continue;
                    targetHost = `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`;
                    offset += 4;
                } else if (atyp === ATYP_DOMAIN) {
                    if (data.length < 5) continue;
                    const len = data[offset];
                    if (data.length < 5 + len) continue;
                    const domain = new TextDecoder().decode(data.slice(offset + 1, offset + 1 + len));
                    targetHost = domain;
                    offset += 1 + len;
                } else if (atyp === ATYP_IPV6) {
                    if (data.length < 19) continue;
                    const parts: string[] = [];
                    for (let i = 0; i < 8; i++) {
                        parts.push((data[offset + i * 2] << 8 | data[offset + i * 2 + 1]).toString(16));
                    }
                    targetHost = parts.join(":");
                    offset += 16;
                } else {
                    continue;
                }

                targetPort = (data[offset] << 8) | data[offset + 1];
                const payload = data.slice(offset + 2);

                const key = `${sender.transport}_${(sender as Deno.NetAddr).hostname ?? "unix"}_${(sender as Deno.NetAddr).port ?? 0}`;
                sessions.set(key, { hostname: targetHost, port: targetPort, lastActivity: Date.now() });

                let shouldProxy: boolean;
                try {
                    shouldProxy = await this.decision.shouldProxy(targetHost);
                } catch (err) {
                    shouldProxy = true;
                }

                let targetAddr: { hostname: string; port: number; transport: "udp" };

                if (shouldProxy) {
                    try {
                        const ips = await this.client.queryDNS(targetHost, "A", 5000);
                        targetAddr = ips.length > 0
                            ? { hostname: ips[0], port: targetPort, transport: "udp" }
                            : { hostname: targetHost, port: targetPort, transport: "udp" };
                    } catch (err) {
                        this.logger.debug("DNS lookup failed for UDP, using hostname", {
                            remoteAddr,
                            targetHost,
                            error: getErrMsg(err)
                        });
                        targetAddr = { hostname: targetHost, port: targetPort, transport: "udp" };
                    }
                } else {
                    targetAddr = { hostname: targetHost, port: targetPort, transport: "udp" };
                }

                await conn.send(payload, targetAddr);
            }
        } catch (err) {
            this.logger.debug("SOCKS5 UDP relay ended", {
                remoteAddr,
                error: getErrMsg(err)
            });
        } finally {
            clearInterval(cleanupInterval);
            conn.close();
            sessions.clear();
        }
    }
}

class PrefixedReader {
    private prefixConsumed = false;

    constructor(
        private stream: ReadableStream<Uint8Array>,
        private prefix: Uint8Array
    ) { }

    getReader(): ReadableStreamDefaultReader<Uint8Array> {
        const self = this;
        
        return new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                if (!self.prefixConsumed) {
                    self.prefixConsumed = true;
                    controller.enqueue(self.prefix);
                    return;
                }

                const reader = self.stream.getReader();
                try {
                    const { value, done } = await reader.read();
                    if (done) {
                        controller.close();
                    } else {
                        controller.enqueue(value);
                    }
                } finally {
                    reader.releaseLock();
                }
            },
        }).getReader();
    }
}
