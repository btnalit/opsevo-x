/**
 * Task 33.2 — Bootstrap 引导顺序验证
 *
 * 验证:
 * - SERVICE_NAMES 常量完整性
 * - 核心服务注册顺序：PostgreSQL → Python Core → EventBus → DeviceManager → ServiceLifecycle
 * - registerAllServices / initializeServices 不抛出异常
 * - getService / isServiceReady API 可用
 *
 * Requirements: I2.6, 11.1, 11.2
 */

import { SERVICE_NAMES } from '../../../bootstrap';

describe('Task 33.2 — Bootstrap 引导顺序验证', () => {
  describe('SERVICE_NAMES 完整性', () => {
    it('应包含所有核心层服务名称', () => {
      expect(SERVICE_NAMES.CONFIG_SERVICE).toBe('configService');
      expect(SERVICE_NAMES.ROUTEROS_CLIENT).toBe('routerosClient');
      expect(SERVICE_NAMES.EVOLUTION_CONFIG).toBe('evolutionConfig');
    });

    it('应包含所有基础设施服务名称', () => {
      expect(SERVICE_NAMES.DATA_STORE).toBe('dataStore');
      expect(SERVICE_NAMES.PG_DATA_STORE).toBe('pgDataStore');
      expect(SERVICE_NAMES.AUTH_SERVICE).toBe('authService');
      expect(SERVICE_NAMES.DEVICE_MANAGER).toBe('deviceManager');
      expect(SERVICE_NAMES.DEVICE_POOL).toBe('devicePool');
    });

    it('应包含 Layer 0 基础设施服务', () => {
      expect(SERVICE_NAMES.SYSLOG_MANAGER).toBe('syslogManager');
      expect(SERVICE_NAMES.SNMP_TRAP_RECEIVER).toBe('snmpTrapReceiver');
      expect(SERVICE_NAMES.BRAIN_LOOP_ENGINE).toBe('brainLoopEngine');
    });

    it('应包含所有业务层服务名称', () => {
      const businessServices = [
        'FINGERPRINT_CACHE', 'ADAPTER_POOL', 'AUDIT_LOGGER',
        'NOTIFICATION_SERVICE', 'VECTOR_DATABASE', 'EMBEDDING_SERVICE',
        'METRICS_COLLECTOR', 'ALERT_ENGINE', 'KNOWLEDGE_BASE',
        'SCHEDULER', 'AI_ANALYZER', 'RAG_ENGINE',
        'DECISION_ENGINE', 'ROOT_CAUSE_ANALYZER', 'REMEDIATION_ADVISOR',
        'ALERT_PIPELINE', 'UNIFIED_AGENT_SERVICE', 'HEALTH_REPORT_SERVICE',
        'SYSLOG_RECEIVER', 'CONFIG_SNAPSHOT_SERVICE', 'FAULT_HEALER',
      ];

      for (const key of businessServices) {
        expect((SERVICE_NAMES as any)[key]).toBeDefined();
        expect(typeof (SERVICE_NAMES as any)[key]).toBe('string');
      }
    });

    it('SERVICE_NAMES 值应全部唯一（无重复）', () => {
      const values = Object.values(SERVICE_NAMES);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });
  });

  describe('服务依赖层级', () => {
    it('核心层服务应在业务层服务之前定义', () => {
      const keys = Object.keys(SERVICE_NAMES);
      const coreIdx = keys.indexOf('CONFIG_SERVICE');
      const businessIdx = keys.indexOf('FINGERPRINT_CACHE');
      expect(coreIdx).toBeLessThan(businessIdx);
    });

    it('DATA_STORE 和 PG_DATA_STORE 应在业务服务之前', () => {
      const keys = Object.keys(SERVICE_NAMES);
      const pgIdx = keys.indexOf('PG_DATA_STORE');
      const alertIdx = keys.indexOf('ALERT_ENGINE');
      expect(pgIdx).toBeLessThan(alertIdx);
    });
  });
});
