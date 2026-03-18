/**
 * AI-Ops 智能运维类型定义
 * 定义智能运维模块所需的所有接口类型
 */

// ==================== 通用类型 ====================

/**
 * 告警运算符
 */
export type AlertOperator = 'gt' | 'lt' | 'eq' | 'ne' | 'gte' | 'lte';

/**
 * 告警严重级别
 */
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'emergency';

/**
 * 指标类型
 * 注意：'syslog' 是特殊类型，用于标识来自 syslog 的事件，不是真正的指标
 */
export type MetricType = 'cpu' | 'memory' | 'disk' | 'interface_status' | 'interface_traffic' | 'syslog';

/**
 * 通知渠道类型
 */
export type ChannelType = 'web_push' | 'webhook' | 'email';

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
  | 'snapshot_create';

// ==================== 指标采集类型 ====================

/**
 * 指标数据点
 */
export interface MetricPoint {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

/**
 * 系统指标
 */
export interface SystemMetrics {
  cpu: { usage: number };
  memory: { total?: number; used?: number; free?: number; usage: number };
  disk: { total?: number; used?: number; free?: number; usage: number };
  uptime: number | string;
}

/**
 * 接口指标
 */
export interface InterfaceMetrics {
  name: string;
  status: 'up' | 'down';
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxErrors: number;
  txErrors: number;
}


/**
 * 指标采集配置
 */
export interface MetricsCollectorConfig {
  intervalMs: number;        // 采集间隔，默认 60000 (1分钟)
  retentionDays: number;     // 数据保留天数，默认 7
  enabled: boolean;
}

// ==================== 告警类型 ====================

/**
 * 接口状态目标值
 */
export type InterfaceStatusTarget = 'up' | 'down';

/**
 * 告警规则
 */
export interface AlertRule {
  id: string;
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID (为空表示全局规则或不特定于设备)
  name: string;
  enabled: boolean;
  metric: MetricType;
  metricLabel?: string;       // 如接口名称
  operator: AlertOperator;
  threshold: number;
  targetStatus?: InterfaceStatusTarget;  // 接口状态目标值（仅用于 interface_status 类型）
  duration: number;           // 持续触发次数
  cooldownMs: number;         // 冷却时间
  severity: AlertSeverity;
  channels: string[];         // 通知渠道 ID 列表
  autoResponse?: {
    enabled: boolean;
    script: string;           // RouterOS 脚本
  };
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
}

/**
 * 创建告警规则输入
 */
export type CreateAlertRuleInput = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 更新告警规则输入
 */
export type UpdateAlertRuleInput = Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * 告警事件来源类型
 * Requirements: syslog-alert-integration 1.3, 2.1
 * - metrics: 来自指标监控的告警
 * - syslog: 来自 Syslog 的告警
 */
export type AlertEventSource = 'metrics' | 'syslog';

/**
 * Syslog 元数据
 * Requirements: syslog-alert-integration 1.4, 2.3
 * 保存 Syslog 事件的原始信息
 */
export interface SyslogMetadata {
  hostname: string;
  facility: number;
  syslogSeverity: number;
  category: string;
  rawMessage: string;
}

/**
 * 告警事件
 * Requirements: 8.1 - AlertEvent 接口包含 metricLabel 字段以支持接口级别的告警
 * Requirements: syslog-alert-integration 1.3, 1.4 - 支持 source 和 syslogData 字段
 */
export interface AlertEvent {
  id: string;
  tenantId?: string;              // 租户 ID
  deviceId?: string;              // 设备 ID
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: MetricType;
  metricLabel?: string;  // 指标标签（如接口名称），用于接口级别的告警
  currentValue: number;
  threshold: number;
  message: string;
  aiAnalysis?: string;
  status: 'active' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed';
  triggeredAt: number;
  resolvedAt?: number;
  autoResponseResult?: {
    executed: boolean;
    success: boolean;
    output?: string;
    error?: string;
  };
  deviceName?: string;            // 设备名称 (Requirements: 8.1 - 增强告警上下文)
  deviceIp?: string;              // 设备 IP (Requirements: 8.1 - 增强告警上下文)
  // Syslog 集成字段 (Requirements: syslog-alert-integration 1.3, 1.4)
  source?: AlertEventSource;      // 事件来源，默认 'metrics'
  syslogData?: SyslogMetadata;    // Syslog 元数据（仅 syslog 来源有值）
  notifyChannels?: string[];      // 通知渠道 ID 列表 (Snapshot/Association)
  autoResponseConfig?: {          // 自动响应配置 (Snapshot/Association)
    enabled: boolean;
    script: string;
  };
}

// ==================== 调度器类型 ====================

/**
 * 定时任务类型
 */
export type ScheduledTaskType = 'inspection' | 'backup' | 'custom';

/**
 * 定时任务
 */
export interface ScheduledTask {
  id: string;
  name: string;
  type: ScheduledTaskType;
  cron: string;              // cron 表达式
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  tenantId?: string;         // 租户 ID
  deviceId?: string;         // 设备 ID
  config?: Record<string, unknown>;
  createdAt: number;
}

/**
 * 创建定时任务输入
 */
export type CreateScheduledTaskInput = Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'>;

/**
 * 更新定时任务输入
 */
export type UpdateScheduledTaskInput = Partial<Omit<ScheduledTask, 'id' | 'createdAt' | 'nextRunAt'>>;

/**
 * 任务执行状态
 */
export type TaskExecutionStatus = 'running' | 'success' | 'failed' | 'timeout';

/**
 * 任务执行记录
 */
export interface TaskExecution {
  id: string;
  taskId: string;
  taskName: string;
  type: string;
  status: TaskExecutionStatus;
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}


// ==================== 配置快照类型 ====================

/**
 * 快照触发方式
 */
export type SnapshotTrigger = 'auto' | 'manual' | 'pre-remediation';

/**
 * 配置快照
 */
export interface ConfigSnapshot {
  id: string;
  timestamp: number;
  trigger: SnapshotTrigger;
  size: number;
  checksum: string;
  metadata?: {
    routerVersion?: string;
    routerModel?: string;
  };
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID
}

/**
 * 风险级别
 */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * 快照差异
 */
export interface SnapshotDiff {
  snapshotA: string;
  snapshotB: string;
  additions: string[];
  modifications: Array<{ path: string; oldValue: string; newValue: string }>;
  deletions: string[];
  aiAnalysis?: {
    riskLevel: RiskLevel;
    summary: string;
    recommendations: string[];
  };
}

// ==================== 健康报告类型 ====================

/**
 * 健康状态
 */
export type HealthStatus = 'healthy' | 'warning' | 'critical';

/**
 * 健康报告
 */
export interface HealthReport {
  id: string;
  generatedAt: number;
  period: { from: number; to: number };
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID
  deviceName?: string;        // 设备名称
  summary: {
    overallHealth: HealthStatus;
    score: number;  // 0-100
  };
  metrics: {
    cpu: { avg: number; max: number; min: number };
    memory: { avg: number; max: number; min: number };
    disk: { avg: number; max: number; min: number };
  };
  interfaces: Array<{
    name: string;
    avgRxRate: number;
    avgTxRate: number;
    downtime: number;
  }>;
  alerts: {
    total: number;
    bySeverity: Record<AlertSeverity, number>;
    topRules: Array<{ ruleName: string; count: number }>;
  };
  configChanges: number;
  aiAnalysis: {
    risks: string[];
    recommendations: string[];
    trends: string[];
  };
}

// ==================== 故障自愈类型 ====================

/**
 * 故障模式条件
 */
export interface FaultCondition {
  metric: MetricType;
  metricLabel?: string;
  operator: AlertOperator;
  threshold: number;
}

/**
 * 故障模式
 */
export interface FaultPattern {
  id: string;
  tenantId?: string;         // 租户 ID
  deviceId?: string;         // 设备 ID
  name: string;
  description: string;
  enabled: boolean;
  status?: FaultPatternStatus; // 状态
  source?: FaultPatternSource; // 来源
  autoHeal: boolean;         // 是否自动修复
  builtin: boolean;          // 是否内置模式
  conditions: FaultCondition[];
  remediationScript: string;  // RouterOS 修复脚本
  rollbackScript?: string;    // 回滚脚本 (Requirements: 4.1, 4.5)
  verificationScript?: string; // 验证脚本
  createdAt: number;
  updatedAt: number;
}

/**
 * 故障模式状态
 */
export type FaultPatternStatus = 'active' | 'pending_review' | 'disabled' | 'rejected';

/**
 * 故障模式来源
 */
export type FaultPatternSource = 'system' | 'user' | 'learned';

/**
 * 创建故障模式输入
 */
export type CreateFaultPatternInput = Omit<FaultPattern, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>;

/**
 * 更新故障模式输入
 */
export type UpdateFaultPatternInput = Partial<Omit<FaultPattern, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>>;


/**
 * 修复执行状态
 */
export type RemediationStatus = 'pending' | 'executing' | 'success' | 'failed' | 'skipped' | 'rolled_back';

/**
 * 回滚结果 (Requirements: 4.1, 4.5)
 */
export interface RollbackResult {
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
}

/**
 * 修复执行记录
 */
export interface RemediationExecution {
  id: string;
  patternId: string;
  patternName: string;
  alertEventId: string;
  tenantId?: string;
  deviceId?: string;
  status: RemediationStatus;
  preSnapshotId?: string;
  aiConfirmation?: {
    confirmed: boolean;
    confidence: number;
    reasoning: string;
  };
  executionResult?: {
    output: string;
    error?: string;
  };
  verificationResult?: {
    passed: boolean;
    message: string;
  };
  // 回滚相关字段 (Requirements: 4.1, 4.5)
  rollbackResult?: RollbackResult;
  retryCount?: number;
  startedAt: number;
  completedAt?: number;
}

// ==================== 通知类型 ====================

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
  url: string;
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
  bodyTemplate?: string;  // 支持变量替换
}

