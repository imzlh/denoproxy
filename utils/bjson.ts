/**
 * 二进制JSON
 * 格式如下：
 * 【类型字节】【可选：变长整数（LEB128）表示长度或值】【可选：内容】
 */

/**
 * BJson数据类型
 */
enum DataType {
    False,        // false
    True,         // true
    Null,         // null
    Undefined,    // undefined
    Integer,      // 整数（有符号LEB128，使用ZigZag编码）
    Float,        // 浮点数（64位小端）
    String,       // 字符串
    Binary,       // 二进制数据
    Array,        // 数组
    Object,       // 对象
    PosInfinity,  // 正无穷
    NegInfinity,  // 负无穷
    NaN,          // NaN
    Unknown       // 未知类型
}

export const Unknown = Symbol("Unknown");

// 复用 TextEncoder/TextDecoder 实例，避免重复创建
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 动态缓冲区类 - 使用预分配策略减少内存分配
 */
class EncodeBuffer {
    private buffer: Uint8Array;
    private offset = 0;
    private static readonly INITIAL_SIZE = 256;
    private static readonly GROWTH_FACTOR = 1.5;

    constructor(initialSize = EncodeBuffer.INITIAL_SIZE) {
        this.buffer = new Uint8Array(initialSize);
    }

    private ensureCapacity(additional: number): void {
        const required = this.offset + additional;
        if (required > this.buffer.length) {
            const newSize = Math.max(
                required,
                Math.floor(this.buffer.length * EncodeBuffer.GROWTH_FACTOR)
            );
            const newBuffer = new Uint8Array(newSize);
            newBuffer.set(this.buffer.subarray(0, this.offset));
            this.buffer = newBuffer;
        }
    }

    writeByte(byte: number): void {
        this.ensureCapacity(1);
        this.buffer[this.offset++] = byte;
    }

    writeBytes(data: Uint8Array): void {
        this.ensureCapacity(data.length);
        this.buffer.set(data, this.offset);
        this.offset += data.length;
    }

    toUint8Array(): Uint8Array {
        return this.buffer.subarray(0, this.offset);
    }
}

/**
 * 编码无符号LEB128
 * @param value 非负bigint
 * @returns Uint8Array
 */
