/**
 * KnowledgeSummarizer - 知识内容智能摘要器
 * 
 * 负责对知识库检索结果进行智能摘要处理，确保在 Token 预算内最大化保留关键信息
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 * - 1.1: 使用 KnowledgeFormatter 对每个 citation 内容进行格式化
 * - 1.2: 按相关度（score）降序分配 Token 预算
 * - 1.3: 使用 smartSegment() 进行智能分段
 * - 1.4: 优先保留代码块完整性
 * - 1.5: 生成简洁的摘要标题，包含类型和相关度信息
 */

import { logger } from '../../utils/logger';
import { SummarizationError, SummarizationErrorCode } from '../../types/summarization';

// ==================== 接口定义 ====================

/**
 * RAG 引用接口（与 UnifiedAgentService 中的 RAGCitation 兼容）
 */
export interface RAGCitation {
  entryId: string;
  title: string;
  content: string;
  score: number;
  type: string;
}

/**
 * 摘要后的引用
 */
export interface SummarizedCitation {
  /** 原始 citation */
  original: RAGCitation;
  /** 摘要后的内容 */
  summarizedContent: string;
  /** 使用的 Token 数 */
  tokenCount: number;
  /** 是否被截断 */
  isTruncated: boolean;
  /** 原始 Token 数 */
  originalTokenCount: number;
  /** 摘要标题 */
  summaryTitle: string;
}

/**
 * 知识摘要器配置
 */
export interface KnowledgeSummarizerConfig {
  /** 是否启用智能摘要，默认 true */
  enabled: boolean;
  /** 是否保留代码块完整性，默认 true */
  preserveCodeBlocks: boolean;
  /** 单个 citation 最大 Token 数，默认 1000 */
  maxTokensPerCitation: number;
  /** 最小 Token 分配，默认 100 */
  minTokensPerCitation: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: KnowledgeSummarizerConfig = {
  enabled: true,
  preserveCodeBlocks: true,
  maxTokensPerCitation: 1000,
  minTokensPerCitation: 100,
};

// ==================== KnowledgeSummarizer 类 ====================

/**
 * 知识内容摘要器类
 */
export class KnowledgeSummarizer {
  private config: KnowledgeSummarizerConfig;

  constructor(config?: Partial<KnowledgeSummarizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('KnowledgeSummarizer created', { config: this.config });
  }

  /**
   * 摘要处理 citations 列表
   * Requirements: 1.1, 1.2, 1.3
   * 
   * @param citations 原始 citations 列表
   * @param totalBudget 总 Token 预算
   * @returns 摘要后的 citations 列表
   */
  summarize(citations: RAGCitation[], totalBudget: number): SummarizedCitation[] {
    if (!this.config.enabled) {
      // 禁用时返回简单截断的结果
      return citations.map(c => this.createSimpleSummarizedCitation(c, totalBudget / citations.length));
    }

    if (citations.length === 0) {
      return [];
    }

    try {
      // 1. 按相关度分配预算
      const budgetMap = this.allocateBudgetByRelevance(citations, totalBudget);
      
      // 2. 对每个 citation 进行摘要处理
      const results: SummarizedCitation[] = [];
      
      for (const citation of citations) {
        const budget = budgetMap.get(citation.entryId) || this.config.minTokensPerCitation;
        const summarized = this.formatCitation(citation, budget);
        results.push(summarized);
      }

      logger.info('Citations summarized', {
        count: citations.length,
        totalBudget,
        totalUsed: results.reduce((sum, r) => sum + r.tokenCount, 0),
        truncatedCount: results.filter(r => r.isTruncated).length,
      });

      return results;
    } catch (error) {
      logger.warn('KnowledgeSummarizer failed, using fallback', { error });
      // 回退到简单截断
      return citations.map(c => this.createSimpleSummarizedCitation(c, totalBudget / citations.length));
    }
  }

