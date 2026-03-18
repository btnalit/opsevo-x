/**
 * FastPathRouter - 快速路径路由器
 * 
 * 主控制器，协调整个快速路径流程。
 * 集成 IntentClassifier, PreRetrievalEngine, QueryRewriter。
 * 实现置信度阈值路由和智能重试机制。
 * 
 * Requirements: 1.2, 1.3, 1.4, 1.5, 3.5, 3.6, 5.1-5.5
 * - 1.2: 置信度 >= 0.85 时直达模式
 * - 1.3: 置信度 0.6-0.85 时增强模式
 * - 1.4: 置信度 < 0.6 时触发智能重试
 * - 1.5: 超时时优雅降级到 ReAct
 * - 3.5: 最多 2 次重试
 * - 3.6: 总重试时间不超过 1500ms
 * - 5.1-5.5: 分层响应策略
 */

import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import {
  FastPathRouterConfig,
  FastPathResult,
  FastPathContext,
  FastPathStats,
  FastPathFeedback,
  ResponseMode,
  KnowledgeGap,
  Citation,
  RetrievedKnowledge,
  IntentClassification,
  DEFAULT_FAST_PATH_CONFIG,
  FastPathError,
  FastPathErrorCode,
} from '../../../types/fast-path';
import { FastPathIntentClassifier } from './fastPathIntentClassifier';
import { PreRetrievalEngine } from './preRetrievalEngine';
import { QueryRewriter } from './queryRewriter';
import { KnowledgeBase } from './knowledgeBase';
import { IAIProviderAdapter } from '../../../types/ai';

// ==================== 并发控制配置 ====================

/**
 * 快速路径并发控制配置
 */
export interface FastPathConcurrencyConfig {
  /** 最大并发请求数 */
  maxConcurrent: number;
  /** 最大等待队列大小 */
  maxQueueSize: number;
  /** 请求超时（毫秒） */
  requestTimeout: number;
}

/**
 * 默认并发控制配置
 */
const DEFAULT_CONCURRENCY_CONFIG: FastPathConcurrencyConfig = {
  maxConcurrent: 10,
  maxQueueSize: 50,
  requestTimeout: 3000, // 3 秒
};

// ==================== FastPathRouter 类 ====================

/**
 * FastPathRouter 类
 * 
 * 快速路径主路由器，协调意图分类、预检索和查询改写。
 */
export class FastPathRouter {
  private config: FastPathRouterConfig;
  private concurrencyConfig: FastPathConcurrencyConfig;
  private intentClassifier: FastPathIntentClassifier;
  private preRetrievalEngine: PreRetrievalEngine;
  private queryRewriter: QueryRewriter;
  private aiAdapter: IAIProviderAdapter | null;

  // 并发控制
  private activeRequests = 0;
  private requestQueue: Array<{
    resolve: (result: FastPathResult) => void;
    reject: (error: Error) => void;
    query: string;
    context?: FastPathContext;
    timestamp: number;
  }> = [];

  // 统计信息
  private stats: FastPathStats = {
    totalQueries: 0,
    directHits: 0,
    enhancedHits: 0,
    explorationCount: 0,
    explicitNotificationCount: 0,
    avgResponseTime: 0,
    avgRetryCount: 0,
    falsePositives: 0,
    falseNegatives: 0,
    knowledgeGaps: 0,
  };

  // 知识缺口注册表（带大小限制，防止内存泄漏）
  private knowledgeGaps: Map<string, KnowledgeGap> = new Map();
  private readonly maxKnowledgeGaps = 1000; // 最大知识缺口记录数

  // 响应时间累计（用于计算平均值）
  private totalResponseTime = 0;
  private totalRetryCount = 0;

  constructor(
    knowledgeBase: KnowledgeBase,
    aiAdapter: IAIProviderAdapter | null,
    config?: Partial<FastPathRouterConfig>,
    concurrencyConfig?: Partial<FastPathConcurrencyConfig>
  ) {
    this.config = { ...DEFAULT_FAST_PATH_CONFIG, ...config };
    this.concurrencyConfig = { ...DEFAULT_CONCURRENCY_CONFIG, ...concurrencyConfig };
    this.aiAdapter = aiAdapter;

    // 初始化组件
    this.intentClassifier = new FastPathIntentClassifier();
    this.preRetrievalEngine = new PreRetrievalEngine(knowledgeBase, {
      defaultTimeout: this.config.preRetrievalTimeout,
    });
    this.queryRewriter = new QueryRewriter(aiAdapter);

    logger.info('FastPathRouter created', {
      config: this.config,
      concurrencyConfig: this.concurrencyConfig,
    });
  }

