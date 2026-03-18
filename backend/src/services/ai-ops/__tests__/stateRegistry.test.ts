/**
 * StateRegistry 单元测试
 *
 * 验证:
 * - registerDefinition 存储定义并验证结构完整性
 * - registerHandler 建立 stateName → StateHandler 映射
 * - validate 检查非终止状态有对应 Handler
 * - 各种验证错误场景
 *
 * 需求: 1.1, 1.2, 1.3
 */

import { StateRegistry, ValidationError } from '../stateMachine/stateRegistry';
import { StateDefinition, StateHandler, StateContext, TransitionResult } from '../stateMachine/types';

/** Helper: create a minimal valid StateDefinition */
function makeDefinition(overrides: Partial<StateDefinition> = {}): StateDefinition {
  return {
    id: 'test-def',
    name: 'Test Definition',
    version: '1.0.0',
    states: ['start', 'middle', 'end'],
    initialState: 'start',
    terminalStates: ['end'],
    transitions: [
      { from: 'start', to: 'middle' },
      { from: 'middle', to: 'end' },
    ],
    ...overrides,
  };
}

/** Helper: create a stub StateHandler */
function makeHandler(name: string): StateHandler {
  return {
    name,
    canHandle: () => true,
    handle: async (ctx: StateContext): Promise<TransitionResult> => ({
      outcome: 'success',
      context: ctx,
    }),
  };
}

