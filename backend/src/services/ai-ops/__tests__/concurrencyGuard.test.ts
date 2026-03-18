/**
 * ConcurrencyGuard Unit Tests
 *
 * Tests for the ConcurrencyGuard integration that wraps ConcurrencyController
 * to provide concurrency control for state machine executions.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 */

import { ConcurrencyGuard } from '../stateMachine/integrations/concurrencyGuard';
import { ExecutionResult } from '../stateMachine/types';

function createMockResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    definitionId: 'def-1',
    finalState: 'done',
    success: true,
    totalDuration: 100,
    nodesVisited: 3,
    degraded: false,
    degradedNodes: [],
    output: {},
    transitionPath: [],
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('ConcurrencyGuard', () => {
  describe('constructor', () => {
    it('should create with default parameters', () => {
      const guard = new ConcurrencyGuard();
      const status = guard.getConcurrencyStatus();
      expect(status.maxConcurrent).toBeGreaterThan(0);
      expect(status.active).toBe(0);
      expect(status.queued).toBe(0);
    });

    it('should accept custom maxConcurrent and queueTimeout', () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 3, queueTimeout: 5000 });
      const status = guard.getConcurrencyStatus();
      expect(status.maxConcurrent).toBe(3);
    });
  });

  describe('execute', () => {
    it('should execute a function and return its result', async () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 2 });
      const expected = createMockResult();
      const result = await guard.execute(() => Promise.resolve(expected));
      expect(result).toEqual(expected);
    });

    it('should propagate errors from the execution function', async () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 2 });
      await expect(
        guard.execute(() => Promise.reject(new Error('execution failed')))
      ).rejects.toThrow('execution failed');
    });

    it('should allow concurrent executions up to maxConcurrent', async () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 2, queueTimeout: 2000 });
      let concurrentCount = 0;
      let maxObserved = 0;

      const executeFn = async (): Promise<ExecutionResult> => {
        concurrentCount++;
        maxObserved = Math.max(maxObserved, concurrentCount);
        await delay(50);
        concurrentCount--;
        return createMockResult();
      };

      const results = await Promise.all([
        guard.execute(executeFn),
        guard.execute(executeFn),
        guard.execute(executeFn),
      ]);

      expect(results).toHaveLength(3);
      expect(maxObserved).toBeLessThanOrEqual(2);
    });

    it('should queue requests exceeding concurrency limit', async () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 1, queueTimeout: 2000 });
      let resolveFirst: (() => void) | undefined;
      const firstBlocking = new Promise<void>(r => { resolveFirst = r; });

      const firstExec = guard.execute(async () => {
        await firstBlocking;
        return createMockResult({ executionId: 'first' });
      });

      // Give time for first to start
      await delay(10);

      const status = guard.getConcurrencyStatus();
      expect(status.active).toBe(1);

      // Start second - should be queued
      const secondExec = guard.execute(async () => {
        return createMockResult({ executionId: 'second' });
      });

      await delay(10);
      const statusAfter = guard.getConcurrencyStatus();
      expect(statusAfter.active).toBe(1);
      expect(statusAfter.queued).toBe(1);

      // Release first
      resolveFirst!();
      const [first, second] = await Promise.all([firstExec, secondExec]);
      expect(first.executionId).toBe('first');
      expect(second.executionId).toBe('second');
    });
  });

  describe('queue timeout', () => {
    it('should reject queued requests that wait longer than timeout', async () => {
      // Use a short queue timeout. The blocking task holds the only slot
      // so the second task stays in the queue until the timeout fires.
      const guard = new ConcurrencyGuard({ maxConcurrent: 1, queueTimeout: 50 });
      let resolveBlocking: (() => void) | undefined;
      const blocking = new Promise<void>(r => { resolveBlocking = r; });

      // Start a long-running execution to fill the concurrency slot
      const firstExec = guard.execute(async () => {
        await blocking;
        return createMockResult();
      });

      await delay(10);

      // This should be queued and eventually timeout while waiting
      const secondExec = guard.execute(async () => {
        return createMockResult();
      });

      // Wait long enough for the queue timeout to fire
      await expect(secondExec).rejects.toThrow(/timed out/i);

      // Clean up: release the blocking task
      resolveBlocking!();
      await firstExec;
    });
  });

  describe('getConcurrencyStatus', () => {
    it('should return accurate active count during execution', async () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 3, queueTimeout: 5000 });
      let resolvers: (() => void)[] = [];

      const createBlockingExec = () => {
        let resolve: (() => void) | undefined;
        const blocker = new Promise<void>(r => { resolve = r; });
        const exec = guard.execute(async () => {
          await blocker;
          return createMockResult();
        });
        resolvers.push(resolve!);
        return exec;
      };

      const exec1 = createBlockingExec();
      const exec2 = createBlockingExec();
      await delay(20);

      const status = guard.getConcurrencyStatus();
      expect(status.active).toBe(2);
      expect(status.queued).toBe(0);
      expect(status.maxConcurrent).toBe(3);

      // Release all
      resolvers.forEach(r => r());
      await Promise.all([exec1, exec2]);

      const finalStatus = guard.getConcurrencyStatus();
      expect(finalStatus.active).toBe(0);
    });

    it('should return accurate queued count', async () => {
      const guard = new ConcurrencyGuard({ maxConcurrent: 1, queueTimeout: 2000 });
      let resolveFirst: (() => void) | undefined;
      const blocking = new Promise<void>(r => { resolveFirst = r; });

      const exec1 = guard.execute(async () => {
        await blocking;
        return createMockResult();
      });

      await delay(10);

      const exec2 = guard.execute(async () => createMockResult());
      const exec3 = guard.execute(async () => createMockResult());

      await delay(10);

      const status = guard.getConcurrencyStatus();
      expect(status.active).toBe(1);
      expect(status.queued).toBe(2);

      resolveFirst!();
      await Promise.all([exec1, exec2, exec3]);
    });
  });
});
