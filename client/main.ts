import ProxyClient from "../core/client.ts";
import { GeoIPManager } from "./geoip.ts";
import { ProxyDecision } from "./proxy-decision.ts";
import { MixedProxyServer } from "./server.ts";
import { Log } from "@cross/log";
import { parseArgs } from "@std/cli";
import { getErrMsg } from "../utils/error.ts";
import { envNumber, envString } from "../utils/env.ts";

const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

export default async function main() {
    const logger = new Log();
    const args = parseArgs(Deno.args, {
        string: ["remote", "mmdb", "hostname"],
        boolean: ['help'],
        default: {
            remote: envString("CONN_PATH", "ws://localhost:8080"),
            port: envNumber("MIXED_PORT", 7890),
            hostname: envString("MIXED_HOST", "127.0.0.1"),
            mmdb: envString("MMDB", "./Country.mmdb"),
        },
    });

    if (args.help) {
        console.log(`Usage: deno run --allow-net --allow-read --allow-env main.ts [options]

Options:
  --remote <path>  WebSocket server path (default: ${args.remote})
  --mmdb <path>    GeoIP database path (default: ${args.mmdb})
  --hostname <host> Local hostname (default: ${args.hostname})
  --port <port>    Local port (default: ${args.port})
  --help           Show this help message`);
        return;
    }

    logger.info("╔════════════════════════════════════════════════════════════╗");
    logger.info("║          DenoProxy Client Starting                         ║");
    logger.info("╚════════════════════════════════════════════════════════════╝");
    logger.info("Client configuration:", {
        remote: args.remote,
        localHostname: args.hostname,
        localPort: args.port,
        geoipDatabase: args.mmdb,
    });

    // Load GeoIP database
    let geoip: GeoIPManager | null = null;
    try {
        logger.info("Loading GeoIP database...");
        geoip = new GeoIPManager(logger);
        await geoip.init(args.mmdb);
        logger.info(`✓ GeoIP database loaded`, { path: args.mmdb });
    } catch (err) {
        logger.warn(`✗ Failed to load GeoIP database`, { 
            error: getErrMsg(err),
            path: args.mmdb 
        });
        logger.info("  → Continuing without GeoIP (all traffic will be proxied)");
    }

    // Initialize components
    logger.info("Initializing components...");
    const client = new ProxyClient(logger);
    const decision = new ProxyDecision(geoip ?? undefined, logger);
    const mixedServer = new MixedProxyServer(client, decision, logger);
    logger.info("✓ Components initialized");

    // Connection management
    let reconnectTimeout: number | null = null;
    let reconnectAttempts = 0;
    let isShuttingDown = false;
    let ws: WebSocket | null = null;

    const connect = async () => {
        if (isShuttingDown) return;
        
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            logger.error("╔════════════════════════════════════════════════════════════╗");
            logger.error("║          Max Reconnection Attempts Reached                 ║");
            logger.error("╚════════════════════════════════════════════════════════════╝");
            logger.error(`Failed to connect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
            Deno.exit(1);
        }

        try {
            reconnectAttempts++;
            const attempt = `${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`;
            logger.info(`[${attempt}] Connecting to remote server...`, { 
                remote: args.remote 
            });

            ws = new WebSocket(args.remote);
            
            const connectionTimeout = setTimeout(() => {
                ws?.close();
            }, 10000); // 10秒连接超时

            await new Promise<void>((resolve, reject) => {
                const handleOpen = () => {
                    clearTimeout(connectionTimeout);
                    cleanup();
                    resolve();
                };
                
                const handleError = (e: Event) => {
                    cleanup();
                    reject(new Error("WebSocket connection failed"));
                };
                
                const handleClose = (e: CloseEvent) => {
                    cleanup();
                    reject(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
                };

                const cleanup = () => {
                    ws!.removeEventListener("open", handleOpen);
                    ws!.removeEventListener("error", handleError);
                    ws!.removeEventListener("close", handleClose);
                };

                ws!.addEventListener("open", handleOpen);
                ws!.addEventListener("error", handleError);
                ws!.addEventListener("close", handleClose);
            });

            client.assign(ws);
            reconnectAttempts = 0; // Reset on successful connection
            logger.info(`✓ Connected to remote`, { remote: args.remote });

            // Monitor connection for disconnection
            ws.addEventListener("close", (e) => {
                if (!isShuttingDown) {
                    logger.warn("✗ Connection lost", { 
                        code: e.code, 
                        reason: e.reason || undefined,
                        wasClean: e.wasClean 
                    });
                    scheduleReconnect();
                }
            });

            ws.addEventListener("error", (e) => {
                logger.error("WebSocket error", { error: String(e) });
            });

            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }
        } catch (err) {
            logger.warn(`✗ Connection attempt failed`, { 
                error: getErrMsg(err),
                attempt: `${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`
            });
            scheduleReconnect();
        }
    };

    const scheduleReconnect = () => {
        if (isShuttingDown) return;
        if (reconnectTimeout) return; // Already scheduled

        const delay = Math.min(
            INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
            MAX_RECONNECT_DELAY
        );
        
        logger.info(`  → Scheduling reconnection...`, { 
            delay: `${delay}ms`,
            nextAttempt: `${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`
        });

        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connect();
        }, delay);
    };

    // Connect to server
    await connect();

    // Start local proxy server
    logger.info("Starting local proxy server...");
    logger.info(`  - HTTP Proxy:  ${args.hostname}:${args.port}`);
    logger.info(`  - SOCKS5 Proxy: ${args.hostname}:${args.port}`);

    const serverPromise = mixedServer.listen(args.port as number, args.hostname);

    logger.info("Ready to proxy traffic...");

    // Cleanup handler
    const cleanup = () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        logger.info("");
        logger.info("╔════════════════════════════════════════════════════════════╗");
        logger.info("║          Shutting Down Client                              ║");
        logger.info("╚════════════════════════════════════════════════════════════╝");

        if (reconnectTimeout) {
            logger.info("Cancelling scheduled reconnection...");
            clearTimeout(reconnectTimeout);
        }

        if (ws) {
            logger.info("Closing WebSocket connection...");
            try {
                ws.close();
            } catch (err) {
                logger.debug("Error closing WebSocket", { error: getErrMsg(err) });
            }
        }

        logger.info("Stopping proxy server...");
        mixedServer.stop();

        if (geoip) {
            logger.info("Closing GeoIP database...");
            geoip.close();
        }

        logger.info("Closing proxy client...");
        client.close();
        
        decision.destroy();

        logger.info("Client shutdown complete");
        Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", cleanup);

    await serverPromise;
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            message: "Proxy client failed",
            error: getErrMsg(err),
        }));
        Deno.exit(1);
    });
}
