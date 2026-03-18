/**
 * AuditLogger 审计日志服务
 * 负责记录所有自动化操作的审计日志
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 7.1, 7.3, 7.4
 * - 10.1: 记录脚本执行时间、触发原因、脚本内容和执行结果
 * - 10.2: 记录配置变更时间和变更内容摘要
 * - 10.3: 记录告警触发/恢复详情和处理状态
 * - 10.4: 支持按时间范围、操作类型筛选审计记录
 * - 10.5: 保留最近 180 天的审计记录，自动清理过期数据
 * - 7.1: 仅查看配置快照页面时不产生审计记录
 * - 7.3: 区分只读操作和写入操作
 * - 7.4: 仅在写入操作时记录审计日志
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AuditLog, AuditLogQueryOptions, IAuditLogger, AuditAction } from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import type { DataStore } from '../core/dataStore';
import type { DataStore as PgDataStoreInterface } from '../dataStore';

const AUDIT_DIR = path.join(process.cwd(), 'data', 'ai-ops', 'audit');
const DEFAULT_RETENTION_DAYS = 180; // 保留 180 天
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24 小时清理一次

/**
 * 只读操作类型列表
 * 这些操作不会产生审计日志记录
 * Requirements: 7.1, 7.3, 7.4
 */
export const READ_ONLY_ACTIONS = [
  'snapshot_view',
  'config_view',
  'report_view',
] as const;

/**
 * 只读操作类型
 */
export type ReadOnlyAction = typeof READ_ONLY_ACTIONS[number];

/**
 * 检查操作是否为只读操作
 * @param action 操作类型
 * @returns 是否为只读操作
 */
export function isReadOnlyAction(action: string): boolean {
  return READ_ONLY_ACTIONS.includes(action as ReadOnlyAction);
}

/**
 * 获取日期字符串 (YYYY-MM-DD) - 使用 UTC 时间
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取日期文件路径
 */
function getDateFilePath(dateStr: string): string {
  return path.join(AUDIT_DIR, `${dateStr}.json`);
}

/**
 * 解析日期字符串为时间戳范围
 */
function parseDateRange(dateStr: string): { start: number; end: number } {
  const date = new Date(dateStr);
  const start = date.getTime();
  const end = start + 24 * 60 * 60 * 1000 - 1; // 当天最后一毫秒
  return { start, end };
}

export class AuditLogger implements IAuditLogger {
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private initialized = false;

  // ==================== DataStore 集成 ====================
  // Requirements: 2.1, 2.2 - 使用 SQLite 替代 JSON 文件存储，注入 tenant_id
  private dataStore: DataStore | null = null;
  private pgDataStore: PgDataStoreInterface | null = null;

  /**
   * 设置 DataStore 实例（旧版 SQLite）
   * Requirements: 2.1, 2.2
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('AuditLogger: DataStore backend configured, using SQLite for audit log storage');
  }

  /**
   * 设置 PgDataStore 实例，启用 PostgreSQL 持久化
   */
  setPgDataStore(dataStore: PgDataStoreInterface): void {
    this.pgDataStore = dataStore;
    logger.info('AuditLogger: PgDataStore backend configured, using PostgreSQL for audit log storage');
  }

  /**
   * 初始化审计日志服务
   * 启动时自动清理过期日志，并设置定时清理任务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureAuditDir();

    // 启动时立即清理过期日志
    const deletedCount = await this.cleanup();
    if (deletedCount > 0) {
      logger.info(`Audit logger initialized, cleaned up ${deletedCount} expired records`);
    } else {
      logger.info('Audit logger initialized');
    }

    // 设置定时清理任务（每 24 小时执行一次）
    this.cleanupIntervalId = setInterval(async () => {
      try {
        const count = await this.cleanup();
        if (count > 0) {
          logger.info(`Scheduled audit log cleanup: ${count} records deleted`);
        }
      } catch (error) {
        logger.error('Scheduled audit log cleanup failed:', error);
      }
    }, CLEANUP_INTERVAL_MS);

    this.initialized = true;
  }

  /**
   * 停止审计日志服务
   */
  stop(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.initialized = false;
    logger.info('Audit logger stopped');
  }

