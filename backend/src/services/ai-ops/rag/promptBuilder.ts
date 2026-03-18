/**
 * PromptBuilder - 提示词构建器
 * 
 * 构建智能提示词引导 LLM 正确使用知识
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1-8.5
 * - 7.1: 明确说明知识是参考而非指令
 * - 7.2: 要求 LLM 判断每条知识的适用性
 * - 7.3: 要求 LLM 使用 [KB-xxx] 格式引用使用的知识
 * - 7.4: 允许 LLM 质疑知识的正确性或时效性
 * - 7.5: 要求 LLM 结合设备实际状态验证知识
 * 
 * Few-Shot 经验注入 (Requirements: 2.3.2, 2.3.4)
 * - 2.3.2: 将检索到的经验注入为 Few-Shot 示例
 * - 2.3.4: 添加经验引用追溯
 */

import { logger } from '../../../utils/logger';
import { FormattedKnowledge } from './types/intelligentRetrieval';
import { ValidationResult } from './types/validation';
import { KnowledgeEntry } from './knowledgeBase';
import {
  PromptOptions,
  DEFAULT_PROMPT_OPTIONS,
  KNOWLEDGE_ENHANCED_PROMPT_TEMPLATE,
  CORRECTION_PROMPT_TEMPLATE,
  KnowledgeContextFormatOptions,
  DEFAULT_CONTEXT_FORMAT_OPTIONS,
} from './types/formatting';

/**
 * Few-Shot 经验格式化选项
 * Requirements: 2.3.2
 */
export interface FewShotOptions {
  /** 最大经验数量，默认 3 */
  maxExperiences?: number;
  /** 是否包含经验来源追溯，默认 true */
  includeSourceTracking?: boolean;
  /** 经验内容最大长度，默认 500 */
  maxExperienceLength?: number;
}

const DEFAULT_FEW_SHOT_OPTIONS: Required<FewShotOptions> = {
  maxExperiences: 3,
  includeSourceTracking: true,
  maxExperienceLength: 500,
};

/**
 * Few-Shot 经验模板
 * Requirements: 2.3.2
 */
const FEW_SHOT_TEMPLATE = `
## 历史成功案例（Few-Shot 示例）

以下是与当前问题相关的历史成功案例，供你参考：

{{experiences}}

**注意**：这些案例仅供参考，请根据当前实际情况进行调整。如果使用了案例中的方法，请使用 [EXP-xxx] 格式引用。
`;

/**
 * 提示词构建器类
 */
export class PromptBuilder {
  private defaultOptions: PromptOptions;
  private defaultFewShotOptions: Required<FewShotOptions>;

  constructor(options?: Partial<PromptOptions>, fewShotOptions?: Partial<FewShotOptions>) {
    this.defaultOptions = { ...DEFAULT_PROMPT_OPTIONS, ...options };
    this.defaultFewShotOptions = { ...DEFAULT_FEW_SHOT_OPTIONS, ...fewShotOptions };
    logger.debug('PromptBuilder created', { options: this.defaultOptions });
  }

  /**
   * 构建知识增强提示词
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
   * 
   * @param userQuery 用户查询
   * @param knowledge 格式化的知识列表
   * @param options 构建选项
   * @returns 完整提示词
   */
  buildKnowledgeEnhancedPrompt(
    userQuery: string,
    knowledge: FormattedKnowledge[],
    options?: Partial<PromptOptions>
  ): string {
    const opts = { ...this.defaultOptions, ...options };

    // 限制知识数量
    const limitedKnowledge = knowledge.slice(0, opts.maxKnowledgeCount);

    // 格式化知识上下文
    const knowledgeContext = this.formatKnowledgeContext(limitedKnowledge);

    // 构建提示词
    let prompt = KNOWLEDGE_ENHANCED_PROMPT_TEMPLATE
      .replace('{{knowledgeContext}}', knowledgeContext)
      .replace('{{userQuery}}', userQuery);

    // 添加额外指导
    const guidelines = this.buildGuidelines(opts);
    if (guidelines) {
      prompt += `\n\n## 额外指导\n${guidelines}`;
    }

    return prompt;
  }

  /**
   * 构建修正提示词
   * Requirements: 10.1
   * 
   * @param originalOutput 原始输出
   * @param validationResult 验证结果
   * @returns 修正提示词
   */
  buildCorrectionPrompt(
    originalOutput: string,
    validationResult: ValidationResult
  ): string {
    // 格式化错误信息
    const errorsText = validationResult.errors
      .slice(0, 5)
      .map((err, index) => {
        let errorDesc = `${index + 1}. `;
        switch (err.type) {
          case 'invalid_format':
            errorDesc += `格式错误: ${err.message}`;
            break;
          case 'missing_reference':
            errorDesc += `缺少引用: ${err.message}`;
            break;
          case 'unknown_id':
            errorDesc += `无效引用: ${err.message}`;
            if (err.reference) {
              errorDesc += ` (引用: ${err.reference})`;
            }
            break;
        }
        return errorDesc;
      })
      .join('\n');

    let prompt = CORRECTION_PROMPT_TEMPLATE
      .replace('{{errors}}', errorsText)
      .replace('{{originalOutput}}', originalOutput);

    // 添加有效引用示例
    if (validationResult.validReferences.length > 0) {
      const validRefs = validationResult.validReferences
        .map(r => r.fullText)
        .join(', ');
      prompt += `\n\n有效的引用示例: ${validRefs}`;
    }

    return prompt;
  }

