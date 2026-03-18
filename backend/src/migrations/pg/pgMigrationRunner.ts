/**
 * PostgreSQL Migration Runner
 *
 * 自动执行 PostgreSQL Schema 迁移，支持：
 * - schema_migrations 版本追踪表
 * - 按文件名前缀数字顺序执行迁移
 * - 每个迁移在独立事务中执行
 * - 系统启动时自动调用
 *
 * Requirements: C1.3, C1.5
 */

import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../utils/logger';
import type { DataStore } from '../../services/dataStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PgMigrationDefinition {
  /** 迁移版本号 */
  version: number;
  /** 迁移描述 */
  description: string;
  /** 升级 SQL 语句 */
  up: string;
  /** 回滚 SQL 语句 */
  down: string;
}

export interface MigrationResult {
  applied: number;
  skipped: number;
  total: number;
}

// ─── Migration Runner ────────────────────────────────────────────────────────

/**
 * 运行所有待执行的 PostgreSQL 迁移
 *
 * @param dataStore - PgDataStore 实例
 * @param migrationsDir - 迁移文件目录，默认为当前目录
 * @returns 迁移执行结果
 */
export async function runPgMigrations(
  dataStore: DataStore,
  migrationsDir?: string,
): Promise<MigrationResult> {
  const dir = migrationsDir ?? path.join(__dirname);

  // 1. 创建 schema_migrations 追踪表
  await ensureMigrationsTable(dataStore);

  // 2. 获取已应用的版本
  const appliedVersions = await getAppliedVersions(dataStore);

  // 3. 加载迁移文件
  const migrations = await loadMigrations(dir);

  if (migrations.length === 0) {
    logger.info('[PgMigration] 没有找到 PostgreSQL 迁移文件');
    return { applied: 0, skipped: 0, total: 0 };
  }

  // 4. 按版本号排序
  migrations.sort((a, b) => a.version - b.version);

  // 5. 执行未应用的迁移
  let applied = 0;
  let skipped = 0;

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      logger.debug(`[PgMigration] v${migration.version} 已应用，跳过`);
      skipped++;
      continue;
    }

    logger.info(
      `[PgMigration] 正在应用 v${migration.version}: ${migration.description}...`,
    );

    try {
      await dataStore.transaction(async (tx) => {
        // 执行迁移 SQL（可能包含多条语句）
        await tx.execute(migration.up);
        // 记录已应用的版本
        await tx.execute(
          'INSERT INTO schema_migrations (version, description) VALUES ($1, $2)',
          [migration.version, migration.description],
        );
      });

      applied++;
      logger.info(
        `[PgMigration] v${migration.version} 应用成功`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        `[PgMigration] v${migration.version} 执行失败: ${err.message}`,
      );
      throw new Error(
        `PostgreSQL 迁移 v${migration.version} 失败: ${err.message}`,
      );
    }
  }

  if (applied > 0) {
    logger.info(`[PgMigration] 共应用 ${applied} 个迁移`);
  } else {
    logger.info('[PgMigration] PostgreSQL Schema 已是最新版本');
  }

  return { applied, skipped, total: migrations.length };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * 确保 schema_migrations 表存在
 */
async function ensureMigrationsTable(dataStore: DataStore): Promise<void> {
  await dataStore.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * 获取已应用的迁移版本集合
 */
async function getAppliedVersions(dataStore: DataStore): Promise<Set<number>> {
  const rows = await dataStore.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return new Set(rows.map((r) => r.version));
}

/**
 * 从目录加载迁移文件
 *
 * 文件命名规则：NNN_description.ts（如 001_core_tables.ts）
 * 文件必须 default export 一个 PgMigrationDefinition 对象
 */
async function loadMigrations(
  dir: string,
): Promise<PgMigrationDefinition[]> {
  if (!fs.existsSync(dir)) {
    logger.warn(`[PgMigration] 迁移目录不存在: ${dir}`);
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        /^\d{3}_.*\.(ts|js)$/.test(f) &&
        !/\.d\.ts$/.test(f) &&
        !/\.(test|spec)\.(ts|js)$/.test(f),
    )
    .sort();

  const migrations: PgMigrationDefinition[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(filePath);
      const migration: PgMigrationDefinition = mod.default ?? mod;

      if (
        typeof migration.version !== 'number' ||
        typeof migration.up !== 'string' ||
        typeof migration.down !== 'string'
      ) {
        logger.warn(`[PgMigration] 文件 ${file} 格式无效，跳过`);
        continue;
      }

      migrations.push(migration);
      logger.debug(`[PgMigration] 已加载: ${file} (v${migration.version})`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[PgMigration] 加载 ${file} 失败: ${err.message}`);
      throw new Error(`加载 PostgreSQL 迁移文件 ${file} 失败: ${err.message}`);
    }
  }

  return migrations;
}

// ─── Exported for testing ────────────────────────────────────────────────────

export { ensureMigrationsTable, getAppliedVersions, loadMigrations };
