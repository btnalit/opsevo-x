/**
 * Iteration 编排流程状态处理器
 *
 * 包含 Iteration Loop 的 4 个核心状态 Handler：
 * - ExecuteHandler: 执行修复计划步骤
 * - EvaluateHandler: 调用 CriticService 评估执行效果
 * - ReflectHandler: 调用 ReflectorService 生成反思和改进建议
 * - IterationDecideHandler: 根据评估和反思结果决定继续/升级/完成，达到最大迭代次数时强制终止
 *
 * 需求: 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { StateHandler, StateContext, TransitionResult } from '../types';
import { CapabilityName } from '../../degradationManager';

// ============================================================
// Dependency interfaces
// ============================================================

export interface ExecuteHandlerDeps {
  executor: {
    executeStep(plan: unknown, iteration: number): Promise<{
      results: unknown[];
      preMetrics?: unknown;
      postMetrics?: unknown;
    }>;
  };
}

export interface EvaluateHandlerDeps {
  criticService: {
    evaluate(executionResults: unknown[], metrics?: { pre?: unknown; post?: unknown }): Promise<unknown>;
  };
}

export interface ReflectHandlerDeps {
  reflectorService: {
    reflect(evaluation: unknown, executionResults: unknown[]): Promise<unknown>;
  };
}

export interface IterationDecideHandlerDeps {
  decisionService: {
    decide(evaluation: unknown, reflection: unknown): Promise<{
      action: 'continue' | 'escalate' | 'complete';
      reason?: string;
    }>;
  };
}

// ============================================================
// ExecuteHandler
// ============================================================

/**
 * Execute 状态处理器
 *
 * 执行修复计划中的步骤，将执行结果写入 StateContext。
 *
 * 需求: 5.2
 */
export class IterationExecuteHandler implements StateHandler {
  readonly name = 'iterationExecuteHandler';
  readonly capability: CapabilityName = 'selfHealing';

  constructor(private deps: ExecuteHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const currentPlan = context.get<unknown>('currentPlan');
    if (!currentPlan) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing currentPlan in context' },
      };
    }

    const currentIteration = context.get<number>('currentIteration') ?? 0;
    const result = await this.deps.executor.executeStep(currentPlan, currentIteration);

    context.set('executionResults', result.results);
    context.set('preMetrics', result.preMetrics ?? null);
    context.set('postMetrics', result.postMetrics ?? null);

    return { outcome: 'success', context };
  }
}

// ============================================================
// EvaluateHandler
// ============================================================

/**
 * Evaluate 状态处理器
 *
 * 调用 CriticService 评估执行效果，生成 EvaluationReport。
 *
 * 需求: 5.3
 */
export class IterationEvaluateHandler implements StateHandler {
  readonly name = 'iterationEvaluateHandler';
  readonly capability: CapabilityName = 'reflection';

  constructor(private deps: EvaluateHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const executionResults = context.get<unknown[]>('executionResults');
    if (!executionResults) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing executionResults in context' },
      };
    }

    const preMetrics = context.get<unknown>('preMetrics');
    const postMetrics = context.get<unknown>('postMetrics');

    const evaluation = await this.deps.criticService.evaluate(
      executionResults,
      { pre: preMetrics, post: postMetrics },
    );

    context.set('evaluation', evaluation);

    return { outcome: 'success', context };
  }
}

// ============================================================
// ReflectHandler
// ============================================================

/**
 * Reflect 状态处理器
 *
 * 调用 ReflectorService 生成反思结果和改进建议。
 *
 * 需求: 5.4
 */
export class IterationReflectHandler implements StateHandler {
  readonly name = 'iterationReflectHandler';
  readonly capability: CapabilityName = 'reflection';

  constructor(private deps: ReflectHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const evaluation = context.get<unknown>('evaluation');
    const executionResults = context.get<unknown[]>('executionResults');

    if (!evaluation || !executionResults) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing evaluation or executionResults in context' },
      };
    }

    const reflection = await this.deps.reflectorService.reflect(evaluation, executionResults);
    context.set('reflection', reflection);

    return { outcome: 'success', context };
  }
}

// ============================================================
// IterationDecideHandler
// ============================================================

/**
 * Decide 状态处理器
 *
 * 根据评估和反思结果决定下一步动作：
 * - outcome 'continue': 继续迭代（转移回 Execute）
 * - outcome 'escalate': 升级处理（转移到 Escalation）
 * - outcome 'complete': 完成（转移到 Completed 终止状态）
 *
 * 当迭代次数达到 maxIterations 时，强制返回 'complete' 并记录超时原因。
 *
 * 需求: 5.5, 5.6
 */
export class IterationDecideHandler implements StateHandler {
  readonly name = 'iterationDecideHandler';
  readonly capability: CapabilityName = 'selfHealing';

  constructor(private deps: IterationDecideHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const currentIteration = (context.get<number>('currentIteration') ?? 0) + 1;
    const maxIterations = context.get<number>('maxIterations') ?? 5;

    context.set('currentIteration', currentIteration);

    // 需求 5.6: 达到最大迭代次数时强制终止
    if (currentIteration >= maxIterations) {
      context.set('nextAction', 'complete');
      return {
        outcome: 'complete',
        context,
        metadata: { reason: 'maxIterations reached', currentIteration, maxIterations },
      };
    }

    const evaluation = context.get<unknown>('evaluation');
    const reflection = context.get<unknown>('reflection');

    if (!evaluation || !reflection) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing evaluation or reflection in context' },
      };
    }

    // 需求 5.5: 根据评估和反思结果决定下一步
    const decision = await this.deps.decisionService.decide(evaluation, reflection);

    context.set('nextAction', decision.action);

    if (decision.action === 'escalate') {
      return {
        outcome: 'escalate',
        context,
        metadata: { reason: decision.reason },
      };
    }

    if (decision.action === 'complete') {
      return {
        outcome: 'complete',
        context,
        metadata: { reason: decision.reason ?? 'task completed successfully' },
      };
    }

    // Default: continue iteration
    return {
      outcome: 'continue',
      context,
      metadata: { reason: decision.reason ?? 'continuing iteration', currentIteration, maxIterations },
    };
  }
}
