/**
 * SQLite → PostgreSQL 数据迁移脚本
 *
 * 将现有 SQLite 数据库中的 12 张核心业务表数据无损迁移至 PostgreSQL。
 * 处理类型转换：TEXT→JSONB, INTEGER→BOOLEAN, TEXT datetime→TIMESTAMPTZ, TEXT id→UUID
 *
 * 用法: npx ts-node backend/src/migrations/pg/migrate-from-sqlite.ts
 *
 * Requirements: C1.6, PC.1
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface MigrationReport {
  success: boolean;
  tables: TableReport[];
  totalRecords: number;
  totalMigrated: number;
  errors: string[];
  duration: number;
}

interface TableReport {
  table: string;
  sqliteCount: number;
  pgCount: number;
  migrated: number;
  skipped: number;
  errors: string[];
}

/** Maps old SQLite TEXT IDs → new PostgreSQL UUIDs */
type IdMapping = Map<string, string>;

interface TableIdMappings {
  users: IdMapping;
  devices: IdMapping;
  alert_rules: IdMapping;
  alert_events: IdMapping;
  chat_sessions: IdMapping;
  [key: string]: IdMapping;
}

/**
 * Defines how each SQLite table maps to the PostgreSQL schema.
 */
interface ColumnMapping {
  /** PG column name */
  pgCol: string;
  /** Source: 'direct' = same column name, 'transform' = custom function, 'generate' = new value */
  source: 'direct' | 'transform' | 'generate';
  /** SQLite column name (for 'direct' or as input to 'transform') */
  sqliteCol?: string;
  /** Transform function */
  transform?: (value: unknown, row: Record<string, unknown>, mappings: TableIdMappings) => unknown;
}

interface TableMigrationConfig {
  table: string;
  columns: ColumnMapping[];
  fkDependencies?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 1000;

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log('[' + ts + '] ' + msg);
}

function logError(msg: string): void {
  const ts = new Date().toISOString();
  console.error('[' + ts + '] ERROR: ' + msg);
}

/** Parse a SQLite TEXT value as JSON, returning a fallback if invalid. */
function safeParseJson(value: unknown, fallback: unknown = {}): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

/** Convert SQLite INTEGER (0/1) to PostgreSQL BOOLEAN. */
function intToBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return Number(value) !== 0;
}

/**
 * Convert SQLite TEXT datetime to ISO 8601 string for TIMESTAMPTZ.
 * Returns null if the value is null/empty.
 */
function textToTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value);
  if (str.includes('T')) return str;
  // SQLite datetime format: "YYYY-MM-DD HH:MM:SS" → append UTC
  return str.replace(' ', 'T') + 'Z';
}

/** Resolve a foreign key: look up old ID in mapping, return new UUID or null. */
function resolveFk(oldId: unknown, mapping: IdMapping): string | null {
  if (oldId === null || oldId === undefined || oldId === '') return null;
  const key = String(oldId);
  return mapping.get(key) ?? null;
}

// ─── Table Migration Configs ─────────────────────────────────────────────────

