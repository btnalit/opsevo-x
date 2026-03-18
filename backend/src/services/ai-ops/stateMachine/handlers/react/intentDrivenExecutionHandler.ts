/**
 * IntentDrivenExecutionHandler - 意图驱动执行状态处理器
 *
 * 调用 IntentDrivenExecutor 执行高置信度意图自动化流程，
 * 将执行结果写入 StateContext。
 *
 * 需求: 3.6
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface IntentDrivenExecutionHandlerDeps {
  intentDrivenExecutor: {
    execute(params: {
      message: string;
      parsedIntent: unknown;
      intentAnalysis: unknown;
      conversationContext?: unknown;
      executionContext?: unknown;
    }): Promise<{
      steps: unknown[];
      finalAnswer: string;
      iterations: number;
    }>;
  };
}

export class IntentDrivenExecutionHandler implements StateHandler {
  readonly name = 'intentDrivenExecutionHandler';
  readonly capability: CapabilityName = 'intentDriven';

  constructor(private deps: IntentDrivenExecutionHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const message = context.get<string>('message') ?? '';
    const parsedIntent = context.get<unknown>('parsedIntent');
    const intentAnalysis = context.get<unknown>('intentAnalysis');
    const conversationContext = context.get<unknown>('conversationContext');
    const executionContext = context.get<unknown>('executionContext');

    const result = await this.deps.intentDrivenExecutor.execute({
      message,
      parsedIntent,
      intentAnalysis,
      conversationContext,
      executionContext,
    });

    context.set('steps', result.steps);
    context.set('finalAnswer', result.finalAnswer);
    context.set('iterations', result.iterations);

    return { outcome: 'success', context };
  }
}
