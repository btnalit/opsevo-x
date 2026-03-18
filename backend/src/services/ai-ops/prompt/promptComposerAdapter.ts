/**
 * PromptComposerAdapter - Prompt 组合器适配层
 *
 * 提供与现有 PromptBuilder、SkillAwarePromptBuilder 和 PromptTemplateService
 * 兼容的接口，将模块化 Prompt 组合能力适配到现有调用方。
 *
 * 核心职责：
 * - 为每种 Prompt 场景选择正确的模块组合
 * - 集成 PromptTemplateService 自定义模板优先逻辑
 * - 提供与 PromptBuilder.buildKnowledgeEnhancedPrompt 签名兼容的方法
 *
 * @see Requirements 6.1 - 兼容 PromptBuilder.buildKnowledgeEnhancedPrompt 签名
 * @see Requirements 6.2 - 支持 SkillAwarePromptBuilder 的 Skill 内容注入
 * @see Requirements 6.3 - PromptTemplateService 自定义模板优先
 * @see Requirements 6.4 - PromptComposer 初始化失败时回退到原始单体模板
 */

import { PromptComposer } from './promptComposer';
import { PromptModule } from './types';
import { logger } from '../../../utils/logger';
import type { VectorStoreClient, VectorSearchResult } from '../rag/vectorStoreClient';
import type { DeviceDriverManager } from '../../device/deviceDriverManager';
import type { CapabilityManifest, CommandPattern } from '../../../types/device-driver';
import {
  LEGACY_REACT_LOOP_PROMPT,
  LEGACY_KNOWLEDGE_FIRST_REACT_PROMPT,
  LEGACY_PARALLEL_REACT_PROMPT,
  LEGACY_ALERT_ANALYSIS_PROMPT,
  LEGACY_BATCH_ALERT_ANALYSIS_PROMPT,
  LEGACY_HEALTH_REPORT_ANALYSIS_PROMPT,
  LEGACY_CONFIG_DIFF_ANALYSIS_PROMPT,
  LEGACY_FAULT_DIAGNOSIS_PROMPT,
  replaceLegacyTemplateVars,
} from './legacyTemplates';
import { basePersona } from './modules/basePersona';
import { reActFormat } from './modules/reActFormat';
import { apiSafety } from './modules/apiSafety';
import { batchProtocol } from './modules/batchProtocol';
import { knowledgeGuide } from './modules/knowledgeGuide';
import { deviceInfo } from './modules/deviceInfo';
import { parallelFormat } from './modules/parallelFormat';
import { operationalRules } from './modules/operationalRules';
import {
  chainOfThought,
  ALERT_ANALYSIS_STEPS,
  BATCH_ANALYSIS_STEPS,
  HEALTH_REPORT_STEPS,
  CONFIG_CHANGE_STEPS,
  FAULT_DIAGNOSIS_STEPS,
  ChainOfThoughtStep,
} from './modules/chainOfThought';
import {
  jsonSchema,
  ALERT_ANALYSIS_SCHEMA,
  BATCH_ANALYSIS_SCHEMA,
  HEALTH_REPORT_SCHEMA,
  CONFIG_CHANGE_SCHEMA,
  FAULT_DIAGNOSIS_SCHEMA,
  JsonSchemaField,
} from './modules/jsonSchema';
import { FormattedKnowledge } from '../rag/types/intelligentRetrieval';
import { PromptOptions, DEFAULT_PROMPT_OPTIONS, KNOWLEDGE_ENHANCED_PROMPT_TEMPLATE } from '../rag/types/formatting';

/**
 * PromptTemplateService 的最小接口
 *
 * 适配器不直接依赖完整的 PromptTemplateService，
 * 而是通过此接口接受可选的模板服务，实现松耦合。
 */
export interface TemplateServiceLike {
  getTemplateContent(name: string, fallback?: string): Promise<string>;
  renderContent(content: string, context: Record<string, unknown>): string;
}

/**
 * 创建一个专用的 ChainOfThought 模块实例，使用指定的步骤集
 *
 * 由于 PromptComposer.compose() 调用 render() 时不传 context，
 * 需要创建包装模块来固定步骤集。
 */
