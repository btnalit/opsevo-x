/**
 * SkillAwareKnowledgeRetriever - Skill 感知的知识检索器
 * 
 * 继承 IntelligentRetriever，支持 Skill 特定的知识检索配置
 * 
 * Requirements: 10.1-10.7
 * - 10.1: 知识类型优先级配置
 * - 10.2: 最小相关度阈值过滤
 * - 10.3: Skill 特定的检索策略
 * - 10.4: 知识数量限制
 * - 10.5: 检索结果排序
 * - 10.6: 知识来源标记
 * - 10.7: 检索性能优化
 */

import { logger } from '../../../utils/logger';
import { Skill, KnowledgeConfig } from '../../../types/skill';
import { IntelligentRetriever, intelligentRetriever } from '../rag/intelligentRetriever';
import { FormattedKnowledge, RetrievalOptions, IntelligentRetrievalResult } from '../rag/types/intelligentRetrieval';

/**
 * Skill 感知检索选项
 */
export interface SkillAwareRetrievalOptions extends RetrievalOptions {
  /** 是否应用 Skill 知识配置 */
  applySkillConfig?: boolean;
  /** 是否过滤低相关度结果 */
  filterLowScore?: boolean;
  /** 是否按 Skill 优先级排序 */
  sortBySkillPriority?: boolean;
}

/**
 * Skill 感知检索结果
 */
export interface SkillAwareRetrievalResult extends IntelligentRetrievalResult {
  /** 应用的 Skill 名称 */
  skillName?: string;
  /** 是否应用了 Skill 配置 */
  skillConfigApplied: boolean;
  /** 过滤掉的文档数量 */
  filteredCount: number;
  /** 原始文档数量 */
  originalCount: number;
}

/**
 * 默认 Skill 感知检索选项
 */
const DEFAULT_SKILL_AWARE_OPTIONS: SkillAwareRetrievalOptions = {
  applySkillConfig: true,
  filterLowScore: true,
  sortBySkillPriority: true,
  topK: 10,
  minScore: 0.3,
  includeFullContent: true,
};

/**
 * SkillAwareKnowledgeRetriever 类
 * Skill 感知的知识检索器
 */
export class SkillAwareKnowledgeRetriever {
  private baseRetriever: IntelligentRetriever;

  constructor(retriever?: IntelligentRetriever) {
    this.baseRetriever = retriever || intelligentRetriever;
    logger.debug('SkillAwareKnowledgeRetriever created');
  }

  /**
   * 初始化检索器
   */
  async initialize(): Promise<void> {
    if (!this.baseRetriever.isInitialized()) {
      await this.baseRetriever.initialize();
    }
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.baseRetriever.isInitialized();
  }

