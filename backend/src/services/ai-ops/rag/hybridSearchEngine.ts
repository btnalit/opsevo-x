/**
 * HybridSearchEngine - 混合检索引擎
 * 
 * 协调关键词检索和向量检索，使用 RRF 算法融合结果。
 * 
 * Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 6.1, 6.2, 6.3, 7.1, 7.2
 * - 3.1: 并行执行关键词检索和向量检索
 * - 3.3: 合并结果并去重
 * - 3.4: 使用 RRF 算法融合排序
 * - 3.5: 支持可配置的权重
 * - 3.6: 500ms 内完成检索
 * - 6.1: 记录检索指标
 * - 6.2: 追踪增强成功率
 * - 6.3: 提供统计 API
 * - 7.1: 关键词检索失败时降级到向量检索
 * - 7.2: 向量检索失败时降级到关键词检索
 */

import { logger } from '../../../utils/logger';
import { KeywordIndexManager } from './keywordIndexManager';
import { EmbeddingService } from './embeddingService';
import { RRFRanker } from './rrfRanker';
import { KnowledgeEntry } from './knowledgeBase';
import { VectorStoreClient, type VectorSearchResult as VscSearchResult } from './vectorStoreClient';
import {
  HybridSearchOptions,
  HybridSearchResult,
  HybridSearchMetrics,
  HybridSearchEngineConfig,
  DEFAULT_HYBRID_SEARCH_ENGINE_CONFIG,
  DEFAULT_HYBRID_SEARCH_OPTIONS,
  KeywordSearchResult,
  RankedItem,
  HybridSearchError,
  HybridSearchErrorCode,
  HybridSearchStats,
  DEFAULT_HYBRID_SEARCH_STATS,
} from './types/hybridSearch';

/**
 * 向量检索结果（内部使用）
 */
interface VectorSearchResultInternal {
  entryId: string;
  score: number;
  content: string;
}

/**
 * HybridSearchEngine 混合检索引擎类
 */
export class HybridSearchEngine {
  private config: HybridSearchEngineConfig;
  private keywordIndexManager: KeywordIndexManager;
  private embeddingService: EmbeddingService;
  private rrfRanker: RRFRanker;

  // Python Core 向量检索客户端（Requirements: J5.12, J5.13）
  private vectorClient: VectorStoreClient;

  // 条目缓存（用于快速查找）
  private entryCache: Map<string, KnowledgeEntry> = new Map();

  // 统计数据 (Requirements: 6.1, 6.2)
  private stats: HybridSearchStats = { ...DEFAULT_HYBRID_SEARCH_STATS };
  private searchHistory: HybridSearchMetrics[] = [];
  private maxHistorySize: number = 1000;

  constructor(
    keywordIndexManager: KeywordIndexManager,
    vectorClient: VectorStoreClient,
    embeddingService: EmbeddingService,
    rrfRanker: RRFRanker,
    config?: Partial<HybridSearchEngineConfig>
  ) {
    this.keywordIndexManager = keywordIndexManager;
    this.vectorClient = vectorClient;
    this.embeddingService = embeddingService;
    this.rrfRanker = rrfRanker;
    this.config = { ...DEFAULT_HYBRID_SEARCH_ENGINE_CONFIG, ...config };

    logger.info('HybridSearchEngine created', { config: this.config });
  }

  /**
   * 设置条目缓存（由 KnowledgeBase 调用）
   */
  setEntryCache(cache: Map<string, KnowledgeEntry>): void {
    this.entryCache = cache;
  }

  /**
   * 设置 VectorStoreClient（兼容方法，构造函数已注入）
   * Requirements: J5.12, J5.13, J5.14
   */
  setVectorClient(client: VectorStoreClient): void {
    this.vectorClient = client;
    logger.info('HybridSearchEngine: VectorStoreClient updated');
  }

