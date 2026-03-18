/**
 * FeatureFlagManager 单元测试
 *
 * 验证:
 * - Flow Flags: 按流程粒度控制状态机编排或原有逻辑 (Req 9.3, 9.4, 9.5)
 * - Control Point Flags: 10 个控制点、依赖校验、PostgreSQL 持久化 (Req I5.14)
 * - 向后兼容: 所有原有 API 行为不变
 */

import {
  FeatureFlagManager,
  FeatureFlagConfig,
  CONTROL_POINT_DEFINITIONS,
  ControlPointKey,
} from '../stateMachine/featureFlagManager';

// ============================================================
// Helpers
// ============================================================

function makeDefaultConfig(): FeatureFlagConfig {
  return {
    flags: {
      'react-orchestration': false,
      'alert-orchestration': false,
      'iteration-orchestration': false,
    },
    comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
  };
}

function makeAllEnabledConfig(): FeatureFlagConfig {
  return {
    flags: {
      'react-orchestration': true,
      'alert-orchestration': true,
      'iteration-orchestration': true,
    },
    comparisonMode: { enabled: false, enabledFor: [], logLevel: 'info' },
  };
}

function makeMockDataStore() {
  const store: Record<string, { flag_key: string; enabled: boolean }[]> = {
    rows: [],
  };
  return {
    query: jest.fn().mockImplementation(async () => store.rows),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
    transaction: jest.fn(),
    getPool: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn(),
    _store: store,
  };
}

// ============================================================
// Flow Flag Tests (backward compatibility)
// ============================================================

