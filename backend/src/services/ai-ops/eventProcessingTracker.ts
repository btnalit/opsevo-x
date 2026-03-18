/**
 * EventProcessingTracker 事件处理跟踪器
 * 跟踪正在处理中的事件，防止重复处理
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 * - 3.1: 事件进入处理流程时记录处理中状态
 * - 3.2: 同一事件 ID 再次进入时检测重复并跳过
 * - 3.3: 事件处理完成或超时时移除处理中状态
 * - 3.4: 支持可配置的处理超时时间（默认 3 分钟）
 * - 3.5: 定期清理过期的处理中状态记录
 */

import { logger } from '../../utils/logger';

/**
 * 事件处理状态
 */
export interface EventProcessingState {
  /** 事件 ID */
  eventId: string;
  /** 开始处理时间戳 */
  startedAt: number;
  /** 超时时间戳 */
  expiresAt: number;
  /** 事件指纹（用于快速查找） */
  fingerprint?: string;
}

/**
 * 跟踪器统计信息
 */
export interface EventProcessingStats {
  /** 当前处理中的事件数量 */
  processingCount: number;
  /** 被拦截的重复事件数量 */
  duplicatesBlocked: number;
  /** 因超时被清理的数量 */
  timeoutsCleared: number;
  /** 总处理完成数量 */
  totalCompleted: number;
}

/**
 * 跟踪器配置
 */
export interface EventProcessingTrackerConfig {
  /** 默认处理超时时间（毫秒），默认 180000 (3分钟) */
  defaultTimeoutMs: number;
  /** 清理间隔（毫秒），默认 60000 (1分钟) */
  cleanupIntervalMs: number;
  /** 最大跟踪条目数，默认 1000 */
  maxEntries: number;
}

const DEFAULT_CONFIG: EventProcessingTrackerConfig = {
  defaultTimeoutMs: 180000, // 3 分钟
  cleanupIntervalMs: 60000, // 1 分钟
  maxEntries: 1000,
};

/**
 * EventProcessingTracker 事件处理跟踪器
 */
export class EventProcessingTracker {
  private processingEvents: Map<string, EventProcessingState> = new Map();
  private config: EventProcessingTrackerConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;
  
  // 统计信息
  private stats: EventProcessingStats = {
    processingCount: 0,
    duplicatesBlocked: 0,
    timeoutsCleared: 0,
    totalCompleted: 0,
  };

  constructor(config?: Partial<EventProcessingTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupTimer();
    logger.info('EventProcessingTracker initialized', { config: this.config });
  }

  /**
   * 检查事件是否正在处理中
   * Requirements: 3.2 - 检测重复事件
   * @param eventId 事件 ID
   * @returns true 如果事件正在处理中
   */
  isProcessing(eventId: string): boolean {
    const state = this.processingEvents.get(eventId);
    if (!state) {
      return false;
    }
    
    // 检查是否已超时
    const now = Date.now();
    if (now > state.expiresAt) {
      // 已超时，清理并返回 false
      this.processingEvents.delete(eventId);
      this.stats.timeoutsCleared++;
      logger.debug(`Event processing state expired: ${eventId}`);
      return false;
    }
    
    return true;
  }

  /**
   * 标记事件开始处理
   * Requirements: 3.1 - 记录处理中状态
   * @param eventId 事件 ID
   * @param timeout 处理超时时间（毫秒），默认使用配置值
   * @param fingerprint 可选的事件指纹
   * @returns true 如果成功标记，false 如果事件已在处理中
   */
  markProcessing(eventId: string, timeout?: number, fingerprint?: string): boolean {
    // 检查是否已在处理中
    if (this.isProcessing(eventId)) {
      this.stats.duplicatesBlocked++;
      logger.debug(`Duplicate event blocked: ${eventId}`);
      return false;
    }
    
    // 检查是否超过最大条目数
    if (this.processingEvents.size >= this.config.maxEntries) {
      // 清理最旧的条目
      this.cleanupOldestEntry();
    }
    
    const now = Date.now();
    const timeoutMs = timeout ?? this.config.defaultTimeoutMs;
    
    const state: EventProcessingState = {
      eventId,
      startedAt: now,
      expiresAt: now + timeoutMs,
      fingerprint,
    };
    
    this.processingEvents.set(eventId, state);
    this.stats.processingCount = this.processingEvents.size;
    
    logger.debug(`Event marked as processing: ${eventId}, timeout: ${timeoutMs}ms`);
    return true;
  }

  /**
   * 标记事件处理完成
   * Requirements: 3.3 - 移除处理中状态
   * @param eventId 事件 ID
   */
  markCompleted(eventId: string): void {
    const existed = this.processingEvents.delete(eventId);
    if (existed) {
      this.stats.totalCompleted++;
      this.stats.processingCount = this.processingEvents.size;
      logger.debug(`Event processing completed: ${eventId}`);
    }
  }

  /**
   * 获取统计信息
   * Requirements: 6.3 - 提供统计信息
   */
  getStats(): EventProcessingStats {
    return {
      ...this.stats,
      processingCount: this.processingEvents.size,
    };
  }

  /**
   * 清理过期的处理状态
   * Requirements: 3.5 - 定期清理过期记录
   */
  cleanup(): number {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [eventId, state] of this.processingEvents) {
      if (now > state.expiresAt) {
        this.processingEvents.delete(eventId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.stats.timeoutsCleared += cleanedCount;
      this.stats.processingCount = this.processingEvents.size;
      logger.info(`Cleaned up ${cleanedCount} expired event processing states`);
    }
    
    return cleanedCount;
  }

  /**
   * 获取当前处理中的事件数量
   */
  getProcessingCount(): number {
    return this.processingEvents.size;
  }

  /**
   * 获取所有处理中的事件 ID
   */
  getProcessingEventIds(): string[] {
    return Array.from(this.processingEvents.keys());
  }

  /**
   * 清理最旧的条目（当达到最大条目数时）
   */
  private cleanupOldestEntry(): void {
    let oldestEventId: string | null = null;
    let oldestStartedAt = Infinity;
    
    for (const [eventId, state] of this.processingEvents) {
      if (state.startedAt < oldestStartedAt) {
        oldestStartedAt = state.startedAt;
        oldestEventId = eventId;
      }
    }
    
    if (oldestEventId) {
      this.processingEvents.delete(oldestEventId);
      this.stats.timeoutsCleared++;
      logger.warn(`Evicted oldest event processing state due to capacity: ${oldestEventId}`);
    }
  }

  /**
   * 启动清理定时器
   * Requirements: 3.5 - 定期清理
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
    
    // 确保定时器不阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
    
    logger.debug(`EventProcessingTracker cleanup timer started (interval: ${this.config.cleanupIntervalMs}ms)`);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.debug('EventProcessingTracker cleanup timer stopped');
    }
  }

  /**
   * 停止服务并清理资源
   */
  stop(): void {
    this.stopCleanupTimer();
    this.processingEvents.clear();
    logger.info('EventProcessingTracker stopped');
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      processingCount: this.processingEvents.size,
      duplicatesBlocked: 0,
      timeoutsCleared: 0,
      totalCompleted: 0,
    };
    logger.debug('EventProcessingTracker stats reset');
  }
}

// 导出单例实例
export const eventProcessingTracker = new EventProcessingTracker();
