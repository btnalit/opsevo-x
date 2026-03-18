/**
 * ConcurrencyLimiter - 并发限制器
 * 
 * 控制并发工具调用数量，防止系统过载
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 * - 5.1: 强制执行可配置的最大并发工具调用数
 * - 5.2: 超过限制时排队等待
 * - 5.3: 支持按工具类型的并发限制
 * - 5.4: 支持按设备的并发限制
 * - 5.5: 追踪和报告队列深度和等待时间
 * - 5.6: 队列超时处理
 */

import { logger } from '../../../utils/logger';
import {
  ConcurrencyConfig,
  ConcurrencySlot,
  ConcurrencyStatus,
  ParallelExecutionError,
  ParallelExecutionErrorType,
  createDefaultConcurrencyConfig,
} from '../../../types/parallel-execution';

/**
 * 槽位请求
 */
export interface SlotRequest {
  /** 工具名称 */
  toolName: string;
  /** 设备 ID（可选） */
  deviceId?: string;
}

/**
 * 排队项
 */
interface QueueItem {
  request: SlotRequest;
  resolve: (slot: ConcurrencySlot) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  timeoutId?: NodeJS.Timeout;
}

/**
 * ConcurrencyLimiter 类
 * 管理并发工具调用的槽位分配
 */
export class ConcurrencyLimiter {
  private config: ConcurrencyConfig;
  
  /** 当前活跃的槽位 */
  private activeSlots: Map<string, ConcurrencySlot> = new Map();
  
  /** 等待队列 */
  private queue: QueueItem[] = [];
  
  /** 按工具类型的活跃计数 */
  private perToolActive: Map<string, number> = new Map();
  
  /** 按设备的活跃计数 */
  private perDeviceActive: Map<string, number> = new Map();
  
  /** 等待时间统计 */
  private waitTimes: number[] = [];
  private maxWaitTimeHistory = 100;
  
  /** 槽位 ID 计数器 */
  private slotIdCounter = 0;

  constructor(config?: Partial<ConcurrencyConfig>) {
    const defaultConfig = createDefaultConcurrencyConfig();
    this.config = {
      ...defaultConfig,
      ...config,
      perToolLimits: config?.perToolLimits || defaultConfig.perToolLimits,
      perDeviceLimits: config?.perDeviceLimits || defaultConfig.perDeviceLimits,
    };
    
    logger.debug('ConcurrencyLimiter initialized', {
      globalMax: this.config.globalMax,
      queueTimeout: this.config.queueTimeout,
    });
  }

  /**
   * 获取并发槽位（批量）
   * Requirements: 5.1, 5.2
   * 
   * @param requests 槽位请求列表
   * @returns 分配的槽位列表
   */
  async acquireSlots(requests: SlotRequest[]): Promise<ConcurrencySlot[]> {
    const slots: ConcurrencySlot[] = [];
    
    for (const request of requests) {
      try {
        const slot = await this.acquireSlot(request);
        slots.push(slot);
      } catch (error) {
        // 如果获取失败，释放已获取的槽位
        this.releaseSlots(slots);
        throw error;
      }
    }
    
    return slots;
  }

  /**
   * 获取单个并发槽位
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
   * 
   * @param request 槽位请求
   * @returns 分配的槽位
   */
  async acquireSlot(request: SlotRequest): Promise<ConcurrencySlot> {
    // 检查是否可以立即分配
    if (this.canAcquire(request)) {
      return this.allocateSlot(request);
    }

    // 需要排队等待
    return this.enqueue(request);
  }

  /**
   * 释放并发槽位（批量）
   * 
   * @param slots 要释放的槽位列表
   */
  releaseSlots(slots: ConcurrencySlot[]): void {
    for (const slot of slots) {
      this.releaseSlot(slot);
    }
  }

  /**
   * 释放单个并发槽位
   * 
   * @param slot 要释放的槽位
   */
  releaseSlot(slot: ConcurrencySlot): void {
    if (!this.activeSlots.has(slot.slotId)) {
      logger.warn('Attempting to release non-existent slot', { slotId: slot.slotId });
      return;
    }

    // 移除活跃槽位
    this.activeSlots.delete(slot.slotId);

    // 更新按工具类型的计数
    const toolCount = this.perToolActive.get(slot.toolName) || 0;
    if (toolCount > 0) {
      this.perToolActive.set(slot.toolName, toolCount - 1);
    }

    // 更新按设备的计数
    if (slot.deviceId) {
      const deviceCount = this.perDeviceActive.get(slot.deviceId) || 0;
      if (deviceCount > 0) {
        this.perDeviceActive.set(slot.deviceId, deviceCount - 1);
      }
    }

    logger.debug('Slot released', {
      slotId: slot.slotId,
      toolName: slot.toolName,
      activeSlots: this.activeSlots.size,
    });

    // 尝试处理队列中的等待请求
    this.processQueue();
  }

  /**
   * 获取当前状态
   * Requirements: 5.5
   * 
   * @returns 并发状态
   */
  getStatus(): ConcurrencyStatus {
    const avgWaitTime = this.waitTimes.length > 0
      ? this.waitTimes.reduce((a, b) => a + b, 0) / this.waitTimes.length
      : 0;

    return {
      activeSlots: this.activeSlots.size,
      queueDepth: this.queue.length,
      avgWaitTime,
      perToolActive: new Map(this.perToolActive),
      perDeviceActive: new Map(this.perDeviceActive),
    };
  }

