/**
 * SkillRouter - LLM 智能 Skill 路由器
 * 
 * 两阶段智能匹配：
 * 1. 预筛选：用语义匹配找出候选 Skill
 * 2. LLM 精选：让 LLM 从候选中选择最合适的
 * 
 * Requirements: 6.5+
 */

import { logger } from '../../../utils/logger';
import { Skill, SkillMatchType, SkillMatchResult } from '../../../types/skill';
import { IAIProviderAdapter, ChatRequest, AIProvider } from '../../../types/ai';
import { SkillRegistry } from './skillRegistry';
import { SkillSemanticMatcher } from './skillSemanticMatcher';

/**
 * AI 适配器工厂函数类型
 */
export type AIAdapterFactory = () => Promise<{
  adapter: IAIProviderAdapter;
  provider: AIProvider;
  model: string;
} | null>;

/**
 * Skill 路由配置
 */
export interface SkillRouterConfig {
  /** 预筛选候选数量 */
  candidateCount: number;
  /** LLM 路由超时（毫秒） */
  timeout: number;
  /** 是否启用 LLM 路由 */
  enableLLMRouting: boolean;
  /** 最低置信度阈值，低于此值使用 generalist */
  minConfidence: number;
  /** LLM 调用最大重试次数 */
  maxRetries: number;
  /** 重试间隔（毫秒） */
  retryDelayMs: number;
}

const DEFAULT_CONFIG: SkillRouterConfig = {
  candidateCount: 5,
  timeout: 10000,
  enableLLMRouting: true,
  minConfidence: 0.6,
  maxRetries: 2,
  retryDelayMs: 500,
};

/**
 * LLM 路由结果
 */
interface LLMRoutingResult {
  skillName: string;
  confidence: number;
  reason: string;
}

/**
 * SkillRouter 类
 */
export class SkillRouter {
  private config: SkillRouterConfig;
  private registry: SkillRegistry;
  private semanticMatcher: SkillSemanticMatcher | null = null;
  private aiAdapter: IAIProviderAdapter | null = null;
  private provider: AIProvider = AIProvider.OPENAI;
  private model: string = 'gpt-4o-mini';
  private adapterFactory: AIAdapterFactory | null = null;

  constructor(registry: SkillRegistry, config?: Partial<SkillRouterConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('SkillRouter created', { config: this.config });
  }

  /**
   * 设置语义匹配器
   */
  setSemanticMatcher(matcher: SkillSemanticMatcher): void {
    this.semanticMatcher = matcher;
  }

  /**
   * 设置 AI 适配器
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model?: string): void {
    this.aiAdapter = adapter;
    this.provider = provider;
    if (model) this.model = model;
    logger.info('SkillRouter AI adapter set', { provider, model: this.model });
  }

  /**
   * 设置 AI 适配器工厂（延迟获取）
   */
  setAIAdapterFactory(factory: AIAdapterFactory): void {
    this.adapterFactory = factory;
    logger.info('SkillRouter AI adapter factory set');
  }

