/**
 * AnomalyPredictor - 异常预测器
 * 
 * 实现基于历史模式的异常预测
 * 
 * Requirements: 5.2.1, 5.2.2, 5.2.5
 * - 5.2.1: 历史模式分析
 * - 5.2.2: 异常预测逻辑
 * - 5.2.5: 预测结果输出
 */

import { logger } from '../../utils/logger';
import { HealthMetrics, InternalHealthSnapshot } from './healthMonitor';
import type { EventBus } from '../eventBus';
import type { DataStore } from '../dataStore';

/**
 * 预测类型
 */
export type PredictionType =
  | 'cpu_spike'           // CPU 飙升
  | 'memory_exhaustion'   // 内存耗尽
  | 'disk_full'           // 磁盘满
  | 'interface_failure'   // 接口故障
  | 'performance_degradation' // 性能下降
  | 'error_rate_increase'; // 错误率上升

/**
 * 预测结果
 */
export interface AnomalyPrediction {
  /** 预测 ID */
  id: string;
  /** 预测类型 */
  type: PredictionType;
  /** 置信度 (0-1) */
  confidence: number;
  /** 预测的发生时间 */
  predictedAt: number;
  /** 预测窗口 (ms) */
  predictionWindow: number;
  /** 当前值 */
  currentValue: number;
  /** 预测值 */
  predictedValue: number;
  /** 阈值 */
  threshold: number;
  /** 趋势方向 */
  trend: 'increasing' | 'decreasing' | 'stable';
  /** 建议的行动 */
  suggestedActions: string[];
  /** 创建时间 */
  createdAt: number;
}

/**
 * 历史数据点
 */
interface DataPoint {
  timestamp: number;
  value: number;
}

/**
 * 趋势分析结果
 */
interface TrendAnalysis {
  slope: number;
  intercept: number;
  r2: number;
  trend: 'increasing' | 'decreasing' | 'stable';
  predictedValue: number;
}

/**
 * 预测器配置
 */
export interface AnomalyPredictorConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 预测窗口 (ms) - 预测多久后的状态 */
  predictionWindow: number;
  /** 最小置信度阈值 */
  minConfidenceThreshold: number;
  /** 历史数据点数量 */
  historySize: number;
  /** 阈值配置 */
  thresholds: {
    cpuWarning: number;
    cpuCritical: number;
    memoryWarning: number;
    memoryCritical: number;
    diskWarning: number;
    diskCritical: number;
    errorRateWarning: number;
  };
}

const DEFAULT_CONFIG: AnomalyPredictorConfig = {
  enabled: true,
  predictionWindow: 30 * 60 * 1000, // 30 分钟
  minConfidenceThreshold: 0.6,
  historySize: 60, // 60 个数据点
  thresholds: {
    cpuWarning: 80,
    cpuCritical: 95,
    memoryWarning: 85,
    memoryCritical: 95,
    diskWarning: 85,
    diskCritical: 95,
    errorRateWarning: 0.05,
  },
};

/**
 * AnomalyPredictor 类
 */
export class AnomalyPredictor {
  private config: AnomalyPredictorConfig;
  private historyData: Map<string, DataPoint[]> = new Map();
  private partitionLastUsed: Map<string, number> = new Map(); // 🔵 FIX: 记录每个设备的最后活跃时间，用于驱逐
  private predictionIdCounter = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Optional: DataStore for loading historical data from PostgreSQL (G5.16) */
  private pgDataStore: DataStore | null = null;
  /** Optional: EventBus for publishing anomaly predictions as PerceptionEvents (G5.16) */
  private eventBus: EventBus | null = null;

  constructor(config?: Partial<AnomalyPredictorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('AnomalyPredictor created', { config: this.config });

    // 🔵 FIX (Audit suggest): 定期清理非活跃分区，防止内存泄漏
    this.cleanupInterval = setInterval(() => this.cleanupPartitions(), 1000 * 60 * 60 * 6); // 每 6 小时清理一次
  }

  /**
   * 清理长期不活跃的分区
   */
  private cleanupPartitions(): void {
    const now = Date.now();
    const TTL = 1000 * 60 * 60 * 48; // 48 小时不活跃则清理

    for (const [key, lastUsed] of this.partitionLastUsed.entries()) {
      if (now - lastUsed > TTL) {
        // key 格式为 "deviceId:metric"
        this.historyData.delete(key);
        this.partitionLastUsed.delete(key);
        logger.debug(`AnomalyPredictor: Evicted inactive partition: ${key}`);
      }
    }
  }

