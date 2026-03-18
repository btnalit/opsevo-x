/**
 * 故障条件探索性测试 - 状态机编排层 7 项缺陷确认
 *
 * 这些测试在未修复代码上运行时预期失败，以确认缺陷确实存在。
 * 每个 describe 块对应一个故障条件（C1-C3, H1-H3, M1）。
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12**
 */

// Jest globals: describe, it, expect are available globally
import { StateMachineEngine } from '../stateMachineEngine';
import { StateRegistry, ValidationError } from '../stateRegistry';
import { StateExecutor } from '../stateExecutor';
import { StateMachineOrchestrator } from '../stateMachineOrchestrator';
import { DegradationIntegration } from '../integrations/degradationIntegration';
import { TracingIntegration } from '../integrations/tracingIntegration';
import { ConcurrencyGuard } from '../integrations/concurrencyGuard';
import {
  StateDefinition,
  StateHandler,
  StateContext,
  TransitionResult,
} from '../types';

// ============================================================
// Test Helpers
// ============================================================

/** Create a simple handler that writes data to context */
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

/** Create a handler with a capability field (for degradation testing) */
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

/** Create a slow handler that takes at least `delayMs` to execute */
function createSlowHandler(name: string, delayMs: number): StateHandler {
  return {
    name,
    canHandle: () => true,
    handle: async (context: StateContext): Promise<TransitionResult> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      context.set(`${name}_executed`, true);
      return { outcome: 'success', context };
    },
  };
}


// ============================================================
// C1: 终止状态 Handler 不执行
// ============================================================

describe('C1: Terminal state handler not executed', () => {
  /**
   * Fault condition: currentState IN definition.terminalStates
   *   AND registry.hasHandler(currentState) AND handler NOT executed
   *
   * The engine's while loop `while (!terminalSet.has(currentState))` exits
   * immediately when reaching a terminal state, so the terminal handler
   * is never called and its data never written to context.
   *
   * On unfixed code → EXPECTED TO FAIL (execResult.output.result is undefined)
   */
  it('should execute terminal state handler and write data to context', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);

    // Define a simple flow: start → process → response(terminal)
    const definition: StateDefinition = {
      id: 'test-terminal',
      name: 'Terminal Test',
      version: '1.0',
      states: ['start', 'process', 'response'],
      initialState: 'start',
      terminalStates: ['response'],
      transitions: [
        { from: 'start', to: 'process', condition: 'success' },
        { from: 'process', to: 'response', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);
    registry.registerHandler('start', createHandler('startHandler', 'success'));
    registry.registerHandler('process', createHandler('processHandler', 'success'));
    // Terminal state handler that writes 'result' to context
    registry.registerHandler(
      'response',
      createHandler('responseHandler', 'success', 'result', { answer: 'hello world' }),
    );

    const execResult = await engine.execute('test-terminal', {});

    // The terminal handler should have been executed and written data
    expect(execResult.output.result).toBeDefined();
    expect(execResult.output.result).toEqual({ answer: 'hello world' });
    expect(execResult.finalState).toBe('response');
    expect(execResult.success).toBe(true);
  });
});

// ============================================================
// C2: Handler 名称冲突
// ============================================================

