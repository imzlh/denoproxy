export class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
        private readonly capacity: number,
        private readonly refillRate: number,
        private readonly refillInterval: number = 1000
    ) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    consume(tokens: number = 1): boolean {
        this.refill();

        if (this.tokens >= tokens) {
            this.tokens -= tokens;
            return true;
        }

        return false;
    }

    async consumeOrWait(tokens: number = 1, maxWait: number = 5000): Promise<boolean> {
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
            if (this.consume(tokens)) {
                return true;
            }

            const tokensNeeded = tokens - this.tokens;
            const waitTime = Math.min(
                (tokensNeeded / this.refillRate) * 1000,
                100
            );

            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        return false;
    }

    getAvailableTokens(): number {
        this.refill();
        return this.tokens;
    }

    reset(): void {
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;

        if (elapsed >= this.refillInterval) {
            const tokensToAdd = Math.floor(
                (elapsed / this.refillInterval) * this.refillRate
            );
            this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
            this.lastRefill = now;
        }
    }
}

export class DistributedTokenBucket {
    private buckets = new Map<string, { bucket: TokenBucket; lastUsed: number }>();
    private cleanupInterval?: number;

    constructor(
        private readonly capacity: number,
        private readonly refillRate: number,
        private readonly refillInterval: number = 1000,
        private readonly maxBuckets: number = 10000
    ) {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 60000);
    }

    consume(identifier: string, tokens: number = 1): boolean {
        let entry = this.buckets.get(identifier);
        if (!entry) {
            if (this.buckets.size >= this.maxBuckets) {
                this.cleanup();
                if (this.buckets.size >= this.maxBuckets) {
                    return false;
                }
            }
            entry = {
                bucket: new TokenBucket(this.capacity, this.refillRate, this.refillInterval),
                lastUsed: Date.now()
            };
            this.buckets.set(identifier, entry);
        }

        entry.lastUsed = Date.now();
        return entry.bucket.consume(tokens);
    }

    getAvailableTokens(identifier: string): number {
        const entry = this.buckets.get(identifier);
        return entry ? entry.bucket.getAvailableTokens() : this.capacity;
    }

    getStats(): {
        totalBuckets: number;
        maxBuckets: number;
    } {
        return {
            totalBuckets: this.buckets.size,
            maxBuckets: this.maxBuckets
        };
    }

    cleanup(): void {
        const now = Date.now();
        const inactiveThreshold = 300000;
        const maxToDelete = Math.floor(this.buckets.size * 0.3);

        if (this.buckets.size > this.maxBuckets / 2) {
            const entries = [...this.buckets.entries()];
            
            entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
            
            let deleted = 0;
            for (const [key, entry] of entries) {
                if (deleted >= maxToDelete) break;
                
                if (now - entry.lastUsed > inactiveThreshold || deleted < Math.floor(this.buckets.size * 0.1)) {
                    this.buckets.delete(key);
                    deleted++;
                }
            }
        }
    }

    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.buckets.clear();
    }
}
