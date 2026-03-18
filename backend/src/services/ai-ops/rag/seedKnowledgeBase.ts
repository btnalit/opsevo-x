/**
 * 知识库种子数据加载器
 *
 * 从 data/ai-ops/knowledge-seed/ 目录加载预定义的知识条目，
 * 用于初始化部署环境中的知识库（如 API 路径参考等）。
 *
 * @see Requirements 8.4 - API 路径知识库条目初始化
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { KnowledgeBase, KnowledgeEntryType } from './knowledgeBase';
import { logger } from '../../../utils/logger';

interface SeedEntry {
  type: KnowledgeEntryType;
  title: string;
  content: string;
  metadata: {
    source: string;
    category: string;
    tags: string[];
  };
}

interface SeedFile {
  description: string;
  version: string;
  entries: SeedEntry[];
}

/**
 * 加载知识库种子数据
 *
 * 扫描 data/ai-ops/knowledge-seed/ 目录下的所有 JSON 文件，
 * 将其中的知识条目批量导入知识库。已存在的同名条目会被跳过。
 *
 * @param knowledgeBase - 已初始化的知识库实例
 * @returns 导入统计 { loaded: number, skipped: number, failed: number }
 */
export async function seedKnowledgeBase(
  knowledgeBase: KnowledgeBase
): Promise<{ loaded: number; skipped: number; failed: number }> {
  const seedDir = path.resolve(__dirname, '../../../../data/ai-ops/knowledge-seed');
  const stats = { loaded: 0, skipped: 0, failed: 0 };

  let files: string[];
  try {
    files = (await fs.readdir(seedDir)).filter(f => f.endsWith('.json'));
  } catch {
    logger.info('No knowledge seed directory found, skipping seed data loading');
    return stats;
  }

  if (files.length === 0) {
    logger.info('No seed files found in knowledge-seed directory');
    return stats;
  }

  for (const file of files) {
    try {
      const filePath = path.join(seedDir, file);
      const raw = await fs.readFile(filePath, 'utf-8');
      const seedFile: SeedFile = JSON.parse(raw);

      logger.info(`Loading seed file: ${file} (${seedFile.entries.length} entries)`);

      for (const entry of seedFile.entries) {
        try {
          // 检查是否已存在同标题的条目（避免重复导入）
          const existing = await knowledgeBase.search({
            query: entry.title,
            type: entry.type,
            limit: 1,
          });

          if (existing.length > 0 && existing[0].entry.title === entry.title) {
            stats.skipped++;
            continue;
          }

          await knowledgeBase.add({
            type: entry.type,
            title: entry.title,
            content: entry.content,
            metadata: {
              source: entry.metadata.source,
              timestamp: Date.now(),
              category: entry.metadata.category,
              tags: entry.metadata.tags,
              usageCount: 0,
              feedbackScore: 0,
              feedbackCount: 0,
            },
          });
          stats.loaded++;
        } catch (err) {
          logger.warn(`Failed to seed entry "${entry.title}": ${err}`);
          stats.failed++;
        }
      }
    } catch (err) {
      logger.error(`Failed to load seed file ${file}: ${err}`);
    }
  }

  logger.info(`Knowledge base seeding complete: ${stats.loaded} loaded, ${stats.skipped} skipped, ${stats.failed} failed`);
  return stats;
}
