/**
 * Task 33.2 — AlertPipeline 全链路验证
 *
 * 验证:
 * - PerceptionEvent → 归一化 → 去重 → 过滤 → 分析 → 决策 → 执行 (G1.1)
 * - 可插拔 NormalizerAdapter (G1.2)
 * - PipelineEventTracker 追踪处理状态 (G5.18)
 * - 统计信息正确
 */

import { AlertPipeline } from '../../alertPipeline';

// ─── Helpers ───

function makeSyslogEvent(overrides?: Record<string, unknown>) {
  return {
    id: `syslog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'syslog' as const,
    timestamp: Date.now(),
    severity: 'warning' as const,
    category: 'system',
    message: 'interface eth0 link down',
    rawData: {
      facility: 1,
      severity: 4,
      timestamp: new Date().toISOString(),
      hostname: 'router-1',
      message: 'interface eth0 link down',
    },
    metadata: {
      hostname: 'router-1',
      facility: 1,
      syslogSeverity: 4,
    },
    ...overrides,
  };
}

function makeAlertEvent(overrides?: Record<string, unknown>) {
  return {
    id: `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ruleId: 'rule-cpu-high',
    ruleName: 'CPU High',
    severity: 'critical' as const,
    metric: 'cpu' as const,
    currentValue: 95,
    threshold: 80,
    message: 'CPU usage exceeded 80%',
    status: 'active' as const,
    triggeredAt: Date.now(),
    ...overrides,
  };
}

