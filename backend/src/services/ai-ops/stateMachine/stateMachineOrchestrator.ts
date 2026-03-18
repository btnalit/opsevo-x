/**
 * StateMachineOrchestrator - 门面类
 *
 * 组合 StateMachineEngine、StateRegistry、ContextManager、
 * ConcurrencyGuard、TracingIntegration、StateDefinitionSerializer、FeatureFlagManager，
 * 提供统一的 IStateMachineOrchestrator 接口。
 *
 * 需求: 1.1, 1.2, 1.4, 8.5, 10.1, 11.4
 */

import { StateMachineEngine } from './stateMachineEngine';
import { StateRegistry } from './stateRegistry';
import { ConcurrencyGuard } from './integrations/concurrencyGuard';
import { TracingIntegration } from './integrations/tracingIntegration';
import { DegradationIntegration } from './integrations/degradationIntegration';
import { StateDefinitionSerializer } from './stateDefinitionSerializer';
import { FeatureFlagManager } from './featureFlagManager';
import {
  StateDefinition,
  StateHandler,
  StateTransition,
  ExecutionResult,
  ExecutionSummary,
} from './types';

export interface StateMachineOrchestratorDeps {
  engine: StateMachineEngine;
  registry: StateRegistry;
  concurrencyGuard: ConcurrencyGuard;
  tracingIntegration: TracingIntegration;
  degradationIntegration?: DegradationIntegration;
  featureFlagManager: FeatureFlagManager;
}

export class StateMachineOrchestrator {
  private readonly engine: StateMachineEngine;
  private readonly registry: StateRegistry;
  private readonly concurrencyGuard: ConcurrencyGuard;
  private readonly tracing: TracingIntegration;
  private readonly degradation?: DegradationIntegration;
  private readonly featureFlags: FeatureFlagManager;

  constructor(deps: StateMachineOrchestratorDeps) {
    this.engine = deps.engine;
    this.registry = deps.registry;
    this.concurrencyGuard = deps.concurrencyGuard;
    this.tracing = deps.tracingIntegration;
    this.degradation = deps.degradationIntegration;
    this.featureFlags = deps.featureFlagManager;
  }

  // === Registration (delegates to StateRegistry) ===

  registerDefinition(definition: StateDefinition): void {
    this.registry.registerDefinition(definition);
  }

  registerHandler(stateName: string, handler: StateHandler): void {
    this.registry.registerHandler(stateName, handler);
  }

  registerScopedHandler(definitionId: string, stateName: string, handler: StateHandler): void {
    this.registry.registerScopedHandler(definitionId, stateName, handler);
  }

  validateDefinition(definitionId: string): void {
    this.registry.validate(definitionId);
  }



  registerHandlerRuntime(stateName: string, handler: StateHandler): void {
    this.registry.registerHandlerRuntime(stateName, handler);
  }

  addTransitionRuntime(definitionId: string, transition: StateTransition): void {
    this.registry.addTransitionRuntime(definitionId, transition);
  }

  // === Execution ===

  async execute(
    definitionId: string,
    input: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    return this.concurrencyGuard.execute(() =>
      this.engine.execute(definitionId, input),
    );
  }

  // === Query (delegates to TracingIntegration) ===

  getExecutionHistory(executionId: string): ExecutionSummary | undefined {
    return this.tracing.getExecutionSummary(executionId);
  }

  queryByRequestId(requestId: string): ExecutionSummary[] {
    return this.tracing.queryByRequestId(requestId);
  }

  // === Concurrency status (delegates to ConcurrencyGuard) ===

  getConcurrencyStatus(): { active: number; queued: number; maxConcurrent: number } {
    return this.concurrencyGuard.getConcurrencyStatus();
  }

  // === Feature Flags (delegates to FeatureFlagManager) ===

  getFeatureFlagManager(): FeatureFlagManager {
    return this.featureFlags;
  }


  // === Serialization (delegates to StateDefinitionSerializer) ===

  serializeDefinition(definitionId: string): string {
    const definition = this.registry.getDefinition(definitionId);
    if (!definition) {
      throw new Error(`Definition '${definitionId}' not found`);
    }
    return StateDefinitionSerializer.serialize(definition);
  }

  deserializeDefinition(json: string): StateDefinition {
    return StateDefinitionSerializer.deserialize(json);
  }

  prettyPrint(definitionId: string): string {
    const definition = this.registry.getDefinition(definitionId);
    if (!definition) {
      throw new Error(`Definition '${definitionId}' not found`);
    }
    return StateDefinitionSerializer.prettyPrint(definition);
  }
}
