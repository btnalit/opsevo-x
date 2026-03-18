/**
 * MetadataEnhancer - 元数据增强器
 * 
 * 负责在知识添加时自动生成增强元数据，包括关键词、问题示例和同义词。
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 * - 1.1: 自动提取 5-10 个关键词
 * - 1.2: 自动生成 3-5 个问题示例
 * - 1.3: 自动生成同义词映射
 * - 1.4: 异步执行，不阻塞添加操作
 * - 1.5: LLM 不可用时降级到 TF-IDF
 * - 1.6: 增强元数据存储在知识条目中
 * 
 * Prompt 模板管理集成:
 * - 支持从 PromptTemplateService 动态获取提示词模板
 * - 支持模板热更新，无需重启服务
 */

import { logger } from '../../../utils/logger';
import { IAIProviderAdapter, ChatRequest, AIProvider } from '../../../types/ai';
import { KnowledgeEntry } from './knowledgeBase';
import {
  EnhancedMetadata,
  MetadataEnhancerConfig,
  DEFAULT_METADATA_ENHANCER_CONFIG,
} from './types/hybridSearch';
import { promptTemplateService } from '../../ai/promptTemplateService';

// ==================== TF-IDF 相关类型 ====================

interface TermFrequency {
  term: string;
  frequency: number;
  tfidf: number;
}

// ==================== 停用词列表 ====================

const CHINESE_STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '什么', '怎么', '如何', '为什么', '哪', '哪个', '哪些',
  '可以', '能', '能够', '应该', '需要', '想', '想要', '请', '请问', '吗', '呢',
  '啊', '吧', '呀', '嘛', '哦', '哈', '嗯', '噢', '唉', '哎', '喂', '嘿',
  '这个', '那个', '这些', '那些', '这里', '那里', '这样', '那样', '如此',
  '因为', '所以', '但是', '但', '然而', '而且', '并且', '或者', '或', '以及',
  '如果', '虽然', '即使', '只要', '只有', '除非', '无论', '不管', '不论',
  '对于', '关于', '根据', '按照', '通过', '经过', '由于', '为了', '以便',
  '之', '其', '此', '彼', '某', '各', '每', '任何', '所有', '全部', '一切',
]);

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me',
  'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what', 'which',
  'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here',
]);

// ==================== LLM 提示词模板 ====================

/**
 * 提示词模板名称常量
 */
const TEMPLATE_NAME_METADATA_ENHANCEMENT = '元数据增强提示词';

/**
 * 默认元数据增强提示词（回退用）
 */
const DEFAULT_ENHANCEMENT_PROMPT = `你是一个知识库元数据增强专家。请分析以下知识条目，并生成增强元数据。

知识条目：
标题：{title}
类型：{type}
内容：{content}

请生成以下内容（使用 JSON 格式返回）：

1. keywords: 提取 {keywordCount} 个最重要的关键词（包括技术术语、产品名称、操作类型等）
2. questionExamples: 生成 {questionCount} 个用户可能会问的问题示例（这些问题应该能够通过这个知识条目来回答）
3. synonyms: 为关键词生成同义词映射（格式：{"关键词": ["同义词1", "同义词2"]}）

要求：
- 关键词应该是具体的、有意义的词汇，避免过于通用的词
- 问题示例应该自然、口语化，模拟真实用户的提问方式
- 同义词应该包括中英文对照、缩写、常见别名等

请直接返回 JSON 格式，不要包含其他文字：
{
  "keywords": ["关键词1", "关键词2", ...],
  "questionExamples": ["问题1？", "问题2？", ...],
  "synonyms": {"关键词1": ["同义词1", "同义词2"], ...}
}`;

// 保留原有常量用于向后兼容
const ENHANCEMENT_PROMPT = DEFAULT_ENHANCEMENT_PROMPT;

/**
 * MetadataEnhancer 元数据增强器类
 */
export class MetadataEnhancer {
  private config: MetadataEnhancerConfig;
  private aiAdapter: IAIProviderAdapter | null = null;
  private provider: AIProvider = AIProvider.OPENAI;
  private model: string = 'gpt-4o-mini';
  
  // 用于 TF-IDF 计算的文档频率缓存
  private documentFrequency: Map<string, number> = new Map();
  private totalDocuments: number = 0;

  constructor(config?: Partial<MetadataEnhancerConfig>) {
    this.config = { ...DEFAULT_METADATA_ENHANCER_CONFIG, ...config };
    logger.info('MetadataEnhancer created', { config: this.config });
  }