/**
 * 邮件配置
 */
export interface EmailConfig {
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
  };
  from: string;
  to: string[];
}

/**
 * 通知渠道配置联合类型
 */
export type NotificationChannelConfig = WebPushConfig | WebhookConfig | EmailConfig;

/**
 * 通知渠道
 */
export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: NotificationChannelConfig;
  severityFilter?: AlertSeverity[];  // 只接收指定级别的告警
  createdAt: number;
}

/**
 * 创建通知渠道输入
 */
export type CreateNotificationChannelInput = Omit<NotificationChannel, 'id' | 'createdAt'>;

/**
 * 更新通知渠道输入
 */
export type UpdateNotificationChannelInput = Partial<Omit<NotificationChannel, 'id' | 'createdAt'>>;

/**
 * 通知类型
 */
export type NotificationType = 'alert' | 'recovery' | 'report' | 'remediation';

/**
 * 通知状态
 */
export type NotificationStatus = 'pending' | 'sent' | 'failed';

/**
 * 通知
 */
export interface Notification {
  id: string;
  channelId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: NotificationStatus;
  sentAt?: number;
  error?: string;
  retryCount: number;
}


// ==================== 审计日志类型 ====================

/**
 * 审计日志
 */
export interface AuditLog {
  id: string;
  timestamp: number;
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID
  action: AuditAction;
  actor: 'system' | 'user';
  source?: string;            // 来源标识（如 mcp_client, mcp_server）
  details: {
    trigger?: string;
    script?: string;
    result?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

/**
 * 审计日志查询选项
 */
export interface AuditLogQueryOptions {
  from?: number;
  to?: number;
  action?: AuditAction;
  actor?: 'system' | 'user';
  limit?: number;
}

// ==================== AI 分析类型 ====================

/**
 * 分析请求类型
 */
export type AnalysisType = 'alert' | 'health_report' | 'config_diff' | 'fault_diagnosis' | 'classify_alert' | 'intelligent_rca';

/**
 * 分析请求
 */
export interface AnalysisRequest {
  type: AnalysisType;
  context: Record<string, unknown>;
}

/**
 * 分析结果
 */
export interface AnalysisResult {
  summary: string;
  details?: string;
  recommendations?: string[];
  riskLevel?: RiskLevel;
  confidence?: number;
}

// ==================== 数据存储类型 ====================

/**
 * AI-Ops 数据存储结构
 */
export interface AIOpsData {
  alertRules: AlertRule[];
  faultPatterns: FaultPattern[];
  notificationChannels: NotificationChannel[];
  scheduledTasks: ScheduledTask[];
  metricsConfig: MetricsCollectorConfig;
}

// ==================== 服务接口 ====================

/**
 * 数据可用性状态
 * Requirements: 6.2 - 返回明确的状态指示
 */
export type DataAvailabilityStatus =
  | 'available'           // 数据可用
  | 'no_previous_data'    // 暂时无数据（首次采集）
  | 'interface_not_found' // 接口不存在
  | 'stale_data'          // 数据过期
  | 'counter_reset'       // 计数器重置
  | 'overflow';           // 计数器溢出

/**
 * 速率计算配置
 * Requirements: 6.5 - 支持配置平滑窗口大小
 */
export interface RateCalculationConfig {
  /** 平滑窗口大小（数据点数量），默认 3 */
  smoothingWindowSize: number;
  /** 最大有效速率（bytes/s），用于异常检测，默认 12.5GB/s (100Gbps) */
  maxValidRate: number;
  /** 计数器位数，默认 64 */
  counterBits: 32 | 64;
}

/**
 * 速率计算结果
 * 用于流量速率计算，正确处理计数器重置等边界情况
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export interface RateCalculationResult {
  /** 计算出的速率（bytes/second），如果无法计算则为 null */
  rate: number | null;
  /** 是否检测到计数器重置 */
  isCounterReset: boolean;
  /** 是否检测到计数器溢出 (Requirements: 6.6) */
  isOverflow: boolean;
  /** 原始差值（current - previous） */
  rawDelta: number;
  /** 平滑后的速率 (Requirements: 6.5) */
  smoothedRate?: number;
  /** 置信度 0-1，表示计算结果的可靠性 */
  confidence: number;
  /** 数据可用性状态 (Requirements: 6.2) */
  dataStatus: DataAvailabilityStatus;
}

/**
 * 指标采集服务接口
 */
export interface IMetricsCollector {
  start(): void;
  stop(): void;
  collectNow(): Promise<{ system: SystemMetrics; interfaces: InterfaceMetrics[] }>;
  getHistory(metric: string, from: number, to: number): Promise<MetricPoint[]>;
  getLatest(): Promise<{ system: SystemMetrics; interfaces: InterfaceMetrics[] } | null>;

  /**
   * 计算流量速率，正确处理计数器重置和溢出
   * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
   * @param current 当前计数器值
   * @param previous 上一次计数器值
   * @param intervalMs 时间间隔（毫秒）
   * @param config 可选的速率计算配置
   * @returns 速率计算结果
   */
  calculateRate(
    current: number,
    previous: number,
    intervalMs: number,
    config?: Partial<RateCalculationConfig>
  ): RateCalculationResult;

  /**
   * 获取速率计算配置
   */
  getRateCalculationConfig(): RateCalculationConfig;

  /**
   * 更新速率计算配置
   * @param config 部分配置更新
   */
  setRateCalculationConfig(config: Partial<RateCalculationConfig>): void;
}

/**
 * 告警引擎配置
 * Requirements: 11.3 - 支持配置持久化间隔
 */
export interface AlertEngineConfig {
  /** 持久化间隔（毫秒），默认 30000 (30秒) */
  persistIntervalMs: number;
  /** 启用内存缓存，默认 true */
  enableMemoryCache: boolean;
}

/**
 * 告警引擎缓存统计
 * Requirements: 11.1 - 提供缓存状态查询
 */
export interface AlertEngineCacheStats {
  /** 内存中的规则数量 */
  rulesInMemory: number;
  /** 内存中的活跃告警数量 */
  activeAlertsInMemory: number;
  /** 待持久化的变更数量 */
  pendingPersist: number;
  /** 事件缓存大小 */
  eventsCacheSize: number;
}

/**
 * 告警引擎接口
 */
export interface IAlertEngine {
  // 规则管理
  createRule(rule: CreateAlertRuleInput): Promise<AlertRule>;
  updateRule(id: string, updates: UpdateAlertRuleInput): Promise<AlertRule>;
  deleteRule(id: string): Promise<void>;
  /**
   * 获取告警规则列表
   */
  getRules(deviceId?: string): Promise<AlertRule[]>;
  getRuleById(id: string): Promise<AlertRule | null>;
  enableRule(id: string): Promise<void>;
  disableRule(id: string): Promise<void>;

  // 告警评估
  evaluate(metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] }): Promise<AlertEvent[]>;

  // 告警事件
  getActiveAlerts(): Promise<AlertEvent[]>;
  getAlertHistory(from: number, to: number): Promise<AlertEvent[]>;
  resolveAlert(id: string): Promise<void>;

  // 内存缓存管理 (Requirements: 11.1, 11.4)
  /**
   * 强制持久化所有待写入数据
   * 用于系统关闭时确保数据不丢失
   */
  flush(): Promise<void>;

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): AlertEngineCacheStats;
}


/**
 * 调度器接口
 */
export interface IScheduler {
  start(): void;
  stop(): void;

  // 任务管理
  createTask(task: CreateScheduledTaskInput): Promise<ScheduledTask>;
  updateTask(id: string, updates: UpdateScheduledTaskInput): Promise<ScheduledTask>;
  deleteTask(id: string): Promise<void>;
  getTasks(): Promise<ScheduledTask[]>;
  getTaskById(id: string): Promise<ScheduledTask | null>;

  /**
   * 立即执行任务
   */
  runTaskNow(id: string, deviceId: string): Promise<TaskExecution>;

