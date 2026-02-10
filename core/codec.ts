import { HEADER_SIZE, MessageType, type ProxyMessage } from "./protocol.ts";

/**
 * 编码消息为二进制格式
 * 格式: [type: 1字节][resourceId: 4字节大端][data: 变长]
 */
export function encodeMessage(msg: ProxyMessage): Uint8Array {
    const buffer = new Uint8Array(HEADER_SIZE + msg.data.length);
    const view = new DataView(buffer.buffer);

    view.setUint8(0, msg.type);
    view.setUint32(1, msg.resourceId, false); // big-endian
    buffer.set(msg.data, HEADER_SIZE);

    return buffer;
}

/**
 * 解码二进制消息
 * @throws 如果数据长度不足会抛出错误
 */
export function decodeMessage(buffer: Uint8Array): ProxyMessage {
    if (buffer.length < HEADER_SIZE) {
        throw new Error(`Invalid message: too short (${buffer.length} < ${HEADER_SIZE})`);
    }

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    return {
        type: view.getUint8(0) as MessageType,
        resourceId: view.getUint32(1, false), // big-endian
        data: buffer.slice(HEADER_SIZE),
    };
}

/**
 * 连接两个 Uint8Array
 */
export function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
}

/**
 * 安全解码消息，失败返回 null
 */
export function tryDecodeMessage(buffer: Uint8Array): ProxyMessage | null {
    try {
        return decodeMessage(buffer);
    } catch {
        return null;
    }
}
