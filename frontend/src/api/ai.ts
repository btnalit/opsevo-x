/**
 * AI Agent Client API
 * 前端 AI 服务 API 客户端，实现与后端 AI 服务的通信
 *
 * 功能：
 * - API 配置管理（CRUD、默认提供商、连接测试）
 * - 聊天功能（流式/非流式响应）
 * - 脚本执行（执行、验证、历史记录）
 * - 会话管理（CRUD、消息、导出）
 *
 * Requirements: 2.3
 */

import { useAuthStore } from '@/stores/auth'
import { useDeviceStore } from '@/stores/device'
import api from './index'

// ==================== 类型定义 ====================

/**
 * AI 服务提供商类型
 */
export enum AIProvider {
  OPENAI = 'openai',
  GEMINI = 'gemini',
  CLAUDE = 'claude',
  DEEPSEEK = 'deepseek',
  QWEN = 'qwen',
  ZHIPU = 'zhipu',
  OLLAMA = 'ollama',
  CUSTOM = 'custom'
}

/**
 * 聊天消息角色
 */
export type ChatRole = 'system' | 'user' | 'assistant'

/**
 * 聊天消息
 */
export interface ChatMessage {
  role: ChatRole
  content: string
}

/**
 * API 配置显示类型（API Key 已掩码）
 */
export interface APIConfigDisplay {
  id: string
  provider: AIProvider
  name: string
  apiKeyMasked: string
  endpoint?: string
  model: string
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * 创建 API 配置的输入类型
 */
export interface CreateAPIConfigInput {
  provider: AIProvider
  name: string
  apiKey: string
  endpoint?: string
  model: string
  isDefault?: boolean
}

/**
 * 更新 API 配置的输入类型
 */
export interface UpdateAPIConfigInput {
  provider?: AIProvider
  name?: string
  apiKey?: string
  endpoint?: string
  model?: string
  isDefault?: boolean
}

/**
 * 提供商信息
 */
export interface ProviderInfo {
  id: AIProvider
  name: string
  defaultEndpoint: string
  defaultModels: string[]
}

/**
 * 聊天会话
 */
export interface ChatSession {
  id: string
  title: string
  provider: AIProvider
  model: string
  mode?: 'standard' | 'knowledge-enhanced'
  messages: ChatMessage[]
  createdAt: Date
  updatedAt: Date
}

/**
 * 脚本执行结果
 */
export interface ScriptExecuteResult {
  success: boolean
  output?: string
  error?: string
  executedAt: Date
}

/**
 * 脚本执行历史记录
 */
export interface ScriptHistory {
  id: string
  script: string
  result: ScriptExecuteResult
  sessionId: string
  createdAt: Date
}

/**
 * 脚本验证结果
 */
export interface ScriptValidationResult {
  valid: boolean
  errors?: string[]
  dangerousCommands?: string[]
  hasDangerousCommands?: boolean
}

/**
 * 设备上下文
 */
export interface DeviceContext {
  deviceId?: string
  deviceName?: string
  driverType?: string
  capabilities?: string[]
  connectionStatus: {
    connected: boolean
    host: string
    version?: string
  }
  systemInfo?: {
    identity: string
    boardName: string
    version: string
    uptime: string
  }
  selectedConfigs?: {
    type: string
    data: unknown
  }[]
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * 聊天响应
 */
export interface ChatResponseData {
  content: string
  usage?: TokenUsage
}

/**
 * 连接测试结果
 */
export interface ConnectionTestResult {
  connected: boolean
  message: string
}

/**
 * SSE 流式响应数据
 */
export interface StreamChunk {
  content?: string
  done?: boolean
  fullContent?: string
  error?: string
}

/**
 * SSE 流式响应回调
 */
export interface StreamCallbacks {
  onChunk?: (chunk: string) => void
  onComplete?: (fullContent: string) => void
  onError?: (error: string) => void
}

// ==================== API 响应类型 ====================

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  message?: string
  retryAfter?: number
}

// ==================== 提供商 API ====================

export const providerApi = {
  /**
   * 获取所有支持的提供商
   */
  getAll: () => api.get<ApiResponse<ProviderInfo[]>>('/ai/providers')
}

// ==================== API 配置管理 ====================

export const configApi = {
  /**
   * 获取所有配置
   */
  getAll: () => api.get<ApiResponse<APIConfigDisplay[]>>('/ai/configs'),

  /**
   * 获取单个配置
   */
  getById: (id: string) => api.get<ApiResponse<APIConfigDisplay>>(`/ai/configs/${id}`),

  /**
   * 创建配置
   */
  create: (data: CreateAPIConfigInput) => api.post<ApiResponse<APIConfigDisplay>>('/ai/configs', data),

  /**
   * 更新配置
   */
  update: (id: string, data: UpdateAPIConfigInput) =>
    api.put<ApiResponse<APIConfigDisplay>>(`/ai/configs/${id}`, data),

  /**
   * 删除配置
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai/configs/${id}`),

  /**
   * 获取默认配置
   */
  getDefault: () => api.get<ApiResponse<APIConfigDisplay | null>>('/ai/configs/default'),

  /**
   * 设置为默认配置
   */
  setDefault: (id: string) => api.post<ApiResponse<void>>(`/ai/configs/${id}/default`),

  /**
   * 测试配置连接
   */
  testConnection: (id: string) =>
    api.post<ApiResponse<ConnectionTestResult>>(`/ai/configs/${id}/test`)
}

// ==================== 聊天功能 ====================

export const chatApi = {
  /**
   * 发送聊天消息（非流式）
   */
  send: (data: {
    configId?: string
    sessionId?: string
    message: string
    includeContext?: boolean
  }) => api.post<ApiResponse<ChatResponseData>>('/ai/chat', data),

  /**
   * 发送聊天消息（流式 SSE）
   * 返回一个 AbortController 用于取消请求
   */
  sendStream: (
    data: {
      configId?: string
      sessionId?: string
      message: string
      includeContext?: boolean
    },
    callbacks: StreamCallbacks
  ): AbortController => {
    const controller = new AbortController()
    let isRetrying = false

    const doFetch = async () => {
      try {
        const authStore = useAuthStore()
        const url = `/api/ai/chat/stream`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        }
        if (authStore.token) {
          headers['Authorization'] = `Bearer ${authStore.token}`
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
          signal: controller.signal
        })

        // 处理 Token 过期导致的 401 Error
        if (response.status === 401 && !isRetrying) {
          isRetrying = true
          const success = await authStore.refreshAccessToken()
          if (success) {
            return doFetch()
          } else {
            authStore.logout()
            callbacks.onError?.('认证已过期，请重新登录')
            return
          }
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '请求失败' }))
          callbacks.onError?.(errorData.error || `HTTP ${response.status}`)
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          callbacks.onError?.('无法读取响应流')
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // 解析 SSE 数据
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // 保留未完成的行

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim()
              if (!jsonStr) continue

