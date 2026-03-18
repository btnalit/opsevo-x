/**
 * RAGEngine 检索增强生成引擎
 * 结合向量检索和 LLM 生成能力，提供增强的 AI 分析
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8
 * - 4.1: 分析告警时检索相关历史告警及其解决方案
 * - 4.2: 生成修复方案时检索类似的历史修复方案及其结果
 * - 4.3: 执行根因分析时检索相关历史事件
 * - 4.4: 按相关性分数和时效性对检索文档排序
 * - 4.5: 构建 LLM 提示词时包含 top-k 最相关的检索文档作为上下文
 * - 4.6: 支持可配置的检索参数（top-k、相似度阈值、时效性权重）
 * - 4.7: 未找到相关文档时回退到标准分析（无 RAG 上下文）
 * - 4.8: 记录检索统计用于监控和优化
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7
 * - 6.1: 分析告警时检索 top 5 最相似的历史告警
 * - 6.2: 找到相似告警时在 AI 提示词中包含其分析和解决方案
 * - 6.3: 相似告警有成功解决方案时突出显示已验证的解决方案
 * - 6.4: 显示每个引用历史告警的相似度分数和来源
 * - 6.5: 当前告警高置信度匹配已知模式时优先使用基于模式的分析
 * - 6.7: 生成分析时引用具体的历史案例
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 * - 7.1: 生成修复方案时检索类似的历史修复方案
 * - 7.2: 找到类似方案时分析其成功率和结果
 * - 7.3: 类似方案成功率高时推荐采用该方案
 * - 7.4: 显示推荐修复步骤的历史成功率
 * - 7.5: 类似方案有失败记录时警告潜在风险
 * - 7.6: 跟踪修复结果以改进未来推荐
 * - 7.7: 生成命令时根据历史成功命令进行验证
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 * - 8.1: 提议配置变更时检索类似的历史配置变更
 * - 8.2: 找到类似变更时分析其结果（成功、失败、回滚）
 * - 8.3: 类似变更导致问题时警告具体风险
 * - 8.4: 基于历史变更结果计算风险评分
 * - 8.5: 风险评分超过阈值时要求额外确认
 * - 8.6: 基于成功的历史变更建议更安全的替代方案
 * - 8.7: 跟踪配置变更结果以改进未来风险评估
 *
 * Architecture Optimization Requirements: 1.2, 10.1, 10.2, 10.5
 * - 1.2: 通过 ServiceRegistry 获取 AIAnalyzer 实例，而非使用动态 require()
 * - 10.1: 知识库检索返回空结果时返回明确的"无相关知识"状态
 * - 10.2: 知识库服务出错时返回明确的"服务故障"错误
 * - 10.5: 记录检索失败的详细原因用于诊断
 *
 * Feedback Integration:
 * - 在告警分析时获取该告警的历史反馈和规则统计
 * - 将反馈信息纳入 LLM 提示词，帮助 AI 更好地理解告警的历史处理情况
 * - 高误报率规则会在分析中标注警告
 * - 返回结果中包含 feedbackInfo 字段，供前端展示
 */

import { KnowledgeBase, knowledgeBase, KnowledgeSearchResult, KnowledgeEntry } from './knowledgeBase';
import { serviceRegistry } from '../../serviceRegistry';
import { logger } from '../../../utils/logger';
import { feedbackService, FeedbackService } from '../feedbackService';
import { ConcurrencyController } from '../concurrencyController';
import {
  AlertEvent,
  SystemMetrics,
  RootCauseAnalysis,
  RemediationPlan,
  SnapshotDiff,
  AnalysisResult,
  RiskLevel,
  UnifiedEvent,
  ExecutionResult,
  IAIAnalyzer,
  KnowledgeRetrievalError,
  KnowledgeRetrievalErrorCode,
  AlertFeedback,
  FeedbackStats,
  OperationalRule,
} from '../../../types/ai-ops';
import {
  ruleEvolutionService,
  RuleEvolutionService,
} from '../ruleEvolutionService';

// ==================== 类型定义 ====================

/**
 * 告警类别
 * Requirements: 1.1, 1.2 - 告警初步分析与分类
 */
export type AlertCategory = 'interface' | 'traffic' | 'resource' | 'security' | 'other';

/**
 * 告警分类结果
 * Requirements: 1.1, 1.2 - 告警初步分析与分类
 */
export interface AlertClassification {
  /** 指标类型: interface_status, traffic, cpu, memory, disk 等 */
  metricType: string;
  /** 告警类别: interface, traffic, resource, security, other */
  category: AlertCategory;
  /** 严重级别 */
  severity: string;
  /** 关键词列表 */
  keywords: string[];
  /** 分类置信度 (0-1) */
  confidence: number;
}

/**
 * RAG 上下文
 */
export interface RAGContext {
  query: string;
  retrievedDocuments: KnowledgeSearchResult[];
  retrievalTime: number;
  candidatesConsidered: number;
}

/**
 * RAG 响应
 */
export interface RAGResponse {
  answer: string;
  context: RAGContext;
  citations: Array<{
    entryId: string;
    title: string;
    relevance: number;
    excerpt: string;
  }>;
  confidence: number;
}

/**
 * RAG 查询结果（改进版，包含状态信息）
 * Requirements: 10.1, 10.2 - 区分"无相关知识"和"服务故障"
 */
export interface RAGQueryResult {
  answer: string;
  context: RAGContext;
  citations: Array<{
    entryId: string;
    title: string;
    relevance: number;
    excerpt: string;
  }>;
  confidence: number;
  /** 查询状态：success=成功, no_results=无相关知识, fallback=回退到标准分析 */
  status: 'success' | 'no_results' | 'fallback';
}

/**
 * RAG 配置
 * Requirements: 3.1, 3.2, 3.4, 3.5 - 相似度阈值优化
 */
export interface RAGConfig {
  topK: number;              // 检索数量，默认 5
  minScore: number;          // 最小相似度，默认 0.7 (从 0.5 提高)
  alertMinScore: number;     // 告警分析最小相似度，默认 0.75 (新增)
  crossTypeMinScore: number; // 跨类型搜索最小相似度，默认 0.85 (新增)
  recencyWeight: number;     // 时效性权重，默认 0.2
  maxContextLength: number;  // 最大上下文长度，默认 4000
  includeMetadata: boolean;  // 是否包含元数据，默认 true
}

/**
 * 历史告警引用
 */
export interface HistoricalAlertReference {
  alertId: string;
  similarity: number;
  resolution?: string;
  outcome?: 'success' | 'partial' | 'failed';
}

/**
 * 历史参考状态
 * Requirements: 5.1, 5.2 - 分析结果展示增强
 * - 'found': 找到相同类型的历史参考
 * - 'not_found': 未找到任何历史参考
 * - 'type_mismatch': 仅找到不同类型的历史参考（跨类型搜索结果）
 */
export type ReferenceStatus = 'found' | 'not_found' | 'type_mismatch';

/**
 * 可执行修复步骤
 * 由 LLM 在 RAG 分析时生成
 */
export interface ExecutableStep {
  /** 步骤序号 */
  order: number;
  /** 步骤描述 */
  description: string;
  /** 设备命令 */
  command: string;
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 是否可自动执行 */
  autoExecutable: boolean;
  /** 预估执行时间（秒） */
  estimatedDuration: number;
}

/**
 * 增强告警分析结果
 * Requirements: 5.1, 5.2 - 分析结果展示增强
 */
export interface EnhancedAlertAnalysis {
  analysis: AnalysisResult;
  ragContext: RAGContext;
  historicalReferences: HistoricalAlertReference[];
  /** 是否有历史参考 - Requirement 5.1 */
  hasHistoricalReference: boolean;
  /** 参考状态 - Requirement 5.2 */
  referenceStatus: ReferenceStatus;
  /** 告警分类结果 - Requirements 1.1-1.3 */
  classification: AlertClassification;
  /** 可执行修复步骤 - 由 LLM 生成 */
  executableSteps?: ExecutableStep[];
  /** 用户反馈信息 - 用于增强分析 */
  feedbackInfo?: {
    /** 该告警的历史反馈 */
    alertFeedback: AlertFeedback[];
    /** 该规则的反馈统计 */
    ruleStats: FeedbackStats;
    /** 是否为高误报率规则 */
    isHighFalsePositiveRule: boolean;
  };
}

/**
 * 历史修复方案引用
 */
export interface HistoricalPlanReference {
  planId: string;
  similarity: number;
  successRate: number;
  adaptations?: string[];
}

/**
 * 增强修复方案
 */
export interface EnhancedRemediationPlan {
  plan: RemediationPlan;
  ragContext: RAGContext;
  historicalPlans: HistoricalPlanReference[];
}

/**
 * 配置风险评估结果
 */
export interface ConfigRiskAssessment {
  riskScore: number;
  historicalOutcomes: Array<{ changeType: string; outcome: string; count: number }>;
  warnings: string[];
  suggestions: string[];
}

/**
 * 检索统计
 */
export interface RAGStats {
  queriesProcessed: number;
  avgRetrievalTime: number;
  avgRelevanceScore: number;
  cacheHits: number;
  fallbackCount: number;
}

/**
 * 告警分析缓存条目
 * Requirements: 1.1, 1.3, 1.4 - 分析结果缓存机制
 */
export interface AlertAnalysisCacheEntry {
  alertId: string;
  analysis: EnhancedAlertAnalysis;
  timestamp: number;
  ttl: number;
}

/**
 * 根因分析缓存条目
 * Requirements (syslog-cpu-spike-fix): 1.1, 1.2, 1.3, 1.4, 1.5 - 根因分析缓存机制
 */
export interface RootCauseAnalysisCacheEntry {
  /** 事件 ID */
  eventId: string;
  /** 分析结果 */
  analysis: RootCauseAnalysis;
  /** 缓存时间戳 */
  timestamp: number;
  /** 缓存 TTL（毫秒） */
  ttl: number;
}

/**
 * 根因分析缓存统计
 * Requirements (syslog-cpu-spike-fix): 6.2 - 缓存统计信息
 */
export interface RootCauseCacheStats {
  /** 缓存大小 */
  size: number;
  /** 缓存命中次数 */
  hits: number;
  /** 缓存未命中次数 */
  misses: number;
  /** 命中率 */
  hitRate: number;
  /** 最旧条目时间戳 */
  oldestEntry: number | null;
}

/**
 * 分析缓存统计
 * Requirements: 6.1, 6.5 - 缓存统计信息
 */
export interface AnalysisCacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  oldestEntry: number | null;
}

// 默认配置
// Requirements: 3.1, 3.2, 3.4, 3.5 - 相似度阈值优化
const DEFAULT_RAG_CONFIG: RAGConfig = {
  topK: 5,
  minScore: 0.7,             // 从 0.5 提高到 0.7 (Requirement 3.1)
  alertMinScore: 0.75,       // 新增：告警分析使用更高阈值 (Requirement 3.2, 3.4)
  crossTypeMinScore: 0.85,   // 新增：跨类型搜索使用更高阈值 (Requirement 3.5)
  recencyWeight: 0.2,
  maxContextLength: 4000,
  includeMetadata: true,
};

// 默认缓存 TTL (30分钟)
// Requirements: 1.4 - 可配置的缓存过期时间
const DEFAULT_CACHE_TTL = 30 * 60 * 1000;

/**
 * RAG 并发控制配置
 * Requirements (syslog-cpu-spike-fix): 5.1, 5.2, 5.3, 5.4 - RAG 分析并发控制
 */
export interface RAGConcurrencyConfig {
  /** 最大并发 RAG 分析数，默认 3 */
  maxConcurrent: number;
  /** 最大等待队列大小，默认 50 */
  maxQueueSize: number;
  /** 单次分析超时（毫秒），默认 60000 */
  analysisTimeout: number;
}

/**
 * RAG 并发统计
 * Requirements (syslog-cpu-spike-fix): 6.2 - 并发统计信息
 */
export interface RAGConcurrencyStats {
  /** 当前活跃的 RAG 分析数 */
  activeAnalyses: number;
  /** 等待队列长度 */
  queueLength: number;
  /** 总处理数 */
  totalProcessed: number;
  /** 因队列满而被拒绝的数量 */
  rejected: number;
  /** 超时数量 */
  timedOut: number;
}

// 默认 RAG 并发控制配置
// Requirements (syslog-cpu-spike-fix): 5.1, 5.2, 5.3, 5.4
const DEFAULT_RAG_CONCURRENCY_CONFIG: RAGConcurrencyConfig = {
  maxConcurrent: 3,
  maxQueueSize: 50,
  analysisTimeout: 60000,
};

// ==================== 告警分类器 ====================



/**
 * RAGEngine 检索增强生成引擎类
 */
export class RAGEngine {
  private knowledgeBase: KnowledgeBase;
  private _aiAnalyzer: IAIAnalyzer | null = null;
  private _feedbackService: FeedbackService;
  private _ruleEvolutionService: RuleEvolutionService;
  private config: RAGConfig;
  private initialized: boolean = false;
  // 统计信息
  private stats: RAGStats = {
    queriesProcessed: 0,
    avgRetrievalTime: 0,
    avgRelevanceScore: 0,
    cacheHits: 0,
    fallbackCount: 0,
  };

