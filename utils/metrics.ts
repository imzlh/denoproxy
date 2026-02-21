/**
 * 性能监控指标收集器
 * 提供详细的性能指标和统计
 */
import { Log } from "@cross/log";

/**
 * 资源泄漏检测器
 * 用于检测长时间运行时的资源泄漏
 */
class LeakDetectorClass {
    private resources = new Map<string, { createdAt: number; count: number }>();
    private interval?: number;
    private logger?: Log;
    
    constructor(private checkIntervalMs: number = 60000) {
        this.interval = setInterval(() => this.check(), checkIntervalMs);
    }
    
    setLogger(logger: Log): void {
        this.logger = logger;
    }
    
    track(name: string): void {
        const entry = this.resources.get(name);
        if (entry) {
            entry.count++;
        } else {
            this.resources.set(name, { createdAt: Date.now(), count: 1 });
        }
    }
    
    untrack(name: string): void {
        const entry = this.resources.get(name);
        if (entry) {
            entry.count--;
            if (entry.count <= 0) {
                this.resources.delete(name);
            }
        }
    }
    
    private check(): void {
        if (!this.logger) return;
        
        for (const [name, entry] of this.resources) {
            if (entry.count > 10) {
                this.logger.warn(`Potential resource leak detected: ${name}`, {
                    count: entry.count,
                    age: Date.now() - entry.createdAt
                });
            }
        }
    }
    
    getStats(): Record<string, { count: number; age: number }> {
        const stats: Record<string, { count: number; age: number }> = {};
        const now = Date.now();
        
        for (const [name, entry] of this.resources) {
            stats[name] = {
                count: entry.count,
                age: now - entry.createdAt
            };
        }
        
        return stats;
    }
    
    destroy(): void {
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.resources.clear();
    }
}

let globalLeakDetectorInstance: LeakDetectorClass | null = null;

export function getLeakDetector(): LeakDetectorClass {
    if (!globalLeakDetectorInstance) {
        globalLeakDetectorInstance = new LeakDetectorClass();
    }
    return globalLeakDetectorInstance;
}

export class PerformanceMetrics {
    private counters = new Map<string, number>();
    private gauges = new Map<string, number>();
    private histograms = new Map<string, number[]>();
    private timers = new Map<string, number>();
    private startTime = Date.now();

    private readonly maxHistogramSize: number;
    private readonly maxKeysCount: number;
    private readonly memoryThresholdMB: number;
    private cleanupInterval?: number;
    private memoryCheckInterval?: number;
    private onMemoryWarning?: (memory: Deno.MemoryUsage) => void;

    constructor(
        maxHistogramSize: number = 1000, 
        maxKeysCount: number = 500,
        memoryThresholdMB: number = 512
    ) {
        this.maxHistogramSize = maxHistogramSize;
        this.maxKeysCount = maxKeysCount;
        this.memoryThresholdMB = memoryThresholdMB;
        
        this.cleanupInterval = setInterval(() => {
            this.trimHistograms();
            this.trimKeysIfNeeded();
        }, 60000);
        
        this.memoryCheckInterval = setInterval(() => {
            this.checkMemory();
        }, 30000);
    }
    
    setMemoryWarningCallback(callback: (memory: Deno.MemoryUsage) => void): void {
        this.onMemoryWarning = callback;
    }
    
    private checkMemory(): void {
        const memory = Deno.memoryUsage();
        const usedMB = memory.heapUsed / 1024 / 1024;
        
        if (usedMB > this.memoryThresholdMB) {
            this.onMemoryWarning?.(memory);
            this.trimHistograms();
            this.trimKeysIfNeeded();
        }
    }

    /**
     * 增加计数器
     */
    increment(name: string, value: number = 1): void {
        this.counters.set(name, (this.counters.get(name) || 0) + value);
    }

    /**
     * 减少计数器
     */
    decrement(name: string, value: number = 1): void {
        this.counters.set(name, (this.counters.get(name) || 0) - value);
    }

    /**
     * 设置计量值
     */
    gauge(name: string, value: number): void {
        this.gauges.set(name, value);
    }

    /**
     * 记录直方图值
     */
    histogram(name: string, value: number): void {
        const values = this.histograms.get(name) || [];
        values.push(value);

        // 限制大小
        if (values.length > this.maxHistogramSize) {
            values.shift();
        }

        this.histograms.set(name, values);
    }

