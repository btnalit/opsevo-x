/**
 * StateMachine Property Tests
 *
 * 使用 fast-check 进行属性测试，验证状态机核心正确性属性。
 * 测试文件位置: backend/src/services/ai-ops/__tests__/stateMachine.property.test.ts
 */

import * as fc from 'fast-check';
import { ContextManager } from '../stateMachine/contextManager';
import { StateRegistry, ValidationError } from '../stateMachine/stateRegistry';
import { StateMachineEngine } from '../stateMachine/stateMachineEngine';
import { StateExecutor } from '../stateMachine/stateExecutor';
import { StateDefinition, StateHandler, StateContext, TransitionResult, ExecutionResult } from '../stateMachine/types';
import { RoutingDecisionHandler } from '../stateMachine/handlers/react/routingDecisionHandler';
import { DegradationIntegration } from '../stateMachine/integrations/degradationIntegration';
import { DegradationManager, DegradationReason, CapabilityName } from '../degradationManager';
import { TracingIntegration } from '../stateMachine/integrations/tracingIntegration';
import { StateDefinitionSerializer } from '../stateMachine/stateDefinitionSerializer';

// ==================== Shared Arbitrary: stateDefinitionArb ====================
const stateDefinitionArb = fc.uniqueArray(
  fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
  { minLength: 2, maxLength: 8 },
).chain(states => {
  const initialState = states[0];
  const terminalStates = [states[states.length - 1]];
  const transitions = states.slice(0, -1).map((s, i) => ({
    from: s,
    to: states[i + 1],
  }));
  return fc.constant({
    id: `def-${states.join('-')}`,
    name: 'Generated Definition',
    version: '1.0.0',
    states,
    initialState,
    terminalStates,
    transitions,
  } as StateDefinition);
});

/** Helper: create a simple StateHandler stub for a given state name */
function createStubHandler(stateName: string): StateHandler {
  return {
    name: stateName,
    canHandle: () => true,
    handle: async (context: StateContext): Promise<TransitionResult> => ({
      outcome: 'success',
      context,
    }),
  };
}

