/**
 * Evolution Frontend API 封装层
 * 
 * 提供智能进化系统、健康监控、异常预测、巡检报告的 API 调用
 * Requirements: evolution-frontend 6.1-6.9
 */

import api from './index'

// ==================== 统一响应类型 ====================

/** 统一 API 响应格式 */
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  pagination?: PaginationInfo
}

/** 分页信息 */
export interface PaginationInfo {
  page: number
  pageSize: number
  total: number
}

/** 分页请求参数 */
export interface PaginationParams {
  page?: number
  pageSize?: number
}

// ==================== 类型定义 ====================

/** 自动修复授权级别 */
export type AutoHealingLevel = 'disabled' | 'notify' | 'low_risk' | 'full'

/** 风险等级 */
export type RiskLevel = 'L1' | 'L2' | 'L3' | 'L4'

/** 反思配置 */
export interface ReflectionConfig {
  enabled: boolean
  maxRetries: number
  timeoutMs: number
}

/** 经验管理配置 */
export interface ExperienceConfig {
  enabled: boolean
  minScoreForRetrieval: number
  maxFewShotExamples: number
  autoApprove: boolean
}

/** 计划修订配置 */
export interface PlanRevisionConfig {
  enabled: boolean
  qualityThreshold: number
  maxAdditionalSteps: number
}

/** 工具反馈配置 */
export interface ToolFeedbackConfig {
  enabled: boolean
  metricsRetentionDays: number
  priorityOptimizationEnabled: boolean
}

/** 主动运维配置 */
export interface ProactiveOpsConfig {
  enabled: boolean
  healthCheckIntervalSeconds: number
  predictionTimeWindowMinutes: number
  predictionConfidenceThreshold: number
  inspectionIntervalHours: number
  contextAwareChatEnabled: boolean
}

/** 意图驱动配置 */
export interface IntentDrivenConfig {
  enabled: boolean
  confidenceThreshold: number
  confirmationTimeoutMinutes: number
  riskLevelForConfirmation: RiskLevel
}

/** 自愈配置 */
export interface SelfHealingConfig {
  enabled: boolean
  autoHealingLevel: AutoHealingLevel
  faultDetectionIntervalSeconds: number
  rootCauseAnalysisTimeoutSeconds: number
}

/** 持续学习配置 */
export interface ContinuousLearningConfig {
  enabled: boolean
  patternLearningEnabled: boolean
  patternLearningDelayDays: number
  bestPracticeThreshold: number
  strategyEvaluationIntervalDays: number
  knowledgeGraphUpdateIntervalHours: number
}

/** 分布式追踪配置 */
export interface TracingConfig {
  enabled: boolean
  traceRetentionDays: number
  longTaskThresholdMinutes: number
  heartbeatIntervalSeconds: number
  enableOpenTelemetryExport: boolean
}

/** Autonomous brain config */
export interface AutonomousBrainConfig {
  enabled: boolean
  tickIntervalMinutes: number
  dailyTokenBudget: number
  autoApproveHighRisk: boolean
}

/** 完整进化配置 */
export interface AIEvolutionConfig {
  reflection: ReflectionConfig
  experience: ExperienceConfig
  planRevision: PlanRevisionConfig
  toolFeedback: ToolFeedbackConfig
  proactiveOps: ProactiveOpsConfig
  intentDriven: IntentDrivenConfig
  selfHealing: SelfHealingConfig
  continuousLearning: ContinuousLearningConfig
  tracing: TracingConfig
  autonomousBrain: AutonomousBrainConfig
}

/** 能力状态摘要 */
export type CapabilityStatusSummary = Record<keyof AIEvolutionConfig, boolean>

/** 健康状态 */
export interface HealthStatus {
  score: number
  level: 'healthy' | 'warning' | 'critical' | 'unknown'
  dimensions: {
    system: number
    network: number
    performance: number
    reliability: number
  }
  issues: HealthIssue[]
  timestamp: number
}

/** 健康问题 */
export interface HealthIssue {
  id: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  suggestion?: string
}

/** 健康趋势数据点 */
export interface HealthTrendPoint {
  timestamp: number
  score: number
  level?: string
  dimensions?: {
    system: number
    network: number
    performance: number
    reliability: number
  }
}

/** 异常预测 */
export interface AnomalyPrediction {
  id: string
  metric: 'cpu' | 'memory' | 'disk'
  predictedTime: number
  confidence: number
  predictedValue: number
  currentValue: number
  severity: 'warning' | 'critical'
  analysis?: string
}

