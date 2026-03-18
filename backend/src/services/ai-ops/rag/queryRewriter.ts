/**
 * QueryRewriter - 查询改写器
 * 
 * 使用 LLM 将用户问题改写为更适合知识库检索的形式。
 * 集成 SynonymExpander 进行关键词扩展，使用 LRU 缓存避免重复调用。
 * 
 * Requirements: 3.1, 3.2, 6.3
 * - 3.1: 使用 LLM 改写查询以提高检索效果
 * - 3.2: 集成 SynonymExpander 进行关键词扩展
 * - 6.3: 缓存改写结果避免重复 LLM 调用
 * 
 * Prompt 模板管理集成:
 * - 支持从 PromptTemplateService 动态获取提示词模板
 * - 支持模板热更新，无需重启服务
 */

import { logger } from '../../../utils/logger';
import { RewriteResult, FastPathError, FastPathErrorCode } from '../../../types/fast-path';
import { SynonymExpander, synonymExpander as defaultSynonymExpander } from './synonymExpander';
import { LRUCache, createLRUCache } from '../../core/lruCache';
import { IAIProviderAdapter } from '../../../types/ai';
import { promptTemplateService } from '../../ai/promptTemplateService';

// ==================== 查询改写提示词 ====================

/**
 * 提示词模板名称常量
 */
const TEMPLATE_NAME_QUERY_REWRITE = '查询改写提示词';

/**
 * 默认查询改写提示词（回退用）
 */
const DEFAULT_REWRITE_SYSTEM_PROMPT = `你是一个专业的查询改写助手，专门优化网络运维领域的知识库检索查询。

你的任务是将用户的自然语言问题改写为更适合知识库检索的形式，以提高检索的准确性和召回率。

改写原则：
1. 提取核心关键词，去除无关的语气词和修饰词
2. 将口语化表达转换为专业术语
3. 扩展可能的同义词和相关概念
4. 保持查询的核心意图不变
5. 输出简洁明了的检索查询

输出格式（JSON）：
{
  "rewrittenQuery": "改写后的查询",
  "keywords": ["关键词1", "关键词2", ...],
  "intent": "查询意图简述"
}`;

// 保留原有常量用于向后兼容
const REWRITE_SYSTEM_PROMPT = DEFAULT_REWRITE_SYSTEM_PROMPT;

const REWRITE_USER_PROMPT_TEMPLATE = `请改写以下查询以优化知识库检索：

原始查询：{query}

已识别的同义词扩展：
{synonyms}

请输出改写结果（JSON格式）：`;

// ==================== QueryRewriter 类 ====================

/**
 * QueryRewriter 配置
 */
export interface QueryRewriterConfig {
  /** 是否启用 LLM 改写 */
  enableLLMRewrite: boolean;
  /** 缓存最大条目数 */
  cacheMaxEntries: number;
  /** 缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** LLM 调用超时（毫秒） */
  llmTimeoutMs: number;
  /** 最大关键词数量 */
  maxKeywords: number;
  /** LLM 提供商（可选，默认从 adapter 获取） */
  llmProvider?: string;
  /** LLM 模型（可选，默认从 adapter 获取） */
  llmModel?: string;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: QueryRewriterConfig = {
  enableLLMRewrite: true,
  cacheMaxEntries: 1000,
  cacheTtlMs: 30 * 60 * 1000, // 30 分钟
  llmTimeoutMs: 5000, // 5 秒
  maxKeywords: 10,
};

/**
 * 缓存条目
 */
interface CachedRewrite {
  rewrittenQuery: string;
  synonyms: string[];
  keywords: string[];
  timestamp: number;
}

/**
 * QueryRewriter 类
 * 
 * LLM 驱动的查询改写器，支持同义词扩展和结果缓存。
 */
export class QueryRewriter {
  private config: QueryRewriterConfig;
  private synonymExpander: SynonymExpander;
  private aiAdapter: IAIProviderAdapter | null;
  private cache: LRUCache<string, CachedRewrite>;

  constructor(
    aiAdapter: IAIProviderAdapter | null,
    synonymExpander?: SynonymExpander,
    config?: Partial<QueryRewriterConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.aiAdapter = aiAdapter;
    this.synonymExpander = synonymExpander || defaultSynonymExpander;
    this.cache = createLRUCache<string, CachedRewrite>({
      maxEntries: this.config.cacheMaxEntries,
      ttlMs: this.config.cacheTtlMs,
    });

    logger.info('QueryRewriter created', { 
      config: this.config,
      hasAIAdapter: !!aiAdapter,
    });
  }

