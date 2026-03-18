/**
 * 故障条件探索性测试 - B1-B5 缺陷确认
 *
 * 验证状态机编排层性能问题与并行工具调用重复执行的 5 个缺陷修复。
 * 修复后这些测试应全部通过。
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */

import { StateMachineEngine } from '../stateMachineEngine';
import { StateRegistry } from '../stateRegistry';
import { StateExecutor } from '../stateExecutor';
import { StateMachineOrchestrator } from '../stateMachineOrchestrator';
import { DegradationIntegration } from '../integrations/degradationIntegration';
import { TracingIntegration } from '../integrations/tracingIntegration';
import { ConcurrencyGuard } from '../integrations/concurrencyGuard';
import { CreateOrchestratorConfig } from '../index';
import { ReActLoopHandler, ReActLoopHandlerDeps } from '../handlers/react/reactLoopHandler';
import {
  StateDefinition,
  StateHandler,
  StateContext,
  TransitionResult,
} from '../types';

// ============================================================
// Test Helpers
// ============================================================

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
      return { outcome, context };
    },
  };
}

function createCapabilityHandler(
  name: string,
  capability: string,
  outcome: string = 'success',
): StateHandler {
  return {
    name,
    capability: capability as any,
    canHandle: () => true,
    handle: async (context: StateContext): Promise<TransitionResult> => {
      context.set(`${name}_executed`, true);
      return { outcome, context };
    },
  };
}

// ============================================================
// B1: 工厂函数注入 DegradationIntegration 和 TracingIntegration
// ============================================================

describe('B1: Factory function injects integrations into engine', () => {
  it('should inject TracingIntegration into engine when constructed with tracing arg', () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    const mockTracingService = {
      startTrace: jest.fn().mockReturnValue({ traceId: 't1', spanId: 's1' }),
      startSpan: jest.fn().mockReturnValue({ traceId: 't1', spanId: 's2' }),
      endSpan: jest.fn(),
      endTrace: jest.fn().mockResolvedValue(undefined),
    };

    const tracing = new TracingIntegration(mockTracingService as any);
    const engine = new StateMachineEngine(registry, executor, undefined, tracing);

    expect((engine as any).tracing).toBeDefined();
    expect((engine as any).tracing).toBeInstanceOf(TracingIntegration);
  });

  it('should inject DegradationIntegration into engine when constructed with degradation arg', () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    const mockDegradationManager = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    const degradation = new DegradationIntegration(mockDegradationManager as any);
    const engine = new StateMachineEngine(registry, executor, degradation);

    expect((engine as any).degradation).toBeDefined();
    expect((engine as any).degradation).toBeInstanceOf(DegradationIntegration);
  });

  it('should have engine.degradation === undefined when not provided', () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);

    expect((engine as any).degradation).toBeUndefined();
  });

  it('should call degradation.wrapExecution during handler execution when degradation is injected', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    const mockDegradationManager = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    const degradation = new DegradationIntegration(mockDegradationManager as any);
    const wrapSpy = jest.spyOn(degradation, 'wrapExecution');
    const engine = new StateMachineEngine(registry, executor, degradation);

    const definition: StateDefinition = {
      id: 'test-b1-wrap',
      name: 'B1 Wrap Test',
      version: '1.0',
      states: ['start', 'done'],
      initialState: 'start',
      terminalStates: ['done'],
      transitions: [
        { from: 'start', to: 'done', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);
    registry.registerHandler('start', createCapabilityHandler('startHandler', 'reflection'));

    await engine.execute('test-b1-wrap', {});

    expect(wrapSpy).toHaveBeenCalled();
  });
});

// ============================================================
// B2: ReActLoopHandler 适配器接口签名修正
// ============================================================

describe('B2: ReActLoopHandler passes positional args to executeLoop', () => {
  it('should call executeLoop with 4 positional args, not a params object', async () => {
    const receivedArgs: unknown[] = [];

    const mockExecutor: ReActLoopHandlerDeps['reactLoopExecutor'] = {
      executeLoop: jest.fn(async (
        message: string,
        intentAnalysis: unknown,
        conversationContext: unknown,
        executionContext: unknown,
      ) => {
        receivedArgs.push(message, intentAnalysis, conversationContext, executionContext);
        return { steps: [], finalAnswer: 'test', iterations: 1 };
      }),
    };

    const handler = new ReActLoopHandler({ reactLoopExecutor: mockExecutor });

    // Create a mock StateContext
    const contextData = new Map<string, unknown>();
    contextData.set('message', 'test message');
    contextData.set('intentAnalysis', { intent: 'query', tools: [] });
    contextData.set('conversationContext', { messages: [] });
    contextData.set('executionContext', { requestId: 'req-1', toolCallPatterns: [] });

    const mockContext: StateContext = {
      requestId: 'req-1',
      executionId: 'exec-1',
      currentState: 'reactLoop',
      stateHistory: [],
      data: contextData,
      metadata: {},
      timings: new Map(),
      get<T>(key: string): T | undefined {
        return contextData.get(key) as T | undefined;
      },
      set<T>(key: string, value: T): void {
        contextData.set(key, value);
      },
    };

    await handler.handle(mockContext);

    // Verify executeLoop was called with positional args
    expect(mockExecutor.executeLoop).toHaveBeenCalledTimes(1);

    // First arg should be the message string, not a params object
    expect(receivedArgs[0]).toBe('test message');
    expect(typeof receivedArgs[0]).toBe('string');

    // Fourth arg should be the executionContext with toolCallPatterns
    expect(receivedArgs[3]).toBeDefined();
    expect((receivedArgs[3] as any).toolCallPatterns).toEqual([]);
  });
});

