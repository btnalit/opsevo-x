/**
 * HealthMonitor → EventBus 桥接
 *
 * 将 HealthMonitor 的指标采集结果转换为 PerceptionEvent 注入 EventBus。
 * 作为内部指标采集器感知源 (D1.5)。
 *
 * 工作方式：
 * - 注册为 EventBus 感知源
 * - 定期从 HealthMonitor 获取最新快照
 * - 将 HealthMetrics 转换为 type='metric' 的 PerceptionEvent
 * - 当健康评分低于阈值时，生成 type='internal' 的告警事件
 */

import { logger } from '../../utils/logger';
import type { EventBus, Priority } from '../eventBus';
import type { HealthMonitor, HealthMetrics, HealthScore } from '../ai-ops/healthMonitor';

export interface HealthMonitorBridgeConfig {
  /** 采集间隔（毫秒），默认 60000 (60s) */
  collectIntervalMs: number;
  /** 健康评分低于此阈值时生成 internal 告警事件，默认 60 */
  alertScoreThreshold: number;
  /** 是否启用，默认 true */
  enabled: boolean;
}

const DEFAULT_CONFIG: HealthMonitorBridgeConfig = {
  collectIntervalMs: 60_000,
  alertScoreThreshold: 60,
  enabled: true,
};

export class HealthMonitorBridge {
  private readonly eventBus: EventBus;
  private readonly healthMonitor: HealthMonitor;
  private readonly config: HealthMonitorBridgeConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    eventBus: EventBus,
    healthMonitor: HealthMonitor,
    config?: Partial<HealthMonitorBridgeConfig>,
  ) {
    this.eventBus = eventBus;
    this.healthMonitor = healthMonitor;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动桥接：注册感知源并开始定期采集
   */
  start(): void {
    if (this.running) return;
    if (!this.config.enabled) {
      logger.debug('[HealthMonitorBridge] Disabled, skipping start');
      return;
    }

    // 注册为 EventBus 感知源 (D1.2)
    this.eventBus.registerSource({
      name: 'health-monitor-bridge',
      eventTypes: ['metric', 'internal'],
      schemaVersion: '1.0.0',
    });

    this.running = true;
    this.scheduleNext();
    logger.info('[HealthMonitorBridge] Started');
  }

  /**
   * 停止桥接
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('[HealthMonitorBridge] Stopped');
  }

  /**
   * 手动触发一次采集并发布到 EventBus
   */
  async publishOnce(deviceId?: string): Promise<void> {
    try {
      const metrics = await this.healthMonitor.collectMetrics();
      const score = this.healthMonitor.calculateScore(metrics);
      await this.publishMetricEvent(metrics, score, deviceId);

      // 健康评分低于阈值时，额外发布 internal 告警
      if (score.overall < this.config.alertScoreThreshold) {
        await this.publishHealthAlertEvent(metrics, score, deviceId);
      }
    } catch (error) {
      logger.warn('[HealthMonitorBridge] Failed to publish metrics', { error });
    }
  }

  // ─── 内部方法 ───

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.publishOnce();
      this.scheduleNext();
    }, this.config.collectIntervalMs);
  }

  private async publishMetricEvent(
    metrics: HealthMetrics,
    score: HealthScore,
    deviceId?: string,
  ): Promise<void> {
    const priority = this.scoreToPriority(score.overall);

    await this.eventBus.publish({
      type: 'metric',
      priority,
      source: 'health-monitor-bridge',
      deviceId,
      payload: {
        cpuUsage: metrics.cpuUsage,
        memoryUsage: metrics.memoryUsage,
        diskUsage: metrics.diskUsage,
        interfaceStatus: metrics.interfaceStatus,
        activeConnections: metrics.activeConnections,
        errorRate: metrics.errorRate,
        avgResponseTime: metrics.avgResponseTime,
        score: score.overall,
        level: score.level,
      },
      schemaVersion: '1.0.0',
    });
  }

  private async publishHealthAlertEvent(
    metrics: HealthMetrics,
    score: HealthScore,
    deviceId?: string,
  ): Promise<void> {
    const priority = score.overall < 30 ? 'critical' as Priority
      : score.overall < 50 ? 'high' as Priority
      : 'medium' as Priority;

    await this.eventBus.publish({
      type: 'internal',
      priority,
      source: 'health-monitor-bridge',
      deviceId,
      payload: {
        alertType: 'low_health_score',
        score: score.overall,
        level: score.level,
        cpuUsage: metrics.cpuUsage,
        memoryUsage: metrics.memoryUsage,
        diskUsage: metrics.diskUsage,
      },
      schemaVersion: '1.0.0',
    });
  }

  private scoreToPriority(score: number): Priority {
    if (score >= 80) return 'info';
    if (score >= 60) return 'low';
    if (score >= 40) return 'medium';
    if (score >= 20) return 'high';
    return 'critical';
  }
}