              try {
                const chunk: StreamChunk = JSON.parse(jsonStr)

                if (chunk.error) {
                  callbacks.onError?.(chunk.error)
                  return
                }

                if (chunk.done && chunk.fullContent !== undefined) {
                  callbacks.onComplete?.(chunk.fullContent)
                } else if (chunk.content) {
                  callbacks.onChunk?.(chunk.content)
                }
              } catch {
                // 忽略解析错误，可能是不完整的 JSON
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          callbacks.onError?.((error as Error).message || '网络请求失败')
        }
      }
    }

    doFetch()

    return controller
  }
}

// ==================== 设备上下文 ====================

export const contextApi = {
  /**
   * 获取当前上下文
   */
  get: () => api.get<ApiResponse<DeviceContext>>('/ai/context'),

  /**
   * 获取可用配置段列表
   */
  getSections: () => api.get<ApiResponse<string[]>>('/ai/context/sections'),

  /**
   * 获取指定配置段
   */
  getSection: (section: string) => api.get<ApiResponse<unknown>>(`/ai/context/sections/${section}`)
}

// ==================== 脚本执行 ====================

export const scriptApi = {
  /**
   * 执行脚本
   */
  execute: (data: { script: string; sessionId: string; dryRun?: boolean }) =>
    api.post<ApiResponse<{ result: ScriptExecuteResult; historyId: string }>>(
      '/ai/scripts/execute',
      data
    ),

  /**
   * 验证脚本
   */
  validate: (script: string) =>
    api.post<ApiResponse<ScriptValidationResult>>('/ai/scripts/validate', { script }),

  /**
   * 获取执行历史
   */
  getHistory: (sessionId?: string) =>
    api.get<ApiResponse<ScriptHistory[]>>('/ai/scripts/history', {
      params: sessionId ? { sessionId } : undefined
    }),

  /**
   * 删除单条执行历史
   */
  deleteHistory: (id: string) => api.delete<ApiResponse<void>>(`/ai/scripts/history/${id}`),

  /**
   * 清除会话的执行历史
   */
  clearSessionHistory: (sessionId: string) =>
    api.delete<ApiResponse<void>>(`/ai/scripts/history/session/${sessionId}`)
}