// ============================================================
// B3: CreateOrchestratorConfig accepts degradationManager field
// ============================================================

describe('B3: CreateOrchestratorConfig accepts degradationManager', () => {
  it('should accept degradationManager as an optional field in config', () => {
    // This test verifies the TypeScript interface accepts the field.
    // If the field doesn't exist, this would cause a compile error.
    const config: CreateOrchestratorConfig = {
      tracingService: {} as any,
      degradationManager: { isAvailable: () => true } as any,
    };

    expect(config.degradationManager).toBeDefined();
  });

  it('should pass DegradationIntegration to orchestrator when degradationManager is provided', () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    const mockDegradationManager = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    const degradation = new DegradationIntegration(mockDegradationManager as any);

    const mockTracingService = {
      startTrace: jest.fn().mockReturnValue({ traceId: 't1', spanId: 's1' }),
      startSpan: jest.fn().mockReturnValue({ traceId: 't1', spanId: 's2' }),
      endSpan: jest.fn(),
      endTrace: jest.fn().mockResolvedValue(undefined),
    };
    const tracing = new TracingIntegration(mockTracingService as any);

    const engine = new StateMachineEngine(registry, executor, degradation, tracing);
    const concurrencyGuard = new ConcurrencyGuard();
    const mockFeatureFlags = { shouldUseStateMachine: () => true };

    const orchestrator = new StateMachineOrchestrator({
      engine,
      registry,
      concurrencyGuard,
      tracingIntegration: tracing,
      degradationIntegration: degradation,
      featureFlagManager: mockFeatureFlags as any,
    });

    // The orchestrator should have degradation integration
    expect((orchestrator as any).degradation).toBeDefined();
    expect((orchestrator as any).degradation).toBeInstanceOf(DegradationIntegration);
  });
});

// ============================================================
// B4: degraded outcome 正确处理
// ============================================================