  /**
   * Skill 感知的知识检索
   * Requirements: 10.1-10.7
   * 
   * @param query 用户查询
   * @param skill 当前 Skill（可选）
   * @param options 检索选项
   * @returns 检索结果
   */
  async retrieve(
    query: string,
    skill?: Skill,
    options?: Partial<SkillAwareRetrievalOptions>
  ): Promise<SkillAwareRetrievalResult> {
    const opts = { ...DEFAULT_SKILL_AWARE_OPTIONS, ...options };
    const startTime = Date.now();

    // 如果没有 Skill 或不应用 Skill 配置，使用基础检索
    if (!skill || !opts.applySkillConfig) {
      const baseResult = await this.baseRetriever.retrieve(query, opts);
      return {
        ...baseResult,
        skillConfigApplied: false,
        filteredCount: 0,
        originalCount: baseResult.documents.length,
      };
    }

    // 获取 Skill 知识配置
    const knowledgeConfig = skill.config.knowledgeConfig;

    // 如果 Skill 禁用了知识检索
    if (!knowledgeConfig.enabled) {
      logger.debug('Knowledge retrieval disabled for Skill', {
        skill: skill.metadata.name,
      });
      return {
        query,
        documents: [],
        retrievalTime: Date.now() - startTime,
        rewrittenQueries: [],
        degradedMode: false,
        skillName: skill.metadata.name,
        skillConfigApplied: true,
        filteredCount: 0,
        originalCount: 0,
      };
    }

    // 应用 Skill 配置到检索选项
    const skillOpts = this.applySkillConfig(opts, knowledgeConfig);

    // 执行基础检索
    const baseResult = await this.baseRetriever.retrieve(query, skillOpts);
    const originalCount = baseResult.documents.length;

    // 应用 Skill 特定的后处理
    let documents = baseResult.documents;

    // 1. 按知识类型优先级过滤和排序
    // Requirements: 10.1
    if (opts.sortBySkillPriority && knowledgeConfig.priorityTypes.length > 0) {
      documents = this.sortByTypePriority(documents, knowledgeConfig.priorityTypes);
    }

    // 2. 过滤低相关度结果
    // Requirements: 10.2
    if (opts.filterLowScore) {
      const minScore = knowledgeConfig.minScore || opts.minScore || 0.3;
      documents = this.filterByScore(documents, minScore);
    }

    // 3. 限制数量
    // Requirements: 10.4
    const maxCount = opts.topK || 5;
    documents = documents.slice(0, maxCount);

    const filteredCount = originalCount - documents.length;

    logger.debug('Skill-aware retrieval completed', {
      skill: skill.metadata.name,
      query: query.substring(0, 50),
      originalCount,
      filteredCount,
      resultCount: documents.length,
      retrievalTime: Date.now() - startTime,
    });

    return {
      ...baseResult,
      documents,
      skillName: skill.metadata.name,
      skillConfigApplied: true,
      filteredCount,
      originalCount,
    };
  }

  /**
   * 应用 Skill 配置到检索选项
   */
  private applySkillConfig(
    opts: SkillAwareRetrievalOptions,
    config: KnowledgeConfig
  ): RetrievalOptions {
    return {
      ...opts,
      minScore: config.minScore || opts.minScore,
      // 可以根据 priorityTypes 调整检索策略
    };
  }

  /**
   * 按知识类型优先级排序
   * Requirements: 10.1, 10.5
   */
  private sortByTypePriority(
    documents: FormattedKnowledge[],
    priorityTypes: string[]
  ): FormattedKnowledge[] {
    if (priorityTypes.length === 0) {
      return documents;
    }

    return [...documents].sort((a, b) => {
      const aIndex = priorityTypes.indexOf(a.type);
      const bIndex = priorityTypes.indexOf(b.type);

      // 优先级列表中的类型排在前面
      if (aIndex === -1 && bIndex === -1) {
        // 都不在优先级列表中，按原始分数排序
        return b.credibilityScore - a.credibilityScore;
      }
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;

      // 都在优先级列表中，按优先级排序
      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }

      // 同一优先级，按分数排序
      return b.credibilityScore - a.credibilityScore;
    });
  }

  /**
   * 按分数过滤
   * Requirements: 10.2
   */
  private filterByScore(
    documents: FormattedKnowledge[],
    minScore: number
  ): FormattedKnowledge[] {
    return documents.filter(doc => doc.credibilityScore >= minScore);
  }

  /**
   * 按知识类型过滤
   */
  filterByTypes(
    documents: FormattedKnowledge[],
    allowedTypes: string[]
  ): FormattedKnowledge[] {
    if (allowedTypes.length === 0) {
      return documents;
    }
    return documents.filter(doc => allowedTypes.includes(doc.type));
  }

  /**
   * 获取 Skill 推荐的知识类型
   */
  getRecommendedTypes(skill: Skill): string[] {
    return skill.config.knowledgeConfig.priorityTypes || [];
  }

  /**
   * 检查 Skill 是否启用知识检索
   */
  isKnowledgeEnabled(skill: Skill): boolean {
    return skill.config.knowledgeConfig.enabled;
  }

  /**
   * 获取 Skill 的最小相关度阈值
   */
  getMinScore(skill: Skill): number {
    return skill.config.knowledgeConfig.minScore || 0.3;
  }
}

// 导出单例实例
export const skillAwareKnowledgeRetriever = new SkillAwareKnowledgeRetriever();
