/**
 * DataStore - 统一数据访问抽象接口
 *
 * 所有服务通过 DataStore 接口访问数据，不直接依赖具体数据库客户端。
 * 当前实现：PgDataStore（PostgreSQL）
 *
 * Requirements: C1.2, C1.4, I6.17
 */

import type { Pool, PoolClient } from 'pg';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * 事务回调接收的客户端接口
 * 在事务内部使用，自动处理 BEGIN/COMMIT/ROLLBACK
 */
export interface DataStoreTransaction {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

/**
 * DataStore 抽象接口
 *
 * 提供通用的数据库操作方法，所有服务通过此接口访问数据，
 * 不直接依赖 pg、better-sqlite3 等具体数据库客户端。
 */
export interface DataStore {
  /** 执行查询，返回所有匹配行 */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** 执行查询，返回第一行或 null */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;

  /** 执行写操作（INSERT/UPDATE/DELETE），返回受影响行数 */
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;

  /** 在事务中执行一组操作，自动处理 BEGIN/COMMIT/ROLLBACK */
  transaction<T>(fn: (tx: DataStoreTransaction) => Promise<T>): Promise<T>;

  /** 获取底层连接池（用于需要直接访问的高级场景） */
  getPool(): Pool;

  /** 健康检查，返回数据库是否可达 */
  healthCheck(): Promise<boolean>;

  /** 关闭连接池，释放所有连接 */
  close(): Promise<void>;
}
