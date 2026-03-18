/**
 * RAG 智能检索增强 API 客户端
 * 前端 RAG 服务 API 客户端，实现与后端 RAG 服务的通信
 *
 * 功能：
 * - 知识库管理
 * - 向量数据库管理
 * - 嵌入服务管理
 * - RAG 查询
 * - Agent 对话
 * - 增强分析
 *
 * Requirements: 10.1-12.7
 */

import api from './index'

// ==================== 类型定义 ====================

/**
 * 知识条目类型
 * - alert: 告警历史记录
 * - remediation: 修复方案
 * - config: 配置知识
 * - pattern: 故障模式
 * - manual: 手动添加的知识
 * - feedback: 用户反馈（自动索引）
 */
export type KnowledgeEntryType = 'alert' | 'remediation' | 'config' | 'pattern' | 'manual' | 'feedback' | 'learning'

/**
 * 知识条目元数据
 */
export interface KnowledgeMetadata {
  source: string
  timestamp: number
  category: string
  tags: string[]
  usageCount: number
  feedbackScore: number
  feedbackCount: number
  lastUsed?: number
  relatedIds?: string[]
  originalData?: Record<string, unknown>
  // 规则关联
  linkedRuleIds?: string[]
  // 反馈来源追踪
  createdFromFeedback?: boolean
  feedbackSourceId?: string
  // 对话来源追溯
  createdFromConversation?: boolean
  sourceSessionId?: string
  sourceMessageIds?: string[]
}

/**
 * 知识条目
 */
export interface KnowledgeEntry {
  id: string
  type: KnowledgeEntryType
  title: string
  content: string
  metadata: KnowledgeMetadata
  createdAt?: number
  updatedAt?: number
  version?: number
}

/**
 * 知识条目搜索结果
 */
export interface KnowledgeSearchResult {
  entry: KnowledgeEntry
  score: number
  highlights?: string[]
}

/**
 * 知识库统计
 */
export interface KnowledgeStats {
  totalEntries: number
  byType: Record<string, number>
  byCategory: Record<string, number>
  recentAdditions: number
  staleEntries: number
  averageFeedbackScore: number
}

/**
 * 知识查询参数
 */
export interface KnowledgeQuery {
  query: string
  type?: KnowledgeEntryType
  category?: string
  tags?: string[]
  dateRange?: { from: number; to: number }
  limit?: number
  minScore?: number
}

/**
 * 创建知识条目输入
 */
export interface CreateKnowledgeEntryInput {
  type: KnowledgeEntryType
  title: string
  content: string
  metadata?: Partial<KnowledgeMetadata>
}

/**
 * 更新知识条目输入
 */
export type UpdateKnowledgeEntryInput = Partial<Omit<KnowledgeEntry, 'id'>>

/**
 * 向量数据库集合统计
 */
export interface CollectionStats {
  name: string
  documentCount: number
  indexSize: number
  lastUpdated: number
}

/**
 * 向量数据库统计
 */
export interface VectorDatabaseStats {
  collections: CollectionStats[]
  totalSize: number
}

/**
 * 嵌入服务提供商
 */
export type EmbeddingProvider = 'openai' | 'gemini' | 'deepseek' | 'qwen' | 'zhipu'

/**
 * 嵌入服务配置
 */
export interface EmbeddingConfig {
  provider: EmbeddingProvider
  model?: string
  dimensions?: number
  batchSize?: number
  cacheEnabled?: boolean
  cacheTtlMs?: number
}

/**
 * 嵌入缓存统计
 */
export interface EmbeddingCacheStats {
  size: number
  hitRate: number
}

/**
 * RAG 配置
 */
export interface RAGConfig {
  topK: number
  minScore: number
  recencyWeight: number
  maxContextLength: number
  includeMetadata: boolean
}

/**
 * RAG 统计
 */
export interface RAGStats {
  queriesProcessed: number
  avgRetrievalTime: number
  avgRelevanceScore: number
}

