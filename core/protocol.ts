// Message types for binary protocol
export enum MessageType {
    // TCP lifecycle
    TCP_CONNECT = 0x01,
    TCP_CONNECT_ACK = 0x02,
    TCP_DATA = 0x03,
    TCP_CLOSE = 0x04,

    // UDP
    UDP_BIND = 0x11,
    UDP_BIND_ACK = 0x12,
    UDP_DATA = 0x13,
    UDP_CLOSE = 0x14,

    // DNS
    DNS_QUERY = 0x21,
    DNS_RESPONSE = 0x22,

    // HTTP
    HTTP_REQUEST = 0x31,
    HTTP_RESPONSE = 0x32,
    HTTP_BODY_CHUNK = 0x33,
    HTTP_BODY_END = 0x34,

    // Control
    ERROR = 0xFE,
    HEARTBEAT = 0xFF,
}

export interface ProxyMessage {
    type: MessageType;
    resourceId: number;
    data: Uint8Array;
}

export const HEADER_SIZE = 5; // 1 byte type + 4 bytes resourceId (uint32 big-endian)

export enum DnsType {
    A = 0,
    AAAA,
    ANAME,
    CNAME,
    NS,
    PTR,
}

const DNS_TYPE_MAP: Record<DnsType, string> = {
    [DnsType.A]: 'A',
    [DnsType.AAAA]: 'AAAA',
    [DnsType.ANAME]: 'ANAME',
    [DnsType.CNAME]: 'CNAME',
    [DnsType.NS]: 'NS',
    [DnsType.PTR]: 'PTR',
};

export function DnsType2String(dt: DnsType): string {
    return DNS_TYPE_MAP[dt] ?? 'UNKNOWN';
}

export interface HTTPResponse extends ResponseInit {
    url: string,
    body: boolean
}