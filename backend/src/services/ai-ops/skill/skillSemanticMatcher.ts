/**
 * SkillSemanticMatcher - Skill 语义匹配器
 * 
 * 使用 EmbeddingService 进行语义相似度匹配
 * 
 * Requirements: 6.5
 * - 集成 EmbeddingService 进行语义匹配
 * - 为 Skill 描述生成嵌入向量
 * - 实现基于相似度的 Skill 匹配
 * - 缓存嵌入向量以提高性能
 * - 添加置信度阈值配置
 */

import { logger } from '../../../utils/logger';
import { Skill, SkillMatchType, SkillMatchResult } from '../../../types/skill';
import { EmbeddingService, embeddingService, EmbeddingResult } from '../rag/embeddingService';
import { SkillRegistry } from './skillRegistry';

/**
 * 缓存的 Skill 嵌入向量
 */
interface SkillEmbeddingCache {
  /** Skill 名称 */
  skillName: string;
  /** 描述文本 */
  description: string;
  /** 嵌入向量 */
  vector: number[];
  /** 创建时间 */
  createdAt: Date;
  /** Skill 修改时间（用于失效检测） */
  skillModifiedAt: Date;
}

/**
 * 语义匹配配置
 */
export interface SemanticMatcherConfig {
  /** 相似度阈值（0-1），低于此值不匹配 */
  similarityThreshold: number;
  /** 是否启用缓存 */
  cacheEnabled: boolean;
  /** 缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 是否在初始化时预计算所有 Skill 嵌入 */
  precomputeEmbeddings: boolean;
  /** 最大返回结果数 */
  maxResults: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SemanticMatcherConfig = {
  similarityThreshold: 0.6,
  cacheEnabled: true,
  cacheTtlMs: 24 * 60 * 60 * 1000, // 24 小时
  precomputeEmbeddings: true,
  maxResults: 3,
};

/**
 * 语义匹配结果
 */
export interface SemanticMatchScore {
  /** Skill */
  skill: Skill;
  /** 相似度分数（0-1） */
  similarity: number;
  /** 匹配的描述文本 */
  matchedDescription: string;
}

/**
 * SkillSemanticMatcher 类
 * 使用嵌入向量进行语义相似度匹配
 */
export class SkillSemanticMatcher {
  private config: SemanticMatcherConfig;
  private registry: SkillRegistry;
  private embeddingService: EmbeddingService;
  
  // Skill 嵌入向量缓存
  private skillEmbeddings: Map<string, SkillEmbeddingCache> = new Map();
  
  // 初始化状态
  private initialized: boolean = false;

  constructor(
    registry: SkillRegistry,
    config?: Partial<SemanticMatcherConfig>,
    embeddingSvc?: EmbeddingService
  ) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingService = embeddingSvc || embeddingService;
    
    logger.info('SkillSemanticMatcher created', { config: this.config });
  }

