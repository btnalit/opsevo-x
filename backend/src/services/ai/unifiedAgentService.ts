/**
 * UnifiedAgentService - 统一 AI Agent 服务
 *
 * 整合纯对话和 RAG 增强两种模式的统一代理服务
 * 支持标准模式（流式对话）和知识增强模式（RAG 检索 + 工具调用）
 *
 * Requirements: 1.1, 2.1
 * - 1.1: 提供统一入口访问所有 AI 对话功能
 * - 2.1: 知识增强模式下先检索知识再生成响应
 *
 * Architecture Optimization Requirements: 4.1, 4.2, 4.4
 * - 4.1: 委托 RAGEngine 执行所有知识检索操作
 * - 4.2: 调用 RAGEngine.query() 方法执行检索
 * - 4.4: 知识检索失败时收到明确的错误类型
 *
 * Architecture Review Requirements: 1.1, 1.2, 1.3
 * - 1.1: 使用依赖注入模式而非动态导入加载 RAG 模块
 * - 1.2: 通过接口抽象而非直接引用实现解耦
 * - 1.3: 服务初始化失败时提供明确的错误信息
 */

import { logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { ChatSessionService, chatSessionService } from './chatSessionService';
import { ContextBuilderService, contextBuilderService } from './contextBuilderService';
import { ScriptExecutorService, scriptExecutorService } from './scriptExecutorService';
import { APIConfigService, apiConfigService } from './apiConfigService';
import { RerankerService, rerankerService } from './rerankerService';
import { AdapterFactory } from './adapters';
import { AIProvider, ChatMessage, TokenUsage, ScriptExecuteResult, DEFAULT_SESSION_CONFIG } from '../../types/ai';
import { KnowledgeRetrievalError, KnowledgeRetrievalErrorCode, IntentAnalysis } from '../../types/ai-ops';
import { IRAGEngine, IKnowledgeBase, IMastraAgent, RAG_SERVICE_TOKENS, RAGQueryOptions } from '../../types/rag-interfaces';
import { serviceContainer } from '../core/serviceContainer';
import { TokenBudgetManager } from './tokenBudgetManager';
import { KnowledgeSummarizer, SummarizedCitation } from './knowledgeSummarizer';
import { DEFAULT_SUMMARIZATION_CONFIG } from '../../types/summarization';

// Skill System Integration
import { SkillManager, skillManager as defaultSkillManager } from '../ai-ops/skill/skillManager';
import { Skill, SkillMatchResult } from '../../types/skill';
import { SkillAwareReActController, skillAwareReActController as defaultSkillAwareReActController, SkillAwareReActResult } from '../ai-ops/skill/skillAwareReActController';
import { IntentAnalyzer, intentAnalyzer as defaultIntentAnalyzer } from '../ai-ops/rag/intentAnalyzer';
import { ConversationMemory } from '../ai-ops/rag/mastraAgent';
import { predefinedTools } from '../ai-ops/rag/agentTools';

// Fast Path Integration
import { FastPathRouter, createFastPathRouter } from '../ai-ops/rag/fastPathRouter';
import { FastPathResult, FastPathRouterConfig } from '../../types/fast-path';

// Knowledge type imports for FastPath → SARC knowledge conversion
import { FormattedKnowledge, KnowledgeType } from '../ai-ops/rag/types/intelligentRetrieval';

// State Machine Integration (lightweight-state-machine)
// Requirements: 9.3, 9.4 - Feature flag routing for gradual migration
import { FeatureFlagManager } from '../ai-ops/stateMachine/featureFlagManager';
import { StateMachineOrchestrator } from '../ai-ops/stateMachine/stateMachineOrchestrator';
import { RelevanceScorer } from './relevanceScorer';

// 泛化设备支持：DeviceManager 类型引用
// Requirements: J2.6 - 替换旧设备客户端为 deviceId + DeviceManager
import type { DeviceManager } from '../device/deviceManager';

// ==================== 类型定义 ====================

/**
 * 统一聊天模式
 */
export type UnifiedChatMode = 'standard' | 'knowledge-enhanced';

/**
 * RAG 上下文
 */
export interface RAGContext {
  retrievalTime: number;
  totalRetrievals: number;
  avgRelevanceScore: number;
}

/**
 * RAG 引用
 */
export interface RAGCitation {
  entryId: string;
  title: string;
  content: string;
  score: number;
  type: string;
}

/**
 * Agent 工具调用
 */
export interface AgentToolCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  duration: number;
}

/**
 * RAG 选项
 */
export interface RAGOptions {
  topK?: number;
  minScore?: number;
  includeTools?: boolean;
  /** 是否启用重排序 */
  rerankEnabled?: boolean;
  /** 重排序返回的最大结果数 */
  rerankTopK?: number;
  /** 重排序相关性阈值 */
  rerankThreshold?: number;
}

/**
 * Skill 选项
 */
export interface SkillOptions {
  /** 手动指定的 Skill 名称 */
  skillOverride?: string;
  /** 是否启用 Skill 系统 */
  enableSkillSystem?: boolean;
}

/**
 * 统一聊天请求
 */
export interface UnifiedChatRequest {
  configId: string;
  sessionId?: string;
  message: string;
  mode: UnifiedChatMode;
  includeContext?: boolean;
  ragOptions?: RAGOptions;
  /** Skill 选项 */
  skillOptions?: SkillOptions;
  /** 多设备支持：请求级设备 ID */
  deviceId?: string;
  /** 多设备支持：请求级租户 ID */
  tenantId?: string;
}

/**
 * ReAct 步骤（用于响应）
 * 与 ai-ops.ts 中的 ReActStep 保持一致
 */
export interface ResponseReActStep {
  /** 步骤类型 */
  type: 'thought' | 'action' | 'observation' | 'final_answer' | 'reflection';
  /** 步骤内容 */
  content: string;
  /** 时间戳 */
  timestamp?: number;
  /** 工具名称（仅 action 类型） */
  toolName?: string;
  /** 工具输入参数（仅 action 类型） */
  toolInput?: Record<string, unknown>;
  /** 工具输出结果（仅 observation 类型） */
  toolOutput?: unknown;
  /** 执行耗时（毫秒） */
  duration?: number;
}

/**
 * 意图分析结果（用于响应）
 */
export interface ResponseIntentAnalysis {
  /** 用户意图的简短描述 */
  intent: string;
  /** 需要调用的工具列表 */
  tools: Array<{
    name: string;
    params: Record<string, unknown>;
    reason: string;
  }>;
  /** 置信度 (0-1) */
  confidence: number;
}

/**
 * 统一聊天响应
 */
export interface UnifiedChatResponse {
  content: string;
  sessionId: string;
  ragContext?: RAGContext;
  citations?: RAGCitation[];
  toolCalls?: AgentToolCall[];
  reasoning?: string[];
  confidence?: number;
  usage?: TokenUsage;
  /** Skill 信息 */
  skill?: {
    name: string;
    description: string;
    matchType: string;
    confidence: number;
  };
  /** ReAct 步骤（知识增强模式） */
  reactSteps?: ResponseReActStep[];
  /** 意图分析结果（知识增强模式） */
  intentAnalysis?: ResponseIntentAnalysis;
}

/**
 * 流式响应块
 */
export interface StreamChunk {
  type: 'content' | 'citation' | 'tool_call' | 'reasoning' | 'done' | 'error';
  content?: string;
  citation?: RAGCitation;
  toolCall?: AgentToolCall;
  reasoning?: string;
  error?: string;
  usage?: TokenUsage;
  /** 助手消息 ID（仅在 done 事件中发送，用于前端收藏功能） */
  messageId?: string;
}

/**
 * 脚本执行请求
 */
export interface UnifiedScriptRequest {
  script: string;
  sessionId?: string;
  dryRun?: boolean;
  /** 泛化设备支持：目标设备 ID */
  deviceId?: string;
}

/**
 * 脚本执行响应（包含 AI 分析）
 */
export interface UnifiedScriptResponse {
  result: ScriptExecuteResult;
  analysis?: string;
  sessionId?: string;
}

/**
 * 统一执行历史类型
 */
export type ExecutionType = 'script' | 'tool_call';

/**
 * 统一执行历史条目
 * Requirement 3.5: 统一执行历史管理
 */
export interface UnifiedExecutionHistory {
  id: string;
  sessionId: string;
  type: ExecutionType;
  timestamp: Date;
  // 脚本执行相关
  script?: string;
  scriptResult?: ScriptExecuteResult;
  // 工具调用相关
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolDuration?: number;
  // 通用字段
  success: boolean;
  error?: string;
}

/**
 * 执行历史查询选项
 */
export interface ExecutionHistoryQuery {
  sessionId?: string;
  type?: ExecutionType;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}


/**
 * RAG 服务依赖接口
 * Requirement 1.2: 通过接口抽象而非直接引用实现解耦
 */
export interface RAGDependencies {
  ragEngine?: IRAGEngine;
  knowledgeBase?: IKnowledgeBase;
  mastraAgent?: IMastraAgent;
}

/**
 * UnifiedAgentService 统一代理服务类
 */
export class UnifiedAgentService {
  /**
   * 纯知识检索工具集合（不算工具执行）
   * 反向排除逻辑：只要 tools 中有不在此集合中的工具，就视为需要工具执行
   * Requirements (fastpath-intent-gating): 2.1, 2.2
   */
  private static readonly KNOWLEDGE_ONLY_TOOLS = new Set([
    'knowledge_search',
  ]);

  /**
   * IntentAnalyzer 前置调用的超时时间（毫秒）
   * 比 IntentAnalyzer 默认的 30s 更短，避免纯知识查询等待过久
   * Requirements (fastpath-intent-gating): P2 优化
   */
  private static readonly INTENT_GATING_TIMEOUT_MS = 30000;

  private chatSessionService: ChatSessionService;
  private contextBuilderService: ContextBuilderService;
  private scriptExecutorService: ScriptExecutorService;
  private apiConfigService: APIConfigService;
  private rerankerService: RerankerService;
  private initialized: boolean = false;

  // Requirements (ai-ops-code-review-fixes): 5.1, 5.5, 5.6 - 工具注册标志位
  // 用于确保工具只在初始化时注册一次，避免运行时竞态条件
  private toolsRegistered: boolean = false;

  // 智能摘要服务
  // Requirements: 4.1 - 集成 TokenBudgetManager 和 KnowledgeSummarizer
  private tokenBudgetManager: TokenBudgetManager;
  private knowledgeSummarizer: KnowledgeSummarizer;

  // RAG 相关服务（通过依赖注入或延迟加载）
  // Requirement 1.1: 使用依赖注入模式而非动态导入加载 RAG 模块
  private _knowledgeBase: IKnowledgeBase | null = null;
  private _mastraAgent: IMastraAgent | null = null;
  private _ragEngine: IRAGEngine | null = null;

  // Skill 系统
  private _skillManager: SkillManager | null = null;
  private _skillFactory: import('../ai-ops/skill/skillFactory').SkillFactory | null = null;
  private skillSystemEnabled: boolean = true;

  // Skill 感知的 ReAct 控制器和意图分析器
  private _skillAwareReActController: SkillAwareReActController | null = null;
  private _intentAnalyzer: IntentAnalyzer | null = null;

  // Fast Path Router
  private _fastPathRouter: FastPathRouter | null = null;
  private fastPathEnabled: boolean = true;

  // State Machine Integration (lightweight-state-machine)
  // Requirements: 9.3, 9.4 - Feature flag routing for gradual migration
  private _featureFlagManager: FeatureFlagManager | null = null;
  private _stateMachineOrchestrator: StateMachineOrchestrator | null = null;

  // 泛化设备支持：DeviceManager 引用
  // Requirements: J2.6 - 通过 deviceId + DeviceManager 管理设备
  private deviceManagerRef: DeviceManager | null = null;

  // 标记是否使用依赖注入
  private useDependencyInjection: boolean = false;

