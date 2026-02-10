import { parseArgs } from "@std/cli";
import { envNumber, envString } from "../utils/env.ts";
export function loadConfig() {
    const args = parseArgs(Deno.args, {
        string: ["hostname", "log-level", "tls-cert", "tls-key", "connect-path", "webui"],
        default: {
            port: envNumber("PORT", 8080),
            hostname: envString("HOSTNAME", "127.0.0.1"),
            "log-level": envString( "LOG_LEVEL", "info"),
            "max-connections": envNumber("CONN_LIMIT", 100),
            "connection-timeout": envNumber("CONNECT_TIMEOUT", 300000), // 5 minutes
            "connect-path": envString("CONN_PATH", "/"),
            "webui": envString("WEBUI", Deno.cwd())
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

    return {
        port,
        hostname: args.hostname as string,
        logLevel: logLevel as "debug" | "info" | "warn" | "error",
        maxConnections,
        connectionTimeout,
        tlsCert,
        tlsKey,
        connectPath: args["connect-path"] as string,
        webui: args['webui']
    };
}
