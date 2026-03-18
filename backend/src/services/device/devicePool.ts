/**
 * DevicePool - 设备连接池
 *
 * 管理多个设备的连接生命周期：
 * - getConnection()：查找已有连接或创建新连接（同一 deviceId 复用同一实例）
 * - releaseConnection()：释放指定设备的连接
 * - disconnectAll()：断开所有连接（可按 tenantId 过滤）
 * - getPoolStats()：查询连接池状态
 *
 * 空闲连接清理：定时器定期检查并关闭超过 idleTimeout 未使用的连接。
 * 连接失败时自动调用 DeviceManager.updateStatus() 更新设备状态为 error。
 *
 * Requirements: 5.4, 5.5, 5.7
 */

import { EventEmitter } from 'events';
import { DeviceManager } from './deviceManager';
import { deviceDriverManager } from './deviceDriverManager';
import type { DeviceDriver } from '../../types/device-driver';
import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * 通用设备客户端接口
 * 替代原 RouterOSClient 硬依赖，由设备驱动插件实现
 */
export interface DeviceClient {
  connect(config: Record<string, unknown>): Promise<boolean>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  print<T>(path: string, query?: Record<string, string>, options?: Record<string, unknown>): Promise<T[]>;
  executeRaw(command: string, params?: string[]): Promise<unknown>;
  getConfig(): Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * 连接池中的连接条目
 */
export interface PooledConnection {
  client: DeviceClient;
  deviceId: string;
  tenantId: string;
  lastUsed: number;
  status: 'connected' | 'connecting' | 'disconnected';
}

/**
 * 连接池统计信息
 */
export interface PoolStats {
  total: number;
  connected: number;
  idle: number;
}

/**
 * DevicePool 配置选项
 */
export interface DevicePoolOptions {
  /** 空闲连接超时时间（毫秒），默认 30 分钟 */
  idleTimeout?: number;
  /** 清理定时器间隔（毫秒），默认 5 分钟 */
  cleanupInterval?: number;
}

/**
 * DevicePool 结构化错误
 */
export class DevicePoolError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DevicePoolError';
    this.code = code;
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000;     // 30 分钟
const DEFAULT_CLEANUP_INTERVAL = 5 * 60 * 1000;  // 5 分钟
const IDLE_THRESHOLD_RATIO = 0.8;                 // 80% of idleTimeout considered idle

// ─── DevicePool Class ────────────────────────────────────────────────────────

export class DevicePool {
  private connections: Map<string, PooledConnection> = new Map();
  private readonly idleTimeout: number;
  private readonly cleanupIntervalMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deviceManager: DeviceManager;
  private connectionEvents = new EventEmitter();

