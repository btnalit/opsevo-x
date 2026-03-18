/**
 * RerankerService - 重排序服务
 *
 * 提供 BGE-Reranker 兼容 API 的重排序功能，用于对 RAG 检索结果进行二次排序。
 *
 * Requirements: 1.1-1.8
 * - 1.1: 实现在 backend/src/services/ai/rerankerService.ts
 * - 1.2: 定义 RerankerConfig 接口
 * - 1.3: 定义 RerankResult 接口
 * - 1.4: 实现 rerank 方法
 * - 1.5: 处理非 200 状态码错误
 * - 1.6: 实现 applyMMR 方法
 * - 1.7: 实现 computeCompositeScore 方法
 * - 1.8: 导出单例实例
 */

import { logger } from '../../utils/logger';
import {
  RerankerConfig,
  RerankResult,
  RerankRequest,
  RerankResponse,
} from '../../types/ai';

/**
 * 默认超时时间（毫秒）
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * 默认 Reranker 配置
 */
const DEFAULT_RERANKER_CONFIG: RerankerConfig = {
  apiKey: process.env.RERANK_API_KEY || '',
  baseUrl: process.env.RERANK_BASE_URL || 'https://api.example.com/v1',
  modelName: process.env.RERANK_MODEL_NAME || 'bge-reranker-v2-m3',
  topK: parseInt(process.env.RERANK_TOP_K || '5', 10),
  threshold: parseFloat(process.env.RERANK_THRESHOLD || '0.5'),
  timeout: parseInt(process.env.RERANK_TIMEOUT || String(DEFAULT_TIMEOUT), 10),
};

/**
 * Reranker 错误类型
 */
export class RerankerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'RerankerError';
  }
}

/**
 * RerankerService 实现类
 */
export class RerankerService {
  private config: RerankerConfig;

  constructor(config?: Partial<RerankerConfig>) {
    this.config = { ...DEFAULT_RERANKER_CONFIG, ...config };
    logger.info('RerankerService created', {
      baseUrl: this.config.baseUrl,
      modelName: this.config.modelName,
      topK: this.config.topK,
      threshold: this.config.threshold,
      timeout: this.config.timeout || DEFAULT_TIMEOUT,
    });
  }

  /**
   * 配置 Reranker 服务
   * @param config 部分配置
   */
  configure(config: Partial<RerankerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('RerankerService configured', {
      baseUrl: this.config.baseUrl,
      modelName: this.config.modelName,
    });
  }

  /**
   * 获取当前配置
   */
  getConfig(): RerankerConfig {
    return { ...this.config };
  }

  /**
   * 重排序文档
   * Requirement 1.4: 实现 HTTP POST 请求到 Rerank API
   * Requirement 1.5: 处理非 200 状态码
   *
   * @param query 查询文本
   * @param documents 待排序的文档列表
   * @returns 排序后的结果
   */
  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (!this.config.apiKey) {
      throw new RerankerError('Reranker API key not configured', 'CONFIG_ERROR');
    }

    if (documents.length === 0) {
      return [];
    }

    const requestBody: RerankRequest = {
      model: this.config.modelName,
      query,
      documents,
    };

    const startTime = Date.now();
    const timeout = this.config.timeout || DEFAULT_TIMEOUT;
    
    // 创建 AbortController 用于超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.config.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      // Requirement 1.5: 处理非 200 状态码
      if (!response.ok) {
        const errorBody = await response.text();
        logger.error('Rerank API error', {
          statusCode: response.status,
          body: errorBody,
        });
        throw new RerankerError(
          `Rerank API returned status ${response.status}: ${errorBody}`,
          'API_ERROR',
          response.status
        );
      }

      const data = await response.json() as RerankResponse;
      const duration = Date.now() - startTime;

      logger.debug('Rerank completed', {
        query: query.substring(0, 100),
        documentsCount: documents.length,
        resultsCount: data.results.length,
        duration,
        totalTokens: data.usage?.total_tokens,
      });

