/**
 * BrainLoopEngine — 事件驱动大脑长循环引擎
 *
 * 替代 AutonomousBrainService 的 setInterval 轮询模式，
 * 实现事件驱动 + 可配置调度间隔的混合模式。
 *
 * 状态机：Initializing → Running → ProcessingTick → Cooldown → Backpressure → ShuttingDown
 *
 * Requirements: D4.21, D4.22, D4.23, D4.24, D4.25, D4.26, D4.27, D4.28, D4.29, D4.30
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../utils/logger';
import {
  globalEventBus,
  EventBus,
  PerceptionEvent,
  EventType,
  Priority,
  type Unsubscribe,
} from '../../eventBus';
import type { DataStore } from '../../dataStore';
import type { BrainMemory, EpisodicMemory } from '../../../types/autonomous-brain';
import type { SkillFactory } from '../skill/skillFactory';

// ─── 状态机类型 ───

export type BrainLoopState =
  | 'initializing'
  | 'running'
  | 'processing_tick'
  | 'cooldown'
  | 'backpressure'
  | 'shutting_down';

// ─── IterationLoop 接口（OODA 循环委托，Task 13.2 实现） ───

export interface TickInput {
  triggerEvent?: PerceptionEvent;
  memory: BrainMemory;
  pendingEvents: PerceptionEvent[];
}

export interface TickResult {
  tickId: string;
  summary: string;
  actions: string[];
  duration: number;
}

export interface IterationLoop {
  execute(input: TickInput): Promise<TickResult>;
}

// ─── 配置 ───

export interface BrainLoopConfig {
  /** 周期性巡检间隔（毫秒），默认 60000 */
  scheduleIntervalMs: number;
  /** Tick 超时（毫秒），默认 120000 */
  tickTimeoutMs: number;
  /** 异常冷却时间（毫秒），默认 5000 */
  cooldownMs: number;
  /** 背压高水位，默认 100 */
  highWaterMark: number;
  /** 背压低水位，默认 50 */
  lowWaterMark: number;
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatIntervalMs: number;
}

const DEFAULT_CONFIG: BrainLoopConfig = {
  scheduleIntervalMs: 60_000,
  tickTimeoutMs: 120_000,
  cooldownMs: 5_000,
  highWaterMark: 100,
  lowWaterMark: 50,
  heartbeatIntervalMs: 30_000,
};

// ─── 优先级数值映射（数值越小优先级越高） ───

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** 所有 EventBus 支持的事件类型（排除 brain_heartbeat 避免订阅自己发布的心跳事件） */
const ALL_EVENT_TYPES: EventType[] = [
  'alert',
  'metric',
  'syslog',
  'snmp_trap',
  'webhook',
  'internal',
];

// ─── 内部优先级队列 ───

/**
 * 最小堆优先级队列，按 priority 数值排序
 * 同优先级按时间戳 FIFO
 */
class EventPriorityQueue {
  private heap: PerceptionEvent[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  enqueue(event: PerceptionEvent): void {
    this.heap.push(event);
    this._bubbleUp(this.heap.length - 1);
  }

  dequeue(): PerceptionEvent | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek(): PerceptionEvent | undefined {
    return this.heap[0];
  }

  /**
   * 丢弃最低优先级事件（从堆尾扫描）
   * 返回被丢弃的事件，如果队列为空或只剩 critical 则返回 undefined
   */
  dropLowestPriority(): PerceptionEvent | undefined {
    if (this.heap.length === 0) return undefined;

    // 从尾部向前找到第一个非 critical 的最低优先级事件
    let worstIdx = -1;
    let worstOrder = -1;
    for (let i = this.heap.length - 1; i >= 0; i--) {
      const order = PRIORITY_ORDER[this.heap[i].priority];
      if (this.heap[i].priority !== 'critical' && order > worstOrder) {
        worstOrder = order;
        worstIdx = i;
      }
    }

    if (worstIdx === -1) return undefined; // 只剩 critical

    const dropped = this.heap[worstIdx];
    // 用最后一个元素替换被删除的元素
    const last = this.heap.pop()!;
    if (worstIdx < this.heap.length) {
      this.heap[worstIdx] = last;
      this._bubbleUp(worstIdx);
      this._sinkDown(worstIdx);
    }
    return dropped;
  }

  /** 排空队列，返回所有事件（按优先级排序） */
  drain(): PerceptionEvent[] {
    const result: PerceptionEvent[] = [];
    while (!this.isEmpty()) {
      result.push(this.dequeue()!);
    }
    return result;
  }

  clear(): void {
    this.heap = [];
  }

  private _compare(a: PerceptionEvent, b: PerceptionEvent): number {
    const pa = PRIORITY_ORDER[a.priority];
    const pb = PRIORITY_ORDER[b.priority];
    if (pa !== pb) return pa - pb;
    return a.timestamp - b.timestamp;
  }

  private _bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this._compare(this.heap[idx], this.heap[parent]) >= 0) break;
      [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
      idx = parent;
    }
  }

  private _sinkDown(idx: number): void {
    const len = this.heap.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < len && this._compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < len && this._compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === idx) break;
      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
      idx = smallest;
    }
  }
}


