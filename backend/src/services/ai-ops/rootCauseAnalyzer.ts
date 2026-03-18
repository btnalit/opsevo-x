/**
 * RootCauseAnalyzer 根因分析服务
 * 分析告警的根本原因和关联关系
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 * - 6.1: 分析单个告警的潜在根因
 * - 6.2: 在关联窗口内分析多个告警以识别共同根因
 * - 6.3: 识别共同根因时将所有相关告警链接到根因事件
 * - 6.4: 生成事件时间线显示事件序列
 * - 6.5: 评估影响范围（用户、服务、网段）
 * - 6.6: 为每个识别的根因提供置信度评分 (0-100)
 * - 6.7: 引用相似的历史事件
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedEvent,
  RootCauseAnalysis,
  IRootCauseAnalyzer,
  TimelineEventType,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { ragEngine } from './rag';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');


/**
 * Get date string (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * Get analysis file path for a date
 */
function getAnalysisFilePath(dateStr: string): string {
  return path.join(ANALYSIS_DIR, `${dateStr}.json`);
}


// NOTE: 硬编码的正则分类已在全智能 RCA 重构中被废弃，
// 现在的分类逻辑由 ragEngine 中的 LLM 驱动分类器处理。


export class RootCauseAnalyzer implements IRootCauseAnalyzer {
  private initialized = false;
  private analysisCache: Map<string, RootCauseAnalysis> = new Map();

  // 缓存清理定时器
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  // 最大缓存条目数
  private readonly MAX_CACHE_SIZE = 200;

  // 缓存 TTL（2 小时）
  private readonly CACHE_TTL_MS = 2 * 60 * 60 * 1000;

