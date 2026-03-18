/**
 * RelevanceScorer - 基于相关性的对话历史筛选模块
 * 
 * 使用轻量级文本相似度算法（关键词重叠 + TF-IDF 余弦相似度）
 * 对历史消息评分，选取与当前用户意图最相关的消息子集。
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2
 */

import type { ChatMessage } from '../../types/ai';

export interface ScoredMessage {
  message: ChatMessage;
  score: number;         // 0.0 - 1.0
  originalIndex: number; // 原始位置，用于恢复时序
}

export interface RelevanceScorerConfig {
  recentKeepCount: number;      // 始终保留的最近消息数，默认 3
  minHistoryForScoring: number; // 触发评分的最小历史长度，默认 10
}

const DEFAULT_CONFIG: RelevanceScorerConfig = {
  recentKeepCount: 3,
  minHistoryForScoring: 10,
};

/**
 * 中文 + 英文分词：按空格、标点、中文字符边界拆分
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  // 将中文字符单独拆出，英文按空格/标点分割
  const tokens: string[] = [];
  // 先用正则拆分：中文字符单独成 token，英文单词保持完整
  const parts = text.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9]+/g);
  if (parts) {
    tokens.push(...parts);
  }
  return tokens;
}

/**
 * 提取关键词集合（去除常见停用词）
 * Fix: 允许单个 CJK 字符作为关键词（排除停用词中的常见单字）
 */
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'shall',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'and', 'or', 'but', 'not', 'this', 'that', 'it', 'i', 'you',
  ]);
  const tokens = tokenize(text);
  const keywords = new Set<string>();
  for (const token of tokens) {
    if (stopWords.has(token)) continue;
    // 允许单个 CJK 字符（非停用词），英文仍要求 length > 1
    const isCJK = token.length === 1 && /[\u4e00-\u9fff]/.test(token);
    if (isCJK || token.length > 1) {
      keywords.add(token);
    }
  }
  return keywords;
}

export class RelevanceScorer {
  private config: RelevanceScorerConfig;

