import { Severity } from "@cross/log";

export type LogEntry = {
    timestamp: string;
    level: Severity;
    message: string;
    data?: Record<string, unknown>;
};

type ClientInfo = {
    controller: ReadableStreamDefaultController<Uint8Array>;
    minLevel: Severity;
};

// 日志级别优先级
const severityLevels: Record<string, number> = {
    "DEBUG": 0,
    "INFO": 1,
    "WARN": 2,
    "ERROR": 3
};

export class SSELogger {
    private clients = new Map<ReadableStreamDefaultController<Uint8Array>, ClientInfo>();
    private logs: LogEntry[] = [];
    private maxLogs = 1000;

    addClient(controller: ReadableStreamDefaultController<Uint8Array>, minLevel: Severity = Severity.Debug) {
        this.clients.set(controller, { controller, minLevel });
        
        // 发送最近的50条符合条件的日志给新客户端
        const recentLogs = this.logs
            .filter(log => this.shouldSend(log.level, minLevel))
            .slice(-50);
        
        for (const log of recentLogs) {
            this.sendToClient(controller, log);
        }
    }

    removeClient(controller: ReadableStreamDefaultController<Uint8Array>) {
        this.clients.delete(controller);
    }

    log(level: Severity, message: string, data?: Record<string, unknown>) {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // 广播给所有符合条件的客户端
        for (const [controller, info] of this.clients) {
            if (this.shouldSend(level, info.minLevel)) {
                this.sendToClient(controller, entry);
            }
        }
    }

    private shouldSend(level: Severity, minLevel: Severity): boolean {
        return (severityLevels[level] ?? 1) >= (severityLevels[minLevel] ?? 1);
    }

    private sendToClient(
        controller: ReadableStreamDefaultController<Uint8Array>,
        entry: LogEntry
    ) {
        try {
            const data = `data: ${JSON.stringify(entry)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));
        } catch {
            // 客户端已断开
            this.clients.delete(controller);
        }
    }

    getLogs(count = 100, minLevel: Severity = Severity.Debug): LogEntry[] {
        return this.logs
            .filter(log => this.shouldSend(log.level, minLevel))
            .slice(-count);
    }
}

// 全局 SSE Logger 实例
export const sseLogger = new SSELogger();