  // 执行历史
  getExecutions(taskId?: string, limit?: number): Promise<TaskExecution[]>;
}

/**
 * 配置快照服务接口
 */
export interface IConfigSnapshotService {
  // 快照管理
  createSnapshot(trigger: SnapshotTrigger): Promise<ConfigSnapshot>;
  getSnapshots(limit?: number): Promise<ConfigSnapshot[]>;
  getSnapshotById(id: string): Promise<ConfigSnapshot | null>;
  deleteSnapshot(id: string): Promise<void>;
  downloadSnapshot(id: string): Promise<string>;  // 返回配置内容

  // 配置恢复
  restoreSnapshot(id: string): Promise<{ success: boolean; message: string }>;

  // 差异对比
  compareSnapshots(idA: string, idB: string): Promise<SnapshotDiff>;
  getLatestDiff(): Promise<SnapshotDiff | null>;
}

/**
 * 健康报告服务接口
 */
export interface IHealthReportService {
  generateReport(from: number, to: number): Promise<HealthReport>;
  getReports(limit?: number): Promise<HealthReport[]>;
  getReportById(id: string): Promise<HealthReport | null>;
  exportAsMarkdown(id: string): Promise<string>;
  exportAsPdf(id: string): Promise<Buffer>;
}

/**
 * 修复执行配置 (Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 2.3)
 */
export interface RemediationExecutionConfig {
  /** 最大重试次数，默认 3 */
  maxRetries: number;
  /** 重试间隔（毫秒），默认 5000 */
  retryDelayMs: number;
  /** 启用自动回滚 */
  enableAutoRollback: boolean;
  /** 回滚超时（毫秒） */
  rollbackTimeoutMs: number;
  /** 验证重试次数 */
  verificationRetries: number;
  /** 脚本执行超时时间（毫秒），默认 30000 (Requirements: 2.3) */
  scriptTimeoutMs: number;
}

/**
 * 故障自愈服务接口
 */
export interface IFaultHealer {
  // 故障模式管理
  getPatterns(): Promise<FaultPattern[]>;
  getPatternById(id: string): Promise<FaultPattern | null>;
  createPattern(pattern: CreateFaultPatternInput): Promise<FaultPattern>;
  updatePattern(id: string, updates: UpdateFaultPatternInput): Promise<FaultPattern>;
  deletePattern(id: string): Promise<void>;
  enableAutoHeal(id: string): Promise<void>;
  disableAutoHeal(id: string): Promise<void>;

  // 故障匹配和修复
  matchPattern(alertEvent: AlertEvent): Promise<FaultPattern | null>;
  executeRemediation(patternId: string, alertEventId: string, tenantId?: string, deviceId?: string): Promise<RemediationExecution>;

  // 执行历史
  getRemediationHistory(limit?: number): Promise<RemediationExecution[]>;

  // 安全模式 (Requirements: 4.4, 4.6)
  isInSafeMode(): boolean;
  enterSafeMode(reason: string): void;
  exitSafeMode(): void;
}

/**
 * 通知服务接口
 */
export interface INotificationService {
  // 渠道管理
  createChannel(channel: CreateNotificationChannelInput): Promise<NotificationChannel>;
  updateChannel(id: string, updates: UpdateNotificationChannelInput): Promise<NotificationChannel>;
  deleteChannel(id: string): Promise<void>;
  getChannels(): Promise<NotificationChannel[]>;
  testChannel(id: string): Promise<{ success: boolean; message: string }>;

  // 发送通知
  send(
    channelIds: string[],
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>,
    severity?: string
  ): Promise<{ success: boolean; failedChannels: string[]; skippedChannels: string[] }>;

  // 通知历史
  getNotificationHistory(limit?: number): Promise<Notification[]>;
}

/**
 * 审计日志服务接口
 */
export interface IAuditLogger {
  log(entry: Omit<AuditLog, 'id' | 'timestamp'>): Promise<AuditLog | null>;
  query(options: AuditLogQueryOptions): Promise<AuditLog[]>;
  cleanup(retentionDays: number): Promise<number>;  // 返回删除的记录数
}

/**
 * AI 分析服务接口
 */
export interface IAIAnalyzer {
  // 初始化
  initialize(): Promise<void>;

  // 通用分析
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;

  // 特定场景分析
  analyzeAlert(
    alertEvent: AlertEvent,
    metrics: SystemMetrics,
    externalRagContext?: { summary?: string; details?: string; recommendations?: string[]; riskLevel?: string; confidence?: number },
    operationalRules?: string[]
  ): Promise<AnalysisResult>;
  analyzeHealthReport(
    metrics: HealthReport['metrics'],
    alerts: HealthReport['alerts']
  ): Promise<AnalysisResult>;
  analyzeConfigDiff(diff: SnapshotDiff): Promise<AnalysisResult>;
  confirmFaultDiagnosis(
    pattern: FaultPattern,
    alertEvent: AlertEvent
  ): Promise<{ confirmed: boolean; confidence: number; reasoning: string }>;
  analyzeClassifyAlert(message: string): Promise<any>;
  analyzeIntelligentRootCause(event: any, metrics: SystemMetrics, historyContext: string): Promise<any>;
}


// ==================== AI-Ops 智能增强类型 ====================
// Phase 1 & Phase 2 Enhancement Types

// ==================== Syslog 接收类型 ====================

/**
 * Syslog 消息
 */
export interface SyslogMessage {
  facility: number;           // Syslog facility (0-23)
  severity: number;           // Syslog severity (0-7)
  timestamp: Date;
  hostname: string;
  topic: string;              // RouterOS topic (e.g., 'system', 'firewall')
  message: string;
  raw: string;
}

/**
 * Syslog 接收配置
 */
export interface SyslogReceiverConfig {
  port: number;               // 默认 514
  enabled: boolean;
}

/**
 * 事件来源类型
 */
export type EventSource = 'syslog' | 'metrics' | 'manual' | 'api';

/**
 * Syslog 事件
 */
export interface SyslogEvent {
  id: string;
  tenantId?: string;          // 租户 ID (Requirements: 9.2)
  deviceId?: string;          // 设备 ID (Requirements: 9.2)
  source: 'syslog';
  timestamp: number;
  severity: AlertSeverity;
  category: string;           // 映射自 RouterOS topic
  message: string;
  rawData: SyslogMessage;
  metadata: {
    hostname: string;
    facility: number;
    syslogSeverity: number;
  };
}

/**
 * Syslog 处理统计信息
 */
export interface SyslogStats {
  /** 接收到的消息总数 */
  received: number;
  /** 解析成功的消息数 */
  parsed: number;
  /** 解析失败的消息数 */
  parseFailed: number;
  /** 入队成功的消息数 */
  enqueued: number;
  /** 入队失败的消息数（背压/队列满等） */
  enqueueFailed: number;
  /** 处理器错误数 */
  handlerErrors: number;
  /** 最后一条消息的时间戳 */
  lastMessageAt: number | null;
  /** 最后一条错误的时间戳 */
  lastErrorAt: number | null;
  /** 启动时间 */
  startedAt: number | null;
  /** 运行时长（毫秒） */
  uptimeMs: number;
}

// ==================== 指纹缓存类型 ====================

/**
 * 指纹条目
 */
export interface FingerprintEntry {
  fingerprint: string;
  firstSeen: number;
  lastSeen: number;
  count: number;              // 重复次数
  ttl: number;                // 过期时间戳
}

/**
 * 指纹缓存配置
 */
export interface FingerprintCacheConfig {
  defaultTtlMs: number;       // 默认 TTL，默认 5 分钟
  cleanupIntervalMs: number;  // 清理间隔，默认 1 分钟
}

/**
 * 指纹缓存统计
 */
export interface FingerprintCacheStats {
  size: number;
  suppressedCount: number;
}

// ==================== 批处理类型 ====================

/**
 * 批处理配置
 */
export interface BatchConfig {
  windowMs: number;           // 批处理窗口，默认 5000ms
  maxBatchSize: number;       // 最大批次大小，默认 20
}

/**
 * 批处理项
 */
export interface BatchItem {
  alert: AlertEvent;
  resolve: (analysis: string) => void;
  reject: (error: Error) => void;
}

// ==================== 分析缓存类型 ====================

/**
 * 缓存的分析结果
 */
export interface CachedAnalysis {
  fingerprint: string;
  analysis: string;
  createdAt: number;
  ttl: number;
  hitCount: number;
}

/**
 * 分析缓存配置
 */
export interface AnalysisCacheConfig {
  defaultTtlMs: number;       // 默认 30 分钟
  maxSize: number;            // 最大缓存条目数，默认 1000
}

/**
 * 分析缓存统计
 */
export interface AnalysisCacheStats {
  size: number;
  hitCount: number;
  missCount: number;
}

// ==================== 事件预处理类型 ====================

/**
 * 设备信息
 */
