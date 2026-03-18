/**
 * KnowledgeFormatter - 知识格式化器
 * 
 * 将知识条目格式化为结构化格式，供 LLM 使用
 * 
 * Requirements: 5.1, 5.3, 5.4, 6.1, 6.2, 6.5, 14.1, 14.2, 14.3, 14.4
 * - 5.1: 提取完整内容而非截断摘要
 * - 5.3: 同时提取所有元数据
 * - 5.4: 保持代码格式完整性
 * - 6.1: 使用统一的结构化格式
 * - 6.2: 为每条知识分配唯一的引用 ID
 * - 6.5: 在知识末尾添加引用提示
 * - 14.1-14.4: 引用 ID 格式规范
 */

import { logger } from '../../../utils/logger';
import { KnowledgeEntry } from './knowledgeBase';
import { CredibilityCalculator, credibilityCalculator } from './credibilityCalculator';
import { ScoredKnowledgeEntry, CredibilityLevel } from './types/credibility';
import {
  FormattedKnowledge,
  KnowledgeType,
} from './types/intelligentRetrieval';
import {
  KnowledgeFormatterConfig,
  DEFAULT_FORMATTER_CONFIG,
  VALID_REFERENCE_TYPES,
  ContentSegment,
  SmartSegmentResult,
} from './types/formatting';

// 用于生成唯一短 ID 的字符集
const SHORT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * 有界 ID 缓存类
 * 用于存储已生成的引用 ID，防止内存泄漏
 * 当缓存达到阈值时自动清理最旧的条目
 */
class BoundedIdCache {
  private cache: Map<string, number>;
  private maxSize: number;
  private cleanupThreshold: number;
  private cleanupCount: number = 0;

  constructor(maxSize: number = 10000, cleanupThreshold: number = 0.9) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.cleanupThreshold = Math.floor(maxSize * cleanupThreshold);
  }

  /**
   * 检查 ID 是否存在
   */
  has(id: string): boolean {
    return this.cache.has(id);
  }

  /**
   * 添加 ID 到缓存
   */
  add(id: string): void {
    if (this.cache.size >= this.cleanupThreshold) {
      this.cleanup();
    }
    this.cache.set(id, Date.now());
  }

  /**
   * 清理最旧的一半条目
   */
  private cleanup(): void {
    const targetSize = Math.floor(this.maxSize / 2);
    const entries = Array.from(this.cache.entries());
    
    // Map 保持插入顺序，所以前面的是最旧的
    const toRemove = entries.length - targetSize;
    if (toRemove > 0) {
      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(entries[i][0]);
      }
      this.cleanupCount++;
      logger.debug('BoundedIdCache cleanup performed', {
        removedCount: toRemove,
        remainingSize: this.cache.size,
        totalCleanups: this.cleanupCount,
      });
    }
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    logger.debug('BoundedIdCache cleared');
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { size: number; maxSize: number; cleanupCount: number; threshold: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      cleanupCount: this.cleanupCount,
      threshold: this.cleanupThreshold,
    };
  }
}

// 已生成的引用 ID 缓存（使用有界缓存防止内存泄漏）
let generatedIdsCache: BoundedIdCache | null = null;

/**
 * 获取或创建 ID 缓存实例
 */
function getGeneratedIdsCache(maxSize: number = 10000, threshold: number = 0.9): BoundedIdCache {
  if (!generatedIdsCache) {
    generatedIdsCache = new BoundedIdCache(maxSize, threshold);
  }
  return generatedIdsCache;
}

/**
 * 知识格式化器类
 */
export class KnowledgeFormatter {
  private config: KnowledgeFormatterConfig;
  private credibilityCalculator: CredibilityCalculator;
  private idCache: BoundedIdCache;

  constructor(
    config?: Partial<KnowledgeFormatterConfig>,
    credCalc?: CredibilityCalculator
  ) {
    this.config = { ...DEFAULT_FORMATTER_CONFIG, ...config };
    this.credibilityCalculator = credCalc || credibilityCalculator;
    this.idCache = getGeneratedIdsCache(
      this.config.maxCachedIds,
      this.config.cacheCleanupThreshold
    );
    logger.debug('KnowledgeFormatter created', { config: this.config });
  }

