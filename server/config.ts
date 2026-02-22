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
    help: boolean;
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

export function printHelp() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║                         DenoProxy Server - Help                             ║
╚══════════════════════════════════════════════════════════════════════════╝

用法:
  deno run -A server/main.ts [选项]

选项:
  基本配置:
    -h, --hostname <地址>        监听地址 (默认: 127.0.0.1)
    -p, --port <端口>            监听端口 (默认: 8080)
    --log-level <级别>           日志级别: debug|info|warn|error (默认: info)
    --connect-path <路径>         WebSocket连接路径 (默认: /)
    --webui <目录>               WebUI文件目录 (默认: ./webui)

  连接配置:
    --max-connections <数量>     最大连接数 (默认: 100)
    --connection-timeout <毫秒>   连接超时时间 (默认: 300000ms=5分钟)

  TLS/安全配置:
    --tls-cert <路径>            TLS证书文件路径
    --tls-key <路径>             TLS私钥文件路径
    --auth-enabled               启用认证
    --auth-tokens <token1,token2> 认证令牌列表
    --auth-header <头名>         认证请求头 (默认: X-Auth-Token)
    --auth-rate-limit <数量>     每个令牌的速率限制 (默认: 1000)

  请求验证配置:
    --validation-enabled         启用请求验证
    --max-host-length <长度>     最大主机名长度 (默认: 253)
    --blocked-hosts <host1,host2> 黑名单主机
    --allowed-ports <port1,port2> 允许的端口列表

  性能配置:
    --max-queue-size <数量>      最大队列大小 (默认: 1000)
    --max-pending-requests <数量> 最大待处理请求数 (默认: 10000)
    --heartbeat-interval <毫秒>   心跳间隔 (默认: 30000ms)
    --heartbeat-timeout <毫秒>    心跳超时 (默认: 60000ms)

  其他:
    --help, -h                   显示此帮助信息

API端点:
  /?api=health                  健康检查
  /?api=stats                   统计信息
  /?api=connections             连接列表
  /?api=system                  系统信息
  /?api=metrics                 指标数据

WebUI:
  访问服务器根路径即可查看WebUI (默认: http://127.0.0.1:8080)

环境变量:
  PORT, HOSTNAME, LOG_LEVEL, CONN_LIMIT, CONNECT_TIMEOUT,
  CONN_PATH, WEBUI, AUTH_ENABLED, AUTH_TOKENS, AUTH_HEADER,
  AUTH_RATE_LIMIT, VALIDATION_ENABLED, MAX_HOST_LENGTH,
  BLOCKED_HOSTS, ALLOWED_PORTS, MAX_QUEUE_SIZE,
  MAX_PENDING_REQUESTS, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT

示例:
  # 基本启动
  deno run -A server/main.ts

  # 指定端口和地址
  deno run -A server/main.ts -p 3000 -h 0.0.0.0

  # 启用TLS
  deno run -A server/main.ts --tls-cert cert.pem --tls-key key.pem

  # 启用认证
  deno run -A server/main.ts --auth-enabled --auth-tokens token123,abc456
`);
}

export function loadConfig(): ServerConfig {
    const args = parseArgs(Deno.args, {
        string: [
            "hostname", "log-level", "tls-cert", "tls-key", "connect-path", "webui",
            "auth-tokens", "auth-header", "blocked-hosts", "allowed-ports"
        ],
        boolean: ["auth-enabled", "validation-enabled", "help"],
        default: {
            port: envNumber("PORT", 8080),
            hostname: envString("HOSTNAME", "127.0.0.1"),
            "log-level": envString("LOG_LEVEL", "info"),
            "max-connections": envNumber("CONN_LIMIT", 100),
            "connection-timeout": envNumber("CONNECT_TIMEOUT", 300000),
            "connect-path": envString("CONN_PATH", "/"),
            "webui": envString("WEBUI", Deno.cwd() + "/webui"),
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
            "heartbeat-timeout": envNumber("HEARTBEAT_TIMEOUT", 60000),
            help: false
        },
        alias: {
            p: "port",
        }
    });

    if (args.help) {
        printHelp();
        Deno.exit(0);
    }

    const port = args.port as number;
    if (port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${port}. Must be between 1 and 65535.`);
    }

    const logLevel = args["log-level"] as string;
    const validLogLevels = ["debug", "info", "warn", "error"];
    if (!validLogLevels.includes(logLevel)) {
        throw new Error(`Invalid log level: ${logLevel}. Must be one of: ${validLogLevels.join(", ")}`);
    }

    const maxConnections = args["max-connections"] as number;
    if (maxConnections < 1) {
        throw new Error("max-connections must be at least 1");
    }

    const connectionTimeout = args["connection-timeout"] as number;
    if (connectionTimeout < 1000) {
        throw new Error("connection-timeout must be at least 1000ms");
    }

    const tlsCert = args["tls-cert"];
    const tlsKey = args["tls-key"];
    
    if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
        throw new Error("Both --tls-cert and --tls-key must be provided for TLS");
    }

    const authTokens = (args["auth-tokens"] as string)
        .split(",")
        .map(t => t.trim())
        .filter(t => t.length > 0);

    const blockedHosts = (args["blocked-hosts"] as string)
        .split(",")
        .map(h => h.trim())
        .filter(h => h.length > 0);

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
        help: args.help as boolean,
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