export interface DeviceInfo {
  id?: string;                // 设备 ID
  tenantId?: string;          // 租户 ID
  hostname: string;
  model: string;
  version: string;
  ip: string;
}

/**
 * 告警规则信息（用于 metrics 来源的事件）
 */
export interface AlertRuleInfo {
  ruleId: string;
  ruleName: string;
  metric: string;
  threshold: number;
  currentValue: number;
}

/**
 * 统一事件格式
 */
export interface UnifiedEvent {
  id: string;
  tenantId?: string;         // 租户 ID
  deviceId?: string;         // 设备 ID
  source: EventSource;
  timestamp: number;
  severity: AlertSeverity;
  category: string;
  message: string;
  rawData: unknown;
  metadata: Record<string, unknown>;
  deviceInfo?: DeviceInfo;
  alertRuleInfo?: AlertRuleInfo;
  notifyChannels?: string[];      // 通知渠道 ID 列表 (Snapshot/Association)
  autoResponseConfig?: {          // 自动响应配置 (Snapshot/Association)
    enabled: boolean;
    script: string;
  };
}

/**
 * 聚合信息
 */
export interface AggregationInfo {
  count: number;
  firstSeen: number;
  lastSeen: number;
  pattern: string;            // 聚合模式描述
}

/**
 * 复合事件（聚合后的事件）
 */
export interface CompositeEvent extends UnifiedEvent {
  isComposite: true;
  childEvents: string[];      // 子事件 ID 列表
  aggregation: AggregationInfo;
}

/**
 * 聚合规则
 */
export interface AggregationRule {
  id: string;
  name: string;
  pattern: string;            // 匹配模式（字符串形式的正则）
  windowMs: number;           // 聚合时间窗口
  minCount: number;           // 最小聚合数量
  category: string;           // 事件类别
}

// ==================== 垃圾告警过滤类型 ====================

/**
 * 周期性维护窗口配置
 */
export interface RecurringSchedule {
  type: 'daily' | 'weekly' | 'monthly';
  dayOfWeek?: number[];       // 0-6, 周日-周六
  dayOfMonth?: number[];
}

/**
 * 维护窗口
 */
