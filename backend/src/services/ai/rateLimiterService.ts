/**
 * RateLimiterService - 请求速率限制服务
 *
 * 实现可配置的请求速率限制，防止 API 请求过于频繁
 * 使用滑动窗口算法进行速率限制
 *
 * Requirements: 6.5
 */

import { IRateLimiterService } from '../../types/ai';

/**
 * 速率限制配置
 */
export interface RateLimiterConfig {
  /** 每分钟允许的最大请求数 */
  maxRequestsPerMinute: number;
  /** 窗口大小（毫秒），默认 60000ms (1分钟) */
  windowSizeMs: number;
}

/**
 * 请求记录
 */
interface RequestRecord {
  /** 请求时间戳列表 */
  timestamps: number[];
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequestsPerMinute: 60,
  windowSizeMs: 60000 // 1 minute
};

/**
 * RateLimiterService 实现类
 *
 * 使用滑动窗口算法实现速率限制：
 * - 记录每个 key 的请求时间戳
 * - 检查时清理过期的时间戳
 * - 根据窗口内的请求数判断是否超限
 */
export class RateLimiterService implements IRateLimiterService {
  private readonly config: RateLimiterConfig;
  private readonly records: Map<string, RequestRecord>;

  /**
   * 创建 RateLimiterService 实例
   * @param config 速率限制配置（可选）
   */
  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config
    };
    this.records = new Map();
  }

  /**
   * 检查是否允许请求并记录
   *
   * 如果未超过速率限制，记录本次请求并返回 true
   * 如果已超过速率限制，返回 false
   *
   * @param key 限制键（通常是用户ID或API配置ID）
   * @returns true 如果允许请求，false 如果超过限制
   */
  checkLimit(key: string): boolean {
    const now = Date.now();
    const record = this.getOrCreateRecord(key);

    // 清理过期的时间戳
    this.cleanExpiredTimestamps(record, now);

    // 检查是否超过限制
    if (record.timestamps.length >= this.config.maxRequestsPerMinute) {
      return false;
    }

    // 记录本次请求
    record.timestamps.push(now);
    return true;
  }

  /**
   * 获取剩余可用请求数
   *
   * @param key 限制键
   * @returns 剩余可用请求数
   */
  getRemainingRequests(key: string): number {
    const now = Date.now();
    const record = this.records.get(key);

    if (!record) {
      return this.config.maxRequestsPerMinute;
    }

    // 清理过期的时间戳
    this.cleanExpiredTimestamps(record, now);

    return Math.max(0, this.config.maxRequestsPerMinute - record.timestamps.length);
  }

  /**
   * 重置指定 key 的限制
   *
   * @param key 限制键
   */
  resetLimit(key: string): void {
    this.records.delete(key);
  }

  /**
   * 获取下次可用请求的等待时间（毫秒）
   *
   * @param key 限制键
   * @returns 等待时间（毫秒），如果可以立即请求则返回 0
   */
  getWaitTimeMs(key: string): number {
    const now = Date.now();
    const record = this.records.get(key);

    if (!record) {
      return 0;
    }

    // 清理过期的时间戳
    this.cleanExpiredTimestamps(record, now);

    if (record.timestamps.length < this.config.maxRequestsPerMinute) {
      return 0;
    }

    // 计算最早的时间戳何时过期
    const oldestTimestamp = record.timestamps[0];
    const expiryTime = oldestTimestamp + this.config.windowSizeMs;
    return Math.max(0, expiryTime - now);
  }

  /**
   * 获取当前配置
   *
   * @returns 当前速率限制配置
   */
  getConfig(): RateLimiterConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   *
   * @param config 新的配置（部分）
   */
  updateConfig(config: Partial<RateLimiterConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * 清理所有记录
   */
  clearAll(): void {
    this.records.clear();
  }

  /**
   * 获取或创建请求记录
   */
  private getOrCreateRecord(key: string): RequestRecord {
    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.records.set(key, record);
    }
    return record;
  }

  /**
   * 清理过期的时间戳
   */
  private cleanExpiredTimestamps(record: RequestRecord, now: number): void {
    const cutoff = now - this.config.windowSizeMs;
    record.timestamps = record.timestamps.filter(ts => ts > cutoff);
  }
}

/**
 * 默认 RateLimiterService 单例实例
 */
export const rateLimiterService = new RateLimiterService();

export default rateLimiterService;
