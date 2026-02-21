import { Maxmind } from "@josh-hemphill/maxminddb-wasm";
import { Log } from "@cross/log"
import { getErrMsg } from "../utils/error.ts";
import { LRUCache } from "../utils/lru-cache.ts";

const GEOIP_CACHE_SIZE = 10000; // GeoIP查询缓存大小

export class GeoIPManager {
    private reader?: Maxmind;
    private cache: LRUCache<string, boolean>;
    private logger: Log;

    constructor(logger: Log) {
        this.logger = logger;
        // 使用LRU缓存减少重复查询
        this.cache = new LRUCache<string, boolean>(GEOIP_CACHE_SIZE);
    }

    async init(mmdbPath: string) {
        let data: Uint8Array;
        try {
            data = await Deno.readFile(mmdbPath);
        } catch (err) {
            throw new Error(`Failed to read GeoIP database: ${getErrMsg(err)}`);
        }

        try {
            this.reader = new Maxmind(data);
        } catch (err) {
            throw new Error(`Failed to parse GeoIP database: ${getErrMsg(err)}`);
        }

        const info = this.reader.metadata;
        this.logger.info("GeoIP database initialized", {
            databaseType: info.database_type,
            ipVersion: info.ip_version,
            recordSize: info.record_size
        });
        this.logger.debug("GeoIP metadata", {
            binaryFormatMajor: info.binary_format_major_version,
            binaryFormatMinor: info.binary_format_minor_version,
            languages: info.languages,
            description: info.description
        });
    }

    isChinaIP(ip: string): boolean {
        if (!this.reader) return false;

        // 检查缓存
        const cached = this.cache.get(ip);
        if (cached !== undefined) {
            return cached;
        }

        try {
            const result = this.reader.lookup_city(ip);
            if (!result) {
                this.cache.set(ip, false);
                return false;
            }
            
            const isChina = result?.country?.iso_code === "CN";
            this.cache.set(ip, isChina);
            
            // 只在调试级别记录
            if (this.logger['debug']) {
                this.logger.debug("GeoIP lookup", { ip, isoCode: result?.country?.iso_code, isChina });
            }
            return isChina;
        } catch (e) {
            this.logger.error("GeoIP lookup error", { ip, error: getErrMsg(e) });
            this.cache.set(ip, false);
            return false;
        }
    }

    shouldProxyIP(ip: string): boolean {
        return !this.isChinaIP(ip);
    }

    /**
     * 批量查询IP
     * 比单个查询更高效
     */
    batchIsChinaIP(ips: string[]): Map<string, boolean> {
        const results = new Map<string, boolean>();
        
        for (const ip of ips) {
            results.set(ip, this.isChinaIP(ip));
        }
        
        return results;
    }

    /**
     * 获取缓存统计
     */
    getCacheStats(): { size: number; maxSize: number } {
        return {
            size: this.cache.size,
            maxSize: this.cache.maxSizeValue
        };
    }

    /**
     * 清空缓存
     */
    clearCache(): void {
        this.cache.clear();
    }

    close() {
        if (this.reader) {
            try {
                this.reader.free();
                this.logger.debug("GeoIP database closed");
            } catch (err) {
                this.logger.error("Error closing GeoIP database", { error: getErrMsg(err) });
            }
            this.reader = undefined;
        }
        this.cache.clear();
    }
}