  /**
   * 执行混合检索
   * Requirements: 3.1, 3.3, 3.4, 3.5, 3.6, 7.1, 7.2
   * 
   * @param query 查询字符串
   * @param collections 要搜索的集合列表
   * @param options 检索选项
   * @returns 检索结果和指标
   */
  async search(
    query: string,
    collections: string[],
    options?: Partial<HybridSearchOptions>
  ): Promise<{
    results: HybridSearchResult[];
    metrics: HybridSearchMetrics;
  }> {
    const startTime = Date.now();
    const opts = this.mergeOptions(options);

    // 初始化指标
    const metrics: HybridSearchMetrics = {
      keywordHits: 0,
      vectorHits: 0,
      mergedResults: 0,
      keywordSearchTime: 0,
      vectorSearchTime: 0,
      totalTime: 0,
      degraded: false,
    };

    let keywordResults: KeywordSearchResult[] = [];
    let vectorResults: VectorSearchResultInternal[] = [];

    // 并行执行检索
    const searchPromises: Promise<void>[] = [];

    // 关键词检索
    if (opts.enableKeywordSearch) {
      const keywordPromise = this.executeKeywordSearch(query, opts.topK * 2)
        .then(results => {
          keywordResults = results;
          metrics.keywordHits = results.length;
          metrics.keywordSearchTime = Date.now() - startTime;
        })
        .catch(error => {
          logger.warn('Keyword search failed', { error: error instanceof Error ? error.message : String(error) });
          metrics.degraded = true;
          metrics.degradedReason = 'Keyword search failed';
        });
      searchPromises.push(keywordPromise);
    }

    // 向量检索
    if (opts.enableVectorSearch) {
      const vectorPromise = this.executeVectorSearch(query, collections, opts.topK * 2)
        .then(results => {
          vectorResults = results;
          metrics.vectorHits = results.length;
          metrics.vectorSearchTime = Date.now() - startTime;
        })
        .catch(error => {
          logger.warn('Vector search failed', { error: error instanceof Error ? error.message : String(error) });
          metrics.degraded = true;
          metrics.degradedReason = 'Vector search failed';
        });
      searchPromises.push(vectorPromise);
    }

    // 等待所有检索完成（带超时）
    await Promise.race([
      Promise.all(searchPromises),
      new Promise<void>(resolve => setTimeout(resolve, opts.timeout)),
    ]);

    // 检查是否有结果
    if (keywordResults.length === 0 && vectorResults.length === 0) {
      metrics.totalTime = Date.now() - startTime;
      return { results: [], metrics };
    }

    // 融合结果
    const fusedResults = this.fuseResults(
      keywordResults,
      vectorResults,
      opts.keywordWeight,
      opts.vectorWeight
    );

    // 转换为最终结果
    const results = this.buildResults(fusedResults, keywordResults, vectorResults, opts);
    metrics.mergedResults = results.length;
    metrics.totalTime = Date.now() - startTime;

    // 记录统计数据 (Requirements: 6.1)
    this.recordMetrics(metrics);

    logger.debug('Hybrid search completed', {
      query: query.substring(0, 50),
      keywordHits: metrics.keywordHits,
      vectorHits: metrics.vectorHits,
      mergedResults: metrics.mergedResults,
      totalTime: metrics.totalTime,
    });

    return { results, metrics };
  }

  /**
   * 仅关键词检索
   */
  async keywordSearch(query: string, limit: number = 10): Promise<KeywordSearchResult[]> {
    return this.executeKeywordSearch(query, limit);
  }

  /**
   * 仅向量检索
   */
  async vectorSearch(
    query: string,
    collections: string[],
    limit: number = 10
  ): Promise<VectorSearchResultInternal[]> {
    return this.executeVectorSearch(query, collections, limit);
  }

  // ==================== 统计方法 (Requirements: 6.1, 6.2, 6.3) ====================