  // 分析结果缓存 - Requirements: 1.1, 1.4
  private analysisCache: Map<string, AlertAnalysisCacheEntry> = new Map();

  // 缓存统计 - Requirements: 6.1, 6.5
  private analysisCacheStats: { hits: number; misses: number } = { hits: 0, misses: 0 };

  // 根因分析缓存 - Requirements (syslog-cpu-spike-fix): 1.1, 1.2, 1.3, 1.4, 1.5
  private rootCauseAnalysisCache: Map<string, RootCauseAnalysisCacheEntry> = new Map();

  // 根因分析缓存统计 - Requirements (syslog-cpu-spike-fix): 6.2
  private rootCauseCacheStats: { hits: number; misses: number } = { hits: 0, misses: 0 };

  // 缓存清理定时器
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  // RAG 分析并发控制器 - Requirements (syslog-cpu-spike-fix): 5.1, 5.2, 5.3, 5.4
  private ragConcurrencyController: ConcurrencyController<UnifiedEvent, RootCauseAnalysis> | null = null;
  private ragConcurrencyConfig: RAGConcurrencyConfig = DEFAULT_RAG_CONCURRENCY_CONFIG;

  /**
   * Lazy getter for AIAnalyzer
   * Requirement 1.2: 通过 ServiceRegistry 获取 AIAnalyzer 实例，而非使用动态 require()
   */
  private get aiAnalyzer(): IAIAnalyzer {
    if (!this._aiAnalyzer) {
      // Try to get from ServiceRegistry first
      const registeredAnalyzer = serviceRegistry.tryGet<IAIAnalyzer>('AIAnalyzer');
      if (registeredAnalyzer) {
        this._aiAnalyzer = registeredAnalyzer;
        logger.debug('RAGEngine: Got AIAnalyzer from ServiceRegistry');
      } else {
        // Fallback: Import directly (for backward compatibility during migration)
        // This will be removed once all services are registered in ServiceRegistry
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { AIAnalyzer } = require('../aiAnalyzer');
        this._aiAnalyzer = new AIAnalyzer();
        logger.warn('RAGEngine: AIAnalyzer not found in ServiceRegistry, using direct import (fallback)');
      }
    }
    return this._aiAnalyzer!;
  }

  constructor(
    knowledgeBaseInstance?: KnowledgeBase,
    aiAnalyzerInstance?: IAIAnalyzer,
    config?: Partial<RAGConfig>,
    feedbackServiceInstance?: FeedbackService,
    ruleEvolutionServiceInstance?: RuleEvolutionService
  ) {
    this.knowledgeBase = knowledgeBaseInstance || knowledgeBase;
    if (aiAnalyzerInstance) {
      this._aiAnalyzer = aiAnalyzerInstance;
    }
    this._feedbackService = feedbackServiceInstance || feedbackService;
    this._ruleEvolutionService = ruleEvolutionServiceInstance || ruleEvolutionService;
    this.config = { ...DEFAULT_RAG_CONFIG, ...config };

    logger.info('RAGEngine created', { config: this.config });
  }

  /**
   * 设置 AIAnalyzer 实例
   * 用于 ServiceRegistry 集成和测试
   * Requirement 1.2: 支持通过 ServiceRegistry 注入 AIAnalyzer
   */
  setAIAnalyzer(analyzer: IAIAnalyzer): void {
    this._aiAnalyzer = analyzer;
    logger.debug('RAGEngine: AIAnalyzer instance set');
  }

  // ==================== 分析缓存方法 ====================

  /**
   * 获取缓存的分析结果
   * Requirements: 1.1, 1.2 - 缓存读取
   * @param alertId 告警ID
   * @returns 缓存的分析结果，如果不存在或已过期则返回 null
   */
  private getCachedAnalysis(alertId: string): EnhancedAlertAnalysis | null {
    const entry = this.analysisCache.get(alertId);

    if (!entry) {
      this.analysisCacheStats.misses++;
      logger.debug('Analysis cache miss', { alertId });
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      // 缓存已过期，删除并返回 null
      this.analysisCache.delete(alertId);
      this.analysisCacheStats.misses++;
      logger.debug('Analysis cache expired', { alertId, age: now - entry.timestamp, ttl: entry.ttl });
      return null;
    }

    // 缓存命中
    this.analysisCacheStats.hits++;
    this.stats.cacheHits++;
    logger.debug('Analysis cache hit', { alertId, age: now - entry.timestamp });
    return entry.analysis;
  }

  /**
   * 缓存分析结果
   * Requirements: 1.3, 1.4 - 缓存写入
   * @param alertId 告警ID
   * @param analysis 分析结果
   * @param ttl 可选的自定义 TTL（毫秒）
   */
  private cacheAnalysis(alertId: string, analysis: EnhancedAlertAnalysis, ttl?: number): void {
    const entry: AlertAnalysisCacheEntry = {
      alertId,
      analysis,
      timestamp: Date.now(),
      ttl: ttl || DEFAULT_CACHE_TTL,
    };

    this.analysisCache.set(alertId, entry);
    logger.debug('Analysis cached', { alertId, ttl: entry.ttl, cacheSize: this.analysisCache.size });
  }

  /**
   * 使分析缓存失效
   * Requirements: 1.5, 1.7, 6.2, 6.3, 6.4 - 缓存失效
   * @param alertId 可选的告警ID，不传则清空所有缓存
   */
  invalidateAnalysisCache(alertId?: string): void {
    if (alertId) {
      // 失效单个缓存
      const deleted = this.analysisCache.delete(alertId);
      logger.info('Analysis cache invalidated', { alertId, deleted });
    } else {
      // 清空所有缓存
      const size = this.analysisCache.size;
      this.analysisCache.clear();
      logger.info('All analysis cache cleared', { clearedEntries: size });
    }
  }

  /**
   * 获取分析缓存统计
   * Requirements: 6.1, 6.5 - 缓存统计
   * @returns 缓存统计信息
   */
  getAnalysisCacheStats(): AnalysisCacheStats {
    const totalRequests = this.analysisCacheStats.hits + this.analysisCacheStats.misses;
    const hitRate = totalRequests > 0 ? this.analysisCacheStats.hits / totalRequests : 0;

    // 找出最旧的缓存条目
    let oldestEntry: number | null = null;
    for (const entry of this.analysisCache.values()) {
      if (oldestEntry === null || entry.timestamp < oldestEntry) {
        oldestEntry = entry.timestamp;
      }
    }

    return {
      size: this.analysisCache.size,
      hits: this.analysisCacheStats.hits,
      misses: this.analysisCacheStats.misses,
      hitRate,
      oldestEntry,
    };
  }

  // ==================== 根因分析缓存方法 ====================
  // Requirements (syslog-cpu-spike-fix): 1.1, 1.2, 1.3, 1.4, 1.5

  /**
   * 获取缓存的根因分析结果
   * Requirements (syslog-cpu-spike-fix): 1.1, 1.2 - 缓存读取
   * @param eventId 事件 ID
   * @returns 缓存的分析结果，如果不存在或已过期则返回 null
   */
  getCachedRootCauseAnalysis(eventId: string): RootCauseAnalysis | null {
    const entry = this.rootCauseAnalysisCache.get(eventId);

    if (!entry) {
      this.rootCauseCacheStats.misses++;
      logger.debug('Root cause analysis cache miss', { eventId });
      return null;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      // 缓存已过期，删除并返回 null
      this.rootCauseAnalysisCache.delete(eventId);
      this.rootCauseCacheStats.misses++;
      logger.debug('Root cause analysis cache expired', { eventId, age: now - entry.timestamp, ttl: entry.ttl });
      return null;
    }

    // 缓存命中
    this.rootCauseCacheStats.hits++;
    this.stats.cacheHits++;
    logger.debug('Root cause analysis cache hit', { eventId, age: now - entry.timestamp });
    return entry.analysis;
  }

  /**
   * 缓存根因分析结果
   * Requirements (syslog-cpu-spike-fix): 1.3 - 缓存写入
   * @param eventId 事件 ID
   * @param analysis 分析结果
   * @param ttl 可选的自定义 TTL（毫秒），默认 30 分钟
   */
  cacheRootCauseAnalysis(eventId: string, analysis: RootCauseAnalysis, ttl?: number): void {
    const entry: RootCauseAnalysisCacheEntry = {
      eventId,
      analysis,
      timestamp: Date.now(),
      ttl: ttl || DEFAULT_CACHE_TTL,
    };

    this.rootCauseAnalysisCache.set(eventId, entry);
    logger.debug('Root cause analysis cached', { eventId, ttl: entry.ttl, cacheSize: this.rootCauseAnalysisCache.size });
  }

  /**
   * 使根因分析缓存失效
   * Requirements (syslog-cpu-spike-fix): 1.4 - 缓存失效
   * @param eventId 可选的事件 ID，不传则清空所有缓存
   */
  invalidateRootCauseCache(eventId?: string): void {
    if (eventId) {
      // 失效单个缓存
      const deleted = this.rootCauseAnalysisCache.delete(eventId);
      logger.info('Root cause analysis cache invalidated', { eventId, deleted });
    } else {
      // 清空所有缓存
      const size = this.rootCauseAnalysisCache.size;
      this.rootCauseAnalysisCache.clear();
      logger.info('All root cause analysis cache cleared', { clearedEntries: size });
    }
  }

  /**
   * 获取根因分析缓存统计
   * Requirements (syslog-cpu-spike-fix): 6.2 - 缓存统计
   * @returns 缓存统计信息
   */
  getRootCauseCacheStats(): RootCauseCacheStats {
    const totalRequests = this.rootCauseCacheStats.hits + this.rootCauseCacheStats.misses;
    const hitRate = totalRequests > 0 ? this.rootCauseCacheStats.hits / totalRequests : 0;

    // 找出最旧的缓存条目
    let oldestEntry: number | null = null;
    for (const entry of this.rootCauseAnalysisCache.values()) {
      if (oldestEntry === null || entry.timestamp < oldestEntry) {
        oldestEntry = entry.timestamp;
      }
    }

    return {
      size: this.rootCauseAnalysisCache.size,
      hits: this.rootCauseCacheStats.hits,
      misses: this.rootCauseCacheStats.misses,
      hitRate,
      oldestEntry,
    };
  }

