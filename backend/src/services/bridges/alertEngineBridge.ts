/**
 * AlertEngine → EventBus 桥接
 *
 * 将 AlertEngine 触发的告警事件转换为 PerceptionEvent 注入 EventBus。
 * 作为内部告警感知源 (D1.5)。
 *
 * 工作方式：
 * - 注册为 EventBus 感知源
 * - 监听 AlertEngine 的 preprocessedEvent 回调
 * - 将 UnifiedEvent / CompositeEvent 转换为 type='alert' 的 PerceptionEvent
 */

import { logger } from '../../utils/logger';
import type { EventBus, Priority } from '../eventBus';
import type { AlertEngine } from '../ai-ops/alertEngine';
import type { UnifiedEvent, CompositeEvent, AlertSeverity } from '../../types/ai-ops';

export interface AlertEngineBridgeConfig {
  /** 是否启用，默认 true */
  enabled: boolean;
}

const DEFAULT_CONFIG: AlertEngineBridgeConfig = {
  enabled: true,
};

export class AlertEngineBridge {
  private readonly eventBus: EventBus;
  private readonly alertEngine: AlertEngine;
  private readonly config: AlertEngineBridgeConfig;
  private handler: ((event: UnifiedEvent | CompositeEvent) => void) | null = null;
  private started = false;

  constructor(
    eventBus: EventBus,
    alertEngine: AlertEngine,
    config?: Partial<AlertEngineBridgeConfig>,
  ) {
    this.eventBus = eventBus;
    this.alertEngine = alertEngine;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动桥接：注册感知源并监听 AlertEngine 事件
   */
  start(): void {
    if (this.started) return;
    if (!this.config.enabled) {
      logger.debug('[AlertEngineBridge] Disabled, skipping start');
      return;
    }

    // 注册为 EventBus 感知源 (D1.2)
    this.eventBus.registerSource({
      name: 'alert-engine-bridge',
      eventTypes: ['alert'],
      schemaVersion: '1.0.0',
    });

    // 监听 AlertEngine 的预处理事件回调
    this.handler = (event: UnifiedEvent | CompositeEvent) => {
      this.onPreprocessedEvent(event).catch((err) => {
        logger.warn('[AlertEngineBridge] Failed to publish alert event to EventBus', { error: err });
      });
    };

    this.alertEngine.onPreprocessedEvent(this.handler);
    this.started = true;
    logger.info('[AlertEngineBridge] Started');
  }

  /**
   * 停止桥接：取消监听
   */
  stop(): void {
    if (!this.started) return;
    if (this.handler) {
      this.alertEngine.offPreprocessedEvent(this.handler);
      this.handler = null;
    }
    this.started = false;
    logger.info('[AlertEngineBridge] Stopped');
  }

  // ─── 内部方法 ───

  private async onPreprocessedEvent(event: UnifiedEvent | CompositeEvent): Promise<void> {
    await this.publishAlertEvent(event);
  }

  private async publishAlertEvent(event: UnifiedEvent | CompositeEvent): Promise<void> {
    const priority = this.severityToPriority(event.severity);
    const isComposite = 'isComposite' in event && (event as CompositeEvent).isComposite;

    // 从 UnifiedEvent 的嵌套结构中提取字段
    const payload: Record<string, unknown> = {
      unifiedEventId: event.id,
      source: event.source,
      category: event.category,
      severity: event.severity,
      message: event.message,
      metadata: event.metadata,
    };

    // 告警规则信息（如果存在）
    if (event.alertRuleInfo) {
      payload.ruleId = event.alertRuleInfo.ruleId;
      payload.ruleName = event.alertRuleInfo.ruleName;
      payload.metric = event.alertRuleInfo.metric;
      payload.threshold = event.alertRuleInfo.threshold;
      payload.currentValue = event.alertRuleInfo.currentValue;
    }

    // 设备信息（如果存在）
    if (event.deviceInfo) {
      payload.deviceName = event.deviceInfo.hostname;
      payload.deviceIp = event.deviceInfo.ip;
    }

    // 复合事件聚合信息
    if (isComposite) {
      const composite = event as CompositeEvent;
      payload.isComposite = true;
      payload.childEvents = composite.childEvents;
      payload.aggregation = composite.aggregation;
    }

    await this.eventBus.publish({
      type: 'alert',
      priority,
      source: 'alert-engine-bridge',
      deviceId: event.deviceId,
      payload,
      schemaVersion: '1.0.0',
    });
  }

  private severityToPriority(severity: AlertSeverity | string): Priority {
    switch (severity) {
      case 'critical': return 'critical';
      case 'warning': return 'medium';
      case 'info': return 'info';
      default: return 'medium';
    }
  }
}
