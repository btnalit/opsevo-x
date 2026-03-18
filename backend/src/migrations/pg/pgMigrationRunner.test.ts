/**
 * Tests for PostgreSQL Migration Runner and 001_core_tables migration
 *
 * Validates:
 * - Migration runner creates schema_migrations table
 * - Migration runner tracks applied versions and skips them
 * - Migration runner applies pending migrations in order
 * - Migration runner handles errors gracefully
 * - 001_core_tables exports valid PgMigrationDefinition
 * - 001_core_tables up SQL contains all 12 tables
 * - 001_core_tables up SQL contains all required indexes
 * - 001_core_tables down SQL drops all tables
 *
 * Requirements: C1.3, C1.5
 */

import {
  runPgMigrations,
  ensureMigrationsTable,
  getAppliedVersions,
  loadMigrations,
} from './pgMigrationRunner';
import type { PgMigrationDefinition } from './pgMigrationRunner';
import type { DataStore, DataStoreTransaction } from '../../services/dataStore';
import migration001 from './001_core_tables';
import * as path from 'path';

// ─── Mock DataStore ──────────────────────────────────────────────────────────

function createMockDataStore(options?: {
  appliedVersions?: number[];
  executeError?: Error;
  transactionError?: Error;
}): DataStore {
  const appliedVersions = options?.appliedVersions ?? [];

  const mockTx: DataStoreTransaction = {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: options?.transactionError
      ? jest.fn().mockRejectedValue(options.transactionError)
      : jest.fn().mockResolvedValue({ rowCount: 1 }),
  };

  return {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return Promise.resolve(
          appliedVersions.map((v) => ({ version: v })),
        );
      }
      return Promise.resolve([]);
    }),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: options?.executeError
      ? jest.fn().mockRejectedValue(options.executeError)
      : jest.fn().mockResolvedValue({ rowCount: 1 }),
    transaction: jest.fn().mockImplementation(
      async (fn: (tx: DataStoreTransaction) => Promise<unknown>) => {
        return fn(mockTx);
      },
    ),
    getPool: jest.fn().mockReturnValue({}),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as DataStore;
}

// ─── Migration Definition Tests ──────────────────────────────────────────────