  /**
   * 初始化语义匹配器
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('SkillSemanticMatcher already initialized');
      return;
    }

    try {
      // 确保 EmbeddingService 已初始化
      if (!this.embeddingService.isInitialized()) {
        await this.embeddingService.initialize();
      }

      // 预计算所有 Skill 的嵌入向量
      if (this.config.precomputeEmbeddings) {
        await this.precomputeAllEmbeddings();
      }

      this.initialized = true;
      logger.info('SkillSemanticMatcher initialized', {
        cachedSkills: this.skillEmbeddings.size,
      });
    } catch (error) {
      logger.error('Failed to initialize SkillSemanticMatcher', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 不抛出错误，允许系统在没有语义匹配的情况下运行
      this.initialized = false;
    }
  }

  /**
   * 预计算所有 Skill 的嵌入向量
   */
  private async precomputeAllEmbeddings(): Promise<void> {
    const skills = this.registry.list({ enabled: true });
    
    if (skills.length === 0) {
      logger.info('No skills to precompute embeddings for');
      return;
    }

    logger.info('Precomputing skill embeddings', { skillCount: skills.length });

    // 收集所有需要计算嵌入的描述
    const descriptionsToEmbed: { skill: Skill; description: string }[] = [];
    
    for (const skill of skills) {
      const description = this.getSkillDescription(skill);
      
      // 检查缓存是否有效
      const cached = this.skillEmbeddings.get(skill.metadata.name);
      if (cached && 
          cached.description === description &&
          cached.skillModifiedAt.getTime() === skill.modifiedAt.getTime()) {
        continue; // 缓存有效，跳过
      }
      
      descriptionsToEmbed.push({ skill, description });
    }

    if (descriptionsToEmbed.length === 0) {
      logger.info('All skill embeddings are cached');
      return;
    }

    try {
      // 批量计算嵌入
      const descriptions = descriptionsToEmbed.map(d => d.description);
      const results = await this.embeddingService.embedBatch(descriptions);

      // 缓存结果
      for (let i = 0; i < results.length; i++) {
        const { skill, description } = descriptionsToEmbed[i];
        const result = results[i];
        
        this.skillEmbeddings.set(skill.metadata.name, {
          skillName: skill.metadata.name,
          description,
          vector: result.vector,
          createdAt: new Date(),
          skillModifiedAt: skill.modifiedAt,
        });
      }

      logger.info('Skill embeddings precomputed', {
        computed: results.length,
        cached: this.skillEmbeddings.size,
      });
    } catch (error) {
      logger.error('Failed to precompute skill embeddings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 获取 Skill 的描述文本（用于嵌入）
   */
  private getSkillDescription(skill: Skill): string {
    // 组合名称、描述和标签作为嵌入文本
    const parts: string[] = [
      skill.metadata.name,
      skill.metadata.description,
    ];

    if (skill.metadata.tags && skill.metadata.tags.length > 0) {
      parts.push(skill.metadata.tags.join(' '));
    }

    // 添加触发词（如果有）
    if (skill.metadata.triggers && skill.metadata.triggers.length > 0) {
      const keywords = skill.metadata.triggers
        .filter(t => !t.startsWith('/') && !t.startsWith('!'))
        .slice(0, 5); // 只取前 5 个关键词
      if (keywords.length > 0) {
        parts.push(keywords.join(' '));
      }
    }

    return parts.join(' ');
  }

  /**
   * 获取 Skill 的嵌入向量（带缓存）
   */
  private async getSkillEmbedding(skill: Skill): Promise<number[] | null> {
    const description = this.getSkillDescription(skill);
    
    // 检查缓存
    if (this.config.cacheEnabled) {
      const cached = this.skillEmbeddings.get(skill.metadata.name);
      if (cached && 
          cached.description === description &&
          cached.skillModifiedAt.getTime() === skill.modifiedAt.getTime()) {
        // 检查 TTL
        const age = Date.now() - cached.createdAt.getTime();
        if (age < this.config.cacheTtlMs) {
          return cached.vector;
        }
      }
    }

    // 计算新的嵌入
    try {
      const result = await this.embeddingService.embed(description);
      
      // 缓存结果
      if (this.config.cacheEnabled) {
        this.skillEmbeddings.set(skill.metadata.name, {
          skillName: skill.metadata.name,
          description,
          vector: result.vector,
          createdAt: new Date(),
          skillModifiedAt: skill.modifiedAt,
        });
      }

      return result.vector;
    } catch (error) {
      logger.error('Failed to get skill embedding', {
        skill: skill.metadata.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 语义匹配
   * Requirements: 6.5
   */
  async match(message: string): Promise<SkillMatchResult | null> {
    if (!this.initialized) {
      logger.debug('SemanticMatcher not initialized, skipping semantic match');
      return null;
    }

    // 语义匹配超时时间（10秒）
    const SEMANTIC_MATCH_TIMEOUT = 10000;

    try {
      // 使用 Promise.race 添加超时机制
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Semantic match timeout after ${SEMANTIC_MATCH_TIMEOUT}ms`));
        }, SEMANTIC_MATCH_TIMEOUT);
      });

      const matchPromise = (async () => {
        // 获取消息的嵌入向量
        const messageResult = await this.embeddingService.embed(message);
        const messageVector = messageResult.vector;

        // 计算与所有 Skill 的相似度
        const scores = await this.computeSimilarities(messageVector);

        // 过滤低于阈值的结果
        const validScores = scores.filter(s => s.similarity >= this.config.similarityThreshold);

        if (validScores.length === 0) {
          logger.debug('No semantic matches above threshold', {
            threshold: this.config.similarityThreshold,
            maxSimilarity: scores.length > 0 ? scores[0].similarity : 0,
          });
          return null;
        }

        // 返回最佳匹配
        const best = validScores[0];
        
        logger.info('Semantic match found', {
          skill: best.skill.metadata.name,
          similarity: best.similarity,
          threshold: this.config.similarityThreshold,
        });

        return {
          skill: best.skill,
          confidence: best.similarity,
          matchType: SkillMatchType.SEMANTIC,
          matchReason: `语义相似度匹配 (${(best.similarity * 100).toFixed(1)}%)`,
        } as SkillMatchResult;
      })();

      return await Promise.race([matchPromise, timeoutPromise]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout')) {
        logger.warn('Semantic matching timeout, skipping', { timeout: SEMANTIC_MATCH_TIMEOUT });
      } else {
        logger.error('Semantic matching failed', { error: errorMessage });
      }
      return null;
    }
  }

  /**
   * 计算消息与所有 Skill 的相似度（并行计算提高性能）
   */
  private async computeSimilarities(messageVector: number[]): Promise<SemanticMatchScore[]> {
    const skills = this.registry.list({ enabled: true });
    
    // 并行获取所有 Skill 的嵌入向量
    const embeddingPromises = skills.map(async (skill) => {
      const skillVector = await this.getSkillEmbedding(skill);
      return { skill, skillVector };
    });

    const embeddingResults = await Promise.all(embeddingPromises);

    // 计算相似度
    const scores: SemanticMatchScore[] = [];
    for (const { skill, skillVector } of embeddingResults) {
      if (!skillVector) continue;

      const similarity = this.cosineSimilarity(messageVector, skillVector);
      
      scores.push({
        skill,
        similarity,
        matchedDescription: this.getSkillDescription(skill),
      });
    }

    // 按相似度降序排序，相似度相同时自定义 Skill 优先
    scores.sort((a, b) => {
      const simDiff = b.similarity - a.similarity;
      if (Math.abs(simDiff) > 0.01) return simDiff; // 相似度差异大于 1% 时按相似度排
      // 相似度接近时，自定义 Skill 优先
      if (a.skill.isBuiltin === b.skill.isBuiltin) return 0;
      return a.skill.isBuiltin ? 1 : -1;
    });

    return scores.slice(0, this.config.maxResults);
  }

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      logger.warn('Vector dimension mismatch', { aLen: a.length, bLen: b.length });
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * 获取多个匹配结果（用于调试和分析）
   */
  async matchMultiple(message: string, limit?: number): Promise<SemanticMatchScore[]> {
    if (!this.initialized) {
      return [];
    }

    try {
      const messageResult = await this.embeddingService.embed(message);
      const scores = await this.computeSimilarities(messageResult.vector);
      return scores.slice(0, limit || this.config.maxResults);
    } catch (error) {
      logger.error('Multiple semantic matching failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * 刷新 Skill 嵌入缓存
   */
  async refreshSkillEmbedding(skillName: string): Promise<void> {
    const skill = this.registry.get(skillName);
    if (!skill) {
      logger.warn('Skill not found for embedding refresh', { skillName });
      return;
    }

    // 删除旧缓存
    this.skillEmbeddings.delete(skillName);

    // 重新计算
    await this.getSkillEmbedding(skill);
    
    logger.info('Skill embedding refreshed', { skillName });
  }

  /**
   * 刷新所有 Skill 嵌入缓存
   */
  async refreshAllEmbeddings(): Promise<void> {
    this.skillEmbeddings.clear();
    await this.precomputeAllEmbeddings();
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.skillEmbeddings.clear();
    logger.info('Skill embedding cache cleared');
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; skills: string[] } {
    return {
      size: this.skillEmbeddings.size,
      skills: Array.from(this.skillEmbeddings.keys()),
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SemanticMatcherConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('SemanticMatcher config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): SemanticMatcherConfig {
    return { ...this.config };
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 检查 EmbeddingService 是否可用
   */
  isEmbeddingServiceAvailable(): boolean {
    return this.embeddingService.isInitialized();
  }
}