function createChainOfThoughtModule(steps: ChainOfThoughtStep[]): PromptModule {
  return {
    name: 'ChainOfThought',
    tokenBudget: chainOfThought.tokenBudget,
    dependencies: chainOfThought.dependencies,
    templateName: chainOfThought.templateName,
    render(): string {
      return chainOfThought.render({ steps });
    },
  };
}

/**
 * 创建一个专用的 JsonSchema 模块实例，使用指定的 Schema
 *
 * 由于 PromptComposer.compose() 调用 render() 时不传 context，
 * 需要创建包装模块来固定 Schema。
 */
function createJsonSchemaModule(schema: JsonSchemaField[]): PromptModule {
  return {
    name: 'JsonSchema',
    tokenBudget: jsonSchema.tokenBudget,
    dependencies: jsonSchema.dependencies,
    templateName: jsonSchema.templateName,
    render(): string {
      return jsonSchema.render({ schema });
    },
  };
}


/**
 * 分析类型到模块配置的映射
 */
interface AnalysisConfig {
  /** ChainOfThought 步骤集 */
  steps: ChainOfThoughtStep[];
  /** JsonSchema 字段定义 */
  schema: JsonSchemaField[];
  /** PromptTemplateService 中的模板名称 */
  templateName: string;
}

const ANALYSIS_CONFIGS: Record<string, AnalysisConfig> = {
  alertAnalysis: {
    steps: ALERT_ANALYSIS_STEPS,
    schema: ALERT_ANALYSIS_SCHEMA,
    templateName: '告警分析提示词',
  },
  batchAlertAnalysis: {
    steps: BATCH_ANALYSIS_STEPS,
    schema: BATCH_ANALYSIS_SCHEMA,
    templateName: '批量告警分析提示词',
  },
  healthReportAnalysis: {
    steps: HEALTH_REPORT_STEPS,
    schema: HEALTH_REPORT_SCHEMA,
    templateName: '健康报告分析提示词',
  },
  configDiffAnalysis: {
    steps: CONFIG_CHANGE_STEPS,
    schema: CONFIG_CHANGE_SCHEMA,
    templateName: '配置变更分析提示词',
  },
  faultDiagnosis: {
    steps: FAULT_DIAGNOSIS_STEPS,
    schema: FAULT_DIAGNOSIS_SCHEMA,
    templateName: '故障诊断提示词',
  },
};

/**
 * PromptComposerAdapter
 *
 * 适配层，将模块化 PromptComposer 的能力适配到现有调用方接口。
 * 为每种 Prompt 场景选择正确的模块组合，并支持自定义模板优先。
 */
export class PromptComposerAdapter {
  /**
   * 模块自定义内容缓存
   *
   * 存储从 PromptTemplateService 异步加载的模块子模板内容，
   * 供 getModuleContent() 同步访问。缓存在构造时异步预加载。
   *
   * @see Requirements 7.5 - 使用用户自定义的模块内容替代默认硬编码内容
   * @see Requirements 7.6 - 未自定义时使用默认模块内容
   */
  private moduleContentCache: Map<string, string> = new Map();

  private readyPromise: Promise<void>;

  /** 可选的向量存储客户端，用于从 prompt_knowledge 检索 Prompt 片段 (F1.3) */
  private vectorClient?: VectorStoreClient;
  /** 可选的设备驱动管理器，用于注入 CapabilityManifest (F1.4) */
  private deviceDriverManager?: DeviceDriverManager;

  /**
   * @param _composer - 已弃用：此参数不再使用，各 build 方法内部创建自己的 PromptComposer 实例。
   *                    保留参数以维持向后兼容，将在下一个主版本中移除。
   * @param templateService - 可选的模板服务，用于自定义模板优先逻辑
   * @param options - 可选的依赖注入选项
   */
  constructor(
    private _composer: PromptComposer,
    private templateService?: TemplateServiceLike,
    options?: {
      vectorClient?: VectorStoreClient;
      deviceDriverManager?: DeviceDriverManager;
    }
  ) {
    this.vectorClient = options?.vectorClient;
    this.deviceDriverManager = options?.deviceDriverManager;
    // 异步预加载模块自定义内容到缓存
    this.readyPromise = this.preloadModuleContent();
  }