  /**
   * 执行快速路径路由（带并发控制）
   * Requirements: 1.2, 1.3, 1.4, 1.5, 5.1-5.5
   * 
   * @param query 用户查询
   * @param context 上下文信息
   * @returns 快速路径结果
   */
  async route(query: string, context?: FastPathContext): Promise<FastPathResult> {
    const startTime = performance.now();

    // 检查是否启用
    if (!this.config.enabled) {
      return this.createExplorationResult(startTime, 0);
    }

    // 并发控制：检查是否可以立即执行
    if (this.activeRequests >= this.concurrencyConfig.maxConcurrent) {
      // 检查队列是否已满
      if (this.requestQueue.length >= this.concurrencyConfig.maxQueueSize) {
        logger.warn('FastPath request queue full, degrading to exploration', {
          activeRequests: this.activeRequests,
          queueSize: this.requestQueue.length,
        });
        return this.createExplorationResult(startTime, 0);
      }

      // 加入等待队列
      return new Promise<FastPathResult>((resolve, reject) => {
        this.requestQueue.push({
          resolve,
          reject,
          query,
          context,
          timestamp: Date.now(),
        });
        logger.debug('FastPath request queued', { queueSize: this.requestQueue.length });

        // 设置超时
        setTimeout(() => {
          const index = this.requestQueue.findIndex(r => r.query === query && r.timestamp === Date.now());
          if (index !== -1) {
            this.requestQueue.splice(index, 1);
            resolve(this.createExplorationResult(startTime, 0));
          }
        }, this.concurrencyConfig.requestTimeout);
      });
    }

    // 执行实际路由
    return this.executeRoute(query, context, startTime);
  }

  /**
   * 执行实际的路由逻辑
   */
  private async executeRoute(
    query: string,
    context: FastPathContext | undefined,
    startTime: number
  ): Promise<FastPathResult> {
    this.activeRequests++;
    const queryId = uuidv4();

    try {
      // 1. 意图分类
      const intentClassification = this.intentClassifier.classify(query);
      logger.debug('Intent classified', {
        query: query.substring(0, 50),
        intent: intentClassification.intent,
        confidence: intentClassification.confidence,
      });

      // 2. 根据意图路由
      // 实时类查询直接进入 ReAct
      if (intentClassification.intent === 'realtime_query') {
        return this.createExplorationResult(startTime, 0, intentClassification);
      }

      // 3. 执行预检索（带智能重试）
      const retrievalResult = await this.executeWithSmartRetry(query, intentClassification);

      // 4. 根据置信度确定响应模式
      let mode = this.determineMode(retrievalResult.maxConfidence);

      // 4.1 内容类型检查：如果是手册类文档，强制降级为增强模式 (Requirements: Content-Aware Routing)
      // 避免直接甩文档给用户，而是让 LLM 进行阅读和生成
      if (mode === 'direct' && retrievalResult.documents.length > 0) {
        const topDoc = retrievalResult.documents[0];
        const riskyTypes = ['manual', 'guide', 'instruction', 'prompt'];

        if (riskyTypes.includes(topDoc.type) ||
          (topDoc.metadata?.category && riskyTypes.includes(topDoc.metadata.category))) {
          logger.info('Downgrading from direct to enhanced mode due to document type', {
            id: topDoc.id,
            type: topDoc.type,
            category: topDoc.metadata?.category
          });
          mode = 'enhanced';
        }
      }

      const processingTime = performance.now() - startTime;

      // 5. 更新统计
      this.updateStats(mode, processingTime, retrievalResult.retryCount);

      // 6. 构建结果
      const result = await this.buildResult(
        mode,
        retrievalResult.documents,
        retrievalResult.maxConfidence,
        processingTime,
        retrievalResult.retryCount,
        intentClassification,
        query
      );

      logger.info('Fast path routing completed', {
        queryId,
        mode,
        confidence: retrievalResult.maxConfidence,
        processingTime,
        retryCount: retrievalResult.retryCount,
      });

      return result;
    } catch (error) {
      // 错误时优雅降级
      logger.error('Fast path routing failed, falling back to exploration', { error });
      return this.createExplorationResult(startTime, 0);
    } finally {
      // 并发控制：释放槽位并处理队列中的下一个请求
      this.activeRequests--;
      this.processNextInQueue();
    }
  }

