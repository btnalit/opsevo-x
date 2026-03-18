/**
 * 上下文管理器 - 创建、快照和管理 StateContext 实例
 *
 * 需求: 2.1 (StateContext 结构), 2.3 (快照保存), 2.4 (节点计时), 2.5 (独立实例)
 */

import { StateContext, StateHistoryEntry } from './types';

/**
 * StateContext 的具体实现类
 * 提供类型安全的 get/set 方法和 Map 数据存储
 */
class StateContextImpl implements StateContext {
  readonly requestId: string;
  readonly executionId: string;
  currentState: string;
  stateHistory: StateHistoryEntry[];
  data: Map<string, unknown>;
  metadata: Record<string, unknown>;
  timings: Map<string, { enterTime: number; exitTime?: number }>;

  constructor(
    requestId: string,
    executionId: string,
    initialState: string,
    initialData?: Map<string, unknown>,
  ) {
    this.requestId = requestId;
    this.executionId = executionId;
    this.currentState = initialState;
    this.stateHistory = [];
    this.data = initialData ? new Map(initialData) : new Map();
    this.metadata = {};
    this.timings = new Map();
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.data.set(key, value);
  }
}

/**
 * ContextManager - 管理 StateContext 的创建、快照和计时
 */
export const ContextManager = {
  /**
   * 创建新的 StateContext 实例
   * 需求 2.1: 包含 requestId、executionId、初始状态、共享数据存储和元数据
   * 需求 2.5: 每次调用创建独立实例，并发请求互不干扰
   */
  createContext(
    requestId: string,
    executionId: string,
    initialState: string,
    initialData?: Map<string, unknown>,
  ): StateContext {
    return new StateContextImpl(requestId, executionId, initialState, initialData);
  },

  /**
   * 在状态转移前保存上下文数据快照到 stateHistory
   * 需求 2.3: 保留修改前的 StateContext 快照
   * 需求 2.4: 记录进入/退出时间
   *
   * 将 Map<string, unknown> 转换为 Record<string, unknown> 进行深拷贝，
   * 确保快照与后续修改隔离。
   */
  snapshot(context: StateContext, exitTime: number): void {
    const timing = context.timings.get(context.currentState);
    const enterTime = timing?.enterTime ?? exitTime;

    // Map → Record 转换，使用 structuredClone 进行深拷贝以确保隔离
    const dataRecord: Record<string, unknown> = {};
    for (const [key, value] of context.data) {
      try {
        dataRecord[key] = structuredClone(value);
      } catch {
        // 不可克隆的值直接引用（如函数等）
        dataRecord[key] = value;
      }
    }

    const entry: StateHistoryEntry = {
      state: context.currentState,
      enterTime,
      exitTime,
      dataSnapshot: dataRecord,
    };

    context.stateHistory.push(entry);
  },

  /**
   * 记录状态节点的进入或退出时间
   * 需求 2.4: 记录每个状态节点的进入时间和退出时间
   */
  recordTiming(
    context: StateContext,
    state: string,
    type: 'enter' | 'exit',
  ): void {
    if (type === 'enter') {
      context.timings.set(state, { enterTime: Date.now() });
    } else {
      const existing = context.timings.get(state);
      if (existing) {
        existing.exitTime = Date.now();
      }
    }
  },
};
