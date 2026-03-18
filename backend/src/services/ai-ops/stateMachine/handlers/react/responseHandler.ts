/**
 * ResponseHandler - 响应组装状态处理器
 *
 * 从 StateContext 中读取各阶段数据，组装 ReActLoopResult 并写入 StateContext。
 *
 * 需求: 3.9
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';

export interface ResponseHandlerDeps {
  responseAssembler?: {
    assemble(params: {
      finalAnswer: string;
      steps: unknown[];
      iterations: number;
      routingPath: string;
      validationResult?: unknown;
      reflectionResult?: unknown;
      knowledgeReferences?: unknown[];
    }): unknown;
  };
}

export class ResponseHandler implements StateHandler {
  readonly name = 'responseHandler';

  constructor(private deps: ResponseHandlerDeps = {}) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const finalAnswer = context.get<string>('finalAnswer') ?? '';
    const steps = context.get<unknown[]>('steps') ?? [];
    const iterations = context.get<number>('iterations') ?? 0;
    const routingPath = context.get<string>('routingPath') ?? 'reactLoop';
    const validationResult = context.get<unknown>('validationResult');
    const reflectionResult = context.get<unknown>('reflectionResult');
    const knowledgeReferences = context.get<unknown[]>('knowledgeReferences') ?? [];

    // Fix #1: Read extra SARC fields from context for output parity with legacy path
    const reachedMaxIterations = context.get<boolean>('reachedMaxIterations') ?? false;
    const totalDuration = context.get<number>('totalDuration') ?? 0;
    const loopRagContext = context.get<unknown>('loopRagContext');
    const intelligentRetrievalResult = context.get<unknown>('intelligentRetrievalResult');
    const loopValidationResult = context.get<unknown>('loopValidationResult');
    const fallbackInfo = context.get<unknown>('fallbackInfo');
    const skill = context.get<unknown>('skill');
    const switchSuggestion = context.get<unknown>('switchSuggestion');
    const skillMetrics = context.get<unknown>('skillMetrics');
    const skillKnowledgeResult = context.get<unknown>('skillKnowledgeResult');

    let result: unknown;

    if (this.deps.responseAssembler) {
      result = this.deps.responseAssembler.assemble({
        finalAnswer,
        steps,
        iterations,
        routingPath,
        validationResult,
        reflectionResult,
        knowledgeReferences,
      });
    } else {
      // Default assembly when no custom assembler is provided
      // Fix #1: Include all SARC fields for output parity with legacy path
      result = {
        finalAnswer,
        steps,
        iterations,
        reachedMaxIterations,
        totalDuration,
        routingPath,
        validationResult: loopValidationResult ?? validationResult,
        reflectionResult,
        knowledgeReferences,
        ragContext: loopRagContext,
        intelligentRetrievalResult,
        fallbackInfo,
        ...(skill !== undefined && { skill }),
        ...(switchSuggestion !== undefined && { switchSuggestion }),
        ...(skillMetrics !== undefined && { skillMetrics }),
        ...(skillKnowledgeResult !== undefined && { skillKnowledgeResult }),
      };
    }

    context.set('result', result);

    return { outcome: 'success', context };
  }
}
