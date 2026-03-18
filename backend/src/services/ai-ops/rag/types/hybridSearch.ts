/**
 * 混合检索系统类型定义
 * 
 * Requirements: 1, 2, 3, 4 - 智能混合检索系统
 * - 1: 知识元数据自动增强
 * - 2: 关键词索引管理
 * - 3: 混合检索引擎
 * - 4: RRF 融合排序
 */

import { KnowledgeEntry } from '../knowledgeBase';

// ==================== MetadataEnhancer 类型 ====================

/**
 * 增强后的元数据
 * Requirements: 1.1, 1.2, 1.3, 1.6
 */
export interface EnhancedMetadata {
  /** 自动提取的关键词 (5-10个) */
  autoKeywords: string[];
  /** 自动生成的问题示例 (3-5个) */
  questionExamples: string[];
  /** 自动生成的同义词映射 */
  autoSynonyms: Record<string, string[]>;
  /** 合并后的可搜索文本 */
  searchableText: string;
  /** 增强时间戳 */
  enhancedAt: number;
  /** 增强来源 (llm/fallback) */
  enhancementSource: 'llm' | 'fallback';
}

/**
 * MetadataEnhancer 配置
 * Requirements: 1.4, 1.5
 */
export interface MetadataEnhancerConfig {
  /** 是否启用 LLM 增强 */
  enableLLM: boolean;
  /** 关键词数量 */
  keywordCount: number;
  /** 问题示例数量 */
  questionExampleCount: number;
  /** LLM 调用超时 (ms) */
  llmTimeout: number;
  /** 是否异步增强 */
  asyncEnhancement: boolean;
  /** 批量增强并发数 */
  batchConcurrency: number;
  /** 最小关键词长度 */
  minKeywordLength: number;
}

/**
 * 默认 MetadataEnhancer 配置
 */
export const DEFAULT_METADATA_ENHANCER_CONFIG: MetadataEnhancerConfig = {
  enableLLM: true,
  keywordCount: 8,
  questionExampleCount: 4,
  llmTimeout: 30000,
  asyncEnhancement: true,
  batchConcurrency: 3,
  minKeywordLength: 2,
};

// ==================== KeywordIndexManager 类型 ====================

/**
 * 关键词索引条目
 * Requirements: 2.1
 */
export interface KeywordIndexEntry {
  /** 知识条目 ID */
  entryId: string;
  /** 关键词 */
  keyword: string;
  /** 字段来源 (title/tags/autoKeywords/questionExamples) */
  field: string;
  /** 词频 */
  termFrequency: number;
}

/**
 * 关键词搜索结果
 * Requirements: 2.2, 2.3
 */
export interface KeywordSearchResult {
  /** 知识条目 ID */
  entryId: string;
  /** BM25 分数 */
  score: number;
  /** 匹配的关键词 */
  matchedKeywords: string[];
  /** 匹配的字段 */
  matchedFields: string[];
}

/**
 * 倒排索引条目
 * Requirements: 2.1
 */
export interface InvertedIndexEntry {
  /** 文档 ID 列表 */
  docIds: Set<string>;
  /** 文档频率 (DF) */
  documentFrequency: number;
}

/**
 * 文档元信息
 * Requirements: 2.1
 */
export interface DocumentMeta {
  /** 文档 ID */
  id: string;
  /** 文档长度（词数） */
  length: number;
  /** 各字段的词频映射 */
  termFrequencies: Map<string, number>;
  /** 字段来源映射 */
  fieldSources: Map<string, string>;
}

/**
 * BM25 参数
 * Requirements: 2.2
 */
export interface BM25Params {
  /** k1 参数，控制词频饱和度，默认 1.2 */
  k1: number;
  /** b 参数，控制文档长度归一化，默认 0.75 */
  b: number;
  /** 平均文档长度 */
  avgDocLength: number;
}

/**
 * KeywordIndexManager 配置
 * Requirements: 2.2, 2.3, 2.5
 */
export interface KeywordIndexConfig {
  /** 是否启用中文分词 */
  enableChineseSegmentation: boolean;
  /** 最小关键词长度 */
  minKeywordLength: number;
  /** 是否启用模糊匹配 */
  enableFuzzyMatch: boolean;
  /** 模糊匹配最大编辑距离 */
  maxEditDistance: number;
  /** 索引持久化路径 */
  persistPath: string;
  /** BM25 k1 参数 */
  bm25K1: number;
  /** BM25 b 参数 */
  bm25B: number;
}

