import { Log } from "@cross/log";
import { ConnectionManager } from "./manager.ts"
import { getErrMsg } from "../utils/error.ts";
import { DistributedTokenBucket } from "../utils/rate-limiter.ts";

export class MetricsCollector {
    private counters = new Map<string, number>();
    private gauges = new Map<string, number>();
    private histograms = new Map<string, number[]>();
    private startTime = Date.now();
    private startTimeISO = new Date().toISOString();
    private requestTimestamps: number[] = [];
    private readonly maxRequestHistory = 1000;

    increment(name: string, value = 1) {
        this.counters.set(name, (this.counters.get(name) || 0) + value);
    }

    gauge(name: string, value: number) {
        this.gauges.set(name, value);
    }

    histogram(name: string, value: number) {
        const values = this.histograms.get(name) || [];
        values.push(value);

        if (values.length > 1000) {
            values.shift();
        }

        this.histograms.set(name, values);
    }

    recordRequest() {
        const now = Date.now();
        this.requestTimestamps.push(now);
        if (this.requestTimestamps.length > this.maxRequestHistory) {
            this.requestTimestamps.shift();
        }
    }

    getRequestsPerSecond(): number {
        if (this.requestTimestamps.length === 0) return 0;
        const now = Date.now();
        const oneSecondAgo = now - 1000;
        const recentRequests = this.requestTimestamps.filter(t => t >= oneSecondAgo);
        return recentRequests.length;
    }

    getRequestsPerMinute(): number {
        if (this.requestTimestamps.length === 0) return 0;
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        const recentRequests = this.requestTimestamps.filter(t => t >= oneMinuteAgo);
        return recentRequests.length;
    }

    getSnapshot() {
        const snapshot: Record<string, unknown> = {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            requests: {
                perSecond: this.getRequestsPerSecond(),
                perMinute: this.getRequestsPerMinute(),
                total: this.requestTimestamps.length
            }
        };

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
        this.requestTimestamps = [];
        this.startTime = Date.now();
        this.startTimeISO = new Date().toISOString();
    }

    getUptime(): number {
        return Date.now() - this.startTime;
    }

    getStartTimeISO(): string {
        return this.startTimeISO;
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
        const osInfo = this.getOSInfo();

        return {
            status: "healthy",
            timestamp: new Date().toISOString(),
            startTime: this.metrics.getStartTimeISO(),
            uptimeSeconds: Math.floor(this.metrics.getUptime() / 1000),
            uptime: this.formatUptime(this.metrics.getUptime() / 1000),
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
                heapUsagePercent: ((memory.heapUsed / memory.heapTotal) * 100).toFixed(2) + "%"
            },
            system: osInfo,
            deno: {
                version: Deno.version.deno,
                v8: Deno.version.v8,
                typescript: Deno.version.typescript,
                build: Deno.build
            }
        };
    }

    private getOSInfo() {
        const info: Record<string, unknown> = {};
        
        try {
            if (Deno.hostname) {
                info.hostname = Deno.hostname();
            }
        } catch (_) {}

        try {
            if ((Deno as any).cpus) {
                const cpus = (Deno as any).cpus();
                info.cpus = cpus.length;
                info.cpuModel = cpus[0]?.model || 'unknown';
            }
        } catch (_) {}

        try {
            if (Deno.loadavg) {
                info.loadavg = Deno.loadavg();
            }
        } catch (_) {}

        try {
            if (Deno.env) {
                info.env = {
                    NODE_ENV: Deno.env.get('NODE_ENV'),
                    DENO_ENV: Deno.env.get('DENO_ENV')
                };
            }
        } catch (_) {}

        return info;
    }

    private formatUptime(seconds: number): string {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        if (d > 0) return `${d}天 ${h}小时 ${m}分`;
        if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
        if (m > 0) return `${m}分 ${s}秒`;
        return `${s}秒`;
    }

    startPeriodicLogging(intervalMs = 60000) {
        // setInterval(() => {
        //     const health = this.getHealth();
        //     this.logger.info('Health check', {
        //         uptime: health.uptime,
        //         connections: health.connections.active,
        //         memory: health.memory.heapUsed,
        //         requestsPerMin: health.metrics.requests?.perMinute || 0
        //     });
        // }, intervalMs);
    }
}

export class RateLimiter {
    private tokenBucket: DistributedTokenBucket;
    private cleanupInterval?: number;
    private requestHistory = new Map<string, number[]>();

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
        const now = Date.now();
        if (!this.requestHistory.has(identifier)) {
            this.requestHistory.set(identifier, []);
        }
        const history = this.requestHistory.get(identifier)!;
        history.push(now);
        if (history.length > 100) {
            history.shift();
        }
        return this.tokenBucket.consume(identifier, 1);
    }

    getRemainingRequests(identifier: string): number {
        return this.tokenBucket.getAvailableTokens(identifier);
    }

    getRequestRate(identifier: string, windowMs = 60000): number {
        const now = Date.now();
        const history = this.requestHistory.get(identifier) || [];
        return history.filter(t => now - t < windowMs).length;
    }

    startPeriodicCleanup(intervalMs = 60000) {
        this.cleanupInterval = setInterval(() => {
            this.tokenBucket.cleanup();
            const now = Date.now();
            for (const [id, history] of this.requestHistory) {
                this.requestHistory.set(id, history.filter(t => now - t < 3600000));
            }
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
        const bucketStats = this.tokenBucket.getStats();
        return {
            ...bucketStats,
            trackedIdentifiers: this.requestHistory.size,
            totalRequests: Array.from(this.requestHistory.values())
                .reduce((sum, arr) => sum + arr.length, 0)
        };
    }
}