  /**
   * 确保审计日志目录存在
   */
  private async ensureAuditDir(): Promise<void> {
    try {
      await fs.access(AUDIT_DIR);
    } catch {
      await fs.mkdir(AUDIT_DIR, { recursive: true });
      logger.info(`Created audit log directory: ${AUDIT_DIR}`);
    }
  }

  /**
   * 读取指定日期的日志文件
   */
  private async readDateFile(dateStr: string): Promise<AuditLog[]> {
    const filePath = getDateFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as AuditLog[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read audit log file ${dateStr}:`, error);
      // 文件损坏时返回空数组
      return [];
    }
  }

  /**
   * 写入指定日期的日志文件
   */
  private async writeDateFile(dateStr: string, logs: AuditLog[]): Promise<void> {
    const filePath = getDateFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(logs, null, 2), 'utf-8');
  }

  /**
   * 获取日期范围内的所有日期字符串 (使用 UTC 时间)
   */
  private getDateRange(from: number, to: number): string[] {
    const dates: string[] = [];

    // 使用 UTC 时间计算日期范围
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // 获取 UTC 日期的开始
    const currentDate = new Date(Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate()
    ));

    // 获取 UTC 日期的结束
    const endDate = new Date(Date.UTC(
      toDate.getUTCFullYear(),
      toDate.getUTCMonth(),
      toDate.getUTCDate(),
      23, 59, 59, 999
    ));

    while (currentDate <= endDate) {
      dates.push(getDateString(currentDate.getTime()));
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return dates;
  }

  /**
   * 列出所有审计日志文件
   */
  private async listAuditFiles(): Promise<string[]> {
    try {
      await this.ensureAuditDir();
      const files = await fs.readdir(AUDIT_DIR);
      return files
        .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
        .map((f) => f.replace('.json', ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 记录审计日志
   * 只读操作（如查看快照、查看配置）不会被记录
   * @param entry 日志条目（不含 id 和 timestamp）
   * @returns 完整的审计日志条目，如果是只读操作则返回 null
   * Requirements: 7.1, 7.3, 7.4
   */
  async log(entry: Omit<AuditLog, 'id' | 'timestamp'>): Promise<AuditLog | null> {
    // 过滤只读操作，不记录审计日志
    if (isReadOnlyAction(entry.action)) {
      logger.debug(`Skipping audit log for read-only action: ${entry.action}`);
      return null;
    }

    const timestamp = Date.now();
    const auditLog: AuditLog = {
      id: uuidv4(),
      timestamp,
      ...entry,
    };

    // 当 PgDataStore 可用时，写入 PostgreSQL
    if (this.pgDataStore) {
      try {
        const tenantId = auditLog.tenantId || 'system';
        const deviceId = auditLog.deviceId || null;
        const actor = entry.actor || 'system';
        const createdAt = new Date(timestamp).toISOString();
        const details = JSON.stringify(entry.details || {});

        await this.pgDataStore.execute(
          `INSERT INTO audit_logs (id, tenant_id, device_id, action, actor, details, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [auditLog.id, tenantId, deviceId, auditLog.action, actor, details, createdAt]
        );

        logger.debug(`Audit log recorded to PostgreSQL: ${auditLog.action} by ${auditLog.actor}`);
        return auditLog;
      } catch (error) {
        logger.error('Failed to write audit log to PostgreSQL, falling back:', error);
      }
    }