/**
 * RAG 上下文
 */
export interface RAGContext {
  query: string
  retrievedDocuments: KnowledgeSearchResult[]
  retrievalTime: number
  candidatesConsidered: number
}

/**
 * RAG 引用
 */
export interface RAGCitation {
  entryId: string
  title: string
  relevance: number
  excerpt: string
}

/**
 * RAG 响应
 */
export interface RAGResponse {
  answer: string
  context: RAGContext
  citations: RAGCitation[]
  confidence: number
}

/**
 * Agent 工具调用
 */
export interface AgentToolCall {
  tool: string
  input: Record<string, unknown>
  output: unknown
  duration: number
}

/**
 * Agent 响应
 */
export interface AgentResponse {
  message: string
  reasoning: string[]
  toolCalls: AgentToolCall[]
  confidence: number
  sessionId?: string
}

/**
 * Agent 会话摘要
 */
export interface AgentSessionSummary {
  sessionId: string
  messageCount: number
  createdAt: number
  lastUpdated: number
}

/**
 * Agent 消息
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  toolResults?: Array<{
    id: string
    result: unknown
  }>
}

/**
 * Agent 会话详情
 */
export interface AgentSession {
  sessionId: string
  messages: AgentMessage[]
  context: Record<string, unknown>
  createdAt: number
  lastUpdated: number
}

/**
 * Agent 工具描述
 */
export interface AgentToolDescription {
  name: string
  description: string
  parameters: Record<string, {
    type: string
    description: string
    required?: boolean
  }>
}

/**
 * Agent 配置
 */
export interface AgentConfig {
  maxIterations: number
  maxTokens: number
  temperature: number
  toolCount: number
}

/**
 * Agent 统计
 */
export interface AgentStats {
  totalChats: number
  totalTasks: number
  totalToolCalls: number
  avgResponseTime: number
}

/**
 * 历史告警引用
 */
export interface HistoricalAlertReference {
  alertId: string
  similarity: number
  resolution?: string
  outcome?: 'success' | 'partial' | 'failed'
}

/**
 * 告警类别
 * Requirements: 1.1, 1.2 - 告警初步分析与分类
 */
export type AlertCategory = 'interface' | 'traffic' | 'resource' | 'security' | 'other'

/**
 * 告警分类结果
 * Requirements: 1.1, 1.2, 1.3 - 告警初步分析与分类
 */
export interface AlertClassification {
  /** 指标类型: interface_status, traffic, cpu, memory, disk 等 */
  metricType: string
  /** 告警类别: interface, traffic, resource, security, other */
  category: AlertCategory
  /** 严重级别 */
  severity: string
  /** 关键词列表 */
  keywords: string[]
  /** 分类置信度 (0-1) */
  confidence: number
}

/**
 * 历史参考状态
 * Requirements: 5.1, 5.2 - 分析结果展示增强
 * - 'found': 找到相同类型的历史参考
 * - 'not_found': 未找到任何历史参考
 * - 'type_mismatch': 仅找到不同类型的历史参考（跨类型搜索结果）
 */
export type ReferenceStatus = 'found' | 'not_found' | 'type_mismatch'

/**
 * 风险等级
 */
export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * 可执行修复步骤
 * 由 LLM 在 RAG 分析时生成
 */
export interface ExecutableStep {
  /** 步骤序号 */
  order: number
  /** 步骤描述 */
  description: string
  /** 设备命令 */
  command: string
  /** 风险等级 */
  riskLevel: RiskLevel
  /** 是否可自动执行 */
  autoExecutable: boolean
  /** 预估执行时间（秒） */
  estimatedDuration: number
}

/**
 * 增强告警分析结果
 * Requirements: 5.1, 5.2 - 分析结果展示增强
 */