  constructor(config?: Partial<RelevanceScorerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 计算关键词重叠度 (Jaccard similarity)
   */
  calculateKeywordOverlap(text1: string, text2: string): number {
    const kw1 = extractKeywords(text1);
    const kw2 = extractKeywords(text2);
    if (kw1.size === 0 || kw2.size === 0) return 0;

    let intersection = 0;
    for (const w of kw1) {
      if (kw2.has(w)) intersection++;
    }
    const union = new Set([...kw1, ...kw2]).size;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * 构建 TF-IDF 词频向量
   */
  buildTfIdfVector(text: string, idfMap: Map<string, number>): Map<string, number> {
    const tokens = tokenize(text);
    if (tokens.length === 0) return new Map();

    // 计算 TF
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // TF-IDF = TF * IDF
    const tfidf = new Map<string, number>();
    for (const [term, count] of tf) {
      const idf = idfMap.get(term) || 0;
      tfidf.set(term, (count / tokens.length) * idf);
    }
    return tfidf;
  }

  /**
   * 计算两个向量的余弦相似度
   */
  private cosineSimilarity(v1: Map<string, number>, v2: Map<string, number>): number {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (const [term, val] of v1) {
      norm1 += val * val;
      const val2 = v2.get(term);
      if (val2 !== undefined) {
        dotProduct += val * val2;
      }
    }
    for (const [, val] of v2) {
      norm2 += val * val;
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * 计算单条消息与当前消息的相关性分数
   * 综合关键词重叠 (40%) 和 TF-IDF 余弦相似度 (60%)
   * Fix: 缓存 tokenize 结果，避免重复分词
   */
  scoreMessage(currentMessage: string, historyMessage: ChatMessage, cachedCurrentTokens?: string[]): number {
    try {
      const content = historyMessage.content || '';
      if (!content || !currentMessage) return 0;

      const keywordScore = this.calculateKeywordOverlap(currentMessage, content);

      // 使用缓存的 currentMessage tokens，避免重复分词
      const currentTokens = cachedCurrentTokens || tokenize(currentMessage);
      const contentTokens = tokenize(content);

      // 构建简单的 IDF（基于两个文档）
      const allTokens = new Set([...currentTokens, ...contentTokens]);
      const idfMap = new Map<string, number>();
      for (const token of allTokens) {
        const inCurrent = currentTokens.includes(token) ? 1 : 0;
        const inHistory = contentTokens.includes(token) ? 1 : 0;
        const docFreq = inCurrent + inHistory;
        idfMap.set(token, Math.log(2 / docFreq + 1));
      }

      const v1 = this.buildTfIdfVector(currentMessage, idfMap);
      const v2 = this.buildTfIdfVector(content, idfMap);
      const tfidfScore = this.cosineSimilarity(v1, v2);

      // 综合分数：关键词重叠 40% + TF-IDF 60%
      const score = keywordScore * 0.4 + tfidfScore * 0.6;
      return Math.max(0, Math.min(1, score));
    } catch {
      return 0;
    }
  }

  /**
   * 对历史消息评分并筛选
   * 
   * - 历史长度 <= minHistoryForScoring 时直接返回全部
   * - 始终保留最近 recentKeepCount 条消息
   * - 选取 topN 条最高分消息，保留 user-assistant 配对
   * - 按原始时序排序输出
   * Fix: 配对后如果超出 topN，截断最低分的非最近消息
   */
  selectRelevant(
    currentMessage: string,
    history: ChatMessage[],
    topN: number
  ): ChatMessage[] {
    // 边界情况处理
    if (!history || history.length === 0) return [];
    if (topN <= 0) return [];
    if (topN >= history.length) return [...history];
    if (history.length <= this.config.minHistoryForScoring) return [...history];

    const { recentKeepCount } = this.config;

    // 缓存 currentMessage 的 tokenize 结果，避免对每条消息重复分词
    const cachedCurrentTokens = tokenize(currentMessage);

    // 对每条消息评分
    const scored: ScoredMessage[] = history.map((msg, idx) => ({
      message: msg,
      score: this.scoreMessage(currentMessage, msg, cachedCurrentTokens),
      originalIndex: idx,
    }));

    // 标记必须保留的最近消息索引
    const recentStartIdx = Math.max(0, history.length - recentKeepCount);
    const recentIndices = new Set<number>();
    for (let i = recentStartIdx; i < history.length; i++) {
      recentIndices.add(i);
    }

    // 从非最近消息中按分数排序，选取 topN - recentKeepCount 条
    const effectiveRecentCount = Math.min(recentKeepCount, history.length);
    const remainingSlots = Math.max(0, topN - effectiveRecentCount);

    const nonRecent = scored
      .filter(s => !recentIndices.has(s.originalIndex))
      .sort((a, b) => b.score - a.score)
      .slice(0, remainingSlots);

    // 合并选中的索引
    const selectedIndices = new Set<number>([
      ...recentIndices,
      ...nonRecent.map(s => s.originalIndex),
    ]);

    // User-Assistant 配对保留：选中 user 消息时，紧随其后的 assistant 也保留
    const pairedIndices = new Set<number>(selectedIndices);
    for (const idx of selectedIndices) {
      if (history[idx].role === 'user' && idx + 1 < history.length && history[idx + 1].role === 'assistant') {
        pairedIndices.add(idx + 1);
      }
    }

    // Fix: 配对后如果超出 topN，移除最低分的非最近、非配对必需消息
    if (pairedIndices.size > topN) {
      // 构建可移除候选：非最近消息中分数最低的
      const removable = scored
        .filter(s => pairedIndices.has(s.originalIndex) && !recentIndices.has(s.originalIndex))
        .sort((a, b) => a.score - b.score); // 升序，最低分在前

      let excess = pairedIndices.size - topN;
      for (const candidate of removable) {
        if (excess <= 0) break;
        // 如果移除此消息会破坏配对（它是某个 user 的 assistant 回复），跳过
        const prevIdx = candidate.originalIndex - 1;
        const isPairedAssistant = prevIdx >= 0 &&
          history[candidate.originalIndex].role === 'assistant' &&
          history[prevIdx].role === 'user' &&
          selectedIndices.has(prevIdx);
        if (isPairedAssistant) continue;

        pairedIndices.delete(candidate.originalIndex);
        excess--;
      }
    }

    // 按原始时序排序输出
    const result = Array.from(pairedIndices)
      .sort((a, b) => a - b)
      .map(idx => history[idx]);

    return result;
  }
}
