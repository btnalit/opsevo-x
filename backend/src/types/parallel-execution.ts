/**
 * ReAct 并行执行类型定义
 * 
 * 定义并行工具调用、执行计划、依赖分析等相关类型
 * 
 * Requirements: 1.1, 1.2, 3.1, 3.4, 5.1
 */

// ==================== 可取消超时类型 ====================

/**
 * 可取消的超时对象
 * 用于解决超时 Promise 内存泄漏问题
 * Requirements: 1.3, 1.4 (react-parallel-bugfix)
 * 
 * @template T 超时 Promise 的返回类型（通常为 never）
 */
export interface CancellableTimeout<T = never> {
  /** 超时 Promise */
  promise: Promise<T>;
  /** 取消函数，调用后清除 setTimeout，防止内存泄漏 */
  cancel: () => void;
}

/**
 * 回退状态跟踪
 * 用于追踪执行模式回退的完整历史
 * Requirements: 3.6, 3.7 (react-parallel-bugfix)
 */
export interface FallbackState {
  /** 原始选择的模式 */
  originalMode: ExecutionMode;
  /** 当前模式 */
  currentMode: ExecutionMode;
  /** 回退次数 */
  fallbackCount: number;
  /** 回退历史 */
  fallbackHistory: Array<{
    fromMode: ExecutionMode;
    toMode: ExecutionMode;
    reason: string;
    timestamp: number;
  }>;
  /** 部分结果（如果有） */
  partialResults?: MergedObservation[];
}

/**
 * 扩展的 ReAct 循环结果（包含回退信息）
 * Requirements: 3.7 (react-parallel-bugfix)
 */
export interface FallbackInfo {
  /** 是否发生了回退 */
  didFallback: boolean;
  /** 原始模式 */
  originalMode: ExecutionMode;
  /** 最终使用的模式 */
  finalMode: ExecutionMode;
  /** 回退次数 */
  fallbackCount: number;
  /** 回退历史 */
  fallbackHistory: Array<{
    fromMode: ExecutionMode;
    toMode: ExecutionMode;
    reason: string;
  }>;
}

// ==================== 执行模式枚举 ====================

/**
 * 执行模式
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
export enum ExecutionMode {
  /** 串行模式：传统 ReAct，每次一个工具调用 */
  SEQUENTIAL = 'sequential',
  /** 并行模式：批量并发执行独立的工具调用 */
  PARALLEL = 'parallel',
  /** 计划模式：先生成执行计划 DAG，再按阶段执行 */
  PLANNED = 'planned',
}

/**
 * 依赖类型
 * Requirements: 3.1, 3.2
 */
export enum DependencyType {
  /** 数据依赖：一个工具的输出是另一个工具的输入 */
  DATA = 'data',
  /** 资源依赖：访问同一资源（如同一设备） */
  RESOURCE = 'resource',
  /** 顺序依赖：必须按特定顺序执行 */
  ORDER = 'order',
}

/**
 * 依赖强度
 * Requirements: 3.4
 */
export enum DependencyStrength {
  /** 硬依赖：必须串行执行 */
  HARD = 'hard',
  /** 软依赖：可以并行但需注意 */
  SOFT = 'soft',
}

// ==================== 工具调用类型 ====================

/**
 * 单个工具调用
 * Requirements: 1.1
 */
export interface ToolCall {
  /** 调用唯一标识 */
  callId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 依赖的其他调用 ID 列表 */
  dependsOn: string[];
}

/**
 * 工具调用批次
 * Requirements: 1.1
 */
export interface ToolCallBatch {
  /** 批次唯一标识 */
  batchId: string;
  /** 工具调用列表 */
  calls: ToolCall[];
  /** 依赖关系图 */
  dependencies: DependencyGraph;
  /** 执行优先级（数字越小优先级越高） */
  priority: number;
}

/**
 * 单个工具调用结果
 * Requirements: 1.2, 1.3
 */
export interface ToolCallResult {
  /** 调用 ID */
  callId: string;
  /** 工具名称 */
  toolName: string;
  /** 是否成功 */
  success: boolean;
  /** 输出结果 */
  output: unknown;
  /** 错误信息（失败时） */
  error?: string;
  /** 执行耗时（毫秒） */
  duration: number;
  /** 重试次数 */
  retryCount: number;
  /** 是否被拦截器处理 */
  intercepted?: boolean;
}

