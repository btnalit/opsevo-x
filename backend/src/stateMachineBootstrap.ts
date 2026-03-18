/**
 * stateMachineBootstrap - 状态机编排器依赖构造与初始化
 *
 * 从现有服务单例构造 RegisterFlowsDeps 所需的全部依赖适配器。
 * 每个适配器是薄包装层，将现有服务单例的方法签名映射到 Handler 期望的接口。
 * 提供 initializeStateMachineOrchestrator() 在启动时创建编排器并注入到服务单例。
 *
 * 需求: 1.1, 1.2, 1.3, 1.4, 2.1-2.5, 3.1, 7.1, 7.2
 */

import { RegisterFlowsDeps } from './services/ai-ops/stateMachine/registerFlows';
import { createStateMachineOrchestrator } from './services/ai-ops/stateMachine';
import { logger } from './utils/logger';

// --- 启动初始化依赖的服务单例 ---
import { tracingService } from './services/ai-ops/tracingService';
import { degradationManager } from './services/ai-ops/degradationManager';
import { unifiedAgentService } from './services/ai/unifiedAgentService';
import { alertPipeline } from './services/ai-ops/alertPipeline';
import { iterationLoop } from './services/ai-ops/iterationLoop';
import { serviceRegistry } from './services/serviceRegistry';
import { SERVICE_NAMES } from './services/bootstrap';

// --- React 组依赖的服务单例 ---
import { intentAnalyzer } from './services/ai-ops/rag/intentAnalyzer';
import { ragEngine } from './services/ai-ops/rag';
import { skillAwareReActController } from './services/ai-ops/skill/skillAwareReActController';
import { outputValidator } from './services/ai-ops/rag/outputValidator';
import { reflectorService } from './services/ai-ops/reflectorService';
import { continuousLearner } from './services/ai-ops/continuousLearner';
import { toolFeedbackCollector } from './services/ai-ops/toolFeedbackCollector';

// --- Alert 组依赖的服务单例 ---
import { alertPreprocessor } from './services/ai-ops/alertPreprocessor';
import { fingerprintCache } from './services/ai-ops/fingerprintCache';
import { noiseFilter } from './services/ai-ops/noiseFilter';
import { rootCauseAnalyzer } from './services/ai-ops/rootCauseAnalyzer';
import { decisionEngine } from './services/ai-ops/decisionEngine';

// --- Iteration 组依赖的服务单例 ---
import { criticService } from './services/ai-ops/criticService';
import { remediationAdvisor } from './services/ai-ops/remediationAdvisor';
import { metricsCollector } from './services/ai-ops/metricsCollector';

// ============================================================
// React 组适配器构造函数
// ============================================================

/**
 * 适配 IntentAnalyzer → intentParser 接口
 * Handler 期望: { parse(message, conversationContext): Promise<{confidence, intent, ...}> }
 * 当 intentAnalyzer 不可用时返回低置信度 unknown 意图（降级行为）
 */