  constructor(deviceManager: DeviceManager, options: DevicePoolOptions = {}) {
    this.deviceManager = deviceManager;
    this.idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this.cleanupIntervalMs = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL;

    this.startCleanupTimer();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * 获取设备连接
   *
   * 查找已有连接并复用，或创建新连接。
   * 同一 deviceId 始终返回同一 DeviceClient 实例（连接存活期间）。
   *
   * @param tenantId 租户 ID
   * @param deviceId 设备 ID
   * @param options 可选参数 { force: boolean }
   * @returns DeviceClient 实例
   */
  async getConnection(tenantId: string, deviceId: string, options?: { force?: boolean }): Promise<DeviceClient> {
    const force = options?.force ?? false;

    // 检查是否已有连接
    const existing = this.connections.get(deviceId);

    if (existing) {
      // 验证租户归属
      if (existing.tenantId !== tenantId) {
        throw new DevicePoolError('租户 ID 不匹配，无权访问该设备连接', 'TENANT_ID_MISMATCH');
      }

      // 如果连接仍然存活，更新 lastUsed 并返回
      if (existing.status === 'connected' && existing.client.isConnected()) {
        existing.lastUsed = Date.now();
        logger.info(`复用设备连接: ${deviceId}`);
        return existing.client;
      }

      // 如果正在连接中，等待一小段时间后重试
      if (existing.status === 'connecting') {
        logger.info(`设备 ${deviceId} 正在连接中，等待...`);
        // Wait briefly and check again
        await this.waitForConnection(deviceId, 10000);
        const retryConn = this.connections.get(deviceId);
        if (retryConn && retryConn.status === 'connected' && retryConn.client.isConnected()) {
          retryConn.lastUsed = Date.now();
          return retryConn.client;
        }
        // If still not connected, clean up and create new
      }

      // 连接已断开，清理旧连接
      logger.info(`设备 ${deviceId} 连接已断开，重新创建连接`);
      await this.cleanupConnection(deviceId);
    }

    // 严格离线检查：如果 device.status 是 'offline' 且没有强制连接，则拒绝连接
    if (!force) {
      const device = await this.deviceManager.getDevice(tenantId, deviceId);
      if (device && device.status === 'offline') {
        logger.warn(`设备 ${deviceId} 处于离线状态，拒绝自动连接`);
        throw new DevicePoolError('设备已离线，请手动连接', 'DEVICE_OFFLINE');
      }
    }

    // 创建新连接
    return await this.createConnection(tenantId, deviceId);
  }

  /**
   * 获取泛化设备驱动实例
   * 从 DeviceDriverManager 获取
   * Requirements: A4.17
   */
  getDeviceDriver(deviceId: string): DeviceDriver | null {
    return deviceDriverManager.getDriver(deviceId);
  }

  /**
   * 释放指定设备的连接
   *
   * 断开连接并从连接池中移除。
   *
   * @param deviceId 设备 ID
   */
  async releaseConnection(deviceId: string): Promise<void> {
    const conn = this.connections.get(deviceId);
    if (!conn) {
      logger.info(`设备 ${deviceId} 无活跃连接，无需释放`);
      return;
    }

    await this.cleanupConnection(deviceId);
    logger.info(`设备连接已释放: ${deviceId}`);
  }

  /**
   * 断开所有连接
   *
   * @param tenantId 可选，仅断开指定租户的连接
   */
  async disconnectAll(tenantId?: string): Promise<void> {
    const deviceIds: string[] = [];

    for (const [deviceId, conn] of this.connections) {
      if (!tenantId || conn.tenantId === tenantId) {
        deviceIds.push(deviceId);
      }
    }

    for (const deviceId of deviceIds) {
      await this.cleanupConnection(deviceId);
    }

    const scope = tenantId ? `租户 ${tenantId}` : '所有';
    logger.info(`已断开${scope}设备连接，共 ${deviceIds.length} 个`);
  }

  /**
   * 获取连接池统计信息
   *
   * @returns 连接池状态
   */
  getPoolStats(): PoolStats {
    let connected = 0;
    let idle = 0;
    const now = Date.now();
    const idleThreshold = this.idleTimeout * IDLE_THRESHOLD_RATIO;

    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') {
        connected++;
        if (now - conn.lastUsed > idleThreshold) {
          idle++;
        }
      }
    }

    return {
      total: this.connections.size,
      connected,
      idle,
    };
  }

  /**
   * 停止清理定时器并断开所有连接
   *
   * 用于优雅关闭。
   */
  async destroy(): Promise<void> {
    this.stopCleanupTimer();
    await this.disconnectAll();
  }

  /**
   * 获取连接池中的原始连接 Map（仅用于测试）
   */
  getConnectionsMap(): Map<string, PooledConnection> {
    return this.connections;
  }

