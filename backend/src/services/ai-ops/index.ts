/**
 * AI-Ops 智能运维服务导出
 */

// 审计日志服务
export { AuditLogger, auditLogger } from './auditLogger';

// 指标采集服务
export { MetricsCollector, metricsCollector } from './metricsCollector';

// 通知服务
export { NotificationService, notificationService } from './notificationService';

// 告警引擎
export { AlertEngine, alertEngine } from './alertEngine';

// 调度器服务
export { Scheduler, scheduler } from './scheduler';

// 配置快照服务
export { ConfigSnapshotService, configSnapshotService } from './configSnapshotService';

// 健康报告服务
export { HealthReportService, healthReportService } from './healthReportService';

// 故障自愈服务
export { FaultHealer, faultHealer } from './faultHealer';

// AI 分析服务
export { AIAnalyzer, aiAnalyzer } from './aiAnalyzer';

// 巡检处理器
export {
  executeInspection,
  analyzeIssues,
  registerInspectionHandler,
  initializeInspectionHandler,
  type InspectionResult,
  type InspectionIssue,
} from './inspectionHandler';

// 快照任务处理器
export {
  initializeSnapshotHandler,
  registerSnapshotHandler,
  executeSnapshotTask,
} from './snapshotHandler';

// Syslog 接收服务 (AI-Ops Enhancement Phase 1)
export { SyslogReceiver, syslogReceiver } from './syslogReceiver';

// 指纹缓存服务 (AI-Ops Enhancement Phase 1)
export { FingerprintCache, fingerprintCache } from './fingerprintCache';

// 批处理服务 (AI-Ops Enhancement Phase 1)
export { BatchProcessor, batchProcessor } from './batchProcessor';

// 分析缓存服务 (AI-Ops Enhancement Phase 1)
export { AnalysisCache, analysisCache } from './analysisCache';

// 告警预处理服务 (AI-Ops Enhancement Phase 2)
export { AlertPreprocessor, alertPreprocessor } from './alertPreprocessor';

// 垃圾告警过滤服务 (AI-Ops Enhancement Phase 2)
export { NoiseFilter, noiseFilter } from './noiseFilter';

// 根因分析服务 (AI-Ops Enhancement Phase 2)
export { RootCauseAnalyzer, rootCauseAnalyzer } from './rootCauseAnalyzer';

// 修复方案服务 (AI-Ops Enhancement Phase 2)
export { RemediationAdvisor, remediationAdvisor } from './remediationAdvisor';

// 智能决策引擎 (AI-Ops Enhancement Phase 2)
export { DecisionEngine, decisionEngine } from './decisionEngine';

// 用户反馈服务 (AI-Ops Enhancement Phase 2)
export { FeedbackService, feedbackService } from './feedbackService';

// 告警处理流水线 (AI-Ops Enhancement - 服务集成)
export { AlertPipeline, alertPipeline, initializeAlertPipeline, NormalizerAdapter, StageTrackingRecord } from './alertPipeline';

// 事件处理跟踪器 (防止重复处理)
export { EventProcessingTracker, eventProcessingTracker } from './eventProcessingTracker';

// 服务生命周期管理 (解决任务不中断导致 CPU 飙升的问题)
export { serviceLifecycle, initializeServiceLifecycle } from './serviceLifecycle';

// 并发控制器 (Requirements: 2.1, 2.2, 2.4, 2.6)
export {
  ConcurrencyController,
  createConcurrencyController,
  type ConcurrencyConfig,
  type ConcurrencyStatus,
  type TaskProcessor,
  type IConcurrencyController,
} from './concurrencyController';

// Critic/Reflector 模块 (Requirements: critic-reflector 1.1-22.5)
export { CriticService, criticService } from './criticService';
export { ReflectorService, reflectorService } from './reflectorService';
export { IterationLoop, iterationLoop } from './iterationLoop';

// AI-OPS 智能进化配置 (Requirements: 10.2.1, 10.2.2, 10.2.3)
export {
  // 类型导出
  type AIEvolutionConfig,
  type AutoHealingLevel,
  type RiskLevel,
  type ReflectionConfig,
  type ExperienceConfig,
  type PlanRevisionConfig,
  type ToolFeedbackConfig,
  type ProactiveOpsConfig,
  type IntentDrivenConfig,
  type SelfHealingConfig,
  type ContinuousLearningConfig,
  type TracingConfig,
  type ConfigChangeListener,
  // 常量导出
  DEFAULT_EVOLUTION_CONFIG,
  // 函数导出
  getEvolutionConfig,
  getCapabilityConfig,
  isCapabilityEnabled,
  updateEvolutionConfig,
  updateCapabilityConfig,
  enableCapability,
  disableCapability,
  resetEvolutionConfig,
  loadConfigFromEnv,
  validateConfig,
  getCapabilityStatusSummary,
  // 文件配置相关
  loadConfigFromFile,
  saveConfigToFile,
  startConfigFileWatcher,
  stopConfigFileWatcher,
  addConfigChangeListener,
  initializeEvolutionConfig,
  shutdownEvolutionConfig,
  getConfigFilePath,
  isEvolutionConfigInitialized,
} from './evolutionConfig';

