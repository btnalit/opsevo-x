/**
 * SkillManager - Skill 系统核心管理器
 * 
 * 整合 SkillLoader, SkillRegistry, SkillMatcher，提供统一的 Skill 管理接口
 * 
 * Requirements: 6.1, 6.4, 6.5, 6.12, 17.5-17.8, 18.1-18.7
 * - 6.1: 智能识别与自动调度
 * - 6.4: 意图映射匹配
 * - 6.5: 语义相似度匹配
 * - 6.12: 手动 Skill 覆盖
 * - 17.5-17.8: 会话级 Skill 管理
 * - 18.1-18.7: Skill 协作与切换
 */

import { logger } from '../../../utils/logger';
import {
  Skill,
  SkillMatchType,
  SkillMatchResult,
  SessionSkillState,
  SkillSystemConfig,
  SkillChainConfig,
  SkillChainStep,
  DEFAULT_SKILL_SYSTEM_CONFIG,
  DEFAULT_SKILL_CHAIN_CONFIG,
} from '../../../types/skill';
import { IntentAnalysis, ChatMessage } from '../../../types';
import { IAIProviderAdapter, AIProvider } from '../../../types/ai';
import { SkillLoader, SkillLoaderConfig } from './skillLoader';
import { SkillRegistry } from './skillRegistry';
import { SkillMatcher, SkillMatchContext, SkillMatcherConfig } from './skillMatcher';
import { SkillMetrics } from './skillMetrics';
import { SkillChainManager, ChainTriggerResult, ChainState } from './skillChainManager';

/**
 * SkillManager 配置
 */
export interface SkillManagerConfig extends Omit<SkillSystemConfig, 'chainConfig'> {
  /** SkillLoader 配置 */
  loaderConfig?: Partial<SkillLoaderConfig>;
  /** SkillMatcher 配置 */
  matcherConfig?: Partial<SkillMatcherConfig>;
  /** SkillChain 配置 */
  chainConfig?: Partial<SkillChainConfig>;
  /** 会话 TTL（毫秒），默认 30 分钟 */
  sessionTTLMs?: number;
  /** 会话清理间隔（毫秒），默认 5 分钟 */
  sessionCleanupIntervalMs?: number;
}

/**
 * 带时间戳的会话状态
 */
interface TimestampedSessionState extends SessionSkillState {
  /** 最后访问时间 */
  lastAccessedAt: Date;
}

/**
 * Skill 选择选项
 */
export interface SkillSelectOptions {
  /** 手动指定的 Skill 名称 */
  skillOverride?: string;
  /** 意图分析结果 */
  intentAnalysis?: IntentAnalysis;
  /** 对话历史 */
  conversationHistory?: ChatMessage[];
  /** 是否启用链式调用检测 */
  enableChaining?: boolean;
}

/**
 * 链式调用结果
 */
export interface ChainExecutionResult {
  /** 是否触发了链式调用 */
  triggered: boolean;
  /** 下一个 Skill */
  nextSkill?: Skill;
  /** 触发原因 */
  reason?: string;
  /** 是否自动切换 */
  autoSwitch?: boolean;
  /** 链状态 */
  chainState?: ChainState;
}

/**
 * SkillManager 类
 * Skill 系统的核心管理器
 */
export class SkillManager {
  private config: SkillManagerConfig;
  private loader: SkillLoader;
  private registry: SkillRegistry;
  private matcher: SkillMatcher;
  private metrics: SkillMetrics;
  private chainManager: SkillChainManager;
  
  // 会话 Skill 状态（带 TTL）
  private sessionStates: Map<string, TimestampedSessionState> = new Map();
  
  // 会话清理定时器
  private sessionCleanupTimer: NodeJS.Timeout | null = null;
  
  // 链清理定时器
  private chainCleanupTimer: NodeJS.Timeout | null = null;
  
  // 初始化状态
  private initialized: boolean = false;

  // 默认会话 TTL: 30 分钟
  private static readonly DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
  // 默认清理间隔: 5 分钟
  private static readonly DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  constructor(config?: Partial<SkillManagerConfig>) {
    this.config = { 
      ...DEFAULT_SKILL_SYSTEM_CONFIG, 
      sessionTTLMs: SkillManager.DEFAULT_SESSION_TTL_MS,
      sessionCleanupIntervalMs: SkillManager.DEFAULT_CLEANUP_INTERVAL_MS,
      ...config 
    };
    
    // 初始化组件
    this.loader = new SkillLoader({
      skillsDir: this.config.skillsDir,
      enableWatch: this.config.enableHotReload,
      ...this.config.loaderConfig,
    });
    
    this.registry = new SkillRegistry();
    this.matcher = new SkillMatcher(this.registry, this.config.matcherConfig);
    this.metrics = new SkillMetrics();
    this.chainManager = new SkillChainManager({
      ...DEFAULT_SKILL_CHAIN_CONFIG,
      ...this.config.chainConfig,
    });
    
    logger.info('SkillManager created', { config: this.config });
  }

