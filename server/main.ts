import { ConsoleLogger, Log, Severity } from "@cross/log";
import { ProxyTransport } from "../core/transport.ts";
import { ConnectionManager } from "./manager.ts";
import { loadConfig, printHelp, ServerConfig } from "./config.ts";
import { HealthService, MetricsCollector, RateLimiter } from "./middleware.ts";
import { getErrMsg } from "../utils/error.ts";
import { serveDir } from "@std/http/file-server";
import { parseArgs } from "@std/cli";
import { sseLogger } from "./sse-logger.ts";

const preArgs = parseArgs(Deno.args, {
    boolean: ["help"],
    default: { help: false }
});

if (preArgs.help || preArgs.h) {
    printHelp();
    Deno.exit(0);
}

// 自定义 Logger，同时输出到控制台和 SSE
class SSELogHandler {
    constructor(private minSeverity: Severity) { }

    log(severity: Severity, message: string, data?: Record<string, unknown>) {
        // 同时发送到 SSE
        sseLogger.log(severity, message, data);
    }
}

class APIServer {
    private startTime: Date;
    private configSnapshot: Partial<ServerConfig>;

    constructor(
        private connMgr: ConnectionManager,
        private health: HealthService,
        private rateLimiter: RateLimiter,
        private metrics: MetricsCollector,
        private config: ServerConfig,
        private logger: Log
    ) {
        this.startTime = new Date();
        this.configSnapshot = this.sanitizeConfig(config);
    }

    private sanitizeConfig(config: ServerConfig): Partial<ServerConfig> {
        return {
            port: config.port,
            hostname: config.hostname,
            logLevel: config.logLevel,
            maxConnections: config.maxConnections,
            connectionTimeout: config.connectionTimeout,
            connectPath: config.connectPath,
            webui: config.webui,
            auth: {
                enabled: config.auth.enabled,
                tokens: config.auth.tokens,
                tokenHeader: config.auth.tokenHeader,
                rateLimitPerToken: config.auth.rateLimitPerToken
            },
            validation: {
                enabled: config.validation.enabled,
                maxHostLength: config.validation.maxHostLength,
                blockedHosts: config.validation.blockedHosts,
                allowedPorts: config.validation.allowedPorts
            },
            performance: config.performance
        };
    }

    handle(req: Request): Response {
        const url = new URL(req.url);
        const api = url.searchParams.get('api');

        if (!api) {
            return new Response("Your request is blocked by guard", { status: 403 });
        }

        this.metrics.recordRequest();
        return this.handleAPI(req, api);
    }

    private handleAPI(req: Request, api: string): Response {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json"
        };