export interface EnhancedAlertAnalysis {
  analysis: unknown
  ragContext: RAGContext
  historicalReferences: HistoricalAlertReference[]
  /** 是否有历史参考 - Requirement 5.1 */
  hasHistoricalReference: boolean
  /** 参考状态 - Requirement 5.2 */
  referenceStatus: ReferenceStatus
  /** 告警分类结果 - Requirements 1.1-1.3 */
  classification: AlertClassification
  /** 可执行修复步骤 - 由 LLM 生成 */
  executableSteps?: ExecutableStep[]
}

/**
 * 历史修复方案引用
 */
export interface HistoricalPlanReference {
  planId: string
  similarity: number
  successRate: number
  adaptations?: string[]
}

/**
 * 增强修复方案
 */
export interface EnhancedRemediationPlan {
  plan: unknown
  ragContext: RAGContext
  historicalPlans: HistoricalPlanReference[]
}

/**
 * 配置风险评估结果
 */
export interface ConfigRiskAssessment {
  riskScore: number
  historicalOutcomes: Array<{ changeType: string; outcome: string; count: number }>
  warnings: string[]
  suggestions: string[]
}

// ==================== API 响应类型 ====================

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
  total?: number
}

// ==================== 知识库 API ====================

export const knowledgeApi = {
  /**
   * 获取知识条目列表
   */
  getAll: (options?: {
    type?: KnowledgeEntryType
    category?: string
    tags?: string
    from?: number
    to?: number
    limit?: number
    page?: number
    pageSize?: number
  }) =>
    api.get<ApiResponse<KnowledgeEntry[]>>('/ai-ops/rag/knowledge', { params: options }),

  /**
   * 获取单个知识条目
   */
  getById: (id: string) =>
    api.get<ApiResponse<KnowledgeEntry>>(`/ai-ops/rag/knowledge/${id}`),

  /**
   * 添加知识条目
   */
  create: (entry: CreateKnowledgeEntryInput) =>
    api.post<ApiResponse<KnowledgeEntry>>('/ai-ops/rag/knowledge', entry),

  /**
   * 更新知识条目
   */
  update: (id: string, updates: UpdateKnowledgeEntryInput) =>
    api.put<ApiResponse<KnowledgeEntry>>(`/ai-ops/rag/knowledge/${id}`, updates),

  /**
   * 删除知识条目
   */
  delete: (id: string) =>
    api.delete<ApiResponse<void>>(`/ai-ops/rag/knowledge/${id}`),

  /**
   * 语义检索
   */
  search: (query: KnowledgeQuery) =>
    api.post<ApiResponse<KnowledgeSearchResult[]>>('/ai-ops/rag/knowledge/search', query),

  /**
   * 批量添加
   */
  bulkCreate: (entries: CreateKnowledgeEntryInput[]) =>
    api.post<ApiResponse<KnowledgeEntry[]>>('/ai-ops/rag/knowledge/bulk', { entries }),

  /**
   * 批量删除
   */
  bulkDelete: (ids: string[]) =>
    api.delete<ApiResponse<void>>('/ai-ops/rag/knowledge/bulk', { data: { ids } }),

  /**
   * 获取统计信息
   */
  getStats: () =>
    api.get<ApiResponse<KnowledgeStats>>('/ai-ops/rag/knowledge/stats'),

  /**
   * 导出知识
   */
  export: (filter?: Partial<KnowledgeQuery>) =>
    api.post<ApiResponse<KnowledgeEntry[]>>('/ai-ops/rag/knowledge/export', filter || {}),

  /**
   * 导入知识
   */
  import: (entries: KnowledgeEntry[]) =>
    api.post<ApiResponse<{ success: number; failed: number }>>('/ai-ops/rag/knowledge/import', { entries }),

  /**
   * 提交反馈
   */
  submitFeedback: (id: string, score: number) =>
    api.post<ApiResponse<void>>(`/ai-ops/rag/knowledge/${id}/feedback`, { score }),

  /**
   * 重建索引
   */
  reindex: () =>
    api.post<ApiResponse<void>>('/ai-ops/rag/knowledge/reindex')
}

