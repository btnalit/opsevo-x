/**
 * AI Agent Client 类型定义
 * 定义与 AI 服务提供商 API 交互所需的所有接口类型
 */

// ==================== Reranker 类型定义 ====================

/**
 * Reranker 配置接口
 */
export interface RerankerConfig {
  /** API 密钥 */
  apiKey: string;
  /** API 基础 URL */
  baseUrl: string;
  /** 模型名称 */
  modelName: string;
  /** 返回的最大结果数 */
  topK: number;
  /** 相关性阈值 (0-1) */
  threshold: number;
  /** 请求超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/**
 * 重排序结果
 */
export interface RerankResult {
  /** 原始文档索引 */
  index: number;
  /** 相关性评分 (0-1) */
  relevanceScore: number;
  /** 原始文档内容（可选） */
  document?: string;
}

/**
 * 重排序请求
 */
export interface RerankRequest {
  /** 模型名称 */
  model: string;
  /** 查询文本 */
  query: string;
  /** 待排序的文档列表 */
  documents: string[];
  /** 截断提示词的 token 数（可选） */
  truncate_prompt_tokens?: number;
}

/**
 * 重排序响应
 */
export interface RerankResponse {
  /** 请求 ID */
  id: string;
  /** 使用的模型 */
  model: string;
  /** Token 使用统计 */
  usage: { total_tokens: number };
  /** 排序结果 */
  results: Array<{ index: number; relevance_score: number }>;
}

// ==================== Prompt 模板类型定义 ====================

/**
 * 占位符定义
 */
export interface PlaceholderDefinition {
  /** 占位符名称（不含双花括号） */
  name: string;
  /** 显示标签 */
  label: string;
  /** 描述说明 */
  description: string;
  /** 默认值（可选） */
  defaultValue?: string;
}

/**
 * 知识库信息（用于渲染上下文）
 */
export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  description?: string;
}

/**
 * 选中的文档信息（用于渲染上下文）
 */
export interface SelectedDocumentInfo {
  id: string;
  title: string;
  excerpt?: string;
}

/**
 * 渲染上下文
 */
export interface RenderContext {
  /** 知识库列表 */
  knowledge_bases?: KnowledgeBaseInfo[];
  /** 网络搜索状态 */
  web_search_status?: boolean;
  /** 当前时间（ISO 8601 格式） */
  current_time?: string;
  /** 选中的文档列表 */
  selected_documents?: SelectedDocumentInfo[];
  /** 其他自定义占位符值 */
  [key: string]: unknown;
}

/**
 * 提示词模板
 */
export interface PromptTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板内容 */
  content: string;
  /** 模板描述 */
  description?: string;
  /** 模板分类 */
  category?: string;
  /** 使用的占位符列表 */
  placeholders: string[];
  /** 是否为默认模板 */
  isDefault: boolean;
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
}

// ==================== 会话配置类型定义 ====================

/**
 * 压缩策略类型
 */
export type CompressionStrategy = 'sliding_window' | 'smart';

/**
 * 智能摘要配置
 * Requirements: 4.5 - 支持通过配置开关启用/禁用智能摘要
 */
export interface SummarizationConfig {
  /** 是否启用知识内容智能摘要 */
  knowledgeSummarizationEnabled?: boolean;
  /** 是否启用工具输出智能摘要 */
  toolOutputSummarizationEnabled?: boolean;
  /** 知识内容预算比例 (0-1)，默认 0.6 */
  knowledgeBudgetRatio?: number;
  /** 工具输出预算比例 (0-1)，默认 0.25 */
  toolsBudgetRatio?: number;
}

/**
 * 会话配置
 */
export interface SessionConfig {
  /** 是否启用多轮对话 */
  multiTurnEnabled: boolean;
  /** 最大历史轮数 */
  maxHistoryTurns: number;
  /** 最大上下文 Token 数 */
  maxContextTokens: number;
  /** 压缩策略 */
  compressionStrategy: CompressionStrategy;
  /** 智能摘要配置 */
  summarization?: SummarizationConfig;
}

/**
 * 上下文统计信息
 */
export interface ContextStats {
  /** 消息数量 */
  messageCount: number;
  /** 估算的 Token 数 */
  estimatedTokens: number;
  /** 是否已压缩 */
  isCompressed: boolean;
  /** 原始消息数量 */
  originalMessageCount: number;
}

