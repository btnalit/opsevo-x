/**
 * AlertPipelineAdapter - 将 AlertPipeline 包装为 StateHandler
 *
 * 适配器模式实现，将现有的 AlertPipeline 包装为状态机的 StateHandler 接口，
 * 实现 StateContext ↔ SyslogEvent/AlertEvent 格式转换。
 * 不修改 AlertPipeline 内部实现。
 *
 * 需求: 9.1, 9.2
 */

import { StateHandler, StateContext, TransitionResult } from '../types';
import { AlertPipeline } from '../../alertPipeline';
import { SyslogEvent, AlertEvent } from '../../../../types/ai-ops';

/**
 * AlertPipelineAdapter - 将 AlertPipeline 包装为 StateHandler
 *
 * 数据映射:
 *   StateContext → AlertPipeline 输入:
 *     context.get('rawEvent') → SyslogEvent | AlertEvent
 *
 *   AlertPipeline 输出 → StateContext:
 *     PipelineResult              → context.set('pipelineResult', ...)
 *     result.event                → context.set('normalizedEvent', ...)
 *     result.analysis             → context.set('rootCauseAnalysis', ...)
 *     result.decision             → context.set('decision', ...)
 *     result.plan                 → context.set('remediationPlan', ...)
 *     result.filterResult         → context.set('filterResult', ...)
 */
export class AlertPipelineAdapter implements StateHandler {
  readonly name = 'AlertPipelineAdapter';

  private readonly pipeline: AlertPipeline;

  constructor(pipeline: AlertPipeline) {
    this.pipeline = pipeline;
  }

  /**
   * 判断上下文是否包含 AlertPipeline 所需的必要数据
   */
  canHandle(context: StateContext): boolean {
    const rawEvent = context.get<SyslogEvent | AlertEvent>('rawEvent');
    return rawEvent !== undefined;
  }

  /**
   * 执行适配：从 StateContext 提取 rawEvent，调用 AlertPipeline.process，
   * 将结果写回 StateContext
   */
  async handle(context: StateContext): Promise<TransitionResult> {
    try {
      // === StateContext → AlertPipeline 输入格式转换 ===
      const rawEvent = context.get<SyslogEvent | AlertEvent>('rawEvent')!;

      // === 调用 AlertPipeline（不修改其内部实现） ===
      const result = await this.pipeline.process(rawEvent);

      // === AlertPipeline 输出 → StateContext 格式转换 ===
      context.set('pipelineResult', result);
      context.set('normalizedEvent', result.event);

      if (result.analysis) {
        context.set('rootCauseAnalysis', result.analysis);
      }
      if (result.decision) {
        context.set('decision', result.decision);
      }
      if (result.plan) {
        context.set('remediationPlan', result.plan);
      }
      if (result.filterResult) {
        context.set('filterResult', result.filterResult);
      }

      return {
        outcome: result.filtered ? 'filtered' : 'success',
        context,
      };
    } catch (error) {
      context.set('error', error instanceof Error ? error.message : String(error));
      return { outcome: 'error', context };
    }
  }
}