// ==================== 向量数据库 API ====================

export const vectorApi = {
  /**
   * 获取统计信息
   */
  getStats: () =>
    api.get<ApiResponse<VectorDatabaseStats>>('/ai-ops/rag/vector/stats'),

  /**
   * 获取集合列表
   */
  getCollections: () =>
    api.get<ApiResponse<string[]>>('/ai-ops/rag/vector/collections'),

  /**
   * 向量检索
   */
  search: (collection: string, query: string, topK?: number, minScore?: number) =>
    api.post<ApiResponse<unknown[]>>('/ai-ops/rag/vector/search', {
      collection,
      query,
      topK,
      minScore
    })
}

// ==================== 嵌入服务 API ====================

export const embeddingApi = {
  /**
   * 获取配置
   */
  getConfig: () =>
    api.get<ApiResponse<EmbeddingConfig>>('/ai-ops/rag/embedding/config'),

  /**
   * 更新配置
   */
  updateConfig: (config: Partial<EmbeddingConfig>) =>
    api.put<ApiResponse<EmbeddingConfig>>('/ai-ops/rag/embedding/config', config),

  /**
   * 生成嵌入向量
   */
  embed: (text: string) =>
    api.post<ApiResponse<{ text: string; vector: number[]; model: string; dimensions: number; cached: boolean }>>('/ai-ops/rag/embedding/embed', { text }),

  /**
   * 批量生成嵌入向量
   */
  embedBatch: (texts: string[]) =>
    api.post<ApiResponse<Array<{ text: string; vector: number[]; model: string; dimensions: number; cached: boolean }>>>('/ai-ops/rag/embedding/embed', { texts }),

  /**
   * 获取缓存统计
   */
  getCacheStats: () =>
    api.get<ApiResponse<EmbeddingCacheStats>>('/ai-ops/rag/embedding/cache/stats'),

  /**
   * 清空缓存
   */
  clearCache: () =>
    api.post<ApiResponse<void>>('/ai-ops/rag/embedding/cache/clear')
}

// ==================== RAG 引擎 API ====================

export const ragApi = {
  /**
   * RAG 查询
   */
  query: (question: string, context?: Record<string, unknown>) =>
    api.post<ApiResponse<RAGResponse>>('/ai-ops/rag/query', { question, context }),

  /**
   * 获取配置
   */
  getConfig: () =>
    api.get<ApiResponse<RAGConfig>>('/ai-ops/rag/config'),

  /**
   * 更新配置
   */
  updateConfig: (config: Partial<RAGConfig>) =>
    api.put<ApiResponse<RAGConfig>>('/ai-ops/rag/config', config),

  /**
   * 获取统计
   */
  getStats: () =>
    api.get<ApiResponse<RAGStats>>('/ai-ops/rag/stats')
}

// ==================== Agent API ====================

export const agentApi = {
  /**
   * Agent 对话
   */
  chat: (message: string, sessionId?: string) =>
    api.post<ApiResponse<AgentResponse>>('/ai-ops/rag/agent/chat', { message, sessionId }),

  /**
   * 执行任务
   */
  executeTask: (task: string, context?: Record<string, unknown>) =>
    api.post<ApiResponse<AgentResponse>>('/ai-ops/rag/agent/task', { task, context }),

  /**
   * 获取会话列表
   */
  getSessions: () =>
    api.get<ApiResponse<AgentSessionSummary[]>>('/ai-ops/rag/agent/sessions'),

  /**
   * 获取会话详情
   */
  getSession: (sessionId: string) =>
    api.get<ApiResponse<AgentSession>>(`/ai-ops/rag/agent/sessions/${sessionId}`),

  /**
   * 创建会话
   */
  createSession: () =>
    api.post<ApiResponse<{ sessionId: string; createdAt: number }>>('/ai-ops/rag/agent/sessions'),

  /**
   * 删除会话
   */
  deleteSession: (sessionId: string) =>
    api.delete<ApiResponse<void>>(`/ai-ops/rag/agent/sessions/${sessionId}`),

  /**
   * 获取可用工具
   */
  getTools: () =>
    api.get<ApiResponse<AgentToolDescription[]>>('/ai-ops/rag/agent/tools'),

  /**
   * 获取配置
   */
  getConfig: () =>
    api.get<ApiResponse<AgentConfig>>('/ai-ops/rag/agent/config'),

  /**
   * 更新配置
   */
  updateConfig: (config: Partial<AgentConfig>) =>
    api.put<ApiResponse<AgentConfig>>('/ai-ops/rag/agent/config', config),

  /**
   * 获取统计
   */
  getStats: () =>
    api.get<ApiResponse<AgentStats>>('/ai-ops/rag/agent/stats')
}