/**
 * 默认会话配置
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  multiTurnEnabled: true,
  maxHistoryTurns: 10,
  maxContextTokens: 4096,
  compressionStrategy: 'sliding_window',
};

// ==================== 提供商枚举 ====================

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
  CUSTOM = 'custom'
}

// ==================== 消息类型 ====================

/**
 * 聊天消息角色
 */
export type ChatRole = 'system' | 'user' | 'assistant';

/**
 * RAG 引用
 */
export interface RAGCitation {
  entryId: string;
  title: string;
  content: string;
  score: number;
  type: string;
}

/**
 * Agent 工具调用
 */
export interface AgentToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  duration: number;
}

/**
 * 聊天消息
 */
export interface ChatMessage {
  id?: string;  // 消息唯一标识
  role: ChatRole;
  content: string;
  timestamp?: Date;  // 消息时间戳
  // 知识增强模式特有字段
  citations?: RAGCitation[];
  toolCalls?: AgentToolCall[];
  reasoning?: string[];
  confidence?: number;
  // 收藏状态
  collected?: boolean;
  collectedAt?: Date;
  // 元数据（用于存储 usedLearningEntryIds 等反馈闭环数据）
  metadata?: Record<string, unknown>;
}

// ==================== 请求/响应类型 ====================

/**
 * 聊天请求接口
 */
export interface ChatRequest {
  provider: AIProvider;
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 聊天响应接口
 */
export interface ChatResponse {
  content: string;
  finishReason: string;
  usage?: TokenUsage;
}

// ==================== API 配置类型 ====================

/**
 * API 配置接口
 */
export interface APIConfig {
  id: string;
  provider: AIProvider;
  name: string;
  apiKey: string;  // 加密存储
  endpoint?: string;  // 自定义端点
  model: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 创建 API 配置的输入类型（不包含自动生成的字段）
 */
export type CreateAPIConfigInput = Omit<APIConfig, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 更新 API 配置的输入类型
 */
export type UpdateAPIConfigInput = Partial<Omit<APIConfig, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * API 配置显示类型（API Key 已掩码）
 */
export interface APIConfigDisplay extends Omit<APIConfig, 'apiKey'> {
  apiKeyMasked: string;
}

// ==================== 上下文类型 ====================

/**
 * 设备连接上下文
 */
export interface DeviceConnectionContext {
  connected: boolean;
  host: string;
  version?: string;
  driverType?: string;
  deviceId?: string;
}

/**
 * 设备系统信息
 */
export interface DeviceSystemInfo {
  identity: string;
  vendor?: string;
  model?: string;
  version: string;
  uptime: string;
  /** @deprecated 向后兼容：部分旧代码使用 boardName，新代码请使用 model */
  boardName?: string;
}

/**
 * 选中的配置项
 */
export interface SelectedConfig {
  type: string;
  data: unknown;
}

/**
 * 设备上下文
 */
export interface DeviceContext {
  connectionStatus: DeviceConnectionContext;
  systemInfo?: DeviceSystemInfo;
  selectedConfigs?: SelectedConfig[];
  capabilities?: import('./device-driver').CapabilityManifest;
}

// ==================== 脚本执行类型 ====================

/**
 * 脚本执行请求
 */
export interface ScriptExecuteRequest {
  script: string;
  dryRun?: boolean;  // 仅验证不执行
  /** 泛化设备支持：目标设备 ID */
  deviceId?: string;
}

/**
 * 脚本执行结果
 */
export interface ScriptExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  executedAt: Date;
}

/**
 * 脚本验证结果
 */
export interface ScriptValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * 脚本执行历史记录
 */
export interface ScriptHistory {
  id: string;
  script: string;
  result: ScriptExecuteResult;
  sessionId: string;
  createdAt: Date;
}

// ==================== 会话类型 ====================

/**
 * 聊天会话模式
 */
export type ChatSessionMode = 'standard' | 'knowledge-enhanced';

/**
 * 聊天会话
 */
export interface ChatSession {
  id: string;
  title: string;
  provider: AIProvider;
  model: string;
  mode?: ChatSessionMode;
  messages: ChatMessage[];
  collectedCount?: number;  // 收藏消息数量
  config?: SessionConfig;  // 会话配置
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 创建会话的输入类型
 */
export type CreateSessionInput = Pick<ChatSession, 'provider' | 'model'> & { mode?: ChatSessionMode };

/**
 * 更新会话的输入类型
 */
export type UpdateSessionInput = Partial<Pick<ChatSession, 'title' | 'provider' | 'model' | 'mode'>>;

// ==================== 数据存储类型 ====================

/**
 * AI Agent 设置
 */
export interface AIAgentSettings {
  defaultProviderId?: string;
  rateLimitPerMinute: number;
  maxContextTokens: number;
}

/**
 * AI Agent 数据存储结构
 */
export interface AIAgentData {
  apiConfigs: APIConfig[];
  sessions: ChatSession[];
  scriptHistory: ScriptHistory[];
  settings: AIAgentSettings;
}

// ==================== 错误类型 ====================

/**
 * AI 错误响应
 */
export interface AIErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
  retryAfter?: number;  // 秒
}

/**
 * AI 错误代码
 */
export enum AIErrorCode {
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  INVALID_API_KEY = 'INVALID_API_KEY',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  SCRIPT_SYNTAX_ERROR = 'SCRIPT_SYNTAX_ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  EXECUTION_TIMEOUT = 'EXECUTION_TIMEOUT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

// ==================== 适配器接口 ====================

/**
 * AI 提供商适配器接口
 */
export interface IAIProviderAdapter {
  /**
   * 发送聊天请求（非流式）
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * 发送聊天请求（流式）
   */
  chatStream(request: ChatRequest): AsyncGenerator<string>;

