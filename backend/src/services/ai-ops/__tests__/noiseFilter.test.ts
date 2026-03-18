/**
 * NoiseFilter 四层噪声过滤 单元测试
 *
 * Requirements: G2.5, G2.6, PG.3, PG.4
 */

import { NoiseFilter } from '../noiseFilter';
import { UnifiedEvent, MaintenanceWindow } from '../../../types/ai-ops';

// ─── 辅助函数 ───

function makeEvent(overrides: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: 'metrics',
    timestamp: Date.now(),
    severity: 'warning',
    category: 'cpu',
    message: 'CPU usage high',
    rawData: {},
    metadata: {},
    deviceId: 'device-1',
    ...overrides,
  };
}

function makeMaintenanceWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  const now = Date.now();
  return {
    id: 'mw-1',
    name: 'Test Maintenance',
    startTime: now - 60000,
    endTime: now + 60000,
    resources: [],
    ...overrides,
  };
}

// ─── 测试 ───

describe('NoiseFilter (four-layer architecture)', () => {
  let filter: NoiseFilter;

  beforeEach(async () => {
    filter = new NoiseFilter({
      jitterWindowMs: 5000,
      jitterThreshold: 3,
      correlationWindowMs: 60000,
      statsIntervalMs: 999999, // 不自动发布
    });
    await filter.initialize();
  });

  afterEach(() => {
    filter.stopCleanupTimer();
  });


  // ══════════════════════════════════════════════════════════
  // Layer 1: 维护窗口过滤 (PG.3)
  // ══════════════════════════════════════════════════════════

  describe('Layer 1: Maintenance Window', () => {
    it('should filter non-critical events during maintenance window', async () => {
      filter.addMaintenanceWindow(makeMaintenanceWindow());

      const event = makeEvent({ severity: 'warning' });
      const result = await filter.filter(event);

      expect(result.filtered).toBe(true);
      expect(result.reason).toBe('maintenance_window');
      expect(result.layer).toBe(1);
    });

    it('should pass critical events through maintenance window (PG.3)', async () => {
      filter.addMaintenanceWindow(makeMaintenanceWindow());

      const event = makeEvent({ severity: 'critical' });
      const result = await filter.filter(event);

      expect(result.filtered).toBe(false);
    });

    it('should pass info events when no maintenance window is active', async () => {
      const event = makeEvent({ severity: 'info' });
      const result = await filter.filter(event);

      expect(result.filtered).toBe(false);
    });

    it('should not filter when maintenance window has expired', async () => {
      const now = Date.now();
      filter.addMaintenanceWindow(
        makeMaintenanceWindow({
          startTime: now - 120000,
          endTime: now - 60000, // expired
        })
      );

      const event = makeEvent({ severity: 'warning' });
      const result = await filter.filter(event);

      expect(result.filtered).toBe(false);
    });

    it('should filter only matching device in maintenance window', async () => {
      filter.addMaintenanceWindow(
        makeMaintenanceWindow({ deviceId: 'device-A' })
      );

      const eventA = makeEvent({ deviceId: 'device-A', severity: 'warning' });
      const eventB = makeEvent({ deviceId: 'device-B', severity: 'warning' });

      expect((await filter.filter(eventA)).filtered).toBe(true);
      expect((await filter.filter(eventB)).filtered).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Layer 2: 抖动检测 (PG.4)
  // ══════════════════════════════════════════════════════════

  describe('Layer 2: Jitter Detection', () => {
    it('should not filter when below jitter threshold', async () => {
      const now = Date.now();
      // Send 2 events (threshold is 3) — use unique deviceIds to avoid correlation
      const r1 = await filter.filter(makeEvent({ timestamp: now, category: 'interface', deviceId: 'jitter-solo-1' }));
      const r2 = await filter.filter(makeEvent({ timestamp: now + 100, category: 'interface', deviceId: 'jitter-solo-2' }));

      expect(r1.filtered).toBe(false);
      expect(r2.filtered).toBe(false);
    });

    it('should aggregate when frequency exceeds threshold (PG.4)', async () => {
      const now = Date.now();
      // Send 3 events from same source within window (threshold = 3)
      await filter.filter(makeEvent({ timestamp: now, category: 'interface', deviceId: 'dev-1' }));
      await filter.filter(makeEvent({ timestamp: now + 100, category: 'interface', deviceId: 'dev-1' }));
      const r3 = await filter.filter(makeEvent({ timestamp: now + 200, category: 'interface', deviceId: 'dev-1' }));

      expect(r3.filtered).toBe(true);
      expect(r3.reason).toBe('jitter_aggregated');
      expect(r3.layer).toBe(2);
    });

    it('should track different sources independently', async () => {
      const now = Date.now();
      // 3 events from source A (same device + category)
      await filter.filter(makeEvent({ timestamp: now, category: 'cpu', deviceId: 'dev-indep-A' }));
      await filter.filter(makeEvent({ timestamp: now + 100, category: 'cpu', deviceId: 'dev-indep-A' }));
      const rA = await filter.filter(makeEvent({ timestamp: now + 200, category: 'cpu', deviceId: 'dev-indep-A' }));

      // 1 event from completely different device — should not trigger jitter
      const rB = await filter.filter(makeEvent({ timestamp: now + 300, category: 'disk', deviceId: 'dev-indep-B' }));

      expect(rA.filtered).toBe(true);
      expect(rA.reason).toBe('jitter_aggregated');
      expect(rB.filtered).toBe(false);
    });

    it('should work with any event category, not just interface', async () => {
      const now = Date.now();
      await filter.filter(makeEvent({ timestamp: now, category: 'routing', deviceId: 'dev-2' }));
      await filter.filter(makeEvent({ timestamp: now + 50, category: 'routing', deviceId: 'dev-2' }));
      const r3 = await filter.filter(makeEvent({ timestamp: now + 100, category: 'routing', deviceId: 'dev-2' }));

      expect(r3.filtered).toBe(true);
      expect(r3.reason).toBe('jitter_aggregated');
      expect(r3.layer).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Layer 3: 关联分析
  // ══════════════════════════════════════════════════════════

  describe('Layer 3: Correlation Analysis', () => {
    it('should not correlate first event from a device', async () => {
      const result = await filter.filter(
        makeEvent({ category: 'interface', deviceId: 'dev-3' })
      );
      expect(result.filtered).toBe(false);
    });

    it('should correlate related categories from same device', async () => {
      const now = Date.now();
      // First event creates a group
      await filter.filter(makeEvent({ timestamp: now, category: 'interface', deviceId: 'dev-3' }));
      // Second event with related category should be correlated
      const r2 = await filter.filter(
        makeEvent({ timestamp: now + 1000, category: 'routing', deviceId: 'dev-3' })
      );

      expect(r2.filtered).toBe(true);
      expect(r2.reason).toBe('correlated');
      expect(r2.layer).toBe(3);
    });

    it('should not correlate unrelated categories', async () => {
      const now = Date.now();
      await filter.filter(makeEvent({ timestamp: now, category: 'interface', deviceId: 'dev-4' }));
      const r2 = await filter.filter(
        makeEvent({ timestamp: now + 1000, category: 'disk', deviceId: 'dev-4' })
      );

      // 'interface' and 'disk' are not related
      expect(r2.filtered).toBe(false);
    });

    it('should not correlate events from different devices', async () => {
      const now = Date.now();
      await filter.filter(makeEvent({ timestamp: now, category: 'cpu', deviceId: 'dev-5' }));
      const r2 = await filter.filter(
        makeEvent({ timestamp: now + 1000, category: 'memory', deviceId: 'dev-6' })
      );

      expect(r2.filtered).toBe(false);
    });

    it('should not correlate events without deviceId', async () => {
      const now = Date.now();
      await filter.filter(makeEvent({ timestamp: now, category: 'cpu', deviceId: undefined }));
      const r2 = await filter.filter(
        makeEvent({ timestamp: now + 1000, category: 'memory', deviceId: undefined })
      );

      expect(r2.filtered).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Layer 4: 优先级过滤（动态阈值）
  // ══════════════════════════════════════════════════════════

  describe('Layer 4: Load-based Filtering', () => {
    it('should not filter anything under normal load', async () => {
      filter.updateLoadLevel('normal');
      const result = await filter.filter(makeEvent({ severity: 'info' }));
      expect(result.filtered).toBe(false);
    });

    it('should filter info events under high load', async () => {
      filter.updateLoadLevel('high');
      const result = await filter.filter(makeEvent({ severity: 'info' }));

      expect(result.filtered).toBe(true);
      expect(result.reason).toBe('load_filtered');
      expect(result.layer).toBe(4);
    });

    it('should not filter warning events under high load', async () => {
      filter.updateLoadLevel('high');
      const result = await filter.filter(makeEvent({ severity: 'warning' }));
      expect(result.filtered).toBe(false);
    });

    it('should filter info and warning events under critical load', async () => {
      filter.updateLoadLevel('critical');

      // Use unique deviceIds to avoid correlation triggering before Layer 4
      const rInfo = await filter.filter(makeEvent({ severity: 'info', deviceId: 'load-dev-1' }));
      const rWarn = await filter.filter(makeEvent({ severity: 'warning', deviceId: 'load-dev-2' }));
      const rCrit = await filter.filter(makeEvent({ severity: 'critical', deviceId: 'load-dev-3' }));

      expect(rInfo.filtered).toBe(true);
      expect(rInfo.reason).toBe('load_filtered');
      expect(rWarn.filtered).toBe(true);
      expect(rWarn.reason).toBe('load_filtered');
      expect(rCrit.filtered).toBe(false);
    });

    it('should auto-adjust load level based on queue depth', () => {
      filter.setEventQueueDepth(100);
      expect(filter.getLoadLevel()).toBe('normal');

      filter.setEventQueueDepth(600);
      expect(filter.getLoadLevel()).toBe('high');

      filter.setEventQueueDepth(1500);
      expect(filter.getLoadLevel()).toBe('critical');
    });
  });


  // ══════════════════════════════════════════════════════════
  // Layer ordering
  // ══════════════════════════════════════════════════════════

  describe('Layer Ordering', () => {
    it('should check maintenance window (L1) before jitter (L2)', async () => {
      const now = Date.now();
      filter.addMaintenanceWindow(makeMaintenanceWindow());

      // Send enough events to trigger jitter
      await filter.filter(makeEvent({ timestamp: now, severity: 'warning', category: 'cpu', deviceId: 'dev-1' }));
      await filter.filter(makeEvent({ timestamp: now + 50, severity: 'warning', category: 'cpu', deviceId: 'dev-1' }));
      const r3 = await filter.filter(
        makeEvent({ timestamp: now + 100, severity: 'warning', category: 'cpu', deviceId: 'dev-1' })
      );

      // Should be caught by Layer 1 (maintenance), not Layer 2 (jitter)
      expect(r3.filtered).toBe(true);
      expect(r3.layer).toBe(1);
      expect(r3.reason).toBe('maintenance_window');
    });

    it('should check jitter (L2) before correlation (L3)', async () => {
      const now = Date.now();
      // Create a correlation group first
      await filter.filter(makeEvent({ timestamp: now, category: 'interface', deviceId: 'dev-7' }));

      // Now send enough related events to trigger both jitter and correlation
      await filter.filter(makeEvent({ timestamp: now + 50, category: 'interface', deviceId: 'dev-7' }));
      const r3 = await filter.filter(
        makeEvent({ timestamp: now + 100, category: 'interface', deviceId: 'dev-7' })
      );

      // Should be caught by Layer 2 (jitter), not Layer 3 (correlation)
      expect(r3.filtered).toBe(true);
      expect(r3.layer).toBe(2);
      expect(r3.reason).toBe('jitter_aggregated');
    });
  });

  // ══════════════════════════════════════════════════════════
  // Stats & EventBus (G2.6)
  // ══════════════════════════════════════════════════════════

  describe('Stats & EventBus Publishing (G2.6)', () => {
    it('should track per-layer filter counts', async () => {
      // Trigger Layer 1
      filter.addMaintenanceWindow(makeMaintenanceWindow());
      await filter.filter(makeEvent({ severity: 'warning', deviceId: 'stats-dev-1' }));

      // Remove maintenance window before testing Layer 4
      filter.removeMaintenanceWindow('mw-1');

      // Trigger Layer 4 — use unique device to avoid correlation
      filter.updateLoadLevel('high');
      await filter.filter(makeEvent({ severity: 'info', deviceId: 'stats-dev-2' }));

      const stats = filter.getFilterStats();
      expect(stats.totalProcessed).toBe(2);
      expect(stats.totalFiltered).toBe(2);
      expect(stats.layerCounts[0]).toBe(1); // L1
      expect(stats.layerCounts[3]).toBe(1); // L4
    });

    it('should publish stats to EventBus when set', async () => {
      const published: any[] = [];
      const mockEventBus = {
        publish: jest.fn().mockImplementation(async (event: any) => {
          published.push(event);
          return event;
        }),
      };

      filter.setEventBus(mockEventBus);

      // Trigger some filtering
      filter.addMaintenanceWindow(makeMaintenanceWindow());
      await filter.filter(makeEvent({ severity: 'warning' }));

      // Manually trigger stats publish (normally on timer)
      (filter as any).publishStats();

      // Wait for async publish
      await new Promise((r) => setTimeout(r, 50));

      expect(mockEventBus.publish).toHaveBeenCalled();
      const payload = published[0]?.payload;
      expect(payload?.event).toBe('noise_filter_stats');
      expect(payload?.stats?.totalProcessed).toBe(1);
      expect(payload?.stats?.totalFiltered).toBe(1);
      expect(payload?.stats?.layerCounts?.layer1_maintenance).toBe(1);
      expect(typeof payload?.stats?.filterRate).toBe('number');
    });

    it('should not throw when EventBus is not set', () => {
      // publishStats should silently skip
      expect(() => (filter as any).publishStats()).not.toThrow();
    });

    it('should reset stats', async () => {
      await filter.filter(makeEvent());
      filter.resetStats();
      const stats = filter.getFilterStats();
      expect(stats.totalProcessed).toBe(0);
      expect(stats.totalFiltered).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Backward Compatibility — CRUD methods
  // ══════════════════════════════════════════════════════════

  describe('Backward Compatibility', () => {
    it('should support maintenance window CRUD', async () => {
      const mw = await filter.createMaintenanceWindow({
        name: 'Test MW',
        startTime: Date.now(),
        endTime: Date.now() + 3600000,
        resources: ['cpu'],
      });
      expect(mw.id).toBeDefined();
      expect(mw.name).toBe('Test MW');

      const updated = await filter.updateMaintenanceWindow(mw.id, { name: 'Updated MW' });
      expect(updated.name).toBe('Updated MW');

      expect(filter.getMaintenanceWindows()).toHaveLength(1);

      filter.removeMaintenanceWindow(mw.id);
      expect(filter.getMaintenanceWindows()).toHaveLength(0);
    });

    it('should support known issue CRUD', async () => {
      const issue = await filter.createKnownIssue({
        pattern: 'test.*pattern',
        description: 'Test issue',
        autoResolve: false,
      });
      expect(issue.id).toBeDefined();

      const updated = await filter.updateKnownIssue(issue.id, { description: 'Updated' });
      expect(updated.description).toBe('Updated');

      expect(filter.getKnownIssues()).toHaveLength(1);

      filter.removeKnownIssue(issue.id);
      expect(filter.getKnownIssues()).toHaveLength(0);
    });

    it('should support matchesKnownIssue', () => {
      filter.addKnownIssue({
        id: 'ki-1',
        pattern: 'DNS.*timeout',
        description: 'Known DNS issue',
        autoResolve: false,
      });

      const match = filter.matchesKnownIssue(makeEvent({ message: 'DNS query timeout detected' }));
      expect(match).not.toBeNull();
      expect(match?.id).toBe('ki-1');

      const noMatch = filter.matchesKnownIssue(makeEvent({ message: 'CPU high' }));
      expect(noMatch).toBeNull();
    });

    it('should support feedback recording', () => {
      filter.recordFeedback({
        alertId: 'alert-1',
        filterResult: { filtered: true, reason: 'maintenance_window' },
        userFeedback: 'false_positive',
      });

      const stats = filter.getFeedbackStats();
      expect(stats.total).toBe(1);
      expect(stats.falsePositives).toBe(1);
    });

    it('should support getStats()', () => {
      filter.addMaintenanceWindow(makeMaintenanceWindow());
      filter.addKnownIssue({
        id: 'ki-2',
        pattern: 'test',
        description: 'test',
        autoResolve: false,
      });

      const stats = filter.getStats();
      expect(stats.maintenanceWindowsCount).toBe(1);
      expect(stats.knownIssuesCount).toBe(1);
      expect(stats.feedbackStats).toBeDefined();
    });

    it('should support clearAll()', async () => {
      filter.addMaintenanceWindow(makeMaintenanceWindow());
      filter.addKnownIssue({
        id: 'ki-3',
        pattern: 'test',
        description: 'test',
        autoResolve: false,
      });

      await filter.clearAll();

      expect(filter.getMaintenanceWindows()).toHaveLength(0);
      expect(filter.getKnownIssues()).toHaveLength(0);
      expect(filter.getFilterStats().totalProcessed).toBe(0);
    });
  });
});