  /**
   * 初始化 Skill 系统
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('SkillManager already initialized');
      return;
    }

    logger.info('Initializing SkillManager...');

    try {
      // 1. 加载所有 Skill
      const skills = await this.loader.loadAll();
      
      // 2. 注册到 Registry
      for (const skill of skills) {
        this.registry.register(skill);
      }

      // 3. 确保 generalist 存在
      if (!this.registry.hasGeneralist()) {
        throw new Error('Missing required builtin Skill: generalist');
      }

      // 4. 初始化 Matcher
      await this.matcher.initialize();

      // 5. 加载指标
      await this.metrics.load();

      // 6. 启动文件监视（热重载）
      if (this.config.enableHotReload) {
        this.loader.startWatching(
          (skill) => {
            this.registry.register(skill);
            logger.info('Skill hot-reloaded', { name: skill.metadata.name });
          },
          (skillName) => {
            try {
              this.registry.unregister(skillName);
            } catch {
              // 内置 Skill 不能注销，忽略错误
            }
          }
        );
      }

      // 7. 启动会话清理定时器
      this.startSessionCleanup();

      // 8. 启动链清理定时器
      this.startChainCleanup();

      this.initialized = true;
      
      const stats = this.registry.getStats();
      logger.info('SkillManager initialized', {
        totalSkills: stats.total,
        builtinSkills: stats.builtin,
        customSkills: stats.custom,
      });
    } catch (error) {
      logger.error('Failed to initialize SkillManager', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 为请求选择 Skill
   * Requirements: 6.1, 6.12
   */
  async selectSkill(
    message: string,
    sessionId: string,
    options?: SkillSelectOptions
  ): Promise<SkillMatchResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // 1. 手动覆盖优先
    if (options?.skillOverride) {
      const skill = this.registry.get(options.skillOverride);
      if (skill && skill.enabled) {
        const result: SkillMatchResult = {
          skill,
          confidence: 1.0,
          matchType: SkillMatchType.EXPLICIT,
          matchReason: `API 参数指定: ${options.skillOverride}`,
        };
        
        // 更新会话状态
        this.updateSessionState(sessionId, result);
        
        // 记录指标
        this.metrics.recordUsage(skill.metadata.name, result.matchType);
        
        return result;
      }
    }

    // 2. 获取会话状态
    const sessionState = this.getSessionState(sessionId);

    // 3. 使用 SkillMatcher 匹配
    const context: SkillMatchContext = {
      message,
      sessionId,
      currentSkill: sessionState.currentSkill || undefined,
      conversationHistory: options?.conversationHistory || [],
      intentAnalysis: options?.intentAnalysis,
    };

    const result = await this.matcher.match(context);

    // 4. 检查最小切换间隔
    if (sessionState.currentSkill && 
        sessionState.currentSkill.metadata.name !== result.skill.metadata.name) {
      const now = new Date();
      if (sessionState.lastSwitchAt) {
        const elapsed = now.getTime() - sessionState.lastSwitchAt.getTime();
        if (elapsed < this.config.minSwitchIntervalMs) {
          // 保持当前 Skill
          logger.debug('Skill switch blocked by min interval', {
            current: sessionState.currentSkill.metadata.name,
            requested: result.skill.metadata.name,
            elapsed,
            minInterval: this.config.minSwitchIntervalMs,
          });
          return {
            skill: sessionState.currentSkill,
            confidence: result.confidence,
            matchType: SkillMatchType.CONTEXT,
            matchReason: '最小切换间隔限制',
          };
        }
      }
    }

    // 5. 更新会话状态
    this.updateSessionState(sessionId, result);

    // 6. 记录指标
    this.metrics.recordUsage(result.skill.metadata.name, result.matchType);

    logger.info('Skill selected', {
      sessionId,
      skill: result.skill.metadata.name,
      matchType: result.matchType,
      confidence: result.confidence,
    });

