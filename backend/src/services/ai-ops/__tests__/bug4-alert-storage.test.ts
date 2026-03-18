/**
 * Bug 4: 告警事件混合存储交叉读取 — 单元测试
 * 
 * 验证:
 * - 仅存在于文件中的 Syslog 事件能被正确找到和删除
 * - 超过 30 天的历史事件能被正确找到
 * - Syslog 转换事件的状态判断正确
 * - 批量删除返回详细错误信息
 * - SQLite 正常事件的查询和删除不受影响（保持检查）
 */

import fs from 'fs/promises';

// Mock 所有外部依赖
jest.mock('../../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../auditLogger', () => ({
  auditLogger: { log: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../notificationService', () => ({
  notificationService: { send: jest.fn() },
}));
jest.mock('../../serviceRegistry', () => ({
  serviceRegistry: { get: jest.fn(), tryGet: jest.fn().mockReturnValue(null) },
}));
jest.mock('../metricsCollector', () => ({
  metricsCollector: { collect: jest.fn() },
}));
jest.mock('../fingerprintCache', () => ({
  fingerprintCache: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('../alertPreprocessor', () => ({
  alertPreprocessor: { process: jest.fn() },
}));
jest.mock('../alertPipeline', () => ({
  alertPipeline: { process: jest.fn() },
}));
jest.mock('../rag', () => ({
  knowledgeBase: { search: jest.fn(), initialize: jest.fn() },
}));
jest.mock('../concurrencyController');
jest.mock('../../core/lruCache');
jest.mock('fs/promises');
jest.mock('uuid', () => ({ v4: jest.fn().mockReturnValue('test-uuid') }));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('Bug 4: 告警事件混合存储交叉读取', () => {
  let AlertEngine: any;
  let engine: any;

  beforeAll(async () => {
    const mod = await import('../alertEngine');
    AlertEngine = mod.AlertEngine;
  });

  afterAll(() => {
    // 清理模块级单例可能启动的 timer
    // fingerprintCache, alertPreprocessor 等在模块加载时创建 setInterval
    // 这些 timer 跨测试文件共享，无法在单个测试中完全清理
    // --forceExit 会处理剩余的 open handles
  });

  beforeEach(() => {
    engine = new AlertEngine();
    // 跳过初始化
    (engine as any).initialized = true;
    (engine as any)._dataStoreLoadedOnInit = true;
    (engine as any).activeAlerts = new Map();
    (engine as any).eventsCache = null;
    (engine as any).dataStore = null;
    (engine as any).config = { enableMemoryCache: false };
    (engine as any).ensureDataDir = jest.fn();

    // Mock readEventsFile
    (engine as any).readEventsFile = jest.fn().mockResolvedValue([]);
    // Mock getDateRange
    (engine as any).getDateRange = jest.fn().mockReturnValue([]);
  });

  afterEach(() => {
    // 清理可能的定时器，防止 timer 泄漏
    if (engine) {
      (engine as any).stopPersistTimer?.();
      (engine as any).stopCacheCleanupTimer?.();
      if ((engine as any).syslogFingerprintCleanupTimer) {
        clearInterval((engine as any).syslogFingerprintCleanupTimer);
        (engine as any).syslogFingerprintCleanupTimer = null;
      }
      if ((engine as any).pipelineController) {
        (engine as any).pipelineController = null;
      }
    }
  });

  // ==================== Task 4.4.1 ====================
  describe('Syslog 事件文件查找', () => {
    it('仅存在于文件中的 Syslog 事件应能被找到', async () => {
      const syslogEvent = {
        id: 'syslog-event-1',
        ruleId: 'syslog-dns',
        ruleName: 'DNS Error',
        severity: 'warning',
        message: 'DNS timeout',
        status: 'active',
        triggeredAt: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 天前
        source: 'syslog',
      };

      // 90 天范围内的文件搜索
      (engine as any).getDateRange.mockReturnValue(['2026-02-21']);
      (engine as any).readEventsFile.mockImplementation(async (dateStr: string) => {
        if (dateStr === '2026-02-21') return [syslogEvent];
        return [];
      });

      const result = await engine.getAlertEventById('syslog-event-1');
      expect(result).not.toBeNull();
      expect(result.id).toBe('syslog-event-1');
    });
  });

  // ==================== Task 4.4.2 ====================
  describe('超过 30 天历史事件查找', () => {
    it('超过 30 天但在 90 天内的事件应能被找到', async () => {
      const oldEvent = {
        id: 'old-event-1',
        ruleId: 'rule-1',
        ruleName: 'Test Rule',
        severity: 'info',
        message: 'old event',
        status: 'resolved',
        triggeredAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 天前
      };

      (engine as any).getDateRange.mockReturnValue(['2025-12-28']);
      (engine as any).readEventsFile.mockImplementation(async (dateStr: string) => {
        if (dateStr === '2025-12-28') return [oldEvent];
        return [];
      });

      const result = await engine.getAlertEventById('old-event-1');
      expect(result).not.toBeNull();
      expect(result.id).toBe('old-event-1');
    });

    it('超过 90 天的事件应通过全目录扫描找到', async () => {
      const veryOldEvent = {
        id: 'very-old-1',
        ruleId: 'rule-1',
        ruleName: 'Test Rule',
        severity: 'info',
        message: 'very old event',
        status: 'resolved',
        triggeredAt: Date.now() - 120 * 24 * 60 * 60 * 1000, // 120 天前
      };

      // 90 天范围内找不到
      (engine as any).getDateRange.mockReturnValue([]);

      // 全目录扫描
      mockFs.readdir.mockResolvedValue(['2025-10-29.json'] as any);
      (engine as any).readEventsFile.mockImplementation(async (dateStr: string) => {
        if (dateStr === '2025-10-29') return [veryOldEvent];
        return [];
      });

      const result = await engine.getAlertEventById('very-old-1');
      expect(result).not.toBeNull();
      expect(result.id).toBe('very-old-1');
    });
  });

  // ==================== Task 4.4.3 ====================
  describe('Syslog 事件状态判断', () => {
    it('Syslog 事件即使 status=active 也应允许删除', async () => {
      const syslogEvent = {
        id: 'syslog-del-1',
        ruleId: 'syslog-dns',
        ruleName: 'DNS Error',
        severity: 'warning',
        message: 'DNS timeout',
        status: 'active',
        triggeredAt: Date.now() - 3600000,
        source: 'syslog',
      };

      // Mock getAlertEventById 返回 syslog 事件
      engine.getAlertEventById = jest.fn().mockResolvedValue(syslogEvent);
      mockFs.readFile.mockResolvedValue(JSON.stringify([syslogEvent]));
      mockFs.writeFile.mockResolvedValue(undefined);

      // 不应抛出 "活跃告警不能删除" 错误
      await expect(engine.deleteAlertEvent('syslog-del-1')).resolves.not.toThrow();
    });

    it('非 Syslog 的活跃告警仍应拒绝删除', async () => {
      const activeEvent = {
        id: 'active-1',
        ruleId: 'rule-1',
        ruleName: 'Test Rule',
        severity: 'warning',
        message: 'test',
        status: 'active',
        triggeredAt: Date.now(),
        // source 不是 'syslog'
      };

      engine.getAlertEventById = jest.fn().mockResolvedValue(activeEvent);

      await expect(engine.deleteAlertEvent('active-1')).rejects.toThrow('活跃告警不能删除');
    });
  });

  // ==================== Task 4.4.4 ====================
  describe('批量删除错误报告', () => {
    it('批量删除应返回详细错误信息', async () => {
      engine.deleteAlertEvent = jest.fn()
        .mockResolvedValueOnce(undefined) // 第 1 条成功
        .mockRejectedValueOnce(new Error('告警事件不存在')) // 第 2 条失败
        .mockResolvedValueOnce(undefined); // 第 3 条成功

      const result = await engine.deleteAlertEvents(['id-1', 'id-2', 'id-3']);

      expect(result.deleted).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        id: 'id-2',
        reason: '告警事件不存在',
      });
    });

    it('全部成功时 errors 应为空数组', async () => {
      engine.deleteAlertEvent = jest.fn().mockResolvedValue(undefined);

      const result = await engine.deleteAlertEvents(['id-1', 'id-2']);

      expect(result.deleted).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ==================== Task 4.4.5 ====================
  describe('SQLite 正常事件保持检查', () => {
    it('SQLite 中的事件应正常查询', async () => {
      const dbEvent = {
        id: 'db-event-1',
        tenant_id: 'default',
        device_id: null,
        rule_id: 'rule-1',
        severity: 'warning',
        message: 'test event',
        metric_value: 95,
        status: 'resolved',
        acknowledged_at: null,
        resolved_at: '2026-02-25T00:00:00Z',
        created_at: '2026-02-24T00:00:00Z',
        notify_channels: null,
        auto_response_config: null,
      };

      const mockDataStore = {
        query: jest.fn().mockReturnValue([dbEvent]),
        run: jest.fn(),
      };
      // 设置 dataStore 前先标记已加载，避免 initialize 重新加载
      (engine as any).dataStore = mockDataStore;
      (engine as any)._dataStoreLoadedOnInit = true;

      const convertedEvent = {
        id: 'db-event-1',
        status: 'resolved',
        ruleId: 'rule-1',
        ruleName: 'Test Rule',
        triggeredAt: Date.now(),
      };
      (engine as any).dbRowToAlertEvent = jest.fn().mockReturnValue(convertedEvent);

      const result = await engine.getAlertEventById('db-event-1');
      expect(result).not.toBeNull();
      expect(result.id).toBe('db-event-1');
      expect(mockDataStore.query).toHaveBeenCalledWith(
        'SELECT * FROM alert_events WHERE id = ?',
        ['db-event-1']
      );
    });
  });
});