export interface MaintenanceWindow {
  id: string;
  tenantId?: string;         // 租户 ID
  deviceId?: string;         // 设备 ID
  name: string;
  startTime: number;
  endTime: number;
  resources: string[];        // 受影响的资源（接口名、IP 等）
  recurring?: RecurringSchedule;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * 创建维护窗口输入
 */
export type CreateMaintenanceWindowInput = Omit<MaintenanceWindow, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 更新维护窗口输入
 */
export type UpdateMaintenanceWindowInput = Partial<Omit<MaintenanceWindow, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * 已知问题
 */
export interface KnownIssue {
  id: string;
  tenantId?: string;         // 租户 ID
  deviceId?: string;         // 设备 ID
  pattern: string;            // 匹配模式（字符串形式的正则）
  description: string;
  expiresAt?: number;
  autoResolve: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * 创建已知问题输入
 */
export type CreateKnownIssueInput = Omit<KnownIssue, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 更新已知问题输入
 */
export type UpdateKnownIssueInput = Partial<Omit<KnownIssue, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * 过滤原因
 */
export type FilterReason =
  | 'maintenance'
  | 'known_issue'
  | 'transient'
  | 'ai_filtered'
  | 'maintenance_window'
  | 'jitter_aggregated'
  | 'correlated'
  | 'load_filtered';

/**
 * 过滤结果
 */
export interface FilterResult {
  filtered: boolean;
  reason?: FilterReason;
  details?: string;
  confidence?: number;        // AI 过滤时的置信度
  layer?: number;             // 四层过滤的层级编号 (1-4)
}

/**
 * 过滤反馈类型
 */
export type FilterFeedbackType = 'correct' | 'false_positive' | 'false_negative';

/**
 * 过滤反馈
 */
export interface FilterFeedback {
  id: string;
  alertId: string;
  filterResult: FilterResult;
  userFeedback: FilterFeedbackType;
  timestamp: number;
  userId?: string;
}

/**
 * 过滤反馈统计
 */
export interface FilterFeedbackStats {
  total: number;
  falsePositives: number;
  falseNegatives: number;
}

// ==================== 根因分析类型 ====================

/**
 * 根因
 */
export interface RootCause {
  id: string;
  description: string;
  confidence: number;         // 0-100
  evidence: string[] | string; // 支持证据 (可以是数组也可单行文本，防御模型幻觉)
  relatedAlerts: string[];    // 相关告警 ID
}

/**
 * 时间线事件类型
 */
export type TimelineEventType = 'trigger' | 'symptom' | 'cause' | 'effect';

/**
 * 时间线事件
 */
export interface TimelineEvent {
  timestamp: number;
  eventId: string;
  description: string;
  type: TimelineEventType;
}

/**
 * 事件时间线
 */
export interface EventTimeline {
  events: TimelineEvent[];
  startTime: number;
  endTime: number;
}

/**
 * 影响范围
 */
export type ImpactScope = 'local' | 'partial' | 'widespread';

/**
 * 影响评估
 */
export interface ImpactAssessment {
  scope: ImpactScope;
  affectedResources: string[];
  estimatedUsers: number;
  services: string[];
  networkSegments: string[];
}

/**
 * 相似历史事件
 */
export interface SimilarIncident {
  id: string;
  timestamp: number;
  similarity: number;
  resolution?: string;
}

/**
 * 根因分析结果
 */
export interface RootCauseAnalysis {
  id: string;
  alertId: string;
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID
  timestamp: number;
  rootCauses: RootCause[];
  timeline: EventTimeline;
  impact: ImpactAssessment;
  similarIncidents?: SimilarIncident[];
  // FaultHealer integration
  matchedFaultPatternId?: string;
  // Auto-response config passed from AlertEvent
  autoResponseConfig?: {
    enabled: boolean;
    script: string;
  };
  /** AI 提取的元数据 (Requirements: intelligent-rca-redesign) */
  metadata?: {
    aiCategory?: string;
    isProtocolIssue?: boolean;
    reasoning?: string;
  };
}

// ==================== 修复方案类型 ====================

/**
 * 修复步骤验证
 */
export interface StepVerification {
  command: string;            // 验证命令
  expectedResult: string;     // 期望结果描述
}

/**
 * 修复步骤
 */
export interface RemediationStep {
  order: number;
  description: string;
  command: string;            // RouterOS 命令
  verification: StepVerification;
  autoExecutable: boolean;    // 是否可自动执行
  riskLevel: RiskLevel;
  estimatedDuration: number;  // 预计耗时（秒）
}

/**
 * 回滚步骤
 */
export interface RollbackStep {
  order: number;
  description: string;
  command: string;
  condition?: string;         // 执行条件
}

/**
 * 修复方案状态
 */
export type RemediationPlanStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';

/**
 * 修复方案
 */
export interface RemediationPlan {
  id: string;
  alertId: string;
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID
  rootCauseId: string;
  description?: string;       // 方案描述
  timestamp: number;
  steps: RemediationStep[];
  rollback: RollbackStep[];
  overallRisk: RiskLevel;
  estimatedDuration: number;  // 总预计耗时（秒）
  requiresConfirmation: boolean;
  status: RemediationPlanStatus;
  indexed?: boolean;  // 是否已索引到知识库 (Requirements: 8.2)
  // FaultHealer integration
  matchedFaultPatternId?: string;
}

/**
 * 自愈流程结果 (H3.11)
 * FaultHealer.heal() 返回值
 */
export interface HealResult {
  success: boolean;
  snapshotId?: string;
  planId?: string;
  error?: string;
  steps: Array<{ description: string; success: boolean; output?: string; error?: string }>;
  duration: number;
}

/**
 * 执行结果
 */
export interface ExecutionResult {
  stepOrder: number;
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
  verificationPassed?: boolean;
  /** 步骤评估结果 (Requirements: critic-reflector 12.2) */
  evaluation?: StepEvaluation;
}

// ==================== 智能决策类型 ====================

/**
 * 决策类型
 */
export type DecisionType = 'auto_execute' | 'notify_and_wait' | 'escalate' | 'silence' | 'auto_remediate' | 'observe';

/**
 * 默认决策配置
 * 当所有决策规则都禁用时使用的默认决策
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
export interface DefaultDecisionConfig {
  /** 默认决策动作 */
  action: DecisionType;
  /** 优先级 */
  priority: number;
  /** 通知渠道 ID 列表 */
  notifyChannels: string[];
}

/**
 * 决策因子评估函数类型
 */
export type DecisionFactorEvaluator = (event: UnifiedEvent, context: DecisionContext) => number;

/**
 * 决策因子
 */
export interface DecisionFactor {
  name: string;
  weight: number;             // 权重 0-1
  evaluate: DecisionFactorEvaluator;
}

/**
 * 决策因子（可序列化版本，不含函数）
 */
export interface DecisionFactorConfig {
  name: string;
  weight: number;
}

/**
 * 决策上下文
 */
export interface DecisionContext {
  currentTime: Date;
  historicalSuccessRate: number;
  affectedScope: ImpactAssessment;
  recentDecisions: Decision[];
  userPreferences?: Record<string, unknown>;
}

/**
 * 决策条件运算符
 */
export type DecisionConditionOperator = 'gt' | 'lt' | 'eq' | 'gte' | 'lte';

/**
 * 决策条件
 */
export interface DecisionCondition {
  factor: string;
  operator: DecisionConditionOperator;
  value: number;
}

/**
 * 决策规则
 */
export interface DecisionRule {
  id: string;
  name: string;
  description?: string;       // 规则描述
  priority: number;           // 优先级，数字越小优先级越高
  conditions: DecisionCondition[];
  action: DecisionType;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * 创建决策规则输入
 */
export type CreateDecisionRuleInput = Omit<DecisionRule, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 更新决策规则输入
 */
export type UpdateDecisionRuleInput = Partial<Omit<DecisionRule, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * 决策因子评分
 */
export interface DecisionFactorScore {
  name: string;
  score: number;
  weight: number;
}

/**
 * 决策执行结果
 */
export interface DecisionExecutionResult {
  success: boolean;
  details: string;
}

/**
 * 决策
 */
export interface Decision {
  id: string;
  alertId: string;
  tenantId?: string;          // 租户 ID
  deviceId?: string;          // 设备 ID
  timestamp: number;
  action: DecisionType;
  reasoning: string;
  factors: DecisionFactorScore[];
  matchedRule?: string;
  executed: boolean;
  executionResult?: DecisionExecutionResult;
}

// ==================== 用户反馈类型 ====================

/**
 * 告警反馈
 */
export interface AlertFeedback {
  id: string;
  alertId: string;
  timestamp: number;
  userId?: string;
  useful: boolean;
  comment?: string;
  tags?: string[];            // 如 'false_positive', 'noise', 'important'
}

/**
 * 创建告警反馈输入
 */
export type CreateAlertFeedbackInput = Omit<AlertFeedback, 'id' | 'timestamp'>;

/**
 * 反馈统计
 */
export interface FeedbackStats {
  ruleId: string;
  totalAlerts: number;
  usefulCount: number;
  notUsefulCount: number;
  falsePositiveRate: number;
  lastUpdated: number;
}

// ==================== 告警处理流水线类型 ====================

/**
 * 流水线阶段
 */
export type PipelineStage = 'normalize' | 'deduplicate' | 'filter' | 'analyze' | 'decide';

/**
 * 流水线处理结果
 */
export interface PipelineResult {
  event: UnifiedEvent | CompositeEvent;
  stage: PipelineStage;
  filtered: boolean;
  filterResult?: FilterResult;
  analysis?: RootCauseAnalysis;
  decision?: Decision;
  plan?: RemediationPlan;
}

// ==================== 增强服务接口 ====================

/**
 * Syslog 接收服务接口
 */
export interface ISyslogReceiver {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  onMessage(handler: (event: SyslogEvent) => void): void;
  getConfig(): SyslogReceiverConfig;
  updateConfig(config: Partial<SyslogReceiverConfig>): void;
}

/**
 * 指纹缓存服务接口
 */
export interface IFingerprintCache {
  generateFingerprint(alert: AlertEvent): string;
  exists(fingerprint: string): boolean;
  set(fingerprint: string, ttlMs?: number): void;
  get(fingerprint: string): FingerprintEntry | null;
  delete(fingerprint: string): void;
  cleanup(): number;
  getStats(): FingerprintCacheStats;
}

/**
 * 批处理服务接口
 */
export interface IBatchProcessor {
  add(alert: AlertEvent): Promise<string>;
  flush(): Promise<void>;
  getPendingCount(): number;
  start(): void;
  stop(): void;
}

/**
 * 分析缓存服务接口
 */
export interface IAnalysisCache {
  get(fingerprint: string): string | null;
  set(fingerprint: string, analysis: string, ttlMs?: number): void;
  cleanup(): number;
  getStats(): AnalysisCacheStats;
}

/**
 * 告警预处理服务接口
 */
export interface IAlertPreprocessor {
  normalize(event: SyslogEvent | AlertEvent): UnifiedEvent;
  aggregate(event: UnifiedEvent): UnifiedEvent | CompositeEvent;
  enrichContext(event: UnifiedEvent): Promise<UnifiedEvent>;
  process(event: SyslogEvent | AlertEvent): Promise<UnifiedEvent | CompositeEvent>;
  addAggregationRule(rule: AggregationRule): void;
  removeAggregationRule(id: string): void;
  getAggregationRules(): AggregationRule[];
}

/**
 * 垃圾过滤服务接口
 */
export interface INoiseFilter {
  filter(event: UnifiedEvent): Promise<FilterResult>;
  addMaintenanceWindow(window: MaintenanceWindow): void;
  removeMaintenanceWindow(id: string): void;
  getMaintenanceWindows(): MaintenanceWindow[];
  isInMaintenanceWindow(event: UnifiedEvent): boolean;
  addKnownIssue(issue: KnownIssue): void;
  removeKnownIssue(id: string): void;
  getKnownIssues(): KnownIssue[];
  matchesKnownIssue(event: UnifiedEvent): KnownIssue | null;
  recordFeedback(feedback: Omit<FilterFeedback, 'id' | 'timestamp'>): void;
  getFeedbackStats(): FilterFeedbackStats;
}

/**
 * 根因分析服务接口
 */
export interface IRootCauseAnalyzer {
  analyzeSingle(event: UnifiedEvent): Promise<RootCauseAnalysis>;
  analyzeCorrelated(events: UnifiedEvent[]): Promise<RootCauseAnalysis>;
}

/**
 * 修复方案服务接口
 */
export interface IRemediationAdvisor {
  generatePlan(analysis: RootCauseAnalysis): Promise<RemediationPlan>;
  executeStep(planId: string, stepOrder: number): Promise<ExecutionResult>;
  executeAutoSteps(planId: string): Promise<ExecutionResult[]>;
  executeRollback(planId: string): Promise<ExecutionResult[]>;
  getPlan(planId: string): Promise<RemediationPlan | null>;
  getExecutionHistory(planId: string): Promise<ExecutionResult[]>;
}

/**
 * 决策引擎服务接口
 */
export interface IDecisionEngine {
  decide(event: UnifiedEvent, analysis?: RootCauseAnalysis): Promise<Decision>;
  executeDecision(decision: Decision, plan?: RemediationPlan, event?: UnifiedEvent): Promise<void>;
  saveDecision(decision: Decision): Promise<void>;
  addRule(rule: DecisionRule): void;
  updateRule(id: string, updates: Partial<DecisionRule>): void;
  removeRule(id: string): void;
  getRules(): DecisionRule[];
  registerFactor(factor: DecisionFactor): void;
  getFactors(): DecisionFactor[];
  getDecisionHistory(alertId?: string, limit?: number): Promise<Decision[]>;
  /** 设置默认决策配置 */
  setDefaultDecision(config: DefaultDecisionConfig): void;
  /** 获取默认决策配置 */
  getDefaultDecision(): DefaultDecisionConfig;
}

/**
 * 反馈服务接口
 */
export interface IFeedbackService {
  recordFeedback(feedback: CreateAlertFeedbackInput): Promise<AlertFeedback>;
  getFeedback(alertId: string): Promise<AlertFeedback[]>;
  getRuleStats(ruleId: string): Promise<FeedbackStats>;
  getAllRuleStats(): Promise<FeedbackStats[]>;
  getRulesNeedingReview(threshold?: number): Promise<FeedbackStats[]>;
  exportFeedback(from?: number, to?: number): Promise<AlertFeedback[]>;
}

/**
 * 告警处理流水线服务接口
 */
export interface IAlertPipeline {
  process(event: SyslogEvent | AlertEvent): Promise<PipelineResult>;
  getStats(): {
    processed: number;
    filtered: number;
    analyzed: number;
    decided: number;
  };
}


// ==================== 知识检索错误类型 ====================

/**
 * 知识检索错误代码
 * 用于区分不同类型的检索错误
 */
export enum KnowledgeRetrievalErrorCode {
  /** 无相关知识 - 检索成功但没有匹配结果 */
  NO_RESULTS = 'NO_RESULTS',
  /** 服务故障 - 知识库服务出错 */
  SERVICE_ERROR = 'SERVICE_ERROR',
  /** 超时 - 检索操作超时 */
  TIMEOUT = 'TIMEOUT',
  /** 无效查询 - 查询参数无效 */
  INVALID_QUERY = 'INVALID_QUERY',
}

/**
 * 知识检索错误
 * 用于区分"无相关知识"和"服务故障"两种情况
 * 
 * @example
 * ```typescript
 * try {
 *   const result = await ragEngine.query(question);
 * } catch (error) {
 *   if (error instanceof KnowledgeRetrievalError) {
 *     if (error.shouldFallback()) {
 *       // 回退到标准分析
 *     }
 *     console.log(error.getUserFriendlyMessage());
 *   }
 * }
 * ```
 */
export class KnowledgeRetrievalError extends Error {
  /** 错误代码 */
  public readonly code: KnowledgeRetrievalErrorCode;

