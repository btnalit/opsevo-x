/**
 * DataStore 单元测试
 *
 * 测试 DataStore 核心功能：
 * - SQLite 初始化与连接管理
 * - query<T>()、run()、transaction() 基础方法
 * - findByTenant()、insertWithTenant() 租户感知方法
 * - runMigrations() 迁移机制
 * - 错误处理（结构化错误，不崩溃进程）
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { DataStore, DataStoreError } from './dataStore';
import * as path from 'path';
import * as fs from 'fs';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** 创建一个内存数据库 DataStore 实例（无迁移文件） */
function createTestStore(migrationsPath?: string): DataStore {
  return new DataStore({
    inMemory: true,
    migrationsPath: migrationsPath ?? path.join(__dirname, '__test_migrations_empty__'),
  });
}

/** 创建临时迁移目录并写入迁移文件 */
function createTempMigrationsDir(migrations: Array<{ filename: string; content: string }>): string {
  const tmpDir = path.join(__dirname, `__test_migrations_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const m of migrations) {
    fs.writeFileSync(path.join(tmpDir, m.filename), m.content);
  }
  return tmpDir;
}

/** 清理临时迁移目录 */
function cleanupTempDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DataStore', () => {
  let store: DataStore;

  afterEach(async () => {
    if (store) {
      await store.close();
    }
  });

  // ─── Initialization ────────────────────────────────────────────────────

  describe('initialize / close', () => {
    it('should initialize an in-memory database successfully', async () => {
      store = createTestStore();
      await store.initialize();
      expect(store.isInitialized()).toBe(true);
    });

    it('should skip duplicate initialization', async () => {
      store = createTestStore();
      await store.initialize();
      // Second call should not throw
      await store.initialize();
      expect(store.isInitialized()).toBe(true);
    });

    it('should close the database and reset state', async () => {
      store = createTestStore();
      await store.initialize();
      await store.close();
      expect(store.isInitialized()).toBe(false);
    });

    it('should enable WAL mode by default', async () => {
      store = createTestStore();
      await store.initialize();
      const db = store.getDatabase();
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      // In-memory databases may report 'memory' for journal_mode
      expect(['wal', 'memory']).toContain(result[0].journal_mode);
    });

    it('should enable foreign keys', async () => {
      store = createTestStore();
      await store.initialize();
      const db = store.getDatabase();
      const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
      expect(result[0].foreign_keys).toBe(1);
    });
  });

  // ─── Core CRUD: query / run ────────────────────────────────────────────

  describe('query / run', () => {
    beforeEach(async () => {
      store = createTestStore();
      await store.initialize();
      store.run('CREATE TABLE test_items (id TEXT PRIMARY KEY, name TEXT, value INTEGER)');
    });

    it('should insert and query a single row', () => {
      store.run('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)', ['1', 'item1', 100]);
      const rows = store.query<{ id: string; name: string; value: number }>(
        'SELECT * FROM test_items WHERE id = ?',
        ['1'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ id: '1', name: 'item1', value: 100 });
    });

    it('should return empty array for no matching rows', () => {
      const rows = store.query('SELECT * FROM test_items WHERE id = ?', ['nonexistent']);
      expect(rows).toEqual([]);
    });

    it('should return RunResult with changes count', () => {
      store.run('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)', ['1', 'item1', 100]);
      const result = store.run('UPDATE test_items SET value = ? WHERE id = ?', [200, '1']);
      expect(result.changes).toBe(1);
    });

    it('should support queries without params', () => {
      store.run('INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)', ['1', 'item1', 100]);
      const rows = store.query<{ id: string }>('SELECT * FROM test_items');
      expect(rows).toHaveLength(1);
    });

    it('should support run without params', () => {
      const result = store.run("INSERT INTO test_items (id, name, value) VALUES ('1', 'item1', 100)");
      expect(result.changes).toBe(1);
    });
  });

  // ─── Transaction ───────────────────────────────────────────────────────

  describe('transaction', () => {
    beforeEach(async () => {
      store = createTestStore();
      await store.initialize();
      store.run('CREATE TABLE tx_test (id TEXT PRIMARY KEY, value INTEGER)');
    });

    it('should commit all operations on success', () => {
      store.transaction(() => {
        store.run('INSERT INTO tx_test (id, value) VALUES (?, ?)', ['a', 1]);
        store.run('INSERT INTO tx_test (id, value) VALUES (?, ?)', ['b', 2]);
      });

      const rows = store.query<{ id: string; value: number }>('SELECT * FROM tx_test ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: 'a', value: 1 });
      expect(rows[1]).toEqual({ id: 'b', value: 2 });
    });

    it('should rollback all operations on failure', () => {
      // Insert a row first
      store.run('INSERT INTO tx_test (id, value) VALUES (?, ?)', ['existing', 0]);

      expect(() => {
        store.transaction(() => {
          store.run('INSERT INTO tx_test (id, value) VALUES (?, ?)', ['c', 3]);
          // This will fail due to PRIMARY KEY constraint
          store.run('INSERT INTO tx_test (id, value) VALUES (?, ?)', ['existing', 99]);
        });
      }).toThrow(DataStoreError);

      // Only the pre-existing row should remain
      const rows = store.query<{ id: string }>('SELECT * FROM tx_test');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('existing');
    });

    it('should return the value from the transaction callback', () => {
      const result = store.transaction(() => {
        store.run('INSERT INTO tx_test (id, value) VALUES (?, ?)', ['x', 42]);
        return 'done';
      });
      expect(result).toBe('done');
    });
  });

  // ─── Tenant-Aware Methods ──────────────────────────────────────────────

  describe('findByTenant / insertWithTenant', () => {
    beforeEach(async () => {
      store = createTestStore();
      await store.initialize();
      store.run(`
        CREATE TABLE tenant_items (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT DEFAULT 'active'
        )
      `);
    });

    it('should insert with tenant_id and retrieve by tenant', () => {
      store.insertWithTenant('tenant_items', 'tenant-1', { id: 'item-1', name: 'Widget' });
      const rows = store.findByTenant<{ id: string; tenant_id: string; name: string }>(
        'tenant_items',
        'tenant-1',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe('tenant-1');
      expect(rows[0].name).toBe('Widget');
    });

    it('should isolate data between tenants', () => {
      store.insertWithTenant('tenant_items', 'tenant-A', { id: 'a1', name: 'A-item' });
      store.insertWithTenant('tenant_items', 'tenant-B', { id: 'b1', name: 'B-item' });

      const rowsA = store.findByTenant<{ id: string }>('tenant_items', 'tenant-A');
      const rowsB = store.findByTenant<{ id: string }>('tenant_items', 'tenant-B');

      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].id).toBe('a1');
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].id).toBe('b1');
    });

    it('should support additional where conditions in findByTenant', () => {
      store.insertWithTenant('tenant_items', 't1', { id: '1', name: 'active-item', status: 'active' });
      store.insertWithTenant('tenant_items', 't1', { id: '2', name: 'inactive-item', status: 'inactive' });

      const rows = store.findByTenant<{ id: string }>(
        'tenant_items',
        't1',
        { status: 'active' },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('1');
    });

    it('should return empty array when tenant has no data', () => {
      const rows = store.findByTenant('tenant_items', 'nonexistent-tenant');
      expect(rows).toEqual([]);
    });
  });

  // ─── Migration Mechanism ───────────────────────────────────────────────

  describe('runMigrations', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) {
        cleanupTempDir(tmpDir);
      }
    });

    it('should apply migrations in version order', async () => {
      tmpDir = createTempMigrationsDir([
        {
          filename: '001_create_users.js',
          content: `module.exports = {
            version: 1,
            up: "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);",
            down: "DROP TABLE users;"
          };`,
        },
        {
          filename: '002_create_devices.js',
          content: `module.exports = {
            version: 2,
            up: "CREATE TABLE devices (id TEXT PRIMARY KEY, host TEXT);",
            down: "DROP TABLE devices;"
          };`,
        },
      ]);

      store = new DataStore({ inMemory: true, migrationsPath: tmpDir });
      await store.initialize();

      // Both tables should exist
      const users = store.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
      const devices = store.query("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'");
      expect(users).toHaveLength(1);
      expect(devices).toHaveLength(1);
    });

    it('should be idempotent - running twice should not fail', async () => {
      tmpDir = createTempMigrationsDir([
        {
          filename: '001_create_test.js',
          content: `module.exports = {
            version: 1,
            up: "CREATE TABLE idempotent_test (id TEXT PRIMARY KEY);",
            down: "DROP TABLE idempotent_test;"
          };`,
        },
      ]);

      store = new DataStore({ inMemory: true, migrationsPath: tmpDir });
      await store.initialize();

      // Run migrations again manually - should not throw
      await store.runMigrations();

      const tables = store.query("SELECT name FROM sqlite_master WHERE type='table' AND name='idempotent_test'");
      expect(tables).toHaveLength(1);
    });

    it('should track applied migrations in schema_migrations table', async () => {
      tmpDir = createTempMigrationsDir([
        {
          filename: '001_first.js',
          content: `module.exports = {
            version: 1,
            up: "CREATE TABLE first_table (id TEXT);",
            down: "DROP TABLE first_table;"
          };`,
        },
      ]);

      store = new DataStore({ inMemory: true, migrationsPath: tmpDir });
      await store.initialize();

      const applied = store.query<{ version: number }>('SELECT version FROM schema_migrations');
      expect(applied).toHaveLength(1);
      expect(applied[0].version).toBe(1);
    });

    it('should handle missing migrations directory gracefully', async () => {
      store = new DataStore({
        inMemory: true,
        migrationsPath: path.join(__dirname, 'nonexistent_dir_12345'),
      });
      // Should not throw
      await store.initialize();
      expect(store.isInitialized()).toBe(true);
    });

    it('should skip files with invalid format', async () => {
      tmpDir = createTempMigrationsDir([
        {
          filename: '001_valid.js',
          content: `module.exports = {
            version: 1,
            up: "CREATE TABLE valid_table (id TEXT);",
            down: "DROP TABLE valid_table;"
          };`,
        },
        {
          filename: '002_invalid.js',
          content: `module.exports = { version: 2, up: 123, down: "DROP TABLE x;" };`,
        },
      ]);

      store = new DataStore({ inMemory: true, migrationsPath: tmpDir });
      await store.initialize();

      // Only the valid migration should be applied
      const tables = store.query("SELECT name FROM sqlite_master WHERE type='table' AND name='valid_table'");
      expect(tables).toHaveLength(1);
    });
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    beforeEach(async () => {
      store = createTestStore();
      await store.initialize();
    });

    it('should throw DataStoreError for invalid SQL in query', () => {
      expect(() => {
        store.query('SELECT * FROM nonexistent_table');
      }).toThrow(DataStoreError);
    });

    it('should throw DataStoreError for invalid SQL in run', () => {
      expect(() => {
        store.run('INSERT INTO nonexistent_table (id) VALUES (?)' , ['1']);
      }).toThrow(DataStoreError);
    });

    it('should include operation context in DataStoreError', () => {
      try {
        store.query('SELECT * FROM nonexistent_table');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DataStoreError);
        const dsError = error as DataStoreError;
        expect(dsError.operation).toBe('query');
        expect(dsError.sql).toBe('SELECT * FROM nonexistent_table');
        expect(dsError.cause).toBeDefined();
      }
    });

    it('should throw DataStoreError when not initialized', () => {
      const uninitStore = createTestStore();
      expect(() => {
        uninitStore.query('SELECT 1');
      }).toThrow(DataStoreError);
    });

    it('should throw DataStoreError for invalid table names', async () => {
      expect(() => {
        store.findByTenant('invalid-table-name!', 'tenant-1');
      }).toThrow(DataStoreError);
    });

    it('should throw DataStoreError for invalid column names', async () => {
      store.run('CREATE TABLE safe_table (id TEXT PRIMARY KEY, tenant_id TEXT)');
      expect(() => {
        store.findByTenant('safe_table', 'tenant-1', { 'bad column!': 'value' });
      }).toThrow(DataStoreError);
    });

    it('should throw DataStoreError for constraint violations', () => {
      store.run('CREATE TABLE unique_test (id TEXT PRIMARY KEY)');
      store.run('INSERT INTO unique_test (id) VALUES (?)', ['dup']);
      expect(() => {
        store.run('INSERT INTO unique_test (id) VALUES (?)', ['dup']);
      }).toThrow(DataStoreError);
    });

    it('should not crash the process on errors', () => {
      // This test verifies that errors are caught and wrapped,
      // not thrown as unhandled exceptions
      let errorCaught = false;
      try {
        store.query('INVALID SQL STATEMENT !!!');
      } catch (error) {
        errorCaught = true;
        expect(error).toBeInstanceOf(DataStoreError);
      }
      expect(errorCaught).toBe(true);
      // Store should still be usable after error
      const result = store.query<{ result: number }>('SELECT 1 as result');
      expect(result[0].result).toBe(1);
    });
  });
});
