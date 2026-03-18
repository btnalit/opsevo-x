/**
 * IterationLoopAdapter 单元测试
 *
 * 验证:
 * - 将 IterationLoop 包装为 StateHandler 接口
 * - StateContext → IterationLoop 输入格式转换（alertEvent + decision + currentPlan）
 * - IterationLoop 输出 → StateContext 格式转换（iterationId + IterationState）
 * - canHandle 正确判断上下文是否包含必要数据
 * - 不修改 IterationLoop 内部实现
 *
 * 需求: 9.1, 9.2
 */

import { IterationLoopAdapter } from '../stateMachine/adapters/iterationLoopAdapter';
import { StateContext } from '../stateMachine/types';
import { IterationLoop } from '../iterationLoop';
import {
  UnifiedEvent,
  Decision,
  RemediationPlan,
  IterationState,
  AlertSeverity,
} from '../../../types/ai-ops';

// ============================================================
// Helpers
// ============================================================

/** Create a minimal StateContext stub */
function makeContext(overrides: Partial<StateContext> = {}): StateContext {
  const data = new Map<string, unknown>();
  return {
    requestId: 'req-test-1',
    executionId: 'exec-test-1',
    currentState: 'IterationLoop',
    stateHistory: [],
    data,
    metadata: {},
    timings: new Map(),
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      data.set(key, value);
    },
    ...overrides,
  };
}

function makeUnifiedEvent(overrides: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    id: 'unified-evt-1',
    originalId: 'syslog-evt-1',
    source: 'syslog',
    timestamp: Date.now(),
    severity: 'warning' as AlertSeverity,
    category: 'system',
    title: 'Interface eth0 link down',
    description: 'Interface eth0 link down',
    fingerprint: 'fp-123',
    tags: [],
    metadata: {},
    ...overrides,
  } as any;
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'decision-1',
    alertId: 'unified-evt-1',
    timestamp: Date.now(),
    action: 'auto_execute',
    reasoning: 'High severity event requires auto remediation',
    factors: [],
    executed: false,
    ...overrides,
  };
}

function makeRemediationPlan(overrides: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
    id: 'plan-1',
    alertId: 'unified-evt-1',
    rootCauseId: 'rc-1',
    description: 'Restart interface eth0',
    timestamp: Date.now(),
    steps: [
      {
        order: 1,
        action: 'restart_interface',
        target: 'eth0',
        description: 'Restart network interface',
        risk: 'low',
        estimatedDuration: 30,
        requiresConfirmation: false,
        rollbackAction: 'no_action',
      } as any,
    ],
    rollback: [],
    overallRisk: 'low',
    estimatedDuration: 30,
    requiresConfirmation: false,
    status: 'pending',
    ...overrides,
  } as any;
}

function makeIterationState(overrides: Partial<IterationState> = {}): IterationState {
  return {
    id: 'iteration-1',
    alertId: 'unified-evt-1',
    planId: 'plan-1',
    currentIteration: 2,
    maxIterations: 5,
    status: 'completed',
    startTime: Date.now() - 10000,
    endTime: Date.now(),
    evaluations: [
      {
        overallSuccess: true,
        overallScore: 0.9,
        stepEvaluations: [],
        timestamp: Date.now(),
      } as any,
    ],
    reflections: [
      {
        nextAction: 'complete',
        summary: 'Remediation successful',
        timestamp: Date.now(),
      } as any,
    ],
    learningEntries: [],
    config: {
      maxIterations: 5,
      successThreshold: 0.8,
      timeoutMs: 300000,
    } as any,
    ...overrides,
  };
}

/** Create a mock IterationLoop */
function makeMockIterationLoop(
  iterationId: string = 'iteration-1',
  state?: IterationState | null,
): IterationLoop {
  const mockState = state !== undefined ? state : makeIterationState({ id: iterationId });
  return {
    start: jest.fn().mockResolvedValue(iterationId),
    getState: jest.fn().mockResolvedValue(mockState),
  } as unknown as IterationLoop;
}

// ============================================================
// Tests
// ============================================================