// ==================== 会话管理 ====================

export const sessionApi = {
  /**
   * 获取所有会话
   */
  getAll: () => api.get<ApiResponse<ChatSession[]>>('/ai/sessions'),

  /**
   * 获取单个会话
   */
  getById: (id: string) => api.get<ApiResponse<ChatSession>>(`/ai/sessions/${id}`),

  /**
   * 创建会话
   */
  create: (data?: { provider?: AIProvider; model?: string; configId?: string; mode?: 'standard' | 'knowledge-enhanced' }) =>
    api.post<ApiResponse<ChatSession>>('/ai/sessions', data || {}),

  /**
   * 更新会话
   */
  update: (id: string, data: { title?: string; provider?: AIProvider; model?: string }) =>
    api.put<ApiResponse<ChatSession>>(`/ai/sessions/${id}`, data),

  /**
   * 删除会话
   */
  delete: (id: string) => api.delete<ApiResponse<void>>(`/ai/sessions/${id}`),

  /**
   * 删除所有会话
   */
  deleteAll: () => api.delete<ApiResponse<void>>('/ai/sessions'),

  /**
   * 重命名会话
   */
  rename: (id: string, title: string) =>
    api.put<ApiResponse<ChatSession>>(`/ai/sessions/${id}/rename`, { title }),

  /**
   * 清除会话消息
   */
  clearMessages: (id: string) => api.post<ApiResponse<void>>(`/ai/sessions/${id}/clear`),

  /**
   * 导出会话为 Markdown
   * 返回 Blob 用于下载
   */
  export: async (id: string): Promise<Blob> => {
    const response = await api.get(`/ai/sessions/${id}/export`, {
      responseType: 'blob'
    })
    return response.data
  },

  /**
   * 复制会话
   */
  duplicate: (id: string) => api.post<ApiResponse<ChatSession>>(`/ai/sessions/${id}/duplicate`),

  /**
   * 搜索会话
   */
  search: (query: string) =>
    api.get<ApiResponse<ChatSession[]>>('/ai/sessions/search', {
      params: { q: query }
    })
}

// ==================== 导出统一 API 对象 ====================

export const aiApi = {
  providers: providerApi,
  configs: configApi,
  chat: chatApi,
  context: contextApi,
  scripts: scriptApi,
  sessions: sessionApi
}

// ==================== 统一 AI Agent API ====================

/**
 * 统一聊天模式
 */
export type UnifiedChatMode = 'standard' | 'knowledge-enhanced'

/**
 * RAG 选项
 */
export interface RAGOptions {
  topK?: number
  minScore?: number
  includeTools?: boolean
}

/**
 * RAG 上下文
 */
export interface RAGContext {
  retrievalTime: number
  totalRetrievals: number
  avgRelevanceScore: number
}

/**
 * RAG 引用
 */
export interface RAGCitation {
  entryId: string
  title: string
  content: string
  score: number
  type: string
}

/**
 * Agent 工具调用
 */
export interface AgentToolCall {
  id: string
  tool: string
  input: Record<string, unknown>
  output: unknown
  duration: number
}

/**
 * 统一聊天请求
 */
export interface UnifiedChatRequest {
  configId?: string
  sessionId?: string
  message: string
  mode?: UnifiedChatMode
  includeContext?: boolean
  ragOptions?: RAGOptions
}

/**
 * 统一聊天响应
 * Requirements: 7.1, 7.3
 */
export interface UnifiedChatResponse {
  content: string
  sessionId: string
  ragContext?: RAGContext
  citations?: RAGCitation[]
  toolCalls?: AgentToolCall[]
  reasoning?: string[]
  confidence?: number
  usage?: TokenUsage
  /** ReAct 循环步骤列表 (Requirements: 7.1) */
  reactSteps?: ReActStep[]
  /** 意图分析结果 */
  intentAnalysis?: IntentAnalysis
}

