import { Log } from "@cross/log";

/**
 * 连接池配置
 */
export interface ConnectionPoolConfig {
    maxConnections: number;
    maxIdleTime: number;
    acquireTimeout: number;
    healthCheckInterval: number;
    minConnections: number; // 最小预热连接数
    warmupDelay: number; // 预热延迟
}

/**
 * 连接池条目
 */
interface PoolEntry<T> {
    connection: T;
    lastUsed: number;
    inUse: boolean;
    createdAt: number;
}

/**
 * 通用连接池
 * 用于复用TCP连接，减少连接建立开销
 */
export class ConnectionPool<T> {
    private pool = new Map<string, PoolEntry<T>[]>();
    private config: ConnectionPoolConfig;
    private cleanupInterval?: number;
    private logger?: Log;

    constructor(
        private creator: (key: string) => Promise<T>,
        private destroyer: (conn: T) => Promise<void>,
        private healthChecker: (conn: T) => Promise<boolean>,
        config: Partial<ConnectionPoolConfig> = {},
        logger?: Log
    ) {
        this.config = {
            maxConnections: config.maxConnections ?? 100,
            maxIdleTime: config.maxIdleTime ?? 300000, // 5分钟
            acquireTimeout: config.acquireTimeout ?? 10000, // 10秒
            healthCheckInterval: config.healthCheckInterval ?? 60000, // 1分钟
            minConnections: config.minConnections ?? 0, // 默认不预热
            warmupDelay: config.warmupDelay ?? 1000 // 默认1秒延迟
        };
        this.logger = logger;

        this.startCleanup();
        
        // 启动预热
        if (this.config.minConnections > 0) {
            setTimeout(() => this.warmup(), this.config.warmupDelay);
        }
    }
    
    /**
     * 预热连接池
     * 预先创建指定数量的最小连接
     */
    async warmup(): Promise<void> {
        const minConn = this.config.minConnections;
        if (minConn <= 0) return;
        
        this.logger?.debug("Starting connection pool warmup", { minConnections: minConn });
        
        const warmupPromises: Promise<void>[] = [];
        
        for (const key of this.pool.keys()) {
            const entries = this.pool.get(key)!;
            const missing = minConn - entries.filter(e => !e.inUse).length;
            
            for (let i = 0; i < missing; i++) {
                warmupPromises.push(
                    (async () => {
                        try {
                            await this.acquire(key);
                            this.release(key, this.pool.get(key)!.find(e => e.inUse)!.connection);
                        } catch (err) {
                            this.logger?.debug("Warmup connection failed", { key, error: String(err) });
                        }
                    })()
                );
            }
        }
        
        await Promise.allSettled(warmupPromises);
        this.logger?.debug("Connection pool warmup completed");
    }

    /**
     * 获取连接
     */
    async acquire(key: string): Promise<T> {
        // 尝试从池中获取空闲连接
        const entries = this.pool.get(key);
        if (entries) {
            for (const entry of entries) {
                if (!entry.inUse) {
                    // 健康检查
                    try {
                        const healthy = await this.healthChecker(entry.connection);
                        if (healthy) {
                            entry.inUse = true;
                            entry.lastUsed = Date.now();
                            return entry.connection;
                        } else {
                            // 不健康，移除
                            await this.destroyer(entry.connection);
                            entries.splice(entries.indexOf(entry), 1);
                        }
                    } catch (err) {
                        this.logger?.debug("Health check failed", { key, error: String(err) });
                        entries.splice(entries.indexOf(entry), 1);
                    }
                }
            }
        }

        // 创建新连接
        const connection = await Promise.race([
            this.creator(key),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Connection acquire timeout")), this.config.acquireTimeout)
            )
        ]);

        // 添加到池
        if (!this.pool.has(key)) {
            this.pool.set(key, []);
        }

        const entry: PoolEntry<T> = {
            connection,
            lastUsed: Date.now(),
            inUse: true,
            createdAt: Date.now()
        };

        this.pool.get(key)!.push(entry);

        // 检查是否超过最大连接数
        this.enforceMaxConnections(key);

