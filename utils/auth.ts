import { Log } from "@cross/log";

/**
 * 认证配置
 */
export interface AuthConfig {
    enabled: boolean;
    tokens: Set<string>;
    tokenHeader?: string;
    rateLimitPerToken?: number;
}

/**
 * 认证管理器
 * 支持Token认证和速率限制
 */
export class AuthManager {
    private config: AuthConfig;
    private tokenUsage = new Map<string, { count: number; lastReset: number }>();
    private logger?: Log;

    constructor(config: Partial<AuthConfig> & { enabled: boolean }, logger?: Log) {
        this.config = {
            tokens: config.tokens ?? new Set(),
            tokenHeader: config.tokenHeader ?? "X-Auth-Token",
            rateLimitPerToken: config.rateLimitPerToken ?? 1000,
            ...config
        };
        this.logger = logger;

        // 每分钟重置使用计数
        setInterval(() => {
            this.resetUsage();
        }, 60000);
    }

    /**
     * 验证Token
     */
    validateToken(token: string): boolean {
        if (!this.config.enabled) {
            return true;
        }

        if (!token) {
            return false;
        }

        if (!this.config.tokens.has(token)) {
            this.logger?.warn("Invalid token attempt", { token: token.substring(0, 8) + "..." });
            return false;
        }

        // 检查速率限制
        if (this.config.rateLimitPerToken) {
            const usage = this.tokenUsage.get(token);
            if (usage && usage.count >= this.config.rateLimitPerToken) {
                this.logger?.warn("Token rate limit exceeded", { token: token.substring(0, 8) + "..." });
                return false;
            }

            // 增加使用计数
            if (!usage) {
                this.tokenUsage.set(token, { count: 1, lastReset: Date.now() });
            } else {
                usage.count++;
            }
        }

        return true;
    }

    /**
     * 从WebSocket握手头中提取Token
     */
    extractTokenFromHeaders(headers: Headers): string | null {
        return headers.get(this.config.tokenHeader!);
    }

    /**
     * 从URL参数中提取Token
     */
    extractTokenFromURL(url: string): string | null {
        try {
            const parsed = new URL(url, "http://localhost");
            return parsed.searchParams.get("token");
        } catch {
            return null;
        }
    }

    /**
     * 添加Token
     */
    addToken(token: string): void {
        this.config.tokens.add(token);
    }

    /**
     * 移除Token
     */
    removeToken(token: string): boolean {
        this.tokenUsage.delete(token);
        return this.config.tokens.delete(token);
    }

    /**
     * 获取所有Token
     */
    getTokens(): string[] {
        return [...this.config.tokens];
    }

    /**
     * 获取Token使用统计
     */
    getTokenStats(): Map<string, { count: number; lastReset: number }> {
        return new Map(this.tokenUsage);
    }

    /**
     * 检查是否启用
     */
    isEnabled(): boolean {
        return this.config.enabled;
    }

    private resetUsage(): void {
        const now = Date.now();
        for (const [token, usage] of this.tokenUsage) {
            if (now - usage.lastReset > 60000) {
                this.tokenUsage.set(token, { count: 0, lastReset: now });
            }
        }
    }
}

/**
 * 请求验证器
 * 验证请求的合法性
 */
export class RequestValidator {
    private maxHostLength: number;
    private maxPort: number;
    private blockedHosts: Set<string>;
    private allowedPorts: Set<number> | null;
    private logger?: Log;

    constructor(options: {
        maxHostLength?: number;
        maxPort?: number;
        blockedHosts?: string[];
        allowedPorts?: number[];
        logger?: Log;
    } = {}) {
        this.maxHostLength = options.maxHostLength ?? 253;
        this.maxPort = options.maxPort ?? 65535;
        this.blockedHosts = new Set(options.blockedHosts ?? []);
        this.allowedPorts = options.allowedPorts ? new Set(options.allowedPorts) : null;
        this.logger = options.logger;
    }

    /**
     * 验证TCP连接请求
     */
    validateTCPConnect(host: string, port: number): { valid: boolean; error?: string } {
        // 验证主机名长度
        if (host.length > this.maxHostLength) {
            return { valid: false, error: "Host name too long" };
        }

        // 验证端口范围
        if (port <= 0 || port > this.maxPort) {
            return { valid: false, error: "Invalid port number" };
        }

        // 检查是否在黑名单中
        if (this.blockedHosts.has(host)) {
            this.logger?.warn("Blocked host attempt", { host });
            return { valid: false, error: "Host is blocked" };
        }

        // 检查端口白名单
        if (this.allowedPorts && !this.allowedPorts.has(port)) {
            this.logger?.warn("Blocked port attempt", { port });
            return { valid: false, error: "Port not allowed" };
        }

        // 验证主机名格式
        if (!this.isValidHost(host)) {
            return { valid: false, error: "Invalid host format" };
        }

        return { valid: true };
    }

    /**
     * 验证DNS查询请求
     */
    validateDNSQuery(name: string, recordType: number): { valid: boolean; error?: string } {
        // 验证域名长度
        if (name.length > 253) {
            return { valid: false, error: "Domain name too long" };
        }

        // 验证域名格式
        if (!this.isValidDomain(name)) {
            return { valid: false, error: "Invalid domain format" };
        }

        // 验证记录类型
        const validTypes = [1, 28, 5, 15, 16, 2, 12]; // A, AAAA, CNAME, MX, TXT, NS, PTR
        if (!validTypes.includes(recordType)) {
            return { valid: false, error: "Invalid DNS record type" };
        }

        return { valid: true };
    }

    /**
     * 验证HTTP请求
     */
    validateHTTPRequest(url: string, method: string): { valid: boolean; error?: string } {
        // 验证URL长度
        if (url.length > 2048) {
            return { valid: false, error: "URL too long" };
        }

        // 验证URL格式
        try {
            const parsed = new URL(url);
            
            // 检查协议
            if (!["http:", "https:"].includes(parsed.protocol)) {
                return { valid: false, error: "Invalid protocol" };
            }

            // 检查是否在黑名单中
            if (this.blockedHosts.has(parsed.hostname)) {
                this.logger?.warn("Blocked host attempt", { host: parsed.hostname });
                return { valid: false, error: "Host is blocked" };
            }
        } catch {
            return { valid: false, error: "Invalid URL format" };
        }

        // 验证HTTP方法
        const validMethods = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"];
        if (!validMethods.includes(method.toUpperCase())) {
            return { valid: false, error: "Invalid HTTP method" };
        }

        return { valid: true };
    }

    /**
     * 添加黑名单主机
     */
    addBlockedHost(host: string): void {
        this.blockedHosts.add(host);
    }

    /**
     * 移除黑名单主机
     */
    removeBlockedHost(host: string): void {
        this.blockedHosts.delete(host);
    }

    /**
     * 获取黑名单
     */
    getBlockedHosts(): string[] {
        return [...this.blockedHosts];
    }

    private isValidHost(host: string): boolean {
        // IP地址
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
            const parts = host.split(".").map(Number);
            return parts.every(p => p >= 0 && p <= 255);
        }

        // IPv6地址
        if (/^\[?[0-9a-fA-F:]+\]?$/.test(host)) {
            return true;
        }

        // 域名
        return this.isValidDomain(host);
    }

    private isValidDomain(domain: string): boolean {
        // 简单的域名验证
        const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        return domainRegex.test(domain);
    }
}

/**
 * 生成安全的随机Token
 */
export function generateSecureToken(length: number = 32): string {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * 哈希Token（用于存储）
 */
export async function hashToken(token: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}
