/**
 * DataStore - 统一数据访问层
 *
 * 使用 better-sqlite3 替代所有 JSON 文件存储，提供：
 * - SQLite 初始化与连接管理（WAL 模式）
 * - 基础 CRUD 方法：query<T>()、run()、transaction()
 * - 租户感知便捷方法：findByTenant()、insertWithTenant()
 * - 数据库迁移机制：runMigrations()
 *
 * 设计决策：选择 better-sqlite3（同步 API）而非 sqlite3（异步），
 * 因为性能更好、事务支持更简洁、更符合 SQLite 单线程写入特性。
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import Database, { type Database as DatabaseType, type RunResult } from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * 迁移定义
 */
export interface MigrationDefinition {
  /** 迁移版本号 */
  version: number;
  /** 升级 SQL 语句 */
  up: string;
  /** 回滚 SQL 语句 */
  down: string;
}

/**
 * DataStore 配置选项
 */
export interface DataStoreOptions {
  /** 数据库文件路径，默认 data/routeros.db */
  dbPath?: string;
  /** 迁移文件目录路径，默认 backend/src/migrations/ */
  migrationsPath?: string;
  /** 是否启用 WAL 模式，默认 true */
  enableWAL?: boolean;
  /** 是否为内存数据库（用于测试），默认 false */
  inMemory?: boolean;
}

/**
 * DataStore 结构化错误
 */
export class DataStoreError extends Error {
  /** 错误操作上下文 */
  public readonly operation: string;
  /** 原始错误 */
  public readonly cause: Error | undefined;
  /** 相关 SQL（如有） */
  public readonly sql?: string;

  constructor(message: string, operation: string, cause?: Error, sql?: string) {
    super(message);
    this.name = 'DataStoreError';
    this.operation = operation;
    this.cause = cause;
    this.sql = sql;
  }
}

// ─── DataStore Class ─────────────────────────────────────────────────────────

export class DataStore {
  private db: DatabaseType | null = null;
  private readonly options: Required<DataStoreOptions>;
  private initialized = false;

  constructor(options: DataStoreOptions = {}) {
    this.options = {
      dbPath: options.dbPath ?? path.join(process.cwd(), 'data', 'routeros.db'),
      migrationsPath: options.migrationsPath ?? path.join(__dirname, '..', '..', 'migrations'),
      enableWAL: options.enableWAL ?? true,
      inMemory: options.inMemory ?? false,
    };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * 初始化数据库连接
   * - 创建数据目录（如不存在）
   * - 打开 SQLite 连接
   * - 启用 WAL 模式
   * - 启用外键约束
   * - 运行迁移
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('DataStore 已初始化，跳过重复初始化');
      return;
    }

    try {
      // 创建数据目录
      if (!this.options.inMemory) {
        const dbDir = path.dirname(this.options.dbPath);
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
          logger.info(`创建数据目录: ${dbDir}`);
        }
      }

      // 打开数据库连接
      const dbPath = this.options.inMemory ? ':memory:' : this.options.dbPath;
      this.db = new Database(dbPath);
      logger.info(`SQLite 数据库已打开: ${dbPath}`);

      // 启用 WAL 模式（更好的并发读性能）
      if (this.options.enableWAL) {
        this.db.pragma('journal_mode = WAL');
        logger.info('已启用 WAL 日志模式');
      }

      // 启用外键约束
      this.db.pragma('foreign_keys = ON');

      // 运行迁移
      await this.runMigrations();

