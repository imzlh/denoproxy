import { Log } from "@cross/log";
import { ConnectionManager } from "./manager.ts"
import { getErrMsg } from "../utils/error.ts";
import { DistributedTokenBucket } from "../utils/rate-limiter.ts";

export class MetricsCollector {
    private counters = new Map<string, number>();
    private gauges = new Map<string, number>();
    private histograms = new Map<string, number[]>();
    private startTime = Date.now();

    increment(name: string, value = 1) {
        this.counters.set(name, (this.counters.get(name) || 0) + value);
    }

    gauge(name: string, value: number) {
        this.gauges.set(name, value);
    }

    histogram(name: string, value: number) {
        const values = this.histograms.get(name) || [];
        values.push(value);

        // Keep only last 1000 values
        if (values.length > 1000) {
            values.shift();
        }

        this.histograms.set(name, values);
    }

    getSnapshot() {
        const snapshot: Record<string, unknown> = {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
        };

        // Calculate histogram percentiles
        const histogramStats: Record<string, unknown> = {};
        for (const [name, values] of this.histograms) {
            if (values.length === 0) continue;

            const sorted = [...values].sort((a, b) => a - b);
            histogramStats[name] = {
                count: values.length,
                min: sorted[0],
                max: sorted[sorted.length - 1],
                p50: sorted[Math.floor(sorted.length * 0.5)],
                p95: sorted[Math.floor(sorted.length * 0.95)],
                p99: sorted[Math.floor(sorted.length * 0.99)],
                avg: values.reduce((a, b) => a + b, 0) / values.length,
            };
        }
        snapshot.histograms = histogramStats;

        return snapshot;
    }

    reset() {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
        this.startTime = Date.now();
    }

    getUptime(): number {
        return Date.now() - this.startTime;
    }
}

export class HealthService {
    constructor(
        private connMgr: ConnectionManager,
        private metrics: MetricsCollector,
        private logger: Log
    ) { }

    getHealth() {
        const connStats = this.connMgr.getStats();
        const metricsSnapshot = this.metrics.getSnapshot();
        const memory = Deno.memoryUsage();

        return {
            status: "healthy",
            timestamp: new Date().toISOString(),
            uptime: Math.floor(this.metrics.getUptime() / 1000),
            connections: connStats,
            metrics: metricsSnapshot,
            memory: {
                rss: Math.floor(memory.rss / 1024 / 1024) + " MB",
                rssBytes: memory.rss,
                heapTotal: Math.floor(memory.heapTotal / 1024 / 1024) + " MB",
                heapTotalBytes: memory.heapTotal,
                heapUsed: Math.floor(memory.heapUsed / 1024 / 1024) + " MB",
                heapUsedBytes: memory.heapUsed,
                external: Math.floor(memory.external / 1024 / 1024) + " MB",
                externalBytes: memory.external,
            },
        };
    }

    startPeriodicLogging(intervalMs = 60000) {
        setInterval(() => {
            const health = this.getHealth();
            this.logger.info('Health check', health);
        }, intervalMs);
    }
}

/**
 * 高性能速率限制器
 * 使用令牌桶算法，比滑动窗口更高效
 */
export class RateLimiter {
    private tokenBucket: DistributedTokenBucket;
    private cleanupInterval?: number;

    constructor(
        maxRequests: number,
        windowMs: number
    ) {
        const refillRate = maxRequests / (windowMs / 1000);
        this.tokenBucket = new DistributedTokenBucket(
            maxRequests,
            refillRate,
            1000,
            10000
        );
    }

    isAllowed(identifier: string): boolean {
        return this.tokenBucket.consume(identifier, 1);
    }

    getRemainingRequests(identifier: string): number {
        return this.tokenBucket.getAvailableTokens(identifier);
    }

    startPeriodicCleanup(intervalMs = 60000) {
        this.cleanupInterval = setInterval(() => {
            this.tokenBucket.cleanup();
        }, intervalMs);
    }

    stopPeriodicCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
        this.tokenBucket.destroy();
    }

    getStats() {
        return this.tokenBucket.getStats();
    }
}