  constructor(code: KnowledgeRetrievalErrorCode, message: string) {
    super(message);
    this.name = 'KnowledgeRetrievalError';
    this.code = code;

    // 确保 instanceof 正常工作
    Object.setPrototypeOf(this, KnowledgeRetrievalError.prototype);
  }

  /**
   * 获取用户友好的错误消息
   * 根据错误代码返回适合展示给用户的消息
   */
  getUserFriendlyMessage(): string {
    switch (this.code) {
      case KnowledgeRetrievalErrorCode.NO_RESULTS:
        return '未找到相关知识，将使用标准分析';
      case KnowledgeRetrievalErrorCode.SERVICE_ERROR:
        return '知识库服务暂时不可用，请稍后重试';
      case KnowledgeRetrievalErrorCode.TIMEOUT:
        return '知识检索超时，将使用标准分析';
      case KnowledgeRetrievalErrorCode.INVALID_QUERY:
        return '查询参数无效，请检查输入';
      default:
        return '知识检索发生未知错误';
    }
  }

  /**
   * 是否应该回退到标准分析
   * NO_RESULTS、SERVICE_ERROR 和 TIMEOUT 应该回退
   * INVALID_QUERY 不应该回退（需要用户修正输入）
   */
  shouldFallback(): boolean {
    switch (this.code) {
      case KnowledgeRetrievalErrorCode.NO_RESULTS:
      case KnowledgeRetrievalErrorCode.SERVICE_ERROR:
      case KnowledgeRetrievalErrorCode.TIMEOUT:
        return true;
      case KnowledgeRetrievalErrorCode.INVALID_QUERY:
        return false;
      default:
        return true;
    }
  }
}


// ==================== ReAct Agent 类型 ====================
// ReAct (Reasoning + Acting) 智能体增强类型定义
// Requirements: 2.6, 7.1, 7.2

/**
 * ReAct 步骤类型
 * 定义 ReAct 循环中的步骤类型
 * - thought: 思考步骤
 * - action: 工具调用步骤
 * - observation: 工具执行结果观察步骤
 * - final_answer: 最终答案步骤
 * - reflection: 反思步骤（智能进化系统新增）
 * 
 * @requirements 1.2.3 每次反思重试记录到 ReActStep 中，类型为 reflection
 */
export type ReActStepType = 'thought' | 'action' | 'observation' | 'final_answer' | 'reflection';

/**
 * ReAct 步骤
 * 记录 ReAct 循环中的每个步骤
 */
export interface ReActStep {
  /** 步骤类型 */
  type: ReActStepType;
  /** 步骤内容 */
  content: string;
  /** 时间戳 */
  timestamp: number;
  /** 工具名称（仅 action 类型） */
  toolName?: string;
  /** 工具输入参数（仅 action 类型） */
  toolInput?: Record<string, unknown>;
  /** 工具输出结果（仅 observation 类型） */
  toolOutput?: unknown;
  /** 执行耗时（毫秒，仅 observation 类型） */
  duration?: number;
  /** 执行是否成功（仅 observation 类型） */
  success?: boolean;
  /** 反思分析结果（仅 reflection 类型） */
  failureAnalysis?: FailureAnalysis;
  /** 修正后的参数（仅 reflection 类型） */
  modifiedParams?: ModifiedParams;
  /** 该步骤是否经过中间件修正（Requirements: 4.4） */
  middlewareCorrected?: boolean;
}

// ==================== 反思与自我修正类型 ====================
// Requirements: 1.1.1, 1.1.2, 1.1.3, 1.2.1, 1.2.2, 1.2.3

/**
 * 失败类型枚举
 * 用于分类工具执行失败的原因
 * 
 * @requirements 1.1.2 失败分析包含：失败类型、可能原因、修正建议
 */
export type FailureType =
  | 'parameter_error'   // 参数错误
  | 'timeout'           // 超时
  | 'permission'        // 权限问题
  | 'resource'          // 资源问题
  | 'network'           // 网络问题
  | 'unknown';          // 未知错误

/**
 * 失败分析结果
 * 工具执行失败后的分析报告
 * 
 * @requirements 1.1.1 工具执行失败后，系统在 5 秒内生成失败分析报告
 * @requirements 1.1.2 失败分析包含：失败类型、可能原因、修正建议
 */
export interface FailureAnalysis {
  /** 失败类型 */
  failureType: FailureType;
  /** 可能的原因列表 */
  possibleCauses: string[];
  /** 修正建议列表 */
  suggestions: string[];
  /** 分析置信度 (0-1) */
  confidence: number;
  /** 分析耗时（毫秒） */
  analysisTime?: number;
  /** 原始错误信息 */
  originalError?: string;
}

/**
 * 参数修正记录
 * 记录单个参数的修正详情
 * 
 * @requirements 1.1.3 修正建议包含具体的参数调整或替代工具推荐
 */
export interface ParamModification {
  /** 修正的字段名 */
  field: string;
  /** 原始值 */
  oldValue: unknown;
  /** 修正后的值 */
  newValue: unknown;
  /** 修正原因 */
  reason: string;
}

/**
 * 修正后的参数
 * 包含修正后的完整参数和修正记录
 * 
 * @requirements 1.2.1 反思后的重试使用修正后的参数，而非原始参数
 */
export interface ModifiedParams {
  /** 修正后的完整参数 */
  params: Record<string, unknown>;
  /** 参数修正记录列表 */
  modifications: ParamModification[];
  /** 是否建议使用替代工具 */
  suggestAlternativeTool?: boolean;
  /** 建议的替代工具名称 */
  alternativeToolName?: string;
}

/**
 * 反思重试结果
 * 执行反思重试后的结果
 * 
 * @requirements 1.2.2 最多允许 2 次反思重试，防止死循环
 */
export interface ReflectionRetryResult {
  /** 是否成功 */
  success: boolean;
  /** 重试次数 */
  retryCount: number;
  /** 最终结果 */
  result?: unknown;
  /** 失败分析历史 */
  analysisHistory: FailureAnalysis[];
  /** 参数修正历史 */
  modificationHistory: ModifiedParams[];
}

/**
 * 问题类型枚举
 * 用于分类用户请求的类型，以便确定工具优先级
 * Requirements: 2.1
 */
export enum QuestionType {
  /** 故障排查 */
  TROUBLESHOOTING = 'troubleshooting',
  /** 配置查询 */
  CONFIGURATION = 'configuration',
  /** 监控查询 */
  MONITORING = 'monitoring',
  /** 历史分析 */
  HISTORICAL_ANALYSIS = 'historical_analysis',
  /** 通用查询 */
  GENERAL = 'general',
}

/**
 * 意图分析结果
 * LLM 分析用户请求后返回的结构化结果
 */
export interface IntentAnalysis {
  /** 用户意图的简短描述 */
  intent: string;
  /** 需要调用的工具列表 */
  tools: Array<{
    /** 工具名称 */
    name: string;
    /** 工具参数 */
    params: Record<string, unknown>;
    /** 选择该工具的原因 */
    reason: string;
  }>;
  /** 置信度 (0-1) */
  confidence: number;
  /** 是否需要多步骤推理 */
  requiresMultiStep: boolean;
}

/**
 * 增强的意图分析结果
 * 扩展 IntentAnalysis，添加问题类型分类和知识检索相关字段
 * Requirements: 2.1, 2.5, 4.4
 */
export interface EnhancedIntentAnalysis extends IntentAnalysis {
  /** 问题类型分类 */
  questionType: QuestionType;
  /** 是否需要知识检索 */
  requiresKnowledgeSearch: boolean;
  /** 知识检索关键词 */
  knowledgeSearchTerms: string[];
  /** 工具优先级顺序 */
  toolPriority: string[];
}

/**
 * Agent 配置基础接口
 */
export interface AgentConfig {
  /** 会话 ID */
  sessionId?: string;
  /** 最大工具调用次数 */
  maxToolCalls?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * RAG 文档接口
 * 表示从知识库检索到的单个文档
 * Requirements: 6.4
 */
export interface RAGDocument {
  /** 文档 ID */
  id: string;
  /** 文档标题 */
  title: string;
  /** 文档类型 */
  type: string;
  /** 相关性评分 (0-1) */
  score: number;
  /** 关键摘要 */
  excerpt: string;
  /** 元数据 */
  metadata: Record<string, unknown>;
}

/**
 * RAG 上下文接口
 * 管理知识库检索结果和状态
 * Requirements: 6.1, 6.4
 */
export interface RAGContext {
  /** 检索到的文档列表 */
  documents: RAGDocument[];
  /** 检索耗时（毫秒） */
  retrievalTime: number;
  /** 检索查询 */
  query: string;
  /** 是否已执行检索 */
  hasRetrieved: boolean;
  /** 检索错误信息（如果有） */
  error?: string;
  /** 是否处于降级模式 */
  degradedMode?: boolean;
}

/**
 * 知识检索状态
 * 用于记录知识检索的执行状态
 * Requirements: 7.4
 */
export type KnowledgeRetrievalStatus = 'success' | 'failed' | 'timeout' | 'skipped';

/**
 * 流式响应事件类型
 */
export type StreamEventType = 'content' | 'react_step' | 'tool_call' | 'done' | 'error';

/**
 * 流式响应事件
 */
export interface StreamEvent {
  /** 事件类型 */
  type: StreamEventType;
  /** 事件数据 */
  data: unknown;
}

/**
 * ReAct 步骤事件
 * 用于流式响应中传递 ReAct 步骤
 */
export interface ReActStepEvent {
  type: 'react_step';
  data: {
    stepType: ReActStepType;
    content: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: unknown;
    duration?: number;
  };
}

/**
 * 完成事件
 * 用于流式响应结束时传递完整结果
 */
export interface DoneEvent {
  type: 'done';
  data: {
    fullContent: string;
    reactSteps: ReActStep[];
    toolCalls: import('./ai').AgentToolCall[];
    reasoning: string[];
    confidence: number;
    messageId?: string; // 消息 ID，用于前端收藏功能
  };
}

/**
 * 错误事件
 * 用于流式响应中传递错误信息
 */
export interface ErrorEvent {
  type: 'error';
  data: {
    code: string;
    message: string;
  };
}

// ==================== Critic/Reflector 模块类型 ====================
// 实现 AI 自我评估和策略调整能力
// Requirements: critic-reflector 1.1-22.5

/**
 * 评估维度
 * Requirements: 1.1-1.6
 */
export interface EvaluationDimensions {
  /** 症状消除评估 (0-100) */
  symptomElimination: number;
  /** 指标恢复评估 (0-100) */
  metricRecovery: number;
  /** 副作用检测 (0-100, 100表示无副作用) */
  sideEffects: number;
  /** 执行质量评估 (0-100) */
  executionQuality: number;
  /** 时间效率评估 (0-100) */
  timeEfficiency: number;
}

/**
 * 失败分类
 * Requirements: 3.1-3.8
 */
export type FailureCategory =
  | 'execution_error'      // 执行错误（命令语法、权限、连接问题）
  | 'verification_failed'  // 验证失败（命令成功但验证未通过）
  | 'wrong_diagnosis'      // 诊断错误（根因分析不正确）
  | 'insufficient_action'  // 行动不足（部分有效）
  | 'side_effect'          // 副作用（引发新问题）
  | 'timeout'              // 超时
  | 'external_factor';     // 外部因素

/**
 * 改进建议类型
 * Requirements: 4.1-4.6
 */
export type ImprovementSuggestion =
  | 'retry'        // 重试
  | 'alternative'  // 替代方案
  | 'escalate'     // 升级处理
  | 'rollback'     // 回滚
  | 'learn';       // 学习记录

/**
 * 步骤评估结果
 * Requirements: 1.1-1.7
 */
export interface StepEvaluation {
  stepOrder: number;
  dimensions: EvaluationDimensions;
  qualityScore: number;
  success: boolean;
  failureCategory?: FailureCategory;
  failureDetails?: string;
  confidence: number;
}

/**
 * 评估报告
 * Requirements: 2.1-2.4
 */
export interface EvaluationReport {
  id: string;
  planId: string;
  alertId: string;
  timestamp: number;
  overallSuccess: boolean;
  overallScore: number;
  stepEvaluations: StepEvaluation[];
  rootCauseAddressed: boolean;
  residualIssues: string[];
  failureCategory?: FailureCategory;
  improvementSuggestions: ImprovementSuggestion[];
  aiAnalysis?: string;
}

/**
 * 下一步行动类型
 * Requirements: 6.1-6.7
 */
export type NextAction =
  | 'retry_same'      // 重试相同方案
  | 'retry_modified'  // 重试修改后的方案
  | 'try_alternative' // 尝试替代方案
  | 'escalate'        // 升级处理
  | 'rollback'        // 回滚
  | 'complete';       // 完成（成功或接受失败）

/**
 * 反思结果
 * Requirements: 5.1-5.5, 6.1
 */
export interface ReflectionResult {
  id: string;
  evaluationId: string;
  timestamp: number;
  summary: string;
  insights: string[];
  gapAnalysis: string;
  patternMatch?: {
    patternId: string;
    similarity: number;
  };
  contextFactors: {
    timeOfDay: string;
    systemLoad: string;
    recentChanges: string[];
  };
  nextAction: NextAction;
  actionDetails?: {
    modifiedParams?: Record<string, unknown>;
    alternativePlan?: RemediationPlan;
    escalationSummary?: string;
  };
}

/**
 * 学习条目
 * 作为 KnowledgeEntry 的子类型存储，type='learning'
 * Requirements: 7.1-7.5
 */
export interface LearningEntry {
  id: string;
  timestamp: number;
  iterationId: string;
  failurePattern: string;
  rootCause: string;
  effectiveSolution?: string;
  ineffectiveApproaches: string[];
  contextFactors: Record<string, string>;
  confidence: number;
  indexed: boolean;
  /** 关联的 KnowledgeEntry ID */
  knowledgeEntryId?: string;
  /** 正面反馈次数 */
  feedbackPositiveCount: number;
  /** 负面反馈次数 */
  feedbackNegativeCount: number;
  /** 条目状态：active 正常 | deprecated 已废弃 */
  status: 'active' | 'deprecated';
}

/**
 * 迭代状态类型
 * Requirements: 8.7, 9.2
 */
export type IterationStatus =
  | 'pending'     // 等待开始
  | 'running'     // 运行中
  | 'evaluating'  // 评估中
  | 'reflecting'  // 反思中
  | 'completed'   // 已完成
  | 'aborted'     // 已中止
  | 'escalated';  // 已升级

/**
 * 迭代配置
 * Requirements: 8.2-8.4
 */
export interface IterationConfig {
  /** 最大迭代次数，默认 3 */
  maxIterations: number;
  /** 成功阈值，默认 80 */
  successThreshold: number;
  /** 超时时间（毫秒），默认 300000 (5分钟) */
  timeoutMs: number;
  /** 中止时是否回滚 */
  enableRollbackOnAbort: boolean;
}

/**
 * 迭代状态
 * Requirements: 9.1-9.5
 */
export interface IterationState {
  id: string;
  alertId: string;
  planId: string;
  currentIteration: number;
  maxIterations: number;
  status: IterationStatus;
  startTime: number;
  endTime?: number;
  evaluations: EvaluationReport[];
  reflections: ReflectionResult[];
  learningEntries: LearningEntry[];
  config: IterationConfig;
  lastError?: string;
}

/**
 * 迭代事件类型（用于 SSE）
 * Requirements: 17.2
 */
export type IterationEventType =
  | 'iteration_started'
  | 'step_executed'
  | 'step_evaluated'
  | 'reflection_complete'
  | 'decision_made'
  | 'iteration_complete';

/**
 * 迭代事件
 * Requirements: 17.2, 17.3
 */
export interface IterationEvent {
  type: IterationEventType;
  iterationId: string;
  timestamp: number;
  data: unknown;
}

/**
 * Critic 统计
 * Requirements: 18.1, 18.2
 */
export interface CriticStats {
  totalEvaluations: number;
  averageScore: number;
  failureCategoryDistribution: Record<FailureCategory, number>;
  improvementSuggestionDistribution: Record<ImprovementSuggestion, number>;
  lastUpdated: number;
}

/**
 * Reflector 统计
 * Requirements: 18.3, 18.4
 */
export interface ReflectorStats {
  totalReflections: number;
  decisionDistribution: Record<NextAction, number>;
  learningEntriesCount: number;
  averageIterationsToSuccess: number;
  lastUpdated: number;
}

/**
 * 迭代统计
 * Requirements: 18.5, 18.6
 */
export interface IterationStats {
  totalIterations: number;
  successRate: number;
  averageDuration: number;
  abortRate: number;
  escalationRate: number;
  lastUpdated: number;
}

/**
 * Critic/Reflector 功能配置
 * Requirements: 21.1, 21.4, 21.5, 21.6
 */
export interface CriticReflectorConfig {
  /** 是否启用 Critic/Reflector 功能 */
  enabled: boolean;
  /** 是否启用异步处理 */
  asyncEnabled: boolean;
  /** 最大并发迭代数 */
  maxConcurrentIterations: number;
  /** 默认迭代配置 */
  defaultIterationConfig: IterationConfig;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 默认 Critic/Reflector 配置
 */
export const DEFAULT_CRITIC_REFLECTOR_CONFIG: CriticReflectorConfig = {
  enabled: true,
  asyncEnabled: true,
  maxConcurrentIterations: 3,
  defaultIterationConfig: {
    maxIterations: 3,
    successThreshold: 80,
    timeoutMs: 300000,
    enableRollbackOnAbort: true,
  },
  updatedAt: Date.now(),
};

/**
 * 默认迭代配置
 */
export const DEFAULT_ITERATION_CONFIG: IterationConfig = {
  maxIterations: 3,
  successThreshold: 80,
  timeoutMs: 300000,
  enableRollbackOnAbort: true,
};

/**
 * 评估上下文
 * Requirements: 1.1-1.6
 */
export interface EvaluationContext {
  /** 告警事件（可选，在独立步骤评估时可能不可用） */
  alertEvent?: UnifiedEvent;
  /** 根因分析 */
  rootCauseAnalysis?: RootCauseAnalysis;
  /** 执行前系统状态 */
  preExecutionState: SystemMetrics;
  /** 执行后系统状态 */
  postExecutionState: SystemMetrics;
  /** 相关历史失败 */
  historicalFailures?: LearningEntry[];
}

/**
 * 反思上下文
 * Requirements: 5.1-5.5
 */
export interface ReflectionContext {
  /** 告警事件 */
  alertEvent: UnifiedEvent;
  /** 修复方案 */
  plan: RemediationPlan;
  /** 迭代历史 */
  iterationHistory: {
    evaluations: EvaluationReport[];
    reflections: ReflectionResult[];
  };
  /** 系统上下文 */
  systemContext: {
    currentTime: Date;
    systemLoad: SystemMetrics;
    recentChanges: string[];
  };
}


// ==================== Critic/Reflector 服务接口 ====================

/**
 * Critic 服务接口
 * Requirements: 1.1-4.6, 20.1
 */
export interface ICriticService {
  /**
   * 初始化服务
   */
  initialize(): Promise<void>;