  /**
   * 改写查询
   * 
   * @param query 原始查询
   * @returns 改写结果
   */
  async rewrite(query: string): Promise<RewriteResult> {
    const startTime = performance.now();
    const normalizedQuery = query.trim();
    const cacheKey = this.getCacheKey(normalizedQuery);

    // 1. 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.debug('Query rewrite cache hit', { query: normalizedQuery.substring(0, 50) });
      return {
        rewrittenQuery: cached.rewrittenQuery,
        synonyms: cached.synonyms,
        keywords: cached.keywords,
        rewriteTime: performance.now() - startTime,
        fromCache: true,
      };
    }

    // 2. 同义词扩展
    const synonymExpansion = this.synonymExpander.expandQuery(normalizedQuery);
    const synonyms = synonymExpansion.expanded;

    // 3. 尝试 LLM 改写
    let rewrittenQuery = normalizedQuery;
    let keywords: string[] = [];

    if (this.config.enableLLMRewrite && this.aiAdapter) {
      try {
        const llmResult = await this.rewriteWithLLM(normalizedQuery, synonyms);
        rewrittenQuery = llmResult.rewrittenQuery;
        keywords = llmResult.keywords;
      } catch (error) {
        logger.warn('LLM rewrite failed, using fallback', { error, query: normalizedQuery.substring(0, 50) });
        // 降级：使用基于规则的改写
        const fallbackResult = this.rewriteWithRules(normalizedQuery, synonyms);
        rewrittenQuery = fallbackResult.rewrittenQuery;
        keywords = fallbackResult.keywords;
      }
    } else {
      // 无 LLM 时使用规则改写
      const fallbackResult = this.rewriteWithRules(normalizedQuery, synonyms);
      rewrittenQuery = fallbackResult.rewrittenQuery;
      keywords = fallbackResult.keywords;
    }

    // 4. 缓存结果
    const cacheEntry: CachedRewrite = {
      rewrittenQuery,
      synonyms,
      keywords,
      timestamp: Date.now(),
    };
    this.cache.set(cacheKey, cacheEntry);

    const rewriteTime = performance.now() - startTime;
    logger.debug('Query rewritten', { 
      original: normalizedQuery.substring(0, 50),
      rewritten: rewrittenQuery.substring(0, 50),
      time: rewriteTime,
    });

    return {
      rewrittenQuery,
      synonyms,
      keywords,
      rewriteTime,
      fromCache: false,
    };
  }

