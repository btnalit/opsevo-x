/**
 * Agentic RAG 智能检索增强服务导出
 */

// 向量数据库服务（VectorStoreClient 通过 Python Core 执行向量操作）
export {
  VectorStoreClient,
  type VectorDocument as VscVectorDocument,
  type VectorSearchQuery,
  type VectorSearchResult as VscVectorSearchResult,
  type EmbeddingResponse,
} from './vectorStoreClient';

// 向量数据库类型定义（保留从 vectorDatabase.ts 导出的类型，向后兼容）
export {
  type VectorDocument,
  type VectorDocumentMetadata,
  type SearchResult,
  type SearchOptions,
  type CollectionStats,
  type VectorDatabaseConfig,
} from './vectorDatabase';

// 文本嵌入服务
export {
  EmbeddingService,
  embeddingService,
  DEFAULT_EMBEDDING_MODELS,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingConfig,
  type EmbeddingResult,
} from './embeddingService';

// 文档处理器服务
export {
  DocumentProcessor,
  documentProcessor,
  type ChunkOptions,
  type ProcessedDocument,
  type DocumentSource,
} from './documentProcessor';

// 知识库服务
export {
  KnowledgeBase,
  knowledgeBase,
  type KnowledgeEntry,
  type KnowledgeEntryType,
  type KnowledgeQuery,
  type KnowledgeSearchResult,
  type KnowledgeStats,
  type KnowledgeMetadata,
  type KnowledgeEffectiveness,
  type FeedbackToKnowledgeInput,
  type KnowledgeSortOptions,
} from './knowledgeBase';

// ==================== 智能混合检索系统 ====================

// 元数据增强器
export {
  MetadataEnhancer,
  metadataEnhancer,
} from './metadataEnhancer';

// 关键词索引管理器
export {
  KeywordIndexManager,
  keywordIndexManager,
} from './keywordIndexManager';

// RRF 融合排序器
export {
  RRFRanker,
  rrfRanker,
} from './rrfRanker';

// 混合检索引擎
export {
  HybridSearchEngine,
} from './hybridSearchEngine';


// RAG 引擎服务
export {
  RAGEngine,
  ragEngine,
  type AlertCategory,
  type AlertClassification,
  type ReferenceStatus,
  type RAGContext,
  type RAGResponse,
  type RAGQueryResult,
  type RAGConfig,
  type RAGStats,
  type HistoricalAlertReference,
  type EnhancedAlertAnalysis,
  type HistoricalPlanReference,
  type EnhancedRemediationPlan,
  type ConfigRiskAssessment,
} from './ragEngine';

// Mastra Agent 服务
export {
  MastraAgent,
  mastraAgent,
  type AgentTool,
  type AgentMessage,
  type AgentResponse,
  type AgentConfig,
  type ConversationMemory,
  type AgentAuditEntry,
  type AgentStats,
} from './mastraAgent';

// Agent 预定义工具
export {
  knowledgeSearchTool,
  deviceQueryTool,
  alertAnalysisTool,
  generateRemediationTool,
  configDiffTool,
  predefinedTools,
  registerPredefinedTools,
  getToolDescriptions,
} from './agentTools';

// 文件处理器服务
export {
  FileProcessor,
  fileProcessor,
  MarkdownParser,
  TextParser,
  JSONParser,
  SUPPORTED_FILE_TYPES,
  type FileParser,
  type UploadedFile,
  type FileTypeInfo,
  type ParsedContent,
  type ContentChunk,
  type ProcessedFileResult,
  type KnowledgeEntrySchema,
} from './fileProcessor';

// 意图分析服务
export {
  IntentAnalyzer,
  intentAnalyzer,
  type IntentAnalyzerConfig,
} from './intentAnalyzer';

// ReAct 循环控制器
export {
  ReActLoopController,
  reactLoopController,
  type ReActLoopControllerConfig,
  type ReActLoopResult,
} from './reactLoopController';

// 响应生成器
export {
  ResponseGenerator,
  responseGenerator,
  type ResponseGeneratorConfig,
} from './responseGenerator';

// ==================== 智能知识应用系统 ====================

// 智能检索类型
export * from './types/intelligentRetrieval';
export * from './types/credibility';
export * from './types/validation';
export * from './types/formatting';

// 可信度计算器
export {
  CredibilityCalculator,
  credibilityCalculator,
} from './credibilityCalculator';

// 知识格式化器
export {
  KnowledgeFormatter,
  knowledgeFormatter,
} from './knowledgeFormatter';

// 输出验证器
export {
  OutputValidator,
  outputValidator,
} from './outputValidator';

// 智能检索器
export {
  IntelligentRetriever,
  intelligentRetriever,
} from './intelligentRetriever';

// 提示词构建器
export {
  PromptBuilder,
  promptBuilder,
} from './promptBuilder';

// 使用追踪器
export {
  UsageTracker,
  usageTracker,
  type UsageContext,
  type ResolutionResult,
  type UsageStats,
  type EffectivenessStats,
  type UsageTrackerConfig,
} from './usageTracker';

// ToolOutputSummarizer - 工具输出摘要器
export {
  ToolOutputSummarizer,
  toolOutputSummarizer,
  type SummarizedToolOutput,
  type ToolOutputSummarizerConfig,
} from './toolOutputSummarizer';

// ==================== 智能知识快速路径 ====================

// 快速路径意图分类器
export {
  FastPathIntentClassifier,
  fastPathIntentClassifier,
  type FastPathIntentClassifierConfig,
} from './fastPathIntentClassifier';

// 同义词扩展器
export {
  SynonymExpander,
  synonymExpander,
  type SynonymExpanderConfig,
} from './synonymExpander';

// 查询改写器
export {
  QueryRewriter,
  createQueryRewriter,
  type QueryRewriterConfig,
} from './queryRewriter';

// 预检索引擎
export {
  PreRetrievalEngine,
  createPreRetrievalEngine,
  type PreRetrievalEngineConfig,
} from './preRetrievalEngine';

// 快速路径路由器
export {
  FastPathRouter,
  createFastPathRouter,
} from './fastPathRouter';

// 快速路径指标服务
export {
  FastPathMetrics,
  fastPathMetrics,
  createFastPathMetrics,
  type FastPathMetricsConfig,
} from './fastPathMetrics';


// 增强循环卡死检测
export { detectLoopStuck, calculateKeywordOverlap } from './reactLoopController';

// 模块化子模块
export * from './reactPromptBuilder';
export * from './reactToolExecutor';
export * from './reactFailureAnalyzer';
export * from './reactFinalAnswer';

// 意图驱动执行器
export {
  IntentDrivenExecutor,
  createIntentDrivenExecutor,
  INTENT_TO_TOOL_MAP,
  RISK_TO_LEVEL,
  RISK_LEVEL_ORDER,
  type IntentDrivenConfig,
  type IntentExecutionResult,
  type ToolObservation,
} from './intentDrivenExecutor';

// 并行循环处理器
export {
  ParallelLoopHandler,
  createParallelLoopHandler,
  ExecutionMode,
  DEFAULT_PARALLEL_LOOP_CONFIG,
  type ParallelLoopConfig,
  type FallbackState,
  type FallbackInfo,
  type ParallelExecutionResult,
} from './parallelLoopHandler';
