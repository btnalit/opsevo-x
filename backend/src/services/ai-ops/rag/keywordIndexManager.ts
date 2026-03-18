/**
 * KeywordIndexManager - 关键词索引管理器
 * 
 * 管理基于关键词的倒排索引，支持 BM25 算法进行关键词检索。
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 * - 2.1: 索引 title, tags, autoKeywords, questionExamples 字段
 * - 2.2: 支持中文文本分词
 * - 2.3: 支持模糊匹配（编辑距离）
 * - 2.4: 自动更新索引
 * - 2.5: 持久化到磁盘
 * - 2.6: 20ms 内完成搜索
 */

import { logger } from '../../../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  KeywordSearchResult,
  KeywordIndexConfig,
  DEFAULT_KEYWORD_INDEX_CONFIG,
  KeywordIndexStats,
  DocumentMeta,
} from './types/hybridSearch';
import { KnowledgeEntry } from './knowledgeBase';

// ==================== 停用词列表 ====================

const CHINESE_STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '什么', '怎么', '如何', '为什么', '哪', '哪个', '哪些',
  '可以', '能', '能够', '应该', '需要', '想', '想要', '请', '请问', '吗', '呢',
]);

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we',
  'what', 'which', 'who', 'when', 'where', 'why', 'how',
]);

// ==================== 索引数据结构 ====================

/**
 * 倒排索引项
 */
interface InvertedIndexItem {
  /** 文档 ID -> 词频 */
  docs: Map<string, number>;
  /** 文档频率 */
  df: number;
}

/**
 * 持久化格式
 */
interface PersistedIndex {
  version: number;
  invertedIndex: Array<[string, { docs: Array<[string, number]>; df: number }]>;
  documentMetas: Array<[string, {
    id: string;
    length: number;
    termFrequencies: Array<[string, number]>;
    fieldSources: Array<[string, string]>;
  }]>;
  avgDocLength: number;
  lastUpdated: number;
}

/**
 * KeywordIndexManager 关键词索引管理器类
 */
export class KeywordIndexManager {
  private config: KeywordIndexConfig;
  
  // 倒排索引: term -> { docs: Map<docId, tf>, df: number }
  private invertedIndex: Map<string, InvertedIndexItem> = new Map();
  
  // 文档元信息: docId -> DocumentMeta
  private documentMetas: Map<string, DocumentMeta> = new Map();
  
  // BM25 参数
  private avgDocLength: number = 0;
  
  // 状态
  private initialized: boolean = false;
  private lastUpdated: number = 0;

  constructor(config?: Partial<KeywordIndexConfig>) {
    this.config = { ...DEFAULT_KEYWORD_INDEX_CONFIG, ...config };
    logger.info('KeywordIndexManager created', { config: this.config });
  }

  /**
   * 初始化索引
   * Requirements: 2.5
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('KeywordIndexManager already initialized');
      return;
    }

    try {
      // 确保持久化目录存在
      await fs.mkdir(this.config.persistPath, { recursive: true });

      // 尝试加载现有索引
      await this.load();

      this.initialized = true;
      logger.info('KeywordIndexManager initialized', {
        entryCount: this.documentMetas.size,
        keywordCount: this.invertedIndex.size,
      });
    } catch (error) {
      logger.warn('Failed to load existing index, starting fresh', { error });
      this.initialized = true;
    }
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('KeywordIndexManager not initialized. Call initialize() first.');
    }
  }

  // ==================== 索引 CRUD 操作 ====================

  /**
   * 添加条目到索引
   * Requirements: 2.1, 2.2, 2.4
   * 
   * @param entryId 条目 ID
   * @param fields 要索引的字段
   */
  addEntry(entryId: string, fields: Record<string, string | string[]>): void {
    this.ensureInitialized();

    // 如果已存在，先删除
    if (this.documentMetas.has(entryId)) {
      this.removeEntry(entryId);
    }

    // 分词并建立索引
    const termFrequencies = new Map<string, number>();
    const fieldSources = new Map<string, string>();
    let totalTerms = 0;

    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      const values = Array.isArray(fieldValue) ? fieldValue : [fieldValue];
      
      for (const value of values) {
        if (!value) continue;
        
        const terms = this.tokenize(value);
        totalTerms += terms.length;

        for (const term of terms) {
          const currentFreq = termFrequencies.get(term) || 0;
          termFrequencies.set(term, currentFreq + 1);
          
          // 记录字段来源（只记录第一次出现的字段）
          if (!fieldSources.has(term)) {
            fieldSources.set(term, fieldName);
          }
        }
      }
    }

