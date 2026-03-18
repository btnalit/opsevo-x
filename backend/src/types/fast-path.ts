/**
 * Fast Path 类型定义
 * 
 * 智能知识查询快速路径的核心类型定义，包括路由配置、结果、上下文等接口。
 * 
 * Requirements: 1.1-1.5, 5.1-5.5
 */

import { KnowledgeEntry, KnowledgeMetadata } from '../services/ai-ops/rag/knowledgeBase';
import { Skill } from './skill';
import { ConversationMemory } from '../services/ai-ops/rag/mastraAgent';

// ==================== 查询意图类型 ====================

/**
 * 查询意图类型
 * - knowledge_query: 知识类查询（历史案例、解决方案、配置）
 * - realtime_query: 实时类查询（当前状态、实时数据）
 * - hybrid_query: 混合类查询（需要知识和实时数据）
 */
export type QueryIntent = 'knowledge_query' | 'realtime_query' | 'hybrid_query';

/**
 * 检索策略
 * - exact_match: 精确匹配
 * - semantic_match: 语义匹配
 * - fuzzy_match: 模糊匹配
 */
export type RetrievalStrategy = 'exact_match' | 'semantic_match' | 'fuzzy_match';

/**
 * 检索范围
 * - full_text: 全文检索
 * - title_only: 仅标题
 * - tags_only: 仅标签
 */
export type RetrievalScope = 'full_text' | 'title_only' | 'tags_only';

/**
 * 响应模式
 * - direct: 直达模式（置信度 >= 0.85）
 * - enhanced: 增强模式（0.6 <= 置信度 < 0.85）
 * - exploration: 探索模式（置信度 < 0.6 或无结果）
 * - explicit_notification: 明确告知模式（确认无相关知识）
 */
export type ResponseMode = 'direct' | 'enhanced' | 'exploration' | 'explicit_notification';

// ==================== 配置接口 ====================

/**
 * 快速路径路由器配置
 */
export interface FastPathRouterConfig {
  /** 是否启用快速路径 */
  enabled: boolean;
  /** 直达模式置信度阈值 */
  directThreshold: number;
  /** 增强模式置信度阈值 */
  enhancedThreshold: number;
  /** 预检索超时（毫秒） */
  preRetrievalTimeout: number;
  /** 智能重试总超时（毫秒） */
  smartRetryTimeout: number;
  /** 最大重试次数 */
  maxRetryAttempts: number;
}

/**
 * 默认快速路径配置
 */
export const DEFAULT_FAST_PATH_CONFIG: FastPathRouterConfig = {
  enabled: true,
  directThreshold: 0.85,
  enhancedThreshold: 0.6,
  preRetrievalTimeout: 500,
  smartRetryTimeout: 1500,
  maxRetryAttempts: 2,
};

// ==================== 意图分类接口 ====================

/**
 * 意图分类结果
 */
export interface IntentClassification {
  /** 意图类型 */
  intent: QueryIntent;
  /** 置信度 (0-1) */
  confidence: number;
  /** 分类耗时（毫秒） */
  classificationTime: number;
  /** 识别的关键词 */
  keywords: string[];
  /** 分类原因 */
  reason: string;
}

/**
 * 意图分类规则
 */
export interface IntentClassificationRule {
  /** 规则 ID */
  id: string;
  /** 规则名称 */
  name: string;
  /** 匹配模式（正则表达式） */
  patterns: string[];
  /** 关键词 */
  keywords: string[];
  /** 目标意图 */
  targetIntent: QueryIntent;
  /** 优先级 */
  priority: number;
  /** 是否启用 */
  enabled: boolean;
}

// ==================== 检索接口 ====================

/**
 * 预检索选项
 */
export interface PreRetrievalOptions {
  /** 检索策略 */
  strategy: RetrievalStrategy;
  /** 检索范围 */
  scope: RetrievalScope;
  /** 超时时间（毫秒） */
  timeout: number;
  /** 最大返回数量 */
  topK: number;
  /** 最小置信度 */
  minScore: number;
}

