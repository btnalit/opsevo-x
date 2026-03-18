/**
 * DecisionEngine unit tests
 *
 * Requirements: G3.7, G3.8, G3.9, G3.10
 * - G3.7: 多因子评分决策（新增 system_load, device_health, correlated_alert_count）
 * - G3.8: 决策规则 CRUD
 * - G3.9: PostgreSQL 持久化（DataStore）
 * - G3.10: 反馈闭环优化权重
 */

import { DecisionEngine } from '../decisionEngine';
import type { DataStore } from '../../dataStore';
import type {
  UnifiedEvent,
  RootCauseAnalysis,
  Decision,
  DecisionFactor,
  ImpactAssessment,
} from '../../../types/ai-ops';

// Suppress logger output during tests
jest.mock('../../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock auditLogger
jest.mock('../auditLogger', () => ({
  auditLogger: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock notificationService
jest.mock('../notificationService', () => ({
  notificationService: {
    send: jest.fn().mockResolvedValue({ success: true, failedChannels: [] }),
    getChannels: jest.fn().mockResolvedValue([]),
  },
}));

// Mock remediationAdvisor
jest.mock('../remediationAdvisor', () => ({
  remediationAdvisor: {
    executeAutoSteps: jest.fn().mockResolvedValue([]),
  },
}));

// Mock faultHealer
jest.mock('../faultHealer', () => ({
  faultHealer: {
    executeRemediation: jest.fn().mockResolvedValue({ status: 'success' }),
  },
}));

// Mock autonomousBrainService
jest.mock('../brain/autonomousBrainService', () => ({
  autonomousBrainService: {
    triggerTick: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock fs to avoid file system operations
jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn().mockResolvedValue([]),
  unlink: jest.fn().mockResolvedValue(undefined),
}));


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Partial<UnifiedEvent>): UnifiedEvent {
  return {
    id: 'evt-1',
    source: 'test',
    category: 'network',
    severity: 'warning',
    message: 'Test alert',
    timestamp: Date.now(),
    deviceId: 'dev-1',
    tenantId: 'tenant-1',
    raw: {},
    ...overrides,
  } as UnifiedEvent;
}

function makeAnalysis(overrides?: Partial<RootCauseAnalysis>): RootCauseAnalysis {
  return {
    id: 'rca-1',
    alertId: 'evt-1',
    timestamp: Date.now(),
    rootCauses: [],
    timeline: { events: [] } as any,
    impact: {
      scope: 'local',
      affectedResources: ['network'],
      estimatedUsers: 1,
      services: [],
      networkSegments: [],
    },
    ...overrides,
  } as RootCauseAnalysis;
}

function makeMockDataStore(): DataStore {
  const store: Record<string, any[]> = {
    decision_rules: [],
    decision_history: [],
  };

  return {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('decision_rules')) return store.decision_rules;
      if (sql.includes('decision_history')) return store.decision_history;
      return [];
    }),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockImplementation(async (_sql: string, params?: unknown[]) => {
      // Track inserts to decision_history
      if (_sql.includes('decision_history') && params) {
        store.decision_history.push({ id: params[0] });
      }
      return { rowCount: 1 };
    }),
    transaction: jest.fn().mockImplementation(async (fn: any) => fn({
      query: jest.fn().mockResolvedValue([]),
      queryOne: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
    })),
    getPool: jest.fn() as any,
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DecisionEngine', () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    engine = new DecisionEngine();
    // Stop cleanup timer to avoid open handles
    engine.stopCleanupTimer();
  });

  afterEach(() => {
    engine.stopCleanupTimer();
  });

  // ==================== G3.7: New Factors ====================

  describe('G3.7: Multi-factor scoring with new factors', () => {
    test('should have 7 factors registered (4 original + 3 new)', () => {
      const factors = engine.getFactors();
      const names = factors.map(f => f.name);

      expect(names).toContain('severity');
      expect(names).toContain('time_of_day');
      expect(names).toContain('historical_success_rate');
      expect(names).toContain('affected_scope');
      expect(names).toContain('system_load');
      expect(names).toContain('device_health');
      expect(names).toContain('correlated_alert_count');
      expect(factors).toHaveLength(7);
    });

    test('factor weights should sum to approximately 1.0', () => {
      const factors = engine.getFactors();
      const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    });

    test('setSystemLoad should update system_load factor value', () => {
      engine.setSystemLoad(0.8);
      expect(engine.getSystemLoad()).toBe(0.8);
    });

    test('setSystemLoad should clamp to [0, 1]', () => {
      engine.setSystemLoad(1.5);
      expect(engine.getSystemLoad()).toBe(1);
      engine.setSystemLoad(-0.5);
      expect(engine.getSystemLoad()).toBe(0);
    });

    test('setDeviceHealth should update device_health factor value', () => {
      engine.setDeviceHealth(0.3);
      expect(engine.getDeviceHealth()).toBe(0.3);
    });

    test('setDeviceHealth should clamp to [0, 1]', () => {
      engine.setDeviceHealth(2.0);
      expect(engine.getDeviceHealth()).toBe(1);
      engine.setDeviceHealth(-1);
      expect(engine.getDeviceHealth()).toBe(0);
    });

    test('decide should include all 7 factor scores', async () => {
      const event = makeEvent();
      const decision = await engine.decide(event);

      expect(decision.factors).toHaveLength(7);
      const factorNames = decision.factors.map(f => f.name);
      expect(factorNames).toContain('system_load');
      expect(factorNames).toContain('device_health');
      expect(factorNames).toContain('correlated_alert_count');
    });

    test('correlated_alert_count should reflect analysis similarIncidents', async () => {
      const event = makeEvent();
      const analysis = makeAnalysis({
        similarIncidents: [
          { id: 's1', alertId: 'a1', similarity: 0.9, timestamp: Date.now(), resolution: 'fixed' },
          { id: 's2', alertId: 'a2', similarity: 0.8, timestamp: Date.now(), resolution: 'fixed' },
          { id: 's3', alertId: 'a3', similarity: 0.7, timestamp: Date.now(), resolution: 'fixed' },
        ] as any,
      });

      const decision = await engine.decide(event, analysis);
      const correlatedFactor = decision.factors.find(f => f.name === 'correlated_alert_count');
      expect(correlatedFactor).toBeDefined();
      // 3 correlated / 5 = 0.6
      expect(correlatedFactor!.score).toBeCloseTo(0.6, 1);
    });

    test('correlated_alert_count should be 0 when no analysis', async () => {
      const event = makeEvent();
      const decision = await engine.decide(event);
      const correlatedFactor = decision.factors.find(f => f.name === 'correlated_alert_count');
      expect(correlatedFactor).toBeDefined();
      expect(correlatedFactor!.score).toBe(0);
    });
  });


  // ==================== G3.9: DataStore Integration ====================

  describe('G3.9: PostgreSQL DataStore persistence', () => {
    test('setDataStore should enable PostgreSQL persistence', async () => {
      const mockDS = makeMockDataStore();
      engine.setDataStore(mockDS);

      const event = makeEvent();
      const decision = await engine.decide(event);

      // saveDecision should have called DataStore.execute for decision_history
      expect(mockDS.execute).toHaveBeenCalled();
      const calls = (mockDS.execute as jest.Mock).mock.calls;
      const historyCall = calls.find((c: any[]) => c[0].includes('decision_history'));
      expect(historyCall).toBeDefined();
    });

    test('loadRules should try DataStore first when set', async () => {
      const mockDS = makeMockDataStore();
      const mockRules = [
        {
          id: 'pg-rule-1',
          name: 'PG Rule',
          priority: 1,
          conditions: JSON.stringify([]),
          action: 'notify_and_wait',
          enabled: true,
        },
      ];
      (mockDS.query as jest.Mock).mockImplementation(async (sql: string) => {
        if (sql.includes('decision_rules')) return mockRules;
        return [];
      });

      engine.setDataStore(mockDS);

      // Force re-initialization by creating a new engine with DataStore
      const engine2 = new DecisionEngine();
      engine2.stopCleanupTimer();
      engine2.setDataStore(mockDS);
      await engine2.decide(makeEvent()); // triggers initialize

      expect(mockDS.query).toHaveBeenCalledWith(
        expect.stringContaining('decision_rules')
      );
      engine2.stopCleanupTimer();
    });

    test('should fall back to file when DataStore query fails', async () => {
      const mockDS = makeMockDataStore();
      (mockDS.query as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

      engine.setDataStore(mockDS);
      // Should not throw - falls back to file
      const event = makeEvent();
      const decision = await engine.decide(event);
      expect(decision).toBeDefined();
      expect(decision.action).toBeDefined();
    });

    test('saveDecision should fall back to file when DataStore execute fails', async () => {
      const mockDS = makeMockDataStore();
      (mockDS.execute as jest.Mock).mockRejectedValue(new Error('DB write failed'));

      engine.setDataStore(mockDS);
      const event = makeEvent();
      // Should not throw - falls back to file-based save
      const decision = await engine.decide(event);
      expect(decision).toBeDefined();
    });
  });

  // ==================== New Decision Types ====================

  describe('New decision types: auto_remediate and observe', () => {
    test('executeDecision should handle auto_remediate like auto_execute', async () => {
      const event = makeEvent();
      const decision = await engine.decide(event);
      decision.action = 'auto_remediate';

      await engine.executeDecision(decision, undefined, event);
      expect(decision.executed).toBe(true);
      expect(decision.executionResult?.success).toBe(true);
    });

    test('executeDecision should handle observe action', async () => {
      const event = makeEvent();
      const decision = await engine.decide(event);
      decision.action = 'observe';

      await engine.executeDecision(decision, undefined, event);
      expect(decision.executed).toBe(true);
      expect(decision.executionResult?.success).toBe(true);
    });
  });

  // ==================== G3.10: Feedback Weight Adjustment ====================

  describe('G3.10: adjustWeights feedback loop', () => {
    test('adjustWeights should adjust factor weights on positive feedback', async () => {
      const event = makeEvent({ severity: 'warning' });
      const decision = await engine.decide(event);

      const factorsBefore = engine.getFactors().map(f => ({ name: f.name, weight: f.weight }));

      await engine.adjustWeights({
        decisionId: decision.id,
        outcome: 'success',
        score: 0.9,
      });

      const factorsAfter = engine.getFactors().map(f => ({ name: f.name, weight: f.weight }));

      // Weights should have changed
      const changed = factorsBefore.some((before, i) =>
        Math.abs(before.weight - factorsAfter[i].weight) > 0.001
      );
      expect(changed).toBe(true);

      // Weights should still sum to ~1.0 after normalization
      const totalWeight = factorsAfter.reduce((sum, f) => sum + f.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    });

    test('adjustWeights should adjust factor weights on negative feedback', async () => {
      const event = makeEvent({ severity: 'critical' });
      const decision = await engine.decide(event);

      const factorsBefore = engine.getFactors().map(f => ({ name: f.name, weight: f.weight }));

      await engine.adjustWeights({
        decisionId: decision.id,
        outcome: 'failure',
        score: 0.1,
      });

      const factorsAfter = engine.getFactors().map(f => ({ name: f.name, weight: f.weight }));

      const changed = factorsBefore.some((before, i) =>
        Math.abs(before.weight - factorsAfter[i].weight) > 0.001
      );
      expect(changed).toBe(true);
    });

    test('adjustWeights should skip for neutral feedback', async () => {
      const event = makeEvent();
      const decision = await engine.decide(event);

      const factorsBefore = engine.getFactors().map(f => ({ name: f.name, weight: f.weight }));

      await engine.adjustWeights({
        decisionId: decision.id,
        outcome: 'partial',
        score: 0.5,
      });

      const factorsAfter = engine.getFactors().map(f => ({ name: f.name, weight: f.weight }));

      // Weights should NOT have changed for neutral feedback
      factorsBefore.forEach((before, i) => {
        expect(before.weight).toBeCloseTo(factorsAfter[i].weight, 5);
      });
    });

    test('adjustWeights should not throw for unknown decisionId', async () => {
      await expect(
        engine.adjustWeights({
          decisionId: 'nonexistent-id',
          outcome: 'success',
          score: 0.9,
        })
      ).resolves.not.toThrow();
    });
  });

  // ==================== Dependency Setters ====================

  describe('Dependency setters', () => {
    test('setMetricsCollector should influence system_load factor', async () => {
      const mockMC = {
        getLatestMetrics: () => ({ cpuUsage: 0.9, memoryUsage: 0.7 }),
      };
      engine.setMetricsCollector(mockMC);

      const event = makeEvent();
      const decision = await engine.decide(event);
      const loadFactor = decision.factors.find(f => f.name === 'system_load');
      expect(loadFactor).toBeDefined();
      // CPU 0.9 → score = 1 - 0.9 = 0.1
      expect(loadFactor!.score).toBeCloseTo(0.1, 1);
    });

    test('setEventBus should be called without error', () => {
      const mockEB = {
        publish: jest.fn().mockResolvedValue(undefined),
      };
      expect(() => engine.setEventBus(mockEB)).not.toThrow();
    });

    test('observe decision should publish to EventBus when set', async () => {
      const mockEB = {
        publish: jest.fn().mockResolvedValue(undefined),
      };
      engine.setEventBus(mockEB);

      const event = makeEvent();
      const decision = await engine.decide(event);
      decision.action = 'observe';

      await engine.executeDecision(decision, undefined, event);

      expect(mockEB.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decision_observed',
        })
      );
    });
  });

  // ==================== Backward Compatibility ====================

  describe('Backward compatibility', () => {
    test('decide should still work with no analysis', async () => {
      const event = makeEvent({ severity: 'critical' });
      const decision = await engine.decide(event);

      expect(decision).toBeDefined();
      expect(decision.id).toBeDefined();
      expect(decision.alertId).toBe('evt-1');
      expect(decision.action).toBeDefined();
      expect(decision.factors.length).toBeGreaterThanOrEqual(4);
    });

    test('existing rule CRUD methods should still work', async () => {
      // Trigger initialization first (loads default rules)
      await engine.decide(makeEvent());

      const rules = engine.getRules();
      expect(rules.length).toBeGreaterThan(0);

      const newRule = await engine.createRule({
        name: 'Test Rule',
        priority: 50,
        conditions: [{ factor: 'severity', operator: 'gte', value: 0.5 }],
        action: 'notify_and_wait',
        enabled: true,
      });
      expect(newRule.id).toBeDefined();

      const updatedRules = engine.getRules();
      expect(updatedRules.find(r => r.id === newRule.id)).toBeDefined();

      engine.removeRule(newRule.id);
      expect(engine.getRules().find(r => r.id === newRule.id)).toBeUndefined();
    });

    test('executeDecision should still handle all original action types', async () => {
      const event = makeEvent();

      for (const action of ['auto_execute', 'notify_and_wait', 'escalate', 'silence'] as const) {
        const decision = await engine.decide(event);
        decision.action = action;
        await engine.executeDecision(decision, undefined, event);
        expect(decision.executed).toBe(true);
      }
    });

    test('getStatistics should include new action types', async () => {
      const stats = await engine.getStatistics();
      expect(stats.byAction).toHaveProperty('auto_remediate');
      expect(stats.byAction).toHaveProperty('observe');
      expect(stats.byAction.auto_remediate).toBe(0);
      expect(stats.byAction.observe).toBe(0);
    });

    test('singleton export should be a DecisionEngine instance', () => {
      // Verify the module exports a singleton
      const { decisionEngine } = require('../decisionEngine');
      expect(decisionEngine).toBeInstanceOf(DecisionEngine);
      decisionEngine.stopCleanupTimer();
    });
  });
});