  /**
   * 评估单步执行结果
   * Requirements: 1.1-1.7
   */
  evaluateStep(
    step: RemediationStep,
    result: ExecutionResult,
    context: EvaluationContext
  ): Promise<StepEvaluation>;

  /**
   * 评估整体修复方案
   * Requirements: 2.1-2.4
   */
  evaluatePlan(
    plan: RemediationPlan,
    results: ExecutionResult[],
    context: EvaluationContext
  ): Promise<EvaluationReport>;

  /**
   * 分析失败原因
   * Requirements: 3.1-3.9
   */
  analyzeFailure(
    result: ExecutionResult,
    context: EvaluationContext
  ): Promise<{ category: FailureCategory; confidence: number; details: string }>;

  /**
   * 生成改进建议
   * Requirements: 4.1-4.6
   */
  generateSuggestions(evaluation: EvaluationReport): ImprovementSuggestion[];

  /**
   * 获取评估报告
   */
  getReport(reportId: string): Promise<EvaluationReport | null>;

  /**
   * 按方案 ID 获取评估报告
   */
  getReportByPlanId(planId: string): Promise<EvaluationReport | null>;

  /**
   * 获取评估统计
   * Requirements: 18.1, 18.2
   */
  getStats(): Promise<CriticStats>;
}

/**
 * Reflector 服务接口
 * Requirements: 5.1-7.5, 18.3, 18.4
 */
export interface IReflectorService {
  /**
   * 初始化服务
   */
  initialize(): Promise<void>;

