/**
 * 保持性属性测试 - 非缺陷输入行为不变性
 *
 * 这些测试在未修复代码上运行时应当通过，捕获当前基线行为。
 * 修复后重新运行以确认无回归。
 *
 * 遵循"观察优先"方法论：先在未修复代码上观察行为，再编写测试捕获该行为。
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**
 */

// Jest globals: describe, it, expect are available globally
import * as fc from 'fast-check';
import { StateMachineEngine } from '../stateMachineEngine';
import { StateRegistry } from '../stateRegistry';
import { StateExecutor } from '../stateExecutor';
import {
  StateDefinition,
  StateHandler,
  StateContext,
  TransitionResult,
  StateTransitionEvent,
} from '../types';

// ============================================================
// Test Helpers
// ============================================================

/** Create a handler that writes its name to context and returns the given outcome */
function createHandler(
  name: string,
  outcome: string = 'success',
  dataKey?: string,
  dataValue?: unknown,
): StateHandler {
  return {
    name,
    canHandle: () => true,
    handle: async (context: StateContext): Promise<TransitionResult> => {
      if (dataKey !== undefined) {
        context.set(dataKey, dataValue);
      }
      context.set(`${name}_executed`, true);
      return { outcome, context };
    },
  };
}

/** Create a handler that throws an error */
function createThrowingHandler(name: string, errorMessage: string): StateHandler {
  return {
    name,
    canHandle: () => true,
    handle: async (): Promise<TransitionResult> => {
      throw new Error(errorMessage);
    },
  };
}


// ============================================================
// Property 1: 非终止状态执行保持
// ============================================================

describe('Preservation: Non-terminal state execution behavior', () => {
  /**
   * **Validates: Requirements 3.1**
   *
   * For any multi-state flow where NO state is terminal during execution,
   * handlers execute in order, outcomes match transitions, and events are emitted.
   * This behavior should remain unchanged after fixes.
   */
  it('should execute handlers in order, match outcomes, and emit transition events for non-terminal states', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a chain length between 2 and 6 (non-terminal states before the terminal)
        fc.integer({ min: 2, max: 6 }),
        async (chainLength: number) => {
          const registry = new StateRegistry();
          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          // Build a linear chain: s0 → s1 → ... → s(n-1) → terminal
          const states: string[] = [];
          for (let i = 0; i < chainLength; i++) {
            states.push(`s${i}`);
          }
          states.push('terminal');

          const transitions = [];
          for (let i = 0; i < chainLength; i++) {
            transitions.push({
              from: `s${i}`,
              to: i < chainLength - 1 ? `s${i + 1}` : 'terminal',
              condition: 'success',
            });
          }

          const definition: StateDefinition = {
            id: 'preservation-chain',
            name: 'Chain Test',
            version: '1.0',
            states,
            initialState: 's0',
            terminalStates: ['terminal'],
            transitions,
          };

          registry.registerDefinition(definition);

          // Register handlers for all non-terminal states
          const executionOrder: string[] = [];
          for (let i = 0; i < chainLength; i++) {
            const handlerName = `handler_s${i}`;
            const handler: StateHandler = {
              name: handlerName,
              canHandle: () => true,
              handle: async (context: StateContext): Promise<TransitionResult> => {
                executionOrder.push(handlerName);
                context.set(`${handlerName}_executed`, true);
                return { outcome: 'success', context };
              },
            };
            registry.registerHandler(`s${i}`, handler);
          }

          // Track transition events
          const transitionEvents: StateTransitionEvent[] = [];
          engine.on('transition', (event: StateTransitionEvent) => {
            transitionEvents.push(event);
          });

          const result = await engine.execute('preservation-chain', {});

          // All non-terminal handlers should have executed in order
          expect(executionOrder).toHaveLength(chainLength);
          for (let i = 0; i < chainLength; i++) {
            expect(executionOrder[i]).toBe(`handler_s${i}`);
          }

          // Transition events should match the chain
          expect(transitionEvents).toHaveLength(chainLength);
          for (let i = 0; i < chainLength; i++) {
            expect(transitionEvents[i].fromState).toBe(`s${i}`);
            expect(transitionEvents[i].toState).toBe(
              i < chainLength - 1 ? `s${i + 1}` : 'terminal',
            );
          }

          // Final state should be terminal
          expect(result.finalState).toBe('terminal');
          // On unfixed code, success is true when finalState is in terminalStates
          expect(result.success).toBe(true);

          // Transition path should be recorded
          expect(result.transitionPath).toHaveLength(chainLength);

          // Handler data should be in output
          for (let i = 0; i < chainLength; i++) {
            expect(result.output[`handler_s${i}_executed`]).toBe(true);
          }

          engine.removeAllListeners();
        },
      ),
      { numRuns: 20 },
    );
  });
});