describe('001_core_tables migration definition', () => {
  it('should export a valid PgMigrationDefinition', () => {
    expect(migration001).toBeDefined();
    expect(migration001.version).toBe(1);
    expect(migration001.description).toBe('12 张核心业务表 (PostgreSQL)');
    expect(typeof migration001.up).toBe('string');
    expect(typeof migration001.down).toBe('string');
    expect(migration001.up.length).toBeGreaterThan(0);
    expect(migration001.down.length).toBeGreaterThan(0);
  });

  it('should contain CREATE TABLE for all 12 core tables', () => {
    const expectedTables = [
      'users',
      'devices',
      'alert_rules',
      'alert_events',
      'audit_logs',
      'config_snapshots',
      'chat_sessions',
      'chat_messages',
      'prompt_templates',
      'monitoring_snapshots',
      'vector_documents',
      'api_configs',
    ];

    for (const table of expectedTables) {
      expect(migration001.up).toContain(`CREATE TABLE ${table}`);
    }
  });

  it('should use UUID primary keys with gen_random_uuid()', () => {
    const tables = [
      'users', 'devices', 'alert_rules', 'alert_events',
      'audit_logs', 'config_snapshots', 'chat_sessions',
      'chat_messages', 'prompt_templates', 'monitoring_snapshots',
      'vector_documents', 'api_configs',
    ];

    for (const table of tables) {
      // Each table should have UUID PRIMARY KEY DEFAULT gen_random_uuid()
      const tableRegex = new RegExp(
        `CREATE TABLE ${table}[\\s\\S]*?id UUID PRIMARY KEY DEFAULT gen_random_uuid\\(\\)`,
      );
      expect(migration001.up).toMatch(tableRegex);
    }
  });

  it('should use TIMESTAMPTZ for timestamp columns', () => {
    // Should not contain TEXT DEFAULT (datetime('now')) — that's SQLite syntax
    expect(migration001.up).not.toContain("datetime('now')");
    // Should use TIMESTAMPTZ
    expect(migration001.up).toContain('TIMESTAMPTZ');
  });

  it('should use JSONB for JSON columns', () => {
    expect(migration001.up).toContain('JSONB');
    // Every DEFAULT '{}' or DEFAULT '[]' should be on a JSONB column line
    const lines = migration001.up.split('\n');
    for (const line of lines) {
      if (line.includes("DEFAULT '{}'") || line.includes("DEFAULT '[]'")) {
        expect(line).toContain('JSONB');
      }
    }
  });

  it('should create GIN indexes on JSONB columns', () => {
    const expectedGinIndexes = [
      'idx_devices_credentials_gin',
      'idx_devices_metadata_gin',
      'idx_alert_rules_condition_gin',
      'idx_alert_events_payload_gin',
      'idx_audit_logs_details_gin',
      'idx_config_snapshots_config_data_gin',
      'idx_chat_sessions_config_gin',
      'idx_chat_messages_metadata_gin',
      'idx_prompt_templates_variables_gin',
      'idx_monitoring_snapshots_metadata_gin',
      'idx_vector_docs_metadata_gin',
      'idx_api_configs_config_gin',
    ];

    for (const idx of expectedGinIndexes) {
      expect(migration001.up).toContain(idx);
      expect(migration001.up).toContain('USING GIN');
    }
  });

  it('should create standard B-tree indexes', () => {
    const expectedIndexes = [
      'idx_devices_driver_type',
      'idx_devices_status',
      'idx_alert_rules_enabled',
      'idx_alert_rules_severity',
      'idx_alert_events_status',
      'idx_alert_events_severity',
      'idx_alert_events_device',
      'idx_alert_events_fingerprint',
      'idx_alert_events_created',
      'idx_audit_logs_actor',
      'idx_audit_logs_action',
      'idx_audit_logs_created',
      'idx_config_snapshots_device',
      'idx_config_snapshots_created',
      'idx_chat_sessions_user',
      'idx_chat_sessions_updated',
      'idx_chat_messages_session',
      'idx_chat_messages_favorited',
      'idx_chat_messages_created',
      'idx_prompt_templates_category',
      'idx_monitoring_device_metric',
      'idx_monitoring_created',
      'idx_vector_docs_collection',
      'idx_api_configs_provider',
    ];

    for (const idx of expectedIndexes) {
      expect(migration001.up).toContain(idx);
    }
  });

  it('should have proper foreign key references', () => {
    // devices → no FK to users (design doc removed tenant_id)
    expect(migration001.up).toContain('REFERENCES alert_rules(id)');
    expect(migration001.up).toContain('REFERENCES devices(id)');
    expect(migration001.up).toContain('REFERENCES users(id)');
    expect(migration001.up).toContain('ON DELETE CASCADE');
  });

  it('should drop all 12 tables in down SQL', () => {
    const expectedDrops = [
      'DROP TABLE IF EXISTS api_configs',
      'DROP TABLE IF EXISTS vector_documents',
      'DROP TABLE IF EXISTS monitoring_snapshots',
      'DROP TABLE IF EXISTS prompt_templates',
      'DROP TABLE IF EXISTS chat_messages',
      'DROP TABLE IF EXISTS chat_sessions',
      'DROP TABLE IF EXISTS config_snapshots',
      'DROP TABLE IF EXISTS audit_logs',
      'DROP TABLE IF EXISTS alert_events',
      'DROP TABLE IF EXISTS alert_rules',
      'DROP TABLE IF EXISTS devices',
      'DROP TABLE IF EXISTS users',
    ];

    for (const drop of expectedDrops) {
      expect(migration001.down).toContain(drop);
    }
  });

  it('should enable pgcrypto extension', () => {
    expect(migration001.up).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  });

  it('should create partial index on chat_messages.is_favorited', () => {
    expect(migration001.up).toContain('WHERE is_favorited = true');
  });
});

