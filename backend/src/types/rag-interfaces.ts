/**
 * RAG 模块接口抽象
 * 
 * 定义 RAG 相关服务的接口，用于依赖注入和解耦。
 * 
 * Requirements: 1.2 - 通过接口抽象而非直接引用实现解耦
 */

// ==================== RAG Engine 接口 ====================

/**
 * RAG 查询选项
 */
export interface RAGQueryOptions {
  /** 检索数量 */
  topK?: number;
  /** 最小相似度阈值 */
  minScore?: number;
  /** 时效性权重 */
  recencyWeight?: number;
  /** 最大上下文长度 */
  maxContextLength?: number;
  /** 是否包含元数据 */
  includeMetadata?: boolean;
  /** 是否启用重排序 */
  rerankEnabled?: boolean;
  /** 重排序返回的最大结果数 */
  rerankTopK?: number;
  /** 重排序相关性阈值 (0-1) */
  rerankThreshold?: number;
}

/**
 * RAG 检索上下文
 */
export interface RAGRetrievalContext {
  /** 原始查询 */
  query: string;
  /** 检索到的文档 */
  retrievedDocuments: Array<{
    id: string;
    title: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
  /** 检索耗时（毫秒） */
  retrievalTime: number;
  /** 考虑的候选数量 */
  candidatesConsidered: number;
}

/**
 * RAG 查询结果
 */
export interface RAGSearchResult {
  /** 生成的回答 */
  answer: string;
  /** 检索上下文 */
  context: RAGRetrievalContext;
  /** 引用列表 */
  citations: Array<{
    entryId: string;
    title: string;
    relevance: number;
    excerpt: string;
  }>;
  /** 置信度 (0-1) */
  confidence: number;
  /** 查询状态 */
  status: 'success' | 'no_results' | 'fallback';
}

/**
 * RAG 引擎接口
 * 
 * 提供检索增强生成能力的核心接口。
 */
export interface IRAGEngine {
  /**
   * 初始化 RAG 引擎
   */
  initialize(): Promise<void>;

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean;

  /**
   * 执行 RAG 查询
   * @param question 查询问题
   * @param options 查询选项
   */
  query(question: string, options?: RAGQueryOptions): Promise<RAGSearchResult>;

  /**
   * 使分析缓存失效
   * @param alertId 可选的告警 ID，不传则清空所有缓存
   */
  invalidateAnalysisCache(alertId?: string): void;

  /**
   * 获取统计信息
   */
  getStats(): {
    queriesProcessed: number;
    avgRetrievalTime: number;
    avgRelevanceScore: number;
    cacheHits: number;
    fallbackCount: number;
  };
}

// ==================== Knowledge Base 接口 ====================

/**
 * 知识条目类型
 */
export type KnowledgeEntryType = 'alert' | 'remediation' | 'config' | 'pattern' | 'manual' | 'feedback';

/**
 * 知识条目元数据
 */
export interface KnowledgeEntryMetadata {
  source: string;
  timestamp: number;
  category: string;
  tags: string[];
  usageCount: number;
  feedbackScore: number;
  feedbackCount: number;
  lastUsed?: number;
  relatedIds?: string[];
  originalData?: Record<string, unknown>;
  metricType?: string;
}

/**
 * 知识条目
 */
export interface IKnowledgeEntry {
  id: string;
  type: KnowledgeEntryType;
  title: string;
  content: string;
  metadata: KnowledgeEntryMetadata;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/**
 * 知识查询参数
 */
export interface KnowledgeQueryParams {
  query: string;
  type?: KnowledgeEntryType;
  category?: string;
  tags?: string[];
  metricType?: string;
  dateRange?: { from: number; to: number };
  limit?: number;
  minScore?: number;
}

/**
 * 知识搜索结果
 */
export interface IKnowledgeSearchResult {
  entry: IKnowledgeEntry;
  score: number;
  highlights?: string[];
}

/**
 * 知识库接口
 * 
 * 提供知识存储和检索能力的核心接口。
 */
export interface IKnowledgeBase {
  /**
   * 初始化知识库
   */
  initialize(): Promise<void>;

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean;