function buildTableConfigs(): TableMigrationConfig[] {
  // Order matters: parent tables first, then child tables
  return [
    // 1. users
    {
      table: 'users',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'username', source: 'direct', sqliteCol: 'username' },
        { pgCol: 'password_hash', source: 'direct', sqliteCol: 'password_hash' },
        { pgCol: 'role', source: 'generate', transform: () => 'admin' },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'updated_at', source: 'transform', sqliteCol: 'updated_at', transform: (v) => textToTimestamp(v) },
      ],
    },
    // 2. devices
    {
      table: 'devices',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'name', source: 'direct', sqliteCol: 'name' },
        { pgCol: 'host', source: 'direct', sqliteCol: 'host' },
        { pgCol: 'port', source: 'direct', sqliteCol: 'port' },
        { pgCol: 'driver_type', source: 'generate', transform: () => 'api' },
        {
          pgCol: 'credentials',
          source: 'transform',
          transform: (_v, row) => JSON.stringify({
            username: row.username ?? '',
            password_encrypted: row.password_encrypted ?? '',
            use_tls: intToBool(row.use_tls),
          }),
        },
        { pgCol: 'status', source: 'direct', sqliteCol: 'status' },
        { pgCol: 'health_score', source: 'generate', transform: () => 0 },
        {
          pgCol: 'metadata',
          source: 'transform',
          transform: (_v, row) => JSON.stringify({
            group_name: row.group_name ?? null,
            tags: safeParseJson(row.tags, []),
            error_message: row.error_message ?? null,
            last_seen: row.last_seen ?? null,
          }),
        },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'updated_at', source: 'transform', sqliteCol: 'updated_at', transform: (v) => textToTimestamp(v) },
      ],
      fkDependencies: ['users'],
    },
    // 3. alert_rules
    {
      table: 'alert_rules',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'name', source: 'direct', sqliteCol: 'name' },
        {
          pgCol: 'description',
          source: 'transform',
          transform: (_v, row) => {
            const m = row.metric ?? '';
            const o = row.operator ?? '';
            const t = row.threshold ?? 0;
            return String(m) + ' ' + String(o) + ' ' + String(t);
          },
        },
        {
          pgCol: 'condition',
          source: 'transform',
          transform: (_v, row) => JSON.stringify({
            metric: row.metric ?? '',
            operator: row.operator ?? '',
            threshold: row.threshold ?? 0,
            config: safeParseJson(row.config, {}),
          }),
        },
        { pgCol: 'severity', source: 'direct', sqliteCol: 'severity' },
        { pgCol: 'enabled', source: 'transform', sqliteCol: 'enabled', transform: (v) => intToBool(v) },
        { pgCol: 'cooldown_seconds', source: 'generate', transform: () => 300 },
        {
          pgCol: 'device_filter',
          source: 'transform',
          transform: (_v, row, mappings) => {
            const deviceId = resolveFk(row.device_id, mappings.devices);
            return deviceId ? JSON.stringify({ device_ids: [deviceId] }) : null;
          },
        },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'updated_at', source: 'transform', sqliteCol: 'updated_at', transform: (v) => textToTimestamp(v) },
      ],
      fkDependencies: ['users', 'devices'],
    },
    // 4. alert_events
    {
      table: 'alert_events',
      columns: [
        { pgCol: 'id', source: 'generate' },
        {
          pgCol: 'rule_id',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.rule_id, mappings.alert_rules),
        },
        {
          pgCol: 'device_id',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.device_id, mappings.devices),
        },
        { pgCol: 'severity', source: 'direct', sqliteCol: 'severity' },
        { pgCol: 'status', source: 'direct', sqliteCol: 'status' },
        { pgCol: 'title', source: 'direct', sqliteCol: 'message' },
        {
          pgCol: 'payload',
          source: 'transform',
          transform: (_v, row) => JSON.stringify({
            metric_value: row.metric_value ?? null,
            notify_channels: safeParseJson(row.notify_channels, []),
            auto_response_config: safeParseJson(row.auto_response_config, {}),
          }),
        },
        { pgCol: 'resolved_at', source: 'transform', sqliteCol: 'resolved_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
      ],
      fkDependencies: ['users', 'devices', 'alert_rules'],
    },
    // 5. audit_logs
    {
      table: 'audit_logs',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'actor', source: 'transform', sqliteCol: 'actor', transform: (v) => v ?? 'system' },
        { pgCol: 'action', source: 'direct', sqliteCol: 'action' },
        { pgCol: 'target', source: 'direct', sqliteCol: 'device_id' },
        { pgCol: 'target_type', source: 'generate', transform: () => 'device' },
        {
          pgCol: 'details',
          source: 'transform',
          sqliteCol: 'details',
          transform: (v) => JSON.stringify(safeParseJson(v, {})),
        },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
      ],
    },
    // 6. config_snapshots
    {
      table: 'config_snapshots',
      columns: [
        { pgCol: 'id', source: 'generate' },
        {
          pgCol: 'device_id',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.device_id, mappings.devices),
        },
        { pgCol: 'snapshot_type', source: 'generate', transform: () => 'full' },
        {
          pgCol: 'config_data',
          source: 'transform',
          sqliteCol: 'snapshot_data',
          transform: (v) => JSON.stringify(safeParseJson(v, {})),
        },
        { pgCol: 'description', source: 'direct', sqliteCol: 'description' },
        {
          pgCol: 'created_by',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.tenant_id, mappings.users),
        },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
      ],
      fkDependencies: ['users', 'devices'],
    },
    // 7. chat_sessions
    {
      table: 'chat_sessions',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'title', source: 'direct', sqliteCol: 'title' },
        {
          pgCol: 'user_id',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.tenant_id, mappings.users),
        },
        {
          pgCol: 'device_id',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.device_id, mappings.devices),
        },
        {
          pgCol: 'config',
          source: 'transform',
          sqliteCol: 'config',
          transform: (v, row) => JSON.stringify({
            ...(safeParseJson(v, {}) as Record<string, unknown>),
            provider: row.provider ?? '',
            model: row.model ?? '',
            mode: row.mode ?? 'standard',
          }),
        },
        {
          pgCol: 'message_count',
          source: 'transform',
          sqliteCol: 'collected_count',
          transform: (v) => Number(v) || 0,
        },
        { pgCol: 'is_archived', source: 'generate', transform: () => false },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'updated_at', source: 'transform', sqliteCol: 'updated_at', transform: (v) => textToTimestamp(v) },
      ],
      fkDependencies: ['users', 'devices'],
    },
    // 8. chat_messages — extracted from chat_sessions.messages JSON array
    {
      table: 'chat_messages',
      columns: [], // Special handling in migrateChatMessages()
      fkDependencies: ['chat_sessions'],
    },
    // 9. prompt_templates
    {
      table: 'prompt_templates',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'name', source: 'direct', sqliteCol: 'name' },
        { pgCol: 'description', source: 'direct', sqliteCol: 'description' },
        { pgCol: 'category', source: 'transform', sqliteCol: 'category', transform: (v) => v ?? 'general' },
        { pgCol: 'template', source: 'direct', sqliteCol: 'content' },
        { pgCol: 'variables', source: 'generate', transform: () => JSON.stringify([]) },
        { pgCol: 'device_types', source: 'generate', transform: () => JSON.stringify([]) },
        { pgCol: 'version', source: 'generate', transform: () => 1 },
        { pgCol: 'is_active', source: 'generate', transform: () => true },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'updated_at', source: 'transform', sqliteCol: 'updated_at', transform: (v) => textToTimestamp(v) },
      ],
    },
    // 10. monitoring_snapshots — from health_metrics
    {
      table: 'monitoring_snapshots',
      columns: [
        { pgCol: 'id', source: 'generate' },
        {
          pgCol: 'device_id',
          source: 'transform',
          transform: (_v, row, mappings) => resolveFk(row.device_id, mappings.devices),
        },
        { pgCol: 'metric', source: 'direct', sqliteCol: 'metric_name' },
        { pgCol: 'value', source: 'direct', sqliteCol: 'metric_value' },
        { pgCol: 'metadata', source: 'generate', transform: () => JSON.stringify({}) },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'collected_at', transform: (v) => textToTimestamp(v) },
      ],
      fkDependencies: ['devices'],
    },
    // 11. vector_documents
    {
      table: 'vector_documents',
      columns: [
        { pgCol: 'id', source: 'generate' },
        { pgCol: 'collection', source: 'direct', sqliteCol: 'collection' },
        { pgCol: 'content', source: 'direct', sqliteCol: 'content' },
        {
          pgCol: 'metadata',
          source: 'transform',
          sqliteCol: 'metadata',
          transform: (v) => JSON.stringify(safeParseJson(v, {})),
        },
        { pgCol: 'created_at', source: 'transform', sqliteCol: 'created_at', transform: (v) => textToTimestamp(v) },
        { pgCol: 'updated_at', source: 'transform', sqliteCol: 'updated_at', transform: (v) => textToTimestamp(v) },
      ],
    },
    // 12. api_configs — no direct SQLite equivalent
    {
      table: 'api_configs',
      columns: [],
    },
  ];
}