  /**
   * 判断 IntentAnalysis 是否需要工具执行
   * 反向排除逻辑：只要 tools 非空且包含任何非 knowledge_search 的工具，就需要工具执行
   * Requirements (fastpath-intent-gating): 2.1, 2.2
   * 
   * @param intentAnalysis IntentAnalyzer 返回的意图分析结果
   * @returns true 表示需要工具执行（跳过 FastPath），false 表示纯知识查询（走 FastPath）
   */
  private requiresToolExecution(intentAnalysis: IntentAnalysis): boolean {
    if (!intentAnalysis.tools || intentAnalysis.tools.length === 0) {
      return false;
    }
    // 反向排除：只要有任何不在 KNOWLEDGE_ONLY_TOOLS 中的工具，就需要工具执行
    return intentAnalysis.tools.some(
      t => !UnifiedAgentService.KNOWLEDGE_ONLY_TOOLS.has(t.name)
    );
  }

  constructor(
    sessionService?: ChatSessionService,
    contextBuilder?: ContextBuilderService,
    scriptExecutor?: ScriptExecutorService,
    configService?: APIConfigService,
    ragDependencies?: RAGDependencies,
    reranker?: RerankerService
  ) {
    this.chatSessionService = sessionService || chatSessionService;
    this.contextBuilderService = contextBuilder || contextBuilderService;
    this.scriptExecutorService = scriptExecutor || scriptExecutorService;
    this.apiConfigService = configService || apiConfigService;
    this.rerankerService = reranker || rerankerService;

    // 初始化智能摘要服务
    // Requirements: 4.1 - 在构造函数中初始化新依赖
    this.tokenBudgetManager = new TokenBudgetManager();
    this.knowledgeSummarizer = new KnowledgeSummarizer();

    // Requirement 1.1: 支持通过构造函数注入 RAG 依赖
    if (ragDependencies) {
      this._ragEngine = ragDependencies.ragEngine || null;
      this._knowledgeBase = ragDependencies.knowledgeBase || null;
      this._mastraAgent = ragDependencies.mastraAgent || null;
      this.useDependencyInjection = true;
      logger.info('UnifiedAgentService created with injected RAG dependencies');
    } else {
      logger.info('UnifiedAgentService created (RAG dependencies will be loaded lazily)');
    }
  }

  /**
   * 设置 RAG 引擎（用于依赖注入）
   * Requirement 1.1: 支持依赖注入
   */
  setRAGEngine(ragEngine: IRAGEngine): void {
    this._ragEngine = ragEngine;
    logger.debug('RAGEngine injected into UnifiedAgentService');
  }

  /**
   * 设置知识库（用于依赖注入）
   * Requirement 1.1: 支持依赖注入
   */
  setKnowledgeBase(knowledgeBase: IKnowledgeBase): void {
    this._knowledgeBase = knowledgeBase;
    logger.debug('KnowledgeBase injected into UnifiedAgentService');
  }

  /**
   * 设置 Mastra Agent（用于依赖注入）
   * Requirement 1.1: 支持依赖注入
   */
  setMastraAgent(mastraAgent: IMastraAgent): void {
    this._mastraAgent = mastraAgent;
    logger.debug('MastraAgent injected into UnifiedAgentService');
  }

  /**
   * 设置 SkillManager（用于依赖注入）
   */
  setSkillManager(skillManager: SkillManager): void {
    this._skillManager = skillManager;
    logger.debug('SkillManager injected into UnifiedAgentService');
  }

