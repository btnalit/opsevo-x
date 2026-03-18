/**
 * FastPathHandler - 快速路径状态处理器
 *
 * 调用 FastPathRouter 生成直接回答，将 finalAnswer 写入 StateContext。
 *
 * 需求: 3.5
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface FastPathHandlerDeps {
  fastPathRouter: {
    generateAnswer(params: {
      message: string;
      ragContext: unknown;
      formattedKnowledge: unknown[];
      conversationContext?: unknown;
    }): Promise<string>;
  };
}

export class FastPathHandler implements StateHandler {
  readonly name = 'fastPathHandler';
  readonly capability: CapabilityName = 'experience';

  constructor(private deps: FastPathHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const message = context.get<string>('message') ?? '';
    const ragContext = context.get<unknown>('ragContext');
    const formattedKnowledge = context.get<unknown[]>('formattedKnowledge') ?? [];
    const conversationContext = context.get<unknown>('conversationContext');

    const finalAnswer = await this.deps.fastPathRouter.generateAnswer({
      message,
      ragContext,
      formattedKnowledge,
      conversationContext,
    });

    context.set('finalAnswer', finalAnswer);

    return { outcome: 'success', context };
  }
}
