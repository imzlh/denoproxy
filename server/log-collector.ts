import { Log, Logger, Severity } from "@cross/log";

export type LogEntry = {
    timestamp: string;
    level: string;
    message: string;
    data?: unknown;
};

type LogListener = (entry: LogEntry) => void;

export class LogCollector implements Logger {
    private listeners = new Set<LogListener>();
    private logs: LogEntry[] = [];
    private maxLogs = 1000;

    addListener(listener: LogListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private pushLog(entry: LogEntry) {
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        this.listeners.forEach(l => l(entry));
    }

    getRecentLogs(count = 100): LogEntry[] {
        return this.logs.slice(-count);
    }

    emergency(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "EMERGENCY", message: msg, data });
    }

    alert(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "ALERT", message: msg, data });
    }

    critical(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "CRITICAL", message: msg, data });
    }

    error(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "ERROR", message: msg, data });
    }

    warning(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "WARNING", message: msg, data });
    }

    notice(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "NOTICE", message: msg, data });
    }

    info(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "INFO", message: msg, data });
    }

    debug(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "DEBUG", message: msg, data });
    }

    trace(msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: "TRACE", message: msg, data });
    }

    log(severity: Severity, msg: string, data?: unknown) {
        this.pushLog({ timestamp: new Date().toISOString(), level: severity, message: msg, data });
    }
}

// 全局日志收集器实例
export const globalLogCollector = new LogCollector();
