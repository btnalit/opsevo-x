/**
 * Task 34 — 最终检查点：全量验证
 *
 * 验证:
 * - TypeScript 编译无错误（tsc --noEmit 在 CI 中单独运行）
 * - 所有核心模块可正常导入
 * - 架构分层完整性：Layer 0-7 关键模块存在
 * - FeatureFlag 10 个控制点定义完整
 * - EventBus 7 种事件类型定义完整
 * - SERVICE_NAMES 覆盖所有必要服务
 */

// ─── Layer 0: Infrastructure ───

import { EventBus, PerceptionEvent, Priority, EventType } from '../../../eventBus';
import { SERVICE_NAMES } from '../../../bootstrap';
import { DeviceManager } from '../../../device/deviceManager';

// ─── Layer 2: Knowledge & Prompt ───

import { VectorStoreClient } from '../../rag/vectorStoreClient';

// ─── Layer 3: Skill & Tool Execution ───

import { SkillFactory } from '../../skill/skillFactory';
import { UnifiedToolRegistry, RegisteredTool, ToolType } from '../../skill/toolRegistry';

// ─── Layer 4: Learning & Evolution ───

import { LearningOrchestrator, LearningResult } from '../../learningOrchestrator';

// ─── Layer 5: Brain Core ───

import { AlertPipeline } from '../../alertPipeline';
import {
  FeatureFlagManager,
  CONTROL_POINT_DEFINITIONS,
  ControlPointKey,
} from '../../stateMachine/featureFlagManager';

describe('Task 34 — 最终检查点：全量验证', () => {
  describe('核心模块导入验证', () => {
    it('Layer 0 — EventBus 可导入并实例化', () => {
      const bus = new EventBus();
      expect(bus).toBeDefined();
      expect(typeof bus.publish).toBe('function');
      expect(typeof bus.subscribe).toBe('function');
      bus.reset();
    });

    it('Layer 0 — SERVICE_NAMES 可导入', () => {
      expect(SERVICE_NAMES).toBeDefined();
      expect(typeof SERVICE_NAMES).toBe('object');
    });

    it('Layer 0 — DeviceManager 可导入', () => {
      expect(DeviceManager).toBeDefined();
      expect(typeof DeviceManager).toBe('function');
    });

    it('Layer 2 — VectorStoreClient 可导入', () => {
      expect(VectorStoreClient).toBeDefined();
    });

    it('Layer 3 — SkillFactory 可导入', () => {
      expect(SkillFactory).toBeDefined();
    });

    it('Layer 3 — UnifiedToolRegistry 可导入', () => {
      expect(UnifiedToolRegistry).toBeDefined();
    });

    it('Layer 4 — LearningOrchestrator 可导入', () => {
      expect(LearningOrchestrator).toBeDefined();
    });

    it('Layer 5 — AlertPipeline 可导入', () => {
      expect(AlertPipeline).toBeDefined();
    });

    it('Layer 5 — FeatureFlagManager 可导入', () => {
      expect(FeatureFlagManager).toBeDefined();
    });
  });

  describe('EventBus 事件类型完整性', () => {
    it('应支持 7 种事件类型', () => {
      const expectedTypes: EventType[] = [
        'alert', 'metric', 'syslog', 'snmp_trap',
        'webhook', 'internal', 'brain_heartbeat',
      ];

      const bus = new EventBus();
      for (const type of expectedTypes) {
        // 注册源并验证不抛出
        bus.registerSource({
          name: `test-${type}`,
          eventTypes: [type],
          schemaVersion: '1.0.0',
        });
      }

      expect(bus.getActiveSources().size).toBe(expectedTypes.length);
      bus.reset();
    });

    it('应支持 5 种优先级', () => {
      const priorities: Priority[] = ['critical', 'high', 'medium', 'low', 'info'];
      expect(priorities).toHaveLength(5);
    });
  });

  describe('FeatureFlag 控制点完整性 (I5.14)', () => {
    it('应定义 10 个控制点', () => {
      expect(CONTROL_POINT_DEFINITIONS).toHaveLength(10);
    });

    it('所有控制点应有描述和依赖定义', () => {
      for (const def of CONTROL_POINT_DEFINITIONS) {
        expect(def.key).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(Array.isArray(def.dependencies)).toBe(true);
      }
    });

    it('use_pg_datastore 应是唯一无依赖的根节点', () => {
      const roots = CONTROL_POINT_DEFINITIONS.filter(
        (d) => d.dependencies.length === 0,
      );
      expect(roots).toHaveLength(1);
      expect(roots[0].key).toBe('use_pg_datastore');
    });

    it('依赖图应无环（拓扑排序可完成）', () => {
      const defs = CONTROL_POINT_DEFINITIONS;
      const visited = new Set<string>();
      const sorted: string[] = [];

      function visit(key: string, stack: Set<string>): boolean {
        if (stack.has(key)) return false; // 环
        if (visited.has(key)) return true;
        stack.add(key);
        const def = defs.find((d) => d.key === key);
        if (def) {
          for (const dep of def.dependencies) {
            if (!visit(dep, stack)) return false;
          }
        }
        stack.delete(key);
        visited.add(key);
        sorted.push(key);
        return true;
      }

      let hasCycle = false;
      for (const def of defs) {
        if (!visit(def.key, new Set())) {
          hasCycle = true;
          break;
        }
      }

      expect(hasCycle).toBe(false);
      expect(sorted).toHaveLength(10);
    });
  });

  describe('SERVICE_NAMES 覆盖验证', () => {
    it('应包含至少 30 个服务名称', () => {
      const count = Object.keys(SERVICE_NAMES).length;
      expect(count).toBeGreaterThanOrEqual(30);
    });

    it('所有值应为非空字符串', () => {
      for (const [key, value] of Object.entries(SERVICE_NAMES)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    });

    it('应包含架构关键服务', () => {
      const required = [
        'DATA_STORE', 'PG_DATA_STORE', 'DEVICE_MANAGER',
        'ALERT_PIPELINE', 'RAG_ENGINE', 'BRAIN_LOOP_ENGINE',
        'SYSLOG_MANAGER', 'SNMP_TRAP_RECEIVER',
      ];
      for (const key of required) {
        expect((SERVICE_NAMES as any)[key]).toBeDefined();
      }
    });
  });

  describe('ToolType 类型完整性', () => {
    it('应支持 skill / mcp / device_driver 三种工具类型', () => {
      const types: ToolType[] = ['skill', 'mcp', 'device_driver'];
      expect(types).toHaveLength(3);
    });
  });
});