/** 巡检报告 */
export interface InspectionReport {
  id: string
  timestamp: number
  status: 'completed' | 'failed' | 'running'
  issueCount: number
  type?: string
  duration?: number
  results?: InspectionResult[]
}

/** 巡检结果 */
export interface InspectionResult {
  itemId: string
  itemName: string
  status: 'pass' | 'warning' | 'fail' | 'error'
  message: string
  issues?: InspectionIssue[]
  duration?: number
}

/** 巡检问题 */
export interface InspectionIssue {
  id: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  suggestion?: string
}

/** 学习条目（反思/经验） */
export interface LearningEntry {
  id: string
  type: 'reflection' | 'experience'
  learningType: 'learning'
  timestamp: number
  title: string
  content: string
  intent?: string
  originalMessage?: string
  confidence?: number
  iterationId?: string
  details?: {
    rootCause: string
    effectiveSolution?: string
    ineffectiveApproaches?: string[]
    contextFactors?: Record<string, string>
  }
}

// ==================== Evolution Config API ====================

export const evolutionConfigApi = {
  /** 获取当前配置 */
  getConfig: () =>
    api.get<ApiResponse<AIEvolutionConfig>>('/ai-ops/evolution/config', {
      timeout: 10000
    }),

  /** 更新配置 */
  updateConfig: (config: Partial<AIEvolutionConfig>) =>
    api.put<ApiResponse<AIEvolutionConfig>>('/ai-ops/evolution/config', config, {
      timeout: 15000
    }),

  /** 获取能力状态摘要 */
  getStatus: () =>
    api.get<ApiResponse<{ capabilities: CapabilityStatusSummary; systemLoad: { currentDegradationLevel: 'none' | 'moderate' | 'severe'; primaryBottleneck: string } | null }>>('/ai-ops/evolution/status', {
      timeout: 15000
    }),

  /** 获取工具统计 */
  getToolStats: (limit?: number) =>
    api.get<ApiResponse<any[]>>('/ai-ops/evolution/tool-stats', {
      params: { limit },
      timeout: 15000
    }),

  /** 查询学习条目 */
  queryLearning: (params?: { query?: string; pattern?: string; limit?: number }) =>
    api.get<ApiResponse<LearningEntry[]>>('/ai-ops/learning', {
      params,
      timeout: 15000
    }),

  /** 启用能力 */
  enableCapability: (name: keyof AIEvolutionConfig) =>
    api.post<ApiResponse<AIEvolutionConfig>>(`/ai-ops/evolution/capability/${name}/enable`, null, {
      timeout: 10000
    }),

  /** 禁用能力 */
  disableCapability: (name: keyof AIEvolutionConfig) =>
    api.post<ApiResponse<AIEvolutionConfig>>(`/ai-ops/evolution/capability/${name}/disable`, null, {
      timeout: 10000
    }),
}

// ==================== Health Monitor API ====================

export const healthApi = {
  /** 获取当前健康状态 */
  getCurrent: (deviceId?: string) =>
    api.get<ApiResponse<HealthStatus>>('/ai-ops/health/current', {
      params: { deviceId },
      timeout: 30000
    }),

  /** 获取健康趋势 */
  getTrend: (range: '1h' | '6h' | '24h' | '7d', deviceId?: string) =>
    api.get<ApiResponse<HealthTrendPoint[]>>('/ai-ops/health/trend', {
      params: { range, deviceId },
      timeout: 30000
    }),
}

// ==================== Anomaly Prediction API ====================

export const anomalyApi = {
  /** 获取异常预测列表 */
  getPredictions: () =>
    api.get<ApiResponse<AnomalyPrediction[]>>('/ai-ops/anomaly/predictions', {
      timeout: 30000
    }),
}

// ==================== Inspection API (已移除，统一使用健康报告) ====================
// 巡检报告已合并到健康报告页面 (/ai-ops/reports)

// ==================== 工具函数 ====================

/** 获取健康分数对应的颜色 */
export function getHealthColor(score: number): string {
  if (score >= 80) return '#67c23a' // 绿色
  if (score >= 60) return '#e6a23c' // 黄色
  return '#f56c6c' // 红色
}

/** 获取健康等级标签 */
export function getHealthLabel(score: number): string {
  if (score >= 80) return '健康'
  if (score >= 60) return '警告'
  return '危险'
}

/** 按严重程度排序预测列表 */
export function sortPredictionsBySeverity(predictions: AnomalyPrediction[]): AnomalyPrediction[] {
  return [...predictions].sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1 }
    return severityOrder[a.severity] - severityOrder[b.severity]
  })
}

