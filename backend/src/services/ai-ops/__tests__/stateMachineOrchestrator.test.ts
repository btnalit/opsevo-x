/**
 * StateMachineOrchestrator - 门面类单元测试
 *
 * TDD: 先写测试，再实现
 * 需求: 1.1, 1.2, 1.4, 8.5, 10.1, 11.4
 */

import { StateMachineOrchestrator } from '../stateMachine/stateMachineOrchestrator';
import { StateMachineEngine } from '../stateMachine/stateMachineEngine';
import { StateRegistry } from '../stateMachine/stateRegistry';
import { ContextManager } from '../stateMachine/contextManager';
import { ConcurrencyGuard } from '../stateMachine/integrations/concurrencyGuard';
import { TracingIntegration } from '../stateMachine/integrations/tracingIntegration';
import { StateDefinitionSerializer } from '../stateMachine/stateDefinitionSerializer';
import { FeatureFlagManager } from '../stateMachine/featureFlagManager';
import {
  StateDefinition,
  StateHandler,
  StateTransition,
  ExecutionResult,
  ExecutionSummary,
} from '../stateMachine/types';

// ============================================================
// Mocks
// ============================================================

jest.mock('../stateMachine/stateMachineEngine');
jest.mock('../stateMachine/stateRegistry');
jest.mock('../stateMachine/integrations/concurrencyGuard');
jest.mock('../stateMachine/integrations/tracingIntegration');
jest.mock('../stateMachine/featureFlagManager');


// ============================================================
// Helpers
// ============================================================

function createMockDefinition(overrides?: Partial<StateDefinition>): StateDefinition {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    version: '1.0.0',
    states: ['start', 'end'],
    initialState: 'start',
    terminalStates: ['end'],
    transitions: [{ from: 'start', to: 'end' }],
    ...overrides,
  };
}

function createMockHandler(name: string): StateHandler {
  return {
    name,
    canHandle: jest.fn().mockReturnValue(true),
    handle: jest.fn().mockResolvedValue({ outcome: 'success', context: {} }),
  };
}

function createMockExecutionResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    definitionId: 'test-flow',
    finalState: 'end',
    success: true,
    totalDuration: 100,
    nodesVisited: 1,
    degraded: false,
    degradedNodes: [],
    output: {},
    transitionPath: [],
    ...overrides,
  };
}

