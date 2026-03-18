/**
 * HybridSearchMigration - 混合检索迁移工具
 * 
 * 用于迁移现有知识条目，增强元数据并重建关键词索引。
 * 
 * Requirements: 5.6
 * - 迁移所有现有条目
 * - 支持增量迁移
 * - 验证迁移结果
 */

import { logger } from '../../../../utils/logger';
import { KnowledgeBase, KnowledgeEntry } from '../knowledgeBase';
import { MetadataEnhancer } from '../metadataEnhancer';
import { KeywordIndexManager } from '../keywordIndexManager';
import {
  MigrationResult,
  MigrationProgress,
  VerificationResult,
  EnhancedMetadata,
} from '../types/hybridSearch';

/**
 * 迁移配置
 */
export interface MigrationConfig {
  /** 批量处理大小 */
  batchSize: number;
  /** 是否跳过已增强的条目 */
  skipEnhanced: boolean;
  /** 是否强制重新增强 */
  forceReEnhance: boolean;
  /** 进度回调间隔 */
  progressInterval: number;
}

/**
 * 默认迁移配置
 */
export const DEFAULT_MIGRATION_CONFIG: MigrationConfig = {
  batchSize: 10,
  skipEnhanced: true,
  forceReEnhance: false,
  progressInterval: 5,
};

/**
 * HybridSearchMigration 迁移工具类
 */
export class HybridSearchMigration {
  private knowledgeBase: KnowledgeBase;
  private metadataEnhancer: MetadataEnhancer;
  private keywordIndexManager: KeywordIndexManager;
  private config: MigrationConfig;

  constructor(
    knowledgeBase: KnowledgeBase,
    metadataEnhancer?: MetadataEnhancer,
    keywordIndexManager?: KeywordIndexManager,
    config?: Partial<MigrationConfig>
  ) {
    this.knowledgeBase = knowledgeBase;
    this.metadataEnhancer = metadataEnhancer || knowledgeBase.getMetadataEnhancer()!;
    this.keywordIndexManager = keywordIndexManager || knowledgeBase.getKeywordIndexManager()!;
    this.config = { ...DEFAULT_MIGRATION_CONFIG, ...config };

    if (!this.metadataEnhancer) {
      throw new Error('MetadataEnhancer not available');
    }
    if (!this.keywordIndexManager) {
      throw new Error('KeywordIndexManager not available');
    }
  }