  /**
   * 启用/禁用 Skill 系统
   */
  setSkillSystemEnabled(enabled: boolean): void {
    this.skillSystemEnabled = enabled;
    logger.info(`Skill system ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 启用/禁用 Fast Path
   */
  setFastPathEnabled(enabled: boolean): void {
    this.fastPathEnabled = enabled;
    if (this._fastPathRouter) {
      this._fastPathRouter.updateConfig({ enabled });
    }
    logger.info(`Fast path ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 设置 FeatureFlagManager（用于状态机迁移路由）
   * Requirements: 9.3, 9.4
   */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this._featureFlagManager = manager;
    logger.debug('FeatureFlagManager injected into UnifiedAgentService');
  }

  /**
   * 设置 StateMachineOrchestrator（用于状态机迁移路由）
   * Requirements: 9.3, 9.4
   */
  setStateMachineOrchestrator(orchestrator: StateMachineOrchestrator): void {
    this._stateMachineOrchestrator = orchestrator;
    logger.debug('StateMachineOrchestrator injected into UnifiedAgentService');
  }

  /**
   * 注入 SkillFactory（向量检索 + 执行引擎）
   * Requirements: E7.22 — UnifiedAgentService 通过 SkillFactory 发现和执行统一工具
   */
  setSkillFactory(sf: import('../ai-ops/skill/skillFactory').SkillFactory): void {
    this._skillFactory = sf;
    logger.debug('SkillFactory injected into UnifiedAgentService');
  }

  /**
   * 注入 DeviceManager（泛化设备支持）
   * Requirements: J2.6 - 通过 deviceId + DeviceManager 管理设备
   */
  setDeviceManager(dm: DeviceManager): void {
    this.deviceManagerRef = dm;
    logger.debug('DeviceManager injected into UnifiedAgentService');
  }

  /**
   * 获取 FastPathRouter 实例
   * 修复：正确传入 AI Adapter 以支持 LLM 查询改写
   */
  private get fastPathRouter(): FastPathRouter | null {
    if (this._fastPathRouter) {
      return this._fastPathRouter;
    }

    // 延迟初始化 FastPathRouter
    if (this.fastPathEnabled && this.knowledgeBase) {
      // 创建 AI Adapter 包装器，用于 QueryRewriter 的 LLM 调用
      const aiAdapter = this.createFastPathAIAdapter();

      this._fastPathRouter = createFastPathRouter(
        this.knowledgeBase as any, // KnowledgeBase 类型兼容
        aiAdapter,
        { enabled: this.fastPathEnabled }
      );
      return this._fastPathRouter;
    }

    return null;
  }

  /**
   * 创建快速路径 AI Adapter
   * 用于 QueryRewriter 的 LLM 调用
   */
  private createFastPathAIAdapter(): any {
    const self = this;
    return {
      async chat(options: {
        provider: string;
        model: string;
        messages: Array<{ role: string; content: string }>;
        stream: boolean;
      }): Promise<{ content: string }> {
        try {
          // 获取默认 API 配置
          const defaultConfig = await self.apiConfigService.getDefault();
          if (!defaultConfig) {
            throw new Error('No default API config found for FastPath LLM');
          }

          // 获取解密的 API Key
          const apiKey = await self.apiConfigService.getDecryptedApiKey(defaultConfig.id);

          // 创建适配器
          const adapter = AdapterFactory.createAdapter(defaultConfig.provider, {
            apiKey,
            endpoint: defaultConfig.endpoint,
          });

          // 执行 LLM 调用 - 使用配置中的 provider 和 model，并正确转换消息类型
          const response = await adapter.chat({
            provider: defaultConfig.provider,
            model: options.model || defaultConfig.model,
            messages: options.messages.map(m => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
            })),
            stream: false,
          });

          return { content: response.content };
        } catch (error) {
          logger.warn('FastPath AI adapter chat failed', { error });
          throw error;
        }
      },
    };
  }

  /**
   * 获取 SkillManager 实例
   */
  private get skillManager(): SkillManager | null {
    if (this._skillManager) {
      return this._skillManager;
    }

    // 使用默认的 skillManager 单例
    if (this.skillSystemEnabled) {
      this._skillManager = defaultSkillManager;
      return this._skillManager;
    }

    return null;
  }

  /**
   * 获取 SkillAwareReActController 实例
   */
  private get skillAwareReActController(): SkillAwareReActController | null {
    if (this._skillAwareReActController) {
      return this._skillAwareReActController;
    }

    // 使用默认的 skillAwareReActController 单例
    if (this.skillSystemEnabled) {
      this._skillAwareReActController = defaultSkillAwareReActController;
      return this._skillAwareReActController;
    }

    return null;
  }

  /**
   * 获取 IntentAnalyzer 实例
   */
  private get intentAnalyzer(): IntentAnalyzer | null {
    if (this._intentAnalyzer) {
      return this._intentAnalyzer;
    }

    // 使用默认的 intentAnalyzer 单例
    this._intentAnalyzer = defaultIntentAnalyzer;
    return this._intentAnalyzer;
  }

  /**
   * 获取 RAG 引擎实例
   * 优先使用注入的实例，其次从服务容器获取，最后回退到动态导入
   */
  private get ragEngine(): IRAGEngine | null {
    if (this._ragEngine) {
      return this._ragEngine;
    }

    // 尝试从服务容器获取
    const containerEngine = serviceContainer.tryResolve<IRAGEngine>(RAG_SERVICE_TOKENS.RAG_ENGINE);
    if (containerEngine) {
      this._ragEngine = containerEngine;
      return this._ragEngine;
    }

    return null;
  }

  /**
   * 获取知识库实例
   * 优先使用注入的实例，其次从服务容器获取，最后回退到动态导入
   */
  private get knowledgeBase(): IKnowledgeBase | null {
    if (this._knowledgeBase) {
      return this._knowledgeBase;
    }

    // 尝试从服务容器获取
    const containerKB = serviceContainer.tryResolve<IKnowledgeBase>(RAG_SERVICE_TOKENS.KNOWLEDGE_BASE);
    if (containerKB) {
      this._knowledgeBase = containerKB;
      return this._knowledgeBase;
    }

    return null;
  }

  /**
   * 获取 Mastra Agent 实例
   * 优先使用注入的实例，其次从服务容器获取，最后回退到动态导入
   */
  private get mastraAgent(): IMastraAgent | null {
    if (this._mastraAgent) {
      return this._mastraAgent;
    }

    // 尝试从服务容器获取
    const containerAgent = serviceContainer.tryResolve<IMastraAgent>(RAG_SERVICE_TOKENS.MASTRA_AGENT);
    if (containerAgent) {
      this._mastraAgent = containerAgent;
      return this._mastraAgent;
    }

    return null;
  }

  /**
   * 初始化服务
   * Requirement 1.3: 服务初始化失败时提供明确的错误信息
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('UnifiedAgentService already initialized');
      return;
    }

    try {
      // 如果已经通过依赖注入设置了 RAG 服务，直接初始化它们
      if (this.useDependencyInjection) {
        await this.initializeInjectedServices();
      } else {
        // 回退到动态导入（向后兼容）
        await this.initializeWithDynamicImport();
      }

      // 设置 Skill 系统的 AI adapter factory（用于 LLM 智能路由）
      await this.setupSkillAIAdapterFactory();

      // Requirements (fastpath-intent-gating): P0 - 为 IntentAnalyzer 设置 AI adapter
      // 确保 Phase 1 前置意图分析能使用 LLM 而非关键词回退
      await this.setupIntentAnalyzerAdapter();

      // Requirements (ai-ops-code-review-fixes): 5.1, 5.2, 5.3 - 在初始化时注册工具
      await this.registerToolsOnce();

      this.initialized = true;
      logger.info('UnifiedAgentService initialized');
    } catch (error) {
      // Requirement 1.3: 提供明确的错误信息
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to initialize UnifiedAgentService', {
        error: errorMessage,
        useDependencyInjection: this.useDependencyInjection
      });
      // 即使 RAG 服务初始化失败，标准模式仍可用
      this.initialized = true;
    }
  }

  /**
   * 设置 Skill 系统的 AI adapter factory
   * 用于 LLM 智能路由功能
   */
  private async setupSkillAIAdapterFactory(): Promise<void> {
    if (!this.skillSystemEnabled || !this.skillManager) {
      return;
    }

    try {
      // 创建 adapter factory，延迟获取默认 API 配置
      const adapterFactory = async () => {
        try {
          // 获取默认 API 配置
          const defaultConfig = await this.apiConfigService.getDefault();
          if (!defaultConfig) {
            logger.warn('No default API config found for Skill LLM routing');
            return null;
          }

          // 获取解密的 API Key
          const apiKey = await this.apiConfigService.getDecryptedApiKey(defaultConfig.id);

          // 创建适配器
          const adapter = AdapterFactory.createAdapter(defaultConfig.provider, {
            apiKey,
            endpoint: defaultConfig.endpoint,
          });

          return {
            adapter,
            provider: defaultConfig.provider,
            model: defaultConfig.model,
          };
        } catch (error) {
          logger.warn('Failed to create AI adapter for Skill routing', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      };

      // 设置到 SkillManager
      this.skillManager.setAIAdapterFactory(adapterFactory);
      logger.info('Skill AI adapter factory configured for LLM routing');
    } catch (error) {
      logger.warn('Failed to setup Skill AI adapter factory', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 为 IntentAnalyzer 设置 AI adapter
   * 确保 Phase 1 前置意图分析能使用 LLM 进行准确的意图判断
   * Requirements (fastpath-intent-gating): 1.1, 1.3
   */
  private async setupIntentAnalyzerAdapter(): Promise<void> {
    if (!this.intentAnalyzer) {
      return;
    }

    // 如果已经有 adapter，跳过
    if (this.intentAnalyzer.hasAIAdapter()) {
      logger.debug('IntentAnalyzer already has AI adapter, skipping setup');
      return;
    }

    try {
      const defaultConfig = await this.apiConfigService.getDefault();
      if (!defaultConfig) {
        logger.warn('No default API config found for IntentAnalyzer, will use keyword fallback');
        return;
      }

      const apiKey = await this.apiConfigService.getDecryptedApiKey(defaultConfig.id);
      const adapter = AdapterFactory.createAdapter(defaultConfig.provider, {
        apiKey,
        endpoint: defaultConfig.endpoint,
      });

      this.intentAnalyzer.setAIAdapter(adapter, defaultConfig.provider, defaultConfig.model);
      logger.info('IntentAnalyzer AI adapter configured for intent gating', {
        provider: defaultConfig.provider,
        model: defaultConfig.model,
      });
    } catch (error) {
      logger.warn('Failed to setup IntentAnalyzer AI adapter, will use keyword fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 一次性注册工具到 baseController
   * 使用标志位确保幂等性，避免运行时竞态条件
   * 
   * Requirements (ai-ops-code-review-fixes): 5.1, 5.2, 5.5, 5.6
   * - 5.1: 在 initialize() 方法中注册工具到 baseController
   * - 5.2: initialize() 完成后 baseController 拥有所有 predefinedTools
   * - 5.5: 如果工具已注册，跳过注册而不进行运行时检查
   * - 5.6: 工具注册是幂等的 - 多次调用 initialize() 不会重复注册工具
   */
  private async registerToolsOnce(): Promise<void> {
    if (this.toolsRegistered) {
      logger.debug('Tools already registered, skipping');
      return;
    }

    if (this.skillSystemEnabled && this.skillAwareReActController) {
      const baseController = this.skillAwareReActController.getBaseController();
      baseController.registerTools(predefinedTools);

      // E7.22: 当 SkillFactory 可用时，注册统一工具列表（Skill + MCP + DeviceDriver）
      if (this._skillFactory) {
        try {
          const skillTools = this._skillFactory.getAllToolsAsAgentTools();
          baseController.registerTools(skillTools);
          logger.info('SkillFactory tools registered to baseController', {
            skillToolCount: skillTools.length,
          });
        } catch (err) {
          logger.warn(`Failed to register SkillFactory tools: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      this.toolsRegistered = true;
      logger.info('Predefined tools registered to baseController during initialization', {
        toolCount: predefinedTools.length,
      });
    }
  }

  /**
   * 初始化注入的服务
   * Requirement 1.1: 使用依赖注入模式
   */
  private async initializeInjectedServices(): Promise<void> {
    // 初始化 RAGEngine
    if (this._ragEngine && !this._ragEngine.isInitialized()) {
      try {
        await this._ragEngine.initialize();
        logger.info('Injected RAGEngine initialized');
      } catch (error) {
        logger.warn('Failed to initialize injected RAGEngine', { error });
      }
    }

    // 初始化 KnowledgeBase
    if (this._knowledgeBase && !this._knowledgeBase.isInitialized()) {
      try {
        await this._knowledgeBase.initialize();
        logger.info('Injected KnowledgeBase initialized');
      } catch (error) {
        logger.warn('Failed to initialize injected KnowledgeBase', { error });
      }
    }

    // 初始化 MastraAgent
    if (this._mastraAgent && !this._mastraAgent.isInitialized()) {
      try {
        await this._mastraAgent.initialize();
        logger.info('Injected MastraAgent initialized');
      } catch (error) {
        logger.warn('Failed to initialize injected MastraAgent', { error });
      }
    }
  }

  /**
   * 使用动态导入初始化（向后兼容）
   * 注意：此方法将在未来版本中弃用，请使用依赖注入
   */
  private async initializeWithDynamicImport(): Promise<void> {
    try {
      // 延迟加载 RAG 服务以避免循环依赖
      const ragModule = await import('../ai-ops/rag');

      // 设置服务实例（类型转换为接口）
      this._knowledgeBase = ragModule.knowledgeBase as unknown as IKnowledgeBase;
      this._mastraAgent = ragModule.mastraAgent as unknown as IMastraAgent;
      this._ragEngine = ragModule.ragEngine as unknown as IRAGEngine;

      // 初始化 RAGEngine
      if (this._ragEngine && !this._ragEngine.isInitialized?.()) {
        try {
          await this._ragEngine.initialize();
          logger.info('RAGEngine initialized for knowledge retrieval delegation');
        } catch (error) {
          logger.warn('Failed to initialize RAGEngine, knowledge-enhanced mode may not work', { error });
        }
      }

      // 初始化 KnowledgeBase
      if (this._knowledgeBase && !this._knowledgeBase.isInitialized?.()) {
        try {
          await this._knowledgeBase.initialize();
        } catch (error) {
          logger.warn('Failed to initialize KnowledgeBase, knowledge-enhanced mode may not work', { error });
        }
      }

      // 初始化 MastraAgent
      if (this._mastraAgent && !this._mastraAgent.isInitialized?.()) {
        try {
          await this._mastraAgent.initialize();
        } catch (error) {
          logger.warn('Failed to initialize MastraAgent, tool calls may not work', { error });
        }
      }
    } catch (error) {
      logger.warn('Failed to load RAG module via dynamic import', { error });
    }
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('UnifiedAgentService not initialized. Call initialize() first.');
    }
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ==================== 核心对话方法 ====================

  /**
   * 发送消息（非流式）
   * Requirement 1.1: 统一入口
   * Skill System Integration: 6.1, 7.10
   */
  async chat(request: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    this.ensureInitialized();

    const startTime = Date.now();
    let selectedSkill: SkillMatchResult | null = null;

    try {
      // 获取或创建会话
      const session = await this.getOrCreateSession(request);

      // Skill 系统集成：选择 Skill
      if (this.skillSystemEnabled && this.skillManager) {
        const skillOptions = request.skillOptions || {};
        if (skillOptions.enableSkillSystem !== false) {
          try {
            selectedSkill = await this.skillManager.selectSkill(
              request.message,
              session.id,
              { skillOverride: skillOptions.skillOverride }
            );
            logger.debug('Skill selected for chat', {
              skill: selectedSkill.skill.metadata.name,
              matchType: selectedSkill.matchType,
              confidence: selectedSkill.confidence,
            });
          } catch (error) {
            logger.warn('Failed to select Skill, continuing without Skill', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // 根据模式处理请求
      let response: UnifiedChatResponse;
      if (request.mode === 'knowledge-enhanced') {
        response = await this.handleKnowledgeEnhancedChat(request, session.id, selectedSkill);
      } else {
        response = await this.handleStandardChat(request, session.id);
      }

      // 添加 Skill 信息到响应
      if (selectedSkill) {
        response.skill = {
          name: selectedSkill.skill.metadata.name,
          description: selectedSkill.skill.metadata.description,
          matchType: selectedSkill.matchType,
          confidence: selectedSkill.confidence,
        };

        // 记录 Skill 使用完成
        const responseTime = Date.now() - startTime;
        this.skillManager?.recordCompletion(
          selectedSkill.skill.metadata.name,
          true,
          responseTime
        );
      }

      return response;
    } catch (error) {
      // 记录 Skill 使用失败
      if (selectedSkill && this.skillManager) {
        const responseTime = Date.now() - startTime;
        this.skillManager.recordCompletion(
          selectedSkill.skill.metadata.name,
          false,
          responseTime
        );
      }

      logger.error('Chat request failed', { error, mode: request.mode });
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      logger.debug(`Chat request completed in ${duration}ms`, { mode: request.mode });
    }
  }

  /**
   * 流式发送消息
   * Requirement 1.1: 统一入口，支持流式响应
   * Skill System Integration: 6.1, 7.10
   */
  async chatStream(
    request: UnifiedChatRequest,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void> {
    this.ensureInitialized();

    const startTime = Date.now();
    let selectedSkill: SkillMatchResult | null = null;

    try {
      // 获取或创建会话
      const session = await this.getOrCreateSession(request);

      // Skill 系统集成：选择 Skill（知识增强模式）
      if (request.mode === 'knowledge-enhanced' && this.skillSystemEnabled && this.skillManager) {
        const skillOptions = request.skillOptions || {};
        if (skillOptions.enableSkillSystem !== false) {
          try {
            selectedSkill = await this.skillManager.selectSkill(
              request.message,
              session.id,
              { skillOverride: skillOptions.skillOverride }
            );
            logger.debug('Skill selected for stream chat', {
              skill: selectedSkill.skill.metadata.name,
              matchType: selectedSkill.matchType,
              confidence: selectedSkill.confidence,
            });
            // 发送 Skill 选择信息
            onChunk({
              type: 'reasoning',
              reasoning: `使用 Skill: ${selectedSkill.skill.metadata.name} (置信度: ${(selectedSkill.confidence * 100).toFixed(1)}%)`
            });
          } catch (error) {
            logger.warn('Failed to select Skill for stream, continuing without Skill', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // 根据模式处理请求
      if (request.mode === 'knowledge-enhanced') {
        await this.handleKnowledgeEnhancedChatStream(request, session.id, onChunk, selectedSkill);
      } else {
        await this.handleStandardChatStream(request, session.id, onChunk);
      }

      // 记录 Skill 使用完成
      if (selectedSkill && this.skillManager) {
        const responseTime = Date.now() - startTime;
        this.skillManager.recordCompletion(
          selectedSkill.skill.metadata.name,
          true,
          responseTime
        );
      }
    } catch (error) {
      // 记录 Skill 使用失败
      if (selectedSkill && this.skillManager) {
        const responseTime = Date.now() - startTime;
        this.skillManager.recordCompletion(
          selectedSkill.skill.metadata.name,
          false,
          responseTime
        );
      }

      logger.error('Stream chat request failed', { error, mode: request.mode });
      onChunk({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const duration = Date.now() - startTime;
      logger.debug(`Stream chat request completed in ${duration}ms`, { mode: request.mode });
    }
  }

  /**
   * 执行脚本
   * Requirement 3.1: 支持设备脚本执行
   */
  async executeScript(request: UnifiedScriptRequest): Promise<ScriptExecuteResult> {
    this.ensureInitialized();

    try {
      const result = await this.scriptExecutorService.execute({
        script: request.script,
        dryRun: request.dryRun,
        deviceId: request.deviceId,
      });

      // 如果有会话 ID，记录执行历史
      if (request.sessionId) {
        await this.scriptExecutorService.addHistory(
          request.script,
          result,
          request.sessionId
        );
        logger.debug(`Script executed in session ${request.sessionId}`);
      }

      return result;
    } catch (error) {
      logger.error('Script execution failed', { error });
      throw error;
    }
  }

  /**
   * 执行脚本并分析结果
   * Requirement 3.4: 脚本执行后自动发送输出到 AI 进行分析
   */
  async executeScriptWithAnalysis(
    request: UnifiedScriptRequest,
    configId: string
  ): Promise<UnifiedScriptResponse> {
    this.ensureInitialized();

    // 执行脚本
    const result = await this.executeScript(request);

    // 如果执行成功且有输出，进行 AI 分析
    let analysis: string | undefined;
    if (result.success && result.output && request.sessionId) {
      try {
        // 构建分析请求
        const deviceLabel = '设备';
        const analysisMessage = `请分析以下${deviceLabel}命令执行结果：\n\n命令：\n\`\`\`\n${request.script}\n\`\`\`\n\n执行结果：\n\`\`\`\n${result.output}\n\`\`\`\n\n请简要说明执行结果的含义，以及是否有需要注意的问题。`;

        const analysisResponse = await this.chat({
          configId,
          sessionId: request.sessionId,
          message: analysisMessage,
          mode: 'standard',
          includeContext: true,
        });

        analysis = analysisResponse.content;
      } catch (error) {
        logger.warn('Failed to analyze script result', { error });
        // 分析失败不影响主流程
      }
    }

    return {
      result,
      analysis,
      sessionId: request.sessionId,
    };
  }

  // ==================== 统一执行历史管理 ====================

  /**
   * 获取统一执行历史
   * Requirement 3.5: 统一执行历史管理
   */
  async getExecutionHistory(query: ExecutionHistoryQuery = {}): Promise<UnifiedExecutionHistory[]> {
    this.ensureInitialized();

    const history: UnifiedExecutionHistory[] = [];

    // 获取脚本执行历史
    if (!query.type || query.type === 'script') {
      const scriptHistory = await this.scriptExecutorService.getHistory(query.sessionId);

      for (const sh of scriptHistory) {
        // 应用日期过滤
        const timestamp = new Date(sh.createdAt);
        if (query.startDate && timestamp < query.startDate) continue;
        if (query.endDate && timestamp > query.endDate) continue;

        history.push({
          id: sh.id,
          sessionId: sh.sessionId,
          type: 'script',
          timestamp,
          script: sh.script,
          scriptResult: sh.result,
          success: sh.result.success,
          error: sh.result.error,
        });
      }
    }

    // 获取工具调用历史（从 MastraAgent）
    if (!query.type || query.type === 'tool_call') {
      if (this.mastraAgent && this.mastraAgent.isInitialized()) {
        try {
          const sessions = this.mastraAgent.getSessions();

          for (const session of sessions) {
            // 会话过滤
            if (query.sessionId && session.sessionId !== query.sessionId) continue;

            // 从会话消息中提取工具调用
            for (const message of session.messages) {
              if (message.toolCalls && message.toolCalls.length > 0) {
                const timestamp = new Date(session.lastUpdated);

                // 应用日期过滤
                if (query.startDate && timestamp < query.startDate) continue;
                if (query.endDate && timestamp > query.endDate) continue;

                for (const tc of message.toolCalls) {
                  const toolResult = message.toolResults?.find((tr: { id: string; result: unknown }) => tr.id === tc.id);

                  history.push({
                    id: tc.id,
                    sessionId: session.sessionId,
                    type: 'tool_call',
                    timestamp,
                    toolName: tc.name,
                    toolInput: tc.arguments,
                    toolOutput: toolResult?.result,
                    success: toolResult !== undefined,
                  });
                }
              }
            }
          }
        } catch (error) {
          logger.warn('Failed to get tool call history from MastraAgent', { error });
        }
      }
    }

    // 按时间倒序排序
    history.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // 应用分页
    const offset = query.offset || 0;
    const limit = query.limit || 100;

    return history.slice(offset, offset + limit);
  }

  /**
   * 获取会话的执行历史
   * Requirement 3.5: 统一执行历史管理
   */
  async getSessionExecutionHistory(sessionId: string): Promise<UnifiedExecutionHistory[]> {
    return this.getExecutionHistory({ sessionId });
  }

  /**
   * 清理执行历史
   * Requirement 3.5: 统一执行历史管理
   */
  async clearExecutionHistory(sessionId?: string): Promise<void> {
    this.ensureInitialized();

    // 清理脚本执行历史
    if (sessionId) {
      await this.scriptExecutorService.clearSessionHistory(sessionId);
    } else {
      await this.scriptExecutorService.clearAllHistory();
    }

    // 清理 MastraAgent 会话（如果指定了 sessionId）
    if (sessionId && this.mastraAgent && this.mastraAgent.isInitialized()) {
      try {
        await this.mastraAgent.clearSession(sessionId);
      } catch (error) {
        logger.warn('Failed to clear MastraAgent session', { error });
      }
    }

    logger.info(`Cleared execution history${sessionId ? ` for session ${sessionId}` : ''}`);
  }

  /**
   * 获取执行历史统计
   * Requirement 3.5: 统一执行历史管理
   */
  async getExecutionHistoryStats(sessionId?: string): Promise<{
    totalExecutions: number;
    scriptExecutions: number;
    toolCalls: number;
    successRate: number;
    recentExecutions: number;
  }> {
    const history = await this.getExecutionHistory({ sessionId, limit: 10000 });

    const scriptExecutions = history.filter(h => h.type === 'script').length;
    const toolCalls = history.filter(h => h.type === 'tool_call').length;
    const successfulExecutions = history.filter(h => h.success).length;

    // 最近 24 小时的执行
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentExecutions = history.filter(h => h.timestamp > oneDayAgo).length;

    return {
      totalExecutions: history.length,
      scriptExecutions,
      toolCalls,
      successRate: history.length > 0 ? successfulExecutions / history.length : 0,
      recentExecutions,
    };
  }


  // ==================== 标准模式处理 ====================

  /**
   * 处理标准模式对话（非流式）
   */
  private async handleStandardChat(
    request: UnifiedChatRequest,
    sessionId: string
  ): Promise<UnifiedChatResponse> {
    // 获取 API 配置
    const config = await this.apiConfigService.getById(request.configId);
    if (!config) {
      throw new Error(`API config not found: ${request.configId}`);
    }

    // 获取解密的 API Key
    const apiKey = await this.apiConfigService.getDecryptedApiKey(request.configId);

    // 构建消息列表
    const messages = await this.buildMessages(request, sessionId);

    // 创建适配器并发送请求
    const adapter = AdapterFactory.createAdapter(config.provider, {
      apiKey,
      endpoint: config.endpoint,
    });
    const response = await adapter.chat({
      provider: config.provider,
      model: config.model,
      messages,
      stream: false,
    });

    // 保存消息到会话
    await this.chatSessionService.addMessage(sessionId, {
      role: 'user',
      content: request.message,
    });
    await this.chatSessionService.addMessage(sessionId, {
      role: 'assistant',
      content: response.content,
    });

    return {
      content: response.content,
      sessionId,
      usage: response.usage,
    };
  }

  /**
   * 处理标准模式流式对话
   */
  private async handleStandardChatStream(
    request: UnifiedChatRequest,
    sessionId: string,
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void> {
    // 获取 API 配置
    const config = await this.apiConfigService.getById(request.configId);
    if (!config) {
      throw new Error(`API config not found: ${request.configId}`);
    }

    // 获取解密的 API Key
    const apiKey = await this.apiConfigService.getDecryptedApiKey(request.configId);

    // 构建消息列表
    const messages = await this.buildMessages(request, sessionId);

    // 创建适配器
    const adapter = AdapterFactory.createAdapter(config.provider, {
      apiKey,
      endpoint: config.endpoint,
    });

    // 保存用户消息
    await this.chatSessionService.addMessage(sessionId, {
      role: 'user',
      content: request.message,
    });

    // 流式发送请求
    let fullContent = '';
    const stream = adapter.chatStream({
      provider: config.provider,
      model: config.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      fullContent += chunk;
      onChunk({
        type: 'content',
        content: chunk,
      });
    }

    // 保存助手消息（预生成 ID 以便返回给前端）
    const assistantMsgId = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
    await this.chatSessionService.addMessage(sessionId, {
      id: assistantMsgId,
      role: 'assistant',
      content: fullContent,
    });

    // 发送完成信号（包含消息 ID，前端收藏功能依赖此 ID）
    onChunk({
      type: 'done',
      messageId: assistantMsgId,
    });
  }

  // ==================== 知识增强模式处理 ====================

  /**
   * 处理知识增强模式对话（非流式）
   * Requirement 2.1: 先检索知识再生成响应
   * Requirement 2.2: 检索完成后流式响应
   * Requirement 2.3: 显示知识引用
   * Requirement 2.6: 显示置信度评分
   * 
   * Skill System Integration: 6.1, 7.10
   * - 使用 SkillAwareReActController.executeLoop() 执行 Skill 感知的 ReAct 循环
   * - 知识检索在 SARC 内部执行，避免重复检索
   * - Skill 配置（temperature, maxIterations, allowedTools）实际生效
   */
  private async handleKnowledgeEnhancedChat(
    request: UnifiedChatRequest,
    sessionId: string,
    selectedSkill?: SkillMatchResult | null
  ): Promise<UnifiedChatResponse> {
    const ragOptions = request.ragOptions || {};
    const citations: RAGCitation[] = [];
    const toolCalls: AgentToolCall[] = [];
    const reasoning: string[] = [];
    let confidence = 0.5;

    try {
      // 预检索知识（用于 FastPath enhanced 模式传递给 SARC）
      let preRetrievedKnowledge: FormattedKnowledge[] | undefined;

      // ==================== 阶段 1：IntentAnalyzer 前置意图分析 ====================
      // Requirements (fastpath-intent-gating): 1.1, 1.2, 1.3, 4.1, 4.2, 4.3
      // 在 FastPath 之前调用 LLM 分析意图，决定走知识库还是工具执行
      let intentAnalysis: IntentAnalysis | null = null;
      let skipFastPath = false;

      // 对话意图修复：获取对话历史用于意图分析
      // 确保 IntentAnalyzer 能够理解多轮对话的上下文
      let conversationHistory: ChatMessage[] = [];
      try {
        const session = await this.chatSessionService.getById(sessionId);
        if (session && session.messages.length > 0) {
          // 基于相关性筛选对话历史，替代简单的 slice(-20)
          // Requirements: conversation-and-reflection-optimization 1.3
          const scorer = new RelevanceScorer();
          conversationHistory = scorer.selectRelevant(request.message, session.messages, 10);
        }
      } catch (historyError) {
        logger.warn('Failed to get conversation history for intent analysis', { error: historyError });
      }

      if (this.intentAnalyzer) {
        try {
          reasoning.push('正在执行 LLM 意图分析...');
          // P0 修复：传入 predefinedTools 而非空数组，确保 fallback 和 parseResponse 能正确识别工具
          // P2 优化：使用更短的超时，避免纯知识查询等待过久
          // 对话意图修复：传入对话历史，确保意图分析能理解多轮对话上下文
          const intentPromise = this.intentAnalyzer.analyzeIntent(request.message, predefinedTools, conversationHistory);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Intent gating timeout')), UnifiedAgentService.INTENT_GATING_TIMEOUT_MS)
          );
          intentAnalysis = await Promise.race([intentPromise, timeoutPromise]);

          skipFastPath = this.requiresToolExecution(intentAnalysis);

          if (skipFastPath) {
            reasoning.push(
              `意图分析：需要工具执行（${intentAnalysis.tools.map(t => t.name).join(', ')}），跳过 FastPath`
            );
          } else {
            reasoning.push('意图分析：纯知识查询，走 FastPath 知识库检索');
          }
        } catch (intentError) {
          // IntentAnalyzer 失败时回退到当前行为（先走 FastPath）
          logger.warn('IntentAnalyzer failed, falling back to FastPath-first flow', {
            error: intentError instanceof Error ? intentError.message : String(intentError),
          });
          reasoning.push('意图分析失败，回退到 FastPath 优先流程');
          skipFastPath = false;
        }
      }

      // ==================== 阶段 2：FastPath 预处理（仅纯知识查询） ====================
      // Requirements (fastpath-intent-gating): 2.3, 2.4, 3.1, 3.2
      // 仅在 IntentAnalyzer 判定为纯知识查询时才执行 FastPath
      if (!skipFastPath && this.fastPathEnabled && this.fastPathRouter) {
        try {
          reasoning.push('正在执行快速路径预检索...');
          const fastPathResult = await this.fastPathRouter.route(request.message);

          // 根据快速路径结果决定后续处理
          if (fastPathResult.skipReAct && fastPathResult.mode === 'direct') {
            // 直达模式：直接返回知识库答案
            reasoning.push(`快速路径命中（直达模式），置信度: ${fastPathResult.confidence.toFixed(2)}`);

            // 转换引用
            if (fastPathResult.citations) {
              for (const citation of fastPathResult.citations) {
                citations.push({
                  entryId: citation.entryId,
                  title: citation.title,
                  content: citation.excerpt,
                  score: citation.relevance,
                  type: 'knowledge',
                });
              }
            }

            // 保存消息到会话
            await this.chatSessionService.addMessage(sessionId, {
              role: 'user',
              content: request.message,
            });
            await this.chatSessionService.addMessage(sessionId, {
              role: 'assistant',
              content: fastPathResult.response || '',
            });

            return {
              content: fastPathResult.response || '',
              sessionId,
              ragContext: {
                retrievalTime: fastPathResult.processingTime,
                totalRetrievals: citations.length,
                avgRelevanceScore: fastPathResult.confidence,
              },
              citations,
              reasoning,
              confidence: fastPathResult.confidence,
            };
          } else if (fastPathResult.mode === 'enhanced') {
            // 增强模式：使用预检索结果作为上下文，继续 ReAct 处理
            reasoning.push(`快速路径命中（增强模式），置信度: ${fastPathResult.confidence.toFixed(2)}`);

            // 将预检索结果添加到引用
            if (fastPathResult.citations) {
              for (const citation of fastPathResult.citations) {
                citations.push({
                  entryId: citation.entryId,
                  title: citation.title,
                  content: citation.excerpt,
                  score: citation.relevance,
                  type: 'knowledge',
                });
              }
            }

            // 将 FastPath 预检索的 RetrievedKnowledge[] 转换为 FormattedKnowledge[]
            // Requirements: 2.1 - 预检索结果传递给 SARC 复用，避免重复检索
            if (fastPathResult.knowledge && fastPathResult.knowledge.length > 0) {
              preRetrievedKnowledge = fastPathResult.knowledge.map(doc => ({
                referenceId: `KB-${doc.type}-${doc.id.substring(0, 8)}`,
                entryId: doc.id,
                title: doc.title,
                type: doc.type as KnowledgeType,
                credibilityScore: doc.score,
                credibilityLevel: (doc.score >= 0.7 ? 'high' : doc.score >= 0.4 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
                fullContent: doc.content,
                content: doc.content,
                summary: doc.content.substring(0, 200),
                metadata: doc.metadata,
                citationHint: `参考 [KB-${doc.type}-${doc.id.substring(0, 8)}]`,
              }));
            }

            // 继续后续处理，但已有预检索结果
            confidence = fastPathResult.confidence;
          } else if (fastPathResult.mode === 'explicit_notification') {
            // 明确告知模式：知识库无相关内容
            reasoning.push('快速路径：知识库无相关记录');
            if (fastPathResult.knowledgeGap) {
              reasoning.push(`已记录知识缺口: ${fastPathResult.knowledgeGap.id}`);
            }

            // 明确告知模式：提前返回，不进入 ReAct 循环
            // Requirements: 5.4 - 明确告知用户并提供替代建议
            const explicitResponse = fastPathResult.response ||
              '抱歉，知识库中暂无相关记录。建议您：\n1. 尝试使用不同的关键词描述问题\n2. 查看系统实时状态获取更多信息\n3. 如果这是一个常见问题，可以考虑添加到知识库';

            // 保存消息到会话
            await this.chatSessionService.addMessage(sessionId, {
              role: 'user',
              content: request.message,
            });
            await this.chatSessionService.addMessage(sessionId, {
              role: 'assistant',
              content: explicitResponse,
            });

            return {
              content: explicitResponse,
              sessionId,
              ragContext: {
                retrievalTime: fastPathResult.processingTime,
                totalRetrievals: 0,
                avgRelevanceScore: 0,
              },
              reasoning,
              confidence: 0,
            };
          } else {
            // 探索模式：继续标准 ReAct 流程
            reasoning.push(`快速路径：进入探索模式，耗时 ${fastPathResult.processingTime.toFixed(0)}ms`);
          }
        } catch (fastPathError) {
          // 快速路径失败时优雅降级
          logger.warn('Fast path failed, continuing with standard flow', { error: fastPathError });
          reasoning.push('快速路径预检索失败，继续标准流程');
        }
      }

      // ==================== 阶段 3：SARC/ReAct 循环 ====================
      // 如果有 Skill 且启用了 SkillAwareReActController，使用 SARC 执行
      // Requirements: 6.1, 7.10
      // Requirements (fastpath-intent-gating): 2.5, 5.6 - 复用阶段 1 的 IntentAnalysis
      if (selectedSkill && this.skillAwareReActController && this.intentAnalyzer) {
        reasoning.push(`使用 Skill: ${selectedSkill.skill.metadata.name}`);

        // 1. 复用阶段 1 的意图分析结果，避免重复 LLM 调用
        // 对话意图修复：如果需要重新分析，传入对话历史
        const finalIntentAnalysis = intentAnalysis
          || await this.intentAnalyzer.analyzeIntent(request.message, predefinedTools, conversationHistory);

        // 2. 构建对话上下文
        const conversationMemory: ConversationMemory = {
          sessionId,
          messages: [],
          context: {},
          createdAt: Date.now(),
          lastUpdated: Date.now(),
        };

        // 获取会话历史
        try {
          const session = await this.chatSessionService.getById(sessionId);
          if (session) {
            conversationMemory.messages = session.messages.map((m: { role: string; content: string }) => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
            }));
          }
        } catch (error) {
          logger.warn('Failed to get session history', { error });
        }

        // 对话意图修复：将当前用户消息添加到对话上下文中
        // 确保 ReAct 循环能够看到完整的对话上下文（包括当前消息）
        conversationMemory.messages.push({
          role: 'user' as const,
          content: request.message,
        });

        // 3. 获取 AI 适配器配置（但不设置到单例实例）
        const config = await this.apiConfigService.getById(request.configId);
        if (!config) {
          throw new Error(`API config not found: ${request.configId}`);
        }
        const apiKey = await this.apiConfigService.getDecryptedApiKey(request.configId);
        const adapter = AdapterFactory.createAdapter(config.provider, {
          apiKey,
          endpoint: config.endpoint,
        });

        // 4. 执行 Skill 感知的 ReAct 循环
        // 并发安全：通过 options 传递 AI 适配器，而非设置到单例实例
        // 关键：知识检索在 SARC 内部执行，避免重复检索

        // Requirements (ai-ops-code-review-fixes): 5.3, 5.4 - 工具已在 initialize() 中注册
        // 不再需要运行时检查，避免竞态条件

        reasoning.push('正在执行 Skill 感知的 ReAct 循环...');
        // Requirements: 9.3, 9.4 - Route through FeatureFlagManager for gradual migration
        const executeLoopOptions = {
          skill: selectedSkill.skill,
          sessionId,
          applySkillConfig: true,
          filterTools: true,
          useSkillKnowledge: true,
          // 并发安全：通过 options 传递 AI 适配器
          aiAdapter: adapter,
          provider: config.provider,
          model: config.model,
          // 新增：传递预检索结果
          preRetrievedKnowledge,
          skipKnowledgeRetrieval: !!preRetrievedKnowledge,
          // 多设备支持：传递请求级设备 ID
          // Requirements: 8.1, 8.2
          deviceId: request.deviceId,
        };
        const reActResult = await this.executeReActWithRouting(
          request.message,
          finalIntentAnalysis,
          conversationMemory,
          executeLoopOptions,
        );

        // 5. 从 ReAct 结果构建响应
        const finalAnswer = reActResult.finalAnswer;

        // 提取工具调用
        for (const step of reActResult.steps) {
          if (step.type === 'action' && step.toolName) {
            toolCalls.push({
              id: `tool_${toolCalls.length}`,
              tool: step.toolName,
              input: step.toolInput || {},
              output: step.toolOutput,
              duration: step.duration || 0,
            });
          }
          if (step.type === 'thought' && step.content) {
            reasoning.push(step.content);
          }
        }

        // 提取知识引用
        if (reActResult.knowledgeReferences) {
          for (const ref of reActResult.knowledgeReferences) {
            citations.push({
              entryId: ref.entryId,
              title: ref.title,
              content: '', // 内容在 SARC 内部已处理
              score: ref.score ?? (ref.isValid ? 0.8 : 0.3),
              type: ref.type,
            });
          }
        }

        // 计算置信度
        if (reActResult.skillMetrics) {
          confidence = reActResult.reachedMaxIterations ? 0.4 : 0.8;
          if (reActResult.skillKnowledgeResult?.documentCount && reActResult.skillKnowledgeResult.documentCount > 0) {
            confidence = Math.min(confidence + 0.1, 1.0);
          }
        }

        // 6. 保存消息到会话
        await this.chatSessionService.addMessage(sessionId, {
          role: 'user',
          content: request.message,
        });
        await this.chatSessionService.addMessage(sessionId, {
          role: 'assistant',
          content: finalAnswer,
          // Fix: 将 usedLearningEntryIds 持久化到 assistant 消息的 metadata 中
          // 用于后续反馈 API 提取并传递给 feedbackService.recordFeedback
          metadata: reActResult.usedLearningEntryIds?.length
            ? { usedLearningEntryIds: reActResult.usedLearningEntryIds }
            : undefined,
        });

        reasoning.push(`ReAct 循环完成，迭代 ${reActResult.iterations} 次`);
        if (reActResult.skillKnowledgeResult) {
          reasoning.push(`知识检索: ${reActResult.skillKnowledgeResult.documentCount} 条文档，耗时 ${reActResult.skillKnowledgeResult.retrievalTime}ms`);
        }

        // 转换 ReAct 步骤为响应格式
        const responseReActSteps: ResponseReActStep[] = reActResult.steps.map(step => ({
          type: step.type,
          content: step.content,
          timestamp: step.timestamp,
          toolName: step.toolName,
          toolInput: step.toolInput,
          toolOutput: step.toolOutput,
          duration: step.duration,
        }));

        return {
          content: finalAnswer,
          sessionId,
          ragContext: reActResult.skillKnowledgeResult ? {
            retrievalTime: reActResult.skillKnowledgeResult.retrievalTime,
            totalRetrievals: reActResult.skillKnowledgeResult.documentCount,
            avgRelevanceScore: 0.7, // SARC 内部已过滤低分文档
          } : undefined,
          citations: citations.length > 0 ? citations : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning,
          confidence,
          skill: reActResult.skill,
          // 新增：返回 ReAct 步骤和意图分析
          reactSteps: responseReActSteps,
          intentAnalysis: {
            intent: finalIntentAnalysis.intent,
            tools: finalIntentAnalysis.tools,
            confidence: finalIntentAnalysis.confidence,
          },
        };
      }

      // 回退到原有逻辑（无 Skill 或 SARC 不可用时）
      // 1. 检索相关知识
      // Requirement 2.1: 知识增强模式下先检索知识
      reasoning.push('正在检索相关知识...');
      const retrievalStart = Date.now();
      const searchResults = await this.retrieveKnowledge(request.message, ragOptions);
      const retrievalTime = Date.now() - retrievalStart;

      // 转换为引用
      for (const result of searchResults) {
        citations.push({
          entryId: result.entry.id,
          title: result.entry.title,
          content: result.entry.content.substring(0, 500),
          score: result.score,
          type: result.entry.type,
        });
      }

      reasoning.push(`检索到 ${citations.length} 条相关知识，耗时 ${retrievalTime}ms`);

      // 2. 如果启用工具调用，使用 MastraAgent
      // Requirement 1.5: 知识增强模式支持工具调用
      if (ragOptions.includeTools && this.mastraAgent && this.mastraAgent.isInitialized()) {
        reasoning.push('正在分析是否需要工具调用...');
        try {
          const agentResponse = await this.mastraAgent.chat(request.message, sessionId);

          toolCalls.push(...agentResponse.toolCalls.map((tc: any, i: number) => ({
            id: `tool_${i}`,
            tool: tc.tool,
            input: tc.input,
            output: tc.output,
            duration: tc.duration,
          })));

          reasoning.push(...agentResponse.reasoning);

          // 使用 Agent 的置信度作为基础
          if (agentResponse.confidence > confidence) {
            confidence = agentResponse.confidence;
          }
        } catch (error) {
          logger.warn('MastraAgent tool call failed', { error });
          reasoning.push('工具调用失败，继续使用知识检索结果');
        }
      }

      // 3. 构建增强的消息列表
      const messages = await this.buildEnhancedMessages(request, sessionId, citations);

      // 4. 获取 API 配置并生成响应
      const config = await this.apiConfigService.getById(request.configId);
      if (!config) {
        throw new Error(`API config not found: ${request.configId}`);
      }

      // 获取解密的 API Key
      const apiKey = await this.apiConfigService.getDecryptedApiKey(request.configId);

      const adapter = AdapterFactory.createAdapter(config.provider, {
        apiKey,
        endpoint: config.endpoint,
      });
      const response = await adapter.chat({
        provider: config.provider,
        model: config.model,
        messages,
        stream: false,
      });

      // 5. 保存消息到会话
      await this.chatSessionService.addMessage(sessionId, {
        role: 'user',
        content: request.message,
      });
      await this.chatSessionService.addMessage(sessionId, {
        role: 'assistant',
        content: response.content,
      });

      // 6. 计算最终置信度
      // Requirement 2.6: 显示置信度评分
      if (citations.length > 0) {
        const avgScore = citations.reduce((sum, c) => sum + c.score, 0) / citations.length;
        confidence = Math.max(confidence, avgScore);
      }

      // 7. 记录知识使用（用于反馈追踪）
      await this.recordKnowledgeUsage(citations);

      return {
        content: response.content,
        sessionId,
        ragContext: {
          retrievalTime,
          totalRetrievals: citations.length,
          avgRelevanceScore: citations.length > 0
            ? citations.reduce((sum, c) => sum + c.score, 0) / citations.length
            : 0,
        },
        citations,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning,
        confidence,
        usage: response.usage,
      };
    } catch (error) {
      // 知识检索失败时回退到标准模式
      // Requirement 2.5: 检索失败时回退并通知用户
      const errorMessage = error instanceof KnowledgeRetrievalError
        ? error.getUserFriendlyMessage()
        : '知识检索失败，回退到标准模式';

      logger.warn('Knowledge retrieval failed, falling back to standard mode', {
        error,
        errorCode: error instanceof KnowledgeRetrievalError ? error.code : 'UNKNOWN'
      });
      reasoning.push(errorMessage);

      const standardResponse = await this.handleStandardChat(request, sessionId);
      return {
        ...standardResponse,
        reasoning,
        confidence: 0.3,
      };
    }
  }

  /**
   * 记录知识使用（用于效果追踪）
   */
  private async recordKnowledgeUsage(citations: RAGCitation[]): Promise<void> {
    if (!this.knowledgeBase || citations.length === 0) {
      return;
    }

    try {
      for (const citation of citations) {
        await this.knowledgeBase.recordUsage(citation.entryId);
      }
    } catch (error) {
      logger.warn('Failed to record knowledge usage', { error });
    }
  }


  /**
   * 处理知识增强模式流式对话
   * Requirement 2.2: 知识检索完成后流式响应
   * Requirement 2.4: 显示知识检索状态
   * Skill System Integration: 6.1, 7.10
   * - 使用 SkillAwareReActController.executeLoop() 执行 Skill 感知的 ReAct 循环
   * - 知识检索在 SARC 内部执行，避免重复检索
   */
  private async handleKnowledgeEnhancedChatStream(
    request: UnifiedChatRequest,
    sessionId: string,
    onChunk: (chunk: StreamChunk) => void,
    selectedSkill?: SkillMatchResult | null
  ): Promise<void> {
    const ragOptions = request.ragOptions || {};
    const citations: RAGCitation[] = [];
    const toolCalls: AgentToolCall[] = [];
    const reactSteps: ResponseReActStep[] = [];

    try {
      // 预检索知识（用于 FastPath enhanced 模式传递给 SARC）
      let preRetrievedKnowledge: FormattedKnowledge[] | undefined;

      // ==================== 阶段 1：IntentAnalyzer 前置意图分析（流式路径） ====================
      // Requirements (fastpath-intent-gating): 1.1, 1.2, 1.3, 4.1, 4.2, 4.3
      // 与非流式路径保持一致：在 FastPath 之前调用 LLM 分析意图
      let intentAnalysis: IntentAnalysis | null = null;
      let skipFastPath = false;

      // 对话意图修复：获取对话历史用于意图分析（流式路径）
      let conversationHistoryStream: ChatMessage[] = [];
      try {
        const session = await this.chatSessionService.getById(sessionId);
        if (session && session.messages.length > 0) {
          // 基于相关性筛选对话历史，替代简单的 slice(-20)
          // Requirements: conversation-and-reflection-optimization 1.3
          const scorer = new RelevanceScorer();
          conversationHistoryStream = scorer.selectRelevant(request.message, session.messages, 10);
        }
      } catch (historyError) {
        logger.warn('Failed to get conversation history for intent analysis (stream)', { error: historyError });
      }

      if (this.intentAnalyzer) {
        try {
          onChunk({ type: 'reasoning', reasoning: '正在执行 LLM 意图分析...' });
          // 对话意图修复：传入对话历史
          const intentPromise = this.intentAnalyzer.analyzeIntent(request.message, predefinedTools, conversationHistoryStream);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Intent gating timeout')), UnifiedAgentService.INTENT_GATING_TIMEOUT_MS)
          );
          intentAnalysis = await Promise.race([intentPromise, timeoutPromise]);

          skipFastPath = this.requiresToolExecution(intentAnalysis);

          if (skipFastPath) {
            onChunk({ type: 'reasoning', reasoning: `意图分析：需要工具执行（${intentAnalysis.tools.map(t => t.name).join(', ')}），跳过 FastPath` });
          } else {
            onChunk({ type: 'reasoning', reasoning: '意图分析：纯知识查询，走 FastPath 知识库检索' });
          }
        } catch (intentError) {
          logger.warn('IntentAnalyzer failed in stream mode, falling back to FastPath-first flow', {
            error: intentError instanceof Error ? intentError.message : String(intentError),
          });
          onChunk({ type: 'reasoning', reasoning: '意图分析失败，回退到 FastPath 优先流程' });
          skipFastPath = false;
        }
      }

      // ==================== 阶段 2：FastPath 预处理（仅纯知识查询，流式路径） ====================
      // Requirements (fastpath-intent-gating): 2.3, 2.4, 3.1, 3.2
      if (!skipFastPath && this.fastPathEnabled && this.fastPathRouter) {
        try {
          onChunk({ type: 'reasoning', reasoning: '正在执行快速路径预检索...' });
          const fastPathResult = await this.fastPathRouter.route(request.message);

          if (fastPathResult.mode === 'enhanced') {
            // 增强模式：将预检索结果转换为 FormattedKnowledge[] 传递给 SARC
            onChunk({ type: 'reasoning', reasoning: `快速路径命中（增强模式），置信度: ${fastPathResult.confidence.toFixed(2)}` });

            // 将预检索结果添加到引用
            if (fastPathResult.citations) {
              for (const citation of fastPathResult.citations) {
                citations.push({
                  entryId: citation.entryId,
                  title: citation.title,
                  content: citation.excerpt,
                  score: citation.relevance,
                  type: 'knowledge',
                });
                onChunk({
                  type: 'citation', citation: {
                    entryId: citation.entryId,
                    title: citation.title,
                    content: citation.excerpt,
                    score: citation.relevance,
                    type: 'knowledge',
                  }
                });
              }
            }

            // 将 FastPath 预检索的 RetrievedKnowledge[] 转换为 FormattedKnowledge[]
            // Requirements: 2.1 - 预检索结果传递给 SARC 复用，避免重复检索
            if (fastPathResult.knowledge && fastPathResult.knowledge.length > 0) {
              preRetrievedKnowledge = fastPathResult.knowledge.map(doc => ({
                referenceId: `KB-${doc.type}-${doc.id.substring(0, 8)}`,
                entryId: doc.id,
                title: doc.title,
                type: doc.type as KnowledgeType,
                credibilityScore: doc.score,
                credibilityLevel: (doc.score >= 0.7 ? 'high' : doc.score >= 0.4 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
                fullContent: doc.content,
                content: doc.content,
                summary: doc.content.substring(0, 200),
                metadata: doc.metadata,
                citationHint: `参考 [KB-${doc.type}-${doc.id.substring(0, 8)}]`,
              }));
            }
          } else if (fastPathResult.skipReAct && fastPathResult.mode === 'direct') {
            // 直达模式：直接返回知识库答案（与非流式路径行为一致）
            onChunk({ type: 'reasoning', reasoning: `快速路径命中（直达模式），置信度: ${fastPathResult.confidence.toFixed(2)}` });

            if (fastPathResult.citations) {
              for (const citation of fastPathResult.citations) {
                const c: RAGCitation = {
                  entryId: citation.entryId,
                  title: citation.title,
                  content: citation.excerpt,
                  score: citation.relevance,
                  type: 'knowledge',
                };
                onChunk({ type: 'citation', citation: c });
              }
            }

            // 流式发送直达答案
            const directResponse = fastPathResult.response || '';
            const chunkSize = 50;
            for (let i = 0; i < directResponse.length; i += chunkSize) {
              onChunk({ type: 'content', content: directResponse.substring(i, i + chunkSize) });
              await new Promise(resolve => setTimeout(resolve, 10));
            }

            // 保存消息到会话（预生成 ID 以便返回给前端）
            await this.chatSessionService.addMessage(sessionId, { role: 'user', content: request.message });
            const directMsgId = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
            await this.chatSessionService.addMessage(sessionId, { id: directMsgId, role: 'assistant', content: directResponse });

            onChunk({ type: 'done', messageId: directMsgId });
            return;
          } else if (fastPathResult.mode === 'explicit_notification') {
            // 明确告知模式：知识库无相关内容（与非流式路径行为一致）
            onChunk({ type: 'reasoning', reasoning: '快速路径：知识库无相关记录' });

            const explicitResponse = fastPathResult.response ||
              '抱歉，知识库中暂无相关记录。建议您：\n1. 尝试使用不同的关键词描述问题\n2. 查看系统实时状态获取更多信息\n3. 如果这是一个常见问题，可以考虑添加到知识库';

            const chunkSize = 50;
            for (let i = 0; i < explicitResponse.length; i += chunkSize) {
              onChunk({ type: 'content', content: explicitResponse.substring(i, i + chunkSize) });
              await new Promise(resolve => setTimeout(resolve, 10));
            }

            // 保存消息到会话（预生成 ID 以便返回给前端）
            await this.chatSessionService.addMessage(sessionId, { role: 'user', content: request.message });
            const explicitMsgId = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
            await this.chatSessionService.addMessage(sessionId, { id: explicitMsgId, role: 'assistant', content: explicitResponse });

            onChunk({ type: 'done', messageId: explicitMsgId });
            return;
          } else {
            // 探索模式：继续标准流程
            onChunk({ type: 'reasoning', reasoning: `快速路径：进入探索模式，耗时 ${fastPathResult.processingTime.toFixed(0)}ms` });
          }
        } catch (fastPathError) {
          // 快速路径失败时优雅降级
          logger.warn('Fast path failed in stream mode, continuing with standard flow', { error: fastPathError });
          onChunk({ type: 'reasoning', reasoning: '快速路径预检索失败，继续标准流程' });
        }
      }

      // 如果有 Skill 且启用了 SkillAwareReActController，使用 SARC 执行
      // Requirements: 6.1, 7.10
      // Requirements (fastpath-intent-gating): 2.5, 5.6 - 复用阶段 1 的 IntentAnalysis
      if (selectedSkill && this.skillAwareReActController && this.intentAnalyzer) {
        onChunk({ type: 'reasoning', reasoning: '正在执行 Skill 感知的 ReAct 循环...' });

        // 1. 复用阶段 1 的意图分析结果，避免重复 LLM 调用
        // 对话意图修复：如果需要重新分析，传入对话历史
        const finalIntentAnalysis = intentAnalysis
          || await this.intentAnalyzer.analyzeIntent(request.message, predefinedTools, conversationHistoryStream);

        // 2. 构建对话上下文
        const conversationMemory: ConversationMemory = {
          sessionId,
          messages: [],
          context: {},
          createdAt: Date.now(),
          lastUpdated: Date.now(),
        };

        // 获取会话历史
        try {
          const session = await this.chatSessionService.getById(sessionId);
          if (session) {
            conversationMemory.messages = session.messages.map((m: { role: string; content: string }) => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
            }));
          }
        } catch (error) {
          logger.warn('Failed to get session history for stream', { error });
        }

        // 对话意图修复：将当前用户消息添加到对话上下文中（流式路径）
        // 确保 ReAct 循环能够看到完整的对话上下文（包括当前消息）
        conversationMemory.messages.push({
          role: 'user' as const,
          content: request.message,
        });

        // 3. 获取 AI 适配器配置
        const config = await this.apiConfigService.getById(request.configId);
        if (!config) {
          throw new Error(`API config not found: ${request.configId}`);
        }
        const apiKey = await this.apiConfigService.getDecryptedApiKey(request.configId);
        const adapter = AdapterFactory.createAdapter(config.provider, {
          apiKey,
          endpoint: config.endpoint,
        });

        // 4. 执行 Skill 感知的 ReAct 循环
        // Requirements (ai-ops-code-review-fixes): 5.3, 5.4 - 工具已在 initialize() 中注册
        // 不再需要运行时检查，避免竞态条件

        // Requirements: 9.3, 9.4 - Route through FeatureFlagManager for gradual migration
        const streamExecuteLoopOptions = {
          skill: selectedSkill.skill,
          sessionId,
          applySkillConfig: true,
          filterTools: true,
          useSkillKnowledge: true,
          aiAdapter: adapter,
          provider: config.provider,
          model: config.model,
          // 新增：传递预检索结果（流式路径）
          preRetrievedKnowledge,
          skipKnowledgeRetrieval: !!preRetrievedKnowledge,
          // 多设备支持：传递请求级设备 ID
          // Requirements: 8.1, 8.2
          deviceId: request.deviceId,
        };
        const reActResult = await this.executeReActWithRouting(
          request.message,
          finalIntentAnalysis,
          conversationMemory,
          streamExecuteLoopOptions,
        );

        // 5. 流式发送 ReAct 步骤
        for (const step of reActResult.steps) {
          const responseStep: ResponseReActStep = {
            type: step.type,
            content: step.content,
            timestamp: step.timestamp,
            toolName: step.toolName,
            toolInput: step.toolInput,
            toolOutput: step.toolOutput,
            duration: step.duration,
          };
          reactSteps.push(responseStep);

          // 发送步骤信息
          if (step.type === 'thought') {
            onChunk({ type: 'reasoning', reasoning: `思考: ${step.content}` });
          } else if (step.type === 'action' && step.toolName) {
            const toolCall: AgentToolCall = {
              id: `tool_${toolCalls.length}`,
              tool: step.toolName,
              input: step.toolInput || {},
              output: step.toolOutput,
              duration: step.duration || 0,
            };
            toolCalls.push(toolCall);
            onChunk({ type: 'tool_call', toolCall });
          } else if (step.type === 'observation') {
            onChunk({ type: 'reasoning', reasoning: `观察: ${step.content.substring(0, 200)}...` });
          }
        }

        // 6. 提取知识引用
        if (reActResult.knowledgeReferences) {
          for (const ref of reActResult.knowledgeReferences) {
            const citation: RAGCitation = {
              entryId: ref.entryId,
              title: ref.title,
              content: '',
              score: ref.score ?? (ref.isValid ? 0.8 : 0.3),
              type: ref.type,
            };
            citations.push(citation);
            onChunk({ type: 'citation', citation });
          }
        }

        // 7. 流式发送最终答案
        const finalAnswer = reActResult.finalAnswer;
        // 模拟流式输出（将答案分块发送）
        const chunkSize = 50;
        for (let i = 0; i < finalAnswer.length; i += chunkSize) {
          const chunk = finalAnswer.substring(i, i + chunkSize);
          onChunk({ type: 'content', content: chunk });
          // 小延迟模拟流式效果
          await new Promise(resolve => setTimeout(resolve, 10));
        }

        // 8. 保存消息到会话（预生成 ID 以便返回给前端）
        await this.chatSessionService.addMessage(sessionId, {
          role: 'user',
          content: request.message,
        });
        const sarcMsgId = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
        await this.chatSessionService.addMessage(sessionId, {
          id: sarcMsgId,
          role: 'assistant',
          content: finalAnswer,
          // Fix: 流式路径也需要持久化 usedLearningEntryIds，与非流式路径保持一致
          metadata: reActResult.usedLearningEntryIds?.length
            ? { usedLearningEntryIds: reActResult.usedLearningEntryIds }
            : undefined,
        });

        // 9. 计算真实置信度（与非流式路径保持一致）
        let streamConfidence = 0.5;
        if (reActResult.skillMetrics) {
          streamConfidence = reActResult.reachedMaxIterations ? 0.4 : 0.8;
          if (reActResult.skillKnowledgeResult?.documentCount && reActResult.skillKnowledgeResult.documentCount > 0) {
            streamConfidence = Math.min(streamConfidence + 0.1, 1.0);
          }
        }

        // 10. 发送完成信号（包含消息 ID、置信度和 Skill 信息）
        onChunk({
          type: 'done',
          messageId: sarcMsgId,
          confidence: streamConfidence,
        } as any);

        logger.info('Skill-aware stream chat completed', {
          skill: selectedSkill.skill.metadata.name,
          iterations: reActResult.iterations,
          stepsCount: reactSteps.length,
        });

        return;
      }

      // 回退到原有逻辑（无 Skill 或 SARC 不可用时）
      // 1. 检索相关知识
      // Requirement 2.4: 显示知识检索状态
      onChunk({ type: 'reasoning', reasoning: '正在检索相关知识...' });
      const retrievalStart = Date.now();
      const searchResults = await this.retrieveKnowledge(request.message, ragOptions);
      const retrievalTime = Date.now() - retrievalStart;

      // 发送引用
      // Requirement 2.3: 显示知识引用
      for (const result of searchResults) {
        const citation: RAGCitation = {
          entryId: result.entry.id,
          title: result.entry.title,
          content: result.entry.content.substring(0, 500),
          score: result.score,
          type: result.entry.type,
        };
        citations.push(citation);
        onChunk({ type: 'citation', citation });
      }

      onChunk({ type: 'reasoning', reasoning: `检索到 ${citations.length} 条相关知识，耗时 ${retrievalTime}ms` });

      // 2. 如果启用工具调用，使用 MastraAgent
      if (ragOptions.includeTools && this.mastraAgent && this.mastraAgent.isInitialized()) {
        onChunk({ type: 'reasoning', reasoning: '正在分析是否需要工具调用...' });
        try {
          const agentResponse = await this.mastraAgent.chat(request.message, sessionId);

          for (const tc of agentResponse.toolCalls) {
            const toolCall: AgentToolCall = {
              id: `tool_${toolCalls.length}`,
              tool: tc.tool,
              input: tc.input,
              output: tc.output,
              duration: tc.duration,
            };
            toolCalls.push(toolCall);
            onChunk({ type: 'tool_call', toolCall });
          }

          for (const r of agentResponse.reasoning) {
            onChunk({ type: 'reasoning', reasoning: r });
          }
        } catch (error) {
          logger.warn('MastraAgent tool call failed in stream mode', { error });
          onChunk({ type: 'reasoning', reasoning: '工具调用失败，继续使用知识检索结果' });
        }
      }

      // 3. 构建增强的消息列表
      const messages = await this.buildEnhancedMessages(request, sessionId, citations);

      // 4. 获取 API 配置
      const config = await this.apiConfigService.getById(request.configId);
      if (!config) {
        throw new Error(`API config not found: ${request.configId}`);
      }

      // 获取解密的 API Key
      const apiKey = await this.apiConfigService.getDecryptedApiKey(request.configId);

      // 保存用户消息
      await this.chatSessionService.addMessage(sessionId, {
        role: 'user',
        content: request.message,
      });

      // 5. 流式生成响应
      // Requirement 2.2: 流式响应
      const adapter = AdapterFactory.createAdapter(config.provider, {
        apiKey,
        endpoint: config.endpoint,
      });
      let fullContent = '';
      const stream = adapter.chatStream({
        provider: config.provider,
        model: config.model,
        messages,
        stream: true,
      });

      for await (const chunk of stream) {
        fullContent += chunk;
        onChunk({ type: 'content', content: chunk });
      }

      // 保存助手消息（预生成 ID 以便返回给前端）
      const fallbackMsgId = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
      await this.chatSessionService.addMessage(sessionId, {
        id: fallbackMsgId,
        role: 'assistant',
        content: fullContent,
      });

      // 记录知识使用
      await this.recordKnowledgeUsage(citations);

      // 发送完成信号（包含消息 ID，前端收藏功能依赖此 ID）
      onChunk({ type: 'done', messageId: fallbackMsgId });
    } catch (error) {
      // 知识检索失败时回退到标准模式
      // Requirement 2.5: 检索失败时回退并通知用户
      const errorMessage = error instanceof KnowledgeRetrievalError
        ? error.getUserFriendlyMessage()
        : '知识检索失败，回退到标准模式';

      logger.warn('Knowledge retrieval failed in stream mode, falling back to standard mode', {
        error,
        errorCode: error instanceof KnowledgeRetrievalError ? error.code : 'UNKNOWN'
      });
      onChunk({ type: 'reasoning', reasoning: errorMessage });

      await this.handleStandardChatStream(request, sessionId, onChunk);
    }
  }

  // ==================== 状态机路由 ====================

  /**
   * 通过 FeatureFlagManager 路由 ReAct 执行
   *
   * - Flag OFF (default): 调用原有 skillAwareReActController.executeLoop()
   * - Flag ON: 调用 StateMachineOrchestrator.execute('react-orchestration', ...)
   *
   * Requirements: 9.3 - Feature flag per flow
   * Requirements: 9.4 - Flag off → legacy behavior identical to pre-migration
   */
  private async executeReActWithRouting(
    message: string,
    intentAnalysis: IntentAnalysis,
    conversationMemory: ConversationMemory,
    options: any,
  ): Promise<SkillAwareReActResult> {
    // If FeatureFlagManager is not configured, fall back to legacy directly
    if (!this._featureFlagManager || !this._stateMachineOrchestrator) {
      return this.skillAwareReActController!.executeLoop(
        message,
        intentAnalysis,
        conversationMemory,
        options,
      );
    }

    const orchestrator = this._stateMachineOrchestrator;

    return this._featureFlagManager.route<SkillAwareReActResult>(
      'react-orchestration',
      // State machine path
      async () => {
        const execResult = await orchestrator.execute('react-orchestration', {
          message,
          intentAnalysis,
          conversationContext: conversationMemory,
          executionContext: options,
        });
        // Extract the SkillAwareReActResult from ExecutionResult.output
        return execResult.output.result as SkillAwareReActResult;
      },
      // Legacy path (identical to pre-migration behavior)
      () => this.skillAwareReActController!.executeLoop(
        message,
        intentAnalysis,
        conversationMemory,
        options,
      ),
    );
  }

  // ==================== 辅助方法 ====================

  /**
   * 获取或创建会话
   */
  private async getOrCreateSession(request: UnifiedChatRequest): Promise<{ id: string }> {
    if (request.sessionId) {
      const session = await this.chatSessionService.getById(request.sessionId);
      if (session) {
        return { id: session.id };
      }
    }

    // 获取配置以确定 provider 和 model
    const config = await this.apiConfigService.getById(request.configId);
    if (!config) {
      throw new Error(`API config not found: ${request.configId}`);
    }

    logger.info(`[UnifiedAgentService] Creating session - Provider: ${config.provider}, Model: ${config.model}, TenantId: ${request.tenantId}, DeviceId: ${request.deviceId}`);

    const session = await this.chatSessionService.create(
      config.provider,
      config.model,
      undefined,
      request.tenantId,
      request.deviceId
    );
    return { id: session.id };
  }

  /**
   * 构建消息列表
   * Requirement 1.4: 标准模式支持上下文注入
   */
  private async buildMessages(
    request: UnifiedChatRequest,
    sessionId: string
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];

    // 添加系统提示词（包含设备上下文）
    if (request.includeContext !== false) {
      const systemPrompt = await this.buildSystemPromptWithContext(request.deviceId);
      messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    // 添加历史消息
    const session = await this.chatSessionService.getById(sessionId);
    if (session) {
      messages.push(...session.messages);
    }

    // 添加当前用户消息
    messages.push({
      role: 'user',
      content: request.message,
    });

    return messages;
  }

  /**
   * 构建带有上下文的系统提示词
   * Requirements: J2.6 - 当 deviceId 可用时，使用泛化设备上下文；否则回退到默认路径
   * Requirement 1.4: 设备上下文注入（向后兼容）
   */
  private async buildSystemPromptWithContext(deviceId?: string): Promise<string> {
    // 泛化设备路径：当 deviceId 可用时，通过 ContextBuilderService 的设备无关方法构建
    if (deviceId) {
      try {
        const deviceContext = await this.contextBuilderService.getConnectionContextForDevice(deviceId);
        return this.contextBuilderService.buildSystemPromptFromDeviceContext(deviceContext);
      } catch (error) {
        logger.warn(`Failed to get device context for ${deviceId}, falling back to default prompt`, { error });
        return this.contextBuilderService.buildSystemPrompt();
      }
    }

    // 向后兼容路径：无 deviceId 时使用默认连接上下文
    try {
      const context = await this.contextBuilderService.getConnectionContext();
      return this.contextBuilderService.buildSystemPromptWithContext(context);
    } catch (error) {
      logger.warn('Failed to get device context, using default prompt', { error });
      return this.contextBuilderService.buildSystemPrompt();
    }
  }

  /**
   * 构建知识增强的消息列表
   * Requirements: 4.1 - 集成智能摘要功能
   */
  private async buildEnhancedMessages(
    request: UnifiedChatRequest,
    sessionId: string,
    citations: RAGCitation[]
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];

    // 获取会话配置
    const session = await this.chatSessionService.getById(sessionId);
    const config = session?.config || DEFAULT_SESSION_CONFIG;
    const maxTokens = config.maxContextTokens;

    // 获取摘要配置
    const summarizationConfig = config.summarization || DEFAULT_SUMMARIZATION_CONFIG;
    const knowledgeSummarizationEnabled = summarizationConfig.knowledgeSummarizationEnabled ?? true;

    // 添加系统提示词（包含知识上下文）
    let systemPrompt = this.contextBuilderService.buildSystemPrompt();

    if (citations.length > 0) {
      systemPrompt += '\n\n【相关知识参考】\n';
      systemPrompt += '以下是从知识库中检索到的相关信息，请参考这些信息回答用户问题：\n\n';

      // Requirements: 4.1, 4.3 - 使用智能摘要处理知识内容
      if (knowledgeSummarizationEnabled) {
        try {
          // 分配 Token 预算
          const allocation = this.tokenBudgetManager.allocateBudget(maxTokens);

          // 智能摘要知识内容
          const summarizedCitations = this.knowledgeSummarizer.summarize(
            citations,
            allocation.knowledgeBudget
          );

          // 使用摘要后的内容构建提示词
          for (const summarized of summarizedCitations) {
            systemPrompt += `--- ${summarized.summaryTitle} ---\n`;
            systemPrompt += `${summarized.summarizedContent}\n`;
            if (summarized.isTruncated) {
              systemPrompt += `[原始内容已智能摘要，原始长度约 ${summarized.originalTokenCount} tokens]\n`;
            }
            systemPrompt += '\n';
          }

          logger.debug('Knowledge content summarized', {
            originalCount: citations.length,
            totalOriginalTokens: summarizedCitations.reduce((sum, c) => sum + c.originalTokenCount, 0),
            totalSummarizedTokens: summarizedCitations.reduce((sum, c) => sum + c.tokenCount, 0),
            truncatedCount: summarizedCitations.filter(c => c.isTruncated).length,
          });
        } catch (error) {
          // Requirement 4.3: 错误回退逻辑
          logger.warn('Knowledge summarization failed, using fallback', { error });
          // 回退到原有的简单拼接逻辑
          for (const citation of citations) {
            systemPrompt += `--- ${citation.title} (相关度: ${(citation.score * 100).toFixed(1)}%) ---\n`;
            systemPrompt += `${citation.content}\n\n`;
          }
        }
      } else {
        // 未启用智能摘要，使用原有逻辑
        for (const citation of citations) {
          systemPrompt += `--- ${citation.title} (相关度: ${(citation.score * 100).toFixed(1)}%) ---\n`;
          systemPrompt += `${citation.content}\n\n`;
        }
      }

      systemPrompt += '请在回答中适当引用上述知识，并标注来源。';
    }

    messages.push({
      role: 'system',
      content: systemPrompt,
    });

    // 添加历史消息
    if (session) {
      messages.push(...session.messages);
    }

    // 添加当前用户消息
    messages.push({
      role: 'user',
      content: request.message,
    });

    return messages;
  }

  /**
   * 检索相关知识
   * Requirement 2.5: 知识检索失败时回退
   * Architecture Optimization Requirements: 4.1, 4.2, 4.4
   * - 4.1: 委托 RAGEngine 执行所有知识检索操作
   * - 4.2: 调用 RAGEngine.query() 方法执行检索
   * - 4.4: 知识检索失败时收到明确的错误类型
   * 
   * WeKnora Integration Requirements: 2.2, 2.3, 2.4, 2.5
   * - 2.2: 当 rerankEnabled 为 true 时调用 RerankerService.rerank
   * - 2.3: 过滤 relevanceScore 低于 rerankThreshold 的结果
   * - 2.4: 阈值降级逻辑
   * - 2.5: 应用 MMR 算法
   */
  private async retrieveKnowledge(
    query: string,
    options: RAGOptions
  ): Promise<Array<{ entry: any; score: number }>> {
    // Requirement 4.1: 委托 RAGEngine 执行所有知识检索操作
    if (!this.ragEngine) {
      logger.warn('RAGEngine not available');
      throw new KnowledgeRetrievalError(
        KnowledgeRetrievalErrorCode.SERVICE_ERROR,
        'RAG 引擎服务不可用'
      );
    }

    if (!this.ragEngine.isInitialized?.()) {
      logger.warn('RAGEngine not initialized');
      throw new KnowledgeRetrievalError(
        KnowledgeRetrievalErrorCode.SERVICE_ERROR,
        'RAG 引擎尚未初始化'
      );
    }

    try {
      // Requirement 4.2: 调用 RAGEngine.query() 方法执行检索
      const ragResult = await this.ragEngine.query(query, {
        topK: options.topK || 5,
        minScore: options.minScore || 0.3,
      });

      // Requirement 4.4: 处理 KnowledgeRetrievalError
      // RAGEngine.query() 返回 RAGQueryResult，需要转换为期望的格式
      // 如果状态是 no_results，返回空数组（不抛出错误，让调用方处理）
      if (ragResult.status === 'no_results' || ragResult.citations.length === 0) {
        logger.info('Knowledge retrieval returned no results', { query: query.substring(0, 100) });
        return [];
      }

      // 转换 RAGQueryResult.citations 为期望的格式
      let results = ragResult.citations.map((citation: { entryId: string; title: string; relevance: number; excerpt: string }) => ({
        entry: {
          id: citation.entryId,
          title: citation.title,
          content: citation.excerpt,
          type: 'knowledge', // 默认类型，RAGEngine 不返回具体类型
        },
        score: citation.relevance,
      }));

      // WeKnora Integration: 应用 Reranker
      if (options.rerankEnabled && results.length > 0) {
        results = await this.applyReranking(query, results, options);
      }

      logger.debug('Knowledge retrieval completed via RAGEngine', {
        query: query.substring(0, 100),
        resultsCount: results.length,
        status: ragResult.status,
        rerankEnabled: options.rerankEnabled,
      });

      return results;
    } catch (error) {
      // Requirement 4.4: 知识检索失败时收到明确的错误类型
      if (error instanceof KnowledgeRetrievalError) {
        // 直接传播 RAGEngine 抛出的 KnowledgeRetrievalError
        logger.warn('Knowledge retrieval failed with KnowledgeRetrievalError', {
          code: error.code,
          message: error.message,
        });
        throw error;
      }

      // 其他错误包装为 SERVICE_ERROR
      logger.error('Knowledge retrieval failed with unexpected error', { error });
      throw new KnowledgeRetrievalError(
        KnowledgeRetrievalErrorCode.SERVICE_ERROR,
        error instanceof Error ? error.message : '知识检索失败'
      );
    }
  }

  /**
   * 应用重排序
   * Requirements: 2.2, 2.3, 2.4, 2.5
   */
  private async applyReranking(
    query: string,
    results: Array<{ entry: any; score: number }>,
    options: RAGOptions
  ): Promise<Array<{ entry: any; score: number }>> {
    const threshold = options.rerankThreshold ?? 0.5;
    const topK = options.rerankTopK ?? 5;

    try {
      // 提取文档内容用于重排序
      const documents = results.map((r) => r.entry.content || r.entry.title);

      // Requirement 2.2: 调用 RerankerService.rerank
      const rerankResults = await this.rerankerService.rerank(query, documents);

      // Requirement 2.3: 阈值过滤
      let filtered = rerankResults.filter((r) => r.relevanceScore >= threshold);

      // Requirement 2.4: 阈值降级逻辑
      if (filtered.length === 0 && threshold > 0.3) {
        const degradedThreshold = Math.max(threshold * 0.7, 0.3);
        logger.info('No results passed threshold, applying degraded threshold', {
          originalThreshold: threshold,
          degradedThreshold,
        });
        filtered = rerankResults.filter((r) => r.relevanceScore >= degradedThreshold);
      }

      // Requirement 2.5: 应用 MMR 算法
      const mmrResults = this.rerankerService.applyMMR(filtered, topK);

      // 映射回原始结果格式
      return mmrResults.map((r) => ({
        entry: results[r.index].entry,
        score: r.relevanceScore,
      }));
    } catch (error) {
      // Reranker 失败时回退到原始结果
      logger.warn('Reranking failed, falling back to original results', { error });
      return results.slice(0, topK);
    }
  }
}

// 导出单例实例
export const unifiedAgentService = new UnifiedAgentService();

export default unifiedAgentService;