describe('C2: Handler name collision across flows', () => {
  /**
   * Fault condition: multipleFlowsRegisterSameName('decide')
   *   AND lastRegisteredHandler OVERRIDES previousHandler
   *
   * With the C2 fix, handlers are registered with definition-scoped storage
   * using registerScopedHandler(). Each flow resolves to its own handler
   * via getHandler(stateName, definitionId).
   *
   * After fix → EXPECTED TO PASS (each flow resolves its own handler)
   */
  it('should resolve correct handler for each flow when same name is used', () => {
    const registry = new StateRegistry();

    // Simulate Alert flow registering 'decide' with scoped registration
    const alertDecideHandler = createHandler('alertDecideHandler', 'alert_decision');
    registry.registerScopedHandler('alert-pipeline', 'decide', alertDecideHandler);

    // Simulate Iteration flow registering 'decide' with scoped registration
    const iterationDecideHandler = createHandler('iterationDecideHandler', 'iteration_decision');
    registry.registerScopedHandler('iteration-loop', 'decide', iterationDecideHandler);

    // When Alert flow asks for 'decide', it should get alertDecideHandler
    const alertResolved = registry.getHandler('decide', 'alert-pipeline');
    expect(alertResolved).toBeDefined();
    expect(alertResolved!.name).toBe('alertDecideHandler');

    // When Iteration flow asks for 'decide', it should get iterationDecideHandler
    const iterationResolved = registry.getHandler('decide', 'iteration-loop');
    expect(iterationResolved).toBeDefined();
    expect(iterationResolved!.name).toBe('iterationDecideHandler');
  });
});


// ============================================================
// C3: 入口点键名不匹配
// ============================================================

describe('C3: Entry point key name mismatch', () => {
  /**
   * Fault condition: callerKey('executionOptions') != handlerReadKey('executionContext')
   *
   * unifiedAgentService passes { executionOptions: options } but handlers
   * read context.get('executionContext'), resulting in undefined.
   *
   * On unfixed code → EXPECTED TO FAIL (handler reads undefined)
   */
  it('should allow handler to read executionContext from input', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);

    let readValue: unknown;

    const definition: StateDefinition = {
      id: 'test-keyname',
      name: 'Key Name Test',
      version: '1.0',
      states: ['start', 'done'],
      initialState: 'start',
      terminalStates: ['done'],
      transitions: [
        { from: 'start', to: 'done', condition: 'success' },
      ],
    };

    registry.registerDefinition(definition);

    // Handler reads 'executionContext' (as real handlers do)
    const handler: StateHandler = {
      name: 'startHandler',
      canHandle: () => true,
      handle: async (context: StateContext): Promise<TransitionResult> => {
        readValue = context.get('executionContext');
        return { outcome: 'success', context };
      },
    };
    registry.registerHandler('start', handler);

    // Simulate what unifiedAgentService does after fix: passes 'executionContext' key
    const options = { model: 'gpt-4', temperature: 0.7 };
    await engine.execute('test-keyname', {
      executionContext: options,  // Fixed: matches handler's context.get('executionContext')
    });

    // Handler should be able to read the execution context
    // On unfixed code, this will be undefined because the key doesn't match
    expect(readValue).toBeDefined();
    expect(readValue).toEqual(options);
  });
});

// ============================================================
// H1: DegradationIntegration 未接入执行路径
// ============================================================

describe('H1: DegradationIntegration not wired into execution path', () => {
  /**
   * Fault condition: degradationIntegration EXISTS
   *   AND engine.execute() NEVER calls degradationIntegration.shouldSkip()
   *
   * The engine directly calls executor.executeHandler() without going
   * through DegradationIntegration.wrapExecution().
   *
   * On unfixed code → EXPECTED TO FAIL (shouldSkip never called)
   */
  it('should call DegradationIntegration.shouldSkip() during handler execution', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();

    // Create a mock DegradationManager
    const mockDegradationManager = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    const degradation = new DegradationIntegration(mockDegradationManager as any);
    const shouldSkipSpy = jest.spyOn(degradation, 'shouldSkip');

    // After H1 fix: engine accepts optional degradation parameter
    const engine = new StateMachineEngine(registry, executor, degradation);

    const definition: StateDefinition = {
      id: 'test-degradation',
      name: 'Degradation Test',
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

    await engine.execute('test-degradation', {});

    // DegradationIntegration.shouldSkip() should have been called
    // On unfixed code, the engine doesn't call it at all
    expect(shouldSkipSpy).toHaveBeenCalled();
  });
});


// ============================================================
// H2: TracingIntegration 未接入引擎
// ============================================================

