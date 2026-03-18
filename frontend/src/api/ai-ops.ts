/**
 * AI-Ops 智能运维 API 客户端
 * 前端 AI-Ops 服务 API 客户端，实现与后端 AI-Ops 服务的通信
 *
 * 功能：
 * - 指标采集管理
 * - 告警规则和事件管理
 * - 调度器任务管理
 * - 配置快照管理
 * - 健康报告管理
 * - 故障模式管理
 * - 通知渠道管理
 * - 审计日志查询
 * - 运维仪表盘数据
 *
 * Requirements: 1.1-10.6
 */

import { useAuthStore, onTokenRefreshed } from '@/stores/auth'
import { useDeviceStore } from '@/stores/device'
import api from './index'

// ==================== 类型定义 ====================

/**
 * 告警运算符
 */
export type AlertOperator = 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte'

/**
 * 告警严重级别
 */
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'emergency'

/**
 * 指标类型
 * 注意：'syslog' 是特殊类型，用于标识来自 syslog 的事件，不是真正的指标
 */
export type MetricType = 'cpu' | 'memory' | 'disk' | 'interface_status' | 'interface_traffic' | 'syslog'

/**
 * 通知渠道类型
 */
export type ChannelType = 'web_push' | 'webhook' | 'email'

/**
 * 审计操作类型
 */
export type AuditAction =
  | 'script_execute'
  | 'config_change'
  | 'alert_trigger'
  | 'alert_resolve'
  | 'remediation_execute'
  | 'config_restore'
  | 'snapshot_create'

/**
 * 智能进化系统负载信息
 */
export interface EvolutionSystemLoad {
  currentDegradationLevel: 'none' | 'moderate' | 'severe'
  primaryBottleneck: string
}

/**
 * 智能进化状态响应
 */
export interface EvolutionStatusResponse {
  capabilities: Record<string, boolean>
  systemLoad: EvolutionSystemLoad | null
}

/**
 * 指标数据点
 */
export interface MetricPoint {
  timestamp: number
  value: number
  labels?: Record<string, string>
}

/**
 * 流量速率数据点
 */
export interface TrafficRatePoint {
  timestamp: number
  rxRate: number // bytes per second
  txRate: number // bytes per second
}

/**
 * 流量采集状态
 */
export interface TrafficCollectionStatus {
  isRunning: boolean
  isRouterConnected: boolean
  interfaceCount: number
  hasData: boolean
  lastCollectionTime: number | null
  consecutiveErrors: number
}

/**
 * 系统指标
 */
export interface SystemMetrics {
  cpu: { usage: number }
  memory: { total: number; used: number; free: number; usage: number }
  disk: { total: number; used: number; free: number; usage: number }
  uptime: number
}

/**
 * 接口指标
 */
export interface InterfaceMetrics {
  name: string
  status: 'up' | 'down'
  rxBytes: number
  txBytes: number
  rxPackets: number
  txPackets: number
  rxErrors: number
  txErrors: number
}

/**
 * 指标采集配置
 */
export interface MetricsCollectorConfig {
  intervalMs: number
  retentionDays: number
  enabled: boolean
}

/**
 * 接口状态目标值
 */
export type InterfaceStatusTarget = 'up' | 'down';

/**
 * 告警规则
 */
export interface AlertRule {
  id: string
  tenantId?: string
  deviceId?: string
  name: string
  enabled: boolean
  metric: MetricType
  metricLabel?: string
  operator: AlertOperator
  threshold: number
  targetStatus?: InterfaceStatusTarget  // 接口状态目标值（仅用于 interface_status 类型）
  duration: number
  cooldownMs: number
  severity: AlertSeverity
  channels: string[]
  autoResponse?: {
    enabled: boolean
    script: string
  }
  createdAt: number
  updatedAt: number
  lastTriggeredAt?: number
}

/**
 * 创建告警规则输入
 */
export type CreateAlertRuleInput = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>

/**
 * 更新告警规则输入
 */
export type UpdateAlertRuleInput = Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>

/**
 * 告警事件来源类型
 * Requirements: syslog-alert-integration 1.3, 2.1
 */
export type AlertEventSource = 'metrics' | 'syslog'

/**
 * Syslog 元数据
 * Requirements: syslog-alert-integration 1.4, 2.3
 */
export interface SyslogMetadata {
  hostname: string
  facility: number
  syslogSeverity: number
  category: string
  rawMessage: string
}

/**
 * 告警事件
 * Requirements: 8.1 - AlertEvent 接口包含 metricLabel 字段以支持接口级别的告警
 * Requirements: syslog-alert-integration 1.3, 1.4 - 支持 source 和 syslogData 字段
 */
export interface AlertEvent {
  id: string
  ruleId: string
  ruleName: string
  severity: AlertSeverity
  metric: MetricType
  metricLabel?: string  // 指标标签（如接口名称），用于接口级别的告警
  currentValue: number
  threshold: number
  message: string
  aiAnalysis?: string
  status: 'active' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed'
  triggeredAt: number
  resolvedAt?: number
  autoResponseResult?: {
    executed: boolean
    success: boolean
    output?: string
    error?: string
  }
  // Syslog 集成字段 (Requirements: syslog-alert-integration 1.3, 1.4)
  source?: AlertEventSource      // 事件来源，默认 'metrics'
  syslogData?: SyslogMetadata    // Syslog 元数据（仅 syslog 来源有值）
  deviceName?: string            // 设备名称 (Requirements: 8.1 - 增强告警上下文)
  deviceIp?: string              // 设备 IP (Requirements: 8.1 - 增强告警上下文)
  notifyChannels?: string[]      // 通知渠道 ID 列表 (System Association)
  autoResponseConfig?: {         // 自动响应配置 (System Association)
    enabled: boolean
    script: string
  }
}

/**
 * 分页告警事件响应
 * Requirements: 4.1, 4.2, 4.3
 */
