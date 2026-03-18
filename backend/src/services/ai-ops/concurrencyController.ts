/**
 * ConcurrencyController - 增强的并发控制器
 * 
 * 解决异步处理中的资源泄漏问题：
 * - 实现优先级队列
 * - 实现超时保护机制
 * - 实现背压机制
 * 
 * Requirements: 2.1, 2.2, 2.4, 2.6
 * - 2.1: AI 分析服务响应超时时取消请求并记录日志
 * - 2.2: Pipeline 队列满时采用优先级策略
 * - 2.4: 并发达上限时将新任务加入优先级队列
 * - 2.6: 系统负载过高时实现背压机制
 */

import { logger } from '../../utils/logger';

/**
 * Pipeline 并发控制配置
 */
export interface ConcurrencyConfig {
  /** 最大并发数，默认 5 */
  maxConcurrent: number;
  /** 最大队列大小，默认 100 */
  maxQueueSize: number;
  /** 单任务超时（毫秒），默认 30000 */
  taskTimeout: number;
  /** 启用优先级队列 */
  enablePriorityQueue: boolean;
  /** 启用背压机制 */
  enableBackpressure: boolean;
  /** 背压阈值（队列使用率 0-1），默认 0.8 */
  backpressureThreshold: number;
}

/**
 * 默认配置
 */
export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = {
  maxConcurrent: 5,
  maxQueueSize: 100,
  taskTimeout: 30000,
  enablePriorityQueue: true,
  enableBackpressure: true,
  backpressureThreshold: 0.8,
};

/**
 * 优先级队列项
 */
export interface PriorityQueueItem<T> {
  item: T;
  priority: number;  // 数字越小优先级越高
  enqueuedAt: number;
  timeout: number;
}

/**
 * 并发状态
 */
export interface ConcurrencyStatus {
  active: number;
  queued: number;
  maxConcurrent: number;
  queueCapacity: number;
  queueUsagePercent: number;
  isPaused: boolean;
  isBackpressureActive: boolean;
  avgProcessingTimeMs: number;
  totalProcessed: number;
  totalDropped: number;
  totalTimedOut: number;
}


/**
 * 队列中的任务项（内部使用）
 */
