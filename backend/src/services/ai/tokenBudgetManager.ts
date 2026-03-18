/**
 * TokenBudgetManager - Token 预算管理器
 * 
 * 负责 Token 预算的分配和追踪，确保在上下文限制内最大化保留关键信息
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 * - 3.1: 从会话配置读取 maxContextTokens 作为总预算
 * - 3.2: 按比例分配预算（知识 60%，工具 25%，其他 15%）
 * - 3.3: 重新分配未使用的预算
 * - 3.4: 提供预算使用统计
 * - 3.5: 按优先级裁剪内容
 */

import { logger } from '../../utils/logger';
import { ChatMessage } from '../../types/ai';

// ==================== 接口定义 ====================

/**
 * 预算分配结果
 */
export interface BudgetAllocation {
  /** 知识内容预算 */
  knowledgeBudget: number;
  /** 工具输出预算 */
  toolsBudget: number;
  /** 系统提示词和历史消息预算 */
  otherBudget: number;
  /** 总预算 */
  totalBudget: number;
}

/**
 * 预算使用情况
 */
export interface BudgetUsage {
  /** 知识内容已用 Token */
  knowledgeUsed: number;
  /** 工具输出已用 Token */
  toolsUsed: number;
  /** 其他已用 Token */
  otherUsed: number;
  /** 总已用 Token */
  totalUsed: number;
  /** 剩余 Token */
  remaining: number;
}

/**
 * Token 预算管理器配置
 */
export interface TokenBudgetManagerConfig {
  /** 知识内容预算比例，默认 0.6 */
  knowledgeRatio: number;
  /** 工具输出预算比例，默认 0.25 */
  toolsRatio: number;
  /** 其他预算比例，默认 0.15 */
  otherRatio: number;
  /** 是否启用动态重分配，默认 true */
  enableRedistribution: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: TokenBudgetManagerConfig = {
  knowledgeRatio: 0.6,
  toolsRatio: 0.25,
  otherRatio: 0.15,
  enableRedistribution: true,
};

// ==================== TokenBudgetManager 类 ====================

/**
 * Token 预算管理器类
 */
export class TokenBudgetManager {
  private config: TokenBudgetManagerConfig;

  constructor(config?: Partial<TokenBudgetManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 验证比例总和
    const totalRatio = this.config.knowledgeRatio + this.config.toolsRatio + this.config.otherRatio;
    if (Math.abs(totalRatio - 1.0) > 0.001) {
      logger.warn('TokenBudgetManager: ratios do not sum to 1.0, normalizing', {
        knowledgeRatio: this.config.knowledgeRatio,
        toolsRatio: this.config.toolsRatio,
        otherRatio: this.config.otherRatio,
        totalRatio,
      });
      // 归一化
      this.config.knowledgeRatio /= totalRatio;
      this.config.toolsRatio /= totalRatio;
      this.config.otherRatio /= totalRatio;
    }
    
    logger.debug('TokenBudgetManager created', { config: this.config });
  }

  /**
   * 分配预算
   * Requirement 3.2: 按比例分配预算
   * 
   * @param totalTokens 总 Token 预算
   * @returns 预算分配结果
   */
  allocateBudget(totalTokens: number): BudgetAllocation {
    if (totalTokens <= 0) {
      logger.warn('TokenBudgetManager: invalid totalTokens', { totalTokens });
      return {
        knowledgeBudget: 0,
        toolsBudget: 0,
        otherBudget: 0,
        totalBudget: 0,
      };
    }

    // 按比例分配，使用 floor 确保不超过总预算
    const knowledgeBudget = Math.floor(totalTokens * this.config.knowledgeRatio);
    const toolsBudget = Math.floor(totalTokens * this.config.toolsRatio);
    // 其他预算取剩余部分，确保总和等于 totalTokens
    const otherBudget = totalTokens - knowledgeBudget - toolsBudget;

    const allocation: BudgetAllocation = {
      knowledgeBudget,
      toolsBudget,
      otherBudget,
      totalBudget: totalTokens,
    };

    logger.debug('Budget allocated', { allocation });
    return allocation;
  }

  /**
   * 计算使用情况
   * Requirement 3.4: 提供预算使用统计
   * 
   * @param knowledgeTokens 知识内容已用 Token
   * @param toolsTokens 工具输出已用 Token
   * @param otherTokens 其他已用 Token
   * @param allocation 原始预算分配
   * @returns 预算使用情况
   */
  calculateUsage(
    knowledgeTokens: number,
    toolsTokens: number,
    otherTokens: number,
    allocation: BudgetAllocation
  ): BudgetUsage {
    const totalUsed = knowledgeTokens + toolsTokens + otherTokens;
    const remaining = allocation.totalBudget - totalUsed;

    return {
      knowledgeUsed: knowledgeTokens,
      toolsUsed: toolsTokens,
      otherUsed: otherTokens,
      totalUsed,
      remaining,
    };
  }