// ============================================================
// Property 2: maxSteps 安全阀保持
// ============================================================

describe('Preservation: maxSteps safety valve behavior', () => {
  /**
   * **Validates: Requirements 3.2**
   *
   * For execution sequences exceeding maxSteps, the engine should correctly
   * terminate with an error. This behavior should remain unchanged after fixes.
   */
  it('should terminate with error when maxSteps is exceeded', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate maxSteps between 1 and 5 (small values to trigger quickly)
        fc.integer({ min: 1, max: 5 }),
        async (maxSteps: number) => {
          const registry = new StateRegistry();
          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          // Create a cycle: s0 → s1 → s0 (infinite loop)
          // With a low maxSteps, the engine should terminate
          const definition: StateDefinition = {
            id: 'preservation-maxsteps',
            name: 'MaxSteps Test',
            version: '1.0',
            states: ['s0', 's1', 'terminal'],
            initialState: 's0',
            terminalStates: ['terminal'],
            transitions: [
              { from: 's0', to: 's1', condition: 'loop' },
              { from: 's1', to: 's0', condition: 'loop' },
              // Unreachable terminal transition (handlers always return 'loop')
              { from: 's0', to: 'terminal', condition: 'done' },
            ],
            maxSteps,
          };

          registry.registerDefinition(definition);
          registry.registerHandler('s0', createHandler('handler_s0', 'loop'));
          registry.registerHandler('s1', createHandler('handler_s1', 'loop'));

          const result = await engine.execute('preservation-maxsteps', {});

          // Engine should have terminated due to maxSteps
          expect(result.success).toBe(false);
          expect(result.error).toBeDefined();
          expect(result.error).toContain(`Max steps (${maxSteps}) exceeded`);

          // The number of transitions should be at most maxSteps
          expect(result.transitionPath.length).toBeLessThanOrEqual(maxSteps);
        },
      ),
      { numRuns: 20 },
    );
  });
});


// ============================================================
// Property 3: 异常处理保持
// ============================================================

describe('Preservation: Exception handling transitions to errorState', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * When a handler throws an exception, the engine should catch it and
   * transition to the errorState. This behavior should remain unchanged.
   */
  it('should transition to errorState when handler throws an exception', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate an error message string
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (errorMessage: string) => {
          const registry = new StateRegistry();
          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          const definition: StateDefinition = {
            id: 'preservation-error',
            name: 'Error Handling Test',
            version: '1.0',
            states: ['start', 'errorHandler', 'terminal'],
            initialState: 'start',
            terminalStates: ['terminal', 'errorHandler'],
            errorState: 'errorHandler',
            transitions: [
              { from: 'start', to: 'terminal', condition: 'success' },
            ],
          };

          registry.registerDefinition(definition);
          // Handler that throws — StateExecutor catches and returns 'error' outcome
          registry.registerHandler('start', createThrowingHandler('startHandler', errorMessage));

          const result = await engine.execute('preservation-error', {});

          // Engine should have transitioned to errorState
          expect(result.finalState).toBe('errorHandler');
          // On unfixed code, the engine transitions to errorState but since
          // errorHandler is terminal, the loop exits without executing its handler.
          // The error field should contain the handler's error message.
          expect(result.error).toBeDefined();
          expect(result.error).toContain(errorMessage);

          // Transition path should show the transition to errorState
          expect(result.transitionPath.length).toBeGreaterThanOrEqual(1);
          const lastTransition = result.transitionPath[result.transitionPath.length - 1];
          expect(lastTransition.toState).toBe('errorHandler');
        },
      ),
      { numRuns: 20 },
    );
  });
});


