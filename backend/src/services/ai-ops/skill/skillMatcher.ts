/**
 * SkillMatcher - Skill 智能匹配器
 * 
 * 实现多层匹配策略，智能选择最合适的 Skill
 * 
 * Requirements: 6.1-6.12, 16.1-16.7, 17.1-17.4
 * - 6.1: 多层匹配策略 explicit > trigger > intent > semantic > fallback
 * - 6.2: 显式 @skill-name 或 #skill-name 语法
 * - 6.3: 触发词匹配
 * - 6.4: 意图映射匹配
 * - 6.5: 语义相似度匹配
 * - 6.6: 返回 SkillMatchResult
 * - 6.7: 兜底到 generalist
 * - 16.1-16.7: 触发配置
 * - 17.1-17.4: 上下文延续检测
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../utils/logger';
import {
  Skill,
  SkillMatchType,
  SkillMatchResult,
  SkillMappingConfig,
  DEFAULT_SKILL_MAPPING,
} from '../../../types/skill';
import { ChatMessage, IntentAnalysis, QuestionType } from '../../../types';
import { SkillRegistry } from './skillRegistry';
import { SkillSemanticMatcher, SemanticMatcherConfig } from './skillSemanticMatcher';
import { SkillRouter } from './skillRouter';
import { IAIProviderAdapter, AIProvider } from '../../../types/ai';

/**
 * 匹配上下文
 */
export interface SkillMatchContext {
  /** 用户消息 */
  message: string;
  /** 会话 ID */
  sessionId: string;
  /** 当前活跃的 Skill */
  currentSkill?: Skill;
  /** 对话历史 */
  conversationHistory: ChatMessage[];
  /** 意图分析结果 */
  intentAnalysis?: IntentAnalysis;
}

/**
 * SkillMatcher 配置
 */
export interface SkillMatcherConfig {
  /** 映射配置文件路径 */
  mappingFilePath: string;
  /** 语义匹配阈值 */
  semanticThreshold: number;
  /** 上下文延续阈值 */
  contextThreshold: number;
  /** 是否启用语义匹配 */
  enableSemanticMatch: boolean;
  /** 是否启用 LLM 智能路由 */
  enableLLMRouting: boolean;
  /** 语义匹配器配置 */
  semanticMatcherConfig?: Partial<SemanticMatcherConfig>;
}

/**
 * 默认配置
 */
const DEFAULT_MATCHER_CONFIG: SkillMatcherConfig = {
  mappingFilePath: 'data/ai-ops/skills/mapping.json',
  semanticThreshold: 0.6,
  contextThreshold: 0.75,
  enableSemanticMatch: true,
  enableLLMRouting: true, // 默认启用 LLM 智能路由
};

/**
 * SkillMatcher 类
 * 智能匹配最合适的 Skill
 */
export class SkillMatcher {
  private config: SkillMatcherConfig;
  private registry: SkillRegistry;
  private mappingConfig: SkillMappingConfig = DEFAULT_SKILL_MAPPING;
  private semanticMatcher: SkillSemanticMatcher | null = null;
  private skillRouter: SkillRouter | null = null;
  
  // 保存待设置的 adapter factory（用于处理初始化顺序问题）
  private pendingAdapterFactory: (() => Promise<{
    adapter: IAIProviderAdapter;
    provider: AIProvider;
    model: string;
  } | null>) | null = null;

