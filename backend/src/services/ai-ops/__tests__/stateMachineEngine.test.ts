/**
 * StateMachineEngine 单元测试
 *
 * 验证:
 * - 简单线性流程 (start → middle → end)
 * - 基于 outcome 的分支转移
 * - 异常处理 (handler 抛出异常 → errorState)
 * - maxSteps 安全阀
 * - 状态转移事件发射
 * - 无匹配 transition → errorState
 * - handler 返回 skipped outcome
 *
 * 需求: 1.4, 1.5, 1.6, 1.7, 1.8, 8.1
 */

import { StateMachineEngine } from '../stateMachine/stateMachineEngine';
import { StateRegistry } from '../stateMachine/stateRegistry';
import { StateExecutor } from '../stateMachine/stateExecutor';
import {
  StateHandler,
  StateContext,
  TransitionResult,
  StateDefinition,
  StateTransitionEvent,
} from '../stateMachine/types';

// ============================================================
// Helpers
// ============================================================

function makeHandler(opts: {
  name?: string;
  canHandle?: (ctx: StateContext) => boolean;
  handle?: (ctx: StateContext) => Promise<TransitionResult>;
}): StateHandler {
  return {
    name: opts.name ?? 'handler',
    canHandle: opts.canHandle ?? (() => true),
    handle: opts.handle ?? (async (ctx) => ({ outcome: 'success', context: ctx })),
  };
}

/** A simple linear definition: start → middle → end */
function linearDefinition(): StateDefinition {
  return {
    id: 'linear',
    name: 'Linear Flow',
    version: '1.0.0',
    states: ['start', 'middle', 'end'],
    initialState: 'start',
    terminalStates: ['end'],
    transitions: [
      { from: 'start', to: 'middle' },
      { from: 'middle', to: 'end' },
    ],
  };
}

/** A branching definition with outcome-based transitions */
function branchingDefinition(): StateDefinition {
  return {
    id: 'branching',
    name: 'Branching Flow',
    version: '1.0.0',
    states: ['start', 'pathA', 'pathB', 'end'],
    initialState: 'start',
    terminalStates: ['end'],
    transitions: [
      { from: 'start', to: 'pathA', condition: 'goA' },
      { from: 'start', to: 'pathB', condition: 'goB' },
      { from: 'pathA', to: 'end' },
      { from: 'pathB', to: 'end' },
    ],
  };
}

function setupLinearEngine(): {
  engine: StateMachineEngine;
  registry: StateRegistry;
} {
  const registry = new StateRegistry();
  const executor = new StateExecutor();
  const engine = new StateMachineEngine(registry, executor);

  registry.registerDefinition(linearDefinition());
  registry.registerHandler(
    'start',
    makeHandler({ name: 'startHandler' }),
  );
  registry.registerHandler(
    'middle',
    makeHandler({ name: 'middleHandler' }),
  );

  return { engine, registry };
}

// ============================================================
// Tests
// ============================================================