  /**
   * 等待模块自定义内容预加载完成
   *
   * 调用方可在首次构建 Prompt 前 await 此方法，
   * 确保所有自定义模块内容已加载到缓存中。
   *
   * @see Requirements 7.5 - 自定义模块内容优先
   */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * 注入动态运行时上下文 (如工具反馈、批评建议)
   * 支持通过包装内部的 PromptComposer 实例调用
   */
  injectContext(prompt: string, context: import('./types').DynamicContext): string {
    const composer = new PromptComposer([]);
    return composer.injectContext(prompt, context);
  }

  /**
   * 异步预加载所有模块的自定义子模板内容到缓存
   *
   * 在构造时触发，不阻塞构造过程。加载完成后，
   * getModuleContent() 即可同步访问自定义内容。
   * 加载失败时静默忽略，使用模块默认 render() 输出。
   *
   * @see Requirements 7.5 - 自定义模块内容优先
   */
  private async preloadModuleContent(): Promise<void> {
    if (!this.templateService) return;

    const allModules: PromptModule[] = [
      basePersona, reActFormat, apiSafety, batchProtocol,
      knowledgeGuide, deviceInfo, parallelFormat, chainOfThought,
      operationalRules,
    ];

    const promises = allModules
      .filter(mod => mod.templateName)
      .map(async (mod) => {
        const templateName = mod.templateName!;
        try {
          const content = await this.templateService!.getTemplateContent(templateName, '');
          // 仅缓存非空的自定义内容
          if (content && content.trim().length > 0) {
            this.moduleContentCache.set(templateName, content);
          }
        } catch {
          // 加载失败时静默忽略，getModuleContent 将回退到 mod.render()
        }
      });

    await Promise.all(promises);
  }

  /**
   * 获取模块内容（同步）
   *
   * 优先从缓存中获取用户自定义的子模板内容，
   * 若无自定义内容则使用模块默认的 render() 输出。
   *
   * @param mod - Prompt 模块
   * @returns 模块内容字符串（自定义内容或默认 render 输出）
   *
   * @see Requirements 7.5 - 用户自定义模块内容替代默认硬编码内容
   * @see Requirements 7.6 - 未自定义时使用默认模块内容
   */
  getModuleContent(mod: PromptModule): string {
    if (this.templateService && mod.templateName) {
      const cached = this.moduleContentCache.get(mod.templateName);
      if (cached && cached.trim().length > 0) {
        return cached;
      }
    }
    return mod.render();
  }

  /**
   * 将模块列表包装为使用自定义内容的版本
   *
   * 创建模块的代理对象，使其 render() 方法通过 getModuleContent()
   * 优先返回用户自定义内容。这样 PromptComposer.compose() 在调用
   * render() 时会自动使用自定义内容。
   *
   * @param modules - 原始模块列表
   * @returns 包装后的模块列表
   */
  private wrapModulesWithCustomContent(modules: PromptModule[]): PromptModule[] {
    return modules.map(mod => ({
      name: mod.name,
      tokenBudget: mod.tokenBudget,
      dependencies: mod.dependencies,
      templateName: mod.templateName,
      render: () => this.getModuleContent(mod),
    }));
  }