/**
 * 统一聊天消息
 */
export interface UnifiedChatMessage {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: Date
  // 收藏状态
  collected?: boolean
  collectedAt?: Date
  // 知识增强模式特有
  toolCalls?: AgentToolCall[]
  reasoning?: string[]
  confidence?: number
  citations?: RAGCitation[]
  // ReAct 步骤
  reactSteps?: ReActStep[]
  // 脚本执行
  scriptExecution?: {
    script: string
    result: {
      success: boolean
      output?: string
      error?: string
    }
  }
}

/**
 * 统一会话类型
 */
export interface UnifiedChatSession extends ChatSession {
  mode: UnifiedChatMode
}

// ==================== ReAct Agent 类型 ====================
// Requirements: 7.1, 7.2

/**
 * ReAct 步骤类型
 * 定义 ReAct 循环中的步骤类型
 * - thought: 思考步骤
 * - action: 工具调用步骤
 * - observation: 工具执行结果观察步骤
 * - final_answer: 最终答案步骤
 * - reflection: 反思步骤（智能进化系统新增）
 */
export type ReActStepType = 'thought' | 'action' | 'observation' | 'final_answer' | 'reflection'

/**
 * 失败类型
 */
export type FailureType =
  | 'parameter_error'
  | 'timeout'
  | 'permission'
  | 'resource'
  | 'network'
  | 'unknown'

/**
 * 失败分析结果
 */
export interface FailureAnalysis {
  failureType: FailureType
  possibleCauses: string[]
  suggestions: string[]
  confidence: number
  analysisTime?: number
  originalError?: string
}

/**
 * 参数修正记录
 */
export interface ParamModification {
  field: string
  oldValue: unknown
  newValue: unknown
  reason: string
}

/**
 * 修正后的参数
 */
export interface ModifiedParams {
  params: Record<string, unknown>
  modifications: ParamModification[]
  suggestAlternativeTool?: boolean
  alternativeToolName?: string
}

/**
 * ReAct 步骤
 * 记录 ReAct 循环中的每个步骤
 * Requirements: 7.2
 */
export interface ReActStep {
  /** 步骤类型 */
  type: ReActStepType
  /** 步骤内容 */
  content: string
  /** 时间戳 */
  timestamp: number
  /** 工具名称（仅 action 类型） */
  toolName?: string
  /** 工具输入参数（仅 action 类型） */
  toolInput?: Record<string, unknown>
  /** 工具输出结果（仅 observation 类型） */
  toolOutput?: unknown
  /** 执行耗时（毫秒，仅 observation 类型） */
  duration?: number
  /** 执行是否成功（仅 observation 类型） */
  success?: boolean
  /** 反思分析结果（仅 reflection 类型） */
  failureAnalysis?: FailureAnalysis
  /** 修正后的参数（仅 reflection 类型） */
  modifiedParams?: ModifiedParams
  /** 该步骤是否经过中间件修正 */
  middlewareCorrected?: boolean
}

/**
 * 意图分析结果
 * LLM 分析用户请求后返回的结构化结果
 */
export interface IntentAnalysis {
  /** 用户意图的简短描述 */
  intent: string
  /** 需要调用的工具列表 */
  tools: Array<{
    /** 工具名称 */
    name: string
    /** 工具参数 */
    params: Record<string, unknown>
    /** 选择该工具的原因 */
    reason: string
  }>
  /** 置信度 (0-1) */
  confidence: number
  /** 是否需要多步骤推理 */
  requiresMultiStep: boolean
}

/**
 * 统一流式响应块
 */
export interface UnifiedStreamChunk {
  type: 'content' | 'citation' | 'tool_call' | 'reasoning' | 'react_step' | 'done' | 'error'
  content?: string
  citation?: RAGCitation
  toolCall?: AgentToolCall
  reasoning?: string
  reactStep?: ReActStep
  error?: string
  usage?: TokenUsage
  confidence?: number
}

/**
 * 统一流式响应回调
 */
export interface UnifiedStreamCallbacks {
  onContent?: (content: string) => void
  onCitation?: (citation: RAGCitation) => void
  onToolCall?: (toolCall: AgentToolCall) => void
  onReasoning?: (reasoning: string) => void
  onReactStep?: (step: ReActStep) => void
  onComplete?: (data?: { reactSteps?: ReActStep[]; confidence?: number }) => void
  onError?: (error: string) => void
}

