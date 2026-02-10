import { getErrMsg } from "../../utils/error.ts";
import { DnsType, DnsType2String, MessageType } from "../protocol.ts";
import { Log } from "@cross/log";

const DNS_QUERY_TIMEOUT = 10000; // 10秒DNS查询超时
const MAX_DNS_NAME_LENGTH = 253; // DNS名称最大长度

export class DNSProxy {
    private pendingQueries = new Map<number, {
        name: string;
        recordType: DnsType;
        startTime: number;
        timeoutId: number;
    }>();

    constructor(
        private sendMessage: (type: MessageType, id: number, data: Uint8Array) => void,
        private logger?: Log
    ) { }

    async handleQuery(resourceId: number, data: Uint8Array) {
        let timeoutId: number | undefined;
        
        try {
            // 裸二进制解析：nameLen(2字节小端) + name + recordType(1字节)
            if (data.length < 3) {
                throw new Error("Invalid DNS query: too short");
            }
            
            let pos = 0;
            const nameLen = data[pos] | (data[pos + 1] << 8);
            pos += 2;
            
            if (nameLen > MAX_DNS_NAME_LENGTH) {
                throw new Error("DNS name too long");
            }
            
            if (data.length < 2 + nameLen + 1) {
                throw new Error("Invalid DNS query: name truncated");
            }
            
            const name = new TextDecoder().decode(data.subarray(pos, pos + nameLen));
            pos += nameLen;
            const recordType = data[pos] as DnsType;

            if (!DnsType2String(recordType)) {
                throw new Error(`Unsupported DNS record type: ${recordType}`);
            }

            this.logger?.info("DNS query", {
                resourceId: resourceId.toString(),
                name,
                recordType: DnsType2String(recordType)
            });

            const startTime = Date.now();
            
            // 设置超时
            timeoutId = setTimeout(() => {
                this.pendingQueries.delete(resourceId);
                this.sendError(resourceId, "DNS query timeout");
                this.logger?.warn("DNS query timeout", {
                    resourceId: resourceId.toString(),
                    name
                });
            }, DNS_QUERY_TIMEOUT);

            this.pendingQueries.set(resourceId, { name, recordType, startTime, timeoutId });

            const result = await Deno.resolveDns(name, DnsType2String(recordType) as 'A' | 'AAAA' | 'ANAME' | 'CNAME' | 'NS' | 'PTR');
            
            // 查询完成，清除超时
            if (timeoutId) clearTimeout(timeoutId);
            this.pendingQueries.delete(resourceId);

            const elapsed = Date.now() - startTime;

            this.logger?.info("DNS response", {
                resourceId: resourceId.toString(),
                name,
                resultCount: result.length,
                elapsedMs: elapsed
            });

            // 裸二进制编码响应：count(2字节小端) + [ipLen(2字节小端) + ip]...
            let totalLen = 2; // count
            for (const ip of result) {
                const ipBytes = new TextEncoder().encode(ip);
                totalLen += 2 + ipBytes.length;
            }

            const response = new Uint8Array(totalLen);
            let respPos = 0;

            // count
            const count = result.length;
            response[respPos++] = count & 0xff;
            response[respPos++] = (count >> 8) & 0xff;

            // IPs
            for (const ip of result) {
                const ipBytes = new TextEncoder().encode(ip);
                const ipLen = ipBytes.length;
                response[respPos++] = ipLen & 0xff;
                response[respPos++] = (ipLen >> 8) & 0xff;
                response.set(ipBytes, respPos);
                respPos += ipBytes.length;
            }

            this.sendMessage(MessageType.DNS_RESPONSE, resourceId, response);
        } catch (err) {
            if (timeoutId) clearTimeout(timeoutId);
            this.pendingQueries.delete(resourceId);
            
            this.logger?.error("DNS query failed", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
            this.sendError(resourceId, getErrMsg(err));
        }
    }

    private sendError(resourceId: number, message: string) {
        try {
            const msgBytes = new TextEncoder().encode(message);
            const response = new Uint8Array(1 + msgBytes.length);
            response[0] = 1; // error flag
            response.set(msgBytes, 1);
            this.sendMessage(MessageType.ERROR, resourceId, response);
        } catch (err) {
            this.logger?.error("Failed to send DNS error", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
    }

    // 清理正在进行的查询
    abortAll() {
        for (const [id, query] of this.pendingQueries) {
            if (query.timeoutId) clearTimeout(query.timeoutId);
            this.logger?.debug("Aborting DNS query", {
                resourceId: id.toString(),
                name: query.name
            });
        }
        this.pendingQueries.clear();
    }
}
