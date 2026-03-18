/**
 * EventBus — 事件总线核心
 *
 * 内存优先级队列 + 发布/订阅，支持：
 * - 按事件类型主题订阅 (D1.1)
 * - 感知源注册与元数据验证 (D1.2)
 * - 唯一 ID 分配 + 时间戳 (D1.3)
 * - 事件 Schema 校验，不合规拒绝 (D1.7)
 * - 优先级队列、队列深度查询
 */

import { v4 as uuidv4 } from 'uuid';

// ─── 类型定义 ───

export type EventType =
  | 'alert'
  | 'metric'
  | 'syslog'
  | 'snmp_trap'
  | 'webhook'
  | 'internal'
  | 'brain_heartbeat';

export type Priority = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** @deprecated PRIORITY_ORDER removed — PriorityQueue was a memory leak (never dequeued in production) */

export interface PerceptionEvent {
  id: string;
  type: EventType;
  priority: Priority;
  source: string;
  deviceId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
  schemaVersion: string;
}

export interface PerceptionSourceMeta {
  name: string;
  eventTypes: EventType[];
  schemaVersion: string;
}

export interface EventSubscriber {
  id: string;
  onEvent(event: PerceptionEvent): Promise<void>;
}

export type Unsubscribe = () => void;


/**
 * 事件 Schema 校验错误
 */
export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

/**
 * 感知源注册错误
 */
export class SourceRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceRegistrationError';
  }
}

// ─── 有效值集合 ───

const VALID_EVENT_TYPES = new Set<EventType>([
  'alert',
  'metric',
  'syslog',
  'snmp_trap',
  'webhook',
  'internal',
  'brain_heartbeat',
]);