/**
 * 执行类型
 */
export type ExecutionType = 'script' | 'tool_call'

/**
 * 统一执行历史
 */
export interface UnifiedExecutionHistory {
  id: string
  sessionId: string
  type: ExecutionType
  timestamp: Date
  script?: string
  scriptResult?: ScriptExecuteResult
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolDuration?: number
  success: boolean
  error?: string
}

/**
 * 执行历史统计
 */
export interface ExecutionHistoryStats {
  totalExecutions: number
  scriptExecutions: number
  toolCalls: number
  successRate: number
  recentExecutions: number
}

/**
 * 收藏的问答对
 * Requirements: 13.4
 */
export interface CollectedQAPair {
  id: string
  sessionId: string
  question: {
    messageId: string
    content: string
    timestamp: Date
  }
  answer: {
    messageId: string
    content: string
    timestamp: Date
    citations?: RAGCitation[]
  }
  collectedAt: Date
  converted: boolean
  convertedEntryId?: string
}

/**
 * 会话收藏摘要
 * Requirements: 14.3, 14.4
 */
export interface SessionCollectionSummary {
  sessionId: string
  sessionTitle: string
  collectedCount: number
  unconvertedCount: number
  lastCollectedAt: Date
}

/**
 * 转换为知识的请求
 * Requirements: 13.5
 */
export interface ConvertToKnowledgeRequest {
  sessionId: string
  questionMessageId: string
  answerMessageId: string
  title?: string
  content?: string
  category?: string
  tags?: string[]
}

/**
 * 知识条目响应
 */
export interface KnowledgeEntryResponse {
  id: string
  type: string
  title: string
  content: string
  metadata: Record<string, unknown>
}

/**
 * 批量转换响应
 */
export interface BatchConvertResponse {
  entries: KnowledgeEntryResponse[]
  total: number
  succeeded: number
  failed: number
}

/**
 * 脚本执行响应（带 AI 分析）
 */
export interface UnifiedScriptResponse {
  result: ScriptExecuteResult
  analysis?: string
  sessionId?: string
}

/**
 * 脚本执行 SSE 事件类型
 */
export type ScriptStreamEventType = 'status' | 'ping' | 'result' | 'analysis' | 'done' | 'error'

/**
 * 脚本执行 SSE 事件
 */
export interface ScriptStreamChunk {
  type: ScriptStreamEventType
  message?: string
  result?: ScriptExecuteResult
  analysis?: string
  sessionId?: string
  error?: string
}

/**
 * 脚本执行 SSE 回调
 */
export interface ScriptStreamCallbacks {
  onStatus?: (message: string) => void
  onResult?: (result: ScriptExecuteResult) => void
  onAnalysis?: (analysis: string) => void
  onDone?: (sessionId?: string) => void
  onError?: (error: string) => void
  onPing?: () => void
}

/**
 * 统一 AI Agent API
 * Requirements: 1.1
 */