/** 能力模块元数据 */
export interface CapabilityMeta {
  key: keyof AIEvolutionConfig
  name: string
  description: string
  icon: string
}

/** 能力模块元数据定义 */
export const CAPABILITY_METADATA: CapabilityMeta[] = [
  {
    key: 'reflection',
    name: '反思与自我修正',
    description: '启用 AI 的反思能力，在执行失败时自动分析原因并重试',
    icon: 'Refresh'
  },
  {
    key: 'experience',
    name: '经验管理',
    description: '管理长短期记忆，提取和复用历史经验',
    icon: 'Collection'
  },
  {
    key: 'planRevision',
    name: '计划动态修订',
    description: '根据执行情况动态调整执行计划',
    icon: 'Edit'
  },
  {
    key: 'toolFeedback',
    name: '工具反馈闭环',
    description: '收集工具使用反馈，优化工具选择',
    icon: 'Tools'
  },
  {
    key: 'proactiveOps',
    name: '主动式运维',
    description: '主动监控系统健康，预测异常，定期巡检',
    icon: 'Monitor'
  },
  {
    key: 'intentDriven',
    name: '意图驱动自动化',
    description: '理解用户意图，自动执行运维操作',
    icon: 'Aim'
  },
  {
    key: 'selfHealing',
    name: '自愈能力',
    description: '自动检测故障并执行修复操作',
    icon: 'FirstAidKit'
  },
  {
    key: 'continuousLearning',
    name: '持续学习',
    description: '从操作中学习，持续优化策略',
    icon: 'TrendCharts'
  },
  {
    key: 'tracing',
    name: '分布式追踪',
    description: '追踪任务执行过程，支持问题排查',
    icon: 'Connection'
  },
  {
    key: 'autonomousBrain',
    name: 'Autonomous Brain',
    description: 'Enable global inspection, risk decisions, and autonomous planning controls.',
    icon: 'Cpu'
  }
]

/** 时间范围选项 */
export const TIME_RANGE_OPTIONS = [
  { label: '1 小时', value: '1h' as const },
  { label: '6 小时', value: '6h' as const },
  { label: '24 小时', value: '24h' as const },
  { label: '7 天', value: '7d' as const }
]


// ==================== Prompt Template Types ====================

/** Prompt 模板 */
export interface PromptTemplate {
  id: string
  name: string
  content: string
  description?: string
  category?: string
  placeholders: string[]
  isDefault: boolean
  createdAt: string
  updatedAt: string
  /** 使用位置（后端服务名称） - 用于展示该模板在哪些地方被使用 */
  usageLocation?: string
}

/** 模板使用位置映射 - 显示每个模板在后端的使用位置 */
export const TEMPLATE_USAGE_LOCATIONS: Record<string, string> = {
  'ReAct 循环基础提示词': 'ReAct 循环控制器 (reactLoopController)',
  '知识优先 ReAct 提示词': 'ReAct 循环控制器 - 知识增强模式',
  '并行执行 ReAct 提示词': 'ReAct 循环控制器 - 并行执行模式',
  '响应生成提示词': '响应生成器 (responseGenerator)',
  '查询改写提示词': '查询改写器 (queryRewriter)',
  '意图分析提示词': '意图分析器 (intentAnalyzer)',
  '元数据增强提示词': '元数据增强器 (metadataEnhancer)',
  'RouterOS 系统提示词': 'AI 对话系统提示词 (设备通用)',
  '知识库检索提示词': '知识库检索增强',
  '告警分析提示词': 'AI-OPS 告警分析',
  '修复方案生成提示词': '修复方案生成',
  '知识增强提示词模板': 'RAG 知识注入',

  // 新增：分析类 Prompt 使用位置
  '批量告警分析提示词': 'AI-OPS 批量告警分析 (aiAnalyzer.batchAlertAnalysis)',
  '健康报告分析提示词': 'AI-OPS 健康报告分析 (aiAnalyzer.healthReportAnalysis)',
  '配置变更分析提示词': 'AI-OPS 配置变更分析 (aiAnalyzer.configDiffAnalysis)',
  '故障诊断提示词': 'AI-OPS 故障诊断 (aiAnalyzer.faultDiagnosis)',

  // 新增：模块子模板使用位置
  '[模块化] BasePersona - 统一人设': '所有 Prompt 的角色定义模块',
  '[模块化] APISafety - API 安全规则': 'ReAct Prompt 的 API 路径安全规则',
  '[模块化] ReActFormat - ReAct 格式': 'ReAct Prompt 的格式规范',
  '[模块化] BatchProtocol - 分批协议': 'ReAct Prompt 的分批处理协议',
  '[模块化] KnowledgeGuide - 知识指引': '知识优先 ReAct Prompt 的知识库使用指引',
  '[模块化] ChainOfThought - 推理链': '分析类 Prompt 的推理步骤模块',
}