  /**
   * 重新分配未使用的预算
   * Requirement 3.3: 将剩余预算重新分配给其他部分
   * 
   * @param usage 当前使用情况
   * @param allocation 原始预算分配
   * @returns 重新分配后的预算
   */
  redistributeUnused(
    usage: BudgetUsage,
    allocation: BudgetAllocation
  ): BudgetAllocation {
    if (!this.config.enableRedistribution) {
      return allocation;
    }

    // 计算各部分的剩余预算
    const knowledgeRemaining = Math.max(0, allocation.knowledgeBudget - usage.knowledgeUsed);
    const toolsRemaining = Math.max(0, allocation.toolsBudget - usage.toolsUsed);
    const otherRemaining = Math.max(0, allocation.otherBudget - usage.otherUsed);
    
    const totalRemaining = knowledgeRemaining + toolsRemaining + otherRemaining;
    
    if (totalRemaining <= 0) {
      return allocation;
    }

    // 重新分配：将未使用的预算按原比例分配给需要更多空间的部分
    // 优先级：知识内容 > 工具输出 > 其他
    let newKnowledgeBudget = usage.knowledgeUsed;
    let newToolsBudget = usage.toolsUsed;
    let newOtherBudget = usage.otherUsed;

    // 如果知识内容超出预算，从其他部分借用
    if (usage.knowledgeUsed > allocation.knowledgeBudget) {
      const overflow = usage.knowledgeUsed - allocation.knowledgeBudget;
      const available = toolsRemaining + otherRemaining;
      if (available >= overflow) {
        newKnowledgeBudget = usage.knowledgeUsed;
      }
    }

    // 重新计算，确保总和不变
    const redistributed: BudgetAllocation = {
      knowledgeBudget: Math.max(allocation.knowledgeBudget, newKnowledgeBudget),
      toolsBudget: Math.max(allocation.toolsBudget - Math.max(0, newKnowledgeBudget - allocation.knowledgeBudget), 0),
      otherBudget: allocation.otherBudget,
      totalBudget: allocation.totalBudget,
    };

    // 确保总和等于原始总预算
    const sum = redistributed.knowledgeBudget + redistributed.toolsBudget + redistributed.otherBudget;
    if (sum !== allocation.totalBudget) {
      redistributed.otherBudget = allocation.totalBudget - redistributed.knowledgeBudget - redistributed.toolsBudget;
    }

    logger.debug('Budget redistributed', { 
      original: allocation, 
      usage, 
      redistributed 
    });

    return redistributed;
  }

  /**
   * 按优先级裁剪内容
   * Requirement 3.5: 按优先级（系统提示词 > 最近历史 > 知识内容 > 工具输出）裁剪
   * 
   * @param messages 消息列表
   * @param maxTokens 最大 Token 数
   * @param estimateTokensFn Token 估算函数
   * @returns 裁剪后的消息列表
   */
  trimByPriority(
    messages: ChatMessage[],
    maxTokens: number,
    estimateTokensFn: (text: string) => number
  ): ChatMessage[] {
    if (messages.length === 0) {
      return [];
    }

    // 分类消息
    const systemMessages: ChatMessage[] = [];
    const historyMessages: ChatMessage[] = [];
    const otherMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        historyMessages.push(msg);
      }
    }

    // 计算系统消息的 Token 数（必须保留）
    let totalTokens = 0;
    for (const msg of systemMessages) {
      totalTokens += estimateTokensFn(msg.content);
    }

    // 如果系统消息已超出限制，只返回系统消息（截断）
    if (totalTokens >= maxTokens) {
      logger.warn('System messages exceed maxTokens, truncating', {
        systemTokens: totalTokens,
        maxTokens,
      });
      return systemMessages;
    }

    // 从最新的历史消息开始添加
    const result: ChatMessage[] = [...systemMessages];
    const remainingBudget = maxTokens - totalTokens;
    let usedBudget = 0;

    // 反向遍历历史消息（最新的优先）
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const msg = historyMessages[i];
      const msgTokens = estimateTokensFn(msg.content);
      
      if (usedBudget + msgTokens <= remainingBudget) {
        result.splice(systemMessages.length, 0, msg); // 插入到系统消息之后
        usedBudget += msgTokens;
      } else {
        // 预算不足，停止添加
        logger.debug('Trimming history messages due to budget', {
          trimmedCount: i + 1,
          usedBudget,
          remainingBudget,
        });
        break;
      }
    }

    // 重新排序：系统消息在前，历史消息按原顺序
    const finalResult: ChatMessage[] = [];
    for (const msg of result) {
      if (msg.role === 'system') {
        finalResult.push(msg);
      }
    }
    for (const msg of result) {
      if (msg.role !== 'system') {
        finalResult.push(msg);
      }
    }

    return finalResult;
  }

  /**
   * 获取配置
   */
  getConfig(): TokenBudgetManagerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TokenBudgetManagerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('TokenBudgetManager config updated', { config: this.config });
  }
}

// 导出单例实例
export const tokenBudgetManager = new TokenBudgetManager();