    /**
     * 开始计时
     */
    startTimer(name: string): void {
        this.timers.set(name, Date.now());
    }

    /**
     * 结束计时并记录
     */
    endTimer(name: string): number {
        const startTime = this.timers.get(name);
        if (startTime === undefined) {
            return 0;
        }

        const duration = Date.now() - startTime;
        this.timers.delete(name);
        this.histogram(name, duration);
        return duration;
    }

    /**
     * 计时装饰器
     */
    time<T>(name: string, fn: () => T): T {
        this.startTimer(name);
        try {
            const result = fn();
            this.endTimer(name);
            return result;
        } catch (err) {
            this.endTimer(name);
            throw err;
        }
    }

    /**
     * 异步计时装饰器
     */
    async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
        this.startTimer(name);
        try {
            const result = await fn();
            this.endTimer(name);
            return result;
        } catch (err) {
            this.endTimer(name);
            throw err;
        }
    }

    /**
     * 获取计数器值
     */
    getCounter(name: string): number {
        return this.counters.get(name) || 0;
    }

    /**
     * 获取计量值
     */
    getGauge(name: string): number {
        return this.gauges.get(name) || 0;
    }

    /**
     * 获取直方图统计
     */
    getHistogramStats(name: string): {
        count: number;
        min: number;
        max: number;
        avg: number;
        p50: number;
        p95: number;
        p99: number;
    } | null {
        const values = this.histograms.get(name);
        if (!values || values.length === 0) {
            return null;
        }

        const sorted = [...values].sort((a, b) => a - b);
        const sum = values.reduce((a, b) => a + b, 0);

        return {
            count: values.length,
            min: sorted[0],
            max: sorted[sorted.length - 1],
            avg: sum / values.length,
            p50: sorted[Math.floor(sorted.length * 0.5)],
            p95: sorted[Math.floor(sorted.length * 0.95)],
            p99: sorted[Math.floor(sorted.length * 0.99)]
        };
    }

    /**
     * 获取所有指标的快照
     */
    getSnapshot(): {
        uptime: number;
        counters: Record<string, number>;
        gauges: Record<string, number>;
        histograms: Record<string, ReturnType<PerformanceMetrics['getHistogramStats']>>;
        memory: {
            rss: number;
            heapTotal: number;
            heapUsed: number;
            external: number;
        };
    } {
        const memory = Deno.memoryUsage();

        const histogramStats: Record<string, ReturnType<PerformanceMetrics['getHistogramStats']>> = {};
        for (const name of this.histograms.keys()) {
            histogramStats[name] = this.getHistogramStats(name);
        }

        return {
            uptime: Date.now() - this.startTime,
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            histograms: histogramStats,
            memory: {
                rss: memory.rss,
                heapTotal: memory.heapTotal,
                heapUsed: memory.heapUsed,
                external: memory.external
            }
        };
    }

    /**
     * 重置所有指标
     */
    reset(): void {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
        this.timers.clear();
        this.startTime = Date.now();
    }

    /**
     * 销毁
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
        if (this.memoryCheckInterval) {
            clearInterval(this.memoryCheckInterval);
            this.memoryCheckInterval = undefined;
        }
        this.reset();
    }

    private trimHistograms(): void {
        for (const [name, values] of this.histograms) {
            if (values.length > this.maxHistogramSize) {
                this.histograms.set(name, values.slice(-this.maxHistogramSize));
            }
        }
    }
    
    private trimKeysIfNeeded(): void {
        if (this.histograms.size > this.maxKeysCount) {
            const entries = [...this.histograms.entries()];
            entries.sort((a, b) => a[1].length - b[1].length);
            
            const toRemove = entries.slice(0, Math.floor(this.histograms.size * 0.3));
            for (const [name] of toRemove) {
                this.histograms.delete(name);
            }
        }
        
        if (this.counters.size > this.maxKeysCount) {
            const entries = [...this.counters.entries()];
            entries.sort((a, b) => a[1] - b[1]);
            
            const toRemove = entries.slice(0, Math.floor(this.counters.size * 0.3));
            for (const [name] of toRemove) {
                this.counters.delete(name);
            }
        }
    }
}

/**
 * 全局性能指标实例
 * 限制 histogram 大小和 key 数量，防止长期运行时内存增长
 */
export const globalMetrics = new PerformanceMetrics(1000, 200, 512);

/**
 * 连接统计
 */