  /**
   * 更新配置
   * 
   * @param config 部分配置更新
   */
  updateConfig(config: Partial<ConcurrencyConfig>): void {
    if (config.globalMax !== undefined) {
      this.config.globalMax = config.globalMax;
    }
    if (config.queueTimeout !== undefined) {
      this.config.queueTimeout = config.queueTimeout;
    }
    if (config.perToolLimits) {
      this.config.perToolLimits = config.perToolLimits;
    }
    if (config.perDeviceLimits) {
      this.config.perDeviceLimits = config.perDeviceLimits;
    }

    logger.debug('ConcurrencyLimiter config updated', {
      globalMax: this.config.globalMax,
      queueTimeout: this.config.queueTimeout,
    });
  }

  /**
   * 清空队列（用于关闭时）
   */
  clearQueue(): void {
    for (const item of this.queue) {
      if (item.timeoutId) {
        clearTimeout(item.timeoutId);
      }
      item.reject(new ParallelExecutionError(
        ParallelExecutionErrorType.CONCURRENCY_TIMEOUT,
        'Queue cleared due to shutdown',
        { toolName: item.request.toolName },
        false
      ));
    }
    this.queue = [];
  }

  // ==================== 私有方法 ====================

  /**
   * 检查是否可以立即分配槽位
   */
  private canAcquire(request: SlotRequest): boolean {
    // 检查全局限制
    if (this.activeSlots.size >= this.config.globalMax) {
      return false;
    }

    // 检查按工具类型的限制
    const toolLimit = this.config.perToolLimits.get(request.toolName);
    if (toolLimit !== undefined) {
      const currentToolCount = this.perToolActive.get(request.toolName) || 0;
      if (currentToolCount >= toolLimit) {
        return false;
      }
    }

    // 检查按设备的限制
    if (request.deviceId) {
      const deviceLimit = this.config.perDeviceLimits.get(request.deviceId);
      if (deviceLimit !== undefined) {
        const currentDeviceCount = this.perDeviceActive.get(request.deviceId) || 0;
        if (currentDeviceCount >= deviceLimit) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 分配槽位
   */
  private allocateSlot(request: SlotRequest): ConcurrencySlot {
    const slot: ConcurrencySlot = {
      slotId: `slot_${++this.slotIdCounter}_${Date.now()}`,
      toolName: request.toolName,
      deviceId: request.deviceId,
      acquiredAt: Date.now(),
    };

    // 添加到活跃槽位
    this.activeSlots.set(slot.slotId, slot);

    // 更新按工具类型的计数
    const toolCount = this.perToolActive.get(request.toolName) || 0;
    this.perToolActive.set(request.toolName, toolCount + 1);

    // 更新按设备的计数
    if (request.deviceId) {
      const deviceCount = this.perDeviceActive.get(request.deviceId) || 0;
      this.perDeviceActive.set(request.deviceId, deviceCount + 1);
    }

    logger.debug('Slot allocated', {
      slotId: slot.slotId,
      toolName: request.toolName,
      activeSlots: this.activeSlots.size,
    });

    return slot;
  }

  /**
   * 将请求加入队列
   * Requirements: 5.2, 5.6
   */
  private enqueue(request: SlotRequest): Promise<ConcurrencySlot> {
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        request,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      // 设置超时
      if (this.config.queueTimeout > 0) {
        item.timeoutId = setTimeout(() => {
          this.handleTimeout(item);
        }, this.config.queueTimeout);
      }

      this.queue.push(item);

      logger.debug('Request enqueued', {
        toolName: request.toolName,
        queueDepth: this.queue.length,
      });
    });
  }

  /**
   * 处理队列超时
   * Requirements: 5.6
   */
  private handleTimeout(item: QueueItem): void {
    const index = this.queue.indexOf(item);
    if (index !== -1) {
      this.queue.splice(index, 1);
      
      const waitTime = Date.now() - item.enqueuedAt;
      logger.warn('Queue timeout', {
        toolName: item.request.toolName,
        waitTime,
        timeout: this.config.queueTimeout,
      });

      item.reject(new ParallelExecutionError(
        ParallelExecutionErrorType.CONCURRENCY_TIMEOUT,
        `Queue timeout after ${waitTime}ms`,
        {
          toolName: item.request.toolName,
          deviceId: item.request.deviceId,
          waitTime,
          timeout: this.config.queueTimeout,
        },
        true
      ));
    }
  }

  /**
   * 处理队列中的等待请求
   */
  private processQueue(): void {
    while (this.queue.length > 0) {
      const item = this.queue[0];
      
      if (!this.canAcquire(item.request)) {
        // 无法分配，停止处理
        break;
      }

      // 从队列中移除
      this.queue.shift();

      // 清除超时
      if (item.timeoutId) {
        clearTimeout(item.timeoutId);
      }

      // 记录等待时间
      const waitTime = Date.now() - item.enqueuedAt;
      this.recordWaitTime(waitTime);

      // 分配槽位
      try {
        const slot = this.allocateSlot(item.request);
        item.resolve(slot);
      } catch (error) {
        item.reject(error as Error);
      }
    }
  }

  /**
   * 记录等待时间
   */
  private recordWaitTime(waitTime: number): void {
    this.waitTimes.push(waitTime);
    if (this.waitTimes.length > this.maxWaitTimeHistory) {
      this.waitTimes.shift();
    }
  }
}

// 导出单例实例
export const concurrencyLimiter = new ConcurrencyLimiter();