  /**
   * 记录检索指标
   * Requirements: 6.1
   */
  private recordMetrics(metrics: HybridSearchMetrics): void {
    // 添加到历史记录
    this.searchHistory.push(metrics);
    if (this.searchHistory.length > this.maxHistorySize) {
      this.searchHistory.shift();
    }

    // 更新统计数据
    this.stats.totalSearches++;

    // 更新命中率
    if (metrics.keywordHits > 0) {
      this.stats.keywordHitRate =
        (this.stats.keywordHitRate * (this.stats.totalSearches - 1) + 1) / this.stats.totalSearches;
    } else {
      this.stats.keywordHitRate =
        (this.stats.keywordHitRate * (this.stats.totalSearches - 1)) / this.stats.totalSearches;
    }

    if (metrics.vectorHits > 0) {
      this.stats.vectorHitRate =
        (this.stats.vectorHitRate * (this.stats.totalSearches - 1) + 1) / this.stats.totalSearches;
    } else {
      this.stats.vectorHitRate =
        (this.stats.vectorHitRate * (this.stats.totalSearches - 1)) / this.stats.totalSearches;
    }

    // 更新平均耗时
    this.stats.avgKeywordSearchTime =
      (this.stats.avgKeywordSearchTime * (this.stats.totalSearches - 1) + metrics.keywordSearchTime) / this.stats.totalSearches;
    this.stats.avgVectorSearchTime =
      (this.stats.avgVectorSearchTime * (this.stats.totalSearches - 1) + metrics.vectorSearchTime) / this.stats.totalSearches;
    this.stats.avgTotalTime =
      (this.stats.avgTotalTime * (this.stats.totalSearches - 1) + metrics.totalTime) / this.stats.totalSearches;

    // 更新降级率
    if (metrics.degraded) {
      this.stats.degradationRate =
        (this.stats.degradationRate * (this.stats.totalSearches - 1) + 1) / this.stats.totalSearches;
    } else {
      this.stats.degradationRate =
        (this.stats.degradationRate * (this.stats.totalSearches - 1)) / this.stats.totalSearches;
    }
  }

  /**
   * 记录增强成功
   * Requirements: 6.2
   */
  recordEnhancementSuccess(usedLLM: boolean): void {
    if (usedLLM) {
      this.stats.llmUsageCount++;
    } else {
      this.stats.fallbackEnhancementCount++;
    }

    const totalEnhancements = this.stats.llmUsageCount + this.stats.fallbackEnhancementCount;
    this.stats.enhancementSuccessRate = this.stats.llmUsageCount / totalEnhancements;
  }

  /**
   * 获取混合检索统计
   * Requirements: 6.3
   */
  getStats(): HybridSearchStats {
    return { ...this.stats };
  }

  /**
   * 获取最近的检索指标
   * Requirements: 6.3
   */
  getRecentMetrics(count: number = 10): HybridSearchMetrics[] {
    return this.searchHistory.slice(-count);
  }

  /**
   * 重置统计数据
   */
  resetStats(): void {
    this.stats = { ...DEFAULT_HYBRID_SEARCH_STATS };
    this.searchHistory = [];
    logger.info('Hybrid search stats reset');
  }

  // ==================== 私有方法 ====================

  /**
   * 执行关键词检索
   */
  private async executeKeywordSearch(query: string, limit: number): Promise<KeywordSearchResult[]> {
    if (!this.keywordIndexManager.isInitialized()) {
      throw new HybridSearchError(
        HybridSearchErrorCode.KEYWORD_INDEX_UNAVAILABLE,
        'Keyword index not initialized'
      );
    }

    return this.keywordIndexManager.search(query, limit);
  }

  /**
   * 执行向量检索
   * 通过 VectorStoreClient → Python Core（J5.12, J5.13）
   */
  private async executeVectorSearch(
    query: string,
    collections: string[],
    limit: number
  ): Promise<VectorSearchResultInternal[]> {
    return this.executeVectorSearchViaPythonCore(query, collections, limit);
  }