// ============================================================
// Property 4: StateContext 类型安全保持
// ============================================================

describe('Preservation: StateContext type-safe get/set behavior', () => {
  /**
   * **Validates: Requirements 3.7**
   *
   * StateContext's get/set methods should maintain type safety and data integrity.
   * This behavior should remain unchanged after fixes.
   */
  it('should preserve data integrity through get/set across handler executions', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate key-value pairs to store in context
        fc.record({
          stringVal: fc.string({ minLength: 0, maxLength: 100 }),
          numberVal: fc.double({ min: -1e6, max: 1e6, noNaN: true }),
          boolVal: fc.boolean(),
          arrayVal: fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 0, maxLength: 10 }),
        }),
        async (data) => {
          const registry = new StateRegistry();
          const executor = new StateExecutor();
          const engine = new StateMachineEngine(registry, executor);

          const definition: StateDefinition = {
            id: 'preservation-context',
            name: 'Context Test',
            version: '1.0',
            states: ['writer', 'reader', 'done'],
            initialState: 'writer',
            terminalStates: ['done'],
            transitions: [
              { from: 'writer', to: 'reader', condition: 'success' },
              { from: 'reader', to: 'done', condition: 'success' },
            ],
          };

          registry.registerDefinition(definition);

          // Writer handler: sets various typed values
          const writerHandler: StateHandler = {
            name: 'writerHandler',
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => {
              context.set<string>('stringVal', data.stringVal);
              context.set<number>('numberVal', data.numberVal);
              context.set<boolean>('boolVal', data.boolVal);
              context.set<number[]>('arrayVal', data.arrayVal);
              return { outcome: 'success', context };
            },
          };

          // Reader handler: reads and verifies values
          let readString: string | undefined;
          let readNumber: number | undefined;
          let readBool: boolean | undefined;
          let readArray: number[] | undefined;

          const readerHandler: StateHandler = {
            name: 'readerHandler',
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => {
              readString = context.get<string>('stringVal');
              readNumber = context.get<number>('numberVal');
              readBool = context.get<boolean>('boolVal');
              readArray = context.get<number[]>('arrayVal');
              return { outcome: 'success', context };
            },
          };

          registry.registerHandler('writer', writerHandler);
          registry.registerHandler('reader', readerHandler);

          const result = await engine.execute('preservation-context', {});

          // Values read by the reader handler should match what was written
          expect(readString).toBe(data.stringVal);
          expect(readNumber).toBe(data.numberVal);
          expect(readBool).toBe(data.boolVal);
          expect(readArray).toEqual(data.arrayVal);

          // Values should also appear in the output
          expect(result.output.stringVal).toBe(data.stringVal);
          expect(result.output.numberVal).toBe(data.numberVal);
          expect(result.output.boolVal).toBe(data.boolVal);
          expect(result.output.arrayVal).toEqual(data.arrayVal);

          // get() for non-existent key should return undefined
          const readerCtxHandler: StateHandler = {
            name: 'undefinedReader',
            canHandle: () => true,
            handle: async (context: StateContext): Promise<TransitionResult> => {
              const missing = context.get<string>('nonExistentKey');
              expect(missing).toBeUndefined();
              return { outcome: 'success', context };
            },
          };

          // Verify undefined key behavior with a separate execution
          const registry2 = new StateRegistry();
          const engine2 = new StateMachineEngine(registry2, new StateExecutor());
          const def2: StateDefinition = {
            id: 'preservation-context-undef',
            name: 'Undef Test',
            version: '1.0',
            states: ['check', 'done2'],
            initialState: 'check',
            terminalStates: ['done2'],
            transitions: [{ from: 'check', to: 'done2', condition: 'success' }],
          };
          registry2.registerDefinition(def2);
          registry2.registerHandler('check', readerCtxHandler);
          await engine2.execute('preservation-context-undef', {});
        },
      ),
      { numRuns: 20 },
    );
  });
});