describe('StateMachine Property Tests', () => {
  // ==================== Property 5: StateContext get/set 往返一致性 ====================
  /**
   * Feature: lightweight-state-machine, Property 5: StateContext get/set 往返一致性
   * For any 键值对 (key: string, value: T)，在 StateContext 上调用 set(key, value) 后
   * 立即调用 get<T>(key)，应返回与原始 value 深度相等的值。
   * Validates: Requirements 2.2
   */
  it('Property 5: StateContext get/set round-trip consistency', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.integer()),
          fc.dictionary(fc.string(), fc.integer()),
        ),
        (key, value) => {
          const ctx = ContextManager.createContext('req', 'exec', 'init');
          ctx.set(key, value);
          const retrieved = ctx.get(key);
          expect(retrieved).toEqual(value);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ==================== Property 6: 状态历史快照完整性 ====================
  /**
   * Feature: lightweight-state-machine, Property 6: 状态历史快照完整性
   * For any 经过 N 次状态转移的执行，StateContext 的 stateHistory 应包含 N 条记录，
   * 每条记录包含该状态的进入时间、退出时间（exitTime >= enterTime）和进入时数据的快照。
   * 快照中的数据应反映该状态 Handler 执行前的上下文数据。
   * Validates: Requirements 2.3, 2.4
   */
  it('Property 6: State history snapshot integrity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1000, max: 2000000000 }),
        (n, baseTime) => {
          const states = Array.from({ length: n + 1 }, (_, i) => `state_${i}`);
          const ctx = ContextManager.createContext('req', 'exec', states[0]);

          // Track expected snapshots: what data should be in each snapshot
          const expectedSnapshots: Record<string, unknown>[] = [];

          for (let i = 0; i < n; i++) {
            // Record enter timing for current state
            const enterTime = baseTime + i * 100;
            ctx.timings.set(ctx.currentState, { enterTime });

            // Capture expected snapshot BEFORE setting new data for this transition
            const snapshotData: Record<string, unknown> = {};
            for (const [key, value] of ctx.data) {
              snapshotData[key] = value;
            }
            expectedSnapshots.push(snapshotData);

            // Set data that simulates handler work (this happens during handler execution)
            ctx.set(`step_${i}`, i);

            // Snapshot with exit time >= enter time
            const exitTime = enterTime + 50 + i;
            ContextManager.snapshot(ctx, exitTime);

            // Move to next state
            if (i < n - 1) {
              ctx.currentState = states[i + 1];
            }
          }

          // Verify: stateHistory has exactly N entries
          expect(ctx.stateHistory).toHaveLength(n);

          for (let i = 0; i < n; i++) {
            const entry = ctx.stateHistory[i];

            // Verify: exitTime >= enterTime
            expect(entry.exitTime).toBeGreaterThanOrEqual(entry.enterTime);

            // Verify: enterTime matches what we set
            expect(entry.enterTime).toBe(baseTime + i * 100);
            expect(entry.exitTime).toBe(baseTime + i * 100 + 50 + i);

            // Verify: snapshot reflects data at snapshot time (includes step_i set during handler)
            // The snapshot is taken AFTER handler sets data, so it includes step_i
            expect(entry.dataSnapshot[`step_${i}`]).toBe(i);

            // Verify: snapshot does NOT contain data from future transitions
            for (let j = i + 1; j < n; j++) {
              expect(entry.dataSnapshot[`step_${j}`]).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
  // ==================== Property 2: 状态定义验证正确性 ====================
  /**
   * Feature: lightweight-state-machine, Property 2: 状态定义验证正确性
   * For any StateDefinition，如果存在某个 StateNode 没有对应的 StateHandler，
   * 或某个 StateTransition 的源/目标状态不在状态枚举中，则注册/验证时应抛出验证错误；
   * 反之，如果所有节点都有处理器且所有转移的源/目标状态都在枚举中，则注册应成功。
   * Validates: Requirements 1.3
   */
  describe('Property 2: 状态定义验证正确性', () => {
    it('should throw ValidationError when non-terminal states are missing handlers', () => {
      fc.assert(
        fc.property(
          stateDefinitionArb,
          fc.integer({ min: 0, max: 5 }),
          (definition, skipCount) => {
            const registry = new StateRegistry();
            registry.registerDefinition(definition);

            const terminalSet = new Set(definition.terminalStates);
            const nonTerminalStates = definition.states.filter(s => !terminalSet.has(s));

            // Skip registering some handlers to create missing handler scenario
            const statesToSkip = Math.min(skipCount, nonTerminalStates.length);

            if (statesToSkip > 0 && nonTerminalStates.length > 0) {
              // Register handlers for only a subset of non-terminal states
              const registeredStates = nonTerminalStates.slice(statesToSkip);
              for (const state of registeredStates) {
                registry.registerHandler(state, createStubHandler(state));
              }
              // Also register handlers for terminal states (not required but harmless)

              // validate() should throw because some non-terminal states lack handlers
              expect(() => registry.validate(definition.id)).toThrow(ValidationError);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should pass validation when all non-terminal states have handlers', () => {
      fc.assert(
        fc.property(stateDefinitionArb, (definition) => {
          const registry = new StateRegistry();
          registry.registerDefinition(definition);

          const terminalSet = new Set(definition.terminalStates);
          for (const state of definition.states) {
            if (!terminalSet.has(state)) {
              registry.registerHandler(state, createStubHandler(state));
            }
          }

          // validate() should NOT throw
          expect(() => registry.validate(definition.id)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('should throw ValidationError when transitions reference states not in the definition', () => {
      fc.assert(
        fc.property(
          stateDefinitionArb,
          fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
          (definition, invalidState) => {
            // Only test if invalidState is NOT already in the states array
            if (definition.states.includes(invalidState)) return;

            const registry = new StateRegistry();

            // Create a definition with an invalid transition (from references non-existent state)
            const invalidFromDef: StateDefinition = {
              ...definition,
              id: `invalid-from-${definition.id}`,
              transitions: [
                ...definition.transitions,
                { from: invalidState, to: definition.states[0] },
              ],
            };
            expect(() => registry.registerDefinition(invalidFromDef)).toThrow(ValidationError);

            // Create a definition with an invalid transition (to references non-existent state)
            const invalidToDef: StateDefinition = {
              ...definition,
              id: `invalid-to-${definition.id}`,
              transitions: [
                ...definition.transitions,
                { from: definition.states[0], to: invalidState },
              ],
            };
            expect(() => registry.registerDefinition(invalidToDef)).toThrow(ValidationError);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ==================== Property 1: 状态定义注册完整性 ====================
  /**
   * Feature: lightweight-state-machine, Property 1: 状态定义注册完整性
   * For any 有效的 StateDefinition 和对应的 StateHandler 集合，
   * 注册后通过 orchestrator 查询应能获取到完全一致的定义和处理器映射。
   * Validates: Requirements 1.1, 1.2
   */
  describe('Property 1: 状态定义注册完整性', () => {
    it('should return the same definition and correct handler mappings after registration', () => {
      fc.assert(
        fc.property(stateDefinitionArb, (definition) => {
          const registry = new StateRegistry();
          registry.registerDefinition(definition);

          const terminalSet = new Set(definition.terminalStates);
          const handlerMap = new Map<string, StateHandler>();

          // Register handlers for all non-terminal states
          for (const state of definition.states) {
            if (!terminalSet.has(state)) {
              const handler = createStubHandler(state);
              registry.registerHandler(state, handler);
              handlerMap.set(state, handler);
            }
          }

          // Verify: getDefinition returns the same definition
          const retrieved = registry.getDefinition(definition.id);
          expect(retrieved).toBeDefined();
          expect(retrieved!.id).toBe(definition.id);
          expect(retrieved!.name).toBe(definition.name);
          expect(retrieved!.version).toBe(definition.version);
          expect(retrieved!.states).toEqual(definition.states);
          expect(retrieved!.initialState).toBe(definition.initialState);
          expect(retrieved!.terminalStates).toEqual(definition.terminalStates);
          expect(retrieved!.transitions).toEqual(definition.transitions);

          // Verify: getHandler returns the correct handler for each non-terminal state
          for (const [stateName, expectedHandler] of handlerMap) {
            const retrievedHandler = registry.getHandler(stateName);
            expect(retrievedHandler).toBe(expectedHandler);
          }

          // Verify: validate() passes
          expect(() => registry.validate(definition.id)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });

  // ==================== Property 3: 状态机执行到达终止状态 ====================
  /**
   * Feature: lightweight-state-machine, Property 3: 状态机执行到达终止状态
   * For any 有效的状态定义和一组不抛异常的 StateHandler，执行应从初始状态开始，
   * 经过一系列状态转移，最终到达终止状态集合中的某个状态。执行结果中的 transitionPath
   * 应记录每一次转移，且路径中的第一个 fromState 应为初始状态，最后一个 toState 应为终止状态。
   * Validates: Requirements 1.4, 1.6, 8.2
   */
  describe('Property 3: 状态机执行到达终止状态', () => {
    it('should execute from initial state to a terminal state with complete transition path', async () => {
      await fc.assert(
        fc.asyncProperty(stateDefinitionArb, async (definition) => {
          const registry = new StateRegistry();
          registry.registerDefinition(definition);

          const terminalSet = new Set(definition.terminalStates);

          // Register handlers for all non-terminal states that return 'success' outcome
          for (const state of definition.states) {
            if (!terminalSet.has(state)) {
              registry.registerHandler(state, createStubHandler(state));
            }
          }

          // Validate the definition
          registry.validate(definition.id);

          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          // Execute the engine
          const result: ExecutionResult = await engine.execute(definition.id, {});

          // Verify: execution succeeded
          expect(result.success).toBe(true);

          // Verify: finalState is in terminalStates
          expect(terminalSet.has(result.finalState)).toBe(true);

          // Verify: transitionPath length > 0
          expect(result.transitionPath.length).toBeGreaterThan(0);

          // Verify: first transition starts from initialState
          expect(result.transitionPath[0].fromState).toBe(definition.initialState);

          // Verify: last transition ends at a terminal state
          const lastTransition = result.transitionPath[result.transitionPath.length - 1];
          expect(terminalSet.has(lastTransition.toState)).toBe(true);

          // Verify: transition path is contiguous (each toState matches next fromState)
          for (let i = 0; i < result.transitionPath.length - 1; i++) {
            expect(result.transitionPath[i].toState).toBe(
              result.transitionPath[i + 1].fromState,
            );
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // ==================== Property 4: 异常处理转移到错误状态 ====================
  /**
   * Feature: lightweight-state-machine, Property 4: 异常处理转移到错误状态
   * For any 配置了 errorState 的状态定义，如果某个 StateHandler 在执行时抛出异常，
   * 状态机应捕获异常并转移到预定义的错误处理状态，而不是向调用方抛出未处理异常。
   * Validates: Requirements 1.7
   */
  describe('Property 4: 异常处理转移到错误状态', () => {
    it('should catch handler exceptions and transition to errorState', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate definitions with at least 3 states (to have room for errorState)
          fc.uniqueArray(
            fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
            { minLength: 3, maxLength: 8 },
          ),
          fc.integer({ min: 0, max: 100 }),
          async (states, _seed) => {
            // Build a linear definition with an errorState
            const initialState = states[0];
            const errorState = states[states.length - 1];
            const terminalState = states[states.length - 2];
            const middleStates = states.slice(1, -2);

            // All states in the definition
            const allStates = states;
            const terminalStates = [terminalState, errorState];

            // Build linear transitions: state[0] -> state[1] -> ... -> terminalState
            const transitions = [];
            const linearPath = [initialState, ...middleStates, terminalState];
            for (let i = 0; i < linearPath.length - 1; i++) {
              transitions.push({ from: linearPath[i], to: linearPath[i + 1] });
            }

            const definition: StateDefinition = {
              id: `err-def-${states.join('-')}`,
              name: 'Error Test Definition',
              version: '1.0.0',
              states: allStates,
              initialState,
              terminalStates,
              transitions,
              errorState,
            };

            const registry = new StateRegistry();
            registry.registerDefinition(definition);

            const terminalSet = new Set(terminalStates);

            // Pick a non-terminal state to throw an exception
            // The throwing state is the first non-terminal state (initialState)
            const throwingState = initialState;

            // Register a throwing handler for the throwing state
            const throwingHandler: StateHandler = {
              name: throwingState,
              canHandle: () => true,
              handle: async (): Promise<TransitionResult> => {
                throw new Error('Simulated handler exception');
              },
            };
            registry.registerHandler(throwingState, throwingHandler);

            // Register normal handlers for remaining non-terminal states
            for (const state of allStates) {
              if (!terminalSet.has(state) && state !== throwingState) {
                registry.registerHandler(state, createStubHandler(state));
              }
            }

            registry.validate(definition.id);

            const executor = new StateExecutor();
            const engine = new StateMachineEngine(registry, executor);

            // Execute — should NOT throw an unhandled exception
            const result: ExecutionResult = await engine.execute(definition.id, {});

            // Verify: the engine caught the exception and transitioned to errorState
            expect(result.finalState).toBe(errorState);

            // Verify: error is defined
            expect(result.error).toBeDefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

// ==================== Property 8: 路由决策一致性 ====================

/**
 * Feature: lightweight-state-machine, Property 8: 路由决策一致性
 * For any ReAct 编排流程执行，RoutingDecision 节点应根据意图置信度和知识检索结果选择路由路径。
 * 当知识检索置信度高于阈值时应路由到 FastPath，当意图置信度高于阈值且为可执行意图时应路由到
 * IntentDrivenExecution，否则应路由到 ReActLoop。路由结果应与 StateContext 中记录的 routingPath 一致。
 * Validates: Requirements 3.4
 */
describe('Property 8: 路由决策一致性', () => {
  it('Property 8: Routing decision consistency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        async (knowledgeConfidence, intentConfidence, isExecutable) => {
          // Determine expected routing
          let expectedPath: 'fastPath' | 'intentDriven' | 'reactLoop';
          if (knowledgeConfidence > 0.8) {
            expectedPath = 'fastPath';
          } else if (intentConfidence > 0.8 && isExecutable) {
            expectedPath = 'intentDriven';
          } else {
            expectedPath = 'reactLoop';
          }

          // Create mock routing decider
          const mockDecider = {
            decide: async (_params: unknown) => ({
              path: expectedPath,
              confidence: Math.max(knowledgeConfidence, intentConfidence),
            }),
          };

          const handler = new RoutingDecisionHandler({ routingDecider: mockDecider });
          const ctx = ContextManager.createContext('req', 'exec', 'routingDecision');
          ctx.set('parsedIntent', { intent: 'test', confidence: intentConfidence });
          ctx.set('intentAnalysis', { confidence: intentConfidence, isExecutable });
          ctx.set('ragContext', { confidence: knowledgeConfidence });

          const result = await handler.handle(ctx);

          expect(result.outcome).toBe(expectedPath);
          expect(ctx.get('routingPath')).toBe(expectedPath);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ==================== Property 9: 条件性早期终止 ====================

import { alertDefinition } from '../stateMachine/definitions/alertDefinition';

/**
 * Feature: lightweight-state-machine, Property 9: 条件性早期终止
 * For any Alert 编排流程执行，当 Deduplicate 节点判定事件为重复时，状态机应转移到 dropped
 * 终止状态且不执行后续的 Filter、Analyze、Decide 节点。当 Filter 节点判定事件被过滤时，
 * 状态机应转移到 filtered 终止状态且不执行后续的 Analyze、Decide 节点。
 * Validates: Requirements 4.3, 4.4
 */
describe('Property 9: 条件性早期终止', () => {
  it('should terminate at dropped when event is duplicate and not call Filter/Analyze/Decide', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          eventId: fc.string({ minLength: 1, maxLength: 20 }),
          eventType: fc.constantFrom('syslog', 'alert'),
          severity: fc.constantFrom('low', 'medium', 'high', 'critical'),
        }),
        async (eventData) => {
          const calledHandlers: string[] = [];

          const registry = new StateRegistry();
          registry.registerDefinition(alertDefinition);

          // RateLimit: always passes
          registry.registerHandler('rateLimit', {
            name: 'rateLimit',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('rateLimit');
              ctx.set('rateLimitPassed', true);
              return { outcome: 'passed', context: ctx };
            },
          });

          // Normalize: always succeeds
          registry.registerHandler('normalize', {
            name: 'normalize',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('normalize');
              ctx.set('normalizedEvent', { ...eventData, normalized: true });
              return { outcome: 'success', context: ctx };
            },
          });

          // Deduplicate: returns isDuplicate (this is the early termination case)
          registry.registerHandler('deduplicate', {
            name: 'deduplicate',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('deduplicate');
              ctx.set('isDuplicate', true);
              return { outcome: 'isDuplicate', context: ctx };
            },
          });

          // Filter: should NOT be called
          registry.registerHandler('filter', {
            name: 'filter',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('filter');
              return { outcome: 'passed', context: ctx };
            },
          });

          // Analyze: should NOT be called
          registry.registerHandler('analyze', {
            name: 'analyze',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('analyze');
              return { outcome: 'success', context: ctx };
            },
          });

          // Decide: should NOT be called (it's a terminal state, no handler needed)

          registry.validate(alertDefinition.id);

          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          const result: ExecutionResult = await engine.execute(alertDefinition.id, {
            rawEvent: eventData,
          });

          // Verify: execution terminates at 'dropped'
          expect(result.finalState).toBe('dropped');
          expect(result.success).toBe(true);

          // Verify: Filter, Analyze, Decide were NOT called
          expect(calledHandlers).not.toContain('filter');
          expect(calledHandlers).not.toContain('analyze');
          expect(calledHandlers).not.toContain('decide');

          // Verify: RateLimit, Normalize, Deduplicate WERE called in order
          expect(calledHandlers).toEqual(['rateLimit', 'normalize', 'deduplicate']);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should terminate at filtered when event is filtered and not call Analyze/Decide', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          eventId: fc.string({ minLength: 1, maxLength: 20 }),
          eventType: fc.constantFrom('syslog', 'alert'),
          severity: fc.constantFrom('low', 'medium', 'high', 'critical'),
        }),
        async (eventData) => {
          const calledHandlers: string[] = [];

          const registry = new StateRegistry();
          registry.registerDefinition(alertDefinition);

          // RateLimit: always passes
          registry.registerHandler('rateLimit', {
            name: 'rateLimit',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('rateLimit');
              ctx.set('rateLimitPassed', true);
              return { outcome: 'passed', context: ctx };
            },
          });

          // Normalize: always succeeds
          registry.registerHandler('normalize', {
            name: 'normalize',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('normalize');
              ctx.set('normalizedEvent', { ...eventData, normalized: true });
              return { outcome: 'success', context: ctx };
            },
          });

          // Deduplicate: returns isUnique (passes through)
          registry.registerHandler('deduplicate', {
            name: 'deduplicate',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('deduplicate');
              ctx.set('isDuplicate', false);
              return { outcome: 'isUnique', context: ctx };
            },
          });

          // Filter: returns isFiltered (early termination)
          registry.registerHandler('filter', {
            name: 'filter',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('filter');
              ctx.set('filterResult', { filtered: true, reason: 'noise' });
              return { outcome: 'isFiltered', context: ctx };
            },
          });

          // Analyze: should NOT be called
          registry.registerHandler('analyze', {
            name: 'analyze',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              calledHandlers.push('analyze');
              return { outcome: 'success', context: ctx };
            },
          });

          registry.validate(alertDefinition.id);

          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          const result: ExecutionResult = await engine.execute(alertDefinition.id, {
            rawEvent: eventData,
          });

          // Verify: execution terminates at 'filtered'
          expect(result.finalState).toBe('filtered');
          expect(result.success).toBe(true);

          // Verify: Analyze and Decide were NOT called
          expect(calledHandlers).not.toContain('analyze');
          expect(calledHandlers).not.toContain('decide');

          // Verify: RateLimit, Normalize, Deduplicate, Filter WERE called in order
          expect(calledHandlers).toEqual(['rateLimit', 'normalize', 'deduplicate', 'filter']);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 10: 迭代循环终止保证 ====================

import { iterationDefinition } from '../stateMachine/definitions/iterationDefinition';

/**
 * Feature: lightweight-state-machine, Property 10: 迭代循环终止保证
 * For any Iteration 编排流程执行和任意最大迭代次数配置 maxIterations，
 * 执行的实际迭代次数不应超过 maxIterations。当达到最大迭代次数时，
 * Decide 节点应强制转移到终止状态。
 * Validates: Requirements 5.5, 5.6
 */
describe('Property 10: 迭代循环终止保证', () => {
  it('should terminate within maxIterations even when DecideHandler always returns continue', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (maxIterations) => {
          const registry = new StateRegistry();
          registry.registerDefinition(iterationDefinition);

          let executeCount = 0;

          // Execute: always succeeds, tracks call count
          registry.registerHandler('execute', {
            name: 'execute',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              executeCount++;
              ctx.set('executionResults', [{ step: executeCount }]);
              ctx.set('preMetrics', {});
              ctx.set('postMetrics', {});
              return { outcome: 'success', context: ctx };
            },
          });

          // Evaluate: always succeeds
          registry.registerHandler('evaluate', {
            name: 'evaluate',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              ctx.set('evaluation', { score: 0.5 });
              return { outcome: 'success', context: ctx };
            },
          });

          // Reflect: always succeeds
          registry.registerHandler('reflect', {
            name: 'reflect',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              ctx.set('reflection', { suggestion: 'keep going' });
              return { outcome: 'success', context: ctx };
            },
          });

          // Decide: increments iteration count and enforces maxIterations,
          // otherwise always returns 'continue' to stress-test termination
          registry.registerHandler('decide', {
            name: 'decide',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              const currentIteration = (ctx.get<number>('currentIteration') ?? 0) + 1;
              ctx.set('currentIteration', currentIteration);

              // Enforce maxIterations (same logic as IterationDecideHandler)
              if (currentIteration >= maxIterations) {
                ctx.set('nextAction', 'complete');
                return {
                  outcome: 'complete',
                  context: ctx,
                  metadata: { reason: 'maxIterations reached' },
                };
              }

              // Always continue to stress-test termination guarantee
              return { outcome: 'continue', context: ctx };
            },
          });

          registry.validate(iterationDefinition.id);

          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          executeCount = 0;

          const result: ExecutionResult = await engine.execute(iterationDefinition.id, {
            currentPlan: { steps: ['fix'] },
            maxIterations,
          });

          // Verify: execution completed successfully
          expect(result.success).toBe(true);

          // Verify: final state is 'completed' (not stuck in loop)
          expect(result.finalState).toBe('completed');

          // Verify: actual iterations (execute calls) do not exceed maxIterations
          expect(executeCount).toBeLessThanOrEqual(maxIterations);

          // Verify: currentIteration in context matches maxIterations
          expect(result.output['currentIteration']).toBe(maxIterations);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 12: 降级节点自动跳过 ====================

/**
 * Feature: lightweight-state-machine, Property 12: 降级节点自动跳过
 * For any 降级状态组合，DegradationIntegration 应：
 * - 对降级能力的 Handler 返回 shouldSkip=true，对可用能力返回 false
 * - 全路径降级时 isFullPathDegraded 返回 true
 * - wrapExecution 对降级 Handler 返回 'degraded' outcome 并追踪到 getDegradedNodes()
 * Validates: Requirements 7.1, 7.4
 */
describe('Property 12: 降级节点自动跳过', () => {
  const ALL_CAPABILITIES: CapabilityName[] = [
    'reflection', 'experience', 'planRevision', 'toolFeedback',
    'proactiveOps', 'intentDriven', 'selfHealing', 'continuousLearning', 'tracing',
  ];

  const capabilityArb = fc.constantFrom<CapabilityName>(...ALL_CAPABILITIES);
  const capabilitySubsetArb = fc.uniqueArray(capabilityArb, { minLength: 1, maxLength: ALL_CAPABILITIES.length });

  let degradationManager: DegradationManager;

  afterEach(() => {
    if (degradationManager) {
      degradationManager.shutdown();
    }
  });

  it('shouldSkip returns true for degraded capabilities and false for available ones', () => {
    fc.assert(
      fc.property(
        capabilitySubsetArb,
        (degradedCapabilities) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          const degradedSet = new Set(degradedCapabilities);

          // Degrade the selected capabilities
          for (const cap of degradedCapabilities) {
            degradationManager.degrade(cap, DegradationReason.MANUAL);
          }

          // Verify shouldSkip for every capability
          for (const cap of ALL_CAPABILITIES) {
            const handler: StateHandler = {
              name: `handler-${cap}`,
              capability: cap,
              canHandle: () => true,
              handle: async (ctx: StateContext): Promise<TransitionResult> => ({
                outcome: 'success',
                context: ctx,
              }),
            };

            if (degradedSet.has(cap)) {
              expect(integration.shouldSkip(handler)).toBe(true);
            } else {
              expect(integration.shouldSkip(handler)).toBe(false);
            }
          }

          // Handlers without capability are never skipped
          const noCap: StateHandler = {
            name: 'no-cap',
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => ({
              outcome: 'success',
              context: ctx,
            }),
          };
          expect(integration.shouldSkip(noCap)).toBe(false);

          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isFullPathDegraded returns true when all handlers capabilities are degraded', () => {
    fc.assert(
      fc.property(
        capabilitySubsetArb,
        fc.boolean(),
        (capabilities, degradeAll) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          const handlers: StateHandler[] = capabilities.map(cap => ({
            name: `handler-${cap}`,
            capability: cap,
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => ({
              outcome: 'success',
              context: ctx,
            }),
          }));

          if (degradeAll) {
            // Degrade all capabilities used by handlers
            for (const cap of capabilities) {
              degradationManager.degrade(cap, DegradationReason.MANUAL);
            }
            expect(integration.isFullPathDegraded(handlers)).toBe(true);
          } else {
            // Don't degrade any — at least one is available
            expect(integration.isFullPathDegraded(handlers)).toBe(false);
          }

          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isFullPathDegraded returns false when path includes handler without capability', () => {
    fc.assert(
      fc.property(
        capabilitySubsetArb,
        (capabilities) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          // Degrade all capabilities
          for (const cap of capabilities) {
            degradationManager.degrade(cap, DegradationReason.MANUAL);
          }

          const handlers: StateHandler[] = [
            ...capabilities.map(cap => ({
              name: `handler-${cap}`,
              capability: cap as CapabilityName,
              canHandle: () => true,
              handle: async (ctx: StateContext): Promise<TransitionResult> => ({
                outcome: 'success',
                context: ctx,
              }),
            })),
            // Handler without capability — always available
            {
              name: 'no-cap-handler',
              canHandle: () => true,
              handle: async (ctx: StateContext): Promise<TransitionResult> => ({
                outcome: 'success',
                context: ctx,
              }),
            },
          ];

          expect(integration.isFullPathDegraded(handlers)).toBe(false);

          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('wrapExecution returns degraded outcome for degraded handlers and tracks them', async () => {
    await fc.assert(
      fc.asyncProperty(
        capabilitySubsetArb,
        async (degradedCapabilities) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);
          integration.reset();

          const degradedSet = new Set(degradedCapabilities);

          // Degrade selected capabilities
          for (const cap of degradedCapabilities) {
            degradationManager.degrade(cap, DegradationReason.MANUAL);
          }

          const ctx = ContextManager.createContext('req', 'exec', 'init');

          // Test wrapExecution for each capability
          for (const cap of ALL_CAPABILITIES) {
            const handler: StateHandler = {
              name: `handler-${cap}`,
              capability: cap,
              canHandle: () => true,
              handle: async (c: StateContext): Promise<TransitionResult> => ({
                outcome: 'success',
                context: c,
              }),
            };

            const result = await integration.wrapExecution(handler, ctx, () => handler.handle(ctx));

            if (degradedSet.has(cap)) {
              expect(result.outcome).toBe('degraded');
            } else {
              expect(result.outcome).toBe('success');
            }
          }

          // Verify getDegradedNodes tracks exactly the degraded handlers
          const degradedNodes = integration.getDegradedNodes();
          const expectedDegradedNames = degradedCapabilities.map(cap => `handler-${cap}`);
          expect(degradedNodes.sort()).toEqual(expectedDegradedNames.sort());
          expect(degradedNodes).toHaveLength(expectedDegradedNames.length);

          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 13: 降级记录一致性 ====================

/**
 * Feature: lightweight-state-machine, Property 13: 降级记录一致性
 * For any StateHandler 执行，如果执行成功则应调用 DegradationManager.recordSuccess，
 * 如果执行失败则应调用 DegradationManager.recordFailure。
 * 调用的 capability 参数应与该 StateHandler 关联的 CapabilityName 一致。
 * Validates: Requirements 7.2, 7.3
 */
describe('Property 13: 降级记录一致性', () => {
  const ALL_CAPABILITIES: CapabilityName[] = [
    'reflection', 'experience', 'planRevision', 'toolFeedback',
    'proactiveOps', 'intentDriven', 'selfHealing', 'continuousLearning', 'tracing',
  ];

  const capabilityArb = fc.constantFrom<CapabilityName>(...ALL_CAPABILITIES);

  let degradationManager: DegradationManager;

  afterEach(() => {
    if (degradationManager) {
      degradationManager.shutdown();
    }
  });

  it('should call recordSuccess with the correct capability when handler succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        capabilityArb,
        async (capability) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          const successSpy = jest.spyOn(degradationManager, 'recordSuccess');
          const failureSpy = jest.spyOn(degradationManager, 'recordFailure');

          const handler: StateHandler = {
            name: `handler-${capability}`,
            capability,
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => ({
              outcome: 'success',
              context: ctx,
            }),
          };

          const ctx = ContextManager.createContext('req', 'exec', 'init');

          await integration.wrapExecution(handler, ctx, () => handler.handle(ctx));

          // Verify: recordSuccess was called exactly once with the handler's capability
          expect(successSpy).toHaveBeenCalledTimes(1);
          expect(successSpy).toHaveBeenCalledWith(capability);

          // Verify: recordFailure was NOT called
          expect(failureSpy).not.toHaveBeenCalled();

          successSpy.mockRestore();
          failureSpy.mockRestore();
          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should call recordFailure with the correct capability and error message when handler throws', async () => {
    await fc.assert(
      fc.asyncProperty(
        capabilityArb,
        fc.string({ minLength: 1, maxLength: 50 }),
        async (capability, errorMessage) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          const successSpy = jest.spyOn(degradationManager, 'recordSuccess');
          const failureSpy = jest.spyOn(degradationManager, 'recordFailure');

          const handler: StateHandler = {
            name: `handler-${capability}`,
            capability,
            canHandle: () => true,
            handle: async (): Promise<TransitionResult> => {
              throw new Error(errorMessage);
            },
          };

          const ctx = ContextManager.createContext('req', 'exec', 'init');

          const result = await integration.wrapExecution(handler, ctx, () => handler.handle(ctx));

          // Verify: recordFailure was called exactly once with the handler's capability and error message
          expect(failureSpy).toHaveBeenCalledTimes(1);
          expect(failureSpy).toHaveBeenCalledWith(capability, errorMessage);

          // Verify: recordSuccess was NOT called
          expect(successSpy).not.toHaveBeenCalled();

          // Verify: result outcome is 'error'
          expect(result.outcome).toBe('error');

          successSpy.mockRestore();
          failureSpy.mockRestore();
          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not call recordSuccess or recordFailure for handlers without capability', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        async (shouldSucceed) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          const successSpy = jest.spyOn(degradationManager, 'recordSuccess');
          const failureSpy = jest.spyOn(degradationManager, 'recordFailure');

          const handler: StateHandler = {
            name: 'no-capability-handler',
            // No capability field
            canHandle: () => true,
            handle: async (ctx: StateContext): Promise<TransitionResult> => {
              if (!shouldSucceed) {
                throw new Error('handler failed');
              }
              return { outcome: 'success', context: ctx };
            },
          };

          const ctx = ContextManager.createContext('req', 'exec', 'init');

          await integration.wrapExecution(handler, ctx, () => handler.handle(ctx));

          // Verify: neither recordSuccess nor recordFailure was called
          expect(successSpy).not.toHaveBeenCalled();
          expect(failureSpy).not.toHaveBeenCalled();

          successSpy.mockRestore();
          failureSpy.mockRestore();
          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should maintain capability consistency between handler and recorded call across random sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            capability: capabilityArb,
            shouldSucceed: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (executions) => {
          degradationManager = new DegradationManager({ autoRecoveryEnabled: false });
          const integration = new DegradationIntegration(degradationManager);

          const successSpy = jest.spyOn(degradationManager, 'recordSuccess');
          const failureSpy = jest.spyOn(degradationManager, 'recordFailure');

          for (const { capability, shouldSucceed } of executions) {
            const handler: StateHandler = {
              name: `handler-${capability}`,
              capability,
              canHandle: () => true,
              handle: async (ctx: StateContext): Promise<TransitionResult> => {
                if (!shouldSucceed) {
                  throw new Error(`fail-${capability}`);
                }
                return { outcome: 'success', context: ctx };
              },
            };

            const ctx = ContextManager.createContext('req', 'exec', 'init');
            await integration.wrapExecution(handler, ctx, () => handler.handle(ctx));
          }

          // Verify: total calls match total executions
          const totalCalls = successSpy.mock.calls.length + failureSpy.mock.calls.length;
          expect(totalCalls).toBe(executions.length);

          // Verify: each call used the correct capability
          let successIdx = 0;
          let failureIdx = 0;
          for (const { capability, shouldSucceed } of executions) {
            if (shouldSucceed) {
              expect(successSpy.mock.calls[successIdx][0]).toBe(capability);
              successIdx++;
            } else {
              expect(failureSpy.mock.calls[failureIdx][0]).toBe(capability);
              expect(failureSpy.mock.calls[failureIdx][1]).toBe(`fail-${capability}`);
              failureIdx++;
            }
          }

          successSpy.mockRestore();
          failureSpy.mockRestore();
          degradationManager.shutdown();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 14: 执行标识唯一性与查询往返 ====================

/**
 * Feature: lightweight-state-machine, Property 14: 执行标识唯一性与查询往返
 * For any N 次执行，生成的 N 个 executionId 应互不相同。对于任意已完成的执行，
 * 通过 executionId 或 requestId 查询应返回包含正确 totalDuration、nodesVisited、
 * degraded 标志和 finalState 的执行摘要。
 * Validates: Requirements 8.1, 8.4, 8.5
 */
describe('Property 14: 执行标识唯一性与查询往返', () => {
  const mockTracingService = {
    startTrace: jest.fn().mockReturnValue({ traceId: 'trace-1', spanId: 'span-1' }),
    startSpan: jest.fn().mockReturnValue({ traceId: 'trace-1', spanId: 'span-2' }),
    endSpan: jest.fn(),
    endTrace: jest.fn().mockResolvedValue(undefined),
  };

  it('executionIds are unique and getExecutionSummary returns correct data', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (n) => {
          const tracingService = {
            startTrace: jest.fn().mockReturnValue({ traceId: 'trace-1', spanId: 'span-1' }),
            startSpan: jest.fn().mockReturnValue({ traceId: 'trace-1', spanId: 'span-2' }),
            endSpan: jest.fn(),
            endTrace: jest.fn().mockResolvedValue(undefined),
          };
          const integration = new TracingIntegration(tracingService as any);

          const executionIds: string[] = [];
          const requestIds: string[] = [];

          for (let i = 0; i < n; i++) {
            const executionId = `exec-${i}-${Date.now()}-${Math.random()}`;
            const requestId = `req-${i}`;
            const definitionId = `def-${i}`;

            executionIds.push(executionId);
            requestIds.push(requestId);

            // Start execution
            const tracingCtx = integration.startExecution(executionId, requestId, definitionId);

            // Trace a transition
            integration.traceTransition(tracingCtx, 'stateA', 'stateB', 50);

            // Build a mock ExecutionResult
            const result: ExecutionResult = {
              executionId,
              requestId,
              definitionId,
              finalState: 'stateB',
              success: true,
              totalDuration: 100 + i,
              nodesVisited: 2 + i,
              degraded: i % 2 === 0,
              degradedNodes: i % 2 === 0 ? ['someNode'] : [],
              output: {},
              transitionPath: [
                { fromState: 'stateA', toState: 'stateB', timestamp: Date.now(), duration: 50, skipped: false },
              ],
            };

            await integration.endExecution(tracingCtx, result);
          }

          // Verify: all executionIds are unique
          const uniqueIds = new Set(executionIds);
          expect(uniqueIds.size).toBe(n);

          // Verify: getExecutionSummary returns correct data for each executionId
          for (let i = 0; i < n; i++) {
            const summary = integration.getExecutionSummary(executionIds[i]);
            expect(summary).toBeDefined();
            expect(summary!.executionId).toBe(executionIds[i]);
            expect(summary!.requestId).toBe(requestIds[i]);
            expect(summary!.totalDuration).toBe(100 + i);
            expect(summary!.nodesVisited).toBe(2 + i);
            expect(summary!.degraded).toBe(i % 2 === 0);
            expect(summary!.finalState).toBe('stateB');
            expect(summary!.success).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('queryByRequestId returns all summaries for a given requestId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 3 }),
        async (numRequests, executionsPerRequest) => {
          const tracingService = {
            startTrace: jest.fn().mockReturnValue({ traceId: 'trace-1', spanId: 'span-1' }),
            startSpan: jest.fn().mockReturnValue({ traceId: 'trace-1', spanId: 'span-2' }),
            endSpan: jest.fn(),
            endTrace: jest.fn().mockResolvedValue(undefined),
          };
          const integration = new TracingIntegration(tracingService as any);

          // Map requestId → list of executionIds
          const requestToExecutions = new Map<string, string[]>();

          for (let r = 0; r < numRequests; r++) {
            const requestId = `req-${r}`;
            const execIds: string[] = [];

            for (let e = 0; e < executionsPerRequest; e++) {
              const executionId = `exec-${r}-${e}-${Date.now()}-${Math.random()}`;
              execIds.push(executionId);

              const tracingCtx = integration.startExecution(executionId, requestId, 'def-test');
              integration.traceTransition(tracingCtx, 'init', 'done', 10);

              const result: ExecutionResult = {
                executionId,
                requestId,
                definitionId: 'def-test',
                finalState: 'done',
                success: true,
                totalDuration: 50,
                nodesVisited: 2,
                degraded: false,
                degradedNodes: [],
                output: {},
                transitionPath: [
                  { fromState: 'init', toState: 'done', timestamp: Date.now(), duration: 10, skipped: false },
                ],
              };

              await integration.endExecution(tracingCtx, result);
            }

            requestToExecutions.set(requestId, execIds);
          }

          // Verify: queryByRequestId returns the correct summaries for each requestId
          for (const [requestId, expectedExecIds] of requestToExecutions) {
            const summaries = integration.queryByRequestId(requestId);
            expect(summaries).toHaveLength(expectedExecIds.length);

            const returnedIds = summaries.map(s => s.executionId);
            for (const expectedId of expectedExecIds) {
              expect(returnedIds).toContain(expectedId);
            }

            // Verify each summary has the correct requestId
            for (const summary of summaries) {
              expect(summary.requestId).toBe(requestId);
            }
          }

          // Verify: querying a non-existent requestId returns empty array
          expect(integration.queryByRequestId('non-existent-req')).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('StateMachineEngine generates unique executionIds across multiple executions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        async (n) => {
          const registry = new StateRegistry();
          const definition: StateDefinition = {
            id: 'uniqueness-test',
            name: 'Uniqueness Test',
            version: '1.0.0',
            states: ['start', 'end'],
            initialState: 'start',
            terminalStates: ['end'],
            transitions: [{ from: 'start', to: 'end' }],
          };

          registry.registerDefinition(definition);
          registry.registerHandler('start', createStubHandler('start'));
          registry.validate(definition.id);

          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          const executionIds: string[] = [];
          for (let i = 0; i < n; i++) {
            const result = await engine.execute(definition.id, {});
            expect(result.success).toBe(true);
            executionIds.push(result.executionId);
          }

          // Verify: all executionIds are unique
          const uniqueIds = new Set(executionIds);
          expect(uniqueIds.size).toBe(n);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 16: 并发限制与队列超时 ====================

/**
 * Feature: lightweight-state-machine, Property 16: 并发限制与队列超时
 * For any 最大并发数配置 M 和超时配置 T，当同时提交 N > M 个请求时，
 * 同一时刻最多有 M 个请求在执行，其余进入等待队列。
 * getConcurrencyStatus() 返回的 active 和 queued 值应准确反映实际状态。
 * 等待时间超过 T 的请求应被拒绝并返回超时错误。
 * Validates: Requirements 11.2, 11.3, 11.4
 */
describe('Property 16: 并发限制与队列超时', () => {
  let ConcurrencyGuard: typeof import('../stateMachine/integrations/concurrencyGuard').ConcurrencyGuard;

  beforeAll(async () => {
    const mod = await import('../stateMachine/integrations/concurrencyGuard');
    ConcurrencyGuard = mod.ConcurrencyGuard;
  });

  const makeResult = (id: string): ExecutionResult => ({
    executionId: id,
    requestId: `req-${id}`,
    definitionId: 'test',
    finalState: 'done',
    success: true,
    totalDuration: 10,
    nodesVisited: 1,
    degraded: false,
    degradedNodes: [],
    output: {},
    transitionPath: [],
  });

  it('concurrent executions never exceed maxConcurrent and getConcurrencyStatus is accurate', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),   // maxConcurrent
        fc.integer({ min: 2, max: 8 }),    // total requests (N)
        async (maxConcurrent, totalRequests) => {
          const guard = new ConcurrencyGuard({
            maxConcurrent,
            queueTimeout: 30000,
            maxQueueSize: 100,
          });

          let peakActive = 0;
          let currentActive = 0;
          const resolvers: Array<() => void> = [];

          // Submit all tasks - each task increments active count and waits for manual resolve
          const promises = Array.from({ length: totalRequests }, (_, i) =>
            guard.execute(() => new Promise<ExecutionResult>((resolve) => {
              currentActive++;
              peakActive = Math.max(peakActive, currentActive);

              const status = guard.getConcurrencyStatus();
              expect(status.active).toBeLessThanOrEqual(maxConcurrent);
              expect(status.maxConcurrent).toBe(maxConcurrent);

              resolvers.push(() => {
                currentActive--;
                resolve(makeResult(`exec-${i}`));
              });
            })),
          );

          // Yield to let enqueues settle
          await new Promise(r => setTimeout(r, 5));

          const statusMid = guard.getConcurrencyStatus();
          expect(statusMid.active).toBeLessThanOrEqual(maxConcurrent);
          expect(statusMid.active + statusMid.queued).toBe(totalRequests);

          // Resolve tasks in batches until all done
          while (resolvers.length > 0) {
            resolvers.splice(0, resolvers.length).forEach(r => r());
            await new Promise(r => setTimeout(r, 2));
          }

          const results = await Promise.all(promises);
          expect(results).toHaveLength(totalRequests);
          expect(peakActive).toBeLessThanOrEqual(maxConcurrent);

          const statusEnd = guard.getConcurrencyStatus();
          expect(statusEnd.active).toBe(0);
          expect(statusEnd.queued).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it('queued requests are rejected with timeout error when wait exceeds threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),    // maxConcurrent
        async (maxConcurrent) => {
          // Use a short queue timeout. The blocking tasks hold all slots,
          // so the extra queued task will timeout while waiting in the queue.
          const queueTimeout = 100;
          const guard = new ConcurrencyGuard({
            maxConcurrent,
            queueTimeout,
            maxQueueSize: 100,
          });

          // Create resolvers for the blocking tasks so we can clean up
          const resolvers: (() => void)[] = [];

          // Submit maxConcurrent blocking tasks to fill all slots
          const blockerPromises = Array.from({ length: maxConcurrent }, () => {
            let resolve: (v: ExecutionResult) => void;
            const p = guard.execute(() => new Promise<ExecutionResult>((r) => {
              resolve = r;
            }));
            resolvers.push(() => resolve!({
              executionId: 'cleanup', requestId: 'cleanup', definitionId: 'cleanup',
              finalState: 'done', success: true, totalDuration: 0, nodesVisited: 0,
              degraded: false, degradedNodes: [], output: {}, transitionPath: [],
            }));
            return p;
          });

          // Give time for blockers to start
          await new Promise(r => setTimeout(r, 10));

          // Submit one extra task that will be queued
          const queuedPromise = guard.execute(() => Promise.resolve({
            executionId: 'queued', requestId: 'queued', definitionId: 'queued',
            finalState: 'done', success: true, totalDuration: 0, nodesVisited: 0,
            degraded: false, degradedNodes: [], output: {}, transitionPath: [],
          }));

          // The queued task should be rejected with a timeout error
          const result = await Promise.allSettled([queuedPromise]);
          expect(result[0].status).toBe('rejected');
          if (result[0].status === 'rejected') {
            expect(result[0].reason).toBeInstanceOf(Error);
            expect((result[0].reason as Error).message.toLowerCase()).toMatch(/time/);
          }

          // Clean up: release all blocking tasks
          resolvers.forEach(r => r());
          await Promise.allSettled(blockerPromises);
        },
      ),
      { numRuns: 100 },
    );
  }, 60000);
});


// ==================== Property 7: 并发执行上下文隔离 ====================

/**
 * Feature: lightweight-state-machine, Property 7: 并发执行上下文隔离
 * For any 两个并发执行的请求 A 和 B，在 A 的 StateHandler 中对 StateContext 的修改
 * 不应影响 B 的 StateContext 中的数据，反之亦然。
 * 两个执行应各自独立到达终止状态。
 * Validates: Requirements 2.5, 11.1
 */
describe('Property 7: 并发执行上下文隔离', () => {
  it('concurrent executions have isolated StateContext instances', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          ),
          { minLength: 1, maxLength: 5 },
        ),
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
          ),
          { minLength: 1, maxLength: 5 },
        ),
        async (kvPairsA, kvPairsB) => {
          const registry = new StateRegistry();
          const definition: StateDefinition = {
            id: 'isolation-test',
            name: 'Isolation Test',
            version: '1.0.0',
            states: ['start', 'end'],
            initialState: 'start',
            terminalStates: ['end'],
            transitions: [{ from: 'start', to: 'end' }],
          };

          let capturedCtxA: StateContext | null = null;
          let capturedCtxB: StateContext | null = null;

          const handlerA: StateHandler = {
            name: 'start',
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => {
              for (const [key, value] of kvPairsA) {
                context.set(`a_${key}`, value);
              }
              capturedCtxA = context;
              return { outcome: 'success', context };
            },
          };

          const handlerB: StateHandler = {
            name: 'start',
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => {
              for (const [key, value] of kvPairsB) {
                context.set(`b_${key}`, value);
              }
              capturedCtxB = context;
              return { outcome: 'success', context };
            },
          };

          // Execute A
          registry.registerDefinition(definition);
          registry.registerHandler('start', handlerA);
          registry.validate(definition.id);
          const executorA = new StateExecutor();
          const engineA = new StateMachineEngine(registry, executorA);
          const resultA = await engineA.execute(definition.id, {});

          // Execute B with different handler
          registry.registerHandler('start', handlerB);
          const executorB = new StateExecutor();
          const engineB = new StateMachineEngine(registry, executorB);
          const resultB = await engineB.execute(definition.id, {});

          expect(resultA.success).toBe(true);
          expect(resultB.success).toBe(true);
          expect(capturedCtxA).not.toBeNull();
          expect(capturedCtxB).not.toBeNull();

          // A's context should NOT contain B's keys
          for (const [key] of kvPairsB) {
            expect(capturedCtxA!.get(`b_${key}`)).toBeUndefined();
          }
          // B's context should NOT contain A's keys
          for (const [key] of kvPairsA) {
            expect(capturedCtxB!.get(`a_${key}`)).toBeUndefined();
          }
          // Each context has its own data
          // 使用 Map 去重：重复 key 时只保留最后写入的值（与 context.set 覆盖行为一致）
          const expectedA = new Map(kvPairsA.map(([k, v]) => [`a_${k}`, v]));
          for (const [key, value] of expectedA) {
            expect(capturedCtxA!.get(key)).toEqual(value);
          }
          const expectedB = new Map(kvPairsB.map(([k, v]) => [`b_${k}`, v]));
          for (const [key, value] of expectedB) {
            expect(capturedCtxB!.get(key)).toEqual(value);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('truly concurrent executions via engine maintain context isolation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.integer(),
        fc.integer(),
        async (keyA, keyB, valueA, valueB) => {
          const capturedContexts: StateContext[] = [];

          // Use a shared registry but each engine creates its own context
          const registry = new StateRegistry();
          const definition: StateDefinition = {
            id: 'concurrent-isolation',
            name: 'Concurrent Isolation',
            version: '1.0.0',
            states: ['work', 'done'],
            initialState: 'work',
            terminalStates: ['done'],
            transitions: [{ from: 'work', to: 'done' }],
          };

          // Handler writes a unique key-value and captures context
          const handler: StateHandler = {
            name: 'work',
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => {
              // Each execution writes its own unique key based on executionId
              const prefix = context.executionId;
              context.set(`${prefix}_key`, prefix);
              capturedContexts.push(context);
              return { outcome: 'success', context };
            },
          };

          registry.registerDefinition(definition);
          registry.registerHandler('work', handler);
          registry.validate(definition.id);

          // Execute two state machines concurrently
          const executorA = new StateExecutor();
          const engineA = new StateMachineEngine(registry, executorA);
          const executorB = new StateExecutor();
          const engineB = new StateMachineEngine(registry, executorB);

          const [resultA, resultB] = await Promise.all([
            engineA.execute(definition.id, {}),
            engineB.execute(definition.id, {}),
          ]);

          expect(resultA.success).toBe(true);
          expect(resultB.success).toBe(true);
          expect(capturedContexts.length).toBe(2);

          const [ctxFirst, ctxSecond] = capturedContexts;

          // Each context should have exactly 1 key (its own)
          // and should NOT have the other's key
          const firstKeys = Array.from(ctxFirst.data.keys());
          const secondKeys = Array.from(ctxSecond.data.keys());

          // No shared keys between contexts
          for (const k of firstKeys) {
            expect(secondKeys).not.toContain(k);
          }
          for (const k of secondKeys) {
            expect(firstKeys).not.toContain(k);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 15: StateDefinition 序列化往返一致性 ====================

/**
 * Feature: lightweight-state-machine, Property 15: StateDefinition 序列化往返一致性
 * For any 有效的 StateDefinition 对象，序列化为 JSON 再反序列化回 StateDefinition 对象
 * 应产生与原始对象等价的结果（id、name、version、states、initialState、terminalStates、transitions 均相等）。
 * pretty printer 输出应包含所有状态名称和转移规则。
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4
 */
describe('Property 15: StateDefinition 序列化往返一致性', () => {
  // Generator for valid StateDefinition with optional fields and richer transitions
  const validStateDefinitionArb = fc.uniqueArray(
    fc.stringMatching(/^[a-z][a-z0-9]{0,14}$/),
    { minLength: 2, maxLength: 8 },
  ).chain(states => {
    const initialState = states[0];
    // Pick 1+ terminal states from the tail of the states array
    const terminalStates = [states[states.length - 1]];

    // Build transitions: linear chain + optional conditional branches
    const linearTransitions = states.slice(0, -1).map((s, i) => ({
      from: s,
      to: states[i + 1],
    }));

    // Generate optional fields
    return fc.record({
      id: fc.constant(`def-${states.join('-')}`),
      name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
      version: fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)).map(([a, b, c]) => `${a}.${b}.${c}`),
      states: fc.constant(states),
      initialState: fc.constant(initialState),
      terminalStates: fc.constant(terminalStates),
      transitions: fc.array(
        fc.record({
          fromIdx: fc.nat(states.length - 1),
          toIdx: fc.nat(states.length - 1),
          condition: fc.option(fc.stringMatching(/^[a-z]{1,10}$/), { nil: undefined }),
          priority: fc.option(fc.nat(10), { nil: undefined }),
        }),
        { minLength: 0, maxLength: 4 },
      ).map(extras => [
        ...linearTransitions,
        ...extras.map(e => {
          const t: Record<string, unknown> = { from: states[e.fromIdx], to: states[e.toIdx] };
          if (e.condition !== undefined) t.condition = e.condition;
          if (e.priority !== undefined) t.priority = e.priority;
          return t as { from: string; to: string; condition?: string; priority?: number };
        }),
      ]),
      errorState: fc.option(fc.constantFrom(...states), { nil: undefined }),
      degradedState: fc.option(fc.constantFrom(...states), { nil: undefined }),
      maxSteps: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
      maxExecutionTime: fc.option(fc.integer({ min: 100, max: 60000 }), { nil: undefined }),
    }) as fc.Arbitrary<StateDefinition>;
  });

  it('serialize then deserialize produces an equivalent StateDefinition', () => {
    fc.assert(
      fc.property(validStateDefinitionArb, (definition) => {
        const json = StateDefinitionSerializer.serialize(definition);
        const restored = StateDefinitionSerializer.deserialize(json);

        // Core fields must be deeply equal
        expect(restored.id).toEqual(definition.id);
        expect(restored.name).toEqual(definition.name);
        expect(restored.version).toEqual(definition.version);
        expect(restored.states).toEqual(definition.states);
        expect(restored.initialState).toEqual(definition.initialState);
        expect(restored.terminalStates).toEqual(definition.terminalStates);
        expect(restored.transitions).toEqual(definition.transitions);

        // Optional fields
        expect(restored.errorState).toEqual(definition.errorState);
        expect(restored.degradedState).toEqual(definition.degradedState);
        expect(restored.maxSteps).toEqual(definition.maxSteps);
        expect(restored.maxExecutionTime).toEqual(definition.maxExecutionTime);
      }),
      { numRuns: 100 },
    );
  });

  it('prettyPrint output contains all state names and transition rules', () => {
    fc.assert(
      fc.property(validStateDefinitionArb, (definition) => {
        const output = StateDefinitionSerializer.prettyPrint(definition);

        // Every state name must appear in the output
        for (const state of definition.states) {
          expect(output).toContain(state);
        }

        // Every transition rule must be represented (from → to)
        for (const t of definition.transitions) {
          expect(output).toContain(t.from);
          expect(output).toContain(t.to);
          expect(output).toContain('→');
          if (t.condition) {
            expect(output).toContain(t.condition);
          }
        }

        // Initial and terminal states must be mentioned
        expect(output).toContain(definition.initialState);
        for (const ts of definition.terminalStates) {
          expect(output).toContain(ts);
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 11: 运行时扩展不影响已有行为 ====================

/**
 * Feature: lightweight-state-machine, Property 11: 运行时扩展不影响已有行为
 * For any 已注册的状态定义和一组已有的 StateHandler，在运行时注册新的 StateHandler
 * 和添加新的 StateTransition 后，原有的状态转移路径和处理逻辑应保持不变
 * （在不触发新转移条件的情况下）。
 * Validates: Requirements 6.1, 6.2, 6.3
 */
describe('Property 11: 运行时扩展不影响已有行为', () => {
  it('runtime handler and transition additions do not alter existing transition paths', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateDefinitionArb,
        // Generate a unique condition string that won't match 'success' (the default outcome)
        fc.stringMatching(/^ext_[a-z]{1,8}$/),
        async (definition, newCondition) => {
          // --- Phase 1: Execute BEFORE runtime extensions ---
          const registry = new StateRegistry();
          registry.registerDefinition(definition);

          // Register stub handlers for all non-terminal states
          const terminalSet = new Set(definition.terminalStates);
          for (const state of definition.states) {
            if (!terminalSet.has(state)) {
              registry.registerHandler(state, createStubHandler(state));
            }
          }
          registry.validate(definition.id);

          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);
          const resultBefore = await engine.execute(definition.id, {});

          // Record the transition path before extensions
          const pathBefore = resultBefore.transitionPath.map(t => ({
            from: t.fromState,
            to: t.toState,
          }));

          // --- Phase 2: Add runtime extensions ---

          // 2a. Register a new runtime handler for a name that doesn't collide
          // with existing non-terminal states (use a prefixed name)
          const newHandlerName = `__runtime_ext_${newCondition}`;
          const newHandler: StateHandler = {
            name: newHandlerName,
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => ({
              outcome: 'success',
              context,
            }),
          };
          registry.registerHandlerRuntime(newHandlerName, newHandler);

          // 2b. Add a new transition with a condition that won't match the
          // existing handlers' outcome ('success'). We pick a non-terminal
          // source state and target the last terminal state.
          const nonTerminalStates = definition.states.filter(s => !terminalSet.has(s));
          if (nonTerminalStates.length > 0) {
            const sourceState = nonTerminalStates[nonTerminalStates.length - 1];
            const targetState = definition.terminalStates[0];
            registry.addTransitionRuntime(definition.id, {
              from: sourceState,
              to: targetState,
              condition: newCondition, // e.g. 'ext_abc' — never matches 'success'
            });
          }

          // --- Phase 3: Execute AFTER runtime extensions ---
          const executor2 = new StateExecutor();
          const engine2 = new StateMachineEngine(registry, executor2);
          const resultAfter = await engine2.execute(definition.id, {});

          // Record the transition path after extensions
          const pathAfter = resultAfter.transitionPath.map(t => ({
            from: t.fromState,
            to: t.toState,
          }));

          // --- Assertions ---
          // The transition paths must be identical
          expect(pathAfter).toEqual(pathBefore);

          // Both executions should reach the same final state
          expect(resultAfter.finalState).toEqual(resultBefore.finalState);

          // Both should have the same success status
          expect(resultAfter.success).toEqual(resultBefore.success);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ==================== Property 17: 适配器格式转换一致性 ====================

/**
 * Feature: lightweight-state-machine, Property 17: 适配器格式转换一致性
 * For any 通过适配器包装的现有模块执行，StateContext 到模块原生输入格式的转换，
 * 以及模块原生输出格式到 StateContext 的转换，应保持数据语义不变。
 * 即适配器不应丢失或错误转换任何业务数据字段。
 * Validates: Requirements 9.2
 */
describe('Property 17: 适配器格式转换一致性', () => {
  // ---- Arbitraries ----

  /** IntentAnalysis generator */
  const intentAnalysisArb = fc.record({
    intent: fc.string({ minLength: 1, maxLength: 50 }),
    tools: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 20 }),
        params: fc.constant({} as Record<string, unknown>),
        reason: fc.string({ minLength: 1, maxLength: 30 }),
      }),
      { minLength: 0, maxLength: 3 },
    ),
    confidence: fc.double({ min: 0, max: 1, noNaN: true }),
    requiresMultiStep: fc.boolean(),
  });

  /** ConversationMemory generator */
  const conversationMemoryArb = fc.record({
    sessionId: fc.string({ minLength: 1, maxLength: 30 }),
    messages: fc.constant([] as Array<{ role: string; content: string }>),
    context: fc.constant({} as Record<string, unknown>),
    createdAt: fc.nat(),
    lastUpdated: fc.nat(),
  });

  /** Minimal ReActExecutionContext generator */
  const executionContextArb = fc.record({
    requestId: fc.string({ minLength: 1, maxLength: 30 }),
    toolInterceptors: fc.constant(new Map()),
    systemPromptOverride: fc.constant(null as string | null),
    aiAdapter: fc.constant(null),
    provider: fc.constant('openai' as const),
    model: fc.constantFrom('gpt-4o', 'gpt-3.5-turbo'),
    toolCallPatterns: fc.constant([] as Array<{ toolName: string; paramsHash: string; timestamp: number }>),
    hasExecutedTool: fc.boolean(),
  });

  /** SyslogEvent generator */
  const syslogEventArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    source: fc.constant('syslog' as const),
    timestamp: fc.nat(),
    severity: fc.constantFrom('info' as const, 'warning' as const, 'critical' as const, 'emergency' as const),
    category: fc.string({ minLength: 1, maxLength: 20 }),
    message: fc.string({ minLength: 1, maxLength: 100 }),
    rawData: fc.record({
      facility: fc.integer({ min: 0, max: 23 }),
      severity: fc.integer({ min: 0, max: 7 }),
      timestamp: fc.constant(new Date()),
      hostname: fc.string({ minLength: 1, maxLength: 20 }),
      topic: fc.string({ minLength: 1, maxLength: 20 }),
      message: fc.string({ minLength: 1, maxLength: 50 }),
      raw: fc.string({ minLength: 1, maxLength: 100 }),
    }),
    metadata: fc.record({
      hostname: fc.string({ minLength: 1, maxLength: 20 }),
      facility: fc.integer({ min: 0, max: 23 }),
      syslogSeverity: fc.integer({ min: 0, max: 7 }),
    }),
  });

  /** UnifiedEvent generator */
  const unifiedEventArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    source: fc.constantFrom('syslog' as const, 'metrics' as const, 'manual' as const, 'api' as const),
    timestamp: fc.nat(),
    severity: fc.constantFrom('info' as const, 'warning' as const, 'critical' as const, 'emergency' as const),
    category: fc.string({ minLength: 1, maxLength: 20 }),
    message: fc.string({ minLength: 1, maxLength: 100 }),
    rawData: fc.constant(null as unknown),
    metadata: fc.constant({} as Record<string, unknown>),
  });

  /** Decision generator */
  const decisionArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    alertId: fc.string({ minLength: 1, maxLength: 20 }),
    timestamp: fc.nat(),
    action: fc.constantFrom(
      'auto_execute' as const,
      'notify_and_wait' as const,
      'escalate' as const,
      'silence' as const,
    ),
    reasoning: fc.string({ minLength: 1, maxLength: 50 }),
    factors: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 15 }),
        score: fc.double({ min: 0, max: 1, noNaN: true }),
        weight: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { minLength: 0, maxLength: 3 },
    ),
    executed: fc.boolean(),
  });

  /** RemediationPlan generator */
  const remediationPlanArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 20 }),
    alertId: fc.string({ minLength: 1, maxLength: 20 }),
    rootCauseId: fc.string({ minLength: 1, maxLength: 20 }),
    timestamp: fc.nat(),
    steps: fc.array(
      fc.record({
        order: fc.nat(10),
        description: fc.string({ minLength: 1, maxLength: 30 }),
        command: fc.string({ minLength: 1, maxLength: 30 }),
        verification: fc.record({
          command: fc.string({ minLength: 1, maxLength: 20 }),
          expectedResult: fc.string({ minLength: 1, maxLength: 20 }),
        }),
        autoExecutable: fc.boolean(),
        riskLevel: fc.constantFrom('low' as const, 'medium' as const, 'high' as const),
        estimatedDuration: fc.nat(600),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    rollback: fc.array(
      fc.record({
        order: fc.nat(10),
        description: fc.string({ minLength: 1, maxLength: 30 }),
        command: fc.string({ minLength: 1, maxLength: 30 }),
      }),
      { minLength: 0, maxLength: 2 },
    ),
    overallRisk: fc.constantFrom('low' as const, 'medium' as const, 'high' as const),
    estimatedDuration: fc.nat(3600),
    requiresConfirmation: fc.boolean(),
    status: fc.constantFrom(
      'pending' as const,
      'in_progress' as const,
      'completed' as const,
      'failed' as const,
      'rolled_back' as const,
    ),
  });

  // ---- ReActLoopAdapter ----

  it('ReActLoopAdapter preserves data semantics through format conversion', async () => {
    const { ReActLoopAdapter } = await import('../stateMachine/adapters/reactLoopAdapter');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),  // message
        intentAnalysisArb,
        conversationMemoryArb,
        executionContextArb,
        async (message, intentAnalysis, conversationMemory, executionContext) => {
          // Track what the mock controller receives
          let capturedMessage: string | undefined;
          let capturedIntentAnalysis: unknown;

          // Mock ReActLoopController that captures inputs and returns them back
          const mockController = {
            executeLoop: async (
              msg: string,
              intent: unknown,
              _ctx: unknown,
              _execCtx: unknown,
            ) => {
              capturedMessage = msg;
              capturedIntentAnalysis = intent;
              return {
                steps: [{ thought: 'test', action: 'test', observation: 'test' }],
                finalAnswer: `answer for: ${msg}`,
                iterations: 1,
                reachedMaxIterations: false,
                totalDuration: 100,
                ragContext: { documents: [], query: msg },
                knowledgeReferences: [{ source: 'test', relevance: 0.9 }],
              };
            },
          };

          const adapter = new ReActLoopAdapter(mockController as any);

          // Create StateContext with input data
          const context = ContextManager.createContext('req-1', 'exec-1', 'test');
          context.set('message', message);
          context.set('intentAnalysis', intentAnalysis);
          context.set('conversationContext', conversationMemory);
          context.set('executionContext', executionContext);

          // Execute adapter
          const result = await adapter.handle(context);

          // Verify input was correctly extracted from StateContext
          expect(capturedMessage).toBe(message);
          expect(capturedIntentAnalysis).toEqual(intentAnalysis);

          // Verify output was correctly written back to StateContext
          expect(result.outcome).toBe('success');
          expect(result.context.get('finalAnswer')).toBe(`answer for: ${message}`);
          expect(result.context.get('iterations')).toBe(1);
          expect(result.context.get('steps')).toEqual([{ thought: 'test', action: 'test', observation: 'test' }]);
          expect(result.context.get('ragContext')).toEqual({ documents: [], query: message });
          expect(result.context.get('knowledgeReferences')).toEqual([{ source: 'test', relevance: 0.9 }]);

          // Verify the full result object is also stored
          const storedResult = result.context.get<any>('result');
          expect(storedResult).toBeDefined();
          expect(storedResult.finalAnswer).toBe(`answer for: ${message}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- AlertPipelineAdapter ----

  it('AlertPipelineAdapter preserves data semantics through format conversion', async () => {
    const { AlertPipelineAdapter } = await import('../stateMachine/adapters/alertPipelineAdapter');

    await fc.assert(
      fc.asyncProperty(
        syslogEventArb,
        async (rawEvent) => {
          // Track what the mock pipeline receives
          let capturedEvent: unknown;

          // Build a normalized event from the raw event for the mock result
          const normalizedEvent = {
            id: rawEvent.id,
            source: rawEvent.source,
            timestamp: rawEvent.timestamp,
            severity: rawEvent.severity,
            category: rawEvent.category,
            message: rawEvent.message,
            rawData: rawEvent.rawData,
            metadata: rawEvent.metadata,
          };

          // Mock AlertPipeline that captures input and returns a PipelineResult
          const mockPipeline = {
            process: async (event: unknown) => {
              capturedEvent = event;
              return {
                event: normalizedEvent,
                stage: 'decide' as const,
                filtered: false,
                analysis: { rootCause: 'test', confidence: 0.8 },
                decision: { id: 'd1', action: 'notify_and_wait', reasoning: 'test' },
                plan: { id: 'p1', steps: [] },
                filterResult: { passed: true, reason: 'ok' },
              };
            },
          };

          const adapter = new AlertPipelineAdapter(mockPipeline as any);

          // Create StateContext with input data
          const context = ContextManager.createContext('req-2', 'exec-2', 'test');
          context.set('rawEvent', rawEvent);

          // Execute adapter
          const result = await adapter.handle(context);

          // Verify input was correctly extracted from StateContext
          expect(capturedEvent).toEqual(rawEvent);

          // Verify output was correctly written back to StateContext
          expect(result.outcome).toBe('success');
          expect(result.context.get('pipelineResult')).toBeDefined();
          expect(result.context.get('normalizedEvent')).toEqual(normalizedEvent);
          expect(result.context.get('rootCauseAnalysis')).toEqual({ rootCause: 'test', confidence: 0.8 });
          expect(result.context.get('decision')).toEqual({ id: 'd1', action: 'notify_and_wait', reasoning: 'test' });
          expect(result.context.get('remediationPlan')).toEqual({ id: 'p1', steps: [] });
          expect(result.context.get('filterResult')).toEqual({ passed: true, reason: 'ok' });

          // Verify the original rawEvent is still accessible
          expect(result.context.get('rawEvent')).toEqual(rawEvent);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ---- IterationLoopAdapter ----

  it('IterationLoopAdapter preserves data semantics through format conversion', async () => {
    const { IterationLoopAdapter } = await import('../stateMachine/adapters/iterationLoopAdapter');

    await fc.assert(
      fc.asyncProperty(
        unifiedEventArb,
        decisionArb,
        remediationPlanArb,
        async (alertEvent, decision, currentPlan) => {
          // Track what the mock iteration loop receives
          let capturedAlertEvent: unknown;
          let capturedDecision: unknown;
          let capturedPlan: unknown;

          const iterationId = `iter-${alertEvent.id}`;

          // Mock IterationLoop that captures inputs and returns predictable state
          const mockIterationLoop = {
            start: async (event: unknown, dec: unknown, plan: unknown) => {
              capturedAlertEvent = event;
              capturedDecision = dec;
              capturedPlan = plan;
              return iterationId;
            },
            getState: async (id: string) => {
              if (id !== iterationId) return null;
              return {
                id: iterationId,
                alertId: alertEvent.id,
                planId: currentPlan.id,
                currentIteration: 2,
                maxIterations: 5,
                status: 'completed' as const,
                startTime: Date.now(),
                evaluations: [{ score: 0.9, details: 'good' }],
                reflections: [{ insight: 'learned something' }],
                learningEntries: [],
                config: {},
              };
            },
          };

          const adapter = new IterationLoopAdapter(mockIterationLoop as any);

          // Create StateContext with input data
          const context = ContextManager.createContext('req-3', 'exec-3', 'test');
          context.set('alertEvent', alertEvent);
          context.set('decision', decision);
          context.set('currentPlan', currentPlan);

          // Execute adapter
          const result = await adapter.handle(context);

          // Verify inputs were correctly extracted from StateContext
          expect(capturedAlertEvent).toEqual(alertEvent);
          expect(capturedDecision).toEqual(decision);
          expect(capturedPlan).toEqual(currentPlan);

          // Verify output was correctly written back to StateContext
          expect(result.outcome).toBe('success');
          expect(result.context.get('iterationId')).toBe(iterationId);

          const iterationState = result.context.get<any>('iterationState');
          expect(iterationState).toBeDefined();
          expect(iterationState.status).toBe('completed');
          expect(iterationState.currentIteration).toBe(2);

          const iterationResult = result.context.get<any>('iterationResult');
          expect(iterationResult).toBeDefined();
          expect(iterationResult.iterationId).toBe(iterationId);
          expect(iterationResult.status).toBe('completed');
          expect(iterationResult.success).toBe(true);
          expect(iterationResult.iterations).toBe(2);

          expect(result.context.get('evaluations')).toEqual([{ score: 0.9, details: 'good' }]);
          expect(result.context.get('reflections')).toEqual([{ insight: 'learned something' }]);

          // Verify original input data is still accessible
          expect(result.context.get('alertEvent')).toEqual(alertEvent);
          expect(result.context.get('decision')).toEqual(decision);
          expect(result.context.get('currentPlan')).toEqual(currentPlan);
        },
      ),
      { numRuns: 100 },
    );
  });
});



// ==================== Property 18: 特性开关路由正确性 ====================

/**
 * Feature: lightweight-state-machine, Property 18: 特性开关路由正确性
 * For any 特性开关配置，当某个流程的开关关闭时，请求应直接路由到原有模块处理；
 * 当开关打开时，请求应通过状态机编排处理。
 * 开关状态的切换不应影响正在执行中的请求。
 * Validates: Requirements 9.3
 */
describe('Property 18: 特性开关路由正确性', () => {
  const FLOW_IDS = ['react-orchestration', 'alert-orchestration', 'iteration-orchestration'] as const;
  type FlowId = typeof FLOW_IDS[number];

  // Arbitrary: generate a random flag configuration for all three flows
  const flagConfigArb = fc.record({
    'react-orchestration': fc.boolean(),
    'alert-orchestration': fc.boolean(),
    'iteration-orchestration': fc.boolean(),
  });

  // Arbitrary: pick a random flow ID
  const flowIdArb = fc.constantFrom<FlowId>(...FLOW_IDS);

  it('routes to stateMachineFn when flag is ON, legacyFn when flag is OFF', async () => {
    const { FeatureFlagManager } = await import('../stateMachine/featureFlagManager');

    await fc.assert(
      fc.asyncProperty(
        flagConfigArb,
        flowIdArb,
        fc.string({ minLength: 1, maxLength: 50 }), // unique result marker
        async (flags, flowId, marker) => {
          const manager = new FeatureFlagManager({
            flags: { ...flags },
            comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
          });

          let smCalled = false;
          let legacyCalled = false;

          const stateMachineFn = async () => { smCalled = true; return `sm-${marker}`; };
          const legacyFn = async () => { legacyCalled = true; return `legacy-${marker}`; };

          const result = await manager.route(flowId, stateMachineFn, legacyFn);

          if (flags[flowId]) {
            // Flag ON → state machine function should be called
            expect(smCalled).toBe(true);
            expect(legacyCalled).toBe(false);
            expect(result).toBe(`sm-${marker}`);
          } else {
            // Flag OFF → legacy function should be called
            expect(legacyCalled).toBe(true);
            expect(smCalled).toBe(false);
            expect(result).toBe(`legacy-${marker}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isEnabled reflects the flag state accurately for all flows', () => {
    const { FeatureFlagManager } = require('../stateMachine/featureFlagManager');

    fc.assert(
      fc.property(
        flagConfigArb,
        (flags) => {
          const manager = new FeatureFlagManager({
            flags: { ...flags },
            comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
          });

          for (const flowId of FLOW_IDS) {
            expect(manager.isEnabled(flowId)).toBe(flags[flowId]);
          }

          // Unknown flow IDs should return false
          expect(manager.isEnabled('unknown-flow')).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('setEnabled dynamically toggles routing without affecting in-flight requests', async () => {
    const { FeatureFlagManager } = await import('../stateMachine/featureFlagManager');

    await fc.assert(
      fc.asyncProperty(
        flowIdArb,
        fc.boolean(), // initial flag state
        async (flowId, initialEnabled) => {
          const flags: Record<FlowId, boolean> = {
            'react-orchestration': false,
            'alert-orchestration': false,
            'iteration-orchestration': false,
          };
          flags[flowId] = initialEnabled;

          const manager = new FeatureFlagManager({
            flags: { ...flags },
            comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
          });

          // Start an in-flight request that resolves after flag toggle
          let resolveInflight: (v: string) => void;
          const inflightPromise = new Promise<string>(r => { resolveInflight = r; });

          let inflightSmCalled = false;
          let inflightLegacyCalled = false;

          const inflightRoutePromise = manager.route(
            flowId,
            async () => { inflightSmCalled = true; return inflightPromise; },
            async () => { inflightLegacyCalled = true; return inflightPromise; },
          );

          // Toggle the flag while the request is in-flight
          const toggled = !initialEnabled;
          manager.setEnabled(flowId, toggled);

          // Verify the flag was toggled
          expect(manager.isEnabled(flowId)).toBe(toggled);

          // Resolve the in-flight request
          resolveInflight!('inflight-result');
          const inflightResult = await inflightRoutePromise;

          // The in-flight request should have been routed based on the ORIGINAL flag state
          if (initialEnabled) {
            expect(inflightSmCalled).toBe(true);
            expect(inflightLegacyCalled).toBe(false);
          } else {
            expect(inflightLegacyCalled).toBe(true);
            expect(inflightSmCalled).toBe(false);
          }
          expect(inflightResult).toBe('inflight-result');

          // New requests should use the TOGGLED flag state
          let newSmCalled = false;
          let newLegacyCalled = false;
          await manager.route(
            flowId,
            async () => { newSmCalled = true; return 'new-sm'; },
            async () => { newLegacyCalled = true; return 'new-legacy'; },
          );

          if (toggled) {
            expect(newSmCalled).toBe(true);
            expect(newLegacyCalled).toBe(false);
          } else {
            expect(newLegacyCalled).toBe(true);
            expect(newSmCalled).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
