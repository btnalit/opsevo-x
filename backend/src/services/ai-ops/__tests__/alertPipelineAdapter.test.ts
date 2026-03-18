/**
 * AlertPipelineAdapter 单元测试
 *
 * 验证:
 * - 将 AlertPipeline 包装为 StateHandler 接口
 * - StateContext → AlertPipeline 输入格式转换（rawEvent → SyslogEvent/AlertEvent）
 * - AlertPipeline 输出 → StateContext 格式转换（PipelineResult → context fields）
 * - canHandle 正确判断上下文是否包含必要数据
 * - 不修改 AlertPipeline 内部实现
 *
 * 需求: 9.1, 9.2
 */

import { AlertPipelineAdapter } from '../stateMachine/adapters/alertPipelineAdapter';
import { StateContext } from '../stateMachine/types';
import { AlertPipeline } from '../alertPipeline';
import {
  SyslogEvent,
  AlertEvent,
  PipelineResult,
  UnifiedEvent,
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
    currentState: 'AlertPipeline',
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

function makeSyslogEvent(overrides: Partial<SyslogEvent> = {}): SyslogEvent {
  return {
    id: 'syslog-evt-1',
    source: 'syslog',
    timestamp: Date.now(),
    severity: 'warning' as AlertSeverity,
    category: 'system',
    message: 'Interface eth0 link down',
    rawData: {
      facility: 1,
      severity: 4,
      timestamp: new Date(),
      hostname: 'router-1',
      appName: 'kernel',
      message: 'Interface eth0 link down',
    } as any,
    metadata: {
      hostname: 'router-1',
      facility: 1,
      syslogSeverity: 4,
    },
    ...overrides,
  };
}

function makeAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'alert-evt-1',
    ruleId: 'rule-1',
    ruleName: 'High CPU',
    severity: 'critical' as AlertSeverity,
    metric: 'cpu' as any,
    currentValue: 95,
    threshold: 90,
    message: 'CPU usage exceeded 90%',
    status: 'active',
    triggeredAt: Date.now(),
    ...overrides,
  };
}

function makeUnifiedEvent(): UnifiedEvent {
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
  } as any;
}

function makePipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    event: makeUnifiedEvent(),
    stage: 'decide',
    filtered: false,
    analysis: {
      eventId: 'unified-evt-1',
      rootCause: 'Interface flap',
      confidence: 0.85,
      relatedEvents: [],
      suggestedActions: ['Check cable'],
      timestamp: Date.now(),
    } as any,
    decision: {
      id: 'decision-1',
      eventId: 'unified-evt-1',
      action: 'notify',
      confidence: 0.9,
      reasoning: 'High severity event',
      timestamp: Date.now(),
    } as any,
    ...overrides,
  };
}

/** Create a mock AlertPipeline */
function makeMockPipeline(result?: PipelineResult): AlertPipeline {
  const mockResult = result ?? makePipelineResult();
  const pipeline = {
    process: jest.fn().mockResolvedValue(mockResult),
  } as unknown as AlertPipeline;
  return pipeline;
}

// ============================================================
// Tests
// ============================================================

