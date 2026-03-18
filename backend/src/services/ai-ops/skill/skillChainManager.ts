/**
 * SkillChainManager - Skill 链式调用管理器
 * 
 * 负责管理 Skill 之间的自动链式调用，包括：
 * - 检测链式调用触发条件
 * - 执行自动 Skill 切换
 * - 追踪链式执行历史
 * - 防止无限循环
 * 
 * Requirements: 18.6, 18.7
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../utils/logger';
import {
  Skill,
  SkillSuggestion,
  SkillChainStep,
  SkillChainConfig,
  SessionSkillState,
  DEFAULT_SKILL_CHAIN_CONFIG,
} from '../../../types/skill';

/**
 * 链式调用检测结果
 */
export interface ChainTriggerResult {
  /** 是否应该触发链式调用 */
  shouldChain: boolean;
  /** 建议的下一个 Skill */
  suggestedSkill?: string;
  /** 触发原因 */
  reason?: string;
  /** 是否自动切换 */
  autoSwitch?: boolean;
  /** 匹配的建议配置 */
  matchedSuggestion?: SkillSuggestion;
}

/**
 * 链状态
 */
export interface ChainState {
  /** 链 ID */
  chainId: string;
  /** 链开始时间 */
  startedAt: Date;
  /** 当前深度 */
  currentDepth: number;
  /** 执行步骤 */
  steps: SkillChainStep[];
  /** 已访问的 Skill（用于检测循环） */
  visitedSkills: Set<string>;
  /** 链状态 */
  status: 'active' | 'completed' | 'failed' | 'timeout';
}

/**
 * SkillChainManager 类
 */
export class SkillChainManager {
  private config: SkillChainConfig;
  
  // 活跃的链状态（按会话 ID 索引）
  private activeChains: Map<string, ChainState> = new Map();

  constructor(config?: Partial<SkillChainConfig>) {
    this.config = { ...DEFAULT_SKILL_CHAIN_CONFIG, ...config };
    logger.info('SkillChainManager created', { config: this.config });
  }

  /**
   * 检测是否应该触发链式调用
   * Requirements: 18.6
   */
  detectChainTrigger(
    currentSkill: Skill,
    message: string,
    response: string,
    sessionState: SessionSkillState
  ): ChainTriggerResult {
    if (!this.config.enabled) {
      return { shouldChain: false };
    }

    const suggestions = currentSkill.metadata.suggestedSkills;
    if (!suggestions || suggestions.length === 0) {
      return { shouldChain: false };
    }

    // 检查链深度限制
    const chainState = this.getChainState(sessionState.chainId);
    if (chainState && chainState.currentDepth >= this.config.maxChainDepth) {
      logger.warn('Chain depth limit reached', {
        chainId: chainState.chainId,
        depth: chainState.currentDepth,
        maxDepth: this.config.maxChainDepth,
      });
      return { shouldChain: false, reason: '链深度已达上限' };
    }

    // 按优先级排序建议
    const sortedSuggestions = [...suggestions].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    );

    // 检查每个建议的触发条件
    for (const suggestion of sortedSuggestions) {
      const triggered = this.checkSuggestionTrigger(suggestion, message, response);
      if (triggered) {
        // 检查是否会形成循环
        if (chainState?.visitedSkills.has(suggestion.skillName)) {
          logger.debug('Skipping suggestion to avoid cycle', {
            skillName: suggestion.skillName,
            visitedSkills: Array.from(chainState.visitedSkills),
          });
          continue;
        }

        return {
          shouldChain: true,
          suggestedSkill: suggestion.skillName,
          reason: suggestion.condition,
          autoSwitch: suggestion.autoSwitch ?? false,
          matchedSuggestion: suggestion,
        };
      }
    }

