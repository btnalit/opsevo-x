/**
 * TracingService - 分布式追踪服务
 * 
 * 实现分布式追踪能力
 * 
 * Requirements: 9.1.1, 9.1.2, 9.1.3, 9.1.4
 * - 9.1.1: traceId 和 spanId 生成
 * - 9.1.2: 追踪上下文管理
 * - 9.1.3: span 生命周期管理
 * - 9.1.4: 追踪数据存储
 */

import { logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DataStore } from '../dataStore';

/**
 * Span 状态
 */
export type SpanStatus = 'running' | 'completed' | 'error';

/**
 * Span 数据
 */
export interface Span {
  /** Span ID */
  spanId: string;
  /** 父 Span ID */
  parentSpanId?: string;
  /** Trace ID */
  traceId: string;
  /** 操作名称 */
  operationName: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 持续时间 (ms) */
  duration?: number;
  /** 状态 */
  status: SpanStatus;
  /** 标签 */
  tags: Record<string, string | number | boolean>;
  /** 日志 */
  logs: Array<{
    timestamp: number;
    message: string;
    level: 'info' | 'warn' | 'error';
  }>;
  /** 错误信息 */
  error?: {
    message: string;
    stack?: string;
  };
}

/**
 * Trace 数据
 */
export interface Trace {
  /** Trace ID */
  traceId: string;
  /** 根 Span */
  rootSpan: Span;
  /** 所有 Span */
  spans: Span[];
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
  /** 总持续时间 */
  duration?: number;
  /** 状态 */
  status: SpanStatus;
  /** 元数据 */
  metadata: Record<string, unknown>;
}

/**
 * 追踪上下文
 */
export interface TracingContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

/**
 * 追踪服务配置
 */
export interface TracingServiceConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 数据保留天数 */
  retentionDays: number;
  /** 最大 Span 数量 */
  maxSpansPerTrace: number;
  /** 采样率 (0-1) */
  samplingRate: number;
}

const DEFAULT_CONFIG: TracingServiceConfig = {
  enabled: true,
  retentionDays: 7,
  maxSpansPerTrace: 100,
  samplingRate: 1.0,
};

const TRACES_DATA_DIR = 'data/ai-ops/traces';

/**
 * TracingService 类
 */
/**
 * 孤儿追踪清理配置
 */
interface OrphanCleanupConfig {
  /** 清理间隔 (ms)，默认 5 分钟 */
  intervalMs: number;
  /** 追踪最大存活时间 (ms)，默认 30 分钟 */
  maxTraceAgeMs: number;
  /** Span 最大存活时间 (ms)，默认 10 分钟 */
  maxSpanAgeMs: number;
}

const DEFAULT_ORPHAN_CLEANUP_CONFIG: OrphanCleanupConfig = {
  intervalMs: 5 * 60 * 1000,      // 5 分钟
  maxTraceAgeMs: 30 * 60 * 1000,  // 30 分钟
  maxSpanAgeMs: 10 * 60 * 1000,   // 10 分钟
};

/**
 * TracingService 类
 */
export class TracingService {
  private config: TracingServiceConfig;
  private activeTraces: Map<string, Trace> = new Map();
  private activeSpans: Map<string, Span> = new Map();
  private initialized: boolean = false;
  private dataDir: string;
  private pgDataStore: DataStore | null = null;
  