  /**
   * 格式化知识上下文
   * Requirements: 6.1, 6.2
   * 
   * @param knowledge 知识列表
   * @param options 格式化选项
   * @returns 格式化的知识上下文字符串
   */
  formatKnowledgeContext(
    knowledge: FormattedKnowledge[],
    options?: Partial<KnowledgeContextFormatOptions>
  ): string {
    const opts = { ...DEFAULT_CONTEXT_FORMAT_OPTIONS, ...options };

    if (knowledge.length === 0) {
      return '暂无相关知识。';
    }

    const formattedItems = knowledge.map((k, index) => {
      const parts: string[] = [];

      // 标题和引用 ID
      parts.push(`### ${index + 1}. ${k.title}`);
      parts.push(`**引用 ID**: ${k.referenceId}`);

      // 可信度信息
      if (opts.includeCredibility) {
        const credibilityLabel = this.getCredibilityLabel(k.credibilityLevel);
        parts.push(`**可信度**: ${credibilityLabel} (${(k.credibilityScore * 100).toFixed(0)}%)`);
      }

      // 类型
      parts.push(`**类型**: ${this.getTypeLabel(k.type)}`);

      // 元数据
      if (opts.includeMetadata) {
        const metaInfo: string[] = [];
        if (k.metadata.category) {
          metaInfo.push(`分类: ${k.metadata.category}`);
        }
        if (k.metadata.tags && k.metadata.tags.length > 0) {
          metaInfo.push(`标签: ${k.metadata.tags.slice(0, 5).join(', ')}`);
        }
        if (k.metadata.timestamp) {
          const date = new Date(k.metadata.timestamp).toLocaleDateString('zh-CN');
          metaInfo.push(`时间: ${date}`);
        }
        if (metaInfo.length > 0) {
          parts.push(`**元数据**: ${metaInfo.join(' | ')}`);
        }
      }

      // 内容
      let content = k.fullContent;
      if (content.length > opts.maxContentLength) {
        content = content.substring(0, opts.maxContentLength) + '...[内容已截断]';
      }
      parts.push(`\n**内容**:\n${content}`);

      // 引用提示
      parts.push(`\n*${k.citationHint}*`);

      return parts.join('\n');
    });

    return formattedItems.join('\n\n---\n\n');
  }

  /**
   * 构建简洁的知识摘要（用于 ReAct 循环）
   * 
   * @param knowledge 知识列表
   * @returns 简洁的知识摘要
   */
  buildKnowledgeSummary(knowledge: FormattedKnowledge[]): string {
    if (knowledge.length === 0) {
      return '未找到相关知识。';
    }

    const summaries = knowledge.map((k, index) => {
      const credibility = this.getCredibilityLabel(k.credibilityLevel);
      return `${index + 1}. [${k.referenceId}] ${k.title} (${credibility})`;
    });

    return `找到 ${knowledge.length} 条相关知识:\n${summaries.join('\n')}`;
  }

  /**
   * 构建知识引用指南
   * Requirements: 7.3
   */
  buildCitationGuide(): string {
    return `
## 知识引用指南

当你使用知识库中的信息时，请遵循以下规则：

1. **引用格式**: 使用 [KB-xxx-xxxxxxxx] 格式引用知识，例如 [KB-alert-abc12345]
2. **引用位置**: 在使用知识内容的句子末尾添加引用
3. **多重引用**: 如果一个观点来自多条知识，可以同时引用多个，如 [KB-alert-abc12345][KB-remediation-def67890]
4. **不确定时**: 如果不确定是否应该引用，宁可多引用也不要遗漏

示例：
- "根据历史记录，该问题通常是由于配置错误导致的 [KB-alert-abc12345]。"
- "建议的解决方案是重启相关服务 [KB-remediation-def67890]。"
`;
  }

  // ==================== 私有方法 ====================

  /**
   * 构建额外指导
   */
  private buildGuidelines(opts: PromptOptions): string {
    const guidelines: string[] = [];

    if (opts.requireCitation) {
      guidelines.push('- 如果使用了知识库中的信息，必须使用 [KB-xxx] 格式进行引用');
    }

    if (opts.allowQuestioning) {
      guidelines.push('- 如果你认为某条知识可能过时或不适用于当前情况，请说明原因');
    }

    if (opts.requireApplicabilityCheck) {
      guidelines.push('- 在使用每条知识之前，请先评估其是否适用于当前问题');
    }

    if (opts.requireDeviceStateVerification) {
      guidelines.push('- 请结合设备的实际状态来验证知识的适用性，不要盲目套用');
    }

    return guidelines.join('\n');
  }

