// deno-lint-ignore no-explicit-any
export function getErrMsg(e: any): string {
    if (e instanceof Error) {
        return e.message;
    }
    if (typeof e === 'string') {
        return e;
    }
    if (e === null || e === undefined) {
        return 'Unknown error';
    }
    try {
        return String(e);
    } catch {
        return 'Unknown error';
    }
}

// deno-lint-ignore no-explicit-any
export function getErrStack(e: any): string | undefined {
    if (e instanceof Error) {
        return e.stack;
    }
    return undefined;
}

/**
 * 带上下文的错误包装
 */
export class ContextualError extends Error {
    constructor(
        message: string,
        public readonly context: Record<string, unknown>
    ) {
        super(message);
        this.name = 'ContextualError';
    }
}
