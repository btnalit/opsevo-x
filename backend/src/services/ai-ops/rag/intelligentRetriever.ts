/**
 * IntelligentRetriever - 智能检索器
 * 
 * 负责意图分析、查询重写、多路召回和混合排序
 * 
 * Requirements: 1.1-1.5, 2.1-2.5, 3.1-3.5, 13.1-13.5, 15.1-15.5
 * - 1.x: 意图分析与知识需求判断
 * - 2.x: 查询重写与多路召回
 * - 3.x: 混合排序算法
 * - 13.x: LanceDB 智能检索优化
 * - 15.x: 降级与容错处理
 * 
 * 智能混合检索系统简化 (Requirements: 5.4, 5B.1, 5B.2, 5B.3)
 * - 移除静态 INTENT_KEYWORDS 映射，由混合检索自动处理关键词匹配
 * - 移除静态 SYNONYM_MAP 映射，由 MetadataEnhancer 自动生成同义词
 * - 简化 requiresKnowledge 判断，所有查询都尝试检索
 */

import { logger } from '../../../utils/logger';
import { KnowledgeBase, knowledgeBase, KnowledgeEntry, KnowledgeSearchResult } from './knowledgeBase';
import { CredibilityCalculator, credibilityCalculator } from './credibilityCalculator';
import { KnowledgeFormatter, knowledgeFormatter } from './knowledgeFormatter';
import {
  IntentType,
  IntentAnalysisResult,
  RetrievalOptions,
  SortOptions,
  RawRetrievalResult,
  ScoredRetrievalResult,
  IntelligentRetrievalResult,
  FormattedKnowledge,
  KnowledgeType,
  IntelligentRetrieverConfig,
  DEFAULT_INTELLIGENT_RETRIEVER_CONFIG,
  KNOWLEDGE_COLLECTIONS,
  VALID_COLLECTIONS,
  TYPE_TO_COLLECTION,
} from './types/intelligentRetrieval';

// ==================== 意图分析关键词映射（简化版） ====================

/**
 * 意图类型关键词映射（简化版）
 * Requirements: 1.1, 5B.1
 * 
 * 注意：这些关键词仅用于意图分类和路由到不同集合，
 * 实际的关键词匹配由混合检索系统（HybridSearchEngine）自动处理。
 * 同义词扩展由 MetadataEnhancer 在知识添加时自动生成。
 */
const INTENT_KEYWORDS: Record<IntentType, string[]> = {
  troubleshooting: [
    '故障', '问题', '错误', '失败', '异常', '告警', '报警',
    '排查', '诊断', '修复', '解决', 'error', 'fail',
  ],
  configuration: [
    '配置', '设置', '修改', '添加', '删除', '创建', '更新',
    'config', 'setup',
  ],
  monitoring: [
    '监控', '状态', '指标', '性能', '资源',
    'monitor', 'metric', 'status',
  ],
  historical_analysis: [
    '历史', '之前', '过去', '记录', '日志', '趋势',
    'history', 'log', 'trend',
  ],
  general: [],
};

/**
 * 知识类型路由映射
 * Requirements: 1.3, 2.3.1
 * 
 * 注意：所有意图类型都包含 alerts_kb，因为 manual 和 feedback 类型的知识
 * 存储在 alerts_kb 中，这些是用户手动添加的通用知识，应该对所有查询可用。
 * 
 * 经验检索增强 (Requirements: 2.3.1, 2.3.3)：
 * - 所有意图类型都包含 remediations_kb，因为 experience 类型存储在其中
 * - 经验条目包含历史成功案例，对所有类型的查询都有参考价值
 */