// ─── 丢弃事件计数器（按事件类型+优先级标签） ───

/**
 * events_dropped_total 计数器
 * 按事件类型和优先级标签分组，供外部监控查询（满足 D4.27）
 */
export interface DroppedEventsCounter {
  /** 按 "type:priority" 键分组的丢弃计数 */
  byLabel: Map<string, number>;
  /** 总丢弃数 */
  total: number;
}

// ─── BrainLoopEngine 核心 ───

export class BrainLoopEngine {
  private state: BrainLoopState = 'initializing';
  private readonly eventBus: EventBus;
  private readonly dataStore: DataStore;
  private memory: BrainMemory;
  private iterationLoop: IterationLoop | null = null;
  private config: BrainLoopConfig;
  /** SkillFactory 引用 — 向量检索 + 执行引擎（Requirements: E7.21） */
  private _skillFactory: SkillFactory | null = null;

  /** 高优先级队列 — critical 事件专用（满足 D4.22） */
  private highPriorityQueue = new EventPriorityQueue();
  /** 普通事件队列 */
  private eventQueue = new EventPriorityQueue();

  /** EventBus 订阅取消函数列表 */
  private unsubscribes: Unsubscribe[] = [];
  /** 周期性调度器句柄 */
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳定时器句柄 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 冷却恢复定时器句柄 */
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  /** 当前正在执行的 Tick Promise（用于优雅停止等待） */
  private currentTickPromise: Promise<void> | null = null;
  /** Tick 计数器 */
  private tickCount = 0;
  /** 最近一次 Tick 耗时（毫秒） */
  private lastTickDurationMs = 0;

  /**
   * events_dropped_total 计数器（满足 D4.27）
   * 按 "eventType:priority" 标签分组，通过 getDroppedEventsCounter() 暴露给外部监控
   */
  private _droppedEventsTotal = 0;
  private _droppedEventsByLabel: Map<string, number> = new Map();

  constructor(
    dataStore: DataStore,
    eventBus: EventBus = globalEventBus,
    config: Partial<BrainLoopConfig> = {},
  ) {
    this.dataStore = dataStore;
    this.eventBus = eventBus;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 初始化空白记忆（start() 时从 PostgreSQL 恢复）
    this.memory = {
      lastTickTime: 0,
      ongoingInvestigations: [],
      notes: [],
      episodicMemory: [],
    };
  }

  // ─── 公共 API ───

  /** 获取当前状态 */
  getState(): BrainLoopState {
    return this.state;
  }

  /** 获取当前配置（只读副本） */
  getConfig(): Readonly<BrainLoopConfig> {
    return { ...this.config };
  }

  /** 获取当前记忆（只读副本） */
  getMemory(): Readonly<BrainMemory> {
    return { ...this.memory };
  }

  /** 获取事件队列深度 */
  getQueueDepth(): { normal: number; highPriority: number; total: number } {
    return {
      normal: this.eventQueue.size,
      highPriority: this.highPriorityQueue.size,
      total: this.eventQueue.size + this.highPriorityQueue.size,
    };
  }

  /** 获取 Tick 计数 */
  getTickCount(): number {
    return this.tickCount;
  }

  /** 获取最近 Tick 耗时 */
  getLastTickDuration(): number {
    return this.lastTickDurationMs;
  }