  /**
   * 处理队列中的下一个请求
   */
  private processNextInQueue(): void {
    if (this.requestQueue.length === 0) {
      return;
    }

    // 清理过期的请求
    const now = Date.now();
    while (this.requestQueue.length > 0) {
      const oldest = this.requestQueue[0];
      if (now - oldest.timestamp > this.concurrencyConfig.requestTimeout) {
        this.requestQueue.shift();
        oldest.resolve(this.createExplorationResult(performance.now(), 0));
        continue;
      }
      break;
    }

    // 处理下一个有效请求
    if (this.requestQueue.length > 0 && this.activeRequests < this.concurrencyConfig.maxConcurrent) {
      const next = this.requestQueue.shift()!;
      this.executeRoute(next.query, next.context, performance.now())
        .then(next.resolve)
        .catch(next.reject);
    }
  }

  /**
   * 获取并发状态
   */
  getConcurrencyStatus(): { active: number; queued: number; maxConcurrent: number } {
    return {
      active: this.activeRequests,
      queued: this.requestQueue.length,
      maxConcurrent: this.concurrencyConfig.maxConcurrent,
    };
  }

  /**
   * 执行带智能重试的检索
   * Requirements: 3.5, 3.6
   * 
   * 重试逻辑：
   * - 初始检索（retryCount = 0）
   * - 最多 maxRetryAttempts 次重试（默认 2 次）
   * - 总共最多执行 maxRetryAttempts + 1 次检索
   */
  private async executeWithSmartRetry(
    query: string,
    intentClassification: IntentClassification
  ): Promise<{
    documents: RetrievedKnowledge[];
    maxConfidence: number;
    retryCount: number;
  }> {
    const startTime = performance.now();
    let retryCount = 0;
    let currentQuery = query;
    let bestDocuments: RetrievedKnowledge[] = [];
    let bestConfidence = 0;

    // 修复：使用 < 而非 <=，确保重试次数不超过 maxRetryAttempts
    // retryCount = 0 是初始检索，1 和 2 是重试
    while (retryCount < this.config.maxRetryAttempts + 1) {
      // 检查总时间限制
      const elapsed = performance.now() - startTime;
      if (elapsed >= this.config.smartRetryTimeout) {
        logger.warn('Smart retry timeout reached', { elapsed, retryCount });
        break;
      }

      // 计算剩余时间
      const remainingTime = this.config.smartRetryTimeout - elapsed;
      const timeout = Math.min(this.config.preRetrievalTimeout, remainingTime);

      try {
        // 执行检索
        const result = await this.preRetrievalEngine.retrieve(currentQuery, { timeout });

        // 更新最佳结果
        if (result.maxConfidence > bestConfidence) {
          bestDocuments = result.documents;
          bestConfidence = result.maxConfidence;
        }

        // 如果置信度足够高，停止重试
        if (bestConfidence >= this.config.enhancedThreshold) {
          break;
        }

        // 如果是第一次检索且置信度低，尝试改写查询
        if (retryCount < this.config.maxRetryAttempts && bestConfidence < this.config.enhancedThreshold) {
          try {
            const rewriteResult = await this.queryRewriter.rewrite(currentQuery);
            if (rewriteResult.rewrittenQuery !== currentQuery) {
              currentQuery = rewriteResult.rewrittenQuery;
              logger.debug('Query rewritten for retry', {
                original: query.substring(0, 50),
                rewritten: currentQuery.substring(0, 50),
              });
            }
          } catch (rewriteError) {
            logger.warn('Query rewrite failed', { error: rewriteError });
          }
        }

        retryCount++;
      } catch (error) {
        logger.warn('Retrieval attempt failed', { retryCount, error });
        retryCount++;
      }
    }

    return {
      documents: bestDocuments,
      maxConfidence: bestConfidence,
      retryCount,
    };
  }

  /**
   * 确定响应模式
   * Requirements: 1.2, 1.3, 1.4
   */
  determineMode(confidence: number): ResponseMode {
    if (confidence >= this.config.directThreshold) {
      return 'direct';
    } else if (confidence >= this.config.enhancedThreshold) {
      return 'enhanced';
    } else if (confidence > 0) {
      return 'exploration';
    } else {
      return 'explicit_notification';
    }
  }