describe('FeatureFlagManager', () => {
  describe('constructor and defaults', () => {
    it('should create with default config (all flags off)', () => {
      const manager = new FeatureFlagManager();
      expect(manager.isEnabled('react-orchestration')).toBe(false);
      expect(manager.isEnabled('alert-orchestration')).toBe(false);
      expect(manager.isEnabled('iteration-orchestration')).toBe(false);
    });

    it('should create with provided config', () => {
      const config = makeAllEnabledConfig();
      const manager = new FeatureFlagManager(config);
      expect(manager.isEnabled('react-orchestration')).toBe(true);
      expect(manager.isEnabled('alert-orchestration')).toBe(true);
      expect(manager.isEnabled('iteration-orchestration')).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('should return true when flag is enabled', () => {
      const config = makeDefaultConfig();
      config.flags['react-orchestration'] = true;
      const manager = new FeatureFlagManager(config);
      expect(manager.isEnabled('react-orchestration')).toBe(true);
    });

    it('should return false when flag is disabled', () => {
      const manager = new FeatureFlagManager();
      expect(manager.isEnabled('react-orchestration')).toBe(false);
    });

    it('should return false for unknown flow IDs', () => {
      const manager = new FeatureFlagManager();
      expect(manager.isEnabled('unknown-flow' as any)).toBe(false);
    });
  });

  describe('setEnabled', () => {
    it('should enable a flag', () => {
      const manager = new FeatureFlagManager();
      manager.setEnabled('react-orchestration', true);
      expect(manager.isEnabled('react-orchestration')).toBe(true);
    });

    it('should disable a flag', () => {
      const config = makeAllEnabledConfig();
      const manager = new FeatureFlagManager(config);
      manager.setEnabled('alert-orchestration', false);
      expect(manager.isEnabled('alert-orchestration')).toBe(false);
    });

    it('should not affect other flags when changing one', () => {
      const config = makeAllEnabledConfig();
      const manager = new FeatureFlagManager(config);
      manager.setEnabled('react-orchestration', false);
      expect(manager.isEnabled('react-orchestration')).toBe(false);
      expect(manager.isEnabled('alert-orchestration')).toBe(true);
      expect(manager.isEnabled('iteration-orchestration')).toBe(true);
    });
  });

  describe('getConfig / updateConfig', () => {
    it('should return a copy (not a reference)', () => {
      const manager = new FeatureFlagManager();
      const config1 = manager.getConfig();
      config1.flags['react-orchestration'] = true;
      expect(manager.isEnabled('react-orchestration')).toBe(false);
    });

    it('should update the entire config', () => {
      const manager = new FeatureFlagManager();
      manager.updateConfig(makeAllEnabledConfig());
      expect(manager.isEnabled('react-orchestration')).toBe(true);
    });
  });

  describe('comparison mode', () => {
    it('should report comparison mode disabled by default', () => {
      const manager = new FeatureFlagManager();
      expect(manager.isComparisonModeEnabled()).toBe(false);
    });

    it('should check if comparison mode is enabled for a specific flow', () => {
      const config = makeDefaultConfig();
      config.comparisonMode.enabled = true;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      expect(manager.isComparisonEnabledFor('react-orchestration')).toBe(true);
      expect(manager.isComparisonEnabledFor('alert-orchestration')).toBe(false);
    });

    it('should return false when comparison mode is globally disabled', () => {
      const config = makeDefaultConfig();
      config.comparisonMode.enabled = false;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      expect(manager.isComparisonEnabledFor('react-orchestration')).toBe(false);
    });
  });

  describe('runComparison', () => {
    it('should execute both functions and detect no differences', async () => {
      const config = makeDefaultConfig();
      config.comparisonMode.enabled = true;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      const smFn = jest.fn().mockResolvedValue({ answer: 'same' });
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'same' });
      const result = await manager.runComparison('react-orchestration', smFn, legacyFn);
      expect(smFn).toHaveBeenCalledTimes(1);
      expect(legacyFn).toHaveBeenCalledTimes(1);
      expect(result.hasDifferences).toBe(false);
    });

    it('should detect differences between results', async () => {
      const config = makeDefaultConfig();
      config.comparisonMode.enabled = true;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      const smFn = jest.fn().mockResolvedValue({ answer: 'sm' });
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'legacy' });
      const result = await manager.runComparison('react-orchestration', smFn, legacyFn);
      expect(result.hasDifferences).toBe(true);
      expect(result.differences!.length).toBeGreaterThan(0);
    });

    it('should handle state machine error', async () => {
      const config = makeDefaultConfig();
      config.comparisonMode.enabled = true;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      const smFn = jest.fn().mockRejectedValue(new Error('SM error'));
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'legacy' });
      const result = await manager.runComparison('react-orchestration', smFn, legacyFn);
      expect(result.stateMachineError).toBeDefined();
      expect(result.hasDifferences).toBe(true);
    });
  });

  describe('route', () => {
    it('should route to state machine when flag is enabled', async () => {
      const config = makeDefaultConfig();
      config.flags['react-orchestration'] = true;
      const manager = new FeatureFlagManager(config);
      const smFn = jest.fn().mockResolvedValue({ answer: 'sm' });
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'legacy' });
      const result = await manager.route('react-orchestration', smFn, legacyFn);
      expect(smFn).toHaveBeenCalledTimes(1);
      expect(legacyFn).not.toHaveBeenCalled();
      expect(result).toEqual({ answer: 'sm' });
    });

    it('should route to legacy when flag is disabled', async () => {
      const manager = new FeatureFlagManager();
      const smFn = jest.fn().mockResolvedValue({ answer: 'sm' });
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'legacy' });
      const result = await manager.route('react-orchestration', smFn, legacyFn);
      expect(legacyFn).toHaveBeenCalledTimes(1);
      expect(smFn).not.toHaveBeenCalled();
      expect(result).toEqual({ answer: 'legacy' });
    });

    it('should route to legacy for unknown flow IDs', async () => {
      const manager = new FeatureFlagManager();
      const smFn = jest.fn().mockResolvedValue({ answer: 'sm' });
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'legacy' });
      const result = await manager.route('unknown-flow' as any, smFn, legacyFn);
      expect(legacyFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ answer: 'legacy' });
    });

    it('should use comparison mode when enabled, returning legacy result', async () => {
      const config = makeDefaultConfig();
      config.flags['react-orchestration'] = true;
      config.comparisonMode.enabled = true;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      const smFn = jest.fn().mockResolvedValue({ answer: 'sm' });
      const legacyFn = jest.fn().mockResolvedValue({ answer: 'legacy' });
      const result = await manager.route('react-orchestration', smFn, legacyFn);
      expect(smFn).toHaveBeenCalledTimes(1);
      expect(legacyFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ answer: 'legacy' });
    });
  });

  describe('getComparisonLog', () => {
    it('should return empty log initially', () => {
      const manager = new FeatureFlagManager();
      expect(manager.getComparisonLog()).toEqual([]);
    });

    it('should record comparison results', async () => {
      const config = makeDefaultConfig();
      config.comparisonMode.enabled = true;
      config.comparisonMode.enabledFor = ['react-orchestration'];
      const manager = new FeatureFlagManager(config);
      await manager.runComparison(
        'react-orchestration',
        jest.fn().mockResolvedValue({ a: 1 }),
        jest.fn().mockResolvedValue({ a: 2 }),
      );
      const log = manager.getComparisonLog();
      expect(log.length).toBe(1);
      expect(log[0].flowId).toBe('react-orchestration');
    });
  });

  // ============================================================
  // Control Point Tests (I5.14)
  // ============================================================

  describe('CONTROL_POINT_DEFINITIONS', () => {
    it('should define exactly 10 control points', () => {
      expect(CONTROL_POINT_DEFINITIONS).toHaveLength(10);
    });

    it('should have all expected keys', () => {
      const keys = CONTROL_POINT_DEFINITIONS.map((d) => d.key);
      expect(keys).toContain('use_pg_datastore');
      expect(keys).toContain('use_python_core');
      expect(keys).toContain('use_event_bus');
      expect(keys).toContain('use_brain_loop_engine');
      expect(keys).toContain('use_device_driver');
      expect(keys).toContain('use_skill_capsule');
      expect(keys).toContain('use_alert_pipeline');
      expect(keys).toContain('use_vector_search_tools');
      expect(keys).toContain('use_syslog_manager');
      expect(keys).toContain('use_snmp_trap_receiver');
    });

    it('should have use_pg_datastore with no dependencies', () => {
      const pg = CONTROL_POINT_DEFINITIONS.find((d) => d.key === 'use_pg_datastore');
      expect(pg!.dependencies).toEqual([]);
    });

    it('should have use_python_core depending on use_pg_datastore', () => {
      const py = CONTROL_POINT_DEFINITIONS.find((d) => d.key === 'use_python_core');
      expect(py!.dependencies).toEqual(['use_pg_datastore']);
    });

    it('should have use_vector_search_tools depending on pg + python_core', () => {
      const vs = CONTROL_POINT_DEFINITIONS.find((d) => d.key === 'use_vector_search_tools');
      expect(vs!.dependencies).toEqual(['use_pg_datastore', 'use_python_core']);
    });
  });

  describe('isControlPointEnabled', () => {
    it('should default all control points to OFF', () => {
      const manager = new FeatureFlagManager();
      for (const def of CONTROL_POINT_DEFINITIONS) {
        expect(manager.isControlPointEnabled(def.key)).toBe(false);
      }
    });
  });

  describe('setControlPointEnabled — dependency validation', () => {
    it('should enable a flag with no dependencies', async () => {
      const manager = new FeatureFlagManager();
      const error = await manager.setControlPointEnabled('use_pg_datastore', true);
      expect(error).toBeNull();
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);
    });

    it('should reject enabling a flag when dependencies are not met', async () => {
      const manager = new FeatureFlagManager();
      const error = await manager.setControlPointEnabled('use_python_core', true);
      expect(error).not.toBeNull();
      expect(error!.missingDependencies).toContain('use_pg_datastore');
      expect(manager.isControlPointEnabled('use_python_core')).toBe(false);
    });

    it('should allow enabling after dependencies are satisfied', async () => {
      const manager = new FeatureFlagManager();
      await manager.setControlPointEnabled('use_pg_datastore', true);
      const error = await manager.setControlPointEnabled('use_python_core', true);
      expect(error).toBeNull();
      expect(manager.isControlPointEnabled('use_python_core')).toBe(true);
    });

    it('should reject disabling a flag that others depend on', async () => {
      const manager = new FeatureFlagManager();
      await manager.setControlPointEnabled('use_pg_datastore', true);
      await manager.setControlPointEnabled('use_python_core', true);
      const error = await manager.setControlPointEnabled('use_pg_datastore', false);
      expect(error).not.toBeNull();
      expect(error!.dependentFlags).toContain('use_python_core');
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);
    });

    it('should allow disabling after dependents are disabled first', async () => {
      const manager = new FeatureFlagManager();
      await manager.setControlPointEnabled('use_pg_datastore', true);
      await manager.setControlPointEnabled('use_python_core', true);
      await manager.setControlPointEnabled('use_python_core', false);
      const error = await manager.setControlPointEnabled('use_pg_datastore', false);
      expect(error).toBeNull();
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(false);
    });

    it('should validate multi-level dependency chain', async () => {
      const manager = new FeatureFlagManager();
      // use_vector_search_tools depends on use_pg_datastore + use_python_core
      // use_python_core depends on use_pg_datastore
      const err1 = await manager.setControlPointEnabled('use_vector_search_tools', true);
      expect(err1).not.toBeNull();

      await manager.setControlPointEnabled('use_pg_datastore', true);
      const err2 = await manager.setControlPointEnabled('use_vector_search_tools', true);
      expect(err2).not.toBeNull(); // still missing use_python_core

      await manager.setControlPointEnabled('use_python_core', true);
      const err3 = await manager.setControlPointEnabled('use_vector_search_tools', true);
      expect(err3).toBeNull();
      expect(manager.isControlPointEnabled('use_vector_search_tools')).toBe(true);
    });

    it('should return error for unknown control point key', async () => {
      const manager = new FeatureFlagManager();
      const error = await manager.setControlPointEnabled('unknown_flag' as ControlPointKey, true);
      expect(error).not.toBeNull();
      expect(error!.message).toContain('Unknown control point');
    });
  });

  describe('getAllControlPoints', () => {
    it('should return all 10 control points with their states', () => {
      const manager = new FeatureFlagManager();
      const points = manager.getAllControlPoints();
      expect(points).toHaveLength(10);
      for (const p of points) {
        expect(p.enabled).toBe(false);
        expect(p.description).toBeTruthy();
      }
    });

    it('should reflect enabled state after toggle', async () => {
      const manager = new FeatureFlagManager();
      await manager.setControlPointEnabled('use_pg_datastore', true);
      const points = manager.getAllControlPoints();
      const pg = points.find((p) => p.key === 'use_pg_datastore');
      expect(pg!.enabled).toBe(true);
    });
  });

  // ============================================================
  // DataStore persistence tests
  // ============================================================

  describe('DataStore integration', () => {
    it('should seed control points when loadFromStore finds empty table', async () => {
      const mockStore = makeMockDataStore();
      const manager = new FeatureFlagManager();
      manager.setDataStore(mockStore as any);
      await manager.loadFromStore();

      // query was called to check existing rows
      expect(mockStore.query).toHaveBeenCalledWith('SELECT flag_key, enabled FROM feature_flags');
      // execute was called 10 times to seed each control point
      expect(mockStore.execute).toHaveBeenCalledTimes(10);
    });

    it('should hydrate from existing rows', async () => {
      const mockStore = makeMockDataStore();
      mockStore.query.mockResolvedValueOnce([
        { flag_key: 'use_pg_datastore', enabled: true },
        { flag_key: 'use_python_core', enabled: false },
      ]);
      const manager = new FeatureFlagManager();
      manager.setDataStore(mockStore as any);
      await manager.loadFromStore();

      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);
      expect(manager.isControlPointEnabled('use_python_core')).toBe(false);
    });

    it('should persist flag changes to DataStore', async () => {
      const mockStore = makeMockDataStore();
      const manager = new FeatureFlagManager();
      manager.setDataStore(mockStore as any);

      await manager.setControlPointEnabled('use_pg_datastore', true);

      expect(mockStore.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE feature_flags'),
        [true, 'use_pg_datastore'],
      );
    });

    it('should not throw when DataStore is not set', async () => {
      const manager = new FeatureFlagManager();
      // No setDataStore call — should work in-memory only
      await expect(manager.loadFromStore()).resolves.not.toThrow();
      const error = await manager.setControlPointEnabled('use_pg_datastore', true);
      expect(error).toBeNull();
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);
    });

    it('should handle DataStore query failure gracefully', async () => {
      const mockStore = makeMockDataStore();
      mockStore.query.mockRejectedValueOnce(new Error('DB down'));
      const manager = new FeatureFlagManager();
      manager.setDataStore(mockStore as any);
      // Should not throw, just log warning
      await expect(manager.loadFromStore()).resolves.not.toThrow();
    });
  });

  // ============================================================
  // Isolation: control points don't affect flow flags
  // ============================================================

  describe('isolation between flow flags and control points', () => {
    it('should not interfere: flow flags and control points are independent', async () => {
      const config = makeAllEnabledConfig();
      const manager = new FeatureFlagManager(config);

      // All flow flags ON
      expect(manager.isEnabled('react-orchestration')).toBe(true);
      // All control points OFF
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(false);

      // Toggle control point — flow flags unaffected
      await manager.setControlPointEnabled('use_pg_datastore', true);
      expect(manager.isEnabled('react-orchestration')).toBe(true);

      // Toggle flow flag — control points unaffected
      manager.setEnabled('react-orchestration', false);
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);
    });
  });
});
