import { Maxmind } from "@josh-hemphill/maxminddb-wasm";
import { Log } from "@cross/log"
import { getErrMsg } from "../utils/error.ts";

export class GeoIPManager {
    private reader?: Maxmind;

    constructor(private logger: Log) { }

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

        try {
            const result = this.reader.lookup_city(ip);
            if (!result) return false;
            
            const isChina = result?.country?.iso_code === "CN";
            this.logger.debug("GeoIP lookup", { ip, isoCode: result?.country?.iso_code, isChina });
            return isChina;
        } catch (e) {
            this.logger.error("GeoIP lookup error", { ip, error: getErrMsg(e) });
            return false;
        }
    }

    shouldProxyIP(ip: string): boolean {
        return !this.isChinaIP(ip);
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
    }
}
