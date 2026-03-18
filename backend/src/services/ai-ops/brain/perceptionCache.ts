/**
 * PerceptionCache — 感知缓存层
 *
 * 将 gatherContext() 的 6 个感知源从"每次 tick 实时拉取"改为"后台守护进程定期预热"，
 * 使 schedule Tick 的 OBSERVE 阶段从 ~5s 降至 <100ms。
 *
 * 设计原则：
 * - 内存后端（默认）：Map<string, CacheEntry>，单实例部署
 * - Redis 后端（可选）：通过 PERCEPTION_CACHE_BACKEND=redis 切换，多实例部署
 * - 回退策略：缓存不新鲜 → 回退到实时采集；critical_alert → 强制实时采集
 * - 守护进程崩溃自动重启（最多 3 次），超过后停止并记录告警
 */

import { EventEmitter } from 'events';
import { logger } from '../../../utils/logger';

// ====================================================================
// 类型定义
// ====================================================================

export interface CacheEntry<T = unknown> {
    data: T;
    lastUpdated: number;           // Unix timestamp ms
    source: string;                // 感知源标识
    freshnessThresholdMs: number;  // 新鲜度阈值（ms）
}

export interface PerceptionCacheConfig {
    backend: 'memory' | 'redis';
    defaultPollingIntervalMs: number;    // 守护进程轮询间隔，默认 30000
    defaultFreshnessThresholdMs: number; // 缓存新鲜度阈值，默认 60000
    redisUrl?: string;                   // Redis 连接 URL（backend=redis 时必填）
}

export interface PerceptionCacheEvents {
    'cache:updated': { source: string; timestamp: number };
    'cache:stale': { source: string; age: number };
}

/** 感知源采集函数类型 */
export type PerceptionCollector<T = unknown> = () => Promise<T>;

/** 已注册的感知源 */
interface RegisteredSource<T = unknown> {
    source: string;
    collector: PerceptionCollector<T>;
    freshnessThresholdMs: number;
}

// ====================================================================
// PerceptionCache 类
// ====================================================================

export class PerceptionCache extends EventEmitter {
    private readonly config: PerceptionCacheConfig;
    /** 内存后端存储 */
    private readonly memoryStore = new Map<string, CacheEntry>();
    /** 已注册的感知源列表 */
    private readonly sources: RegisteredSource[] = [];
    /** 守护进程定时器句柄 */
    private daemonTimer: NodeJS.Timeout | null = null;
    /** 守护进程崩溃重启计数 */
    private daemonRestartCount = 0;
    private readonly MAX_DAEMON_RESTARTS = 3;
    /** 守护进程是否正在运行 */
    private isDaemonRunning = false;

    constructor(config: Partial<PerceptionCacheConfig> = {}) {
        super();
        this.config = {
            backend: config.backend ?? 'memory',
            defaultPollingIntervalMs: config.defaultPollingIntervalMs ?? 30_000,
            defaultFreshnessThresholdMs: config.defaultFreshnessThresholdMs ?? 60_000,
            redisUrl: config.redisUrl,
        };
        // 允许多个监听器（SSE 客户端等）
        this.setMaxListeners(50);
    }

    // ====================================================================
    // 核心 API
    // ====================================================================

    /**
     * 读取缓存条目
     * @returns CacheEntry 或 null（未命中）
     */
    get<T>(source: string): CacheEntry<T> | null {
        const entry = this.memoryStore.get(source);
        if (!entry) return null;
        return entry as CacheEntry<T>;
    }

    /**
     * 写入缓存条目，并发射 cache:updated 事件
     */
    set<T>(source: string, data: T, freshnessThresholdMs?: number): void {
        const threshold = freshnessThresholdMs ?? this.config.defaultFreshnessThresholdMs;
        const entry: CacheEntry<T> = {
            data,
            lastUpdated: Date.now(),
            source,
            freshnessThresholdMs: threshold,
        };
        this.memoryStore.set(source, entry as CacheEntry);
        this.emit('cache:updated', { source, timestamp: entry.lastUpdated });
    }

    /**
     * 判断缓存是否新鲜
     * 新鲜条件：(Date.now() - lastUpdated) <= freshnessThresholdMs
     */
    isFresh(source: string): boolean {
        const entry = this.memoryStore.get(source);
        if (!entry) return false;
        const age = Date.now() - entry.lastUpdated;
        const fresh = age <= entry.freshnessThresholdMs;
        if (!fresh) {
            this.emit('cache:stale', { source, age });
        }
        return fresh;
    }