// ─── Core Migration Logic ────────────────────────────────────────────────────

/** Columns with NOT NULL FK constraints — rows with null values for these must be skipped */
const NOT_NULL_FK_COLUMNS: Record<string, string[]> = {
  config_snapshots: ['device_id'],
  monitoring_snapshots: ['device_id'],
  chat_messages: ['session_id'],
};

export class SqliteToPgMigrator {
  private sqliteDb: DatabaseType;
  private pgPool: Pool;
  private idMappings: TableIdMappings;
  private report: MigrationReport;

  constructor(sqlitePath: string, pgPool: Pool) {
    if (!fs.existsSync(sqlitePath)) {
      throw new Error('SQLite 数据库文件不存在: ' + sqlitePath);
    }
    this.sqliteDb = new Database(sqlitePath, { readonly: true });
    this.pgPool = pgPool;
    this.idMappings = {
      users: new Map(),
      devices: new Map(),
      alert_rules: new Map(),
      alert_events: new Map(),
      chat_sessions: new Map(),
    };
    this.report = {
      success: false,
      tables: [],
      totalRecords: 0,
      totalMigrated: 0,
      errors: [],
      duration: 0,
    };
  }

  /** Execute the full migration */
  async migrate(): Promise<MigrationReport> {
    const startTime = Date.now();
    log('═══════════════════════════════════════════════════');
    log('  SQLite → PostgreSQL 数据迁移开始');
    log('═══════════════════════════════════════════════════');

    try {
      const configs = buildTableConfigs();

      for (const config of configs) {
        try {
          await this.migrateTable(config);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logError('表 ' + config.table + ' 迁移失败: ' + msg);
          this.report.errors.push(config.table + ': ' + msg);
        }
      }

      // Verification phase
      log('');
      log('── 校验阶段 ──────────────────────────────────────');
      await this.verify();

      this.report.success = this.report.errors.length === 0;
      this.report.duration = Date.now() - startTime;

      log('');
      log('═══════════════════════════════════════════════════');
      log('  迁移' + (this.report.success ? '成功' : '完成（有错误）'));
      log('  总记录: ' + this.report.totalRecords + ', 已迁移: ' + this.report.totalMigrated);
      log('  耗时: ' + this.report.duration + 'ms');
      if (this.report.errors.length > 0) {
        log('  错误数: ' + this.report.errors.length);
        for (const err of this.report.errors) {
          logError('  - ' + err);
        }
      }
      log('═══════════════════════════════════════════════════');

      return this.report;
    } finally {
      this.sqliteDb.close();
    }
  }