  /**
   * 通过 Python Core 执行向量检索
   * VectorStoreClient.search() 内部处理 embedding，无需本地 embeddingService
   */
  private async executeVectorSearchViaPythonCore(
    query: string,
    collections: string[],
    limit: number
  ): Promise<VectorSearchResultInternal[]> {
    const allResults: VectorSearchResultInternal[] = [];
    const seenIds = new Set<string>();

    for (const collection of collections) {
      try {
        const results: VscSearchResult[] = await this.vectorClient!.search(collection, {
          collection,
          query,
          top_k: limit,
          min_score: 0.3,
        });

        for (const result of results) {
          const entryId = (result.metadata?.entryId as string) || result.id;
          if (!entryId || seenIds.has(entryId)) continue;

          seenIds.add(entryId);
          allResults.push({
            entryId,
            score: result.score,
            content: result.text,
          });
        }
      } catch (error) {
        logger.warn('Vector search via Python Core failed for collection', {
          collection,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * 融合检索结果
   */
  private fuseResults(
    keywordResults: KeywordSearchResult[],
    vectorResults: VectorSearchResultInternal[],
    keywordWeight: number,
    vectorWeight: number
  ): Map<string, {
    rrfScore: number;
    keywordRank?: number;
    keywordScore?: number;
    vectorRank?: number;
    vectorScore?: number;
    matchedKeywords?: string[];
  }> {
    // 转换为 RankedItem 格式
    const keywordRanked: RankedItem[] = keywordResults.map((r, i) => ({
      id: r.entryId,
      rank: i + 1,
      score: r.score,
    }));

    const vectorRanked: RankedItem[] = vectorResults.map((r, i) => ({
      id: r.entryId,
      rank: i + 1,
      score: r.score,
    }));

    // 使用 RRF 融合
    const fusedResults = this.rrfRanker.fuseTwoPaths(
      keywordRanked,
      vectorRanked,
      keywordWeight,
      vectorWeight
    );

    // 构建结果映射
    const resultMap = new Map<string, {
      rrfScore: number;
      keywordRank?: number;
      keywordScore?: number;
      vectorRank?: number;
      vectorScore?: number;
      matchedKeywords?: string[];
    }>();

    // 创建关键词结果的快速查找
    const keywordMap = new Map(keywordResults.map(r => [r.entryId, r]));

    for (const fused of fusedResults) {
      const keywordResult = keywordMap.get(fused.id);

      resultMap.set(fused.id, {
        rrfScore: fused.normalizedScore,
        keywordRank: fused.ranks.keyword > 0 ? fused.ranks.keyword : undefined,
        keywordScore: fused.scores.keyword > 0 ? fused.scores.keyword : undefined,
        vectorRank: fused.ranks.vector > 0 ? fused.ranks.vector : undefined,
        vectorScore: fused.scores.vector > 0 ? fused.scores.vector : undefined,
        matchedKeywords: keywordResult?.matchedKeywords,
      });
    }

    return resultMap;
  }

  /**
   * 构建最终结果
   */
  private buildResults(
    fusedResults: Map<string, {
      rrfScore: number;
      keywordRank?: number;
      keywordScore?: number;
      vectorRank?: number;
      vectorScore?: number;
      matchedKeywords?: string[];
    }>,
    keywordResults: KeywordSearchResult[],
    vectorResults: VectorSearchResultInternal[],
    options: HybridSearchOptions
  ): HybridSearchResult[] {
    const results: HybridSearchResult[] = [];

    // 按 RRF 分数排序
    const sortedEntries = Array.from(fusedResults.entries())
      .sort((a, b) => b[1].rrfScore - a[1].rrfScore);

    for (const [entryId, data] of sortedEntries) {
      // 从缓存获取条目
      const entry = this.entryCache.get(entryId);
      if (!entry) {
        logger.debug('Entry not found in cache', { entryId });
        continue;
      }

      // 检查最小分数
      if (data.rrfScore < options.minScore) {
        continue;
      }

      // 计算混合置信度：结合 RRF 排名分与绝对相似度分
      // 权重分配：30% RRF (相对排名) + 70% Vector (绝对相似度)
      let confidence = data.rrfScore;

      if (data.vectorScore !== undefined) {
        // vectorScore 通常在 0-1 之间 (余弦相似度)
        confidence = 0.3 * data.rrfScore + 0.7 * data.vectorScore;
      }

      results.push({
        entry,
        score: confidence,
        keywordScore: data.keywordScore,
        vectorScore: data.vectorScore,
        keywordRank: data.keywordRank,
        vectorRank: data.vectorRank,
        matchedKeywords: data.matchedKeywords,
      });

      // 限制返回数量
      if (results.length >= options.topK) {
        break;
      }
    }

    return results;
  }

  /**
   * 合并选项
   */
  private mergeOptions(options?: Partial<HybridSearchOptions>): HybridSearchOptions {
    return {
      keywordWeight: options?.keywordWeight ?? this.config.defaultKeywordWeight,
      vectorWeight: options?.vectorWeight ?? this.config.defaultVectorWeight,
      topK: options?.topK ?? this.config.defaultTopK,
      minScore: options?.minScore ?? this.config.defaultMinScore,
      timeout: options?.timeout ?? this.config.defaultTimeout,
      enableKeywordSearch: options?.enableKeywordSearch ?? true,
      enableVectorSearch: options?.enableVectorSearch ?? true,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): HybridSearchEngineConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<HybridSearchEngineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('HybridSearchEngine config updated', { config: this.config });
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}
