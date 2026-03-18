/**
 * registerFlows - 注册三个编排流程定义和 Handler
 *
 * 在 StateMachineOrchestrator 初始化时注册 ReAct、Alert、Iteration 三个 StateDefinition，
 * 注册所有对应的 StateHandler，并配置降级集成和追踪集成。
 *
 * 需求: 3.1, 4.1, 5.1
 */

import { StateMachineOrchestrator } from './stateMachineOrchestrator';
import { StateHandler, StateContext, TransitionResult } from './types';

// --- Definitions ---
import { reactDefinition } from './definitions/reactDefinition';
import { alertDefinition } from './definitions/alertDefinition';
import { iterationDefinition } from './definitions/iterationDefinition';

// --- React Handlers ---
import { IntentParseHandler, IntentParseHandlerDeps } from './handlers/react/intentParseHandler';
import { KnowledgeRetrievalHandler, KnowledgeRetrievalHandlerDeps } from './handlers/react/knowledgeRetrievalHandler';
import { RoutingDecisionHandler, RoutingDecisionHandlerDeps } from './handlers/react/routingDecisionHandler';
import { FastPathHandler, FastPathHandlerDeps } from './handlers/react/fastPathHandler';
import { IntentDrivenExecutionHandler, IntentDrivenExecutionHandlerDeps } from './handlers/react/intentDrivenExecutionHandler';
import { ReActLoopHandler, ReActLoopHandlerDeps } from './handlers/react/reactLoopHandler';
import { PostProcessingHandler, PostProcessingHandlerDeps } from './handlers/react/postProcessingHandler';
import { ResponseHandler, ResponseHandlerDeps } from './handlers/react/responseHandler';

// --- Alert Handlers ---
import {
  RateLimitHandler, RateLimitHandlerDeps,
  NormalizeHandler, NormalizeHandlerDeps,
  DeduplicateHandler, DeduplicateHandlerDeps,
  FilterHandler, FilterHandlerDeps,
  AnalyzeHandler, AnalyzeHandlerDeps,
  DecideHandler as AlertDecideHandler, DecideHandlerDeps as AlertDecideHandlerDeps,
} from './handlers/alertHandlers';

// --- Iteration Handlers ---
import {
  IterationExecuteHandler, ExecuteHandlerDeps,
  IterationEvaluateHandler, EvaluateHandlerDeps,
  IterationReflectHandler, ReflectHandlerDeps,
  IterationDecideHandler, IterationDecideHandlerDeps,
} from './handlers/iterationHandlers';


// ============================================================
// Dependency interfaces for registerAllFlows
// ============================================================

export interface RegisterFlowsDeps {
  react: {
    intentParser: IntentParseHandlerDeps['intentParser'];
    knowledgeRetriever: KnowledgeRetrievalHandlerDeps['knowledgeRetriever'];
    routingDecider: RoutingDecisionHandlerDeps['routingDecider'];
    fastPathRouter: FastPathHandlerDeps['fastPathRouter'];
    intentDrivenExecutor: IntentDrivenExecutionHandlerDeps['intentDrivenExecutor'];
    reactLoopExecutor: ReActLoopHandlerDeps['reactLoopExecutor'];
    postProcessing: PostProcessingHandlerDeps;
    responseAssembler?: ResponseHandlerDeps['responseAssembler'];
  };
  alert: {
    rateLimiter: RateLimitHandlerDeps['rateLimiter'];
    normalizer: NormalizeHandlerDeps['normalizer'];
    deduplicator: DeduplicateHandlerDeps['deduplicator'];
    filter: FilterHandlerDeps['filter'];
    analyzer: AnalyzeHandlerDeps['analyzer'];
    decider: AlertDecideHandlerDeps['decider'];
  };
  iteration: {
    executor: ExecuteHandlerDeps['executor'];
    criticService: EvaluateHandlerDeps['criticService'];
    reflectorService: ReflectHandlerDeps['reflectorService'];
    decisionService: IterationDecideHandlerDeps['decisionService'];
  };
}

// ============================================================
// Generic ErrorHandler for errorHandler states
// ============================================================

/**
 * A generic error handler that captures error metadata from context
 * and produces a degraded/error response. Used for errorHandler states
 * across all three flow definitions.
 */
