/**
 * Prompt 知识库种子数据加载器
 *
 * 从 data/ai-ops/knowledge-seed/prompt-knowledge.json 加载泛化后的 Prompt 模板，
 * 通过 VectorStoreClient 向量化存入 prompt_knowledge 集合。
 *
 * 每个条目包含：原始文本、类别标签、适用设备类型、版本号、反馈评分。
 * 所有 RouterOS 硬编码引用已被替换为 {{device_type}} 和 {{device_capabilities}} 占位符。
 *
 * @see Requirements F1.1 - Prompt 模板拆解去 RouterOS
 * @see Requirements F1.2 - 知识条目向量化存储
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { VectorStoreClient, VectorDocument } from '../rag/vectorStoreClient';
import { logger } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prompt 知识条目类别 */
export type PromptCategory = 'system_prompt' | 'operation_rule' | 'experience' | 'pattern';

/** 种子文件中的单个条目 */
export interface PromptKnowledgeSeedEntry {
  id: string;
  text: string;
  category: PromptCategory;
  deviceTypes: string[];       // 空数组表示通用
  version: number;
  feedbackScore: number;       // 0.0 - 1.0
  tags: string[];
}

/** 种子文件结构 */
interface PromptKnowledgeSeedFile {
  description: string;
  version: string;
  entries: PromptKnowledgeSeedEntry[];
}

/** 种子加载统计 */
export interface SeedStats {
  loaded: number;
  skipped: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'prompt_knowledge';
const SEED_FILE = 'prompt-knowledge.json';

// ---------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------

/**
 * 将泛化后的 Prompt 模板种子数据向量化存入 prompt_knowledge 集合。
 *
 * 幂等操作：通过 VectorStoreClient.search 检查已有条目，
 * 仅当同 id 条目不存在时才执行 upsert。
 *
 * @param vectorClient - VectorStoreClient 实例
 * @returns 导入统计
 */
export async function seedPromptKnowledge(
  vectorClient: VectorStoreClient,
): Promise<SeedStats> {
  const stats: SeedStats = { loaded: 0, skipped: 0, failed: 0 };

  // 1. 读取种子文件
  const seedPath = path.resolve(
    __dirname,
    '../../../../data/ai-ops/knowledge-seed',
    SEED_FILE,
  );

  let seedFile: PromptKnowledgeSeedFile;
  try {
    const raw = await fs.readFile(seedPath, 'utf-8');
    seedFile = JSON.parse(raw) as PromptKnowledgeSeedFile;
  } catch (err) {
    logger.warn(`[PromptKnowledgeSeeder] Seed file not found or invalid: ${seedPath}`, err);
    return stats;
  }

  logger.info(
    `[PromptKnowledgeSeeder] Loading ${seedFile.entries.length} prompt knowledge entries (v${seedFile.version})`,
  );

  // 2. 逐条 upsert
  for (const entry of seedFile.entries) {
    try {
      // 检查是否已存在（按 id 精确匹配）
      const existing = await vectorClient.search(COLLECTION, {
        collection: COLLECTION,
        query: entry.id,
        top_k: 1,
        filter: { id: entry.id },
      });

      if (existing.length > 0 && existing[0].metadata?.id === entry.id) {
        stats.skipped++;
        continue;
      }

      // 构建 VectorDocument
      const doc: VectorDocument = {
        id: entry.id,
        content: entry.text,
        metadata: {
          id: entry.id,
          category: entry.category,
          deviceTypes: entry.deviceTypes,
          version: entry.version,
          feedbackScore: entry.feedbackScore,
          tags: entry.tags,
          hitCount: 0,
          source: 'seed-data',
          createdAt: new Date().toISOString(),
        },
      };

      await vectorClient.upsert(COLLECTION, [doc]);
      stats.loaded++;
    } catch (err) {
      logger.warn(`[PromptKnowledgeSeeder] Failed to seed entry "${entry.id}": ${err}`);
      stats.failed++;
    }
  }

  logger.info(
    `[PromptKnowledgeSeeder] Seeding complete: ${stats.loaded} loaded, ${stats.skipped} skipped, ${stats.failed} failed`,
  );
  return stats;
}
