/**
 * 智能检索类型定义
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3, 2.4, 3.1-3.5, 13.4
 */

import { KnowledgeEntry, KnowledgeMetadata } from '../knowledgeBase';

// ==================== 意图分析类型 ====================

/**
 * 意图类型
 * Requirements: 1.1
 */
export type IntentType =
  | 'troubleshooting'      // 故障排查
  | 'configuration'        // 配置查询
  | 'monitoring'           // 监控分析
  | 'historical_analysis'  // 历史分析
  | 'general';             // 通用查询

/**
 * 知识类型
 * Requirements: 1.3
 */
export type KnowledgeType = 'alert' | 'remediation' | 'config' | 'pattern' | 'manual' | 'feedback';

/**
 * 知识来源类型
 * Requirements: 4.2
 */
export type KnowledgeSource = 'official_doc' | 'historical_case' | 'user_feedback' | 'auto_generated';

/**
 * 意图分析结果
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */
export interface IntentAnalysisResult {
  /** 意图类型 */
  intentType: IntentType;
  /** 是否需要知识库支持 */
  requiresKnowledge: boolean;
  /** 目标知识集合 */
  targetCollections: string[];
  /** 提取的关键词 */
  keywords: string[];
  /** 置信度 (0-1) */
  confidence: number;
}

// ==================== 检索选项类型 ====================

/**
 * 检索选项
 * Requirements: 2.4, 13.4
 */
export interface RetrievalOptions {
  /** 最大返回数量，默认 10 */
  topK?: number;
  /** 最小相关性阈值，默认 0.3 */
  minScore?: number;
  /** 指定知识类型 */
  types?: KnowledgeType[];
  /** 是否包含完整内容，默认 true */
  includeFullContent?: boolean;
  /** 检索超时（毫秒），默认 10000 */
  timeout?: number;
}

/**
 * 排序选项
 * Requirements: 3.1, 3.2, 3.3, 3.4
 */
export interface SortOptions {
  /** 相似度权重，默认 0.5 */
  similarityWeight?: number;
  /** 时效性权重，默认 0.2 */
  recencyWeight?: number;
  /** 反馈评分权重，默认 0.2 */
  feedbackWeight?: number;
  /** 使用频率权重，默认 0.1 */
  usageWeight?: number;
  /** 时效性计算最大时间范围（毫秒），默认 90 天 */
  maxAgeMs?: number;
}

// ==================== 检索结果类型 ====================

/**
 * 原始检索结果
 * Requirements: 2.3
 */
export interface RawRetrievalResult {
  /** 知识条目 */
  entry: KnowledgeEntry;
  /** 相似度分数 */
  similarityScore: number;
  /** 来源集合 */
  collection: string;
}

/**
 * 带评分的检索结果
 * Requirements: 3.1, 3.5
 */
export interface ScoredRetrievalResult {
  /** 知识条目 */
  entry: KnowledgeEntry;
  /** 原始相似度分数 */
  similarityScore: number;
  /** 时效性分数 */
  recencyScore: number;
  /** 反馈分数 */
  feedbackScore: number;
  /** 使用频率分数 */
  usageScore: number;
  /** 混合分数 */
  hybridScore: number;
  /** 可信度分数 */
  credibilityScore: number;
}

/**
 * 智能检索结果
 * Requirements: 1.1, 2.1, 2.5, 13.5
 */
export interface IntelligentRetrievalResult {
  /** 检索到的知识列表 */
  documents: FormattedKnowledge[];
  /** 检索耗时 */
  retrievalTime: number;
  /** 原始查询 */
  query: string;
  /** 重写后的查询 */
  rewrittenQueries: string[];
  /** 是否降级模式 */
  degradedMode: boolean;
  /** 降级原因 */
  degradedReason?: string;
  /** 降级时间戳 */
  degradedAt?: number;
}

// ==================== 格式化知识类型 ====================

/**
 * 格式化后的知识
 * Requirements: 5.1, 6.1, 6.2, 6.5
 */
export interface FormattedKnowledge {
  /** 引用 ID，格式：KB-{type}-{shortId} */
  referenceId: string;
  /** 原始知识条目 ID */
  entryId: string;
  /** 标题 */
  title: string;
  /** 知识类型 */
  type: KnowledgeType;
  /** 可信度分数 */
  credibilityScore: number;
  /** 可信度等级 */
  credibilityLevel: 'high' | 'medium' | 'low';
  /** 完整内容 */
  fullContent: string;
  /** 内容（fullContent 的别名，便于访问） */
  content: string;
  /** 摘要（用于快速预览） */
  summary: string;
  /** 元数据 */
  metadata: KnowledgeMetadata;
  /** 关联知识引用 */
  relatedReferences?: string[];
  /** 引用提示 */
  citationHint: string;
}

// ==================== 智能检索器配置 ====================

/**
 * 智能检索器配置
 */
export interface IntelligentRetrieverConfig {
  /** 混合排序权重 */
  sortWeights: Required<Omit<SortOptions, 'maxAgeMs'>>;
  /** 时效性计算最大时间范围（毫秒），默认 90 天 */
  maxAgeMs: number;
  /** 检索超时（毫秒），默认 10000 */
  retrievalTimeout: number;
  /** 最小相关性阈值 */
  minScore: number;
  /** 默认返回数量 */
  defaultTopK: number;
}

/**
 * 默认智能检索器配置
 */
export const DEFAULT_INTELLIGENT_RETRIEVER_CONFIG: IntelligentRetrieverConfig = {
  sortWeights: {
    similarityWeight: 0.5,
    recencyWeight: 0.2,
    feedbackWeight: 0.2,
    usageWeight: 0.1,
  },
  maxAgeMs: 90 * 24 * 60 * 60 * 1000, // 90 天
  retrievalTimeout: 10000,
  minScore: 0.3,
  defaultTopK: 10,
};

// ==================== 集合名称常量 ====================

/**
 * 知识集合名称
 */
export const KNOWLEDGE_COLLECTIONS = {
  ALERTS: 'alerts_kb',
  REMEDIATIONS: 'remediations_kb',
  CONFIGS: 'configs_kb',
  PATTERNS: 'patterns_kb',
} as const;

/**
 * 有效的知识集合名称列表
 */
export const VALID_COLLECTIONS = Object.values(KNOWLEDGE_COLLECTIONS);

/**
 * 知识类型到集合的映射
 */
export const TYPE_TO_COLLECTION: Record<KnowledgeType, string> = {
  alert: KNOWLEDGE_COLLECTIONS.ALERTS,
  remediation: KNOWLEDGE_COLLECTIONS.REMEDIATIONS,
  config: KNOWLEDGE_COLLECTIONS.CONFIGS,
  pattern: KNOWLEDGE_COLLECTIONS.PATTERNS,
  manual: KNOWLEDGE_COLLECTIONS.ALERTS,
  feedback: KNOWLEDGE_COLLECTIONS.ALERTS,
};

// ==================== 知识引用类型（用于 ReActLoopController） ====================

/**
 * 追踪的知识引用（用于追踪和验证）
 * Requirements: 9.1, 9.2, 11.1
 */
export interface TrackedKnowledgeReference {
  /** 引用 ID，格式：KB-{type}-{shortId} */
  referenceId: string;
  /** 原始知识条目 ID */
  entryId: string;
  /** 标题 */
  title: string;
  /** 知识类型 */
  type: string;
  /** 是否有效（验证通过） */
  isValid: boolean;
  /** RAG 相关度/可信度评分 */
  score?: number;
}