  /**
   * 获取 AI 适配器（优先使用已设置的，否则通过工厂获取）
   */
  private async getAIAdapter(): Promise<{
    adapter: IAIProviderAdapter;
    provider: AIProvider;
    model: string;
  } | null> {
    if (this.aiAdapter) {
      return {
        adapter: this.aiAdapter,
        provider: this.provider,
        model: this.model,
      };
    }
    
    if (this.adapterFactory) {
      try {
        return await this.adapterFactory();
      } catch (error) {
        logger.warn('Failed to get AI adapter from factory', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    
    return null;
  }

  /**
   * 智能路由 - 选择最合适的 Skill
   */
  async route(message: string, currentSkill?: Skill): Promise<SkillMatchResult> {
    try {
      // 阶段 1：预筛选候选 Skill
      const candidates = await this.preselectCandidates(message);
      
      if (candidates.length === 0) {
        logger.info('No candidates found, using generalist');
        return this.getGeneralistResult();
      }

      // 如果只有一个候选且置信度高，直接返回
      if (candidates.length === 1 && candidates[0].similarity > 0.8) {
        return this.toMatchResult(candidates[0], SkillMatchType.SEMANTIC);
      }

      // 阶段 2：LLM 精选
      if (this.config.enableLLMRouting) {
        const adapterInfo = await this.getAIAdapter();
        if (adapterInfo) {
          const llmResult = await this.llmSelect(message, candidates, currentSkill, adapterInfo);
          if (llmResult && llmResult.confidence >= this.config.minConfidence) {
            const skill = this.registry.get(llmResult.skillName);
            if (skill) {
              return {
                skill,
                confidence: llmResult.confidence,
                matchType: SkillMatchType.INTENT,
                matchReason: llmResult.reason,
              };
            }
          }
        }
      }

      // 回退：返回语义匹配最高的
      if (candidates.length > 0 && candidates[0].similarity >= this.config.minConfidence) {
        return this.toMatchResult(candidates[0], SkillMatchType.SEMANTIC);
      }

      return this.getGeneralistResult();
    } catch (error) {
      logger.error('Skill routing failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.getGeneralistResult();
    }
  }


  /**
   * 阶段 1：预筛选候选 Skill
   * 使用语义匹配 + 标签匹配快速筛选
   */
  private async preselectCandidates(message: string): Promise<CandidateSkill[]> {
    const candidates: CandidateSkill[] = [];
    const seenSkills = new Set<string>();

    // 1. 语义匹配（如果可用）
    if (this.semanticMatcher?.isInitialized()) {
      try {
        const semanticResults = await this.semanticMatcher.matchMultiple(message, this.config.candidateCount);
        for (const result of semanticResults) {
          if (!seenSkills.has(result.skill.metadata.name)) {
            candidates.push({
              skill: result.skill,
              similarity: result.similarity,
              source: 'semantic',
            });
            seenSkills.add(result.skill.metadata.name);
          }
        }
      } catch (error) {
        logger.warn('Semantic preselection failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 2. 标签/关键词匹配补充
    const enabledSkills = this.registry.list({ enabled: true });
    const lowerMessage = message.toLowerCase();
    
    for (const skill of enabledSkills) {
      if (seenSkills.has(skill.metadata.name)) continue;
      if (candidates.length >= this.config.candidateCount * 2) break;

      // 检查标签匹配
      const tags = skill.metadata.tags || [];
      const tagMatch = tags.some(tag => lowerMessage.includes(tag.toLowerCase()));
      
      // 检查描述关键词匹配
      const descWords = skill.metadata.description.toLowerCase().split(/\s+/);
      const descMatch = descWords.some(word => word.length > 2 && lowerMessage.includes(word));

      if (tagMatch || descMatch) {
        candidates.push({
          skill,
          similarity: tagMatch ? 0.5 : 0.3,
          source: 'keyword',
        });
        seenSkills.add(skill.metadata.name);
      }
    }

    // 按相似度排序，取前 N 个
    candidates.sort((a, b) => b.similarity - a.similarity);
    return candidates.slice(0, this.config.candidateCount);
  }

  /**
   * 阶段 2：LLM 精选（带重试机制）
   */
  private async llmSelect(
    message: string,
    candidates: CandidateSkill[],
    currentSkill?: Skill,
    adapterInfo?: { adapter: IAIProviderAdapter; provider: AIProvider; model: string }
  ): Promise<LLMRoutingResult | null> {
    if (!adapterInfo || candidates.length === 0) return null;

    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info('Retrying LLM skill selection', { attempt, maxRetries: this.config.maxRetries });
          await this.delay(this.config.retryDelayMs * attempt); // 指数退避
        }

        const prompt = this.buildRoutingPrompt(message, candidates, currentSkill);
        
        const request: ChatRequest = {
          provider: adapterInfo.provider,
          model: adapterInfo.model,
          messages: [
            {
              role: 'system',
              content: '你是一个 Skill 路由助手。根据用户请求选择最合适的专家 Skill。只返回 JSON，不要其他文字。',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          stream: false,
          temperature: 0.1,
          maxTokens: 200,
        };

        // 带超时的调用
        const response = await Promise.race([
          adapterInfo.adapter.chat(request),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('LLM routing timeout')), this.config.timeout)
          ),
        ]);

        const result = this.parseRoutingResponse(response.content, candidates);
        if (result) {
          return result;
        }
        
        // 解析失败，继续重试
        lastError = new Error('Failed to parse LLM response');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // 超时错误不重试
        if (lastError.message.includes('timeout')) {
          logger.warn('LLM routing timeout, not retrying', { attempt });
          break;
        }
      }
    }

    logger.warn('LLM skill selection failed after retries', {
      attempts: this.config.maxRetries + 1,
      error: lastError?.message,
    });
    return null;
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 构建路由提示词
   */
  private buildRoutingPrompt(
    message: string,
    candidates: CandidateSkill[],
    currentSkill?: Skill
  ): string {
    const skillList = candidates.map((c, i) => 
      `${i + 1}. ${c.skill.metadata.name}: ${c.skill.metadata.description}`
    ).join('\n');

    const contextInfo = currentSkill 
      ? `\n当前正在使用: ${currentSkill.metadata.name}` 
      : '';

    return `用户请求: "${message}"
${contextInfo}

可选专家 Skill:
${skillList}

请选择最合适的 Skill 处理此请求。返回 JSON:
{
  "skillName": "选择的skill名称",
  "confidence": 0.0-1.0,
  "reason": "选择原因（简短）"
}

如果没有合适的，返回 skillName 为 "generalist"。`;
  }

  /**
   * 解析路由响应
   */
  private parseRoutingResponse(
    response: string,
    candidates: CandidateSkill[]
  ): LLMRoutingResult | null {
    try {
      // 提取 JSON
      let jsonStr = response.trim();
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonStr);
      
      // 验证 skillName 是否在候选列表中
      const validNames = new Set([
        ...candidates.map(c => c.skill.metadata.name),
        'generalist',
      ]);

      if (!validNames.has(parsed.skillName)) {
        logger.warn('LLM returned invalid skill name', { 
          returned: parsed.skillName,
          valid: Array.from(validNames),
        });
        return null;
      }

      return {
        skillName: parsed.skillName,
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.7)),
        reason: parsed.reason || 'LLM 推荐',
      };
    } catch (error) {
      logger.warn('Failed to parse LLM routing response', {
        response: response.substring(0, 200),
      });
      return null;
    }
  }

  /**
   * 转换为 SkillMatchResult
   */
  private toMatchResult(candidate: CandidateSkill, matchType: SkillMatchType): SkillMatchResult {
    return {
      skill: candidate.skill,
      confidence: candidate.similarity,
      matchType,
      matchReason: `${candidate.source} 匹配 (${(candidate.similarity * 100).toFixed(1)}%)`,
    };
  }

  /**
   * 获取 generalist 结果
   */
  private getGeneralistResult(): SkillMatchResult {
    const generalist = this.registry.get('generalist');
    if (!generalist) {
      throw new Error('Generalist skill not found');
    }
    return {
      skill: generalist,
      confidence: 0.5,
      matchType: SkillMatchType.FALLBACK,
      matchReason: '使用通用助手',
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SkillRouterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): SkillRouterConfig {
    return { ...this.config };
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.semanticMatcher?.isInitialized() || 
           this.aiAdapter !== null || 
           this.adapterFactory !== null;
  }
}

/**
 * 候选 Skill
 */
interface CandidateSkill {
  skill: Skill;
  similarity: number;
  source: 'semantic' | 'keyword' | 'trigger';
}