  /**
   * 构建结果
   * Requirements: 5.1-5.5
   */
  private async buildResult(
    mode: ResponseMode,
    documents: RetrievedKnowledge[],
    confidence: number,
    processingTime: number,
    retryCount: number,
    intentClassification: IntentClassification,
    originalQuery: string
  ): Promise<FastPathResult> {
    const baseResult: FastPathResult = {
      mode,
      skipReAct: mode === 'direct' || mode === 'explicit_notification',
      knowledge: documents,
      confidence,
      processingTime,
      retryCount,
      intentClassification,
    };

    switch (mode) {
      case 'direct':
        // 直达模式：返回知识库答案和引用
        return {
          ...baseResult,
          response: this.buildDirectResponse(documents),
          citations: this.buildCitations(documents),
        };

      case 'enhanced':
        // 增强模式：返回知识库答案，标记需要 LLM 补充
        return {
          ...baseResult,
          response: this.buildEnhancedResponse(documents),
          citations: this.buildCitations(documents),
          skipReAct: false, // 增强模式仍需要 LLM 处理
        };

      case 'exploration':
        // 探索模式：进入 ReAct 循环
        return baseResult;

      case 'explicit_notification':
        // 明确告知模式：记录知识缺口
        const knowledgeGap = this.recordKnowledgeGap(originalQuery, intentClassification, retryCount);
        return {
          ...baseResult,
          response: this.buildExplicitNotificationResponse(),
          knowledgeGap,
        };

      default:
        return baseResult;
    }
  }

  /**
   * 构建直达响应
   */
  private buildDirectResponse(documents: RetrievedKnowledge[]): string {
    if (documents.length === 0) {
      return '';
    }

    const topDoc = documents[0];
    return `根据知识库记录：\n\n${topDoc.content}`;
  }

  /**
   * 构建增强响应
   */
  private buildEnhancedResponse(documents: RetrievedKnowledge[]): string {
    if (documents.length === 0) {
      return '';
    }

    const topDoc = documents[0];
    return `参考知识库记录（置信度中等，建议结合实际情况）：\n\n${topDoc.content}`;
  }

  /**
   * 构建明确告知响应
   */
  private buildExplicitNotificationResponse(): string {
    return '抱歉，知识库中暂无相关记录。建议您：\n1. 尝试使用不同的关键词描述问题\n2. 查看系统实时状态获取更多信息\n3. 如果这是一个常见问题，可以考虑添加到知识库';
  }

  /**
   * 构建引用信息
   */
  private buildCitations(documents: RetrievedKnowledge[]): Citation[] {
    return documents.slice(0, 3).map(doc => ({
      entryId: doc.id,
      title: doc.title,
      relevance: doc.score,
      excerpt: doc.content.substring(0, 200) + (doc.content.length > 200 ? '...' : ''),
    }));
  }

  /**
   * 记录知识缺口
   * Requirements: 4.1, 4.2, 4.3, 4.4
   * 
   * 包含 LRU 淘汰策略，防止内存泄漏
   */
  private recordKnowledgeGap(
    query: string,
    intentClassification: IntentClassification,
    retryCount: number
  ): KnowledgeGap | undefined {
    // 只有知识类查询才记录缺口
    if (intentClassification.intent !== 'knowledge_query') {
      return undefined;
    }

    // LRU 淘汰策略：当达到最大容量时，删除最旧的记录
    if (this.knowledgeGaps.size >= this.maxKnowledgeGaps) {
      this.evictOldestKnowledgeGaps();
    }

    const gap: KnowledgeGap = {
      id: uuidv4(),
      originalQuery: query,
      rewrittenQueries: [],
      queryType: intentClassification.intent,
      timestamp: Date.now(),
      retryCount,
      status: 'open',
    };

    this.knowledgeGaps.set(gap.id, gap);
    this.stats.knowledgeGaps++;

    logger.info('Knowledge gap recorded', { gapId: gap.id, query: query.substring(0, 50) });
    return gap;
  }

  /**
   * 淘汰最旧的知识缺口记录
   * 删除最旧的 10% 记录
   */
  private evictOldestKnowledgeGaps(): void {
    const entries = Array.from(this.knowledgeGaps.entries());
    // 按时间戳排序（最旧的在前）
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // 删除最旧的 10%
    const deleteCount = Math.max(1, Math.floor(this.maxKnowledgeGaps * 0.1));
    for (let i = 0; i < deleteCount && i < entries.length; i++) {
      this.knowledgeGaps.delete(entries[i][0]);
    }

    logger.debug('Evicted old knowledge gaps', { deletedCount: deleteCount });
  }

