/**
 * ReactKnowledgeRetrieval - 知识检索集成模块
 *
 * 从 ReActLoopController 拆分的知识检索相关功能。
 * 当前阶段作为委托模块，后续可逐步将方法从主控制器迁移到此处。
 *
 * 包含方法：
 * - performIntelligentRetrieval
 * - executeIntelligentKnowledgeSearch
 * - executeKnowledgeSearchWithTimeout
 * - storeKnowledgeResults
 * - trackKnowledgeUsage
 *
 * Requirements: 8.1, 8.2
 */

// Re-export types for convenience
export type { FormattedKnowledge, TrackedKnowledgeReference } from './types/intelligentRetrieval';
