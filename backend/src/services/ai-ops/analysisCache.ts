/**
 * AnalysisCache 分析缓存服务
 * 缓存相似告警的 AI 分析结果，避免重复调用 AI
 *
 * Requirements: 3.5, 3.6
 * - 3.5: 当告警指纹匹配缓存的分析结果时，直接返回缓存结果
 * - 3.6: 缓存分析结果时使用可配置的 TTL（默认 30 分钟）
 */

import {
  CachedAnalysis,
  AnalysisCacheConfig,
  AnalysisCacheStats,
  IAnalysisCache,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';

// 默认配置
const DEFAULT_CONFIG: AnalysisCacheConfig = {
  defaultTtlMs: 30 * 60 * 1000,  // 30 分钟
  maxSize: 1000,                  // 最大缓存条目数
};

export class AnalysisCache implements IAnalysisCache {
  private cache: Map<string, CachedAnalysis> = new Map();
  private config: AnalysisCacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private hitCount: number = 0;
  private missCount: number = 0;

  // LRU 访问顺序追踪
  private accessOrder: string[] = [];

  constructor(config?: Partial<AnalysisCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
    logger.info('AnalysisCache initialized', { config: this.config });
  }

  /**
   * 启动定期清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    // 每 5 分钟清理一次过期条目
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 获取缓存的分析结果
   * @param fingerprint 告警指纹
   * @returns 分析结果或 null
   */
  get(fingerprint: string): string | null {
    const entry = this.cache.get(fingerprint);
    
    if (!entry) {
      this.missCount++;
      return null;
    }

    // 检查是否过期
    if (Date.now() > entry.ttl) {
      this.cache.delete(fingerprint);
      this.removeFromAccessOrder(fingerprint);
      this.missCount++;
      return null;
    }

    // 更新命中计数和访问顺序
    entry.hitCount++;
    this.hitCount++;
    this.updateAccessOrder(fingerprint);

    logger.debug(`Analysis cache hit: ${fingerprint}, hitCount: ${entry.hitCount}`);
    return entry.analysis;
  }

  /**
   * 缓存分析结果
   * @param fingerprint 告警指纹
   * @param analysis 分析结果
   * @param ttlMs 可选的 TTL（毫秒）
   */
  set(fingerprint: string, analysis: string, ttlMs?: number): void {
    const now = Date.now();
    const ttl = now + (ttlMs ?? this.config.defaultTtlMs);

    // 检查是否需要淘汰旧条目
    if (this.cache.size >= this.config.maxSize && !this.cache.has(fingerprint)) {
      this.evictLRU();
    }

    const entry: CachedAnalysis = {
      fingerprint,
      analysis,
      createdAt: now,
      ttl,
      hitCount: 0,
    };

    this.cache.set(fingerprint, entry);
    this.updateAccessOrder(fingerprint);

    logger.debug(`Analysis cached: ${fingerprint}, ttl: ${ttl}`);
  }

  /**
   * 更新 LRU 访问顺序
   * @param fingerprint 指纹
   */
  private updateAccessOrder(fingerprint: string): void {
    this.removeFromAccessOrder(fingerprint);
    this.accessOrder.push(fingerprint);
  }

  /**
   * 从访问顺序中移除
   * @param fingerprint 指纹
   */
  private removeFromAccessOrder(fingerprint: string): void {
    const index = this.accessOrder.indexOf(fingerprint);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * 淘汰最近最少使用的条目
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    // 找到最旧的未过期条目进行淘汰
    const now = Date.now();
    for (let i = 0; i < this.accessOrder.length; i++) {
      const fingerprint = this.accessOrder[i];
      const entry = this.cache.get(fingerprint);
      
      // 如果条目已过期，直接删除
      if (!entry || now > entry.ttl) {
        this.cache.delete(fingerprint);
        this.accessOrder.splice(i, 1);
        logger.debug(`Evicted expired entry: ${fingerprint}`);
        return;
      }
    }

    // 如果没有过期条目，淘汰最旧的条目
    const oldestFingerprint = this.accessOrder.shift();
    if (oldestFingerprint) {
      this.cache.delete(oldestFingerprint);
      logger.debug(`Evicted LRU entry: ${oldestFingerprint}`);
    }
  }

  /**
   * 清理过期条目
   * @returns 删除的条目数
   */
  cleanup(): number {
    const now = Date.now();
    let deletedCount = 0;

    for (const [fingerprint, entry] of this.cache) {
      if (now > entry.ttl) {
        this.cache.delete(fingerprint);
        this.removeFromAccessOrder(fingerprint);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.debug(`AnalysisCache cleanup: removed ${deletedCount} expired entries`);
    }

    return deletedCount;
  }

  /**
   * 获取统计信息
   * @returns 缓存统计
   */
  getStats(): AnalysisCacheStats {
    return {
      size: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
    };
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.hitCount = 0;
    this.missCount = 0;
    logger.info('AnalysisCache cleared');
  }

  /**
   * 获取配置
   */
  getConfig(): AnalysisCacheConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AnalysisCacheConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('AnalysisCache config updated', { config: this.config });
  }

  /**
   * 检查指纹是否存在于缓存中（不更新访问顺序）
   * @param fingerprint 指纹
   * @returns 是否存在
   */
  has(fingerprint: string): boolean {
    const entry = this.cache.get(fingerprint);
    if (!entry) return false;
    
    // 检查是否过期
    if (Date.now() > entry.ttl) {
      this.cache.delete(fingerprint);
      this.removeFromAccessOrder(fingerprint);
      return false;
    }
    
    return true;
  }

  /**
   * 删除指定指纹的缓存
   * @param fingerprint 指纹
   */
  delete(fingerprint: string): void {
    this.cache.delete(fingerprint);
    this.removeFromAccessOrder(fingerprint);
    logger.debug(`Analysis cache entry deleted: ${fingerprint}`);
  }
}

// 导出单例实例
export const analysisCache = new AnalysisCache();