      this.initialized = true;
      logger.info('DataStore 初始化完成');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`DataStore 初始化失败: ${err.message}`);
      throw new DataStoreError('数据库初始化失败', 'initialize', err);
    }
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
        this.initialized = false;
        logger.info('DataStore 已关闭');
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`DataStore 关闭失败: ${err.message}`);
        throw new DataStoreError('数据库关闭失败', 'close', err);
      }
    }
  }

  /**
   * 检查数据库是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取底层 better-sqlite3 数据库实例（高级用法）
   */
  getDatabase(): DatabaseType {
    this.ensureInitialized();
    return this.db!;
  }

  // ─── Core CRUD Methods ───────────────────────────────────────────────────

  /**
   * 执行查询并返回所有匹配行
   * @param sql SQL 查询语句
   * @param params 参数化查询参数
   * @returns 查询结果数组
   */
  query<T>(sql: string, params?: unknown[]): T[] {
    this.ensureInitialized();
    try {
      const stmt = this.db!.prepare(sql);
      return (params ? stmt.all(...params) : stmt.all()) as T[];
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`查询执行失败: ${err.message} | SQL: ${sql}`);
      throw new DataStoreError(
        `查询执行失败: ${err.message}`,
        'query',
        err,
        sql,
      );
    }
  }

  /**
   * 执行写操作（INSERT/UPDATE/DELETE）
   * @param sql SQL 语句
   * @param params 参数化查询参数
   * @returns 执行结果（changes, lastInsertRowid）
   */
  run(sql: string, params?: unknown[]): RunResult {
    this.ensureInitialized();
    try {
      const stmt = this.db!.prepare(sql);
      return params ? stmt.run(...params) : stmt.run();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`SQL 执行失败: ${err.message} | SQL: ${sql}`);
      throw new DataStoreError(
        `SQL 执行失败: ${err.message}`,
        'run',
        err,
        sql,
      );
    }
  }

  /**
   * 在事务中执行一组操作，保证原子性
   * 如果回调函数抛出异常，所有操作自动回滚
   * @param fn 事务回调函数
   * @returns 回调函数的返回值
   */
  transaction<T>(fn: () => T): T {
    this.ensureInitialized();
    try {
      const transactionFn = this.db!.transaction(fn);
      return transactionFn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`事务执行失败: ${err.message}`);
      throw new DataStoreError(
        `事务执行失败: ${err.message}`,
        'transaction',
        err,
      );
    }
  }

  // ─── Tenant-Aware Convenience Methods ────────────────────────────────────

  /**
   * 按租户 ID 查询数据
   * 自动注入 tenant_id 过滤条件
   *
   * @param table 表名
   * @param tenantId 租户 ID
   * @param where 额外的过滤条件（键值对）
   * @returns 查询结果数组
   */
  findByTenant<T>(
    table: string,
    tenantId: string,
    where?: Record<string, unknown>,
  ): T[] {
    this.ensureInitialized();
    this.validateTableName(table);

    try {
      const conditions: string[] = ['tenant_id = ?'];
      const params: unknown[] = [tenantId];

      if (where) {
        for (const [key, value] of Object.entries(where)) {
          this.validateColumnName(key);
          conditions.push(`${key} = ?`);
          params.push(value);
        }
      }

      const sql = `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')}`;
      const stmt = this.db!.prepare(sql);
      return stmt.all(...params) as T[];
    } catch (error) {
      if (error instanceof DataStoreError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`租户查询失败: ${err.message} | table: ${table}, tenantId: ${tenantId}`);
      throw new DataStoreError(
        `租户查询失败: ${err.message}`,
        'findByTenant',
        err,
      );
    }
  }

  /**
   * 插入带租户 ID 的数据
   * 自动注入 tenant_id 字段
   *
   * @param table 表名
   * @param tenantId 租户 ID
   * @param data 要插入的数据（键值对）
   * @returns 执行结果
   */
  insertWithTenant(
    table: string,
    tenantId: string,
    data: Record<string, unknown>,
  ): RunResult {
    this.ensureInitialized();
    this.validateTableName(table);

    try {
      const allData = { tenant_id: tenantId, ...data };
      const columns = Object.keys(allData);
      const placeholders = columns.map(() => '?').join(', ');
      const values = Object.values(allData);

      // Validate column names
      for (const col of columns) {
        this.validateColumnName(col);
      }

      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
      const stmt = this.db!.prepare(sql);
      return stmt.run(...values);
    } catch (error) {
      if (error instanceof DataStoreError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`租户插入失败: ${err.message} | table: ${table}, tenantId: ${tenantId}`);
      throw new DataStoreError(
        `租户插入失败: ${err.message}`,
        'insertWithTenant',
        err,
      );
    }
  }

  // ─── Migration Mechanism ─────────────────────────────────────────────────

  /**
   * 运行数据库迁移
   * - 创建 schema_migrations 表（如不存在）
   * - 读取迁移文件目录
   * - 按版本号顺序执行未应用的迁移
   * - 每个迁移在独立事务中执行
   */
  async runMigrations(): Promise<void> {
    this.ensureConnected();

    try {
      // 创建迁移版本管理表
      this.db!.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // 获取已应用的迁移版本
      const appliedVersions = new Set(
        (this.db!.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
          .map((row) => row.version),
      );

      // 加载迁移文件
      const migrations = await this.loadMigrations();

      if (migrations.length === 0) {
        logger.info('没有找到迁移文件');
        return;
      }

      // 按版本号排序
      migrations.sort((a, b) => a.version - b.version);

      // 执行未应用的迁移
      let appliedCount = 0;
      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) {
          logger.debug(`迁移 v${migration.version} 已应用，跳过`);
          continue;
        }

        logger.info(`正在应用迁移 v${migration.version}...`);

        try {
          // 每个迁移在事务中执行
          const applyMigration = this.db!.transaction(() => {
            this.db!.exec(migration.up);
            this.db!.prepare(
              'INSERT INTO schema_migrations (version) VALUES (?)',
            ).run(migration.version);
          });

          applyMigration();
          appliedCount++;
          logger.info(`迁移 v${migration.version} 应用成功`);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error(`迁移 v${migration.version} 执行失败: ${err.message}`);
          throw new DataStoreError(
            `迁移 v${migration.version} 执行失败: ${err.message}`,
            'runMigrations',
            err,
          );
        }
      }

      if (appliedCount > 0) {
        logger.info(`共应用 ${appliedCount} 个迁移`);
      } else {
        logger.info('数据库 schema 已是最新版本');
      }
    } catch (error) {
      if (error instanceof DataStoreError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`迁移过程失败: ${err.message}`);
      throw new DataStoreError('迁移过程失败', 'runMigrations', err);
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * 加载迁移文件
   * 从 migrationsPath 目录读取所有 .ts/.js 迁移文件
   */
  private async loadMigrations(): Promise<MigrationDefinition[]> {
    const migrationsPath = this.options.migrationsPath;

    if (!fs.existsSync(migrationsPath)) {
      logger.warn(`迁移目录不存在: ${migrationsPath}`);
      return [];
    }

    const files = fs.readdirSync(migrationsPath)
      .filter((f) => /^\d+.*\.(ts|js)$/.test(f) && !/\.d\.ts$/.test(f) && !/\.(test|spec)\.(ts|js)$/.test(f))
      .sort();

    const migrations: MigrationDefinition[] = [];

    for (const file of files) {
      try {
        const filePath = path.join(migrationsPath, file);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(filePath);
        const migration: MigrationDefinition = mod.default ?? mod;

        if (
          typeof migration.version !== 'number' ||
          typeof migration.up !== 'string' ||
          typeof migration.down !== 'string'
        ) {
          logger.warn(`迁移文件 ${file} 格式无效，跳过`);
          continue;
        }

        migrations.push(migration);
        logger.debug(`已加载迁移文件: ${file} (v${migration.version})`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`加载迁移文件 ${file} 失败: ${err.message}`);
        throw new DataStoreError(
          `加载迁移文件 ${file} 失败: ${err.message}`,
          'loadMigrations',
          err,
        );
      }
    }

    return migrations;
  }

  /**
   * 确保数据库已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new DataStoreError(
        'DataStore 未初始化，请先调用 initialize()',
        'ensureInitialized',
      );
    }
  }

  /**
   * 确保数据库连接已建立（用于迁移阶段，此时 initialized 可能还是 false）
   */
  private ensureConnected(): void {
    if (!this.db) {
      throw new DataStoreError(
        'DataStore 数据库连接未建立',
        'ensureConnected',
      );
    }
  }

  /**
   * 验证表名（防止 SQL 注入）
   * 只允许字母、数字和下划线
   */
  private validateTableName(table: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new DataStoreError(
        `无效的表名: ${table}`,
        'validateTableName',
      );
    }
  }

  /**
   * 验证列名（防止 SQL 注入）
   * 只允许字母、数字和下划线
   */
  private validateColumnName(column: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
      throw new DataStoreError(
        `无效的列名: ${column}`,
        'validateColumnName',
      );
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { RunResult };
export default DataStore;