        return connection;
    }

    /**
     * 释放连接
     */
    release(key: string, connection: T): void {
        const entries = this.pool.get(key);
        if (!entries) return;

        for (const entry of entries) {
            if (entry.connection === connection) {
                entry.inUse = false;
                entry.lastUsed = Date.now();
                return;
            }
        }
    }

    /**
     * 移除连接
     */
    async remove(key: string, connection: T): Promise<void> {
        const entries = this.pool.get(key);
        if (!entries) return;

        const index = entries.findIndex(e => e.connection === connection);
        if (index >= 0) {
            const entry = entries[index];
            entries.splice(index, 1);
            try {
                await this.destroyer(entry.connection);
            } catch (err) {
                this.logger?.debug("Error destroying connection", { key, error: String(err) });
            }
        }
    }

    /**
     * 获取统计信息
     */
    getStats(): {
        totalPools: number;
        totalConnections: number;
        activeConnections: number;
        idleConnections: number;
    } {
        let total = 0;
        let active = 0;
        let idle = 0;

        for (const entries of this.pool.values()) {
            for (const entry of entries) {
                total++;
                if (entry.inUse) {
                    active++;
                } else {
                    idle++;
                }
            }
        }

        return {
            totalPools: this.pool.size,
            totalConnections: total,
            activeConnections: active,
            idleConnections: idle
        };
    }

    /**
     * 清理所有连接
     */
    async clear(): Promise<void> {
        for (const [key, entries] of this.pool) {
            for (const entry of entries) {
                try {
                    await this.destroyer(entry.connection);
                } catch (err) {
                    this.logger?.debug("Error destroying connection during clear", { key, error: String(err) });
                }
            }
        }
        this.pool.clear();
    }

    /**
     * 销毁连接池
     */
    async destroy(): Promise<void> {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        await this.clear();
    }

    private startCleanup(): void {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.config.healthCheckInterval);
    }

    private async cleanup(): Promise<void> {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, entries] of this.pool) {
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                
                // 清理空闲超时的连接
                if (!entry.inUse && now - entry.lastUsed > this.config.maxIdleTime) {
                    try {
                        await this.destroyer(entry.connection);
                    } catch (err) {
                        this.logger?.debug("Error destroying idle connection", { key, error: String(err) });
                    }
                    entries.splice(i, 1);
                    cleaned++;
                }
            }

            // 清理空池
            if (entries.length === 0) {
                this.pool.delete(key);
            }
        }

        if (cleaned > 0) {
            this.logger?.debug("Connection pool cleanup", { cleaned, remaining: this.getStats().totalConnections });
        }
    }

    private enforceMaxConnections(key: string): void {
        const entries = this.pool.get(key);
        if (!entries) return;

        // 每个key最多保留一定数量的连接
        const maxPerKey = Math.ceil(this.config.maxConnections / Math.max(1, this.pool.size));
        
        while (entries.length > maxPerKey) {
            // 移除最旧的空闲连接
            const idleEntry = entries.find(e => !e.inUse);
            if (idleEntry) {
                const index = entries.indexOf(idleEntry);
                entries.splice(index, 1);
                this.destroyer(idleEntry.connection).catch(() => {});
            } else {
                break;
            }
        }
    }
}

/**
 * TCP连接池
 */
export class TCPConnectionPool extends ConnectionPool<Deno.TcpConn> {
    constructor(config: Partial<ConnectionPoolConfig> = {}, logger?: Log) {
        super(
            async (key: string) => {
                const [host, port] = key.split(":");
                return await Deno.connect({ 
                    hostname: host, 
                    port: parseInt(port) 
                });
            },
            async (conn: Deno.TcpConn) => {
                try {
                    conn.close();
                } catch {
                    // 忽略关闭错误
                }
            },
            async (conn: Deno.TcpConn) => {
                try {
                    // 简单的健康检查：尝试获取远程地址
                    const addr = conn.remoteAddr;
                    return addr !== undefined;
                } catch {
                    return false;
                }
            },
            config,
            logger
        );
    }
}
