/**
 * 自适应心跳管理器
 * 根据网络RTT动态调整心跳间隔
 */
export class AdaptiveHeartbeat {
    private rttHistory: number[] = [];
    private readonly historySize: number;
    private readonly minInterval: number;
    private readonly maxInterval: number;
    private readonly baseTimeout: number;
    
    private currentInterval: number;
    private lastSendTime = 0;
    private lastReceiveTime = 0;
    private missedHeartbeats = 0;
    private readonly maxMissedHeartbeats: number;

    constructor(options: {
        minInterval?: number;
        maxInterval?: number;
        baseTimeout?: number;
        historySize?: number;
        maxMissedHeartbeats?: number;
    } = {}) {
        this.minInterval = options.minInterval ?? 10000; // 最小10秒
        this.maxInterval = options.maxInterval ?? 60000; // 最大60秒
        this.baseTimeout = options.baseTimeout ?? 30000; // 基础超时30秒
        this.historySize = options.historySize ?? 10;
        this.maxMissedHeartbeats = options.maxMissedHeartbeats ?? 3;
        
        this.currentInterval = this.minInterval;
    }

    /**
     * 记录发送心跳
     */
    recordSend(): void {
        this.lastSendTime = Date.now();
    }

    /**
     * 记录收到心跳响应
     */
    recordReceive(): void {
        this.lastReceiveTime = Date.now();
        
        if (this.lastSendTime > 0) {
            const rtt = this.lastReceiveTime - this.lastSendTime;
            this.addRTT(rtt);
            this.missedHeartbeats = 0;
            this.adjustInterval();
        }
    }

    /**
     * 使用外部计算的RTT值记录心跳响应
     */
    recordReceiveWithRTT(rtt: number): void {
        this.lastReceiveTime = Date.now();
        this.addRTT(rtt);
        this.missedHeartbeats = 0;
        this.adjustInterval();
    }

    /**
     * 记录心跳超时
     */
    recordTimeout(): void {
        this.missedHeartbeats++;
        
        // 超时时降低心跳间隔
        this.currentInterval = Math.max(
            this.minInterval,
            this.currentInterval * 0.5
        );
    }

    /**
     * 检查是否应该发送心跳
     */
    shouldSendHeartbeat(): boolean {
        const now = Date.now();
        return now - this.lastSendTime >= this.currentInterval;
    }

    /**
     * 检查连接是否超时
     */
    isTimeout(): boolean {
        return this.missedHeartbeats >= this.maxMissedHeartbeats;
    }

    /**
     * 获取当前心跳间隔
     */
    getInterval(): number {
        return this.currentInterval;
    }

    /**
     * 获取超时时间
     */
    getTimeout(): number {
        const avgRTT = this.getAverageRTT();
        // 超时时间 = 基础超时 + 3倍平均RTT
        return this.baseTimeout + avgRTT * 3;
    }

    /**
     * 获取统计信息
     */
    getStats(): {
        currentInterval: number;
        averageRTT: number;
        missedHeartbeats: number;
        rttHistory: number[];
    } {
        return {
            currentInterval: this.currentInterval,
            averageRTT: this.getAverageRTT(),
            missedHeartbeats: this.missedHeartbeats,
            rttHistory: [...this.rttHistory]
        };
    }

    /**
     * 重置状态
     */
    reset(): void {
        this.rttHistory = [];
        this.currentInterval = this.minInterval;
        this.lastSendTime = 0;
        this.lastReceiveTime = 0;
        this.missedHeartbeats = 0;
    }

    private addRTT(rtt: number): void {
        this.rttHistory.push(rtt);
        if (this.rttHistory.length > this.historySize) {
            this.rttHistory.shift();
        }
    }

    private getAverageRTT(): number {
        if (this.rttHistory.length === 0) return 0;
        return this.rttHistory.reduce((a, b) => a + b, 0) / this.rttHistory.length;
    }

    private adjustInterval(): void {
        const avgRTT = this.getAverageRTT();
        
        // 添加最小 RTT 阈值，避免 RTT 为 0 时过于频繁心跳
        const minRTTThreshold = 100; // 最小 100ms
        
        if (avgRTT < minRTTThreshold && avgRTT > 0) {
            this.currentInterval = this.minInterval;
            return;
        }
        
        if (avgRTT === 0) {
            // 没有 RTT 数据时使用最大间隔，减少无效心跳
            this.currentInterval = this.maxInterval;
            return;
        }

        // 心跳间隔 = 平均RTT * 3，但限制在范围内
        // 网络越好，心跳间隔越大
        const newInterval = Math.min(
            this.maxInterval,
            Math.max(this.minInterval, avgRTT * 3)
        );

        // 平滑调整
        this.currentInterval = this.currentInterval * 0.7 + newInterval * 0.3;
    }
}

/**
 * 心跳序列号管理
 * 用于检测丢包和乱序
 */
export class HeartbeatSequence {
    private sendSeq = 0;
    private expectedSeq = 0;
    private pendingAcks = new Map<number, number>(); // seq -> sendTime

    /**
     * 获取下一个发送序列号
     */
    nextSeq(): number {
        const seq = this.sendSeq++;
        // 防止溢出
        if (this.sendSeq >= 0xFFFFFFFF) {
            this.sendSeq = 0;
        }
        return seq;
    }

    /**
     * 记录发送
     */
    recordSend(seq: number): void {
        this.pendingAcks.set(seq, Date.now());
        
        // 清理过期的pending acks（超过30秒）
        const now = Date.now();
        for (const [s, time] of this.pendingAcks) {
            if (now - time > 30000) {
                this.pendingAcks.delete(s);
            }
        }
    }

    /**
     * 记录收到ACK
     */
    recordAck(seq: number): number | null {
        const sendTime = this.pendingAcks.get(seq);
        if (sendTime !== undefined) {
            this.pendingAcks.delete(seq);
            return Date.now() - sendTime;
        }
        return null;
    }

    /**
     * 检查序列号是否有效
     */
    isValidSeq(seq: number): boolean {
        // 允许一定范围的乱序
        const diff = Math.abs(seq - this.expectedSeq);
        if (diff < 1000) {
            this.expectedSeq = seq + 1;
            return true;
        }
        return false;
    }

    /**
     * 获取待确认数量
     */
    getPendingCount(): number {
        return this.pendingAcks.size;
    }

    /**
     * 重置
     */
    reset(): void {
        this.sendSeq = 0;
        this.expectedSeq = 0;
        this.pendingAcks.clear();
    }
}
