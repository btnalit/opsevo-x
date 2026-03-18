/**
 * StateExecutor 单元测试
 *
 * 验证:
 * - 成功执行 handler 返回正确 outcome
 * - handler 抛出异常时返回 error outcome
 * - canHandle 返回 false 时返回 skipped outcome
 * - handler 返回的 metadata 被保留
 *
 * 需求: 1.4, 1.5, 1.7, 6.4
 */

import { StateExecutor } from '../stateMachine/stateExecutor';
import { StateHandler, StateContext, TransitionResult } from '../stateMachine/types';

/** Helper: create a minimal StateContext stub */
function makeContext(overrides: Partial<StateContext> = {}): StateContext {
  const data = new Map<string, unknown>();
  return {
    requestId: 'req-1',
    executionId: 'exec-1',
    currentState: 'testState',
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

/** Helper: create a stub StateHandler */
function makeHandler(opts: {
  name?: string;
  canHandle?: (ctx: StateContext) => boolean;
  handle?: (ctx: StateContext) => Promise<TransitionResult>;
}): StateHandler {
  return {
    name: opts.name ?? 'testHandler',
    canHandle: opts.canHandle ?? (() => true),
    handle: opts.handle ?? (async (ctx) => ({ outcome: 'success', context: ctx })),
  };
}

describe('StateExecutor', () => {
  let executor: StateExecutor;

  beforeEach(() => {
    executor = new StateExecutor();
  });

  it('should return the TransitionResult from a successful handler execution', async () => {
    const ctx = makeContext();
    const handler = makeHandler({
      handle: async (c) => ({ outcome: 'done', context: c }),
    });

    const result = await executor.executeHandler(handler, ctx);

    expect(result.outcome).toBe('done');
    expect(result.context).toBe(ctx);
  });

  it('should return error outcome when handler throws an Error', async () => {
    const ctx = makeContext();
    const handler = makeHandler({
      handle: async () => {
        throw new Error('something broke');
      },
    });

    const result = await executor.executeHandler(handler, ctx);

    expect(result.outcome).toBe('error');
    expect(result.context).toBe(ctx);
    expect(result.metadata).toEqual({
      error: 'something broke',
      errorName: 'Error',
    });
  });

  it('should return error outcome with correct errorName for custom errors', async () => {
    const ctx = makeContext();
    const handler = makeHandler({
      handle: async () => {
        throw new TypeError('bad type');
      },
    });

    const result = await executor.executeHandler(handler, ctx);

    expect(result.outcome).toBe('error');
    expect(result.metadata).toEqual({
      error: 'bad type',
      errorName: 'TypeError',
    });
  });

  it('should handle non-Error thrown values gracefully', async () => {
    const ctx = makeContext();
    const handler = makeHandler({
      handle: async () => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      },
    });

    const result = await executor.executeHandler(handler, ctx);

    expect(result.outcome).toBe('error');
    expect(result.metadata?.error).toBe('string error');
    expect(result.metadata?.errorName).toBe('Error');
  });

  it('should return skipped outcome when canHandle returns false', async () => {
    const ctx = makeContext();
    const handleSpy = jest.fn();
    const handler = makeHandler({
      canHandle: () => false,
      handle: handleSpy,
    });

    const result = await executor.executeHandler(handler, ctx);

    expect(result.outcome).toBe('skipped');
    expect(result.context).toBe(ctx);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('should preserve metadata returned by the handler', async () => {
    const ctx = makeContext();
    const handler = makeHandler({
      handle: async (c) => ({
        outcome: 'routed',
        context: c,
        metadata: { route: 'fastPath', confidence: 0.95 },
      }),
    });

    const result = await executor.executeHandler(handler, ctx);

    expect(result.outcome).toBe('routed');
    expect(result.metadata).toEqual({ route: 'fastPath', confidence: 0.95 });
  });
});
