/**
 * EvolutionEngine — 进化引擎
 *
 * 通过反馈闭环持续优化规则、知识和 Prompt：
 * - 正面反馈（≥ 0.8）→ 提取 verified_experience 向量化存入 prompt_knowledge
 * - 负面反馈（≤ 0.3）→ 记录 negative_experience，降低检索权重
 * - 整合 ruleEvolutionService.learnFromReflection()，规则同步向量化
 * - 知识版本历史（保留最近 5 个版本）、定期清理（24h）淘汰低价值条目
 * - 新规则生成时发布 rule_evolved 事件
 *
 * Requirements: F4.14, F4.15, F4.16, F4.17, F4.18, F4.19
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import type { EvolutionEngineLike, EvolutionInput, EvolutionResult } from './learningOrchestrator';
import type { VectorStoreClient, VectorDocument } from './rag/vectorStoreClient';
import type { DataStore } from '../dataStore';
import type { EventBus, PerceptionEvent } from '../eventBus';
import type { ReflectionResult } from '../../types/ai-ops';

// ---------------------------------------------------------------------------
// Dependency interfaces (loose coupling)
// ---------------------------------------------------------------------------

/** RuleEvolutionService 接口 — 仅需 learnFromReflection (F4.16) */
export interface RuleEvolutionServiceLike {
  learnFromReflection(reflection: ReflectionResult): Promise<unknown[]>;
}

/** EvolutionEngine 构造依赖 */
export interface EvolutionEngineDeps {
  vectorClient: VectorStoreClient;
  dataStore: DataStore;
  eventBus?: EventBus;
  ruleEvolutionService?: RuleEvolutionServiceLike;
}

/** 进化引擎配置 (overallScore 使用 0-100 刻度) */
export interface EvolutionEngineConfig {
  positiveThreshold: number;       // F4.14 正面反馈阈值 (默认 80)
  negativeThreshold: number;       // F4.15 负面反馈阈值 (默认 30)
  maxVersions: number;             // F4.17 版本保留数
  cleanupIntervalHours: number;    // F4.18 清理周期
  maxKnowledgeEntries: number;     // PF.6 知识库上限
  promotionThreshold: number;      // PF.8 模式推广阈值 (默认 80)
}

/** prompt_knowledge 集合名称 */
const COLLECTION = 'prompt_knowledge';

// ---------------------------------------------------------------------------
// EvolutionEngine
// ---------------------------------------------------------------------------

export class EvolutionEngine implements EvolutionEngineLike {
  private readonly vectorClient: VectorStoreClient;
  private readonly dataStore: DataStore;
  private readonly eventBus?: EventBus;
  private readonly ruleEvolutionService?: RuleEvolutionServiceLike;

  private readonly config: EvolutionEngineConfig;

  /** 单次 evolve() 调用的计数器 */
  private updatedCount = 0;
  private newCount = 0;

  constructor(deps: EvolutionEngineDeps, config?: Partial<EvolutionEngineConfig>) {
    this.vectorClient = deps.vectorClient;
    this.dataStore = deps.dataStore;
    this.eventBus = deps.eventBus;
    this.ruleEvolutionService = deps.ruleEvolutionService;

    this.config = {
      positiveThreshold: 80,         // overallScore is 0-100 scale
      negativeThreshold: 30,         // overallScore is 0-100 scale
      maxVersions: 5,
      cleanupIntervalHours: 24,
      maxKnowledgeEntries: 10000,
      promotionThreshold: 80,
      ...config,
    };
  }

  // ── Core: evolve() ────────────────────────────────────────────