/**
 * 默认预检索选项
 */
export const DEFAULT_PRE_RETRIEVAL_OPTIONS: PreRetrievalOptions = {
  strategy: 'semantic_match',
  scope: 'full_text',
  timeout: 500,
  topK: 5,
  minScore: 0.3,
};

/**
 * 检索到的知识
 */
export interface RetrievedKnowledge {
  /** 知识条目 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 内容 */
  content: string;
  /** 类型 */
  type: string;
  /** 置信度分数 */
  score: number;
  /** 来源 */
  source: string;
  /** 元数据 */
  metadata: KnowledgeMetadata;
}

/**
 * 预检索结果
 */
export interface PreRetrievalResult {
  /** 检索到的文档 */
  documents: RetrievedKnowledge[];
  /** 最高置信度 */
  maxConfidence: number;
  /** 平均置信度 */
  avgConfidence: number;
  /** 检索耗时（毫秒） */
  retrievalTime: number;
  /** 使用的策略 */
  strategy: RetrievalStrategy;
  /** 使用的范围 */
  scope: RetrievalScope;
  /** 是否超时 */
  timedOut: boolean;
}

// ==================== 查询改写接口 ====================

/**
 * 同义词扩展结果
 */
export interface SynonymExpansion {
  /** 原始词 */
  original: string;
  /** 同义词列表 */
  synonyms: string[];
  /** 扩展来源 */
  source: 'dictionary' | 'llm' | 'learned';
}

/**
 * 查询改写结果
 */
export interface RewriteResult {
  /** 改写后的查询 */
  rewrittenQuery: string;
  /** 扩展的同义词 */
  synonyms: string[];
  /** 提取的关键词 */
  keywords: string[];
  /** 改写耗时（毫秒） */
  rewriteTime: number;
  /** 是否使用缓存 */
  fromCache: boolean;
}

// ==================== 知识缺口接口 ====================

/**
 * 知识缺口状态
 */
export type KnowledgeGapStatus = 'open' | 'resolved' | 'ignored';

/**
 * 知识缺口
 */
export interface KnowledgeGap {
  /** 缺口 ID */
  id: string;
  /** 原始查询 */
  originalQuery: string;
  /** 改写后的查询 */
  rewrittenQueries: string[];
  /** 查询类型 */
  queryType: string;
  /** 记录时间 */
  timestamp: number;
  /** 重试次数 */
  retryCount: number;
  /** 状态 */
  status: KnowledgeGapStatus;
}

// ==================== 引用接口 ====================

/**
 * 引用信息
 */
export interface Citation {
  /** 知识条目 ID */
  entryId: string;
  /** 标题 */
  title: string;
  /** 相关度 */
  relevance: number;
  /** 摘录 */
  excerpt: string;
}

// ==================== 快速路径上下文 ====================

/**
 * 快速路径上下文
 */
export interface FastPathContext {
  /** 会话 ID */
  sessionId?: string;
  /** 当前 Skill */
  skill?: Skill;
  /** 对话历史 */
  conversationHistory?: ConversationMemory;
  /** 用户偏好 */
  userPreferences?: UserPreferences;
}

/**
 * 用户偏好
 */
export interface UserPreferences {
  /** 偏好的响应详细程度 */
  responseDetail: 'brief' | 'normal' | 'detailed';
  /** 是否显示引用 */
  showCitations: boolean;
  /** 是否显示置信度 */
  showConfidence: boolean;
}

// ==================== 快速路径结果 ====================

/**
 * 快速路径结果
 */
