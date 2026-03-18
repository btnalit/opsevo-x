/**
 * SkillAwareReActController - Skill 感知的 ReAct 控制器
 * 
 * 包装 ReActLoopController，添加 Skill 系统集成
 * 
 * Requirements: 7.1-7.12
 * - 7.1: Skill 参数传递
 * - 7.2: Skill 配置注入（temperature, maxIterations）
 * - 7.3: SkillAwarePromptBuilder 集成
 * - 7.4: SkillAwareToolSelector 集成
 * - 7.5: SkillAwareKnowledgeRetriever 集成
 * - 7.6: 工具调用拦截
 * - 7.7: 参数验证和修正
 * - 7.8: Skill 元数据记录
 * - 7.9: 切换建议检测
 * - 7.10: 响应中包含 Skill 信息
 * - 7.11: 性能指标记录
 * - 7.12: 错误处理
 * 
 * 关键设计变更:
 * - 知识检索在 SARC 内部执行，而非 UAS 中
 * - 禁用 RALC 内部知识检索（knowledgeEnhancedMode: false）
 * - 使用执行上下文（ReActExecutionContext）实现并发安全
 * - 拦截器和提示词覆盖通过执行上下文传递，而非设置到单例实例
 */

import { logger } from '../../../utils/logger';
import { Skill } from '../../../types/skill';
import { IntentAnalysis } from '../../../types/ai-ops';
import { IAIProviderAdapter, AIProvider } from '../../../types/ai';
import { ReActLoopController, ReActLoopResult, ReActLoopControllerConfig, ToolInterceptor, ReActExecutionContext, createExecutionContext, SkillContext, reactLoopController } from '../rag/reactLoopController';
import { ConversationMemory, AgentTool } from '../rag/mastraAgent';
import { SkillAwarePromptBuilder, skillAwarePromptBuilder } from './skillAwarePromptBuilder';
import { SkillAwareToolSelector, skillAwareToolSelector } from './skillAwareToolSelector';
import { SkillAwareKnowledgeRetriever, skillAwareKnowledgeRetriever, SkillAwareRetrievalResult } from './skillAwareKnowledgeRetriever';
import { SkillMetrics, skillMetrics } from './skillMetrics';
import { SkillManager, skillManager } from './skillManager';
import { FormattedKnowledge, TrackedKnowledgeReference } from '../rag/types/intelligentRetrieval';
import { outputValidator } from '../rag/outputValidator';
import { usageTracker } from '../rag/usageTracker';

/**
 * Skill 感知的 ReAct 结果
 */
export interface SkillAwareReActResult extends ReActLoopResult {
  /** 使用的 Skill */
  skill?: {
    name: string;
    description: string;
    matchType: string;
    confidence: number;
  };
  /** Skill 切换建议 */
  switchSuggestion?: {
    suggested: boolean;
    skillName?: string;
    reason?: string;
  };
  /** Skill 性能指标 */
  skillMetrics?: {
    responseTime: number;
    toolCallCount: number;
    knowledgeUsed: boolean;
  };
  /** Skill 知识检索结果 */
  skillKnowledgeResult?: {
    documentCount: number;
    retrievalTime: number;
    skillConfigApplied: boolean;
  };
}

/**
 * Skill 感知的 ReAct 选项
 */
export interface SkillAwareReActOptions {
  /** 当前 Skill */
  skill?: Skill;
  /** 会话 ID */
  sessionId?: string;
  /** 是否应用 Skill 配置 */
  applySkillConfig?: boolean;
  /** 是否过滤工具 */
  filterTools?: boolean;
  /** 是否使用 Skill 知识配置 */
  useSkillKnowledge?: boolean;
  /** AI 适配器（并发安全：请求级别） */
  aiAdapter?: IAIProviderAdapter | null;
  /** AI 提供商（并发安全：请求级别） */
  provider?: AIProvider;
  /** 模型名称（并发安全：请求级别） */
  model?: string;
  /** 预检索的知识（来自 FastPathRouter，避免重复检索） */
  preRetrievedKnowledge?: FormattedKnowledge[];
  /** 是否跳过知识检索（当有预检索结果时） */
  skipKnowledgeRetrieval?: boolean;
  /** 多设备支持：设备 ID，用于通过 deviceDriverManager 获取设备客户端 */
  deviceId?: string;
}

