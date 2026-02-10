import { decode, encode } from "../../utils/bjson.ts";
import { getErrMsg } from "../../utils/error.ts";
import { HTTPResponse, MessageType } from "../protocol.ts";
import { Log } from "@cross/log";

const FETCH_TIMEOUT = 30000; // 30秒请求超时
const MAX_BODY_CHUNK_SIZE = 65536; // 64KB

interface SerializedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
}

export class HTTPProxy {
    private requests = new Map<number, AbortController>();
    private bodyControllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>();

    constructor(
        private sendMessage: (type: MessageType, id: number, data: Uint8Array) => void,
        private logger?: Log
    ) { }

    async handleRequest(resourceId: number, data: Uint8Array) {
        let controller: AbortController | null = null;
        
        try {
            const req: SerializedRequest = decode(data);
            
            // 验证请求
            if (!req.url || !req.method) {
                throw new Error("Invalid request: missing URL or method");
            }

            controller = new AbortController();
            this.requests.set(resourceId, controller);

            const headers = new Headers(req.headers);
            const hasBody = headers.get("content-length") || headers.get("transfer-encoding");

            this.logger?.debug("HTTP request", {
                resourceId: resourceId.toString(),
                method: req.method,
                url: req.url
            });

            // 设置请求超时
            const timeoutId = setTimeout(() => {
                controller?.abort(new Error("Request timeout"));
            }, FETCH_TIMEOUT);

            const response = await fetch(req.url, {
                method: req.method,
                headers,
                body: hasBody ? this.createBodyStream(resourceId) : undefined,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            this.logger?.debug("HTTP response", {
                resourceId: resourceId.toString(),
                status: response.status,
                statusText: response.statusText
            });

            await this.sendResponse(resourceId, response);
        } catch (err) {
            const errorMsg = getErrMsg(err);
            this.logger?.error("HTTP request failed", {
                resourceId: resourceId.toString(),
                error: errorMsg
            });
            this.sendError(resourceId, errorMsg);
            this.requests.delete(resourceId);
        }
    }

    handleBodyChunk(resourceId: number, data: Uint8Array) {
        const controller = this.bodyControllers.get(resourceId);
        if (!controller) {
            this.logger?.warn("HTTP body chunk for unknown request", {
                resourceId: resourceId.toString()
            });
            return;
        }

        try {
            // 如果 chunk 太大，可能需要分片处理
            if (data.length > MAX_BODY_CHUNK_SIZE) {
                this.logger?.debug("Large body chunk received", {
                    resourceId: resourceId.toString(),
                    size: data.length
                });
            }
            controller.enqueue(data);
        } catch (err) {
            this.logger?.debug("HTTP body enqueue failed", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
    }

    handleBodyEnd(resourceId: number) {
        const controller = this.bodyControllers.get(resourceId);
        if (!controller) return;

        try {
            controller.close();
        } catch (err) {
            this.logger?.debug("HTTP body close failed", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
        this.bodyControllers.delete(resourceId);
    }

    abort(resourceId: number) {
        const controller = this.requests.get(resourceId);
        if (controller) {
            this.logger?.debug("Aborting HTTP request", {
                resourceId: resourceId.toString()
            });
            controller.abort();
            this.requests.delete(resourceId);
        }
        this.bodyControllers.delete(resourceId);
    }

    private createBodyStream(resourceId: number): ReadableStream<Uint8Array> {
        return new ReadableStream({
            start: (controller) => {
                this.bodyControllers.set(resourceId, controller);
            },
            cancel: (reason) => {
                this.logger?.debug("HTTP body stream cancelled", {
                    resourceId: resourceId.toString(),
                    reason: String(reason)
                });
                this.bodyControllers.delete(resourceId);
            },
        });
    }

    private clone(response: Response): HTTPResponse {
        return {
            headers: Object.fromEntries(response.headers.entries()),
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            body: !!response.body
        };
    }

    private async sendResponse(resourceId: number, response: Response) {
        try {
            this.sendMessage(
                MessageType.HTTP_RESPONSE,
                resourceId,
                encode(this.clone(response))
            );

            if (response.body) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        this.sendMessage(MessageType.HTTP_BODY_CHUNK, resourceId, value);
                    }
                } finally {
                    reader.releaseLock();
                    this.sendMessage(MessageType.HTTP_BODY_END, resourceId, new Uint8Array(0));
                    this.requests.delete(resourceId);
                }
            } else {
                this.sendMessage(MessageType.HTTP_BODY_END, resourceId, new Uint8Array(0));
                this.requests.delete(resourceId);
            }
        } catch (err) {
            this.logger?.error("Failed to send HTTP response", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
            this.sendError(resourceId, getErrMsg(err));
            this.requests.delete(resourceId);
        }
    }

    private sendError(resourceId: number, message: string) {
        try {
            const data = new TextEncoder().encode(message);
            this.sendMessage(MessageType.ERROR, resourceId, data);
        } catch (err) {
            this.logger?.error("Failed to send HTTP error", {
                resourceId: resourceId.toString(),
                error: getErrMsg(err)
            });
        }
    }

    abortAll() {
        const count = this.requests.size;
        if (count === 0) return;

        this.logger?.info("Aborting all HTTP requests", { count });
        
        const ids = [...this.requests.keys()];
        for (const id of ids) {
            this.abort(id);
        }
        
        // 清理所有 body controllers
        for (const [id, controller] of this.bodyControllers) {
            try {
                controller.error(new Error("Proxy aborted"));
            } catch { /* ignore */ }
        }
        this.bodyControllers.clear();
    }
}