  /**
   * 格式化单个知识条目
   * Requirements: 5.1, 6.1, 6.2, 6.5
   * 
   * @param entry 知识条目
   * @returns 格式化后的知识
   */
  format(entry: KnowledgeEntry): FormattedKnowledge {
    // 计算可信度
    const credibilityScore = this.credibilityCalculator.calculate(entry);
    const credibilityLevel = this.credibilityCalculator.getCredibilityLevel(credibilityScore);

    // 生成引用 ID
    const referenceId = this.generateReferenceId(entry);

    // 提取完整内容
    const fullContent = this.extractFullContent(entry);

    // 生成摘要
    const summary = this.generateSummary(entry.content);

    // 生成引用提示
    const citationHint = this.generateCitationHint(referenceId, entry.type);

    // 处理关联引用
    const relatedReferences = this.processRelatedIds(entry.metadata.relatedIds);

    return {
      referenceId,
      entryId: entry.id,
      title: entry.title,
      type: entry.type as KnowledgeType,
      credibilityScore,
      credibilityLevel,
      fullContent,
      content: fullContent, // content 是 fullContent 的别名
      summary,
      metadata: entry.metadata,
      relatedReferences,
      citationHint,
    };
  }

  /**
   * 批量格式化
   * Requirements: 6.3 - 按可信度降序排列
   * 
   * @param entries 知识条目列表（可以是普通条目或带评分的条目）
   * @returns 格式化后的知识列表（按可信度降序）
   */
  formatBatch(entries: (KnowledgeEntry | ScoredKnowledgeEntry)[]): FormattedKnowledge[] {
    const formatted = entries.map(entry => this.format(entry));
    
    // 按可信度降序排列
    return formatted.sort((a, b) => b.credibilityScore - a.credibilityScore);
  }

  /**
   * 生成引用 ID
   * Requirements: 6.2, 14.1, 14.2, 14.3, 14.4
   * 
   * 格式: KB-{type}-{shortId}
   * - type: 小写字母
   * - shortId: 8位字母数字组合
   * 
   * @param entry 知识条目
   * @returns 引用 ID
   */
  generateReferenceId(entry: KnowledgeEntry): string {
    // 确保类型是有效的小写字母
    const type = this.normalizeType(entry.type);
    
    // 生成唯一的短 ID
    const shortId = this.generateUniqueShortId(entry.id);
    
    return `KB-${type}-${shortId}`;
  }

  /**
   * 从引用 ID 解析组成部分
   * Requirements: 14.5
   * 
   * @param referenceId 引用 ID
   * @returns 解析结果，如果格式无效返回 null
   */
  parseReferenceId(referenceId: string): { type: string; shortId: string } | null {
    const match = referenceId.match(/^KB-([a-z]+)-([a-zA-Z0-9]{8})$/);
    if (!match) {
      return null;
    }
    return {
      type: match[1],
      shortId: match[2],
    };
  }

  /**
   * 验证引用 ID 格式
   * Requirements: 14.1, 14.2, 14.3
   */
  isValidReferenceId(referenceId: string): boolean {
    return /^KB-[a-z]+-[a-zA-Z0-9]{8}$/.test(referenceId);
  }

  /**
   * 提取完整内容
   * Requirements: 5.1, 5.4
   * 
   * @param entry 知识条目
   * @param maxTokens 最大 token 数（可选）
   * @returns 完整或智能分段的内容
   */
  extractFullContent(entry: KnowledgeEntry, maxTokens?: number): string {
    const content = entry.content;
    const limit = maxTokens || this.config.maxContentTokens;

    // 估算 token 数（简单估算：中文约 1 字符 = 1 token，英文约 4 字符 = 1 token）
    const estimatedTokens = this.estimateTokens(content);

    if (estimatedTokens <= limit) {
      // 内容在限制内，返回完整内容
      return content;
    }

    // 需要智能分段
    const segmentResult = this.smartSegment(content, limit);
    
    if (segmentResult.hasTruncation) {
      logger.debug('Content truncated for entry', {
        entryId: entry.id,
        originalTokens: estimatedTokens,
        limit,
      });
    }

    // 合并分段，保留关键信息
    return this.mergeSegments(segmentResult);
  }