    return { shouldChain: false };
  }

  /**
   * 检查单个建议的触发条件
   */
  private checkSuggestionTrigger(
    suggestion: SkillSuggestion,
    message: string,
    response: string
  ): boolean {
    const triggers = suggestion.triggers;
    if (!triggers || triggers.length === 0) {
      // 没有具体触发器，检查响应中是否包含建议标记
      return this.checkResponseForSuggestion(response, suggestion.skillName);
    }

    const combinedText = `${message} ${response}`.toLowerCase();

    for (const trigger of triggers) {
      if (trigger.startsWith('/') && trigger.endsWith('/i')) {
        // 正则匹配
        try {
          const regex = new RegExp(trigger.slice(1, -2), 'i');
          if (regex.test(combinedText)) {
            return true;
          }
        } catch {
          logger.warn('Invalid regex trigger', { trigger });
        }
      } else {
        // 关键词匹配
        if (combinedText.includes(trigger.toLowerCase())) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 检查响应中是否包含 Skill 建议标记
   */
  private checkResponseForSuggestion(response: string, skillName: string): boolean {
    // 检查多种格式的建议标记
    const patterns = [
      new RegExp(`suggest(?:ed)?_skill:\\s*${skillName}`, 'i'),
      new RegExp(`switch_to:\\s*${skillName}`, 'i'),
      new RegExp(`recommend(?:ed)?:\\s*${skillName}`, 'i'),
      new RegExp(`建议切换到\\s*${skillName}`, 'i'),
      new RegExp(`推荐使用\\s*${skillName}`, 'i'),
    ];

    return patterns.some(pattern => pattern.test(response));
  }

  /**
   * 开始新的链式调用
   * Requirements: 18.7
   */
  startChain(sessionId: string, initialSkill: Skill): ChainState {
    const chainId = uuidv4();
    const now = new Date();

    const chainState: ChainState = {
      chainId,
      startedAt: now,
      currentDepth: 1,
      steps: [{
        stepId: uuidv4(),
        skillName: initialSkill.metadata.name,
        enteredAt: now,
        status: 'active',
        triggerReason: '链起始点',
        autoSwitched: false,
      }],
      visitedSkills: new Set([initialSkill.metadata.name]),
      status: 'active',
    };

    this.activeChains.set(sessionId, chainState);
    
    logger.info('Skill chain started', {
      sessionId,
      chainId,
      initialSkill: initialSkill.metadata.name,
    });

    return chainState;
  }

  /**
   * 添加链步骤
   * Requirements: 18.7
   */
  addChainStep(
    sessionId: string,
    skill: Skill,
    triggerReason: string,
    autoSwitched: boolean
  ): SkillChainStep | null {
    const chainState = this.activeChains.get(sessionId);
    if (!chainState) {
      logger.warn('No active chain for session', { sessionId });
      return null;
    }

    // 标记前一个步骤为完成
    const previousStep = chainState.steps[chainState.steps.length - 1];
    if (previousStep && previousStep.status === 'active') {
      previousStep.status = 'completed';
      previousStep.exitedAt = new Date();
    }

    // 创建新步骤
    const newStep: SkillChainStep = {
      stepId: uuidv4(),
      skillName: skill.metadata.name,
      enteredAt: new Date(),
      status: 'active',
      triggerReason,
      autoSwitched,
    };

    chainState.steps.push(newStep);
    chainState.currentDepth++;
    chainState.visitedSkills.add(skill.metadata.name);

    logger.info('Chain step added', {
      sessionId,
      chainId: chainState.chainId,
      stepId: newStep.stepId,
      skillName: skill.metadata.name,
      depth: chainState.currentDepth,
    });

    return newStep;
  }

  /**
   * 完成当前链步骤
   */
  completeCurrentStep(
    sessionId: string,
    success: boolean,
    resultSummary?: string
  ): void {
    const chainState = this.activeChains.get(sessionId);
    if (!chainState) return;

    const currentStep = chainState.steps[chainState.steps.length - 1];
    if (currentStep && currentStep.status === 'active') {
      currentStep.status = success ? 'completed' : 'failed';
      currentStep.exitedAt = new Date();
      currentStep.resultSummary = resultSummary;
    }
  }

  /**
   * 结束链式调用
   * Requirements: 18.7
   */
  endChain(sessionId: string, status: 'completed' | 'failed' | 'timeout' = 'completed'): ChainState | null {
    const chainState = this.activeChains.get(sessionId);
    if (!chainState) return null;

    // 标记最后一个步骤
    const lastStep = chainState.steps[chainState.steps.length - 1];
    if (lastStep && lastStep.status === 'active') {
      lastStep.status = status === 'completed' ? 'completed' : 'failed';
      lastStep.exitedAt = new Date();
    }

    chainState.status = status;
    this.activeChains.delete(sessionId);

    logger.info('Skill chain ended', {
      sessionId,
      chainId: chainState.chainId,
      status,
      totalSteps: chainState.steps.length,
      duration: Date.now() - chainState.startedAt.getTime(),
    });

    return chainState;
  }

  /**
   * 获取链状态
   */
  getChainState(chainId?: string): ChainState | null {
    if (!chainId) return null;
    
    for (const state of this.activeChains.values()) {
      if (state.chainId === chainId) {
        return state;
      }
    }
    return null;
  }

  /**
   * 获取会话的链状态
   */
  getSessionChainState(sessionId: string): ChainState | null {
    return this.activeChains.get(sessionId) || null;
  }

  /**
   * 检查链是否超时
   */
  isChainTimeout(sessionId: string): boolean {
    const chainState = this.activeChains.get(sessionId);
    if (!chainState) return false;

    const elapsed = Date.now() - chainState.startedAt.getTime();
    return elapsed > this.config.chainTimeoutMs;
  }

  /**
   * 清理超时的链
   */
  cleanupTimeoutChains(): number {
    let cleanedCount = 0;
    const now = Date.now();

    for (const [sessionId, chainState] of this.activeChains) {
      const elapsed = now - chainState.startedAt.getTime();
      if (elapsed > this.config.chainTimeoutMs) {
        this.endChain(sessionId, 'timeout');
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info('Timeout chains cleaned up', { cleanedCount });
    }

    return cleanedCount;
  }

  /**
   * 获取链历史（用于 API 查询）
   */
  getChainHistory(sessionId: string): SkillChainStep[] {
    const chainState = this.activeChains.get(sessionId);
    return chainState?.steps || [];
  }

  /**
   * 获取链统计信息
   */
  getChainStats(): {
    activeChains: number;
    totalSteps: number;
    avgDepth: number;
  } {
    let totalSteps = 0;
    let totalDepth = 0;

    for (const state of this.activeChains.values()) {
      totalSteps += state.steps.length;
      totalDepth += state.currentDepth;
    }

    const activeChains = this.activeChains.size;
    return {
      activeChains,
      totalSteps,
      avgDepth: activeChains > 0 ? totalDepth / activeChains : 0,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SkillChainConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('SkillChainManager config updated', { config: this.config });
  }

  /**
   * 获取当前配置
   */
  getConfig(): SkillChainConfig {
    return { ...this.config };
  }
}

// 导出单例
export const skillChainManager = new SkillChainManager();