export interface PaginatedAlertEvents {
  items: AlertEvent[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * 统一事件类型（合并 AlertEvent 和 SyslogEvent）
 */
export interface UnifiedEvent {
  id: string
  tenantId?: string
  deviceId?: string
  type: 'alert' | 'syslog'
  severity: AlertSeverity
  message: string
  timestamp: number
  status: 'active' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed'
  category?: string
  ruleName?: string
  ruleId?: string
  metric?: MetricType
  metricLabel?: string
  currentValue?: number
  threshold?: number
  resolvedAt?: number
  rawData?: unknown
  metadata?: {
    hostname?: string
    facility?: number
    syslogSeverity?: number
  }
  aiAnalysis?: string
  autoResponseResult?: {
    executed: boolean
    success: boolean
    output?: string
    error?: string
  }
  deviceName?: string
  deviceIp?: string
  notifyChannels?: string[]      // 通知渠道 ID 列表 (System Association)
  autoResponseConfig?: {         // 自动响应配置 (System Association)
    enabled: boolean
    script: string
  }
}

/**
 * 分页统一事件响应
 */
export interface PaginatedUnifiedEvents {
  items: UnifiedEvent[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * 定时任务类型
 */
export type ScheduledTaskType = 'inspection' | 'backup' | 'custom'

/**
 * 定时任务
 */
export interface ScheduledTask {
  id: string
  tenantId?: string
  deviceId?: string
  name: string
  type: ScheduledTaskType
  cron: string
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  config?: Record<string, unknown>
  createdAt: number
}

/**
 * 创建定时任务输入
 */
export type CreateScheduledTaskInput = Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'>

/**
 * 更新定时任务输入
 */
export type UpdateScheduledTaskInput = Partial<Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'>>

/**
 * 任务执行状态
 */
export type TaskExecutionStatus = 'running' | 'success' | 'failed'

/**
 * 任务执行记录
 */
export interface TaskExecution {
  id: string
  taskId: string
  taskName: string
  type: string
  status: TaskExecutionStatus
  startedAt: number
  completedAt?: number
  result?: unknown
  error?: string
}

/**
 * 快照触发方式
 */
export type SnapshotTrigger = 'auto' | 'manual' | 'pre-remediation'

/**
 * 配置快照
 */
export interface ConfigSnapshot {
  id: string
  timestamp: number
  trigger: SnapshotTrigger
  size: number
  checksum: string
  metadata?: {
    routerVersion?: string
    routerModel?: string
  }
}

/**
 * 风险级别
 */
export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * 快照差异
 */
export interface SnapshotDiff {
  snapshotA: string
  snapshotB: string
  additions: string[]
  modifications: Array<{ path: string; oldValue: string; newValue: string }>
  deletions: string[]
  aiAnalysis?: {
    riskLevel: RiskLevel
    summary: string
    recommendations: string[]
  }
}

/**
 * 健康状态
 */
export type HealthStatus = 'healthy' | 'warning' | 'critical'

/**
 * 健康报告
 */
export interface HealthReport {
  id: string
  tenantId?: string
  deviceId?: string
  generatedAt: number
  period: { from: number; to: number }
  summary: {
    overallHealth: HealthStatus
    score: number
  }
  metrics: {
    cpu: { avg: number; max: number; min: number }
    memory: { avg: number; max: number; min: number }
    disk: { avg: number; max: number; min: number }
  }
  interfaces: Array<{
    name: string
    avgRxRate: number
    avgTxRate: number
    downtime: number
  }>
  alerts: {
    total: number
    bySeverity: Record<AlertSeverity, number>
    topRules: Array<{ ruleName: string; count: number }>
  }
  configChanges: number
  aiAnalysis: {
    risks: string[]
    recommendations: string[]
    trends: string[]
  }
}

/**
 * 故障模式条件
 */
export interface FaultCondition {
  metric: MetricType
  metricLabel?: string
  operator: AlertOperator
  threshold: number
}

/**
 * 故障模式
 */
export interface FaultPattern {
  id: string
  tenantId?: string
  deviceId?: string
  name: string
  description: string
  enabled: boolean
  autoHeal: boolean
  builtin: boolean
  conditions: FaultCondition[]
  conditionLogic?: 'AND' | 'OR'
  remediationScript: string
  rollbackScript?: string
  verificationScript?: string
  createdAt: number
  updatedAt: number
}

/**
 * 创建故障模式输入
 */
export type CreateFaultPatternInput = Omit<FaultPattern, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>

/**
 * 更新故障模式输入
 */
export type UpdateFaultPatternInput = Partial<Omit<FaultPattern, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>>

/**
 * 修复执行状态
 */
export type RemediationStatus = 'pending' | 'executing' | 'success' | 'failed' | 'skipped' | 'rolled_back'

/**
 * 回滚结果
 */
export interface RollbackResult {
  success: boolean
  output?: string
  error?: string
  duration: number
}

/**
 * 修复执行记录
 */
export interface RemediationExecution {
  id: string
  patternId: string
  patternName: string
  alertEventId: string
  status: RemediationStatus
  preSnapshotId?: string
  aiConfirmation?: {
    confirmed: boolean
    confidence: number
    reasoning: string
  }
  executionResult?: {
    output: string
    error?: string
  }
  verificationResult?: {
    passed: boolean
    message: string
  }
  rollbackResult?: RollbackResult
  retryCount?: number
  startedAt: number
  completedAt?: number
}

/**
 * Web Push 配置
 */
export interface WebPushConfig {
  // Web Push 使用浏览器原生 API，无需额外配置
}

/**
 * Webhook 配置
 */
export interface WebhookConfig {
  url: string
  method: 'POST' | 'PUT'
  headers?: Record<string, string>
  bodyTemplate?: string
}

/**
 * 邮件配置
 */
export interface EmailConfig {
  smtp: {
    host: string
    port: number
    secure: boolean
    auth: { user: string; pass: string }
  }
  from: string
  to: string[]
}

/**
 * 通知渠道配置联合类型
 */
export type NotificationChannelConfig = WebPushConfig | WebhookConfig | EmailConfig

/**
 * 通知渠道
 */
export interface NotificationChannel {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  config: NotificationChannelConfig
  severityFilter?: AlertSeverity[]
  createdAt: number
}

/**
 * 创建通知渠道输入
 */
export type CreateNotificationChannelInput = Omit<NotificationChannel, 'id' | 'createdAt'>

/**
 * 更新通知渠道输入
 */
export type UpdateNotificationChannelInput = Partial<Omit<NotificationChannel, 'id' | 'createdAt'>>

/**
 * 通知类型
 */
export type NotificationType = 'alert' | 'recovery' | 'report' | 'remediation'

/**
 * 通知状态
 */
export type NotificationStatus = 'pending' | 'sent' | 'failed'

/**
 * 通知
 */
export interface Notification {
  id: string
  channelId: string
  type: NotificationType
  title: string
  body: string
  data?: Record<string, unknown>
  status: NotificationStatus
  sentAt?: number
  error?: string
  retryCount: number
}

/**
 * 审计日志
 */
export interface AuditLog {
  id: string
  timestamp: number
  action: AuditAction
  actor: 'system' | 'user'
  details: {
    trigger?: string
    script?: string
    result?: string
    error?: string
    metadata?: Record<string, unknown>
    [key: string]: unknown
  }
}

/**
 * 仪表盘数据
 */
export interface DashboardData {
  metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] } | null
  alerts: {
    active: number
    critical: number
    warning: number
    info: number
    list: AlertEvent[]
  }
  remediations: {
    recent: number
    successful: number
    list: RemediationExecution[]
  }
  reports: {
    recent: number
    list: HealthReport[]
  }
  scheduler: {
    total: number
    enabled: number
  }
  timestamp: number
}

// ==================== API 响应类型 ====================

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// ==================== 指标 API ====================

export const metricsApi = {
  /**
   * 获取运维仪表盘数据
   * @param deviceId 设备 ID (可选)
   */
  getData: (deviceId?: string) =>
    api.get<ApiResponse<DashboardData>>('/ai-ops/dashboard', { params: { deviceId } }),

  /**
   * 获取最新指标
   * @param deviceId 设备 ID (可选)
   */
  getLatest(deviceId?: string) {
    return api.get<ApiResponse<{ system: SystemMetrics; interfaces: InterfaceMetrics[] }>>(
      '/ai-ops/metrics/latest',
      { params: { deviceId } }
    )
  },

  /**
   * 获取历史指标
   */
  getHistory(metric: string, from: number, to: number) {
    return api.get<ApiResponse<MetricPoint[]>>('/ai-ops/metrics/history', {
      params: { metric, from, to }
    })
  },

  /**
   * 获取流量历史
   * @param deviceId 设备 ID (可选)
   */
  getDeviceTrafficHistory: (deviceId?: string) =>
    api.get<ApiResponse<Record<string, TrafficRatePoint[]>>>('/ai-ops/metrics/traffic', {
      params: { deviceId }
    }),

  /**
   * 获取可用流量接口列表
   * @param deviceId 设备 ID (可选)
   */
  getTrafficInterfaces: (deviceId?: string) =>
    api.get<ApiResponse<string[]>>('/ai-ops/metrics/traffic/interfaces', {
      params: { deviceId }
    }),

  /**
   * 获取流量采集状态
   * @param deviceId 设备 ID (可选)
   */
  getTrafficCollectionStatus: (deviceId?: string) =>
    api.get<ApiResponse<TrafficCollectionStatus>>('/ai-ops/metrics/traffic/status', {
      params: { deviceId }
    }),

  /**
   * 获取采集配置
   */
  getConfig: () => api.get<ApiResponse<MetricsCollectorConfig>>('/ai-ops/metrics/config'),

  /**
   * 更新采集配置
   */
  updateConfig: (config: Partial<MetricsCollectorConfig>) =>
    api.put<ApiResponse<MetricsCollectorConfig>>('/ai-ops/metrics/config', config),

  /**
   * 立即采集指标
   */
  collectNow: () =>
    api.post<ApiResponse<{ system: SystemMetrics; interfaces: InterfaceMetrics[] }>>(
      '/ai-ops/metrics/collect'
    )
}

// ==================== 告警规则 API ====================

export const alertRulesApi = {
  /**
   * 获取告警规则列表
   */
  getAll: (deviceId?: string) => api.get<ApiResponse<AlertRule[]>>('/ai-ops/alerts/rules', { params: { deviceId } }),

  /**
   * 获取单个告警规则
   */
  getById: (id: string) => api.get<ApiResponse<AlertRule>>(`/ai-ops/alerts/rules/${id}`),

  /**
   * 创建告警规则
   */
  create: (rule: CreateAlertRuleInput) =>
    api.post<ApiResponse<AlertRule>>('/ai-ops/alerts/rules', rule),

  /**
   * 更新告警规则
   */
  update: (id: string, updates: UpdateAlertRuleInput) =>
    api.put<ApiResponse<AlertRule>>(`/ai-ops/alerts/rules/${id}`, updates),

  /**
   * 删除告警规则
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/alerts/rules/${id}`),

  /**
   * 启用告警规则
   */
  enable: (id: string) => api.post<ApiResponse<void>>(`/ai-ops/alerts/rules/${id}/enable`),

  /**
   * 禁用告警规则
   */
  disable: (id: string) => api.post<ApiResponse<void>>(`/ai-ops/alerts/rules/${id}/disable`)
}

// ==================== 告警事件 API ====================

export const alertEventsApi = {
  /**
   * 获取告警事件列表（支持分页和来源过滤）
   * Requirements: 4.1, 4.2, 4.3
   * Requirements: syslog-alert-integration 7.1, 7.2 - 支持 source 参数
   */
  getAll: (from: number, to: number, page?: number, pageSize?: number, source?: 'all' | 'metrics' | 'syslog', deviceId?: string) =>
    api.get<ApiResponse<AlertEvent[] | PaginatedAlertEvents>>('/ai-ops/alerts/events', {
      params: { from, to, page, pageSize, source, deviceId }
    }),

  /**
   * 获取分页告警事件列表
   * Requirements: 4.1, 4.2, 4.3
   * Requirements: syslog-alert-integration 7.1, 7.2 - 支持 source 参数
   */
  getPaginated: (from: number, to: number, page: number = 1, pageSize: number = 20, source?: 'all' | 'metrics' | 'syslog', deviceId?: string) =>
    api.get<ApiResponse<PaginatedAlertEvents>>('/ai-ops/alerts/events', {
      params: { from, to, page, pageSize, source, deviceId }
    }),

  /**
   * 获取活跃告警
   */
  getActive: (deviceId?: string) => api.get<ApiResponse<AlertEvent[]>>('/ai-ops/alerts/events/active', { params: { deviceId } }),

  /**
   * 获取合并事件（AlertEvent + SyslogEvent）
   * Requirements: syslog-alert-integration 7.1, 7.2
   * 注意：includeSyslog 参数现在用于过滤是否包含 syslog 来源的事件
   * source 参数用于按来源过滤：'metrics' | 'syslog' | undefined (全部)
   */
  getUnified: (from: number, to: number, page: number = 1, pageSize: number = 20, includeSyslog: boolean = true, source?: 'metrics' | 'syslog', deviceId?: string, severity?: string, status?: string) =>
    api.get<ApiResponse<PaginatedUnifiedEvents>>('/ai-ops/alerts/events/unified', {
      params: { from, to, page, pageSize, includeSyslog, source, deviceId, severity, status }
    }),

  /**
   * 获取活跃的合并事件（AlertEvent + SyslogEvent）
   * Requirements: syslog-alert-integration 7.1, 7.2
   * source 参数用于按来源过滤：'metrics' | 'syslog' | undefined (全部)
   */
  getActiveUnified: (includeSyslog: boolean = true, source?: 'metrics' | 'syslog', deviceId?: string) =>
    api.get<ApiResponse<UnifiedEvent[]>>('/ai-ops/alerts/events/unified/active', {
      params: { includeSyslog, source, deviceId }
    }),

  /**
   * 获取单个告警事件
   */
  getById: (id: string) => api.get<ApiResponse<AlertEvent>>(`/ai-ops/alerts/events/${id}`),

  /**
   * 解决告警
   */
  resolve: (id: string) => api.post<ApiResponse<void>>(`/ai-ops/alerts/events/${id}/resolve`),

  /**
   * 删除告警事件
   * Requirements: 4.5, 4.7
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/alerts/events/${id}`),

  /**
   * 批量删除告警事件
   * Requirements: 4.6, 4.7
   */
  batchDelete: (ids: string[]) =>
    api.post<ApiResponse<{ deleted: number; failed: number }>>('/ai-ops/alerts/events/batch-delete', { ids })
}

// ==================== 调度器 API ====================

export const schedulerApi = {
  /**
   * 获取任务列表
   */
  getTasks: (deviceId?: string) => api.get<ApiResponse<ScheduledTask[]>>('/ai-ops/scheduler/tasks', { params: { deviceId } }),

  /**
   * 获取单个任务
   */
  getTaskById: (id: string) => api.get<ApiResponse<ScheduledTask>>(`/ai-ops/scheduler/tasks/${id}`),

  /**
   * 创建任务
   */
  createTask: (task: CreateScheduledTaskInput) =>
    api.post<ApiResponse<ScheduledTask>>('/ai-ops/scheduler/tasks', task),

  /**
   * 更新任务
   */
  updateTask: (id: string, updates: UpdateScheduledTaskInput) =>
    api.put<ApiResponse<ScheduledTask>>(`/ai-ops/scheduler/tasks/${id}`, updates),

  /**
   * 删除任务
   */
  deleteTask: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/scheduler/tasks/${id}`),

  /**
   * 立即执行任务
   */
  runTaskNow: (id: string, deviceId?: string) =>
    api.post<ApiResponse<TaskExecution>>(`/ai-ops/scheduler/tasks/${id}/run`, null, { params: { deviceId } }),

  /**
   * 获取执行历史
   */
  getExecutions: (taskId?: string, limit?: number) =>
    api.get<ApiResponse<TaskExecution[]>>('/ai-ops/scheduler/executions', {
      params: { taskId, limit }
    })
}

// ==================== 配置快照 API ====================

export const snapshotsApi = {
  /**
   * 获取快照列表
   */
  getAll: (limit?: number, deviceId?: string) =>
    api.get<ApiResponse<ConfigSnapshot[]>>('/ai-ops/snapshots', {
      params: { limit, deviceId }
    }),

  /**
   * 获取单个快照
   */
  getById: (id: string) => api.get<ApiResponse<ConfigSnapshot>>(`/ai-ops/snapshots/${id}`),

  /**
   * 创建快照
   */
  create: (deviceId?: string, tenantId?: string) =>
    api.post<ApiResponse<ConfigSnapshot>>('/ai-ops/snapshots', { deviceId, tenantId }),

  /**
   * 删除快照
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/snapshots/${id}`),

  /**
   * 下载快照
   */
  download: async (id: string): Promise<Blob> => {
    const response = await api.get(`/ai-ops/snapshots/${id}/download`, {
      responseType: 'blob'
    })
    return response.data
  },

  /**
   * 恢复快照
   */
  restore: (id: string) =>
    api.post<ApiResponse<{ success: boolean; message: string }>>(`/ai-ops/snapshots/${id}/restore`),

  /**
   * 对比快照
   */
  compare: (idA: string, idB: string) =>
    api.get<ApiResponse<SnapshotDiff>>('/ai-ops/snapshots/diff', {
      params: { idA, idB }
    }),

  /**
   * 获取最新差异
   */
  getLatestDiff: () => api.get<ApiResponse<SnapshotDiff | null>>('/ai-ops/snapshots/diff/latest'),

  /**
   * 获取变更时间线
   */
  getTimeline: (limit?: number) =>
    api.get<ApiResponse<Array<{ snapshot: ConfigSnapshot; diff?: SnapshotDiff; dangerousChanges?: unknown }>>>('/ai-ops/snapshots/timeline', {
      params: limit ? { limit } : undefined
    })
}

// ==================== 健康报告 API ====================

export const reportsApi = {
  /**
   * 获取报告列表
   */
  getAll: (limit?: number, deviceId?: string) =>
    api.get<ApiResponse<HealthReport[]>>('/ai-ops/reports', {
      params: { limit, deviceId }
    }),

  /**
   * 获取单个报告
   */
  getById: (id: string) => api.get<ApiResponse<HealthReport>>(`/ai-ops/reports/${id}`),

  /**
   * 生成报告
   */
  generate: (from: number, to: number, channelIds?: string[], deviceId?: string) =>
    api.post<ApiResponse<HealthReport>>('/ai-ops/reports/generate', {
      from,
      to,
      channelIds,
      deviceId
    }),

  /**
   * 导出报告为 Markdown
   */
  exportMarkdown: async (id: string): Promise<Blob> => {
    const response = await api.get(`/ai-ops/reports/${id}/export`, {
      responseType: 'blob',
      params: { format: 'markdown' }
    })
    return response.data
  },

  /**
   * 导出报告为 PDF
   */
  exportPdf: async (id: string): Promise<Blob> => {
    const response = await api.get(`/ai-ops/reports/${id}/export`, {
      responseType: 'blob',
      params: { format: 'pdf' }
    })
    return response.data
  },

  /**
   * 删除报告
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/reports/${id}`)
}

// ==================== 故障模式 API ====================

export const faultPatternsApi = {
  /**
   * 获取故障模式列表
   */
  getAll: (deviceId?: string) => api.get<ApiResponse<FaultPattern[]>>('/ai-ops/patterns', { params: { deviceId } }),

  /**
   * 获取单个故障模式
   */
  getById: (id: string) => api.get<ApiResponse<FaultPattern>>(`/ai-ops/patterns/${id}`),

  /**
   * 创建故障模式
   */
  create: (pattern: CreateFaultPatternInput) =>
    api.post<ApiResponse<FaultPattern>>('/ai-ops/patterns', pattern),

  /**
   * 更新故障模式
   */
  update: (id: string, updates: UpdateFaultPatternInput) =>
    api.put<ApiResponse<FaultPattern>>(`/ai-ops/patterns/${id}`, updates),

  /**
   * 删除故障模式
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/patterns/${id}`),

  /**
   * 启用自动修复
   */
  enableAutoHeal: (id: string) =>
    api.post<ApiResponse<void>>(`/ai-ops/patterns/${id}/enable-auto-heal`),

  /**
   * 禁用自动修复
   */
  disableAutoHeal: (id: string) =>
    api.post<ApiResponse<void>>(`/ai-ops/patterns/${id}/disable-auto-heal`),

  /**
   * 手动执行修复
   */
  executeRemediation: (id: string, alertEventId: string) =>
    api.post<ApiResponse<RemediationExecution>>(`/ai-ops/patterns/${id}/execute`, {
      alertEventId
    })
}

// ==================== 修复记录 API ====================

export const remediationsApi = {
  /**
   * 获取修复历史
   */
  getAll: (limit?: number, deviceId?: string) =>
    api.get<ApiResponse<RemediationExecution[]>>('/ai-ops/remediations', {
      params: { limit, deviceId }
    }),

  /**
   * 获取单个修复记录
   */
  getById: (id: string) => api.get<ApiResponse<RemediationExecution>>(`/ai-ops/remediations/${id}`)
}

// ==================== 通知渠道 API ====================

export const notificationChannelsApi = {
  /**
   * 获取渠道列表
   */
  getAll: () => api.get<ApiResponse<NotificationChannel[]>>('/ai-ops/channels'),

  /**
   * 获取单个渠道
   */
  getById: (id: string) => api.get<ApiResponse<NotificationChannel>>(`/ai-ops/channels/${id}`),

  /**
   * 创建渠道
   */
  create: (channel: CreateNotificationChannelInput) =>
    api.post<ApiResponse<NotificationChannel>>('/ai-ops/channels', channel),

  /**
   * 更新渠道
   */
  update: (id: string, updates: UpdateNotificationChannelInput) =>
    api.put<ApiResponse<NotificationChannel>>(`/ai-ops/channels/${id}`, updates),

  /**
   * 删除渠道
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/channels/${id}`),

  /**
   * 测试渠道
   */
  test: (id: string) =>
    api.post<ApiResponse<{ success: boolean; message: string }>>(`/ai-ops/channels/${id}/test`),

  /**
   * 获取待推送通知
   */
  getPending: (id: string) =>
    api.get<ApiResponse<Notification[]>>(`/ai-ops/channels/${id}/pending`),

  /**
   * 获取通知历史
   */
  getHistory: (limit?: number) =>
    api.get<ApiResponse<Notification[]>>('/ai-ops/notifications/history', {
      params: limit ? { limit } : undefined
    })
}

// ==================== 审计日志 API ====================

export const auditApi = {
  /**
   * 查询审计日志
   */
  query: (options?: {
    action?: AuditAction
    from?: number
    to?: number
    limit?: number
  }) =>
    api.get<ApiResponse<AuditLog[]>>('/ai-ops/audit', {
      params: options
    })
}

// ==================== 仪表盘 API ====================

export const dashboardApi = {
  /**
   * 获取仪表盘数据
   */
  getData: (deviceId?: string) =>
    api.get<ApiResponse<DashboardData>>('/ai-ops/dashboard', { params: { deviceId } })
}

// ==================== AI-Ops Enhancement: 类型定义 ====================
// Requirements: 1.1-10.6

/**
 * 事件来源类型
 */
export type EventSource = 'syslog' | 'metrics' | 'manual' | 'api'

/**
 * Syslog 消息
 */
export interface SyslogMessage {
  facility: number
  severity: number
  timestamp: string
  hostname: string
  topic: string
  message: string
  raw: string
}

/**
 * Syslog 接收配置
 */
export interface SyslogReceiverConfig {
  port: number
  enabled: boolean
}

/**
 * Syslog 服务状态（包含统计信息）
 */
export interface SyslogStatus {
  running: boolean
  port: number
  enabled: boolean
  handlersCount: number
  stats: SyslogStats
}

/**
 * Syslog 事件
 */
export interface SyslogEvent {
  id: string
  source: 'syslog'
  timestamp: number
  severity: AlertSeverity
  category: string
  message: string
  rawData: SyslogMessage
  metadata: {
    hostname: string
    facility: number
    syslogSeverity: number
  }
}

/**
 * Syslog 处理统计信息
 */
export interface SyslogStats {
  /** 接收到的消息总数 */
  received: number
  /** 解析成功的消息数 */
  parsed: number
  /** 解析失败的消息数 */
  parseFailed: number
  /** 入队成功的消息数 */
  enqueued: number
  /** 入队失败的消息数（背压/队列满等） */
  enqueueFailed: number
  /** 处理器错误数 */
  handlerErrors: number
  /** 最后一条消息的时间戳 */
  lastMessageAt: number | null
  /** 最后一条错误的时间戳 */
  lastErrorAt: number | null
  /** 启动时间 */
  startedAt: number | null
  /** 运行时长（毫秒） */
  uptimeMs: number
}

/**
 * Syslog 完整统计（包含 Pipeline 状态）
 */
export interface SyslogFullStats {
  syslog: SyslogStats
  pipeline: {
    active: number
    queued: number
    queueUsagePercent: number
    totalProcessed: number
    totalDropped: number
    totalTimedOut: number
    avgProcessingTimeMs: number
  }
}

/**
 * 周期性维护窗口配置
 */
export interface RecurringSchedule {
  type: 'daily' | 'weekly' | 'monthly'
  dayOfWeek?: number[]
  dayOfMonth?: number[]
}

/**
 * 维护窗口
 */
export interface MaintenanceWindow {
  id: string
  tenantId?: string
  deviceId?: string
  name: string
  startTime: number
  endTime: number
  resources: string[]
  recurring?: RecurringSchedule
  createdAt?: number
  updatedAt?: number
}

/**
 * 创建维护窗口输入
 */
export type CreateMaintenanceWindowInput = Omit<MaintenanceWindow, 'id' | 'createdAt' | 'updatedAt'>

/**
 * 更新维护窗口输入
 */
export type UpdateMaintenanceWindowInput = Partial<Omit<MaintenanceWindow, 'id' | 'createdAt' | 'updatedAt'>>

/**
 * 已知问题
 */
export interface KnownIssue {
  id: string
  pattern: string
  description: string
  expiresAt?: number
  autoResolve: boolean
  createdAt?: number
  updatedAt?: number
}

/**
 * 创建已知问题输入
 */
export type CreateKnownIssueInput = Omit<KnownIssue, 'id' | 'createdAt' | 'updatedAt'>

/**
 * 更新已知问题输入
 */
export type UpdateKnownIssueInput = Partial<Omit<KnownIssue, 'id' | 'createdAt' | 'updatedAt'>>

/**
 * 根因
 */
export interface RootCause {
  id: string
  description: string
  confidence: number
  evidence: string[]
  relatedAlerts: string[]
}

/**
 * 时间线事件类型
 */
export type TimelineEventType = 'trigger' | 'symptom' | 'cause' | 'effect'

/**
 * 时间线事件
 */
export interface TimelineEvent {
  timestamp: number
  eventId: string
  description: string
  type: TimelineEventType
}

/**
 * 事件时间线
 */
export interface EventTimeline {
  events: TimelineEvent[]
  startTime: number
  endTime: number
}

/**
 * 影响范围
 */
export type ImpactScope = 'local' | 'partial' | 'widespread'

/**
 * 影响评估
 */
export interface ImpactAssessment {
  scope: ImpactScope
  affectedResources: string[]
  estimatedUsers: number
  services: string[]
  networkSegments: string[]
}

/**
 * 相似历史事件
 */
export interface SimilarIncident {
  id: string
  timestamp: number
  similarity: number
  resolution?: string
}

/**
 * 根因分析结果
 */
export interface RootCauseAnalysis {
  id: string
  alertId: string
  timestamp: number
  rootCauses: RootCause[]
  timeline: EventTimeline
  impact: ImpactAssessment
  similarIncidents?: SimilarIncident[]
}

/**
 * 修复步骤验证
 */
export interface StepVerification {
  command: string
  expectedResult: string
}

/**
 * 修复步骤
 */
export interface RemediationStep {
  order: number
  description: string
  command: string
  verification: StepVerification
  autoExecutable: boolean
  riskLevel: RiskLevel
  estimatedDuration: number
}

/**
 * 回滚步骤
 */
export interface RollbackStep {
  order: number
  description: string
  command: string
  condition?: string
}

/**
 * 修复方案状态
 */
export type RemediationPlanStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back'

/**
 * 修复方案
 */
export interface RemediationPlan {
  id: string
  alertId: string
  rootCauseId: string
  timestamp: number
  steps: RemediationStep[]
  rollback: RollbackStep[]
  overallRisk: RiskLevel
  estimatedDuration: number
  requiresConfirmation: boolean
  status: RemediationPlanStatus
  indexed?: boolean  // 是否已索引到知识库
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  stepOrder: number
  success: boolean
  output?: string
  error?: string
  duration: number
  verificationPassed?: boolean
}

/**
 * 决策类型
 */
export type DecisionType = 'auto_execute' | 'notify_and_wait' | 'escalate' | 'silence' | 'auto_remediate' | 'observe'

/**
 * 决策条件运算符
 */
export type DecisionConditionOperator = 'gt' | 'lt' | 'eq' | 'gte' | 'lte'

/**
 * 决策条件
 */
export interface DecisionCondition {
  factor: string
  operator: DecisionConditionOperator
  value: number
}

/**
 * 决策规则
 */
export interface DecisionRule {
  id: string
  name: string
  priority: number
  conditions: DecisionCondition[]
  action: DecisionType
  enabled: boolean
  createdAt?: number
  updatedAt?: number
}

/**
 * 创建决策规则输入
 */
export type CreateDecisionRuleInput = Omit<DecisionRule, 'id' | 'createdAt' | 'updatedAt'>

/**
 * 更新决策规则输入
 */
export type UpdateDecisionRuleInput = Partial<Omit<DecisionRule, 'id' | 'createdAt' | 'updatedAt'>>

/**
 * 决策因子评分
 */
export interface DecisionFactorScore {
  name: string
  score: number
  weight: number
}

/**
 * 决策执行结果
 */
export interface DecisionExecutionResult {
  success: boolean
  details: string
}

/**
 * 决策
 */
export interface Decision {
  id: string
  alertId: string
  timestamp: number
  action: DecisionType
  reasoning: string
  factors: DecisionFactorScore[]
  matchedRule?: string
  executed: boolean
  executionResult?: DecisionExecutionResult
}

/**
 * 告警反馈
 */
export interface AlertFeedback {
  id: string
  alertId: string
  timestamp: number
  userId?: string
  useful: boolean
  comment?: string
  tags?: string[]
}

/**
 * 创建告警反馈输入
 */
export type CreateAlertFeedbackInput = Omit<AlertFeedback, 'id' | 'timestamp'>

/**
 * 反馈统计
 */
export interface FeedbackStats {
  ruleId: string
  totalAlerts: number
  usefulCount: number
  notUsefulCount: number
  falsePositiveRate: number
  lastUpdated: number
}

/**
 * 指纹缓存配置
 */
export interface FingerprintCacheConfig {
  defaultTtlMs: number
  cleanupIntervalMs: number
}

/**
 * 指纹缓存统计
 */
export interface FingerprintCacheStats {
  size: number
  suppressedCount: number
  config: FingerprintCacheConfig
}

/**
 * 分析缓存配置
 */
export interface AnalysisCacheConfig {
  defaultTtlMs: number
  maxSize: number
}

/**
 * 分析缓存统计
 */
export interface AnalysisCacheStats {
  size: number
  hitCount: number
  missCount: number
  config: AnalysisCacheConfig
}

// ==================== AI-Ops Enhancement: Syslog API ====================
// Requirements: 1.1, 1.7

export const syslogApi = {
  /**
   * 获取 Syslog 配置
   */
  getConfig: () => api.get<ApiResponse<SyslogReceiverConfig>>('/ai-ops/syslog/config'),

  /**
   * 更新 Syslog 配置
   */
  updateConfig: (config: Partial<SyslogReceiverConfig>) =>
    api.put<ApiResponse<SyslogReceiverConfig>>('/ai-ops/syslog/config', config),

  /**
   * 获取 Syslog 服务状态
   */
  getStatus: () => api.get<ApiResponse<SyslogStatus>>('/ai-ops/syslog/status'),

  /**
   * 获取 Syslog 事件历史
   */
  getEvents: (options?: { from?: number; to?: number; limit?: number }) =>
    api.get<ApiResponse<SyslogEvent[]>>('/ai-ops/syslog/events', { params: options }),

  /**
   * 获取 Syslog 统计信息
   */
  getStats: () => api.get<ApiResponse<SyslogFullStats>>('/ai-ops/syslog/stats'),

  /**
   * 重置 Syslog 统计信息
   */
  resetStats: () => api.post<ApiResponse<{ message: string }>>('/ai-ops/syslog/stats/reset')
}

// ==================== AI-Ops Enhancement: 过滤器 API ====================
// Requirements: 5.7, 5.8

export const filtersApi = {
  // 维护窗口管理
  /**
   * 获取维护窗口列表
   */
  getMaintenanceWindows: (deviceId?: string) =>
    api.get<ApiResponse<MaintenanceWindow[]>>('/ai-ops/filters/maintenance', { params: { deviceId } }),

  /**
   * 创建维护窗口
   */
  createMaintenanceWindow: (window: CreateMaintenanceWindowInput) =>
    api.post<ApiResponse<MaintenanceWindow>>('/ai-ops/filters/maintenance', window),

  /**
   * 更新维护窗口
   */
  updateMaintenanceWindow: (id: string, updates: UpdateMaintenanceWindowInput) =>
    api.put<ApiResponse<MaintenanceWindow>>(`/ai-ops/filters/maintenance/${id}`, updates),

  /**
   * 删除维护窗口
   */
  deleteMaintenanceWindow: (id: string) =>
    api.delete<ApiResponse<void>>(`/ai-ops/filters/maintenance/${id}`),

  // 已知问题管理
  /**
   * 获取已知问题列表
   */
  getKnownIssues: () => api.get<ApiResponse<KnownIssue[]>>('/ai-ops/filters/known-issues'),

  /**
   * 创建已知问题
   */
  createKnownIssue: (issue: CreateKnownIssueInput) =>
    api.post<ApiResponse<KnownIssue>>('/ai-ops/filters/known-issues', issue),

  /**
   * 更新已知问题
   */
  updateKnownIssue: (id: string, updates: UpdateKnownIssueInput) =>
    api.put<ApiResponse<KnownIssue>>(`/ai-ops/filters/known-issues/${id}`, updates),

  /**
   * 删除已知问题
   */
  deleteKnownIssue: (id: string) =>
    api.delete<ApiResponse<void>>(`/ai-ops/filters/known-issues/${id}`)
}

// ==================== AI-Ops Enhancement: 分析 API ====================
// Requirements: 6.1, 6.2, 6.4

export const analysisApi = {
  /**
   * 获取告警的根因分析
   */
  getAnalysis: (alertId: string) =>
    api.get<ApiResponse<RootCauseAnalysis>>(`/ai-ops/analysis/${alertId}`),

  /**
   * 重新分析告警
   */
  refreshAnalysis: (alertId: string) =>
    api.post<ApiResponse<RootCauseAnalysis>>(`/ai-ops/analysis/${alertId}/refresh`),

  /**
   * 获取事件时间线
   */
  getTimeline: (alertId: string) =>
    api.get<ApiResponse<EventTimeline>>(`/ai-ops/analysis/${alertId}/timeline`),

  /**
   * 获取关联告警
   */
  getRelatedAlerts: (alertId: string, windowMs?: number) =>
    api.get<ApiResponse<AlertEvent[]>>(`/ai-ops/analysis/${alertId}/related`, {
      params: windowMs ? { windowMs } : undefined
    })
}

// ==================== AI-Ops Enhancement: 修复方案 API ====================
// Requirements: 7.1, 7.4

export const remediationPlansApi = {
  /**
   * 获取修复方案
   */
  getPlan: (alertId: string) =>
    api.get<ApiResponse<RemediationPlan | null>>(`/ai-ops/remediation/${alertId}`),

  /**
   * 生成修复方案
   */
  generatePlan: (alertId: string) =>
    api.post<ApiResponse<RemediationPlan>>(`/ai-ops/remediation/${alertId}`),

  /**
   * 执行修复方案（所有自动步骤）
   */
  executePlan: (planId: string) =>
    api.post<ApiResponse<ExecutionResult[]>>(`/ai-ops/remediation/${planId}/execute`),

  /**
   * 执行单个步骤
   */
  executeStep: (planId: string, stepOrder: number) =>
    api.post<ApiResponse<ExecutionResult>>(`/ai-ops/remediation/${planId}/execute`, { stepOrder }),

  /**
   * 执行回滚
   */
  executeRollback: (planId: string) =>
    api.post<ApiResponse<ExecutionResult[]>>(`/ai-ops/remediation/${planId}/rollback`)
}

// ==================== AI-Ops Enhancement: 决策 API ====================
// Requirements: 8.8

export const decisionsApi = {
  /**
   * 获取决策规则列表
   */
  getRules: () => api.get<ApiResponse<DecisionRule[]>>('/ai-ops/decisions/rules'),

  /**
   * 获取单个决策规则
   */
  getRuleById: (id: string) => api.get<ApiResponse<DecisionRule>>(`/ai-ops/decisions/rules/${id}`),

  /**
   * 创建决策规则
   */
  createRule: (rule: CreateDecisionRuleInput) =>
    api.post<ApiResponse<DecisionRule>>('/ai-ops/decisions/rules', rule),

  /**
   * 更新决策规则
   */
  updateRule: (id: string, updates: UpdateDecisionRuleInput) =>
    api.put<ApiResponse<DecisionRule>>(`/ai-ops/decisions/rules/${id}`, updates),

  /**
   * 删除决策规则
   */
  deleteRule: (id: string) => api.delete<ApiResponse<void>>(`/ai-ops/decisions/rules/${id}`),

  /**
   * 获取决策历史
   */
  getHistory: (options?: { alertId?: string; limit?: number }) =>
    api.get<ApiResponse<Decision[]>>('/ai-ops/decisions/history', { params: options })
}

// ==================== AI-Ops Enhancement: 反馈 API ====================
// Requirements: 10.1, 10.4, 10.5, 10.6

export const feedbackApi = {
  /**
   * 提交反馈
   */
  submit: (feedback: CreateAlertFeedbackInput) =>
    api.post<ApiResponse<AlertFeedback>>('/ai-ops/feedback', feedback),

  /**
   * 获取反馈统计（所有规则或指定规则）
   */
  getStats: (ruleId?: string) =>
    api.get<ApiResponse<FeedbackStats | FeedbackStats[]>>('/ai-ops/feedback/stats', {
      params: ruleId ? { ruleId } : undefined
    }),

  /**
   * 获取需要审查的规则
   */
  getRulesNeedingReview: (threshold?: number) =>
    api.get<ApiResponse<FeedbackStats[]>>('/ai-ops/feedback/review', {
      params: threshold ? { threshold } : undefined
    })
}

// ==================== AI-Ops Enhancement: 缓存管理 API ====================
// Requirements: 2.5, 3.5

export const cacheApi = {
  /**
   * 获取指纹缓存统计
   */
  getFingerprintStats: () =>
    api.get<ApiResponse<FingerprintCacheStats>>('/ai-ops/cache/fingerprint/stats'),

  /**
   * 清空指纹缓存
   */
  clearFingerprintCache: () =>
    api.post<ApiResponse<{ message: string }>>('/ai-ops/cache/fingerprint/clear'),

  /**
   * 获取分析缓存统计
   */
  getAnalysisStats: () =>
    api.get<ApiResponse<AnalysisCacheStats>>('/ai-ops/cache/analysis/stats'),

  /**
   * 清空分析缓存
   */
  clearAnalysisCache: () =>
    api.post<ApiResponse<{ message: string }>>('/ai-ops/cache/analysis/clear')
}

// ==================== AI-Ops Enhancement: 智能进化状态 API ====================
// Requirements: evolution-frontend - System Degradation Indicator

export const evolutionApi = {
  /**
   * 获取智能进化模块状态（包含降级信息）
   */
  getStatus: () =>
    api.get<ApiResponse<EvolutionStatusResponse>>('/ai-ops/evolution/status')
}

// ==================== AI-Ops Enhancement: 自主意图 API ====================
// Requirements: evolution-frontend - Autonomous Intent Generation

export const intentsApi = {
  /**
   * SSE 自主意图事件流
   * 返回一个 AbortController 用于取消请求
   */
  streamAutonomousIntents: (
    onMessage: (event: MessageEvent) => void,
    onError?: (event: Event) => void
  ): AbortController => {
    const controller = new AbortController()
    let isRetrying = false
    // 内部 abort controller，用于 token 刷新时中断当前 fetch 而不终止整个流
    let innerController: AbortController | null = null

    // 监听全局 token 刷新事件：中断当前 fetch，让 while 循环用新 token 重连
    const unsubTokenRefresh = onTokenRefreshed(() => {
      if (innerController && !controller.signal.aborted) {
        innerController.abort()
      }
    })

    // 外部 abort 时清理 token 监听
    controller.signal.addEventListener('abort', () => {
      unsubTokenRefresh()
      if (innerController) innerController.abort()
    })

    const doFetch = async () => {
      let retryDelayMs = 2000
      const maxRetryDelayMs = 60000

      while (!controller.signal.aborted) {
        innerController = new AbortController()
        // 如果外部已 abort，同步中断内部
        if (controller.signal.aborted) { innerController.abort(); break }
        // 外部 abort 时联动内部
        const onExternalAbort = () => innerController?.abort()
        controller.signal.addEventListener('abort', onExternalAbort, { once: true })

        try {
          const authStore = useAuthStore()
          const deviceStore = useDeviceStore()

          const baseUrl = api.defaults.baseURL || '/api'
          let url = `${baseUrl}/ai-ops/intents/stream`

          if (deviceStore.currentDeviceId && baseUrl.includes('/devices/')) {
            url = `/api/devices/${deviceStore.currentDeviceId}/ai-ops/intents/stream`
          }

          const headers: Record<string, string> = {
            'Accept': 'text/event-stream'
          }

          if (authStore.token) {
            headers['Authorization'] = `Bearer ${authStore.token}`
          }

          const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: innerController.signal
          })

          if (response.status === 401 && !isRetrying) {
            isRetrying = true
            const success = await authStore.refreshAccessToken()
            if (success) {
              isRetrying = false
              continue
            } else {
              authStore.logout()
              const errorEv = new Event('error')
              Object.defineProperty(errorEv, 'message', { value: '认证已过期', writable: true })
              onError?.(errorEv)
              return
            }
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }

          const reader = response.body?.getReader()
          if (!reader) {
            throw new Error('无法读取响应流')
          }

          const decoder = new TextDecoder()
          let buffer = ''

          retryDelayMs = 2000
          isRetrying = false

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const dataStr = line.slice(6).trim()
                if (!dataStr) continue

                const messageEvent = new MessageEvent('message', { data: dataStr })
                onMessage(messageEvent)
              }
            }
          }
        } catch (error) {
          if (controller.signal.aborted) {
            break
          }
          if ((error as Error).name === 'AbortError') {
            // Inner abort (token refresh) — loop back immediately with new token
            continue
          }
          console.warn('自主意图流断开，准备重连...', error)
        }

        if (!controller.signal.aborted) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs))
          retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs) // 指数退避
        }
      }
    }

    doFetch()

    return controller
  }
}

// ==================== 导出统一 API 对象 ====================

export const aiOpsApi = {
  metrics: metricsApi,
  alertRules: alertRulesApi,
  alertEvents: alertEventsApi,
  scheduler: schedulerApi,
  snapshots: snapshotsApi,
  reports: reportsApi,
  faultPatterns: faultPatternsApi,
  remediations: remediationsApi,
  notificationChannels: notificationChannelsApi,
  audit: auditApi,
  dashboard: dashboardApi,
  // AI-Ops Enhancement APIs
  syslog: syslogApi,
  filters: filtersApi,
  analysis: analysisApi,
  remediationPlans: remediationPlansApi,
  decisions: decisionsApi,
  feedback: feedbackApi,
  cache: cacheApi,
  intents: intentsApi,
  evolution: evolutionApi
}

export default aiOpsApi