  /**
   * 清理过期缓存
   * Requirement 1.6 - 定期清理过期缓存
   * Requirements (syslog-cpu-spike-fix): 1.5 - 清理过期的根因分析缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    // 清理告警分析缓存
    for (const [alertId, entry] of this.analysisCache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.analysisCache.delete(alertId);
        cleanedCount++;
      }
    }

    // 清理根因分析缓存 - Requirements (syslog-cpu-spike-fix): 1.5
    let rootCauseCleanedCount = 0;
    for (const [eventId, entry] of this.rootCauseAnalysisCache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.rootCauseAnalysisCache.delete(eventId);
        rootCauseCleanedCount++;
      }
    }

    if (cleanedCount > 0 || rootCauseCleanedCount > 0) {
      logger.debug('Expired cache cleaned', {
        analysisCleanedCount: cleanedCount,
        rootCauseCleanedCount,
        analysisRemainingSize: this.analysisCache.size,
        rootCauseRemainingSize: this.rootCauseAnalysisCache.size,
      });
    }
  }

  /**
   * 停止缓存清理定时器
   * 用于服务关闭时释放资源，防止内存泄漏
   * 
   * Requirements (ai-ops-code-review-fixes): 2.1, 2.2, 2.3, 2.4
   * - 2.1: 暴露公开的 stopCleanupTimer() 方法
   * - 2.2: 调用时清除 cacheCleanupTimer interval
   * - 2.3: 调用时将 cacheCleanupTimer 设置为 null
   * - 2.4: 方法签名与 DecisionEngine, RootCauseAnalyzer, CriticService 保持一致
   */
  stopCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.info('RAGEngine cleanup timer stopped');
    }
  }

  /**
   * 初始化 RAG 引擎
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('RAGEngine already initialized');
      return;
    }

    try {
      // 初始化知识库
      if (!this.knowledgeBase.isInitialized()) {
        await this.knowledgeBase.initialize();
      }

      // 初始化 AI 分析器
      await this.aiAnalyzer.initialize();

      // 初始化反馈服务
      await this._feedbackService.initialize();

      // 注册反馈索引处理器，将反馈自动索引到向量数据库
      this._feedbackService.setFeedbackIndexHandler(async (feedback, alertInfo) => {
        await this.indexFeedbackToKnowledgeBase(feedback, alertInfo);
      });

      // 初始化规则进化服务
      await this._ruleEvolutionService.initialize();

      // 设置缓存清理定时器 - Requirement 1.6
      // 每5分钟清理一次过期缓存
      this.cacheCleanupTimer = setInterval(() => {
        this.cleanupExpiredCache();
      }, 5 * 60 * 1000);

      // 初始化 RAG 并发控制器 - Requirements (syslog-cpu-spike-fix): 5.1, 5.2, 5.3, 5.4
      this.ragConcurrencyController = new ConcurrencyController<UnifiedEvent, RootCauseAnalysis>({
        maxConcurrent: this.ragConcurrencyConfig.maxConcurrent,
        maxQueueSize: this.ragConcurrencyConfig.maxQueueSize,
        taskTimeout: this.ragConcurrencyConfig.analysisTimeout,
        enablePriorityQueue: true,
        enableBackpressure: true,
        backpressureThreshold: 0.8,
      });
      // 设置处理器为内部的根因分析方法
      this.ragConcurrencyController.setProcessor((event) => this.executeRootCauseAnalysis(event));
      logger.info('RAG concurrency controller initialized', { config: this.ragConcurrencyConfig });

      this.initialized = true;
      logger.info('RAGEngine initialized');
    } catch (error) {
      logger.error('Failed to initialize RAGEngine', { error });
      throw error;
    }
  }

  /**
   * 将反馈索引到知识库
   * 用于语义匹配检索相关反馈
   */
  private async indexFeedbackToKnowledgeBase(
    feedback: AlertFeedback,
    alertInfo?: {
      ruleName?: string;
      message?: string;
      metric?: string;
      severity?: string;
    }
  ): Promise<void> {
    // 构建反馈内容
    let content = `## 用户反馈\n\n`;
    content += `- **告警ID**: ${feedback.alertId}\n`;
    content += `- **评价**: ${feedback.useful ? '有用' : '无用'}\n`;
    content += `- **时间**: ${new Date(feedback.timestamp).toISOString()}\n`;

    if (alertInfo) {
      content += `\n## 告警信息\n\n`;
      if (alertInfo.ruleName) content += `- **规则名称**: ${alertInfo.ruleName}\n`;
      if (alertInfo.message) content += `- **告警消息**: ${alertInfo.message}\n`;
      if (alertInfo.metric) content += `- **指标类型**: ${alertInfo.metric}\n`;
      if (alertInfo.severity) content += `- **严重级别**: ${alertInfo.severity}\n`;
    }

    if (feedback.comment) {
      content += `\n## 用户评论\n\n${feedback.comment}\n`;
    }

    if (feedback.tags && feedback.tags.length > 0) {
      content += `\n## 标签\n\n${feedback.tags.join(', ')}\n`;
    }

    // 构建标题
    const title = alertInfo?.ruleName
      ? `反馈: ${alertInfo.ruleName} - ${feedback.useful ? '有用' : '无用'}`
      : `反馈: ${feedback.alertId} - ${feedback.useful ? '有用' : '无用'}`;

    // 构建标签
    const tags = ['feedback', feedback.useful ? 'useful' : 'not_useful'];
    if (feedback.tags) {
      tags.push(...feedback.tags);
    }

    // 添加到知识库
    await this.knowledgeBase.add({
      type: 'feedback',
      title,
      content,
      metadata: {
        source: 'user_feedback',
        timestamp: feedback.timestamp,
        category: 'feedback',
        tags,
        usageCount: 0,
        feedbackScore: feedback.useful ? 1 : -1,
        feedbackCount: 1,
        relatedIds: [feedback.alertId],
        metricType: alertInfo?.metric,
        originalData: {
          feedbackId: feedback.id,
          alertId: feedback.alertId,
          useful: feedback.useful,
          comment: feedback.comment,
          tags: feedback.tags,
          metric: alertInfo?.metric, // 用于 metricType 过滤
        },
      },
    });

    logger.info(`Feedback indexed to knowledge base: ${feedback.id}`, {
      alertId: feedback.alertId,
      useful: feedback.useful,
    });
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RAGEngine not initialized. Call initialize() first.');
    }
  }

  // ==================== 通用 RAG 查询 ====================

  /**
   * 通用 RAG 查询
   * Requirements: 4.4, 4.5, 4.6, 4.7, 4.8
   * Requirements: 10.1, 10.2, 10.5 - 区分错误类型并记录详细原因
   * Requirements: 13.4 - 使用 KnowledgeBase 的排序功能，而非在内存中重新排序
   * @throws KnowledgeRetrievalError 当查询无效时（INVALID_QUERY）
   */
  async query(question: string, context?: Record<string, unknown>): Promise<RAGQueryResult> {
    this.ensureInitialized();

    // Validate query
    if (!question || question.trim().length === 0) {
      logger.warn('RAG query failed: empty question', { question });
      throw new KnowledgeRetrievalError(
        KnowledgeRetrievalErrorCode.INVALID_QUERY,
        '查询问题不能为空'
      );
    }

    const startTime = Date.now();
    let retrievedDocs: KnowledgeSearchResult[] = [];
    let candidatesConsidered = 0;
    let retrievalError: Error | null = null;
    let status: RAGQueryResult['status'] = 'success';

    try {
      // Requirements: 13.4 - 使用 KnowledgeBase 的排序功能
      // 检索相关文档，KnowledgeBase 会在数据库层面完成混合排序
      const searchResults = await this.knowledgeBase.search({
        query: question,
        limit: this.config.topK, // 直接请求 topK 数量，KnowledgeBase 会处理排序
        minScore: this.config.minScore,
        sortOptions: {
          recencyWeight: this.config.recencyWeight,
          enableHybridSort: true,
        },
      });

      candidatesConsidered = searchResults.length;

      // Requirements: 13.4 - 不再需要在内存中排序，KnowledgeBase 已完成排序
      retrievedDocs = searchResults;

      // 记录使用
      for (const doc of retrievedDocs) {
        await this.knowledgeBase.recordUsage(doc.entry.id);
      }

      // Requirement 10.1: 检查是否有结果
      if (retrievedDocs.length === 0) {
        status = 'no_results';
        logger.info('RAG query returned no results', {
          question: question.substring(0, 100),
          candidatesConsidered,
        });
      }

    } catch (error) {
      // Requirement 10.2, 10.5: 记录服务故障详细原因
      retrievalError = error instanceof Error ? error : new Error(String(error));
      logger.error('RAG retrieval failed with service error', {
        error: retrievalError.message,
        question: question.substring(0, 100),
        stack: retrievalError.stack,
      });
      this.stats.fallbackCount++;
      status = 'fallback';
    }

    const retrievalTime = Date.now() - startTime;

    // 构建 RAG 上下文
    const ragContext: RAGContext = {
      query: question,
      retrievedDocuments: retrievedDocs,
      retrievalTime,
      candidatesConsidered,
    };

    // 构建引用
    const citations = retrievedDocs.map(doc => ({
      entryId: doc.entry.id,
      title: doc.entry.title,
      relevance: doc.score,
      excerpt: doc.entry.content.substring(0, 200),
    }));

    // 生成回答
    let answer: string;
    let confidence: number;

    if (retrievedDocs.length > 0) {
      // 使用 RAG 上下文生成回答
      const contextText = this.buildContextText(retrievedDocs);
      answer = await this.generateAnswerWithContext(question, contextText, context);
      confidence = this.calculateConfidence(retrievedDocs);
    } else {
      // 回退到标准分析
      // Requirement 4.7: 未找到相关文档时回退到标准分析
      answer = await this.generateFallbackAnswer(question, context);
      confidence = 0.5;
      if (status === 'success') {
        status = 'no_results';
      }
    }

    // 更新统计
    this.updateStats(retrievalTime, retrievedDocs);

    return {
      answer,
      context: ragContext,
      citations,
      confidence,
      status,
    };
  }

  /**
   * 按相似度和时效性排序文档
   * Requirement 4.4: 按相关性分数和时效性对检索文档排序
   * 
   * @deprecated 此方法已弃用。Requirements 13.4 要求使用 KnowledgeBase 的排序功能。
   * 保留此方法仅用于向后兼容和内部使用（如 analyzeAlert、generateRemediation 等方法）。
   * 新代码应使用 KnowledgeBase.search() 的 sortOptions 参数。
   */
  private rankDocuments(documents: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
    const now = Date.now();
    const maxAge = 90 * 24 * 60 * 60 * 1000; // 90 天

    return documents
      .map(doc => {
        const age = now - doc.entry.metadata.timestamp;
        const recencyScore = Math.max(0, 1 - age / maxAge);
        const combinedScore =
          doc.score * (1 - this.config.recencyWeight) +
          recencyScore * this.config.recencyWeight;

        return { ...doc, combinedScore };
      })
      .sort((a, b) => (b as any).combinedScore - (a as any).combinedScore);
  }

  /**
   * 构建上下文文本
   * Requirement 4.5: 构建 LLM 提示词时包含 top-k 最相关的检索文档作为上下文
   */
  private buildContextText(documents: KnowledgeSearchResult[]): string {
    let contextText = '';
    let currentLength = 0;

    for (const doc of documents) {
      const docText = this.formatDocumentForContext(doc);

      if (currentLength + docText.length > this.config.maxContextLength) {
        // 截断以适应最大长度
        const remaining = this.config.maxContextLength - currentLength;
        if (remaining > 100) {
          contextText += docText.substring(0, remaining) + '...\n';
        }
        break;
      }

      contextText += docText + '\n\n';
      currentLength += docText.length + 2;
    }

    return contextText.trim();
  }

  /**
   * 格式化文档用于上下文
   */
  private formatDocumentForContext(doc: KnowledgeSearchResult): string {
    let text = `【历史案例】${doc.entry.title}\n`;
    text += `相似度: ${(doc.score * 100).toFixed(1)}%\n`;

    if (this.config.includeMetadata) {
      text += `类型: ${doc.entry.type}\n`;
      text += `时间: ${new Date(doc.entry.metadata.timestamp).toISOString()}\n`;
      if (doc.entry.metadata.tags.length > 0) {
        text += `标签: ${doc.entry.metadata.tags.join(', ')}\n`;
      }
    }

    text += `内容:\n${doc.entry.content}`;
    return text;
  }

  /**
   * 使用上下文生成回答
   */
  private async generateAnswerWithContext(
    question: string,
    contextText: string,
    additionalContext?: Record<string, unknown>
  ): Promise<string> {
    const prompt = `基于以下历史案例和知识，回答问题。

## 历史案例参考
${contextText}

## 问题
${question}

${additionalContext ? `## 附加上下文\n${JSON.stringify(additionalContext, null, 2)}` : ''}

请基于历史案例提供分析和建议，并引用相关的历史案例。`;

    try {
      const result = await this.aiAnalyzer.analyze({
        type: 'alert',
        context: { prompt },
      });
      return result.summary + (result.details ? `\n\n${result.details}` : '');
    } catch (error) {
      logger.error('Failed to generate answer with context', { error });
      return `基于历史案例分析：\n${contextText.substring(0, 500)}...`;
    }
  }

  /**
   * 生成回退回答（无 RAG 上下文）
   * Requirement 4.7: 未找到相关文档时回退到标准分析
   */
  private async generateFallbackAnswer(
    question: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    try {
      const result = await this.aiAnalyzer.analyze({
        type: 'alert',
        context: { question, ...context },
      });
      return result.summary + (result.details ? `\n\n${result.details}` : '');
    } catch (error) {
      logger.error('Failed to generate fallback answer', { error });
      return '无法生成分析结果，请稍后重试。';
    }
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(documents: KnowledgeSearchResult[]): number {
    if (documents.length === 0) return 0.5;

    const avgScore = documents.reduce((sum, doc) => sum + doc.score, 0) / documents.length;
    const countFactor = Math.min(1, documents.length / this.config.topK);

    return avgScore * 0.7 + countFactor * 0.3;
  }

  /**
   * 更新统计信息
   * Requirement 4.8: 记录检索统计用于监控和优化
   */
  private updateStats(retrievalTime: number, documents: KnowledgeSearchResult[]): void {
    this.stats.queriesProcessed++;

    // 更新平均检索时间
    this.stats.avgRetrievalTime =
      (this.stats.avgRetrievalTime * (this.stats.queriesProcessed - 1) + retrievalTime) /
      this.stats.queriesProcessed;

    // 更新平均相关性分数
    if (documents.length > 0) {
      const avgScore = documents.reduce((sum, doc) => sum + doc.score, 0) / documents.length;
      this.stats.avgRelevanceScore =
        (this.stats.avgRelevanceScore * (this.stats.queriesProcessed - 1) + avgScore) /
        this.stats.queriesProcessed;
    }
  }


  // ==================== 增强告警分析 ====================

  /**
   * 增强告警分析 - 完整 Agentic RAG 流程
   * Requirements: 1.1-1.5, 2.1-2.5, 3.1-3.5, 4.1-4.5, 5.1-5.5, 6.1-6.7
   * Requirements (Cache): 1.1, 1.2, 1.3 - 分析结果缓存
   * 
   * 流程：
   * 0. 检查缓存 - 如果有缓存直接返回
   * 1. 初步分析 - 告警分类
   * 2. RAG 检索 - 按类型精确匹配
   * 3. 无结果时回退到跨类型搜索（使用更高阈值）
   * 4. 汇总上下文
   * 5. LLM 深度分析
   * 6. 构建返回结果并缓存
   */
  async analyzeAlert(
    alertEvent: AlertEvent,
    metrics?: SystemMetrics
  ): Promise<EnhancedAlertAnalysis> {
    this.ensureInitialized();

    // Step 0: 检查缓存 - Requirements: 1.1, 1.2
    const cachedAnalysis = this.getCachedAnalysis(alertEvent.id);
    if (cachedAnalysis) {
      logger.info('Returning cached analysis', { alertId: alertEvent.id });
      return cachedAnalysis;
    }

    const startTime = Date.now();

    // Step 1: 智能理解与语义分类
    // Requirements: 1.1, 1.2, 1.5 - LLM 驱动分类与语义提取
    let classification: any;
    try {
      classification = await this.aiAnalyzer.analyzeClassifyAlert(alertEvent.message);
    } catch (error) {
      logger.warn('AI alert classification failed, using basic fallback', { error });
      classification = {
        category: 'other',
        subCategory: 'unknown',
        searchKeywords: [alertEvent.metric, alertEvent.ruleName],
        isProtocolIssue: false,
        reasoning: 'AI 分类器故障'
      };
    }

    // Step 2: RAG 检索 - 基于 AI 提取的关键词进行深度语义检索
    // Requirements: 2.1-2.5, 3.2, 3.4
    const alertMinScore = this.config.alertMinScore || 0.75;
    const queryKeywords = classification.searchKeywords?.join(' ') || alertEvent.message;
    const queryText = `分类: ${classification.category} 概念: ${queryKeywords} 消息: ${alertEvent.message}`;
    let searchResults = await this.knowledgeBase.search({
      query: queryText,
      // 移除 type: 'alert' 限制，让系统能查找到 type 为 syslog 且类别相同的数据
      category: classification.category !== 'other' ? classification.category : undefined,
      limit: this.config.topK + 1,
      minScore: alertMinScore,
      sortOptions: {
        recencyWeight: this.config.recencyWeight,
        enableHybridSort: true,
      },
    });

    // 排除当前告警自身（如果它已经被索引到知识库）
    searchResults = searchResults.filter(doc => {
      const originalData = doc.entry.metadata.originalData as Record<string, unknown> | undefined;
      const docAlertId = originalData?.alertId as string | undefined;
      return docAlertId !== alertEvent.id;
    }).slice(0, this.config.topK);

    // Step 3: 确定参考状态
    // Requirements: 2.3, 3.3, 3.5
    let referenceStatus: ReferenceStatus = 'not_found';

    if (searchResults.length > 0) {
      // 找到相同类型的历史参考
      referenceStatus = 'found';
      logger.debug('Found same-type historical references', {
        alertId: alertEvent.id,
        category: classification.category,
        count: searchResults.length,
      });
    } else {
      // 回退到跨类型搜索（使用更高阈值）
      // Requirement 2.3, 3.5
      const crossTypeMinScore = this.config.crossTypeMinScore || 0.85;
      logger.debug('No same-type results, falling back to cross-type search', {
        alertId: alertEvent.id,
        category: classification.category,
        crossTypeMinScore,
      });

      searchResults = await this.knowledgeBase.search({
        query: queryText,
        // 移除 type: 'alert' 限制，搜索所有类型的事件（包括 syslog）
        limit: this.config.topK + 1, // 多检索一个，以便排除当前告警
        minScore: crossTypeMinScore,
        sortOptions: {
          recencyWeight: this.config.recencyWeight,
          enableHybridSort: true,
        },
      });

      // 排除当前告警自身
      searchResults = searchResults.filter(doc => {
        const originalData = doc.entry.metadata.originalData as Record<string, unknown> | undefined;
        const docAlertId = originalData?.alertId as string | undefined;
        return docAlertId !== alertEvent.id;
      }).slice(0, this.config.topK);

      if (searchResults.length > 0) {
        referenceStatus = 'type_mismatch';
        logger.debug('Found cross-type historical references', {
          alertId: alertEvent.id,
          count: searchResults.length,
        });
      }
    }

    const retrievalTime = Date.now() - startTime;

    // Step 4: 汇总上下文
    // Requirement 4.1, 4.2
    const ragContext: RAGContext = {
      query: queryText,
      retrievedDocuments: searchResults,
      retrievalTime,
      candidatesConsidered: searchResults.length,
    };

    // 构建历史引用
    const historicalReferences = this.buildHistoricalAlertReferences(searchResults);

    // 记录使用
    for (const doc of searchResults) {
      await this.knowledgeBase.recordUsage(doc.entry.id);
    }

    // Step 4.5: 获取反馈数据（通过向量检索 + 直接查询）
    let feedbackInfo: EnhancedAlertAnalysis['feedbackInfo'] | undefined;
    let relatedFeedbackDocs: KnowledgeSearchResult[] = [];

    try {
      // 1. 通过向量检索获取语义相关的反馈
      const feedbackSearchResults = await this.knowledgeBase.search({
        query: queryText,
        type: 'feedback',
        limit: 5,
        minScore: 0.7,
        sortOptions: {
          recencyWeight: 0.3, // 反馈更注重时效性
          enableHybridSort: true,
        },
      });

      relatedFeedbackDocs = feedbackSearchResults;

      if (relatedFeedbackDocs.length > 0) {
        logger.debug('Found related feedback via vector search', {
          alertId: alertEvent.id,
          count: relatedFeedbackDocs.length,
          scores: relatedFeedbackDocs.map(d => d.score.toFixed(3)),
        });
      }

      // 2. 获取该告警的直接反馈和规则统计
      const alertFeedback = await this._feedbackService.getFeedback(alertEvent.id);
      // 对于 Syslog 事件，ruleId 可能为空，使用空字符串作为默认值
      const ruleStats = alertEvent.ruleId
        ? await this._feedbackService.getRuleStats(alertEvent.ruleId)
        : { ruleId: '', totalAlerts: 0, usefulCount: 0, notUsefulCount: 0, falsePositiveRate: 0, lastUpdated: Date.now() };
      const isHighFalsePositiveRule = ruleStats.falsePositiveRate >= 0.3 && ruleStats.totalAlerts >= 3;

      feedbackInfo = {
        alertFeedback,
        ruleStats,
        isHighFalsePositiveRule,
      };

      if (alertFeedback.length > 0 || ruleStats.totalAlerts > 0 || relatedFeedbackDocs.length > 0) {
        logger.debug('Feedback data retrieved for alert analysis', {
          alertId: alertEvent.id,
          ruleId: alertEvent.ruleId,
          directFeedbackCount: alertFeedback.length,
          relatedFeedbackCount: relatedFeedbackDocs.length,
          ruleStats: {
            totalAlerts: ruleStats.totalAlerts,
            usefulCount: ruleStats.usefulCount,
            falsePositiveRate: ruleStats.falsePositiveRate,
          },
          isHighFalsePositiveRule,
        });
      }
    } catch (error) {
      logger.warn('Failed to retrieve feedback data for alert analysis', {
        alertId: alertEvent.id,
        error
      });
    }

    // Step 5: LLM 深度分析
    // Requirements: 4.3, 4.4, 4.5
    let analysis: AnalysisResult;
    let executableSteps: ExecutableStep[] | undefined;

    // 判断是否有任何可用的上下文信息（历史告警或相关反馈）
    const hasHistoricalContext = searchResults.length > 0;
    const hasFeedbackContext = relatedFeedbackDocs.length > 0 ||
      (feedbackInfo?.alertFeedback && feedbackInfo.alertFeedback.length > 0) ||
      (feedbackInfo?.ruleStats && feedbackInfo.ruleStats.totalAlerts > 0);

    if (hasHistoricalContext || hasFeedbackContext) {
      // 使用 RAG 上下文增强分析（包括历史告警和/或反馈数据）
      const enhancedResult = await this.generateEnhancedAlertAnalysis(
        alertEvent,
        metrics,
        searchResults,
        historicalReferences,
        classification,
        referenceStatus,
        feedbackInfo,
        relatedFeedbackDocs
      );
      analysis = enhancedResult.analysis;
      executableSteps = enhancedResult.executableSteps;
    } else {
      // 回退到标准分析（无任何历史参考或反馈数据）
      // Requirement 4.7: 未找到相关文档时回退到标准分析
      this.stats.fallbackCount++;
      analysis = metrics
        ? await this.aiAnalyzer.analyzeAlert(alertEvent, metrics)
        : {
          summary: `告警: ${alertEvent.message}`,
          details: '首次遇到此类告警，无历史参考。建议检查相关配置和系统状态。',
          recommendations: ['建议检查相关配置和系统状态', '记录此告警的处理过程以便后续参考'],
          riskLevel: this.mapSeverityToRisk(alertEvent.severity),
          confidence: 0.5,
        };
    }

    // 更新统计
    this.updateStats(retrievalTime, searchResults);

    // Step 6: 构建返回结果并缓存
    // Requirements: 1.3, 5.1, 5.2
    const result: EnhancedAlertAnalysis = {
      analysis,
      ragContext,
      historicalReferences,
      hasHistoricalReference: searchResults.length > 0,
      referenceStatus,
      classification,
      executableSteps,
      feedbackInfo,
    };

    // 缓存分析结果 - Requirement 1.3
    this.cacheAnalysis(alertEvent.id, result);

    return result;
  }


  /**
   * 构建历史告警引用
   * Requirement 6.4: 显示每个引用历史告警的相似度分数和来源
   */
  private buildHistoricalAlertReferences(
    documents: KnowledgeSearchResult[]
  ): HistoricalAlertReference[] {
    return documents.map(doc => {
      const originalData = doc.entry.metadata.originalData as Record<string, unknown> | undefined;

      // 尝试从内容中提取解决方案
      let resolution: string | undefined;
      const content = doc.entry.content;
      if (content.includes('解决方案') || content.includes('修复')) {
        const match = content.match(/(?:解决方案|修复)[：:]\s*([^\n]+)/);
        resolution = match ? match[1] : undefined;
      }

      // 确定结果
      let outcome: 'success' | 'partial' | 'failed' | undefined;
      if (content.includes('成功') || content.includes('已解决')) {
        outcome = 'success';
      } else if (content.includes('部分') || content.includes('partial')) {
        outcome = 'partial';
      } else if (content.includes('失败') || content.includes('failed')) {
        outcome = 'failed';
      }

      return {
        alertId: (originalData?.alertId as string) || doc.entry.id,
        similarity: doc.score,
        resolution,
        outcome,
      };
    });
  }

  /**
   * 生成增强告警分析
   * Requirements: 4.5, 5.3, 5.4, 5.5, 6.2, 6.3, 6.7
   * - 在 LLM 提示词中包含分类信息
   * - 无历史参考时明确提示"首次遇到此类告警，无历史参考"
   * - 根据历史数据可用性调整置信度
   * - 同时生成可执行的修复步骤
   * - 包含语义相关的用户反馈
   */
  private async generateEnhancedAlertAnalysis(
    alertEvent: AlertEvent,
    metrics: SystemMetrics | undefined,
    documents: KnowledgeSearchResult[],
    historicalReferences: HistoricalAlertReference[],
    classification: any,
    referenceStatus: ReferenceStatus,
    feedbackInfo?: EnhancedAlertAnalysis['feedbackInfo'],
    relatedFeedbackDocs?: KnowledgeSearchResult[]
  ): Promise<{ analysis: AnalysisResult; executableSteps?: ExecutableStep[] }> {
    // 构建历史案例上下文
    const contextText = this.buildContextText(documents);

    // 找出成功解决的案例
    const successfulCases = historicalReferences.filter(ref => ref.outcome === 'success');

    // 构建增强提示词
    let enhancedPrompt = `## 当前告警
规则: ${alertEvent.ruleName}
消息: ${alertEvent.message}
指标: ${alertEvent.metric}
严重级别: ${alertEvent.severity}
当前值: ${alertEvent.currentValue}
阈值: ${alertEvent.threshold}

## 告警分类信息
告警类别: ${classification.category}
子类别: ${classification.subCategory}
分类原因: ${classification.reasoning}
关键词: ${classification.searchKeywords?.join(', ') || 'N/A'}
此问题是否属于特定协议问题: ${classification.isProtocolIssue ? '是' : '否'}

`;

    // 添加用户反馈信息
    if (feedbackInfo) {
      const { alertFeedback, ruleStats, isHighFalsePositiveRule } = feedbackInfo;

      if (ruleStats.totalAlerts > 0) {
        enhancedPrompt += `## 用户反馈统计
该规则历史反馈统计：
- 总告警数: ${ruleStats.totalAlerts}
- 有用反馈: ${ruleStats.usefulCount}
- 无用反馈: ${ruleStats.notUsefulCount}
- 误报率: ${(ruleStats.falsePositiveRate * 100).toFixed(1)}%
`;
        if (isHighFalsePositiveRule) {
          enhancedPrompt += `⚠️ 注意：该规则误报率较高，请谨慎评估告警的真实性。

`;
        } else {
          enhancedPrompt += `\n`;
        }
      }

      if (alertFeedback.length > 0) {
        enhancedPrompt += `## 该告警的历史反馈
`;
        for (const fb of alertFeedback.slice(0, 3)) {
          const feedbackTime = new Date(fb.timestamp).toISOString();
          enhancedPrompt += `- ${feedbackTime}: ${fb.useful ? '有用' : '无用'}`;
          if (fb.comment) {
            enhancedPrompt += ` - "${fb.comment}"`;
          }
          if (fb.tags && fb.tags.length > 0) {
            enhancedPrompt += ` [${fb.tags.join(', ')}]`;
          }
          enhancedPrompt += `\n`;
        }
        enhancedPrompt += `\n`;
      }
    }

    // 添加语义相关的用户反馈（通过向量检索获取）
    if (relatedFeedbackDocs && relatedFeedbackDocs.length > 0) {
      enhancedPrompt += `## 相关用户反馈（语义匹配）
以下是与当前告警语义相关的历史反馈：
`;
      for (const doc of relatedFeedbackDocs.slice(0, 3)) {
        const originalData = doc.entry.metadata.originalData as Record<string, unknown> | undefined;
        const useful = originalData?.useful as boolean | undefined;
        const comment = originalData?.comment as string | undefined;

        enhancedPrompt += `- 相似度 ${(doc.score * 100).toFixed(1)}%: ${useful ? '有用' : '无用'}`;
        if (comment) {
          enhancedPrompt += ` - "${comment}"`;
        }
        enhancedPrompt += `\n`;
      }
      enhancedPrompt += `\n`;
    }

    if (metrics) {
      enhancedPrompt += `## 系统状态
CPU: ${metrics.cpu.usage}%
内存: ${metrics.memory.usage}%
磁盘: ${metrics.disk.usage}%
运行时间: ${metrics.uptime}

`;
    }

    // 根据参考状态添加不同的上下文信息
    // Requirements: 5.3, 5.4
    if (referenceStatus === 'found') {
      enhancedPrompt += `## 历史相似案例（相同类型）
${contextText}

`;
      if (successfulCases.length > 0) {
        enhancedPrompt += `## 已验证的解决方案
以下解决方案在历史案例中被证明有效：
${successfulCases.map(c => `- ${c.resolution || '参见历史案例详情'} (相似度: ${(c.similarity * 100).toFixed(1)}%)`).join('\n')}

`;
      }
    } else if (referenceStatus === 'type_mismatch') {
      enhancedPrompt += `## 历史参考案例（跨类型）
注意：未找到相同类别（${classification.category}）的历史告警，以下是其他类别的相关案例，仅供参考：
${contextText}

`;
    } else {
      enhancedPrompt += `## 历史参考
首次遇到此类告警，无历史参考。
建议：
1. 仔细分析当前告警的根本原因
2. 记录处理过程以便后续参考
3. 解决后将案例录入知识库

`;
    }

    enhancedPrompt += `请基于以上信息分析当前告警，提供：
1. 问题分析摘要
2. 详细分析说明
3. 处理建议列表
4. 可执行的设备修复命令（如果适用）

请以 JSON 格式返回，包含以下字段：
{
  "summary": "问题分析摘要",
  "details": "详细分析说明",
  "recommendations": ["建议1", "建议2", ...],
  "riskLevel": "low|medium|high",
  "executableSteps": [
    {
      "order": 1,
      "description": "步骤描述",
      "command": "设备命令（如 CLI、SSH 命令等）",
      "riskLevel": "low|medium|high",
      "autoExecutable": true/false,
      "estimatedDuration": 秒数
    }
  ]
}

注意：
- executableSteps 应包含具体的设备操作命令（根据设备类型使用对应的 CLI 语法）
- 高风险命令（如重启、删除配置）应设置 autoExecutable 为 false
- 如果无法确定具体命令，可以省略 executableSteps 字段`;

    if (referenceStatus === 'found') {
      enhancedPrompt += `\n- 引用相关的历史案例中成功的命令`;
    }

    try {
      const result = await this.aiAnalyzer.analyze({
        type: 'alert',
        context: { prompt: enhancedPrompt },
      });

      // 尝试解析 JSON 格式的响应
      let parsedResult: {
        summary?: string;
        details?: string;
        recommendations?: string[];
        riskLevel?: string;
        executableSteps?: ExecutableStep[];
      } | null = null;

      try {
        // 尝试从响应中提取 JSON
        const jsonMatch = result.summary?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResult = JSON.parse(jsonMatch[0]);
        }
      } catch (parseError) {
        logger.debug('Failed to parse JSON from LLM response, using text format', { parseError });
      }

      // 如果成功解析 JSON，使用解析的结果
      let summary = parsedResult?.summary || result.summary;
      let details = parsedResult?.details || result.details || result.summary;
      const recommendations = parsedResult?.recommendations || result.recommendations || [];
      const riskLevel = (parsedResult?.riskLevel as RiskLevel) || result.riskLevel || this.mapSeverityToRisk(alertEvent.severity);
      const executableSteps = parsedResult?.executableSteps;

      // Requirements: 5.3, 5.4 - 显示历史参考状态
      details += '\n\n## 历史参考状态\n';
      if (referenceStatus === 'found') {
        details += `找到 ${historicalReferences.length} 个相同类型的历史案例\n`;
      } else if (referenceStatus === 'type_mismatch') {
        details += `未找到相同类型的历史案例，参考了 ${historicalReferences.length} 个其他类型的案例\n`;
      } else {
        details += '首次遇到此类告警，无历史参考\n';
      }

      if (historicalReferences.length > 0) {
        details += '\n## 历史案例引用\n';
        for (const ref of historicalReferences.slice(0, 3)) {
          details += `- 案例 ${ref.alertId}: 相似度 ${(ref.similarity * 100).toFixed(1)}%`;
          if (ref.outcome) {
            details += ` (结果: ${ref.outcome})`;
          }
          details += '\n';
        }
      }

      // Requirement 5.5: 根据历史数据可用性调整置信度
      let confidence = this.calculateConfidence(documents);
      if (referenceStatus === 'not_found') {
        // 无历史参考时降低置信度
        confidence = Math.min(confidence, 0.5);
      } else if (referenceStatus === 'type_mismatch') {
        // 跨类型参考时适度降低置信度
        confidence = confidence * 0.8;
      }

      return {
        analysis: {
          summary,
          details,
          recommendations,
          riskLevel,
          confidence,
        },
        executableSteps,
      };
    } catch (error) {
      logger.error('Failed to generate enhanced alert analysis', { error });

      // 构建回退响应 - 根据告警类型生成针对性建议
      let fallbackDetails = `基于 ${documents.length} 个历史案例的分析`;
      if (referenceStatus === 'not_found') {
        fallbackDetails = '首次遇到此类告警，无历史参考';
      } else if (referenceStatus === 'type_mismatch') {
        fallbackDetails = `参考了 ${documents.length} 个其他类型的历史案例`;
      }

      // 根据告警分类生成针对性建议
      const targetedRecommendations = this.generateTargetedRecommendations(
        classification.category,
        classification.metricType,
        alertEvent
      );

      return {
        analysis: {
          summary: `告警: ${alertEvent.message}`,
          details: fallbackDetails,
          recommendations: targetedRecommendations,
          riskLevel: this.mapSeverityToRisk(alertEvent.severity),
          confidence: referenceStatus === 'found' ? 0.6 : 0.4,
        },
        executableSteps: undefined,
      };
    }
  }

  /**
   * 根据告警类型生成针对性建议
   */
  private generateTargetedRecommendations(
    category: AlertCategory,
    metricType: string,
    alertEvent: AlertEvent
  ): string[] {
    const recommendations: string[] = [];

    switch (category) {
      case 'interface':
        recommendations.push(
          '检查接口物理连接状态',
          '使用 /interface print 查看接口状态',
          '检查接口配置是否正确',
          '如果接口频繁抖动，考虑检查网线或对端设备'
        );
        break;
      case 'traffic':
        recommendations.push(
          '使用 /interface print stats 查看流量统计',
          '使用 /tool torch 分析实时流量来源',
          '检查是否有异常的大流量连接',
          '考虑配置 QoS 限速策略'
        );
        break;
      case 'resource':
        if (metricType.includes('cpu')) {
          recommendations.push(
            '使用 /tool profile 查看 CPU 占用进程',
            '检查是否有异常的连接数或流量',
            '考虑优化防火墙规则减少 CPU 负载',
            '检查是否有脚本或调度任务占用资源'
          );
        } else if (metricType.includes('memory')) {
          recommendations.push(
            '使用 /system resource print 查看内存使用',
            '清理 DNS 缓存: /ip dns cache flush',
            '检查连接跟踪表大小',
            '考虑重启设备释放内存（如果持续高占用）'
          );
        } else if (metricType.includes('disk')) {
          recommendations.push(
            '使用 /file print 查看文件占用',
            '清理旧的备份和日志文件',
            '检查是否有大量的日志写入',
            '考虑配置日志轮转策略'
          );
        } else {
          recommendations.push(
            '检查系统资源使用情况',
            '使用 /system resource print 查看详细信息',
            '检查是否有异常进程或连接'
          );
        }
        break;
      case 'security':
        recommendations.push(
          '检查防火墙日志: /log print where topics~"firewall"',
          '检查是否有异常的登录尝试',
          '使用 /ip firewall address-list print 查看黑名单',
          '考虑加强访问控制策略'
        );
        break;
      default:
        recommendations.push(
          '检查系统日志: /log print',
          '检查相关配置是否正确',
          '记录此告警的处理过程以便后续参考'
        );
    }

    return recommendations;
  }

  /**
   * 映射严重级别到风险级别
   */
  private mapSeverityToRisk(severity: string): RiskLevel {
    switch (severity) {
      case 'emergency':
      case 'critical':
        return 'high';
      case 'warning':
        return 'medium';
      default:
        return 'low';
    }
  }


  // ==================== 增强修复方案生成 ====================

  /**
   * 增强修复方案生成
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
   * Requirements: 13.4 - 使用 KnowledgeBase 的排序功能
   */
  async generateRemediation(analysis: RootCauseAnalysis): Promise<EnhancedRemediationPlan> {
    this.ensureInitialized();

    const startTime = Date.now();

    // 构建查询文本
    const queryText = this.buildRemediationQueryText(analysis);

    // Requirements: 13.4 - 使用 KnowledgeBase 的排序功能检索历史修复方案
    const rankedResults = await this.knowledgeBase.search({
      query: queryText,
      type: 'remediation',
      limit: this.config.topK,
      minScore: this.config.minScore,
      sortOptions: {
        recencyWeight: this.config.recencyWeight,
        enableHybridSort: true,
      },
    });

    const retrievalTime = Date.now() - startTime;

    // 构建 RAG 上下文
    const ragContext: RAGContext = {
      query: queryText,
      retrievedDocuments: rankedResults,
      retrievalTime,
      candidatesConsidered: rankedResults.length,
    };

    // 构建历史方案引用
    const historicalPlans = this.buildHistoricalPlanReferences(rankedResults);

    // 记录使用
    for (const doc of rankedResults) {
      await this.knowledgeBase.recordUsage(doc.entry.id);
    }

    // 获取适用的操作规则 (Requirements: Phase 2)
    let rules: OperationalRule[] = [];
    try {
      const primaryRootCause = analysis.rootCauses.length > 0
        ? analysis.rootCauses.reduce((a, b) => a.confidence > b.confidence ? a : b)
        : null;

      if (primaryRootCause) {
        const results = await this._ruleEvolutionService.findApplicableRules(
          primaryRootCause.description
        );
        rules = results.map(r => r.rule);
        logger.info(`Found ${rules.length} applicable rules for remediation generation`, {
          alertId: analysis.alertId,
          ruleIds: rules.map(r => r.id)
        });
      }
    } catch (error) {
      logger.warn('Failed to fetch applicable rules', { error });
    }

    // 生成增强修复方案
    const plan = await this.generateEnhancedRemediationPlan(
      analysis,
      rankedResults,
      historicalPlans,
      rules
    );

    // 更新统计
    this.updateStats(retrievalTime, rankedResults);

    return {
      plan,
      ragContext,
      historicalPlans,
    };
  }

  /**
   * 构建修复方案查询文本
   */
  private buildRemediationQueryText(analysis: RootCauseAnalysis): string {
    const rootCauses = analysis.rootCauses
      .map(rc => `${rc.description} (置信度: ${rc.confidence}%)`)
      .join('\n');

    return `根因分析:
${rootCauses}

影响范围: ${analysis.impact?.scope || '未知'}
受影响资源: ${analysis.impact?.affectedResources?.join(', ') || '未知'}`;
  }

  /**
   * 构建历史修复方案引用
   * Requirements: 7.2, 7.4
   */
  private buildHistoricalPlanReferences(
    documents: KnowledgeSearchResult[]
  ): HistoricalPlanReference[] {
    return documents.map(doc => {
      const originalData = doc.entry.metadata.originalData as Record<string, unknown> | undefined;

      // 从元数据或内容中提取成功率
      let successRate = (originalData?.successRate as number) || 0;
      if (!successRate) {
        // 尝试从标签中提取
        const successTag = doc.entry.metadata.tags.find(t => t.startsWith('success_rate_'));
        if (successTag) {
          successRate = parseInt(successTag.replace('success_rate_', '')) / 100;
        }
      }

      // 提取可能的适配建议
      const adaptations: string[] = [];
      const content = doc.entry.content;
      if (content.includes('注意') || content.includes('建议')) {
        const match = content.match(/(?:注意|建议)[：:]\s*([^\n]+)/g);
        if (match) {
          adaptations.push(...match.map(m => m.replace(/^(?:注意|建议)[：:]\s*/, '')));
        }
      }

      return {
        planId: (originalData?.planId as string) || doc.entry.id,
        similarity: doc.score,
        successRate,
        adaptations: adaptations.length > 0 ? adaptations : undefined,
      };
    });
  }

  /**
   * 生成增强修复方案
   * Requirements: 7.3, 7.5, 7.7
   */
  private async generateEnhancedRemediationPlan(
    analysis: RootCauseAnalysis,
    documents: KnowledgeSearchResult[],
    historicalPlans: HistoricalPlanReference[],
    rules: OperationalRule[] = []
  ): Promise<RemediationPlan> {
    // 找出高成功率的方案
    const highSuccessPlans = historicalPlans.filter(p => p.successRate >= 0.8);

    // 找出有失败记录的方案
    const failedPlans = historicalPlans.filter(p => p.successRate < 0.5 && p.successRate > 0);

    // 构建增强提示词
    let enhancedPrompt = `## 根因分析
${analysis.rootCauses.map(rc => `- ${rc.description} (置信度: ${rc.confidence}%)`).join('\n')}

## 影响评估
范围: ${analysis.impact?.scope || '未知'}
受影响资源: ${analysis.impact?.affectedResources?.join(', ') || '未知'}

`;

    // 添加操作规则上下文 (Requirements: Phase 2)
    if (rules.length > 0) {
      enhancedPrompt += `## 操作规则 (Operational Rules)
请严格遵守以下规则生成修复方案：

### 约束 (Constraints) - 必须遵守，禁止违反
${rules.filter(r => r.type === 'constraint').map(r => `- ${r.description}`).join('\n') || '无'}

### 最佳实践 (Best Practices) - 强烈建议采纳
${rules.filter(r => r.type === 'best_practice').map(r => `- ${r.description}`).join('\n') || '无'}

### 修正 (Corrections) - 注意避免错误的模式
${rules.filter(r => r.type === 'correction').map(r => `- ${r.description}`).join('\n') || '无'}

`;
    }

    enhancedPrompt += `## 历史修复方案参考
${this.buildContextText(documents)}

`;

    if (highSuccessPlans.length > 0) {
      enhancedPrompt += `## 推荐方案（高成功率）
以下方案在历史中有较高成功率：
${highSuccessPlans.map(p => `- 方案 ${p.planId}: 成功率 ${(p.successRate * 100).toFixed(0)}%, 相似度 ${(p.similarity * 100).toFixed(1)}%`).join('\n')}

`;
    }

    if (failedPlans.length > 0) {
      enhancedPrompt += `## 风险警告
以下类似方案曾有失败记录，请注意避免相同问题：
${failedPlans.map(p => `- 方案 ${p.planId}: 成功率仅 ${(p.successRate * 100).toFixed(0)}%`).join('\n')}

`;
    }

    enhancedPrompt += `请基于历史方案生成修复计划，优先参考高成功率的方案，并注意避免历史失败案例中的问题。`;

    // 生成基础修复方案
    const basePlan: RemediationPlan = {
      id: `plan_${Date.now()}`,
      alertId: analysis.alertId,
      rootCauseId: analysis.id,
      timestamp: Date.now(),
      steps: [],
      rollback: [],
      overallRisk: this.calculateOverallRisk(analysis, historicalPlans),
      estimatedDuration: 0,
      requiresConfirmation: true,
      status: 'pending',
    };

    // 从历史方案中提取步骤，传递根因描述以生成针对性步骤
    if (documents.length > 0) {
      // 获取主要根因描述
      const primaryRootCause = analysis.rootCauses.length > 0
        ? analysis.rootCauses.reduce((a, b) => a.confidence > b.confidence ? a : b)
        : null;
      const rootCauseDescription = primaryRootCause?.description || '';

      const extractedSteps = this.extractStepsFromHistory(documents, historicalPlans, rootCauseDescription);
      basePlan.steps = extractedSteps.steps;
      basePlan.rollback = extractedSteps.rollback;
      basePlan.estimatedDuration = extractedSteps.steps.reduce(
        (sum, step) => sum + step.estimatedDuration,
        0
      );
    } else {
      // 没有历史文档时，根据根因类型生成针对性步骤
      const primaryRootCause = analysis.rootCauses.length > 0
        ? analysis.rootCauses.reduce((a, b) => a.confidence > b.confidence ? a : b)
        : null;
      const rootCauseDescription = primaryRootCause?.description || '';

      const targetedSteps = this.generateTargetedSteps(rootCauseDescription);
      basePlan.steps = targetedSteps;
      basePlan.estimatedDuration = targetedSteps.reduce(
        (sum, step) => sum + step.estimatedDuration,
        0
      );
    }

    return basePlan;
  }

  /**
   * 计算整体风险
   */
  private calculateOverallRisk(
    analysis: RootCauseAnalysis,
    historicalPlans: HistoricalPlanReference[]
  ): RiskLevel {
    // 基于历史成功率计算风险
    const avgSuccessRate = historicalPlans.length > 0
      ? historicalPlans.reduce((sum, p) => sum + p.successRate, 0) / historicalPlans.length
      : 0.5;

    // 基于影响范围调整
    const scopeFactor = analysis.impact?.scope === 'widespread' ? 0.3
      : analysis.impact?.scope === 'partial' ? 0.15
        : 0;

    const riskScore = 1 - avgSuccessRate + scopeFactor;

    if (riskScore > 0.6) return 'high';
    if (riskScore > 0.3) return 'medium';
    return 'low';
  }

  /**
   * 从历史方案中提取步骤
   * 改进：支持从文档内容中智能提取设备命令，并根据根因类型生成针对性步骤
   */
  private extractStepsFromHistory(
    documents: KnowledgeSearchResult[],
    historicalPlans: HistoricalPlanReference[],
    rootCauseDescription?: string
  ): { steps: RemediationPlan['steps']; rollback: RemediationPlan['rollback'] } {
    const steps: RemediationPlan['steps'] = [];
    const rollback: RemediationPlan['rollback'] = [];

    // 从最相似的文档中提取步骤
    for (const doc of documents.slice(0, 2)) {
      const content = doc.entry.content;
      const historicalPlan = historicalPlans.find(p => p.planId === doc.entry.id);
      const successRate = historicalPlan?.successRate || 0.5;

      // 提取命令 - 支持多种格式
      const extractedCommands = this.extractDeviceCommands(content);

      for (const cmd of extractedCommands) {
        if (cmd.command && !steps.some(s => s.command === cmd.command)) {
          // 跳过通用的诊断命令（如果已经有其他命令）
          if (steps.length > 0 && this.isGenericDiagnosticCommand(cmd.command)) {
            continue;
          }

          steps.push({
            order: steps.length + 1,
            description: cmd.description || `执行命令 (历史成功率: ${(successRate * 100).toFixed(0)}%)`,
            command: cmd.command,
            verification: {
              command: cmd.verification || '/system resource print',
              expectedResult: '命令执行成功',
            },
            autoExecutable: successRate >= 0.8 && !this.isHighRiskCommand(cmd.command),
            riskLevel: this.determineCommandRiskLevel(cmd.command, successRate),
            estimatedDuration: cmd.estimatedDuration || 30,
          });
        }
      }

      // 提取回滚步骤
      const rollbackMatches = content.match(/回滚[：:]\s*([^\n]+)/g);
      if (rollbackMatches) {
        for (let i = 0; i < rollbackMatches.length; i++) {
          const command = rollbackMatches[i].replace(/^回滚[：:]\s*/, '').trim();
          if (command && !rollback.some(r => r.command === command)) {
            rollback.push({
              order: rollback.length + 1,
              description: '回滚操作',
              command,
            });
          }
        }
      }
    }

    // 如果没有提取到有效步骤，根据根因类型生成针对性步骤
    if (steps.length === 0 || steps.every(s => this.isGenericDiagnosticCommand(s.command))) {
      const targetedSteps = this.generateTargetedSteps(rootCauseDescription, documents);
      // 替换或补充步骤
      if (targetedSteps.length > 0) {
        steps.length = 0; // 清空通用步骤
        steps.push(...targetedSteps);
      }
    }

    return { steps, rollback };
  }

  /**
   * 从文档内容中提取设备命令（支持 API 路径格式）
   * 支持多种格式：命令：xxx、`xxx`、/xxx/xxx 等
   */
  private extractDeviceCommands(content: string): Array<{
    command: string;
    description?: string;
    verification?: string;
    estimatedDuration?: number;
  }> {
    const commands: Array<{
      command: string;
      description?: string;
      verification?: string;
      estimatedDuration?: number;
    }> = [];

    // 格式1: 命令：xxx 或 命令: xxx
    const format1 = content.match(/命令[：:]\s*([^\n]+)/g);
    if (format1) {
      for (const match of format1) {
        const cmd = match.replace(/^命令[：:]\s*/, '').trim();
        if (cmd && this.isValidDeviceCommand(cmd)) {
          commands.push({ command: cmd });
        }
      }
    }

    // 格式2: 代码块中的命令 ```routeros ... ```
    const codeBlockRegex = /```(?:routeros|ros|shell)?\s*([\s\S]*?)```/g;
    let codeMatch;
    while ((codeMatch = codeBlockRegex.exec(content)) !== null) {
      const codeContent = codeMatch[1];
      const lines = codeContent.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && this.isValidDeviceCommand(trimmed) && !trimmed.startsWith('#')) {
          commands.push({ command: trimmed });
        }
      }
    }

    // 格式3: 行内代码 `xxx`
    const inlineCodeRegex = /`([^`]+)`/g;
    let inlineMatch;
    while ((inlineMatch = inlineCodeRegex.exec(content)) !== null) {
      const cmd = inlineMatch[1].trim();
      if (cmd && this.isValidDeviceCommand(cmd)) {
        commands.push({ command: cmd });
      }
    }

    // 格式4: 直接以 / 开头的命令行
    const directCmdRegex = /^(\/[a-z][a-z0-9\/\-]*(?:\s+[^\n]+)?)/gm;
    let directMatch;
    while ((directMatch = directCmdRegex.exec(content)) !== null) {
      const cmd = directMatch[1].trim();
      if (cmd && this.isValidDeviceCommand(cmd)) {
        commands.push({ command: cmd });
      }
    }

    // 去重
    const seen = new Set<string>();
    return commands.filter(c => {
      if (seen.has(c.command)) return false;
      seen.add(c.command);
      return true;
    });
  }

  /**
   * 检查是否为有效的设备命令（支持 API 路径格式）
   */
  private isValidDeviceCommand(cmd: string): boolean {
    // 设备命令通常以 / 开头（API 路径格式）
    if (cmd.startsWith('/')) return true;
    // 或者是常见的命令关键词
    const validPrefixes = ['print', 'set', 'add', 'remove', 'enable', 'disable', 'ping', 'traceroute'];
    return validPrefixes.some(p => cmd.toLowerCase().startsWith(p));
  }

  /**
   * 检查是否为通用诊断命令
   */
  private isGenericDiagnosticCommand(cmd: string): boolean {
    const genericCommands = [
      '/system resource print',
      '/system/resource/print',
      '/log print',
      '/log/print',
    ];
    return genericCommands.some(g => cmd.toLowerCase().includes(g.toLowerCase().replace(/\//g, '')));
  }

  /**
   * 检查是否为高风险命令
   */
  private isHighRiskCommand(cmd: string): boolean {
    const highRiskPatterns = [
      /\/system\/reset/i,
      /\/system\/reboot/i,
      /\/user.*password/i,
      /\/interface.*disable/i,
      /remove/i,
      /delete/i,
    ];
    return highRiskPatterns.some(p => p.test(cmd));
  }

  /**
   * 确定命令风险级别
   */
  private determineCommandRiskLevel(cmd: string, successRate: number): RiskLevel {
    if (this.isHighRiskCommand(cmd)) return 'high';
    if (cmd.includes('print') || cmd.includes('monitor')) return 'low';
    if (successRate >= 0.8) return 'low';
    if (successRate >= 0.5) return 'medium';
    return 'high';
  }

  /**
   * 根据根因类型生成针对性的修复步骤
   */
  private generateTargetedSteps(
    rootCauseDescription?: string,
    documents?: KnowledgeSearchResult[]
  ): RemediationPlan['steps'] {
    const steps: RemediationPlan['steps'] = [];
    const desc = (rootCauseDescription || '').toLowerCase();

    // 根据根因描述确定问题类型并生成针对性步骤
    if (desc.includes('interface') || desc.includes('接口') || desc.includes('link') || desc.includes('链路')) {
      steps.push(
        {
          order: 1,
          description: '检查接口状态',
          command: '/interface print',
          verification: { command: '/interface print', expectedResult: '显示接口状态列表' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '检查接口详细信息',
          command: '/interface ethernet print',
          verification: { command: '/interface ethernet print', expectedResult: '显示以太网接口配置' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '尝试重新启用故障接口',
          command: '/interface enable [find where running=no]',
          verification: { command: '/interface print where running=yes', expectedResult: '接口应恢复运行状态' },
          autoExecutable: false,
          riskLevel: 'medium',
          estimatedDuration: 15,
        }
      );
    } else if (desc.includes('cpu') || desc.includes('处理器') || desc.includes('负载')) {
      steps.push(
        {
          order: 1,
          description: '检查 CPU 使用情况',
          command: '/system resource print',
          verification: { command: '/system resource print', expectedResult: 'CPU 使用率应显示当前值' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '检查高 CPU 占用的进程',
          command: '/tool profile',
          verification: { command: '/tool profile', expectedResult: '显示进程 CPU 占用列表' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 10,
        },
        {
          order: 3,
          description: '检查连接跟踪表大小',
          command: '/ip firewall connection print count-only',
          verification: { command: '/ip firewall connection print count-only', expectedResult: '连接数应在合理范围内' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        }
      );
    } else if (desc.includes('memory') || desc.includes('内存') || desc.includes('oom')) {
      steps.push(
        {
          order: 1,
          description: '检查内存使用情况',
          command: '/system resource print',
          verification: { command: '/system resource print', expectedResult: '显示内存使用统计' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '清理 DNS 缓存释放内存',
          command: '/ip dns cache flush',
          verification: { command: '/ip dns cache print count-only', expectedResult: 'DNS 缓存条目数应减少' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '清理过期连接跟踪',
          command: '/ip firewall connection remove [find where timeout<10s]',
          verification: { command: '/ip firewall connection print count-only', expectedResult: '连接数应减少' },
          autoExecutable: false,
          riskLevel: 'medium',
          estimatedDuration: 10,
        }
      );
    } else if (desc.includes('traffic') || desc.includes('流量') || desc.includes('bandwidth') || desc.includes('带宽')) {
      steps.push(
        {
          order: 1,
          description: '检查接口流量统计',
          command: '/interface print stats',
          verification: { command: '/interface print stats', expectedResult: '显示接口流量统计' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '检查活动连接数',
          command: '/ip firewall connection print count-only',
          verification: { command: '/ip firewall connection print count-only', expectedResult: '显示连接数' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '使用 Torch 查看实时流量分布',
          command: '/tool torch interface=all',
          verification: { command: '/tool torch interface=all', expectedResult: '显示实时流量分布' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 15,
        }
      );
    } else if (desc.includes('disk') || desc.includes('磁盘') || desc.includes('storage') || desc.includes('存储')) {
      steps.push(
        {
          order: 1,
          description: '检查磁盘使用情况',
          command: '/system resource print',
          verification: { command: '/system resource print', expectedResult: '显示磁盘使用统计' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '列出文件占用情况',
          command: '/file print',
          verification: { command: '/file print', expectedResult: '显示文件列表' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '清理旧的备份文件',
          command: '/file remove [find where name~"backup" and creation-time<([:timestamp]-7d)]',
          verification: { command: '/file print where name~"backup"', expectedResult: '旧备份文件应被删除' },
          autoExecutable: false,
          riskLevel: 'medium',
          estimatedDuration: 10,
        }
      );
    } else if (desc.includes('firewall') || desc.includes('防火墙') || desc.includes('security') || desc.includes('安全')) {
      steps.push(
        {
          order: 1,
          description: '检查防火墙过滤规则',
          command: '/ip firewall filter print',
          verification: { command: '/ip firewall filter print', expectedResult: '显示防火墙过滤规则' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '检查 NAT 规则',
          command: '/ip firewall nat print',
          verification: { command: '/ip firewall nat print', expectedResult: '显示 NAT 规则' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '检查地址列表（黑名单）',
          command: '/ip firewall address-list print where list="blacklist"',
          verification: { command: '/ip firewall address-list print where list="blacklist"', expectedResult: '显示黑名单 IP' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        }
      );
    } else if (desc.includes('route') || desc.includes('路由') || desc.includes('gateway') || desc.includes('网关')) {
      steps.push(
        {
          order: 1,
          description: '检查路由表',
          command: '/ip route print',
          verification: { command: '/ip route print', expectedResult: '显示路由表' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '检查 ARP 表',
          command: '/ip arp print',
          verification: { command: '/ip arp print', expectedResult: '显示 ARP 表' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '测试网关连通性',
          command: '/ping 8.8.8.8 count=3',
          verification: { command: '/ping 8.8.8.8 count=1', expectedResult: '应收到 ping 响应' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 10,
        }
      );
    } else {
      // 默认：通用诊断步骤，但更全面
      steps.push(
        {
          order: 1,
          description: '检查系统资源状态',
          command: '/system resource print',
          verification: { command: '/system resource print', expectedResult: '显示系统资源信息' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 2,
          description: '检查系统日志',
          command: '/log print',
          verification: { command: '/log print', expectedResult: '显示系统日志' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        },
        {
          order: 3,
          description: '检查接口状态',
          command: '/interface print',
          verification: { command: '/interface print', expectedResult: '显示接口列表' },
          autoExecutable: true,
          riskLevel: 'low',
          estimatedDuration: 5,
        }
      );
    }

    return steps;
  }


  // ==================== 配置变更风险评估 ====================

  /**
   * 配置变更风险评估
   * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
   * Requirements: 13.4 - 使用 KnowledgeBase 的排序功能
   */
  async assessConfigRisk(diff: SnapshotDiff): Promise<ConfigRiskAssessment> {
    this.ensureInitialized();

    const startTime = Date.now();

    // 构建查询文本
    const queryText = this.buildConfigQueryText(diff);

    // Requirements: 13.4 - 使用 KnowledgeBase 的排序功能检索历史配置变更
    const rankedResults = await this.knowledgeBase.search({
      query: queryText,
      type: 'config',
      limit: this.config.topK,
      minScore: this.config.minScore,
      sortOptions: {
        recencyWeight: this.config.recencyWeight,
        enableHybridSort: true,
      },
    });

    const retrievalTime = Date.now() - startTime;

    // 记录使用
    for (const doc of rankedResults) {
      await this.knowledgeBase.recordUsage(doc.entry.id);
    }

    // 分析历史结果
    const historicalOutcomes = this.analyzeHistoricalOutcomes(rankedResults, diff);

    // 计算风险评分
    const riskScore = this.calculateConfigRiskScore(rankedResults, diff, historicalOutcomes);

    // 生成警告
    const warnings = this.generateConfigWarnings(rankedResults, diff, historicalOutcomes);

    // 生成建议
    const suggestions = this.generateConfigSuggestions(rankedResults, diff, historicalOutcomes);

    // 更新统计
    this.updateStats(retrievalTime, rankedResults);

    return {
      riskScore,
      historicalOutcomes,
      warnings,
      suggestions,
    };
  }

  /**
   * 构建配置查询文本
   */
  private buildConfigQueryText(diff: SnapshotDiff): string {
    const changes: string[] = [];

    if (diff.additions.length > 0) {
      changes.push(`新增配置: ${diff.additions.slice(0, 5).join(', ')}`);
    }
    if (diff.modifications.length > 0) {
      changes.push(`修改配置: ${diff.modifications.slice(0, 5).map(m => m.path).join(', ')}`);
    }
    if (diff.deletions.length > 0) {
      changes.push(`删除配置: ${diff.deletions.slice(0, 5).join(', ')}`);
    }

    return `配置变更:
${changes.join('\n')}

变更统计:
- 新增: ${diff.additions.length} 项
- 修改: ${diff.modifications.length} 项
- 删除: ${diff.deletions.length} 项`;
  }

  /**
   * 分析历史结果
   * Requirement 8.2: 找到类似变更时分析其结果
   */
  private analyzeHistoricalOutcomes(
    documents: KnowledgeSearchResult[],
    diff: SnapshotDiff
  ): Array<{ changeType: string; outcome: string; count: number }> {
    const outcomeMap = new Map<string, Map<string, number>>();

    for (const doc of documents) {
      const content = doc.entry.content;
      const originalData = doc.entry.metadata.originalData as Record<string, unknown> | undefined;

      // 确定变更类型
      let changeType = 'general';
      if (content.includes('firewall') || content.includes('防火墙')) {
        changeType = 'firewall';
      } else if (content.includes('interface') || content.includes('接口')) {
        changeType = 'interface';
      } else if (content.includes('route') || content.includes('路由')) {
        changeType = 'routing';
      } else if (content.includes('dns') || content.includes('DNS')) {
        changeType = 'dns';
      }

      // 确定结果
      let outcome = 'unknown';
      if (content.includes('成功') || content.includes('success')) {
        outcome = 'success';
      } else if (content.includes('失败') || content.includes('failed')) {
        outcome = 'failed';
      } else if (content.includes('回滚') || content.includes('rollback')) {
        outcome = 'rollback';
      }

      // 统计
      if (!outcomeMap.has(changeType)) {
        outcomeMap.set(changeType, new Map());
      }
      const typeMap = outcomeMap.get(changeType)!;
      typeMap.set(outcome, (typeMap.get(outcome) || 0) + 1);
    }

    // 转换为数组
    const results: Array<{ changeType: string; outcome: string; count: number }> = [];
    for (const [changeType, outcomes] of outcomeMap) {
      for (const [outcome, count] of outcomes) {
        results.push({ changeType, outcome, count });
      }
    }

    return results;
  }

  /**
   * 计算配置风险评分
   * Requirement 8.4: 基于历史变更结果计算风险评分
   */
  private calculateConfigRiskScore(
    documents: KnowledgeSearchResult[],
    diff: SnapshotDiff,
    historicalOutcomes: Array<{ changeType: string; outcome: string; count: number }>
  ): number {
    let riskScore = 0;

    // 基础风险：变更数量
    const totalChanges = diff.additions.length + diff.modifications.length + diff.deletions.length;
    riskScore += Math.min(0.3, totalChanges * 0.02);

    // 删除操作风险更高
    riskScore += Math.min(0.2, diff.deletions.length * 0.05);

    // 基于历史结果调整
    const totalHistorical = historicalOutcomes.reduce((sum, o) => sum + o.count, 0);
    if (totalHistorical > 0) {
      const failedCount = historicalOutcomes
        .filter(o => o.outcome === 'failed' || o.outcome === 'rollback')
        .reduce((sum, o) => sum + o.count, 0);

      const failureRate = failedCount / totalHistorical;
      riskScore += failureRate * 0.4;
    } else {
      // 没有历史数据，增加不确定性风险
      riskScore += 0.1;
    }

    // 检查敏感配置
    const allChanges = [
      ...diff.additions,
      ...diff.deletions,
      ...diff.modifications.map(m => m.newValue),
    ].join(' ').toLowerCase();

    if (allChanges.includes('firewall') || allChanges.includes('filter')) {
      riskScore += 0.15;
    }
    if (allChanges.includes('password') || allChanges.includes('secret')) {
      riskScore += 0.1;
    }
    if (allChanges.includes('route') || allChanges.includes('gateway')) {
      riskScore += 0.1;
    }

    return Math.min(1, riskScore);
  }

  /**
   * 生成配置警告
   * Requirement 8.3: 类似变更导致问题时警告具体风险
   */
  private generateConfigWarnings(
    documents: KnowledgeSearchResult[],
    diff: SnapshotDiff,
    historicalOutcomes: Array<{ changeType: string; outcome: string; count: number }>
  ): string[] {
    const warnings: string[] = [];

    // 基于历史失败案例生成警告
    const failedOutcomes = historicalOutcomes.filter(
      o => o.outcome === 'failed' || o.outcome === 'rollback'
    );

    for (const outcome of failedOutcomes) {
      warnings.push(
        `历史记录显示 ${outcome.changeType} 类型的变更有 ${outcome.count} 次${outcome.outcome === 'failed' ? '失败' : '回滚'}记录`
      );
    }

    // 检查敏感操作
    if (diff.deletions.length > 5) {
      warnings.push(`删除了 ${diff.deletions.length} 项配置，建议在执行前创建备份`);
    }

    const allChanges = [
      ...diff.additions,
      ...diff.deletions,
      ...diff.modifications.map(m => m.newValue),
    ].join(' ').toLowerCase();

    if (allChanges.includes('firewall') && diff.deletions.length > 0) {
      warnings.push('检测到防火墙规则删除，可能影响网络安全');
    }

    if (allChanges.includes('password') || allChanges.includes('secret')) {
      warnings.push('检测到密码或密钥变更，请确保新凭据符合安全策略');
    }

    // 从历史文档中提取警告
    for (const doc of documents.slice(0, 3)) {
      const content = doc.entry.content;
      if (content.includes('警告') || content.includes('注意')) {
        const match = content.match(/(?:警告|注意)[：:]\s*([^\n]+)/);
        if (match && !warnings.includes(match[1])) {
          warnings.push(`历史案例提示: ${match[1]}`);
        }
      }
    }

    return warnings;
  }

  /**
   * 生成配置建议
   * Requirement 8.6: 基于成功的历史变更建议更安全的替代方案
   */
  private generateConfigSuggestions(
    documents: KnowledgeSearchResult[],
    diff: SnapshotDiff,
    historicalOutcomes: Array<{ changeType: string; outcome: string; count: number }>
  ): string[] {
    const suggestions: string[] = [];

    // 基于历史成功案例生成建议
    const successOutcomes = historicalOutcomes.filter(o => o.outcome === 'success');

    if (successOutcomes.length > 0) {
      suggestions.push('参考历史成功案例中的配置方式');
    }

    // 通用建议
    if (diff.deletions.length > 0) {
      suggestions.push('建议在删除配置前创建快照备份');
    }

    if (diff.modifications.length > 3) {
      suggestions.push('建议分批执行修改，每批后验证系统状态');
    }

    // 从历史文档中提取建议
    for (const doc of documents.slice(0, 3)) {
      const content = doc.entry.content;
      if (content.includes('建议') || content.includes('推荐')) {
        const match = content.match(/(?:建议|推荐)[：:]\s*([^\n]+)/);
        if (match && !suggestions.includes(match[1])) {
          suggestions.push(match[1]);
        }
      }
    }

    // 如果没有建议，添加默认建议
    if (suggestions.length === 0) {
      suggestions.push('建议在生产环境应用前进行测试');
    }

    return suggestions;
  }

  // ==================== 增强根因分析 ====================

  /**
   * 增强根因分析（带并发控制）
   * Requirement 4.3: 执行根因分析时检索相关历史事件
   * Requirements: 13.4 - 使用 KnowledgeBase 的排序功能
   * Requirements (syslog-cpu-spike-fix): 1.1, 1.2, 1.3 - 使用缓存机制
   * Requirements (syslog-cpu-spike-fix): 5.1, 5.2, 5.4 - 使用并发控制
   */
  async analyzeRootCause(event: UnifiedEvent): Promise<RootCauseAnalysis> {
    this.ensureInitialized();

    // Requirements (syslog-cpu-spike-fix): 1.1, 1.2 - 检查缓存
    const cachedResult = this.getCachedRootCauseAnalysis(event.id);
    if (cachedResult) {
      logger.debug('Returning cached root cause analysis', { eventId: event.id });
      return cachedResult;
    }

    // Requirements (syslog-cpu-spike-fix): 5.1, 5.2, 5.4 - 使用并发控制
    if (this.ragConcurrencyController) {
      try {
        // 通过并发控制器执行分析
        // 优先级基于严重级别：critical=1, high=2, medium=3, low=4, info=5
        const priorityMap: Record<string, number> = {
          critical: 1,
          high: 2,
          medium: 3,
          low: 4,
          info: 5,
        };
        const priority = priorityMap[event.severity?.toLowerCase()] || 3;

        return await this.ragConcurrencyController.enqueue(event, priority);
      } catch (error) {
        // Requirements (syslog-cpu-spike-fix): 5.4 - 降级处理
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Backpressure') || errorMessage.includes('Queue full')) {
          logger.warn('RAG analysis degraded due to concurrency limit', { eventId: event.id, error: errorMessage });
          // 返回降级结果
          return this.createDegradedRootCauseAnalysis(event, '系统负载过高，使用简化分析');
        }
        throw error;
      }
    }

    // 如果并发控制器未初始化，直接执行分析
    return this.executeRootCauseAnalysis(event);
  }

  /**
   * 执行根因分析（内部方法，被并发控制器调用）
   * Requirements (syslog-cpu-spike-fix): 5.1 - 实际的分析逻辑
   */
  private async executeRootCauseAnalysis(event: UnifiedEvent): Promise<RootCauseAnalysis> {
    const startTime = Date.now();

    // 第一阶段：智能理解与语义提取
    // 使用 AI 对告警进行深度分类并提取搜索关键词
    const classification = await this.aiAnalyzer.analyzeClassifyAlert(event.message);
    const category = classification.category || event.category || 'unknown';
    const searchKeywords = classification.searchKeywords || [event.message.substring(0, 30)];

    // 构建语义查询文本
    const queryText = `分类: ${category}
子类: ${classification.subCategory || 'N/A'}
概念: ${searchKeywords.join(', ')}
原始消息: ${event.message}`;

    // 第二阶段：精准语义检索
    // 使用 AI 提取的关键词和语义标签进行知识库搜索
    const tags: string[] = [];
    if (classification.subCategory) tags.push(classification.subCategory);
    if (classification.isProtocolIssue) tags.push('protocol-first');

    const searchOptions: import('./knowledgeBase').KnowledgeQuery = {
      query: queryText,
      type: 'alert',
      category: category !== 'unknown' ? category : undefined, // 如果 AI 确定了类别，则进行过滤
      tags: tags.length > 0 ? tags : undefined,
      limit: this.config.topK,
      minScore: this.config.minScore,
      sortOptions: {
        recencyWeight: this.config.recencyWeight,
        enableHybridSort: true,
      },
    };

    if (classification.isProtocolIssue) {
      searchOptions.protocolConstraint = true;
    }

    const rankedResults = await this.knowledgeBase.search(searchOptions);

    const retrievalTime = Date.now() - startTime;

    // 记录知识库使用情况
    for (const doc of rankedResults) {
      await this.knowledgeBase.recordUsage(doc.entry.id);
    }

    // 构建历史案例参考文本供 AI 合成
    const historyContext = rankedResults.length > 0
      ? rankedResults.map((doc, i) => `[案例 ${i + 1}] (相似度: ${(doc.score * 100).toFixed(1)}%)\n标题: ${doc.entry.title}\n内容: ${doc.entry.content}`).join('\n\n')
      : '';

    // 第三阶段：AI 综合根因合成
    // 获取当前设备指标（处理 -1 情况）
    const metricsCount = await this.getSystemMetricsForEvent(event);

    const aiRcaResult = await this.aiAnalyzer.analyzeIntelligentRootCause(
      { ...event, category },
      metricsCount,
      historyContext
    );

    const rootCauses = aiRcaResult.rootCauses || [];

    // 构建相似事件列表
    const similarIncidents = rankedResults.map(doc => ({
      id: doc.entry.id,
      timestamp: doc.entry.metadata.timestamp,
      similarity: doc.score,
      resolution: this.extractResolution(doc.entry),
    }));

    const result: RootCauseAnalysis = {
      id: `rca_${Date.now()}`,
      alertId: event.id,
      timestamp: Date.now(),
      rootCauses,
      timeline: {
        events: [{
          timestamp: event.timestamp,
          eventId: event.id,
          description: event.message,
          type: 'trigger',
        }],
        startTime: event.timestamp,
        endTime: Date.now(),
      },
      impact: {
        scope: 'local',
        affectedResources: [],
        estimatedUsers: 0,
        services: [],
        networkSegments: [],
      },
      similarIncidents,
      // 保存 AI 提取的元数据供后续使用
      metadata: {
        ...classification,
        aiCategory: category,
        isProtocolIssue: classification.isProtocolIssue,
        reasoning: classification.reasoning,
        subCategory: classification.subCategory,
        searchKeywords: classification.searchKeywords,
      } as Record<string, unknown>
    };

    // 更新统计
    this.updateStats(retrievalTime, rankedResults);

    // 缓存分析结果
    this.cacheRootCauseAnalysis(event.id, result);

    return result;
  }

  /**
   * 获取事件关联的系统指标，处理不可用情况
   */
  private async getSystemMetricsForEvent(event: UnifiedEvent): Promise<SystemMetrics> {
    // 默认返回 -1 表示不可用
    const fallbackMetrics: SystemMetrics = {
      cpu: { usage: -1 },
      memory: { usage: -1 },
      disk: { usage: -1 },
      uptime: 'unknown'
    };

    try {
      // 如果 UnifiedEvent 中已经包含了指标信息，则直接使用
      if ((event as any).metrics) {
        return (event as any).metrics;
      }

      // 否则尝试从设备监控服务获取最新指标
      const monitorService = serviceRegistry.tryGet<any>('monitorService');
      if (monitorService && event.deviceId) {
        const latest = await monitorService.getLatestMetrics(event.tenantId || 'default', event.deviceId);
        if (latest) return latest;
      }
    } catch (_error) {
      logger.debug('Failed to get real-time metrics for RCA, using fallback', { eventId: event.id });
    }

    return fallbackMetrics;
  }

  /**
   * 创建降级的根因分析结果
   * Requirements (syslog-cpu-spike-fix): 5.4 - 降级处理
   */
  private createDegradedRootCauseAnalysis(event: UnifiedEvent, reason: string): RootCauseAnalysis {
    return {
      id: `rca_degraded_${Date.now()}`,
      alertId: event.id,
      timestamp: Date.now(),
      rootCauses: [{
        id: `rc_degraded_${Date.now()}`,
        description: `${event.category} 相关问题: ${event.message}（${reason}）`,
        confidence: 10,
        evidence: ['基于事件信息推断（降级模式）'],
        relatedAlerts: [event.id],
      }],
      timeline: {
        events: [{
          timestamp: event.timestamp,
          eventId: event.id,
          description: event.message,
          type: 'trigger',
        }],
        startTime: event.timestamp,
        endTime: Date.now(),
      },
      impact: {
        scope: 'local',
        affectedResources: [],
        estimatedUsers: 0,
        services: [],
        networkSegments: [],
      },
      similarIncidents: [],
    };
  }

  /**
   * 从知识条目中提取解决方案
   */
  private extractResolution(entry: KnowledgeEntry): string | undefined {
    const content = entry.content;
    const match = content.match(/(?:解决方案|修复|resolution)[：:]\s*([^\n]+)/i);
    return match ? match[1] : undefined;
  }

  /**
   * 移除陈旧的 generateRootCauses 方法，改用 executeRootCauseAnalysis 中的 AI 合成
   */

  // ==================== 配置和统计 ====================

  /**
   * 获取配置
   */
  getConfig(): RAGConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   * Requirement 4.6: 支持可配置的检索参数
   */
  updateConfig(config: Partial<RAGConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('RAGEngine config updated', { config: this.config });
  }

  /**
   * 获取统计信息
   * Requirement 4.8: 记录检索统计用于监控和优化
   */
  getStats(): RAGStats {
    return { ...this.stats };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      queriesProcessed: 0,
      avgRetrievalTime: 0,
      avgRelevanceScore: 0,
      cacheHits: 0,
      fallbackCount: 0,
    };
  }

  /**
   * 获取 RAG 并发统计信息
   * Requirements (syslog-cpu-spike-fix): 6.2 - 并发统计
   */
  getRAGConcurrencyStats(): RAGConcurrencyStats {
    if (!this.ragConcurrencyController) {
      return {
        activeAnalyses: 0,
        queueLength: 0,
        totalProcessed: 0,
        rejected: 0,
        timedOut: 0,
      };
    }

    const status = this.ragConcurrencyController.getStatus();
    return {
      activeAnalyses: status.active,
      queueLength: status.queued,
      totalProcessed: status.totalProcessed,
      rejected: status.totalDropped,
      timedOut: status.totalTimedOut,
    };
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 关闭 RAG 引擎，释放资源
   * Requirements: 4.1, 4.2, 4.3, 4.4
   * - 4.1: 提供 shutdown() 方法用于停止缓存清理定时器
   * - 4.2: 清除 cacheCleanupTimer 定时器
   * - 4.3: 将 initialized 状态设置为 false
   * - 4.4: 能够正常重新初始化
   */
  async shutdown(): Promise<void> {
    // 停止缓存清理定时器 (Requirements: 4.2)
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.info('RAGEngine cache cleanup timer stopped');
    }

    // 清空缓存
    const analysisCacheSize = this.analysisCache.size;
    const rootCauseCacheSize = this.rootCauseAnalysisCache.size;
    this.analysisCache.clear();
    this.rootCauseAnalysisCache.clear();

    // 重置缓存统计
    this.analysisCacheStats = { hits: 0, misses: 0 };
    this.rootCauseCacheStats = { hits: 0, misses: 0 };

    // 停止并发控制器
    if (this.ragConcurrencyController) {
      this.ragConcurrencyController = null;
    }

    // 重置初始化状态 (Requirements: 4.3)
    this.initialized = false;

    // 重置统计信息
    this.resetStats();

    logger.info('RAGEngine shutdown complete', {
      clearedAnalysisCache: analysisCacheSize,
      clearedRootCauseCache: rootCauseCacheSize,
    });
  }
}

// 导出单例实例
export const ragEngine = new RAGEngine();
