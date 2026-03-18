/**
 * FingerprintCache 指纹缓存服务
 * 用于告警去重的内存缓存实现
 *
 * Requirements: 2.1, 2.2, 2.5, 2.6, 2.7
 * - 2.1: 生成指纹时移除动态部分（IP、时间戳、端口、会话 ID）
 * - 2.2: 保留核心特征（规则 ID、指标类型、严重级别）
 * - 2.5: 支持配置 TTL（默认 5 分钟）
 * - 2.6: TTL 过期后自动移除指纹条目
 * - 2.7: 使用内存 Map 实现，无外部依赖
 */

import {
  AlertEvent,
  FingerprintEntry,
  FingerprintCacheConfig,
  FingerprintCacheStats,
  IFingerprintCache,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';

// 默认配置
const DEFAULT_CONFIG: FingerprintCacheConfig = {
  defaultTtlMs: 5 * 60 * 1000,      // 5 分钟
  cleanupIntervalMs: 60 * 1000,     // 1 分钟
};

// 正则表达式用于移除动态部分
const PATTERNS = {
  // IPv4 地址
  ipv4: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
  // IPv6 地址
  ipv6: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|:(?::[0-9a-fA-F]{1,4}){1,7}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}\b|\b(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}\b|\b[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}\b|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|::(?:ffff:)?(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/gi,
  // 时间戳（各种格式）
  timestamp: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b|\b\d{10,13}\b/g,
  // 端口号（在冒号后或 port 关键字后）
  port: /(?::\d{1,5}\b)|(?:\bport[:\s]+\d{1,5}\b)/gi,
  // 会话 ID（UUID 格式）
  sessionId: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // 十六进制会话 ID
  hexSessionId: /\b[0-9a-fA-F]{16,32}\b/g,
};

export class FingerprintCache implements IFingerprintCache {
  private cache: Map<string, FingerprintEntry> = new Map();
  private config: FingerprintCacheConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private suppressedCount: number = 0;

  constructor(config?: Partial<FingerprintCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
    logger.info('FingerprintCache initialized', { config: this.config });
  }

  /**
   * 启动定期清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
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
   * 移除消息中的动态部分
   * @param message 原始消息
   * @returns 移除动态部分后的消息
   */
  private removeDynamicParts(message: string): string {
    let result = message;

    // 移除 IPv4 地址
    result = result.replace(PATTERNS.ipv4, '<IP>');

    // 移除 IPv6 地址
    result = result.replace(PATTERNS.ipv6, '<IP>');

    // 移除时间戳
    result = result.replace(PATTERNS.timestamp, '<TIMESTAMP>');

    // 移除端口号
    result = result.replace(PATTERNS.port, '<PORT>');

    // 移除 UUID 格式的会话 ID
    result = result.replace(PATTERNS.sessionId, '<SESSION>');

    // 移除十六进制会话 ID
    result = result.replace(PATTERNS.hexSessionId, '<SESSION>');

    return result;
  }

  /**
   * 生成告警指纹
   * 保留核心特征：规则 ID、指标类型、严重级别
   * 移除动态部分：IP、时间戳、端口、会话 ID
   * 
   * @param alert 告警事件
   * @returns 指纹字符串
   */
  generateFingerprint(alert: AlertEvent): string {
    // 核心特征
    const coreFeatures = [
      alert.tenantId || 'default',
      alert.deviceId || 'global',
      alert.ruleId,
      alert.metric,
      alert.severity,
    ];

    // 处理消息，移除动态部分
    const normalizedMessage = this.removeDynamicParts(alert.message);

    // 组合生成指纹
    const fingerprintSource = [...coreFeatures, normalizedMessage].join('|');

    // 使用简单的哈希算法生成指纹
    return this.simpleHash(fingerprintSource);
  }

  /**
   * 简单哈希算法
   * @param str 输入字符串
   * @returns 哈希值
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // 转换为十六进制字符串，确保正数
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * 检查指纹是否存在且未过期
   * @param fingerprint 指纹
   * @returns 是否存在
   */
  exists(fingerprint: string): boolean {
    const entry = this.cache.get(fingerprint);
    if (!entry) {
      return false;
    }

    // 检查是否过期
    if (Date.now() > entry.ttl) {
      this.cache.delete(fingerprint);
      return false;
    }

    return true;
  }

  /**
   * 添加或更新指纹
   * @param fingerprint 指纹
   * @param ttlMs 可选的 TTL（毫秒）
   */
  set(fingerprint: string, ttlMs?: number): void {
    const now = Date.now();
    const ttl = now + (ttlMs ?? this.config.defaultTtlMs);

    const existing = this.cache.get(fingerprint);

    if (existing) {
      // 更新现有条目
      existing.lastSeen = now;
      existing.count += 1;
      existing.ttl = ttl;
      this.suppressedCount += 1;
      logger.debug(`Fingerprint updated: ${fingerprint}, count: ${existing.count}`);
    } else {
      // 创建新条目
      const entry: FingerprintEntry = {
        fingerprint,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        ttl,
      };
      this.cache.set(fingerprint, entry);
      logger.debug(`Fingerprint added: ${fingerprint}`);
    }
  }

  /**
   * 获取指纹信息
   * @param fingerprint 指纹
   * @returns 指纹条目或 null
   */
  get(fingerprint: string): FingerprintEntry | null {
    const entry = this.cache.get(fingerprint);
    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (Date.now() > entry.ttl) {
      this.cache.delete(fingerprint);
      return null;
    }

    return { ...entry };
  }

  /**
   * 删除指纹
   * @param fingerprint 指纹
   */
  delete(fingerprint: string): void {
    this.cache.delete(fingerprint);
    logger.debug(`Fingerprint deleted: ${fingerprint}`);
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
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.debug(`FingerprintCache cleanup: removed ${deletedCount} expired entries`);
    }

    return deletedCount;
  }

  /**
   * 获取统计信息
   * @returns 缓存统计
   */
  getStats(): FingerprintCacheStats {
    return {
      size: this.cache.size,
      suppressedCount: this.suppressedCount,
    };
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.suppressedCount = 0;
    logger.info('FingerprintCache cleared');
  }

  /**
   * 获取配置
   */
  getConfig(): FingerprintCacheConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<FingerprintCacheConfig>): void {
    this.config = { ...this.config, ...config };

    // 如果清理间隔改变，重启定时器
    if (config.cleanupIntervalMs !== undefined) {
      this.startCleanupTimer();
    }

    logger.info('FingerprintCache config updated', { config: this.config });
  }
}

// 导出单例实例
export const fingerprintCache = new FingerprintCache();