  /**
   * 获取可信度标签
   */
  private getCredibilityLabel(level: string): string {
    const labels: Record<string, string> = {
      high: '高可信度 ✓',
      medium: '中等可信度',
      low: '低可信度 ⚠',
    };
    return labels[level] || level;
  }

  /**
   * 获取类型标签
   */
  private getTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      alert: '告警记录',
      remediation: '修复方案',
      config: '配置知识',
      pattern: '故障模式',
      manual: '手动添加',
      feedback: '用户反馈',
      experience: '历史经验',
    };
    return labels[type] || type;
  }

  /**
   * 构建包含 Few-Shot 经验的知识增强提示词
   * Requirements: 2.3.2, 2.3.4
   * 
   * @param userQuery 用户查询
   * @param knowledge 格式化的知识列表
   * @param experiences 经验条目列表（用于 Few-Shot）
   * @param options 构建选项
   * @returns 完整提示词
   */
  buildKnowledgeEnhancedPromptWithExperiences(
    userQuery: string,
    knowledge: FormattedKnowledge[],
    experiences: KnowledgeEntry[],
    options?: Partial<PromptOptions & FewShotOptions>
  ): string {
    // 先构建基础的知识增强提示词
    let prompt = this.buildKnowledgeEnhancedPrompt(userQuery, knowledge, options);

    // 如果有经验，添加 Few-Shot 部分
    if (experiences.length > 0) {
      const fewShotSection = this.formatFewShotExperiences(experiences, options);
      // 在知识上下文之后、用户查询之前插入 Few-Shot 部分
      const queryMarker = '## 用户问题';
      const insertIndex = prompt.indexOf(queryMarker);
      if (insertIndex > 0) {
        prompt = prompt.slice(0, insertIndex) + fewShotSection + '\n\n' + prompt.slice(insertIndex);
      } else {
        // 如果找不到标记，直接追加
        prompt = fewShotSection + '\n\n' + prompt;
      }
    }

    return prompt;
  }

  /**
   * 格式化 Few-Shot 经验
   * Requirements: 2.3.2, 2.3.4
   * 
   * @param experiences 经验条目列表
   * @param options 格式化选项
   * @returns 格式化的 Few-Shot 部分
   */
  formatFewShotExperiences(
    experiences: KnowledgeEntry[],
    options?: Partial<FewShotOptions>
  ): string {
    const opts = { ...this.defaultFewShotOptions, ...options };

    if (experiences.length === 0) {
      return '';
    }

    // 限制经验数量
    const limitedExperiences = experiences.slice(0, opts.maxExperiences);

    const formattedExperiences = limitedExperiences.map((exp, index) => {
      const parts: string[] = [];

      // 经验标题和引用 ID
      const expRefId = `EXP-${exp.id.substring(0, 8)}`;
      parts.push(`### 案例 ${index + 1}: ${exp.title}`);
      parts.push(`**引用 ID**: ${expRefId}`);

      // 来源追溯
      if (opts.includeSourceTracking && exp.metadata.sourceSessionId) {
        parts.push(`**来源会话**: ${exp.metadata.sourceSessionId}`);
        if (exp.createdAt) {
          const date = new Date(exp.createdAt).toLocaleDateString('zh-CN');
          parts.push(`**记录时间**: ${date}`);
        }
      }

      // 经验内容
      let content = exp.content;
      if (content.length > opts.maxExperienceLength) {
        content = content.substring(0, opts.maxExperienceLength) + '...[内容已截断]';
      }
      parts.push(`\n**经验内容**:\n${content}`);

      // 标签
      if (exp.metadata.tags && exp.metadata.tags.length > 0) {
        parts.push(`\n**相关标签**: ${exp.metadata.tags.join(', ')}`);
      }

      return parts.join('\n');
    });

    return FEW_SHOT_TEMPLATE.replace('{{experiences}}', formattedExperiences.join('\n\n---\n\n'));
  }

  /**
   * 获取经验引用 ID
   * Requirements: 2.3.4
   * 
   * @param experienceId 经验条目 ID
   * @returns 格式化的引用 ID
   */
  getExperienceReferenceId(experienceId: string): string {
    return `EXP-${experienceId.substring(0, 8)}`;
  }

  /**
   * 构建经验引用指南
   * Requirements: 2.3.4
   */
  buildExperienceCitationGuide(): string {
    return `
## 经验引用指南

当你使用历史经验案例中的方法时，请遵循以下规则：

1. **引用格式**: 使用 [EXP-xxxxxxxx] 格式引用经验，例如 [EXP-abc12345]
2. **引用位置**: 在使用经验方法的句子末尾添加引用
3. **适应性说明**: 如果对经验方法进行了调整，请说明调整原因

示例：
- "根据历史案例，可以通过重启服务来解决此问题 [EXP-abc12345]。"
- "参考之前的处理经验，建议先检查配置文件 [EXP-def67890]，但需要根据当前版本进行调整。"
`;
  }
}

// 导出单例实例
export const promptBuilder = new PromptBuilder();