  /**
   * 创建探索模式结果（降级）
   */
  private createExplorationResult(
    startTime: number,
    retryCount: number,
    intentClassification?: IntentClassification
  ): FastPathResult {
    return {
      mode: 'exploration',
      skipReAct: false,
      confidence: 0,
      processingTime: performance.now() - startTime,
      retryCount,
      intentClassification,
    };
  }

  /**
   * 更新统计信息
   */
  private updateStats(mode: ResponseMode, processingTime: number, retryCount: number): void {
    this.stats.totalQueries++;
    this.totalResponseTime += processingTime;
    this.totalRetryCount += retryCount;

    switch (mode) {
      case 'direct':
        this.stats.directHits++;
        break;
      case 'enhanced':
        this.stats.enhancedHits++;
        break;
      case 'exploration':
        this.stats.explorationCount++;
        break;
      case 'explicit_notification':
        this.stats.explicitNotificationCount++;
        break;
    }

    // 更新平均值
    this.stats.avgResponseTime = this.totalResponseTime / this.stats.totalQueries;
    this.stats.avgRetryCount = this.totalRetryCount / this.stats.totalQueries;
  }

  /**
   * 更新配置
   * Requirements: 6.5
   */
  updateConfig(config: Partial<FastPathRouterConfig>): void {
    this.config = { ...this.config, ...config };

    // 更新子组件配置
    if (config.preRetrievalTimeout) {
      this.preRetrievalEngine.updateConfig({
        defaultTimeout: config.preRetrievalTimeout,
      });
    }

    logger.info('FastPathRouter config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): FastPathRouterConfig {
    return { ...this.config };
  }

  /**
   * 获取统计信息
   */
  getStats(): FastPathStats {
    return { ...this.stats };
  }

  /**
   * 记录用户反馈
   * Requirements: 7.2, 7.3, 7.4
   */
  recordFeedback(queryId: string, feedback: FastPathFeedback): void {
    // 检测假阳性（直达响应但答案错误）
    if (!feedback.correct && feedback.useful === false) {
      this.stats.falsePositives++;
      logger.info('False positive recorded', { queryId });
    }

    // 检测假阴性（进入 ReAct 但知识存在）
    // 这需要额外的上下文信息，暂时通过用户评论判断
    if (feedback.comment?.includes('知识库有') || feedback.comment?.includes('应该直接回答')) {
      this.stats.falseNegatives++;
      logger.info('False negative recorded', { queryId });
    }

    logger.info('Feedback recorded', { queryId, feedback });
  }

  /**
   * 获取知识缺口列表
   */
  getKnowledgeGaps(status?: KnowledgeGap['status']): KnowledgeGap[] {
    const gaps = Array.from(this.knowledgeGaps.values());
    if (status) {
      return gaps.filter(g => g.status === status);
    }
    return gaps;
  }

  /**
   * 更新知识缺口状态
   */
  updateKnowledgeGapStatus(gapId: string, status: KnowledgeGap['status']): boolean {
    const gap = this.knowledgeGaps.get(gapId);
    if (gap) {
      gap.status = status;
      logger.info('Knowledge gap status updated', { gapId, status });
      return true;
    }
    return false;
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      totalQueries: 0,
      directHits: 0,
      enhancedHits: 0,
      explorationCount: 0,
      explicitNotificationCount: 0,
      avgResponseTime: 0,
      avgRetryCount: 0,
      falsePositives: 0,
      falseNegatives: 0,
      knowledgeGaps: 0,
    };
    this.totalResponseTime = 0;
    this.totalRetryCount = 0;
    logger.info('FastPathRouter stats reset');
  }
}

/**
 * 创建 FastPathRouter 实例的工厂函数
 */
export function createFastPathRouter(
  knowledgeBase: KnowledgeBase,
  aiAdapter: IAIProviderAdapter | null,
  config?: Partial<FastPathRouterConfig>,
  concurrencyConfig?: Partial<FastPathConcurrencyConfig>
): FastPathRouter {
  return new FastPathRouter(knowledgeBase, aiAdapter, config, concurrencyConfig);
}