/**
 * 默认 KeywordIndexManager 配置
 */
export const DEFAULT_KEYWORD_INDEX_CONFIG: KeywordIndexConfig = {
  enableChineseSegmentation: true,
  minKeywordLength: 1,
  enableFuzzyMatch: false,
  maxEditDistance: 1,
  persistPath: 'data/ai-ops/rag/keyword-index',
  bm25K1: 1.2,
  bm25B: 0.75,
};

/**
 * 关键词索引统计
 * Requirements: 6.5
 */
export interface KeywordIndexStats {
  /** 条目数量 */
  entryCount: number;
  /** 关键词数量 */
  keywordCount: number;
  /** 内存使用估算 (bytes) */
  memoryUsage: number;
  /** 平均文档长度 */
  avgDocLength: number;
  /** 最后更新时间 */
  lastUpdated: number;
}

// ==================== RRFRanker 类型 ====================

/**
 * RRF 配置
 * Requirements: 4.1, 4.4
 */
export interface RRFConfig {
  /** RRF k 参数，默认 60 */
  k: number;
  /** 是否归一化分数到 0-1 */
  normalizeScores: boolean;
}

/**
 * 默认 RRF 配置
 */
export const DEFAULT_RRF_CONFIG: RRFConfig = {
  k: 60,
  normalizeScores: true,
};

/**
 * 排名项
 * Requirements: 4.1
 */
export interface RankedItem {
  /** 条目 ID */
  id: string;
  /** 排名 (1-based) */
  rank: number;
  /** 原始分数 */
  score: number;
}

/**
 * 融合结果
 * Requirements: 4.1, 4.2, 4.3, 4.5
 */
export interface FusedResult {
  /** 条目 ID */
  id: string;
  /** RRF 融合分数 */
  rrfScore: number;
  /** 归一化分数 (0-1) */
  normalizedScore: number;
  /** 各路检索的排名 */
  ranks: Record<string, number>;
  /** 各路检索的原始分数 */
  scores: Record<string, number>;
}

// ==================== HybridSearchEngine 类型 ====================

/**
 * 混合检索选项
 * Requirements: 3.1, 3.5, 3.6
 */
export interface HybridSearchOptions {
  /** 关键词检索权重 (0-1) */
  keywordWeight: number;
  /** 向量检索权重 (0-1) */
  vectorWeight: number;
  /** 最大返回数量 */
  topK: number;
  /** 最小分数阈值 */
  minScore: number;
  /** 超时时间 (ms) */
  timeout: number;
  /** 是否启用关键词检索 */
  enableKeywordSearch: boolean;
  /** 是否启用向量检索 */
  enableVectorSearch: boolean;
}

/**
 * 默认混合检索选项
 */
export const DEFAULT_HYBRID_SEARCH_OPTIONS: HybridSearchOptions = {
  keywordWeight: 0.4,
  vectorWeight: 0.6,
  topK: 10,
  minScore: 0.3,
  timeout: 500,
  enableKeywordSearch: true,
  enableVectorSearch: true,
};

/**
 * 混合检索结果
 * Requirements: 3.3, 3.4, 4.5
 */
export interface HybridSearchResult {
  /** 知识条目 */
  entry: KnowledgeEntry;
  /** 最终融合分数 */
  score: number;
  /** 关键词检索分数 */
  keywordScore?: number;
  /** 向量检索分数 */
  vectorScore?: number;
  /** 关键词检索排名 */
  keywordRank?: number;
  /** 向量检索排名 */
  vectorRank?: number;
  /** 匹配的关键词 */
  matchedKeywords?: string[];
}

/**
 * 混合检索指标
 * Requirements: 6.1
 */
export interface HybridSearchMetrics {
  /** 关键词检索命中数 */
  keywordHits: number;
  /** 向量检索命中数 */
  vectorHits: number;
  /** 融合后结果数 */
  mergedResults: number;
  /** 关键词检索耗时 (ms) */
  keywordSearchTime: number;
  /** 向量检索耗时 (ms) */
  vectorSearchTime: number;
  /** 总耗时 (ms) */
  totalTime: number;
  /** 是否降级 */
  degraded: boolean;
  /** 降级原因 */
  degradedReason?: string;
}

/**
 * 混合检索引擎配置
 * Requirements: 3.5, 5.3
 */
