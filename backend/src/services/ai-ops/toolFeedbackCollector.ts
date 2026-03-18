/**
 * ToolFeedbackCollector 工具反馈收集器
 * 负责收集工具执行指标、聚合统计信息、清理过期数据
 *
 * Requirements: 2.1, 2.3
 * - 2.1: 记录工具调用的名称、耗时、成功/失败状态、错误信息到持久化存储
 * - 2.3: 定时清理超过 metricsRetentionDays 的过期指标数据
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';

let METRICS_DIR = path.join(process.cwd(), 'data', 'ai-ops', 'tool-metrics');

/**
 * 用于测试环境：覆盖指标存储目录
 */
export function setMetricsDirForTesting(newDir: string): void {
  METRICS_DIR = newDir;
}

// ==================== 数据类型 ====================

export interface ToolMetric {
  id: string;
  toolName: string;
  timestamp: number;
  duration: number;
  success: boolean;
  errorMessage?: string;
  requestId?: string;
}

export interface ToolStats {
  toolName: string;
  totalCalls: number;
  successCount: number;
  successRate: number;
  avgDuration: number;
}

// ==================== 工具反馈收集器 ====================

export class ToolFeedbackCollector {
  private cleanupTimer: NodeJS.Timeout | null = null;

  // FIX: 内存缓存，避免每次请求都遍历读取所有文件
  private statsCache: { data: ToolStats[]; timestamp: number } | null = null;
  private static readonly STATS_CACHE_TTL = 30_000; // 30 秒缓存

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(METRICS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create tool-metrics directory:', error);
    }
  }

  /**
   * 获取日期分片文件路径
   */
  private getMetricsFilePath(date: Date): string {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(METRICS_DIR, `${dateStr}.json`);
  }

  /**
   * 读取指定日期的指标文件
   */
  private async readMetricsFile(filePath: string): Promise<ToolMetric[]> {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as ToolMetric[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.warn(`Failed to read metrics file ${filePath}:`, error);
      return [];
    }
  }

  /**
   * 写入指标到日期分片文件
   */
  private async writeMetricsFile(filePath: string, metrics: ToolMetric[]): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(metrics, null, 2), 'utf-8');
  }

  // ==================== 公共方法 ====================

  /**
   * 记录工具执行指标
   * 写入到日期分片 JSON 文件: data/ai-ops/tool-metrics/{YYYY-MM-DD}.json
   */
  async recordMetric(metric: Omit<ToolMetric, 'id'>): Promise<void> {
    try {
      await this.ensureDataDir();

      const fullMetric: ToolMetric = {
        id: uuidv4(),
        ...metric,
      };

      const date = new Date(metric.timestamp);
      const filePath = this.getMetricsFilePath(date);

      const existingMetrics = await this.readMetricsFile(filePath);
      existingMetrics.push(fullMetric);

      await this.writeMetricsFile(filePath, existingMetrics);
      // FIX: 新指标写入后使缓存失效
      this.invalidateStatsCache();
    } catch (error) {
      logger.warn('Failed to record tool metric:', error);
    }
  }

  /**
   * 获取工具统计信息
   * 默认仅聚合最近 metricsRetentionDays 天的指标文件
   * @param toolName 可选，指定工具名称过滤
   * @param retentionDays 可选，限制统计的天数范围（默认从 evolutionConfig 读取，回退 7 天）
   */
  async getToolStats(toolName?: string, retentionDays?: number): Promise<ToolStats[]> {
    try {
      // FIX: 使用缓存避免每次请求都遍历读取所有文件（进化配置页面超时的根因之一）
      if (!toolName && this.statsCache && Date.now() - this.statsCache.timestamp < ToolFeedbackCollector.STATS_CACHE_TTL) {
        return this.statsCache.data;
      }

      await this.ensureDataDir();

      // 确定日期范围
      let effectiveRetentionDays = retentionDays;
      if (effectiveRetentionDays === undefined) {
        try {
          const { getCapabilityConfig } = await import('./evolutionConfig');
          const tfConfig = getCapabilityConfig('toolFeedback');
          effectiveRetentionDays = tfConfig.metricsRetentionDays;
        } catch {
          effectiveRetentionDays = 7; // 默认 7 天
        }
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - effectiveRetentionDays);
      cutoffDate.setHours(0, 0, 0, 0);

      const files = await fs.readdir(METRICS_DIR);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      // 收集日期范围内的指标（FIX: 并行读取文件，避免串行 I/O 阻塞）
      const readPromises: Promise<ToolMetric[]>[] = [];
      for (const file of jsonFiles) {
        // 按文件名日期过滤，避免读取过期文件
        const dateStr = file.replace('.json', '');
        const fileDate = new Date(dateStr + 'T00:00:00.000Z');
        if (isNaN(fileDate.getTime()) || fileDate < cutoffDate) {
          continue;
        }

        const filePath = path.join(METRICS_DIR, file);
        readPromises.push(this.readMetricsFile(filePath));
      }

      const fileResults = await Promise.all(readPromises);
      const allMetrics: ToolMetric[] = [];
      for (const metrics of fileResults) {
        allMetrics.push(...metrics);
      }

      // 按工具名称分组
      const grouped = new Map<string, ToolMetric[]>();
      for (const metric of allMetrics) {
        if (toolName && metric.toolName !== toolName) continue;

        const existing = grouped.get(metric.toolName) || [];
        existing.push(metric);
        grouped.set(metric.toolName, existing);
      }

      // 计算统计信息
      const stats: ToolStats[] = [];
      for (const [name, metrics] of grouped) {
        const totalCalls = metrics.length;
        const successCount = metrics.filter((m) => m.success).length;
        const successRate = totalCalls > 0 ? successCount / totalCalls : 0;
        const avgDuration =
          totalCalls > 0
            ? metrics.reduce((sum, m) => sum + m.duration, 0) / totalCalls
            : 0;

        stats.push({
          toolName: name,
          totalCalls,
          successCount,
          successRate,
          avgDuration,
        });
      }

      // FIX: 更新缓存
      if (!toolName) {
        this.statsCache = { data: stats, timestamp: Date.now() };
      }

      return stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error('Failed to get tool stats:', error);
      return [];
    }
  }

  /**
   * 使统计缓存失效（在记录新指标后调用）
   */
  invalidateStatsCache(): void {
    this.statsCache = null;
  }

  /**
   * 清理过期指标数据
   * 删除超过 retentionDays 天的日期分片文件
   * @returns 删除的文件数量
   */
  async cleanupExpiredMetrics(retentionDays: number): Promise<number> {
    try {
      await this.ensureDataDir();

      const files = await fs.readdir(METRICS_DIR);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      cutoffDate.setHours(0, 0, 0, 0);

      let deletedCount = 0;

      for (const file of jsonFiles) {
        // 从文件名解析日期 (YYYY-MM-DD.json)
        const dateStr = file.replace('.json', '');
        const fileDate = new Date(dateStr + 'T00:00:00.000Z');

        if (isNaN(fileDate.getTime())) {
          logger.warn(`Skipping invalid metrics file name: ${file}`);
          continue;
        }

        if (fileDate < cutoffDate) {
          try {
            const filePath = path.join(METRICS_DIR, file);
            await fs.unlink(filePath);
            deletedCount++;
          } catch (error) {
            logger.warn(`Failed to delete expired metrics file ${file}:`, error);
          }
        }
      }

      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} expired tool metrics files`);
      }

      return deletedCount;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      logger.error('Failed to cleanup expired metrics:', error);
      return 0;
    }
  }

  /**
   * 启动定期清理定时器 (每 24 小时执行一次)
   */
  startCleanupTimer(retentionDays: number): void {
    this.stopCleanupTimer();

    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

    this.cleanupTimer = setInterval(async () => {
      try {
        await this.cleanupExpiredMetrics(retentionDays);
      } catch (error) {
        logger.error('Periodic tool metrics cleanup failed:', error);
      }
    }, CLEANUP_INTERVAL_MS);

    logger.info(`Tool metrics cleanup timer started (retention: ${retentionDays} days)`);
  }

  /**
   * 停止定期清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Tool metrics cleanup timer stopped');
    }
  }

  /**
   * 关闭并清理所有资源
   */
  shutdown(): void {
    this.stopCleanupTimer();
    logger.info('ToolFeedbackCollector shut down');
  }
}

// ==================== 导出单例 ====================

export const toolFeedbackCollector = new ToolFeedbackCollector();