  /**
   * 根据 deviceId 查找当前连接池中该设备所属的 tenantId
   * 用于 Brain 在 FORBIDDEN 错误时自动修正 tenantId，避免直接暴露内部连接 Map
   * 
   * @param deviceId 设备 ID
   * @returns 连接池中该设备的 tenantId，不存在时返回 null
   */
  findTenantIdForDevice(deviceId: string): string | null {
    if (!deviceId || deviceId.trim() === '') return null;
    const conn = this.connections.get(deviceId);
    return conn ? conn.tenantId : null;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * 创建新的设备连接
   */
  private async createConnection(tenantId: string, deviceId: string): Promise<DeviceClient> {
    // 从 DeviceManager 获取设备配置
    const device = await this.deviceManager.getDevice(tenantId, deviceId);
    if (!device) {
      throw new DevicePoolError(`设备不存在或无权访问: ${deviceId}`, 'NOT_FOUND');
    }

    // 解密密码
    let password: string;
    try {
      password = this.deviceManager.decryptPassword(device.password_encrypted);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.deviceManager.updateStatus(deviceId, 'error', `密码解密失败: ${errMsg}`);
      throw new DevicePoolError(`设备密码解密失败: ${deviceId}`, 'DECRYPT_FAILED');
    }

    // 通过 DeviceDriverManager 获取或创建设备驱动
    const driver = deviceDriverManager.getDriver(deviceId);
    // 使用驱动作为客户端（duck typing 兼容 DeviceClient 接口）
    const client = (driver || { connect: async () => false, disconnect: async () => {}, isConnected: () => false, print: async () => [], getConfig: () => null }) as unknown as DeviceClient;

    // 标记为正在连接
    const pooledConn: PooledConnection = {
      client,
      deviceId,
      tenantId,
      lastUsed: Date.now(),
      status: 'connecting',
    };
    this.connections.set(deviceId, pooledConn);

    // 更新设备状态为 connecting
    try {
      await this.deviceManager.updateStatus(deviceId, 'connecting');
    } catch {
      // 状态更新失败不阻塞连接
    }

    try {
      // 建立连接
      await client.connect({
        host: device.host,
        port: device.port,
        username: device.username,
        password,
        useTLS: device.use_tls,
      });

      // 连接成功
      pooledConn.status = 'connected';
      pooledConn.lastUsed = Date.now();

      // 通知所有等待该设备连接的调用者
      this.connectionEvents.emit(`connected:${deviceId}`);

      // 更新设备状态为 online
      try {
        await this.deviceManager.updateStatus(deviceId, 'online');
      } catch {
        // 状态更新失败不阻塞
      }

      logger.info(`设备连接已创建: ${deviceId} (${device.host}:${device.port})`);
      return client;
    } catch (error) {
      // 连接失败，清理并更新状态
      const errMsg = error instanceof Error ? error.message : String(error);
      this.connections.delete(deviceId);

      // 通知等待者连接已结束（失败），让它们检查状态后自行处理
      this.connectionEvents.emit(`connected:${deviceId}`);

      // 更新设备状态为 error
      try {
        await this.deviceManager.updateStatus(deviceId, 'error', errMsg);
      } catch {
        // 状态更新失败不阻塞
      }

      logger.error(`设备连接失败: ${deviceId} - ${errMsg}`);
      throw new DevicePoolError(`设备连接失败: ${errMsg}`, 'CONNECTION_FAILED');
    }
  }

  /**
   * 清理指定设备的连接
   */
  private async cleanupConnection(deviceId: string): Promise<void> {
    const conn = this.connections.get(deviceId);
    if (!conn) return;

    try {
      await conn.client.disconnect();
    } catch (error) {
      // 忽略断开连接时的错误
      logger.warn(`断开设备 ${deviceId} 连接时出错: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.connections.delete(deviceId);

    // 更新设备状态为 offline
    try {
      await this.deviceManager.updateStatus(deviceId, 'offline');
    } catch {
      // 状态更新失败不阻塞
    }
  }

  /**
   * 等待设备连接完成
   *
   * 使用 EventEmitter 事件通知替代 setTimeout 递归轮询。
   * 当连接成功时 createConnection() 会 emit `connected:{deviceId}` 事件，
   * 所有等待者通过 once 监听立即被通知，无需轮询间隔。
   * 超时后自动 resolve，让调用者检查连接状态。
   */
  private waitForConnection(deviceId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const eventName = `connected:${deviceId}`;

      // 先检查当前状态，如果已经不是 connecting 则直接返回
      const conn = this.connections.get(deviceId);
      if (!conn || conn.status !== 'connecting') {
        resolve();
        return;
      }

      // 🔴 FIX 1.3: 使用具名监听器 + removeListener，避免 removeAllListeners 误删其他并发等待者
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        this.connectionEvents.removeListener(eventName, onConnected);
        resolve(); // 超时后 resolve，让调用者检查状态
      }, timeoutMs);

      this.connectionEvents.once(eventName, onConnected);
    });
  }

  /**
   * 启动空闲连接清理定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections().catch((error) => {
        logger.error(`空闲连接清理失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.cleanupIntervalMs);

    // 允许 Node.js 进程在定时器运行时正常退出
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * 停止清理定时器
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 清理空闲连接
   *
   * 关闭超过 idleTimeout 未使用的连接。
   */
  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now();
    const idleDeviceIds: string[] = [];

    for (const [deviceId, conn] of this.connections) {
      if (conn.status === 'connected' && now - conn.lastUsed > this.idleTimeout) {
        idleDeviceIds.push(deviceId);
      }
    }

    if (idleDeviceIds.length > 0) {
      logger.info(`清理 ${idleDeviceIds.length} 个空闲连接`);
      for (const deviceId of idleDeviceIds) {
        // FIX: 清理前重新检查 lastUsed — 防止与 getConnection 的竞态条件
        // 如果在收集 idleDeviceIds 和实际清理之间，有调用者通过 getConnection 复用了该连接
        // （更新了 lastUsed），则跳过清理，避免"用后释放"
        const conn = this.connections.get(deviceId);
        if (conn && Date.now() - conn.lastUsed > this.idleTimeout) {
          await this.cleanupConnection(deviceId);
        } else {
          logger.debug(`跳过设备 ${deviceId} 的空闲清理 — 连接在清理窗口内被复用`);
        }
      }
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export default DevicePool;