export class ConnectionStats {
    private activeConnections = 0;
    private totalConnections = 0;
    private failedConnections = 0;
    private connectionTimes: number[] = [];
    private readonly maxTimes = 1000;

    /**
     * 记录新连接
     */
    onConnect(): void {
        this.activeConnections++;
        this.totalConnections++;
    }

    /**
     * 记录断开连接
     */
    onDisconnect(duration: number): void {
        this.activeConnections--;
        this.connectionTimes.push(duration);
        if (this.connectionTimes.length > this.maxTimes) {
            this.connectionTimes.shift();
        }
    }

    /**
     * 记录连接失败
     */
    onFailed(): void {
        this.failedConnections++;
    }

    /**
     * 获取统计
     */
    getStats(): {
        active: number;
        total: number;
        failed: number;
        avgDuration: number;
        maxDuration: number;
    } {
        const times = this.connectionTimes;
        const avgDuration = times.length > 0
            ? times.reduce((a, b) => a + b, 0) / times.length
            : 0;
        const maxDuration = times.length > 0
            ? Math.max(...times)
            : 0;

        return {
            active: this.activeConnections,
            total: this.totalConnections,
            failed: this.failedConnections,
            avgDuration,
            maxDuration
        };
    }

    /**
     * 重置
     */
    reset(): void {
        this.activeConnections = 0;
        this.totalConnections = 0;
        this.failedConnections = 0;
        this.connectionTimes = [];
    }
}

/**
 * 流量统计
 */
export class TrafficStats {
    private bytesIn = 0;
    private bytesOut = 0;
    private packetsIn = 0;
    private packetsOut = 0;
    private lastReset = Date.now();

    /**
     * 记录入站流量
     */
    onInbound(bytes: number): void {
        this.bytesIn += bytes;
        this.packetsIn++;
    }

    /**
     * 记录出站流量
     */
    onOutbound(bytes: number): void {
        this.bytesOut += bytes;
        this.packetsOut++;
    }

    /**
     * 获取统计
     */
    getStats(): {
        bytesIn: number;
        bytesOut: number;
        packetsIn: number;
        packetsOut: number;
        bytesInPerSec: number;
        bytesOutPerSec: number;
        duration: number;
    } {
        const duration = (Date.now() - this.lastReset) / 1000;

        return {
            bytesIn: this.bytesIn,
            bytesOut: this.bytesOut,
            packetsIn: this.packetsIn,
            packetsOut: this.packetsOut,
            bytesInPerSec: duration > 0 ? this.bytesIn / duration : 0,
            bytesOutPerSec: duration > 0 ? this.bytesOut / duration : 0,
            duration
        };
    }

    /**
     * 重置
     */
    reset(): void {
        this.bytesIn = 0;
        this.bytesOut = 0;
        this.packetsIn = 0;
        this.packetsOut = 0;
        this.lastReset = Date.now();
    }
}

/**
 * 资源泄漏检测器
 * 用于检测长时间运行时的资源泄漏
 */
export class LeakDetector {
    private resources = new Map<string, { createdAt: number; count: number }>();
    private interval?: number;
    private logger?: Log;
    
    constructor(private checkIntervalMs: number = 60000) {
        this.interval = setInterval(() => this.check(), checkIntervalMs);
    }
    
    setLogger(logger: Log): void {
        this.logger = logger;
    }
    
    track(name: string): void {
        const entry = this.resources.get(name);
        if (entry) {
            entry.count++;
        } else {
            this.resources.set(name, { createdAt: Date.now(), count: 1 });
        }
    }
    
    untrack(name: string): void {
        const entry = this.resources.get(name);
        if (entry) {
            entry.count--;
            if (entry.count <= 0) {
                this.resources.delete(name);
            }
        }
    }
    
    private check(): void {
        if (!this.logger) return;
        
        for (const [name, entry] of this.resources) {
            if (entry.count > 10) {
                this.logger.warn(`Potential resource leak detected: ${name}`, {
                    count: entry.count,
                    age: Date.now() - entry.createdAt
                });
            }
        }
    }
    
    getStats(): Record<string, { count: number; age: number }> {
        const stats: Record<string, { count: number; age: number }> = {};
        const now = Date.now();
        
        for (const [name, entry] of this.resources) {
            stats[name] = {
                count: entry.count,
                age: now - entry.createdAt
            };
        }
        
        return stats;
    }
    
    destroy(): void {
        if (this.interval) {
            clearInterval(this.interval);
        }
        this.resources.clear();
    }
}