  /**
   * 按相关度分配预算
   * Requirement 1.2: 按相关度（score）降序分配 Token 预算
   * 
   * @param citations citations 列表
   * @param totalBudget 总预算
   * @returns entryId -> 预算 的映射
   */
  allocateBudgetByRelevance(
    citations: RAGCitation[],
    totalBudget: number
  ): Map<string, number> {
    const budgetMap = new Map<string, number>();
    
    if (citations.length === 0) {
      return budgetMap;
    }

    // 确保预算为正数
    if (totalBudget <= 0) {
      logger.warn('allocateBudgetByRelevance: invalid totalBudget', { totalBudget });
      for (const citation of citations) {
        budgetMap.set(citation.entryId, this.config.minTokensPerCitation);
      }
      return budgetMap;
    }

    // 计算总分数（只计算正数分数）
    const totalScore = citations.reduce((sum, c) => sum + Math.max(0, c.score), 0);
    
    if (totalScore <= 0) {
      // 如果没有有效分数，平均分配
      const avgBudget = Math.floor(totalBudget / citations.length);
      for (const citation of citations) {
        budgetMap.set(citation.entryId, Math.max(avgBudget, this.config.minTokensPerCitation));
      }
      return budgetMap;
    }

    // 按分数比例分配预算
    let allocatedBudget = 0;
    const sortedCitations = [...citations].sort((a, b) => b.score - a.score);
    
    for (let i = 0; i < sortedCitations.length; i++) {
      const citation = sortedCitations[i];
      const isLast = i === sortedCitations.length - 1;
      
      if (isLast) {
        // 最后一个获得剩余预算
        const remaining = totalBudget - allocatedBudget;
        budgetMap.set(citation.entryId, Math.max(remaining, this.config.minTokensPerCitation));
      } else {
        // 按比例分配，但不超过最大限制
        const ratio = citation.score / totalScore;
        let budget = Math.floor(totalBudget * ratio);
        
        // 应用限制
        budget = Math.max(budget, this.config.minTokensPerCitation);
        budget = Math.min(budget, this.config.maxTokensPerCitation);
        
        budgetMap.set(citation.entryId, budget);
        allocatedBudget += budget;
      }
    }

    return budgetMap;
  }

  /**
   * 格式化单个 citation
   * Requirements: 1.1, 1.3, 1.4
   * 
   * @param citation 原始 citation
   * @param budget Token 预算
   * @returns 摘要后的 citation
   */
  formatCitation(citation: RAGCitation, budget: number): SummarizedCitation {
    const originalTokenCount = this.estimateTokens(citation.content);
    const summaryTitle = this.generateTitle(citation);
    
    // 如果内容在预算内，直接返回
    if (originalTokenCount <= budget) {
      return {
        original: citation,
        summarizedContent: citation.content,
        tokenCount: originalTokenCount,
        isTruncated: false,
        originalTokenCount,
        summaryTitle,
      };
    }

    // 需要智能分段
    try {
      const summarizedContent = this.smartSegment(citation.content, budget);
      const tokenCount = this.estimateTokens(summarizedContent);
      
      return {
        original: citation,
        summarizedContent,
        tokenCount,
        isTruncated: true,
        originalTokenCount,
        summaryTitle,
      };
    } catch (error) {
      // 回退到简单截断
      logger.warn('Smart segment failed, using simple truncation', { 
        entryId: citation.entryId, 
        error 
      });
      return this.createSimpleSummarizedCitation(citation, budget);
    }
  }

  /**
   * 生成摘要标题
   * Requirement 1.5: 生成简洁的摘要标题，包含类型和相关度信息
   * 
   * @param citation 原始 citation
   * @returns 摘要标题
   */
  generateTitle(citation: RAGCitation): string {
    const typeLabel = this.getTypeLabel(citation.type);
    const scorePercent = (citation.score * 100).toFixed(1);
    return `[${typeLabel}] ${citation.title} (相关度: ${scorePercent}%)`;
  }

