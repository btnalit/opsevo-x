/**
 * StateMachineEngine - 状态机核心引擎
 *
 * 继承 EventEmitter，实现状态转移循环、outcome→transition 匹配、
 * 事件发射、异常处理、无效转移检测和 maxSteps 安全阀。
 *
 * 需求: 1.4, 1.5, 1.6, 1.7, 1.8, 8.1
 */

import { EventEmitter } from 'events';
import { StateRegistry } from './stateRegistry';
import { StateExecutor } from './stateExecutor';
import { ContextManager } from './contextManager';
import { DegradationIntegration } from './integrations/degradationIntegration';
import { TracingIntegration } from './integrations/tracingIntegration';
import type { DataStore } from '../../dataStore';
import {
  StateContext,
  StateDefinition,
  StateTransition,
  ExecutionResult,
  TransitionRecord,
  StateTransitionEvent,
} from './types';

const DEFAULT_MAX_STEPS = 100;

export class StateMachineEngine extends EventEmitter {
  private registry: StateRegistry;
  private executor: StateExecutor;
  private pgDataStore: DataStore | null = null;

  constructor(
    registry: StateRegistry,
    executor: StateExecutor,
    private degradation?: DegradationIntegration,
    private tracing?: TracingIntegration,
  ) {
    super();
    this.registry = registry;
    this.executor = executor;
  }

