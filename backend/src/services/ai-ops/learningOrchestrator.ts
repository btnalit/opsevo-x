/**
 * LearningOrchestrator — 统一学习编排器
 *
 * Tick 完成后协调完整学习流程：
 *   CriticService 评估 → ReflectorService 反思 → PatternLearner 模式识别 → EvolutionEngine 知识进化
 *
 * 设计原则：
 * - 依赖注入：所有服务通过构造函数注入，保持松耦合
 * - 独立容错：每个编排步骤独立 try/catch，单步失败不阻塞后续流程
 * - EvolutionEngine 可选：Task 17.5 实现前可为 undefined
 *
 * Requirements: F2.8, F2.9, F2.10, F3.11, F3.12, F4.13, F4.20, F4.21
 */

import { logger } from '../../utils/logger';
import type {
  EvaluationReport,
  EvaluationContext,
  ReflectionResult,
  ReflectionContext,
  RemediationPlan,
  ExecutionResult,
  AlertFeedback,
  SystemMetrics,
} from '../../types/ai-ops';

// ---------------------------------------------------------------------------
// Dependency interfaces (loose coupling)
// ---------------------------------------------------------------------------

/** CriticService 评估接口 — 五维度评估 (F2.8) */
export interface CriticServiceLike {
  evaluatePlan(
    plan: RemediationPlan,
    results: ExecutionResult[],
    context: EvaluationContext,
  ): Promise<EvaluationReport>;
}

/** ReflectorService 反思接口 — 深度反思 + 学习持久化 (F2.9, F2.10) */
export interface ReflectorServiceLike {
  reflect(
    evaluation: EvaluationReport,
    context: ReflectionContext,
  ): Promise<ReflectionResult>;
}

/** PatternLearner 模式识别接口 (F3.12) */
export interface PatternLearnerLike {
  identifyPatterns(userId: string): unknown[];
}

/** EvolutionEngine 知识进化接口 — 可选，Task 17.5 实现 */
export interface EvolutionEngineLike {
  evolve(input: EvolutionInput): Promise<EvolutionResult>;
}

/** FeedbackService 用户反馈接口 (F3.11) */
export interface FeedbackServiceLike {
  recordFeedback(
    feedback: { alertId: string; useful: boolean; comment?: string; tags?: string[] },
    alertInfo?: Record<string, unknown>,
  ): Promise<AlertFeedback>;
}

// ---------------------------------------------------------------------------
// Orchestrator types
// ---------------------------------------------------------------------------

/** Tick 执行结果 — orchestrate() 的输入 */
export interface TickResult {
  tickId: string;
  plan: RemediationPlan;
  results: ExecutionResult[];
  context: EvaluationContext;
  reflectionContext: ReflectionContext;
  userId?: string;
}

/** EvolutionEngine 输入 */
export interface EvolutionInput {
  evaluation: EvaluationReport;
  reflection: ReflectionResult;
  patterns: unknown[];
  tickResult: TickResult;
}

/** EvolutionEngine 输出 */
export interface EvolutionResult {
  updatedEntries: number;
  newEntries: number;
}

/** orchestrate() 的完整输出 */
export interface LearningResult {
  evaluation: EvaluationReport | null;
  reflection: ReflectionResult | null;
  patterns: unknown[];
  evolution: EvolutionResult | null;
  errors: LearningStepError[];
}

/** 单步错误记录 */
export interface LearningStepError {
  step: 'evaluate' | 'reflect' | 'pattern' | 'evolve';
  message: string;
}

// ---------------------------------------------------------------------------
// Constructor dependencies
// ---------------------------------------------------------------------------

export interface LearningOrchestratorDeps {
  critic: CriticServiceLike;
  reflector: ReflectorServiceLike;
  patternLearner: PatternLearnerLike;
  feedbackService?: FeedbackServiceLike;
  evolutionEngine?: EvolutionEngineLike;
}

// ---------------------------------------------------------------------------
// LearningOrchestrator
// ---------------------------------------------------------------------------

export class LearningOrchestrator {
  private readonly critic: CriticServiceLike;
  private readonly reflector: ReflectorServiceLike;
  private readonly patternLearner: PatternLearnerLike;
  private readonly feedbackService?: FeedbackServiceLike;
  private evolutionEngine?: EvolutionEngineLike;

