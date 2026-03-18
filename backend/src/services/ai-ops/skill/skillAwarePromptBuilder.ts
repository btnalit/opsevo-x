/**
 * SkillAwarePromptBuilder - Skill 感知的提示词构建器
 * 
 * 扩展 PromptBuilder，支持 Skill 感知的提示词构建
 * 
 * Requirements: 9.1-9.7
 * - 9.1: SKILL.md 内容注入
 * - 9.2: 渐进式资源文件加载
 * - 9.3: 输出格式指令生成
 * - 9.4: 引用要求注入
 * - 9.5: Skill 特定指导
 * - 9.6: 工具使用指南
 * - 9.7: 知识优先级配置
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../utils/logger';
import { Skill } from '../../../types/skill';
import { PromptBuilder } from '../rag/promptBuilder';
import { FormattedKnowledge } from '../rag/types/intelligentRetrieval';
import { PromptOptions } from '../rag/types/formatting';
import { AgentTool } from '../rag/mastraAgent';

/**
 * Skill 增强提示词选项
 */
export interface SkillEnhancedPromptOptions extends PromptOptions {
  /** 是否包含 Skill 内容 */
  includeSkillContent?: boolean;
  /** 是否包含工具指南 */
  includeToolGuide?: boolean;
  /** 是否包含输出格式指令 */
  includeOutputFormat?: boolean;
  /** 是否加载资源文件 */
  loadResources?: boolean;
  /** 要加载的资源文件列表 */
  resourceFiles?: string[];
}

/**
 * 默认 Skill 增强选项
 */
const DEFAULT_SKILL_ENHANCED_OPTIONS: SkillEnhancedPromptOptions = {
  includeSkillContent: true,
  includeToolGuide: true,
  includeOutputFormat: true,
  loadResources: false,
  resourceFiles: [],
  requireCitation: true,
  allowQuestioning: true,
  requireApplicabilityCheck: true,
  requireDeviceStateVerification: true,
  maxKnowledgeCount: 5,
};

/**
 * SkillAwarePromptBuilder 类
 * Skill 感知的提示词构建器
 */
export class SkillAwarePromptBuilder extends PromptBuilder {
  private resourceCache: Map<string, string> = new Map();

  constructor(options?: Partial<PromptOptions>) {
    super(options);
    logger.debug('SkillAwarePromptBuilder created');
  }

  /**
   * 构建 Skill 增强的提示词
   * Requirements: 9.1-9.7
   * 
   * @param userQuery 用户查询
   * @param skill 当前 Skill
   * @param knowledge 格式化的知识列表
   * @param options 构建选项
   * @returns 完整提示词
   */
  async buildSkillEnhancedPrompt(
    userQuery: string,
    skill: Skill,
    knowledge: FormattedKnowledge[],
    options?: Partial<SkillEnhancedPromptOptions>
  ): Promise<string> {
    const opts = { ...DEFAULT_SKILL_ENHANCED_OPTIONS, ...options };
    const parts: string[] = [];

    // 1. Skill 系统提示词（SKILL.md 内容）
    // Requirements: 9.1
    if (opts.includeSkillContent) {
      parts.push(this.formatSkillContent(skill));
    }

    // 2. 工具使用指南
    // Requirements: 9.6
    if (opts.includeToolGuide && skill.config.allowedTools.length > 0) {
      parts.push(this.buildToolGuide(skill));
    }

    // 3. 加载资源文件（渐进式加载）
    // Requirements: 9.2
    if (opts.loadResources && opts.resourceFiles && opts.resourceFiles.length > 0) {
      const resources = await this.loadSkillResources(skill, opts.resourceFiles);
      if (resources) {
        parts.push(resources);
      }
    }

    // 4. 基础知识增强提示词
    const basePrompt = this.buildKnowledgeEnhancedPrompt(userQuery, knowledge, opts);
    parts.push(basePrompt);

    // 5. 输出格式要求
    // Requirements: 9.3
    if (opts.includeOutputFormat) {
      parts.push(this.buildOutputFormatInstructions(skill.config.outputFormat));
    }

    // 6. 引用要求
    // Requirements: 9.4
    if (skill.config.requireCitations) {
      parts.push(this.buildCitationGuide());
    }

    return parts.join('\n\n');
  }