  /**
   * 迁移所有现有条目
   * Requirements: 5.6
   * 
   * @param onProgress 进度回调
   * @returns 迁移结果
   */
  async migrateAll(
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<MigrationResult> {
    const startTime = Date.now();
    const entries = this.knowledgeBase.getAllEntries();
    
    logger.info('Starting hybrid search migration', { totalEntries: entries.length });

    const result: MigrationResult = {
      total: entries.length,
      success: 0,
      failed: 0,
      skipped: 0,
      failedIds: [],
      duration: 0,
    };

    // 过滤需要迁移的条目
    const entriesToMigrate = this.config.skipEnhanced && !this.config.forceReEnhance
      ? entries.filter(e => !e.metadata.enhancedAt)
      : entries;

    result.skipped = entries.length - entriesToMigrate.length;

    // 分批处理
    for (let i = 0; i < entriesToMigrate.length; i += this.config.batchSize) {
      const batch = entriesToMigrate.slice(i, i + this.config.batchSize);
      
      // 处理当前批次
      const batchResults = await Promise.allSettled(
        batch.map(entry => this.migrateEntry(entry.id))
      );

      // 统计结果
      for (let j = 0; j < batchResults.length; j++) {
        const batchResult = batchResults[j];
        if (batchResult.status === 'fulfilled') {
          result.success++;
        } else {
          result.failed++;
          result.failedIds.push(batch[j].id);
          logger.error('Migration failed for entry', {
            entryId: batch[j].id,
            error: batchResult.reason,
          });
        }
      }

      // 报告进度
      if (onProgress && (i + this.config.batchSize) % (this.config.progressInterval * this.config.batchSize) === 0) {
        const current = Math.min(i + this.config.batchSize, entriesToMigrate.length);
        const elapsed = Date.now() - startTime;
        const avgTimePerEntry = elapsed / current;
        const remaining = entriesToMigrate.length - current;
        
        onProgress({
          current: current + result.skipped,
          total: entries.length,
          success: result.success,
          failed: result.failed,
          percentage: Math.round(((current + result.skipped) / entries.length) * 100),
          estimatedRemaining: Math.round(avgTimePerEntry * remaining),
        });
      }
    }

    // 持久化关键词索引
    await this.keywordIndexManager.persist();

    result.duration = Date.now() - startTime;

    logger.info('Hybrid search migration completed', {
      total: result.total,
      success: result.success,
      failed: result.failed,
      skipped: result.skipped,
      duration: result.duration,
    });

    return result;
  }

  /**
   * 迁移单个条目
   * Requirements: 5.6
   * 
   * @param entryId 条目 ID
   */
  async migrateEntry(entryId: string): Promise<void> {
    const entry = await this.knowledgeBase.get(entryId);
    if (!entry) {
      throw new Error(`Entry ${entryId} not found`);
    }

    // 增强元数据
    const enhanced = await this.metadataEnhancer.enhance(entry);

    // 更新条目
    await this.knowledgeBase.update(entryId, {
      metadata: {
        ...entry.metadata,
        autoKeywords: enhanced.autoKeywords,
        questionExamples: enhanced.questionExamples,
        autoSynonyms: enhanced.autoSynonyms,
        searchableText: enhanced.searchableText,
        enhancedAt: enhanced.enhancedAt,
        enhancementSource: enhanced.enhancementSource,
      },
    });

    // 更新关键词索引
    this.keywordIndexManager.updateEntry(entryId, {
      title: entry.title,
      content: entry.content,
      tags: entry.metadata.tags || [],
      autoKeywords: enhanced.autoKeywords,
      questionExamples: enhanced.questionExamples,
    });

    logger.debug('Migrated entry', { entryId });
  }

  /**
   * 验证迁移结果
   * Requirements: 5.6
   * 
   * @returns 验证结果
   */
  async verify(): Promise<VerificationResult> {
    const entries = this.knowledgeBase.getAllEntries();
    const issues: string[] = [];

    let enhancedCount = 0;
    let indexedCount = 0;

    for (const entry of entries) {
      // 检查元数据增强
      if (entry.metadata.enhancedAt) {
        enhancedCount++;
        
        // 验证增强数据完整性
        if (!entry.metadata.autoKeywords || entry.metadata.autoKeywords.length === 0) {
          issues.push(`Entry ${entry.id} has no autoKeywords`);
        }
      } else {
        issues.push(`Entry ${entry.id} not enhanced`);
      }

      // 检查关键词索引
      if (this.keywordIndexManager.hasEntry(entry.id)) {
        indexedCount++;
      } else {
        issues.push(`Entry ${entry.id} not in keyword index`);
      }
    }

    const passed = issues.length === 0;

    logger.info('Migration verification completed', {
      passed,
      totalEntries: entries.length,
      enhancedEntries: enhancedCount,
      indexedEntries: indexedCount,
      issuesCount: issues.length,
    });

    return {
      passed,
      totalEntries: entries.length,
      enhancedEntries: enhancedCount,
      indexedEntries: indexedCount,
      issues,
    };
  }

  /**
   * 检测未增强的条目
   * 
   * @returns 未增强的条目 ID 列表
   */
  getUnenhancedEntries(): string[] {
    const entries = this.knowledgeBase.getAllEntries();
    return entries
      .filter(e => !e.metadata.enhancedAt)
      .map(e => e.id);
  }

  /**
   * 获取迁移统计
   */
  getMigrationStats(): {
    total: number;
    enhanced: number;
    indexed: number;
    pending: number;
  } {
    const entries = this.knowledgeBase.getAllEntries();
    const enhanced = entries.filter(e => e.metadata.enhancedAt).length;
    const indexed = entries.filter(e => this.keywordIndexManager.hasEntry(e.id)).length;

    return {
      total: entries.length,
      enhanced,
      indexed,
      pending: entries.length - enhanced,
    };
  }
}