  constructor(deps: LearningOrchestratorDeps) {
    this.critic = deps.critic;
    this.reflector = deps.reflector;
    this.patternLearner = deps.patternLearner;
    this.feedbackService = deps.feedbackService;
    this.evolutionEngine = deps.evolutionEngine;
  }

  /**
   * Tick 完成后触发完整学习流程 (F4.13)
   *
   * 1. CriticService 评估 (F2.8)
   * 2. ReflectorService 反思 (F2.9)
   * 3. PatternLearner 模式识别 (F3.12)
   * 4. EvolutionEngine 知识进化 (optional)
   *
   * 每步独立容错 — 单步失败记录错误但继续后续步骤。
   */
  async orchestrate(tickResult: TickResult): Promise<LearningResult> {
    const errors: LearningStepError[] = [];
    let evaluation: EvaluationReport | null = null;
    let reflection: ReflectionResult | null = null;
    let patterns: unknown[] = [];
    let evolution: EvolutionResult | null = null;

    // Step 1: CriticService 评估 (F2.8)
    try {
      evaluation = await this.critic.evaluatePlan(
        tickResult.plan,
        tickResult.results,
        tickResult.context,
      );
      logger.info(`[LearningOrchestrator] Evaluation completed for tick ${tickResult.tickId}, score: ${evaluation.overallScore}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LearningOrchestrator] Evaluation failed for tick ${tickResult.tickId}: ${message}`);
      errors.push({ step: 'evaluate', message });
    }

    // Step 2: ReflectorService 反思 (F2.9) — 需要 evaluation 结果
    if (evaluation) {
      try {
        reflection = await this.reflector.reflect(
          evaluation,
          tickResult.reflectionContext,
        );
        logger.info(`[LearningOrchestrator] Reflection completed for tick ${tickResult.tickId}, action: ${reflection.nextAction}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[LearningOrchestrator] Reflection failed for tick ${tickResult.tickId}: ${message}`);
        errors.push({ step: 'reflect', message });
      }
    }

    // Step 3: PatternLearner 模式识别 (F3.12)
    try {
      const userId = tickResult.userId ?? 'system';
      patterns = this.patternLearner.identifyPatterns(userId);
      logger.info(`[LearningOrchestrator] Pattern identification completed for tick ${tickResult.tickId}, found ${patterns.length} patterns`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LearningOrchestrator] Pattern identification failed for tick ${tickResult.tickId}: ${message}`);
      errors.push({ step: 'pattern', message });
    }

    // Step 4: EvolutionEngine 知识进化 (optional — Task 17.5)
    if (this.evolutionEngine && evaluation) {
      try {
        evolution = await this.evolutionEngine.evolve({
          evaluation,
          reflection: reflection!,
          patterns,
          tickResult,
        });
        logger.info(`[LearningOrchestrator] Evolution completed for tick ${tickResult.tickId}, updated: ${evolution.updatedEntries}, new: ${evolution.newEntries}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[LearningOrchestrator] Evolution failed for tick ${tickResult.tickId}: ${message}`);
        errors.push({ step: 'evolve', message });
      }
    }

    if (errors.length > 0) {
      logger.warn(`[LearningOrchestrator] Tick ${tickResult.tickId} completed with ${errors.length} error(s)`);
    }

    return { evaluation, reflection, patterns, evolution, errors };
  }

  /**
   * 处理用户反馈 (F3.11)
   * 将反馈转发给 FeedbackService 进行记录和后续学习触发。
   */
  async processFeedback(
    feedback: { alertId: string; useful: boolean; comment?: string; tags?: string[] },
    alertInfo?: Record<string, unknown>,
  ): Promise<AlertFeedback | null> {
    if (!this.feedbackService) {
      logger.warn('[LearningOrchestrator] processFeedback called but FeedbackService not available');
      return null;
    }

    try {
      const result = await this.feedbackService.recordFeedback(feedback, alertInfo);
      logger.info(`[LearningOrchestrator] Feedback recorded for alert ${feedback.alertId}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[LearningOrchestrator] Failed to record feedback for alert ${feedback.alertId}: ${message}`);
      return null;
    }
  }

  /** Set or replace the EvolutionEngine at runtime (for late binding in Task 17.5). */
  setEvolutionEngine(engine: EvolutionEngineLike): void {
    this.evolutionEngine = engine;
  }
}