/**
 * 合并的观察结果
 * Requirements: 1.2
 */
export interface MergedObservation {
  /** 批次 ID */
  batchId: string;
  /** 各工具调用结果 */
  results: ToolCallResult[];
  /** 成功数量 */
  successCount: number;
  /** 失败数量 */
  failureCount: number;
  /** 总执行时间（毫秒） */
  totalDuration: number;
  /** 实际并行度 */
  parallelism: number;
  /** 格式化后的文本（供 LLM 使用） */
  formattedText?: string;
}

// ==================== 依赖分析类型 ====================

/**
 * 依赖关系
 * Requirements: 3.1, 3.2, 3.4
 */
export interface Dependency {
  /** 源工具调用 ID */
  from: string;
  /** 目标工具调用 ID */
  to: string;
  /** 依赖类型 */
  type: DependencyType;
  /** 依赖强度 */
  strength: DependencyStrength;
  /** 依赖原因描述 */
  reason: string;
}

/**
 * 依赖图
 * Requirements: 3.1, 3.6
 */
export interface DependencyGraph {
  /** 节点列表（工具调用 ID） */
  nodes: string[];
  /** 边列表（依赖关系） */
  edges: Dependency[];
  /** 是否存在环 */
  hasCycle: boolean;
  /** 拓扑排序结果（每个数组是可并行执行的一组） */
  topologicalOrder: string[][];
}

/**
 * 自定义依赖规则
 * Requirements: 3.5
 */
export interface DependencyRule {
  /** 规则名称 */
  name: string;
  /** 源工具匹配模式 */
  sourceToolPattern: string | RegExp;
  /** 目标工具匹配模式 */
  targetToolPattern: string | RegExp;
  /** 依赖类型 */
  dependencyType: DependencyType;
  /** 依赖强度 */
  strength: DependencyStrength;
  /** 条件函数（可选） */
  condition?: (source: ToolCall, target: ToolCall) => boolean;
}

// ==================== 执行计划类型 ====================

/**
 * 计划中的工具调用
 * Requirements: 2.1, 2.2
 */
export interface PlannedToolCall {
  /** 工具名称 */
  toolName: string;
  /** 参数模板（可能包含占位符） */
  paramsTemplate: Record<string, unknown>;
  /** 目的描述 */
  purpose: string;
  /** 是否可选 */
  optional: boolean;
}

/**
 * 执行阶段
 * Requirements: 2.2, 2.3
 */
export interface ExecutionStage {
  /** 阶段 ID */
  stageId: string;
  /** 阶段序号 */
  order: number;
  /** 该阶段的工具调用 */
  toolCalls: PlannedToolCall[];
  /** 依赖的前置阶段 ID 列表 */
  dependsOnStages: string[];
}

/**
 * 执行计划
 * Requirements: 2.1, 2.2, 2.3
 */
export interface ExecutionPlan {
  /** 计划 ID */
  planId: string;
  /** 执行阶段列表（按依赖顺序） */
  stages: ExecutionStage[];
  /** 预估总工具调用数 */
  estimatedToolCalls: number;
  /** 预估执行时间（毫秒） */
  estimatedDuration: number;
  /** 最大并行度 */
  maxParallelism: number;
  /** 创建时间 */
  createdAt: number;
}

// ==================== 模式选择类型 ====================

/**
 * 模式选择结果
 * Requirements: 4.1
 */
export interface ModeSelectionResult {
  /** 选择的模式 */
  mode: ExecutionMode;
  /** 置信度 (0-1) */
  confidence: number;
  /** 选择原因 */
  reason: string;
  /** 预估工具调用数 */
  estimatedToolCalls: number;
  /** 预估并行度 */
  estimatedParallelism: number;
}

/**
 * 复杂度分析结果
 * Requirements: 4.2, 4.3, 4.4
 */
export interface ComplexityAnalysis {
  /** 复杂度级别 */
  complexity: 'simple' | 'moderate' | 'complex';
  /** 预估工具调用数 */
  estimatedToolCalls: number;
  /** 检测到的关键词 */
  keywords: string[];
  /** 分析耗时（毫秒） */
  analysisTime: number;
}

// ==================== 并发控制类型 ====================

/**
 * 并发限制配置
 * Requirements: 5.1, 5.3, 5.4
 */