  /**
   * 注入 PgDataStore，启用执行历史持久化
   */
  setPgDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
  }

  /**
   * 执行状态机流程
   *
   * 1. 获取并验证状态定义
   * 2. 生成 executionId / requestId，创建上下文
   * 3. 状态转移循环：执行 handler → 匹配 transition → 发射事件 → 更新状态
   * 4. 构建并返回 ExecutionResult
   */
  async execute(
    definitionId: string,
    input: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const definition = this.registry.getDefinition(definitionId);
    if (!definition) {
      throw new Error(`Definition '${definitionId}' not found`);
    }

    const executionId = crypto.randomUUID();
    const requestId =
      typeof input.requestId === 'string' ? input.requestId : crypto.randomUUID();

    const maxSteps = definition.maxSteps ?? DEFAULT_MAX_STEPS;
    const terminalSet = new Set(definition.terminalStates);

    // Create context
    const initialData = new Map<string, unknown>();
    for (const [key, value] of Object.entries(input)) {
      initialData.set(key, value);
    }
    const context = ContextManager.createContext(
      requestId,
      executionId,
      definition.initialState,
      initialData,
    );

    const startTime = Date.now();

    // Reset degradation tracking for this execution
    if (this.degradation) {
      this.degradation.reset();
    }

    // Start tracing for this execution
    let tracingContext: any;
    if (this.tracing) {
      tracingContext = this.tracing.startExecution(executionId, requestId, definitionId);
    }

    const transitionPath: TransitionRecord[] = [];
    let steps = 0;
    let currentState = definition.initialState;
    let error: string | undefined;
    let success = true;

    // State transition loop
    while (true) {
      const isTerminal = terminalSet.has(currentState);

      // maxSteps safety valve (only for non-terminal states)
      if (!isTerminal && steps >= maxSteps) {
        error = `Max steps (${maxSteps}) exceeded`;
        success = false;
        break;
      }

      // maxExecutionTime safety valve
      const maxExecutionTime = definition.maxExecutionTime;
      if (maxExecutionTime !== undefined && (Date.now() - startTime) >= maxExecutionTime) {
        error = `Max execution time (${maxExecutionTime}ms) exceeded`;
        success = false;
        break;
      }

      const handler = this.registry.getHandler(currentState, definitionId);
      if (!handler) {
        if (isTerminal) {
          // Terminal state with no handler → silent exit (e.g. rateLimited, dropped, filtered)
          break;
        }
        // No handler for non-terminal state — go to errorState if available
        if (definition.errorState && currentState !== definition.errorState) {
          const transitionRecord: TransitionRecord = {
            fromState: currentState,
            toState: definition.errorState,
            timestamp: Date.now(),
            duration: 0,
            skipped: false,
            skipReason: undefined,
          };
          transitionPath.push(transitionRecord);
          currentState = definition.errorState;
          context.currentState = currentState;
          error = `No handler registered for state '${currentState}'`;
          continue;
        }
        error = `No handler registered for state '${currentState}'`;
        success = false;
        break;
      }

      // Record enter timing
      ContextManager.recordTiming(context, currentState, 'enter');
      const enterTime = Date.now();

      // Execute handler via StateExecutor (with optional degradation wrapping)
      let result;
      if (this.degradation) {
        result = await this.degradation.wrapExecution(
          handler,
          context,
          () => this.executor.executeHandler(handler, context),
        );
      } else {
        result = await this.executor.executeHandler(handler, context);
      }

      // Record exit timing
      ContextManager.recordTiming(context, currentState, 'exit');
      const exitTime = Date.now();
      const duration = exitTime - enterTime;

      // Snapshot context before transition
      ContextManager.snapshot(context, exitTime);

      const outcome = result.outcome;
      let nextState: string | undefined;

      if (isTerminal) {
        // Terminal state handler executed — check for outgoing transitions
        const matched = this.matchTransition(definition, currentState, outcome);
        if (matched) {
          // Terminal state has outgoing edge (e.g. errorHandler → response) → continue
          nextState = matched.to;

          // Emit StateTransitionEvent
          const event: StateTransitionEvent = {
            executionId,
            requestId,
            fromState: currentState,
            toState: nextState,
            duration,
            timestamp: Date.now(),
            contextSnapshot: {
              currentState: nextState,
              metadata: { ...context.metadata },
              dataKeys: Array.from(context.data.keys()),
            },
          };
          this.emit('transition', event);

          // Record transition
          const transitionRecord: TransitionRecord = {
            fromState: currentState,
            toState: nextState,
            timestamp: Date.now(),
            duration,
            skipped: false,
          };
          transitionPath.push(transitionRecord);

          if (this.tracing && tracingContext) {
            tracingContext = this.tracing.traceTransition(tracingContext, currentState, nextState, duration);
          }

          // Update current state and continue loop
          currentState = nextState;
          context.currentState = currentState;
          continue;
        } else {
          // Terminal state with no outgoing edges → normal exit
          break;
        }
      }

      // --- Non-terminal state logic (unchanged) ---

      // Handle error outcome → go to errorState
      if (outcome === 'error') {
        if (definition.errorState) {
          nextState = definition.errorState;
          error = (result.metadata?.error as string) ?? 'Handler error';
        } else {
          error = (result.metadata?.error as string) ?? 'Handler error';
          success = false;

          const transitionRecord: TransitionRecord = {
            fromState: currentState,
            toState: currentState,
            timestamp: Date.now(),
            duration,
            skipped: false,
          };
          transitionPath.push(transitionRecord);
          break;
        }
      }

      // Match outcome to transition (if not already resolved by error handling)
      if (nextState === undefined) {
        const matched = this.matchTransition(definition, currentState, outcome);
        if (matched) {
          nextState = matched.to;
        } else if (outcome === 'degraded' || outcome === 'skipped') {
          // Special handling for degraded/skipped outcomes:
          // Find the default (unconditional) transition from current state
          const defaultTransition = definition.transitions.find(
            t => t.from === currentState && t.condition === undefined
          );
          if (defaultTransition) {
            nextState = defaultTransition.to;
          } else if (outcome === 'degraded' && definition.degradedState) {
            nextState = definition.degradedState;
          } else if (definition.errorState && currentState !== definition.errorState) {
            nextState = definition.errorState;
            error = `No default transition for ${outcome} outcome from state '${currentState}'`;
          } else {
            error = `No default transition for ${outcome} outcome from state '${currentState}'`;
            success = false;

            const transitionRecord: TransitionRecord = {
              fromState: currentState,
              toState: currentState,
              timestamp: Date.now(),
              duration,
              skipped: true,
              skipReason: outcome,
            };
            transitionPath.push(transitionRecord);
            break;
          }
        } else {
          // Normal outcome with no matching transition → go to errorState
          if (definition.errorState && currentState !== definition.errorState) {
            nextState = definition.errorState;
            error = `No matching transition for outcome '${outcome}' from state '${currentState}'`;
          } else {
            error = `No matching transition for outcome '${outcome}' from state '${currentState}'`;
            success = false;

            const transitionRecord: TransitionRecord = {
              fromState: currentState,
              toState: currentState,
              timestamp: Date.now(),
              duration,
              skipped: false,
            };
            transitionPath.push(transitionRecord);
            break;
          }
        }
      }

      // Emit StateTransitionEvent
      const event: StateTransitionEvent = {
        executionId,
        requestId,
        fromState: currentState,
        toState: nextState,
        duration,
        timestamp: Date.now(),
        contextSnapshot: {
          currentState: nextState,
          metadata: { ...context.metadata },
          dataKeys: Array.from(context.data.keys()),
        },
      };
      this.emit('transition', event);

      // Record transition
      const transitionRecord: TransitionRecord = {
        fromState: currentState,
        toState: nextState,
        timestamp: Date.now(),
        duration,
        skipped: false,
      };
      transitionPath.push(transitionRecord);

      if (this.tracing && tracingContext) {
        tracingContext = this.tracing.traceTransition(tracingContext, currentState, nextState, duration);
      }

      // Update current state
      currentState = nextState;
      context.currentState = currentState;
      steps++;
    }

    const endTime = Date.now();

    // Build output from context data
    const output: Record<string, unknown> = {};
    for (const [key, value] of context.data) {
      output[key] = value;
    }

    const executionResult: ExecutionResult = {
      executionId,
      requestId,
      definitionId,
      finalState: currentState,
      success: success && terminalSet.has(currentState),
      totalDuration: endTime - startTime,
      nodesVisited: transitionPath.length,
      degraded: this.degradation ? this.degradation.getDegradedNodes().length > 0 : false,
      degradedNodes: this.degradation ? this.degradation.getDegradedNodes() : [],
      output,
      transitionPath,
      error,
    };

    if (this.tracing && tracingContext) {
      await this.tracing.endExecution(tracingContext, executionResult);
    }

    // 持久化执行历史到 PostgreSQL
    this.persistExecution(executionResult).catch(() => {});

    return executionResult;
  }

  /**
   * 持久化执行结果到 PostgreSQL（fire-and-forget）
   */
  private async persistExecution(result: ExecutionResult): Promise<void> {
    if (!this.pgDataStore) return;

    try {
      await this.pgDataStore.execute(
        `INSERT INTO state_machine_executions (id, machine_type, current_state, context, history, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           current_state = EXCLUDED.current_state, context = EXCLUDED.context,
           history = EXCLUDED.history, status = EXCLUDED.status, updated_at = NOW()`,
        [
          result.executionId,
          result.definitionId,
          result.finalState,
          JSON.stringify(result.output),
          JSON.stringify(result.transitionPath),
          result.success ? 'completed' : 'failed',
        ]
      );
    } catch {
      // fire-and-forget, logged by DataStore
    }
  }

  /**
   * 查询执行历史（供 API 层使用）
   */
  async getExecutionHistory(options?: {
    machineType?: string;
    status?: string;
    limit?: number;
  }): Promise<ExecutionResult[]> {
    if (!this.pgDataStore) return [];

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options?.machineType) {
      conditions.push(`machine_type = $${idx++}`);
      params.push(options.machineType);
    }
    if (options?.status) {
      conditions.push(`status = $${idx++}`);
      params.push(options.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 50;
    params.push(limit);

    const rows = await this.pgDataStore.query<{
      id: string; machine_type: string; current_state: string;
      context: Record<string, unknown>; history: TransitionRecord[];
      status: string; created_at: string;
    }>(`SELECT * FROM state_machine_executions ${where} ORDER BY created_at DESC LIMIT $${idx}`, params);

    return rows.map(r => ({
      executionId: r.id,
      requestId: '',
      definitionId: r.machine_type,
      finalState: r.current_state,
      success: r.status === 'completed',
      totalDuration: 0,
      nodesVisited: (r.history || []).length,
      degraded: false,
      degradedNodes: [],
      output: r.context || {},
      transitionPath: r.history || [],
    }));
  }

  /**
   * 匹配 outcome 到转移规则
   *
   * 1. 筛选 from === currentState 的转移
   * 2. 按 priority 排序（数值越小优先级越高）
   * 3. 条件匹配优先于无条件匹配
   * 4. 无条件转移（condition 为 undefined）作为默认回退
   */
  private matchTransition(
    definition: StateDefinition,
    currentState: string,
    outcome: string,
  ): StateTransition | undefined {
    const candidates = definition.transitions.filter((t) => t.from === currentState);

    // Sort by priority (lower = higher priority), default priority is Infinity
    candidates.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));

    // First pass: find conditional match
    for (const t of candidates) {
      if (t.condition !== undefined && t.condition === outcome) {
        return t;
      }
    }

    // Second pass: find unconditional (default) match
    for (const t of candidates) {
      if (t.condition === undefined) {
        return t;
      }
    }

    return undefined;
  }
}
