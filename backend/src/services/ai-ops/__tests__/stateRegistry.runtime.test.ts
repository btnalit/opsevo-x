/**
 * StateRegistry 运行时扩展功能测试
 *
 * 验证:
 * - registerHandlerRuntime: 运行时注册新 StateHandler，可被已有流程引用
 * - addTransitionRuntime: 运行时添加新 StateTransition，验证源/目标状态存在
 * - 新注册的 Handler 和 Transition 可被已有流程引用
 *
 * 需求: 6.1, 6.2, 6.3
 */

import { StateRegistry, ValidationError } from '../stateMachine/stateRegistry';
import { StateDefinition, StateHandler, StateContext, TransitionResult, StateTransition } from '../stateMachine/types';

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

describe('StateRegistry - Runtime Extension', () => {
  let registry: StateRegistry;

  beforeEach(() => {
    registry = new StateRegistry();
  });

  // ============================================================
  // registerHandlerRuntime
  // ============================================================
  describe('registerHandlerRuntime', () => {
    it('should register a new handler at runtime that can be retrieved', () => {
      const handler = makeHandler('runtimeHandler');
      registry.registerHandlerRuntime('newState', handler);

      expect(registry.getHandler('newState')).toBe(handler);
      expect(registry.hasHandler('newState')).toBe(true);
    });

    it('should allow runtime handler to override an existing handler', () => {
      const original = makeHandler('original');
      const replacement = makeHandler('replacement');

      registry.registerHandler('start', original);
      registry.registerHandlerRuntime('start', replacement);

      expect(registry.getHandler('start')).toBe(replacement);
    });

    it('should make runtime-registered handler available for validation', () => {
      const def = makeDefinition({
        states: ['start', 'middle', 'extra', 'end'],
        transitions: [
          { from: 'start', to: 'middle' },
          { from: 'middle', to: 'extra' },
          { from: 'extra', to: 'end' },
        ],
      });
      registry.registerDefinition(def);
      registry.registerHandler('start', makeHandler('startH'));
      registry.registerHandler('middle', makeHandler('middleH'));

      // Before runtime registration, validation should fail (missing 'extra' handler)
      expect(() => registry.validate('test-def')).toThrow(ValidationError);

      // Register handler at runtime
      registry.registerHandlerRuntime('extra', makeHandler('extraH'));

      // Now validation should pass
      expect(() => registry.validate('test-def')).not.toThrow();
    });

    it('should throw an error when handler name is empty', () => {
      const handler = makeHandler('');
      expect(() => registry.registerHandlerRuntime('', handler)).toThrow();
    });

    it('should allow registering multiple runtime handlers', () => {
      registry.registerHandlerRuntime('stateA', makeHandler('handlerA'));
      registry.registerHandlerRuntime('stateB', makeHandler('handlerB'));

      expect(registry.hasHandler('stateA')).toBe(true);
      expect(registry.hasHandler('stateB')).toBe(true);
    });
  });

  // ============================================================
  // addTransitionRuntime
  // ============================================================
  describe('addTransitionRuntime', () => {
    it('should add a new transition to an existing definition', () => {
      const def = makeDefinition({
        states: ['start', 'middle', 'end'],
      });
      registry.registerDefinition(def);

      const newTransition: StateTransition = {
        from: 'start',
        to: 'end',
        condition: 'skip',
      };
      registry.addTransitionRuntime('test-def', newTransition);

      const updatedDef = registry.getDefinition('test-def');
      expect(updatedDef!.transitions).toContainEqual(newTransition);
    });

    it('should throw ValidationError when definition does not exist', () => {
      const transition: StateTransition = { from: 'a', to: 'b' };
      expect(() => registry.addTransitionRuntime('nonexistent', transition)).toThrow(ValidationError);
    });

    it('should throw ValidationError when from state is not in definition states', () => {
      registry.registerDefinition(makeDefinition());

      const transition: StateTransition = { from: 'nonexistent', to: 'end' };
      expect(() => registry.addTransitionRuntime('test-def', transition)).toThrow(ValidationError);
      expect(() => registry.addTransitionRuntime('test-def', transition)).toThrow(/source state/i);
    });

    it('should throw ValidationError when to state is not in definition states', () => {
      registry.registerDefinition(makeDefinition());

      const transition: StateTransition = { from: 'start', to: 'nonexistent' };
      expect(() => registry.addTransitionRuntime('test-def', transition)).toThrow(ValidationError);
      expect(() => registry.addTransitionRuntime('test-def', transition)).toThrow(/target state/i);
    });

    it('should allow adding transition with condition', () => {
      registry.registerDefinition(makeDefinition());

      const transition: StateTransition = {
        from: 'start',
        to: 'end',
        condition: 'fastTrack',
        priority: 1,
      };
      registry.addTransitionRuntime('test-def', transition);

      const def = registry.getDefinition('test-def');
      const added = def!.transitions.find(
        (t) => t.from === 'start' && t.to === 'end' && t.condition === 'fastTrack',
      );
      expect(added).toBeDefined();
      expect(added!.priority).toBe(1);
    });

    it('should allow adding multiple transitions at runtime', () => {
      registry.registerDefinition(makeDefinition());

      registry.addTransitionRuntime('test-def', { from: 'start', to: 'end', condition: 'skip' });
      registry.addTransitionRuntime('test-def', { from: 'middle', to: 'start', condition: 'retry' });

      const def = registry.getDefinition('test-def');
      // Original 2 + 2 new = 4
      expect(def!.transitions.length).toBe(4);
    });

    it('should make new transitions immediately available for engine use', () => {
      const def = makeDefinition();
      registry.registerDefinition(def);

      // Add a new transition
      registry.addTransitionRuntime('test-def', {
        from: 'start',
        to: 'end',
        condition: 'directEnd',
      });

      // Verify the definition reflects the new transition
      const updatedDef = registry.getDefinition('test-def');
      const directTransition = updatedDef!.transitions.find(
        (t) => t.from === 'start' && t.to === 'end' && t.condition === 'directEnd',
      );
      expect(directTransition).toBeDefined();
    });
  });

  // ============================================================
  // Integration: runtime handler + runtime transition work together
  // ============================================================
  describe('runtime extension integration', () => {
    it('should support adding a new state via runtime handler and connecting it via runtime transition', () => {
      // Start with a definition that includes a new state placeholder
      const def = makeDefinition({
        states: ['start', 'middle', 'newNode', 'end'],
        transitions: [
          { from: 'start', to: 'middle' },
          { from: 'middle', to: 'end' },
        ],
      });
      registry.registerDefinition(def);

      // Register handlers for existing states
      registry.registerHandler('start', makeHandler('startH'));
      registry.registerHandler('middle', makeHandler('middleH'));

      // At runtime, register handler for the new node
      registry.registerHandlerRuntime('newNode', makeHandler('newNodeH'));

      // At runtime, add transition to connect middle -> newNode -> end
      registry.addTransitionRuntime('test-def', { from: 'middle', to: 'newNode', condition: 'enhance' });
      registry.addTransitionRuntime('test-def', { from: 'newNode', to: 'end' });

      // Validation should pass
      expect(() => registry.validate('test-def')).not.toThrow();

      // Verify transitions exist
      const updatedDef = registry.getDefinition('test-def');
      expect(updatedDef!.transitions.length).toBe(4); // 2 original + 2 new
    });
  });
});