export const unifiedAgentApi = {
  /**
   * 发送统一聊天消息（非流式）
   */
  chat: (data: UnifiedChatRequest) =>
    api.post<ApiResponse<UnifiedChatResponse>>('/ai/unified/chat', data),

  /**
   * 发送统一聊天消息（流式 SSE）
   * 返回一个 AbortController 用于取消请求
   */
  chatStream: (
    data: UnifiedChatRequest,
    callbacks: UnifiedStreamCallbacks
  ): AbortController => {
    const controller = new AbortController()
    let isRetrying = false

    const doFetch = async () => {
      try {
        const authStore = useAuthStore()
        const deviceStore = useDeviceStore()

        // 构造全局 URL（AI 模块已全局化，不需要设备前缀）
        let url = '/api/ai/unified/chat/stream'

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        }

        // 必须手动附加 Token，因为没有经过 axios 拦截器
        if (authStore.token) {
          headers['Authorization'] = `Bearer ${authStore.token}`
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
          signal: controller.signal
        })

        // 处理 Token 过期导致的 401 Error
        if (response.status === 401 && !isRetrying) {
          isRetrying = true
          const success = await authStore.refreshAccessToken()
          if (success) {
            // 刷新成功，递归重试
            return doFetch()
          } else {
            authStore.logout()
            callbacks.onError?.('认证已过期，请重新登录')
            return
          }
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '请求失败' }))
          callbacks.onError?.(errorData.error || `HTTP ${response.status}`)
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          callbacks.onError?.('无法读取响应流')
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // 解析 SSE 数据
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim()
              if (!jsonStr) continue

              try {
                const chunk: UnifiedStreamChunk = JSON.parse(jsonStr)

                switch (chunk.type) {
                  case 'content':
                    if (chunk.content) {
                      callbacks.onContent?.(chunk.content)
                    }
                    break
                  case 'citation':
                    if (chunk.citation) {
                      callbacks.onCitation?.(chunk.citation)
                    }
                    break
                  case 'tool_call':
                    if (chunk.toolCall) {
                      callbacks.onToolCall?.(chunk.toolCall)
                    }
                    break
                  case 'reasoning':
                    if (chunk.reasoning) {
                      callbacks.onReasoning?.(chunk.reasoning)
                    }
                    break
                  case 'react_step':
                    if (chunk.reactStep) {
                      callbacks.onReactStep?.(chunk.reactStep)
                    }
                    break
                  case 'done':
                    {
                      const doneData: { reactSteps?: ReActStep[]; confidence?: number } = {}
                      if ((chunk as any).reactSteps) {
                        doneData.reactSteps = (chunk as any).reactSteps
                      }
                      if (chunk.confidence !== undefined) {
                        doneData.confidence = chunk.confidence
                      }
                      callbacks.onComplete?.(Object.keys(doneData).length > 0 ? doneData : undefined)
                    }
                    break
                  case 'error':
                    if (chunk.error) {
                      callbacks.onError?.(chunk.error)
                    }
                    break
                }
              } catch {
                // 忽略单个 chunk 解析错误
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          callbacks.onError?.((error as Error).message || '网络请求失败')
        }
      }
    }

    // 单独发起执行
    doFetch()

    return controller
  },

  /**
   * 获取所有统一会话
   */
  getSessions: (mode?: UnifiedChatMode) =>
    api.get<ApiResponse<UnifiedChatSession[]>>('/ai/unified/sessions', {
      params: mode ? { mode } : undefined
    }),

  /**
   * 创建统一会话
   */
  createSession: (data?: { configId?: string; mode?: UnifiedChatMode }) =>
    api.post<ApiResponse<UnifiedChatSession>>('/ai/unified/sessions', data || {}),

  /**
   * 获取单个统一会话
   */
  getSession: (id: string) =>
    api.get<ApiResponse<UnifiedChatSession>>(`/ai/unified/sessions/${id}`),

  /**
   * 更新统一会话
   */
  updateSession: (id: string, data: { title?: string; mode?: UnifiedChatMode }) =>
    api.put<ApiResponse<UnifiedChatSession>>(`/ai/unified/sessions/${id}`, data),

  /**
   * 删除统一会话
   */
  deleteSession: (id: string) =>
    api.delete<ApiResponse<void>>(`/ai/unified/sessions/${id}`),

  /**
   * 导出统一会话为 Markdown（包含知识引用）
   */
  exportSession: async (id: string): Promise<Blob> => {
    const response = await api.get(`/ai/unified/sessions/${id}/export`, {
      responseType: 'blob'
    })
    return response.data
  },

  /**
   * 执行脚本（带 AI 分析）
   */
  executeScript: (data: {
    script: string
    sessionId?: string
    dryRun?: boolean
    analyze?: boolean
    configId?: string
  }) => api.post<ApiResponse<UnifiedScriptResponse>>('/ai/unified/scripts/execute', data),

  /**
   * 执行脚本（SSE 流式）
   * 返回 AbortController 用于取消请求
   */
  executeScriptStream: (
    data: {
      script: string
      sessionId?: string
      dryRun?: boolean
      analyze?: boolean
      configId?: string
    },
    callbacks: ScriptStreamCallbacks
  ): AbortController => {
    const controller = new AbortController()
    let isRetrying = false

    const doFetch = async () => {
      try {
        const authStore = useAuthStore()
        const deviceStore = useDeviceStore()

        let url = '/api/ai/unified/scripts/execute/stream'

        const headers: Record<string, string> = {
          'Content-Type': 'application/json'
        }
        if (authStore.token) {
          headers['Authorization'] = `Bearer ${authStore.token}`
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
          signal: controller.signal
        })

        if (response.status === 401 && !isRetrying) {
          isRetrying = true
          const success = await authStore.refreshAccessToken()
          if (success) {
            return doFetch()
          } else {
            authStore.logout()
            callbacks.onError?.('认证已过期，请重新登录')
            return
          }
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '请求失败' }))
          callbacks.onError?.(errorData.error || `HTTP ${response.status}`)
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          callbacks.onError?.('无法读取响应流')
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue

            const jsonStr = trimmed.slice(5).trim()
            if (!jsonStr) continue

            try {
              const chunk: ScriptStreamChunk = JSON.parse(jsonStr)
              switch (chunk.type) {
                case 'status':
                  if (chunk.message) callbacks.onStatus?.(chunk.message)
                  break
                case 'result':
                  if (chunk.result) callbacks.onResult?.(chunk.result)
                  break
                case 'analysis':
                  if (chunk.analysis) callbacks.onAnalysis?.(chunk.analysis)
                  break
                case 'done':
                  callbacks.onDone?.(chunk.sessionId)
                  break
                case 'error':
                  if (chunk.error) callbacks.onError?.(chunk.error)
                  return
                case 'ping':
                  callbacks.onPing?.()
                  break
              }
            } catch {
              // 忽略单个 chunk 解析错误
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          callbacks.onError?.((error as Error).message || '网络请求失败')
        }
      }
    }

    doFetch()
    return controller
  },

  /**
   * 获取统一执行历史
   */
  getHistory: (params?: {
    sessionId?: string
    type?: ExecutionType
    limit?: number
    offset?: number
  }) => api.get<ApiResponse<UnifiedExecutionHistory[]>>('/ai/unified/history', { params }),

  /**
   * 获取执行历史统计
   */
  getHistoryStats: (sessionId?: string) =>
    api.get<ApiResponse<ExecutionHistoryStats>>('/ai/unified/history/stats', {
      params: sessionId ? { sessionId } : undefined
    }),

  /**
 * 清除执行历史
 */
  clearHistory: (sessionId?: string) =>
    api.delete<ApiResponse<void>>('/ai/unified/history', {
      params: sessionId ? { sessionId } : undefined
    }),

  // ==================== 对话收藏功能 ====================

  /**
   * 收藏消息
   * Requirements: 13.1, 13.2, 14.1
   */
  collectMessage: (sessionId: string, messageId: string) =>
    api.post<ApiResponse<void>>(`/ai/unified/sessions/${sessionId}/messages/${messageId}/collect`),

  /**
   * 取消收藏消息
   * Requirements: 14.2
   */
  uncollectMessage: (sessionId: string, messageId: string) =>
    api.delete<ApiResponse<void>>(`/ai/unified/sessions/${sessionId}/messages/${messageId}/collect`),

  /**
   * 获取会话中的收藏消息
   * Requirements: 13.4
   */
  getCollectedMessages: (sessionId: string) =>
    api.get<ApiResponse<CollectedQAPair[]>>(`/ai/unified/sessions/${sessionId}/collected`),

  /**
   * 获取所有有收藏消息的会话
   * Requirements: 14.3, 14.4
   */
  getSessionsWithCollections: () =>
    api.get<ApiResponse<SessionCollectionSummary[]>>('/ai/unified/sessions-with-collections'),

  /**
   * 转换收藏消息为知识条目
   * Requirements: 13.5, 13.6, 13.7, 13.10
   */
  convertToKnowledge: (data: ConvertToKnowledgeRequest) =>
    api.post<ApiResponse<KnowledgeEntryResponse>>('/ai/unified/conversations/convert', data),

  /**
   * 批量转换收藏消息为知识条目
   * Requirements: 13.11
   */
  batchConvertToKnowledge: (requests: ConvertToKnowledgeRequest[]) =>
    api.post<ApiResponse<BatchConvertResponse>>('/ai/unified/conversations/batch-convert', { requests }),

  /**
   * 获取标签建议
   * Requirements: 13.9
   */
  suggestTags: (content: string) =>
    api.post<ApiResponse<string[]>>('/ai/unified/conversations/suggest-tags', { content }),

  /**
   * 导出收藏消息为 Markdown
   * Requirements: 14.6
   */
  exportCollectedMessages: async (sessionId: string): Promise<Blob> => {
    const response = await api.get(`/ai/unified/sessions/${sessionId}/collected/export`, {
      responseType: 'blob'
    })
    return response.data
  }
}

export default aiApi
