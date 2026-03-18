/**
 * ReActLoopHandler - ReAct 推理循环状态处理器
 *
 * 执行 Thought → Action → Observation 循环（包装现有核心逻辑），
 * 将 steps、finalAnswer、iterations 写入 StateContext。
 *
 * 需求: 3.7
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface ReActLoopHandlerDeps {
  reactLoopExecutor: {
    executeLoop(
      message: string,
      intentAnalysis: unknown,
      conversationContext: unknown,
      executionContext: unknown,
    ): Promise<{
      steps: unknown[];
      finalAnswer: string;
      iterations: number;
      // Fix #1 & #7: Extra fields from SkillAwareReActResult
      reachedMaxIterations?: boolean;
      totalDuration?: number;
      ragContext?: unknown;
      intelligentRetrievalResult?: unknown;
      validationResult?: unknown;
      knowledgeReferences?: unknown[];
      fallbackInfo?: unknown;
      skill?: unknown;
      switchSuggestion?: unknown;
      skillMetrics?: unknown;
      skillKnowledgeResult?: unknown;
      [key: string]: unknown;
    }>;
  };
}

export class ReActLoopHandler implements StateHandler {
  readonly name = 'reactLoopHandler';
  readonly capability: CapabilityName = 'planRevision';

  constructor(private deps: ReActLoopHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const message = context.get<string>('message') ?? '';
    const intentAnalysis = context.get<unknown>('intentAnalysis');
    const conversationContext = context.get<unknown>('conversationContext');
    const executionContext = context.get<unknown>('executionContext');

    const result = await this.deps.reactLoopExecutor.executeLoop(
      message,
      intentAnalysis,
      conversationContext,
      executionContext,
    );

    context.set('steps', result.steps);
    context.set('finalAnswer', result.finalAnswer);
    context.set('iterations', result.iterations);

    // Fix #1 & #7: Transparently pass all extra SARC fields into context
    // so ResponseHandler can include them in the assembled result.
    if (result.reachedMaxIterations !== undefined) {
      context.set('reachedMaxIterations', result.reachedMaxIterations);
    }
    if (result.totalDuration !== undefined) {
      context.set('totalDuration', result.totalDuration);
    }
    if (result.ragContext !== undefined) {
      context.set('loopRagContext', result.ragContext);
    }
    if (result.intelligentRetrievalResult !== undefined) {
      context.set('intelligentRetrievalResult', result.intelligentRetrievalResult);
    }
    if (result.validationResult !== undefined) {
      context.set('loopValidationResult', result.validationResult);
    }
    if (result.knowledgeReferences !== undefined) {
      context.set('knowledgeReferences', result.knowledgeReferences);
    }
    if (result.fallbackInfo !== undefined) {
      context.set('fallbackInfo', result.fallbackInfo);
    }
    if (result.skill !== undefined) {
      context.set('skill', result.skill);
    }
    if (result.switchSuggestion !== undefined) {
      context.set('switchSuggestion', result.switchSuggestion);
    }
    if (result.skillMetrics !== undefined) {
      context.set('skillMetrics', result.skillMetrics);
    }
    if (result.skillKnowledgeResult !== undefined) {
      context.set('skillKnowledgeResult', result.skillKnowledgeResult);
    }

    return { outcome: 'success', context };
  }
}
