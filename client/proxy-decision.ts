import { GeoIPManager } from "./geoip.ts";
import { Log } from "@cross/log";
import { getErrMsg } from "../utils/error.ts";
import { TTLCache } from "../utils/lru-cache.ts";

const DNS_CACHE_TTL = 300000; // 5分钟DNS缓存
const DNS_TIMEOUT = 5000; // 5秒DNS超时
const MAX_DNS_CACHE_SIZE = 10000; // 最大DNS缓存条目数

export class ProxyDecision {
    private dnsCache: TTLCache<string, string[]>;
    private geoip?: GeoIPManager;
    private logger?: Log;

    constructor(geoip?: GeoIPManager, logger?: Log) {
        this.geoip = geoip;
        this.logger = logger;
        
        // 使用带TTL的LRU缓存，限制大小防止内存泄漏
        this.dnsCache = new TTLCache<string, string[]>(
            MAX_DNS_CACHE_SIZE,
            DNS_CACHE_TTL,
            true // 自动清理过期条目
        );
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

        // 检查缓存（TTLCache自动处理过期）
        const cached = this.dnsCache.get(host);
        if (cached) {
            this.logger?.debug("Using cached DNS result", { host });
            return this.checkIPsShouldProxy(cached);
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

            // 缓存结果（TTLCache自动处理TTL）
            this.dnsCache.set(host, ips);

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

    destroy() {
        this.dnsCache.destroy();
    }

    getCacheStats() {
        return {
            size: this.dnsCache.size,
            maxSize: MAX_DNS_CACHE_SIZE
        };
    }
}