        if (req.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        if (req.method !== "GET" && req.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method not allowed" }), {
                status: 405,
                headers: corsHeaders
            });
        }

        const url = new URL(req.url);
        const useSSE = url.searchParams.get('sse') === 'true';

        try {
            switch (api) {
                case 'health': {
                    if (useSSE) {
                        return this.createSSEStream((send) => {
                            send({ type: 'health', data: this.health.getHealth() });
                            const interval = setInterval(() => {
                                send({ type: 'health', data: this.health.getHealth() });
                            }, 3000);
                            return () => clearInterval(interval);
                        }, corsHeaders);
                    }
                    return new Response(JSON.stringify(this.health.getHealth()), {
                        headers: corsHeaders
                    });
                }

                case 'stats': {
                    if (useSSE) {
                        return this.createSSEStream((send) => {
                            const sendStats = () => send({
                                type: 'stats',
                                data: {
                                    server: {
                                        startTime: this.startTime.toISOString(),
                                        uptime: Date.now() - this.startTime.getTime()
                                    },
                                    connections: this.connMgr.getStats(),
                                    rateLimiter: this.rateLimiter.getStats(),
                                    metrics: this.metrics.getSnapshot(),
                                    timestamp: new Date().toISOString()
                                }
                            });
                            sendStats();
                            const interval = setInterval(sendStats, 3000);
                            return () => clearInterval(interval);
                        }, corsHeaders);
                    }
                    return new Response(JSON.stringify({
                        server: {
                            startTime: this.startTime.toISOString(),
                            uptime: Date.now() - this.startTime.getTime()
                        },
                        connections: this.connMgr.getStats(),
                        rateLimiter: this.rateLimiter.getStats(),
                        metrics: this.metrics.getSnapshot(),
                        timestamp: new Date().toISOString()
                    }), { headers: corsHeaders });
                }

                case 'connections': {
                    if (useSSE) {
                        return this.createSSEStream((send) => {
                            const sendConns = () => {
                                const conns = this.connMgr.getAllConnections().map(c => {
                                    const now = Date.now();
                                    const idleMs = now - c.lastActivity;
                                    return {
                                        id: c.id,
                                        connectedAt: new Date(c.connectedAt).toISOString(),
                                        lastActivity: new Date(c.lastActivity).toISOString(),
                                        reconnectCount: c.reconnectCount,
                                        duration: now - c.connectedAt,
                                        idleMs,
                                        idle: idleMs > 60000,
                                        idleTime: this.formatDuration(idleMs)
                                    };
                                });
                                send({
                                    type: 'connections',
                                    data: {
                                        connections: conns,
                                        total: conns.length,
                                        active: conns.filter(c => !c.idle).length,
                                        idle: conns.filter(c => c.idle).length
                                    }
                                });
                            };
                            sendConns();
                            const interval = setInterval(sendConns, 3000);
                            return () => clearInterval(interval);
                        }, corsHeaders);
                    }
                    const conns = this.connMgr.getAllConnections().map(c => {
                        const now = Date.now();
                        const idleMs = now - c.lastActivity;
                        return {
                            id: c.id,
                            connectedAt: new Date(c.connectedAt).toISOString(),
                            lastActivity: new Date(c.lastActivity).toISOString(),
                            reconnectCount: c.reconnectCount,
                            duration: now - c.connectedAt,
                            idleMs,
                            idle: idleMs > 60000,
                            idleTime: this.formatDuration(idleMs)
                        };
                    });
                    return new Response(JSON.stringify({
                        connections: conns,
                        total: conns.length,
                        active: conns.filter(c => !c.idle).length,
                        idle: conns.filter(c => c.idle).length
                    }), {
                        headers: corsHeaders
                    });
                }

                case 'connections': {
                    const conns = this.connMgr.getAllConnections().map(c => {
                        const now = Date.now();
                        const idleMs = now - c.lastActivity;
                        return {
                            id: c.id,
                            connectedAt: new Date(c.connectedAt).toISOString(),
                            lastActivity: new Date(c.lastActivity).toISOString(),
                            reconnectCount: c.reconnectCount,
                            duration: now - c.connectedAt,
                            idleMs,
                            idle: idleMs > 60000,
                            idleTime: this.formatDuration(idleMs)
                        };
                    });
                    return new Response(JSON.stringify({
                        connections: conns,
                        total: conns.length,
                        active: conns.filter(c => !c.idle).length,
                        idle: conns.filter(c => c.idle).length
                    }), {
                        headers: corsHeaders
                    });
                }

                case 'system': {
                    const mem = Deno.memoryUsage();
                    const load = (Deno as any).loadavg ? (Deno as any).loadavg() : [0, 0, 0];
                    const cpus = (Deno as any).cpus ? (Deno as any).cpus() : [];
                    return new Response(JSON.stringify({
                        memory: {
                            rss: mem.rss,
                            rssMB: Math.floor(mem.rss / 1024 / 1024),
                            heapTotal: mem.heapTotal,
                            heapTotalMB: Math.floor(mem.heapTotal / 1024 / 1024),
                            heapUsed: mem.heapUsed,
                            heapUsedMB: Math.floor(mem.heapUsed / 1024 / 1024),
                            external: mem.external,
                            externalMB: Math.floor(mem.external / 1024 / 1024),
                            heapUsagePercent: ((mem.heapUsed / mem.heapTotal) * 100).toFixed(2)
                        },
                        loadavg: load,
                        cpus: cpus.length,
                        cpuModel: cpus[0]?.model || 'unknown',
                        deno: Deno.version,
                        build: Deno.build,
                        hostname: Deno.hostname ? Deno.hostname() : 'unknown'
                    }), { headers: corsHeaders });
                }

                case 'metrics': {
                    return new Response(JSON.stringify(this.metrics.getSnapshot()), {
                        headers: corsHeaders
                    });
                }

                case 'config': {
                    return new Response(JSON.stringify(this.configSnapshot), {
                        headers: corsHeaders
                    });
                }

                case 'all': {
                    return new Response(JSON.stringify({
                        health: this.health.getHealth(),
                        stats: {
                            connections: this.connMgr.getStats(),
                            rateLimiter: this.rateLimiter.getStats()
                        },
                        connections: this.connMgr.getAllConnections().map(c => ({
                            id: c.id,
                            connectedAt: new Date(c.connectedAt).toISOString(),
                            lastActivity: new Date(c.lastActivity).toISOString(),
                            reconnectCount: c.reconnectCount,
                            duration: Date.now() - c.connectedAt
                        })),
                        metrics: this.metrics.getSnapshot(),
                        system: {
                            deno: Deno.version,
                            build: Deno.build
                        },
                        config: this.configSnapshot,
                        timestamp: new Date().toISOString()
                    }), { headers: corsHeaders });
                }

                case 'ping': {
                    return new Response(JSON.stringify({
                        pong: true,
                        timestamp: new Date().toISOString()
                    }), { headers: corsHeaders });
                }

                case 'logs': {
                    // SSE 日志流
                    const level = (url.searchParams.get('level') || 'INFO').toUpperCase();
                    const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
                    const minLevel: Severity = (validLevels.includes(level) ? level : 'INFO') as Severity;

                    const stream = new ReadableStream<Uint8Array>({
                        start(controller) {
                            sseLogger.addClient(controller, minLevel);
                        },
                        cancel(controller) {
                            sseLogger.removeClient(controller);
                        }
                    });

                    return new Response(stream, {
                        headers: {
                            ...corsHeaders,
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive'
                        }
                    });
                }

                case 'reset': {
                    if (req.method !== "POST") {
                        return new Response(JSON.stringify({ error: "Method not allowed" }), {
                            status: 405,
                            headers: corsHeaders
                        });
                    }
                    this.metrics.reset();
                    this.logger.info("Metrics reset requested");
                    return new Response(JSON.stringify({
                        success: true,
                        message: "Metrics reset successfully",
                        timestamp: new Date().toISOString()
                    }), { headers: corsHeaders });
                }

                default:
                    return new Response(JSON.stringify({
                        error: "Unknown API endpoint",
                        availableEndpoints: [
                            'health', 'stats', 'connections', 'system',
                            'metrics', 'config', 'all', 'ping', 'reset'
                        ]
                    }), {
                        status: 404,
                        headers: corsHeaders
                    });
            }
        } catch (err) {
            this.logger.error("API error", { error: getErrMsg(err), api });
            return new Response(JSON.stringify({
                error: getErrMsg(err),
                timestamp: new Date().toISOString()
            }), {
                status: 500,
                headers: corsHeaders
            });
        }
    }

    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) return `${hours}小时 ${minutes % 60}分钟`;
        if (minutes > 0) return `${minutes}分钟 ${seconds % 60}秒`;
        return `${seconds}秒`;
    }

    private createSSEStream(
        handler: (send: (data: unknown) => void) => (() => void),
        corsHeaders: Record<string, string>
    ): Response {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const send = (data: unknown) => {
                    try {
                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
                    } catch {
                        // 客户端断开
                    }
                };

                const cleanup = handler(send);

                // 清理函数
                (controller as any).cleanup = cleanup;
            },
            cancel(controller) {
                if ((controller as any).cleanup) {
                    (controller as any).cleanup();
                }
            }
        });

        return new Response(stream, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }
        });
    }
}

