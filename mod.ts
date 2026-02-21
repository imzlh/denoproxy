/**
 * DenoProxy
 * 高性能代理系统，支持 HTTP、SOCKS5、TCP、UDP 和 DNS 代理
 */

export {
    MessageType,
    type ProxyMessage,
    type HTTPResponse,
    DnsType,
    DnsType2String,
    HEADER_SIZE
} from "./core/protocol.ts";

export {
    encodeMessage,
    decodeMessage
} from "./core/codec.ts";

export { default as ProxyClient, TCPStream } from "./core/client.ts";
export { ProxyTransport } from "./core/transport.ts";
export { CommandHandler } from "./core/command.ts";

export { TCPProxy } from "./core/protocol/tcp.ts";
export { UDPProxy } from "./core/protocol/udp.ts";
export { DNSProxy } from "./core/protocol/dns.ts";
export { HTTPProxy } from "./core/protocol/http-proxy.ts";

export { encode, decode, tryDecode, encodeToBase64, decodeFromBase64, Unknown } from "./utils/bjson.ts";
export { getErrMsg } from "./utils/error.ts";
export { DistributedTokenBucket } from "./utils/rate-limiter.ts";
export { LRUCache, TTLCache } from "./utils/lru-cache.ts";