  /**
   * 智能分段
   * Requirements: 5.2, 5.4
   * 
   * @param content 原始内容
   * @param maxTokens 最大 token 数
   * @returns 分段结果
   */
  smartSegment(content: string, maxTokens: number): SmartSegmentResult {
    const segments: ContentSegment[] = [];
    const preservedKeyInfo: string[] = [];
    let hasTruncation = false;

    // 识别代码块
    const codeBlockPattern = /```[\s\S]*?```/g;
    const codeBlocks: { start: number; end: number; content: string }[] = [];
    let match;
    
    while ((match = codeBlockPattern.exec(content)) !== null) {
      codeBlocks.push({
        start: match.index,
        end: match.index + match[0].length,
        content: match[0],
      });
    }

    // 分割内容，保留代码块完整性
    let currentPos = 0;
    let segmentIndex = 0;
    let totalTokens = 0;

    for (const block of codeBlocks) {
      // 处理代码块之前的文本
      if (block.start > currentPos) {
        const textBefore = content.substring(currentPos, block.start);
        const textTokens = this.estimateTokens(textBefore);
        
        if (totalTokens + textTokens <= maxTokens) {
          segments.push({
            content: textBefore,
            index: segmentIndex++,
            isCodeBlock: false,
            isTruncated: false,
          });
          totalTokens += textTokens;
        } else {
          // 需要截断文本
          const remainingTokens = maxTokens - totalTokens;
          const truncatedText = this.truncateToTokens(textBefore, remainingTokens);
          segments.push({
            content: truncatedText,
            index: segmentIndex++,
            isCodeBlock: false,
            isTruncated: true,
          });
          hasTruncation = true;
          totalTokens = maxTokens;
          break;
        }
      }

      // 处理代码块（保持完整性）
      const blockTokens = this.estimateTokens(block.content);
      if (totalTokens + blockTokens <= maxTokens) {
        segments.push({
          content: block.content,
          index: segmentIndex++,
          isCodeBlock: true,
          isTruncated: false,
        });
        totalTokens += blockTokens;
        preservedKeyInfo.push('代码块已保留');
      } else if (this.config.preserveCodeBlocks && blockTokens <= maxTokens * 0.5) {
        // 代码块较小，优先保留
        segments.push({
          content: block.content,
          index: segmentIndex++,
          isCodeBlock: true,
          isTruncated: false,
        });
        totalTokens += blockTokens;
        preservedKeyInfo.push('代码块已优先保留');
      } else {
        hasTruncation = true;
        preservedKeyInfo.push('代码块因长度限制被省略');
      }

      currentPos = block.end;
    }

    // 处理最后一段文本
    if (currentPos < content.length && totalTokens < maxTokens) {
      const remainingText = content.substring(currentPos);
      const remainingTokens = this.estimateTokens(remainingText);
      
      if (totalTokens + remainingTokens <= maxTokens) {
        segments.push({
          content: remainingText,
          index: segmentIndex++,
          isCodeBlock: false,
          isTruncated: false,
        });
      } else {
        const availableTokens = maxTokens - totalTokens;
        const truncatedText = this.truncateToTokens(remainingText, availableTokens);
        segments.push({
          content: truncatedText,
          index: segmentIndex++,
          isCodeBlock: false,
          isTruncated: true,
        });
        hasTruncation = true;
      }
    }

    return {
      segments,
      totalSegments: segments.length,
      hasTruncation,
      preservedKeyInfo,
    };
  }

  // ==================== 私有方法 ====================

  /**
   * 规范化类型为小写字母
   * Requirements: 14.2
   */
  private normalizeType(type: string): string {
    const normalized = type.toLowerCase();
    if (VALID_REFERENCE_TYPES.includes(normalized as any)) {
      return normalized;
    }
    // 默认返回 'manual'
    return 'manual';
  }

  /**
   * 生成唯一的短 ID
   * Requirements: 14.3, 14.4
   */
  private generateUniqueShortId(entryId: string): string {
    // 首先尝试从 entryId 生成确定性的短 ID
    const hash = this.simpleHash(entryId);
    let shortId = this.hashToShortId(hash);
    
    // 确保唯一性
    let attempts = 0;
    while (this.idCache.has(shortId) && attempts < 100) {
      // 添加随机后缀
      shortId = this.hashToShortId(hash + attempts);
      attempts++;
    }
    
    this.idCache.add(shortId);
    return shortId;
  }

