/**
 * 中间件管道 — 按优先级顺序执行已注册的中间件链
 *
 * 设计要点：
 * - 按 priority 升序执行（数字越小越先执行）
 * - 同名中间件注册时替换旧的
 * - 单个中间件抛异常不影响其他中间件和主循环
 * - 中间件返回 null/undefined 时使用上一步的 output 继续
 * - 空管道直接返回原始输入（恒等行为）
 *
 * Requirements: 1.1, 1.2, 1.3, 1.6, 1.8
 */

import type { ParsedLLMOutput } from '../llmOutputParser';
import type { MiddlewareContext, MiddlewareEntry, ReActMiddleware } from './types';
import { logger } from '../../../../utils/logger';

export class MiddlewarePipeline {
  private entries: MiddlewareEntry[] = [];

  /**
   * 注册中间件，按 priority 升序排列（数字越小越先执行）
   * 如果已存在同名中间件，替换之
   */
  register(middleware: ReActMiddleware, priority: number): void {
    if (!middleware) {
      throw new TypeError('middleware must not be null or undefined');
    }

    // 同名替换
    const existingIdx = this.entries.findIndex(e => e.middleware.name === middleware.name);
    if (existingIdx !== -1) {
      this.entries[existingIdx] = { middleware, priority };
    } else {
      this.entries.push({ middleware, priority });
    }

    // 按优先级升序排序
    this.entries.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 按名称移除中间件
   * @returns 是否成功移除
   */
  unregister(name: string): boolean {
    const idx = this.entries.findIndex(e => e.middleware.name === name);
    if (idx === -1) return false;
    this.entries.splice(idx, 1);
    return true;
  }

  /**
   * 按优先级顺序执行所有中间件
   * 如果某个中间件抛出异常，记录日志并跳过，继续下一个
   * 如果中间件返回 null/undefined，使用上一步的 output 继续
   * @returns 经过所有中间件处理后的 ParsedLLMOutput
   */
  async execute(output: ParsedLLMOutput, context: MiddlewareContext): Promise<ParsedLLMOutput> {
    let current = output;

    for (const entry of this.entries) {
      try {
        const result = await entry.middleware.process(current, context);
        // 防御性处理：null/undefined 视为未修改
        if (result != null) {
          current = result;
        }
      } catch (error) {
        logger.warn(`Middleware "${entry.middleware.name}" threw an error, skipping`, {
          error: error instanceof Error ? error.message : String(error),
          middlewareName: entry.middleware.name,
          priority: entry.priority,
        });
        // 跳过该中间件，继续下一个
      }
    }

    return current;
  }

  /**
   * 获取已注册中间件数量
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * 检查是否有已注册的中间件
   */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }
}
