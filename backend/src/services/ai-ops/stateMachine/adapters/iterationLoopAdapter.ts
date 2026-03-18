/**
 * IterationLoopAdapter - 将 IterationLoop 包装为 StateHandler
 *
 * 适配器模式实现，将现有的 IterationLoop 包装为状态机的 StateHandler 接口，
 * 实现 StateContext ↔ IterationState + RemediationPlan 格式转换。
 * 不修改 IterationLoop 内部实现。
 *
 * 需求: 9.1, 9.2
 */

import { StateHandler, StateContext, TransitionResult } from '../types';
import { IterationLoop } from '../../iterationLoop';
import { UnifiedEvent, Decision, RemediationPlan } from '../../../../types/ai-ops';

/**
 * IterationLoopAdapter - 将 IterationLoop 包装为 StateHandler
 *
 * 数据映射:
 *   StateContext → IterationLoop 输入:
 *     context.get('alertEvent')   → UnifiedEvent
 *     context.get('decision')     → Decision
 *     context.get('currentPlan')  → RemediationPlan
 *
 *   IterationLoop 输出 → StateContext:
 *     iterationId                 → context.set('iterationId', ...)
 *     IterationState              → context.set('iterationState', ...)
 *     iterationResult summary     → context.set('iterationResult', ...)
 *     state.evaluations           → context.set('evaluations', ...)
 *     state.reflections           → context.set('reflections', ...)
 */
export class IterationLoopAdapter implements StateHandler {
  readonly name = 'IterationLoopAdapter';

  private readonly iterationLoop: IterationLoop;

  constructor(iterationLoop: IterationLoop) {
    this.iterationLoop = iterationLoop;
  }

  /**
   * 判断上下文是否包含 IterationLoop 所需的必要数据
   */
  canHandle(context: StateContext): boolean {
    const alertEvent = context.get<UnifiedEvent>('alertEvent');
    const decision = context.get<Decision>('decision');
    const currentPlan = context.get<RemediationPlan>('currentPlan');
    return alertEvent !== undefined && decision !== undefined && currentPlan !== undefined;
  }

  /**
   * 执行适配：从 StateContext 提取数据，调用 IterationLoop.start，
   * 将结果写回 StateContext
   */
  async handle(context: StateContext): Promise<TransitionResult> {
    try {
      // === StateContext → IterationLoop 输入格式转换 ===
      const alertEvent = context.get<UnifiedEvent>('alertEvent')!;
      const decision = context.get<Decision>('decision')!;
      const currentPlan = context.get<RemediationPlan>('currentPlan')!;

      // === 调用 IterationLoop（不修改其内部实现） ===
      const iterationId = await this.iterationLoop.start(alertEvent, decision, currentPlan);

      // === IterationLoop 输出 → StateContext 格式转换 ===
      context.set('iterationId', iterationId);

      // 获取迭代最终状态
      const iterationState = await this.iterationLoop.getState(iterationId);

      if (iterationState) {
        context.set('iterationState', iterationState);
        context.set('iterationResult', {
          iterationId,
          status: iterationState.status,
          iterations: iterationState.currentIteration,
          success: iterationState.status === 'completed',
        });

        if (iterationState.evaluations.length > 0) {
          context.set('evaluations', iterationState.evaluations);
        }
        if (iterationState.reflections.length > 0) {
          context.set('reflections', iterationState.reflections);
        }

        // Map iteration status to outcome
        return {
          outcome: this.mapStatusToOutcome(iterationState.status),
          context,
        };
      }

      return { outcome: 'success', context };
    } catch (error) {
      context.set('error', error instanceof Error ? error.message : String(error));
      return { outcome: 'error', context };
    }
  }

  /**
   * 将 IterationState.status 映射为 outcome 字符串
   */
  private mapStatusToOutcome(status: string): string {
    switch (status) {
      case 'completed':
        return 'success';
      case 'escalated':
        return 'escalated';
      case 'aborted':
        return 'aborted';
      default:
        return 'success';
    }
  }
}