export interface FastPathResult {
  /** 响应模式 */
  mode: ResponseMode;
  /** 是否应该跳过 ReAct */
  skipReAct: boolean;
  /** 检索到的知识 */
  knowledge?: RetrievedKnowledge[];
  /** 置信度分数 */
  confidence: number;
  /** 响应内容（直达/增强/明确告知模式） */
  response?: string;
  /** 引用信息 */
  citations?: Citation[];
  /** 处理时间（毫秒） */
  processingTime: number;
  /** 重试次数 */
  retryCount: number;
  /** 知识缺口（如果检测到） */
  knowledgeGap?: KnowledgeGap;
  /** 意图分类结果 */
  intentClassification?: IntentClassification;
}

// ==================== 统计和反馈接口 ====================

/**
 * 快速路径统计
 */
export interface FastPathStats {
  /** 总查询数 */
  totalQueries: number;
  /** 直达模式命中数 */
  directHits: number;
  /** 增强模式命中数 */
  enhancedHits: number;
  /** 探索模式数 */
  explorationCount: number;
  /** 明确告知数 */
  explicitNotificationCount: number;
  /** 平均响应时间（毫秒） */
  avgResponseTime: number;
  /** 平均重试次数 */
  avgRetryCount: number;
  /** 假阳性数 */
  falsePositives: number;
  /** 假阴性数 */
  falseNegatives: number;
  /** 知识缺口数 */
  knowledgeGaps: number;
}

/**
 * 快速路径反馈
 */
export interface FastPathFeedback {
  /** 查询 ID */
  queryId: string;
  /** 是否有用 */
  useful: boolean;
  /** 是否正确 */
  correct: boolean;
  /** 用户评论 */
  comment?: string;
  /** 反馈时间 */
  timestamp: number;
}

/**
 * 快速路径决策日志
 */
export interface FastPathDecisionLog {
  /** 日志 ID */
  id: string;
  /** 查询 ID */
  queryId: string;
  /** 原始查询 */
  query: string;
  /** 意图分类 */
  intentClassification: IntentClassification;
  /** 响应模式 */
  responseMode: ResponseMode;
  /** 置信度 */
  confidence: number;
  /** 重试次数 */
  retryCount: number;
  /** 处理时间（毫秒） */
  processingTime: number;
  /** 时间戳 */
  timestamp: number;
  /** 用户反馈（如果有） */
  feedback?: FastPathFeedback;
}

// ==================== 错误处理 ====================

/**
 * 快速路径错误代码
 */
export enum FastPathErrorCode {
  /** 预检索超时 */
  PRE_RETRIEVAL_TIMEOUT = 'PRE_RETRIEVAL_TIMEOUT',
  /** 意图分类失败 */
  INTENT_CLASSIFICATION_FAILED = 'INTENT_CLASSIFICATION_FAILED',
  /** 查询改写失败 */
  QUERY_REWRITE_FAILED = 'QUERY_REWRITE_FAILED',
  /** 知识库服务不可用 */
  KNOWLEDGE_BASE_UNAVAILABLE = 'KNOWLEDGE_BASE_UNAVAILABLE',
  /** LLM 服务不可用 */
  LLM_SERVICE_UNAVAILABLE = 'LLM_SERVICE_UNAVAILABLE',
  /** 配置无效 */
  INVALID_CONFIGURATION = 'INVALID_CONFIGURATION',
  /** 智能重试超时 */
  SMART_RETRY_TIMEOUT = 'SMART_RETRY_TIMEOUT',
}

/**
 * 快速路径错误
 */
export class FastPathError extends Error {
  public readonly code: FastPathErrorCode;
  public readonly recoverable: boolean;

  constructor(
    code: FastPathErrorCode,
    message: string,
    recoverable: boolean = true
  ) {
    super(message);
    this.name = 'FastPathError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

// ==================== 同义词字典接口 ====================

/**
 * 同义词字典
 */
export interface SynonymDictionary {
  /** 字典 ID */
  id: string;
  /** 字典名称 */
  name: string;
  /** 同义词映射 */
  mappings: Record<string, string[]>;
  /** 领域 */
  domain: string;
  /** 更新时间 */
  updatedAt: number;
}