// 健康监控组件 (Requirements: 5.1.1-5.1.5)
export {
  HealthMonitor,
  healthMonitor,
  type HealthMetrics,
  type HealthScore,
  type InternalHealthSnapshot,
  type HealthTrend,
  type HealthMonitorConfig,
} from './healthMonitor';

// 意图解析器 (Requirements: 6.1.1-6.1.5)
export {
  IntentParser,
  intentParser,
  type IntentCategory,
  type ParsedIntent,
  type IntentParserConfig,
} from './intentParser';

// 分布式追踪服务 (Requirements: 9.1.1-9.1.4)
export {
  TracingService,
  tracingService,
  type Span,
  type SpanStatus,
  type Trace,
  type TracingContext,
  type TracingServiceConfig,
} from './tracingService';

// 异常预测器 (Requirements: 5.2.1-5.2.5)
export {
  AnomalyPredictor,
  anomalyPredictor,
  type AnomalyPrediction,
  type AnomalyPredictorConfig,
  type PredictionType,
} from './anomalyPredictor';

// 主动巡检器 (Requirements: 5.3.1-5.3.5)
export {
  ProactiveInspector,
  proactiveInspector,
  type InspectionItem,
  type InspectionItemType,
  type InspectionResult as ProactiveInspectionResult,
  type InspectionIssue as ProactiveInspectionIssue,
  type InspectionReport,
  type InspectionSummary,
  type ProactiveInspectorConfig,
} from './proactiveInspector';

// 模式学习器 (Requirements: 8.1.1-8.1.5)
export {
  PatternLearner,
  patternLearner,
  type UserOperation,
  type OperationPattern,
  type OperationRecommendation,
  type OperationContext,
  type PatternLearnerConfig,
} from './patternLearner';

// 知识图谱构建器 (Requirements: 8.4.1-8.4.5)
export {
  KnowledgeGraphBuilder,
  knowledgeGraphBuilder,
  type GraphNode,
  type GraphEdge,
  type NodeType,
  type EdgeType,
  type TopologyGraph,
  type GraphChange,
  type DependencyResult,
  type ImpactAnalysis,
  type KnowledgeGraphConfig,
} from './knowledgeGraphBuilder';

// 进化错误处理器 (Requirements: 10.6.1-10.6.3)
export {
  EvolutionErrorHandler,
  evolutionErrorHandler,
  EvolutionErrorType,
  ErrorSeverity,
  type ClassifiedError,
  type RetryConfig,
  type RetryState,
} from './evolutionErrorHandler';

// 降级管理器 (Requirements: 10.6.4-10.6.5)
export {
  DegradationManager,
  degradationManager,
  DegradationReason,
  type CapabilityName,
  type DegradationState,
  type DegradationConfig,
} from './degradationManager';

// 学习编排器 (Requirements: F2.8, F2.9, F2.10, F3.11, F3.12, F4.13, F4.20, F4.21)
export {
  LearningOrchestrator,
  type LearningOrchestratorDeps,
  type CriticServiceLike,
  type ReflectorServiceLike,
  type PatternLearnerLike,
  type EvolutionEngineLike,
  type FeedbackServiceLike,
  type TickResult,
  type LearningResult,
  type EvolutionInput,
  type EvolutionResult,
  type LearningStepError,
} from './learningOrchestrator';

// 进化引擎 (Requirements: F4.14, F4.15, F4.16, F4.17, F4.18, F4.19)
export {
  EvolutionEngine,
  type EvolutionEngineDeps,
  type EvolutionEngineConfig,
  type RuleEvolutionServiceLike,
} from './evolutionEngine';

// 故障模式库 (Requirements: H4.15, H4.16)
export {
  FaultPatternLibrary,
  faultPatternLibrary,
  type FaultPatternFilter,
} from './faultPatternLibrary';

// 自主大脑服务 (Tier 0 Commander)
export {
  AutonomousBrainService,
  autonomousBrainService
} from './brain/autonomousBrainService';