describe('AlertPipelineAdapter', () => {
  describe('constructor and properties', () => {
    it('should have name "AlertPipelineAdapter"', () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);
      expect(adapter.name).toBe('AlertPipelineAdapter');
    });

    it('should implement StateHandler interface', () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);
      expect(typeof adapter.canHandle).toBe('function');
      expect(typeof adapter.handle).toBe('function');
      expect(typeof adapter.name).toBe('string');
    });
  });

  describe('canHandle', () => {
    it('should return true when context has rawEvent', () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);
      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      expect(adapter.canHandle(ctx)).toBe(true);
    });

    it('should return true when context has AlertEvent as rawEvent', () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);
      const ctx = makeContext();
      ctx.set('rawEvent', makeAlertEvent());

      expect(adapter.canHandle(ctx)).toBe(true);
    });

    it('should return false when context is missing rawEvent', () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);
      const ctx = makeContext();

      expect(adapter.canHandle(ctx)).toBe(false);
    });
  });

  describe('handle - format conversion StateContext → AlertPipeline input', () => {
    it('should extract rawEvent from StateContext and call pipeline.process with SyslogEvent', async () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);

      const syslogEvent = makeSyslogEvent();
      const ctx = makeContext();
      ctx.set('rawEvent', syslogEvent);

      await adapter.handle(ctx);

      expect(pipeline.process).toHaveBeenCalledTimes(1);
      expect(pipeline.process).toHaveBeenCalledWith(syslogEvent);
    });

    it('should extract rawEvent from StateContext and call pipeline.process with AlertEvent', async () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);

      const alertEvent = makeAlertEvent();
      const ctx = makeContext();
      ctx.set('rawEvent', alertEvent);

      await adapter.handle(ctx);

      expect(pipeline.process).toHaveBeenCalledTimes(1);
      expect(pipeline.process).toHaveBeenCalledWith(alertEvent);
    });
  });

  describe('handle - format conversion AlertPipeline output → StateContext', () => {
    it('should write pipelineResult to StateContext', async () => {
      const expectedResult = makePipelineResult();
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.context.get('pipelineResult')).toEqual(expectedResult);
    });

    it('should write normalizedEvent to StateContext from pipeline result', async () => {
      const unifiedEvent = makeUnifiedEvent();
      const expectedResult = makePipelineResult({ event: unifiedEvent });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.context.get('normalizedEvent')).toEqual(unifiedEvent);
    });

    it('should write rootCauseAnalysis to StateContext when present', async () => {
      const analysis = {
        eventId: 'evt-1',
        rootCause: 'Cable fault',
        confidence: 0.9,
        relatedEvents: [],
        suggestedActions: ['Replace cable'],
        timestamp: Date.now(),
      };
      const expectedResult = makePipelineResult({ analysis: analysis as any });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.context.get('rootCauseAnalysis')).toEqual(analysis);
    });

    it('should write decision to StateContext when present', async () => {
      const decision = {
        id: 'dec-1',
        eventId: 'evt-1',
        action: 'remediate',
        confidence: 0.95,
        reasoning: 'Critical issue',
        timestamp: Date.now(),
      };
      const expectedResult = makePipelineResult({ decision: decision as any });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.context.get('decision')).toEqual(decision);
    });

    it('should write remediationPlan to StateContext when present', async () => {
      const plan = {
        id: 'plan-1',
        steps: [{ action: 'restart', target: 'interface' }],
      };
      const expectedResult = makePipelineResult({ plan: plan as any });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.context.get('remediationPlan')).toEqual(plan);
    });

    it('should write filterResult to StateContext when event was filtered', async () => {
      const filterResult = {
        filtered: true,
        reason: 'maintenance_window',
        details: 'Event filtered during maintenance',
      };
      const expectedResult = makePipelineResult({
        filtered: true,
        stage: 'filter',
        filterResult: filterResult as any,
      });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.context.get('filterResult')).toEqual(filterResult);
    });

    it('should return outcome "success" on successful non-filtered execution', async () => {
      const expectedResult = makePipelineResult({ filtered: false });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('success');
    });

    it('should return outcome "filtered" when pipeline result is filtered', async () => {
      const expectedResult = makePipelineResult({ filtered: true, stage: 'filter' });
      const pipeline = makeMockPipeline(expectedResult);
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('filtered');
    });

    it('should return outcome "error" when pipeline.process throws', async () => {
      const pipeline = {
        process: jest.fn().mockRejectedValue(new Error('Pipeline timeout')),
      } as unknown as AlertPipeline;
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('error');
      expect(result.context.get('error')).toBeDefined();
    });
  });

  describe('handle - does not modify AlertPipeline', () => {
    it('should only call process without modifying pipeline state', async () => {
      const pipeline = makeMockPipeline();
      const adapter = new AlertPipelineAdapter(pipeline);

      const ctx = makeContext();
      ctx.set('rawEvent', makeSyslogEvent());

      await adapter.handle(ctx);

      // Only process should have been called
      expect(pipeline.process).toHaveBeenCalledTimes(1);
    });
  });
});
