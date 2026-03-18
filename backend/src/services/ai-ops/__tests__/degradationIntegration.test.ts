/**
 * DegradationIntegration - Unit Tests
 *
 * Tests for the degradation integration layer that wraps StateExecutor
 * with DegradationManager checks.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4
 */

import { DegradationIntegration } from '../stateMachine/integrations/degradationIntegration';
import { DegradationManager, DegradationReason, CapabilityName } from '../degradationManager';
import { StateHandler, StateContext, TransitionResult, StateDefinition, StateTransition } from '../stateMachine/types';

// ============================================================
// Test Helpers
// ============================================================

function createMockContext(currentState = 'stateA'): StateContext {
  return {
    requestId: 'req-1',
    executionId: 'exec-1',
    currentState,
    stateHistory: [],
    data: new Map<string, unknown>(),
    metadata: {},
    timings: new Map(),
    get<T>(key: string): T | undefined {
      return this.data.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      this.data.set(key, value);
    },
  };
}

function createMockHandler(
  name: string,
  capability?: CapabilityName,
  outcome = 'success',
  shouldThrow = false,
): StateHandler {
  return {
    name,
    capability,
    canHandle: () => true,
    handle: async (context: StateContext): Promise<TransitionResult> => {
      if (shouldThrow) {
        throw new Error(`${name} failed`);
      }
      return { outcome, context };
    },
  };
}

// ============================================================
// shouldSkip Tests (Requirement 7.1)
// ============================================================

