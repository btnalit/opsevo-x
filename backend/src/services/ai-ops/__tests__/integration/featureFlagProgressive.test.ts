/**
 * Task 33.1 — FeatureFlag 渐进式切换验证
 *
 * 验证:
 * - 按阶段顺序逐步开启 Flag (I5.14)
 * - 每个阶段验证：功能等价性、错误率、数据一致性
 * - Flag 依赖关系：子 Flag 开启前父 Flag 必须已开启
 * - Flag 隔离性：切换不影响其他 Flag 控制的功能
 */

import {
  FeatureFlagManager,
  CONTROL_POINT_DEFINITIONS,
  ControlPointKey,
} from '../../stateMachine/featureFlagManager';

// ─── Helpers ───

function makeMockDataStore() {
  return {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
    transaction: jest.fn(),
    getPool: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn(),
  };
}

/**
 * 按 spec 定义的阶段顺序开启 Flag
 * use_pg_datastore → use_python_core → use_device_driver → use_event_bus
 * → use_brain_loop_engine → use_syslog_manager → use_snmp_trap_receiver
 * → use_skill_capsule → use_alert_pipeline → use_vector_search_tools
 */
const PROGRESSIVE_ORDER: ControlPointKey[] = [
  'use_pg_datastore',
  'use_python_core',
  'use_device_driver',
  'use_event_bus',
  'use_brain_loop_engine',
  'use_syslog_manager',
  'use_snmp_trap_receiver',
  'use_skill_capsule',
  'use_alert_pipeline',
  'use_vector_search_tools',
];

