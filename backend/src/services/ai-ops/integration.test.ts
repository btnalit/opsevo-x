/**
 * AI-Ops 集成测试（精简版）
 *
 * 测试核心告警处理流程，每种类型保留两条测试用例
 *
 * Requirements: 1.1-1.6, 2.1-2.6, 4.1-4.6, 5.1-5.6, 6.1-6.7, 7.1-7.8, 8.1-8.9
 */

import { SyslogReceiver } from './syslogReceiver';
import { AlertPipeline } from './alertPipeline';
import { alertPreprocessor } from './alertPreprocessor';
import { fingerprintCache } from './fingerprintCache';
import { noiseFilter } from './noiseFilter';
import { rootCauseAnalyzer } from './rootCauseAnalyzer';
import { remediationAdvisor } from './remediationAdvisor';
import {
  AlertEvent,
  UnifiedEvent,
} from '../../types/ai-ops';

// 设置超时时间：AI 调用可能需要 10-30 秒
jest.setTimeout(120000);

// 全局清理
afterAll(async () => {
  fingerprintCache.stopCleanupTimer();
  alertPreprocessor.stopCleanupTimer();
  noiseFilter.stopCleanupTimer();
});

// ==================== Syslog 解析测试 ====================
describe('Integration: Syslog Parsing', () => {
  let syslogReceiver: SyslogReceiver;

  beforeAll(async () => {
    syslogReceiver = new SyslogReceiver();
    await syslogReceiver.initialize();
  });

  it('should parse RFC 3164 syslog message', () => {
    const rawMessage = '<134>Jan 15 10:30:00 router1 system,info,account user admin logged in';
    const syslogMessage = syslogReceiver.parseSyslogMessage(rawMessage);

    expect(syslogMessage).not.toBeNull();
    expect(syslogMessage!.hostname).toBe('router1');
    expect(syslogMessage!.topic).toBe('system,info,account');

    const event = syslogReceiver.convertToSyslogEvent(syslogMessage!);
    expect(event.source).toBe('syslog');
    expect(event.severity).toBe('info');
  });

  it('should handle malformed syslog messages gracefully', () => {
    const malformedMessages = ['no pri tag', '<999>invalid', ''];
    for (const msg of malformedMessages) {
      const result = syslogReceiver.parseSyslogMessage(msg);
      expect(result === null || result !== undefined).toBe(true);
    }
  });
});

// ==================== 告警归一化和去重测试 ====================
describe('Integration: Alert Normalization & Deduplication', () => {
  beforeEach(() => {
    fingerprintCache.clear();
  });

  it('should normalize metrics alert to unified format', () => {
    const alertEvent: AlertEvent = {
      id: 'test-alert-001',
      tenantId: 'test-tenant',
      deviceId: 'test-device',
      ruleId: 'rule-cpu-high',
      ruleName: 'High CPU Alert',
      severity: 'warning',
      metric: 'cpu',
      currentValue: 95,
      threshold: 80,
      message: 'CPU usage is 95%',
      status: 'active',
      triggeredAt: Date.now(),
    };

    const normalized = alertPreprocessor.normalize(alertEvent);
    expect(normalized.source).toBe('metrics');
    expect(normalized.severity).toBe('warning');
    expect(normalized.alertRuleInfo?.ruleId).toBe('rule-cpu-high');
  });

  it('should deduplicate identical alerts using fingerprint', () => {
    const alert1: AlertEvent = {
      id: 'alert-1',
      tenantId: 'test-tenant',
      deviceId: 'test-device',
      ruleId: 'rule-memory',
      ruleName: 'Memory Alert',
      severity: 'warning',
      metric: 'memory',
      currentValue: 90,
      threshold: 85,
      message: 'Memory high',
      status: 'active',
      triggeredAt: Date.now(),
    };

    const alert2: AlertEvent = {
      ...alert1,
      id: 'alert-2',
      currentValue: 91,
      triggeredAt: Date.now() + 1000,
    };

    const fp1 = fingerprintCache.generateFingerprint(alert1);
    const fp2 = fingerprintCache.generateFingerprint(alert2);
    expect(fp1).toBe(fp2);

    fingerprintCache.set(fp1);
    expect(fingerprintCache.exists(fp2)).toBe(true);
  });
});

// ==================== 告警过滤测试 ====================
describe('Integration: Alert Filtering', () => {
  beforeAll(async () => {
    // 确保 noiseFilter 已初始化
    await noiseFilter.initialize();
  });

  it('should filter alerts during maintenance window', async () => {
    const now = Date.now();
    noiseFilter.addMaintenanceWindow({
      id: 'test-maint',
      name: 'Test Maintenance',
      startTime: now - 60000,
      endTime: now + 60000,
      resources: ['cpu', 'system'],
    });

    // 等待维护窗口保存
    await new Promise(resolve => setTimeout(resolve, 100));

    const alertEvent: AlertEvent = {
      id: 'test-alert-maint',
      tenantId: 'test-tenant',
      deviceId: 'test-device',
      ruleId: 'rule-cpu',
      ruleName: 'CPU Alert',
      severity: 'warning',
      metric: 'cpu',
      currentValue: 95,
      threshold: 80,
      message: 'CPU high',
      status: 'active',
      triggeredAt: now,
    };

    const normalized = alertPreprocessor.normalize(alertEvent);
    // 确保 alertRuleInfo.metric 被设置
    expect(normalized.alertRuleInfo?.metric).toBe('cpu');

    const result = await noiseFilter.filter(normalized);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe('maintenance_window');

    noiseFilter.removeMaintenanceWindow('test-maint');
  });

  it('should filter alerts matching known issues', async () => {
    noiseFilter.addKnownIssue({
      id: 'test-known',
      pattern: 'DNS.*timeout',
      description: 'Known DNS issue',
      autoResolve: false,
    });

    const alertEvent: AlertEvent = {
      id: 'test-alert-known',
      tenantId: 'test-tenant',
      deviceId: 'test-device',
      ruleId: 'rule-dns',
      ruleName: 'DNS Alert',
      severity: 'warning',
      metric: 'cpu',
      currentValue: 0,
      threshold: 0,
      message: 'DNS query timeout',
      status: 'active',
      triggeredAt: Date.now(),
    };

    const normalized = alertPreprocessor.normalize(alertEvent);
    const result = await noiseFilter.filter(normalized);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe('known_issue');

    noiseFilter.removeKnownIssue('test-known');
  });
});

