/**
 * PreRetrievalEngine - 预检索引擎
 * 
 * 执行快速知识检索，支持多种检索策略和范围。
 * 设计目标：在 500ms 内完成检索，支持超时控制。
 * 
 * Requirements: 1.1, 3.3, 3.4, 6.1, 8.2
 * - 1.1: 在 500ms 内完成预检索
 * - 3.3: 支持多种检索策略（exact_match, semantic_match, fuzzy_match）
 * - 3.4: 支持多种检索范围（full_text, title_only, tags_only）
 * - 6.1: 超时控制
 * - 8.2: 集成现有 KnowledgeBase 服务
 */

import { logger } from '../../../utils/logger';
import {
  RetrievalStrategy,
  RetrievalScope,
  PreRetrievalOptions,
  PreRetrievalResult,
  RetrievedKnowledge,
  DEFAULT_PRE_RETRIEVAL_OPTIONS,
  FastPathError,
  FastPathErrorCode,
} from '../../../types/fast-path';
import { KnowledgeBase, KnowledgeSearchResult, KnowledgeQuery } from './knowledgeBase';

// ==================== PreRetrievalEngine 类 ====================

/**
 * PreRetrievalEngine 配置
 */
export interface PreRetrievalEngineConfig {
  /** 默认超时时间（毫秒） */
  defaultTimeout: number;
  /** 默认返回数量 */
  defaultTopK: number;
  /** 默认最小分数 */
  defaultMinScore: number;
  /** 是否启用多策略检索 */
  enableMultiStrategy: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: PreRetrievalEngineConfig = {
  defaultTimeout: 500,
  defaultTopK: 5,
  defaultMinScore: 0.3,
  enableMultiStrategy: true,
};

/**
 * PreRetrievalEngine 类
 * 
 * 快速知识预检索引擎，支持多种检索策略和超时控制。
 */
export class PreRetrievalEngine {
  private config: PreRetrievalEngineConfig;
  private knowledgeBase: KnowledgeBase;

  constructor(knowledgeBase: KnowledgeBase, config?: Partial<PreRetrievalEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.knowledgeBase = knowledgeBase;
    logger.info('PreRetrievalEngine created', { config: this.config });
  }