  /**
   * 进化入口 — LearningOrchestrator 调用 (F4.13)
   *
   * 1. 根据评分执行正面/负面经验处理
   * 2. 调用 ruleEvolutionService.learnFromReflection() (F4.16)
   * 3. 发布 rule_evolved 事件 (F4.19)
   */
  async evolve(input: EvolutionInput): Promise<EvolutionResult> {
    this.updatedCount = 0;
    this.newCount = 0;

    const score = input.evaluation.overallScore;

    // Step 1: 正面/负面反馈处理
    if (score >= this.config.positiveThreshold) {
      try {
        await this.extractPositiveExperience(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[EvolutionEngine] extractPositiveExperience failed: ${msg}`);
      }
    } else if (score <= this.config.negativeThreshold) {
      try {
        await this.recordNegativeExperience(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[EvolutionEngine] recordNegativeExperience failed: ${msg}`);
      }
    }

    // Step 2: 规则进化 (F4.16)
    if (this.ruleEvolutionService && input.reflection) {
      try {
        const newRules = await this.ruleEvolutionService.learnFromReflection(input.reflection);
        if (newRules.length > 0) {
          logger.info(`[EvolutionEngine] learnFromReflection produced ${newRules.length} rule(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[EvolutionEngine] learnFromReflection failed: ${msg}`);
      }
    }

    // Step 3: 发布 rule_evolved 事件 (F4.19)
    const patterns = input.patterns as { newRules?: unknown[] } | unknown[];
    const newRules = Array.isArray(patterns)
      ? []
      : (patterns?.newRules ?? []) as unknown[];

    if (newRules.length > 0 && this.eventBus) {
      try {
        await this.eventBus.publish({
          type: 'internal',
          priority: 'low',
          source: 'evolution-engine',
          payload: { event: 'rule_evolved', rules: newRules },
          schemaVersion: '1.0',
        });
        logger.info(`[EvolutionEngine] Published rule_evolved event with ${newRules.length} rule(s)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[EvolutionEngine] Failed to publish rule_evolved event: ${msg}`);
      }
    }

    return { updatedEntries: this.updatedCount, newEntries: this.newCount };
  }

  // ── Positive experience (F4.14) ──────────────────────────────

  /**
   * 正面反馈 → 提取 verified_experience 向量化存入 prompt_knowledge
   */
  private async extractPositiveExperience(input: EvolutionInput): Promise<void> {
    const { evaluation, reflection, tickResult } = input;

    const content = [
      `[verified_experience] Score: ${evaluation.overallScore}`,
      `Plan: ${tickResult.plan.description ?? tickResult.plan.id}`,
      reflection ? `Insights: ${reflection.insights?.join('; ') ?? 'none'}` : '',
      reflection ? `Summary: ${reflection.summary}` : '',
    ].filter(Boolean).join('\n');

    const entryId = `ve_${uuidv4()}`;
    const now = Date.now();

    // Upsert to vector store
    const doc: VectorDocument = {
      id: entryId,
      content,
      metadata: {
        type: 'verified_experience',
        feedbackScore: evaluation.overallScore,
        hitCount: 0,
        planId: tickResult.plan.id,
        alertId: evaluation.alertId,
        createdAt: now,
        version: 1,
      },
    };
    await this.vectorClient.upsert(COLLECTION, [doc]);

    // Persist version history to PostgreSQL (F4.17)
    await this.saveVersionHistory(entryId, content, doc.metadata!, 1);

    this.newCount += 1;
    logger.info(`[EvolutionEngine] Extracted positive experience ${entryId}, score=${evaluation.overallScore}`);
  }

  // ── Negative experience (F4.15) ─────────────────────────────

  /**
   * 负面反馈 → 记录 negative_experience，降低相关 Prompt/Skill 检索权重
   */
  private async recordNegativeExperience(input: EvolutionInput): Promise<void> {
    const { evaluation, reflection, tickResult } = input;

    const content = [
      `[negative_experience] Score: ${evaluation.overallScore}`,
      `Plan: ${tickResult.plan.description ?? tickResult.plan.id}`,
      reflection ? `Gap: ${reflection.gapAnalysis}` : '',
      reflection ? `Next action: ${reflection.nextAction}` : '',
    ].filter(Boolean).join('\n');

    const entryId = `ne_${uuidv4()}`;
    const now = Date.now();

    // Upsert negative experience with low feedbackScore so it ranks low in retrieval
    const doc: VectorDocument = {
      id: entryId,
      content,
      metadata: {
        type: 'negative_experience',
        feedbackScore: evaluation.overallScore,
        hitCount: 0,
        planId: tickResult.plan.id,
        alertId: evaluation.alertId,
        createdAt: now,
        version: 1,
      },
    };
    await this.vectorClient.upsert(COLLECTION, [doc]);

    // Persist version history
    await this.saveVersionHistory(entryId, content, doc.metadata!, 1);

    // Lower weight of related entries by searching for similar content and reducing feedbackScore
    try {
      const planDesc = tickResult.plan.description ?? tickResult.plan.id;
      const related = await this.vectorClient.search(COLLECTION, {
        collection: COLLECTION,
        query: planDesc,
        top_k: 3,
        min_score: 0.5,
      });

      for (const hit of related) {
        if (hit.id === entryId) continue;
        const currentScore = (hit.metadata?.feedbackScore as number) ?? 50;
        const reducedScore = Math.max(0, currentScore * 0.8); // reduce by 20%
        await this.vectorClient.upsert(COLLECTION, [{
          id: hit.id,
          content: hit.text,
          metadata: { ...hit.metadata, feedbackScore: reducedScore },
        }]);
        this.updatedCount += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[EvolutionEngine] Failed to lower related entry weights: ${msg}`);
    }

    this.newCount += 1;
    logger.info(`[EvolutionEngine] Recorded negative experience ${entryId}, score=${evaluation.overallScore}`);
  }

  // ── Version history (F4.17) ──────────────────────────────────

  /**
   * 保存知识条目版本历史，保留最近 maxVersions 个版本
   */
  private async saveVersionHistory(
    entryId: string,
    content: string,
    metadata: Record<string, unknown>,
    version: number,
  ): Promise<void> {
    try {
      await this.dataStore.execute(
        `INSERT INTO knowledge_version_history (id, entry_id, version, content, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [uuidv4(), entryId, version, content, JSON.stringify(metadata)],
      );

      // Prune old versions beyond maxVersions
      await this.dataStore.execute(
        `DELETE FROM knowledge_version_history
         WHERE entry_id = $1
           AND id NOT IN (
             SELECT id FROM knowledge_version_history
             WHERE entry_id = $1
             ORDER BY version DESC
             LIMIT $2
           )`,
        [entryId, this.config.maxVersions],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[EvolutionEngine] saveVersionHistory failed for ${entryId}: ${msg}`);
    }
  }

  // ── Cleanup (F4.18) ────────────────────────────────────────

  /**
   * 定期清理 — 淘汰低价值条目，保持总数 <= maxKnowledgeEntries
   *
   * 策略：
   * 1. 删除超过 cleanupIntervalHours 且 feedbackScore 低的条目
   * 2. 如果总数仍超限，按 feedbackScore ASC + hitCount ASC 淘汰
   */
  async cleanup(): Promise<{ deleted: number }> {
    let totalDeleted = 0;

    try {
      // Step 1: 删除过期低价值条目（超过 cleanupIntervalHours 且 feedbackScore < negativeThreshold）
      const cutoffMs = Date.now() - this.config.cleanupIntervalHours * 3600 * 1000;
      const staleRows = await this.dataStore.query<{ entry_id: string }>(
        `SELECT entry_id FROM knowledge_version_history
         WHERE created_at < to_timestamp($1 / 1000.0)
           AND (metadata::jsonb->>'feedbackScore')::float < $2
         GROUP BY entry_id`,
        [cutoffMs, this.config.negativeThreshold],
      );

      for (const row of staleRows) {
        try {
          await this.vectorClient.delete(COLLECTION, row.entry_id);
          await this.dataStore.execute(
            `DELETE FROM knowledge_version_history WHERE entry_id = $1`,
            [row.entry_id],
          );
          totalDeleted += 1;
        } catch {
          // best-effort per entry
        }
      }

      // Step 2: 如果总数仍超限，按 feedbackScore ASC, hitCount ASC 淘汰
      const countResult = await this.dataStore.queryOne<{ cnt: string }>(
        `SELECT COUNT(DISTINCT entry_id) as cnt FROM knowledge_version_history`,
      );
      const currentCount = parseInt(countResult?.cnt ?? '0', 10);

      if (currentCount > this.config.maxKnowledgeEntries) {
        const excess = currentCount - this.config.maxKnowledgeEntries;
        const toDelete = await this.dataStore.query<{ entry_id: string }>(
          `SELECT entry_id,
                  (metadata::jsonb->>'feedbackScore')::float as score,
                  (metadata::jsonb->>'hitCount')::int as hits
           FROM knowledge_version_history
           WHERE version = (
             SELECT MAX(version) FROM knowledge_version_history kvh2
             WHERE kvh2.entry_id = knowledge_version_history.entry_id
           )
           ORDER BY score ASC NULLS FIRST, hits ASC NULLS FIRST
           LIMIT $1`,
          [excess],
        );

        for (const row of toDelete) {
          try {
            await this.vectorClient.delete(COLLECTION, row.entry_id);
            await this.dataStore.execute(
              `DELETE FROM knowledge_version_history WHERE entry_id = $1`,
              [row.entry_id],
            );
            totalDeleted += 1;
          } catch {
            // best-effort
          }
        }
      }

      logger.info(`[EvolutionEngine] Cleanup completed, deleted ${totalDeleted} entries`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[EvolutionEngine] Cleanup failed: ${msg}`);
    }

    return { deleted: totalDeleted };
  }

  /** 获取当前配置（用于测试/调试） */
  getConfig(): Readonly<EvolutionEngineConfig> {
    return { ...this.config };
  }
}