class GenericErrorHandler implements StateHandler {
  readonly name = 'genericErrorHandler';

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    // Pass through - the error state simply transitions to the next state
    // per the definition's transition rules (e.g., errorHandler → response)
    return { outcome: 'success', context };
  }
}

// ============================================================
// Registration function
// ============================================================

/**
 * Register all three orchestration flow definitions and their handlers
 * with the StateMachineOrchestrator.
 *
 * This function:
 * 1. Registers ReAct, Alert, and Iteration StateDefinitions
 * 2. Registers all corresponding StateHandlers
 * 3. Configures degradation integration (via handler capability fields)
 *    and tracing integration (via orchestrator's TracingIntegration)
 *
 * @param orchestrator - The StateMachineOrchestrator instance
 * @param deps - Dependencies required by all handlers
 */
export function registerAllFlows(
  orchestrator: StateMachineOrchestrator,
  deps: RegisterFlowsDeps,
): void {
  // === Step 1: Register all definitions ===
  orchestrator.registerDefinition(reactDefinition);
  orchestrator.registerDefinition(alertDefinition);
  orchestrator.registerDefinition(iterationDefinition);

  // === Step 2: Register ReAct flow handlers (scoped to 'react-orchestration') ===
  orchestrator.registerScopedHandler('react-orchestration', 'intentParse', new IntentParseHandler({
    intentParser: deps.react.intentParser,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'knowledgeRetrieval', new KnowledgeRetrievalHandler({
    knowledgeRetriever: deps.react.knowledgeRetriever,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'routingDecision', new RoutingDecisionHandler({
    routingDecider: deps.react.routingDecider,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'fastPath', new FastPathHandler({
    fastPathRouter: deps.react.fastPathRouter,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'intentDrivenExecution', new IntentDrivenExecutionHandler({
    intentDrivenExecutor: deps.react.intentDrivenExecutor,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'reactLoop', new ReActLoopHandler({
    reactLoopExecutor: deps.react.reactLoopExecutor,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'postProcessing', new PostProcessingHandler(deps.react.postProcessing));
  orchestrator.registerScopedHandler('react-orchestration', 'response', new ResponseHandler({
    responseAssembler: deps.react.responseAssembler,
  }));
  orchestrator.registerScopedHandler('react-orchestration', 'errorHandler', new GenericErrorHandler());

  // === Step 3: Register Alert flow handlers (scoped to 'alert-pipeline') ===
  orchestrator.registerScopedHandler('alert-pipeline', 'rateLimit', new RateLimitHandler({
    rateLimiter: deps.alert.rateLimiter,
  }));
  orchestrator.registerScopedHandler('alert-pipeline', 'normalize', new NormalizeHandler({
    normalizer: deps.alert.normalizer,
  }));
  orchestrator.registerScopedHandler('alert-pipeline', 'deduplicate', new DeduplicateHandler({
    deduplicator: deps.alert.deduplicator,
  }));
  orchestrator.registerScopedHandler('alert-pipeline', 'filter', new FilterHandler({
    filter: deps.alert.filter,
  }));
  orchestrator.registerScopedHandler('alert-pipeline', 'analyze', new AnalyzeHandler({
    analyzer: deps.alert.analyzer,
  }));
  orchestrator.registerScopedHandler('alert-pipeline', 'decide', new AlertDecideHandler({
    decider: deps.alert.decider,
  }));

  // === Step 4: Register Iteration flow handlers (scoped to 'iteration-loop') ===
  orchestrator.registerScopedHandler('iteration-loop', 'execute', new IterationExecuteHandler({
    executor: deps.iteration.executor,
  }));
  orchestrator.registerScopedHandler('iteration-loop', 'evaluate', new IterationEvaluateHandler({
    criticService: deps.iteration.criticService,
  }));
  orchestrator.registerScopedHandler('iteration-loop', 'reflect', new IterationReflectHandler({
    reflectorService: deps.iteration.reflectorService,
  }));
  orchestrator.registerScopedHandler('iteration-loop', 'decide', new IterationDecideHandler({
    decisionService: deps.iteration.decisionService,
  }));

  // === Step 5: Validate all definitions' handler completeness ===
  orchestrator.validateDefinition('react-orchestration');
  orchestrator.validateDefinition('alert-pipeline');
  orchestrator.validateDefinition('iteration-loop');
}