  /**
   * 构建知识增强提示词
   *
   * 兼容 PromptBuilder.buildKnowledgeEnhancedPrompt 签名。
   * 使用 BasePersona + DeviceInfo + KnowledgeGuide 模块组合，
   * 然后格式化知识上下文并附加用户查询。
   *
   * @param userQuery - 用户查询
   * @param knowledge - 格式化的知识列表
   * @param options - 构建选项
   * @returns 完整的知识增强提示词
   *
   * @see Requirements 6.1 - 兼容 PromptBuilder.buildKnowledgeEnhancedPrompt 签名
   */
  buildKnowledgeEnhancedPrompt(
    userQuery: string,
    knowledge: FormattedKnowledge[],
    options?: Partial<PromptOptions>
  ): string {
    try {
      const opts = { ...DEFAULT_PROMPT_OPTIONS, ...options };

      // 限制知识数量
      const limitedKnowledge = knowledge.slice(0, opts.maxKnowledgeCount);

      // 格式化知识上下文
      const knowledgeContext = this.formatKnowledgeContext(limitedKnowledge);

      // 使用模块组合构建基础 Prompt（支持模块级自定义内容）
      const modules: PromptModule[] = [basePersona, deviceInfo, knowledgeGuide];
      const wrappedModules = this.wrapModulesWithCustomContent(modules);
      const baseComposer = new PromptComposer(wrappedModules);
      const basePrompt = baseComposer.compose();

      // 构建知识增强部分
      let prompt = KNOWLEDGE_ENHANCED_PROMPT_TEMPLATE
        .replace('{{knowledgeContext}}', knowledgeContext)
        .replace('{{userQuery}}', userQuery);

      // 将模块化基础 Prompt 与知识增强模板组合
      prompt = basePrompt + '\n\n' + prompt;

      // 添加额外指导
      const guidelines = this.buildGuidelines(opts);
      if (guidelines) {
        prompt += `\n\n## 额外指导\n${guidelines}`;
      }

      return prompt;
    } catch (error) {
      logger.error('PromptComposer failed in buildKnowledgeEnhancedPrompt, falling back to legacy template', { error });
      // 回退到基本的知识增强模板
      const knowledgeContext = this.formatKnowledgeContext(knowledge);
      return KNOWLEDGE_ENHANCED_PROMPT_TEMPLATE
        .replace('{{knowledgeContext}}', knowledgeContext)
        .replace('{{userQuery}}', userQuery);
    }
  }

