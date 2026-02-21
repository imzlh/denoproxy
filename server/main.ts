import { ConsoleLogger, Log, Severity } from "@cross/log";
import { ProxyTransport } from "../core/transport.ts";
import { ConnectionManager } from "./manager.ts";
import { loadConfig } from "./config.ts";
import { HealthService, MetricsCollector, RateLimiter } from "./middleware.ts";
import { getErrMsg } from "../utils/error.ts";
import { serveDir } from "@std/http/file-server";

// API Server for status and management
class APIServer {
    constructor(
        private connMgr: ConnectionManager,
        private health: HealthService,
        private rateLimiter: RateLimiter,
        private logger: Log
    ) {}

    // Handle API requests via query parameter: ?api=health
    handle(req: Request): Response {
        const url = new URL(req.url);
        const api = url.searchParams.get('api');
        
        if (!api) {
            return new Response("Your request is blocked by guard", { status: 403 });
        }
        
        return this.handleAPI(req, api);
    }

    private handleAPI(req: Request, api: string): Response {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json"
        };

        if (req.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        if (req.method !== "GET") {
            return new Response(JSON.stringify({ error: "Method not allowed" }), { 
                status: 405, 
                headers: corsHeaders 
            });
        }

        try {
            switch (api) {
                case 'health':
                    return new Response(JSON.stringify(this.health.getHealth()), { 
                        headers: corsHeaders 
                    });

                case 'stats':
                    return new Response(JSON.stringify({
                        connections: this.connMgr.getStats(),
                        rateLimiter: this.rateLimiter.getStats(),
                        timestamp: new Date().toISOString()
                    }), { headers: corsHeaders });

                case 'connections':{
                    const conns = this.connMgr.getAllConnections().map(c => ({
                        id: c.id,
                        connectedAt: new Date(c.connectedAt).toISOString(),
                        lastActivity: new Date(c.lastActivity).toISOString(),
                        reconnectCount: c.reconnectCount,
                        duration: Date.now() - c.connectedAt
                    }));
                    return new Response(JSON.stringify({ connections: conns }), { 
                        headers: corsHeaders 
                    });
                }

                default:
                    return new Response(JSON.stringify({ error: "Unknown API endpoint" }), { 
                        status: 404, 
                        headers: corsHeaders 
                    });
            }
        } catch (err) {
            this.logger.error("API error", { error: getErrMsg(err), api });
            return new Response(JSON.stringify({ error: getErrMsg(err) }), { 
                status: 500, 
                headers: corsHeaders 
            });
        }
    }
}

async function main() {
    const config = loadConfig();
    const logger = new Log([
        new ConsoleLogger({
            "minimumSeverity": config.logLevel.toUpperCase() as Severity
        })
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
        wsPrefix: config.connectPath
    });

    const connMgr = new ConnectionManager(
        config.maxConnections,
        config.connectionTimeout,
        logger
    );
    const metrics = new MetricsCollector();
    const health = new HealthService(connMgr, metrics, logger);
    const rateLimiter = new RateLimiter(15, 10000); // 90 req/min

    logger.info("Initializing services...", {
        connectionManager: "ready",
        metricsCollector: "ready",
        healthService: "ready",
        rateLimiter: "90 req/min",
    });

    // Start health logging
    health.startPeriodicLogging();
    rateLimiter.startPeriodicCleanup();

    // Create API Server
    const apiServer = new APIServer(connMgr, health, rateLimiter, logger);

    logger.info("Services started successfully");

    // Main WebSocket server
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

        // Not connect path: 404
        if (url.pathname !== config.connectPath) {
            return config.webui ? await serveDir(req, {
                fsRoot: config.webui,
                showIndex: true
            }) : new Response("Hello, world!");
        }

        // Not WebSocket: API via query parameter (?api=health)
        if (req.headers.get("upgrade") !== "websocket") {
            return apiServer.handle(req);
        }

        // Rate limiting
        if (!rateLimiter.isAllowed(remoteAddr)) {
            logger.warn(`[${requestId}] Rate limit exceeded`, { 
                remoteAddr,
                remaining: 0 
            });
            metrics.increment("rate_limit_hits");
            return new Response("Too Many Requests", { status: 429 });
        }

        // Connection limit
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
                // Don't unregister immediately - transport has a 60s reconnect window.
                // Transport will fire "timeout" or "close" event when truly done.
                // Unregister is handled by transport event listeners in register().
                metrics.gauge("connections_active", connMgr.getStats().active);
            }
        };

        const handleError = (err: Event) => {
            socket.removeEventListener("error", handleError);
            logger.error(`[${requestId}] WebSocket error`, {
                connectionId: id,
                // @ts-ignore ErrorEvent
                error: err.message ?? "Unknown error"
            });
            metrics.increment("connection_errors");
            // Don't unregister here - transport's onClose will fire and handle reconnect window
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
            logger.info("Ready to accept connections...");
        },
    };

    // Add TLS if configured
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

    // Graceful shutdown
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