/**
 * SkillAwareReActController 类
 * Skill 感知的 ReAct 控制器
 * 
 * 并发安全设计：
 * - 不再使用实例级别的 cachedKnowledge 和 cachedKnowledgeResult
 * - 所有请求级别的状态通过 ReActExecutionContext 传递
 * - 拦截器和提示词覆盖设置到执行上下文，而非单例实例
 */
export class SkillAwareReActController {
  private baseController: ReActLoopController;
  private promptBuilder: SkillAwarePromptBuilder;
  private toolSelector: SkillAwareToolSelector;
  private knowledgeRetriever: SkillAwareKnowledgeRetriever;
  private metrics: SkillMetrics;
  private manager: SkillManager;

  constructor(
    baseController?: ReActLoopController,
    promptBuilder?: SkillAwarePromptBuilder,
    toolSelector?: SkillAwareToolSelector,
    knowledgeRetriever?: SkillAwareKnowledgeRetriever,
    metrics?: SkillMetrics,
    manager?: SkillManager
  ) {
    this.baseController = baseController || reactLoopController;
    this.promptBuilder = promptBuilder || skillAwarePromptBuilder;
    this.toolSelector = toolSelector || skillAwareToolSelector;
    this.knowledgeRetriever = knowledgeRetriever || skillAwareKnowledgeRetriever;
    this.metrics = metrics || skillMetrics;
    this.manager = manager || skillManager;

    logger.debug('SkillAwareReActController created');
  }