describe('IterationLoopAdapter', () => {
  describe('constructor and properties', () => {
    it('should have name "IterationLoopAdapter"', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      expect(adapter.name).toBe('IterationLoopAdapter');
    });

    it('should implement StateHandler interface', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      expect(typeof adapter.canHandle).toBe('function');
      expect(typeof adapter.handle).toBe('function');
      expect(typeof adapter.name).toBe('string');
    });
  });

  describe('canHandle', () => {
    it('should return true when context has alertEvent, decision, and currentPlan', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      expect(adapter.canHandle(ctx)).toBe(true);
    });

    it('should return false when context is missing alertEvent', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      const ctx = makeContext();
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      expect(adapter.canHandle(ctx)).toBe(false);
    });

    it('should return false when context is missing decision', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('currentPlan', makeRemediationPlan());

      expect(adapter.canHandle(ctx)).toBe(false);
    });

    it('should return false when context is missing currentPlan', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());

      expect(adapter.canHandle(ctx)).toBe(false);
    });

    it('should return false when context is empty', () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);
      const ctx = makeContext();

      expect(adapter.canHandle(ctx)).toBe(false);
    });
  });

  describe('handle - format conversion StateContext → IterationLoop input', () => {
    it('should extract alertEvent, decision, and currentPlan from StateContext and call start', async () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);

      const alertEvent = makeUnifiedEvent();
      const decision = makeDecision();
      const plan = makeRemediationPlan();

      const ctx = makeContext();
      ctx.set('alertEvent', alertEvent);
      ctx.set('decision', decision);
      ctx.set('currentPlan', plan);

      await adapter.handle(ctx);

      expect(loop.start).toHaveBeenCalledTimes(1);
      expect(loop.start).toHaveBeenCalledWith(alertEvent, decision, plan);
    });
  });

  describe('handle - format conversion IterationLoop output → StateContext', () => {
    it('should write iterationId to StateContext', async () => {
      const loop = makeMockIterationLoop('iter-abc');
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.context.get('iterationId')).toBe('iter-abc');
    });

    it('should write iterationState to StateContext', async () => {
      const expectedState = makeIterationState({ id: 'iter-xyz', status: 'completed' });
      const loop = makeMockIterationLoop('iter-xyz', expectedState);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.context.get('iterationState')).toEqual(expectedState);
    });

    it('should write iterationResult with status and iterations to StateContext', async () => {
      const expectedState = makeIterationState({
        id: 'iter-1',
        status: 'completed',
        currentIteration: 3,
      });
      const loop = makeMockIterationLoop('iter-1', expectedState);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      const iterationResult = result.context.get<{
        iterationId: string;
        status: string;
        iterations: number;
        success: boolean;
      }>('iterationResult');
      expect(iterationResult).toBeDefined();
      expect(iterationResult!.iterationId).toBe('iter-1');
      expect(iterationResult!.status).toBe('completed');
      expect(iterationResult!.iterations).toBe(3);
      expect(iterationResult!.success).toBe(true);
    });

    it('should write evaluations to StateContext when present', async () => {
      const evaluations = [
        { overallSuccess: true, overallScore: 0.95, stepEvaluations: [], timestamp: Date.now() },
      ];
      const expectedState = makeIterationState({ evaluations: evaluations as any });
      const loop = makeMockIterationLoop('iter-1', expectedState);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.context.get('evaluations')).toEqual(evaluations);
    });

    it('should write reflections to StateContext when present', async () => {
      const reflections = [
        { nextAction: 'complete', summary: 'All good', timestamp: Date.now() },
      ];
      const expectedState = makeIterationState({ reflections: reflections as any });
      const loop = makeMockIterationLoop('iter-1', expectedState);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.context.get('reflections')).toEqual(reflections);
    });

    it('should return outcome "success" when iteration completes successfully', async () => {
      const state = makeIterationState({ status: 'completed' });
      const loop = makeMockIterationLoop('iter-1', state);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('success');
    });

    it('should return outcome "escalated" when iteration is escalated', async () => {
      const state = makeIterationState({ status: 'escalated' });
      const loop = makeMockIterationLoop('iter-1', state);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('escalated');
    });

    it('should return outcome "aborted" when iteration is aborted', async () => {
      const state = makeIterationState({ status: 'aborted' });
      const loop = makeMockIterationLoop('iter-1', state);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('aborted');
    });

    it('should return outcome "success" and still write state when getState returns null', async () => {
      const loop = makeMockIterationLoop('iter-1', null);
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('success');
      expect(result.context.get('iterationId')).toBe('iter-1');
      expect(result.context.get('iterationState')).toBeUndefined();
    });
  });

  describe('handle - error handling', () => {
    it('should return outcome "error" when iterationLoop.start throws', async () => {
      const loop = {
        start: jest.fn().mockRejectedValue(new Error('Iteration loop failed')),
        getState: jest.fn(),
      } as unknown as IterationLoop;
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('error');
      expect(result.context.get('error')).toBe('Iteration loop failed');
    });

    it('should return outcome "error" with string error when non-Error is thrown', async () => {
      const loop = {
        start: jest.fn().mockRejectedValue('string error'),
        getState: jest.fn(),
      } as unknown as IterationLoop;
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('error');
      expect(result.context.get('error')).toBe('string error');
    });
  });

  describe('handle - does not modify IterationLoop', () => {
    it('should only call start and getState without modifying loop state', async () => {
      const loop = makeMockIterationLoop();
      const adapter = new IterationLoopAdapter(loop);

      const ctx = makeContext();
      ctx.set('alertEvent', makeUnifiedEvent());
      ctx.set('decision', makeDecision());
      ctx.set('currentPlan', makeRemediationPlan());

      await adapter.handle(ctx);

      expect(loop.start).toHaveBeenCalledTimes(1);
      expect(loop.getState).toHaveBeenCalledTimes(1);
    });
  });
});