function buildIntentParserAdapter(): RegisterFlowsDeps['react']['intentParser'] {
  return {
    async parse(message: string, _conversationContext?: unknown) {
      if (!intentAnalyzer) {
        return { confidence: 0, intent: 'unknown' };
      }
      try {
        const result = await intentAnalyzer.analyzeIntent(message, [], []);
        return {
          confidence: result.confidence ?? 0,
          intent: result.intent ?? 'unknown',
        };
      } catch (error) {
        logger.warn('intentParser adapter: analyzeIntent failed, degrading', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { confidence: 0, intent: 'unknown' };
      }
    },
  };
}

/**
 * 适配 RAGEngine/KnowledgeBase → knowledgeRetriever 接口
 * Handler 期望: { retrieve(query, intentAnalysis): Promise<{ragContext, formattedKnowledge, knowledgeReferences}> }
 * 当 ragEngine 不可用时返回空结果（降级行为）
 *
 * ragEngine.query 返回 RAGQueryResult: { answer, context: RAGContext, citations, confidence, status }
 * RAGContext: { query, retrievedDocuments: KnowledgeSearchResult[], retrievalTime, candidatesConsidered }
 */
function buildKnowledgeRetrieverAdapter(): RegisterFlowsDeps['react']['knowledgeRetriever'] {
  return {
    async retrieve(query: string, _intentAnalysis?: unknown) {
      if (!ragEngine) {
        return { ragContext: null, formattedKnowledge: [], knowledgeReferences: [] };
      }
      try {
        const result = await ragEngine.query(query);
        const citations = result.citations ?? [];
        return {
          // Fix #3: Embed ragConfidence from RAGQueryResult into ragContext
          // so that buildRoutingDeciderAdapter can read ragContext.confidence
          ragContext: result.context
            ? { ...result.context, confidence: result.confidence ?? 0 }
            : null,
          formattedKnowledge: citations.map((c: any) => ({
            title: c.title ?? '',
            content: c.excerpt ?? '',
            entryId: c.entryId ?? '',
            relevance: c.relevance ?? 0,
          })),
          knowledgeReferences: citations.map((c: any) => ({
            entryId: c.entryId ?? '',
            title: c.title ?? '',
            relevance: c.relevance ?? 0,
          })),
        };
      } catch (error) {
        logger.warn('knowledgeRetriever adapter: ragEngine.query failed, degrading', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { ragContext: null, formattedKnowledge: [], knowledgeReferences: [] };
      }
    },
  };
}

/**
 * 适配路由决策逻辑 → routingDecider 接口
 * Handler 期望: { decide({parsedIntent, intentAnalysis, ragContext}): Promise<{path, confidence}> }
 *
 * 路由策略：
 * - 高置信度 RAG 上下文 + 简单查询 → fastPath（直接知识回答）
 * - 高置信度意图 + 低风险 → intentDriven（意图驱动自动化）
 * - 其他情况 → reactLoop（完整 ReAct 推理循环）
 */
function buildRoutingDeciderAdapter(): RegisterFlowsDeps['react']['routingDecider'] {
  return {
    async decide(params: { parsedIntent: unknown; intentAnalysis: unknown; ragContext: unknown }) {
      const confidence = (params.intentAnalysis as any)?.confidence ?? 0;
      const intent = (params.intentAnalysis as any)?.intent ?? 'unknown';
      const ragContext = params.ragContext as any;

      // 如果 RAG 上下文有高质量结果且意图是简单查询，走 fastPath
      const hasRagResults = ragContext?.retrievedDocuments?.length > 0 || ragContext?.query;
      const ragConfidence = ragContext?.confidence ?? 0;
      if (hasRagResults && ragConfidence >= 0.8 && (intent === 'knowledge_query' || intent === 'general')) {
        return { path: 'fastPath' as const, confidence: ragConfidence };
      }

      // 高置信度意图且非通用查询，走 intentDriven
      if (confidence >= 0.8 && intent !== 'unknown' && intent !== 'general') {
        return { path: 'intentDriven' as const, confidence };
      }

      // 默认走 reactLoop
      return { path: 'reactLoop' as const, confidence };
    },
  };
}

/**
 * 适配 FastPathRouter → fastPathRouter 接口
 * Handler 期望: { generateAnswer({message, ragContext, formattedKnowledge, conversationContext}): Promise<string> }
 *
 * FastPathRouter 在 UnifiedAgentService 中延迟初始化，不是全局单例。
 * 此适配器使用 ragEngine 的回答能力作为替代：如果 ragContext 中已有 answer，直接返回；
 * 否则尝试通过 ragEngine.query 获取回答。
 * 当所有服务不可用时返回空字符串（降级行为，触发 explore 模式）。
 */
function buildFastPathRouterAdapter(): RegisterFlowsDeps['react']['fastPathRouter'] {
  return {
    async generateAnswer(params: {
      message: string;
      ragContext: unknown;
      formattedKnowledge: unknown[];
      conversationContext?: unknown;
    }) {
      try {
        // 如果 ragContext 中已有 answer（来自 RAGEngine.query 的结果），直接使用
        const ragResult = params.ragContext as any;
        if (ragResult?.answer && typeof ragResult.answer === 'string') {
          return ragResult.answer;
        }

        // 尝试通过 ragEngine 生成回答
        if (ragEngine) {
          const result = await ragEngine.query(params.message);
          if (result.answer && result.status !== 'no_results') {
            return result.answer;
          }
        }

        // 降级：返回空字符串，Handler 会将其视为无法快速回答
        return '';
      } catch (error) {
        logger.warn('fastPathRouter adapter: generateAnswer failed, degrading', {
          error: error instanceof Error ? error.message : String(error),
        });
        return '';
      }
    },
  };
}

/**
 * 适配意图驱动执行逻辑 → intentDrivenExecutor 接口
 * Handler 期望: { execute({parsedIntent, intentAnalysis, conversationContext, executionContext}): Promise<{steps, finalAnswer, iterations}> }
 *
 * IntentDrivenExecutor.tryExecute 需要大量运行时参数（AI adapter、interceptors 等），
 * 这些在状态机 Handler 上下文中不直接可用。此适配器提供简化的意图驱动执行：
 * 将意图信息注入为思考步骤，然后委托给 SARC 执行完整循环。
 * 当 SARC 不可用时返回空结果（降级行为）。
 */
function buildIntentDrivenExecutorAdapter(): RegisterFlowsDeps['react']['intentDrivenExecutor'] {
  return {
    async execute(params: {
      message?: string;
      parsedIntent: unknown;
      intentAnalysis: unknown;
      conversationContext?: unknown;
      executionContext?: unknown;
    }) {
      if (!skillAwareReActController) {
        return { steps: [], finalAnswer: '', iterations: 0 };
      }
      try {
        const parsedIntent = params.parsedIntent as any;
        const intentAnalysis = params.intentAnalysis as any;
        // Bug fix: 优先使用从 StateContext 传入的 message 参数，
        // 而不是仅从 parsedIntent/intentAnalysis 的 originalMessage 字段提取（这些字段通常不存在）
        const message = params.message ?? parsedIntent?.originalMessage ?? intentAnalysis?.originalMessage ?? '';

        // 委托给 SARC 执行，意图信息已在 intentAnalysis 中
        const result = await skillAwareReActController.executeLoop(
          message,
          intentAnalysis ?? { intent: 'unknown', confidence: 0, tools: [] },
          params.conversationContext as any ?? { messages: [], metadata: {} },
          params.executionContext as any,
        );
        return {
          steps: result.steps ?? [],
          finalAnswer: result.finalAnswer ?? '',
          iterations: result.iterations ?? 0,
        };
      } catch (error) {
        logger.warn('intentDrivenExecutor adapter: execution failed, degrading', {
          error: error instanceof Error ? error.message : String(error),
        });
        return { steps: [], finalAnswer: '', iterations: 0 };
      }
    },
  };
}

/**
 * 适配 SkillAwareReActController → reactLoopExecutor 接口
 * Handler 期望: { executeLoop(message, intentAnalysis, conversationContext, executionContext): Promise<{steps, finalAnswer, iterations}> }
 *
 * 这是最关键的适配器：直接委托给 SkillAwareReActController.executeLoop，
 * 保持参数原样传递，确保状态机路径与 legacy 路径行为一致。
 * 需求: 4.1 - 参数原样委托给底层 SARC.executeLoop
 */
function buildReactLoopExecutorAdapter(): RegisterFlowsDeps['react']['reactLoopExecutor'] {
  return {
    async executeLoop(
      message: string,
      intentAnalysis: unknown,
      conversationContext: unknown,
      executionContext: unknown,
    ) {
      if (!skillAwareReActController) {
        throw new Error('skillAwareReActController is not available');
      }
      const result = await skillAwareReActController.executeLoop(
        message,
        intentAnalysis as any,
        conversationContext as any,
        executionContext as any,
      );
      // Fix #1 & #7: Transparently pass ALL fields from SARC result
      // instead of only { steps, finalAnswer, iterations }.
      // This ensures reachedMaxIterations, skill, switchSuggestion,
      // skillMetrics, skillKnowledgeResult, totalDuration, ragContext etc.
      // are available to downstream handlers.
      return {
        steps: result.steps ?? [],
        finalAnswer: result.finalAnswer ?? '',
        iterations: result.iterations ?? 0,
        reachedMaxIterations: result.reachedMaxIterations ?? false,
        totalDuration: result.totalDuration ?? 0,
        ragContext: result.ragContext,
        intelligentRetrievalResult: result.intelligentRetrievalResult,
        validationResult: result.validationResult,
        knowledgeReferences: result.knowledgeReferences,
        fallbackInfo: result.fallbackInfo,
        skill: (result as any).skill,
        switchSuggestion: (result as any).switchSuggestion,
        skillMetrics: (result as any).skillMetrics,
        skillKnowledgeResult: (result as any).skillKnowledgeResult,
      };
    },
  };
}

/**
 * 适配后处理服务 → postProcessing 接口
 * 包含 outputValidator、reflectorService、continuousLearner、toolFeedbackCollector 四个子依赖
 *
 * 每个子依赖适配对应的服务单例：
 * - outputValidator: 调用 OutputValidator.validate，返回验证结果
 * - reflectorService: 调用 ReflectorService.reflect（需要 EvaluationReport 格式），提供简化适配
 * - continuousLearner: 调用 ContinuousLearner.recordOperation 记录操作
 * - toolFeedbackCollector: 调用 ToolFeedbackCollector.recordMetric 记录工具指标
 *
 * 当源服务不可用时提供合理降级行为。
 */
function buildPostProcessingAdapter(): RegisterFlowsDeps['react']['postProcessing'] {
  return {
    outputValidator: {
      async validate(params: { finalAnswer: string; steps: unknown[] }) {
        if (!outputValidator) {
          return { valid: true };
        }
        try {
          // OutputValidator.validate 需要 (output, contextOrKnowledge)
          // 在状态机上下文中没有 FormattedKnowledge，传入空数组做基本验证
          const result = outputValidator.validate(params.finalAnswer, []);
          return { valid: result.isValid, errors: result.errors, warnings: result.warnings };
        } catch (error) {
          logger.warn('postProcessing.outputValidator adapter: validate failed, degrading', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { valid: true };
        }
      },
    },
    reflectorService: {
      async reflect(params: { steps: unknown[]; finalAnswer: string }) {
        if (!reflectorService) {
          return { reflections: [] };
        }
        try {
          // ReflectorService.reflect 需要 (EvaluationReport, ReflectionContext)
          // 构造简化的 EvaluationReport 和 ReflectionContext
          const evaluation = {
            id: `eval-${Date.now()}`,
            timestamp: Date.now(),
            overallScore: params.finalAnswer ? 0.7 : 0.3,
            categories: [],
            summary: params.finalAnswer ? 'Execution completed' : 'No answer produced',
          };
          const context = {
            iterationNumber: 1,
            previousReflections: [],
            executionHistory: [],
          };
          const result = await reflectorService.reflect(evaluation as any, context as any);
          return { reflections: result.insights ?? [] };
        } catch (error) {
          logger.warn('postProcessing.reflectorService adapter: reflect failed, degrading', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { reflections: [] };
        }
      },
    },
    continuousLearner: {
      async learn(_params: { steps: unknown[]; finalAnswer: string; reflectionResult: unknown }) {
        if (!continuousLearner) {
          return;
        }
        try {
          // ContinuousLearner.recordOperation 记录操作用于模式学习
          const steps = _params.steps as any[];
          const toolSteps = steps.filter((s: any) => s?.type === 'action' && s?.toolName);
          for (const step of toolSteps) {
            continuousLearner.recordOperation('state-machine', {
              userId: 'state-machine',
              sessionId: `sm-${Date.now()}`,
              toolName: step.toolName ?? 'unknown',
              parameters: step.toolInput ?? {},
              result: step.success !== false ? 'success' : 'failure',
              timestamp: Date.now(),
              context: {},
            });
          }
        } catch (error) {
          logger.warn('postProcessing.continuousLearner adapter: learn failed, degrading', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    toolFeedbackCollector: {
      async collect(_params: { steps: unknown[] }) {
        if (!toolFeedbackCollector) {
          return;
        }
        try {
          // ToolFeedbackCollector.recordMetric 记录工具执行指标
          const steps = _params.steps as any[];
          const actionSteps = steps.filter((s: any) => s?.type === 'action' && s?.toolName);
          for (const step of actionSteps) {
            await toolFeedbackCollector.recordMetric({
              toolName: step.toolName ?? 'unknown',
              timestamp: step.timestamp ?? Date.now(),
              duration: step.duration ?? 0,
              success: step.success !== false,
              errorMessage: step.success === false ? String(step.toolOutput ?? '') : undefined,
            });
          }
        } catch (error) {
          logger.warn('postProcessing.toolFeedbackCollector adapter: collect failed, degrading', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  };
}

// ============================================================
// Alert 组适配器构造函数
// ============================================================

/**
 * 构造 Alert 组依赖适配器
 * 从现有 alertPipeline 相关服务单例构造真实适配器
 *
 * 映射关系：
 * - rateLimiter → fingerprintCache（基于指纹的速率检查）
 * - normalizer → alertPreprocessor.process（归一化 + 聚合 + 上下文增强）
 * - deduplicator → fingerprintCache（指纹去重）
 * - filter → noiseFilter.filter（维护窗口 / 已知问题 / 瞬态抖动 / AI 过滤）
 * - analyzer → rootCauseAnalyzer.analyzeSingle（根因分析）
 * - decider → decisionEngine.decide（智能决策引擎）
 */
function buildAlertDeps(): RegisterFlowsDeps['alert'] {
  return {
    rateLimiter: {
      async check(event: unknown) {
        try {
          // 使用 fingerprintCache 做简单的速率检查：
          // 如果同一指纹在 TTL 内已存在，视为被限流
          if (!fingerprintCache || !event || typeof event !== 'object') {
            return { passed: true };
          }
          const alertEvent = event as { id?: string; ruleId?: string; metric?: string; severity?: string; message?: string; tenantId?: string; deviceId?: string };
          const fp = fingerprintCache.generateFingerprint({
            id: alertEvent.id || '',
            ruleId: alertEvent.ruleId || '',
            metric: alertEvent.metric || 'unknown',
            severity: alertEvent.severity || 'info',
            message: alertEvent.message || '',
            tenantId: alertEvent.tenantId,
            deviceId: alertEvent.deviceId,
            currentValue: 0,
            threshold: 0,
            status: 'active',
            triggeredAt: Date.now(),
          } as any);
          const exists = fingerprintCache.exists(fp);
          // Fix #4: Record the fingerprint so subsequent checks can detect rate limiting.
          // Without set(), exists() always returns false and rate limiting never triggers.
          if (!exists) {
            fingerprintCache.set(fp);
          }
          return { passed: !exists };
        } catch (error) {
          logger.debug('Alert rateLimiter adapter degraded:', error);
          return { passed: true };
        }
      },
    },

    normalizer: {
      async normalize(event: unknown) {
        try {
          if (!alertPreprocessor || !event) {
            return event;
          }
          return await alertPreprocessor.process(event as any);
        } catch (error) {
          logger.debug('Alert normalizer adapter degraded:', error);
          return event;
        }
      },
    },

    deduplicator: {
      async checkDuplicate(event: unknown) {
        try {
          if (!fingerprintCache || !event || typeof event !== 'object') {
            return { isDuplicate: false };
          }
          const alertLike = event as { id?: string; ruleId?: string; metric?: string; severity?: string; message?: string; tenantId?: string; deviceId?: string };
          const fp = fingerprintCache.generateFingerprint({
            id: alertLike.id || '',
            ruleId: alertLike.ruleId || '',
            metric: alertLike.metric || 'unknown',
            severity: alertLike.severity || 'info',
            message: alertLike.message || '',
            tenantId: alertLike.tenantId,
            deviceId: alertLike.deviceId,
            currentValue: 0,
            threshold: 0,
            status: 'active',
            triggeredAt: Date.now(),
          } as any);
          const isDuplicate = fingerprintCache.exists(fp);
          // 无论是否重复，都更新指纹缓存
          fingerprintCache.set(fp);
          return { isDuplicate };
        } catch (error) {
          logger.debug('Alert deduplicator adapter degraded:', error);
          return { isDuplicate: false };
        }
      },
    },

    filter: {
      async apply(event: unknown) {
        try {
          if (!noiseFilter || !event) {
            return { filtered: false };
          }
          const result = await noiseFilter.filter(event as any);
          return { filtered: result.filtered, reason: result.reason };
        } catch (error) {
          logger.debug('Alert filter adapter degraded:', error);
          return { filtered: false };
        }
      },
    },

    analyzer: {
      async analyze(event: unknown) {
        try {
          if (!rootCauseAnalyzer || !event) {
            return event;
          }
          return await rootCauseAnalyzer.analyzeSingle(event as any);
        } catch (error) {
          logger.debug('Alert analyzer adapter degraded:', error);
          return event;
        }
      },
    },

    decider: {
      async decide(analysis: unknown, event: unknown) {
        try {
          if (!decisionEngine || !event) {
            return { decision: analysis };
          }
          const decision = await decisionEngine.decide(event as any, analysis as any);
          return {
            decision,
            remediationPlan: undefined,
          };
        } catch (error) {
          logger.debug('Alert decider adapter degraded:', error);
          return { decision: analysis };
        }
      },
      async executeDecision(decision: unknown, plan?: unknown, event?: unknown) {
        if (!decisionEngine || !decision) {
          return;
        }
        await decisionEngine.executeDecision(decision as any, plan as any, event as any);
      },
    },
  };
}

// ============================================================
// Iteration 组适配器构造函数
// ============================================================

/**
 * 构造 Iteration 组依赖适配器
 * 从现有 iterationLoop 相关服务单例构造真实适配器
 *
 * 映射关系：
 * - executor → remediationAdvisor.executeAutoSteps + metricsCollector（执行修复步骤并采集指标）
 * - criticService → criticService.evaluatePlan（评估执行效果）
 * - reflectorService → reflectorService.reflect（生成反思和改进建议）
 * - decisionService → reflectorService.decideNextAction（决定继续/升级/完成）
 */
function buildIterationDeps(): RegisterFlowsDeps['iteration'] {
  return {
    executor: {
      async executeStep(plan: unknown, _iteration: number) {
        try {
          if (!remediationAdvisor || !plan || typeof plan !== 'object') {
            return { results: [] };
          }
          const planObj = plan as { id?: string };
          if (!planObj.id) {
            return { results: [] };
          }

          // 采集执行前指标
          let preMetrics: unknown;
          try {
            if (metricsCollector) {
              const collected = await metricsCollector.collectNow();
              preMetrics = collected?.system;
            }
          } catch {
            // 指标采集失败不阻塞执行
          }

          const results = await remediationAdvisor.executeAutoSteps(planObj.id);

          // 采集执行后指标
          let postMetrics: unknown;
          try {
            if (metricsCollector) {
              const collected = await metricsCollector.collectNow();
              postMetrics = collected?.system;
            }
          } catch {
            // 指标采集失败不阻塞执行
          }

          return { results, preMetrics, postMetrics };
        } catch (error) {
          logger.debug('Iteration executor adapter degraded:', error);
          return { results: [] };
        }
      },
    },

    criticService: {
      async evaluate(executionResults: unknown[], metrics?: { pre?: unknown; post?: unknown }) {
        try {
          if (!criticService || !executionResults) {
            return { score: 0, feedback: 'CriticService unavailable' };
          }
          // Fix #5: Provide richer evaluation context from execution results
          const evaluationContext = {
            alertEvent: {} as any,
            preExecutionState: metrics?.pre || {},
            postExecutionState: metrics?.post || {},
          };
          // Build a more meaningful plan from execution results
          const minimalPlan = {
            id: `eval-plan-${Date.now()}`,
            steps: (executionResults as any[]).map((r: any, i: number) => ({
              id: `step-${i}`,
              action: r?.action ?? r?.toolName ?? 'unknown',
              status: r?.success !== false ? 'completed' : 'failed',
              result: r,
            })),
            status: 'in_progress' as const,
          };
          const evaluation = await criticService.evaluatePlan(
            minimalPlan as any,
            executionResults as any[],
            evaluationContext as any,
          );
          return evaluation;
        } catch (error) {
          logger.debug('Iteration criticService adapter degraded:', error);
          return { score: 0, feedback: 'Evaluation failed' };
        }
      },
    },

    reflectorService: {
      async reflect(evaluation: unknown, executionResults: unknown[]) {
        try {
          if (!reflectorService || !evaluation) {
            return { suggestions: [] };
          }
          // Fix #5: Provide richer reflection context from evaluation and results
          const reflectionContext = {
            alertEvent: {} as any,
            plan: {
              id: `reflect-plan-${Date.now()}`,
              steps: (executionResults as any[]).map((r: any, i: number) => ({
                id: `step-${i}`,
                action: r?.action ?? r?.toolName ?? 'unknown',
                status: r?.success !== false ? 'completed' : 'failed',
                result: r,
              })),
            } as any,
            iterationHistory: {
              evaluations: [evaluation],
              reflections: [],
            },
            systemContext: {
              currentTime: new Date(),
              systemLoad: {},
              recentChanges: [],
            },
          };
          const reflection = await reflectorService.reflect(evaluation as any, reflectionContext as any);
          return reflection;
        } catch (error) {
          logger.debug('Iteration reflectorService adapter degraded:', error);
          return { suggestions: [] };
        }
      },
    },

    decisionService: {
      async decide(evaluation: unknown, reflection: unknown) {
        try {
          if (!reflectorService || !evaluation || !reflection) {
            return { action: 'complete' as const };
          }
          // reflectorService.decideNextAction 需要 reflection + iterationState
          // 构造简化的迭代状态
          const minimalState = {
            id: 'adapter-iteration',
            currentIteration: 0,
            config: { maxIterations: 5 },
            evaluations: [evaluation],
            reflections: [reflection],
          };
          const nextAction = await reflectorService.decideNextAction(reflection as any, minimalState as any);
          // 将 reflectorService 的 action 映射到 handler 期望的格式
          const actionMap: Record<string, 'continue' | 'escalate' | 'complete'> = {
            retry_same: 'continue',
            retry_modified: 'continue',
            try_alternative: 'continue',
            escalate: 'escalate',
            complete: 'complete',
            rollback: 'escalate',
          };
          return {
            action: actionMap[nextAction] || 'complete',
            reason: `Reflector decided: ${nextAction}`,
          };
        } catch (error) {
          logger.debug('Iteration decisionService adapter degraded:', error);
          return { action: 'complete' as const };
        }
      },
    },
  };
}

// ============================================================
// 主构造函数
// ============================================================

/**
 * 构造 RegisterFlowsDeps 依赖对象
 *
 * 从现有服务单例构造所有 Handler 依赖，返回符合 RegisterFlowsDeps 接口的对象。
 * React 组需要 7 个适配器，Alert 组 6 个，Iteration 组 4 个。
 *
 * @returns RegisterFlowsDeps 类型对象
 */
export function buildRegisterFlowsDeps(): RegisterFlowsDeps {
  return {
    react: {
      intentParser: buildIntentParserAdapter(),
      knowledgeRetriever: buildKnowledgeRetrieverAdapter(),
      routingDecider: buildRoutingDeciderAdapter(),
      fastPathRouter: buildFastPathRouterAdapter(),
      intentDrivenExecutor: buildIntentDrivenExecutorAdapter(),
      reactLoopExecutor: buildReactLoopExecutorAdapter(),
      postProcessing: buildPostProcessingAdapter(),
    },
    alert: buildAlertDeps(),
    iteration: buildIterationDeps(),
  };
}

// ============================================================
// 启动初始化函数
// ============================================================

/**
 * 创建 StateMachineOrchestrator 实例并注入到所有服务单例
 *
 * 在 registerCallbacksAndHandlers() 中调用，完成以下工作：
 * 1. 调用 buildRegisterFlowsDeps() 构造依赖
 * 2. 调用 createStateMachineOrchestrator(deps, config) 创建编排器
 * 3. 获取 FeatureFlagManager 实例
 * 4. 注入到 unifiedAgentService、alertPipeline、iterationLoop
 *
 * 整个逻辑包裹在 try-catch 中，初始化失败不阻塞应用启动。
 * 需求: 1.1, 1.2, 1.3, 1.4, 2.1-2.5, 3.1
 */
export async function initializeStateMachineOrchestrator(): Promise<void> {
  try {
    const deps = buildRegisterFlowsDeps();

    // 尝试获取 PgDataStore（可能未初始化）
    let pgDataStore;
    try {
      pgDataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    } catch {
      logger.debug('PgDataStore not available for StateMachineEngine');
    }

    const orchestrator = createStateMachineOrchestrator(deps, {
      tracingService,
      degradationManager,
      pgDataStore,
      featureFlagConfig: {
        flags: {
          'react-orchestration': true,
          'alert-orchestration': true,
          'iteration-orchestration': true,
        },
        comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
      },
    });

    const featureFlagManager = orchestrator.getFeatureFlagManager();

    // 注入到所有服务单例
    unifiedAgentService.setStateMachineOrchestrator(orchestrator);
    unifiedAgentService.setFeatureFlagManager(featureFlagManager);
    alertPipeline.setStateMachineOrchestrator(orchestrator);
    alertPipeline.setFeatureFlagManager(featureFlagManager);
    iterationLoop.setStateMachineOrchestrator(orchestrator);
    iterationLoop.setFeatureFlagManager(featureFlagManager);

    logger.info('StateMachineOrchestrator initialized and injected');
  } catch (error) {
    logger.error('Failed to initialize StateMachineOrchestrator, falling back to legacy paths:', error);
  }
}
