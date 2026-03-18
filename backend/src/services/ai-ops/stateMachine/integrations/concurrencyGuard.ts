/**
 * ConcurrencyGuard - 并发控制集成
 *
 * 包装 ConcurrencyController，为状态机执行提供并发限制、等待队列和超时管理。
 *
 * 需求: 11.1, 11.2, 11.3, 11.4
 * - 11.1: 每个请求创建独立执行实例，并发执行互不阻塞
 * - 11.2: 最大并发执行数配置，超过限制进入等待队列
 * - 11.3: 等待队列超时拒绝请求并返回 TimeoutError
 * - 11.4: 当前并发执行数和队列长度实时查询
 */

import { ExecutionResult } from '../types';

export interface ConcurrencyGuardConfig {
  /** 最大并发执行数，默认 5 */
  maxConcurrent: number;
  /** 队列等待超时（毫秒），默认 30000 */
  queueTimeout: number;
  /** 最大队列大小，默认 100 */
  maxQueueSize: number;
}

const DEFAULT_CONFIG: ConcurrencyGuardConfig = {
  maxConcurrent: 5,
  queueTimeout: 30000,
  maxQueueSize: 100,
};

interface QueuedRequest {
  executeFn: () => Promise<ExecutionResult>;
  resolve: (result: ExecutionResult) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

/**
 * ConcurrencyGuard provides concurrency control for state machine executions.
 * It limits concurrent executions, queues excess requests, and rejects
 * queued requests that wait longer than the configured timeout.
 *
 * Unlike ConcurrencyController which uses a single taskTimeout for both
 * queue waiting and processing, ConcurrencyGuard separates these concerns:
 * - queueTimeout: only applies while a request is waiting in the queue
 * - No processing timeout: execution functions manage their own timeouts
 */
export class ConcurrencyGuard {
  private readonly config: ConcurrencyGuardConfig;
  private activeCount = 0;
  private readonly queue: QueuedRequest[] = [];

  constructor(config?: Partial<ConcurrencyGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute a function with concurrency control.
   * If the concurrency limit is reached, the request enters a wait queue.
   * If the wait exceeds queueTimeout, a TimeoutError is thrown.
   */
  async execute(executeFn: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    // If under the concurrency limit, execute immediately
    if (this.activeCount < this.config.maxConcurrent) {
      return this.runTask(executeFn);
    }

    // Check queue capacity
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new Error(`Queue full (${this.config.maxQueueSize})`);
    }

    // Queue the request and wait
    return new Promise<ExecutionResult>((resolve, reject) => {
      const request: QueuedRequest = {
        executeFn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      // Set queue wait timeout
      request.timeoutHandle = setTimeout(() => {
        const index = this.queue.indexOf(request);
        if (index !== -1) {
          this.queue.splice(index, 1);
          const waitTime = Date.now() - request.enqueuedAt;
          reject(new Error(`Task timed out while waiting in queue (${waitTime}ms)`));
        }
      }, this.config.queueTimeout);

      this.queue.push(request);
    });
  }

  /**
   * Get current concurrency status.
   * Returns active, queued, and maxConcurrent counts.
   */
  getConcurrencyStatus(): { active: number; queued: number; maxConcurrent: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  private async runTask(executeFn: () => Promise<ExecutionResult>): Promise<ExecutionResult> {
    this.activeCount++;
    try {
      return await executeFn();
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.activeCount < this.config.maxConcurrent) {
      const next = this.queue.shift()!;
      // Clear the queue timeout since the task is now being processed
      if (next.timeoutHandle) {
        clearTimeout(next.timeoutHandle);
      }
      this.runTask(next.executeFn).then(next.resolve, next.reject);
    }
  }
}