  /**
   * 添加知识条目
   */
  add(entry: Omit<IKnowledgeEntry, 'id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<IKnowledgeEntry>;

  /**
   * 获取知识条目
   */
  get(id: string): Promise<IKnowledgeEntry | null>;

  /**
   * 更新知识条目
   */
  update(id: string, updates: Partial<Omit<IKnowledgeEntry, 'id' | 'createdAt'>>): Promise<IKnowledgeEntry>;

  /**
   * 删除知识条目
   */
  delete(id: string): Promise<void>;

  /**
   * 语义检索知识条目
   */
  search(query: KnowledgeQueryParams): Promise<IKnowledgeSearchResult[]>;

  /**
   * 记录知识条目使用
   */
  recordUsage(entryId: string): Promise<void>;

  /**
   * 获取知识库统计
   */
  getStats(): Promise<{
    totalEntries: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    recentAdditions: number;
    staleEntries: number;
    averageFeedbackScore: number;
  }>;
}

// ==================== Mastra Agent 接口 ====================

/**
 * Agent 工具定义
 */
export interface IAgentTool {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Agent 响应
 */
export interface IAgentResponse {
  message: string;
  reasoning: string[];
  toolCalls: Array<{
    tool: string;
    input: Record<string, unknown>;
    output: unknown;
    duration: number;
  }>;
  confidence: number;
}

/**
 * Agent 配置
 */
export interface IAgentConfig {
  maxIterations: number;
  maxTokens: number;
  temperature: number;
  tools: IAgentTool[];
}

/**
 * 会话记忆
 */
export interface IConversationMemory {
  sessionId: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls?: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
    toolResults?: Array<{
      id: string;
      result: unknown;
    }>;
  }>;
  context: Record<string, unknown>;
  createdAt: number;
  lastUpdated: number;
}

/**
 * Mastra Agent 接口
 * 
 * 提供智能代理能力的核心接口。
 */
export interface IMastraAgent {
  /**
   * 初始化 Agent
   */
  initialize(): Promise<void>;

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean;

  /**
   * 注册工具
   */
  registerTool(tool: IAgentTool): void;

  /**
   * 注销工具
   */
  unregisterTool(name: string): void;

  /**
   * 获取所有注册的工具
   */
  getTools(): IAgentTool[];

  /**
   * 创建新会话
   */
  createSession(): string;

  /**
   * 获取会话
   */
  getSession(sessionId: string): IConversationMemory | null;

  /**
   * 获取所有会话
   */
  getSessions(): IConversationMemory[];

  /**
   * 清除会话
   */
  clearSession(sessionId: string): Promise<void>;

  /**
   * 处理对话消息
   */
  chat(message: string, sessionId?: string): Promise<IAgentResponse>;

  /**
   * 执行任务
   */
  executeTask(task: string, context?: Record<string, unknown>): Promise<IAgentResponse>;

  /**
   * 获取配置
   */
  getConfig(): IAgentConfig;

  /**
   * 更新配置
   */
  updateConfig(config: Partial<Omit<IAgentConfig, 'tools'>>): void;

  /**
   * 获取统计信息
   */
  getStats(): {
    totalSessions: number;
    totalToolCalls: number;
    totalLLMRequests: number;
    avgResponseTime: number;
    errorCount: number;
  };
}

// ==================== 服务 Token 常量 ====================

/**
 * 服务注册 Token
 * 用于依赖注入容器中的服务标识
 */
export const RAG_SERVICE_TOKENS = {
  RAG_ENGINE: 'RAGEngine',
  KNOWLEDGE_BASE: 'KnowledgeBase',
  MASTRA_AGENT: 'MastraAgent',
} as const;