  /**
   * 获取 events_dropped_total 计数器（满足 D4.27）
   * 按事件类型和优先级标签分组，供外部监控/MetricsCollector 查询
   */
  getDroppedEventsCounter(): DroppedEventsCounter {
    return {
      byLabel: new Map(this._droppedEventsByLabel),
      total: this._droppedEventsTotal,
    };
  }

  /** 注入 IterationLoop 实现（OODA 循环委托） */
  setIterationLoop(loop: IterationLoop): void {
    this.iterationLoop = loop;
  }

  /**
   * 注入 SkillFactory（向量检索 + 执行引擎）
   * Requirements: E7.21 — BrainLoopEngine 通过 SkillFactory 发现和执行工具
   */
  setSkillFactory(sf: SkillFactory): void {
    this._skillFactory = sf;
    logger.info('[BrainLoop] SkillFactory injected');
  }

  /** 获取 SkillFactory 引用 */
  getSkillFactory(): SkillFactory | null {
    return this._skillFactory;
  }

  /** 动态更新配置 */
  updateConfig(partial: Partial<BrainLoopConfig>): void {
    this.config = { ...this.config, ...partial };
    logger.info(`[BrainLoop] Config updated: ${JSON.stringify(partial)}`);

    // 如果调度间隔变了且正在运行，重启调度器
    if (partial.scheduleIntervalMs !== undefined && this.state === 'running') {
      this._stopScheduler();
      this._startScheduler();
    }
    // 如果心跳间隔变了且正在运行，重启心跳
    if (partial.heartbeatIntervalMs !== undefined && this.heartbeatTimer) {
      this._stopHeartbeat();
      this._startHeartbeat();
    }
  }

  // ─── 启动（满足 D4.21） ───

  async start(): Promise<void> {
    if (this.state !== 'initializing' && this.state !== 'shutting_down') {
      logger.warn(`[BrainLoop] Cannot start from state: ${this.state}`);
      return;
    }

    logger.info('[BrainLoop] Starting Brain Loop Engine...');

    // 1. 从 PostgreSQL 恢复 BrainMemory（满足 D4.30）
    await this._loadMemory();

    // 2. 订阅 EventBus 所有事件类型（满足 D4.21）
    this._subscribeAllEvents();

    // 3. 启动周期性调度器（满足 D4.23）
    this._startScheduler();

    // 4. 启动心跳发布（满足 D4.29）
    this._startHeartbeat();

    this.state = 'running';
    logger.info(
      `[BrainLoop] Engine started. Schedule interval: ${this.config.scheduleIntervalMs}ms, ` +
      `Heartbeat: ${this.config.heartbeatIntervalMs}ms`,
    );
  }

  // ─── 优雅停止（满足 D4.28） ───

  async stop(): Promise<void> {
    if (this.state === 'shutting_down' || this.state === 'initializing') {
      return;
    }

    logger.info('[BrainLoop] Shutting down...');
    this.state = 'shutting_down';

    // 停止调度器和心跳
    this._stopScheduler();
    this._stopHeartbeat();
    this._stopCooldownTimer();

    // 取消所有 EventBus 订阅
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];

    // 等待当前 Tick 完成
    if (this.currentTickPromise) {
      logger.info('[BrainLoop] Waiting for current tick to complete...');
      try {
        await this.currentTickPromise;
      } catch {
        // Tick 异常不阻止关闭
      }
    }

    // 持久化 BrainMemory
    await this._persistMemory();