function createMockSummary(overrides?: Partial<ExecutionSummary>): ExecutionSummary {
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    definitionId: 'test-flow',
    startTime: 1000,
    endTime: 1100,
    totalDuration: 100,
    nodesVisited: 1,
    degraded: false,
    finalState: 'end',
    success: true,
    transitionPath: [],
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('StateMachineOrchestrator', () => {
  let orchestrator: StateMachineOrchestrator;
  let mockEngine: jest.Mocked<StateMachineEngine>;
  let mockRegistry: jest.Mocked<StateRegistry>;
  let mockConcurrencyGuard: jest.Mocked<ConcurrencyGuard>;
  let mockTracing: jest.Mocked<TracingIntegration>;
  let mockFeatureFlags: jest.Mocked<FeatureFlagManager>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockEngine = new StateMachineEngine(null as any, null as any) as jest.Mocked<StateMachineEngine>;
    mockRegistry = new StateRegistry() as jest.Mocked<StateRegistry>;
    mockConcurrencyGuard = new ConcurrencyGuard() as jest.Mocked<ConcurrencyGuard>;
    mockTracing = new TracingIntegration(null as any) as jest.Mocked<TracingIntegration>;
    mockFeatureFlags = new FeatureFlagManager() as jest.Mocked<FeatureFlagManager>;

    orchestrator = new StateMachineOrchestrator({
      engine: mockEngine,
      registry: mockRegistry,
      concurrencyGuard: mockConcurrencyGuard,
      tracingIntegration: mockTracing,
      featureFlagManager: mockFeatureFlags,
    });
  });

  // ----------------------------------------------------------
  // Registration delegation
  // ----------------------------------------------------------
  describe('registerDefinition', () => {
    it('should delegate to StateRegistry.registerDefinition', () => {
      const def = createMockDefinition();
      orchestrator.registerDefinition(def);
      expect(mockRegistry.registerDefinition).toHaveBeenCalledWith(def);
    });
  });

  describe('registerHandler', () => {
    it('should delegate to StateRegistry.registerHandler', () => {
      const handler = createMockHandler('myHandler');
      orchestrator.registerHandler('start', handler);
      expect(mockRegistry.registerHandler).toHaveBeenCalledWith('start', handler);
    });
  });

  describe('registerHandlerRuntime', () => {
    it('should delegate to StateRegistry.registerHandlerRuntime', () => {
      const handler = createMockHandler('runtimeHandler');
      orchestrator.registerHandlerRuntime('newState', handler);
      expect(mockRegistry.registerHandlerRuntime).toHaveBeenCalledWith('newState', handler);
    });
  });

  describe('addTransitionRuntime', () => {
    it('should delegate to StateRegistry.addTransitionRuntime', () => {
      const transition: StateTransition = { from: 'a', to: 'b', condition: 'ok' };
      orchestrator.addTransitionRuntime('test-flow', transition);
      expect(mockRegistry.addTransitionRuntime).toHaveBeenCalledWith('test-flow', transition);
    });
  });

  // ----------------------------------------------------------
  // Serialization delegation
  // ----------------------------------------------------------
  describe('serializeDefinition', () => {
    it('should get definition from registry and serialize it', () => {
      const def = createMockDefinition();
      mockRegistry.getDefinition.mockReturnValue(def);

      const result = orchestrator.serializeDefinition('test-flow');

      expect(mockRegistry.getDefinition).toHaveBeenCalledWith('test-flow');
      // StateDefinitionSerializer.serialize is static, so we verify the output
      expect(result).toBe(JSON.stringify(def));
    });

    it('should throw when definition not found', () => {
      mockRegistry.getDefinition.mockReturnValue(undefined);
      expect(() => orchestrator.serializeDefinition('unknown')).toThrow();
    });
  });

  describe('deserializeDefinition', () => {
    it('should deserialize JSON to StateDefinition', () => {
      const def = createMockDefinition();
      const json = JSON.stringify(def);

      const result = orchestrator.deserializeDefinition(json);

      expect(result.id).toBe(def.id);
      expect(result.name).toBe(def.name);
      expect(result.states).toEqual(def.states);
    });
  });

  describe('prettyPrint', () => {
    it('should get definition from registry and pretty print it', () => {
      const def = createMockDefinition();
      mockRegistry.getDefinition.mockReturnValue(def);

      const result = orchestrator.prettyPrint('test-flow');

      expect(mockRegistry.getDefinition).toHaveBeenCalledWith('test-flow');
      expect(result).toContain('Test Flow');
      expect(result).toContain('start');
      expect(result).toContain('end');
    });

    it('should throw when definition not found', () => {
      mockRegistry.getDefinition.mockReturnValue(undefined);
      expect(() => orchestrator.prettyPrint('unknown')).toThrow();
    });
  });

  // ----------------------------------------------------------
  // Query delegation
  // ----------------------------------------------------------
  describe('getExecutionHistory', () => {
    it('should delegate to TracingIntegration.getExecutionSummary', () => {
      const summary = createMockSummary();
      mockTracing.getExecutionSummary.mockReturnValue(summary);

      const result = orchestrator.getExecutionHistory('exec-1');

      expect(mockTracing.getExecutionSummary).toHaveBeenCalledWith('exec-1');
      expect(result).toBe(summary);
    });

    it('should return undefined for unknown executionId', () => {
      mockTracing.getExecutionSummary.mockReturnValue(undefined);

      const result = orchestrator.getExecutionHistory('unknown');

      expect(result).toBeUndefined();
    });
  });

  describe('queryByRequestId', () => {
    it('should delegate to TracingIntegration.queryByRequestId', () => {
      const summaries = [createMockSummary()];
      mockTracing.queryByRequestId.mockReturnValue(summaries);

      const result = orchestrator.queryByRequestId('req-1');

      expect(mockTracing.queryByRequestId).toHaveBeenCalledWith('req-1');
      expect(result).toBe(summaries);
    });

    it('should return empty array for unknown requestId', () => {
      mockTracing.queryByRequestId.mockReturnValue([]);

      const result = orchestrator.queryByRequestId('unknown');

      expect(result).toEqual([]);
    });
  });

  describe('getConcurrencyStatus', () => {
    it('should delegate to ConcurrencyGuard.getConcurrencyStatus', () => {
      const status = { active: 2, queued: 1, maxConcurrent: 5 };
      mockConcurrencyGuard.getConcurrencyStatus.mockReturnValue(status);

      const result = orchestrator.getConcurrencyStatus();

      expect(mockConcurrencyGuard.getConcurrencyStatus).toHaveBeenCalled();
      expect(result).toEqual(status);
    });
  });

  // ----------------------------------------------------------
  // Execute method
  // ----------------------------------------------------------
  describe('execute', () => {
    it('should execute via concurrency guard wrapping engine execution', async () => {
      const execResult = createMockExecutionResult();

      // ConcurrencyGuard.execute wraps the fn and returns its result
      mockConcurrencyGuard.execute.mockImplementation(async (fn) => fn());
      mockEngine.execute.mockResolvedValue(execResult);

      const result = await orchestrator.execute('test-flow', { key: 'value' });

      expect(mockConcurrencyGuard.execute).toHaveBeenCalledTimes(1);
      expect(mockEngine.execute).toHaveBeenCalledWith('test-flow', { key: 'value' });
      expect(result).toBe(execResult);
    });

    it('should propagate concurrency guard errors (e.g. timeout)', async () => {
      mockConcurrencyGuard.execute.mockRejectedValue(
        new Error('Task timed out while waiting in queue'),
      );

      await expect(orchestrator.execute('test-flow', {})).rejects.toThrow(
        'Task timed out while waiting in queue',
      );
    });

    it('should propagate engine execution errors', async () => {
      mockConcurrencyGuard.execute.mockImplementation(async (fn) => fn());
      mockEngine.execute.mockRejectedValue(new Error("Definition 'bad' not found"));

      await expect(orchestrator.execute('bad', {})).rejects.toThrow("Definition 'bad' not found");
    });
  });
});
