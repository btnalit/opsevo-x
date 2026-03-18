/**
 * AI-OPS Skill System 服务导出
 * 
 * 提供完整的 Skill 系统功能，包括：
 * - SkillLoader: 文件系统加载器
 * - SkillRegistry: Skill 注册表
 * - SkillMatcher: 智能匹配器
 * - SkillManager: 核心管理器
 * - SkillMetrics: 指标追踪
 */

// SkillLoader - 文件系统加载器
export {
  SkillLoader,
  skillLoader,
  type SkillLoaderConfig,
} from './skillLoader';

// Skill Capsule 类型 (Requirements: E1.1, E1.2)
export type {
  SkillCapsule,
  SkillCapsuleRuntime,
  SkillCapsuleDependency,
  SkillCapsuleHealthCheck,
  LoadedSkillCapsule,
  SkillCapsuleExecutionResult,
  JsonSchemaDefinition,
} from '../../../types/skillCapsule';
export {
  validateSkillCapsule,
  parseSkillCapsule,
} from '../../../types/skillCapsule';

// SkillRegistry - 注册表
export {
  SkillRegistry,
  skillRegistry,
  type SkillFilterOptions,
} from './skillRegistry';

// SkillMatcher - 智能匹配器
export {
  SkillMatcher,
  type SkillMatchContext,
  type SkillMatcherConfig,
} from './skillMatcher';

// SkillSemanticMatcher - 语义匹配器
export {
  SkillSemanticMatcher,
  type SemanticMatcherConfig,
  type SemanticMatchScore,
} from './skillSemanticMatcher';

// SkillManager - 核心管理器
export {
  SkillManager,
  skillManager,
  type SkillManagerConfig,
  type SkillSelectOptions,
  type ChainExecutionResult,
} from './skillManager';

// SkillChainManager - 链式调用管理器
export {
  SkillChainManager,
  skillChainManager,
  type ChainTriggerResult,
  type ChainState,
} from './skillChainManager';

// SkillMetrics - 指标追踪
export {
  SkillMetrics,
  skillMetrics,
  type SkillMetricsConfig,
  // Tool metrics types (Requirements: 4.1.1, 4.1.2, 4.1.3, 4.1.4)
  type ToolFailurePattern,
  type ToolUsageMetrics,
  type ToolHealthStatus,
} from './skillMetrics';

// SkillParameterTuner - 参数自动调优
export {
  SkillParameterTuner,
  getParameterTuner,
  type ParameterTunerConfig,
  type ParameterUsageRecord,
  type ParameterSnapshot,
  type ParameterStats,
  type ParameterRecommendation,
  type ABTestConfig,
} from './skillParameterTuner';

// SkillAwarePromptBuilder - Skill 感知的提示词构建器
export {
  SkillAwarePromptBuilder,
  skillAwarePromptBuilder,
  type SkillEnhancedPromptOptions,
} from './skillAwarePromptBuilder';

// SkillAwareToolSelector - Skill 感知的工具选择器
export {
  SkillAwareToolSelector,
  skillAwareToolSelector,
  type AgentTool,
  type ParamValidationResult,
  type ToolSelectionResult,
  // Tool priority types (Requirements: 4.2.1, 4.2.4)
  type ToolPriorityConfig,
} from './skillAwareToolSelector';

// SkillAwareKnowledgeRetriever - Skill 感知的知识检索器
export {
  SkillAwareKnowledgeRetriever,
  skillAwareKnowledgeRetriever,
  type SkillAwareRetrievalOptions,
  type SkillAwareRetrievalResult,
} from './skillAwareKnowledgeRetriever';

// SkillAwareReActController - Skill 感知的 ReAct 控制器
export {
  SkillAwareReActController,
  skillAwareReActController,
  type SkillAwareReActResult,
  type SkillAwareReActOptions,
} from './skillAwareReActController';

// UnifiedToolRegistry - 统一工具注册中心 (Requirements: E2.6, E2.7, E3.12)
export {
  UnifiedToolRegistry,
  type RegisteredTool,
  type ToolType,
  type UnifiedToolRegistryConfig,
} from './toolRegistry';

// SkillFactory - 向量检索 + 执行引擎 (Requirements: E3.8, E3.9, E3.10, E3.11)
export {
  SkillFactory,
  type ToolCandidate,
  type ToolExecutionResult,
  type SkillFactoryConfig,
} from './skillFactory';

// bootstrapSkillSystem - Skill 系统单一初始化入口 (Requirements: E7.17, E7.18, E7.19)
export {
  initializeSkillSystem,
  type SkillSystemDeps,
  type SkillSystemResult,
} from './bootstrapSkillSystem';