    logger.info('[BrainLoop] Engine stopped gracefully.');
  }

  // ─── 事件处理（满足 D4.22） ───

  /**
   * 处理从 EventBus 收到的事件
   * - critical 事件进入高优先级队列
   * - 其他事件进入普通队列
   * - 检查背压
   * - 如果当前空闲，立即触发 Tick
   */
  private _onEvent(event: PerceptionEvent): void {
    // 关闭中不再接收事件
    if (this.state === 'shutting_down') return;

    if (event.priority === 'critical') {
      // Critical 事件始终进入高优先级队列（满足 D4.22）
      this.highPriorityQueue.enqueue(event);
      logger.debug(`[BrainLoop] Critical event queued: ${event.id} (type=${event.type})`);

      // 如果当前空闲，立即触发 Tick
      if (this.state === 'running') {
        this._triggerTick(event);
      }
      // 如果正在 processing_tick，当前 Tick 完成后会检查 highPriorityQueue
    } else {
      this.eventQueue.enqueue(event);

      // 检查背压（满足 D4.27）
      const totalSize = this.eventQueue.size + this.highPriorityQueue.size;
      if (totalSize > this.config.highWaterMark) {
        this._applyBackpressure();
      }
    }
  }

  // ─── 触发 Tick ───

  /**
   * 触发一次 OODA Tick
   * 如果当前正在处理 Tick，不会重复触发（Tick 完成后会自动检查队列）
   */
  private _triggerTick(triggerEvent?: PerceptionEvent): void {
    if (this.state !== 'running') return;
    if (this.currentTickPromise) return; // 已有 Tick 在执行

    this.currentTickPromise = this._executeTick(triggerEvent)
      .finally(() => {
        this.currentTickPromise = null;
      });
  }

  // ─── Tick 执行（核心骨架，Task 13.2 补充完整逻辑） ───

  private async _executeTick(triggerEvent?: PerceptionEvent): Promise<void> {
    this.state = 'processing_tick';
    const tickId = uuidv4();
    const startTime = Date.now();
    this.tickCount++;

    logger.debug(`[BrainLoop Tick ${tickId}] Starting (trigger: ${triggerEvent?.type ?? 'schedule'}, #${this.tickCount})`);

    // Tick 超时保护（满足 D4.25）
    let tickAborted = false;
    const timeoutTimer = setTimeout(() => {
      tickAborted = true;
      logger.warn(`[BrainLoop Tick ${tickId}] Timeout after ${this.config.tickTimeoutMs}ms`);
    }, this.config.tickTimeoutMs);

    try {
      // 排空队列中的待处理事件
      const pendingEvents = this._drainQueues();

      if (this.iterationLoop) {
        // 委托给 IterationLoop 执行 OODA 循环
        const result = await this.iterationLoop.execute({
          triggerEvent,
          memory: this.memory,
          pendingEvents,
        });

        // 更新记忆时间戳
        this.memory.lastTickTime = Date.now();

        // 写入 Episodic Memory（满足 D4.24）
        await this._persistEpisodicMemory(tickId, result);

        // 发布 tick_completed 事件
        await this.eventBus.publish({
          type: 'internal',
          priority: 'low',
          source: 'brain_loop_engine',
          payload: { tickId, summary: result.summary, duration: result.duration },
          schemaVersion: '1.0',
        });
      } else {
        // 无 IterationLoop 时仅更新时间戳（引擎骨架模式）
        this.memory.lastTickTime = Date.now();
        logger.debug(`[BrainLoop Tick ${tickId}] No IterationLoop set, skeleton tick completed.`);
      }

      const duration = Date.now() - startTime;
      this.lastTickDurationMs = duration;
      logger.debug(`[BrainLoop Tick ${tickId}] Completed in ${duration}ms`);
    } catch (error) {
      // 异常处理 → 冷却（满足 D4.26）
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`[BrainLoop Tick ${tickId}] Error: ${err.message}`);
      this._enterCooldown();
      return; // 冷却状态下不检查队列
    } finally {
      clearTimeout(timeoutTimer);
    }

    // Tick 正常完成 → 回到 running 状态
    if (this.state === 'processing_tick') {
      this.state = 'running';

      // Tick 完成后立即检查高优先级队列（满足 D4.22）
      if (!this.highPriorityQueue.isEmpty()) {
        const nextCritical = this.highPriorityQueue.dequeue();
        if (nextCritical) {
          this._triggerTick(nextCritical);
        }
      }
    }
  }

  // ─── 队列操作 ───

  /**
   * 排空两个队列，返回所有待处理事件（高优先级优先）
   */
  private _drainQueues(): PerceptionEvent[] {
    const events: PerceptionEvent[] = [];
    // 先排空高优先级队列
    while (!this.highPriorityQueue.isEmpty()) {
      events.push(this.highPriorityQueue.dequeue()!);
    }
    // 再排空普通队列
    while (!this.eventQueue.isEmpty()) {
      events.push(this.eventQueue.dequeue()!);
    }
    return events;
  }

  // ─── 背压机制（满足 D4.27, PD.3） ───

  private _applyBackpressure(): void {
    const prevState = this.state;
    if (this.state !== 'shutting_down' && this.state !== 'cooldown') {
      this.state = 'backpressure';
    }

    let droppedCount = 0;
    const droppedByPriority: Record<string, number> = {};
    const droppedByType: Record<string, number> = {};
    let earliestTimestamp = Infinity;
    let latestTimestamp = 0;

    // 按优先级丢弃：info → low → medium → high，critical 永不丢弃（PD.3）
    while (this.eventQueue.size > this.config.highWaterMark) {
      const dropped = this.eventQueue.dropLowestPriority();
      if (!dropped) break; // 只剩 critical 或队列空
      droppedCount++;
      droppedByPriority[dropped.priority] = (droppedByPriority[dropped.priority] ?? 0) + 1;
      droppedByType[dropped.type] = (droppedByType[dropped.type] ?? 0) + 1;

      // 跟踪丢弃事件的时间范围
      if (dropped.timestamp < earliestTimestamp) earliestTimestamp = dropped.timestamp;
      if (dropped.timestamp > latestTimestamp) latestTimestamp = dropped.timestamp;

      // 更新 events_dropped_total 计数器（按 type:priority 标签）
      const label = `${dropped.type}:${dropped.priority}`;
      this._droppedEventsByLabel.set(label, (this._droppedEventsByLabel.get(label) ?? 0) + 1);
      this._droppedEventsTotal++;
    }

    if (droppedCount > 0) {
      const priorityDist = Object.entries(droppedByPriority)
        .map(([p, c]) => `${p}:${c}`)
        .join(', ');
      const typeDist = Object.entries(droppedByType)
        .map(([t, c]) => `${t}:${c}`)
        .join(', ');
      const timeRange = earliestTimestamp <= latestTimestamp
        ? `${new Date(earliestTimestamp).toISOString()} ~ ${new Date(latestTimestamp).toISOString()}`
        : 'N/A';

      logger.warn(
        `[BrainLoop] Backpressure: dropped ${droppedCount} events. ` +
        `Priority: [${priorityDist}], Type: [${typeDist}], ` +
        `TimeRange: [${timeRange}]. ` +
        `Queue depth: ${this.eventQueue.size}, ` +
        `events_dropped_total: ${this._droppedEventsTotal}`,
      );
    }

    // 如果队列降到低水位以下，恢复 running
    const totalSize = this.eventQueue.size + this.highPriorityQueue.size;
    if (totalSize <= this.config.lowWaterMark && this.state === 'backpressure') {
      this.state = prevState === 'processing_tick' ? 'processing_tick' : 'running';
    }
  }

  // ─── 冷却恢复（满足 D4.26） ───

  private _enterCooldown(): void {
    this.state = 'cooldown';
    logger.info(`[BrainLoop] Entering cooldown for ${this.config.cooldownMs}ms`);

    this._stopCooldownTimer();
    this.cooldownTimer = setTimeout(() => {
      if (this.state === 'cooldown') {
        this.state = 'running';
        logger.info('[BrainLoop] Cooldown complete, resuming.');

        // 恢复后检查是否有待处理的高优先级事件
        if (!this.highPriorityQueue.isEmpty()) {
          const next = this.highPriorityQueue.dequeue();
          if (next) this._triggerTick(next);
        }
      }
    }, this.config.cooldownMs);
  }

  // ─── EventBus 订阅 ───

  /**
   * 订阅 EventBus 所有事件类型
   * EventBus 不支持 '*' 通配符，需逐个类型订阅
   */
  private _subscribeAllEvents(): void {
    const subscriber = {
      id: 'brain-loop-engine',
      onEvent: async (event: PerceptionEvent) => {
        this._onEvent(event);
      },
    };

    for (const eventType of ALL_EVENT_TYPES) {
      const unsub = this.eventBus.subscribe(eventType, subscriber);
      this.unsubscribes.push(unsub);
    }

    logger.debug(`[BrainLoop] Subscribed to ${ALL_EVENT_TYPES.length} event types on EventBus`);
  }

  // ─── 周期性调度器（满足 D4.23） ───

  private _startScheduler(): void {
    this._stopScheduler();

    const scheduleNext = () => {
      this.schedulerTimer = setTimeout(() => {
        if (this.state === 'running' && !this.currentTickPromise) {
          this._triggerTick(); // 周期性巡检 Tick（无触发事件）
        }
        // 无论是否触发了 Tick，都继续调度下一次
        if (this.state !== 'shutting_down') {
          scheduleNext();
        }
      }, this.config.scheduleIntervalMs);
    };

    scheduleNext();
    logger.debug(`[BrainLoop] Scheduler started (interval: ${this.config.scheduleIntervalMs}ms)`);
  }

  private _stopScheduler(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  // ─── 心跳（满足 D4.29） ───

  private _startHeartbeat(): void {
    this._stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      if (this.state === 'shutting_down') return;

      try {
        await this.eventBus.publish({
          type: 'brain_heartbeat',
          priority: 'info',
          source: 'brain_loop_engine',
          payload: {
            state: this.state,
            tickCount: this.tickCount,
            lastTickDurationMs: this.lastTickDurationMs,
            queueDepth: this.getQueueDepth(),
            memoryLastTickTime: this.memory.lastTickTime,
            eventsDroppedTotal: this._droppedEventsTotal,
          },
          schemaVersion: '1.0',
        });
      } catch (err) {
        logger.debug(`[BrainLoop] Heartbeat publish failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.config.heartbeatIntervalMs);

    logger.debug(`[BrainLoop] Heartbeat started (interval: ${this.config.heartbeatIntervalMs}ms)`);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _stopCooldownTimer(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  // ─── PostgreSQL 持久化（满足 D4.30） ───

  /**
   * 从 PostgreSQL 恢复 BrainMemory
   * 如果没有持久化记录，使用默认空白记忆
   */
  private async _loadMemory(): Promise<void> {
    try {
      const row = await this.dataStore.queryOne<{
        memory_data: BrainMemory;
        updated_at: string;
      }>(
        `SELECT memory_data, updated_at FROM brain_memory WHERE id = $1`,
        ['brain-loop-engine'],
      );

      if (row && row.memory_data) {
        this.memory = row.memory_data;
        logger.info(
          `[BrainLoop] Memory restored from PostgreSQL (lastTickTime: ${new Date(this.memory.lastTickTime).toISOString()})`,
        );
      } else {
        logger.info('[BrainLoop] No persisted memory found, starting fresh.');
      }
    } catch (err) {
      logger.warn(
        `[BrainLoop] Failed to load memory from PostgreSQL: ${err instanceof Error ? err.message : String(err)}. Starting with blank memory.`,
      );
    }
  }

  /**
   * 持久化 BrainMemory 到 PostgreSQL
   * 使用 UPSERT（INSERT ... ON CONFLICT UPDATE）
   */
  private async _persistMemory(): Promise<void> {
    try {
      await this.dataStore.execute(
        `INSERT INTO brain_memory (id, memory_data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET memory_data = $2, updated_at = NOW()`,
        ['brain-loop-engine', JSON.stringify(this.memory)],
      );
      logger.debug('[BrainLoop] Memory persisted to PostgreSQL.');
    } catch (err) {
      logger.error(
        `[BrainLoop] Failed to persist memory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 持久化 Episodic Memory（Tick 执行结果）
   * 满足 D4.24
   */
  private async _persistEpisodicMemory(tickId: string, result: TickResult): Promise<void> {
    const episode: EpisodicMemory = {
      id: tickId,
      content: result.summary,
      context: `tick #${this.tickCount}, actions: ${result.actions.join(', ')}`,
      source: 'brain_tick',
      createdAt: Date.now(),
      lastVerifiedAt: Date.now(),
      verificationCount: 1,
      decayWeight: 1.0,
      promoted: false,
    };

    // 添加到内存中的情景记忆
    this.memory.episodicMemory.push(episode);

    // 限制内存中情景记忆数量（防止无限增长）
    const MAX_EPISODIC = 100;
    if (this.memory.episodicMemory.length > MAX_EPISODIC) {
      this.memory.episodicMemory = this.memory.episodicMemory.slice(-MAX_EPISODIC);
    }

    // 持久化到 PostgreSQL
    await this._persistMemory();
  }
}