describe('StateMachineEngine', () => {
  describe('simple linear flow', () => {
    it('should execute start → middle → end and return success', async () => {
      const { engine } = setupLinearEngine();

      const result = await engine.execute('linear', {});

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('end');
      expect(result.definitionId).toBe('linear');
      expect(result.transitionPath).toHaveLength(2);
      expect(result.transitionPath[0].fromState).toBe('start');
      expect(result.transitionPath[0].toState).toBe('middle');
      expect(result.transitionPath[1].fromState).toBe('middle');
      expect(result.transitionPath[1].toState).toBe('end');
    });

    it('should generate unique executionId', async () => {
      const { engine } = setupLinearEngine();

      const r1 = await engine.execute('linear', {});
      const r2 = await engine.execute('linear', {});

      expect(r1.executionId).not.toBe(r2.executionId);
    });

    it('should use requestId from input if provided', async () => {
      const { engine } = setupLinearEngine();

      const result = await engine.execute('linear', { requestId: 'my-req-123' });

      expect(result.requestId).toBe('my-req-123');
    });

    it('should generate requestId if not provided', async () => {
      const { engine } = setupLinearEngine();

      const result = await engine.execute('linear', {});

      expect(result.requestId).toBeDefined();
      expect(typeof result.requestId).toBe('string');
      expect(result.requestId.length).toBeGreaterThan(0);
    });

    it('should populate output from context data', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      registry.registerDefinition(linearDefinition());
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async (ctx) => {
            ctx.set('result', 42);
            return { outcome: 'success', context: ctx };
          },
        }),
      );
      registry.registerHandler('middle', makeHandler({}));

      const result = await engine.execute('linear', { input: 'hello' });

      expect(result.output.input).toBe('hello');
      expect(result.output.result).toBe(42);
    });
  });

  describe('branching flow with outcome-based transitions', () => {
    it('should follow pathA when outcome is goA', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      registry.registerDefinition(branchingDefinition());
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'goA', context: ctx }),
        }),
      );
      registry.registerHandler('pathA', makeHandler({}));
      registry.registerHandler('pathB', makeHandler({}));

      const result = await engine.execute('branching', {});

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('end');
      expect(result.transitionPath[0].fromState).toBe('start');
      expect(result.transitionPath[0].toState).toBe('pathA');
    });

    it('should follow pathB when outcome is goB', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      registry.registerDefinition(branchingDefinition());
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'goB', context: ctx }),
        }),
      );
      registry.registerHandler('pathA', makeHandler({}));
      registry.registerHandler('pathB', makeHandler({}));

      const result = await engine.execute('branching', {});

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('end');
      expect(result.transitionPath[0].fromState).toBe('start');
      expect(result.transitionPath[0].toState).toBe('pathB');
    });
  });

  describe('transition priority and unconditional fallback', () => {
    it('should prefer conditional match over unconditional fallback', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'priority-test',
        name: 'Priority Test',
        version: '1.0.0',
        states: ['start', 'specific', 'default', 'end'],
        initialState: 'start',
        terminalStates: ['end'],
        transitions: [
          { from: 'start', to: 'default' }, // unconditional fallback
          { from: 'start', to: 'specific', condition: 'special' },
          { from: 'specific', to: 'end' },
          { from: 'default', to: 'end' },
        ],
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'special', context: ctx }),
        }),
      );
      registry.registerHandler('specific', makeHandler({}));
      registry.registerHandler('default', makeHandler({}));

      const result = await engine.execute('priority-test', {});

      expect(result.transitionPath[0].toState).toBe('specific');
    });

    it('should use unconditional fallback when no condition matches', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'fallback-test',
        name: 'Fallback Test',
        version: '1.0.0',
        states: ['start', 'specific', 'default', 'end'],
        initialState: 'start',
        terminalStates: ['end'],
        transitions: [
          { from: 'start', to: 'default' }, // unconditional fallback
          { from: 'start', to: 'specific', condition: 'special' },
          { from: 'specific', to: 'end' },
          { from: 'default', to: 'end' },
        ],
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'unknown', context: ctx }),
        }),
      );
      registry.registerHandler('specific', makeHandler({}));
      registry.registerHandler('default', makeHandler({}));

      const result = await engine.execute('fallback-test', {});

      expect(result.transitionPath[0].toState).toBe('default');
    });
  });

  describe('error handling', () => {
    it('should transition to errorState when handler throws', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'error-test',
        name: 'Error Test',
        version: '1.0.0',
        states: ['start', 'end', 'errorHandler'],
        initialState: 'start',
        terminalStates: ['end', 'errorHandler'],
        transitions: [{ from: 'start', to: 'end' }],
        errorState: 'errorHandler',
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async () => {
            throw new Error('boom');
          },
        }),
      );

      const result = await engine.execute('error-test', {});

      expect(result.finalState).toBe('errorHandler');
      expect(result.error).toBe('boom');
    });

    it('should fail with error when handler throws and no errorState configured', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'no-error-state',
        name: 'No Error State',
        version: '1.0.0',
        states: ['start', 'end'],
        initialState: 'start',
        terminalStates: ['end'],
        transitions: [{ from: 'start', to: 'end' }],
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async () => {
            throw new Error('no error state');
          },
        }),
      );

      const result = await engine.execute('no-error-state', {});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should transition to errorState on no matching transition', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'no-match',
        name: 'No Match',
        version: '1.0.0',
        states: ['start', 'end', 'errorHandler'],
        initialState: 'start',
        terminalStates: ['end', 'errorHandler'],
        transitions: [
          { from: 'start', to: 'end', condition: 'expected' },
        ],
        errorState: 'errorHandler',
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'unexpected', context: ctx }),
        }),
      );

      const result = await engine.execute('no-match', {});

      expect(result.finalState).toBe('errorHandler');
      expect(result.error).toContain('No matching transition');
    });
  });

  describe('maxSteps safety valve', () => {
    it('should terminate when maxSteps is exceeded', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      // A self-loop that never terminates
      const def: StateDefinition = {
        id: 'loop',
        name: 'Infinite Loop',
        version: '1.0.0',
        states: ['looping', 'end'],
        initialState: 'looping',
        terminalStates: ['end'],
        transitions: [
          { from: 'looping', to: 'looping', condition: 'continue' },
          { from: 'looping', to: 'end', condition: 'done' },
        ],
        maxSteps: 5,
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'looping',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'continue', context: ctx }),
        }),
      );

      const result = await engine.execute('loop', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Max steps');
      expect(result.transitionPath.length).toBeLessThanOrEqual(5);
    });

    it('should use default maxSteps of 100', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      let stepCount = 0;
      const def: StateDefinition = {
        id: 'default-max',
        name: 'Default Max',
        version: '1.0.0',
        states: ['looping', 'end'],
        initialState: 'looping',
        terminalStates: ['end'],
        transitions: [
          { from: 'looping', to: 'looping', condition: 'continue' },
          { from: 'looping', to: 'end', condition: 'done' },
        ],
        // no maxSteps → defaults to 100
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'looping',
        makeHandler({
          handle: async (ctx) => {
            stepCount++;
            return { outcome: 'continue', context: ctx };
          },
        }),
      );

      const result = await engine.execute('default-max', {});

      expect(result.success).toBe(false);
      expect(stepCount).toBe(100);
    });
  });

  describe('event emission', () => {
    it('should emit transition events for each state transition', async () => {
      const { engine } = setupLinearEngine();
      const events: StateTransitionEvent[] = [];

      engine.on('transition', (event: StateTransitionEvent) => {
        events.push(event);
      });

      const result = await engine.execute('linear', {});

      expect(events).toHaveLength(2);
      expect(events[0].fromState).toBe('start');
      expect(events[0].toState).toBe('middle');
      expect(events[1].fromState).toBe('middle');
      expect(events[1].toState).toBe('end');

      // Verify event structure
      for (const event of events) {
        expect(event.executionId).toBe(result.executionId);
        expect(event.requestId).toBe(result.requestId);
        expect(typeof event.duration).toBe('number');
        expect(typeof event.timestamp).toBe('number');
        expect(event.contextSnapshot).toBeDefined();
        expect(event.contextSnapshot.dataKeys).toBeInstanceOf(Array);
      }
    });
  });

  describe('handler returning skipped outcome', () => {
    it('should use unconditional fallback when handler returns skipped', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'skip-test',
        name: 'Skip Test',
        version: '1.0.0',
        states: ['start', 'next', 'end'],
        initialState: 'start',
        terminalStates: ['end'],
        transitions: [
          { from: 'start', to: 'next', condition: 'skipped' },
          { from: 'next', to: 'end' },
        ],
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          canHandle: () => false, // will return 'skipped' outcome
        }),
      );
      registry.registerHandler('next', makeHandler({}));

      const result = await engine.execute('skip-test', {});

      expect(result.success).toBe(true);
      expect(result.finalState).toBe('end');
      expect(result.transitionPath[0].fromState).toBe('start');
      expect(result.transitionPath[0].toState).toBe('next');
    });
  });

  describe('definition not found', () => {
    it('should throw when definition does not exist', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      await expect(engine.execute('nonexistent', {})).rejects.toThrow(
        "Definition 'nonexistent' not found",
      );
    });
  });

  describe('transition duration tracking', () => {
    it('should record duration in transition records', async () => {
      const { engine } = setupLinearEngine();

      const result = await engine.execute('linear', {});

      for (const record of result.transitionPath) {
        expect(typeof record.duration).toBe('number');
        expect(record.duration).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('error state as non-terminal with handler', () => {
    it('should continue execution from errorState if it has a handler and transitions', async () => {
      const registry = new StateRegistry();
      const executor = new StateExecutor();
      const engine = new StateMachineEngine(registry, executor);

      const def: StateDefinition = {
        id: 'error-recovery',
        name: 'Error Recovery',
        version: '1.0.0',
        states: ['start', 'errorHandler', 'recovered'],
        initialState: 'start',
        terminalStates: ['recovered'],
        transitions: [
          { from: 'start', to: 'recovered', condition: 'success' },
          { from: 'errorHandler', to: 'recovered' },
        ],
        errorState: 'errorHandler',
      };

      registry.registerDefinition(def);
      registry.registerHandler(
        'start',
        makeHandler({
          handle: async () => {
            throw new Error('fail');
          },
        }),
      );
      registry.registerHandler(
        'errorHandler',
        makeHandler({
          handle: async (ctx) => ({ outcome: 'recovered', context: ctx }),
        }),
      );

      const result = await engine.execute('error-recovery', {});

      expect(result.finalState).toBe('recovered');
      expect(result.success).toBe(true);
    });
  });
});