/** 模板分类枚举 */
export type TemplateCategory = 'system' | 'chat' | 'analysis' | 'remediation' | 'custom'

/** 占位符定义 */
export interface PlaceholderDefinition {
  name: string
  label: string
  description: string
  defaultValue?: string
}

/** 渲染上下文 */
export interface RenderContext {
  [key: string]: unknown
}

/** 模板分类选项 */
export const TEMPLATE_CATEGORY_OPTIONS = [
  { label: '全部', value: '' },
  { label: '系统', value: 'system' },
  { label: '对话', value: 'chat' },
  { label: '分析', value: 'analysis' },
  { label: '修复', value: 'remediation' },
  { label: 'ReAct', value: 'react' },
  { label: 'RAG', value: 'rag' },
  { label: '模块', value: 'module' },
  { label: '自定义', value: 'custom' }
]

/** 模板覆盖配置 */
export interface TemplateOverrides {
  /** 系统模板名称 -> 自定义模板ID */
  [systemTemplateName: string]: string
}

// ==================== Prompt Template API ====================

export const templateApi = {
  /** 获取所有模板（支持分页、筛选和搜索） */
  getAll: (params?: PaginationParams & { category?: string; search?: string }) =>
    api.get<ApiResponse<PromptTemplate[]>>('/prompt-templates', {
      params: params ? {
        page: params.page || 1,
        pageSize: params.pageSize || 10,
        category: params.category,
        search: params.search
      } : undefined,
      timeout: 30000
    }),

  /** 获取单个模板 */
  getById: (id: string) =>
    api.get<ApiResponse<PromptTemplate>>(`/prompt-templates/${id}`, {
      timeout: 30000
    }),

  /** 创建模板 */
  create: (template: Omit<PromptTemplate, 'id' | 'placeholders' | 'createdAt' | 'updatedAt'>) =>
    api.post<ApiResponse<PromptTemplate>>('/prompt-templates', template, {
      timeout: 30000
    }),

  /** 更新模板 */
  update: (id: string, template: Partial<Omit<PromptTemplate, 'id' | 'placeholders' | 'createdAt' | 'updatedAt'>>) =>
    api.put<ApiResponse<PromptTemplate>>(`/prompt-templates/${id}`, template, {
      timeout: 30000
    }),

  /** 删除模板 */
  delete: (id: string) =>
    api.delete<ApiResponse<void>>(`/prompt-templates/${id}`, {
      timeout: 30000
    }),

  /** 获取可用占位符 */
  getPlaceholders: () =>
    api.get<ApiResponse<PlaceholderDefinition[]>>('/prompt-templates/placeholders', {
      timeout: 30000
    }),

  /** 渲染模板预览 */
  render: (id: string, context: RenderContext) =>
    api.post<ApiResponse<{ content: string }>>(`/prompt-templates/${id}/render`, context, {
      timeout: 30000
    }),

  /** 获取默认模板 */
  getDefault: (category?: string) =>
    api.get<ApiResponse<PromptTemplate>>('/prompt-templates/default', {
      params: category ? { category } : undefined,
      timeout: 30000
    }),

  /** 设置默认模板 */
  setDefault: (id: string) =>
    api.post<ApiResponse<void>>(`/prompt-templates/${id}/default`, null, {
      timeout: 30000
    }),

  /** 获取所有模板覆盖配置 */
  getOverrides: () =>
    api.get<ApiResponse<TemplateOverrides>>('/prompt-templates/overrides', {
      timeout: 30000
    }),

  /** 设置模板覆盖（用自定义模板替代系统模板） */
  setOverride: (systemTemplateName: string, customTemplateId: string) =>
    api.post<ApiResponse<TemplateOverrides>>('/prompt-templates/overrides', {
      systemTemplateName,
      customTemplateId
    }, {
      timeout: 30000
    }),

  /** 清除模板覆盖（恢复使用系统模板） */
  clearOverride: (systemTemplateName: string) =>
    api.delete<ApiResponse<TemplateOverrides>>(`/prompt-templates/overrides/${encodeURIComponent(systemTemplateName)}`, {
      timeout: 30000
    }),
}