export interface HybridSearchEngineConfig {
  /** 是否启用混合检索 */
  enabled: boolean;
  /** 默认关键词检索权重 */
  defaultKeywordWeight: number;
  /** 默认向量检索权重 */
  defaultVectorWeight: number;
  /** 默认超时时间 (ms) */
  defaultTimeout: number;
  /** 默认最小分数阈值 */
  defaultMinScore: number;
  /** 默认返回数量 */
  defaultTopK: number;
}

/**
 * 默认混合检索引擎配置
 */
export const DEFAULT_HYBRID_SEARCH_ENGINE_CONFIG: HybridSearchEngineConfig = {
  enabled: true,
  defaultKeywordWeight: 0.4,
  defaultVectorWeight: 0.6,
  defaultTimeout: 500,
  defaultMinScore: 0.3,
  defaultTopK: 10,
};

// ==================== 错误类型 ====================

/**
 * 混合检索错误码
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */
export enum HybridSearchErrorCode {
  KEYWORD_INDEX_UNAVAILABLE = 'KEYWORD_INDEX_UNAVAILABLE',
  VECTOR_SEARCH_FAILED = 'VECTOR_SEARCH_FAILED',
  METADATA_ENHANCEMENT_FAILED = 'METADATA_ENHANCEMENT_FAILED',
  LLM_SERVICE_UNAVAILABLE = 'LLM_SERVICE_UNAVAILABLE',
  INDEX_CORRUPTION = 'INDEX_CORRUPTION',
  TIMEOUT = 'TIMEOUT',
}

/**
 * 混合检索错误
 */
export class HybridSearchError extends Error {
  constructor(
    public code: HybridSearchErrorCode,
    message: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'HybridSearchError';
  }
}

// ==================== 迁移类型 ====================

/**
 * 迁移结果
 * Requirements: 5.6
 */
export interface MigrationResult {
  /** 总条目数 */
  total: number;
  /** 成功数 */
  success: number;
  /** 失败数 */
  failed: number;
  /** 跳过数（已增强） */
  skipped: number;
  /** 失败的条目 ID 列表 */
  failedIds: string[];
  /** 迁移耗时 (ms) */
  duration: number;
}

/**
 * 迁移进度
 */
export interface MigrationProgress {
  /** 当前处理的条目索引 */
  current: number;
  /** 总条目数 */
  total: number;
  /** 已成功数 */
  success: number;
  /** 已失败数 */
  failed: number;
  /** 进度百分比 */
  percentage: number;
  /** 预计剩余时间 (ms) */
  estimatedRemaining: number;
}

/**
 * 验证结果
 * Requirements: 5.6
 */
export interface VerificationResult {
  /** 是否通过验证 */
  passed: boolean;
  /** 总条目数 */
  totalEntries: number;
  /** 已增强条目数 */
  enhancedEntries: number;
  /** 已索引条目数 */
  indexedEntries: number;
  /** 问题列表 */
  issues: string[];
}

// ==================== 统计类型 ====================

/**
 * 混合检索统计
 * Requirements: 6.1, 6.2, 6.3
 */
export interface HybridSearchStats {
  /** 总搜索次数 */
  totalSearches: number;
  /** 关键词检索命中率 */
  keywordHitRate: number;
  /** 向量检索命中率 */
  vectorHitRate: number;
  /** 平均关键词检索耗时 (ms) */
  avgKeywordSearchTime: number;
  /** 平均向量检索耗时 (ms) */
  avgVectorSearchTime: number;
  /** 平均总耗时 (ms) */
  avgTotalTime: number;
  /** 降级率 */
  degradationRate: number;
  /** 元数据增强成功率 */
  enhancementSuccessRate: number;
  /** LLM 使用次数 */
  llmUsageCount: number;
  /** 降级增强次数 */
  fallbackEnhancementCount: number;
}

/**
 * 默认混合检索统计
 */
export const DEFAULT_HYBRID_SEARCH_STATS: HybridSearchStats = {
  totalSearches: 0,
  keywordHitRate: 0,
  vectorHitRate: 0,
  avgKeywordSearchTime: 0,
  avgVectorSearchTime: 0,
  avgTotalTime: 0,
  degradationRate: 0,
  enhancementSuccessRate: 0,
  llmUsageCount: 0,
  fallbackEnhancementCount: 0,
};
