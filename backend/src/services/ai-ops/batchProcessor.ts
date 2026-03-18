/**
 * BatchProcessor 批处理服务
 * 积攒告警进行批量 AI 分析，优化 API 调用
 *
 * Requirements: 3.1, 3.2, 3.3, 3.7
 * - 3.1: 在 5 秒窗口内积攒告警进行批量分析
 * - 3.2: 批处理窗口过期时，将所有积攒的告警发送给 AI 分析
 * - 3.3: AI 返回分析结果后，分发给对应的告警事件
 * - 3.7: 批次大小超过 20 时，分割成多个批次
 */

import {
  AlertEvent,
  BatchConfig,
  BatchItem,
  IBatchProcessor,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { aiAnalyzer } from './aiAnalyzer';
import { fingerprintCache } from './fingerprintCache';

// 默认配置
const DEFAULT_CONFIG: BatchConfig = {
  windowMs: 5000,           // 5 秒批处理窗口
  maxBatchSize: 20,         // 最大批次大小
};

export class BatchProcessor implements IBatchProcessor {
  private config: BatchConfig;
  private batch: BatchItem[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private running: boolean = false;
  private processing: boolean = false;

  constructor(config?: Partial<BatchConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('BatchProcessor initialized', { config: this.config });
  }

  /**
   * 添加告警到批次，返回 Promise 等待分析结果
   * @param alert 告警事件
   * @returns 分析结果 Promise
   */
  add(alert: AlertEvent): Promise<string> {
    return new Promise((resolve, reject) => {
      const item: BatchItem = { alert, resolve, reject };
      this.batch.push(item);

      logger.debug(`Alert added to batch: ${alert.id}, batch size: ${this.batch.length}`);

      // 如果批次达到最大大小，立即处理
      if (this.batch.length >= this.config.maxBatchSize) {
        logger.info(`Batch size reached max (${this.config.maxBatchSize}), processing immediately`);
        this.processBatch();
      } else if (this.running && !this.batchTimer) {
        // 启动批处理定时器
        this.startBatchTimer();
      }
    });
  }

  /**
   * 立即处理当前批次
   */
  async flush(): Promise<void> {
    if (this.batch.length > 0) {
      await this.processBatch();
    }
  }

  /**
   * 获取待处理数量
   */
  getPendingCount(): number {
    return this.batch.length;
  }

  /**
   * 启动批处理
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('BatchProcessor started');
  }

  /**
   * 停止批处理
   */
  stop(): void {
    this.running = false;
    this.stopBatchTimer();
    logger.info('BatchProcessor stopped');
  }

  /**
   * 启动批处理定时器
   */
  private startBatchTimer(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      if (this.batch.length > 0) {
        this.processBatch();
      }
    }, this.config.windowMs);
  }

  /**
   * 停止批处理定时器
   */
  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }


  /**
   * 处理当前批次
   */
  private async processBatch(): Promise<void> {
    if (this.processing || this.batch.length === 0) return;

    this.processing = true;
    this.stopBatchTimer();

    // 取出当前批次
    const currentBatch = [...this.batch];
    this.batch = [];

    logger.info(`Processing batch of ${currentBatch.length} alerts`);

    try {
      // 如果批次超过最大大小，分割成多个批次
      const batches = this.splitBatches(currentBatch);

      for (const batch of batches) {
        await this.processSingleBatch(batch);
      }
    } catch (error) {
      logger.error('Batch processing failed:', error);
      // 对所有未处理的项返回错误
      for (const item of currentBatch) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.processing = false;

      // 如果还有待处理的告警，启动新的定时器
      if (this.running && this.batch.length > 0) {
        this.startBatchTimer();
      }
    }
  }

  /**
   * 分割批次
   * @param items 批处理项列表
   * @returns 分割后的批次数组
   */
  private splitBatches(items: BatchItem[]): BatchItem[][] {
    const batches: BatchItem[][] = [];
    for (let i = 0; i < items.length; i += this.config.maxBatchSize) {
      batches.push(items.slice(i, i + this.config.maxBatchSize));
    }
    return batches;
  }

  /**
   * 处理单个批次
   * @param batch 批处理项列表
   */
  private async processSingleBatch(batch: BatchItem[]): Promise<void> {
    logger.debug(`Processing single batch of ${batch.length} alerts`);

    // 构建批量分析请求
    const alertsInfo = batch.map((item, index) => ({
      index,
      id: item.alert.id,
      ruleName: item.alert.ruleName,
      severity: item.alert.severity,
      metric: item.alert.metric,
      currentValue: item.alert.currentValue,
      threshold: item.alert.threshold,
      message: item.alert.message,
    }));

    try {
      // 调用 AI 进行批量分析
      const batchAnalysis = await this.analyzeBatch(alertsInfo);

      // 分发结果给各个告警
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const analysis = batchAnalysis[i] || this.getDefaultAnalysis(item.alert);
        item.resolve(analysis);
      }

      logger.info(`Batch analysis completed for ${batch.length} alerts`);
    } catch (error) {
      logger.error('Single batch processing failed:', error);
      // 对批次中的所有项返回错误
      for (const item of batch) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * 批量分析告警
   * @param alertsInfo 告警信息列表
   * @returns 分析结果数组
   */
  private async analyzeBatch(alertsInfo: Array<{
    index: number;
    id: string;
    ruleName: string;
    severity: string;
    metric: string;
    currentValue: number;
    threshold: number;
    message: string;
  }>): Promise<string[]> {
    // 构建批量分析提示词
    const prompt = this.buildBatchPrompt(alertsInfo);

    try {
      // 调用 AI 分析
      const result = await aiAnalyzer.analyze({
        type: 'alert',
        context: {
          batchMode: true,
          alerts: alertsInfo,
          prompt,
        },
      });

      // 解析批量分析结果
      return this.parseBatchResult(result.summary, alertsInfo.length);
    } catch (error) {
      logger.warn('AI batch analysis failed, using fallback:', error);
      // 返回默认分析结果
      return alertsInfo.map(info => this.getDefaultAnalysisForInfo(info));
    }
  }

  /**
   * 构建批量分析提示词
   */
  private buildBatchPrompt(alertsInfo: Array<{
    index: number;
    id: string;
    ruleName: string;
    severity: string;
    metric: string;
    currentValue: number;
    threshold: number;
    message: string;
  }>): string {
    const alertsList = alertsInfo.map((info, i) => 
      `[告警 ${i + 1}] ${info.ruleName} (${info.severity}): ${info.message} - 当前值: ${info.currentValue}, 阈值: ${info.threshold}`
    ).join('\n');

    return `请分析以下 ${alertsInfo.length} 个告警事件，为每个告警提供简要分析和建议。

${alertsList}

请按照以下 JSON 格式返回分析结果：
{
  "analyses": [
    {"index": 0, "analysis": "告警1的分析和建议"},
    {"index": 1, "analysis": "告警2的分析和建议"},
    ...
  ]
}`;
  }

  /**
   * 解析批量分析结果
   * @param result AI 返回的结果
   * @param expectedCount 期望的结果数量
   * @returns 分析结果数组
   */
  private parseBatchResult(result: string, expectedCount: number): string[] {
    const analyses: string[] = [];

    try {
      // 尝试解析 JSON 格式
      const jsonMatch = result.match(/\{[\s\S]*"analyses"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.analyses)) {
          for (const item of parsed.analyses) {
            analyses[item.index] = item.analysis;
          }
        }
      }
    } catch {
      // JSON 解析失败，尝试按段落分割
      const sections = result.split(/\[告警\s*\d+\]/);
      for (let i = 1; i < sections.length && i <= expectedCount; i++) {
        analyses[i - 1] = sections[i].trim();
      }
    }

    // 确保返回正确数量的结果
    while (analyses.length < expectedCount) {
      analyses.push('分析结果不可用');
    }

    return analyses;
  }

  /**
   * 获取默认分析结果
   */
  private getDefaultAnalysis(alert: AlertEvent): string {
    return `[${alert.severity}] ${alert.ruleName}: ${alert.message}。建议检查相关配置和系统状态。`;
  }

  /**
   * 获取默认分析结果（基于告警信息）
   */
  private getDefaultAnalysisForInfo(info: {
    ruleName: string;
    severity: string;
    message: string;
  }): string {
    return `[${info.severity}] ${info.ruleName}: ${info.message}。建议检查相关配置和系统状态。`;
  }

  /**
   * 获取配置
   */
  getConfig(): BatchConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<BatchConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('BatchProcessor config updated', { config: this.config });
  }
}

// 导出单例实例
export const batchProcessor = new BatchProcessor();
