/**
 * LRU (Least Recently Used) 缓存实现
 * 用于限制缓存大小，防止内存无限增长
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private readonly maxSize: number;

    constructor(maxSize: number) {
        if (maxSize <= 0) {
            throw new Error("Max size must be positive");
        }
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // 移到末尾表示最近使用
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        // 如果已存在，先删除
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        
        // 检查是否需要淘汰
        if (this.cache.size >= this.maxSize) {
            // 删除最旧的（第一个）条目
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        
        this.cache.set(key, value);
    }

    has(key: K): boolean {
        return this.cache.has(key);
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }

    get maxSizeValue(): number {
        return this.maxSize;
    }

    keys(): IterableIterator<K> {
        return this.cache.keys();
    }

    values(): IterableIterator<V> {
        return this.cache.values();
    }

    entries(): IterableIterator<[K, V]> {
        return this.cache.entries();
    }

    forEach(callback: (value: V, key: K) => void): void {
        this.cache.forEach(callback);
    }
}

/**
 * 带TTL的LRU缓存
 * 支持过期时间
 */
export class TTLCache<K, V> {
    private cache = new Map<K, { value: V; expiresAt: number }>();
    private readonly maxSize: number;
    private readonly defaultTTL: number;
    private cleanupInterval?: number;

    constructor(maxSize: number, defaultTTL: number, autoCleanup = true) {
        if (maxSize <= 0) {
            throw new Error("Max size must be positive");
        }
        this.maxSize = maxSize;
        this.defaultTTL = defaultTTL;

        if (autoCleanup) {
            // 每分钟清理一次过期条目
            this.cleanupInterval = setInterval(() => {
                this.cleanup();
            }, 60000);
        }
    }

    get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }

        // 移到末尾表示最近使用
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V, ttl?: number): void {
        const expiresAt = Date.now() + (ttl ?? this.defaultTTL);

        // 如果已存在，先删除
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 检查是否需要淘汰
        while (this.cache.size >= this.maxSize) {
            // 删除最旧的条目
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            } else {
                break;
            }
        }

        this.cache.set(key, { value, expiresAt });
    }

    has(key: K): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return false;
        }

        return true;
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    cleanup(): number {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entry] of this.cache) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                cleaned++;
            }
        }

        return cleaned;
    }

    get size(): number {
        return this.cache.size;
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.cache.clear();
    }
}