export interface ConcurrencyConfig {
  /** 全局最大并发数 */
  globalMax: number;
  /** 按工具类型的并发限制 */
  perToolLimits: Map<string, number>;
  /** 按设备的并发限制 */
  perDeviceLimits: Map<string, number>;
  /** 队列超时时间（毫秒） */
  queueTimeout: number;
}

/**
 * 并发槽位
 * Requirements: 5.1, 5.2
 */
export interface ConcurrencySlot {
  /** 槽位 ID */
  slotId: string;
  /** 工具名称 */
  toolName: string;
  /** 设备 ID（如果适用） */
  deviceId?: string;
  /** 获取时间戳 */
  acquiredAt: number;
}

/**
 * 并发状态
 * Requirements: 5.5
 */
export interface ConcurrencyStatus {
  /** 当前活跃槽位数 */
  activeSlots: number;
  /** 队列深度 */
  queueDepth: number;
  /** 平均等待时间（毫秒） */
  avgWaitTime: number;
  /** 按工具类型的活跃数 */
  perToolActive: Map<string, number>;
  /** 按设备的活跃数 */
  perDeviceActive: Map<string, number>;
}

// ==================== 熔断器类型 ====================

/**
 * 熔断器状态
 * Requirements: 6.5
 */
export enum CircuitBreakerState {
  /** 关闭状态：正常执行 */
  CLOSED = 'closed',
  /** 打开状态：拒绝执行 */
  OPEN = 'open',
  /** 半开状态：尝试恢复 */
  HALF_OPEN = 'half_open',
}

/**
 * 熔断器配置
 * Requirements: 6.5
 */
export interface CircuitBreakerConfig {
  /** 失败阈值（触发熔断的连续失败次数） */
  failureThreshold: number;
  /** 恢复超时时间（毫秒） */
  recoveryTimeout: number;
  /** 半开状态的测试请求数 */
  halfOpenRequests: number;
}

/**
 * 工具熔断器状态
 * Requirements: 6.5
 */
export interface ToolCircuitBreakerState {
  /** 工具名称 */
  toolName: string;
  /** 当前状态 */
  state: CircuitBreakerState;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 上次失败时间 */
  lastFailureTime?: number;
  /** 上次成功时间 */
  lastSuccessTime?: number;
  /** 半开状态下的成功请求数 */
  halfOpenSuccesses: number;
}

// ==================== 并行执行器配置 ====================

/**
 * 并行执行器配置
 * Requirements: 1.1, 5.1, 6.5
 */
export interface ParallelExecutorConfig {
  /** 是否启用并行执行 */
  enabled: boolean;
  /** 最大并发工具调用数 */
  maxConcurrency: number;
  /** 单个工具调用超时（毫秒） */
  toolTimeout: number;
  /** 批次执行超时（毫秒） */
  batchTimeout: number;
  /** 失败重试次数 */
  retryCount: number;
  /** 是否启用熔断器 */
  enableCircuitBreaker: boolean;
}

/**
 * 完整的并行执行配置
 * Requirements: 8.5, 8.6
 */
export interface ParallelExecutionFullConfig {
  /** 执行器配置 */
  executor: ParallelExecutorConfig;
  /** 并发限制配置 */
  concurrency: ConcurrencyConfig;
  /** 熔断器配置 */
  circuitBreaker: CircuitBreakerConfig;
  /** 模式选择配置 */
  modeSelection: {
    /** 简单查询阈值（预估工具调用数） */
    simpleThreshold: number;
    /** 复杂查询阈值 */
    complexThreshold: number;
    /** 是否启用自动模式选择 */
    autoSelect: boolean;
  };
  /** 计划生成配置 */
  planning: {
    /** 是否启用 */
    enabled: boolean;
    /** 超时时间（毫秒） */
    timeout: number;
    /** 最大阶段数 */
    maxStages: number;
  };
  /** 渐进式发布配置 */
  rollout: {
    /** 发布百分比 (0-100) */
    percentage: number;
  };
}

// ==================== 执行状态类型 ====================

/**
 * 并行执行状态
 * Requirements: 7.1
 */
export interface ParallelExecutionState {
  /** 执行 ID */
  executionId: string;
  /** 当前模式 */
  mode: ExecutionMode;
  /** 执行计划（计划模式下） */
  plan?: ExecutionPlan;
  /** 已完成的批次 */
  completedBatches: MergedObservation[];
  /** 当前批次 */
  currentBatch?: ToolCallBatch;
  /** 总工具调用数 */
  totalToolCalls: number;
  /** 成功调用数 */
  successfulCalls: number;
  /** 失败调用数 */
  failedCalls: number;
  /** 开始时间 */
  startTime: number;
  /** 当前阶段 */
  currentStage: number;
  /** 总阶段数 */
  totalStages: number;
}