  private sqliteTableExists(table: string): boolean {
    const row = this.sqliteDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table) as { name: string } | undefined;
    return !!row;
  }

  private async pgTableHasData(table: string): Promise<boolean> {
    const client = await this.pgPool.connect();
    try {
      const result = await client.query(
        'SELECT EXISTS(SELECT 1 FROM ' + table + ' LIMIT 1) AS has_data',
      );
      return result.rows[0]?.has_data === true;
    } finally {
      client.release();
    }
  }

  private async pgCount(table: string): Promise<number> {
    const result = await this.pgPool.query('SELECT COUNT(*) AS cnt FROM ' + table);
    return parseInt(result.rows[0].cnt, 10);
  }

  /** Migrate a single table */
  private async migrateTable(config: TableMigrationConfig): Promise<void> {
    const { table } = config;

    // Special case: chat_messages are extracted from chat_sessions
    if (table === 'chat_messages') {
      await this.migrateChatMessages();
      return;
    }

    // Special case: api_configs has no SQLite source
    if (table === 'api_configs') {
      log('[api_configs] 无 SQLite 源表，跳过');
      this.report.tables.push({
        table: 'api_configs', sqliteCount: 0, pgCount: 0, migrated: 0, skipped: 0, errors: [],
      });
      return;
    }

    // monitoring_snapshots comes from health_metrics in SQLite
    const sqliteTable = table === 'monitoring_snapshots' ? 'health_metrics' : table;

    if (!this.sqliteTableExists(sqliteTable)) {
      log('[' + table + '] SQLite 表 ' + sqliteTable + ' 不存在，跳过');
      this.report.tables.push({
        table, sqliteCount: 0, pgCount: 0, migrated: 0, skipped: 0, errors: [],
      });
      return;
    }

    // Idempotency check
    const hasData = await this.pgTableHasData(table);
    if (hasData) {
      const pgCnt = await this.pgCount(table);
      log('[' + table + '] PostgreSQL 已有 ' + pgCnt + ' 条数据，跳过（幂等）');
      this.report.tables.push({
        table, sqliteCount: 0, pgCount: pgCnt, migrated: 0, skipped: pgCnt, errors: [],
      });
      return;
    }

    // Read all rows from SQLite
    const rows = this.sqliteDb.prepare('SELECT * FROM ' + sqliteTable).all() as Record<string, unknown>[];
    const sqliteCount = rows.length;
    log('[' + table + '] SQLite 读取 ' + sqliteCount + ' 条记录');

    if (sqliteCount === 0) {
      this.report.tables.push({
        table, sqliteCount: 0, pgCount: 0, migrated: 0, skipped: 0, errors: [],
      });
      return;
    }

    // Build ID mapping for this table
    const tableIdMapping = this.idMappings[table] ?? new Map<string, string>();
    this.idMappings[table] = tableIdMapping;

    // Transform and batch insert
    let migrated = 0;
    let totalSkipped = 0;
    const tableErrors: string[] = [];

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(rows.length / BATCH_SIZE);

      try {
        const skipped = await this.insertBatch(table, config.columns, batch, tableIdMapping);
        migrated += batch.length - skipped;
        totalSkipped += skipped;
        if (totalBatches > 1) {
          log('[' + table + '] 批次 ' + batchNum + '/' + totalBatches + ' 完成 (' + batch.length + ' 条)');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        tableErrors.push('批次 ' + batchNum + ': ' + msg);
        logError('[' + table + '] 批次 ' + batchNum + ' 失败: ' + msg);
      }
    }

    const pgCnt = await this.pgCount(table);
    log('[' + table + '] 迁移完成: SQLite=' + sqliteCount + ', PG=' + pgCnt + ', 已迁移=' + migrated);

    this.report.tables.push({
      table, sqliteCount, pgCount: pgCnt, migrated, skipped: totalSkipped, errors: tableErrors,
    });
    this.report.totalRecords += sqliteCount;
    this.report.totalMigrated += migrated;

    if (tableErrors.length > 0) {
      this.report.errors.push(...tableErrors.map((e) => table + ': ' + e));
    }
  }

  /**
   * Insert a batch of transformed rows into PostgreSQL.
   * Returns the number of skipped rows (due to NOT NULL FK constraints).
   */
  private async insertBatch(
    table: string,
    columns: ColumnMapping[],
    rows: Record<string, unknown>[],
    idMapping: IdMapping,
  ): Promise<number> {
    const client = await this.pgPool.connect();
    const notNullCols = NOT_NULL_FK_COLUMNS[table] ?? [];
    let skipped = 0;

    try {
      await client.query('BEGIN');

      for (const row of rows) {
        const pgValues: unknown[] = [];
        const pgCols: string[] = [];
        let newId: string | null = null;
        let skipRow = false;

        for (const col of columns) {
          let value: unknown;

          if (col.pgCol === 'id' && col.source === 'generate') {
            newId = uuidv4();
            value = newId;
          } else if (col.transform) {
            const sourceVal = col.sqliteCol ? row[col.sqliteCol] : undefined;
            value = col.transform(sourceVal, row, this.idMappings);
          } else if (col.source === 'direct' && col.sqliteCol) {
            value = row[col.sqliteCol] ?? null;
          } else {
            value = null;
          }

          // Check NOT NULL FK constraint
          if (notNullCols.includes(col.pgCol) && (value === null || value === undefined)) {
            skipRow = true;
            break;
          }

          pgCols.push(col.pgCol);
          pgValues.push(value);
        }

        if (skipRow) {
          skipped++;
          continue;
        }

        // Store ID mapping: old SQLite id → new PG UUID
        if (newId && row.id !== undefined) {
          idMapping.set(String(row.id), newId);
        }

        const placeholders = pgCols.map(function (_c, idx) {
          return '$' + (idx + 1);
        }).join(', ');
        const sql = 'INSERT INTO ' + table + ' (' + pgCols.join(', ') + ') VALUES (' + placeholders + ')';
        await client.query(sql, pgValues);
      }

      await client.query('COMMIT');

      if (skipped > 0) {
        log('[' + table + '] 跳过 ' + skipped + ' 条记录（NOT NULL FK 约束）');
      }

      return skipped;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Special migration for chat_messages: extract from chat_sessions.messages JSON
   */
  private async migrateChatMessages(): Promise<void> {
    const table = 'chat_messages';

    // Idempotency check
    const hasData = await this.pgTableHasData(table);
    if (hasData) {
      const pgCnt = await this.pgCount(table);
      log('[chat_messages] PostgreSQL 已有 ' + pgCnt + ' 条数据，跳过（幂等）');
      this.report.tables.push({
        table, sqliteCount: 0, pgCount: pgCnt, migrated: 0, skipped: pgCnt, errors: [],
      });
      return;
    }

    if (!this.sqliteTableExists('chat_sessions')) {
      log('[chat_messages] SQLite 表 chat_sessions 不存在，跳过');
      this.report.tables.push({
        table, sqliteCount: 0, pgCount: 0, migrated: 0, skipped: 0, errors: [],
      });
      return;
    }

    // Read chat_sessions with messages
    const sessions = this.sqliteDb.prepare(
      'SELECT id, messages FROM chat_sessions WHERE messages IS NOT NULL',
    ).all() as Array<{ id: string; messages: string }>;

    let totalMessages = 0;
    let migrated = 0;
    const tableErrors: string[] = [];
    const messageBatch: Array<{
      sessionId: string;
      role: string;
      content: string;
      metadata: string;
      isFavorited: boolean;
      createdAt: string;
    }> = [];

    for (const session of sessions) {
      const pgSessionId = this.idMappings.chat_sessions.get(String(session.id));
      if (!pgSessionId) continue;

      const messages = safeParseJson(session.messages, []) as Array<Record<string, unknown>>;
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        totalMessages++;
        messageBatch.push({
          sessionId: pgSessionId,
          role: String(msg.role ?? 'user'),
          content: String(msg.content ?? ''),
          metadata: JSON.stringify({
            timestamp: msg.timestamp ?? null,
            model: msg.model ?? null,
            provider: msg.provider ?? null,
          }),
          isFavorited: intToBool(msg.is_favorited),
          createdAt: textToTimestamp(msg.timestamp) ?? new Date().toISOString(),
        });
      }
    }

    log('[chat_messages] 从 chat_sessions 提取 ' + totalMessages + ' 条消息');

    // Batch insert messages
    for (let i = 0; i < messageBatch.length; i += BATCH_SIZE) {
      const batch = messageBatch.slice(i, i + BATCH_SIZE);
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        for (const msg of batch) {
          await client.query(
            'INSERT INTO chat_messages (id, session_id, role, content, metadata, is_favorited, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [uuidv4(), msg.sessionId, msg.role, msg.content, msg.metadata, msg.isFavorited, msg.createdAt],
          );
        }
        await client.query('COMMIT');
        migrated += batch.length;
      } catch (error) {
        await client.query('ROLLBACK');
        const errMsg = error instanceof Error ? error.message : String(error);
        tableErrors.push(errMsg);
        logError('[chat_messages] 批次插入失败: ' + errMsg);
      } finally {
        client.release();
      }
    }

    const pgCnt = await this.pgCount(table);
    log('[chat_messages] 迁移完成: 提取=' + totalMessages + ', PG=' + pgCnt + ', 已迁移=' + migrated);

    this.report.tables.push({
      table, sqliteCount: totalMessages, pgCount: pgCnt, migrated, skipped: 0, errors: tableErrors,
    });
    this.report.totalRecords += totalMessages;
    this.report.totalMigrated += migrated;

    if (tableErrors.length > 0) {
      this.report.errors.push(...tableErrors.map((e) => 'chat_messages: ' + e));
    }
  }

  /** Verify migration: compare record counts and key fields */
  private async verify(): Promise<void> {
    for (const tableReport of this.report.tables) {
      const { table, sqliteCount, pgCount, skipped } = tableReport;

      // Skip tables that were already populated (idempotent skip)
      if (skipped > 0 && sqliteCount === 0) continue;
      // Skip tables with no source data
      if (sqliteCount === 0 && pgCount === 0) continue;

      // Account for rows skipped due to NOT NULL FK constraints
      const expectedCount = sqliteCount - (tableReport.skipped || 0);
      if (expectedCount !== pgCount) {
        const msg = '[校验] ' + table + ': 记录数不匹配 期望=' + expectedCount + ' vs PG=' + pgCount;
        logError(msg);
        this.report.errors.push(msg);
      } else {
        log('[校验] ' + table + ': ✓ 记录数一致 (' + pgCount + ')');
      }
    }

    // Verify key fields for critical tables
    await this.verifyKeyFields('users', 'username');
    await this.verifyKeyFields('devices', 'name');
    await this.verifyKeyFields('prompt_templates', 'name');
  }

  /** Verify that key field values in PG match those in SQLite */
  private async verifyKeyFields(pgTable: string, keyField: string): Promise<void> {
    const sqliteTable = pgTable;
    if (!this.sqliteTableExists(sqliteTable)) return;

    const sqliteValues = this.sqliteDb.prepare(
      'SELECT ' + keyField + ' FROM ' + sqliteTable + ' ORDER BY ' + keyField,
    ).all() as Array<Record<string, unknown>>;

    const pgResult = await this.pgPool.query(
      'SELECT ' + keyField + ' FROM ' + pgTable + ' ORDER BY ' + keyField,
    );

    const sqliteSet = new Set(sqliteValues.map((r) => String(r[keyField])));
    const pgSet = new Set(pgResult.rows.map((r: Record<string, unknown>) => String(r[keyField])));

    let missing = 0;
    for (const val of sqliteSet) {
      if (!pgSet.has(val)) {
        missing++;
      }
    }

    if (missing > 0) {
      const msg = '[校验] ' + pgTable + '.' + keyField + ': ' + missing + ' 个值在 PG 中缺失';
      logError(msg);
      this.report.errors.push(msg);
    } else if (sqliteSet.size > 0) {
      log('[校验] ' + pgTable + '.' + keyField + ': ✓ 关键字段一致 (' + sqliteSet.size + ' 个值)');
    }
  }
}