describe('StateRegistry', () => {
  let registry: StateRegistry;

  beforeEach(() => {
    registry = new StateRegistry();
  });

  // ============================================================
  // registerDefinition - successful registration
  // ============================================================
  describe('registerDefinition', () => {
    it('should store a valid definition and retrieve it by id', () => {
      const def = makeDefinition();
      registry.registerDefinition(def);

      expect(registry.getDefinition('test-def')).toBe(def);
    });

    it('should allow registering multiple definitions', () => {
      const def1 = makeDefinition({ id: 'def-1' });
      const def2 = makeDefinition({ id: 'def-2' });

      registry.registerDefinition(def1);
      registry.registerDefinition(def2);

      expect(registry.getDefinition('def-1')).toBe(def1);
      expect(registry.getDefinition('def-2')).toBe(def2);
    });

    it('should accept definition with errorState in states', () => {
      const def = makeDefinition({
        states: ['start', 'middle', 'end', 'error'],
        errorState: 'error',
      });
      expect(() => registry.registerDefinition(def)).not.toThrow();
    });

    it('should accept definition with degradedState in states', () => {
      const def = makeDefinition({
        states: ['start', 'middle', 'end', 'degraded'],
        degradedState: 'degraded',
      });
      expect(() => registry.registerDefinition(def)).not.toThrow();
    });

    it('should return undefined for unregistered definition id', () => {
      expect(registry.getDefinition('nonexistent')).toBeUndefined();
    });
  });

  // ============================================================
  // registerDefinition - validation errors
  // ============================================================
  describe('registerDefinition validation errors', () => {
    it('should throw ValidationError when initialState is not in states', () => {
      const def = makeDefinition({ initialState: 'nonexistent' });
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
      expect(() => registry.registerDefinition(def)).toThrow(/initialState/);
    });

    it('should throw ValidationError when a terminalState is not in states', () => {
      const def = makeDefinition({ terminalStates: ['nonexistent'] });
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
      expect(() => registry.registerDefinition(def)).toThrow(/terminalState/);
    });

    it('should throw ValidationError when errorState is not in states', () => {
      const def = makeDefinition({ errorState: 'nonexistent' });
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
      expect(() => registry.registerDefinition(def)).toThrow(/errorState/);
    });

    it('should throw ValidationError when degradedState is not in states', () => {
      const def = makeDefinition({ degradedState: 'nonexistent' });
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
      expect(() => registry.registerDefinition(def)).toThrow(/degradedState/);
    });

    it('should throw ValidationError when transition from is not in states', () => {
      const def = makeDefinition({
        transitions: [{ from: 'nonexistent', to: 'end' }],
      });
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
      expect(() => registry.registerDefinition(def)).toThrow(/source state/);
    });

    it('should throw ValidationError when transition to is not in states', () => {
      const def = makeDefinition({
        transitions: [{ from: 'start', to: 'nonexistent' }],
      });
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
      expect(() => registry.registerDefinition(def)).toThrow(/target state/);
    });

    it('should throw ValidationError for multiple invalid terminal states', () => {
      const def = makeDefinition({ terminalStates: ['end', 'bad1', 'bad2'] });
      // Should throw on the first invalid one
      expect(() => registry.registerDefinition(def)).toThrow(ValidationError);
    });
  });

  // ============================================================
  // registerHandler
  // ============================================================
  describe('registerHandler', () => {
    it('should store a handler and retrieve it by state name', () => {
      const handler = makeHandler('startHandler');
      registry.registerHandler('start', handler);

      expect(registry.getHandler('start')).toBe(handler);
    });

    it('should return undefined for unregistered handler', () => {
      expect(registry.getHandler('nonexistent')).toBeUndefined();
    });

    it('should report hasHandler correctly', () => {
      expect(registry.hasHandler('start')).toBe(false);
      registry.registerHandler('start', makeHandler('h'));
      expect(registry.hasHandler('start')).toBe(true);
    });

    it('should allow overwriting a handler for the same state', () => {
      const h1 = makeHandler('handler1');
      const h2 = makeHandler('handler2');

      registry.registerHandler('start', h1);
      registry.registerHandler('start', h2);

      expect(registry.getHandler('start')).toBe(h2);
    });
  });

  // ============================================================
  // validate
  // ============================================================
  describe('validate', () => {
    it('should pass when all non-terminal states have handlers', () => {
      const def = makeDefinition();
      registry.registerDefinition(def);
      registry.registerHandler('start', makeHandler('startH'));
      registry.registerHandler('middle', makeHandler('middleH'));

      expect(() => registry.validate('test-def')).not.toThrow();
    });

    it('should not require handlers for terminal states', () => {
      const def = makeDefinition();
      registry.registerDefinition(def);
      // Only register handlers for non-terminal states
      registry.registerHandler('start', makeHandler('startH'));
      registry.registerHandler('middle', makeHandler('middleH'));
      // 'end' is terminal - no handler needed

      expect(() => registry.validate('test-def')).not.toThrow();
    });

    it('should throw ValidationError when a non-terminal state lacks a handler', () => {
      const def = makeDefinition();
      registry.registerDefinition(def);
      // Only register handler for 'start', missing 'middle'
      registry.registerHandler('start', makeHandler('startH'));

      expect(() => registry.validate('test-def')).toThrow(ValidationError);
      expect(() => registry.validate('test-def')).toThrow(/middle/);
    });

    it('should throw ValidationError when no handlers are registered', () => {
      const def = makeDefinition();
      registry.registerDefinition(def);

      expect(() => registry.validate('test-def')).toThrow(ValidationError);
    });

    it('should throw ValidationError for unknown definition id', () => {
      expect(() => registry.validate('nonexistent')).toThrow(ValidationError);
      expect(() => registry.validate('nonexistent')).toThrow(/not found/);
    });

    it('should pass for definition where all states are terminal', () => {
      const def = makeDefinition({
        states: ['only'],
        initialState: 'only',
        terminalStates: ['only'],
        transitions: [],
      });
      registry.registerDefinition(def);

      // No handlers needed since the only state is terminal
      expect(() => registry.validate(def.id)).not.toThrow();
    });

    it('should validate with errorState that has a handler', () => {
      const def = makeDefinition({
        states: ['start', 'middle', 'end', 'error'],
        errorState: 'error',
      });
      registry.registerDefinition(def);
      registry.registerHandler('start', makeHandler('startH'));
      registry.registerHandler('middle', makeHandler('middleH'));
      registry.registerHandler('error', makeHandler('errorH'));

      expect(() => registry.validate(def.id)).not.toThrow();
    });

    it('should fail validation when errorState (non-terminal) lacks a handler', () => {
      const def = makeDefinition({
        states: ['start', 'middle', 'end', 'error'],
        errorState: 'error',
      });
      registry.registerDefinition(def);
      registry.registerHandler('start', makeHandler('startH'));
      registry.registerHandler('middle', makeHandler('middleH'));
      // Missing handler for 'error' which is non-terminal

      expect(() => registry.validate(def.id)).toThrow(ValidationError);
      expect(() => registry.validate(def.id)).toThrow(/error/);
    });
  });
});
