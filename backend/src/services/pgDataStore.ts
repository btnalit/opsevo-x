/**
 * PgDataStore - PostgreSQL 实现的 DataStore
 *
 * 使用 pg 连接池管理 PostgreSQL 连接，提供：
 * - 参数化查询（防 SQL 注入）
 * - 自动事务管理（BEGIN/COMMIT/ROLLBACK）
 * - 连接池配置通过环境变量 PG_POOL_MIN、PG_POOL_MAX、PG_IDLE_TIMEOUT 调整
 * - 健康检查与优雅关闭
 *
 * Requirements: C1.2, C1.4, I6.17
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { logger } from '../utils/logger';
import type { DataStore, DataStoreTransaction } from './dataStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PgDataStoreConfig {
  /** PostgreSQL 连接字符串 */
  connectionString: string;
  /** 连接池最小连接数（默认 2，可通过 PG_POOL_MIN 环境变量配置） */
  min?: number;
  /** 连接池最大连接数（默认 10，可通过 PG_POOL_MAX 环境变量配置） */
  max?: number;
  /** 空闲连接超时毫秒数（默认 30000，可通过 PG_IDLE_TIMEOUT 环境变量配置） */
  idleTimeoutMillis?: number;
}

// ─── PgDataStore Class ───────────────────────────────────────────────────────

export class PgDataStore implements DataStore {
  private pool: Pool;

  constructor(config?: PgDataStoreConfig) {
    const connectionString = config?.connectionString
      ?? process.env.DATABASE_URL
      ?? `postgresql://${process.env.PG_USER || 'postgres'}:${process.env.PG_PASSWORD || 'postgres'}@${process.env.PG_HOST || 'localhost'}:${process.env.PG_PORT || '5432'}/${process.env.PG_DATABASE || 'opsevo'}`;

    const poolConfig: PoolConfig = {
      connectionString,
      min: config?.min ?? parseInt(process.env.PG_POOL_MIN || '2', 10),
      max: config?.max ?? parseInt(process.env.PG_POOL_MAX || '10', 10),
      idleTimeoutMillis:
        config?.idleTimeoutMillis ??
        parseInt(process.env.PG_IDLE_TIMEOUT || '30000', 10),
    };

    this.pool = new Pool(poolConfig);

    // 连接池错误处理：防止未处理的错误导致进程崩溃
    this.pool.on('error', (err: Error) => {
      logger.error(`PgDataStore 连接池异常: ${err.message}`);
    });

    logger.info(
      `PgDataStore 已创建 (min=${poolConfig.min}, max=${poolConfig.max}, idleTimeout=${poolConfig.idleTimeoutMillis}ms)`,
    );
  }

  // ─── DataStore Interface ─────────────────────────────────────────────────

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows as T[];
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`PgDataStore query 失败: ${err.message} | SQL: ${sql}`);
      throw err;
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const result = await this.pool.query(sql, params);
      return (result.rows[0] as T) ?? null;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`PgDataStore queryOne 失败: ${err.message} | SQL: ${sql}`);
      throw err;
    }
  }

  async execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount: number }> {
    try {
      const result = await this.pool.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`PgDataStore execute 失败: ${err.message} | SQL: ${sql}`);
      throw err;
    }
  }

  async transaction<T>(
    fn: (tx: DataStoreTransaction) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const tx: DataStoreTransaction = {
        async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
          const result = await client.query(sql, params);
          return result.rows as R[];
        },
        async queryOne<R>(
          sql: string,
          params?: unknown[],
        ): Promise<R | null> {
          const result = await client.query(sql, params);
          return (result.rows[0] as R) ?? null;
        },
        async execute(
          sql: string,
          params?: unknown[],
        ): Promise<{ rowCount: number }> {
          const result = await client.query(sql, params);
          return { rowCount: result.rowCount ?? 0 };
        },
      };

      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        const rbErr =
          rollbackError instanceof Error
            ? rollbackError
            : new Error(String(rollbackError));
        logger.error(`PgDataStore ROLLBACK 失败: ${rbErr.message}`);
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`PgDataStore transaction 失败: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  getPool(): Pool {
    return this.pool;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`PgDataStore healthCheck 失败: ${err.message}`);
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
      logger.info('PgDataStore 连接池已关闭');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`PgDataStore close 失败: ${err.message}`);
      throw err;
    }
  }
}