  /**
   * 智能分段
   * Requirements: 1.3, 1.4
   * 
   * @param content 原始内容
   * @param maxTokens 最大 Token 数
   * @returns 分段后的内容
   */
  private smartSegment(content: string, maxTokens: number): string {
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

    // 如果配置保留代码块且代码块较小，优先保留
    if (this.config.preserveCodeBlocks && codeBlocks.length > 0) {
      const totalCodeTokens = codeBlocks.reduce(
        (sum, block) => sum + this.estimateTokens(block.content), 
        0
      );
      
      // 如果代码块占比不超过 50%，优先保留
      if (totalCodeTokens <= maxTokens * 0.5) {
        return this.segmentWithCodeBlocks(content, codeBlocks, maxTokens);
      }
    }

    // 简单截断
    return this.truncateToTokens(content, maxTokens);
  }

  /**
   * 保留代码块的分段
   */
  private segmentWithCodeBlocks(
    content: string,
    codeBlocks: { start: number; end: number; content: string }[],
    maxTokens: number
  ): string {
    const segments: string[] = [];
    let totalTokens = 0;
    let currentPos = 0;

    for (const block of codeBlocks) {
      // 处理代码块之前的文本
      if (block.start > currentPos) {
        const textBefore = content.substring(currentPos, block.start);
        const textTokens = this.estimateTokens(textBefore);
        
        if (totalTokens + textTokens <= maxTokens) {
          segments.push(textBefore);
          totalTokens += textTokens;
        } else {
          // 截断文本
          const remainingTokens = maxTokens - totalTokens;
          if (remainingTokens > 0) {
            segments.push(this.truncateToTokens(textBefore, remainingTokens));
          }
          break;
        }
      }

      // 添加代码块
      const blockTokens = this.estimateTokens(block.content);
      if (totalTokens + blockTokens <= maxTokens) {
        segments.push(block.content);
        totalTokens += blockTokens;
      }

      currentPos = block.end;
    }

    // 处理最后一段文本
    if (currentPos < content.length && totalTokens < maxTokens) {
      const remainingText = content.substring(currentPos);
      const remainingTokens = maxTokens - totalTokens;
      segments.push(this.truncateToTokens(remainingText, remainingTokens));
    }

    const result = segments.join('');
    
    // 如果有截断，添加提示
    if (this.estimateTokens(content) > maxTokens) {
      return result + '\n\n[内容已截断]';
    }
    
    return result;
  }

  /**
   * 截断到指定 Token 数
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) {
      return '';
    }
    
    const currentTokens = this.estimateTokens(text);
    if (currentTokens <= maxTokens) {
      return text;
    }

    // 估算需要保留的字符数（粗略估算：1 token ≈ 2 字符）
    const ratio = maxTokens / currentTokens;
    const targetLength = Math.max(1, Math.floor(text.length * ratio * 0.9)); // 留 10% 余量，至少保留 1 字符
    
    return text.substring(0, targetLength) + '...';
  }

  /**
   * 估算 Token 数
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    
    // 简单估算：
    // - 中文字符约 1 token
    // - 英文单词约 1 token（平均 4 字符）
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
   * 获取类型标签
   */
  private getTypeLabel(type: string): string {
    const typeLabels: Record<string, string> = {
      manual: '手动',
      auto: '自动',
      alert: '告警',
      config: '配置',
      knowledge: '知识',
      faq: 'FAQ',
    };
    return typeLabels[type.toLowerCase()] || type;
  }

  /**
   * 创建简单摘要的 citation（回退方法）
   */
  private createSimpleSummarizedCitation(
    citation: RAGCitation,
    budget: number
  ): SummarizedCitation {
    const originalTokenCount = this.estimateTokens(citation.content);
    const summaryTitle = this.generateTitle(citation);
    
    if (originalTokenCount <= budget) {
      return {
        original: citation,
        summarizedContent: citation.content,
        tokenCount: originalTokenCount,
        isTruncated: false,
        originalTokenCount,
        summaryTitle,
      };
    }

    const summarizedContent = this.truncateToTokens(citation.content, budget);
    return {
      original: citation,
      summarizedContent,
      tokenCount: this.estimateTokens(summarizedContent),
      isTruncated: true,
      originalTokenCount,
      summaryTitle,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): KnowledgeSummarizerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<KnowledgeSummarizerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('KnowledgeSummarizer config updated', { config: this.config });
  }
}

// 导出单例实例
export const knowledgeSummarizer = new KnowledgeSummarizer();