// ─── Migration Runner Tests ──────────────────────────────────────────────────

describe('ensureMigrationsTable', () => {
  it('should execute CREATE TABLE IF NOT EXISTS for schema_migrations', async () => {
    const ds = createMockDataStore();
    await ensureMigrationsTable(ds);

    expect(ds.execute).toHaveBeenCalledTimes(1);
    const sql = (ds.execute as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(sql).toContain('version INTEGER PRIMARY KEY');
    expect(sql).toContain('applied_at TIMESTAMPTZ');
  });
});

describe('getAppliedVersions', () => {
  it('should return empty set when no migrations applied', async () => {
    const ds = createMockDataStore({ appliedVersions: [] });
    const versions = await getAppliedVersions(ds);
    expect(versions.size).toBe(0);
  });

  it('should return set of applied version numbers', async () => {
    const ds = createMockDataStore({ appliedVersions: [1, 2, 3] });
    const versions = await getAppliedVersions(ds);
    expect(versions.size).toBe(3);
    expect(versions.has(1)).toBe(true);
    expect(versions.has(2)).toBe(true);
    expect(versions.has(3)).toBe(true);
    expect(versions.has(4)).toBe(false);
  });
});

describe('loadMigrations', () => {
  it('should load migration files from the pg directory', async () => {
    const dir = path.join(__dirname);
    const migrations = await loadMigrations(dir);

    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0].version).toBe(1);
    expect(migrations[0].description).toBeTruthy();
    expect(typeof migrations[0].up).toBe('string');
    expect(typeof migrations[0].down).toBe('string');
  });

  it('should return empty array for non-existent directory', async () => {
    const migrations = await loadMigrations('/nonexistent/path');
    expect(migrations).toEqual([]);
  });

  it('should skip files that do not match NNN_ pattern', async () => {
    // The runner file (pgMigrationRunner.ts) should be excluded
    const dir = path.join(__dirname);
    const migrations = await loadMigrations(dir);

    const filenames = migrations.map((m) => m.description);
    // Should not include the runner itself
    for (const desc of filenames) {
      expect(desc).not.toContain('pgMigrationRunner');
    }
  });
});

describe('runPgMigrations', () => {
  it('should apply pending migrations', async () => {
    const ds = createMockDataStore({ appliedVersions: [] });
    const result = await runPgMigrations(ds, path.join(__dirname));

    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBe(0);
    expect(result.total).toBeGreaterThanOrEqual(1);

    // Should have called transaction for each migration
    expect(ds.transaction).toHaveBeenCalled();
  });

  it('should skip already applied migrations', async () => {
    const ds = createMockDataStore({ appliedVersions: [1] });
    const result = await runPgMigrations(ds, path.join(__dirname));

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    // transaction should not be called for skipped migrations
    // (only called for pending ones)
  });

  it('should create schema_migrations table before running', async () => {
    const ds = createMockDataStore();
    await runPgMigrations(ds, path.join(__dirname));

    // First execute call should be CREATE TABLE IF NOT EXISTS schema_migrations
    const firstCall = (ds.execute as jest.Mock).mock.calls[0][0] as string;
    expect(firstCall).toContain('schema_migrations');
  });

  it('should throw on migration execution failure', async () => {
    const ds = createMockDataStore({
      transactionError: new Error('syntax error'),
    });

    await expect(
      runPgMigrations(ds, path.join(__dirname)),
    ).rejects.toThrow('PostgreSQL 迁移 v1 失败');
  });

  it('should return zero applied for empty directory', async () => {
    const ds = createMockDataStore();
    const result = await runPgMigrations(ds, '/nonexistent/path');

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(0);
  });
});