  /**
   * 使用 LLM 改写查询
   * 
   * 模板管理集成：
   * - 优先从 PromptTemplateService 获取模板
   * - 支持模板热更新
   */
  private async rewriteWithLLM(
    query: string,
    synonyms: string[]
  ): Promise<{ rewrittenQuery: string; keywords: string[] }> {
    if (!this.aiAdapter) {
      throw new FastPathError(
        FastPathErrorCode.LLM_SERVICE_UNAVAILABLE,
        'AI adapter not available'
      );
    }

    const synonymsText = synonyms.length > 0
      ? synonyms.map(s => `- ${s}`).join('\n')
      : '（无）';

    const userPrompt = REWRITE_USER_PROMPT_TEMPLATE
      .replace('{query}', query)
      .replace('{synonyms}', synonymsText);

    try {
      // 从模板服务获取系统提示词
      let systemPrompt = REWRITE_SYSTEM_PROMPT;
      try {
        systemPrompt = await promptTemplateService.getTemplateContent(
          TEMPLATE_NAME_QUERY_REWRITE,
          DEFAULT_REWRITE_SYSTEM_PROMPT
        );
      } catch (error) {
        logger.debug('Failed to get query rewrite template, using default', { error });
      }

      // 使用超时控制
      // 从配置获取 provider 和 model，如果未配置则使用默认值
      const provider = this.config.llmProvider || 'openai';
      const model = this.config.llmModel || 'gpt-4o-mini'; // 使用较小模型以提高速度
      
      const response = await Promise.race([
        this.aiAdapter.chat({
          provider: provider as any,
          model: model,
          messages: [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: userPrompt },
          ],
          stream: false,
        }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('LLM timeout')), this.config.llmTimeoutMs)
        ),
      ]);

      // 解析 JSON 响应
      const content = response.content.trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          rewrittenQuery: parsed.rewrittenQuery || query,
          keywords: (parsed.keywords || []).slice(0, this.config.maxKeywords),
        };
      }

      // 如果无法解析 JSON，返回原始内容作为改写结果
      return {
        rewrittenQuery: content.length > 0 && content.length < 200 ? content : query,
        keywords: [],
      };
    } catch (error) {
      throw new FastPathError(
        FastPathErrorCode.QUERY_REWRITE_FAILED,
        `LLM rewrite failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * 使用规则改写查询（降级方案）
   */
  private rewriteWithRules(
    query: string,
    synonyms: string[]
  ): { rewrittenQuery: string; keywords: string[] } {
    // 提取关键词
    const keywords = this.extractKeywords(query);
    
    // 构建改写查询
    // 策略：原始查询 + 同义词扩展
    let rewrittenQuery = query;
    
    if (synonyms.length > 0) {
      // 添加最相关的同义词
      const topSynonyms = synonyms.slice(0, 3);
      rewrittenQuery = `${query} ${topSynonyms.join(' ')}`;
    }

    return {
      rewrittenQuery: rewrittenQuery.trim(),
      keywords: keywords.slice(0, this.config.maxKeywords),
    };
  }

  /**
   * 提取关键词
   */
  private extractKeywords(query: string): string[] {
    const keywords: string[] = [];
    
    // 移除常见的停用词
    const stopWords = new Set([
      '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
      '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
      '自己', '这', '那', '什么', '怎么', '如何', '为什么', '哪个', '哪些',
      '请', '帮', '帮我', '能', '能不能', '可以', '吗', '呢', '啊', '吧',
    ]);

    // 简单分词（按空格和标点）
    const tokens = query.split(/[\s,，。！？、；：""''（）【】\[\]]+/);
    
    for (const token of tokens) {
      const trimmed = token.trim();
      if (trimmed.length >= 2 && !stopWords.has(trimmed)) {
        keywords.push(trimmed);
      }
    }

    return [...new Set(keywords)];
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(query: string): string {
    // 简单的规范化：小写 + 去除多余空格
    return query.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const stats = this.cache.getStats();
    return {
      hits: stats.hitCount,
      misses: stats.missCount,
      size: stats.entries,
      hitRate: stats.hitRate,
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('QueryRewriter cache cleared');
  }

  /**
   * 预热缓存（批量改写常见查询）
   */
  async warmupCache(queries: string[]): Promise<void> {
    logger.info('Warming up QueryRewriter cache', { count: queries.length });
    
    for (const query of queries) {
      try {
        await this.rewrite(query);
      } catch (error) {
        logger.warn('Cache warmup failed for query', { query: query.substring(0, 50), error });
      }
    }
  }

  /**
   * 获取配置
   */
  getConfig(): QueryRewriterConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<QueryRewriterConfig>): void {
    this.config = { ...this.config, ...config };
    
    // 如果缓存配置变化，重新创建缓存
    if (config.cacheMaxEntries || config.cacheTtlMs) {
      const oldStats = this.cache.getStats();
      this.cache.destroy();
      this.cache = createLRUCache<string, CachedRewrite>({
        maxEntries: this.config.cacheMaxEntries,
        ttlMs: this.config.cacheTtlMs,
      });
      logger.info('QueryRewriter cache recreated', { 
        oldEntries: oldStats.entries,
        newConfig: { maxEntries: this.config.cacheMaxEntries, ttlMs: this.config.cacheTtlMs },
      });
    }

    logger.info('QueryRewriter config updated', { config: this.config });
  }

  /**
   * 设置 AI 适配器
   */
  setAIAdapter(adapter: IAIProviderAdapter | null): void {
    this.aiAdapter = adapter;
    logger.info('QueryRewriter AI adapter updated', { hasAdapter: !!adapter });
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.cache.destroy();
    logger.info('QueryRewriter destroyed');
  }
}

/**
 * 创建 QueryRewriter 实例的工厂函数
 */
export function createQueryRewriter(
  aiAdapter: IAIProviderAdapter | null,
  synonymExpander?: SynonymExpander,
  config?: Partial<QueryRewriterConfig>
): QueryRewriter {
  return new QueryRewriter(aiAdapter, synonymExpander, config);
}
