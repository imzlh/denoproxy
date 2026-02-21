import { ProxyTransport } from "../core/transport.ts";
import { Log } from "@cross/log";
import { getErrMsg } from "../utils/error.ts";

type ConnectionInfo = {
    id: string;
    connectedAt: number;
    transport: ProxyTransport;
    lastActivity: number;
    reconnectCount: number;
};

export class ConnectionManager {
    private connections = new Map<string, ConnectionInfo>();
    private cleanupInterval?: number;
    private readonly cleanupIntervalMs = 30000; // 30秒清理一次
    private readonly maxConnections: number;
    private readonly timeout: number;

    constructor(
        maxConnections: number,
        timeout: number,
        private logger: Log
    ) {
        this.maxConnections = maxConnections;
        this.timeout = timeout;
        this.startCleanup();
    }

    canAccept(): boolean {
        return this.connections.size < this.maxConnections;
    }

    register(transport: ProxyTransport): void {
        const id = transport.clientUUID;
        if (!this.canAccept()) {
            this.logger.warn("Connection limit reached", {
                current: this.connections.size,
                max: this.maxConnections
            });
            throw new Error("Connection limit reached");
        }

        if (this.connections.has(id)) {
            this.logger.warn("Connection already registered", { connectionId: id });
            throw new Error(`Connection ${id} already registered`);
        }

        this.connections.set(id, {
            id,
            connectedAt: Date.now(),
            transport,
            lastActivity: Date.now(),
            reconnectCount: 0
        });

        this.logger.debug("Connection registered", {
            connectionId: id,
            total: this.connections.size,
            max: this.maxConnections
        });

        // Auto-unregister when transport is fully closed or reconnect times out
        transport.addEventListener("timeout", () => {
            this.logger.info("Transport reconnect timed out, unregistering", { connectionId: id });
            this.unregister(id);
        });
        transport.addEventListener("close", () => {
            if (this.connections.has(id)) {
                this.logger.debug("Transport closed, unregistering", { connectionId: id });
                this.connections.delete(id); // don't call unregister (would double-close)
            }
        });
        transport.addEventListener("disconnect", () => {
            this.updateActivity(id);
        });
    }

    reconnect(id: string, ws: WebSocket) {
        const conn = this.connections.get(id);
        if (!conn) {
            this.logger.error("Reconnect failed: connection not found", { connectionId: id });
            throw new Error(`Connection ${id} not found`);
        }

        conn.reconnectCount++;
        conn.transport.assign(ws);
        conn.lastActivity = Date.now();

        this.logger.debug("Connection reconnected", {
            connectionId: id,
            reconnectCount: conn.reconnectCount
        });
    }

    unregister(id: string) {
        const conn = this.connections.get(id);
        if (!conn) return;

        this.logger.debug("Unregistering connection", {
            connectionId: id,
            duration: Date.now() - conn.connectedAt,
            reconnectCount: conn.reconnectCount
        });

        try {
            conn.transport.close();
        } catch (err) {
            this.logger.debug("Error closing transport", {
                connectionId: id,
                error: getErrMsg(err)
            });
        }
        
        this.connections.delete(id);

        this.logger.debug("Connection unregistered", {
            connectionId: id,
            remaining: this.connections.size
        });
    }

    get(id: string): ConnectionInfo | undefined {
        return this.connections.get(id);
    }

    updateActivity(id: string) {
        const conn = this.connections.get(id);
        if (conn) {
            conn.lastActivity = Date.now();
        }
    }

    getStats() {
        const now = Date.now();
        let totalUptime = 0;
        let totalReconnects = 0;

        for (const conn of this.connections.values()) {
            totalUptime += now - conn.connectedAt;
            totalReconnects += conn.reconnectCount;
        }

        return {
            active: this.connections.size,
            max: this.maxConnections,
            utilization: (this.connections.size / this.maxConnections * 100).toFixed(1) + "%",
            averageUptime: this.connections.size > 0 ? Math.floor(totalUptime / this.connections.size / 1000) + "s" : "0s",
            totalReconnects
        };
    }

    getAllConnections(): ConnectionInfo[] {
        return Array.from(this.connections.values());
    }

    private startCleanup() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.cleanupIntervalMs);
    }
    
    private cleanup() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [id, conn] of this.connections) {
            if (now - conn.lastActivity > this.timeout) {
                this.logger.info("Connection timeout", {
                    connectionId: id,
                    idle: Math.floor((now - conn.lastActivity) / 1000) + "s"
                });
                this.unregister(id);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            this.logger.debug("Connection cleanup complete", { 
                cleaned, 
                remaining: this.connections.size 
            });
        }
    }

    close() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        this.logger.info("Closing all connections", { count: this.connections.size });
        
        // 复制 keys 避免在迭代过程中修改
        const ids = [...this.connections.keys()];
        for (const id of ids) {
            this.unregister(id);
        }
    }
}