  /**
   * 构建 ReAct Prompt（替代 REACT_LOOP_PROMPT）
   *
   * 模块组合：BasePersona + DeviceInfo + ReActFormat + APISafety + BatchProtocol
   *
   * @param message - 用户请求消息
   * @param tools - 可用工具列表
   * @param steps - 已执行的步骤
   * @param ragContext - 可选的 RAG 上下文
   * @returns 完整的 ReAct Prompt
   *
   * @see Requirements 1.7 - REACT_LOOP_PROMPT 模块化重构
   */
  buildReActPrompt(
    message: string,
    tools: string,
    steps: string,
    ragContext?: string
  ): string {
    try {
      // 检查自定义模板优先
      // 注意：templateService 方法是异步的，但此方法是同步的
      // 自定义模板优先逻辑在异步版本中处理

      const modules: PromptModule[] = [
        basePersona,
        deviceInfo,
        reActFormat,
        apiSafety,
        batchProtocol,
      ];

      const variables: Record<string, string> = {
        message,
        tools,
        steps,
      };

      if (ragContext) {
        variables.ragContext = ragContext;
      }

      // 使用包装后的模块以支持模块级自定义内容
      const reActComposer = new PromptComposer(this.wrapModulesWithCustomContent(modules));
      let prompt = reActComposer.compose({ variables });

      // 附加用户请求和工具信息部分
      prompt += this.buildReActSuffix(message, tools, steps, ragContext);

      return prompt;
    } catch (error) {
      logger.error('PromptComposer failed in buildReActPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_REACT_LOOP_PROMPT, { message, tools, steps });
    }
  }

  /**
   * 构建知识优先 ReAct Prompt（替代 KNOWLEDGE_FIRST_REACT_PROMPT）
   *
   * 模块组合：BasePersona + DeviceInfo + ReActFormat + APISafety + BatchProtocol + KnowledgeGuide
   *
   * @param message - 用户请求消息
   * @param tools - 可用工具列表
   * @param steps - 已执行的步骤
   * @param ragContext - RAG 上下文
   * @returns 完整的知识优先 ReAct Prompt
   *
   * @see Requirements 1.8 - KNOWLEDGE_FIRST_REACT_PROMPT 模块化重构
   */
  buildKnowledgeFirstReActPrompt(
    message: string,
    tools: string,
    steps: string,
    ragContext: string
  ): string {
    try {
      const modules: PromptModule[] = [
        basePersona,
        deviceInfo,
        reActFormat,
        apiSafety,
        batchProtocol,
        knowledgeGuide,
      ];

      const variables: Record<string, string> = {
        message,
        tools,
        steps,
        ragContext,
      };

      // 使用包装后的模块以支持模块级自定义内容
      const reActComposer = new PromptComposer(this.wrapModulesWithCustomContent(modules));
      let prompt = reActComposer.compose({ variables });

      // 附加用户请求、知识上下文和工具信息部分
      prompt += this.buildKnowledgeFirstReActSuffix(message, tools, steps, ragContext);

      return prompt;
    } catch (error) {
      logger.error('PromptComposer failed in buildKnowledgeFirstReActPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_KNOWLEDGE_FIRST_REACT_PROMPT, { message, tools, steps, ragContext });
    }
  }

  /**
   * 构建并行 ReAct Prompt（替代 PARALLEL_REACT_PROMPT）
   *
   * 模块组合：BasePersona + DeviceInfo + ParallelFormat + APISafety
   *
   * @param message - 用户请求消息
   * @param tools - 可用工具列表
   * @param steps - 已执行的步骤
   * @param maxConcurrency - 最大并发数
   * @returns 完整的并行 ReAct Prompt
   *
   * @see Requirements 1.9 - PARALLEL_REACT_PROMPT 模块化重构
   */
  buildParallelReActPrompt(
    message: string,
    tools: string,
    steps: string,
    maxConcurrency: number
  ): string {
    try {
      const modules: PromptModule[] = [
        basePersona,
        deviceInfo,
        parallelFormat,
        apiSafety,
      ];

      const variables: Record<string, string> = {
        message,
        tools,
        steps,
        maxConcurrency: String(maxConcurrency),
      };

      // 使用包装后的模块以支持模块级自定义内容
      const parallelComposer = new PromptComposer(this.wrapModulesWithCustomContent(modules));
      let prompt = parallelComposer.compose({ variables });

      // 附加用户请求和工具信息部分
      prompt += this.buildParallelReActSuffix(message, tools, steps);

      return prompt;
    } catch (error) {
      logger.error('PromptComposer failed in buildParallelReActPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_PARALLEL_REACT_PROMPT, { message, tools, steps, maxConcurrency });
    }
  }

  /**
   * 构建告警分析 Prompt（替代 PROMPT_TEMPLATES.alertAnalysis）
   *
   * 模块组合：BasePersona + ChainOfThought(告警步骤) + JsonSchema(告警Schema)
   *
   * @param vars - 模板变量
   * @returns 完整的告警分析 Prompt
   *
   * @see Requirements 3.1 - 告警分析包含 ChainOfThought 推理步骤
   * @see Requirements 3.2 - 告警分析包含显式 JSON Schema 定义
   */
  buildAlertAnalysisPrompt(vars: Record<string, string | number>): string {
    try {
      return this.buildAnalysisPrompt('alertAnalysis', vars);
    } catch (error) {
      logger.error('PromptComposer failed in buildAlertAnalysisPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_ALERT_ANALYSIS_PROMPT, vars);
    }
  }

  /**
   * 构建批量告警分析 Prompt
   *
   * 模块组合：BasePersona + ChainOfThought(批量步骤) + JsonSchema(批量Schema)
   *
   * @param vars - 模板变量
   * @returns 完整的批量告警分析 Prompt
   *
   * @see Requirements 3.3 - 批量告警分析包含 ChainOfThought 和 JSON Schema
   */
  buildBatchAlertAnalysisPrompt(vars: Record<string, string | number>): string {
    try {
      return this.buildAnalysisPrompt('batchAlertAnalysis', vars);
    } catch (error) {
      logger.error('PromptComposer failed in buildBatchAlertAnalysisPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_BATCH_ALERT_ANALYSIS_PROMPT, vars);
    }
  }

  /**
   * 构建健康报告分析 Prompt
   *
   * 模块组合：BasePersona + ChainOfThought(健康步骤) + JsonSchema(健康Schema)
   *
   * @param vars - 模板变量
   * @returns 完整的健康报告分析 Prompt
   *
   * @see Requirements 3.5 - 健康报告分析包含 ChainOfThought 推理步骤
   */
  buildHealthReportAnalysisPrompt(vars: Record<string, string | number>): string {
    try {
      return this.buildAnalysisPrompt('healthReportAnalysis', vars);
    } catch (error) {
      logger.error('PromptComposer failed in buildHealthReportAnalysisPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_HEALTH_REPORT_ANALYSIS_PROMPT, vars);
    }
  }

  /**
   * 构建配置变更分析 Prompt
   *
   * 模块组合：BasePersona + ChainOfThought(配置步骤) + JsonSchema(配置Schema)
   *
   * @param vars - 模板变量
   * @returns 完整的配置变更分析 Prompt
   *
   * @see Requirements 3.6 - 配置变更分析包含 ChainOfThought 推理步骤
   */
  buildConfigDiffAnalysisPrompt(vars: Record<string, string | number>): string {
    try {
      return this.buildAnalysisPrompt('configDiffAnalysis', vars);
    } catch (error) {
      logger.error('PromptComposer failed in buildConfigDiffAnalysisPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_CONFIG_DIFF_ANALYSIS_PROMPT, vars);
    }
  }

  /**
   * 构建故障诊断 Prompt
   *
   * 模块组合：BasePersona + ChainOfThought(故障步骤) + JsonSchema(故障Schema)
   *
   * @param vars - 模板变量
   * @returns 完整的故障诊断 Prompt
   *
   * @see Requirements 3.7 - 故障诊断包含 ChainOfThought 推理步骤
   */
  buildFaultDiagnosisPrompt(vars: Record<string, string | number>): string {
    try {
      return this.buildAnalysisPrompt('faultDiagnosis', vars);
    } catch (error) {
      logger.error('PromptComposer failed in buildFaultDiagnosisPrompt, falling back to legacy template', { error });
      return replaceLegacyTemplateVars(LEGACY_FAULT_DIAGNOSIS_PROMPT, vars);
    }
  }

  // ==================== 动态 Prompt 组装 (F1.3-F1.5) ====================

  /**
   * 动态构建系统 Prompt（OODA Orient 阶段）
   *
   * 1. 从 prompt_knowledge 向量检索 Top-K Prompt 片段 (F1.3)
   * 2. 注入目标设备的 CapabilityManifest (F1.4)
   * 3. 无法检索时回退到通用默认 Prompt (F1.5)
   *
   * @param context - 构建上下文
   * @returns 完整的系统 Prompt
   *
   * @see Requirements F1.3 - 向量检索 Top-K Prompt 片段
   * @see Requirements F1.4 - 注入设备 CapabilityManifest
   * @see Requirements F1.5 - 回退到通用默认 Prompt
   */
  async buildSystemPrompt(context: {
    deviceId?: string;
    intentDescription: string;
    tickContext?: Record<string, unknown>;
  }): Promise<string> {
    let fragments: VectorSearchResult[] = [];

    // 1. 向量检索 Top-K Prompt 片段
    if (this.vectorClient) {
      try {
        const deviceType = context.deviceId
          ? this.getDeviceType(context.deviceId)
          : undefined;

        const filter: Record<string, unknown> = deviceType
          ? { deviceTypes: { $in: [deviceType, '*'] } }
          : {};

        fragments = await this.vectorClient.search('prompt_knowledge', {
          collection: 'prompt_knowledge',
          query: context.intentDescription,
          top_k: 3,
          filter,
          min_score: 0.3,
        });
      } catch (error) {
        logger.warn('[PromptComposerAdapter] Vector search failed, falling back to default prompt', { error });
      }
    }

    // 2. 注入设备 CapabilityManifest
    let capabilities = '';
    if (context.deviceId && this.deviceDriverManager) {
      try {
        const manifest = this.deviceDriverManager.getCapabilityManifest(context.deviceId);
        if (manifest) {
          capabilities = this.formatCapabilities(manifest);
        }
      } catch (error) {
        logger.warn('[PromptComposerAdapter] Failed to get device capabilities', { error });
      }
    }

    // 3. 组装完整 Prompt
    return this.assemblePrompt(fragments, capabilities, context);
  }

  /**
   * 通用默认 Prompt 模板（F1.5 回退）
   *
   * 当 Vector_Store 不可用或检索不到相关片段时使用。
   * 设备无关，不包含任何厂商硬编码。
   */
  private getDefaultPrompt(): string {
    return [
      '你是一个智能运维助手，能够管理和诊断各类网络设备和系统。',
      '你的核心能力包括：',
      '- 设备状态监控与健康检查',
      '- 告警分析与根因定位',
      '- 配置管理与变更审计',
      '- 故障诊断与修复建议',
      '- 性能优化与容量规划',
      '',
      '请根据用户的意图和设备上下文，提供准确、安全的运维操作建议。',
      '在执行任何变更操作前，请先确认操作的影响范围和风险等级。',
    ].join('\n');
  }

  /**
   * 组装完整 Prompt
   *
   * 将向量检索到的片段、设备能力描述和上下文组合为完整的系统 Prompt。
   * 如果没有检索到片段，回退到默认 Prompt。
   *
   * @param fragments - 向量检索结果
   * @param capabilities - 设备能力描述
   * @param context - 构建上下文
   * @returns 组装后的完整 Prompt
   */
  private assemblePrompt(
    fragments: VectorSearchResult[],
    capabilities: string,
    context: { intentDescription: string; tickContext?: Record<string, unknown> },
  ): string {
    const parts: string[] = [];

    // 基础 Prompt：优先使用检索到的片段，否则回退到默认
    if (fragments.length > 0) {
      parts.push('## 运维知识上下文');
      for (const frag of fragments) {
        parts.push(`\n### ${frag.metadata?.category ?? '知识片段'} (相关度: ${frag.score.toFixed(2)})`);
        parts.push(frag.text);
      }
    } else {
      parts.push(this.getDefaultPrompt());
    }

    // 注入设备能力描述
    if (capabilities) {
      parts.push('\n## 目标设备能力');
      parts.push(capabilities);
    }

    // 注入意图描述
    parts.push(`\n## 当前意图\n${context.intentDescription}`);

    // 注入 Tick 上下文（如果有）
    if (context.tickContext && Object.keys(context.tickContext).length > 0) {
      parts.push('\n## 执行上下文');
      parts.push(JSON.stringify(context.tickContext, null, 2));
    }

    return parts.join('\n');
  }

  /**
   * 获取设备类型标识
   *
   * 通过 DeviceDriverManager 获取设备的驱动类型。
   * 如果设备未连接或无法获取，返回 undefined。
   */
  private getDeviceType(deviceId: string): string | undefined {
    if (!this.deviceDriverManager) return undefined;
    try {
      const manifest = this.deviceDriverManager.getCapabilityManifest(deviceId);
      return manifest?.driverType;
    } catch {
      return undefined;
    }
  }

  /**
   * 格式化设备 CapabilityManifest 为可读文本
   */
  private formatCapabilities(manifest: CapabilityManifest): string {
    const lines: string[] = [];
    lines.push(`设备类型: ${manifest.driverType}`);
    if (manifest.vendor) lines.push(`厂商: ${manifest.vendor}`);
    if (manifest.model) lines.push(`型号: ${manifest.model}`);

    if (manifest.commands.length > 0) {
      lines.push('\n支持的操作:');
      for (const cmd of manifest.commands) {
        const risk = cmd.riskLevel !== 'low' ? ` [风险: ${cmd.riskLevel}]` : '';
        const ro = cmd.readOnly ? ' (只读)' : '';
        lines.push(`- ${cmd.actionType}: ${cmd.description}${ro}${risk}`);
      }
    }

    if (manifest.metricsCapabilities.length > 0) {
      lines.push(`\n可采集指标: ${manifest.metricsCapabilities.join(', ')}`);
    }

    return lines.join('\n');
  }

  // ==================== 私有方法 ====================

  /**
   * 通用分析 Prompt 构建方法
   *
   * 根据分析类型选择对应的 ChainOfThought 步骤集和 JsonSchema，
   * 组合 BasePersona + ChainOfThought + JsonSchema 模块。
   *
   * @param analysisType - 分析类型键名
   * @param vars - 模板变量
   * @returns 完整的分析 Prompt
   */
  private buildAnalysisPrompt(
    analysisType: string,
    vars: Record<string, string | number>
  ): string {
    const config = ANALYSIS_CONFIGS[analysisType];
    if (!config) {
      throw new Error(`Unknown analysis type: ${analysisType}`);
    }

    // 创建专用的 ChainOfThought 和 JsonSchema 模块实例
    const cotModule = createChainOfThoughtModule(config.steps);
    const schemaModule = createJsonSchemaModule(config.schema);

    // 组合 BasePersona + ChainOfThought + OperationalRules + JsonSchema 模块
    const modules: PromptModule[] = [basePersona, operationalRules, cotModule, schemaModule];

    // 将 vars 转换为字符串变量
    const variables: Record<string, string> = {
      operationalRules: '', // 默认为空字符串，避免 undefined 导致 {{operationalRules}} 不被替换
    };
    for (const [key, value] of Object.entries(vars)) {
      variables[key] = String(value);
    }

    // 使用包装后的模块以支持模块级自定义内容
    const analysisComposer = new PromptComposer(this.wrapModulesWithCustomContent(modules));
    return analysisComposer.compose({ variables });
  }

  /**
   * 构建 ReAct Prompt 的后缀部分（用户请求、工具、步骤）
   */
  private buildReActSuffix(
    message: string,
    tools: string,
    steps: string,
    ragContext?: string
  ): string {
    const parts: string[] = [];

    parts.push(`\n\n用户请求：${message}`);

    if (ragContext) {
      parts.push(`\n\n知识库上下文：\n${ragContext}`);
    }

    parts.push(`\n\n可用工具（包含参数说明）：\n${tools}`);
    parts.push(`\n\n之前的步骤：\n${steps}`);
    parts.push('\n\n请思考下一步行动。如果问题已解决，输出最终答案。');

    return parts.join('');
  }

  /**
   * 构建知识优先 ReAct Prompt 的后缀部分
   */
  private buildKnowledgeFirstReActSuffix(
    message: string,
    tools: string,
    steps: string,
    ragContext: string
  ): string {
    const parts: string[] = [];

    parts.push(`\n\n用户请求：${message}`);
    parts.push(`\n\n知识库上下文：\n${ragContext}`);
    parts.push(`\n\n可用工具（包含参数说明）：\n${tools}`);
    parts.push(`\n\n之前的步骤：\n${steps}`);
    parts.push('\n\n请思考下一步行动。记住：如果还没有查询知识库，应该先查询知识库！');

    return parts.join('');
  }

  /**
   * 构建并行 ReAct Prompt 的后缀部分
   */
  private buildParallelReActSuffix(
    message: string,
    tools: string,
    steps: string
  ): string {
    const parts: string[] = [];

    parts.push(`\n\n用户请求：${message}`);
    parts.push(`\n\n可用工具：\n${tools}`);
    parts.push(`\n\n之前的步骤：\n${steps}`);
    parts.push('\n\n请思考下一步行动。**如果可以并行执行多个独立操作，请务必使用编号格式**。');

    return parts.join('');
  }

  /**
   * 格式化知识上下文
   *
   * 将 FormattedKnowledge 列表格式化为可嵌入 Prompt 的文本。
   *
   * @param knowledge - 知识列表
   * @returns 格式化的知识上下文字符串
   */
  private formatKnowledgeContext(knowledge: FormattedKnowledge[]): string {
    if (knowledge.length === 0) {
      return '暂无相关知识。';
    }

    const formattedItems = knowledge.map((k, index) => {
      const parts: string[] = [];
      parts.push(`### ${index + 1}. ${k.title}`);
      parts.push(`**引用 ID**: ${k.referenceId}`);
      parts.push(`**类型**: ${k.type}`);

      let content = k.fullContent;
      if (content.length > 1000) {
        content = content.substring(0, 1000) + '...[内容已截断]';
      }
      parts.push(`\n**内容**:\n${content}`);
      parts.push(`\n*${k.citationHint}*`);

      return parts.join('\n');
    });

    return formattedItems.join('\n\n---\n\n');
  }

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
}