async function main() {
    const config = loadConfig();
    // 自定义日志处理器，同时发送到 SSE
    const sseLogHandler = {
        log: (severity: Severity, message: string, data?: Record<string, unknown>) => {
            sseLogger.log(severity, message, data);
        }
    };

    const logger = new Log([
        new ConsoleLogger({
            "minimumSeverity": config.logLevel.toUpperCase() as Severity
        }),
        sseLogHandler as any
    ]);

    logger.info("╔═══════════════════════════════════════╗");
    logger.info("║       DenoProxy Server Starting       ║");
    logger.info("╚═══════════════════════════════════════╝");
    logger.info("Server configuration:", {
        hostname: config.hostname,
        port: config.port,
        maxConnections: config.maxConnections,
        connectionTimeout: config.connectionTimeout + "ms",
        logLevel: config.logLevel,
        tls: (config.tlsCert && config.tlsKey) ? "enabled" : "disabled",
        wsPrefix: config.connectPath,
        webui: config.webui
    });

    const connMgr = new ConnectionManager(
        config.maxConnections,
        config.connectionTimeout,
        logger
    );
    const metrics = new MetricsCollector();
    const health = new HealthService(connMgr, metrics, logger);
    const rateLimiter = new RateLimiter(15, 10000);

    logger.info("Initializing services...", {
        connectionManager: "ready",
        metricsCollector: "ready",
        healthService: "ready",
        rateLimiter: "90 req/min",
    });

    health.startPeriodicLogging();
    rateLimiter.startPeriodicCleanup();

    const apiServer = new APIServer(connMgr, health, rateLimiter, metrics, config, logger);

    logger.info("Services started successfully");

    const handler = async (req: Request): Promise<Response> => {
        const remoteAddr = req.headers.get("x-forwarded-for") ||
            (req as unknown as { conn?: { remoteAddr?: { hostname?: string } } }).conn?.remoteAddr?.hostname ||
            "unknown";
        const url = new URL(req.url, "http://localhost");
        const requestId = crypto.randomUUID().slice(0, 8);

        logger.debug(`[${requestId}] Incoming request`, {
            remoteAddr,
            url: url.pathname,
            method: req.method,
        });

        if (url.pathname !== config.connectPath) {
            if (url.pathname == '/log') {
                // 后门：打印配置
                console.log({
                    hostname: config.hostname,
                    port: config.port,
                    maxConnections: config.maxConnections,
                    connectionTimeout: config.connectionTimeout + "ms",
                    logLevel: config.logLevel,
                    tls: (config.tlsCert && config.tlsKey) ? "enabled" : "disabled",
                    wsPrefix: config.connectPath,
                    webui: config.webui
                });
            }
            return config.webui ? await serveDir(req, {
                fsRoot: config.webui,
                showIndex: true
            }) : new Response("Hello, world!");
        }

        if (req.headers.get("upgrade") !== "websocket") {
            return apiServer.handle(req);
        }

        if (!rateLimiter.isAllowed(remoteAddr)) {
            logger.warn(`[${requestId}] Rate limit exceeded`, {
                remoteAddr,
                remaining: 0
            });
            metrics.increment("rate_limit_hits");
            return new Response("Too Many Requests", { status: 429 });
        }

        if (!connMgr.canAccept()) {
            const stats = connMgr.getStats();
            logger.warn(`[${requestId}] Connection rejected - limit reached`, {
                remoteAddr,
                current: stats.active,
                max: stats.max
            });
            metrics.increment("connection_rejections");
            return new Response("Service Unavailable", { status: 503 });
        }

        logger.debug(`[${requestId}] Upgrading to WebSocket...`);

        let socket: WebSocket;
        let response: Response;

        try {
            const upgrade = Deno.upgradeWebSocket(req);
            socket = upgrade.socket;
            response = upgrade.response;
        } catch (err) {
            logger.error(`[${requestId}] WebSocket upgrade failed`, {
                error: getErrMsg(err)
            });
            return new Response("WebSocket upgrade failed", { status: 400 });
        }

        let id: string | undefined;

        const handleOpen = () => {
            socket.removeEventListener("open", handleOpen);

            try {
                if (url.searchParams.has("id")) {
                    const connId = url.searchParams.get("id")!;
                    logger.info(`[${requestId}] Reconnecting client`, {
                        connectionId: connId,
                        remoteAddr
                    });
                    connMgr.reconnect(connId, socket);
                    id = connId;
                } else {
                    logger.info(`[${requestId}] New client connection`, { remoteAddr });
                    const t = new ProxyTransport(logger);
                    connMgr.register(t);
                    t.assign(socket);
                    id = t.clientUUID;
                }

                logger.info(`[${requestId}] WebSocket connection established`, {
                    connectionId: id,
                    remoteAddr,
                    totalConnections: connMgr.getStats().active
                });
                metrics.increment("connections_total");
                metrics.gauge("connections_active", connMgr.getStats().active);
            } catch (err) {
                logger.error(`[${requestId}] Failed to establish connection`, {
                    error: getErrMsg(err),
                    remoteAddr
                });
                socket.close(1011, "Internal server error");
            }
        };

        const handleClose = (e: CloseEvent) => {
            socket.removeEventListener("close", handleClose);
            if (id) {
                logger.info(`[${requestId}] WebSocket connection closed`, {
                    connectionId: id,
                    code: e.code,
                    reason: e.reason || undefined,
                    wasClean: e.wasClean,
                });
                metrics.gauge("connections_active", connMgr.getStats().active);
            }
        };

        const handleError = (err: Event) => {
            socket.removeEventListener("error", handleError);
            logger.error(`[${requestId}] WebSocket error`, {
                connectionId: id,
                error: (err as ErrorEvent).message ?? "Unknown error"
            });
            metrics.increment("connection_errors");
        };

        socket.addEventListener("open", handleOpen);
        socket.addEventListener("close", handleClose);
        socket.addEventListener("error", handleError);

        return response;
    };

    const serveOptions: Deno.ServeTcpOptions & Deno.ServeOptions = {
        hostname: config.hostname,
        port: config.port,
        onListen: (_addr) => {
            const addr = _addr as Deno.NetAddr;
            logger.info("Server listening", {
                address: `${addr.hostname}:${addr.port}`,
                transport: "WebSocket",
                protocol: config.tlsCert ? "wss (encrypted)" : "ws (plain)",
            });
            logger.info("WebUI available at:", {
                url: `http${config.tlsCert ? 's' : ''}://${addr.hostname === '0.0.0.0' ? '127.0.0.1' : addr.hostname}:${addr.port}`
            });
            logger.info("Ready to accept connections...");
        },
    };

    if (config.tlsCert && config.tlsKey) {
        logger.info("Loading TLS certificates...");
        let cert: string;
        let key: string;

        try {
            [cert, key] = await Promise.all([
                Deno.readTextFile(config.tlsCert),
                Deno.readTextFile(config.tlsKey)
            ]);
        } catch (err) {
            logger.error("Failed to load TLS certificates", {
                cert: config.tlsCert,
                key: config.tlsKey,
                error: getErrMsg(err)
            });
            Deno.exit(1);
        }

        logger.info("TLS enabled, starting secure server...");
        Deno.serve({ ...serveOptions, cert, key }, handler);
    } else {
        logger.info("TLS disabled, starting plain server...");
        Deno.serve(serveOptions, handler);
    }

    const shutdown = () => {
        logger.info("");
        logger.info("╔════════════════════════════════════════════════════════════╗");
        logger.info("║          Shutting Down Server                              ║");
        logger.info("╚════════════════════════════════════════════════════════════╝");

        rateLimiter.stopPeriodicCleanup();
        logger.info("Closing all connections...");
        connMgr.close();

        logger.info("Server shutdown complete");
        Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", shutdown);
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            message: "Fatal error",
            error: getErrMsg(err),
            stack: err instanceof Error ? err.stack : undefined,
        }));
        Deno.exit(1);
    });
}