  /**
   * 优雅关闭，清理定时器
   */
  public shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('AnomalyPredictor shutdown complete');
    }
  }

  /**
   * 手动重置数据
   */
  public reset(): void {
    this.historyData.clear();
    this.partitionLastUsed.clear();
    this.predictionIdCounter = 0;
  }

  /**
   * 获取服务名称 (Lifecycle)
   */
  public getName(): string {
    return 'anomalyPredictor';
  }

  /**
   * 设置 DataStore 依赖（PostgreSQL）
   * 启用后从 monitoring_snapshots 表加载历史数据进行趋势分析 (G5.16)
   */
  public setDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
    logger.info('AnomalyPredictor: DataStore configured for PostgreSQL historical data');
  }

  /**
   * 设置 EventBus 依赖
   * 启用后高置信度预测结果作为 PerceptionEvent 发布 (G5.16)
   */
  public setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    logger.info('AnomalyPredictor: EventBus configured');
  }

  /**
   * 停止服务 (Lifecycle)
   */
  public stop(): void {
    this.shutdown();
  }

  /**
   * 添加历史数据点
   */
  addDataPoint(metric: string, value: number, timestamp?: number, deviceId: string = 'global'): void {
    // 🔴 BUG FIX (Audit suggest): 处理无效 deviceId，防止分区污染
    if (!deviceId || typeof deviceId !== 'string') {
      logger.warn('Received invalid deviceId in AnomalyPredictor, skipping data point', { deviceId, metric });
      return;
    }

    const ts = timestamp || Date.now();
    const key = `${deviceId}:${metric}`;
    this.partitionLastUsed.set(key, ts); // 更新最后活跃时间

    const history = this.historyData.get(key) || [];

    history.push({ timestamp: ts, value });

    // 保持历史数据大小限制
    while (history.length > this.config.historySize) {
      history.shift();
    }

    this.historyData.set(key, history);
  }

  /**
   * 从健康快照更新历史数据
   */
  updateFromSnapshot(snapshot: InternalHealthSnapshot): void {
    const { metrics, timestamp, deviceId = 'global' } = snapshot;

    this.addDataPoint('cpu', metrics.cpuUsage, timestamp, deviceId);
    this.addDataPoint('memory', metrics.memoryUsage, timestamp, deviceId);
    this.addDataPoint('disk', metrics.diskUsage, timestamp, deviceId);
    this.addDataPoint('errorRate', metrics.errorRate, timestamp, deviceId);
    this.addDataPoint('responseTime', metrics.avgResponseTime, timestamp, deviceId);

    if (metrics.interfaceStatus.total > 0) {
      const downRate = metrics.interfaceStatus.down / metrics.interfaceStatus.total;
      this.addDataPoint('interfaceDownRate', downRate, timestamp, deviceId);
    }
  }

  /**
   * 预测异常
   * Requirements: 5.2.1, 5.2.2, G5.16
   */
  async predict(deviceId: string = 'global', currentMetrics?: HealthMetrics): Promise<AnomalyPrediction[]> {
    if (!this.config.enabled) {
      return [];
    }

    // 如果 DataStore 可用，从 PostgreSQL 补充历史数据 (G5.16)
    if (this.pgDataStore) {
      await this.loadHistoricalDataFromPg(deviceId);
    }

    const predictions: AnomalyPrediction[] = [];
    const now = Date.now();

    // 如果提供了当前指标，先更新历史数据
    if (currentMetrics) {
      this.addDataPoint('cpu', currentMetrics.cpuUsage, now, deviceId);
      this.addDataPoint('memory', currentMetrics.memoryUsage, now, deviceId);
      this.addDataPoint('disk', currentMetrics.diskUsage, now, deviceId);
      this.addDataPoint('errorRate', currentMetrics.errorRate, now, deviceId);
    }

    // CPU 预测
    const cpuPrediction = this.predictMetric(
      'cpu',
      'cpu_spike',
      this.config.thresholds.cpuWarning,
      ['检查高 CPU 进程', '考虑扩容或优化'],
      deviceId
    );
    if (cpuPrediction) predictions.push(cpuPrediction);

    // 内存预测
    const memoryPrediction = this.predictMetric(
      'memory',
      'memory_exhaustion',
      this.config.thresholds.memoryWarning,
      ['检查内存泄漏', '清理缓存', '考虑增加内存'],
      deviceId
    );
    if (memoryPrediction) predictions.push(memoryPrediction);

    // 磁盘预测
    const diskPrediction = this.predictMetric(
      'disk',
      'disk_full',
      this.config.thresholds.diskWarning,
      ['清理日志文件', '删除临时文件', '扩展存储'],
      deviceId
    );
    if (diskPrediction) predictions.push(diskPrediction);

    // 错误率预测
    const errorPrediction = this.predictMetric(
      'errorRate',
      'error_rate_increase',
      this.config.thresholds.errorRateWarning,
      ['检查服务健康状态', '查看错误日志', '检查依赖服务'],
      deviceId
    );
    if (errorPrediction) predictions.push(errorPrediction);

    // 接口故障预测
    const interfacePrediction = this.predictMetric(
      'interfaceDownRate',
      'interface_failure',
      0.1, // 10% 接口离线
      ['检查网络连接', '检查接口配置', '检查物理连接'],
      deviceId
    );
    if (interfacePrediction) predictions.push(interfacePrediction);

    // EventBus 集成：高置信度预测作为 PerceptionEvent 发布 (G5.16)
    if (this.eventBus) {
      for (const prediction of predictions) {
        if (prediction.confidence > 0.7) {
          try {
            await this.eventBus.publish({
              type: 'internal',
              priority: prediction.type === 'disk_full' || prediction.type === 'memory_exhaustion' ? 'high' : 'medium',
              source: 'anomaly_predictor',
              deviceId: deviceId !== 'global' ? deviceId : undefined,
              payload: {
                eventSubType: 'anomaly_prediction',
                metric: prediction.type,
                predictedValue: prediction.predictedValue,
                confidence: prediction.confidence,
                timeToAnomaly: prediction.predictionWindow,
                currentValue: prediction.currentValue,
                threshold: prediction.threshold,
                trend: prediction.trend,
                suggestedActions: prediction.suggestedActions,
              },
              schemaVersion: '1.0.0',
            });
          } catch (err) {
            logger.warn('AnomalyPredictor: Failed to publish prediction to EventBus', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    logger.debug('Anomaly predictions generated', { count: predictions.length });
    return predictions;
  }

  /**
   * 从 PostgreSQL monitoring_snapshots 表加载历史数据补充内存 (G5.16)
   */
  private async loadHistoricalDataFromPg(deviceId: string): Promise<void> {
    if (!this.pgDataStore) return;

    const metricsToLoad = ['cpu', 'memory', 'disk', 'errorRate', 'interfaceDownRate'];
    const metricColumnMap: Record<string, string> = {
      cpu: 'cpu',
      memory: 'memory',
      disk: 'disk',
      errorRate: 'error_rate',
      interfaceDownRate: 'interface_down_rate',
    };

    for (const metric of metricsToLoad) {
      const key = `${deviceId}:${metric}`;
      const existingHistory = this.historyData.get(key);

      // Only load from PG if in-memory data is insufficient
      if (existingHistory && existingHistory.length >= 10) continue;

      try {
        const dbMetric = metricColumnMap[metric] || metric;
        const rows = await this.pgDataStore.query<{ value: number; created_at: string }>(
          `SELECT value, created_at FROM monitoring_snapshots
           WHERE device_id = $1 AND metric = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [deviceId === 'global' ? null : deviceId, dbMetric, this.config.historySize],
        );

        if (rows.length === 0) continue;

        // Merge PG data with in-memory data (PG data fills gaps)
        const pgPoints: DataPoint[] = rows.map(r => ({
          timestamp: new Date(r.created_at).getTime(),
          value: r.value,
        })).reverse(); // oldest first

        const existing = this.historyData.get(key) || [];
        const existingTimestamps = new Set(existing.map(p => p.timestamp));

        // Add PG points that don't overlap with in-memory data
        for (const point of pgPoints) {
          if (!existingTimestamps.has(point.timestamp)) {
            existing.push(point);
          }
        }

        // Sort by timestamp and trim to historySize
        existing.sort((a, b) => a.timestamp - b.timestamp);
        while (existing.length > this.config.historySize) {
          existing.shift();
        }

        this.historyData.set(key, existing);
        this.partitionLastUsed.set(key, Date.now());
      } catch (err) {
        logger.debug(`AnomalyPredictor: Failed to load historical data from PG for ${key}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * 预测单个指标
   */
  private predictMetric(
    metricName: string,
    predictionType: PredictionType,
    threshold: number,
    suggestedActions: string[],
    deviceId: string = 'global'
  ): AnomalyPrediction | null {
    const key = `${deviceId}:${metricName}`;
    const history = this.historyData.get(key);
    if (!history || history.length < 5) {
      return null; // 数据不足
    }

    const trend = this.analyzeTrend(history);
    const currentValue = history[history.length - 1].value;

    // 只有当趋势向上且预测值超过阈值时才生成预测
    if (trend.trend !== 'increasing' || trend.predictedValue <= threshold) {
      return null;
    }

    // 计算置信度
    const confidence = this.calculateConfidence(trend, currentValue, threshold);
    if (confidence < this.config.minConfidenceThreshold) {
      return null;
    }

    const now = Date.now();
    return {
      id: `pred_${++this.predictionIdCounter}_${now}`,
      type: predictionType,
      confidence,
      predictedAt: now + this.config.predictionWindow,
      predictionWindow: this.config.predictionWindow,
      currentValue,
      predictedValue: trend.predictedValue,
      threshold,
      trend: trend.trend,
      suggestedActions,
      createdAt: now,
    };
  }

  /**
   * 分析趋势（线性回归）
   * Requirements: 5.2.1
   */
  private analyzeTrend(history: DataPoint[]): TrendAnalysis {
    const n = history.length;
    if (n < 2) {
      return {
        slope: 0,
        intercept: history[0]?.value || 0,
        r2: 0,
        trend: 'stable',
        predictedValue: history[0]?.value || 0,
      };
    }

    // 归一化时间戳
    const startTime = history[0].timestamp;
    const points = history.map(p => ({
      x: (p.timestamp - startTime) / 1000, // 转换为秒
      y: p.value,
    }));

    // 计算线性回归
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumX2 += p.x * p.x;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // 计算 R²
    const yMean = sumY / n;
    let ssTotal = 0, ssResidual = 0;
    for (const p of points) {
      const predicted = slope * p.x + intercept;
      ssTotal += (p.y - yMean) ** 2;
      ssResidual += (p.y - predicted) ** 2;
    }
    const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

    // 预测未来值
    const futureX = (Date.now() - startTime + this.config.predictionWindow) / 1000;
    const predictedValue = slope * futureX + intercept;

    // 判断趋势
    let trend: 'increasing' | 'decreasing' | 'stable';
    const slopeThreshold = 0.001; // 每秒变化阈值
    if (slope > slopeThreshold) {
      trend = 'increasing';
    } else if (slope < -slopeThreshold) {
      trend = 'decreasing';
    } else {
      trend = 'stable';
    }

    return { slope, intercept, r2, trend, predictedValue };
  }

  /**
   * 计算预测置信度
   */
  private calculateConfidence(
    trend: TrendAnalysis,
    currentValue: number,
    threshold: number
  ): number {
    // 基础置信度来自 R²
    let confidence = Math.max(0, trend.r2);

    // 如果当前值已经接近阈值，提高置信度
    const proximity = currentValue / threshold;
    if (proximity > 0.8) {
      confidence = Math.min(1, confidence + 0.2);
    }

    // 如果斜率很陡，提高置信度
    if (Math.abs(trend.slope) > 0.01) {
      confidence = Math.min(1, confidence + 0.1);
    }

    return Math.round(confidence * 100) / 100;
  }

  /**
   * 获取历史数据
   */
  getHistory(metric: string): DataPoint[] {
    return [...(this.historyData.get(metric) || [])];
  }

  /**
   * 清除历史数据
   */
  clearHistory(metric?: string): void {
    if (metric) {
      this.historyData.delete(metric);
    } else {
      this.historyData.clear();
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AnomalyPredictorConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('AnomalyPredictor config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): AnomalyPredictorConfig {
    return { ...this.config };
  }
}

// 导出单例实例
export const anomalyPredictor = new AnomalyPredictor();