    // 更新倒排索引
    for (const [term, freq] of termFrequencies) {
      let indexItem = this.invertedIndex.get(term);
      if (!indexItem) {
        indexItem = { docs: new Map(), df: 0 };
        this.invertedIndex.set(term, indexItem);
      }
      
      indexItem.docs.set(entryId, freq);
      indexItem.df = indexItem.docs.size;
    }

    // 保存文档元信息
    this.documentMetas.set(entryId, {
      id: entryId,
      length: totalTerms,
      termFrequencies,
      fieldSources,
    });

    // 更新平均文档长度
    this.updateAvgDocLength();
    this.lastUpdated = Date.now();

    logger.debug('Added entry to keyword index', {
      entryId,
      termsCount: termFrequencies.size,
      docLength: totalTerms,
    });
  }

  /**
   * 从索引删除条目
   * Requirements: 2.4
   * 
   * @param entryId 条目 ID
   */
  removeEntry(entryId: string): void {
    this.ensureInitialized();

    const docMeta = this.documentMetas.get(entryId);
    if (!docMeta) {
      return;
    }

    // 从倒排索引中删除
    for (const term of docMeta.termFrequencies.keys()) {
      const indexItem = this.invertedIndex.get(term);
      if (indexItem) {
        indexItem.docs.delete(entryId);
        indexItem.df = indexItem.docs.size;
        
        // 如果没有文档包含该词，删除该词
        if (indexItem.docs.size === 0) {
          this.invertedIndex.delete(term);
        }
      }
    }

    // 删除文档元信息
    this.documentMetas.delete(entryId);

    // 更新平均文档长度
    this.updateAvgDocLength();
    this.lastUpdated = Date.now();

    logger.debug('Removed entry from keyword index', { entryId });
  }

  /**
   * 更新索引条目
   * Requirements: 2.4
   * 
   * @param entryId 条目 ID
   * @param fields 要索引的字段
   */
  updateEntry(entryId: string, fields: Record<string, string | string[]>): void {
    // 更新 = 删除 + 添加
    this.removeEntry(entryId);
    this.addEntry(entryId, fields);
  }

  // ==================== BM25 搜索 ====================

  /**
   * 关键词搜索
   * Requirements: 2.2, 2.3, 2.6
   * 
   * @param query 查询字符串
   * @param limit 返回数量限制
   * @returns 搜索结果
   */
  search(query: string, limit: number = 10): KeywordSearchResult[] {
    this.ensureInitialized();

    const startTime = Date.now();

    // 分词
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return [];
    }

    // 计算每个文档的 BM25 分数
    const scores = new Map<string, {
      score: number;
      matchedKeywords: string[];
      matchedFields: Set<string>;
    }>();

    const N = this.documentMetas.size; // 总文档数
    const k1 = this.config.bm25K1;
    const b = this.config.bm25B;
    const avgdl = this.avgDocLength || 1;

    for (const term of queryTerms) {
      // 获取包含该词的文档
      let matchingDocs: Map<string, number>;
      let df: number;

      const indexItem = this.invertedIndex.get(term);
      if (indexItem) {
        matchingDocs = indexItem.docs;
        df = indexItem.df;
      } else if (this.config.enableFuzzyMatch) {
        // 模糊匹配
        const fuzzyResult = this.fuzzyMatch(term);
        if (fuzzyResult) {
          matchingDocs = fuzzyResult.docs;
          df = fuzzyResult.df;
        } else {
          continue;
        }
      } else {
        continue;
      }

      // 计算 IDF
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      // 计算每个文档的 BM25 分数
      for (const [docId, tf] of matchingDocs) {
        const docMeta = this.documentMetas.get(docId);
        if (!docMeta) continue;

        const dl = docMeta.length;
        
        // BM25 公式
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
        const termScore = idf * tfNorm;

        // 累加分数
        let docScore = scores.get(docId);
        if (!docScore) {
          docScore = { score: 0, matchedKeywords: [], matchedFields: new Set() };
          scores.set(docId, docScore);
        }
        
        docScore.score += termScore;
        docScore.matchedKeywords.push(term);
        
        const fieldSource = docMeta.fieldSources.get(term);
        if (fieldSource) {
          docScore.matchedFields.add(fieldSource);
        }
      }
    }

    // 排序并返回结果
    const results: KeywordSearchResult[] = Array.from(scores.entries())
      .map(([entryId, data]) => ({
        entryId,
        score: data.score,
        matchedKeywords: [...new Set(data.matchedKeywords)],
        matchedFields: Array.from(data.matchedFields),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const searchTime = Date.now() - startTime;
    logger.debug('Keyword search completed', {
      query,
      termsCount: queryTerms.length,
      resultsCount: results.length,
      searchTime,
    });

    return results;
  }

  /**
   * 模糊匹配
   * Requirements: 2.3
   */
  private fuzzyMatch(term: string): InvertedIndexItem | null {
    const maxDistance = this.config.maxEditDistance;
    let bestMatch: { term: string; item: InvertedIndexItem; distance: number } | null = null;

    for (const [indexTerm, item] of this.invertedIndex) {
      // 快速过滤：长度差异过大的跳过
      if (Math.abs(indexTerm.length - term.length) > maxDistance) {
        continue;
      }

      const distance = this.levenshteinDistance(term, indexTerm);
      if (distance <= maxDistance) {
        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = { term: indexTerm, item, distance };
        }
      }
    }

    return bestMatch?.item || null;
  }

  /**
   * 计算编辑距离（Levenshtein Distance）
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;

    // 优化：如果其中一个为空
    if (m === 0) return n;
    if (n === 0) return m;

    // 使用一维数组优化空间
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // 删除
          curr[j - 1] + 1,  // 插入
          prev[j - 1] + cost // 替换
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }

  // ==================== 分词 ====================

  /**
   * 分词
   * Requirements: 2.2
   */
  private tokenize(text: string): string[] {
    const tokens: string[] = [];

    // 中文分词（简单实现：按字符和常见词组分割）
    const chinesePattern = /[\u4e00-\u9fa5]{1,}/g;
    const chineseMatches = text.match(chinesePattern) || [];
    
    for (const match of chineseMatches) {
      // 对于长词，尝试分割成 2-4 字的词组
      if (match.length > 4) {
        for (let len = 2; len <= 4; len++) {
          for (let i = 0; i <= match.length - len; i++) {
            const subword = match.substring(i, i + len);
            if (!CHINESE_STOP_WORDS.has(subword)) {
              tokens.push(subword);
            }
          }
        }
      } else if (!CHINESE_STOP_WORDS.has(match)) {
        tokens.push(match);
      }
    }

    // 英文分词
    const englishPattern = /[a-zA-Z][a-zA-Z0-9_-]*/g;
    const englishMatches = text.match(englishPattern) || [];
    
    for (const match of englishMatches) {
      const lower = match.toLowerCase();
      if (!ENGLISH_STOP_WORDS.has(lower) && match.length >= this.config.minKeywordLength) {
        tokens.push(lower);
      }
    }

    // 提取数字+单位组合
    const numericPattern = /\d+(?:\.\d+)?(?:Mbps|Gbps|KB|MB|GB|TB|ms|s|%|MHz|GHz)?/gi;
    const numericMatches = text.match(numericPattern) || [];
    tokens.push(...numericMatches.map(m => m.toLowerCase()));

    return tokens;
  }

  // ==================== 持久化 ====================

  /**
   * 持久化索引到磁盘
   * Requirements: 2.5
   */
  async persist(): Promise<void> {
    this.ensureInitialized();

    const indexPath = path.join(this.config.persistPath, 'keyword-index.json');

    // 转换为可序列化格式
    const persistedData: PersistedIndex = {
      version: 1,
      invertedIndex: Array.from(this.invertedIndex.entries()).map(([term, item]) => [
        term,
        {
          docs: Array.from(item.docs.entries()),
          df: item.df,
        },
      ]),
      documentMetas: Array.from(this.documentMetas.entries()).map(([id, meta]) => [
        id,
        {
          id: meta.id,
          length: meta.length,
          termFrequencies: Array.from(meta.termFrequencies.entries()),
          fieldSources: Array.from(meta.fieldSources.entries()),
        },
      ]),
      avgDocLength: this.avgDocLength,
      lastUpdated: this.lastUpdated,
    };

    await fs.writeFile(indexPath, JSON.stringify(persistedData), 'utf-8');

    logger.info('Keyword index persisted', {
      path: indexPath,
      entryCount: this.documentMetas.size,
      keywordCount: this.invertedIndex.size,
    });
  }

  /**
   * 从磁盘加载索引
   * Requirements: 2.5
   */
  async load(): Promise<void> {
    const indexPath = path.join(this.config.persistPath, 'keyword-index.json');

    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      const persistedData: PersistedIndex = JSON.parse(data);

      // 恢复倒排索引
      this.invertedIndex.clear();
      for (const [term, item] of persistedData.invertedIndex) {
        this.invertedIndex.set(term, {
          docs: new Map(item.docs),
          df: item.df,
        });
      }

      // 恢复文档元信息
      this.documentMetas.clear();
      for (const [id, meta] of persistedData.documentMetas) {
        this.documentMetas.set(id, {
          id: meta.id,
          length: meta.length,
          termFrequencies: new Map(meta.termFrequencies),
          fieldSources: new Map(meta.fieldSources),
        });
      }

      this.avgDocLength = persistedData.avgDocLength;
      this.lastUpdated = persistedData.lastUpdated;

      logger.info('Keyword index loaded', {
        entryCount: this.documentMetas.size,
        keywordCount: this.invertedIndex.size,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No existing keyword index found');
      } else {
        throw error;
      }
    }
  }

  /**
   * 重建索引
   * Requirements: 2.4, 7.4
   * 
   * @param entries 知识条目列表
   */
  async rebuild(entries: KnowledgeEntry[]): Promise<void> {
    this.ensureInitialized();

    logger.info('Rebuilding keyword index', { entriesCount: entries.length });

    // 清空现有索引
    this.invertedIndex.clear();
    this.documentMetas.clear();
    this.avgDocLength = 0;

    // 重新索引所有条目
    for (const entry of entries) {
      this.addEntry(entry.id, this.extractIndexableFields(entry));
    }

    // 持久化
    await this.persist();

    logger.info('Keyword index rebuilt', {
      entryCount: this.documentMetas.size,
      keywordCount: this.invertedIndex.size,
    });
  }

  /**
   * 从知识条目提取可索引字段
   */
  private extractIndexableFields(entry: KnowledgeEntry): Record<string, string | string[]> {
    return {
      title: entry.title,
      content: entry.content,
      tags: entry.metadata.tags || [],
      autoKeywords: entry.metadata.autoKeywords || [],
      questionExamples: entry.metadata.questionExamples || [],
    };
  }

  // ==================== 统计 ====================

  /**
   * 获取索引统计
   * Requirements: 6.5
   */
  getStats(): KeywordIndexStats {
    // 估算内存使用
    let memoryUsage = 0;
    
    // 倒排索引内存
    for (const [term, item] of this.invertedIndex) {
      memoryUsage += term.length * 2; // 字符串
      memoryUsage += item.docs.size * 16; // Map 条目
    }
    
    // 文档元信息内存
    for (const [, meta] of this.documentMetas) {
      memoryUsage += meta.termFrequencies.size * 16;
      memoryUsage += meta.fieldSources.size * 32;
    }

    return {
      entryCount: this.documentMetas.size,
      keywordCount: this.invertedIndex.size,
      memoryUsage,
      avgDocLength: this.avgDocLength,
      lastUpdated: this.lastUpdated,
    };
  }

  /**
   * 更新平均文档长度
   */
  private updateAvgDocLength(): void {
    if (this.documentMetas.size === 0) {
      this.avgDocLength = 0;
      return;
    }

    let totalLength = 0;
    for (const meta of this.documentMetas.values()) {
      totalLength += meta.length;
    }
    this.avgDocLength = totalLength / this.documentMetas.size;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取配置
   */
  getConfig(): KeywordIndexConfig {
    return { ...this.config };
  }

  /**
   * 检查条目是否已索引
   */
  hasEntry(entryId: string): boolean {
    return this.documentMetas.has(entryId);
  }
}

// 导出单例实例
export const keywordIndexManager = new KeywordIndexManager();