    // 当 DataStore 可用时，写入 SQLite
    if (this.dataStore) {
      try {
        const tenantId = auditLog.tenantId || 'system';
        const deviceId = auditLog.deviceId || null;
        const actor = entry.actor || 'system';
        const createdAt = new Date(timestamp).toISOString();
        // Store details without _actor since actor now has its own column
        const details = JSON.stringify(entry.details || {});

        this.dataStore.run(
          `INSERT INTO audit_logs (id, tenant_id, device_id, action, actor, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [auditLog.id, tenantId, deviceId, auditLog.action, actor, details, createdAt]
        );

        logger.debug(`Audit log recorded to DataStore: ${auditLog.action} by ${auditLog.actor}`);
        return auditLog;
      } catch (error) {
        logger.error('Failed to write audit log to DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 写入 JSON 文件
    await this.ensureAuditDir();

    const dateStr = getDateString(timestamp);
    const logs = await this.readDateFile(dateStr);
    logs.push(auditLog);
    await this.writeDateFile(dateStr, logs);

    logger.debug(`Audit log recorded: ${auditLog.action} by ${auditLog.actor}`);
    return auditLog;
  }

  /**
   * 查询审计日志
   * @param options 查询选项
   * @returns 匹配的审计日志列表
   */
  async query(options: AuditLogQueryOptions & { tenant_id?: string } = {}): Promise<AuditLog[]> {
    const { from, to, action, actor, limit, tenant_id } = options;

    // 当 PgDataStore 可用时，从 PostgreSQL 查询
    if (this.pgDataStore) {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (tenant_id) {
          conditions.push(`tenant_id = $${idx++}`);
          params.push(tenant_id);
        }
        if (from !== undefined) {
          conditions.push(`created_at >= $${idx++}`);
          params.push(new Date(from).toISOString());
        }
        if (to !== undefined) {
          conditions.push(`created_at <= $${idx++}`);
          params.push(new Date(to).toISOString());
        }
        if (action !== undefined) {
          conditions.push(`action = $${idx++}`);
          params.push(action);
        }
        if (actor !== undefined) {
          conditions.push(`actor = $${idx++}`);
          params.push(actor);
        }

        let sql = 'SELECT * FROM audit_logs';
        if (conditions.length > 0) {
          sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY created_at DESC';

        if (limit !== undefined && limit > 0) {
          sql += ` LIMIT $${idx++}`;
          params.push(limit);
        }

        const rows = await this.pgDataStore.query<{
          id: string; tenant_id: string; device_id: string | null;
          action: string; actor: string; details: string | Record<string, unknown>;
          created_at: string;
        }>(sql, params);

        return rows.map((row) => {
          const detailsObj = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
          return {
            id: row.id,
            timestamp: new Date(row.created_at).getTime(),
            action: row.action as AuditAction,
            actor: (row.actor || 'system') as 'system' | 'user',
            details: detailsObj,
          } as AuditLog;
        });
      } catch (error) {
        logger.error('Failed to query audit logs from PostgreSQL, falling back:', error);
      }
    }

    // 当 DataStore 可用时，从 SQLite 查询
    if (this.dataStore) {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (tenant_id) {
          conditions.push('tenant_id = ?');
          params.push(tenant_id);
        }

        if (from !== undefined) {
          conditions.push('created_at >= ?');
          params.push(new Date(from).toISOString());
        }

        if (to !== undefined) {
          conditions.push('created_at <= ?');
          params.push(new Date(to).toISOString());
        }

        if (action !== undefined) {
          conditions.push('action = ?');
          params.push(action);
        }

        if (actor !== undefined) {
          conditions.push('actor = ?');
          params.push(actor);
        }

        let sql = 'SELECT * FROM audit_logs';
        if (conditions.length > 0) {
          sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY created_at DESC';

        if (limit !== undefined && limit > 0) {
          sql += ' LIMIT ?';
          params.push(limit);
        }

        const rows = this.dataStore.query<{
          id: string;
          tenant_id: string;
          device_id: string | null;
          action: string;
          actor: string;
          details: string;
          created_at: string;
        }>(sql, params);

        const results = rows.map((row) => {
          const detailsObj = JSON.parse(row.details || '{}');
          return {
            id: row.id,
            timestamp: new Date(row.created_at).getTime(),
            action: row.action as AuditAction,
            actor: (row.actor || 'system') as 'system' | 'user',
            details: detailsObj,
          } as AuditLog;
        });

        return results;
      } catch (error) {
        logger.error('Failed to query audit logs from DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 从 JSON 文件查询
    await this.ensureAuditDir();

    logger.info(`Querying audit logs with options: from=${from ? new Date(from).toISOString() : 'undefined'}, to=${to ? new Date(to).toISOString() : 'undefined'}, action=${action}, limit=${limit}`);

    // 确定要查询的日期范围
    let datesToQuery: string[];
    if (from !== undefined && to !== undefined) {
      datesToQuery = this.getDateRange(from, to);
    } else if (from !== undefined) {
      datesToQuery = this.getDateRange(from, Date.now());
    } else if (to !== undefined) {
      // 默认从 90 天前开始
      const defaultFrom = to - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      datesToQuery = this.getDateRange(defaultFrom, to);
    } else {
      // 查询所有文件
      datesToQuery = await this.listAuditFiles();
    }

    logger.info(`Dates to query: ${datesToQuery.join(', ')}`);

    // 收集所有匹配的日志
    let allLogs: AuditLog[] = [];

    for (const dateStr of datesToQuery) {
      const logs = await this.readDateFile(dateStr);
      logger.info(`Read ${logs.length} logs from ${dateStr}`);
      allLogs = allLogs.concat(logs);
    }

    logger.info(`Total logs before filtering: ${allLogs.length}`);

    // 应用过滤条件
    let filteredLogs = allLogs;

    if (from !== undefined) {
      filteredLogs = filteredLogs.filter((log) => log.timestamp >= from);
    }

    if (to !== undefined) {
      filteredLogs = filteredLogs.filter((log) => log.timestamp <= to);
    }

    if (action !== undefined) {
      filteredLogs = filteredLogs.filter((log) => log.action === action);
    }

    if (actor !== undefined) {
      filteredLogs = filteredLogs.filter((log) => log.actor === actor);
    }

    // 按时间戳降序排序（最新的在前）
    filteredLogs.sort((a, b) => b.timestamp - a.timestamp);

    // 应用限制
    if (limit !== undefined && limit > 0) {
      filteredLogs = filteredLogs.slice(0, limit);
    }

    return filteredLogs;
  }

  /**
   * 清理过期的审计日志
   * @param retentionDays 保留天数，默认 90 天
   * @returns 删除的记录数
   */
  async cleanup(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
    // 当 PgDataStore 可用时，从 PostgreSQL 清理
    if (this.pgDataStore) {
      try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffDateStr = cutoffDate.toISOString();

        const result = await this.pgDataStore.execute(
          'DELETE FROM audit_logs WHERE created_at < $1',
          [cutoffDateStr]
        );

        if (result.rowCount > 0) {
          logger.info(`Audit log cleanup from PostgreSQL: ${result.rowCount} records deleted`);
        }
        return result.rowCount;
      } catch (error) {
        logger.error('Failed to cleanup audit logs from PostgreSQL, falling back:', error);
      }
    }

    // 当 DataStore 可用时，从 SQLite 清理
    if (this.dataStore) {
      try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffDateStr = cutoffDate.toISOString();

        const result = this.dataStore.run(
          'DELETE FROM audit_logs WHERE created_at < ?',
          [cutoffDateStr]
        );

        if (result.changes > 0) {
          logger.info(`Audit log cleanup from DataStore: ${result.changes} records deleted`);
        }
        return result.changes;
      } catch (error) {
        logger.error('Failed to cleanup audit logs from DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 从 JSON 文件清理
    await this.ensureAuditDir();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);
    const cutoffDateStr = getDateString(cutoffDate.getTime());

    const files = await this.listAuditFiles();
    let deletedCount = 0;

    for (const dateStr of files) {
      if (dateStr < cutoffDateStr) {
        const filePath = getDateFilePath(dateStr);
        try {
          // 先读取文件获取记录数
          const logs = await this.readDateFile(dateStr);
          deletedCount += logs.length;

          // 删除文件
          await fs.unlink(filePath);
          logger.info(`Deleted expired audit log file: ${dateStr} (${logs.length} records)`);
        } catch (error) {
          logger.error(`Failed to delete audit log file ${dateStr}:`, error);
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(`Audit log cleanup completed: ${deletedCount} records deleted`);
    }

    return deletedCount;
  }
}

// 导出单例实例
export const auditLogger = new AuditLogger();
