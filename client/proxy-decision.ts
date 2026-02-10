import { GeoIPManager } from "./geoip.ts";
import { Log } from "@cross/log";
import { getErrMsg } from "../utils/error.ts";

const DNS_CACHE_TTL = 300000; // 5分钟DNS缓存
const DNS_TIMEOUT = 5000; // 5秒DNS超时

interface CacheEntry {
    ips: string[];
    timestamp: number;
}

export class ProxyDecision {
    private dnsCache = new Map<string, CacheEntry>();
    private cacheCleanupInterval?: number;

    constructor(private geoip?: GeoIPManager, private logger?: Log) {
        // 启动定期清理
        this.cacheCleanupInterval = setInterval(() => {
            this.cleanupCache();
        }, 60000);
    }

    async shouldProxy(host: string): Promise<boolean> {
        // 如果无 GeoIP，所有流量都走代理
        if (!this.geoip) return true;

        // 检查是否为 IP 地址
        if (this.isIP(host)) {
            const shouldProxy = this.geoip.shouldProxyIP(host);
            this.logger?.debug("IP shouldProxy check", { host, shouldProxy });
            return shouldProxy;
        }

        // 检查缓存
        const cached = this.dnsCache.get(host);
        if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
            this.logger?.debug("Using cached DNS result", { host });
            return this.checkIPsShouldProxy(cached.ips);
        }

        try {
            // 使用带超时的 DNS 查询
            const ips = await Promise.race([
                Deno.resolveDns(host, "A"),
                new Promise<string[]>((_, reject) => 
                    setTimeout(() => reject(new Error("DNS timeout")), DNS_TIMEOUT)
                )
            ]);

            if (!ips || ips.length === 0) {
                this.logger?.debug("No DNS results, defaulting to proxy", { host });
                return true;
            }

            // 缓存结果
            this.dnsCache.set(host, { ips, timestamp: Date.now() });

            return this.checkIPsShouldProxy(ips);
        } catch (err) {
            this.logger?.debug("DNS resolution failed, defaulting to proxy", {
                host,
                error: getErrMsg(err)
            });
            return true;
        }
    }

    shouldProxyIP(ip: string): boolean {
        if (!this.geoip) return false;
        return this.geoip.shouldProxyIP(ip);
    }

    private checkIPsShouldProxy(ips: string[]): boolean {
        for (const ip of ips) {
            if (typeof ip === 'string' && this.geoip!.isChinaIP(ip)) {
                this.logger?.debug("China IP detected, direct connection", { ip });
                return false;
            }
        }
        return true;
    }

    private isIP(host: string): boolean {
        // 简单检查是否为 IP 地址
        return /^\d+\.\d+\.\d+\.\d+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host);
    }

    private cleanupCache() {
        const now = Date.now();
        let cleaned = 0;
        for (const [host, entry] of this.dnsCache) {
            if (now - entry.timestamp > DNS_CACHE_TTL) {
                this.dnsCache.delete(host);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.logger?.debug("Cleaned DNS cache", { cleaned, remaining: this.dnsCache.size });
        }
    }

    destroy() {
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
        }
        this.dnsCache.clear();
    }

    getCacheStats() {
        return {
            size: this.dnsCache.size,
            entries: Array.from(this.dnsCache.keys())
        };
    }
}