const INTENT_TO_COLLECTIONS: Record<IntentType, string[]> = {
  troubleshooting: [KNOWLEDGE_COLLECTIONS.ALERTS, KNOWLEDGE_COLLECTIONS.REMEDIATIONS, KNOWLEDGE_COLLECTIONS.PATTERNS],
  configuration: [KNOWLEDGE_COLLECTIONS.ALERTS, KNOWLEDGE_COLLECTIONS.CONFIGS, KNOWLEDGE_COLLECTIONS.REMEDIATIONS],
  monitoring: [KNOWLEDGE_COLLECTIONS.ALERTS, KNOWLEDGE_COLLECTIONS.PATTERNS, KNOWLEDGE_COLLECTIONS.REMEDIATIONS],
  historical_analysis: [KNOWLEDGE_COLLECTIONS.ALERTS, KNOWLEDGE_COLLECTIONS.CONFIGS, KNOWLEDGE_COLLECTIONS.REMEDIATIONS],
  general: VALID_COLLECTIONS as unknown as string[],
};

// 注意：SYNONYM_MAP 已移除 (Requirements: 5B.2)
// 同义词扩展现在由 MetadataEnhancer 在知识添加时自动生成，
// 并存储在知识条目的 autoSynonyms 字段中。
// 混合检索系统会自动利用这些同义词进行匹配。

/**
 * 智能检索器类
 * 
 * 经验检索增强 (Requirements: 2.3.1, 2.3.3)：
 * - 支持并行检索经验和知识
 * - 经验条目优先用于 Few-Shot 示例
 */
export class IntelligentRetriever {
  private config: IntelligentRetrieverConfig;
  private knowledgeBase: KnowledgeBase;
  private credibilityCalculator: CredibilityCalculator;
  private knowledgeFormatter: KnowledgeFormatter;
  private initialized: boolean = false;

  constructor(
    config?: Partial<IntelligentRetrieverConfig>,
    kb?: KnowledgeBase,
    credCalc?: CredibilityCalculator,
    formatter?: KnowledgeFormatter
  ) {
    this.config = { ...DEFAULT_INTELLIGENT_RETRIEVER_CONFIG, ...config };
    this.knowledgeBase = kb || knowledgeBase;
    this.credibilityCalculator = credCalc || credibilityCalculator;
    this.knowledgeFormatter = formatter || knowledgeFormatter;
    logger.debug('IntelligentRetriever created', { config: this.config });
  }

