/**
 * TracingIntegration - 追踪集成层
 *
 * 将 TracingService 与状态机引擎集成，提供：
 * - 执行开始时创建 Trace（startExecution）
 * - 每次状态转移创建 Span（traceTransition）
 * - 执行结束时结束 Trace 并存储 ExecutionSummary（endExecution）
 * - 按 executionId 和 requestId 查询历史执行路径
 *
 * 需求: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { TracingService, TracingContext } from '../../tracingService';
import { ExecutionResult, ExecutionSummary } from '../types';

export class TracingIntegration {
  private tracingService: TracingService;
  /** executionId → ExecutionSummary */
  private summariesById: Map<string, ExecutionSummary> = new Map();
  /** requestId → executionId[] (preserves insertion order) */
  private requestIndex: Map<string, string[]> = new Map();
  /** executionId → startTime (recorded when startExecution is called) */
  private startTimes: Map<string, number> = new Map();
  /** Insertion-order tracking for LRU eviction */
  private insertionOrder: string[] = [];
  /** Maximum number of summaries to retain (prevents unbounded memory growth) */
  private readonly maxEntries: number;

  constructor(tracingService: TracingService, maxEntries: number = 1000) {
    this.tracingService = tracingService;
    this.maxEntries = maxEntries;
  }

  /**
   * Start tracing for a state machine execution.
   * Calls TracingService.startTrace and records the start time.
   *
   * Requirement 8.1: Generate unique executionId (provided by caller)
   * Requirement 8.3: Integrate with TracingService
   */
  startExecution(executionId: string, requestId: string, definitionId: string): TracingContext {
    this.startTimes.set(executionId, Date.now());

    return this.tracingService.startTrace(`state-machine:${definitionId}`, {
      executionId,
      requestId,
      definitionId,
    });
  }

  /**
   * Trace a single state transition by creating and immediately ending a span.
   *
   * Requirement 8.2: Record each transition as a span with state name and duration
   * Requirement 8.3: Write transition info as spans into the tracing pipeline
   */
  traceTransition(
    tracingContext: TracingContext,
    fromState: string,
    toState: string,
    duration: number,
  ): TracingContext {
    const spanCtx = this.tracingService.startSpan(
      tracingContext,
      `transition:${fromState}->${toState}`,
      { fromState, toState, duration },
    );

    this.tracingService.endSpan(spanCtx);

    return spanCtx;
  }

  /**
   * End tracing for a state machine execution.
   * Calls TracingService.endTrace and stores the ExecutionSummary.
   *
   * Requirement 8.3: End trace on execution completion
   * Requirement 8.4: Generate execution summary
   */
  async endExecution(tracingContext: TracingContext, result: ExecutionResult): Promise<void> {
    const error = result.error ? new Error(result.error) : undefined;
    await this.tracingService.endTrace(tracingContext.traceId, error);

    const endTime = Date.now();
    const startTime = this.startTimes.get(result.executionId) ?? (endTime - result.totalDuration);
    this.startTimes.delete(result.executionId);

    const summary: ExecutionSummary = {
      executionId: result.executionId,
      requestId: result.requestId,
      definitionId: result.definitionId,
      startTime,
      endTime,
      totalDuration: result.totalDuration,
      nodesVisited: result.nodesVisited,
      degraded: result.degraded,
      finalState: result.finalState,
      success: result.success,
      transitionPath: result.transitionPath,
    };

    // Store by executionId
    this.summariesById.set(result.executionId, summary);
    this.insertionOrder.push(result.executionId);

    // Index by requestId
    const existing = this.requestIndex.get(result.requestId);
    if (existing) {
      existing.push(result.executionId);
    } else {
      this.requestIndex.set(result.requestId, [result.executionId]);
    }

    // LRU eviction: remove oldest entries when exceeding maxEntries
    this._evictIfNeeded();
  }

  /**
   * Evict oldest summaries when the map exceeds maxEntries.
   * Removes from both summariesById and requestIndex to prevent memory leaks.
   */
  private _evictIfNeeded(): void {
    while (this.summariesById.size > this.maxEntries && this.insertionOrder.length > 0) {
      const oldestId = this.insertionOrder.shift()!;
      const summary = this.summariesById.get(oldestId);
      this.summariesById.delete(oldestId);

      // Clean up requestIndex
      if (summary) {
        const ids = this.requestIndex.get(summary.requestId);
        if (ids) {
          const filtered = ids.filter(id => id !== oldestId);
          if (filtered.length === 0) {
            this.requestIndex.delete(summary.requestId);
          } else {
            this.requestIndex.set(summary.requestId, filtered);
          }
        }
      }
    }
  }

  /**
   * Query execution summary by executionId.
   *
   * Requirement 8.5: Support query by executionId
   */
  getExecutionSummary(executionId: string): ExecutionSummary | undefined {
    return this.summariesById.get(executionId);
  }

  /**
   * Query all execution summaries for a given requestId.
   *
   * Requirement 8.5: Support query by requestId
   */
  queryByRequestId(requestId: string): ExecutionSummary[] {
    const executionIds = this.requestIndex.get(requestId);
    if (!executionIds) {
      return [];
    }
    return executionIds
      .map(id => this.summariesById.get(id))
      .filter((s): s is ExecutionSummary => s !== undefined);
  }
}
