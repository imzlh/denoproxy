import { HEADER_SIZE, MessageType, type ProxyMessage } from "./protocol.ts";

export function encodeMessage(msg: ProxyMessage): Uint8Array {
    const totalSize = HEADER_SIZE + msg.data.length;
    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer);

    view.setUint8(0, msg.type);
    view.setUint32(1, msg.resourceId, false);
    buffer.set(msg.data, HEADER_SIZE);

    return buffer;
}

export function decodeMessage(buffer: Uint8Array): ProxyMessage {
    if (buffer.length < HEADER_SIZE) {
        throw new Error(`Invalid message: too short (${buffer.length} < ${HEADER_SIZE})`);
    }

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    return {
        type: view.getUint8(0) as MessageType,
        resourceId: view.getUint32(1, false),
        data: buffer.slice(HEADER_SIZE),
    };
}