describe('B4: degraded outcome follows default transition', () => {
  it('should follow default (unconditional) transition when outcome is degraded', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    const mockDegradationManager = {
      isAvailable: jest.fn().mockReturnValue(false), // capability is degraded
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    const degradation = new DegradationIntegration(mockDegradationManager as any);
    const engine = new StateMachineEngine(registry, executor, degradation);

    // State with only conditional transitions + one unconditional default
    const definition: StateDefinition = {
      id: 'test-degraded',
      name: 'Degraded Test',
      version: '1.0',
      states: ['start', 'knowledgeRetrieval', 'nextStep', 'done', 'errorHandler'],
      initialState: 'start',
      terminalStates: ['done'],
      errorState: 'errorHandler',
      transitions: [
        { from: 'start', to: 'knowledgeRetrieval', condition: 'success' },
        { from: 'knowledgeRetrieval', to: 'nextStep' }, // unconditional default
        { from: 'nextStep', to: 'done', condition: 'success' },
        { from: 'errorHandler', to: 'done', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);
    registry.registerHandler('start', createHandler('startHandler', 'success'));
    // knowledgeRetrieval has a degraded capability → DegradationIntegration returns 'degraded'
    registry.registerHandler('knowledgeRetrieval', createCapabilityHandler('knowledgeHandler', 'experience'));
    registry.registerHandler('nextStep', createHandler('nextStepHandler', 'success'));
    registry.registerHandler('errorHandler', createHandler('errorHandler', 'success'));

    const result = await engine.execute('test-degraded', {});

    // Should follow the default transition to 'nextStep', NOT go to errorState
    expect(result.finalState).toBe('done');
    expect(result.success).toBe(true);
    // knowledgeRetrieval should have been skipped (degraded)
    expect(result.degradedNodes).toContain('knowledgeHandler');
  });

  it('should go to degradedState when no default transition exists and degradedState is configured', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    const mockDegradationManager = {
      isAvailable: jest.fn().mockReturnValue(false),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    const degradation = new DegradationIntegration(mockDegradationManager as any);
    const engine = new StateMachineEngine(registry, executor, degradation);

    // State with ONLY conditional transitions (no unconditional default)
    const definition: StateDefinition = {
      id: 'test-degraded-state',
      name: 'Degraded State Test',
      version: '1.0',
      states: ['start', 'routing', 'fastPath', 'reactLoop', 'degradedResponse', 'done', 'errorHandler'],
      initialState: 'start',
      terminalStates: ['done'],
      errorState: 'errorHandler',
      degradedState: 'degradedResponse',
      transitions: [
        { from: 'start', to: 'routing', condition: 'success' },
        { from: 'routing', to: 'fastPath', condition: 'fastPath' },
        { from: 'routing', to: 'reactLoop', condition: 'reactLoop' },
        // No unconditional transition from 'routing'
        { from: 'fastPath', to: 'done', condition: 'success' },
        { from: 'reactLoop', to: 'done', condition: 'success' },
        { from: 'degradedResponse', to: 'done', condition: 'success' },
        { from: 'errorHandler', to: 'done', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);
    registry.registerHandler('start', createHandler('startHandler', 'success'));
    // routing has a degraded capability
    registry.registerHandler('routing', createCapabilityHandler('routingHandler', 'planRevision'));
    registry.registerHandler('fastPath', createHandler('fastPathHandler', 'success'));
    registry.registerHandler('reactLoop', createHandler('reactLoopHandler', 'success'));
    registry.registerHandler('degradedResponse', createHandler('degradedResponseHandler', 'success'));
    registry.registerHandler('errorHandler', createHandler('errorHandler', 'success'));

    const result = await engine.execute('test-degraded-state', {});

    // Should go to degradedState, not errorState
    expect(result.transitionPath.some(t => t.toState === 'degradedResponse')).toBe(true);
    expect(result.finalState).toBe('done');
    expect(result.success).toBe(true);
  });
});

// ============================================================
// B5: skipped outcome 正确处理
// ============================================================

describe('B5: skipped outcome follows default transition', () => {
  it('should follow default (unconditional) transition when outcome is skipped', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);

    const definition: StateDefinition = {
      id: 'test-skipped',
      name: 'Skipped Test',
      version: '1.0',
      states: ['start', 'optional', 'nextStep', 'done', 'errorHandler'],
      initialState: 'start',
      terminalStates: ['done'],
      errorState: 'errorHandler',
      transitions: [
        { from: 'start', to: 'optional', condition: 'success' },
        { from: 'optional', to: 'nextStep' }, // unconditional default
        { from: 'nextStep', to: 'done', condition: 'success' },
        { from: 'errorHandler', to: 'done', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);
    registry.registerHandler('start', createHandler('startHandler', 'success'));
    // Handler that returns canHandle=false → StateExecutor returns 'skipped'
    registry.registerHandler('optional', {
      name: 'optionalHandler',
      canHandle: () => false,
      handle: async (context: StateContext): Promise<TransitionResult> => {
        return { outcome: 'success', context };
      },
    });
    registry.registerHandler('nextStep', createHandler('nextStepHandler', 'success'));
    registry.registerHandler('errorHandler', createHandler('errorHandler', 'success'));

    const result = await engine.execute('test-skipped', {});

    // Should follow default transition to 'nextStep', NOT go to errorState
    expect(result.finalState).toBe('done');
    expect(result.success).toBe(true);
  });

  it('should go to errorState when no default transition exists for skipped outcome', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);

    const definition: StateDefinition = {
      id: 'test-skipped-error',
      name: 'Skipped Error Test',
      version: '1.0',
      states: ['start', 'conditional', 'pathA', 'pathB', 'done', 'errorHandler'],
      initialState: 'start',
      terminalStates: ['done'],
      errorState: 'errorHandler',
      transitions: [
        { from: 'start', to: 'conditional', condition: 'success' },
        { from: 'conditional', to: 'pathA', condition: 'pathA' },
        { from: 'conditional', to: 'pathB', condition: 'pathB' },
        // No unconditional transition from 'conditional'
        { from: 'pathA', to: 'done', condition: 'success' },
        { from: 'pathB', to: 'done', condition: 'success' },
        { from: 'errorHandler', to: 'done', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);
    registry.registerHandler('start', createHandler('startHandler', 'success'));
    registry.registerHandler('conditional', {
      name: 'conditionalHandler',
      canHandle: () => false, // will be skipped
      handle: async (context: StateContext): Promise<TransitionResult> => {
        return { outcome: 'pathA', context };
      },
    });
    registry.registerHandler('pathA', createHandler('pathAHandler', 'success'));
    registry.registerHandler('pathB', createHandler('pathBHandler', 'success'));
    registry.registerHandler('errorHandler', createHandler('errorHandler', 'success'));

    const result = await engine.execute('test-skipped-error', {});

    // Should go to errorState since no default transition exists
    expect(result.transitionPath.some(t => t.toState === 'errorHandler')).toBe(true);
    expect(result.finalState).toBe('done');
  });
});
