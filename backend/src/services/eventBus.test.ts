/**
 * EventBus 单元测试
 */

import {
  EventBus,
  EventValidationError,
  SourceRegistrationError,
  PerceptionEvent,
  EventSubscriber,
  Priority,
  EventType,
} from './eventBus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.reset();
  });

  // ─── Helper ───

  function makeEvent(overrides: Partial<PerceptionEvent> = {}): Omit<PerceptionEvent, 'id' | 'timestamp'> {
    return {
      type: 'alert',
      priority: 'medium',
      source: 'test-source',
      payload: { msg: 'hello' },
      schemaVersion: '1.0',
      ...overrides,
    } as Omit<PerceptionEvent, 'id' | 'timestamp'>;
  }

  function makeSub(id: string, cb?: (e: PerceptionEvent) => void): EventSubscriber {
    return {
      id,
      onEvent: async (e) => cb?.(e),
    };
  }

  // ─── publish ───

  describe('publish', () => {
    it('should assign unique id and timestamp', async () => {
      const event = await bus.publish(makeEvent());
      expect(event.id).toBeDefined();
      expect(typeof event.id).toBe('string');
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.timestamp).toBeDefined();
      expect(typeof event.timestamp).toBe('number');
    });

    it('should enqueue event into priority queue', async () => {
      await bus.publish(makeEvent());
      expect(bus.getQueueDepth()).toBe(1);
    });

    it('should dispatch to matching subscribers', async () => {
      const received: PerceptionEvent[] = [];
      bus.subscribe('alert', makeSub('s1', (e) => received.push(e)));

      await bus.publish(makeEvent({ type: 'alert' }));
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('alert');
    });

    it('should not dispatch to non-matching subscribers', async () => {
      const received: PerceptionEvent[] = [];
      bus.subscribe('metric', makeSub('s1', (e) => received.push(e)));

      await bus.publish(makeEvent({ type: 'alert' }));
      expect(received).toHaveLength(0);
    });

    it('should dispatch to multiple subscribers of same type', async () => {
      const r1: PerceptionEvent[] = [];
      const r2: PerceptionEvent[] = [];
      bus.subscribe('alert', makeSub('s1', (e) => r1.push(e)));
      bus.subscribe('alert', makeSub('s2', (e) => r2.push(e)));

      await bus.publish(makeEvent({ type: 'alert' }));
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    });

    it('should generate unique IDs across multiple publishes', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const e = await bus.publish(makeEvent());
        ids.add(e.id);
      }
      expect(ids.size).toBe(50);
    });
  });


  // ─── Schema 校验 (D1.7) ───

  describe('schema validation', () => {
    it('should reject event with missing type', async () => {
      const event = makeEvent();
      (event as any).type = undefined;
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with invalid type', async () => {
      const event = makeEvent();
      (event as any).type = 'invalid_type';
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with missing priority', async () => {
      const event = makeEvent();
      (event as any).priority = undefined;
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with invalid priority', async () => {
      const event = makeEvent();
      (event as any).priority = 'ultra';
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with missing source', async () => {
      const event = makeEvent();
      (event as any).source = '';
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with missing payload', async () => {
      const event = makeEvent();
      (event as any).payload = null;
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with array payload', async () => {
      const event = makeEvent();
      (event as any).payload = [1, 2, 3];
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should reject event with missing schemaVersion', async () => {
      const event = makeEvent();
      (event as any).schemaVersion = '';
      await expect(bus.publish(event)).rejects.toThrow(EventValidationError);
    });

    it('should accept all valid event types', async () => {
      const types: EventType[] = ['alert', 'metric', 'syslog', 'snmp_trap', 'webhook', 'internal', 'brain_heartbeat'];
      for (const type of types) {
        const e = await bus.publish(makeEvent({ type }));
        expect(e.type).toBe(type);
      }
    });

    it('should accept all valid priorities', async () => {
      const priorities: Priority[] = ['critical', 'high', 'medium', 'low', 'info'];
      for (const priority of priorities) {
        const e = await bus.publish(makeEvent({ priority }));
        expect(e.priority).toBe(priority);
      }
    });
  });

  // ─── subscribe ───

  describe('subscribe', () => {
    it('should return unsubscribe function', async () => {
      const received: PerceptionEvent[] = [];
      const unsub = bus.subscribe('alert', makeSub('s1', (e) => received.push(e)));

      await bus.publish(makeEvent({ type: 'alert' }));
      expect(received).toHaveLength(1);

      unsub();
      await bus.publish(makeEvent({ type: 'alert' }));
      expect(received).toHaveLength(1); // no new events
    });

    it('should reject invalid event type for subscription', () => {
      expect(() => bus.subscribe('bad' as any, makeSub('s1'))).toThrow(EventValidationError);
    });

    it('should reject subscriber without id', () => {
      expect(() => bus.subscribe('alert', { id: '', onEvent: async () => {} })).toThrow(EventValidationError);
    });

    it('should not throw when subscriber.onEvent throws', async () => {
      bus.subscribe('alert', {
        id: 'bad-sub',
        onEvent: async () => { throw new Error('boom'); },
      });
      // Should not reject
      await expect(bus.publish(makeEvent({ type: 'alert' }))).resolves.toBeDefined();
    });

    it('should report correct subscriber count', () => {
      bus.subscribe('alert', makeSub('s1'));
      bus.subscribe('alert', makeSub('s2'));
      expect(bus.getSubscriberCount('alert')).toBe(2);
      expect(bus.getSubscriberCount('metric')).toBe(0);
    });
  });


  // ─── 感知源注册 (D1.2) ───

  describe('registerSource', () => {
    it('should register a valid source', () => {
      bus.registerSource({
        name: 'syslog-receiver',
        eventTypes: ['syslog'],
        schemaVersion: '1.0',
      });
      const sources = bus.getActiveSources();
      expect(sources.has('syslog-receiver')).toBe(true);
    });

    it('should reject source with empty name', () => {
      expect(() =>
        bus.registerSource({ name: '', eventTypes: ['alert'], schemaVersion: '1.0' }),
      ).toThrow(SourceRegistrationError);
    });

    it('should reject source with no event types', () => {
      expect(() =>
        bus.registerSource({ name: 'bad', eventTypes: [], schemaVersion: '1.0' }),
      ).toThrow(SourceRegistrationError);
    });

    it('should reject source with invalid event type', () => {
      expect(() =>
        bus.registerSource({ name: 'bad', eventTypes: ['nope' as any], schemaVersion: '1.0' }),
      ).toThrow(SourceRegistrationError);
    });

    it('should reject source with empty schemaVersion', () => {
      expect(() =>
        bus.registerSource({ name: 'bad', eventTypes: ['alert'], schemaVersion: '' }),
      ).toThrow(SourceRegistrationError);
    });

    it('should allow unregistering a source', () => {
      bus.registerSource({ name: 'tmp', eventTypes: ['alert'], schemaVersion: '1.0' });
      expect(bus.unregisterSource('tmp')).toBe(true);
      expect(bus.getActiveSources().has('tmp')).toBe(false);
    });
  });

  // ─── 优先级队列 ───

  describe('priority queue', () => {
    it('should dequeue events in priority order', async () => {
      await bus.publish(makeEvent({ priority: 'low', source: 'a' }));
      await bus.publish(makeEvent({ priority: 'critical', source: 'b' }));
      await bus.publish(makeEvent({ priority: 'high', source: 'c' }));

      const e1 = bus.dequeue();
      const e2 = bus.dequeue();
      const e3 = bus.dequeue();

      expect(e1?.priority).toBe('critical');
      expect(e2?.priority).toBe('high');
      expect(e3?.priority).toBe('low');
    });

    it('should dequeue same-priority events in FIFO order', async () => {
      // Use slightly different timestamps to ensure ordering
      const e1 = await bus.publish(makeEvent({ priority: 'medium', source: 'first' }));
      const e2 = await bus.publish(makeEvent({ priority: 'medium', source: 'second' }));

      const d1 = bus.dequeue();
      const d2 = bus.dequeue();

      expect(d1?.source).toBe('first');
      expect(d2?.source).toBe('second');
    });

    it('should return undefined when dequeuing empty queue', () => {
      expect(bus.dequeue()).toBeUndefined();
    });

    it('peek should return highest priority without removing', async () => {
      await bus.publish(makeEvent({ priority: 'low' }));
      await bus.publish(makeEvent({ priority: 'critical' }));

      const peeked = bus.peek();
      expect(peeked?.priority).toBe('critical');
      expect(bus.getQueueDepth()).toBe(2); // not removed
    });
  });

  // ─── reset ───

  describe('reset', () => {
    it('should clear all state', async () => {
      bus.subscribe('alert', makeSub('s1'));
      bus.registerSource({ name: 'src', eventTypes: ['alert'], schemaVersion: '1.0' });
      await bus.publish(makeEvent());

      bus.reset();

      expect(bus.getQueueDepth()).toBe(0);
      expect(bus.getSubscriberCount('alert')).toBe(0);
      expect(bus.getActiveSources().size).toBe(0);
    });
  });
});
