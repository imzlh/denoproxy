import { getErrMsg } from "../../utils/error.ts";
import { MessageType } from "../protocol.ts";
import { Log } from "@cross/log";

const DEFAULT_UDP_BUFFER_SIZE = 2048;
const MAX_UDP_PACKET_SIZE = 65535;
const MAX_WS_BUFFERED_AMOUNT = 1024 * 1024;

export class UDPProxy {
    private sockets = new Map<number, Deno.DatagramConn>();
    private closingSockets = new Set<number>();
    private getBufferedAmount: () => number;

    constructor(
        private sendMessage: (type: MessageType, id: number, data: Uint8Array) => void,
        private logger?: Log,
        getBufferedAmount?: () => number
    ) {
        this.getBufferedAmount = getBufferedAmount || (() => 0);
    }

    handleBind(resourceId: number, data: Uint8Array) {
        let conn: Deno.DatagramConn | null = null;
        try {
            if (data.length < 4) {
                throw new Error("Invalid bind data: too short");
            }
            
            let pos = 0;
            const hostLen = data[pos++] | (data[pos++] << 8);
            if (data.length < 2 + hostLen + 2) {
                throw new Error("Invalid bind data: host truncated");
            }
            const host = new TextDecoder().decode(data.subarray(pos, pos + hostLen));
            pos += hostLen;
            const port = data[pos] | (data[pos + 1] << 8);

            this.logger?.debug("UDP bind request", {
                resourceId: resourceId.toString(),
                host,
                port
            });

            conn = Deno.listenDatagram({
                hostname: "0.0.0.0",
                port: 0,
                transport: "udp"
            });

            this.sockets.set(resourceId, conn);
            const addr = conn.addr as Deno.NetAddr;

            const responseHost = new TextEncoder().encode(addr.hostname);
            const response = new Uint8Array(2 + responseHost.length + 2);
            let respPos = 0;
            response[respPos++] = responseHost.length & 0xff;
            response[respPos++] = (responseHost.length >> 8) & 0xff;
            response.set(responseHost, respPos);
            respPos += responseHost.length;
            const portNum = addr.port;
            response[respPos++] = portNum & 0xff;
            response[respPos++] = (portNum >> 8) & 0xff;

            this.sendMessage(MessageType.UDP_BIND_ACK, resourceId, response);

            this.logger?.debug("UDP bind successful", {
                resourceId: resourceId.toString(),
                localAddr: `${addr.hostname}:${addr.port}`
            });

            // FIX: 启动 receiveLoop 并处理错误
            this.receiveLoop(resourceId, conn).catch(err => {
                this.logger?.error("UDP receive loop error", {
                    resourceId: resourceId.toString(),
                    error: getErrMsg(err)
                });
                this.close(resourceId);
            });
        } catch (err) {
            this.logger?.error("UDP bind failed", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
            if (conn) {
                try { conn.close(); } catch { /* ignore */ }
            }
            this.sendError(resourceId, getErrMsg(err));
        }
    }

    async handleData(resourceId: number, data: Uint8Array) {
        const conn = this.sockets.get(resourceId);
        if (!conn) {
            this.logger?.debug("UDP data for unknown socket (likely closed)", {
                resourceId: resourceId.toString()
            });
            return;
        }

        if (this.closingSockets.has(resourceId)) {
            return;
        }

        try {
            if (data.length < 4) {
                throw new Error("Invalid UDP data: too short");
            }
            
            let pos = 0;
            const hostLen = data[pos++] | (data[pos++] << 8);
            if (data.length < 2 + hostLen + 2) {
                throw new Error("Invalid UDP data: host truncated");
            }
            const targetHost = new TextDecoder().decode(data.subarray(pos, pos + hostLen));
            pos += hostLen;
            const targetPort = data[pos] | (data[pos + 1] << 8);
            pos += 2;
            const payload = data.subarray(pos);

            if (payload.length > MAX_UDP_PACKET_SIZE) {
                throw new Error("UDP payload too large");
            }

            const targetAddr: Deno.NetAddr = {
                hostname: targetHost,
                port: targetPort,
                transport: "udp"
            };

            await conn.send(payload, targetAddr);
        } catch (err) {
            this.logger?.debug("UDP send failed", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
    }

    close(resourceId: number) {
        if (this.closingSockets.has(resourceId)) {
            return;
        }

        const conn = this.sockets.get(resourceId);
        if (!conn) return;

        this.closingSockets.add(resourceId);

        try {
            this.logger?.debug("Closing UDP socket", {
                resourceId: resourceId.toString()
            });
            conn.close();
        } catch (err) {
            this.logger?.debug("Error closing UDP socket", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }

        this.sockets.delete(resourceId);
        this.closingSockets.delete(resourceId);

        try {
            this.sendMessage(MessageType.UDP_CLOSE, resourceId, new Uint8Array(0));
        } catch (err) {
            this.logger?.debug("Error sending UDP_CLOSE", {
                error: getErrMsg(err)
            });
        }
    }

    private async receiveLoop(resourceId: number, conn: Deno.DatagramConn) {
        const buffer = new Uint8Array(DEFAULT_UDP_BUFFER_SIZE);
        
        try {
            while (!this.closingSockets.has(resourceId)) {
                // 简单的背压控制
                while (this.getBufferedAmount() > MAX_WS_BUFFERED_AMOUNT) {
                    await new Promise(r => setTimeout(r, 10));
                }

                try {
                    const [data, addr] = await conn.receive();
                    
                    if (data.length > MAX_UDP_PACKET_SIZE) {
                        this.logger?.warn("Received oversized UDP packet", {
                            resourceId: resourceId.toString(),
                            size: data.length
                        });
                        continue;
                    }
                    
                    this.sendUDPData(resourceId, new Uint8Array(data), addr as Deno.NetAddr);
                } catch (err) {
                    const errorMsg = getErrMsg(err);
                    if (errorMsg.includes("closed") || errorMsg.includes("Bad resource")) {
                        break;
                    }
                    this.logger?.debug("UDP receive error", {
                        resourceId: resourceId.toString(),
                        error: errorMsg
                    });
                }
            }
        } finally {
            this.close(resourceId);
        }
    }

    private sendUDPData(resourceId: number, data: Uint8Array, addr: Deno.NetAddr) {
        const hostname = addr.hostname;
        const port = addr.port;
        const hostnameBytes = new TextEncoder().encode(hostname);

        const payload = new Uint8Array(2 + hostnameBytes.length + 2 + data.length);
        let pos = 0;

        payload[pos++] = hostnameBytes.length & 0xff;
        payload[pos++] = (hostnameBytes.length >> 8) & 0xff;
        payload.set(hostnameBytes, pos);
        pos += hostnameBytes.length;

        payload[pos++] = port & 0xff;
        payload[pos++] = (port >> 8) & 0xff;

        payload.set(data, pos);

        this.sendMessage(MessageType.UDP_DATA, resourceId, payload);
    }

    private sendError(resourceId: number, message: string) {
        try {
            const data = new TextEncoder().encode(message);
            this.sendMessage(MessageType.ERROR, resourceId, data);
        } catch (err) {
            this.logger?.error("Failed to send UDP error", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
    }

    closeAll() {
        const count = this.sockets.size;
        if (count === 0) return;

        this.logger?.info("Closing all UDP sockets", { count });
        
        const ids = [...this.sockets.keys()];
        for (const id of ids) {
            this.close(id);
        }
    }
}