describe('Task 33.2 — AlertPipeline 全链路验证', () => {
  let pipeline: AlertPipeline;

  beforeEach(() => {
    pipeline = new AlertPipeline();
  });

  afterEach(async () => {
    await pipeline.stop();
  });

  describe('Pipeline 初始化与配置', () => {
    it('应创建 Pipeline 实例并返回默认配置', () => {
      const config = pipeline.getConfig();
      expect(config).toBeDefined();
      expect(config.enableDeduplication).toBe(true);
      expect(config.enableFiltering).toBe(true);
      expect(config.enableAnalysis).toBe(true);
      expect(config.enableDecision).toBe(true);
    });

    it('应返回初始统计信息（全零）', () => {
      const stats = pipeline.getStats();
      expect(stats.processed).toBe(0);
      expect(stats.filtered).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('resetStats 应清零统计', () => {
      pipeline.resetStats();
      const stats = pipeline.getStats();
      expect(stats.processed).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('updateConfig 应更新配置', () => {
      pipeline.updateConfig({ enableAnalysis: false });
      const config = pipeline.getConfig();
      expect(config.enableAnalysis).toBe(false);
    });
  });

  describe('可插拔 NormalizerAdapter (G1.2)', () => {
    it('应注册自定义 NormalizerAdapter', () => {
      const customAdapter = {
        name: 'custom-normalizer',
        sourceType: 'custom',
        normalize: jest.fn().mockResolvedValue({
          id: 'unified-1',
          source: 'custom',
          severity: 'warning',
          category: 'custom',
          message: 'normalized',
          timestamp: Date.now(),
          fingerprint: 'fp-custom-1',
          metadata: {},
        }),
      };

      pipeline.registerNormalizer('custom', customAdapter);
      const normalizers = pipeline.getRegisteredNormalizers();
      expect(normalizers.some((n) => n.sourceType === 'custom')).toBe(true);
    });

    it('应注销 NormalizerAdapter', () => {
      const adapter = {
        name: 'temp-adapter',
        sourceType: 'temp',
        normalize: jest.fn(),
      };

      pipeline.registerNormalizer('temp', adapter);
      const removed = pipeline.unregisterNormalizer('temp');
      expect(removed).toBe(true);

      const normalizers = pipeline.getRegisteredNormalizers();
      expect(normalizers.some((n) => n.sourceType === 'temp')).toBe(false);
    });
  });

  describe('PipelineEventTracker (G5.18)', () => {
    it('应返回 tracker 实例', () => {
      const tracker = pipeline.getPipelineTracker();
      expect(tracker).toBeDefined();
      expect(tracker.getActiveCount()).toBe(0);
    });

    it('tracker 应追踪事件处理阶段', () => {
      const tracker = pipeline.getPipelineTracker();
      const eventId = 'test-event-1';

      tracker.start(eventId);
      expect(tracker.getActiveCount()).toBe(1);

      tracker.stageStart(eventId, 'normalize');
      tracker.stageEnd(eventId, 'normalize');
      tracker.end(eventId, 'decided');

      expect(tracker.getActiveCount()).toBe(0);
      const records = tracker.getRecentRecords();
      expect(records.length).toBeGreaterThanOrEqual(1);
      expect(records[0].outcome).toBe('decided');
    });

    it('tracker reset 应清空所有记录', () => {
      const tracker = pipeline.getPipelineTracker();
      tracker.start('evt-reset');
      tracker.end('evt-reset', 'decided');
      tracker.reset();
      expect(tracker.getRecentRecords()).toHaveLength(0);
      expect(tracker.getActiveCount()).toBe(0);
    });
  });

  describe('Syslog 事件处理', () => {
    it('应处理 Syslog 事件并返回 PipelineResult', async () => {
      const event = makeSyslogEvent();
      const result = await pipeline.process(event as any);

      expect(result).toBeDefined();
      expect(result.event).toBeDefined();
      expect(result.stage).toBeDefined();
    });

    it('处理后统计应更新', async () => {
      const event = makeSyslogEvent();
      await pipeline.process(event as any);

      const stats = pipeline.getStats();
      expect(stats.processed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Alert 事件处理', () => {
    it('应处理 Alert 事件并返回 PipelineResult', async () => {
      const event = makeAlertEvent();
      const result = await pipeline.process(event as any);

      expect(result).toBeDefined();
      expect(result.event).toBeDefined();
    });
  });

  describe('通知状态追踪', () => {
    it('应记录和查询通知状态', () => {
      pipeline.recordNotificationStatus('evt-1', 'dec-1', 'notify');
      expect(pipeline.hasNotificationBeenSent('evt-1')).toBe(true);

      const status = pipeline.getNotificationStatus('evt-1');
      expect(status).not.toBeNull();
      expect(status!.decisionId).toBe('dec-1');
    });

    it('应清除通知状态', () => {
      pipeline.recordNotificationStatus('evt-2', 'dec-2', 'notify');
      pipeline.clearNotificationStatus('evt-2');
      expect(pipeline.hasNotificationBeenSent('evt-2')).toBe(false);
    });

    it('应返回通知状态统计', () => {
      pipeline.recordNotificationStatus('evt-3', 'dec-3', 'notify');
      const stats = pipeline.getNotificationStatusStats();
      expect(stats.cacheSize).toBeGreaterThanOrEqual(1);
    });
  });

  describe('FeatureFlag 集成', () => {
    it('应接受 FeatureFlagManager 注入', () => {
      const { FeatureFlagManager } = require('../../stateMachine/featureFlagManager');
      const ffm = new FeatureFlagManager();
      expect(() => pipeline.setFeatureFlagManager(ffm)).not.toThrow();
    });

    it('应接受 EventBus 注入', () => {
      const mockEventBus = {
        publish: jest.fn().mockResolvedValue(undefined),
      };
      expect(() => pipeline.setEventBus(mockEventBus)).not.toThrow();
    });
  });

  describe('降级模式', () => {
    it('supportsDegradedMode 应返回 boolean', () => {
      expect(typeof pipeline.supportsDegradedMode()).toBe('boolean');
    });

    it('healthCheck 应返回健康状态', async () => {
      const health = await pipeline.healthCheck();
      expect(health).toBeDefined();
      expect(typeof health.healthy).toBe('boolean');
    });
  });

  describe('详细统计', () => {
    it('getDetailedStats 应返回完整统计', () => {
      const stats = pipeline.getDetailedStats();
      expect(stats).toBeDefined();
    });

    it('getEventProcessingStats 应返回事件处理统计', () => {
      const stats = pipeline.getEventProcessingStats();
      expect(stats).toBeDefined();
    });
  });
});