/**
 * 并行执行指标
 * Requirements: 7.1, 7.2, 7.6
 */
export interface ParallelExecutionMetrics {
  /** 执行 ID */
  executionId: string;
  /** 使用的模式 */
  mode: ExecutionMode;
  /** 总工具调用数 */
  toolCallCount: number;
  /** 并行批次数 */
  batchCount: number;
  /** 总执行时间（毫秒） */
  totalDuration: number;
  /** 串行执行的理论时间（毫秒） */
  theoreticalSequentialDuration: number;
  /** 实际加速比 */
  speedupRatio: number;
  /** 平均并行度 */
  avgParallelism: number;
  /** 失败率 */
  failureRate: number;
  /** 重试次数 */
  retryCount: number;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 模式选择准确性追踪
 * Requirements: 7.3
 */
export interface ModeSelectionAccuracy {
  /** 预测的工具调用数 */
  predictedToolCalls: number;
  /** 实际工具调用数 */
  actualToolCalls: number;
  /** 预测的模式 */
  predictedMode: ExecutionMode;
  /** 是否准确 */
  accurate: boolean;
  /** 时间戳 */
  timestamp: number;
}

// ==================== 错误类型 ====================

/**
 * 并行执行错误类型
 * Requirements: 6.1, 6.2, 6.3, 6.6
 */
export enum ParallelExecutionErrorType {
  /** 工具调用解析错误 */
  PARSE_ERROR = 'parse_error',
  /** 单个工具执行失败 */
  TOOL_EXECUTION_ERROR = 'tool_execution_error',
  /** 批次执行超时 */
  BATCH_TIMEOUT = 'batch_timeout',
  /** 并发限制超时 */
  CONCURRENCY_TIMEOUT = 'concurrency_timeout',
  /** 熔断器打开 */
  CIRCUIT_BREAKER_OPEN = 'circuit_breaker_open',
  /** 计划生成失败 */
  PLANNING_ERROR = 'planning_error',
  /** 依赖分析错误 */
  DEPENDENCY_ERROR = 'dependency_error',
  /** 级联失败 */
  CASCADE_FAILURE = 'cascade_failure',
  /** 不可恢复错误 */
  UNRECOVERABLE_ERROR = 'unrecoverable_error',
}

/**
 * 并行执行错误
 * Requirements: 6.1, 6.6
 */
export class ParallelExecutionError extends Error {
  constructor(
    public type: ParallelExecutionErrorType,
    message: string,
    public details?: Record<string, unknown>,
    public recoverable: boolean = true
  ) {
    super(message);
    this.name = 'ParallelExecutionError';
  }
}

// ==================== 默认配置 ====================

/**
 * 默认并行执行配置
 * Requirements: 8.5, 8.6
 */
export const DEFAULT_PARALLEL_CONFIG: ParallelExecutionFullConfig = {
  executor: {
    enabled: false, // 默认禁用，需要显式启用
    maxConcurrency: 5,
    toolTimeout: 30000,
    batchTimeout: 60000,
    retryCount: 1,
    enableCircuitBreaker: true,
  },
  concurrency: {
    globalMax: 8,
    perToolLimits: new Map([
      ['device_query', 4],
      ['execute_command', 4],
    ]),
    perDeviceLimits: new Map(),
    queueTimeout: 30000,
  },
  circuitBreaker: {
    failureThreshold: 3,
    recoveryTimeout: 30000,
    halfOpenRequests: 1,
  },
  modeSelection: {
    simpleThreshold: 2,
    complexThreshold: 4,
    autoSelect: true,
  },
  planning: {
    enabled: true,
    timeout: 1000,
    maxStages: 5,
  },
  rollout: {
    percentage: 0, // 默认 0%，需要显式配置
  },
};

/**
 * 创建默认并发配置（用于序列化场景）
 */
export function createDefaultConcurrencyConfig(): ConcurrencyConfig {
  return {
    globalMax: 8,
    perToolLimits: new Map([
      ['device_query', 4],
      ['execute_command', 4],
    ]),
    perDeviceLimits: new Map(),
    queueTimeout: 30000,
  };
}
