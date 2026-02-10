import { Log } from "@cross/log";
import { ConnectionManager } from "./manager.ts"
import { getErrMsg } from "../utils/error.ts";

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

export class RateLimiter {
    private requests = new Map<string, number[]>();
    private cleanupInterval?: number;

    constructor(
        private maxRequests: number,
        private windowMs: number
    ) { }

    isAllowed(identifier: string): boolean {
        const now = Date.now();
        const timestamps = this.requests.get(identifier) || [];

        // Remove old timestamps outside window
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);

        if (validTimestamps.length >= this.maxRequests) {
            return false;
        }

        validTimestamps.push(now);
        this.requests.set(identifier, validTimestamps);

        return true;
    }

    getRemainingRequests(identifier: string): number {
        const now = Date.now();
        const timestamps = this.requests.get(identifier) || [];
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
        return Math.max(0, this.maxRequests - validTimestamps.length);
    }

    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, timestamps] of this.requests) {
            const valid = timestamps.filter(ts => now - ts < this.windowMs);
            if (valid.length === 0) {
                this.requests.delete(key);
                cleaned++;
            } else {
                this.requests.set(key, valid);
            }
        }
        return cleaned;
    }

    startPeriodicCleanup(intervalMs = 60000) {
        this.cleanupInterval = setInterval(() => {
            const cleaned = this.cleanup();
            if (cleaned > 0) {
                console.debug(`Rate limiter cleaned ${cleaned} entries`);
            }
        }, intervalMs);
    }

    stopPeriodicCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
    }

    getStats() {
        return {
            totalEntries: this.requests.size,
            maxRequests: this.maxRequests,
            windowMs: this.windowMs,
        };
    }
}
