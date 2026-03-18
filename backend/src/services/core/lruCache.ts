/**
 * LRU 缓存管理器
 * 
 * 实现带有最大条目数限制、内存监控和 LRU 淘汰策略的增强缓存。
 * 
 * Requirements: 3.1, 3.2, 3.4
 * - 3.1: 为缓存设置最大条目数限制
 * - 3.2: 使用 LRU 策略淘汰最少使用的条目
 * - 3.4: 提供缓存内存使用量监控接口
 */

import { logger } from '../../utils/logger';

/**
 * LRU 缓存配置
 */
export interface LRUCacheConfig {
  /** 最大条目数 */
  maxEntries: number;
  /** 最大内存（MB），可选 */
  maxMemoryMB?: number;
  /** 清理间隔（毫秒） */
  cleanupIntervalMs: number;
  /** 默认 TTL（毫秒） */
  ttlMs: number;
  /** 淘汰回调 */
  onEvict?: (key: string, value: unknown) => void;
}

/**
 * 缓存统计
 */
export interface CacheStats {
  /** 当前条目数 */
  entries: number;
  /** 估算内存使用量（MB） */
  memoryUsageMB: number;
  /** 命中次数 */
  hitCount: number;
  /** 未命中次数 */
  missCount: number;
  /** 淘汰次数 */
  evictionCount: number;
  /** 命中率 */
  hitRate: number;
}

/**
 * 缓存条目
 */
interface CacheEntry<V> {
  value: V;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  size: number; // 估算大小（字节）
}

/**
 * 增强的缓存接口
 */
export interface IEnhancedCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, ttlMs?: number): void;
  delete(key: K): boolean;
  clear(): void;
  has(key: K): boolean;
  size(): number;
  getStats(): CacheStats;
  setMaxEntries(max: number): void;
  forceCleanup(): number;
  keys(): K[];
  values(): V[];
  entries(): [K, V][];
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: LRUCacheConfig = {
  maxEntries: 10000,
  maxMemoryMB: 100,
  cleanupIntervalMs: 5 * 60 * 1000, // 5 分钟
  ttlMs: 30 * 60 * 1000, // 30 分钟
};


/**
 * LRU 缓存实现
 * 
 * 使用 Map 保持插入顺序，通过删除和重新插入实现 LRU 更新。
 */
export class LRUCache<K = string, V = unknown> implements IEnhancedCache<K, V> {
  private cache: Map<K, CacheEntry<V>> = new Map();
  private config: LRUCacheConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // 统计信息
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(config?: Partial<LRUCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
  }

  /**
   * 获取缓存值
   * 命中时更新访问时间并移动到末尾（最近使用）
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.missCount++;
      return undefined;
    }

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      this.missCount++;
      return undefined;
    }

    // 更新访问时间并移动到末尾（LRU 更新）
    entry.lastAccessedAt = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    this.hitCount++;
    return entry.value;
  }

  /**
   * 设置缓存值
   * 如果超过最大条目数，淘汰最少使用的条目
   */
  set(key: K, value: V, ttlMs?: number): void {
    const now = Date.now();
    const effectiveTtl = ttlMs ?? this.config.ttlMs;
    
    // 如果 key 已存在，先删除（更新 LRU 顺序）
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 检查是否需要淘汰
    while (this.cache.size >= this.config.maxEntries) {
      this.evictLRU();
    }

    // 检查内存限制
    if (this.config.maxMemoryMB) {
      while (this.getEstimatedMemoryMB() >= this.config.maxMemoryMB && this.cache.size > 0) {
        this.evictLRU();
      }
    }

    const entry: CacheEntry<V> = {
      value,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + effectiveTtl,
      size: this.estimateSize(value),
    };

    this.cache.set(key, entry);
  }

  /**
   * 删除缓存条目
   */
  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (entry && this.config.onEvict) {
      this.config.onEvict(String(key), entry.value);
    }
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    if (this.config.onEvict) {
      for (const [key, entry] of this.cache) {
        this.config.onEvict(String(key), entry.value);
      }
    }
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  /**
   * 检查 key 是否存在（不更新 LRU）
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    const total = this.hitCount + this.missCount;
    return {
      entries: this.cache.size,
      memoryUsageMB: this.getEstimatedMemoryMB(),
      hitCount: this.hitCount,
      missCount: this.missCount,
      evictionCount: this.evictionCount,
      hitRate: total > 0 ? this.hitCount / total : 0,
    };
  }

  /**
   * 设置最大条目数
   */
  setMaxEntries(max: number): void {
    this.config.maxEntries = max;
    // 如果当前条目数超过新限制，淘汰多余的
    while (this.cache.size > max) {
      this.evictLRU();
    }
  }

  /**
   * 强制清理过期条目
   * @returns 清理的条目数
   */
  forceCleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`LRU cache cleanup: removed ${cleaned} expired entries`);
    }

    return cleaned;
  }

  /**
   * 获取所有 keys
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 获取所有 values
   */
  values(): V[] {
    return Array.from(this.cache.values()).map(entry => entry.value);
  }

  /**
   * 获取所有 entries
   */
  entries(): [K, V][] {
    return Array.from(this.cache.entries()).map(([key, entry]) => [key, entry.value]);
  }

  /**
   * 淘汰最少使用的条目（Map 的第一个元素）
   */
  private evictLRU(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey !== undefined) {
      const entry = this.cache.get(firstKey);
      if (entry && this.config.onEvict) {
        this.config.onEvict(String(firstKey), entry.value);
      }
      this.cache.delete(firstKey);
      this.evictionCount++;
    }
  }

  /**
   * 估算值的大小（字节）
   */
  private estimateSize(value: V): number {
    try {
      const json = JSON.stringify(value);
      return json.length * 2; // UTF-16 编码，每个字符 2 字节
    } catch {
      return 1024; // 默认 1KB
    }
  }

  /**
   * 获取估算的内存使用量（MB）
   */
  private getEstimatedMemoryMB(): number {
    let totalBytes = 0;
    for (const entry of this.cache.values()) {
      totalBytes += entry.size;
    }
    return totalBytes / (1024 * 1024);
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    if (this.config.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.forceCleanup();
      }, this.config.cleanupIntervalMs);
    }
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
   * 销毁缓存
   */
  destroy(): void {
    this.stopCleanupTimer();
    this.clear();
  }
}

/**
 * 创建 LRU 缓存实例的工厂函数
 */
export function createLRUCache<K = string, V = unknown>(
  config?: Partial<LRUCacheConfig>
): LRUCache<K, V> {
  return new LRUCache<K, V>(config);
}