    return result;
  }

  /**
   * 获取会话当前 Skill
   * Requirements: 17.6
   */
  getSessionSkill(sessionId: string): Skill | null {
    const state = this.sessionStates.get(sessionId);
    return state?.currentSkill || null;
  }

  /**
   * 清除会话 Skill
   * Requirements: 17.8
   */
  clearSessionSkill(sessionId: string): void {
    this.sessionStates.delete(sessionId);
    logger.debug('Session skill cleared', { sessionId });
  }

  /**
   * 获取会话状态（带 TTL 检查）
   */
  private getSessionState(sessionId: string): TimestampedSessionState {
    let state = this.sessionStates.get(sessionId);
    const now = new Date();
    
    // 检查是否过期
    if (state) {
      const elapsed = now.getTime() - state.lastAccessedAt.getTime();
      if (elapsed > (this.config.sessionTTLMs || SkillManager.DEFAULT_SESSION_TTL_MS)) {
        // 会话已过期，删除并创建新的
        this.sessionStates.delete(sessionId);
        state = undefined;
        logger.debug('Session expired and removed', { sessionId, elapsed });
      } else {
        // 更新最后访问时间
        state.lastAccessedAt = now;
      }
    }
    
    if (!state) {
      state = {
        currentSkill: null,
        switchHistory: [],
        lastSwitchAt: null,
        lastAccessedAt: now,
      };
      this.sessionStates.set(sessionId, state);
    }
    return state;
  }

  /**
   * 启动会话清理定时器
   */
  private startSessionCleanup(): void {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
    }
    
    const interval = this.config.sessionCleanupIntervalMs || SkillManager.DEFAULT_CLEANUP_INTERVAL_MS;
    this.sessionCleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, interval);
    
    logger.debug('Session cleanup timer started', { intervalMs: interval });
  }

  /**
   * 清理过期会话
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    const ttl = this.config.sessionTTLMs || SkillManager.DEFAULT_SESSION_TTL_MS;
    let cleanedCount = 0;
    
    for (const [sessionId, state] of this.sessionStates) {
      const elapsed = now.getTime() - state.lastAccessedAt.getTime();
      if (elapsed > ttl) {
        this.sessionStates.delete(sessionId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info('Expired sessions cleaned up', { 
        cleanedCount, 
        remainingCount: this.sessionStates.size 
      });
    }
  }

  /**
   * 停止会话清理定时器
   */
  private stopSessionCleanup(): void {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
  }

  /**
   * 启动链清理定时器
   */
  private startChainCleanup(): void {
    if (this.chainCleanupTimer) {
      clearInterval(this.chainCleanupTimer);
    }
    
    // 每分钟清理一次超时的链
    this.chainCleanupTimer = setInterval(() => {
      this.chainManager.cleanupTimeoutChains();
    }, 60000);
    
    logger.debug('Chain cleanup timer started');
  }

  /**
   * 停止链清理定时器
   */
  private stopChainCleanup(): void {
    if (this.chainCleanupTimer) {
      clearInterval(this.chainCleanupTimer);
      this.chainCleanupTimer = null;
    }
  }

  // ==================== 链式调用 API ====================

  /**
   * 检测并执行链式调用
   * Requirements: 18.6, 18.7
   */
  async checkAndExecuteChain(
    sessionId: string,
    message: string,
    response: string
  ): Promise<ChainExecutionResult> {
    const sessionState = this.getSessionState(sessionId);
    const currentSkill = sessionState.currentSkill;

    if (!currentSkill) {
      return { triggered: false };
    }

    // 检测链式调用触发
    const triggerResult = this.chainManager.detectChainTrigger(
      currentSkill,
      message,
      response,
      sessionState
    );

    if (!triggerResult.shouldChain || !triggerResult.suggestedSkill) {
      return { triggered: false };
    }

    // 获取建议的 Skill
    const nextSkill = this.registry.get(triggerResult.suggestedSkill);
    if (!nextSkill || !nextSkill.enabled) {
      logger.warn('Suggested skill not found or disabled', {
        suggestedSkill: triggerResult.suggestedSkill,
      });
      return { triggered: false, reason: 'Skill 不存在或已禁用' };
    }

    // 如果需要用户确认且不是自动切换，返回建议但不执行
    const chainConfig = this.chainManager.getConfig();
    if (chainConfig.requireConfirmation && !triggerResult.autoSwitch) {
      return {
        triggered: true,
        nextSkill,
        reason: triggerResult.reason,
        autoSwitch: false,
      };
    }

    // 执行链式切换
    return this.executeChainSwitch(sessionId, nextSkill, triggerResult);
  }

  /**
   * 执行链式切换
   * Requirements: 18.6
   */
  async executeChainSwitch(
    sessionId: string,
    nextSkill: Skill,
    triggerResult: ChainTriggerResult
  ): Promise<ChainExecutionResult> {
    const sessionState = this.getSessionState(sessionId);

    // 如果没有活跃的链，开始新链
    let chainState = this.chainManager.getSessionChainState(sessionId);
    if (!chainState) {
      const currentSkill = sessionState.currentSkill;
      if (currentSkill) {
        chainState = this.chainManager.startChain(sessionId, currentSkill);
        // 更新会话状态中的 chainId
        sessionState.chainId = chainState.chainId;
      }
    }

    // 添加链步骤
    if (chainState) {
      this.chainManager.addChainStep(
        sessionId,
        nextSkill,
        triggerResult.reason || '链式调用',
        triggerResult.autoSwitch || false
      );
    }

    // 更新会话 Skill
    const result: SkillMatchResult = {
      skill: nextSkill,
      confidence: 0.95,
      matchType: SkillMatchType.CONTEXT,
      matchReason: `链式调用: ${triggerResult.reason}`,
    };
    this.updateSessionState(sessionId, result);

    // 记录指标
    this.metrics.recordUsage(nextSkill.metadata.name, SkillMatchType.CONTEXT);

    logger.info('Chain switch executed', {
      sessionId,
      fromSkill: sessionState.currentSkill?.metadata.name,
      toSkill: nextSkill.metadata.name,
      reason: triggerResult.reason,
      chainId: chainState?.chainId,
    });

    return {
      triggered: true,
      nextSkill,
      reason: triggerResult.reason,
      autoSwitch: triggerResult.autoSwitch,
      chainState: chainState || undefined,
    };
  }

  /**
   * 手动确认链式切换
   * Requirements: 18.3
   */
  async confirmChainSwitch(
    sessionId: string,
    skillName: string,
    reason: string
  ): Promise<ChainExecutionResult> {
    const skill = this.registry.get(skillName);
    if (!skill || !skill.enabled) {
      return { triggered: false, reason: 'Skill 不存在或已禁用' };
    }

    return this.executeChainSwitch(sessionId, skill, {
      shouldChain: true,
      suggestedSkill: skillName,
      reason,
      autoSwitch: true,
    });
  }

  /**
   * 结束当前链
   * Requirements: 18.7
   */
  endCurrentChain(
    sessionId: string,
    success: boolean = true,
    resultSummary?: string
  ): ChainState | null {
    // 完成当前步骤
    this.chainManager.completeCurrentStep(sessionId, success, resultSummary);
    
    // 结束链
    const chainState = this.chainManager.endChain(
      sessionId,
      success ? 'completed' : 'failed'
    );

    // 清除会话中的 chainId
    const sessionState = this.sessionStates.get(sessionId);
    if (sessionState) {
      // 保存链历史到会话
      if (chainState) {
        sessionState.chainHistory = chainState.steps;
      }
      sessionState.chainId = undefined;
    }

    return chainState;
  }

  /**
   * 获取链历史
   * Requirements: 18.7
   */
  getChainHistory(sessionId: string): SkillChainStep[] {
    // 先检查活跃的链
    const activeHistory = this.chainManager.getChainHistory(sessionId);
    if (activeHistory.length > 0) {
      return activeHistory;
    }

    // 返回会话中保存的历史
    const sessionState = this.sessionStates.get(sessionId);
    return sessionState?.chainHistory || [];
  }

  /**
   * 获取链管理器
   */
  getChainManager(): SkillChainManager {
    return this.chainManager;
  }

  /**
   * 更新会话状态
   * Requirements: 17.5
   */
  private updateSessionState(sessionId: string, result: SkillMatchResult): void {
    const state = this.getSessionState(sessionId);
    const previousSkill = state.currentSkill;

    // 如果 Skill 发生变化，记录切换历史
    if (!previousSkill || previousSkill.metadata.name !== result.skill.metadata.name) {
      state.switchHistory.push({
        skillName: result.skill.metadata.name,
        matchType: result.matchType,
        timestamp: new Date(),
      });

      // 限制历史记录长度
      if (state.switchHistory.length > 20) {
        state.switchHistory = state.switchHistory.slice(-20);
      }

      state.lastSwitchAt = new Date();
    }

    state.currentSkill = result.skill;
    state.lastAccessedAt = new Date();
    this.sessionStates.set(sessionId, state);
  }

  /**
   * 解析 Skill 继承
   * Requirements: 18.4, 18.5
   */
  resolveSkillInheritance(skill: Skill): Skill {
    if (!skill.config.extends) {
      return skill;
    }

    const parentSkill = this.registry.get(skill.config.extends);
    if (!parentSkill) {
      logger.warn('Parent skill not found', {
        skill: skill.metadata.name,
        extends: skill.config.extends,
      });
      return skill;
    }

    // 合并配置（子 Skill 覆盖父 Skill）
    const mergedConfig = {
      ...parentSkill.config,
      ...skill.config,
      allowedTools: skill.config.allowedTools.length > 0 
        ? skill.config.allowedTools 
        : parentSkill.config.allowedTools,
      toolDefaults: { ...parentSkill.config.toolDefaults, ...skill.config.toolDefaults },
      toolConstraints: { ...parentSkill.config.toolConstraints, ...skill.config.toolConstraints },
      knowledgeConfig: { ...parentSkill.config.knowledgeConfig, ...skill.config.knowledgeConfig },
    };

    return {
      ...skill,
      config: mergedConfig,
    };
  }

  /**
   * 检测 Skill 切换建议
   * Requirements: 18.2, 18.3
   */
  detectSkillSwitchSuggestion(response: string): { suggested: boolean; skillName?: string; reason?: string } {
    // 检测 skill_switch_suggestion 格式
    const match = response.match(/skill_switch_suggestion:\s*(\w+)(?:\s*-\s*(.+))?/i);
    if (match) {
      return {
        suggested: true,
        skillName: match[1],
        reason: match[2],
      };
    }
    return { suggested: false };
  }

  // ==================== 公共 API ====================

  /**
   * 获取所有 Skill
   */
  listSkills(filter?: { builtin?: boolean; enabled?: boolean }): Skill[] {
    return this.registry.list(filter);
  }

  /**
   * 获取 Skill
   */
  getSkill(name: string): Skill | undefined {
    return this.registry.get(name);
  }

  /**
   * 切换 Skill 启用状态
   */
  toggleSkill(name: string, enabled: boolean): boolean {
    return this.registry.toggle(name, enabled);
  }

  /**
   * 获取 Skill 指标
   */
  getSkillMetrics(name: string) {
    return this.metrics.getMetrics(name);
  }

  /**
   * 获取所有指标
   */
  getAllMetrics() {
    return this.metrics.getAllMetrics();
  }

  /**
   * 记录任务完成
   */
  recordCompletion(skillName: string, success: boolean, responseTime: number): void {
    this.metrics.recordCompletion(skillName, success, responseTime);
  }

  /**
   * 记录用户反馈
   */
  recordFeedback(skillName: string, positive: boolean): void {
    this.metrics.recordFeedback(skillName, positive);
  }

  /**
   * 获取 Registry
   */
  getRegistry(): SkillRegistry {
    return this.registry;
  }

  /**
   * 获取 Matcher
   */
  getMatcher(): SkillMatcher {
    return this.matcher;
  }

  /**
   * 设置 AI 适配器（用于智能路由）
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model?: string): void {
    this.matcher.setAIAdapter(adapter, provider, model);
  }

  /**
   * 设置 AI 适配器工厂（延迟获取，用于智能路由）
   */
  setAIAdapterFactory(factory: () => Promise<{
    adapter: IAIProviderAdapter;
    provider: AIProvider;
    model: string;
  } | null>): void {
    this.matcher.setAIAdapterFactory(factory);
  }

  /**
   * 获取 Metrics
   */
  getMetricsService(): SkillMetrics {
    return this.metrics;
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取会话统计信息
   */
  getSessionStats(): { totalSessions: number; oldestSessionAge: number | null } {
    const now = new Date();
    let oldestAge: number | null = null;
    
    for (const state of this.sessionStates.values()) {
      const age = now.getTime() - state.lastAccessedAt.getTime();
      if (oldestAge === null || age > oldestAge) {
        oldestAge = age;
      }
    }
    
    return {
      totalSessions: this.sessionStates.size,
      oldestSessionAge: oldestAge,
    };
  }

  /**
   * 关闭 SkillManager
   */
  async shutdown(): Promise<void> {
    this.stopSessionCleanup();
    this.stopChainCleanup();
    await this.loader.stopWatching();
    await this.metrics.flush();
    this.sessionStates.clear();
    this.initialized = false;
    logger.info('SkillManager shutdown');
  }
}

// 导出单例实例
export const skillManager = new SkillManager();
