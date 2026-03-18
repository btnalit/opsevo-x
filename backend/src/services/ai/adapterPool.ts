/**
 * AI 适配器池
 *
 * 缓存和复用 AI 适配器实例，减少创建开销并提高性能。
 * 实现 LRU 淘汰策略，支持配置最大缓存数量和过期时间。
 *
 * 需求: 12.1, 12.2, 12.4, 12.5, 12.6
 */

import { AIProvider, IAIProviderAdapter } from '../../types/ai';
import { AdapterFactory, AdapterConfig } from './adapters';
import { logger } from '../../utils/logger';

/**
 * 适配器缓存键
 */
export interface AdapterKey {
  provider: AIProvider;
  endpoint?: string;
}

/**
 * 适配器池配置
 */
export interface AdapterPoolConfig {
  /** 最大缓存数量，默认 10 */
  maxSize: number;
  /** 缓存过期时间（毫秒），默认 30 分钟 */
  ttlMs: number;
}

/**
 * 适配器缓存条目
 */
interface AdapterCacheEntry {
  adapter: IAIProviderAdapter;
  key: AdapterKey;
  apiKeyHash: string;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
}

/**
 * 适配器池统计信息
 */
export interface AdapterPoolStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/**
 * 适配器池接口
 */
export interface IAdapterPool {
  /**
   * 获取或创建适配器
   */
  getAdapter(key: AdapterKey, apiKey: string): IAIProviderAdapter;

  /**
   * 使缓存失效
   */
  invalidate(key: AdapterKey): void;

  /**
   * 清空所有缓存
   */
  clear(): void;

  /**
   * 获取统计信息
   */
  getStats(): AdapterPoolStats;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: AdapterPoolConfig = {
  maxSize: 10,
  ttlMs: 30 * 60 * 1000, // 30 分钟
};

/**
 * 生成缓存键字符串
 */
function generateCacheKey(key: AdapterKey, apiKeyHash: string): string {
  return `${key.provider}:${key.endpoint || 'default'}:${apiKeyHash}`;
}

/**
 * 简单的字符串哈希函数
 * 用于生成 API Key 的哈希值，避免在缓存键中存储明文
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * 适配器池实现类
 *
 * 使用 LRU (Least Recently Used) 策略管理缓存：
 * - 当缓存满时，淘汰最少使用的适配器
 * - 支持配置最大缓存数量和过期时间
 * - 提供缓存命中率统计
 */
export class AdapterPool implements IAdapterPool {
  private cache: Map<string, AdapterCacheEntry>;
  private config: AdapterPoolConfig;
  private hits: number = 0;
  private misses: number = 0;

  constructor(config: Partial<AdapterPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
  }

  /**
   * 获取或创建适配器
   *
   * 优先返回缓存的实例，如果缓存未命中则创建新实例。
   * 当缓存满时，使用 LRU 策略淘汰最少使用的适配器。
   *
   * @param key 适配器键（provider + endpoint）
   * @param apiKey API 密钥
   * @returns 适配器实例
   */
  getAdapter(key: AdapterKey, apiKey: string): IAIProviderAdapter {
    const apiKeyHash = hashString(apiKey);
    const cacheKey = generateCacheKey(key, apiKeyHash);
    const now = Date.now();

    // 检查缓存
    const entry = this.cache.get(cacheKey);
    if (entry) {
      // 检查是否过期
      if (now - entry.createdAt < this.config.ttlMs) {
        // 缓存命中
        this.hits++;
        entry.lastUsedAt = now;
        entry.useCount++;
        logger.debug(`AdapterPool: Cache hit for ${key.provider}`, {
          cacheKey,
          useCount: entry.useCount,
        });
        return entry.adapter;
      } else {
        // 缓存过期，删除
        this.cache.delete(cacheKey);
        logger.debug(`AdapterPool: Cache expired for ${key.provider}`, {
          cacheKey,
        });
      }
    }

    // 缓存未命中
    this.misses++;

    // 检查是否需要淘汰
    if (this.cache.size >= this.config.maxSize) {
      this.evictLRU();
    }

    // 创建新适配器
    const adapterConfig: AdapterConfig = {
      apiKey,
      endpoint: key.endpoint,
    };

    const adapter = AdapterFactory.createAdapter(key.provider, adapterConfig);

    // 添加到缓存
    const newEntry: AdapterCacheEntry = {
      adapter,
      key,
      apiKeyHash,
      createdAt: now,
      lastUsedAt: now,
      useCount: 1,
    };
    this.cache.set(cacheKey, newEntry);

    logger.debug(`AdapterPool: Created new adapter for ${key.provider}`, {
      cacheKey,
      cacheSize: this.cache.size,
    });

    return adapter;
  }

  /**
   * 使指定键的缓存失效
   *
   * 当适配器配置变更时调用此方法使对应的缓存失效。
   *
   * @param key 适配器键
   */
  invalidate(key: AdapterKey): void {
    // 遍历缓存，删除匹配的条目
    const keysToDelete: string[] = [];

    for (const [cacheKey, entry] of this.cache.entries()) {
      if (
        entry.key.provider === key.provider &&
        entry.key.endpoint === key.endpoint
      ) {
        keysToDelete.push(cacheKey);
      }
    }

    for (const cacheKey of keysToDelete) {
      this.cache.delete(cacheKey);
      logger.debug(`AdapterPool: Invalidated cache for ${key.provider}`, {
        cacheKey,
      });
    }
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.debug(`AdapterPool: Cleared all cache`, { previousSize: size });
  }

  /**
   * 获取统计信息
   *
   * @returns 缓存统计信息，包括大小、命中次数、未命中次数和命中率
   */
  getStats(): AdapterPoolStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * 重置统计信息（用于测试）
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 淘汰最少使用的缓存条目 (LRU)
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [cacheKey, entry] of this.cache.entries()) {
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt;
        oldestKey = cacheKey;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      logger.debug(`AdapterPool: Evicted LRU entry`, {
        cacheKey: oldestKey,
        provider: entry?.key.provider,
        useCount: entry?.useCount,
      });
    }
  }

  /**
   * 清理过期的缓存条目
   * 可以定期调用此方法清理过期条目
   */
  cleanupExpired(): number {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [cacheKey, entry] of this.cache.entries()) {
      if (now - entry.createdAt >= this.config.ttlMs) {
        keysToDelete.push(cacheKey);
      }
    }

    for (const cacheKey of keysToDelete) {
      this.cache.delete(cacheKey);
    }

    if (keysToDelete.length > 0) {
      logger.debug(`AdapterPool: Cleaned up expired entries`, {
        count: keysToDelete.length,
      });
    }

    return keysToDelete.length;
  }

  /**
   * 获取当前配置
   */
  getConfig(): AdapterPoolConfig {
    return { ...this.config };
  }
}

// 单例实例
let adapterPoolInstance: AdapterPool | null = null;

/**
 * 获取 AdapterPool 单例实例
 */
export function getAdapterPool(config?: Partial<AdapterPoolConfig>): AdapterPool {
  if (!adapterPoolInstance) {
    adapterPoolInstance = new AdapterPool(config);
  }
  return adapterPoolInstance;
}

/**
 * 重置 AdapterPool 单例（用于测试）
 */
export function resetAdapterPool(): void {
  if (adapterPoolInstance) {
    adapterPoolInstance.clear();
    adapterPoolInstance = null;
  }
}
