/**
 * PgDataStore 单元测试
 *
 * 通过 mock pg.Pool 测试 PgDataStore 的核心逻辑：
 * - query / queryOne / execute 方法
 * - transaction 的 BEGIN/COMMIT/ROLLBACK 流程
 * - healthCheck 成功与失败
 * - close 连接池
 * - 连接池错误处理
 *
 * Requirements: C1.2, C1.4, I6.17
 */

import { PgDataStore } from './pgDataStore';

// ─── Mock pg module ──────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();
const mockOn = jest.fn();

jest.mock('pg', () => {
  return {
    Pool: jest.fn().mockImplementation(() => ({
      query: mockQuery,
      connect: mockConnect,
      end: mockEnd,
      on: mockOn,
    })),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createStore(overrides?: Partial<{ min: number; max: number; idleTimeoutMillis: number }>) {
  return new PgDataStore({
    connectionString: 'postgresql://test:test@localhost:5432/testdb',
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PgDataStore', () => {
  let store: PgDataStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = createStore();
  });

  // ─── Constructor ─────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should register a pool error handler', () => {
      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should use env var defaults when config values not provided', () => {
      const { Pool } = require('pg');
      createStore();
      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: 'postgresql://test:test@localhost:5432/testdb',
        }),
      );
    });

    it('should use explicit config values over env defaults', () => {
      const { Pool } = require('pg');
      createStore({ min: 5, max: 20, idleTimeoutMillis: 60000 });
      expect(Pool).toHaveBeenCalledWith(
        expect.objectContaining({
          min: 5,
          max: 20,
          idleTimeoutMillis: 60000,
        }),
      );
    });
  });

  // ─── query ───────────────────────────────────────────────────────────────

  describe('query', () => {
    it('should return rows from pool.query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] });
      const result = await store.query<{ id: number; name: string }>('SELECT * FROM items');
      expect(result).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM items', undefined);
    });

    it('should pass params to pool.query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      await store.query('SELECT * FROM items WHERE id = $1', [1]);
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM items WHERE id = $1', [1]);
    });

    it('should return empty array when no rows match', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await store.query('SELECT * FROM items WHERE id = $1', [999]);
      expect(result).toEqual([]);
    });

    it('should throw on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation does not exist'));
      await expect(store.query('SELECT * FROM bad_table')).rejects.toThrow('relation does not exist');
    });
  });

  // ─── queryOne ────────────────────────────────────────────────────────────

  describe('queryOne', () => {
    it('should return first row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, name: 'first' }] });
      const result = await store.queryOne<{ id: number; name: string }>('SELECT * FROM items LIMIT 1');
      expect(result).toEqual({ id: 1, name: 'first' });
    });

    it('should return null when no rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await store.queryOne('SELECT * FROM items WHERE id = $1', [999]);
      expect(result).toBeNull();
    });

    it('should throw on query error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('syntax error'));
      await expect(store.queryOne('BAD SQL')).rejects.toThrow('syntax error');
    });
  });

  // ─── execute ─────────────────────────────────────────────────────────────

  describe('execute', () => {
    it('should return rowCount from result', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3 });
      const result = await store.execute('DELETE FROM items WHERE status = $1', ['inactive']);
      expect(result).toEqual({ rowCount: 3 });
    });

    it('should return 0 when rowCount is null', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: null });
      const result = await store.execute('CREATE TABLE test (id INT)');
      expect(result).toEqual({ rowCount: 0 });
    });

    it('should throw on execute error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('constraint violation'));
      await expect(store.execute('INSERT INTO items VALUES ($1)', ['dup'])).rejects.toThrow('constraint violation');
    });
  });

  // ─── transaction ─────────────────────────────────────────────────────────

  describe('transaction', () => {
    let mockClient: { query: jest.Mock; release: jest.Mock };

    beforeEach(() => {
      mockClient = { query: jest.fn(), release: jest.fn() };
      mockConnect.mockResolvedValue(mockClient);
    });

    it('should execute BEGIN, callback, COMMIT, and release client', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // user query
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await store.transaction(async (tx) => {
        const rows = await tx.query<{ count: number }>('SELECT count(*) FROM items');
        return rows[0].count;
      });

      expect(result).toBe(5);
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenNthCalledWith(2, 'SELECT count(*) FROM items', undefined);
      expect(mockClient.query).toHaveBeenNthCalledWith(3, 'COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should ROLLBACK and release client on callback error', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('insert failed')) // user query fails
        .mockResolvedValueOnce(undefined); // ROLLBACK

      await expect(
        store.transaction(async (tx) => {
          await tx.execute('INSERT INTO items VALUES ($1)', ['bad']);
        }),
      ).rejects.toThrow('insert failed');

      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should support tx.queryOne returning null', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // queryOne → no rows
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await store.transaction(async (tx) => {
        return tx.queryOne('SELECT * FROM items WHERE id = $1', [999]);
      });

      expect(result).toBeNull();
    });

    it('should support tx.execute returning rowCount', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rowCount: 2 }) // execute
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await store.transaction(async (tx) => {
        return tx.execute('UPDATE items SET status = $1', ['active']);
      });

      expect(result).toEqual({ rowCount: 2 });
    });

    it('should release client even if ROLLBACK fails', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('query failed')) // user query
        .mockRejectedValueOnce(new Error('rollback failed')); // ROLLBACK fails

      await expect(
        store.transaction(async (tx) => {
          await tx.query('BAD SQL');
        }),
      ).rejects.toThrow('query failed');

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  // ─── healthCheck ─────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('should return true when database is reachable', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      const result = await store.healthCheck();
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('should return false when database is unreachable', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      const result = await store.healthCheck();
      expect(result).toBe(false);
    });
  });

  // ─── close ───────────────────────────────────────────────────────────────

  describe('close', () => {
    it('should call pool.end()', async () => {
      mockEnd.mockResolvedValueOnce(undefined);
      await store.close();
      expect(mockEnd).toHaveBeenCalled();
    });

    it('should throw if pool.end() fails', async () => {
      mockEnd.mockRejectedValueOnce(new Error('close failed'));
      await expect(store.close()).rejects.toThrow('close failed');
    });
  });

  // ─── getPool ─────────────────────────────────────────────────────────────

  describe('getPool', () => {
    it('should return the underlying pool instance', () => {
      const pool = store.getPool();
      expect(pool).toBeDefined();
      expect(pool.query).toBe(mockQuery);
    });
  });
});