  /**
   * 简单哈希函数
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * 将哈希值转换为短 ID
   */
  private hashToShortId(hash: number): string {
    let result = '';
    let remaining = hash;
    
    for (let i = 0; i < this.config.shortIdLength; i++) {
      const index = remaining % SHORT_ID_CHARS.length;
      result += SHORT_ID_CHARS[index];
      remaining = Math.floor(remaining / SHORT_ID_CHARS.length);
      
      // 如果 remaining 为 0，使用随机值继续
      if (remaining === 0) {
        remaining = Math.floor(Math.random() * 1000000);
      }
    }
    
    return result;
  }

  /**
   * 生成摘要
   */
  private generateSummary(content: string): string {
    // 移除代码块
    const withoutCode = content.replace(/```[\s\S]*?```/g, '[代码块]');
    
    // 截取前 N 个字符
    if (withoutCode.length <= this.config.summaryMaxLength) {
      return withoutCode;
    }
    
    return withoutCode.substring(0, this.config.summaryMaxLength) + '...';
  }

  /**
   * 生成引用提示
   * Requirements: 6.5
   */
  private generateCitationHint(referenceId: string, type: string): string {
    return `引用此知识时请使用: [${referenceId}]`;
  }

  /**
   * 处理关联 ID
   */
  private processRelatedIds(relatedIds?: string[]): string[] | undefined {
    if (!relatedIds || relatedIds.length === 0) {
      return undefined;
    }
    // 这里可以将原始 ID 转换为引用 ID 格式
    // 目前简单返回原始 ID
    return relatedIds;
  }

  /**
   * 估算 token 数
   */
  private estimateTokens(text: string): number {
    // 简单估算：
    // - 中文字符约 1 token
    // - 英文单词约 1 token（平均 4 字符）
    // - 标点符号约 1 token
    
    let tokens = 0;
    const chinesePattern = /[\u4e00-\u9fa5]/g;
    const chineseChars = text.match(chinesePattern) || [];
    tokens += chineseChars.length;
    
    // 移除中文后计算英文
    const withoutChinese = text.replace(chinesePattern, ' ');
    const words = withoutChinese.split(/\s+/).filter(w => w.length > 0);
    tokens += words.length;
    
    return tokens;
  }

  /**
   * 截断文本到指定 token 数
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) {
      return '';
    }
    
    let tokens = 0;
    let endIndex = 0;
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      // 中文字符
      if (/[\u4e00-\u9fa5]/.test(char)) {
        tokens++;
      } else if (/\s/.test(char)) {
        // 空格不计入 token
      } else {
        // 英文字符，每 4 个约 1 token
        if (i % 4 === 0) {
          tokens++;
        }
      }
      
      if (tokens >= maxTokens) {
        endIndex = i;
        break;
      }
      endIndex = i;
    }
    
    return text.substring(0, endIndex + 1) + '...';
  }

  /**
   * 合并分段
   */
  private mergeSegments(result: SmartSegmentResult): string {
    const merged = result.segments.map(s => s.content).join('');
    
    if (result.hasTruncation) {
      return merged + '\n\n[内容已截断，完整内容请查看原始知识条目]';
    }
    
    return merged;
  }

  /**
   * 清除已生成的 ID 缓存（用于测试）
   */
  static clearGeneratedIds(): void {
    if (generatedIdsCache) {
      generatedIdsCache.clear();
    }
  }

  /**
   * 获取 ID 缓存统计信息（用于监控）
   */
  static getCacheStats(): { size: number; maxSize: number; cleanupCount: number; threshold: number } | null {
    if (generatedIdsCache) {
      return generatedIdsCache.getStats();
    }
    return null;
  }

  /**
   * 获取实例的 ID 缓存统计信息
   */
  getCacheStats(): { size: number; maxSize: number; cleanupCount: number; threshold: number } {
    return this.idCache.getStats();
  }
}

// 导出单例实例
export const knowledgeFormatter = new KnowledgeFormatter();