  /**
   * 执行深度反思
   * Requirements: 5.1-5.5
   */
  reflect(
    evaluation: EvaluationReport,
    context: ReflectionContext
  ): Promise<ReflectionResult>;

  /**
   * 决定下一步行动
   * Requirements: 6.1-6.7
   */
  decideNextAction(
    reflection: ReflectionResult,
    iterationState: IterationState
  ): Promise<NextAction>;

  /**
   * 提取学习内容
   * Requirements: 7.1, 7.2
   */
  extractLearning(iterationState: IterationState): Promise<LearningEntry>;

  /**
   * 持久化学习内容
   * 将 LearningEntry 转换为 KnowledgeEntry 并存储到知识库
   * Requirements: 7.3, 7.4
   */
  persistLearning(entry: LearningEntry): Promise<void>;

  /**
   * 查询相关学习内容
   * 使用 KnowledgeBase.search() 查询 type='learning' 的条目
   * Requirements: 7.5
   */
  queryLearning(query: string, limit?: number): Promise<LearningEntry[]>;

  /**
   * 按失败模式搜索学习内容
   * Requirements: 14.5
   */
  searchByFailurePattern(pattern: string, limit?: number): Promise<LearningEntry[]>;

  /**
   * 获取反思统计
   * Requirements: 18.3, 18.4
   */
  getStats(): Promise<ReflectorStats>;
}

/**
 * 迭代循环服务接口
 * Requirements: 8.1-10.5, 17.1-17.4, 18.5, 18.6, 21.1-22.5
 */
export interface IIterationLoop {
  /**
   * 初始化服务
   */
  initialize(): Promise<void>;

  /**
   * 启动迭代循环（同步等待完成）
   * Requirements: 8.1-8.7
   */
  start(
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan,
    config?: Partial<IterationConfig>
  ): Promise<string>;

  /**
   * 异步启动迭代循环（不阻塞调用方）
   * Requirements: 22.1, 22.2
   * 返回 Promise<string> 以支持真正的异步回调
   */
  startAsync(
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan,
    config?: Partial<IterationConfig>
  ): Promise<string>;

  /**
   * 中止迭代
   * Requirements: 10.1-10.5
   */
  abort(iterationId: string, reason?: string): Promise<void>;

  /**
   * 获取迭代状态
   * Requirements: 9.1-9.5
   */
  getState(iterationId: string): Promise<IterationState | null>;

  /**
   * 列出活跃迭代
   */
  listActive(): Promise<IterationState[]>;

  /**
   * 列出最近迭代
   */
  listRecent(limit?: number): Promise<IterationState[]>;

  /**
   * 订阅迭代事件（SSE）
   * Requirements: 17.1-17.4
   */
  subscribe(iterationId: string): AsyncIterable<IterationEvent>;

  /**
   * 获取迭代统计
   * Requirements: 18.5, 18.6
   */
  getStats(): Promise<IterationStats>;

  /**
   * 获取功能配置
   * Requirements: 21.4, 21.5
   */
  getConfig(): CriticReflectorConfig;

  /**
   * 更新功能配置
   * Requirements: 21.5, 21.6
   */
  updateConfig(config: Partial<CriticReflectorConfig>): Promise<void>;

  /**
   * 检查功能是否启用
   * Requirements: 21.1
   */
  isEnabled(): boolean;
}

// ==================== 规则进化系统 ====================

/**
 * 规则类型
 */
export type RuleType = 'constraint' | 'best_practice' | 'correction';

/**
 * 规则来源
 */
export interface RuleSource {
  type: 'manual' | 'feedback' | 'pattern' | 'system';
  refId?: string; // 关联的反馈 ID、模式 ID 等
  createdAt: number;
}

/**
 * 运维规则
 */
export interface OperationalRule {
  id: string;
  type: RuleType;
  /** 自然语言描述，用于 RAG 检索和 LLM 理解 */
  description: string;
  /** 触发条件（向量化后用于匹配上下文） */
  condition: string;
  /** 如果是 constraint，表示禁止的操作或参数 */
  constraint?: {
    toolName?: string;
    forbiddenParams?: string[];
  };
  /** 如果是 correction，表示修正后的建议 */
  correction?: string;
  /** 关联的上下文标签 */
  tags?: string[];
  source: RuleSource;
  confidence: number;
  usageCount: number;
  lastUsedAt?: number;
}

/**
 * 创建规则输入
 */
export interface CreateRuleInput {
  type: RuleType;
  description: string;
  condition: string;
  source: RuleSource;
  constraint?: OperationalRule['constraint'];
  correction?: string;
  tags?: string[];
  initialConfidence?: number;
}

/**
 * 规则检索结果
 */
export interface RuleRetrievalResult {
  rule: OperationalRule;
  similarity: number;
  relevance: string;
}

/**
 * 规则进化服务接口
 */
export interface IRuleEvolutionService {
  initialize(): Promise<void>;
  learnFromReflection(reflection: ReflectionResult): Promise<OperationalRule[]>;
  learnFromPattern(pattern: FaultPattern): Promise<OperationalRule[]>;
  findApplicableRules(context: string, limit?: number): Promise<RuleRetrievalResult[]>;
  createRule(input: CreateRuleInput): Promise<OperationalRule>;
  getAllRules(): Promise<OperationalRule[]>;
  recordRuleUsage(ruleId: string, helpful: boolean): Promise<void>;
  deleteRule(id: string): Promise<void>;
}
