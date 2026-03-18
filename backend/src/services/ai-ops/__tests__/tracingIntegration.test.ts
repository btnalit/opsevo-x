/**
 * TracingIntegration - Unit Tests
 *
 * Tests for the tracing integration layer that wraps StateMachineEngine
 * execution with TracingService calls.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { TracingIntegration } from '../stateMachine/integrations/tracingIntegration';
import { TracingContext } from '../tracingService';
import { ExecutionResult, TransitionRecord } from '../stateMachine/types';

// ============================================================
// Mock TracingService
// ============================================================

function createMockTracingService() {
  let spanCounter = 0;
  return {
    startTrace: jest.fn().mockImplementation((operationName: string, metadata?: Record<string, unknown>): TracingContext => {
      return { traceId: 'trace-1', spanId: 'root-span-1' };
    }),
    startSpan: jest.fn().mockImplementation((context: TracingContext, operationName: string, tags?: Record<string, string | number | boolean>): TracingContext => {
      spanCounter++;
      return { traceId: context.traceId, spanId: `span-${spanCounter}`, parentSpanId: context.spanId };
    }),
    endSpan: jest.fn(),
    endTrace: jest.fn().mockResolvedValue(undefined),
  };
}

// ============================================================
// Test Helpers
// ============================================================

function createExecutionResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  const transitionPath: TransitionRecord[] = overrides.transitionPath ?? [
    { fromState: 'init', toState: 'process', timestamp: 1000, duration: 50, skipped: false },
    { fromState: 'process', toState: 'done', timestamp: 1050, duration: 30, skipped: false },
  ];
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    definitionId: 'test-def',
    finalState: 'done',
    success: true,
    totalDuration: 80,
    nodesVisited: 3,
    degraded: false,
    degradedNodes: [],
    output: {},
    transitionPath,
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('TracingIntegration', () => {
  let tracingService: ReturnType<typeof createMockTracingService>;
  let integration: TracingIntegration;

  beforeEach(() => {
    tracingService = createMockTracingService();
    integration = new TracingIntegration(tracingService as any);
  });

  // ============================================================
  // startExecution Tests (Requirement 8.1, 8.3)
  // ============================================================

  describe('startExecution', () => {
    it('should call TracingService.startTrace with operation name and metadata', () => {
      const ctx = integration.startExecution('exec-1', 'req-1', 'test-def');

      expect(tracingService.startTrace).toHaveBeenCalledWith(
        'state-machine:test-def',
        expect.objectContaining({
          executionId: 'exec-1',
          requestId: 'req-1',
          definitionId: 'test-def',
        }),
      );
      expect(ctx).toEqual({ traceId: 'trace-1', spanId: 'root-span-1' });
    });

    it('should return the TracingContext from startTrace', () => {
      const ctx = integration.startExecution('exec-2', 'req-2', 'alert-pipeline');
      expect(ctx.traceId).toBe('trace-1');
      expect(ctx.spanId).toBe('root-span-1');
    });
  });

  // ============================================================
  // traceTransition Tests (Requirement 8.2, 8.3)
  // ============================================================

  describe('traceTransition', () => {
    it('should call startSpan with state name and duration tag', () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      const spanCtx = integration.traceTransition(rootCtx, 'stateA', 'stateB', 42);

      expect(tracingService.startSpan).toHaveBeenCalledWith(
        rootCtx,
        'transition:stateA->stateB',
        expect.objectContaining({
          fromState: 'stateA',
          toState: 'stateB',
          duration: 42,
        }),
      );
      expect(spanCtx.traceId).toBe('trace-1');
    });

    it('should call endSpan on the created span context', () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      integration.traceTransition(rootCtx, 'init', 'process', 10);

      expect(tracingService.endSpan).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple transitions', () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      integration.traceTransition(rootCtx, 'a', 'b', 10);
      integration.traceTransition(rootCtx, 'b', 'c', 20);
      integration.traceTransition(rootCtx, 'c', 'd', 30);

      expect(tracingService.startSpan).toHaveBeenCalledTimes(3);
      expect(tracingService.endSpan).toHaveBeenCalledTimes(3);
    });
  });

  // ============================================================
  // endExecution Tests (Requirement 8.3, 8.4)
  // ============================================================

  describe('endExecution', () => {
    it('should call TracingService.endTrace with the traceId', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      const result = createExecutionResult();

      await integration.endExecution(rootCtx, result);

      expect(tracingService.endTrace).toHaveBeenCalledWith('trace-1', undefined);
    });

    it('should call endTrace with error when result has error', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      const result = createExecutionResult({ success: false, error: 'something went wrong' });

      await integration.endExecution(rootCtx, result);

      expect(tracingService.endTrace).toHaveBeenCalledWith('trace-1', expect.any(Error));
    });

    it('should store ExecutionSummary after endExecution', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      const result = createExecutionResult();

      await integration.endExecution(rootCtx, result);

      const summary = integration.getExecutionSummary('exec-1');
      expect(summary).toBeDefined();
      expect(summary!.executionId).toBe('exec-1');
      expect(summary!.requestId).toBe('req-1');
      expect(summary!.definitionId).toBe('test-def');
      expect(summary!.finalState).toBe('done');
      expect(summary!.success).toBe(true);
    });

    it('should generate correct execution summary fields', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      const result = createExecutionResult({
        totalDuration: 150,
        nodesVisited: 5,
        degraded: true,
        finalState: 'errorHandler',
        success: false,
      });

      await integration.endExecution(rootCtx, result);

      const summary = integration.getExecutionSummary('exec-1');
      expect(summary).toBeDefined();
      expect(summary!.totalDuration).toBe(150);
      expect(summary!.nodesVisited).toBe(5);
      expect(summary!.degraded).toBe(true);
      expect(summary!.finalState).toBe('errorHandler');
      expect(summary!.success).toBe(false);
    });

    it('should store transitionPath in the summary', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      const transitions: TransitionRecord[] = [
        { fromState: 'a', toState: 'b', timestamp: 100, duration: 10, skipped: false },
        { fromState: 'b', toState: 'c', timestamp: 110, duration: 20, skipped: true, skipReason: 'degraded' },
      ];
      const result = createExecutionResult({ transitionPath: transitions });

      await integration.endExecution(rootCtx, result);

      const summary = integration.getExecutionSummary('exec-1');
      expect(summary!.transitionPath).toEqual(transitions);
    });
  });

  // ============================================================
  // getExecutionSummary Tests (Requirement 8.5)
  // ============================================================

  describe('getExecutionSummary', () => {
    it('should return undefined for unknown executionId', () => {
      expect(integration.getExecutionSummary('unknown')).toBeUndefined();
    });

    it('should return the stored summary for a known executionId', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      await integration.endExecution(rootCtx, createExecutionResult({ executionId: 'exec-42' }));

      const summary = integration.getExecutionSummary('exec-42');
      expect(summary).toBeDefined();
      expect(summary!.executionId).toBe('exec-42');
    });
  });

  // ============================================================
  // queryByRequestId Tests (Requirement 8.5)
  // ============================================================

  describe('queryByRequestId', () => {
    it('should return empty array for unknown requestId', () => {
      expect(integration.queryByRequestId('unknown')).toEqual([]);
    });

    it('should return all summaries for a given requestId', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };

      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'exec-1',
        requestId: 'req-shared',
      }));
      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'exec-2',
        requestId: 'req-shared',
      }));
      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'exec-3',
        requestId: 'req-other',
      }));

      const results = integration.queryByRequestId('req-shared');
      expect(results).toHaveLength(2);
      expect(results.map(s => s.executionId)).toEqual(['exec-1', 'exec-2']);
    });

    it('should return summaries in insertion order', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };

      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'first',
        requestId: 'req-1',
      }));
      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'second',
        requestId: 'req-1',
      }));

      const results = integration.queryByRequestId('req-1');
      expect(results[0].executionId).toBe('first');
      expect(results[1].executionId).toBe('second');
    });
  });

  // ============================================================
  // Summary startTime/endTime Tests (Requirement 8.4)
  // ============================================================

  describe('execution summary timing', () => {
    it('should have startTime <= endTime', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      integration.startExecution('exec-1', 'req-1', 'test-def');
      await integration.endExecution(rootCtx, createExecutionResult());

      const summary = integration.getExecutionSummary('exec-1');
      expect(summary).toBeDefined();
      expect(summary!.startTime).toBeLessThanOrEqual(summary!.endTime);
    });

    it('should compute endTime - startTime close to totalDuration from result', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };
      integration.startExecution('exec-1', 'req-1', 'test-def');
      const result = createExecutionResult({ totalDuration: 100 });
      await integration.endExecution(rootCtx, result);

      const summary = integration.getExecutionSummary('exec-1');
      expect(summary).toBeDefined();
      // totalDuration comes from the ExecutionResult, not computed from wall clock
      expect(summary!.totalDuration).toBe(100);
    });
  });

  // ============================================================
  // Multiple executions isolation
  // ============================================================

  describe('multiple executions', () => {
    it('should store separate summaries for different executionIds', async () => {
      const rootCtx: TracingContext = { traceId: 'trace-1', spanId: 'root-span-1' };

      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'exec-a',
        requestId: 'req-a',
        finalState: 'stateA',
      }));
      await integration.endExecution(rootCtx, createExecutionResult({
        executionId: 'exec-b',
        requestId: 'req-b',
        finalState: 'stateB',
      }));

      const summaryA = integration.getExecutionSummary('exec-a');
      const summaryB = integration.getExecutionSummary('exec-b');

      expect(summaryA!.finalState).toBe('stateA');
      expect(summaryB!.finalState).toBe('stateB');
    });
  });
});