  /**
   * Ensure data directory exists
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(ANALYSIS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create analysis directory:', error);
    }
  }

  /**
   * Initialize service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDataDir();

    // 启动缓存清理定时器
    this.startCacheCleanupTimer();

    this.initialized = true;
    logger.info('RootCauseAnalyzer initialized');
  }

  /**
   * 启动缓存清理定时器
   */
  private startCacheCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
    }

    // 每 20 分钟清理一次过期缓存
    const CLEANUP_INTERVAL_MS = 20 * 60 * 1000;
    this.cacheCleanupTimer = setInterval(() => {
      this.cleanupExpiredCache();
    }, CLEANUP_INTERVAL_MS);

    logger.debug('RootCauseAnalyzer cache cleanup timer started');
  }

  /**
   * 停止缓存清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.debug('RootCauseAnalyzer cache cleanup timer stopped');
    }
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    // 清理过期的分析缓存
    for (const [id, analysis] of this.analysisCache) {
      if (now - analysis.timestamp > this.CACHE_TTL_MS) {
        this.analysisCache.delete(id);
        cleanedCount++;
      }
    }

    // 如果缓存仍然过大，删除最旧的条目
    if (this.analysisCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.analysisCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, this.analysisCache.size - this.MAX_CACHE_SIZE);
      for (const [id] of toRemove) {
        this.analysisCache.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`RootCauseAnalyzer cleaned up ${cleanedCount} expired cache entries, remaining: ${this.analysisCache.size}`);
    }
  }

  /**
   * Read analysis file for a date
   */
  private async readAnalysisFile(dateStr: string): Promise<RootCauseAnalysis[]> {
    const filePath = getAnalysisFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as RootCauseAnalysis[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read analysis file ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * Write analysis file for a date
   */
  private async writeAnalysisFile(dateStr: string, analyses: RootCauseAnalysis[]): Promise<void> {
    await this.ensureDataDir();
    const filePath = getAnalysisFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(analyses, null, 2), 'utf-8');
  }

  /**
   * Save analysis result
   */
  private async saveAnalysis(analysis: RootCauseAnalysis): Promise<void> {
    const dateStr = getDateString(analysis.timestamp);
    const analyses = await this.readAnalysisFile(dateStr);

    const existingIndex = analyses.findIndex((a) => a.id === analysis.id);
    if (existingIndex >= 0) {
      analyses[existingIndex] = analysis;
    } else {
      analyses.push(analysis);
    }

    await this.writeAnalysisFile(dateStr, analyses);
    this.analysisCache.set(analysis.id, analysis);
  }


  /**
   * Analyze a single event for root causes
   * Requirements: 6.1, 6.6
   * Requirements (syslog-cpu-spike-fix): 2.2, 2.3 - 支持接收外部 RAG 分析结果
   * @param event 统一事件
   * @param existingRagAnalysis 可选的已有 RAG 分析结果，避免重复调用
   */
  async analyzeSingle(event: UnifiedEvent, existingRagAnalysis?: RootCauseAnalysis): Promise<RootCauseAnalysis> {
    await this.initialize();

    const now = Date.now();

    // Step 0: 获取权威的 RAG 分析结果 (Requirements: Truth Report V5 - 消除双头怪链路)
    let ragAnalysis: RootCauseAnalysis;
    if (existingRagAnalysis && existingRagAnalysis.rootCauses && existingRagAnalysis.rootCauses.length > 0) {
      ragAnalysis = existingRagAnalysis;
      logger.debug(`Using provided RAG analysis for event ${event.id}`);
    } else {
      try {
        ragAnalysis = await ragEngine.analyzeRootCause(event);
      } catch (error) {
        logger.error(`RAG analysis failed for event ${event.id}, creating fallback:`, error);
        // 极致兜底：如果 RAG 彻底失败，构造一个空的分析对象以保证流程不中断
        ragAnalysis = {
          id: `fallback-${uuidv4().slice(0, 8)}`,
          alertId: event.id,
          timestamp: now,
          rootCauses: [{
            id: `err-${uuidv4().slice(0, 8)}`,
            description: `根因分析暂时不可用: ${event.message}`,
            confidence: 10,
            evidence: ['RAG engine failure'],
            relatedAlerts: [event.id]
          }],
          timeline: {
            events: [{
              timestamp: event.timestamp,
              eventId: event.id,
              description: event.message,
              type: 'trigger'
            }],
            startTime: event.timestamp,
            endTime: now
          },
          impact: { scope: 'local', affectedResources: [], estimatedUsers: 0, services: [], networkSegments: [] }
        };
      }
    }

    // Step 1: 补充特定平台元数据 (tenantId/deviceId)
    const analysis: RootCauseAnalysis = {
      ...ragAnalysis,
      tenantId: event.deviceInfo?.tenantId,
      deviceId: event.deviceInfo?.id,
      timestamp: ragAnalysis.timestamp || now,
    };

    // Step 2: 保存分析结果
    await this.saveAnalysis(analysis);

    logger.info(`Root cause analysis completed for event ${event.id}: ${analysis.rootCauses.length} root causes identified (Source: RAG)`);
    return analysis;
  }

  /**
   * Analyze correlated events for common root causes
   * Requirements: 6.2, 6.3
   */
  async analyzeCorrelated(
    events: UnifiedEvent[]
  ): Promise<RootCauseAnalysis> {
    await this.initialize();

    if (events.length === 0) {
      throw new Error('No events provided for correlation analysis');
    }

    if (events.length === 1) {
      return this.analyzeSingle(events[0]);
    }

    // 针对关联分析，目前采取以关键告警为核心的 RAG 分析 (Requirements: Truth Report V5)
    const primaryEvent = events[0];
    const analysis = await this.analyzeSingle(primaryEvent);

    // Add a 5-minute buffer to the start and end times to better capture extending cascades
    const TIMELINE_BUFFER_MS = 5 * 60 * 1000;
    const minTimestamp = Math.min(...events.map(e => e.timestamp));
    const maxTimestamp = Math.max(...events.map(e => e.timestamp));

    return {
      ...analysis,
      id: `${analysis.id}-correlated`,
      alertId: primaryEvent.id,
      timestamp: Date.now(),
      timeline: {
        events: events.map(e => ({
          timestamp: e.timestamp,
          eventId: e.id,
          description: e.message,
          type: 'trigger' as TimelineEventType,
        })).sort((a, b) => a.timestamp - b.timestamp),
        startTime: minTimestamp - TIMELINE_BUFFER_MS,
        endTime: maxTimestamp + TIMELINE_BUFFER_MS,
      },
    };
  }


  /**
   * Generate event timeline
   * Requirements: 6.4
   */

  /**
   * Get date range for searching
   */
  private getDateRange(from: number, to: number): string[] {
    const dates: string[] = [];
    const fromDate = new Date(from);
    const toDate = new Date(to);

    const currentDate = new Date(Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate()
    ));

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

  // ==================== Public Utility Methods ====================

  /**
   * Get analysis by ID
   */
  async getAnalysis(analysisId: string): Promise<RootCauseAnalysis | null> {
    // Check cache first
    if (this.analysisCache.has(analysisId)) {
      return this.analysisCache.get(analysisId)!;
    }

    // Search in files (last 30 days)
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const dates = this.getDateRange(thirtyDaysAgo, now);

    for (const dateStr of dates) {
      const analyses = await this.readAnalysisFile(dateStr);
      const found = analyses.find((a) => a.id === analysisId);
      if (found) {
        this.analysisCache.set(analysisId, found);
        return found;
      }
    }

    return null;
  }

  /**
   * Get analysis by alert ID
   */
  async getAnalysisByAlertId(alertId: string): Promise<RootCauseAnalysis | null> {
    // Check cache first
    for (const analysis of this.analysisCache.values()) {
      if (analysis.alertId === alertId) {
        return analysis;
      }
    }

    // Search in files (last 30 days)
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const dates = this.getDateRange(thirtyDaysAgo, now);

    for (const dateStr of dates) {
      const analyses = await this.readAnalysisFile(dateStr);
      const found = analyses.find((a) => a.alertId === alertId);
      if (found) {
        this.analysisCache.set(found.id, found);
        return found;
      }
    }

    return null;
  }

  /**
   * Get recent analyses
   */
  async getRecentAnalyses(limit: number = 20): Promise<RootCauseAnalysis[]> {
    await this.initialize();

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const dates = this.getDateRange(sevenDaysAgo, now).reverse(); // Most recent first

    const allAnalyses: RootCauseAnalysis[] = [];

    for (const dateStr of dates) {
      if (allAnalyses.length >= limit) break;

      const analyses = await this.readAnalysisFile(dateStr);
      allAnalyses.push(...analyses);
    }

    // Sort by timestamp descending and limit
    return allAnalyses
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Clear analysis cache
   */
  clearCache(): void {
    this.analysisCache.clear();
    logger.info('RootCauseAnalyzer cache cleared');
  }

  /**
   * Get statistics
   */
  getStats(): {
    cacheSize: number;
    initialized: boolean;
  } {
    return {
      cacheSize: this.analysisCache.size,
      initialized: this.initialized,
    };
  }
}

// Export singleton instance
export const rootCauseAnalyzer = new RootCauseAnalyzer();
