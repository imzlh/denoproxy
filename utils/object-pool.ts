/**
 * 对象池实现
 * 用于复用对象，减少GC压力
 */
export class ObjectPool<T> {
    private pool: T[] = [];
    private readonly maxSize: number;
    private readonly factory: () => T;
    private readonly reset?: (obj: T) => void;

    constructor(
        factory: () => T,
        maxSize: number = 100,
        reset?: (obj: T) => void
    ) {
        this.factory = factory;
        this.maxSize = maxSize;
        this.reset = reset;
    }

    acquire(): T {
        const obj = this.pool.pop();
        if (obj !== undefined) {
            return obj;
        }
        return this.factory();
    }

    release(obj: T): void {
        if (this.pool.length < this.maxSize) {
            if (this.reset) {
                this.reset(obj);
            }
            this.pool.push(obj);
        }
    }

    clear(): void {
        this.pool = [];
    }

    get size(): number {
        return this.pool.length;
    }

    get available(): number {
        return this.pool.length;
    }
}

/**
 * Uint8Array 缓冲区池
 * 专门用于网络数据缓冲区的复用
 */
export class BufferPool {
    private pools = new Map<number, ObjectPool<Uint8Array>>();
    private readonly maxPoolSize: number;

    constructor(maxPoolSize: number = 100) {
        this.maxPoolSize = maxPoolSize;
    }

    acquire(size: number): Uint8Array {
        // 向上取整到最近的2的幂次方，减少池的数量
        const poolSize = this.roundToPowerOf2(size);
        
        let pool = this.pools.get(poolSize);
        if (!pool) {
            pool = new ObjectPool<Uint8Array>(
                () => new Uint8Array(poolSize),
                this.maxPoolSize,
                (buf) => buf.fill(0)
            );
            this.pools.set(poolSize, pool);
        }

        const buffer = pool.acquire();
        // 返回正确大小的视图
        if (buffer.length !== size) {
            return buffer.subarray(0, size);
        }
        return buffer;
    }

    release(buffer: Uint8Array): void {
        const poolSize = this.roundToPowerOf2(buffer.length);
        let pool = this.pools.get(poolSize);
        
        if (!pool) {
            pool = new ObjectPool<Uint8Array>(
                () => new Uint8Array(poolSize),
                this.maxPoolSize,
                (buf) => buf.fill(0)
            );
            this.pools.set(poolSize, pool);
        }
        
        let releaseBuffer: Uint8Array;
        if (buffer.length === poolSize) {
            releaseBuffer = buffer;
        } else {
            releaseBuffer = new Uint8Array(poolSize);
            releaseBuffer.set(buffer.subarray(0, poolSize));
        }
        pool.release(releaseBuffer);
    }

    private roundToPowerOf2(n: number): number {
        if (n <= 0) return 16; // 最小16字节
        n--;
        n |= n >> 1;
        n |= n >> 2;
        n |= n >> 4;
        n |= n >> 8;
        n |= n >> 16;
        return n + 1;
    }

    clear(): void {
        for (const pool of this.pools.values()) {
            pool.clear();
        }
        this.pools.clear();
    }

    getStats(): { poolCount: number; totalBuffers: number; poolSizes: number[] } {
        let total = 0;
        const sizes: number[] = [];

        for (const [size, pool] of this.pools) {
            total += pool.size;
            sizes.push(size);
        }

        return {
            poolCount: this.pools.size,
            totalBuffers: total,
            poolSizes: sizes.sort((a, b) => a - b)
        };
    }
}

/**
 * 全局缓冲区池实例
 */
export const globalBufferPool = new BufferPool(200);