  /**
   * 验证 API Key 是否有效
   */
  validateApiKey(apiKey: string): Promise<boolean>;

  /**
   * 获取可用模型列表
   */
  listModels(): Promise<string[]>;
}

// ==================== 服务接口 ====================

/**
 * API 配置服务接口
 */
export interface IAPIConfigService {
  create(config: CreateAPIConfigInput): Promise<APIConfig>;
  update(id: string, config: UpdateAPIConfigInput): Promise<APIConfig>;
  delete(id: string): Promise<void>;
  getAll(): Promise<APIConfig[]>;
  getById(id: string): Promise<APIConfig | null>;
  getDefault(): Promise<APIConfig | null>;
  setDefault(id: string): Promise<void>;
  testConnection(id: string): Promise<boolean>;
}

/**
 * 上下文构建器接口
 */
export interface IContextBuilder {
  buildSystemPrompt(): string;
  getConnectionContext(): Promise<DeviceContext>;
  getConfigSection(section: string): Promise<unknown>;
  sanitizeConfig(config: unknown): unknown;
}

/**
 * 脚本执行器接口
 */
export interface IScriptExecutor {
  execute(request: ScriptExecuteRequest): Promise<ScriptExecuteResult>;
  validate(script: string): Promise<ScriptValidationResult>;
  getHistory(sessionId?: string): Promise<ScriptHistory[]>;
}

/**
 * 会话服务接口
 */
export interface IChatSessionService {
  create(provider: AIProvider, model: string, mode?: ChatSessionMode): Promise<ChatSession>;
  update(id: string, updates: UpdateSessionInput): Promise<ChatSession>;
  delete(id: string): Promise<void>;
  getById(id: string): Promise<ChatSession | null>;
  getAll(): Promise<ChatSession[]>;
  addMessage(sessionId: string, message: ChatMessage): Promise<void>;
  exportAsMarkdown(id: string): Promise<string>;
}

/**
 * 加密服务接口
 */
export interface ICryptoService {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

/**
 * 速率限制服务接口
 */
export interface IRateLimiterService {
  checkLimit(key: string): boolean;
  getRemainingRequests(key: string): number;
  resetLimit(key: string): void;
}

// ==================== 常量配置 ====================

/**
 * 默认 API 端点
 */
export const DEFAULT_ENDPOINTS: Record<AIProvider, string> = {
  [AIProvider.OPENAI]: 'https://api.openai.com/v1',
  [AIProvider.GEMINI]: 'https://generativelanguage.googleapis.com/v1beta',
  [AIProvider.CLAUDE]: 'https://api.anthropic.com/v1',
  [AIProvider.DEEPSEEK]: 'https://api.deepseek.com/v1',
  [AIProvider.QWEN]: 'https://dashscope.aliyuncs.com/api/v1',
  [AIProvider.ZHIPU]: 'https://open.bigmodel.cn/api/paas/v4',
  [AIProvider.CUSTOM]: ''
};

/**
 * 默认模型列表 (2026年1月更新)
 */
export const DEFAULT_MODELS: Record<AIProvider, string[]> = {
  [AIProvider.OPENAI]: [
    'gpt-5',
    'gpt-5-mini',
    'gpt-5.1',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o4-mini'
  ],
  [AIProvider.GEMINI]: [
    'gemini-3-pro',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash'
  ],
  [AIProvider.CLAUDE]: [
    'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219',
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-20241022',
    'claude-3-opus-20240229'
  ],
  [AIProvider.DEEPSEEK]: [
    'deepseek-chat',
    'deepseek-reasoner'
  ],
  [AIProvider.QWEN]: [
    'qwen3-max',
    'qwen3-plus',
    'qwen3-turbo',
    'qwen-max',
    'qwen-plus',
    'qwen-turbo'
  ],
  [AIProvider.ZHIPU]: [
    'glm-4.7',
    'glm-4-plus',
    'glm-4-flash',
    'glm-4-flashx',
    'glm-4-air'
  ],
  [AIProvider.CUSTOM]: []
};

/**
 * AIOps 系统提示词模板（泛化版本，替代原 RouterOS 专用模板）
 */
export const AIOPS_SYSTEM_PROMPT = `你是 AIOps 智能运维助手，专注于多类型设备和系统的智能运维管理。你的职责是：

1. 帮助用户理解和管理各类网络设备与系统
2. 生成准确、安全的设备配置脚本
3. 解释网络概念和设备特定功能
4. 提供最佳实践建议

重要规则：
- 所有设备命令必须使用代码块格式
- 在执行危险操作前提醒用户备份配置
- 不要假设用户的网络拓扑，需要时请询问
- 优先使用安全的配置方式
- 解释每个命令的作用

【严格禁止】：
- 绝对不要假装已经执行了命令
- 绝对不要编造或虚构任何配置数据、IP地址、接口名称等信息
- 绝对不要生成假的命令输出结果
- 如果用户想查看配置，只提供命令，让用户点击"执行"按钮来获取真实数据
- 你无法直接访问或执行设备命令，只能生成命令供用户执行

正确的回复方式：
- 当用户想查看配置时，说"您可以执行以下命令查看"，然后提供命令
- 不要在命令后面添加假的输出结果
- 等用户执行命令后，根据真实输出来回答问题

当前连接状态：
{connectionContext}
`;


// ==================== 对话收藏类型 ====================

/**
 * 收藏的问答对
 */
export interface CollectedQAPair {
  id: string;
  sessionId: string;
  question: {
    messageId: string;
    content: string;
    timestamp: Date;
  };
  answer: {
    messageId: string;
    content: string;
    timestamp: Date;
    citations?: RAGCitation[];
  };
  collectedAt: Date;
  converted: boolean;
  convertedEntryId?: string;
}

/**
 * 会话收藏摘要
 */
export interface SessionCollectionSummary {
  sessionId: string;
  sessionTitle: string;
  collectedCount: number;
  unconvertedCount: number;
  lastCollectedAt: Date;
}

/**
 * 转换为知识的请求
 */
export interface ConvertToKnowledgeRequest {
  sessionId: string;
  questionMessageId: string;
  answerMessageId: string;
  // 可选的用户编辑
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
}

/**
 * 对话转知识的数据结构
 */
export interface ConversationToKnowledge {
  sessionId: string;
  questionMessageId: string;
  answerMessageId: string;
  question: string;
  answer: string;
  title: string;
  category: string;
  tags: string[];
  citations?: RAGCitation[];
}

/**
 * 对话收藏服务接口
 */
export interface IConversationCollector {
  /**
   * 收藏消息（标记问答对）
   */
  collectMessage(sessionId: string, messageId: string): Promise<void>;

  /**
   * 取消收藏
   */
  uncollectMessage(sessionId: string, messageId: string): Promise<void>;

  /**
   * 获取会话中的收藏消息
   */
  getCollectedMessages(sessionId: string): Promise<CollectedQAPair[]>;

  /**
   * 获取所有有收藏消息的会话
   */
  getSessionsWithCollections(): Promise<SessionCollectionSummary[]>;

  /**
   * 转换收藏消息为知识条目
   */
  convertToKnowledge(request: ConvertToKnowledgeRequest): Promise<unknown>;

  /**
   * 批量转换
   */
  batchConvertToKnowledge(requests: ConvertToKnowledgeRequest[]): Promise<unknown[]>;

  /**
   * 自动生成标签建议
   */
  suggestTags(content: string): Promise<string[]>;

  /**
   * 导出收藏消息为 Markdown
   */
  exportAsMarkdown(sessionId: string): Promise<string>;
}