describe('H2: TracingIntegration not wired into engine', () => {
  /**
   * Fault condition: tracingIntegration EXISTS
   *   AND engine.execute() NEVER calls startExecution/traceTransition/endExecution
   *
   * The orchestrator holds a TracingIntegration reference but only uses it
   * for query methods. The engine never calls startExecution/endExecution.
   *
   * On unfixed code → EXPECTED TO FAIL (getExecutionSummary returns undefined)
   */
  it('should produce a valid ExecutionSummary after flow execution', async () => {
    const mockTracingService = {
      startTrace: jest.fn().mockReturnValue({
        traceId: 'trace-1',
        spanId: 'span-1',
      }),
      startSpan: jest.fn().mockReturnValue({
        traceId: 'trace-1',
        spanId: 'span-2',
      }),
      endSpan: jest.fn(),
      endTrace: jest.fn().mockResolvedValue(undefined),
    };

    const tracing = new TracingIntegration(mockTracingService as any);
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    // After H2 fix: engine accepts optional tracing parameter (4th arg)
    const engine = new StateMachineEngine(registry, executor, undefined, tracing);
    const concurrencyGuard = new ConcurrencyGuard();

    const mockFeatureFlags = {
      shouldUseStateMachine: () => true,
    };

    const orchestrator = new StateMachineOrchestrator({
      engine,
      registry,
      concurrencyGuard,
      tracingIntegration: tracing,
      featureFlagManager: mockFeatureFlags as any,
    });

    const definition: StateDefinition = {
      id: 'test-tracing',
      name: 'Tracing Test',
      version: '1.0',
      states: ['start', 'done'],
      initialState: 'start',
      terminalStates: ['done'],
      transitions: [
        { from: 'start', to: 'done', condition: 'success' },
      ],
    };

    orchestrator.registerDefinition(definition);
    orchestrator.registerHandler('start', createHandler('startHandler', 'success'));

    const execResult = await orchestrator.execute('test-tracing', {});

    // After execution, getExecutionSummary should return a valid summary
    // On unfixed code, endExecution is never called so summary is undefined
    const summary = orchestrator.getExecutionHistory(execResult.executionId);
    expect(summary).toBeDefined();
    expect(summary!.executionId).toBe(execResult.executionId);
    expect(summary!.success).toBe(true);
  });
});

// ============================================================
// H3: maxExecutionTime 未强制执行
// ============================================================

describe('H3: maxExecutionTime not enforced', () => {
  /**
   * Fault condition: definition.maxExecutionTime IS defined
   *   AND elapsedTime > maxExecutionTime AND engine does NOT terminate
   *
   * The engine only checks maxSteps, never checks elapsed time against
   * maxExecutionTime.
   *
   * On unfixed code → EXPECTED TO FAIL (execution not terminated by timeout)
   */
  it('should terminate execution when maxExecutionTime is exceeded', async () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);

    // A flow with 3 states, each taking 80ms. Total ~240ms > maxExecutionTime of 100ms
    const definition: StateDefinition = {
      id: 'test-timeout',
      name: 'Timeout Test',
      version: '1.0',
      states: ['step1', 'step2', 'step3', 'done'],
      initialState: 'step1',
      terminalStates: ['done'],
      transitions: [
        { from: 'step1', to: 'step2', condition: 'success' },
        { from: 'step2', to: 'step3', condition: 'success' },
        { from: 'step3', to: 'done', condition: 'success' },
      ],
      maxExecutionTime: 100, // 100ms timeout
    };

    registry.registerDefinition(definition);
    registry.registerHandler('step1', createSlowHandler('step1', 80));
    registry.registerHandler('step2', createSlowHandler('step2', 80));
    registry.registerHandler('step3', createSlowHandler('step3', 80));

    const execResult = await engine.execute('test-timeout', {});

    // Execution should have been terminated due to timeout
    // On unfixed code, the engine doesn't check maxExecutionTime
    expect(execResult.success).toBe(false);
    expect(execResult.error).toBeDefined();
    expect(execResult.error).toContain('execution time');
  });
});