      // 转换响应格式
      return data.results.map((r) => ({
        index: r.index,
        relevanceScore: r.relevance_score,
        document: documents[r.index],
      }));
    } catch (error) {
      // 处理超时错误
      if (error instanceof Error && error.name === 'AbortError') {
        const duration = Date.now() - startTime;
        logger.error('Rerank request timeout', { timeout, duration });
        throw new RerankerError(
          `Rerank request timeout after ${timeout}ms`,
          'TIMEOUT_ERROR'
        );
      }

      if (error instanceof RerankerError) {
        throw error;
      }

      // 处理网络错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Rerank request failed', { error: errorMessage });
      throw new RerankerError(
        `Rerank request failed: ${errorMessage}`,
        'NETWORK_ERROR'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }


  /**
   * 计算复合评分
   * Requirement 1.7: 实现复合评分计算
   *
   * 公式: 0.6 * modelScore + 0.3 * baseScore + 0.1 * sourceWeight
   *
   * @param modelScore 模型评分 (0-1)
   * @param baseScore 基础评分 (0-1)
   * @param sourceWeight 来源权重 (0-1)，默认 0.5
   * @returns 复合评分 (0-1)
   */
  computeCompositeScore(
    modelScore: number,
    baseScore: number,
    sourceWeight: number = 0.5
  ): number {
    const score = 0.6 * modelScore + 0.3 * baseScore + 0.1 * sourceWeight;
    // 确保结果在 0-1 范围内
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 计算 Jaccard 相似度
   * 用于 MMR 算法中计算文档间的相似度
   *
   * @param doc1 文档1
   * @param doc2 文档2
   * @returns 相似度 (0-1)
   */
  private calculateJaccardSimilarity(doc1: string, doc2: string): number {
    const words1 = new Set(doc1.toLowerCase().split(/\s+/));
    const words2 = new Set(doc2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    if (union.size === 0) {
      return 0;
    }

    return intersection.size / union.size;
  }

  /**
   * 应用 MMR (Maximal Marginal Relevance) 算法
   * Requirement 1.6: 实现 MMR 多样性选择算法
   *
   * MMR 公式: MMR = λ * Sim(d, q) - (1 - λ) * max(Sim(d, d_i))
   * 其中 d_i 是已选择的文档
   *
   * @param results 重排序结果
   * @param topK 返回的最大结果数
   * @param lambda 相关性与多样性的平衡参数 (0-1)，默认 0.7
   * @returns 经过 MMR 选择的结果
   */
  applyMMR(
    results: RerankResult[],
    topK: number,
    lambda: number = 0.7
  ): RerankResult[] {
    if (results.length === 0 || topK <= 0) {
      return [];
    }

    if (results.length <= topK) {
      return results;
    }

    const selected: RerankResult[] = [];
    const remaining = [...results];

    // 选择第一个（最相关的）文档
    const firstIndex = remaining.reduce(
      (maxIdx, curr, idx, arr) =>
        curr.relevanceScore > arr[maxIdx].relevanceScore ? idx : maxIdx,
      0
    );
    selected.push(remaining.splice(firstIndex, 1)[0]);

    // 迭代选择剩余文档
    while (selected.length < topK && remaining.length > 0) {
      let bestScore = -Infinity;
      let bestIndex = 0;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const relevance = candidate.relevanceScore;

        // 计算与已选文档的最大相似度
        let maxSimilarity = 0;
        for (const selectedDoc of selected) {
          if (candidate.document && selectedDoc.document) {
            const similarity = this.calculateJaccardSimilarity(
              candidate.document,
              selectedDoc.document
            );
            maxSimilarity = Math.max(maxSimilarity, similarity);
          }
        }

        // MMR 评分
        const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = i;
        }
      }

      selected.push(remaining.splice(bestIndex, 1)[0]);
    }

    return selected;
  }

  /**
   * 重排序并应用阈值过滤
   *
   * @param query 查询文本
   * @param documents 待排序的文档列表
   * @param threshold 相关性阈值，默认使用配置值
   * @returns 过滤后的排序结果
   */
  async rerankWithThreshold(
    query: string,
    documents: string[],
    threshold?: number
  ): Promise<RerankResult[]> {
    const results = await this.rerank(query, documents);
    const effectiveThreshold = threshold ?? this.config.threshold;

    return results.filter((r) => r.relevanceScore >= effectiveThreshold);
  }

  /**
   * 完整的重排序流程：重排序 -> 阈值过滤 -> MMR 选择
   *
   * @param query 查询文本
   * @param documents 待排序的文档列表
   * @param options 选项
   * @returns 最终的排序结果
   */
  async rerankWithMMR(
    query: string,
    documents: string[],
    options?: {
      threshold?: number;
      topK?: number;
      lambda?: number;
    }
  ): Promise<RerankResult[]> {
    const threshold = options?.threshold ?? this.config.threshold;
    const topK = options?.topK ?? this.config.topK;
    const lambda = options?.lambda ?? 0.7;

    // 1. 重排序
    const results = await this.rerank(query, documents);

    // 2. 阈值过滤
    const filtered = results.filter((r) => r.relevanceScore >= threshold);

    // 3. MMR 选择
    return this.applyMMR(filtered, topK, lambda);
  }
}

/**
 * 默认 RerankerService 单例实例
 * Requirement 1.8: 导出单例实例
 */
export const rerankerService = new RerankerService();

export default rerankerService;