  // 孤儿追踪清理相关
  private orphanCleanupConfig: OrphanCleanupConfig;
  private orphanCleanupTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<TracingServiceConfig>, dataDir?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataDir = dataDir || TRACES_DATA_DIR;
    this.orphanCleanupConfig = { ...DEFAULT_ORPHAN_CLEANUP_CONFIG };
    logger.debug('TracingService created', { config: this.config });
  }

  /**
   * 注入 PgDataStore，启用 PostgreSQL 持久化
   */
  setPgDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
    logger.info('TracingService: PgDataStore injected, persistence enabled');
  }

  /**
   * 初始化追踪服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      
      // 启动孤儿追踪定期清理
      this.startOrphanCleanupTimer();
      
      this.initialized = true;
      logger.info('TracingService initialized');
    } catch (error) {
      logger.error('Failed to initialize TracingService', { error });
      throw error;
    }
  }

  /**
   * 关闭追踪服务，清理资源
   */
  async shutdown(): Promise<void> {
    // 停止孤儿清理定时器
    this.stopOrphanCleanupTimer();
    
    // 结束所有活跃的追踪
    const activeTraceIds = Array.from(this.activeTraces.keys());
    for (const traceId of activeTraceIds) {
      try {
        await this.endTrace(traceId, new Error('Service shutdown'));
      } catch (error) {
        logger.warn(`Failed to end trace ${traceId} during shutdown`, { error });
      }
    }
    
    this.initialized = false;
    logger.info('TracingService shutdown complete', {
      tracesEnded: activeTraceIds.length,
    });
  }

  /**
   * 启动孤儿追踪定期清理定时器
   */
  private startOrphanCleanupTimer(): void {
    this.stopOrphanCleanupTimer();
    
    this.orphanCleanupTimer = setInterval(() => {
      this.cleanupOrphanTracesAndSpans().catch(error => {
        logger.warn('Orphan cleanup failed', { error });
      });
    }, this.orphanCleanupConfig.intervalMs);
    
    logger.debug('Orphan cleanup timer started', {
      intervalMs: this.orphanCleanupConfig.intervalMs,
    });
  }

  /**
   * 停止孤儿追踪清理定时器
   */
  private stopOrphanCleanupTimer(): void {
    if (this.orphanCleanupTimer) {
      clearInterval(this.orphanCleanupTimer);
      this.orphanCleanupTimer = null;
      logger.debug('Orphan cleanup timer stopped');
    }
  }

  /**
   * 清理孤儿追踪和 Span
   * 孤儿追踪：长时间未结束的追踪（可能由于异常导致未正常结束）
   */
  private async cleanupOrphanTracesAndSpans(): Promise<{ traces: number; spans: number }> {
    const now = Date.now();
    let cleanedTraces = 0;
    let cleanedSpans = 0;

    // 清理孤儿 Traces
    for (const [traceId, trace] of this.activeTraces) {
      const age = now - trace.startTime;
      if (age > this.orphanCleanupConfig.maxTraceAgeMs) {
        logger.warn('Cleaning up orphan trace', {
          traceId,
          age,
          operationName: trace.rootSpan.operationName,
        });
        
        try {
          await this.endTrace(traceId, new Error('Orphan trace cleanup'));
          cleanedTraces++;
        } catch (error) {
          // 强制清理
          this.activeTraces.delete(traceId);
          cleanedTraces++;
        }
      }
    }

    // 清理孤儿 Spans（没有对应 Trace 的 Span）
    for (const [spanId, span] of this.activeSpans) {
      const age = now - span.startTime;
      const hasTrace = this.activeTraces.has(span.traceId);
      
      if (!hasTrace || age > this.orphanCleanupConfig.maxSpanAgeMs) {
        logger.warn('Cleaning up orphan span', {
          spanId,
          traceId: span.traceId,
          age,
          hasTrace,
          operationName: span.operationName,
        });
        
        this.activeSpans.delete(spanId);
        cleanedSpans++;
      }
    }

    if (cleanedTraces > 0 || cleanedSpans > 0) {
      logger.info('Orphan cleanup completed', { cleanedTraces, cleanedSpans });
    }

    return { traces: cleanedTraces, spans: cleanedSpans };
  }

  /**
   * 更新孤儿清理配置
   */
  updateOrphanCleanupConfig(config: Partial<OrphanCleanupConfig>): void {
    this.orphanCleanupConfig = { ...this.orphanCleanupConfig, ...config };
    
    // 重启定时器以应用新配置
    if (this.initialized && this.orphanCleanupTimer) {
      this.startOrphanCleanupTimer();
    }
    
    logger.debug('Orphan cleanup config updated', { config: this.orphanCleanupConfig });
  }

  /**
   * 获取活跃追踪统计
   */
  getActiveStats(): { activeTraces: number; activeSpans: number } {
    return {
      activeTraces: this.activeTraces.size,
      activeSpans: this.activeSpans.size,
    };
  }

  /**
   * 创建新的 Trace
   * Requirements: 9.1.1
   */
  startTrace(operationName: string, metadata?: Record<string, unknown>): TracingContext {
    if (!this.config.enabled) {
      return this.createNoopContext();
    }

    // 采样检查
    if (Math.random() > this.config.samplingRate) {
      return this.createNoopContext();
    }

    const traceId = this.generateTraceId();
    const spanId = this.generateSpanId();
    const now = Date.now();

    const rootSpan: Span = {
      spanId,
      traceId,
      operationName,
      startTime: now,
      status: 'running',
      tags: {},
      logs: [],
    };

    const trace: Trace = {
      traceId,
      rootSpan,
      spans: [rootSpan],
      startTime: now,
      status: 'running',
      metadata: metadata || {},
    };

    this.activeTraces.set(traceId, trace);
    this.activeSpans.set(spanId, rootSpan);

    logger.debug('Trace started', { traceId, operationName });

    return { traceId, spanId };
  }


  /**
   * 创建子 Span
   * Requirements: 9.1.2, 9.1.3
   */
  startSpan(
    context: TracingContext,
    operationName: string,
    tags?: Record<string, string | number | boolean>
  ): TracingContext {
    if (!this.config.enabled || !context.traceId) {
      return this.createNoopContext();
    }

    const trace = this.activeTraces.get(context.traceId);
    if (!trace) {
      logger.warn('Trace not found for span creation', { traceId: context.traceId });
      return this.createNoopContext();
    }

    // 检查 Span 数量限制
    if (trace.spans.length >= this.config.maxSpansPerTrace) {
      logger.warn('Max spans per trace reached', { traceId: context.traceId });
      return context;
    }

    const spanId = this.generateSpanId();
    const now = Date.now();

    const span: Span = {
      spanId,
      parentSpanId: context.spanId,
      traceId: context.traceId,
      operationName,
      startTime: now,
      status: 'running',
      tags: tags || {},
      logs: [],
    };

    trace.spans.push(span);
    this.activeSpans.set(spanId, span);

    logger.debug('Span started', { traceId: context.traceId, spanId, operationName });

    return {
      traceId: context.traceId,
      spanId,
      parentSpanId: context.spanId,
    };
  }

  /**
   * 结束 Span
   * Requirements: 9.1.3
   */
  endSpan(context: TracingContext, error?: Error): void {
    if (!this.config.enabled || !context.spanId) {
      return;
    }

    const span = this.activeSpans.get(context.spanId);
    if (!span) {
      return;
    }

    const now = Date.now();
    span.endTime = now;
    span.duration = now - span.startTime;
    span.status = error ? 'error' : 'completed';

    if (error) {
      span.error = {
        message: error.message,
        stack: error.stack,
      };
    }

    this.activeSpans.delete(context.spanId);

    logger.debug('Span ended', {
      traceId: context.traceId,
      spanId: context.spanId,
      duration: span.duration,
      status: span.status,
    });
  }

  /**
   * 结束 Trace
   * Requirements: 9.1.3, 9.1.4
   */
  async endTrace(traceId: string, error?: Error): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const trace = this.activeTraces.get(traceId);
    if (!trace) {
      return;
    }

    const now = Date.now();
    trace.endTime = now;
    trace.duration = now - trace.startTime;
    trace.status = error ? 'error' : 'completed';

    // 结束所有未完成的 Span
    for (const span of trace.spans) {
      if (span.status === 'running') {
        span.endTime = now;
        span.duration = now - span.startTime;
        span.status = error ? 'error' : 'completed';
        this.activeSpans.delete(span.spanId);
      }
    }

    // 保存 Trace
    await this.saveTrace(trace);

    this.activeTraces.delete(traceId);

    logger.info('Trace ended', {
      traceId,
      duration: trace.duration,
      spanCount: trace.spans.length,
      status: trace.status,
    });
  }

  /**
   * 添加 Span 标签
   */
  addTag(context: TracingContext, key: string, value: string | number | boolean): void {
    if (!this.config.enabled || !context.spanId) {
      return;
    }

    const span = this.activeSpans.get(context.spanId);
    if (span) {
      span.tags[key] = value;
    }
  }

  /**
   * 添加 Span 日志
   */
  addLog(
    context: TracingContext,
    message: string,
    level: 'info' | 'warn' | 'error' = 'info'
  ): void {
    if (!this.config.enabled || !context.spanId) {
      return;
    }

    const span = this.activeSpans.get(context.spanId);
    if (span) {
      span.logs.push({
        timestamp: Date.now(),
        message,
        level,
      });
    }
  }

  /**
   * 获取 Trace
   * Requirements: 9.3.1
   */
  async getTrace(traceId: string): Promise<Trace | null> {
    // 先检查活跃的 Trace
    const activeTrace = this.activeTraces.get(traceId);
    if (activeTrace) {
      return activeTrace;
    }

    // 从 PostgreSQL 加载
    if (this.pgDataStore) {
      try {
        const traceRow = await this.pgDataStore.queryOne<{
          id: string; name: string; status: string; start_time: string;
          end_time: string | null; duration_ms: number | null;
          tags: Record<string, unknown>; metadata: Record<string, unknown>;
        }>('SELECT * FROM traces WHERE id = $1', [traceId]);

        if (!traceRow) return null;

        const spanRows = await this.pgDataStore.query<{
          id: string; trace_id: string; parent_span_id: string | null;
          name: string; status: string; start_time: string;
          end_time: string | null; duration_ms: number | null;
          tags: Record<string, unknown>; logs: Array<{ timestamp: number; message: string; level: string }>;
        }>('SELECT * FROM trace_spans WHERE trace_id = $1 ORDER BY start_time ASC', [traceId]);

        const spans: Span[] = spanRows.map(r => ({
          spanId: r.id,
          parentSpanId: r.parent_span_id ?? undefined,
          traceId: r.trace_id,
          operationName: r.name,
          startTime: new Date(r.start_time).getTime(),
          endTime: r.end_time ? new Date(r.end_time).getTime() : undefined,
          duration: r.duration_ms ?? undefined,
          status: r.status as SpanStatus,
          tags: (r.tags || {}) as Record<string, string | number | boolean>,
          logs: (r.logs || []) as Span['logs'],
        }));

        const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];

        return {
          traceId: traceRow.id,
          rootSpan,
          spans,
          startTime: new Date(traceRow.start_time).getTime(),
          endTime: traceRow.end_time ? new Date(traceRow.end_time).getTime() : undefined,
          duration: traceRow.duration_ms ?? undefined,
          status: traceRow.status as SpanStatus,
          metadata: traceRow.metadata || {},
        };
      } catch (error) {
        logger.warn('TracingService: Failed to load trace from PostgreSQL', { traceId, error });
      }
    }

    // Fallback: 从文件加载
    try {
      const filePath = path.join(this.dataDir, `${traceId}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as Trace;
    } catch {
      return null;
    }
  }

  /**
   * 列出 Traces
   * Requirements: 9.3.3
   */
  async listTraces(options?: {
    limit?: number;
    status?: SpanStatus;
    startTime?: number;
    endTime?: number;
  }): Promise<Trace[]> {
    const limit = options?.limit ?? 50;

    // PostgreSQL path
    if (this.pgDataStore) {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (options?.status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(options.status);
        }
        if (options?.startTime) {
          conditions.push(`start_time >= $${paramIdx++}`);
          params.push(new Date(options.startTime).toISOString());
        }
        if (options?.endTime) {
          conditions.push(`end_time <= $${paramIdx++}`);
          params.push(new Date(options.endTime).toISOString());
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        params.push(limit);

        const rows = await this.pgDataStore.query<{
          id: string; name: string; status: string; start_time: string;
          end_time: string | null; duration_ms: number | null;
          tags: Record<string, unknown>; metadata: Record<string, unknown>;
        }>(`SELECT * FROM traces ${where} ORDER BY start_time DESC LIMIT $${paramIdx}`, params);

        const traces: Trace[] = [];
        for (const row of rows) {
          const trace = await this.getTrace(row.id);
          if (trace) traces.push(trace);
        }
        return traces;
      } catch (error) {
        logger.warn('TracingService: Failed to list traces from PostgreSQL, falling back to file', { error });
      }
    }

    // Fallback: file-based
    const traces: Trace[] = [];
    try {
      const files = await fs.readdir(this.dataDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
          const trace = JSON.parse(content) as Trace;

          if (options?.status && trace.status !== options.status) continue;
          if (options?.startTime && trace.startTime < options.startTime) continue;
          if (options?.endTime && trace.endTime && trace.endTime > options.endTime) continue;

          traces.push(trace);
          if (traces.length >= limit) break;
        } catch {
          // 跳过无效文件
        }
      }
    } catch {
      // 目录可能不存在
    }

    return traces.sort((a, b) => b.startTime - a.startTime);
  }

  /**
   * 导出 Trace（JSON 格式）
   * Requirements: 9.3.2
   */
  async exportTrace(traceId: string): Promise<string | null> {
    const trace = await this.getTrace(traceId);
    if (!trace) {
      return null;
    }

    return JSON.stringify(trace, null, 2);
  }

  /**
   * 导出 Trace（OpenTelemetry 兼容格式）
   * Requirements: 9.3.2
   */
  async exportTraceOTLP(traceId: string): Promise<object | null> {
    const trace = await this.getTrace(traceId);
    if (!trace) {
      return null;
    }

    // 转换为 OTLP 格式
    return {
      resourceSpans: [{
        resource: {
          attributes: Object.entries(trace.metadata).map(([key, value]) => ({
            key,
            value: { stringValue: String(value) },
          })),
        },
        scopeSpans: [{
          scope: { name: 'ai-ops-tracing' },
          spans: trace.spans.map(span => ({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.operationName,
            startTimeUnixNano: span.startTime * 1000000,
            endTimeUnixNano: span.endTime ? span.endTime * 1000000 : undefined,
            status: {
              code: span.status === 'error' ? 2 : 1,
              message: span.error?.message,
            },
            attributes: Object.entries(span.tags).map(([key, value]) => ({
              key,
              value: { stringValue: String(value) },
            })),
          })),
        }],
      }],
    };
  }

  /**
   * 清理过期 Traces
   */
  async cleanup(): Promise<number> {
    const cutoffTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    // PostgreSQL cleanup
    if (this.pgDataStore) {
      try {
        const cutoffDate = new Date(cutoffTime).toISOString();
        // trace_spans has ON DELETE CASCADE from traces, so deleting traces removes spans
        const result = await this.pgDataStore.execute(
          'DELETE FROM traces WHERE start_time < $1',
          [cutoffDate]
        );
        deleted = result.rowCount;
        if (deleted > 0) {
          logger.info('Cleaned up old traces from PostgreSQL', { deleted });
        }
        return deleted;
      } catch (error) {
        logger.warn('TracingService: Failed to cleanup from PostgreSQL, falling back to file', { error });
      }
    }

    // Fallback: file-based cleanup
    try {
      const files = await fs.readdir(this.dataDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const filePath = path.join(this.dataDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const trace = JSON.parse(content) as Trace;

          if (trace.startTime < cutoffTime) {
            await fs.unlink(filePath);
            deleted++;
          }
        } catch {
          // 跳过无效文件
        }
      }
    } catch {
      // 目录可能不存在
    }

    if (deleted > 0) {
      logger.info('Cleaned up old traces', { deleted });
    }

    return deleted;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TracingServiceConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('TracingService config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): TracingServiceConfig {
    return { ...this.config };
  }

  // ==================== 私有方法 ====================

  private generateTraceId(): string {
    return uuidv4().replace(/-/g, '');
  }

  private generateSpanId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 16);
  }

  private createNoopContext(): TracingContext {
    return { traceId: '', spanId: '' };
  }

  private async saveTrace(trace: Trace): Promise<void> {
    if (this.pgDataStore) {
      try {
        await this.pgDataStore.transaction(async (tx) => {
          // Upsert trace record
          await tx.execute(
            `INSERT INTO traces (id, name, status, start_time, end_time, duration_ms, tags, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               status = EXCLUDED.status, end_time = EXCLUDED.end_time,
               duration_ms = EXCLUDED.duration_ms, tags = EXCLUDED.tags, metadata = EXCLUDED.metadata`,
            [
              trace.traceId,
              trace.rootSpan.operationName,
              trace.status,
              new Date(trace.startTime).toISOString(),
              trace.endTime ? new Date(trace.endTime).toISOString() : null,
              trace.duration ?? null,
              JSON.stringify(trace.rootSpan.tags),
              JSON.stringify(trace.metadata),
            ]
          );

          // Upsert all spans
          for (const span of trace.spans) {
            await tx.execute(
              `INSERT INTO trace_spans (id, trace_id, parent_span_id, name, status, start_time, end_time, duration_ms, tags, logs)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (id) DO UPDATE SET
                 status = EXCLUDED.status, end_time = EXCLUDED.end_time,
                 duration_ms = EXCLUDED.duration_ms, tags = EXCLUDED.tags, logs = EXCLUDED.logs`,
              [
                span.spanId,
                span.traceId,
                span.parentSpanId ?? null,
                span.operationName,
                span.status,
                new Date(span.startTime).toISOString(),
                span.endTime ? new Date(span.endTime).toISOString() : null,
                span.duration ?? null,
                JSON.stringify(span.tags),
                JSON.stringify(span.logs),
              ]
            );
          }
        });
        return;
      } catch (error) {
        logger.warn('TracingService: Failed to save trace to PostgreSQL, falling back to file', { traceId: trace.traceId, error });
      }
    }

    // Fallback: save to file
    try {
      const filePath = path.join(this.dataDir, `${trace.traceId}.json`);
      await fs.writeFile(filePath, JSON.stringify(trace, null, 2));
    } catch (error) {
      logger.error('Failed to save trace', { traceId: trace.traceId, error });
    }
  }
}

// 导出单例实例
export const tracingService = new TracingService();
