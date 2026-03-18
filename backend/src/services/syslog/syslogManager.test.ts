/**
 * SyslogManager 单元测试
 *
 * Tests: RFC 3164/5424 parsing, severity→priority mapping, source resolution
 * (exact IP > CIDR longest prefix), filter rules, parse rule engine, and
 * EventBus integration.
 */

import { SyslogManager, ParsedSyslog } from './syslogManager';
import { EventBus, PerceptionEvent } from '../eventBus';
import type { DataStore, DataStoreTransaction } from '../dataStore';
import type { Pool } from 'pg';

// ─── Mock DataStore ───

function createMockDataStore(): DataStore {
  return {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
    transaction: jest.fn(async <T>(fn: (tx: DataStoreTransaction) => Promise<T>): Promise<T> => {
      const tx: DataStoreTransaction = {
        query: jest.fn().mockResolvedValue([]),
        queryOne: jest.fn().mockResolvedValue(null),
        execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
      };
      return fn(tx);
    }),
    getPool: jest.fn().mockReturnValue({} as Pool),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('SyslogManager', () => {
  let manager: SyslogManager;
  let eventBus: EventBus;
  let dataStore: DataStore;

  beforeEach(async () => {
    eventBus = new EventBus();
    dataStore = createMockDataStore();
    manager = new SyslogManager(dataStore, eventBus);
  });

  afterEach(async () => {
    await manager.stop();
    eventBus.reset();
  });

  // ─── RFC 3164 Parsing ───

  describe('RFC 3164 parsing', () => {
    it('should parse a standard RFC 3164 message', () => {
      const raw = '<134>Jan 15 10:30:00 myhost sshd[1234]: Accepted publickey for user';
      const parsed = manager.parse(raw, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.facility).toBe(16); // local0
      expect(parsed!.severity).toBe(6);  // info
      expect(parsed!.hostname).toBe('myhost');
      expect(parsed!.message).toContain('sshd[1234]: Accepted publickey');
      expect(parsed!.format).toBe('rfc3164');
    });

    it('should parse message without timestamp', () => {
      const raw = '<13>myhost kernel: something happened';
      const parsed = manager.parse(raw, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.facility).toBe(1); // user
      expect(parsed!.severity).toBe(5); // notice
    });

    it('should return null for non-syslog message', () => {
      const parsed = manager.parse('not a syslog message', '10.0.0.1');
      expect(parsed).toBeNull();
    });

    it('should handle single-digit day in timestamp', () => {
      const raw = '<134>Jan  5 08:00:00 host1 test message';
      const parsed = manager.parse(raw, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.hostname).toBe('host1');
    });
  });

  // ─── RFC 5424 Parsing ───

  describe('RFC 5424 parsing', () => {
    it('should parse a standard RFC 5424 message', () => {
      const raw = '<165>1 2024-01-15T10:30:00.000Z myhost myapp 1234 ID47 - Hello world';
      const parsed = manager.parse(raw, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.facility).toBe(20); // local4
      expect(parsed!.severity).toBe(5);  // notice
      expect(parsed!.hostname).toBe('myhost');
      expect(parsed!.appName).toBe('myapp');
      expect(parsed!.procId).toBe('1234');
      expect(parsed!.msgId).toBe('ID47');
      expect(parsed!.message).toBe('Hello world');
      expect(parsed!.format).toBe('rfc5424');
    });

    it('should handle NILVALUE fields', () => {
      const raw = '<134>1 - - - - - - Just a message';
      const parsed = manager.parse(raw, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.hostname).toBe('unknown');
      expect(parsed!.message).toBe('Just a message');
    });

    it('should handle structured data', () => {
      const raw = '<134>1 2024-01-15T10:30:00Z host app - - [exampleSDID@32473 iut="3"] msg';
      const parsed = manager.parse(raw, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.structuredData).toContain('exampleSDID');
      expect(parsed!.message).toBe('msg');
    });
  });

  // ─── Severity → Priority Mapping ───

  describe('severity to priority mapping', () => {
    const cases: Array<[number, string, string]> = [
      [0, 'critical', 'Emergency'],
      [1, 'critical', 'Alert'],
      [2, 'high', 'Critical'],
      [3, 'high', 'Error'],
      [4, 'medium', 'Warning'],
      [5, 'low', 'Notice'],
      [6, 'low', 'Info'],
      [7, 'info', 'Debug'],
    ];

    for (const [severity, expectedPriority, label] of cases) {
      it(`should map severity ${severity} (${label}) to priority "${expectedPriority}"`, async () => {
        const received: PerceptionEvent[] = [];
        eventBus.subscribe('syslog', {
          id: 'test-sub',
          onEvent: async (e) => { received.push(e); },
        });

        // Construct a message with the target severity
        // PRI = facility * 8 + severity; use facility 1 (user)
        const pri = 1 * 8 + severity;
        const raw = `<${pri}>Jan 15 10:00:00 testhost test message sev ${severity}`;

        await manager.handleRawMessage(raw, '10.0.0.1');

        expect(received).toHaveLength(1);
        expect(received[0].priority).toBe(expectedPriority);
      });
    }
  });

  // ─── Source Resolution ───

  describe('source resolution', () => {
    it('should return unknown for unmapped IP', () => {
      const result = manager.resolveSource('192.168.1.100');
      expect(result.known).toBe(false);
      expect(result.deviceId).toBeUndefined();
    });

    it('should match exact IP over CIDR', async () => {
      // Add CIDR mapping first
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      await manager.addSourceMapping({
        sourceIp: '192.168.1.0',
        sourceCidr: '192.168.1.0/24',
        deviceId: 'cidr-device',
        description: 'subnet',
        lastSeenAt: null,
        messageRate: 0,
      });

      // Add exact IP mapping
      await manager.addSourceMapping({
        sourceIp: '192.168.1.50',
        sourceCidr: null,
        deviceId: 'exact-device',
        description: 'exact',
        lastSeenAt: null,
        messageRate: 0,
      });

      const result = manager.resolveSource('192.168.1.50');
      expect(result.known).toBe(true);
      expect(result.deviceId).toBe('exact-device');
    });

    it('should use longest prefix match for CIDR', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addSourceMapping({
        sourceIp: '10.0.0.0',
        sourceCidr: '10.0.0.0/8',
        deviceId: 'broad-device',
        description: '/8',
        lastSeenAt: null,
        messageRate: 0,
      });

      await manager.addSourceMapping({
        sourceIp: '10.1.0.0',
        sourceCidr: '10.1.0.0/16',
        deviceId: 'narrow-device',
        description: '/16',
        lastSeenAt: null,
        messageRate: 0,
      });

      const result = manager.resolveSource('10.1.2.3');
      expect(result.known).toBe(true);
      expect(result.deviceId).toBe('narrow-device');
    });

    it('should fall back to broader CIDR when narrow does not match', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addSourceMapping({
        sourceIp: '10.0.0.0',
        sourceCidr: '10.0.0.0/8',
        deviceId: 'broad-device',
        description: '/8',
        lastSeenAt: null,
        messageRate: 0,
      });

      await manager.addSourceMapping({
        sourceIp: '10.1.0.0',
        sourceCidr: '10.1.0.0/16',
        deviceId: 'narrow-device',
        description: '/16',
        lastSeenAt: null,
        messageRate: 0,
      });

      // 10.2.x.x matches /8 but not /16
      const result = manager.resolveSource('10.2.3.4');
      expect(result.known).toBe(true);
      expect(result.deviceId).toBe('broad-device');
    });
  });

  // ─── Filter Rules ───

  describe('filter rules', () => {
    it('should drop messages matching a drop filter', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addFilterRule({
        name: 'drop-debug',
        sourceIp: null,
        facility: null,
        severityMin: 7,
        severityMax: 7,
        keyword: null,
        action: 'drop',
        enabled: true,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      // severity 7 = debug → should be dropped
      const raw = '<15>Jan 15 10:00:00 host debug message'; // PRI 15 = facility 1, severity 7
      await manager.handleRawMessage(raw, '10.0.0.1');

      expect(received).toHaveLength(0);
    });

    it('should pass messages not matching any filter', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addFilterRule({
        name: 'drop-debug',
        sourceIp: null,
        facility: null,
        severityMin: 7,
        severityMax: 7,
        keyword: null,
        action: 'drop',
        enabled: true,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      // severity 4 = warning → should pass
      const raw = '<12>Jan 15 10:00:00 host warning message'; // PRI 12 = facility 1, severity 4
      await manager.handleRawMessage(raw, '10.0.0.1');

      expect(received).toHaveLength(1);
    });

    it('should filter by keyword', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addFilterRule({
        name: 'drop-keepalive',
        sourceIp: null,
        facility: null,
        severityMin: null,
        severityMax: null,
        keyword: 'keepalive',
        action: 'drop',
        enabled: true,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      const raw = '<134>Jan 15 10:00:00 host KEEPALIVE check passed';
      await manager.handleRawMessage(raw, '10.0.0.1');

      expect(received).toHaveLength(0);
    });

    it('should filter by source IP', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addFilterRule({
        name: 'drop-noisy-host',
        sourceIp: '10.0.0.99',
        facility: null,
        severityMin: null,
        severityMax: null,
        keyword: null,
        action: 'drop',
        enabled: true,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      // From filtered IP
      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg', '10.0.0.99');
      expect(received).toHaveLength(0);

      // From different IP
      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg', '10.0.0.1');
      expect(received).toHaveLength(1);
    });
  });

  // ─── Custom Parse Rules ───

  describe('custom parse rules', () => {
    it('should extract fields using regex parse rule', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addParseRule({
        name: 'extract-user',
        pattern: 'user (?<username>\\w+) logged in from (?<loginIp>[\\d.]+)',
        patternType: 'regex',
        extractFields: ['username', 'loginIp'],
        priority: 10,
        enabled: true,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      const raw = '<134>Jan 15 10:00:00 host user admin logged in from 192.168.1.5';
      await manager.handleRawMessage(raw, '10.0.0.1');

      expect(received).toHaveLength(1);
      const payload = received[0].payload as Record<string, unknown>;
      const fields = payload.extractedFields as Record<string, string>;
      expect(fields.username).toBe('admin');
      expect(fields.loginIp).toBe('192.168.1.5');
    });

    it('should extract fields using grok-like parse rule', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addParseRule({
        name: 'extract-ip',
        pattern: 'from %{IP:srcIp}',
        patternType: 'grok',
        extractFields: ['srcIp'],
        priority: 10,
        enabled: true,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      const raw = '<134>Jan 15 10:00:00 host connection from 10.1.2.3 accepted';
      await manager.handleRawMessage(raw, '10.0.0.1');

      expect(received).toHaveLength(1);
      const payload = received[0].payload as Record<string, unknown>;
      const fields = payload.extractedFields as Record<string, string>;
      expect(fields.srcIp).toBe('10.1.2.3');
    });
  });

  // ─── EventBus Integration ───

  describe('EventBus integration', () => {
    it('should publish PerceptionEvent with type=syslog', async () => {
      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      const raw = '<134>Jan 15 10:00:00 myhost test message';
      await manager.handleRawMessage(raw, '10.0.0.1');

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('syslog');
      expect(received[0].source).toBe('syslog:10.0.0.1');
      expect(received[0].schemaVersion).toBe('1.0.0');
    });

    it('should include sourceIp in payload', async () => {
      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg', '192.168.1.1');

      const payload = received[0].payload as Record<string, unknown>;
      expect(payload.sourceIp).toBe('192.168.1.1');
    });

    it('should fill deviceId when source is mapped', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await manager.addSourceMapping({
        sourceIp: '10.0.0.5',
        sourceCidr: null,
        deviceId: 'device-abc',
        description: 'test device',
        lastSeenAt: null,
        messageRate: 0,
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (e) => { received.push(e); },
      });

      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg', '10.0.0.5');

      expect(received[0].deviceId).toBe('device-abc');
    });

    it('should publish unknown-source alert for unmapped IPs', async () => {
      const internalEvents: PerceptionEvent[] = [];
      eventBus.subscribe('internal', {
        id: 'internal-sub',
        onEvent: async (e) => { internalEvents.push(e); },
      });

      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg', '99.99.99.99');

      expect(internalEvents).toHaveLength(1);
      expect((internalEvents[0].payload as Record<string, unknown>).alert).toBe('unknown_syslog_source');
    });
  });

  // ─── Source Stats ───

  describe('source stats', () => {
    it('should track message count per source', async () => {
      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg1', '10.0.0.1');
      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg2', '10.0.0.1');
      await manager.handleRawMessage('<134>Jan 15 10:00:00 host msg3', '10.0.0.2');

      const stats = manager.getSourceStats();
      expect(stats.get('10.0.0.1')?.messageCount).toBe(2);
      expect(stats.get('10.0.0.2')?.messageCount).toBe(1);
    });
  });

  // ─── CRUD operations ───

  describe('CRUD operations', () => {
    it('should add and remove parse rules', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      const rule = await manager.addParseRule({
        name: 'test-rule',
        pattern: '.*',
        patternType: 'regex',
        extractFields: [],
        priority: 50,
        enabled: true,
      });

      expect(manager.getParseRules()).toHaveLength(1);
      expect(rule.id).toBeDefined();

      const removed = await manager.removeParseRule(rule.id);
      expect(removed).toBe(true);
      expect(manager.getParseRules()).toHaveLength(0);
    });

    it('should add and remove source mappings', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      const mapping = await manager.addSourceMapping({
        sourceIp: '10.0.0.1',
        sourceCidr: null,
        deviceId: 'dev-1',
        description: 'test',
        lastSeenAt: null,
        messageRate: 0,
      });

      expect(manager.getSourceMappings()).toHaveLength(1);

      const removed = await manager.removeSourceMapping(mapping.id);
      expect(removed).toBe(true);
      expect(manager.getSourceMappings()).toHaveLength(0);
    });

    it('should add and remove filter rules', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      const rule = await manager.addFilterRule({
        name: 'test-filter',
        sourceIp: null,
        facility: null,
        severityMin: 7,
        severityMax: 7,
        keyword: null,
        action: 'drop',
        enabled: true,
      });

      expect(manager.getFilterRules()).toHaveLength(1);

      const removed = await manager.removeFilterRule(rule.id);
      expect(removed).toBe(true);
      expect(manager.getFilterRules()).toHaveLength(0);
    });
  });
});
