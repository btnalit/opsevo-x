/**
 * DeviceDriverManager — 设备驱动统一分发管理器
 *
 * 管理驱动工厂注册、设备连接实例缓存、统一执行入口。
 * 上层模块通过此管理器执行设备操作，不直接依赖具体驱动。
 *
 * Requirements: A1.3
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import type {
  DriverType,
  DeviceDriver,
  DeviceDriverFactory,
  DeviceConnectionConfig,
  DeviceExecutionResult,
  DeviceMetrics,
  CapabilityManifest,
  HealthCheckResult,
} from '../../types/device-driver';
import { DeviceError } from '../../types/device-driver';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConnectedDevice {
  deviceId: string;
  driver: DeviceDriver;
  config: DeviceConnectionConfig;
  connectedAt: number;
}

// ─── DeviceDriverManager ─────────────────────────────────────────────────────

export class DeviceDriverManager extends EventEmitter {
  /** 已注册的驱动工厂 */
  private factories: Map<DriverType, DeviceDriverFactory> = new Map();
  /** 已连接的设备驱动实例 */
  private connections: Map<string, ConnectedDevice> = new Map();

  /**
   * 注册驱动工厂
   */
  registerDriverFactory(factory: DeviceDriverFactory): void {
    this.factories.set(factory.driverType, factory);
    logger.info(`DeviceDriverManager: Registered driver factory for '${factory.driverType}'`);
  }

  /**
   * 获取已注册的驱动类型列表
   */
  getRegisteredDriverTypes(): DriverType[] {
    return Array.from(this.factories.keys());
  }

  /**
   * 连接设备（创建驱动实例并缓存）
   */
  async connectDevice(deviceId: string, config: DeviceConnectionConfig): Promise<void> {
    const factory = this.factories.get(config.driverType);
    if (!factory) {
      throw new DeviceError(
        `No driver factory registered for type '${config.driverType}'`,
        'DRIVER_NOT_FOUND',
        { deviceId, driverType: config.driverType },
      );
    }

    // 断开已有连接
    if (this.connections.has(deviceId)) {
      await this.disconnectDevice(deviceId);
    }

    const driver = await factory.create(config);
    await driver.connect(config);

    this.connections.set(deviceId, {
      deviceId,
      driver,
      config,
      connectedAt: Date.now(),
    });

    this.emit('deviceConnected', { deviceId, driverType: config.driverType });
    logger.info(`DeviceDriverManager: Device '${deviceId}' connected via '${config.driverType}'`);
  }

  /**
   * 断开设备连接
   */
  async disconnectDevice(deviceId: string): Promise<void> {
    const conn = this.connections.get(deviceId);
    if (!conn) return;

    try {
      await conn.driver.disconnect();
    } catch (error) {
      logger.warn(`DeviceDriverManager: Error disconnecting device '${deviceId}'`, { error });
    }

    this.connections.delete(deviceId);
    this.emit('deviceDisconnected', { deviceId });
  }

  /**
   * 获取设备驱动实例
   */
  getDriver(deviceId: string): DeviceDriver | null {
    return this.connections.get(deviceId)?.driver ?? null;
  }

  /**
   * 统一执行入口
   * Requirements: A1.3
   */
  async execute(
    deviceId: string,
    actionType: string,
    payload?: Record<string, unknown>,
  ): Promise<DeviceExecutionResult> {
    const conn = this.connections.get(deviceId);
    if (!conn) {
      throw new DeviceError(
        `Device '${deviceId}' is not connected`,
        'DEVICE_NOT_CONNECTED',
        { deviceId },
      );
    }

    const startTime = Date.now();
    try {
      const result = await conn.driver.execute(actionType, payload);
      result.durationMs = Date.now() - startTime;
      this.emit('deviceExecuted', { deviceId, actionType, success: result.success, durationMs: result.durationMs });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.emit('deviceExecuted', { deviceId, actionType, success: false, durationMs });
      throw error;
    }
  }

  /**
   * 采集设备指标
   */
  async collectMetrics(deviceId: string): Promise<DeviceMetrics> {
    const conn = this.connections.get(deviceId);
    if (!conn) {
      throw new DeviceError('Device not connected', 'DEVICE_NOT_CONNECTED', { deviceId });
    }
    return conn.driver.collectMetrics();
  }

  /**
   * 采集设备数据
   */
  async collectData(deviceId: string, dataType: string): Promise<unknown> {
    const conn = this.connections.get(deviceId);
    if (!conn) {
      throw new DeviceError('Device not connected', 'DEVICE_NOT_CONNECTED', { deviceId });
    }
    return conn.driver.collectData(dataType);
  }

  /**
   * 获取设备能力清单
   */
  getCapabilityManifest(deviceId: string): CapabilityManifest | null {
    const conn = this.connections.get(deviceId);
    return conn?.driver.getCapabilityManifest() ?? null;
  }

  /**
   * 设备健康检查
   */
  async healthCheck(deviceId: string): Promise<HealthCheckResult> {
    const conn = this.connections.get(deviceId);
    if (!conn) {
      return { healthy: false, latencyMs: 0, message: 'Device not connected' };
    }
    return conn.driver.healthCheck();
  }

  /**
   * 获取所有已连接设备 ID
   */
  getConnectedDeviceIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * 关闭所有连接
   */
  async shutdown(): Promise<void> {
    const deviceIds = Array.from(this.connections.keys());
    for (const deviceId of deviceIds) {
      await this.disconnectDevice(deviceId);
    }
    logger.info('DeviceDriverManager: All connections closed');
  }
}

// 导出单例
export const deviceDriverManager = new DeviceDriverManager();