  /**
   * 执行 Skill 感知的 ReAct 循环
   * Requirements: 7.1-7.12
   * 
   * 并发安全设计：
   * 1. 创建请求级别的执行上下文（ReActExecutionContext）
   * 2. 将 AI 适配器、拦截器、提示词覆盖设置到执行上下文
   * 3. 将执行上下文传递给 RALC.executeLoop()
   * 4. 不再需要 finally 清理，因为上下文在请求结束后自动丢弃
   * 
   * 关键流程:
   * 1. 应用 Skill 配置（temperature, maxIterations）
   * 2. 禁用 RALC 内部知识检索（knowledgeEnhancedMode: false）
   * 3. 过滤工具（基于 Skill.allowedTools）
   * 4. 执行 Skill 感知的知识检索（一次，在 SARC 内部）
   * 5. 创建执行上下文，设置拦截器和提示词覆盖
   * 6. 执行 ReAct 循环（传递执行上下文）
   * 7. 恢复原始配置和工具（执行上下文自动丢弃）
   */
  async executeLoop(
    message: string,
    intentAnalysis: IntentAnalysis,
    context: ConversationMemory,
    options?: SkillAwareReActOptions
  ): Promise<SkillAwareReActResult> {
    const startTime = Date.now();
    const opts = {
      applySkillConfig: true,
      filterTools: true,
      useSkillKnowledge: true,
      ...options,
    };

    let skill = opts.skill;
    let matchType = 'none';
    let confidence = 0;

    // 如果没有提供 Skill，尝试自动选择
    if (!skill && opts.sessionId) {
      try {
        const matchResult = await this.manager.selectSkill(
          message,
          opts.sessionId,
          { intentAnalysis }
        );
        skill = matchResult.skill;
        matchType = matchResult.matchType;
        confidence = matchResult.confidence;
      } catch (error) {
        logger.warn('Failed to select Skill, using default behavior', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 请求级别的知识缓存（不再使用实例属性）
    let cachedKnowledge: FormattedKnowledge[] = [];
    let cachedKnowledgeResult: SkillAwareRetrievalResult | null = null;
    // 工具过滤恢复用（需在 try 外声明，finally 中使用）
    let originalTools: AgentTool[] | null = null;

    try {
      // 1. 构建 Skill 配置覆盖（不再直接修改单例 config）
      // Requirements: 7.2
      let skillTemperature: number | undefined;
      let configOverrides: Partial<ReActLoopControllerConfig> | undefined;
      if (skill && opts.applySkillConfig) {
        configOverrides = this.buildConfigOverrides(skill);
        // 关键：禁用 RALC 内部知识检索，由 SARC 统一管理
        configOverrides.knowledgeEnhancedMode = false;
        configOverrides.enableIntelligentRetrieval = false;
        skillTemperature = configOverrides.temperature;
        
        logger.debug('Skill config overrides prepared (concurrent-safe)', {
          skill: skill.metadata.name,
          temperature: configOverrides.temperature,
          maxIterations: configOverrides.maxIterations,
          knowledgeEnhancedMode: false,
        });
      }

      // 2. 过滤工具
      // Requirements: 7.4
      // 注意：工具过滤仍需修改单例的工具列表，因为 RALC 的 executeTool 直接从 this.tools 查找
      // 但 SARC 的 systemPromptOverride 已包含过滤后的工具描述，LLM 只会请求允许的工具
      if (skill && opts.filterTools) {
        const allTools = this.baseController.getTools();
        const selectionResult = this.toolSelector.filterTools(allTools as AgentTool[], skill);
        const filteredToolNames = new Set(selectionResult.tools.map(t => t.name));

        logger.debug('Tools filtered for Skill', {
          skill: skill.metadata.name,
          original: allTools.length,
          filtered: filteredToolNames.size,
        });

        if (filteredToolNames.size !== allTools.length) {
          originalTools = allTools;
          const filteredTools = allTools.filter(t => filteredToolNames.has(t.name));
          this.baseController.clearTools();
          this.baseController.registerTools(filteredTools);
        }
      }

      // 3. 执行 Skill 感知的知识检索（一次，在 SARC 内部）
      // Requirements: 7.5, 10.1, 10.2
      // Fast Path Integration: 支持使用预检索结果，避免重复检索
      if (opts.preRetrievedKnowledge && opts.preRetrievedKnowledge.length > 0 && opts.skipKnowledgeRetrieval) {
        // 使用 FastPathRouter 的预检索结果
        cachedKnowledge = opts.preRetrievedKnowledge;
        cachedKnowledgeResult = {
          documents: opts.preRetrievedKnowledge,
          retrievalTime: 0, // 预检索时间已在 FastPathRouter 中记录
          skillConfigApplied: false,
          filteredCount: 0,
          originalCount: opts.preRetrievedKnowledge.length,
          query: message,
          rewrittenQueries: [],
          degradedMode: false,
        };
        
        logger.info('Using pre-retrieved knowledge from FastPathRouter', {
          documentCount: cachedKnowledge.length,
        });
      } else if (skill && opts.useSkillKnowledge && this.knowledgeRetriever.isKnowledgeEnabled(skill)) {
        try {
          const retrievalResult = await this.knowledgeRetriever.retrieve(message, skill);
          cachedKnowledge = retrievalResult.documents;
          cachedKnowledgeResult = retrievalResult;
          
          logger.info('Skill-aware knowledge retrieval completed', {
            skill: skill.metadata.name,
            documentCount: cachedKnowledge.length,
            retrievalTime: retrievalResult.retrievalTime,
            skillConfigApplied: retrievalResult.skillConfigApplied,
          });
        } catch (error) {
          logger.warn('Skill-aware knowledge retrieval failed', {
            skill: skill.metadata.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 4. 创建执行上下文（并发安全的核心）
      // Requirements: 7.6, 9.1, 4.1, 4.2 - 构建并设置 SkillContext
      
      // Requirements: 4.1, 11.1 - 从 Skill 配置构建 SkillContext
      let skillContextForExecution: SkillContext | undefined;
      if (skill) {
        skillContextForExecution = this.buildSkillContext(skill);
        logger.debug('SkillContext built from Skill config', {
          skillName: skillContextForExecution.skillName,
          toolPriority: skillContextForExecution.toolPriority,
          allowedTools: skillContextForExecution.allowedTools,
        });
      }

      const executionContext = createExecutionContext(
        opts.aiAdapter,
        opts.provider,
        opts.model,
        skillTemperature,
        skillContextForExecution,  // Requirements: 4.2, 11.2 - 传递 SkillContext 到执行上下文
      );

      // 并发安全：将配置覆盖设置到执行上下文（不再修改单例 config）
      if (configOverrides) {
        executionContext.configOverrides = configOverrides;
      }

      // 5. 设置 knowledge_search 工具拦截器到执行上下文
      if (skill && cachedKnowledge.length > 0) {
        const knowledgeInterceptor: ToolInterceptor = async (toolName, params) => {
          // 返回缓存的知识，避免重复检索
          logger.debug('knowledge_search intercepted, returning cached knowledge', {
            skill: skill!.metadata.name,
            cachedCount: cachedKnowledge.length,
            requestId: executionContext.requestId,
          });
          
          return {
            intercepted: true,
            result: {
              success: true,
              documents: cachedKnowledge.map(doc => ({
                id: doc.referenceId,
                title: doc.title,
                type: doc.type,
                content: doc.content,
                score: doc.credibilityScore,
              })),
              message: `从缓存返回 ${cachedKnowledge.length} 条知识（Skill: ${skill!.metadata.name}）`,
            },
          };
        };
        
        // 设置到执行上下文，而非单例实例
        executionContext.toolInterceptors.set('knowledge_search', knowledgeInterceptor);
      }

      // 6. 构建 Skill 增强的提示词并设置到执行上下文
      // Requirements: 7.3, 9.1
      // 意图丢失修复：将用户请求放在提示词最前面，确保 LLM 始终能看到用户的实际请求
      if (skill) {
        // 获取过滤后的工具列表
        const filteredTools = this.baseController.getTools();
        
        // 构建工具描述（包含参数详情）
        const toolDescriptions = this.promptBuilder.buildToolDescriptions(filteredTools);
        
        const enhancedPrompt = await this.promptBuilder.buildSkillEnhancedPrompt(
          message,
          skill,
          cachedKnowledge,
          {
            includeSkillContent: true,
            includeToolGuide: true,
            includeOutputFormat: true,
          }
        );
        
        // 意图丢失修复：重构提示词结构
        // 1. 将用户请求放在最前面，确保 LLM 不会忽略用户意图
        // 2. 将 IntentAnalyzer 的 LLM 分析结果注入提示词，指导 ReAct 循环
        //    原问题：IntentAnalyzer 已准确分析出意图和推荐工具，但这些信息没有传递给 ReAct 的 LLM
        //    导致 ReAct LLM 需要重新"猜测"用户意图，经常猜错
        
        // 构建意图分析指导信息
        let intentGuidance = '';
        if (intentAnalysis && intentAnalysis.tools && intentAnalysis.tools.length > 0) {
          const toolList = intentAnalysis.tools
            .map(t => `- \`${t.name}\`${t.params ? `（参数: ${JSON.stringify(t.params)}）` : ''}${t.reason ? `：${t.reason}` : ''}`)
            .join('\n');
          intentGuidance = `

## 🎯 LLM 意图分析结果（已通过前置分析确认）

经过 LLM 意图分析，用户请求的意图为：**${intentAnalysis.intent || '未知'}**（置信度: ${((intentAnalysis.confidence || 0) * 100).toFixed(0)}%）

推荐使用的工具：
${toolList}

⚠️ 请优先使用上述推荐工具来处理用户请求，不要忽略意图分析的结果。`;
        }
        
        const fullPrompt = `## ⚠️ 用户当前请求（最重要）

以下是用户的实际请求，你必须针对此请求进行分析和回答：

「${message}」

请务必围绕上述用户请求展开思考和行动，不要忽略用户的意图。
${intentGuidance}

---

${enhancedPrompt}

## 可用工具（包含参数说明）

${toolDescriptions}

## 用户请求

{{message}}

## 之前的步骤

{{steps}}

## 输出格式

请思考下一步行动。如果问题已解决，输出最终答案。

- 如果需要继续，输出：
  Thought: 你的思考过程（必须具体说明要做什么，必须与用户请求「${message}」相关）
  Action: 工具名称
  Action Input: {"参数名": "具体值", ...}

- 如果问题已解决，输出：
  Thought: 总结思考（需要引用知识库中的相关案例，使用 [KB-xxx] 格式）
  Final Answer: 最终回答`;
        
        // 设置到执行上下文，而非单例实例
        executionContext.systemPromptOverride = fullPrompt;
        
        logger.debug('Skill-enhanced prompt set to execution context', {
          skill: skill.metadata.name,
          promptLength: fullPrompt.length,
          requestId: executionContext.requestId,
        });
      }

      // 7. 执行 ReAct 循环（传递执行上下文）
      const result = await this.baseController.executeLoop(
        message,
        intentAnalysis,
        context,
        executionContext  // 传递执行上下文，实现并发安全
      );

      // 步骤 A：使用 OutputValidator 验证最终回答中的知识引用
      // Requirements: 1.1, 1.3, 1.4
      let validatedReferences: TrackedKnowledgeReference[] = [];
      if (cachedKnowledge.length > 0 && result.finalAnswer) {
        const validationResult = outputValidator.validate(result.finalAnswer, cachedKnowledge);
        validatedReferences = validationResult.references.map(ref => {
          const refId = ref.fullText.replace(/[\[\]]/g, '');
          const knowledge = cachedKnowledge.find(k => k.referenceId === refId);
          return {
            referenceId: refId,
            entryId: knowledge?.entryId || '',
            title: knowledge?.title || '',
            type: knowledge?.type || 'unknown',
            isValid: validationResult.validReferences.some(vr => vr.fullText === ref.fullText),
          };
        });
      }

      // 步骤 B：使用 UsageTracker 记录知识使用
      // Requirements: 1.2
      if (cachedKnowledge.length > 0 && validatedReferences.length > 0) {
        try {
          // 从 intentAnalysis.intent 映射到 IntentType
          const intentTypeMap: Record<string, 'troubleshooting' | 'configuration' | 'monitoring' | 'historical_analysis' | 'general'> = {
            troubleshooting: 'troubleshooting',
            configuration: 'configuration',
            monitoring: 'monitoring',
            historical_analysis: 'historical_analysis',
            '故障排查': 'troubleshooting',
            '配置': 'configuration',
            '监控': 'monitoring',
            '历史分析': 'historical_analysis',
          };
          const intentLower = intentAnalysis.intent?.toLowerCase() || '';
          const mappedIntentType = intentTypeMap[intentLower]
            || (intentLower.includes('troubleshoot') || intentLower.includes('故障') ? 'troubleshooting'
            : intentLower.includes('config') || intentLower.includes('配置') ? 'configuration'
            : intentLower.includes('monitor') || intentLower.includes('监控') ? 'monitoring'
            : intentLower.includes('histor') || intentLower.includes('历史') ? 'historical_analysis'
            : 'general');

          for (const ref of validatedReferences) {
            if (ref.isValid && ref.entryId) {
              await usageTracker.recordUsage(ref.entryId, {
                query: message,
                timestamp: Date.now(),
                referenceId: ref.referenceId,
                sessionId: opts.sessionId,
                intentType: mappedIntentType,
              });
            }
          }
        } catch (trackingError) {
          logger.warn('Failed to track knowledge usage in SARC', { error: trackingError });
        }
      }

      // 检测 Skill 切换建议
      let switchSuggestion: SkillAwareReActResult['switchSuggestion'];
      if (skill) {
        switchSuggestion = this.manager.detectSkillSwitchSuggestion(result.finalAnswer);
      }

      // 记录性能指标
      const responseTime = Date.now() - startTime;
      if (skill) {
        const success = !result.reachedMaxIterations && result.finalAnswer.length > 0;
        this.metrics.recordCompletion(skill.metadata.name, success, responseTime);
      }

      // 构建结果
      const skillAwareResult: SkillAwareReActResult = {
        ...result,
        // Requirements: 1.4 - 使用经过验证的引用列表替代 RALC 直接透传的引用
        knowledgeReferences: validatedReferences.length > 0 ? validatedReferences : result.knowledgeReferences,
        skill: skill ? {
          name: skill.metadata.name,
          description: skill.metadata.description,
          matchType,
          confidence,
        } : undefined,
        switchSuggestion,
        skillMetrics: {
          responseTime,
          toolCallCount: result.steps.filter(s => s.type === 'action').length,
          knowledgeUsed: cachedKnowledge.length > 0,
        },
        skillKnowledgeResult: cachedKnowledgeResult ? {
          documentCount: cachedKnowledgeResult.documents.length,
          retrievalTime: cachedKnowledgeResult.retrievalTime,
          skillConfigApplied: cachedKnowledgeResult.skillConfigApplied,
        } : undefined,
      };

      logger.info('Skill-aware ReAct loop completed', {
        skill: skill?.metadata.name,
        iterations: result.iterations,
        responseTime,
        knowledgeUsed: cachedKnowledge.length > 0,
        switchSuggested: switchSuggestion?.suggested,
        requestId: executionContext.requestId,
      });

      return skillAwareResult;
    } catch (error) {
      logger.error('Skill-aware ReAct loop execution failed', {
        error: error instanceof Error ? error.message : String(error),
        skill: skill?.metadata.name,
      });
      throw error;
    } finally {
      // 8. 清理：恢复工具列表（如果被过滤修改过）
      // 配置覆盖在执行上下文中，随上下文自动丢弃，无需恢复
      if (originalTools) {
        this.baseController.clearTools();
        this.baseController.registerTools(originalTools);
      }
      
      logger.debug('Skill-aware ReAct cleanup completed (execution context auto-discarded)');
    }
  }

  /**
   * 构建配置覆盖
   * Requirements: 7.2
   */
  private buildConfigOverrides(skill: Skill): Partial<ReActLoopControllerConfig> {
    const caps = skill.config.caps;
    return {
      maxIterations: caps.maxIterations,
      temperature: caps.temperature,
    };
  }

  /**
   * 从 Skill 配置构建 SkillContext
   * Requirements: 4.1, 11.1 - 提取 toolPriority, allowedTools, toolDefaults
   * 
   * @param skill Skill 配置
   * @returns SkillContext 对象
   */
  private buildSkillContext(skill: Skill): SkillContext {
    const config = skill.config;
    
    // 提取 toolPriority（如果存在）
    const toolPriority = config.toolPriority || [];
    
    // 提取 allowedTools
    const allowedTools = config.allowedTools || [];
    
    // 提取 toolDefaults（如果存在）
    const toolDefaults = config.toolDefaults as Record<string, Record<string, unknown>> | undefined;
    
    const skillContext: SkillContext = {
      skillName: skill.metadata.name,
      toolPriority,
      allowedTools,
      toolDefaults,
    };

    // Requirements: 4.5, 11.3 - 记录调试日志
    logger.debug('Built SkillContext from Skill config', {
      skillName: skillContext.skillName,
      toolPriorityCount: toolPriority.length,
      allowedToolsCount: allowedTools.length,
      hasToolDefaults: !!toolDefaults,
    });

    return skillContext;
  }

  /**
   * 拦截工具调用
   * Requirements: 7.6, 7.7
   */
  interceptToolCall(
    toolName: string,
    params: Record<string, unknown>,
    skill: Skill
  ): { allowed: boolean; params?: Record<string, unknown>; reason?: string } {
    return this.toolSelector.interceptToolCall(toolName, params, skill);
  }

  /**
   * 获取 Skill 的 temperature 配置
   */
  getSkillTemperature(skill: Skill): number {
    return skill.config.caps.temperature;
  }

  /**
   * 获取 Skill 的最大迭代次数
   */
  getSkillMaxIterations(skill: Skill): number {
    return skill.config.caps.maxIterations;
  }

  /**
   * 获取基础控制器
   */
  getBaseController(): ReActLoopController {
    return this.baseController;
  }

  /**
   * 设置基础控制器
   */
  setBaseController(controller: ReActLoopController): void {
    this.baseController = controller;
  }
}

// 导出单例实例
export const skillAwareReActController = new SkillAwareReActController();