  constructor(registry: SkillRegistry, config?: Partial<SkillMatcherConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_MATCHER_CONFIG, ...config };
    logger.info('SkillMatcher created', { config: this.config });
  }

  /**
   * 初始化（加载映射配置）
   */
  async initialize(): Promise<void> {
    await this.loadMappingConfig();
    
    // 初始化语义匹配器
    if (this.config.enableSemanticMatch) {
      try {
        this.semanticMatcher = new SkillSemanticMatcher(
          this.registry,
          {
            similarityThreshold: this.config.semanticThreshold,
            ...this.config.semanticMatcherConfig,
          }
        );
        await this.semanticMatcher.initialize();
        logger.info('Semantic matcher initialized');
      } catch (error) {
        logger.warn('Failed to initialize semantic matcher, semantic matching disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.semanticMatcher = null;
      }
    }
    
    // 初始化智能路由器
    if (this.config.enableLLMRouting) {
      this.skillRouter = new SkillRouter(this.registry, {
        candidateCount: 5,
        enableLLMRouting: true,
      });
      if (this.semanticMatcher) {
        this.skillRouter.setSemanticMatcher(this.semanticMatcher);
      }
      
      // 应用之前保存的 adapter factory（处理初始化顺序问题）
      if (this.pendingAdapterFactory) {
        this.skillRouter.setAIAdapterFactory(this.pendingAdapterFactory);
        this.pendingAdapterFactory = null;
        logger.info('Pending AI adapter factory applied to SkillRouter');
      }
      
      logger.info('Skill router initialized');
    }
    
    logger.info('SkillMatcher initialized');
  }

  /**
   * 加载映射配置
   */
  private async loadMappingConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.mappingFilePath, 'utf-8');
      const parsed = JSON.parse(content);
      this.mappingConfig = { ...DEFAULT_SKILL_MAPPING, ...parsed };
      logger.info('Mapping config loaded', {
        intentMappings: Object.keys(this.mappingConfig.intentMapping).length,
        keywordMappings: Object.keys(this.mappingConfig.keywordMapping).length,
      });
    } catch (error) {
      logger.warn('Failed to load mapping config, using defaults', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 匹配最合适的 Skill
   * Requirements: 6.1
   * 优先级: explicit > trigger > context > LLM智能路由 > intent > semantic > fallback
   */
  async match(context: SkillMatchContext): Promise<SkillMatchResult> {
    const { message, currentSkill, conversationHistory, intentAnalysis } = context;

    // 1. 显式匹配 @skill-name 或 #skill-name
    const explicitMatch = this.matchExplicit(message);
    if (explicitMatch) {
      logger.info('Explicit skill match', { skill: explicitMatch.skill.metadata.name });
      return explicitMatch;
    }

    // 2. 触发词匹配
    const triggerMatch = this.matchTriggers(message);
    if (triggerMatch) {
      logger.info('Trigger skill match', { skill: triggerMatch.skill.metadata.name });
      return triggerMatch;
    }

    // 3. 上下文延续检查
    if (currentSkill && this.isContinuation(message, conversationHistory)) {
      logger.info('Context continuation', { skill: currentSkill.metadata.name });
      return {
        skill: currentSkill,
        confidence: this.config.contextThreshold,
        matchType: SkillMatchType.CONTEXT,
        matchReason: '延续当前会话话题',
      };
    }

    // 4. LLM 智能路由（如果启用）
    if (this.skillRouter?.isAvailable()) {
      try {
        const routerResult = await this.skillRouter.route(message, currentSkill);
        if (routerResult.matchType !== SkillMatchType.FALLBACK) {
          logger.info('LLM router skill match', { 
            skill: routerResult.skill.metadata.name,
            confidence: routerResult.confidence,
          });
          return routerResult;
        }
      } catch (error) {
        logger.warn('LLM routing failed, falling back to other methods', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 5. 意图映射匹配
    const intentMatch = this.matchIntent(message, intentAnalysis);
    if (intentMatch && intentMatch.confidence > 0.7) {
      logger.info('Intent skill match', { skill: intentMatch.skill.metadata.name });
      return intentMatch;
    }

    // 6. 关键词映射匹配
    const keywordMatch = this.matchKeywords(message);
    if (keywordMatch) {
      logger.info('Keyword skill match', { skill: keywordMatch.skill.metadata.name });
      return keywordMatch;
    }

    // 7. 语义匹配（如果启用且路由器未使用）
    if (this.config.enableSemanticMatch && !this.skillRouter) {
      const semanticMatch = await this.matchSemantic(message);
      if (semanticMatch && semanticMatch.confidence > this.config.semanticThreshold) {
        logger.info('Semantic skill match', { skill: semanticMatch.skill.metadata.name });
        return semanticMatch;
      }
    }

    // 8. 兜底到 generalist
    logger.info('Fallback to generalist');
    return this.getFallbackResult();
  }

  /**
   * 显式匹配 @skill-name 或 #skill-name
   * Requirements: 6.2
   */
  matchExplicit(message: string): SkillMatchResult | null {
    // 匹配 @skill-name 或 #skill-name
    const match = message.match(/[@#]([a-z0-9-]+)/i);
    if (match) {
      const skillName = match[1].toLowerCase();
      const skill = this.registry.get(skillName);
      if (skill && skill.enabled) {
        return {
          skill,
          confidence: 1.0,
          matchType: SkillMatchType.EXPLICIT,
          matchReason: `用户显式指定 ${skillName}`,
        };
      }
    }
    return null;
  }

  /**
   * 触发词匹配
   * Requirements: 6.3, 16.1-16.7
   */
  matchTriggers(message: string): SkillMatchResult | null {
    const enabledSkills = this.registry.list({ enabled: true });
    
    // 自定义 Skill 优先于内置 Skill
    const sortedSkills = [...enabledSkills].sort((a, b) => {
      if (a.isBuiltin === b.isBuiltin) return 0;
      return a.isBuiltin ? 1 : -1; // 自定义 Skill 排前面
    });

    skillLoop: for (const skill of sortedSkills) {
      const triggers = skill.metadata.triggers || [];
      
      // 第一步：检查所有负向模式，如果任何一个匹配，跳过整个 Skill
      for (const trigger of triggers) {
        if (trigger.startsWith('!')) {
          const excludePattern = trigger.slice(1);
          if (message.includes(excludePattern)) {
            logger.debug('Skill excluded by negative pattern', {
              skill: skill.metadata.name,
              pattern: excludePattern,
            });
            continue skillLoop; // 跳过整个 Skill，不再检查其他触发器
          }
        }
      }
      
      // 第二步：检查正向触发器
      for (const trigger of triggers) {
        // 跳过负向模式（已在上面处理）
        if (trigger.startsWith('!')) {
          continue;
        }
        
        // 正则匹配（/pattern/i 格式）
        if (trigger.startsWith('/') && trigger.endsWith('/i')) {
          try {
            const pattern = trigger.slice(1, -2);
            const regex = new RegExp(pattern, 'i');
            if (regex.test(message)) {
              return {
                skill,
                confidence: 0.9,
                matchType: SkillMatchType.TRIGGER,
                matchReason: `匹配触发模式: ${trigger}`,
              };
            }
          } catch {
            logger.warn('Invalid trigger regex', { trigger, skill: skill.metadata.name });
          }
        }
        // 关键词精确匹配
        else if (message.includes(trigger)) {
          return {
            skill,
            confidence: 0.9,
            matchType: SkillMatchType.TRIGGER,
            matchReason: `匹配触发词: ${trigger}`,
          };
        }
      }
    }

    return null;
  }

  /**
   * 意图映射匹配
   * Requirements: 6.4, 6.9-6.11
   */
  matchIntent(message: string, intentAnalysis?: IntentAnalysis): SkillMatchResult | null {
    if (!intentAnalysis) {
      return null;
    }

    // 从意图分析结果中获取问题类型
    const enhancedAnalysis = intentAnalysis as { questionType?: QuestionType };
    const questionType = enhancedAnalysis.questionType;

    if (questionType) {
      const skillName = this.mappingConfig.intentMapping[questionType];
      if (skillName) {
        const skill = this.registry.get(skillName);
        if (skill && skill.enabled) {
          return {
            skill,
            confidence: 0.8,
            matchType: SkillMatchType.INTENT,
            matchReason: `意图类型 ${questionType} 映射到 ${skillName}`,
          };
        }
      }
    }

    // 从意图描述中推断
    const intent = intentAnalysis.intent.toLowerCase();
    
    if (intent.includes('故障') || intent.includes('诊断') || intent.includes('排查')) {
      const skill = this.registry.get('diagnostician');
      if (skill && skill.enabled) {
        return {
          skill,
          confidence: 0.75,
          matchType: SkillMatchType.INTENT,
          matchReason: '意图分析识别为故障诊断',
        };
      }
    }

    if (intent.includes('配置') || intent.includes('设置') || intent.includes('添加')) {
      const skill = this.registry.get('configurator');
      if (skill && skill.enabled) {
        return {
          skill,
          confidence: 0.75,
          matchType: SkillMatchType.INTENT,
          matchReason: '意图分析识别为配置操作',
        };
      }
    }

    return null;
  }

  /**
   * 关键词映射匹配
   */
  matchKeywords(message: string): SkillMatchResult | null {
    const lowerMessage = message.toLowerCase();

    for (const [keyword, skillName] of Object.entries(this.mappingConfig.keywordMapping)) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        const skill = this.registry.get(skillName);
        if (skill && skill.enabled) {
          return {
            skill,
            confidence: 0.85,
            matchType: SkillMatchType.TRIGGER,
            matchReason: `关键词映射: ${keyword} -> ${skillName}`,
          };
        }
      }
    }

    return null;
  }

  /**
   * 语义相似度匹配
   * Requirements: 6.5
   */
  async matchSemantic(message: string): Promise<SkillMatchResult | null> {
    if (!this.semanticMatcher || !this.semanticMatcher.isInitialized()) {
      logger.debug('Semantic matcher not available');
      return null;
    }

    try {
      const result = await this.semanticMatcher.match(message);
      return result;
    } catch (error) {
      logger.error('Semantic matching failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 判断是否为延续性问题
   * Requirements: 17.1-17.4
   */
  isContinuation(message: string, history: ChatMessage[]): boolean {
    // 检查最近 3 轮对话
    const recentHistory = history.slice(-6);
    if (recentHistory.length < 2) {
      return false;
    }

    // 简单启发式：如果消息很短且不包含新话题关键词，认为是延续
    const shortMessage = message.length < 50;
    const noNewTopic = !this.containsNewTopicKeywords(message);
    
    // 检查是否是追问
    const isFollowUp = this.isFollowUpQuestion(message);

    return (shortMessage && noNewTopic) || isFollowUp;
  }

  /**
   * 检查是否包含新话题关键词
   */
  private containsNewTopicKeywords(message: string): boolean {
    const newTopicKeywords = [
      '另外', '还有', '顺便', '换个话题',
      '新问题', '其他', '另一个',
    ];
    
    const lowerMessage = message.toLowerCase();
    return newTopicKeywords.some(keyword => lowerMessage.includes(keyword));
  }

  /**
   * 检查是否是追问
   */
  private isFollowUpQuestion(message: string): boolean {
    const followUpPatterns = [
      /^那/,
      /^这个/,
      /^它/,
      /^为什么/,
      /^怎么/,
      /^还有吗/,
      /^继续/,
      /^然后呢/,
      /^接下来/,
    ];

    return followUpPatterns.some(pattern => pattern.test(message));
  }

  /**
   * 获取兜底结果
   * Requirements: 6.7
   */
  getFallbackResult(): SkillMatchResult {
    const generalist = this.registry.get('generalist');
    
    if (!generalist) {
      throw new Error('Generalist skill not found');
    }

    return {
      skill: generalist,
      confidence: 0.5,
      matchType: SkillMatchType.FALLBACK,
      matchReason: '未找到匹配的专业 Skill，使用通用助手',
    };
  }

  /**
   * 更新映射配置
   */
  updateMappingConfig(config: Partial<SkillMappingConfig>): void {
    this.mappingConfig = { ...this.mappingConfig, ...config };
    logger.info('Mapping config updated');
  }

  /**
   * 获取映射配置
   */
  getMappingConfig(): SkillMappingConfig {
    return { ...this.mappingConfig };
  }

  /**
   * 保存映射配置
   */
  async saveMappingConfig(): Promise<void> {
    try {
      await fs.writeFile(
        this.config.mappingFilePath,
        JSON.stringify(this.mappingConfig, null, 2),
        'utf-8'
      );
      logger.info('Mapping config saved');
    } catch (error) {
      logger.error('Failed to save mapping config', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * 获取语义匹配器
   */
  getSemanticMatcher(): SkillSemanticMatcher | null {
    return this.semanticMatcher;
  }

  /**
   * 获取智能路由器
   */
  getSkillRouter(): SkillRouter | null {
    return this.skillRouter;
  }

  /**
   * 设置 AI 适配器（用于智能路由）
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model?: string): void {
    if (this.skillRouter) {
      this.skillRouter.setAIAdapter(adapter, provider, model);
      logger.info('SkillMatcher AI adapter set for routing');
    }
  }

  /**
   * 设置 AI 适配器工厂（延迟获取，用于智能路由）
   */
  setAIAdapterFactory(factory: () => Promise<{
    adapter: IAIProviderAdapter;
    provider: AIProvider;
    model: string;
  } | null>): void {
    if (this.skillRouter) {
      this.skillRouter.setAIAdapterFactory(factory);
      logger.info('SkillMatcher AI adapter factory set for routing');
    } else {
      // 保存 factory，等 initialize 后再设置（处理初始化顺序问题）
      this.pendingAdapterFactory = factory;
      logger.info('SkillMatcher AI adapter factory saved (pending router initialization)');
    }
  }

  /**
   * 刷新 Skill 嵌入向量
   */
  async refreshSkillEmbedding(skillName: string): Promise<void> {
    if (this.semanticMatcher) {
      await this.semanticMatcher.refreshSkillEmbedding(skillName);
    }
  }

  /**
   * 刷新所有 Skill 嵌入向量
   */
  async refreshAllEmbeddings(): Promise<void> {
    if (this.semanticMatcher) {
      await this.semanticMatcher.refreshAllEmbeddings();
    }
  }

  /**
   * 检查语义匹配是否可用
   */
  isSemanticMatchEnabled(): boolean {
    return this.config.enableSemanticMatch && 
           this.semanticMatcher !== null && 
           this.semanticMatcher.isInitialized();
  }

  /**
   * 获取语义匹配统计
   */
  getSemanticMatchStats(): { enabled: boolean; cacheSize: number; skills: string[] } | null {
    if (!this.semanticMatcher) {
      return null;
    }
    const cacheStats = this.semanticMatcher.getCacheStats();
    return {
      enabled: this.semanticMatcher.isInitialized(),
      cacheSize: cacheStats.size,
      skills: cacheStats.skills,
    };
  }
}
