/**
 * 轻量级状态机编排层 - 核心类型定义
 *
 * 定义状态机引擎的所有核心接口和数据模型。
 * 需求: 1.1, 1.2, 1.5, 1.8, 2.1, 2.2, 6.4
 */

import { CapabilityName } from '../degradationManager';

// ============================================================
// 核心接口
// ============================================================

/**
 * 状态处理器接口 - 每个状态节点的执行逻辑
 * 需求 1.2: 注册 StateHandler 方法
 * 需求 6.4: canHandle 条件性节点执行
 */
export interface StateHandler<TContext extends StateContext = StateContext> {
  /** 处理器名称，用于注册和日志 */
  readonly name: string;

  /** 关联的进化能力名称（可选，用于降级检查） */
  readonly capability?: CapabilityName;

  /**
   * 判断该处理器是否适用于当前上下文
   * 用于条件性节点执行
   */
  canHandle(context: TContext): boolean;

  /**
   * 执行状态处理逻辑
   * @returns 包含转移结果标识（outcome）和更新后上下文的结果
   */
  handle(context: TContext): Promise<TransitionResult<TContext>>;
}

/**
 * 状态转移结果
 * 需求 1.5: outcome 标识用于匹配 StateTransition.condition
 */
export interface TransitionResult<TContext extends StateContext = StateContext> {
  /** 转移结果标识，引擎根据此值匹配 StateTransition.condition 决定下一状态 */
  outcome: string;
  /** 更新后的上下文 */
  context: TContext;
  /** 转移元数据（可选） */
  metadata?: Record<string, unknown>;
}

/**
 * 状态上下文 - 在状态节点之间传递的共享数据容器
 * 需求 2.1: 包含 requestId、当前状态、历史记录、共享数据、元数据
 * 需求 2.2: 类型安全的 get/set 方法
 */
export interface StateContext {
  /** 请求唯一标识 */
  readonly requestId: string;
  /** 执行唯一标识 */
  readonly executionId: string;
  /** 当前状态标识 */
  currentState: string;
  /** 状态历史记录（含快照） */
  stateHistory: StateHistoryEntry[];
  /** 共享数据存储 */
  data: Map<string, unknown>;
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 每个节点的进入/退出时间 */
  timings: Map<string, { enterTime: number; exitTime?: number }>;

  /** 类型安全的 get 方法 */
  get<T>(key: string): T | undefined;
  /** 类型安全的 set 方法 */
  set<T>(key: string, value: T): void;
}

/**
 * 状态历史记录条目
 * 需求 2.3: 状态转移前保存上下文数据快照
 * 需求 2.4: 记录每个节点的进入/退出时间
 */
export interface StateHistoryEntry {
  /** 状态名称 */
  state: string;
  /** 进入时间（毫秒时间戳） */
  enterTime: number;
  /** 退出时间（毫秒时间戳） */
  exitTime: number;
  /** 进入该状态时的数据快照 */
  dataSnapshot: Record<string, unknown>;
}

// ============================================================
// 状态定义与转移
// ============================================================

/**
 * 状态定义 - 描述一个状态机的完整配置
 * 需求 1.1: 包含状态枚举、转移规则、初始状态和终止状态
 * 需求 1.8: maxSteps 防止无限循环
 */
export interface StateDefinition {
  /** 状态机唯一标识 */
  id: string;
  /** 状态机名称 */
  name: string;
  /** 版本号 */
  version: string;
  /** 所有状态枚举 */
  states: string[];
  /** 初始状态 */
  initialState: string;
  /** 终止状态集合 */
  terminalStates: string[];
  /** 转移规则 */
  transitions: StateTransition[];
  /** 错误处理状态（可选） */
  errorState?: string;
  /** 降级响应状态（可选） */
  degradedState?: string;
  /** 最大状态转移步数（默认 100），防止无限循环 */
  maxSteps?: number;
  /** 最大执行时间（毫秒，可选），超时后强制终止 */
  maxExecutionTime?: number;
}

/**
 * 状态转移规则
 * 需求 1.5: condition 匹配 StateHandler 返回的 outcome 值
 */
export interface StateTransition {
  /** 源状态 */
  from: string;
  /** 目标状态 */
  to: string;
  /** 转移条件：匹配 StateHandler 返回的 outcome 值（可选，默认匹配任意 outcome） */
  condition?: string;
  /** 转移优先级（数值越小优先级越高） */
  priority?: number;
}

// ============================================================
// 执行结果与摘要
// ============================================================

/**
 * 状态机执行结果
 * 需求 8.1: 包含唯一 executionId
 * 需求 8.2: 包含完整状态转移路径
 * 需求 8.4: 包含执行摘要信息
 */
export interface ExecutionResult {
  /** 执行唯一标识 */
  executionId: string;
  /** 请求唯一标识 */
  requestId: string;
  /** 使用的状态定义 ID */
  definitionId: string;
  /** 最终状态 */
  finalState: string;
  /** 是否成功到达终止状态 */
  success: boolean;
  /** 总耗时（毫秒） */
  totalDuration: number;
  /** 经过的节点数 */
  nodesVisited: number;
  /** 是否触发降级 */
  degraded: boolean;
  /** 降级的节点列表 */
  degradedNodes: string[];
  /** 最终上下文中的输出数据 */
  output: Record<string, unknown>;
  /** 完整状态转移路径 */
  transitionPath: TransitionRecord[];
  /** 错误信息（如果失败） */
  error?: string;
}

/**
 * 状态转移记录
 */
export interface TransitionRecord {
  /** 源状态 */
  fromState: string;
  /** 目标状态 */
  toState: string;
  /** 转移时间戳（毫秒） */
  timestamp: number;
  /** 转移耗时（毫秒） */
  duration: number;
  /** 是否被跳过（降级） */
  skipped: boolean;
  /** 跳过原因 */
  skipReason?: string;
}

/**
 * 执行摘要 - 用于查询和监控
 * 需求 8.4: 包含总耗时、节点数、降级标志和最终状态
 * 需求 8.5: 支持按 requestId 或 executionId 查询
 */
export interface ExecutionSummary {
  /** 执行唯一标识 */
  executionId: string;
  /** 请求唯一标识 */
  requestId: string;
  /** 使用的状态定义 ID */
  definitionId: string;
  /** 开始时间（毫秒时间戳） */
  startTime: number;
  /** 结束时间（毫秒时间戳） */
  endTime: number;
  /** 总耗时（毫秒） */
  totalDuration: number;
  /** 经过的节点数 */
  nodesVisited: number;
  /** 是否触发降级 */
  degraded: boolean;
  /** 最终状态 */
  finalState: string;
  /** 是否成功 */
  success: boolean;
  /** 完整状态转移路径 */
  transitionPath: TransitionRecord[];
}

// ============================================================
// 事件
// ============================================================

/**
 * 状态转移事件 - 每次状态转移时发出
 * 需求 1.6: 事件包含源状态、目标状态、转移耗时和上下文快照
 */
export interface StateTransitionEvent {
  /** 执行唯一标识 */
  executionId: string;
  /** 请求唯一标识 */
  requestId: string;
  /** 源状态 */
  fromState: string;
  /** 目标状态 */
  toState: string;
  /** 转移耗时（毫秒） */
  duration: number;
  /** 转移时间戳（毫秒） */
  timestamp: number;
  /** 转移时的上下文快照（仅包含 metadata，不含完整 data） */
  contextSnapshot: {
    currentState: string;
    metadata: Record<string, unknown>;
    dataKeys: string[];
  };
}