// ==================== 增强分析 API ====================

export const analyzeApi = {
  /**
   * RAG 增强告警分析
   * @param alertId 告警 ID
   * @param alertEvent 告警事件
   * @param metrics 系统指标（可选）
   */
  analyzeAlert: (alertId: string, alertEvent: unknown, metrics?: unknown) =>
    api.post<ApiResponse<EnhancedAlertAnalysis>>(`/ai-ops/rag/analyze/alert/${alertId}`, {
      alertEvent,
      metrics
    }),

  /**
   * RAG 增强修复方案生成
   */
  generateRemediation: (analysis: unknown) =>
    api.post<ApiResponse<EnhancedRemediationPlan>>('/ai-ops/rag/analyze/remediation', { analysis }),

  /**
   * 配置变更风险评估
   */
  assessConfigRisk: (diff: unknown) =>
    api.post<ApiResponse<ConfigRiskAssessment>>('/ai-ops/rag/analyze/config-risk', { diff }),

  /**
   * RAG 增强根因分析
   */
  analyzeRootCause: (event: unknown) =>
    api.post<ApiResponse<unknown>>('/ai-ops/rag/analyze/root-cause', { event })
}

// ==================== 文件上传类型定义 ====================

/**
 * 文件类型信息
 */
export interface FileTypeInfo {
  extension: string
  mimeTypes: string[]
  description: string
  maxSize: number
}

/**
 * 处理后的文件结果
 */
export interface ProcessedFileResult {
  success: boolean
  filename: string
  entries: KnowledgeEntry[]
  warnings?: string[]
  error?: string
}

/**
 * 上传进度信息
 */
export interface UploadProgress {
  id: string
  filename: string
  status: 'pending' | 'uploading' | 'processing' | 'completed' | 'failed'
  progress: number
  message?: string
  result?: ProcessedFileResult
  startedAt: number
  completedAt?: number
}

/**
 * 批量上传响应
 */
interface BatchUploadResponse {
  success: boolean
  data?: ProcessedFileResult[]
  summary?: {
    total: number
    success: number
    failed: number
    entriesCreated: number
  }
  error?: string
  progressId?: string
}

/**
 * 单文件上传响应
 */
interface SingleUploadResponse {
  success: boolean
  data?: ProcessedFileResult
  error?: string
  progressId?: string
}

// ==================== 文件上传 API ====================

export const fileUploadApi = {
  /**
   * 获取支持的文件类型
   */
  getSupportedTypes: () =>
    api.get<ApiResponse<FileTypeInfo[]>>('/ai-ops/rag/knowledge/upload/types'),

  /**
   * 验证文件
   */
  validateFiles: (files: File[]) => {
    const formData = new FormData()
    files.forEach(file => formData.append('files', file))
    return api.post<ApiResponse<Array<{ filename: string; valid: boolean; error?: string }>>>(
      '/ai-ops/rag/knowledge/upload/validate',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    )
  },

  /**
   * 上传单个文件
   */
  uploadFile: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post<SingleUploadResponse>(
      '/ai-ops/rag/knowledge/upload',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    )
  },

  /**
   * 批量上传文件
   */
  uploadFiles: (files: File[]) => {
    const formData = new FormData()
    files.forEach(file => formData.append('files', file))
    return api.post<BatchUploadResponse>(
      '/ai-ops/rag/knowledge/upload/batch',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    )
  },

  /**
   * 获取上传进度
   */
  getProgress: (progressId: string) =>
    api.get<ApiResponse<UploadProgress>>(`/ai-ops/rag/knowledge/upload/progress/${progressId}`)
}