interface QueuedTask<T, R> {
  item: T;
  priority: number;
  enqueuedAt: number;
  timeout: number;
  resolve: (value: R) => void;
  reject: (error: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * 任务处理器类型
 */
export type TaskProcessor<T, R> = (item: T) => Promise<R>;

/**
 * 并发控制器接口
 */
export interface IConcurrencyController<T, R> {
  enqueue(item: T, priority?: number): Promise<R>;
  getStatus(): ConcurrencyStatus;
  pause(): void;
  resume(): void;
  drain(): Promise<void>;
  setProcessor(processor: TaskProcessor<T, R>): void;
}

/**
 * 增强的并发控制器
 * 
 * 特性：
 * - 优先级队列：高优先级任务优先处理
 * - 超时保护：任务超时自动取消
 * - 背压机制：队列使用率过高时拒绝新任务
 * - 统计信息：处理时间、成功/失败计数等
 */
export class ConcurrencyController<T, R> implements IConcurrencyController<T, R> {
  private config: ConcurrencyConfig;
  private processor: TaskProcessor<T, R> | null = null;

  // 队列和状态
  private queue: QueuedTask<T, R>[] = [];
  private activeCount = 0;
  private isPaused = false;
  private isBackpressureActive = false;

  // 统计信息
  private totalProcessed = 0;
  private totalDropped = 0;
  private totalTimedOut = 0;
  private processingTimes: number[] = [];
  private readonly MAX_PROCESSING_TIME_SAMPLES = 100;

  constructor(config?: Partial<ConcurrencyConfig>) {
    this.config = { ...DEFAULT_CONCURRENCY_CONFIG, ...config };
  }

  /**
   * 设置任务处理器
   */
  setProcessor(processor: TaskProcessor<T, R>): void {
    this.processor = processor;
  }

  /**
   * 将任务加入队列
   * @param item 任务项
   * @param priority 优先级（数字越小优先级越高，默认 5）
   * @returns Promise，任务完成时 resolve
   */
  async enqueue(item: T, priority: number = 5): Promise<R> {
    if (!this.processor) {
      throw new Error('Task processor not set. Call setProcessor() first.');
    }

    // 检查背压
    if (this.config.enableBackpressure && this.isBackpressureTriggered()) {
      this.isBackpressureActive = true;
      // 只有优先级较低的任务会被背压拒绝 (默认优先级为 5)
      // 如果优先级更高 (数字更小)，则允许尝试入队或替换
      if (priority > 5) {
        logger.warn(`Backpressure active: rejecting low priority task (${priority}), queue usage ${this.getQueueUsagePercent().toFixed(1)}%`);
        throw new Error('Backpressure active: system overloaded, please retry later');
      }
      logger.debug(`Backpressure active: allowing high priority task (${priority}) to proceed`);
    } else {
      this.isBackpressureActive = false;
    }

    // 检查队列是否已满
    if (this.queue.length >= this.config.maxQueueSize) {
      if (this.config.enablePriorityQueue) {
        // 优先级队列模式：尝试替换低优先级任务
        const lowestPriorityIndex = this.findLowestPriorityIndex();
        if (lowestPriorityIndex !== -1 && this.queue[lowestPriorityIndex].priority > priority) {
          // 新任务优先级更高，替换最低优先级任务
          const dropped = this.queue.splice(lowestPriorityIndex, 1)[0];
          this.clearTaskTimeout(dropped);
          dropped.reject(new Error('Task dropped: replaced by higher priority task'));
          this.totalDropped++;
          logger.info(`Task dropped (priority ${dropped.priority}) to make room for higher priority task (${priority})`);
        } else {
          // 新任务优先级不够高，拒绝
          this.totalDropped++;
          throw new Error(`Queue full (${this.config.maxQueueSize}), task priority (${priority}) not high enough`);
        }
      } else {
        // 非优先级模式：直接拒绝
        this.totalDropped++;
        throw new Error(`Queue full (${this.config.maxQueueSize})`);
      }
    }

    return new Promise<R>((resolve, reject) => {
      const task: QueuedTask<T, R> = {
        item,
        priority,
        enqueuedAt: Date.now(),
        timeout: this.config.taskTimeout,
        resolve,
        reject,
      };

      // 设置超时
      task.timeoutHandle = setTimeout(() => {
        this.handleTaskTimeout(task);
      }, this.config.taskTimeout);

      // 插入队列（按优先级排序）
      if (this.config.enablePriorityQueue) {
        this.insertByPriority(task);
      } else {
        this.queue.push(task);
      }

      logger.debug(`Task enqueued: priority=${priority}, queueSize=${this.queue.length}, active=${this.activeCount}`);

      // 尝试处理队列
      this.processQueue();
    });
  }

  /**
   * 获取并发状态
   */
  getStatus(): ConcurrencyStatus {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      queueCapacity: this.config.maxQueueSize,
      queueUsagePercent: this.getQueueUsagePercent(),
      isPaused: this.isPaused,
      isBackpressureActive: this.config.enableBackpressure && this.isBackpressureTriggered(),
      avgProcessingTimeMs: this.getAvgProcessingTime(),
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      totalTimedOut: this.totalTimedOut,
    };
  }

  /**
   * 暂停处理
   */
  pause(): void {
    this.isPaused = true;
    logger.info('ConcurrencyController paused');
  }

  /**
   * 恢复处理
   */
  resume(): void {
    this.isPaused = false;
    logger.info('ConcurrencyController resumed');
    this.processQueue();
  }

  /**
   * 等待所有任务完成
   */
  async drain(): Promise<void> {
    logger.info(`Draining queue: ${this.queue.length} queued, ${this.activeCount} active`);

    // 等待所有活跃任务和队列任务完成
    while (this.activeCount > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info('Queue drained');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ConcurrencyConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('ConcurrencyController config updated:', this.config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): ConcurrencyConfig {
    return { ...this.config };
  }

  // ==================== 私有方法 ====================

  /**
   * 处理队列中的任务
   */
  private processQueue(): void {
    if (this.isPaused) {
      return;
    }

    while (this.activeCount < this.config.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.processTask(task);
      }
    }
  }

  /**
   * 处理单个任务
   */
  private async processTask(task: QueuedTask<T, R>): Promise<void> {
    this.activeCount++;
    const startTime = Date.now();

    try {
      // 清除超时定时器（任务开始处理）
      this.clearTaskTimeout(task);

      // 创建新的处理超时
      const timeoutPromise = new Promise<never>((_, reject) => {
        task.timeoutHandle = setTimeout(() => {
          reject(new Error(`Task processing timeout after ${this.config.taskTimeout}ms`));
        }, this.config.taskTimeout);
      });

      // 执行任务（带超时）
      const result = await Promise.race([
        this.processor!(task.item),
        timeoutPromise,
      ]);

      // 清除处理超时
      this.clearTaskTimeout(task);

      // 记录处理时间
      this.recordProcessingTime(Date.now() - startTime);
      this.totalProcessed++;

      task.resolve(result);
    } catch (error) {
      this.clearTaskTimeout(task);

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout')) {
        this.totalTimedOut++;
        logger.warn(`Task timed out after ${Date.now() - startTime}ms`);
      }

      task.reject(error instanceof Error ? error : new Error(errorMessage));
    } finally {
      this.activeCount--;
      // 继续处理队列
      this.processQueue();
    }
  }

  /**
   * 处理任务超时（在队列中等待超时）
   */
  private handleTaskTimeout(task: QueuedTask<T, R>): void {
    const index = this.queue.indexOf(task);
    if (index !== -1) {
      this.queue.splice(index, 1);
      this.totalTimedOut++;
      const waitTime = Date.now() - task.enqueuedAt;
      logger.warn(`Task timed out while waiting in queue (waited ${waitTime}ms)`);
      task.reject(new Error(`Task timed out while waiting in queue (${waitTime}ms)`));
    }
  }

  /**
   * 清除任务超时定时器
   */
  private clearTaskTimeout(task: QueuedTask<T, R>): void {
    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = undefined;
    }
  }

