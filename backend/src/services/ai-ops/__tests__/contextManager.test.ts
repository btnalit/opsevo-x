/**
 * ContextManager 单元测试
 *
 * 验证:
 * - createContext 创建正确的 StateContext 实例
 * - snapshot 正确保存数据快照并隔离
 * - recordTiming 正确记录进入/退出时间
 * - get/set 类型安全方法
 *
 * 需求: 2.1, 2.3, 2.4, 2.5
 */

import { ContextManager } from '../stateMachine/contextManager';

describe('ContextManager', () => {
  describe('createContext', () => {
    it('should create a StateContext with correct initial values', () => {
      const ctx = ContextManager.createContext('req-1', 'exec-1', 'init');

      expect(ctx.requestId).toBe('req-1');
      expect(ctx.executionId).toBe('exec-1');
      expect(ctx.currentState).toBe('init');
      expect(ctx.stateHistory).toEqual([]);
      expect(ctx.data).toBeInstanceOf(Map);
      expect(ctx.data.size).toBe(0);
      expect(ctx.metadata).toEqual({});
      expect(ctx.timings).toBeInstanceOf(Map);
      expect(ctx.timings.size).toBe(0);
    });

    it('should populate data from initialData map', () => {
      const initialData = new Map<string, unknown>([
        ['key1', 'value1'],
        ['key2', 42],
      ]);
      const ctx = ContextManager.createContext('req-2', 'exec-2', 'start', initialData);

      expect(ctx.data.size).toBe(2);
      expect(ctx.get<string>('key1')).toBe('value1');
      expect(ctx.get<number>('key2')).toBe(42);
    });

    it('should create independent instances (isolation)', () => {
      const ctxA = ContextManager.createContext('req-a', 'exec-a', 'stateA');
      const ctxB = ContextManager.createContext('req-b', 'exec-b', 'stateB');

      ctxA.set('shared', 'only-in-A');
      expect(ctxB.get('shared')).toBeUndefined();
    });

    it('should not mutate the original initialData map', () => {
      const initialData = new Map<string, unknown>([['x', 1]]);
      const ctx = ContextManager.createContext('r', 'e', 's', initialData);

      ctx.set('y', 2);
      expect(initialData.has('y')).toBe(false);
    });
  });

  describe('get/set', () => {
    it('should return undefined for missing keys', () => {
      const ctx = ContextManager.createContext('r', 'e', 's');
      expect(ctx.get('nonexistent')).toBeUndefined();
    });

    it('should round-trip primitive values', () => {
      const ctx = ContextManager.createContext('r', 'e', 's');
      ctx.set('str', 'hello');
      ctx.set('num', 123);
      ctx.set('bool', true);
      ctx.set('nil', null);

      expect(ctx.get<string>('str')).toBe('hello');
      expect(ctx.get<number>('num')).toBe(123);
      expect(ctx.get<boolean>('bool')).toBe(true);
      expect(ctx.get('nil')).toBeNull();
    });

    it('should round-trip object values', () => {
      const ctx = ContextManager.createContext('r', 'e', 's');
      const obj = { nested: { deep: [1, 2, 3] } };
      ctx.set('obj', obj);

      expect(ctx.get('obj')).toBe(obj); // same reference
    });
  });

  describe('snapshot', () => {
    it('should push a history entry with correct state and times', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateA');
      ctx.timings.set('stateA', { enterTime: 1000 });

      ContextManager.snapshot(ctx, 2000);

      expect(ctx.stateHistory).toHaveLength(1);
      const entry = ctx.stateHistory[0];
      expect(entry.state).toBe('stateA');
      expect(entry.enterTime).toBe(1000);
      expect(entry.exitTime).toBe(2000);
    });

    it('should use exitTime as enterTime when no timing recorded', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateX');

      ContextManager.snapshot(ctx, 5000);

      const entry = ctx.stateHistory[0];
      expect(entry.enterTime).toBe(5000);
      expect(entry.exitTime).toBe(5000);
    });

    it('should deep clone data into snapshot for isolation', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateA');
      ctx.set('arr', [1, 2, 3]);
      ctx.timings.set('stateA', { enterTime: 100 });

      ContextManager.snapshot(ctx, 200);

      // Mutate original data after snapshot
      (ctx.get<number[]>('arr') as number[]).push(4);

      const snapshotArr = ctx.stateHistory[0].dataSnapshot['arr'] as number[];
      expect(snapshotArr).toEqual([1, 2, 3]); // snapshot is isolated
    });

    it('should convert Map data to Record in snapshot', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateA');
      ctx.set('name', 'test');
      ctx.set('count', 42);
      ctx.timings.set('stateA', { enterTime: 0 });

      ContextManager.snapshot(ctx, 100);

      const snapshot = ctx.stateHistory[0].dataSnapshot;
      expect(snapshot).toEqual({ name: 'test', count: 42 });
      expect(snapshot).not.toBeInstanceOf(Map);
    });

    it('should accumulate multiple snapshots', () => {
      const ctx = ContextManager.createContext('r', 'e', 'state1');
      ctx.timings.set('state1', { enterTime: 0 });
      ContextManager.snapshot(ctx, 100);

      ctx.currentState = 'state2';
      ctx.timings.set('state2', { enterTime: 100 });
      ContextManager.snapshot(ctx, 200);

      expect(ctx.stateHistory).toHaveLength(2);
      expect(ctx.stateHistory[0].state).toBe('state1');
      expect(ctx.stateHistory[1].state).toBe('state2');
    });
  });

  describe('recordTiming', () => {
    it('should record enter time for a state', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateA');
      const before = Date.now();
      ContextManager.recordTiming(ctx, 'stateA', 'enter');
      const after = Date.now();

      const timing = ctx.timings.get('stateA');
      expect(timing).toBeDefined();
      expect(timing!.enterTime).toBeGreaterThanOrEqual(before);
      expect(timing!.enterTime).toBeLessThanOrEqual(after);
      expect(timing!.exitTime).toBeUndefined();
    });

    it('should record exit time on existing timing entry', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateA');
      ContextManager.recordTiming(ctx, 'stateA', 'enter');
      ContextManager.recordTiming(ctx, 'stateA', 'exit');

      const timing = ctx.timings.get('stateA');
      expect(timing!.exitTime).toBeDefined();
      expect(timing!.exitTime!).toBeGreaterThanOrEqual(timing!.enterTime);
    });

    it('should not create timing entry for exit without prior enter', () => {
      const ctx = ContextManager.createContext('r', 'e', 'stateA');
      ContextManager.recordTiming(ctx, 'stateA', 'exit');

      // No entry should be created since there was no prior enter
      expect(ctx.timings.has('stateA')).toBe(false);
    });
  });
});
