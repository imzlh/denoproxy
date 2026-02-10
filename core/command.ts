import { Log } from "@cross/log";
import { getErrMsg } from "../utils/error.ts";

export interface CommandResponse {
    success: boolean;
    message: string;
    data?: unknown;
}

export class CommandHandler {
    private commands = new Map<string, (args: string[]) => CommandResponse>();

    constructor(
        private sendText: (text: string) => void,
        private logger?: Log,
        private isServer = false
    ) {
        this.registerDefaultCommands();
    }

    private registerDefaultCommands() {
        // SET commands - 用于设置配置或状态
        this.commands.set("SET", (args) => {
            if (args.length === 0) {
                return { success: false, message: "SET requires arguments" };
            }

            const key = args[0].toUpperCase();
            const value = args.slice(1).join(" ");

            switch (key) {
                case "UUID":
                    // UUID is handled at connection level, just acknowledge
                    return { success: true, message: `UUID set to: ${value}` };

                case "LOGLEVEL":
                    if (this.isServer) {
                        // Server could change log level dynamically
                        return { success: true, message: `Log level would be set to: ${value}` };
                    }
                    return { success: false, message: "Cannot set log level on client" };

                default:
                    return { success: false, message: `Unknown SET parameter: ${key}` };
            }
        });

        // GET commands - 用于获取状态或配置
        this.commands.set("GET", (args) => {
            if (args.length === 0) {
                return { success: false, message: "GET requires arguments" };
            }

            const key = args[0].toUpperCase();

            switch (key) {
                case "STATUS":
                    return { success: true, message: "STATUS: OK", data: { status: "connected" } };

                case "INFO":
                    return {
                        success: true,
                        message: "INFO",
                        data: {
                            type: this.isServer ? "server" : "client",
                            timestamp: new Date().toISOString(),
                            uptime: Math.floor(performance.now() / 1000) + "s"
                        }
                    };

                case "VERSION":
                    return {
                        success: true,
                        message: "VERSION",
                        data: {
                            version: "1.0.0",
                            protocol: "1.0"
                        }
                    };

                default:
                    return { success: false, message: `Unknown GET parameter: ${key}` };
            }
        });

        // PING/PONG commands - 用于心跳检测
        this.commands.set("PING", () => {
            return { success: true, message: "PONG", data: { timestamp: Date.now() } };
        });

        this.commands.set("PONG", () => {
            // Client responding to server ping
            return { success: true, message: "PONG received" };
        });

        // STATS command - 获取统计信息
        this.commands.set("STATS", () => {
            const memory = Deno.memoryUsage();
            return {
                success: true,
                message: "STATS",
                data: {
                    memory: {
                        rss: Math.floor(memory.rss / 1024 / 1024) + " MB",
                        heapTotal: Math.floor(memory.heapTotal / 1024 / 1024) + " MB",
                        heapUsed: Math.floor(memory.heapUsed / 1024 / 1024) + " MB",
                        heapUnused: Math.floor((memory.heapTotal - memory.heapUsed) / 1024 / 1024) + " MB",
                        external: Math.floor(memory.external / 1024 / 1024) + " MB",
                    },
                    uptime: Math.floor(performance.now() / 1000) + "s"
                }
            };
        });

        // HELP command - 显示帮助信息
        this.commands.set("HELP", () => {
            const helpText = this.isServer ? 
`Available commands (Server):
  SET UUID <uuid>      - Set client UUID
  SET LOGLEVEL <level> - Set log level (debug/info/warn/error)
  GET STATUS          - Get connection status
  GET INFO            - Get server information
  GET VERSION         - Get version information
  STATS               - Get statistics
  PING                - Ping test
  HELP                - Show this help` : 
`Available commands (Client):
  SET UUID <uuid>     - Set client UUID
  GET STATUS          - Get connection status
  GET INFO            - Get client information
  GET VERSION         - Get version information
  STATS               - Get statistics
  PING                - Ping test
  PONG                - Respond to ping
  HELP                - Show this help`;
            return { success: true, message: "HELP", data: { help: helpText } };
        });
    }

    handleCommand(text: string): boolean {
        const trimmed = text.trim();

        // 支持多种命令格式: /CMD, CMD, SET ...
        let cmdText = trimmed;
        if (trimmed.startsWith("/")) {
            cmdText = trimmed.slice(1);
        } else if (trimmed.startsWith("CMD ")) {
            cmdText = trimmed.slice(4);
        }

        const parts = cmdText.split(/\s+/);
        const command = parts[0]?.toUpperCase();
        const args = parts.slice(1);

        if (!command) {
            return false;
        }

        const handler = this.commands.get(command);
        if (handler) {
            try {
                const response = handler(args);
                this.sendResponse(response);
                this.logger?.debug(`Command executed: ${command}`, { success: response.success });
            } catch (err) {
                const errorResponse: CommandResponse = {
                    success: false,
                    message: `Command error: ${getErrMsg(err)}`
                };
                this.sendResponse(errorResponse);
                this.logger?.error(`Command error: ${command}`, { error: getErrMsg(err) });
            }
            return true;
        }

        // Unknown command
        const errorResponse: CommandResponse = {
            success: false,
            message: `Unknown command: ${command}. Type HELP for available commands.`
        };
        this.sendResponse(errorResponse);
        return true;
    }

    private sendResponse(response: CommandResponse) {
        try {
            const responseData = JSON.stringify({
                success: response.success,
                message: response.message,
                data: response.data
            });
            // 通过文本帧发送，不是二进制帧
            this.sendText(responseData);
        } catch (err) {
            this.logger?.error("Failed to send command response", { error: getErrMsg(err) });
        }
    }

    registerCommand(name: string, handler: (args: string[]) => CommandResponse) {
        this.commands.set(name.toUpperCase(), handler);
    }

    /**
     * 创建命令字符串
     */
    static createCommand(command: string, ...args: string[]): string {
        return `${command} ${args.join(" ")}`.trim();
    }

    /**
     * 解析命令响应
     */
    static parseResponse(text: string): CommandResponse | null {
        try {
            return JSON.parse(text) as CommandResponse;
        } catch {
            return null;
        }
    }
}