    /**
     * 注册感知源（供守护进程轮询）
     */
    registerSource<T>(
        source: string,
        collector: PerceptionCollector<T>,
        freshnessThresholdMs?: number,
    ): void {
        // 避免重复注册
        const existing = this.sources.findIndex(s => s.source === source);
        const entry: RegisteredSource<T> = {
            source,
            collector,
            freshnessThresholdMs: freshnessThresholdMs ?? this.config.defaultFreshnessThresholdMs,
        };
        if (existing >= 0) {
            this.sources[existing] = entry as RegisteredSource;
        } else {
            this.sources.push(entry as RegisteredSource);
        }
    }

    // ====================================================================
    // 守护进程
    // ====================================================================

    /**
     * 启动后台守护进程，以 defaultPollingIntervalMs 间隔轮询所有已注册感知源
     */
    startDaemon(): void {
        if (this.isDaemonRunning) {
            logger.warn('[PerceptionCache] Daemon already running, skipping startDaemon().');
            return;
        }
        this.isDaemonRunning = true;
        this.daemonRestartCount = 0;
        logger.info(`[PerceptionCache] Daemon started (interval: ${this.config.defaultPollingIntervalMs}ms, sources: ${this.sources.length})`);
        this._scheduleDaemonTick();
    }

    /**
     * 停止后台守护进程
     */
    stopDaemon(): void {
        if (this.daemonTimer) {
            clearTimeout(this.daemonTimer);
            this.daemonTimer = null;
        }
        this.isDaemonRunning = false;
        logger.info('[PerceptionCache] Daemon stopped.');
    }

    /**
     * 手动触发一次全量采集（用于测试或强制刷新）
     */
    async pollOnce(): Promise<void> {
        await this._runPollCycle();
    }

    // ====================================================================
    // 内部实现
    // ====================================================================

    private daemonFailCount = 0;

    private _scheduleDaemonTick(): void {
        if (!this.isDaemonRunning) return;

        // 🟢 FIX (Gemini audit): 指数退避策略
        // 失败次数越多，重试间隔越长，防止在持续故障期间浪费系统资源
        // 0-1次失败: 使用默认间隔 (30s)
        // 2次失败: 60s
        // 3次失败: 4min
        // ... 最大 30 分钟
        const baseInterval = this.config.defaultPollingIntervalMs;
        let delay = baseInterval;
        if (this.daemonFailCount >= 2) {
            const factor = Math.pow(2, this.daemonFailCount - 1);
            delay = Math.min(baseInterval * factor, 30 * 60 * 1000); // Capped at 30 minutes
        }

        this.daemonTimer = setTimeout(async () => {
            try {
                await this._runPollCycle();
                this.daemonFailCount = 0; // 成功后重置失败计数
            } catch (err) {
                this.daemonFailCount++;
                logger.error(`[PerceptionCache] Daemon poll cycle failed (consecutive failures: ${this.daemonFailCount}):`, err);
                
                // 🔴 FIX (Gemini audit): 不再彻底停止，而是发送一次性告警并进入慢速重试模式
                if (this.daemonFailCount === 3) {
                    logger.warn('[PerceptionCache] ⚠️ Daemon reached 3 failures. Entering exponential backoff mode.');
                    void (async () => {
                        try {
                            const { notificationService } = await import('../notificationService');
                            const channels = await notificationService.getChannels();
                            const enabledIds = channels.filter((c: any) => c.enabled).map((c: any) => c.id);
                            if (enabledIds.length > 0) {
                                await notificationService.send(enabledIds, {
                                    type: 'alert',
                                    title: '🚨 大脑感知缓存守护进程降级',
                                    body: `PerceptionCache 守护进程已连续 3 次轮询失败。系统已自动切换到“指数退避”模式，将以更长的间隔持续尝试恢复，直至上游服务就绪。`,
                                });
                            }
                        } catch (notifyErr) {
                            logger.error('[PerceptionCache] Failed to send daemon-degraded alert:', notifyErr);
                        }
                    })();
                }
            }
            // 🔴 无论成功失败，继续调度（实现自愈）
            this._scheduleDaemonTick();
        }, delay);
    }

    private async _runPollCycle(): Promise<void> {
        if (this.sources.length === 0) return;

        const results = await Promise.allSettled(
            this.sources.map(async (s) => {
                const data = await s.collector();
                this.set(s.source, data, s.freshnessThresholdMs);
                return s.source;
            })
        );

        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            const reasons = (failed as PromiseRejectedResult[]).map(r => String(r.reason)).join('; ');
            logger.warn(`[PerceptionCache] ${failed.length}/${this.sources.length} sources failed in poll cycle: ${reasons}`);
        }
    }
}

// ====================================================================
// 单例导出
// ====================================================================

export const perceptionCache = new PerceptionCache({
    backend: 'memory',
    defaultPollingIntervalMs: 30_000,
    defaultFreshnessThresholdMs: 60_000,
});