function encodeULEB128(value: bigint): Uint8Array {
    if (value < 0n) throw new Error("Cannot encode negative value as ULEB128");
    const bytes: number[] = [];
    do {
        let byte = Number(value & 0x7fn);
        value >>= 7n;
        if (value > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (value > 0n);
    return new Uint8Array(bytes);
}

/**
 * 解码无符号LEB128
 * @param buffer 数据缓冲
 * @param pos 当前位置（会更新）
 * @returns bigint
 */
function decodeULEB128(buffer: Uint8Array, pos: { pos: number }): bigint {
    let result = 0n;
    let shift = 0;
    const startPos = pos.pos;
    
    while (pos.pos < buffer.length) {
        const byte = buffer[pos.pos++];
        result |= BigInt(byte & 0x7f) << BigInt(shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
        
        // 安全检查：防止无限循环
        if (pos.pos - startPos > 10) {
            throw new Error("ULEB128 too long");
        }
    }
    return result;
}

/**
 * ZigZag编码（将有符号整数转换为无符号）
 * @param value bigint
 * @returns 无符号bigint
 */
function zigzagEncode(value: bigint): bigint {
    if (value >= 0n) {
        return value << 1n;
    } else {
        return (-value << 1n) - 1n;
    }
}

/**
 * ZigZag解码
 * @param value 无符号bigint
 * @returns 有符号bigint
 */
function zigzagDecode(value: bigint): bigint {
    return (value >> 1n) ^ -(value & 1n);
}

/**
 * 编码数据为Uint8Array
 * @param data 原始数据
 * @returns Uint8Array
 */
export function encode(data: unknown): Uint8Array {
    const buffer = new EncodeBuffer();

    function write(data: Uint8Array): void {
        buffer.writeBytes(data);
    }

    function encodeValue(obj: unknown, inArray = false): void {
        if (obj === undefined) {
            if (inArray) {
                buffer.writeByte(DataType.Undefined);
            }
            return;
        }

        if (obj === null) {
            buffer.writeByte(DataType.Null);
            return;
        }

        const type = typeof obj;

        if (type === "boolean") {
            buffer.writeByte(obj ? DataType.True : DataType.False);
            return;
        }

        if (type === "number") {
            const num = obj as number;
            if (Number.isNaN(num)) {
                buffer.writeByte(DataType.NaN);
            } else if (!Number.isFinite(num)) {
                buffer.writeByte(num > 0 ? DataType.PosInfinity : DataType.NegInfinity);
            } else if (Number.isSafeInteger(num)) {
                const val = BigInt(num);
                buffer.writeByte(DataType.Integer);
                write(encodeULEB128(zigzagEncode(val)));
            } else {
                buffer.writeByte(DataType.Float);
                const dv = new DataView(new ArrayBuffer(8));
                dv.setFloat64(0, num, true); // little-endian
                write(new Uint8Array(dv.buffer));
            }
            return;
        }

        if (type === "string") {
            const encoded = textEncoder.encode(obj as string);
            const maxLen = 0xFFFFFFFF;
            if (encoded.length > maxLen) {
                throw new Error("String too long");
            }
            buffer.writeByte(DataType.String);
            write(encodeULEB128(BigInt(encoded.length)));
            write(encoded);
            return;
        }

        if (type === "bigint") {
            buffer.writeByte(DataType.Integer);
            write(encodeULEB128(zigzagEncode(obj as bigint)));
            return;
        }

        if (type === "symbol" || type === "function") {
            buffer.writeByte(DataType.Unknown);
            return;
        }

        if (type === "object") {
            if (Array.isArray(obj)) {
                const maxLen = 0xFFFFFFFF;
                if (obj.length > maxLen) {
                    throw new Error("Array too long");
                }
                buffer.writeByte(DataType.Array);
                write(encodeULEB128(BigInt(obj.length)));
                for (const item of obj) {
                    encodeValue(item, true);
                }
                return;
            }

            if (obj instanceof ArrayBuffer || obj instanceof Uint8Array) {
                const view = obj instanceof ArrayBuffer ? new Uint8Array(obj) : obj;
                const maxLen = 0xFFFFFFFF;
                if (view.length > maxLen) {
                    throw new Error("Binary data too long");
                }
                buffer.writeByte(DataType.Binary);
                write(encodeULEB128(BigInt(view.length)));
                write(view);
                return;
            }

            // 普通对象，忽略undefined值
            const entries = Object.entries(obj as Record<string, unknown>)
                .filter(([_, v]) => v !== undefined);
            buffer.writeByte(DataType.Object);
            write(encodeULEB128(BigInt(entries.length)));
            for (const [key, value] of entries) {
                const keyEncoded = textEncoder.encode(key);
                write(encodeULEB128(BigInt(keyEncoded.length)));
                write(keyEncoded);
                encodeValue(value);
            }
            return;
        }

        // 其他未知类型
        buffer.writeByte(DataType.Unknown);
    }

    encodeValue(data);
    return buffer.toUint8Array();
}

/**
 * 解码Uint8Array为原始数据
 * @param buffer 编码后的数据
 * @returns 原始数据
 */
export function decode<T = unknown>(buffer: Uint8Array): T {
    if (!buffer || buffer.length === 0) {
        throw new Error("Empty buffer");
    }

    let pos = 0;

    function readULEB(): bigint {
        const ref = { pos };
        const val = decodeULEB128(buffer, ref);
        pos = ref.pos;
        return val;
    }

    function readBytes(len: number): Uint8Array {
        if (len < 0) throw new Error("Invalid length");
        if (pos + len > buffer.length) throw new Error("Unexpected end of data");
        const res = buffer.subarray(pos, pos + len);
        pos += len;
        return res;
    }

    function decodeValue(): unknown {
        if (pos >= buffer.length) return undefined;

        const header = buffer[pos++];
        switch (header) {
            case DataType.False:
                return false;
            case DataType.True:
                return true;
            case DataType.Null:
                return null;
            case DataType.Undefined:
                return undefined;
            case DataType.PosInfinity:
                return Infinity;
            case DataType.NegInfinity:
                return -Infinity;
            case DataType.NaN:
                return NaN;
            case DataType.Unknown:
                return Unknown;
            case DataType.Integer: {
                const zig = readULEB();
                const value = zigzagDecode(zig);
                // 如果在安全整数范围内，返回number，否则bigint
                const safeMin = BigInt(Number.MIN_SAFE_INTEGER);
                const safeMax = BigInt(Number.MAX_SAFE_INTEGER);
                if (value >= safeMin && value <= safeMax) {
                    return Number(value);
                } else {
                    return value;
                }
            }
            case DataType.Float: {
                const bytes = readBytes(8);
                const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                return dv.getFloat64(0, true); // little-endian
            }
            case DataType.String: {
                const len = Number(readULEB());
                return textDecoder.decode(readBytes(len));
            }
            case DataType.Binary: {
                const len = Number(readULEB());
                return readBytes(len);
            }
            case DataType.Array: {
                const len = Number(readULEB());
                const arr: unknown[] = [];
                for (let i = 0; i < len; i++) {
                    arr.push(decodeValue());
                }
                return arr;
            }
            case DataType.Object: {
                const len = Number(readULEB());
                const obj: Record<string, unknown> = {};
                for (let i = 0; i < len; i++) {
                    const keyLen = Number(readULEB());
                    const key = textDecoder.decode(readBytes(keyLen));
                    obj[key] = decodeValue();
                }
                return obj;
            }
            default:
                throw new Error(`Unknown data type ${header} at position ${pos - 1}`);
        }
    }

    const result = decodeValue();
    if (pos < buffer.length) {
        throw new Error(`Extra data after decoding, pos=${pos}, size=${buffer.length}`);
    }
    return result as T;
}

/**
 * 尝试解码，失败返回 null
 */
export function tryDecode<T = unknown>(buffer: Uint8Array): T | null {
    try {
        return decode<T>(buffer);
    } catch {
        return null;
    }
}

/**
 * 编码为 base64 字符串
 * 优化：避免使用展开运算符，改用循环处理
 */
export function encodeToBase64(data: unknown): string {
    const encoded = encode(data);
    // 使用循环而非展开运算符，避免大数据栈溢出
    let binary = '';
    const len = encoded.length;
    // 分块处理，每次处理 8192 字节
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        const chunk = encoded.subarray(i, Math.min(i + chunkSize, len));
        binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
}

/**
 * 从 base64 字符串解码
 */
export function decodeFromBase64<T = unknown>(base64: string): T {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return decode<T>(bytes);
}
