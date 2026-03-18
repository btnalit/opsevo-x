/**
 * StateExecutor - 状态执行器
 *
 * 负责执行 StateHandler，处理异常捕获和 canHandle 检查。
 * 需求: 1.4, 1.5, 1.7, 6.4
 */

import { StateHandler, StateContext, TransitionResult } from './types';

export class StateExecutor {
  /**
   * 执行指定的 StateHandler
   *
   * 1. 检查 handler.canHandle(context) — 若返回 false，返回 skipped outcome
   * 2. 调用 handler.handle(context) — 成功时返回 handler 的 TransitionResult
   * 3. 异常捕获 — handler 抛出异常时返回 error outcome 并附带错误元数据
   */
  async executeHandler(
    handler: StateHandler,
    context: StateContext,
  ): Promise<TransitionResult> {
    if (!handler.canHandle(context)) {
      return { outcome: 'skipped', context };
    }

    try {
      return await handler.handle(context);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        outcome: 'error',
        context,
        metadata: {
          error: error.message,
          errorName: error.name,
        },
      };
    }
  }
}