  /**
   * 按优先级插入任务
   */
  private insertByPriority(task: QueuedTask<T, R>): void {
    // 找到第一个优先级比当前任务低的位置
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > task.priority) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, task);
  }

  /**
   * 找到最低优先级任务的索引
   */
  private findLowestPriorityIndex(): number {
    if (this.queue.length === 0) return -1;

    let lowestIndex = 0;
    let lowestPriority = this.queue[0].priority;

    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority > lowestPriority) {
        lowestPriority = this.queue[i].priority;
        lowestIndex = i;
      }
    }

    return lowestIndex;
  }

  /**
   * 检查是否触发背压
   */
  private isBackpressureTriggered(): boolean {
    const usagePercent = this.getQueueUsagePercent() / 100;
    return usagePercent >= this.config.backpressureThreshold;
  }

  /**
   * 获取队列使用率百分比
   */
  private getQueueUsagePercent(): number {
    return (this.queue.length / this.config.maxQueueSize) * 100;
  }

  /**
   * 记录处理时间
   */
  private recordProcessingTime(timeMs: number): void {
    this.processingTimes.push(timeMs);
    if (this.processingTimes.length > this.MAX_PROCESSING_TIME_SAMPLES) {
      this.processingTimes.shift();
    }
  }

  /**
   * 获取平均处理时间
   */
  private getAvgProcessingTime(): number {
    if (this.processingTimes.length === 0) return 0;
    const sum = this.processingTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.processingTimes.length);
  }
}

/**
 * 创建并发控制器实例
 */
export function createConcurrencyController<T, R>(
  processor: TaskProcessor<T, R>,
  config?: Partial<ConcurrencyConfig>
): ConcurrencyController<T, R> {
  const controller = new ConcurrencyController<T, R>(config);
  controller.setProcessor(processor);
  return controller;
}