describe('DegradationIntegration', () => {
  let degradationManager: DegradationManager;
  let integration: DegradationIntegration;

  beforeEach(() => {
    degradationManager = new DegradationManager({
      autoRecoveryEnabled: false, // disable timers in tests
    });
    integration = new DegradationIntegration(degradationManager);
  });

  afterEach(() => {
    degradationManager.shutdown();
  });

  describe('shouldSkip', () => {
    it('should return false when handler has no capability', () => {
      const handler = createMockHandler('noCap');
      expect(integration.shouldSkip(handler)).toBe(false);
    });

    it('should return false when capability is available', () => {
      const handler = createMockHandler('reflectionHandler', 'reflection');
      expect(integration.shouldSkip(handler)).toBe(false);
    });

    it('should return true when capability is degraded', () => {
      const handler = createMockHandler('reflectionHandler', 'reflection');
      degradationManager.degrade('reflection', DegradationReason.ERROR);
      expect(integration.shouldSkip(handler)).toBe(true);
    });

    it('should return false after capability recovers', () => {
      const handler = createMockHandler('reflectionHandler', 'reflection');
      degradationManager.degrade('reflection', DegradationReason.ERROR);
      expect(integration.shouldSkip(handler)).toBe(true);
      degradationManager.recover('reflection');
      expect(integration.shouldSkip(handler)).toBe(false);
    });
  });

  // ============================================================
  // wrapExecution Tests (Requirements 7.2, 7.3)
  // ============================================================

  describe('wrapExecution', () => {
    it('should call recordSuccess when handler succeeds', async () => {
      const handler = createMockHandler('reflectionHandler', 'reflection', 'success');
      const context = createMockContext();
      const recordSuccessSpy = jest.spyOn(degradationManager, 'recordSuccess');

      const executeFn = () => handler.handle(context);
      const result = await integration.wrapExecution(handler, context, executeFn);

      expect(result.outcome).toBe('success');
      expect(recordSuccessSpy).toHaveBeenCalledWith('reflection');
    });

    it('should call recordFailure when handler throws', async () => {
      const handler = createMockHandler('reflectionHandler', 'reflection', 'success', true);
      const context = createMockContext();
      const recordFailureSpy = jest.spyOn(degradationManager, 'recordFailure');

      const executeFn = () => handler.handle(context);
      const result = await integration.wrapExecution(handler, context, executeFn);

      expect(result.outcome).toBe('error');
      expect(result.metadata?.error).toBe('reflectionHandler failed');
      expect(recordFailureSpy).toHaveBeenCalledWith('reflection', 'reflectionHandler failed');
    });

    it('should not call recordSuccess/recordFailure when handler has no capability', async () => {
      const handler = createMockHandler('noCap', undefined, 'done');
      const context = createMockContext();
      const recordSuccessSpy = jest.spyOn(degradationManager, 'recordSuccess');
      const recordFailureSpy = jest.spyOn(degradationManager, 'recordFailure');

      const executeFn = () => handler.handle(context);
      await integration.wrapExecution(handler, context, executeFn);

      expect(recordSuccessSpy).not.toHaveBeenCalled();
      expect(recordFailureSpy).not.toHaveBeenCalled();
    });

    it('should return degraded outcome when handler capability is degraded', async () => {
      const handler = createMockHandler('reflectionHandler', 'reflection');
      const context = createMockContext();
      degradationManager.degrade('reflection', DegradationReason.ERROR);

      const executeFn = () => handler.handle(context);
      const result = await integration.wrapExecution(handler, context, executeFn);

      expect(result.outcome).toBe('degraded');
      expect(result.metadata?.skipped).toBe(true);
      expect(result.metadata?.reason).toBe('capability_degraded');
    });

    it('should not execute handler when capability is degraded', async () => {
      const handleSpy = jest.fn().mockResolvedValue({ outcome: 'success', context: createMockContext() });
      const handler: StateHandler = {
        name: 'reflectionHandler',
        capability: 'reflection',
        canHandle: () => true,
        handle: handleSpy,
      };
      const context = createMockContext();
      degradationManager.degrade('reflection', DegradationReason.ERROR);

      const executeFn = () => handler.handle(context);
      await integration.wrapExecution(handler, context, executeFn);

      expect(handleSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // getDegradedNodes Tests
  // ============================================================

  describe('getDegradedNodes', () => {
    it('should return empty array initially', () => {
      expect(integration.getDegradedNodes()).toEqual([]);
    });

    it('should track degraded nodes after wrapExecution skips them', async () => {
      const handler = createMockHandler('reflectionHandler', 'reflection');
      const context = createMockContext();
      degradationManager.degrade('reflection', DegradationReason.ERROR);

      const executeFn = () => handler.handle(context);
      await integration.wrapExecution(handler, context, executeFn);

      expect(integration.getDegradedNodes()).toEqual(['reflectionHandler']);
    });

    it('should track multiple degraded nodes', async () => {
      const handler1 = createMockHandler('reflectionHandler', 'reflection');
      const handler2 = createMockHandler('experienceHandler', 'experience');
      const context = createMockContext();

      degradationManager.degrade('reflection', DegradationReason.ERROR);
      degradationManager.degrade('experience', DegradationReason.ERROR);

      const executeFn1 = () => handler1.handle(context);
      await integration.wrapExecution(handler1, context, executeFn1);

      const executeFn2 = () => handler2.handle(context);
      await integration.wrapExecution(handler2, context, executeFn2);

      expect(integration.getDegradedNodes()).toEqual(['reflectionHandler', 'experienceHandler']);
    });

    it('should reset degraded nodes on reset()', async () => {
      const handler = createMockHandler('reflectionHandler', 'reflection');
      const context = createMockContext();
      degradationManager.degrade('reflection', DegradationReason.ERROR);

      const executeFn = () => handler.handle(context);
      await integration.wrapExecution(handler, context, executeFn);

      expect(integration.getDegradedNodes()).toHaveLength(1);
      integration.reset();
      expect(integration.getDegradedNodes()).toEqual([]);
    });
  });

  // ============================================================
  // isFullPathDegraded Tests (Requirement 7.4)
  // ============================================================

  describe('isFullPathDegraded', () => {
    it('should return false when no handlers are provided', () => {
      expect(integration.isFullPathDegraded([])).toBe(false);
    });

    it('should return false when at least one handler capability is available', () => {
      const handlers = [
        createMockHandler('reflectionHandler', 'reflection'),
        createMockHandler('experienceHandler', 'experience'),
      ];
      degradationManager.degrade('reflection', DegradationReason.ERROR);
      // experience is still available
      expect(integration.isFullPathDegraded(handlers)).toBe(false);
    });

    it('should return true when all handler capabilities are degraded', () => {
      const handlers = [
        createMockHandler('reflectionHandler', 'reflection'),
        createMockHandler('experienceHandler', 'experience'),
      ];
      degradationManager.degrade('reflection', DegradationReason.ERROR);
      degradationManager.degrade('experience', DegradationReason.ERROR);
      expect(integration.isFullPathDegraded(handlers)).toBe(true);
    });

    it('should return false when handlers have no capability (always available)', () => {
      const handlers = [
        createMockHandler('basicHandler'),
        createMockHandler('anotherHandler'),
      ];
      expect(integration.isFullPathDegraded(handlers)).toBe(false);
    });

    it('should return false when mix of no-capability and available handlers', () => {
      const handlers = [
        createMockHandler('reflectionHandler', 'reflection'),
        createMockHandler('basicHandler'), // no capability = always available
      ];
      degradationManager.degrade('reflection', DegradationReason.ERROR);
      expect(integration.isFullPathDegraded(handlers)).toBe(false);
    });

    it('should return true when all capability handlers are degraded and no fallback', () => {
      const handlers = [
        createMockHandler('reflectionHandler', 'reflection'),
        createMockHandler('experienceHandler', 'experience'),
        createMockHandler('planHandler', 'planRevision'),
      ];
      degradationManager.degrade('reflection', DegradationReason.ERROR);
      degradationManager.degrade('experience', DegradationReason.ERROR);
      degradationManager.degrade('planRevision', DegradationReason.ERROR);
      expect(integration.isFullPathDegraded(handlers)).toBe(true);
    });
  });
});