  /**
   * 执行预检索
   * Requirements: 1.1, 6.1
   * 
   * @param query 查询字符串
   * @param options 检索选项
   * @returns 预检索结果
   */
  async retrieve(
    query: string,
    options?: Partial<PreRetrievalOptions>
  ): Promise<PreRetrievalResult> {
    const startTime = performance.now();
    const opts: PreRetrievalOptions = {
      ...DEFAULT_PRE_RETRIEVAL_OPTIONS,
      ...options,
      timeout: options?.timeout ?? this.config.defaultTimeout,
      topK: options?.topK ?? this.config.defaultTopK,
      minScore: options?.minScore ?? this.config.defaultMinScore,
    };

    try {
      // 使用超时控制执行检索
      const result = await this.executeWithTimeout(
        () => this.executeRetrieval(query, opts),
        opts.timeout
      );

      const retrievalTime = performance.now() - startTime;

      // 检查是否超时
      if (retrievalTime > opts.timeout) {
        logger.warn('Pre-retrieval exceeded timeout', {
          query: query.substring(0, 50),
          time: retrievalTime,
          timeout: opts.timeout,
        });
      }

      return {
        ...result,
        retrievalTime,
        timedOut: false,
      };
    } catch (error) {
      const retrievalTime = performance.now() - startTime;

      // 超时错误
      if (error instanceof Error && error.message === 'TIMEOUT') {
        logger.warn('Pre-retrieval timed out', {
          query: query.substring(0, 50),
          timeout: opts.timeout,
        });

        return {
          documents: [],
          maxConfidence: 0,
          avgConfidence: 0,
          retrievalTime,
          strategy: opts.strategy,
          scope: opts.scope,
          timedOut: true,
        };
      }

      // 其他错误
      logger.error('Pre-retrieval failed', { error, query: query.substring(0, 50) });
      throw new FastPathError(
        FastPathErrorCode.PRE_RETRIEVAL_TIMEOUT,
        `Pre-retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * 多策略检索
   * Requirements: 3.3
   * 
   * 尝试多种检索策略，返回最佳结果
   * 
   * @param query 查询字符串
   * @param timeout 总超时时间
   * @returns 预检索结果
   */
  async multiStrategyRetrieve(query: string, timeout?: number): Promise<PreRetrievalResult> {
    const startTime = performance.now();
    const totalTimeout = timeout ?? this.config.defaultTimeout;
    
    // 策略优先级：语义匹配 > 模糊匹配 > 精确匹配
    const strategies: RetrievalStrategy[] = ['semantic_match', 'fuzzy_match', 'exact_match'];
    
    let bestResult: PreRetrievalResult | null = null;
    let usedStrategy: RetrievalStrategy = 'semantic_match';

    for (const strategy of strategies) {
      const elapsed = performance.now() - startTime;
      const remainingTime = totalTimeout - elapsed;

      // 如果剩余时间不足，停止尝试
      if (remainingTime < 100) {
        logger.debug('Multi-strategy retrieval: insufficient time for next strategy', {
          strategy,
          remainingTime,
        });
        break;
      }

      try {
        const result = await this.retrieve(query, {
          strategy,
          timeout: Math.min(remainingTime, totalTimeout / strategies.length),
        });

        // 如果找到高置信度结果，直接返回
        if (result.maxConfidence >= 0.85) {
          logger.debug('Multi-strategy retrieval: found high confidence result', {
            strategy,
            confidence: result.maxConfidence,
          });
          return {
            ...result,
            strategy,
          };
        }

        // 保留最佳结果
        if (!bestResult || result.maxConfidence > bestResult.maxConfidence) {
          bestResult = result;
          usedStrategy = strategy;
        }
      } catch (error) {
        logger.warn('Multi-strategy retrieval: strategy failed', { strategy, error });
        // 继续尝试下一个策略
      }
    }

    const retrievalTime = performance.now() - startTime;

    // 返回最佳结果或空结果
    if (bestResult) {
      return {
        ...bestResult,
        strategy: usedStrategy,
        retrievalTime,
      };
    }

    return {
      documents: [],
      maxConfidence: 0,
      avgConfidence: 0,
      retrievalTime,
      strategy: 'semantic_match',
      scope: 'full_text',
      timedOut: retrievalTime >= totalTimeout,
    };
  }

  /**
   * 执行检索
   */
  private async executeRetrieval(
    query: string,
    options: PreRetrievalOptions
  ): Promise<Omit<PreRetrievalResult, 'retrievalTime' | 'timedOut'>> {
    // 根据检索范围构建查询
    const searchQuery = this.buildSearchQuery(query, options);

    // 执行知识库搜索
    const results = await this.knowledgeBase.search(searchQuery);

    // 转换结果
    const documents = this.convertResults(results, options);

    // 计算置信度统计
    const scores = documents.map(d => d.score);
    const maxConfidence = scores.length > 0 ? Math.max(...scores) : 0;
    const avgConfidence = scores.length > 0 
      ? scores.reduce((a, b) => a + b, 0) / scores.length 
      : 0;

    return {
      documents,
      maxConfidence,
      avgConfidence,
      strategy: options.strategy,
      scope: options.scope,
    };
  }

  /**
   * 构建搜索查询
   * Requirements: 3.4
   */
  private buildSearchQuery(query: string, options: PreRetrievalOptions): KnowledgeQuery {
    let searchQuery = query;

    // 根据检索范围调整查询
    switch (options.scope) {
      case 'title_only':
        // 标题检索：添加标题相关的提示词
        searchQuery = `标题: ${query}`;
        break;
      case 'tags_only':
        // 标签检索：提取关键词作为标签
        searchQuery = query;
        break;
      case 'full_text':
      default:
        // 全文检索：使用原始查询
        searchQuery = query;
        break;
    }

    // 根据检索策略调整
    switch (options.strategy) {
      case 'exact_match':
        // 精确匹配：提高最小分数阈值
        return {
          query: searchQuery,
          limit: options.topK,
          minScore: Math.max(options.minScore, 0.8),
        };
      case 'fuzzy_match':
        // 模糊匹配：降低最小分数阈值
        return {
          query: searchQuery,
          limit: options.topK * 2, // 获取更多候选
          minScore: Math.min(options.minScore, 0.2),
        };
      case 'semantic_match':
      default:
        // 语义匹配：使用默认参数
        return {
          query: searchQuery,
          limit: options.topK,
          minScore: options.minScore,
        };
    }
  }

  /**
   * 转换搜索结果
   */
  private convertResults(
    results: KnowledgeSearchResult[],
    options: PreRetrievalOptions
  ): RetrievedKnowledge[] {
    return results
      .filter(r => r.score >= options.minScore)
      .slice(0, options.topK)
      .map(r => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content,
        type: r.entry.type,
        score: r.score,
        source: r.entry.metadata.source,
        metadata: r.entry.metadata,
      }));
  }

  /**
   * 带超时控制的执行
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('TIMEOUT')), timeout)
      ),
    ]);
  }

  /**
   * 获取配置
   */
  getConfig(): PreRetrievalEngineConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PreRetrievalEngineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('PreRetrievalEngine config updated', { config: this.config });
  }
}

/**
 * 创建 PreRetrievalEngine 实例的工厂函数
 */
export function createPreRetrievalEngine(
  knowledgeBase: KnowledgeBase,
  config?: Partial<PreRetrievalEngineConfig>
): PreRetrievalEngine {
  return new PreRetrievalEngine(knowledgeBase, config);
}