// ─── Standalone Entry Point ──────────────────────────────────────────────────

async function main(): Promise<void> {
  // Resolve SQLite path
  const sqlitePath = process.env.SQLITE_DB_PATH
    ?? path.join(process.cwd(), 'data', 'routeros.db');

  // Resolve PostgreSQL connection
  const pgHost = process.env.PG_HOST ?? 'localhost';
  const pgPort = process.env.PG_PORT ?? '5432';
  const pgUser = process.env.PG_USER ?? 'opsevo';
  const pgPassword = process.env.PG_PASSWORD ?? '';
  const pgDb = process.env.PG_DB ?? 'opsevo';
  const pgConnectionString = process.env.DATABASE_URL
    ?? ('postgresql://' + pgUser + ':' + pgPassword + '@' + pgHost + ':' + pgPort + '/' + pgDb);

  log('SQLite 路径: ' + sqlitePath);
  log('PostgreSQL: ' + pgConnectionString.replace(/:[^:@]+@/, ':***@'));

  if (!fs.existsSync(sqlitePath)) {
    logError('SQLite 数据库文件不存在: ' + sqlitePath);
    process.exit(1);
  }

  const pgPool = new Pool({ connectionString: pgConnectionString });

  try {
    // Verify PG connection
    await pgPool.query('SELECT 1');
    log('PostgreSQL 连接成功');

    const migrator = new SqliteToPgMigrator(sqlitePath, pgPool);
    const report = await migrator.migrate();

    process.exit(report.success ? 0 : 1);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError('迁移失败: ' + msg);
    process.exit(1);
  } finally {
    await pgPool.end();
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}
