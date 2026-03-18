/**
 * AI 服务模块导出
 *
 * 本模块提供 AI Agent Client 的所有后端服务：
 * - CryptoService: API Key 加密解密
 * - APIConfigService: API 配置管理
 * - ContextBuilderService: 设备上下文构建
 * - ScriptExecutorService: 脚本执行
 * - ChatSessionService: 会话管理
 * - RateLimiterService: 速率限制
 * - AI Provider Adapters: 各 AI 提供商适配器
 */

// CryptoService - API Key 加密解密
export { CryptoService, cryptoService } from './cryptoService';

// APIConfigService - API 配置管理
export { APIConfigService, apiConfigService } from './apiConfigService';

// ContextBuilderService - 设备上下文构建
export { ContextBuilderService, contextBuilderService, DeviceContextInfo } from './contextBuilderService';

// AI Provider Adapters - 各 AI 提供商适配器
export {
  BaseAdapter,
  AdapterConfig,
  AIAdapterError,
  AdapterFactory,
  OpenAIAdapter,
  GeminiAdapter,
  DeepSeekAdapter,
  QwenAdapter,
  ZhipuAdapter,
  CustomAdapter
} from './adapters';

// ScriptExecutorService - 脚本执行服务
export { ScriptExecutorService, scriptExecutorService } from './scriptExecutorService';

// ChatSessionService - 会话管理服务
export { ChatSessionService, chatSessionService } from './chatSessionService';

// RateLimiterService - 速率限制服务
export { RateLimiterService, RateLimiterConfig, rateLimiterService } from './rateLimiterService';

// UnifiedAgentService - 统一 AI Agent 服务
export {
  UnifiedAgentService,
  unifiedAgentService,
  UnifiedChatMode,
  UnifiedChatRequest,
  UnifiedChatResponse,
  StreamChunk,
  RAGContext,
  RAGCitation,
  AgentToolCall,
  RAGOptions,
  UnifiedScriptRequest,
  UnifiedScriptResponse,
  ExecutionType,
  UnifiedExecutionHistory,
  ExecutionHistoryQuery,
} from './unifiedAgentService';

// Re-export KnowledgeRetrievalError from ai-ops types for backward compatibility
export { KnowledgeRetrievalError, KnowledgeRetrievalErrorCode } from '../../types/ai-ops';

// ConversationCollector - 对话收藏和转换服务
export { ConversationCollector, conversationCollector } from './conversationCollector';

// AdapterPool - AI 适配器缓存池
export {
  AdapterPool,
  AdapterKey,
  AdapterPoolConfig,
  AdapterPoolStats,
  IAdapterPool,
  getAdapterPool,
  resetAdapterPool,
} from './adapterPool';

// RerankerService - 重排序服务
export { RerankerService, rerankerService, RerankerError } from './rerankerService';

// PromptTemplateService - 提示词模板服务
export { PromptTemplateService, promptTemplateService } from './promptTemplateService';

// TokenBudgetManager - Token 预算管理器
export {
  TokenBudgetManager,
  tokenBudgetManager,
  BudgetAllocation,
  BudgetUsage,
  TokenBudgetManagerConfig,
} from './tokenBudgetManager';

// KnowledgeSummarizer - 知识内容摘要器
export {
  KnowledgeSummarizer,
  knowledgeSummarizer,
  SummarizedCitation,
  KnowledgeSummarizerConfig,
} from './knowledgeSummarizer';
