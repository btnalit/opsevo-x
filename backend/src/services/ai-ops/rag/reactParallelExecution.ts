/**
 * ReactParallelExecution - 并行执行逻辑模块
 *
 * 从 ReActLoopController 拆分的并行执行相关功能。
 * 当前阶段作为委托模块，后续可逐步将方法从主控制器迁移到此处。
 *
 * 包含方法：
 * - executePlannedMode
 * - buildParallelPrompt / buildParallelPromptAsync
 * - shouldEnableParallelExecution
 *
 * Requirements: 8.1, 8.2
 */

// Re-export parallel execution types for convenience
export { ExecutionMode } from '../../../types/parallel-execution';
export { ParallelExecutor, parallelExecutor } from './parallelExecutor';
export { AdaptiveModeSelector, adaptiveModeSelector } from './adaptiveModeSelector';
export { ExecutionPlanner, executionPlanner } from './executionPlanner';