  /**
   * 格式化 Skill 内容
   * Requirements: 9.1
   */
  private formatSkillContent(skill: Skill): string {
    const parts: string[] = [];

    // 角色标题
    parts.push(`## 当前角色: ${skill.metadata.name}`);
    parts.push('');

    // 描述
    parts.push(skill.metadata.description);
    parts.push('');

    // 分隔线
    parts.push('---');
    parts.push('');

    // SKILL.md 主体内容
    parts.push(skill.content);

    return parts.join('\n');
  }

  /**
   * 构建工具使用指南
   * Requirements: 9.6
   */
  private buildToolGuide(skill: Skill): string {
    const parts: string[] = [];

    parts.push('## 工具使用指南');
    parts.push('');

    // 可用工具列表
    parts.push('### 可用工具');
    const allowedTools = skill.config.allowedTools;
    if (allowedTools.length > 0) {
      parts.push(`本角色可使用以下工具: ${allowedTools.join(', ')}`);
    } else {
      parts.push('本角色可使用所有可用工具。');
    }
    parts.push('');

    // 工具优先级
    if (skill.config.toolPriority && skill.config.toolPriority.length > 0) {
      parts.push('### 工具优先级');
      parts.push('请按以下优先级顺序考虑使用工具:');
      skill.config.toolPriority.forEach((tool, index) => {
        parts.push(`${index + 1}. ${tool}`);
      });
      parts.push('');
    }

    // 工具默认参数
    if (Object.keys(skill.config.toolDefaults).length > 0) {
      parts.push('### 工具默认参数');
      for (const [toolName, defaults] of Object.entries(skill.config.toolDefaults)) {
        parts.push(`- **${toolName}**: ${JSON.stringify(defaults)}`);
      }
      parts.push('');
    }

    // 工具约束
    if (Object.keys(skill.config.toolConstraints).length > 0) {
      parts.push('### 工具约束');
      for (const [toolName, constraints] of Object.entries(skill.config.toolConstraints)) {
        parts.push(`- **${toolName}**:`);
        for (const [paramName, constraint] of Object.entries(constraints)) {
          const constraintDesc: string[] = [];
          if (constraint.defaultValue !== undefined) {
            constraintDesc.push(`默认值: ${constraint.defaultValue}`);
          }
          if (constraint.allowedValues) {
            constraintDesc.push(`允许值: ${constraint.allowedValues.join(', ')}`);
          }
          if (constraint.required) {
            constraintDesc.push('必需');
          }
          parts.push(`  - ${paramName}: ${constraintDesc.join(', ')}`);
        }
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * 构建输出格式指令
   * Requirements: 9.3
   */
  private buildOutputFormatInstructions(format: string): string {
    const parts: string[] = [];

    parts.push('## 输出格式要求');
    parts.push('');

    switch (format) {
      case 'structured':
        parts.push('请使用结构化格式输出：');
        parts.push('');
        parts.push('1. **问题分析**：简要描述问题');
        parts.push('2. **诊断过程**：列出诊断步骤和发现');
        parts.push('3. **根本原因**：指出问题的根本原因');
        parts.push('4. **解决方案**：提供具体的解决步骤');
        parts.push('5. **预防建议**：给出预防措施');
        break;

      case 'concise':
        parts.push('请简洁回答，控制在 200 字以内，直接给出结论和建议。');
        break;

      case 'detailed':
      default:
        parts.push('请详细回答，包含完整的分析过程和解决方案。');
        break;
    }

    return parts.join('\n');
  }

  /**
   * 加载 Skill 资源文件
   * Requirements: 9.2
   */
  async loadSkillResources(skill: Skill, filenames: string[]): Promise<string | null> {
    const loadedResources: string[] = [];

    for (const filename of filenames) {
      // 检查文件是否在 Skill 目录中
      if (!skill.files.includes(filename)) {
        logger.warn('Resource file not found in Skill', {
          skill: skill.metadata.name,
          filename,
        });
        continue;
      }

      // 检查缓存
      const cacheKey = `${skill.path}/${filename}`;
      let content = this.resourceCache.get(cacheKey);

      if (!content) {
        try {
          const resourcePath = path.join(skill.path, filename);
          content = await fs.readFile(resourcePath, 'utf-8');
          this.resourceCache.set(cacheKey, content);
        } catch (error) {
          logger.warn('Failed to load Skill resource', {
            skill: skill.metadata.name,
            filename,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      loadedResources.push(`### 参考文档: ${filename}\n\n${content}`);
    }

    if (loadedResources.length === 0) {
      return null;
    }

    return `## 附加参考资料\n\n${loadedResources.join('\n\n---\n\n')}`;
  }

  /**
   * 加载单个 Skill 资源文件
   */
  async loadSkillResource(skill: Skill, filename: string): Promise<string | null> {
    if (!skill.files.includes(filename)) {
      return null;
    }

    const cacheKey = `${skill.path}/${filename}`;
    let content = this.resourceCache.get(cacheKey);

    if (!content) {
      try {
        const resourcePath = path.join(skill.path, filename);
        content = await fs.readFile(resourcePath, 'utf-8');
        this.resourceCache.set(cacheKey, content);
      } catch (error) {
        logger.warn('Failed to load Skill resource', {
          skill: skill.metadata.name,
          filename,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    return content;
  }

  /**
   * 清除资源缓存
   */
  clearResourceCache(): void {
    this.resourceCache.clear();
  }

  /**
   * 构建工具详细描述（包含参数信息）
   * Requirements: 9.6
   * 
   * 格式与 RALC 中的工具描述格式一致
   * 
   * @param tools 工具列表
   * @returns 格式化的工具描述字符串
   */
  buildToolDescriptions(tools: AgentTool[]): string {
    if (tools.length === 0) {
      return '当前没有可用工具。';
    }

    return tools.map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => {
          const required = info.required ? ', 必需' : '';
          return `    - ${name} (${info.type}${required}): ${info.description}`;
        })
        .join('\n');
      return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
    }).join('\n\n');
  }

  /**
   * 构建 Skill 特定的知识优先级提示
   * Requirements: 9.7
   */
  buildKnowledgePriorityHint(skill: Skill): string {
    const config = skill.config.knowledgeConfig;
    if (!config.enabled) {
      return '';
    }

    const parts: string[] = [];
    parts.push('## 知识检索优先级');
    parts.push('');

    if (config.priorityTypes && config.priorityTypes.length > 0) {
      parts.push('请优先参考以下类型的知识:');
      config.priorityTypes.forEach((type, index) => {
        const typeLabel = this.getKnowledgeTypeLabel(type);
        parts.push(`${index + 1}. ${typeLabel}`);
      });
      parts.push('');
    }

    if (config.minScore > 0) {
      parts.push(`注意: 只考虑相关度高于 ${(config.minScore * 100).toFixed(0)}% 的知识。`);
    }

    return parts.join('\n');
  }

  /**
   * 获取知识类型标签
   */
  private getKnowledgeTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      alert: '告警记录',
      remediation: '修复方案',
      config: '配置知识',
      pattern: '故障模式',
      manual: '手动添加',
      feedback: '用户反馈',
    };
    return labels[type] || type;
  }
}

// 导出单例实例
export const skillAwarePromptBuilder = new SkillAwarePromptBuilder();
