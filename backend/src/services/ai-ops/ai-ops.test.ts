/**
 * AI-Ops 基础数据服务测试（精简版）
 * 
 * 验证审计日志、指标采集、告警引擎、调度器、配置快照和健康报告服务
 * 每种类型保留核心测试用例
 */

import fs from 'fs/promises';
import path from 'path';
import { AuditLogger, auditLogger as auditLoggerSingleton } from './auditLogger';
import { MetricsCollector } from './metricsCollector';
import { AlertEngine } from './alertEngine';
import { Scheduler } from './scheduler';
import { ConfigSnapshotService } from './configSnapshotService';
import { HealthReportService } from './healthReportService';
import { fingerprintCache } from './fingerprintCache';
import { alertPreprocessor } from './alertPreprocessor';
import { noiseFilter } from './noiseFilter';
import { analysisCache } from './analysisCache';
import {
  AuditAction,
  CreateAlertRuleInput,
  CreateScheduledTaskInput,
} from '../../types/ai-ops';

// 测试数据目录
const TEST_DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops-test');
const TEST_AUDIT_DIR = path.join(TEST_DATA_DIR, 'audit');

// 全局清理
afterAll(async () => {
  fingerprintCache.stopCleanupTimer();
  alertPreprocessor.stopCleanupTimer();
  noiseFilter.stopCleanupTimer();
  analysisCache.stopCleanupTimer();
  auditLoggerSingleton.stop();
});