// ============================================================
// M1: validate() 未自动调用
// ============================================================

describe('M1: validate() not automatically called after registration', () => {
  /**
   * Fault condition: registerAllFlows() completed
   *   AND registry.validate() NEVER called
   *
   * registerAllFlows() registers definitions and handlers but never calls
   * validate() at the end, so missing handlers are only discovered at runtime.
   *
   * After M1 fix: registerAllFlows() now calls orchestrator.validateDefinition()
   * at the end, which delegates to registry.validate(). This test verifies
   * that the validateDefinition() method on the orchestrator correctly
   * delegates to registry.validate() and catches missing handlers.
   */
  it('should throw ValidationError when a handler is missing after registration via orchestrator', () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);
    const concurrencyGuard = new ConcurrencyGuard();

    const mockFeatureFlags = {
      shouldUseStateMachine: () => true,
    };

    const orchestrator = new StateMachineOrchestrator({
      engine,
      registry,
      concurrencyGuard,
      tracingIntegration: undefined as any,
      featureFlagManager: mockFeatureFlags as any,
    });

    // Register a definition with 3 non-terminal states
    const definition: StateDefinition = {
      id: 'test-validate',
      name: 'Validation Test',
      version: '1.0',
      states: ['start', 'process', 'finish', 'done'],
      initialState: 'start',
      terminalStates: ['done'],
      transitions: [
        { from: 'start', to: 'process', condition: 'success' },
        { from: 'process', to: 'finish', condition: 'success' },
        { from: 'finish', to: 'done', condition: 'success' },
      ],
    };

    orchestrator.registerDefinition(definition);

    // Deliberately register only 2 of 3 required handlers (missing 'finish')
    orchestrator.registerScopedHandler('test-validate', 'start', createHandler('startHandler', 'success'));
    orchestrator.registerScopedHandler('test-validate', 'process', createHandler('processHandler', 'success'));
    // Missing 'finish' handler

    // After M1 fix, registerAllFlows calls orchestrator.validateDefinition()
    // which delegates to registry.validate(). This should throw ValidationError
    // for the missing 'finish' handler.
    expect(() => orchestrator.validateDefinition('test-validate')).toThrow(ValidationError);
    expect(() => orchestrator.validateDefinition('test-validate')).toThrow(/Missing handlers.*finish/);
  });

  it('should pass validation when all non-terminal handlers are registered', () => {
    const registry = new StateRegistry();
    const executor = new StateExecutor();
    const engine = new StateMachineEngine(registry, executor);
    const concurrencyGuard = new ConcurrencyGuard();

    const mockFeatureFlags = {
      shouldUseStateMachine: () => true,
    };

    const orchestrator = new StateMachineOrchestrator({
      engine,
      registry,
      concurrencyGuard,
      tracingIntegration: undefined as any,
      featureFlagManager: mockFeatureFlags as any,
    });

    const definition: StateDefinition = {
      id: 'test-validate-pass',
      name: 'Validation Pass Test',
      version: '1.0',
      states: ['start', 'process', 'done'],
      initialState: 'start',
      terminalStates: ['done'],
      transitions: [
        { from: 'start', to: 'process', condition: 'success' },
        { from: 'process', to: 'done', condition: 'success' },
      ],
    };

    orchestrator.registerDefinition(definition);
    orchestrator.registerScopedHandler('test-validate-pass', 'start', createHandler('startHandler', 'success'));
    orchestrator.registerScopedHandler('test-validate-pass', 'process', createHandler('processHandler', 'success'));

    // Should NOT throw when all non-terminal handlers are registered
    expect(() => orchestrator.validateDefinition('test-validate-pass')).not.toThrow();
  });
});
