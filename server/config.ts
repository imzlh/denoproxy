import { parseArgs } from "@std/cli";
import { envNumber, envString } from "../utils/env.ts";

export interface ServerConfig {
    port: number;
    hostname: string;
    logLevel: "debug" | "info" | "warn" | "error";
    maxConnections: number;
    connectionTimeout: number;
    tlsCert?: string;
    tlsKey?: string;
    connectPath: string;
    webui: string;
    // 新增：安全配置
    auth: {
        enabled: boolean;
        tokens: string[];
        tokenHeader: string;
        rateLimitPerToken: number;
    };
    // 新增：请求验证配置
    validation: {
        enabled: boolean;
        maxHostLength: number;
        blockedHosts: string[];
        allowedPorts: number[];
    };
    // 新增：性能配置
    performance: {
        maxQueueSize: number;
        maxPendingRequests: number;
        heartbeatInterval: number;
        heartbeatTimeout: number;
    };
}

export function loadConfig(): ServerConfig {
    const args = parseArgs(Deno.args, {
        string: [
            "hostname", "log-level", "tls-cert", "tls-key", "connect-path", "webui",
            "auth-tokens", "auth-header", "blocked-hosts", "allowed-ports"
        ],
        boolean: ["auth-enabled", "validation-enabled"],
        default: {
            port: envNumber("PORT", 8080),
            hostname: envString("HOSTNAME", "127.0.0.1"),
            "log-level": envString("LOG_LEVEL", "info"),
            "max-connections": envNumber("CONN_LIMIT", 100),
            "connection-timeout": envNumber("CONNECT_TIMEOUT", 300000), // 5 minutes
            "connect-path": envString("CONN_PATH", "/"),
            "webui": envString("WEBUI", Deno.cwd()),
            "auth-enabled": envString("AUTH_ENABLED", "false") === "true",
            "auth-tokens": envString("AUTH_TOKENS", ""),
            "auth-header": envString("AUTH_HEADER", "X-Auth-Token"),
            "auth-rate-limit": envNumber("AUTH_RATE_LIMIT", 1000),
            "validation-enabled": envString("VALIDATION_ENABLED", "false") === "true",
            "max-host-length": envNumber("MAX_HOST_LENGTH", 253),
            "blocked-hosts": envString("BLOCKED_HOSTS", ""),
            "allowed-ports": envString("ALLOWED_PORTS", ""),
            "max-queue-size": envNumber("MAX_QUEUE_SIZE", 1000),
            "max-pending-requests": envNumber("MAX_PENDING_REQUESTS", 10000),
            "heartbeat-interval": envNumber("HEARTBEAT_INTERVAL", 30000),
            "heartbeat-timeout": envNumber("HEARTBEAT_TIMEOUT", 60000)
        },
        alias: {
            p: "port",
            h: "hostname",
        }
    });

    // 验证端口
    const port = args.port as number;
    if (port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${port}. Must be between 1 and 65535.`);
    }

    // 验证日志级别
    const logLevel = args["log-level"] as string;
    const validLogLevels = ["debug", "info", "warn", "error"];
    if (!validLogLevels.includes(logLevel)) {
        throw new Error(`Invalid log level: ${logLevel}. Must be one of: ${validLogLevels.join(", ")}`);
    }

    // 验证连接限制
    const maxConnections = args["max-connections"] as number;
    if (maxConnections < 1) {
        throw new Error("max-connections must be at least 1");
    }

    // 验证超时
    const connectionTimeout = args["connection-timeout"] as number;
    if (connectionTimeout < 1000) {
        throw new Error("connection-timeout must be at least 1000ms");
    }

    // 验证 TLS 配置
    const tlsCert = args["tls-cert"];
    const tlsKey = args["tls-key"];
    
    if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
        throw new Error("Both --tls-cert and --tls-key must be provided for TLS");
    }

    // 解析认证tokens
    const authTokens = (args["auth-tokens"] as string)
        .split(",")
        .map(t => t.trim())
        .filter(t => t.length > 0);

    // 解析黑名单主机
    const blockedHosts = (args["blocked-hosts"] as string)
        .split(",")
        .map(h => h.trim())
        .filter(h => h.length > 0);

    // 解析允许的端口
    const allowedPorts = (args["allowed-ports"] as string)
        .split(",")
        .map(p => parseInt(p.trim()))
        .filter(p => !isNaN(p) && p > 0 && p <= 65535);

    return {
        port,
        hostname: args.hostname as string,
        logLevel: logLevel as "debug" | "info" | "warn" | "error",
        maxConnections,
        connectionTimeout,
        tlsCert,
        tlsKey,
        connectPath: args["connect-path"] as string,
        webui: args['webui'] as string,
        auth: {
            enabled: args["auth-enabled"] as boolean,
            tokens: authTokens,
            tokenHeader: args["auth-header"] as string,
            rateLimitPerToken: args["auth-rate-limit"] as number
        },
        validation: {
            enabled: args["validation-enabled"] as boolean,
            maxHostLength: args["max-host-length"] as number,
            blockedHosts,
            allowedPorts
        },
        performance: {
            maxQueueSize: args["max-queue-size"] as number,
            maxPendingRequests: args["max-pending-requests"] as number,
            heartbeatInterval: args["heartbeat-interval"] as number,
            heartbeatTimeout: args["heartbeat-timeout"] as number
        }
    };
}
