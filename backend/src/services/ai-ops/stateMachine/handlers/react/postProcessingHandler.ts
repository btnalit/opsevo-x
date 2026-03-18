/**
 * PostProcessingHandler - 后处理状态处理器
 *
 * 依次执行 OutputValidator、ReflectorService、ContinuousLearner、ToolFeedbackCollector，
 * 将 validationResult 和 reflectionResult 写入 StateContext。
 *
 * 需求: 3.8
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface PostProcessingHandlerDeps {
  outputValidator: {
    validate(params: { finalAnswer: string; steps: unknown[] }): Promise<unknown>;
  };
  reflectorService: {
    reflect(params: { steps: unknown[]; finalAnswer: string }): Promise<unknown>;
  };
  continuousLearner: {
    learn(params: { steps: unknown[]; finalAnswer: string; reflectionResult: unknown }): Promise<void>;
  };
  toolFeedbackCollector: {
    collect(params: { steps: unknown[] }): Promise<void>;
  };
}

export class PostProcessingHandler implements StateHandler {
  readonly name = 'postProcessingHandler';
  readonly capability: CapabilityName = 'reflection';

  constructor(private deps: PostProcessingHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const finalAnswer = context.get<string>('finalAnswer') ?? '';
    const steps = context.get<unknown[]>('steps') ?? [];

    const validationResult = await this.deps.outputValidator.validate({
      finalAnswer,
      steps,
    });
    context.set('validationResult', validationResult);

    const reflectionResult = await this.deps.reflectorService.reflect({
      steps,
      finalAnswer,
    });
    context.set('reflectionResult', reflectionResult);

    await this.deps.continuousLearner.learn({
      steps,
      finalAnswer,
      reflectionResult,
    });

    await this.deps.toolFeedbackCollector.collect({ steps });

    return { outcome: 'success', context };
  }
}