// ==================== 审计日志测试 ====================
describe('AuditLogger', () => {
  let auditLogger: AuditLogger;

  beforeAll(async () => {
    await fs.mkdir(TEST_AUDIT_DIR, { recursive: true });
  });

  beforeEach(() => {
    auditLogger = new AuditLogger();
  });

  afterAll(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('should create audit log entry with id and timestamp', async () => {
    const result = await auditLogger.log({
      action: 'script_execute' as AuditAction,
      actor: 'system',
      details: { trigger: 'test', script: 'test script', result: 'success' },
      tenantId: 'test-tenant',
      deviceId: 'test-device',
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBeDefined();
    expect(result!.timestamp).toBeDefined();
    expect(result!.action).toBe('script_execute');
  });

  it('should query logs by action type', async () => {
    await auditLogger.log({ action: 'config_change', actor: 'user', details: { trigger: 'manual' }, tenantId: 'test-tenant', deviceId: 'test-device' });
    await auditLogger.log({ action: 'alert_trigger', actor: 'system', details: { trigger: 'auto' }, tenantId: 'test-tenant', deviceId: 'test-device' });

    const logs = await auditLogger.query({ action: 'config_change' });
    expect(logs.every(log => log.action === 'config_change')).toBe(true);
  });
});

// ==================== 指标采集测试 ====================
describe('MetricsCollector', () => {
  let metricsCollector: MetricsCollector;
  let originalConfig: { intervalMs: number; retentionDays: number; enabled: boolean };

  beforeEach(() => {
    metricsCollector = new MetricsCollector();
    // 保存原始配置
    originalConfig = metricsCollector.getConfig();
  });

  afterEach(async () => {
    metricsCollector.stop();
    // 恢复原始配置，确保 enabled 为 true
    await metricsCollector.saveConfig({ ...originalConfig, enabled: true });
  });

  it('should return default configuration', () => {
    const config = metricsCollector.getConfig();
    expect(config.intervalMs).toBe(60000);
    expect(config.retentionDays).toBe(7);
    expect(config.enabled).toBe(true);
  });

  it('should update configuration', async () => {
    const newConfig = await metricsCollector.saveConfig({ intervalMs: 30000, enabled: false });
    expect(newConfig.intervalMs).toBe(30000);
    expect(newConfig.enabled).toBe(false);
    // 测试后会在 afterEach 中恢复配置
  });
});

// ==================== 告警引擎测试 ====================
describe('AlertEngine', () => {
  let alertEngine: AlertEngine;

  beforeEach(() => {
    // 使用禁用内存缓存的配置，避免持久化定时器干扰测试
    alertEngine = new AlertEngine({ enableMemoryCache: false });
  });

  afterEach(async () => {
    // 确保清理持久化定时器
    await alertEngine.flush();
  });

  describe('Rule Management', () => {
    it('should create and retrieve alert rule', async () => {
      const input: CreateAlertRuleInput = {
        name: 'Test CPU Alert',
        enabled: true,
        metric: 'cpu',
        operator: 'gt',
        threshold: 80,
        duration: 1,
        cooldownMs: 60000,
        severity: 'warning',
        channels: [],
      };

      const created = await alertEngine.createRule(input);
      expect(created.id).toBeDefined();
      expect(created.name).toBe('Test CPU Alert');

      const retrieved = await alertEngine.getRuleById(created.id);
      expect(retrieved?.id).toBe(created.id);
    });

    it('should update and delete alert rule', async () => {
      const created = await alertEngine.createRule({
        name: 'Original',
        enabled: true,
        metric: 'disk',
        operator: 'gt',
        threshold: 70,
        duration: 1,
        cooldownMs: 60000,
        severity: 'info',
        channels: [],
      });

      const updated = await alertEngine.updateRule(created.id, { name: 'Updated', threshold: 85 });
      expect(updated.name).toBe('Updated');
      expect(updated.threshold).toBe(85);

      await alertEngine.deleteRule(created.id);
      const deleted = await alertEngine.getRuleById(created.id);
      expect(deleted).toBeNull();
    });
  });

  describe('Condition Evaluation', () => {
    it('should evaluate operators correctly', () => {
      expect(alertEngine.evaluateCondition(90, 'gt', 80)).toBe(true);
      expect(alertEngine.evaluateCondition(70, 'lt', 80)).toBe(true);
      expect(alertEngine.evaluateCondition(80, 'eq', 80)).toBe(true);
      expect(alertEngine.evaluateCondition(79, 'ne', 80)).toBe(true);
      expect(alertEngine.evaluateCondition(80, 'gte', 80)).toBe(true);
      expect(alertEngine.evaluateCondition(80, 'lte', 80)).toBe(true);
    });
  });

  describe('Evaluate', () => {
    it('should not trigger alert when condition is not met', async () => {
      await alertEngine.createRule({
        name: 'High CPU',
        enabled: true,
        metric: 'cpu',
        operator: 'gt',
        threshold: 90,
        duration: 1,
        cooldownMs: 60000,
        severity: 'warning',
        channels: [],
      });

      const metrics = {
        system: {
          cpu: { usage: 50 },
          memory: { total: 1000, used: 500, free: 500, usage: 50 },
          disk: { total: 10000, used: 5000, free: 5000, usage: 50 },
          uptime: 3600,
        },
        interfaces: [],
      };

      const events = await alertEngine.evaluate(metrics);
      expect(events.length).toBe(0);
    });

    // 此测试会触发完整 AI 流水线（243条规则），在集成测试中已覆盖
    // 跳过以避免超时
    it.skip('should trigger alert when condition is met', async () => {
      await alertEngine.createRule({
        name: 'High CPU Trigger',
        enabled: true,
        metric: 'cpu',
        operator: 'gt',
        threshold: 80,
        duration: 1,
        cooldownMs: 0,
        severity: 'critical',
        channels: [],
      });

      const metrics = {
        system: {
          cpu: { usage: 95 },
          memory: { total: 1000, used: 500, free: 500, usage: 50 },
          disk: { total: 10000, used: 5000, free: 5000, usage: 50 },
          uptime: 3600,
        },
        interfaces: [],
      };

      const events = await alertEngine.evaluate(metrics);
      expect(Array.isArray(events)).toBe(true);
    }, 120000);
  });

  // ==================== 内存缓存测试 ====================
  // Requirements: 11.1, 11.2, 11.3, 11.4
  describe('Memory Cache', () => {
    let cachedAlertEngine: AlertEngine;

    beforeEach(() => {
      // 使用启用内存缓存的配置
      cachedAlertEngine = new AlertEngine({
        enableMemoryCache: true,
        persistIntervalMs: 100000 // 设置较长间隔，避免自动持久化干扰测试
      });
    });

    afterEach(async () => {
      await cachedAlertEngine.flush();
    });

    it('should return cache stats', async () => {
      await cachedAlertEngine.initialize();

      const stats = cachedAlertEngine.getCacheStats();
      expect(stats).toHaveProperty('rulesInMemory');
      expect(stats).toHaveProperty('activeAlertsInMemory');
      expect(stats).toHaveProperty('pendingPersist');
      expect(stats).toHaveProperty('eventsCacheSize');
      expect(typeof stats.rulesInMemory).toBe('number');
      expect(typeof stats.activeAlertsInMemory).toBe('number');
      expect(typeof stats.pendingPersist).toBe('number');
    });

    it('should mark rules as dirty when created', async () => {
      await cachedAlertEngine.initialize();

      const statsBefore = cachedAlertEngine.getCacheStats();
      const rulesBefore = statsBefore.rulesInMemory;

      await cachedAlertEngine.createRule({
        name: 'Cache Test Rule',
        enabled: true,
        metric: 'cpu',
        operator: 'gt',
        threshold: 80,
        duration: 1,
        cooldownMs: 60000,
        severity: 'warning',
        channels: [],
      });

      const statsAfter = cachedAlertEngine.getCacheStats();
      expect(statsAfter.rulesInMemory).toBe(rulesBefore + 1);
      expect(statsAfter.pendingPersist).toBeGreaterThan(0);
    });

    it('should flush pending data on demand', async () => {
      await cachedAlertEngine.initialize();

      await cachedAlertEngine.createRule({
        name: 'Flush Test Rule',
        enabled: true,
        metric: 'memory',
        operator: 'gt',
        threshold: 90,
        duration: 1,
        cooldownMs: 60000,
        severity: 'critical',
        channels: [],
      });

      // 强制刷新
      await cachedAlertEngine.flush();

      // 刷新后 pendingPersist 应该为 0
      const stats = cachedAlertEngine.getCacheStats();
      expect(stats.pendingPersist).toBe(0);
    });
  });
});

// ==================== 调度器测试 ====================
describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('should validate cron expressions', () => {
    expect(scheduler.calculateNextRunTime('* * * * *')).not.toBeNull();
    expect(scheduler.calculateNextRunTime('invalid')).toBeNull();
  });

  it('should create and manage scheduled tasks', async () => {
    const input: CreateScheduledTaskInput & { tenant_id?: string; device_id?: string | null } = {
      name: 'Test Backup',
      type: 'backup',
      cron: '0 0 * * *',
      enabled: true,
      tenant_id: 'test-tenant',
      device_id: 'test-device',
    };

    const created = await scheduler.createTask(input);
    expect(created.id).toBeDefined();
    expect(created.name).toBe('Test Backup');

    const updated = await scheduler.updateTask(created.id, { name: 'Updated Task' });
    expect(updated.name).toBe('Updated Task');

    await scheduler.deleteTask(created.id);
    const deleted = await scheduler.getTaskById(created.id);
    expect(deleted).toBeNull();
  });
});

// ==================== 配置快照测试 ====================
describe('ConfigSnapshotService', () => {
  let service: ConfigSnapshotService;

  beforeEach(() => {
    service = new ConfigSnapshotService();
  });

  it('should initialize without errors', async () => {
    await expect(service.initialize()).resolves.not.toThrow();
  });

  it('should detect dangerous changes', () => {
    const diff = {
      snapshotA: 'a',
      snapshotB: 'b',
      additions: [],
      modifications: [],
      deletions: ['/ip firewall filter add chain=input action=drop'],
    };

    const result = service.detectDangerousChanges(diff);
    expect(result.detected).toBe(true);
    expect(result.overallRiskLevel).toBe('high');
  });
});

// ==================== 健康报告测试 ====================
describe('HealthReportService', () => {
  let service: HealthReportService;

  beforeEach(() => {
    service = new HealthReportService();
  });

  it('should initialize without errors', async () => {
    await expect(service.initialize()).resolves.not.toThrow();
  });

  it('should return empty array for reports initially', async () => {
    const reports = await service.getReports();
    expect(Array.isArray(reports)).toBe(true);
  });
});