  /**
   * 初始化检索器
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // 确保知识库已初始化
      if (!this.knowledgeBase.isInitialized()) {
        await this.knowledgeBase.initialize();
      }
      this.initialized = true;
      logger.info('IntelligentRetriever initialized');
    } catch (error) {
      logger.error('Failed to initialize IntelligentRetriever', { error });
      // 进入降级模式
      this.initialized = true; // 标记为已初始化，但会在检索时返回降级结果
    }
  }

  /**
   * 智能检索知识
   * Requirements: 1.x, 2.x, 3.x, 13.x, 15.x
   * 
   * @param query 用户查询
   * @param options 检索选项
   * @returns 检索结果
   */
  async retrieve(query: string, options?: RetrievalOptions): Promise<IntelligentRetrievalResult> {
    const startTime = Date.now();
    const opts = this.mergeOptions(options);

    try {
      // 确保已初始化
      if (!this.initialized) {
        await this.initialize();
      }

      // 1. 意图分析
      const intent = await this.analyzeIntent(query);
      
      // 如果不需要知识库支持，返回空结果
      if (!intent.requiresKnowledge) {
        return this.createEmptyResult(query, [], Date.now() - startTime);
      }

      // 2. 查询重写
      const rewrittenQueries = await this.rewriteQuery(query, intent);

      // 3. 多路召回
      const rawResults = await this.multiPathRetrieval(
        rewrittenQueries,
        intent.targetCollections,
        opts
      );

      // 4. 混合排序
      const scoredResults = this.hybridSort(rawResults, {
        similarityWeight: this.config.sortWeights.similarityWeight,
        recencyWeight: this.config.sortWeights.recencyWeight,
        feedbackWeight: this.config.sortWeights.feedbackWeight,
        usageWeight: this.config.sortWeights.usageWeight,
        maxAgeMs: this.config.maxAgeMs,
      });

      // 5. 限制返回数量
      const limitedResults = scoredResults.slice(0, opts.topK);

      // 6. 格式化结果
      const formattedDocs = this.knowledgeFormatter.formatBatch(
        limitedResults.map(r => r.entry)
      );

      const retrievalTime = Date.now() - startTime;

      logger.info('Intelligent retrieval completed', {
        query: query.substring(0, 50),
        intentType: intent.intentType,
        resultsCount: formattedDocs.length,
        retrievalTime,
      });

      return {
        documents: formattedDocs,
        retrievalTime,
        query,
        rewrittenQueries,
        degradedMode: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Intelligent retrieval failed', { error: errorMessage, query });

      // 返回降级结果
      return this.createDegradedResult(query, Date.now() - startTime, errorMessage);
    }
  }

  /**
   * 分析意图并判断知识需求
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 5B.3
   * 
   * 简化版：所有查询都尝试检索，让混合检索决定是否有相关结果
   * 
   * @param query 用户查询
   * @returns 意图分析结果
   */
  async analyzeIntent(query: string): Promise<IntentAnalysisResult> {
    try {
      const queryLower = query.toLowerCase();
      
      // 计算各意图类型的匹配分数
      const scores: Record<IntentType, number> = {
        troubleshooting: 0,
        configuration: 0,
        monitoring: 0,
        historical_analysis: 0,
        general: 0.1, // 基础分数
      };

      const matchedKeywords: string[] = [];

      for (const [intentType, keywords] of Object.entries(INTENT_KEYWORDS)) {
        for (const keyword of keywords) {
          if (queryLower.includes(keyword.toLowerCase())) {
            scores[intentType as IntentType] += 1;
            matchedKeywords.push(keyword);
          }
        }
      }

      // 找出最高分的意图类型
      let maxScore = 0;
      let bestIntent: IntentType = 'general';
      
      for (const [intentType, score] of Object.entries(scores)) {
        if (score > maxScore) {
          maxScore = score;
          bestIntent = intentType as IntentType;
        }
      }

      // 计算置信度
      const confidence = Math.min(1, maxScore / 3); // 匹配 3 个关键词达到最高置信度

      // 简化：所有查询都尝试检索 (Requirements: 5B.3)
      // 让混合检索系统决定是否有相关结果
      // 这样可以利用关键词索引和自动生成的问题示例来匹配更多查询
      const requiresKnowledge = true;

      // 确定目标集合
      const targetCollections = INTENT_TO_COLLECTIONS[bestIntent];

      // 提取关键词（简化版，不再依赖静态映射）
      const keywords = this.extractKeywords(query);

      return {
        intentType: bestIntent,
        requiresKnowledge,
        targetCollections,
        keywords,
        confidence,
      };
    } catch (error) {
      // 降级：返回通用意图，仍然尝试检索
      logger.warn('Intent analysis failed, using fallback', { error });
      return {
        intentType: 'general',
        requiresKnowledge: true,
        targetCollections: VALID_COLLECTIONS as unknown as string[],
        keywords: this.extractKeywords(query),
        confidence: 0.5,
      };
    }
  }

  /**
   * 重写查询
   * Requirements: 2.1
   * 
   * @param query 原始查询
   * @param intent 意图分析结果
   * @returns 重写后的查询列表
   */
  async rewriteQuery(query: string, intent: IntentAnalysisResult): Promise<string[]> {
    const queries: string[] = [query]; // 始终包含原始查询

    try {
      // 同义词扩展
      const expandedQuery = this.expandSynonyms(query);
      if (expandedQuery !== query) {
        queries.push(expandedQuery);
      }

      // 基于关键词生成查询
      if (intent.keywords.length > 0) {
        const keywordQuery = intent.keywords.join(' ');
        if (!queries.includes(keywordQuery)) {
          queries.push(keywordQuery);
        }
      }

      // 基于意图类型添加上下文
      const contextQuery = this.addIntentContext(query, intent.intentType);
      if (contextQuery && !queries.includes(contextQuery)) {
        queries.push(contextQuery);
      }

      return queries;
    } catch (error) {
      logger.warn('Query rewriting failed, using original query', { error });
      return [query]; // 至少返回原始查询
    }
  }

  /**
   * 多路召回
   * Requirements: 2.2, 2.3, 2.4, 2.5
   * 
   * @param queries 查询列表
   * @param collections 目标集合
   * @param options 检索选项
   * @returns 合并后的检索结果
   */
  async multiPathRetrieval(
    queries: string[],
    collections: string[],
    options: Required<RetrievalOptions>
  ): Promise<RawRetrievalResult[]> {
    const allResults: RawRetrievalResult[] = [];
    const seenIds = new Set<string>();

    // 并行检索所有集合
    const searchPromises: Promise<void>[] = [];

    for (const query of queries) {
      for (const collection of collections) {
        const promise = this.searchCollection(query, collection, options)
          .then(results => {
            for (const result of results) {
              // 去重
              if (!seenIds.has(result.entry.id)) {
                seenIds.add(result.entry.id);
                allResults.push(result);
              } else {
                // 如果已存在，保留分数更高的
                const existingIndex = allResults.findIndex(r => r.entry.id === result.entry.id);
                if (existingIndex >= 0 && result.similarityScore > allResults[existingIndex].similarityScore) {
                  allResults[existingIndex] = result;
                }
              }
            }
          })
          .catch(error => {
            // 单个集合检索失败不影响其他集合
            logger.warn('Collection search failed', { collection, error });
          });
        
        searchPromises.push(promise);
      }
    }

    // 等待所有检索完成（带超时）
    await Promise.race([
      Promise.all(searchPromises),
      new Promise<void>(resolve => setTimeout(resolve, options.timeout)),
    ]);

    // 过滤低分结果
    return allResults.filter(r => r.similarityScore >= options.minScore);
  }

  /**
   * 混合排序
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   * 
   * @param results 原始检索结果
   * @param options 排序选项
   * @returns 排序后的结果
   */
  hybridSort(results: RawRetrievalResult[], options?: SortOptions): ScoredRetrievalResult[] {
    const opts: Required<SortOptions> = {
      similarityWeight: options?.similarityWeight ?? this.config.sortWeights.similarityWeight,
      recencyWeight: options?.recencyWeight ?? this.config.sortWeights.recencyWeight,
      feedbackWeight: options?.feedbackWeight ?? this.config.sortWeights.feedbackWeight,
      usageWeight: options?.usageWeight ?? this.config.sortWeights.usageWeight,
      maxAgeMs: options?.maxAgeMs ?? this.config.maxAgeMs,
    };

    const now = Date.now();

    const scoredResults: ScoredRetrievalResult[] = results.map(result => {
      const entry = result.entry;
      const metadata = entry.metadata;

      // 计算各分量分数
      const similarityScore = result.similarityScore;
      const recencyScore = this.calculateRecencyScore(metadata.timestamp, opts.maxAgeMs, now);
      const feedbackScore = this.normalizeFeedbackScore(metadata.feedbackScore, metadata.feedbackCount);
      const usageScore = this.normalizeUsageScore(metadata.usageCount);

      // 计算混合分数
      const hybridScore = 
        similarityScore * opts.similarityWeight +
        recencyScore * opts.recencyWeight +
        feedbackScore * opts.feedbackWeight +
        usageScore * opts.usageWeight;

      // 计算可信度分数
      const credibilityScore = this.credibilityCalculator.calculate(entry);

      return {
        entry,
        similarityScore,
        recencyScore,
        feedbackScore,
        usageScore,
        hybridScore,
        credibilityScore,
      };
    });

    // 按混合分数降序排列
    return scoredResults.sort((a, b) => b.hybridScore - a.hybridScore);
  }

  // ==================== 私有方法 ====================

  /**
   * 合并选项
   */
  private mergeOptions(options?: RetrievalOptions): Required<RetrievalOptions> {
    return {
      topK: options?.topK ?? this.config.defaultTopK,
      minScore: options?.minScore ?? this.config.minScore,
      types: options?.types ?? [],
      includeFullContent: options?.includeFullContent ?? true,
      timeout: options?.timeout ?? this.config.retrievalTimeout,
    };
  }

  /**
   * 搜索单个集合
   * 
   * 修复：不再根据集合名称推断类型过滤，因为 manual 和 feedback 类型
   * 也存储在 alerts_kb 集合中。改为不传 type 参数，让知识库搜索所有类型。
   */
  private async searchCollection(
    query: string,
    collection: string,
    options: Required<RetrievalOptions>
  ): Promise<RawRetrievalResult[]> {
    // 如果指定了类型过滤，检查集合是否匹配
    if (options.types.length > 0) {
      // 检查这个集合是否包含任何指定的类型
      const collectionTypes = Object.entries(TYPE_TO_COLLECTION)
        .filter(([, c]) => c === collection)
        .map(([t]) => t);
      
      const hasMatchingType = options.types.some(t => collectionTypes.includes(t));
      if (!hasMatchingType) {
        return [];
      }
    }

    // 不传 type 参数，搜索集合中的所有类型
    // 这样 manual 和 feedback 类型的条目也能被搜索到
    const searchResults = await this.knowledgeBase.search({
      query,
      // 不传 type，让知识库搜索所有类型
      limit: options.topK * 2, // 获取更多候选
      minScore: options.minScore,
    });

    // 过滤出属于当前集合的结果
    const collectionTypes = new Set(
      Object.entries(TYPE_TO_COLLECTION)
        .filter(([, c]) => c === collection)
        .map(([t]) => t)
    );

    return searchResults
      .filter(r => collectionTypes.has(r.entry.type))
      .map(r => ({
        entry: r.entry,
        similarityScore: r.score,
        collection,
      }));
  }

  /**
   * 提取关键词
   * Requirements: 1.4
   */
  private extractKeywords(query: string): string[] {
    // 移除常见停用词
    const stopWords = ['的', '是', '在', '了', '和', '与', '或', '有', '这', '那', '什么', '怎么', '如何'];
    
    // 分词（简单实现）
    const words = query.split(/[\s,，。？！、]+/).filter(w => w.length > 0);
    
    // 过滤停用词
    return words.filter(w => !stopWords.includes(w) && w.length > 1);
  }

  /**
   * 同义词扩展
   * Requirements: 2.1, 5B.2
   * 
   * 简化版：不再使用静态 SYNONYM_MAP
   * 同义词扩展现在由混合检索系统自动处理：
   * - MetadataEnhancer 在知识添加时自动生成同义词
   * - KeywordIndexManager 会索引这些同义词
   * - 搜索时会自动匹配同义词
   */
  private expandSynonyms(query: string): string {
    // 简化：直接返回原始查询
    // 同义词匹配由混合检索系统自动处理
    return query;
  }

  /**
   * 添加意图上下文
   */
  private addIntentContext(query: string, intentType: IntentType): string | null {
    const contextMap: Record<IntentType, string> = {
      troubleshooting: '故障排查 问题解决',
      configuration: '配置设置 参数调整',
      monitoring: '监控状态 性能指标',
      historical_analysis: '历史记录 变更分析',
      general: '',
    };

    const context = contextMap[intentType];
    if (context) {
      return `${query} ${context}`;
    }
    return null;
  }

  /**
   * 计算时效性分数
   * Requirements: 3.2
   */
  private calculateRecencyScore(timestamp: number, maxAgeMs: number, now: number): number {
    const age = now - timestamp;
    if (age <= 0) return 1;
    return Math.max(0, 1 - age / maxAgeMs);
  }

  /**
   * 归一化反馈分数
   * Requirements: 3.3
   */
  private normalizeFeedbackScore(score: number, count: number): number {
    if (count === 0) return 0.5;
    return Math.max(0, Math.min(1, score / 5));
  }

  /**
   * 归一化使用分数
   * Requirements: 3.4
   */
  private normalizeUsageScore(count: number): number {
    if (count <= 0) return 0;
    return Math.min(1, Math.log(1 + count) / Math.log(101));
  }

  /**
   * 创建空结果
   */
  private createEmptyResult(
    query: string,
    rewrittenQueries: string[],
    retrievalTime: number
  ): IntelligentRetrievalResult {
    return {
      documents: [],
      retrievalTime,
      query,
      rewrittenQueries,
      degradedMode: false,
    };
  }

  /**
   * 创建降级结果
   * Requirements: 15.5
   */
  private createDegradedResult(
    query: string,
    retrievalTime: number,
    reason: string
  ): IntelligentRetrievalResult {
    return {
      documents: [],
      retrievalTime,
      query,
      rewrittenQueries: [query],
      degradedMode: true,
      degradedReason: reason,
      degradedAt: Date.now(),
    };
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 检索相关经验（Few-Shot 示例）
   * Requirements: 2.3.1, 2.3.3
   * 
   * 专门检索 experience 类型的知识条目，用于 Few-Shot 注入
   * 
   * @param query 用户查询
   * @param options 检索选项
   * @returns 经验检索结果
   */
  async retrieveExperiences(
    query: string,
    options?: { topK?: number; minScore?: number }
  ): Promise<KnowledgeEntry[]> {
    const topK = options?.topK ?? 3;
    const minScore = options?.minScore ?? 0.5;

    try {
      // 确保已初始化
      if (!this.initialized) {
        await this.initialize();
      }

      // 搜索 experience 类型的知识
      const results = await this.knowledgeBase.search({
        query,
        type: 'experience',
        limit: topK,
        minScore,
      });

      // 排除 feedbackScore 为负值的条目
      // Requirements: conversation-and-reflection-optimization 7.3
      const filtered = results.filter(r => {
        const score = r.entry.metadata?.feedbackScore;
        return score === undefined || score === null || score >= 0;
      });

      logger.debug('Experience retrieval completed', {
        query: query.substring(0, 50),
        resultsCount: filtered.length,
        filteredOut: results.length - filtered.length,
      });

      return filtered.map(r => r.entry);
    } catch (error) {
      logger.warn('Experience retrieval failed', { error });
      return [];
    }
  }

  /**
   * 并行检索经验和知识
   * Requirements: 2.3.1, 2.3.3
   * 
   * 同时检索经验（用于 Few-Shot）和知识（用于上下文），
   * 提高检索效率
   * 
   * @param query 用户查询
   * @param options 检索选项
   * @returns 包含经验和知识的检索结果
   */
  async retrieveWithExperiences(
    query: string,
    options?: RetrievalOptions & { experienceTopK?: number }
  ): Promise<{
    knowledge: IntelligentRetrievalResult;
    experiences: KnowledgeEntry[];
  }> {
    const experienceTopK = options?.experienceTopK ?? 3;

    // 并行检索
    const [knowledge, experiences] = await Promise.all([
      this.retrieve(query, options),
      this.retrieveExperiences(query, { topK: experienceTopK }),
    ]);

    logger.info('Parallel retrieval completed', {
      query: query.substring(0, 50),
      knowledgeCount: knowledge.documents.length,
      experienceCount: experiences.length,
    });

    return { knowledge, experiences };
  }
}

// 导出单例实例
export const intelligentRetriever = new IntelligentRetriever();