const VALID_PRIORITIES = new Set<Priority>([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

// ─── 优先级队列 ───

/** @deprecated PriorityQueue removed — was a memory leak (enqueued all events, never dequeued in production) */


// ─── EventBus 核心 ───

export class EventBus {
  private subscribers: Map<EventType, Set<EventSubscriber>> = new Map();
  /** Counter of total published events (replaces PriorityQueue which was a memory leak) */
  private publishedCount: number = 0;
  private activeSources: Map<string, PerceptionSourceMeta> = new Map();

  // ─── 发布 ───

  /**
   * 发布事件到 EventBus
   *
   * 1. 校验事件 Schema（不合规拒绝，D1.7）
   * 2. 分配唯一 ID + 时间戳（D1.3）
   * 3. 入优先级队列
   * 4. 投递到所有匹配 event.type 的订阅者（PD.4）
   *
   * @param event 部分字段可省略（id / timestamp 由 EventBus 分配）
   * @returns 分配后的完整事件
   */
  async publish(
    event: Omit<PerceptionEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: number },
  ): Promise<PerceptionEvent> {
    // Schema 校验
    this.validateEventSchema(event);

    // 分配唯一 ID
    const id = this.generateUniqueId();
    const timestamp = event.timestamp ?? Date.now();

    const fullEvent: PerceptionEvent = {
      ...event,
      id,
      timestamp,
    } as PerceptionEvent;

    // Track published event count (no longer enqueuing — was a memory leak)
    this.publishedCount++;

    // 投递到所有匹配订阅者 (PD.4)
    await this.dispatch(fullEvent);

    return fullEvent;
  }

  // ─── 订阅 ───

  /**
   * 按事件类型订阅 (D1.1)
   * @returns 取消订阅函数
   */
  subscribe(eventType: EventType, subscriber: EventSubscriber): Unsubscribe {
    if (!VALID_EVENT_TYPES.has(eventType)) {
      throw new EventValidationError(`Invalid event type for subscription: ${eventType}`);
    }
    if (!subscriber.id || typeof subscriber.onEvent !== 'function') {
      throw new EventValidationError('Subscriber must have an id and onEvent function');
    }

    let subs = this.subscribers.get(eventType);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(eventType, subs);
    }
    subs.add(subscriber);

    return () => {
      subs!.delete(subscriber);
      if (subs!.size === 0) {
        this.subscribers.delete(eventType);
      }
    };
  }

  // ─── 感知源注册 (D1.2) ───

  /**
   * 注册感知源，验证元数据
   */
  registerSource(meta: PerceptionSourceMeta): void {
    // 验证名称
    if (!meta.name || typeof meta.name !== 'string' || meta.name.trim().length === 0) {
      throw new SourceRegistrationError('Source name is required and must be a non-empty string');
    }

    // 验证事件类型
    if (!Array.isArray(meta.eventTypes) || meta.eventTypes.length === 0) {
      throw new SourceRegistrationError('Source must declare at least one event type');
    }
    for (const et of meta.eventTypes) {
      if (!VALID_EVENT_TYPES.has(et)) {
        throw new SourceRegistrationError(`Invalid event type in source declaration: ${et}`);
      }
    }

    // 验证 Schema 版本
    if (!meta.schemaVersion || typeof meta.schemaVersion !== 'string' || meta.schemaVersion.trim().length === 0) {
      throw new SourceRegistrationError('Source schemaVersion is required');
    }

    this.activeSources.set(meta.name, meta);
  }

  /**
   * 注销感知源
   */
  unregisterSource(name: string): boolean {
    return this.activeSources.delete(name);
  }

  /**
   * 获取所有活跃感知源
   */
  getActiveSources(): Map<string, PerceptionSourceMeta> {
    return new Map(this.activeSources);
  }

  // ─── 队列操作 ───

  /**
   * 获取已发布事件总数（原为队列深度，但队列从未被消费导致内存泄漏，现改为计数器）
   */
  getQueueDepth(): number {
    return this.publishedCount;
  }

  /**
   * @deprecated PriorityQueue removed — was never dequeued in production (memory leak)
   */
  dequeue(): PerceptionEvent | undefined {
    return undefined;
  }

  /**
   * @deprecated PriorityQueue removed — was never dequeued in production (memory leak)
   */
  peek(): PerceptionEvent | undefined {
    return undefined;
  }

  /**
   * 获取指定事件类型的订阅者数量
   */
  getSubscriberCount(eventType: EventType): number {
    return this.subscribers.get(eventType)?.size ?? 0;
  }

  /**
   * 清空队列和已分配 ID（主要用于测试）
   */
  reset(): void {
    this.publishedCount = 0;
    this.subscribers.clear();
    this.activeSources.clear();
  }

  // ─── 内部方法 ───

  /**
   * 校验事件 Schema (D1.7)
   * 必填字段：type, priority, source, payload, schemaVersion
   */
  private validateEventSchema(
    event: Partial<PerceptionEvent>,
  ): void {
    const errors: string[] = [];

    // type
    if (!event.type || !VALID_EVENT_TYPES.has(event.type as EventType)) {
      errors.push(
        `Invalid or missing event type: ${event.type}. Must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`,
      );
    }

    // priority
    if (!event.priority || !VALID_PRIORITIES.has(event.priority as Priority)) {
      errors.push(
        `Invalid or missing priority: ${event.priority}. Must be one of: ${[...VALID_PRIORITIES].join(', ')}`,
      );
    }

    // source
    if (!event.source || typeof event.source !== 'string' || event.source.trim().length === 0) {
      errors.push('Event source is required and must be a non-empty string');
    }

    // payload
    if (event.payload === undefined || event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      errors.push('Event payload is required and must be a plain object');
    }

    // schemaVersion
    if (!event.schemaVersion || typeof event.schemaVersion !== 'string' || event.schemaVersion.trim().length === 0) {
      errors.push('Event schemaVersion is required and must be a non-empty string');
    }

    if (errors.length > 0) {
      throw new EventValidationError(`Event schema validation failed: ${errors.join('; ')}`);
    }
  }

  /**
   * 生成全局唯一事件 ID (PD.5)
   */
  private generateUniqueId(): string {
    return uuidv4();
  }

  /**
   * 投递事件到所有匹配订阅者 (PD.4)
   */
  private async dispatch(event: PerceptionEvent): Promise<void> {
    const subs = this.subscribers.get(event.type);
    if (!subs || subs.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const sub of subs) {
      promises.push(
        sub.onEvent(event).catch((err) => {
          // 订阅者异常不影响其他订阅者
          console.error(`[EventBus] Subscriber ${sub.id} failed for event ${event.id}:`, err);
        }),
      );
    }
    await Promise.all(promises);
  }
}


// ─── 全局单例 ───

/** 全局 EventBus 单例，供所有模块共享 */
export const globalEventBus = new EventBus();
