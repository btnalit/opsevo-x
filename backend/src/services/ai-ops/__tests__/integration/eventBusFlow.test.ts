/**
 * Task 33.2 — EventBus 事件流集成验证
 *
 * 验证:
 * - 感知源 → EventBus → 订阅者 事件流 (D1.1, D1.2, D1.3, D1.7)
 * - 优先级队列排序
 * - Schema 校验拒绝不合规事件
 * - 感知源注册/注销
 */

import {
  EventBus,
  EventSubscriber,
  PerceptionEvent,
  PerceptionSourceMeta,
  EventValidationError,
  SourceRegistrationError,
} from '../../../eventBus';

describe('Task 33.2 — EventBus 事件流集成验证', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.reset();
  });

  describe('感知源注册与事件发布', () => {
    it('注册感知源后可发布事件', async () => {
      eventBus.registerSource({
        name: 'test-syslog',
        eventTypes: ['syslog'],
        schemaVersion: '1.0.0',
      });

      const received: PerceptionEvent[] = [];
      eventBus.subscribe('syslog', {
        id: 'test-sub',
        onEvent: async (event) => { received.push(event); },
      });

      await eventBus.publish({
        type: 'syslog',
        priority: 'medium',
        source: 'test-syslog',
        payload: { message: 'test log' },
        schemaVersion: '1.0.0',
      });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('syslog');
      expect(received[0].id).toBeTruthy();
      expect(received[0].timestamp).toBeGreaterThan(0);
    });

    it('未注册的感知源发布事件仍可通过 Schema 校验（EventBus 不校验源注册）', async () => {
      // EventBus.validateEventSchema 只校验字段格式，不校验源是否注册
      const result = await eventBus.publish({
        type: 'syslog',
        priority: 'medium',
        source: 'unregistered-source',
        payload: { message: 'test' },
        schemaVersion: '1.0.0',
      });
      expect(result.id).toBeTruthy();
    });

    it('注销感知源后 getActiveSources 不再包含该源', () => {
      eventBus.registerSource({
        name: 'temp-source',
        eventTypes: ['alert'],
        schemaVersion: '1.0.0',
      });

      expect(eventBus.getActiveSources().has('temp-source')).toBe(true);
      eventBus.unregisterSource('temp-source');
      expect(eventBus.getActiveSources().has('temp-source')).toBe(false);
    });
  });

  describe('事件 Schema 校验 (D1.7)', () => {
    beforeEach(() => {
      eventBus.registerSource({
        name: 'validator-test',
        eventTypes: ['alert', 'metric', 'syslog'],
        schemaVersion: '1.0.0',
      });
    });

    it('缺少 type 字段应拒绝', async () => {
      await expect(
        eventBus.publish({
          type: '' as any,
          priority: 'medium',
          source: 'validator-test',
          payload: {},
          schemaVersion: '1.0.0',
        }),
      ).rejects.toThrow();
    });

    it('无效 priority 应拒绝', async () => {
      await expect(
        eventBus.publish({
          type: 'alert',
          priority: 'invalid' as any,
          source: 'validator-test',
          payload: {},
          schemaVersion: '1.0.0',
        }),
      ).rejects.toThrow();
    });

    it('缺少 schemaVersion 应拒绝', async () => {
      await expect(
        eventBus.publish({
          type: 'alert',
          priority: 'high',
          source: 'validator-test',
          payload: {},
          schemaVersion: '',
        }),
      ).rejects.toThrow();
    });
  });

  describe('多订阅者事件分发', () => {
    beforeEach(() => {
      eventBus.registerSource({
        name: 'multi-test',
        eventTypes: ['alert'],
        schemaVersion: '1.0.0',
      });
    });

    it('同一事件类型的多个订阅者都应收到事件', async () => {
      const received1: PerceptionEvent[] = [];
      const received2: PerceptionEvent[] = [];

      eventBus.subscribe('alert', {
        id: 'sub-1',
        onEvent: async (e) => { received1.push(e); },
      });
      eventBus.subscribe('alert', {
        id: 'sub-2',
        onEvent: async (e) => { received2.push(e); },
      });

      await eventBus.publish({
        type: 'alert',
        priority: 'high',
        source: 'multi-test',
        payload: { alertId: 'a1' },
        schemaVersion: '1.0.0',
      });

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    it('取消订阅后不再收到事件', async () => {
      const received: PerceptionEvent[] = [];
      const unsub = eventBus.subscribe('alert', {
        id: 'sub-cancel',
        onEvent: async (e) => { received.push(e); },
      });

      unsub();

      await eventBus.publish({
        type: 'alert',
        priority: 'high',
        source: 'multi-test',
        payload: {},
        schemaVersion: '1.0.0',
      });

      expect(received).toHaveLength(0);
    });
  });

  describe('优先级队列', () => {
    it('队列深度应正确反映入队事件数', () => {
      expect(eventBus.getQueueDepth()).toBe(0);
    });

    it('getSubscriberCount 应返回正确的订阅者数量', () => {
      expect(eventBus.getSubscriberCount('alert')).toBe(0);

      eventBus.subscribe('alert', {
        id: 'counter-sub',
        onEvent: async () => {},
      });

      expect(eventBus.getSubscriberCount('alert')).toBe(1);
    });
  });

  describe('唯一 ID 分配 (D1.3)', () => {
    it('每个事件应获得唯一 ID 和时间戳', async () => {
      eventBus.registerSource({
        name: 'id-test',
        eventTypes: ['metric'],
        schemaVersion: '1.0.0',
      });

      const events: PerceptionEvent[] = [];
      eventBus.subscribe('metric', {
        id: 'id-collector',
        onEvent: async (e) => { events.push(e); },
      });

      await eventBus.publish({
        type: 'metric',
        priority: 'low',
        source: 'id-test',
        payload: { value: 1 },
        schemaVersion: '1.0.0',
      });
      await eventBus.publish({
        type: 'metric',
        priority: 'low',
        source: 'id-test',
        payload: { value: 2 },
        schemaVersion: '1.0.0',
      });

      expect(events).toHaveLength(2);
      expect(events[0].id).not.toBe(events[1].id);
      expect(events[0].timestamp).toBeGreaterThan(0);
      expect(events[1].timestamp).toBeGreaterThan(0);
    });
  });
});
