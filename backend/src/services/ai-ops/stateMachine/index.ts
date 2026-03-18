/**
 * 状态机编排层 - 模块导出入口
 *
 * 导出所有公共接口、类型、核心类和工厂方法。
 * 需求: 全部
 */

// ============================================================
// 核心类型
// ============================================================

export type {
  StateHandler,
  TransitionResult,
  StateContext,
  StateHistoryEntry,
  StateDefinition,
  StateTransition,
  ExecutionResult,
  ExecutionSummary,
  TransitionRecord,
  StateTransitionEvent,
} from './types';

// ============================================================
// 核心类
// ============================================================

export { StateMachineEngine } from './stateMachineEngine';
export { StateRegistry } from './stateRegistry';
export { StateExecutor } from './stateExecutor';
export { ContextManager } from './contextManager';
export { StateDefinitionSerializer } from './stateDefinitionSerializer';

// ============================================================
// 集成层
// ============================================================

export { ConcurrencyGuard } from './integrations/concurrencyGuard';
export type { ConcurrencyGuardConfig } from './integrations/concurrencyGuard';
export { DegradationIntegration } from './integrations/degradationIntegration';
export { TracingIntegration } from './integrations/tracingIntegration';

// ============================================================
// 适配器层
// ============================================================

export { ReActLoopAdapter } from './adapters/reactLoopAdapter';
export { AlertPipelineAdapter } from './adapters/alertPipelineAdapter';
export { IterationLoopAdapter } from './adapters/iterationLoopAdapter';

// ============================================================
// 特性开关
// ============================================================

export { FeatureFlagManager, CONTROL_POINT_DEFINITIONS } from './featureFlagManager';
export type {
  FlowId,
  FeatureFlagConfig,
  ComparisonResult,
  ControlPointKey,
  ControlPointDefinition,
  ControlPointState,
  DependencyError,
} from './featureFlagManager';

// ============================================================
// 编排器门面
// ============================================================

export { StateMachineOrchestrator } from './stateMachineOrchestrator';
export type { StateMachineOrchestratorDeps } from './stateMachineOrchestrator';

// ============================================================
// 流程注册
// ============================================================

export { registerAllFlows } from './registerFlows';
export type { RegisterFlowsDeps } from './registerFlows';

// ============================================================
// 流程定义
// ============================================================

export { reactDefinition, REACT_DEFINITION_ID } from './definitions/reactDefinition';
export type { ReActStateData } from './definitions/reactDefinition';
export { alertDefinition, ALERT_DEFINITION_ID } from './definitions/alertDefinition';
export type { AlertStateData } from './definitions/alertDefinition';
export { iterationDefinition, ITERATION_DEFINITION_ID } from './definitions/iterationDefinition';
export type { IterationStateData } from './definitions/iterationDefinition';

// ============================================================
// 工厂方法
// ============================================================

import { StateMachineEngine } from './stateMachineEngine';
import { StateRegistry } from './stateRegistry';
import { StateExecutor } from './stateExecutor';
import { ConcurrencyGuard } from './integrations/concurrencyGuard';
import { TracingIntegration } from './integrations/tracingIntegration';
import { FeatureFlagManager } from './featureFlagManager';
import { StateMachineOrchestrator } from './stateMachineOrchestrator';
import { registerAllFlows, RegisterFlowsDeps } from './registerFlows';
import type { ConcurrencyGuardConfig } from './integrations/concurrencyGuard';
import type { FeatureFlagConfig } from './featureFlagManager';
import type { TracingService } from '../tracingService';
import { DegradationIntegration } from './integrations/degradationIntegration';
import type { DegradationManager } from '../degradationManager';
import type { DataStore } from '../../dataStore';

export interface CreateOrchestratorConfig {
  tracingService: TracingService;
  degradationManager?: DegradationManager;
  pgDataStore?: DataStore;
  concurrencyConfig?: Partial<ConcurrencyGuardConfig>;
  featureFlagConfig?: FeatureFlagConfig;
}

/**
 * 工厂方法 - 创建配置好的 StateMachineOrchestrator 实例
 *
 * 1. 创建所有子组件实例
 * 2. 组装 StateMachineOrchestrator
 * 3. 调用 registerAllFlows 注册所有流程定义和 Handler
 * 4. 返回配置好的编排器
 */
export function createStateMachineOrchestrator(
  deps: RegisterFlowsDeps,
  config: CreateOrchestratorConfig,
): StateMachineOrchestrator {
  const registry = new StateRegistry();
  const executor = new StateExecutor();
  const concurrencyGuard = new ConcurrencyGuard(config.concurrencyConfig);
  const tracingIntegration = new TracingIntegration(config.tracingService);
  const degradationIntegration = config.degradationManager
    ? new DegradationIntegration(config.degradationManager)
    : undefined;
  const engine = new StateMachineEngine(registry, executor, degradationIntegration, tracingIntegration);
  if (config.pgDataStore) {
    engine.setPgDataStore(config.pgDataStore);
  }
  const featureFlagManager = new FeatureFlagManager(config.featureFlagConfig);

  const orchestrator = new StateMachineOrchestrator({
    engine,
    registry,
    concurrencyGuard,
    tracingIntegration,
    degradationIntegration,
    featureFlagManager,
  });

  registerAllFlows(orchestrator, deps);

  return orchestrator;
}