  /**
   * 设置 AI 适配器
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model?: string): void {
    this.aiAdapter = adapter;
    this.provider = provider;
    if (model) {
      this.model = model;
    }
    logger.info('MetadataEnhancer AI adapter set', { provider, model: this.model });
  }

  /**
   * 增强知识条目元数据
   * Requirements: 1.1, 1.2, 1.3, 1.5
   * 
   * @param entry 知识条目
   * @returns 增强后的元数据
   */
  async enhance(entry: KnowledgeEntry): Promise<EnhancedMetadata> {
    const startTime = Date.now();

    try {
      // 如果启用 LLM 且适配器可用，尝试使用 LLM 增强
      if (this.config.enableLLM && this.aiAdapter) {
        try {
          const result = await this.enhanceWithLLM(entry);
          logger.info('Metadata enhanced with LLM', {
            entryId: entry.id,
            duration: Date.now() - startTime,
          });
          return result;
        } catch (error) {
          logger.warn('LLM enhancement failed, falling back to TF-IDF', {
            entryId: entry.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // 降级到 TF-IDF
          return this.enhanceFallback(entry);
        }
      }

      // 使用降级方法
      return this.enhanceFallback(entry);
    } catch (error) {
      logger.error('Metadata enhancement failed', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // 返回最小化的增强结果
      return this.createMinimalEnhancement(entry);
    }
  }

  /**
   * 使用 LLM 增强元数据
   * Requirements: 1.1, 1.2, 1.3
   * 
   * 模板管理集成：
   * - 优先从 PromptTemplateService 获取模板
   * - 支持模板热更新
   */
  private async enhanceWithLLM(entry: KnowledgeEntry): Promise<EnhancedMetadata> {
    if (!this.aiAdapter) {
      throw new Error('AI adapter not available');
    }

    // 从模板服务获取提示词模板
    let promptTemplate = ENHANCEMENT_PROMPT;
    try {
      promptTemplate = await promptTemplateService.getTemplateContent(
        TEMPLATE_NAME_METADATA_ENHANCEMENT,
        DEFAULT_ENHANCEMENT_PROMPT
      );
    } catch (error) {
      logger.debug('Failed to get metadata enhancement template, using default', { error });
    }

    // 构建提示词
    const prompt = promptTemplate
      .replace('{title}', entry.title)
      .replace('{type}', entry.type)
      .replace('{content}', entry.content.substring(0, 2000)) // 限制内容长度
      .replace('{keywordCount}', String(this.config.keywordCount))
      .replace('{questionCount}', String(this.config.questionExampleCount));

    // 调用 LLM
    const request: ChatRequest = {
      provider: this.provider,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: this.model,
      stream: false,
      temperature: 0.3,
      maxTokens: 1000,
    };

    // 使用超时控制
    const response = await Promise.race([
      this.aiAdapter.chat(request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM timeout')), this.config.llmTimeout)
      ),
    ]);

    // 解析响应
    const content = response.content;
    const parsed = this.parseLLMResponse(content);

    // 构建可搜索文本
    const searchableText = this.buildSearchableText(entry, parsed.keywords, parsed.questionExamples);

    return {
      autoKeywords: parsed.keywords,
      questionExamples: parsed.questionExamples,
      autoSynonyms: parsed.synonyms,
      searchableText,
      enhancedAt: Date.now(),
      enhancementSource: 'llm',
    };
  }

  /**
   * 解析 LLM 响应
   */
  private parseLLMResponse(content: string): {
    keywords: string[];
    questionExamples: string[];
    synonyms: Record<string, string[]>;
  } {
    try {
      // 尝试提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 10) : [],
        questionExamples: Array.isArray(parsed.questionExamples) ? parsed.questionExamples.slice(0, 5) : [],
        synonyms: typeof parsed.synonyms === 'object' && parsed.synonyms !== null ? parsed.synonyms : {},
      };
    } catch (error) {
      logger.warn('Failed to parse LLM response', { error, content: content.substring(0, 200) });
      return {
        keywords: [],
        questionExamples: [],
        synonyms: {},
      };
    }
  }

  /**
   * 降级增强（使用 TF-IDF）
   * Requirements: 1.5
   * 
   * @param entry 知识条目
   * @returns 增强后的元数据
   */
  enhanceFallback(entry: KnowledgeEntry): EnhancedMetadata {
    const startTime = Date.now();

    // 提取关键词（使用 TF-IDF）
    const keywords = this.extractKeywordsTFIDF(entry);

    // 生成简单的问题示例
    const questionExamples = this.generateSimpleQuestions(entry, keywords);

    // 生成简单的同义词映射
    const synonyms = this.generateSimpleSynonyms(keywords);

    // 构建可搜索文本
    const searchableText = this.buildSearchableText(entry, keywords, questionExamples);

    logger.debug('Metadata enhanced with fallback', {
      entryId: entry.id,
      keywordsCount: keywords.length,
      duration: Date.now() - startTime,
    });

    return {
      autoKeywords: keywords,
      questionExamples,
      autoSynonyms: synonyms,
      searchableText,
      enhancedAt: Date.now(),
      enhancementSource: 'fallback',
    };
  }

  /**
   * 使用 TF-IDF 提取关键词
   */
  private extractKeywordsTFIDF(entry: KnowledgeEntry): string[] {
    const text = `${entry.title} ${entry.content}`;
    const terms = this.tokenize(text);

    // 计算词频
    const termFreq = new Map<string, number>();
    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) || 0) + 1);
    }

    // 计算 TF-IDF 分数
    const tfidfScores: TermFrequency[] = [];
    const totalTerms = terms.length;

    for (const [term, freq] of termFreq) {
      // TF: 词频 / 总词数
      const tf = freq / totalTerms;
      
      // IDF: log(总文档数 / 包含该词的文档数)
      // 由于我们没有完整的文档集，使用简化的 IDF
      const df = this.documentFrequency.get(term) || 1;
      const idf = Math.log((this.totalDocuments + 1) / (df + 1)) + 1;
      
      const tfidf = tf * idf;

      tfidfScores.push({ term, frequency: freq, tfidf });
    }

    // 按 TF-IDF 分数排序并取前 N 个
    tfidfScores.sort((a, b) => b.tfidf - a.tfidf);

    return tfidfScores
      .slice(0, this.config.keywordCount)
      .map(t => t.term);
  }

  /**
   * 分词
   */
  private tokenize(text: string): string[] {
    const tokens: string[] = [];

    // 中文分词（简单实现：按字符和常见词组分割）
    // 提取中文词组（2-4个字符）
    const chinesePattern = /[\u4e00-\u9fa5]{2,4}/g;
    const chineseMatches = text.match(chinesePattern) || [];
    
    for (const match of chineseMatches) {
      if (!CHINESE_STOP_WORDS.has(match) && match.length >= this.config.minKeywordLength) {
        tokens.push(match);
      }
    }

    // 英文分词
    const englishPattern = /[a-zA-Z][a-zA-Z0-9_-]{1,}/g;
    const englishMatches = text.match(englishPattern) || [];
    
    for (const match of englishMatches) {
      const lower = match.toLowerCase();
      if (!ENGLISH_STOP_WORDS.has(lower) && match.length >= this.config.minKeywordLength) {
        tokens.push(match);
      }
    }

    // 提取数字+单位组合（如 100Mbps, 1GB）
    const numericPattern = /\d+(?:\.\d+)?(?:Mbps|Gbps|KB|MB|GB|TB|ms|s|%|MHz|GHz)/gi;
    const numericMatches = text.match(numericPattern) || [];
    tokens.push(...numericMatches);

    return tokens;
  }

  /**
   * 生成简单的问题示例
   */
  private generateSimpleQuestions(entry: KnowledgeEntry, keywords: string[]): string[] {
    const questions: string[] = [];
    const title = entry.title;

    // 基于标题生成问题
    if (title.includes('故障') || title.includes('问题') || title.includes('错误')) {
      questions.push(`${title}怎么解决？`);
      questions.push(`遇到${title}怎么办？`);
    } else if (title.includes('配置') || title.includes('设置')) {
      questions.push(`如何${title}？`);
      questions.push(`${title}的步骤是什么？`);
    } else if (title.includes('告警') || title.includes('监控')) {
      questions.push(`${title}是什么意思？`);
      questions.push(`收到${title}怎么处理？`);
    } else {
      questions.push(`什么是${title}？`);
      questions.push(`${title}怎么操作？`);
    }

    // 基于关键词生成问题
    for (const keyword of keywords.slice(0, 2)) {
      if (!questions.some(q => q.includes(keyword))) {
        questions.push(`${keyword}相关的问题怎么处理？`);
      }
    }

    return questions.slice(0, this.config.questionExampleCount);
  }

  /**
   * 生成简单的同义词映射
   */
  private generateSimpleSynonyms(keywords: string[]): Record<string, string[]> {
    const synonyms: Record<string, string[]> = {};

    // 预定义的同义词映射
    const predefinedSynonyms: Record<string, string[]> = {
      '故障': ['问题', '异常', '错误', 'error', 'fault'],
      '接口': ['端口', 'interface', 'port'],
      'CPU': ['处理器', 'cpu', 'processor'],
      '内存': ['memory', 'ram', 'mem'],
      '网络': ['network', '连接', '通信'],
      '路由': ['route', 'routing', '路由表'],
      '防火墙': ['firewall', 'filter', '过滤'],
      '告警': ['alert', 'alarm', '报警', '警告'],
      '修复': ['repair', 'fix', '解决', '处理'],
      '配置': ['config', 'configuration', '设置'],
      '监控': ['monitor', 'monitoring', '观察'],
      '带宽': ['bandwidth', 'bw', '流量'],
      '延迟': ['latency', 'delay', '时延'],
      '丢包': ['packet loss', 'drop', '丢弃'],
      '客服': ['客户服务', '服务', 'support', '帮助'],
      '机器人': ['bot', 'robot', '自动'],
    };

    for (const keyword of keywords) {
      const keywordLower = keyword.toLowerCase();
      
      // 检查预定义同义词
      for (const [key, syns] of Object.entries(predefinedSynonyms)) {
        if (keyword.includes(key) || keywordLower.includes(key.toLowerCase())) {
          synonyms[keyword] = syns.filter(s => s !== keyword);
          break;
        }
      }
    }

    return synonyms;
  }

  /**
   * 构建可搜索文本
   */
  private buildSearchableText(
    entry: KnowledgeEntry,
    keywords: string[],
    questionExamples: string[]
  ): string {
    const parts: string[] = [
      entry.title,
      ...(entry.metadata.tags || []),
      ...keywords,
      ...questionExamples,
    ];

    return parts.join(' ');
  }

  /**
   * 创建最小化的增强结果
   */
  private createMinimalEnhancement(entry: KnowledgeEntry): EnhancedMetadata {
    // 从标题提取简单关键词
    const titleWords = this.tokenize(entry.title);

    return {
      autoKeywords: titleWords.slice(0, 5),
      questionExamples: [],
      autoSynonyms: {},
      searchableText: `${entry.title} ${entry.metadata.tags?.join(' ') || ''}`,
      enhancedAt: Date.now(),
      enhancementSource: 'fallback',
    };
  }

  /**
   * 批量增强（用于迁移）
   * Requirements: 1.4
   * 
   * @param entries 知识条目列表
   * @returns 增强结果映射
   */
  async enhanceBatch(
    entries: KnowledgeEntry[],
    onProgress?: (current: number, total: number) => void
  ): Promise<Map<string, EnhancedMetadata>> {
    const results = new Map<string, EnhancedMetadata>();
    const total = entries.length;
    let current = 0;

    // 更新文档频率统计
    this.updateDocumentFrequency(entries);

    // 分批处理
    const batchSize = this.config.batchConcurrency;
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      
      // 并行处理当前批次
      const batchPromises = batch.map(async (entry) => {
        try {
          const enhanced = await this.enhance(entry);
          results.set(entry.id, enhanced);
        } catch (error) {
          logger.error('Batch enhancement failed for entry', {
            entryId: entry.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // 使用最小化增强
          results.set(entry.id, this.createMinimalEnhancement(entry));
        }
        
        current++;
        if (onProgress) {
          onProgress(current, total);
        }
      });

      await Promise.all(batchPromises);

      // 添加小延迟避免 API 限流
      if (this.config.enableLLM && this.aiAdapter && i + batchSize < entries.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    logger.info('Batch enhancement completed', {
      total,
      success: results.size,
    });

    return results;
  }

  /**
   * 更新文档频率统计（用于 TF-IDF）
   */
  private updateDocumentFrequency(entries: KnowledgeEntry[]): void {
    this.documentFrequency.clear();
    this.totalDocuments = entries.length;

    for (const entry of entries) {
      const text = `${entry.title} ${entry.content}`;
      const terms = new Set(this.tokenize(text));

      for (const term of terms) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
      }
    }
  }

  /**
   * 获取配置
   */
  getConfig(): MetadataEnhancerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<MetadataEnhancerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('MetadataEnhancer config updated', { config: this.config });
  }
}

// 导出单例实例
export const metadataEnhancer = new MetadataEnhancer();
