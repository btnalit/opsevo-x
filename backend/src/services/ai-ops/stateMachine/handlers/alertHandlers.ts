/**
 * Alert 编排流程状态处理器
 *
 * 包含 Alert Pipeline 的 6 个核心状态 Handler：
 * - RateLimitHandler: 速率限制检查和 Syslog 聚合
 * - NormalizeHandler: 事件标准化为 UnifiedEvent
 * - DeduplicateHandler: 事件指纹去重
 * - FilterHandler: 噪声过滤
 * - AnalyzeHandler: 根因分析
 * - DecideHandler: 决策与动作执行
 *
 * 需求: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { StateHandler, StateContext, TransitionResult } from '../types';
import { CapabilityName } from '../../degradationManager';

// ============================================================
// Dependency interfaces
// ============================================================

export interface RateLimitHandlerDeps {
  rateLimiter: {
    check(event: unknown): Promise<{ passed: boolean; aggregation?: unknown }>;
  };
}

export interface NormalizeHandlerDeps {
  normalizer: {
    normalize(event: unknown): Promise<unknown>;
  };
}

export interface DeduplicateHandlerDeps {
  deduplicator: {
    checkDuplicate(event: unknown): Promise<{ isDuplicate: boolean }>;
  };
}

export interface FilterHandlerDeps {
  filter: {
    apply(event: unknown): Promise<{ filtered: boolean; reason?: string }>;
  };
}

export interface AnalyzeHandlerDeps {
  analyzer: {
    analyze(event: unknown): Promise<unknown>;
  };
}

export interface DecideHandlerDeps {
  decider: {
    decide(analysis: unknown, event: unknown): Promise<{
      decision: unknown;
      remediationPlan?: unknown;
    }>;
    executeDecision(decision: unknown, plan?: unknown, event?: unknown): Promise<void>;
  };
}


// ============================================================
// RateLimitHandler
// ============================================================

/**
 * RateLimit 状态处理器
 *
 * 执行速率限制检查和 Syslog 聚合。
 * - outcome 'passed': 通过速率限制
 * - outcome 'limited': 超过速率限制
 *
 * 需求: 4.2
 */
export class RateLimitHandler implements StateHandler {
  readonly name = 'rateLimitHandler';
  readonly capability: CapabilityName = 'proactiveOps';

  constructor(private deps: RateLimitHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const rawEvent = context.get<unknown>('rawEvent');
    if (!rawEvent) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing rawEvent in context' },
      };
    }

    const result = await this.deps.rateLimiter.check(rawEvent);

    context.set('rateLimitPassed', result.passed);
    context.set('aggregatedEvent', result.aggregation ?? null);

    return {
      outcome: result.passed ? 'passed' : 'limited',
      context,
    };
  }
}

// ============================================================
// NormalizeHandler
// ============================================================

/**
 * Normalize 状态处理器
 *
 * 将 SyslogEvent/AlertEvent 标准化为 UnifiedEvent。
 *
 * 需求: 4.3
 */
export class NormalizeHandler implements StateHandler {
  readonly name = 'normalizeHandler';
  readonly capability: CapabilityName = 'proactiveOps';

  constructor(private deps: NormalizeHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const rawEvent = context.get<unknown>('rawEvent');
    if (!rawEvent) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing rawEvent in context' },
      };
    }

    const normalizedEvent = await this.deps.normalizer.normalize(rawEvent);
    context.set('normalizedEvent', normalizedEvent);

    return { outcome: 'success', context };
  }
}

// ============================================================
// DeduplicateHandler
// ============================================================

/**
 * Deduplicate 状态处理器
 *
 * 检查事件指纹是否重复。
 * - outcome 'isDuplicate': 重复事件
 * - outcome 'isUnique': 非重复事件
 *
 * 需求: 4.4
 */
export class DeduplicateHandler implements StateHandler {
  readonly name = 'deduplicateHandler';
  readonly capability: CapabilityName = 'proactiveOps';

  constructor(private deps: DeduplicateHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const normalizedEvent = context.get<unknown>('normalizedEvent');
    if (!normalizedEvent) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing normalizedEvent in context' },
      };
    }

    const result = await this.deps.deduplicator.checkDuplicate(normalizedEvent);
    context.set('isDuplicate', result.isDuplicate);

    return {
      outcome: result.isDuplicate ? 'isDuplicate' : 'isUnique',
      context,
    };
  }
}

// ============================================================
// FilterHandler
// ============================================================

/**
 * Filter 状态处理器
 *
 * 应用噪声过滤规则。
 * - outcome 'isFiltered': 被过滤的事件
 * - outcome 'passed': 通过过滤的事件
 *
 * 需求: 4.5
 */
export class FilterHandler implements StateHandler {
  readonly name = 'filterHandler';
  readonly capability: CapabilityName = 'proactiveOps';

  constructor(private deps: FilterHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const normalizedEvent = context.get<unknown>('normalizedEvent');
    if (!normalizedEvent) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing normalizedEvent in context' },
      };
    }

    const result = await this.deps.filter.apply(normalizedEvent);
    context.set('filterResult', result);

    return {
      outcome: result.filtered ? 'isFiltered' : 'passed',
      context,
    };
  }
}

// ============================================================
// AnalyzeHandler
// ============================================================

/**
 * Analyze 状态处理器
 *
 * 执行根因分析，将 RootCauseAnalysis 写入 StateContext。
 *
 * 需求: 4.6
 */
export class AnalyzeHandler implements StateHandler {
  readonly name = 'analyzeHandler';
  readonly capability: CapabilityName = 'proactiveOps';

  constructor(private deps: AnalyzeHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const normalizedEvent = context.get<unknown>('normalizedEvent');
    if (!normalizedEvent) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing normalizedEvent in context' },
      };
    }

    const rootCauseAnalysis = await this.deps.analyzer.analyze(normalizedEvent);
    context.set('rootCauseAnalysis', rootCauseAnalysis);

    return { outcome: 'success', context };
  }
}

// ============================================================
// DecideHandler
// ============================================================

/**
 * Decide 状态处理器
 *
 * 根据分析结果生成决策并执行相应动作（通知、修复、忽略）。
 *
 * 需求: 4.7
 */
export class DecideHandler implements StateHandler {
  readonly name = 'decideHandler';
  readonly capability: CapabilityName = 'proactiveOps';

  constructor(private deps: DecideHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const rootCauseAnalysis = context.get<unknown>('rootCauseAnalysis');
    const normalizedEvent = context.get<unknown>('normalizedEvent');

    if (!rootCauseAnalysis || !normalizedEvent) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing rootCauseAnalysis or normalizedEvent in context' },
      };
    }

    const result = await this.deps.decider.decide(rootCauseAnalysis, normalizedEvent);
    const decision = result.decision;

    // 执行决策（通知、自动修复等）
    if (decision) {
      try {
        await this.deps.decider.executeDecision(decision, result.remediationPlan, normalizedEvent);
      } catch (error) {
        // 执行失败不阻断流程，决策引擎内部已处理失败状态
      }
    }

    context.set('decision', decision);
    context.set('remediationPlan', result.remediationPlan ?? null);
    context.set('pipelineResult', {
      decision,
      event: normalizedEvent,
      analysis: rootCauseAnalysis,
    });

    return { outcome: 'success', context };
  }
}