// ==================== 完整流水线测试（含 AI 调用）====================
describe('Integration: Complete Pipeline with AI', () => {
  let alertPipeline: AlertPipeline;

  beforeAll(async () => {
    alertPipeline = new AlertPipeline({
      enableDeduplication: true,
      enableFiltering: true,
      enableAnalysis: true,
      enableDecision: true,
      autoExecuteDecision: false,
      generateRemediationPlan: true,
    });
    await alertPipeline.initialize();
  });

  beforeEach(() => {
    fingerprintCache.clear();
    alertPipeline.resetStats();
  });

  it('should process alert through complete pipeline', async () => {
    const alertEvent: AlertEvent = {
      id: 'test-pipeline-' + Date.now(),
      tenantId: 'test-tenant',
      deviceId: 'test-device',
      ruleId: 'rule-disk',
      ruleName: 'Disk Alert',
      severity: 'critical',
      metric: 'disk',
      currentValue: 95,
      threshold: 90,
      message: 'Disk usage 95%',
      status: 'active',
      triggeredAt: Date.now(),
    };

    const result = await alertPipeline.process(alertEvent);
    expect(result.event).toBeDefined();
    expect(result.event.source).toBe('metrics');

    if (!result.filtered) {
      expect(result.analysis).toBeDefined();
      expect(result.decision).toBeDefined();
    }
  });

  it('should track pipeline statistics', async () => {
    const alertEvent: AlertEvent = {
      id: 'test-stats-' + Date.now(),
      tenantId: 'test-tenant',
      deviceId: 'test-device',
      ruleId: 'rule-interface',
      ruleName: 'Interface Alert',
      severity: 'warning',
      metric: 'interface_status',
      currentValue: 0,
      threshold: 1,
      message: 'Interface down',
      status: 'active',
      triggeredAt: Date.now(),
    };

    await alertPipeline.process(alertEvent);
    const stats = alertPipeline.getStats();
    expect(stats.processed).toBeGreaterThan(0);
  });
});

// ==================== 修复方案生成测试（含 AI 调用）====================
describe('Integration: Remediation Plan', () => {
  beforeAll(async () => {
    await remediationAdvisor.initialize();
    await rootCauseAnalyzer.initialize();
  });

  it('should generate remediation plan from analysis', async () => {
    const event: UnifiedEvent = {
      id: 'test-remediation-' + Date.now(),
      source: 'metrics',
      timestamp: Date.now(),
      severity: 'critical',
      category: 'system',
      message: 'High CPU: 95%',
      rawData: {},
      metadata: {},
    };

    const analysis = await rootCauseAnalyzer.analyzeSingle(event);
    expect(analysis.rootCauses.length).toBeGreaterThan(0);

    const plan = await remediationAdvisor.generatePlan(analysis);
    expect(plan.id).toBeDefined();
    expect(plan.alertId).toBe(event.id);
    expect(['low', 'medium', 'high']).toContain(plan.overallRisk);
  });

  it('should retrieve plan by ID', async () => {
    const event: UnifiedEvent = {
      id: 'test-retrieve-' + Date.now(),
      source: 'metrics',
      timestamp: Date.now(),
      severity: 'warning',
      category: 'interface',
      message: 'Interface flapping',
      rawData: {},
      metadata: {},
    };

    const analysis = await rootCauseAnalyzer.analyzeSingle(event);
    const generated = await remediationAdvisor.generatePlan(analysis);
    const retrieved = await remediationAdvisor.getPlan(generated.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(generated.id);
  });
});

// ==================== 多来源关联分析测试（含 AI 调用）====================
describe('Integration: Multi-Source Correlation', () => {
  beforeAll(async () => {
    await rootCauseAnalyzer.initialize();
  });

  it('should correlate events from different sources', async () => {
    const now = Date.now();

    const events: UnifiedEvent[] = [
      {
        id: 'syslog-' + now,
        source: 'syslog',
        timestamp: now,
        severity: 'warning',
        category: 'interface',
        message: 'ether1 link down',
        rawData: {},
        metadata: {},
      },
      {
        id: 'metrics-' + now,
        source: 'metrics',
        timestamp: now + 1000,
        severity: 'critical',
        category: 'interface',
        message: 'Interface status down',
        rawData: {},
        metadata: {},
      },
    ];

    const analysis = await rootCauseAnalyzer.analyzeCorrelated(events);
    expect(analysis.rootCauses.length).toBeGreaterThan(0);
    expect(analysis.timeline.events.length).toBe(2);
  });


});