// ==================== 知识-规则关联类型定义 ====================

/**
 * 规则-知识关联建议
 * Requirements: 6.4
 */
export interface RuleKnowledgeSuggestion {
  entryId: string
  title: string
  type: KnowledgeEntryType
  similarity: number
  excerpt: string
}

/**
 * 知识条目效果指标
 * Requirements: 6.5
 */
export interface KnowledgeEffectiveness {
  entryId: string
  usageCount: number
  resolvedAlerts: number
  avgResolutionTime: number
  successRate: number
  lastUsed?: number
}

// ==================== 知识-规则关联管理 API ====================

/**
 * 知识-规则关联管理 API
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */
export const associationApi = {
  /**
   * 关联知识条目与告警规则
   * Requirements: 6.1
   */
  linkToRule: (entryId: string, ruleId: string) =>
    api.post<ApiResponse<void>>(`/ai-ops/rag/knowledge/${entryId}/link-rule`, { ruleId }),

  /**
   * 取消关联
   * Requirements: 6.1
   */
  unlinkFromRule: (entryId: string, ruleId: string) =>
    api.delete<ApiResponse<void>>(`/ai-ops/rag/knowledge/${entryId}/link-rule/${ruleId}`),

  /**
   * 获取规则关联的知识条目
   * Requirements: 6.2
   */
  getEntriesByRule: (ruleId: string) =>
    api.get<ApiResponse<KnowledgeEntry[]>>(`/ai-ops/rag/knowledge/by-rule/${ruleId}`),

  /**
   * 获取知识条目关联的规则
   * Requirements: 6.3
   */
  getRulesByEntry: (entryId: string) =>
    api.get<ApiResponse<string[]>>(`/ai-ops/rag/knowledge/${entryId}/rules`),

  /**
   * 基于内容相似度建议关联
   * Requirements: 6.4
   */
  suggestAssociations: (ruleId: string, limit?: number) =>
    api.get<ApiResponse<RuleKnowledgeSuggestion[]>>(`/ai-ops/rag/knowledge/suggest-for-rule/${ruleId}`, {
      params: { limit: limit || 5 }
    }),

  /**
   * 获取知识条目效果指标
   * Requirements: 6.5
   */
  getEffectiveness: (entryId: string) =>
    api.get<ApiResponse<KnowledgeEffectiveness>>(`/ai-ops/rag/knowledge/${entryId}/effectiveness`),

  /**
   * 批量关联知识条目与规则
   * Requirements: 6.1
   */
  bulkLinkToRule: (entryIds: string[], ruleId: string) =>
    api.post<ApiResponse<{ success: number; failed: number }>>('/ai-ops/rag/knowledge/bulk-link-rule', {
      entryIds,
      ruleId
    }),

  /**
   * 从反馈创建知识条目
   * Requirements: 5.5, 5.6
   */
  createFromFeedback: (data: {
    ruleId: string
    title: string
    content: string
    category?: string
    tags?: string[]
    linkToRule?: boolean
  }) =>
    api.post<ApiResponse<KnowledgeEntry>>('/ai-ops/rag/knowledge/from-feedback', data)
}

// ==================== 导出统一 API 对象 ====================

export const ragApiClient = {
  knowledge: knowledgeApi,
  vector: vectorApi,
  embedding: embeddingApi,
  rag: ragApi,
  agent: agentApi,
  analyze: analyzeApi,
  fileUpload: fileUploadApi,
  association: associationApi
}

export default ragApiClient
