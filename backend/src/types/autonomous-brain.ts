/**
 * 自主大脑 (Autonomous Brain) 类型定义
 * 定义大脑的内部状态、上下文输入和执行记录结构
 */

import { AlertEvent } from './ai-ops';

/**
 * 接口状态简报
 * 包含基础的网络接口统计，供大脑参考
 */
export interface InterfaceBrief {
  name: string;
  status: 'up' | 'down';
  rxBytes: number;
  txBytes: number;
  errors: number;
}

/**
 * 系统健康摘要 (供 Brain 感知)
 */
export interface SystemHealthSummary {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  uptime: number | string;
  interfaces: InterfaceBrief[];
  /** 接口状态统计 (up/total) */
  interfaceStats?: { up: number; total: number };
  /** 总体健康分数 (0-100) */
  score: number;
  /** 健康等级 */
  level: 'healthy' | 'warning' | 'critical' | 'unknown';
  /** 识别出的健康问题摘要 */
  issues?: string[];
  /** 分维度评分 */
  dimensions?: {
    system: number;
    network: number;
    performance: number;
    reliability: number;
  };
  /** 快照时间戳 */
  timestamp?: number;
}

/**
 * 设备摘要（供 Brain 感知多设备环境）
 */
export interface DeviceSummary {
  id: string;
  name: string;
  host: string;
  /** DeviceManager 中记录的状态（online/offline/error/connecting） */
  status: string;
  /** 设备所属租户 ID，永不为 undefined（gatherContext 中已补全） */
  tenantId: string;
  /**
   * 本次 tick 的连通性探测结果（tick 级别快照）
   * true  = DevicePool 连接可用，LLM 可以调用 execute_intent
   * false = 连接不可用，LLM 应改用 send_notification
   */
  reachable: boolean;
  /** 不可达时的原因，供 LLM 参考 */
  unreachableReason?: string;
}

/**
 * 大脑心跳收集的全局上下文 (State Context)
 * 每次 Tick 时，大脑会接收这一份完整报告
 */
export interface BrainTickContext {
  tickId: string;
  timestamp: number;
  trigger: 'schedule' | 'critical_alert' | 'decision_pending' | 'manual';

  // 多设备感知
  managedDevices: DeviceSummary[];   // 所有受管设备列表
  targetDeviceId?: string;           // 当前操作的目标设备（预留：未来 Brain 可在 OODA 循环中锁定目标设备）

  // 系统全景
  systemHealth: SystemHealthSummary;

  // 活跃事件
  activeAlerts: AlertEvent[];

  // 待处理的严重工单 / 决策
  pendingDecisions: {
    decisionId: string;
    alertId: string;
    action: string;
    reasoning: string;
  }[];

  // P2: Orient 深度认知数据
  anomalyPredictions: {
    type: string;
    confidence: number;
    predictedValue: number;
    threshold: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    suggestedActions: string[];
  }[];

  topologySummary: string;  // 知识图谱拓扑简报
  topologyFreshnessMs: number; // P2: 拓扑数据鲜活度（毫秒）

  detectedPatterns: {
    id: string;
    type: string;
    sequence: string[];
    frequency: number;
    confidence: number;
  }[];

  // 进化子模块近期的反馈
  recentEvolutionEvents: {
    source: 'Reflector' | 'PatternLearner' | 'Healer';
    event: string;
    status: string;
    timestamp: number;
  }[];

  // P2 FIX: 感知源健康度摘要 — 让大脑知道数据是否可信
  perceptionSummary?: string;

  // 感知源健康状态列表
  perceptionHealth?: {
    source: string;
    ok: boolean;
    error?: string;
    durationMs?: number;
    degraded?: boolean;
  }[];
}

/**
 * 大脑动作执行记录 (Audit/Memory)
 */
export interface BrainActionRecord {
  id: string;
  tickId: string;
  timestamp: number;
  toolSet: 'device' | 'orchestration' | 'knowledge' | 'communication';
  actionName: string;
  parameters: Record<string, unknown>;

  // 人工审批状态（如需）
  requiresApproval: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'auto_approved';

  // 执行结果
  executedAt?: number;
  success?: boolean;
  result?: string;
  error?: string;
}

/**
 * P1: 情景记忆（双轨记忆模型 — 短期层）
 * 师傅教导：绝不能让反思结果直接修改底层 Prompt
 * 必须先放进短期记忆，经过夜间巩固后才固化到长期知识库
 */
export interface EpisodicMemory {
  id: string;
  content: string;            // 反思/学习内容
  context: string;            // 触发场景描述
  source: 'healer' | 'reflector' | 'brain_tick';
  createdAt: number;
  lastVerifiedAt: number;     // 最后验证时间
  verificationCount: number;  // 被验证次数（频次够高 → 可信）
  decayWeight: number;        // 0.0~1.0，随时间衰减
  promoted: boolean;          // 是否已固化到长期知识库
  matchKey?: string;          // 🔴 FIX 1.3: 结构化匹配键，用于精确匹配相似记忆
}

/**
 * 大脑双轨记忆 (Dual-Track Memory)
 * 包含短期工作记忆 + 情景记忆
 */
export interface BrainMemory {
  lastTickTime: number;
  ongoingInvestigations: string[]; // 正在追踪的 Alert ID 或系统异常
  notes: string[];                // 大脑留给下一次 tick 的便签
  episodicMemory: EpisodicMemory[]; // P1: 短期情景记忆
}

/**
 * 分析报告条目
 */
export interface AnalysisEntry {
  id: string;
  alertId: string;
  timestamp: number;
  rootCauses: {
    id: string;
    description: string;
    confidence: number;
    evidence: string[];
    relatedAlerts: string[];
  }[];
  timeline: {
    events: { timestamp: number; eventId: string; description: string; type: string }[];
    startTime: number;
    endTime: number;
  };
  impact: {
    scope: string;
    affectedResources: string[];
    estimatedUsers: number;
    services: string[];
    networkSegments: string[];
  };
}

/**
 * 分析报告摘要
 */
export interface AnalysisReportSummary {
  success: boolean;
  reportCount: number;
  parseErrors: number;
  warning?: string;
  dateRange: { start: string; end: string };
  reports?: AnalysisEntry[];
  summary?: {
    totalAlerts: number;
    topRootCauses: { description: string; count: number }[];
    impactDistribution: Record<string, number>;
  };
}

/**
 * 状态差异对比结果
 */
export interface StateDiff {
  success: boolean;
  changes: {
    field: string;
    before: unknown;
    after: unknown;
    direction: 'increased' | 'decreased' | 'changed';
    magnitude?: number;
  }[];
  summary: string;
}

/**
 * 状态对比参数
 */
export interface CompareStateParams {
  before: unknown;
  after: unknown;
}

/**
 * 操作后验证配置
 */
export interface VerificationConfig {
  enabled?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  timeoutMs?: number;
}