describe('Task 33.1 — FeatureFlag 渐进式切换验证', () => {
  let manager: FeatureFlagManager;
  let mockStore: ReturnType<typeof makeMockDataStore>;

  beforeEach(() => {
    manager = new FeatureFlagManager();
    mockStore = makeMockDataStore();
    manager.setDataStore(mockStore as any);
  });

  describe('渐进式开启顺序', () => {
    it('应按阶段顺序逐步开启所有 10 个 Flag，无依赖错误', async () => {
      for (const key of PROGRESSIVE_ORDER) {
        const error = await manager.setControlPointEnabled(key, true);
        expect(error).toBeNull();
        expect(manager.isControlPointEnabled(key)).toBe(true);
      }

      // 全部开启后验证
      for (const key of PROGRESSIVE_ORDER) {
        expect(manager.isControlPointEnabled(key)).toBe(true);
      }
    });

    it('每步开启后，之前已开启的 Flag 状态不变', async () => {
      const enabled: ControlPointKey[] = [];
      for (const key of PROGRESSIVE_ORDER) {
        await manager.setControlPointEnabled(key, true);
        enabled.push(key);

        // 验证所有已开启的 Flag 仍然为 true
        for (const prev of enabled) {
          expect(manager.isControlPointEnabled(prev)).toBe(true);
        }
      }
    });
  });

  describe('依赖关系校验', () => {
    it('跳过 use_pg_datastore 直接开启 use_python_core 应失败', async () => {
      const error = await manager.setControlPointEnabled('use_python_core', true);
      expect(error).not.toBeNull();
      expect(error!.missingDependencies).toContain('use_pg_datastore');
    });

    it('跳过 use_event_bus 直接开启 use_brain_loop_engine 应失败', async () => {
      await manager.setControlPointEnabled('use_pg_datastore', true);
      const error = await manager.setControlPointEnabled('use_brain_loop_engine', true);
      expect(error).not.toBeNull();
      expect(error!.missingDependencies).toContain('use_event_bus');
    });

    it('use_vector_search_tools 需要 pg + python_core 两个前置', async () => {
      await manager.setControlPointEnabled('use_pg_datastore', true);
      // 缺少 python_core
      const err1 = await manager.setControlPointEnabled('use_vector_search_tools', true);
      expect(err1).not.toBeNull();

      await manager.setControlPointEnabled('use_python_core', true);
      const err2 = await manager.setControlPointEnabled('use_vector_search_tools', true);
      expect(err2).toBeNull();
    });

    it('use_alert_pipeline 需要 pg + event_bus 两个前置', async () => {
      await manager.setControlPointEnabled('use_pg_datastore', true);
      const err1 = await manager.setControlPointEnabled('use_alert_pipeline', true);
      expect(err1).not.toBeNull();

      await manager.setControlPointEnabled('use_event_bus', true);
      const err2 = await manager.setControlPointEnabled('use_alert_pipeline', true);
      expect(err2).toBeNull();
    });

    it('所有 CONTROL_POINT_DEFINITIONS 的依赖关系均可验证', () => {
      for (const def of CONTROL_POINT_DEFINITIONS) {
        for (const dep of def.dependencies) {
          const depDef = CONTROL_POINT_DEFINITIONS.find((d) => d.key === dep);
          expect(depDef).toBeDefined();
        }
      }
    });
  });

  describe('反向禁用校验', () => {
    it('禁用被依赖的 Flag 应被拒绝', async () => {
      // 开启 pg → python_core
      await manager.setControlPointEnabled('use_pg_datastore', true);
      await manager.setControlPointEnabled('use_python_core', true);

      // 尝试禁用 pg（python_core 依赖它）
      const error = await manager.setControlPointEnabled('use_pg_datastore', false);
      expect(error).not.toBeNull();
      expect(error!.dependentFlags).toContain('use_python_core');
    });

    it('按反向顺序逐步禁用所有 Flag 应成功', async () => {
      // 先全部开启
      for (const key of PROGRESSIVE_ORDER) {
        await manager.setControlPointEnabled(key, true);
      }

      // 按反向顺序禁用
      const reversed = [...PROGRESSIVE_ORDER].reverse();
      for (const key of reversed) {
        const error = await manager.setControlPointEnabled(key, false);
        expect(error).toBeNull();
        expect(manager.isControlPointEnabled(key)).toBe(false);
      }
    });
  });

  describe('Flag 隔离性 (PI.6)', () => {
    it('Control Point Flag 切换不影响 Flow Flag', async () => {
      manager.setEnabled('react-orchestration', true);
      await manager.setControlPointEnabled('use_pg_datastore', true);

      expect(manager.isEnabled('react-orchestration')).toBe(true);
      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);

      await manager.setControlPointEnabled('use_pg_datastore', false);
      expect(manager.isEnabled('react-orchestration')).toBe(true);
    });

    it('Flow Flag 切换不影响 Control Point Flag', async () => {
      await manager.setControlPointEnabled('use_pg_datastore', true);
      manager.setEnabled('react-orchestration', true);
      manager.setEnabled('react-orchestration', false);

      expect(manager.isControlPointEnabled('use_pg_datastore')).toBe(true);
    });

    it('开启一个 Control Point 不影响其他未开启的 Control Point', async () => {
      await manager.setControlPointEnabled('use_pg_datastore', true);

      const others = CONTROL_POINT_DEFINITIONS
        .filter((d) => d.key !== 'use_pg_datastore')
        .map((d) => d.key);

      for (const key of others) {
        expect(manager.isControlPointEnabled(key)).toBe(false);
      }
    });
  });

  describe('PostgreSQL 持久化', () => {
    it('每次 Flag 切换都应持久化到 DataStore', async () => {
      await manager.setControlPointEnabled('use_pg_datastore', true);

      expect(mockStore.execute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE feature_flags'),
        [true, 'use_pg_datastore'],
      );
    });

    it('从 DataStore 恢复后状态一致', async () => {
      mockStore.query.mockResolvedValueOnce([
        { flag_key: 'use_pg_datastore', enabled: true },
        { flag_key: 'use_python_core', enabled: true },
        { flag_key: 'use_event_bus', enabled: false },
      ]);

      const restored = new FeatureFlagManager();
      restored.setDataStore(mockStore as any);
      await restored.loadFromStore();

      expect(restored.isControlPointEnabled('use_pg_datastore')).toBe(true);
      expect(restored.isControlPointEnabled('use_python_core')).toBe(true);
      expect(restored.isControlPointEnabled('use_event_bus')).toBe(false);
    });
  });
});
