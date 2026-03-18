/**
 * MetricsCollector 指标采集服务
 * 负责周期性采集 RouterOS 设备的运行指标
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
 * - 1.1: 按配置的采集间隔周期性采集指标
 * - 1.2: 获取 CPU 使用率百分比
 * - 1.3: 获取已用内存、可用内存和使用率
 * - 1.4: 获取磁盘总容量、已用容量和使用率
 * - 1.5: 获取每个接口的收发流量、包数和错误数
 * - 1.6: 获取接口的运行状态（up/down）和连接状态
 * - 1.7: 将指标数据持久化存储
 * - 1.8: 保留最近 7 天的历史数据
 * - 1.9: 自动清理过期数据
 * - 1.10: 采集错误时记录日志并在下一周期重试
 */

import fs from 'fs/promises';
import path from 'path';
import {
  IMetricsCollector,
  MetricsCollectorConfig,
  MetricPoint,
  SystemMetrics,
  InterfaceMetrics,
  RateCalculationResult,
  RateCalculationConfig,
  DataAvailabilityStatus,
} from '../../types/ai-ops';
import { routerosClient, RouterOSClient } from '../routerosClient';
import { logger } from '../../utils/logger';
import type { DevicePool } from '../device/devicePool';
import type { DataStore } from '../core/dataStore';

// 告警评估回调类型
type AlertEvaluationCallback = (metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] }) => Promise<void>;

const METRICS_DIR = path.join(process.cwd(), 'data', 'ai-ops', 'metrics');
const SYSTEM_METRICS_DIR = path.join(METRICS_DIR, 'system');
const INTERFACE_METRICS_DIR = path.join(METRICS_DIR, 'interfaces');
const TRAFFIC_METRICS_DIR = path.join(METRICS_DIR, 'traffic');
const CONFIG_FILE = path.join(process.cwd(), 'data', 'ai-ops', 'metrics-config.json');

const DEFAULT_CONFIG: MetricsCollectorConfig = {
  intervalMs: 60000, // 1 minute
  retentionDays: 7,
  enabled: true,
};

// Traffic collection configuration
const TRAFFIC_COLLECTION_INTERVAL_MS = 10000; // 10 seconds
const TRAFFIC_MAX_INTERFACES = 50; // Maximum interfaces to track

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取系统指标文件路径
 */
function getSystemMetricsFilePath(dateStr: string): string {
  return path.join(SYSTEM_METRICS_DIR, `${dateStr}.json`);
}

/**
 * 获取接口指标文件路径
 */
function getInterfaceMetricsFilePath(dateStr: string): string {
  return path.join(INTERFACE_METRICS_DIR, `${dateStr}.json`);
}


/**
 * 存储的系统指标数据点
 */
interface StoredSystemMetrics {
  timestamp: number;
  metrics: SystemMetrics;
}

/**
 * 存储的接口指标数据点
 */
interface StoredInterfaceMetrics {
  timestamp: number;
  interfaces: InterfaceMetrics[];
}

/**
 * 流量速率数据点
 */
export interface TrafficRatePoint {
  timestamp: number;
  rxRate: number; // bytes per second
  txRate: number; // bytes per second
}

/**
 * 接口流量历史数据
 */
interface InterfaceTrafficHistory {
  name: string;
  points: TrafficRatePoint[];
  lastBytes: {
    rx: number;
    tx: number;
    timestamp: number;
  } | null;
}

export class MetricsCollector implements IMetricsCollector {
  private config: MetricsCollectorConfig = DEFAULT_CONFIG;
  private intervalId: NodeJS.Timeout | null = null;
  private trafficIntervalId: NodeJS.Timeout | null = null;
  private cleanTask: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private latestMetrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] } | null = null;
  private lastCollectTime: number = 0;
  private readonly COLLECT_THROTTLE_MS = 5000;
  private consecutiveErrors: number = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 3;

  // Multi-device support
  private latestMetricsMap = new Map<string, { system: SystemMetrics; interfaces: InterfaceMetrics[] }>();

  // Traffic history with composite key "deviceId:interfaceName"
  private trafficHistory: Map<string, {
    name: string;
    points: TrafficRatePoint[];
    lastBytes: { rx: number; tx: number; timestamp: number } | null;
  }> = new Map();

  // 告警评估回调
  private alertEvaluationCallback: AlertEvaluationCallback | null = null;

  // 速率计算配置 (Requirements: 6.5)
  private rateCalculationConfig: RateCalculationConfig = {
    smoothingWindowSize: 3,
    maxValidRate: 12_500_000_000, // 100 Gbps = 12.5 GB/s
    counterBits: 64,
  };

  // 速率平滑历史 (Requirements: 6.5)
  // key: interfaceName:direction (e.g., "ether1:rx", "ether1:tx")
  private rateSmoothingHistory: Map<string, number[]> = new Map();

  // 上一个有效速率值 (Requirements: 6.4)
  // key: interfaceName:direction
  private lastValidRates: Map<string, number> = new Map();

  // 多设备支持
  private devicePool: DevicePool | null = null;
  private dataStore: DataStore | null = null;

  constructor(
    dataStore?: DataStore,
    devicePool?: DevicePool
  ) {
    if (dataStore) {
      this.setDataStore(dataStore);
    }
    if (devicePool) {
      this.setDevicePool(devicePool);
    }
  }

  /**
   * 设置设备连接池（多设备模式）
   * 设置后，采集指标时将遍历所有已连接设备
   */
  setDevicePool(pool: DevicePool): void {
    this.devicePool = pool;
    logger.info('MetricsCollector: DevicePool set, multi-device mode enabled');
  }

  /**
   * 设置数据存储（用于写入 health_metrics 表）
   */
  setDataStore(store: DataStore): void {
    this.dataStore = store;
    logger.info('MetricsCollector: DataStore set, metrics will be persisted to database');
  }

  /**
   * 确保目录存在
   */
  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(SYSTEM_METRICS_DIR, { recursive: true });
      await fs.mkdir(INTERFACE_METRICS_DIR, { recursive: true });
      await fs.mkdir(TRAFFIC_METRICS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create metrics directories:', error);
    }
  }

  /**
   * 加载配置
   */
  private async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load metrics config:', error);
      }
      this.config = DEFAULT_CONFIG;
    }
  }

  /**
   * 保存配置
   */
  async saveConfig(config: Partial<MetricsCollectorConfig>): Promise<MetricsCollectorConfig> {
    await this.ensureDirectories();
    this.config = { ...this.config, ...config };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
    return this.config;
  }

  /**
   * 获取配置
   */
  getConfig(): MetricsCollectorConfig {
    return { ...this.config };
  }

  /**
   * 读取指定日期的系统指标文件
   */
  private async readSystemMetricsFile(dateStr: string): Promise<StoredSystemMetrics[]> {
    const filePath = getSystemMetricsFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as StoredSystemMetrics[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read system metrics file ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * 写入系统指标文件
   */
  private async writeSystemMetricsFile(dateStr: string, data: StoredSystemMetrics[]): Promise<void> {
    const filePath = getSystemMetricsFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * 读取指定日期的接口指标文件
   */
  private async readInterfaceMetricsFile(dateStr: string): Promise<StoredInterfaceMetrics[]> {
    const filePath = getInterfaceMetricsFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as StoredInterfaceMetrics[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read interface metrics file ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * 写入接口指标文件
   */
  private async writeInterfaceMetricsFile(dateStr: string, data: StoredInterfaceMetrics[]): Promise<void> {
    const filePath = getInterfaceMetricsFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * 获取 RouterOS 客户端
   * 如果指定了 deviceId 且 DevicePool 可用，返回对应设备的客户端
   * 否则返回全局 routerosClient (兼容单设备模式)
   */
  private async getClient(deviceId?: string): Promise<RouterOSClient> {
    if (this.devicePool && deviceId) {
      const connections = this.devicePool.getConnectionsMap();
      const conn = connections.get(deviceId);
      if (conn && conn.status === 'connected' && conn.client.isConnected()) {
        return conn.client;
      }
      logger.warn(`Device ${deviceId} not found or not connected in DevicePool, falling back to default client`);
    }

    // 如果没有 DevicePool 或者没有找到指定设备，使用默认客户端
    // 注意：在多设备模式下，如果请求了特定设备但没找到，这可能会导致返回错误的（默认）设备数据
    // 但为了保持健壮性，暂时这样做，并在上面记录警告
    return routerosClient;
  }


  /**
   * 从 RouterOS 采集系统指标
   * @param deviceId 可选的设备 ID
   */
  private async collectSystemMetrics(deviceId?: string): Promise<SystemMetrics> {
    const targetClient = await this.getClient(deviceId);
    // 获取系统资源信息
    const resources = await targetClient.print<{
      'cpu-load': string;
      'free-memory': string;
      'total-memory': string;
      'free-hdd-space': string;
      'total-hdd-space': string;
      uptime: string;
    }>('/system/resource');

    if (!resources || resources.length === 0) {
      throw new Error('Failed to get system resources');
    }

    const resource = resources[0];

    // 解析 CPU 使用率
    const cpuUsage = parseInt(resource['cpu-load'] || '0', 10);

    // 解析内存信息 (bytes)
    const totalMemory = parseInt(resource['total-memory'] || '0', 10);
    const freeMemory = parseInt(resource['free-memory'] || '0', 10);
    const usedMemory = totalMemory - freeMemory;
    const memoryUsage = totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0;

    // 解析磁盘信息 (bytes)
    const totalDisk = parseInt(resource['total-hdd-space'] || '0', 10);
    const freeDisk = parseInt(resource['free-hdd-space'] || '0', 10);
    const usedDisk = totalDisk - freeDisk;
    const diskUsage = totalDisk > 0 ? Math.round((usedDisk / totalDisk) * 100) : 0;

    // 解析运行时间 (RouterOS 格式: 1w2d3h4m5s)
    const uptimeStr = resource.uptime || '0s';
    const uptime = this.parseUptime(uptimeStr);

    return {
      cpu: { usage: cpuUsage },
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        usage: memoryUsage,
      },
      disk: {
        total: totalDisk,
        used: usedDisk,
        free: freeDisk,
        usage: diskUsage,
      },
      uptime,
    };
  }

  /**
   * 解析 RouterOS 运行时间格式
   * 格式: 1w2d3h4m5s
   */
  private parseUptime(uptimeStr: string): number {
    let seconds = 0;
    const regex = /(\d+)([wdhms])/g;
    let match;

    while ((match = regex.exec(uptimeStr)) !== null) {
      const value = parseInt(match[1], 10);
      const unit = match[2];

      switch (unit) {
        case 'w':
          seconds += value * 7 * 24 * 60 * 60;
          break;
        case 'd':
          seconds += value * 24 * 60 * 60;
          break;
        case 'h':
          seconds += value * 60 * 60;
          break;
        case 'm':
          seconds += value * 60;
          break;
        case 's':
          seconds += value;
          break;
      }
    }

    return seconds;
  }

  /**
   * 获取速率计算配置
   * Requirements: 6.5
   */
  getRateCalculationConfig(): RateCalculationConfig {
    return { ...this.rateCalculationConfig };
  }

  /**
   * 更新速率计算配置
   * Requirements: 6.5
   * @param config 部分配置更新
   */
  setRateCalculationConfig(config: Partial<RateCalculationConfig>): void {
    this.rateCalculationConfig = { ...this.rateCalculationConfig, ...config };
    logger.info('Rate calculation config updated:', this.rateCalculationConfig);
  }

  /**
   * 检测 64 位计数器溢出
   * Requirements: 6.6 - 处理 64 位计数器溢出的情况
   * 
   * @param current 当前计数器值
   * @param previous 上一次计数器值
   * @param counterBits 计数器位数
   * @returns 是否发生溢出以及调整后的差值
   */
  private detectOverflow(
    current: number,
    previous: number,
    counterBits: 32 | 64
  ): { isOverflow: boolean; adjustedDelta: number } {
    const rawDelta = current - previous;

    // 如果差值为正，没有溢出
    if (rawDelta >= 0) {
      return { isOverflow: false, adjustedDelta: rawDelta };
    }

    // 计算最大值
    // 注意：JavaScript 的 Number 最大安全整数是 2^53-1
    // 对于 64 位计数器，我们使用 Number.MAX_SAFE_INTEGER 作为近似
    const maxValue = counterBits === 32
      ? 0xFFFFFFFF  // 2^32 - 1
      : Number.MAX_SAFE_INTEGER; // 2^53 - 1 (JavaScript 安全整数限制)

    // 检测是否可能是溢出（而非重置）
    // 溢出的特征：previous 接近最大值，current 是一个较小的值
    // 重置的特征：previous 可能是任意值，current 通常是 0 或很小的值

    // 如果 previous 在最大值的 90% 以上，且 current 较小，可能是溢出
    const overflowThreshold = maxValue * 0.9;

    if (previous > overflowThreshold && current < maxValue * 0.1) {
      // 可能是溢出，计算调整后的差值
      const adjustedDelta = (maxValue - previous) + current + 1;

      // 验证调整后的差值是否合理（不应该太大）
      // 假设最大合理的单次增量是 1TB（在 10 秒内）
      const maxReasonableDelta = 1_000_000_000_000; // 1 TB

      if (adjustedDelta <= maxReasonableDelta) {
        logger.info(`Counter overflow detected: previous=${previous}, current=${current}, adjustedDelta=${adjustedDelta}`);
        return { isOverflow: true, adjustedDelta };
      }
    }

    // 不是溢出，可能是重置
    return { isOverflow: false, adjustedDelta: rawDelta };
  }

  /**
   * 计算平滑速率
   * Requirements: 6.5 - 支持配置速率计算的平滑窗口大小
   * 
   * @param key 平滑历史的键（如 "ether1:rx"）
   * @param newRate 新的速率值
   * @param windowSize 平滑窗口大小
   * @returns 平滑后的速率
   */
  private calculateSmoothedRate(key: string, newRate: number, windowSize: number): number {
    let history = this.rateSmoothingHistory.get(key);
    if (!history) {
      history = [];
      this.rateSmoothingHistory.set(key, history);
    }

    // 添加新值
    history.push(newRate);

    // 保持窗口大小
    while (history.length > windowSize) {
      history.shift();
    }

    // 计算滑动平均
    const sum = history.reduce((acc, val) => acc + val, 0);
    return sum / history.length;
  }

  /**
   * 计算流量速率，正确处理计数器重置和溢出
   * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
   * 
   * @param current 当前计数器值
   * @param previous 上一次计数器值
   * @param intervalMs 时间间隔（毫秒）
   * @param config 可选的速率计算配置
   * @returns 速率计算结果，包含速率、是否重置、原始差值、平滑速率、置信度
   */
  calculateRate(
    current: number,
    previous: number,
    intervalMs: number,
    config?: Partial<RateCalculationConfig>
  ): RateCalculationResult {
    const effectiveConfig = { ...this.rateCalculationConfig, ...config };
    const rawDelta = current - previous;
    const intervalSeconds = intervalMs / 1000;

    // 检查时间间隔是否有效
    if (intervalSeconds <= 0) {
      logger.warn('calculateRate: Invalid interval (<=0), returning null rate');
      return {
        rate: null,
        isCounterReset: false,
        isOverflow: false,
        rawDelta,
        confidence: 0,
        dataStatus: 'stale_data',
      };
    }

    // 检测溢出 (Requirements: 6.6)
    const { isOverflow, adjustedDelta } = this.detectOverflow(
      current,
      previous,
      effectiveConfig.counterBits
    );

    // 如果是溢出，使用调整后的差值
    if (isOverflow) {
      const rate = adjustedDelta / intervalSeconds;

      // 验证速率是否在合理范围内 (Requirements: 6.3)
      if (rate < 0) {
        logger.warn(`calculateRate: Negative rate after overflow adjustment (${rate}), returning null`);
        return {
          rate: null,
          isCounterReset: false,
          isOverflow: true,
          rawDelta,
          confidence: 0,
          dataStatus: 'overflow',
        };
      }

      // 检查是否超过最大有效速率 (Requirements: 6.4)
      if (rate > effectiveConfig.maxValidRate) {
        logger.warn(`calculateRate: Rate after overflow (${rate} bytes/s) exceeds max valid rate, returning null`);
        return {
          rate: null,
          isCounterReset: false,
          isOverflow: true,
          rawDelta,
          confidence: 0.3,
          dataStatus: 'overflow',
        };
      }

      return {
        rate,
        isCounterReset: false,
        isOverflow: true,
        rawDelta,
        confidence: 0.7, // 溢出处理后的置信度较低
        dataStatus: 'available',
      };
    }

    // 检测计数器重置（当前值小于上一个值且不是溢出）
    // Requirements: 6.1
    if (rawDelta < 0) {
      logger.info(`Counter reset detected: current=${current}, previous=${previous}, delta=${rawDelta}`);
      return {
        rate: null,
        isCounterReset: true,
        isOverflow: false,
        rawDelta,
        confidence: 0,
        dataStatus: 'counter_reset',
      };
    }

    // 正常计算速率
    const rate = rawDelta / intervalSeconds;

    // 验证速率是否为非负数 (Requirements: 6.3)
    if (rate < 0) {
      logger.warn(`calculateRate: Negative rate detected (${rate}), this should not happen`);
      return {
        rate: null,
        isCounterReset: false,
        isOverflow: false,
        rawDelta,
        confidence: 0,
        dataStatus: 'available',
      };
    }

    // 检查速率是否异常 (Requirements: 6.4)
    if (rate > effectiveConfig.maxValidRate) {
      logger.warn(`calculateRate: Abnormally high rate detected (${rate} bytes/s), exceeds max valid rate`);
      return {
        rate: null,
        isCounterReset: false,
        isOverflow: false,
        rawDelta,
        confidence: 0.2,
        dataStatus: 'available',
      };
    }

    // 计算置信度
    // 基于时间间隔的合理性（10秒是理想间隔）
    const idealInterval = 10000; // 10 seconds
    const intervalDeviation = Math.abs(intervalMs - idealInterval) / idealInterval;
    const confidence = Math.max(0.5, 1 - intervalDeviation * 0.5);

    return {
      rate,
      isCounterReset: false,
      isOverflow: false,
      rawDelta,
      confidence,
      dataStatus: 'available',
    };
  }

  /**
   * 计算带平滑的流量速率
   * Requirements: 6.4, 6.5 - 支持平滑窗口和异常值处理
   * 
   * @param interfaceName 接口名称
   * @param direction 方向 ('rx' | 'tx')
   * @param current 当前计数器值
   * @param previous 上一次计数器值
   * @param intervalMs 时间间隔（毫秒）
   * @returns 速率计算结果，包含平滑速率
   */
  calculateRateWithSmoothing(
    interfaceName: string,
    direction: 'rx' | 'tx',
    current: number,
    previous: number,
    intervalMs: number
  ): RateCalculationResult {
    const result = this.calculateRate(current, previous, intervalMs);
    const key = `${interfaceName}:${direction}`;

    // 如果计算成功，更新平滑历史和最后有效值
    if (result.rate !== null) {
      const smoothedRate = this.calculateSmoothedRate(
        key,
        result.rate,
        this.rateCalculationConfig.smoothingWindowSize
      );

      // 更新最后有效值 (Requirements: 6.4)
      this.lastValidRates.set(key, result.rate);

      return {
        ...result,
        smoothedRate,
      };
    }

    // 如果计算失败，尝试使用上一个有效值 (Requirements: 6.4)
    const lastValidRate = this.lastValidRates.get(key);
    if (lastValidRate !== undefined) {
      logger.info(`Using last valid rate for ${key}: ${lastValidRate} bytes/s`);
      return {
        ...result,
        rate: lastValidRate,
        smoothedRate: lastValidRate,
        confidence: result.confidence * 0.5, // 降低置信度
      };
    }

    return result;
  }

  /**
   * 检测速率值是否为异常值（基于历史数据的统计分析）
   * Requirements: 6.4 - 检测异常速率值
   * 
   * @param interfaceName 接口名称
   * @param direction 方向 ('rx' | 'tx')
   * @param rate 待检测的速率值
   * @returns 是否为异常值及相关信息
   */
  detectRateOutlier(
    interfaceName: string,
    direction: 'rx' | 'tx',
    rate: number
  ): {
    isOutlier: boolean;
    reason?: string;
    suggestedValue?: number;
  } {
    const key = `${interfaceName}:${direction}`;
    const history = this.rateSmoothingHistory.get(key);

    // 如果没有历史数据，无法判断是否为异常值
    if (!history || history.length < 2) {
      return { isOutlier: false };
    }

    // 计算历史数据的均值和标准差
    const sum = history.reduce((acc, val) => acc + val, 0);
    const mean = sum / history.length;

    const squaredDiffs = history.map(val => Math.pow(val - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((acc, val) => acc + val, 0) / history.length;
    const stdDev = Math.sqrt(avgSquaredDiff);

    // 使用 3-sigma 规则检测异常值
    // 如果值偏离均值超过 3 个标准差，则认为是异常值
    const zScore = stdDev > 0 ? Math.abs(rate - mean) / stdDev : 0;
    const isOutlier = zScore > 3;

    if (isOutlier) {
      const lastValidRate = this.lastValidRates.get(key);
      logger.warn(
        `Rate outlier detected for ${key}: rate=${rate}, mean=${mean.toFixed(2)}, ` +
        `stdDev=${stdDev.toFixed(2)}, zScore=${zScore.toFixed(2)}`
      );

      return {
        isOutlier: true,
        reason: `Rate ${rate} is ${zScore.toFixed(1)} standard deviations from mean ${mean.toFixed(2)}`,
        suggestedValue: lastValidRate ?? mean,
      };
    }

    return { isOutlier: false };
  }

  /**
   * 获取接口速率统计信息
   * Requirements: 6.4 - 用于异常值检测的辅助方法
   * 
   * @param interfaceName 接口名称
   * @param direction 方向 ('rx' | 'tx')
   * @returns 速率统计信息
   */
  getRateStatistics(
    interfaceName: string,
    direction: 'rx' | 'tx'
  ): {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
    sampleCount: number;
    lastValidRate: number | null;
  } | null {
    const key = `${interfaceName}:${direction}`;
    const history = this.rateSmoothingHistory.get(key);

    if (!history || history.length === 0) {
      return null;
    }

    const sum = history.reduce((acc, val) => acc + val, 0);
    const mean = sum / history.length;

    const squaredDiffs = history.map(val => Math.pow(val - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((acc, val) => acc + val, 0) / history.length;
    const stdDev = Math.sqrt(avgSquaredDiff);

    const min = Math.min(...history);
    const max = Math.max(...history);

    const lastValidRate = this.lastValidRates.get(key) ?? null;

    return {
      mean,
      stdDev,
      min,
      max,
      sampleCount: history.length,
      lastValidRate,
    };
  }

  /**
   * 从 RouterOS 采集接口指标
   * @param deviceId 可选的设备 ID
   */
  private async collectInterfaceMetrics(deviceId?: string): Promise<InterfaceMetrics[]> {
    const targetClient = await this.getClient(deviceId);
    // 获取接口列表
    const interfaces = await targetClient.print<{
      name: string;
      running: string;
      disabled: string;
      'rx-byte': string;
      'tx-byte': string;
      'rx-packet': string;
      'tx-packet': string;
      'rx-error': string;
      'tx-error': string;
    }>('/interface');

    if (!interfaces || interfaces.length === 0) {
      return [];
    }

    return interfaces.map((iface) => ({
      name: iface.name,
      status: iface.running === 'true' && iface.disabled !== 'true' ? 'up' : 'down',
      rxBytes: parseInt(iface['rx-byte'] || '0', 10),
      txBytes: parseInt(iface['tx-byte'] || '0', 10),
      rxPackets: parseInt(iface['rx-packet'] || '0', 10),
      txPackets: parseInt(iface['tx-packet'] || '0', 10),
      rxErrors: parseInt(iface['rx-error'] || '0', 10),
      txErrors: parseInt(iface['tx-error'] || '0', 10),
    }));
  }


  /**
   * 存储指标数据
   */
  private async storeMetrics(
    system: SystemMetrics,
    interfaces: InterfaceMetrics[]
  ): Promise<void> {
    const timestamp = Date.now();
    const dateStr = getDateString(timestamp);

    // 存储系统指标
    const systemData = await this.readSystemMetricsFile(dateStr);
    systemData.push({ timestamp, metrics: system });
    await this.writeSystemMetricsFile(dateStr, systemData);

    // 存储接口指标
    const interfaceData = await this.readInterfaceMetricsFile(dateStr);
    interfaceData.push({ timestamp, interfaces });
    await this.writeInterfaceMetricsFile(dateStr, interfaceData);

    logger.debug(`Metrics stored for ${dateStr}`);
  }

  /**
   * 执行一次采集
   */
  private async doCollect(): Promise<void> {
    try {
      // 如果有 DevicePool，使用多设备采集模式
      if (this.devicePool) {
        await this.collectAllDeviceMetrics();

        // 触发告警评估回调（使用最新缓存的指标）
        if (this.alertEvaluationCallback && this.latestMetrics) {
          try {
            const ALERT_EVALUATION_TIMEOUT = 120000; // 2 分钟超时（包含 AI 分析时间）
            await Promise.race([
              this.alertEvaluationCallback(this.latestMetrics),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Alert evaluation timeout')), ALERT_EVALUATION_TIMEOUT)
              ),
            ]);
          } catch (error) {
            logger.error('Alert evaluation failed or timed out:', error);
          }
        }

        return; // 多设备模式下跳过单设备采集
      }

      // 单设备采集逻辑（向后兼容）
      // 检查 RouterOS 连接
      if (!routerosClient.isConnected()) {
        logger.warn('RouterOS not connected, skipping metrics collection');
        this.consecutiveErrors++;
        return;
      }

      const system = await this.collectSystemMetrics();
      const interfaces = await this.collectInterfaceMetrics();

      // 更新最新指标缓存
      this.latestMetrics = { system, interfaces };

      // 持久化存储
      await this.storeMetrics(system, interfaces);

      // 重置错误计数
      this.consecutiveErrors = 0;

      // 触发告警评估（如果已注册回调，带超时保护防止 CPU 飙升）
      if (this.alertEvaluationCallback) {
        try {
          const ALERT_EVALUATION_TIMEOUT = 120000; // 2 分钟超时（包含 AI 分析时间）
          await Promise.race([
            this.alertEvaluationCallback({ system, interfaces }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Alert evaluation timeout')), ALERT_EVALUATION_TIMEOUT)
            ),
          ]);
        } catch (error) {
          logger.error('Alert evaluation failed or timed out:', error);
          // 超时或失败不应阻塞指标采集
        }
      }

      logger.debug('Metrics collection completed successfully');
    } catch (error) {
      this.consecutiveErrors++;
      logger.error(`Metrics collection failed (attempt ${this.consecutiveErrors}):`, error);

      // 连续错误超过阈值时记录警告
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        logger.warn(
          `Metrics collection has failed ${this.consecutiveErrors} consecutive times`
        );
      }
    }
  }

  /**
   * 确保所有标记为 online 的设备都已连接
   * 用于服务重启后恢复连接池
   */
  private async ensureConnections(): Promise<void> {
    const { dataStore, devicePool } = this;
    if (!dataStore || !devicePool) return;

    try {
      // 查询所有状态为 online 或 connecting 的设备
      // 排除 error 状态，避免死循环重试
      const rows = await dataStore.query<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM devices WHERE status IN ('online', 'connecting')"
      );

      if (rows.length > 0) {
        logger.debug(`Ensuring connections for ${rows.length} devices...`);

        // 使用 Promise.allSettled 并发恢复连接，防止单个设备超时阻塞整体 (Requirements: 9.5)
        await Promise.allSettled(
          rows.map(async (row) => {
            try {
              // getConnection 会自动复用现有连接或创建新连接 (带有超时保护)
              await devicePool.getConnection(row.tenant_id, row.id);
            } catch (error) {
              // 仅记录 debug 日志，避免刷屏
              // DevicePool 内部会处理状态更新（设为 error 并记录 errMsg）
              logger.debug(`Failed to restore connection for device ${row.id}:`, error);
            }
          })
        );
      }
    } catch (error) {
      logger.error('Failed to ensure connections:', error);
    }
  }

  /**
   * 遍历所有已连接设备采集指标（多设备模式）
   * Requirements: 9.1, 9.5
   * 跳过 offline/error 状态的设备，将指标写入 health_metrics 表
   */
  private async collectAllDeviceMetrics(): Promise<void> {
    if (!this.devicePool) {
      return;
    }

    // 每一轮采集前确保连接池包含所有应在线的设备
    await this.ensureConnections();

    const connectionsMap = this.devicePool.getConnectionsMap();
    let primaryDeviceUpdated = false;

    for (const [deviceId, pooledConn] of connectionsMap) {
      // 跳过非 connected 状态的设备 (Requirements: 9.5)
      if (pooledConn.status !== 'connected') {
        logger.debug(`MetricsCollector: Skipping device ${deviceId}: status is ${pooledConn.status}`);
        continue;
      }

      // 跳过未连接的客户端
      if (!pooledConn.client.isConnected()) {
        logger.debug(`MetricsCollector: Skipping device ${deviceId}: client not connected`);
        continue;
      }

      try {
        const system = await this.collectSystemMetrics(deviceId);
        const interfaces = await this.collectInterfaceMetrics(deviceId);

        // 写入 health_metrics 表
        if (this.dataStore) {
          this.writeMetricsToDb(pooledConn.tenantId, deviceId, system, interfaces);
        }

        // Store in multi-device map
        this.latestMetricsMap.set(deviceId, { system, interfaces });

        // For legacy dashboard compatibility: pick the first available device as "primary"
        // This ensures the dashboard /api/ai-ops/metrics/latest endpoint returns data
        if (!primaryDeviceUpdated) {
          this.latestMetrics = { system, interfaces };
          await this.storeMetrics(system, interfaces);
          primaryDeviceUpdated = true;
          logger.debug(`MetricsCollector: Updated legacy metrics from primary device ${deviceId}`);
        } else {
          // Also store other devices metrics to file if needed? 
          // Currently storeMetrics writes to a single file. 
          // Only primary device history is persisted to JSON files for now.
          // Database (health_metrics) has all data.
        }

        logger.debug(`MetricsCollector: Collected metrics for device ${deviceId}`, {
          cpuUsage: system.cpu.usage,
          memoryUsage: system.memory.usage,
          interfaceCount: interfaces.length,
        });
      } catch (error) {
        logger.warn(`MetricsCollector: Failed to collect metrics for device ${deviceId}`, { error });
      }
    }
  }

  /**
   * 将指标数据写入 health_metrics 表
   * Requirements: 9.1
   * @param tenantId 租户 ID
   * @param deviceId 设备 ID
   * @param system 系统指标
   * @param interfaces 接口指标
   */
  private writeMetricsToDb(
    tenantId: string,
    deviceId: string,
    system: SystemMetrics,
    interfaces: InterfaceMetrics[]
  ): void {
    if (!this.dataStore) {
      return;
    }

    try {
      const metricEntries: Array<{ name: string; value: number }> = [
        { name: 'cpu_usage', value: system.cpu.usage },
        { name: 'memory_usage', value: system.memory.usage },
        { name: 'disk_usage', value: system.disk.usage },
        { name: 'uptime', value: typeof system.uptime === 'string' ? parseInt(system.uptime, 10) : system.uptime },
      ];

      // 添加接口级别的指标
      for (const iface of interfaces) {
        metricEntries.push(
          { name: `interface_${iface.name}_rx_bytes`, value: iface.rxBytes },
          { name: `interface_${iface.name}_tx_bytes`, value: iface.txBytes },
        );
      }

      const insertStmt = `INSERT INTO health_metrics (tenant_id, device_id, metric_name, metric_value) VALUES (?, ?, ?, ?)`;

      this.dataStore.transaction(() => {
        for (const entry of metricEntries) {
          this.dataStore!.run(insertStmt, [tenantId, deviceId, entry.name, entry.value]);
        }
      });

      logger.debug(`MetricsCollector: Wrote ${metricEntries.length} metrics to health_metrics for device ${deviceId}`);
    } catch (error) {
      logger.warn('MetricsCollector: Failed to write metrics to database', { error, tenantId, deviceId });
    }
  }

  /**
   * 启动指标采集
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('MetricsCollector is already running');
      return;
    }

    this.loadConfig().then(() => {
      if (!this.config.enabled) {
        logger.info('MetricsCollector is disabled');
        return;
      }

      this.ensureDirectories().then(() => {
        // 立即执行一次采集
        this.doCollect();

        // 设置定时采集（系统指标）
        this.intervalId = setInterval(() => {
          this.doCollect();
        }, this.config.intervalMs);

        // 启动流量速率采集（更频繁，10秒一次）
        this.startTrafficCollection();

        this.isRunning = true;
        logger.info(
          `MetricsCollector started with interval ${this.config.intervalMs}ms, traffic collection every ${TRAFFIC_COLLECTION_INTERVAL_MS}ms`
        );

        // 启动时清理过期数据
        this.cleanupExpiredData();
        this.cleanupExpiredTrafficData();
      });
    });
  }

  /**
   * 停止指标采集
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.trafficIntervalId) {
      clearInterval(this.trafficIntervalId);
      this.trafficIntervalId = null;
    }
    // 保存字节快照
    this.saveLastBytesSnapshot();
    this.isRunning = false;
    logger.info('MetricsCollector stopped');
  }

  /**
   * 立即执行一次采集
   * @param deviceId 可选的设备 ID，如果不传则采集默认/主设备
   * @param tenantId 可选的租户 ID
   */
  async collectNow(deviceId?: string, tenantId?: string): Promise<{ system: SystemMetrics; interfaces: InterfaceMetrics[] }> {
    // 检查节流 (Requirements: 架构建议 3.1)
    // 注意：如果是特定设备的采集，暂时忽略全局节流，或者可以为每个设备单独实现节流
    // 这里为了简化，只有未指定 deviceId 时才使用全局节流
    const now = Date.now();
    if (!deviceId && this.latestMetrics && (now - this.lastCollectTime < this.COLLECT_THROTTLE_MS)) {
      logger.debug(`Metrics collection throttled, returning cached data (age: ${now - this.lastCollectTime}ms)`);
      return this.latestMetrics;
    }

    // 如果指定了 deviceId，检查是否有该设备的特定缓存
    if (deviceId && this.latestMetricsMap.has(deviceId)) {
      // 对于特定设备，也可以实现简单的节流，这里暂不实现，假设调用者希望强制刷新
    }

    await this.ensureDirectories();

    const system = await this.collectSystemMetrics(deviceId);
    const interfaces = await this.collectInterfaceMetrics(deviceId);

    // 更新最新指标缓存和采集时间
    if (deviceId) {
      this.latestMetricsMap.set(deviceId, { system, interfaces });
      // 不更新全局 lastCollectTime，因为它控制的是默认采集循环
    } else {
      this.latestMetrics = { system, interfaces };
      this.lastCollectTime = Date.now();
    }

    // 持久化存储
    await this.storeMetrics(system, interfaces);

    return { system, interfaces };
  }

  /**
   * 获取最新指标
   * @param deviceId 可选的设备 ID，如果不传则返回默认/主设备指标
   */
  async getLatest(deviceId?: string): Promise<{ system: SystemMetrics; interfaces: InterfaceMetrics[] } | null> {
    // 优先尝试从 Map 获取特定设备的指标
    if (deviceId && this.latestMetricsMap.has(deviceId)) {
      return this.latestMetricsMap.get(deviceId)!;
    }

    // 如果没有指定 deviceId 或 Map 中没有，回退到 legacy 逻辑
    if (this.latestMetrics) {
      return this.latestMetrics;
    }

    // 否则从文件读取最新数据 (Legacy fallback)
    const today = getDateString(Date.now());
    const systemData = await this.readSystemMetricsFile(today);
    const interfaceData = await this.readInterfaceMetricsFile(today);

    if (systemData.length > 0 && interfaceData.length > 0) {
      const latestSystem = systemData[systemData.length - 1];
      const latestInterface = interfaceData[interfaceData.length - 1];

      this.latestMetrics = {
        system: latestSystem.metrics,
        interfaces: latestInterface.interfaces,
      };

      return this.latestMetrics;
    }

    return null;
  }


  /**
   * 获取历史指标数据
   * @param metric 指标类型: 'cpu', 'memory', 'disk', 'interface:{name}'
   * @param from 开始时间戳
   * @param to 结束时间戳
   */
  async getHistory(metric: string, from: number, to: number): Promise<MetricPoint[]> {
    await this.ensureDirectories();

    const points: MetricPoint[] = [];
    const dates = this.getDateRange(from, to);

    // 判断是系统指标还是接口指标
    if (metric.startsWith('interface:')) {
      const interfaceName = metric.substring('interface:'.length);

      for (const dateStr of dates) {
        const data = await this.readInterfaceMetricsFile(dateStr);

        for (const entry of data) {
          if (entry.timestamp >= from && entry.timestamp <= to) {
            const iface = entry.interfaces.find((i) => i.name === interfaceName);
            if (iface) {
              // 返回接口流量作为值
              points.push({
                timestamp: entry.timestamp,
                value: iface.rxBytes + iface.txBytes,
                labels: {
                  name: iface.name,
                  status: iface.status,
                  rxBytes: String(iface.rxBytes),
                  txBytes: String(iface.txBytes),
                },
              });
            }
          }
        }
      }
    } else {
      // 系统指标
      for (const dateStr of dates) {
        const data = await this.readSystemMetricsFile(dateStr);

        for (const entry of data) {
          if (entry.timestamp >= from && entry.timestamp <= to) {
            let value: number;

            switch (metric) {
              case 'cpu':
                value = entry.metrics.cpu.usage;
                break;
              case 'memory':
                value = entry.metrics.memory.usage;
                break;
              case 'disk':
                value = entry.metrics.disk.usage;
                break;
              default:
                continue;
            }

            points.push({
              timestamp: entry.timestamp,
              value,
            });
          }
        }
      }
    }

    // 按时间戳排序
    points.sort((a, b) => a.timestamp - b.timestamp);

    return points;
  }

  /**
   * 获取日期范围内的所有日期字符串 (使用 UTC 时间)
   */
  private getDateRange(from: number, to: number): string[] {
    const dates: string[] = [];

    // 使用 UTC 时间计算日期范围
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // 获取 UTC 日期的开始
    const currentDate = new Date(Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate()
    ));

    // 获取 UTC 日期的结束
    const endDate = new Date(Date.UTC(
      toDate.getUTCFullYear(),
      toDate.getUTCMonth(),
      toDate.getUTCDate(),
      23, 59, 59, 999
    ));

    while (currentDate <= endDate) {
      dates.push(getDateString(currentDate.getTime()));
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return dates;
  }

  /**
   * 列出所有指标文件
   */
  private async listMetricsFiles(dir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(dir);
      return files
        .filter((f) => f.endsWith('.json') && f !== '.gitkeep')
        .map((f) => f.replace('.json', ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 清理过期数据
   */
  async cleanupExpiredData(): Promise<{ systemDeleted: number; interfaceDeleted: number }> {
    await this.ensureDirectories();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);
    const cutoffDateStr = getDateString(cutoffDate.getTime());

    let systemDeleted = 0;
    let interfaceDeleted = 0;

    // 清理系统指标
    const systemFiles = await this.listMetricsFiles(SYSTEM_METRICS_DIR);
    for (const dateStr of systemFiles) {
      if (dateStr < cutoffDateStr) {
        const filePath = getSystemMetricsFilePath(dateStr);
        try {
          const data = await this.readSystemMetricsFile(dateStr);
          systemDeleted += data.length;
          await fs.unlink(filePath);
          logger.info(`Deleted expired system metrics file: ${dateStr}`);
        } catch (error) {
          logger.error(`Failed to delete system metrics file ${dateStr}:`, error);
        }
      }
    }

    // 清理接口指标
    const interfaceFiles = await this.listMetricsFiles(INTERFACE_METRICS_DIR);
    for (const dateStr of interfaceFiles) {
      if (dateStr < cutoffDateStr) {
        const filePath = getInterfaceMetricsFilePath(dateStr);
        try {
          const data = await this.readInterfaceMetricsFile(dateStr);
          interfaceDeleted += data.length;
          await fs.unlink(filePath);
          logger.info(`Deleted expired interface metrics file: ${dateStr}`);
        } catch (error) {
          logger.error(`Failed to delete interface metrics file ${dateStr}:`, error);
        }
      }
    }

    if (systemDeleted > 0 || interfaceDeleted > 0) {
      logger.info(
        `Metrics cleanup completed: ${systemDeleted} system records, ${interfaceDeleted} interface records deleted`
      );
    }

    return { systemDeleted, interfaceDeleted };
  }

  /**
   * 获取指定日期范围内的系统指标
   * @param from 开始时间戳
   * @param to 结束时间戳
   * @param deviceId 设备 ID (可选，如果提供则从数据库查询)
   */
  async getSystemMetricsHistory(from: number, to: number, deviceId?: string): Promise<StoredSystemMetrics[]> {
    await this.ensureDirectories();

    const results: StoredSystemMetrics[] = [];

    // 如果指定了 deviceId 且数据库可用，从数据库查询 (Requirements: 9.1)
    if (this.dataStore && deviceId) {
      try {
        const isoFrom = new Date(from).toISOString();
        const isoTo = new Date(to).toISOString();
        const sql = `
          SELECT metric_name, metric_value, collected_at 
          FROM health_metrics 
          WHERE device_id = ? AND collected_at >= ? AND collected_at <= ?
          AND metric_name IN ('cpu_usage', 'memory_usage', 'disk_usage', 'uptime')
          ORDER BY collected_at ASC
        `;

        const rows = this.dataStore.query<{ metric_name: string; metric_value: number; collected_at: string }>(
          sql,
          [deviceId, isoFrom, isoTo]
        );

        if (rows.length > 0) {
          // 按时间戳聚合指标
          const metricsByTime = new Map<string, StoredSystemMetrics>();

          for (const row of rows) {
            const timestamp = new Date(row.collected_at).getTime();
            const timeKey = row.collected_at;

            if (!metricsByTime.has(timeKey)) {
              metricsByTime.set(timeKey, {
                timestamp,
                metrics: {
                  cpu: { usage: 0 },
                  memory: { total: 0, used: 0, free: 0, usage: 0 },
                  disk: { total: 0, used: 0, free: 0, usage: 0 },
                  uptime: 0
                }
              });
            }

            const m = metricsByTime.get(timeKey)!;
            switch (row.metric_name) {
              case 'cpu_usage': m.metrics.cpu.usage = row.metric_value; break;
              case 'memory_usage': m.metrics.memory.usage = row.metric_value; break;
              case 'disk_usage': m.metrics.disk.usage = row.metric_value; break;
              case 'uptime': m.metrics.uptime = row.metric_value; break;
            }
          }
          results.push(...Array.from(metricsByTime.values()));
        }

        results.sort((a, b) => a.timestamp - b.timestamp);
        return results;
      } catch (error) {
        logger.warn(`Failed to query system metrics from DB for device ${deviceId}:`, error);
        // Fallback to file-based (though it might only have primary device data)
      }
    }

    const dates = this.getDateRange(from, to);

    for (const dateStr of dates) {
      const data = await this.readSystemMetricsFile(dateStr);
      for (const entry of data) {
        if (entry.timestamp >= from && entry.timestamp <= to) {
          results.push(entry);
        }
      }
    }

    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }

  /**
   * 获取指定日期范围内的接口指标
   * @param from 开始时间戳
   * @param to 结束时间戳
   * @param deviceId 设备 ID (可选，如果提供则从数据库查询)
   */
  async getInterfaceMetricsHistory(from: number, to: number, deviceId?: string): Promise<StoredInterfaceMetrics[]> {
    await this.ensureDirectories();

    const results: StoredInterfaceMetrics[] = [];

    // 如果指定了 deviceId 且数据库可用，从数据库查询 (Requirements: 9.1)
    if (this.dataStore && deviceId) {
      try {
        const isoFrom = new Date(from).toISOString();
        const isoTo = new Date(to).toISOString();
        const sql = `
          SELECT metric_name, metric_value, collected_at 
          FROM health_metrics 
          WHERE device_id = ? AND collected_at >= ? AND collected_at <= ?
          AND metric_name LIKE 'interface_%'
          ORDER BY collected_at ASC
        `;

        const rows = this.dataStore.query<{ metric_name: string; metric_value: number; collected_at: string }>(
          sql,
          [deviceId, isoFrom, isoTo]
        );

        if (rows.length > 0) {
          // 按时间戳聚合指标
          const metricsByTime = new Map<string, StoredInterfaceMetrics>();

          for (const row of rows) {
            const timestamp = new Date(row.collected_at).getTime();
            const timeKey = row.collected_at;

            if (!metricsByTime.has(timeKey)) {
              metricsByTime.set(timeKey, {
                timestamp,
                interfaces: []
              });
            }

            const m = metricsByTime.get(timeKey)!;

            // 解析接口名称和指标类型
            // 格式: interface_{name}_rx_bytes 或 interface_{name}_tx_bytes
            const rxMatch = row.metric_name.match(/^interface_(.+)_rx_bytes$/);
            const txMatch = row.metric_name.match(/^interface_(.+)_tx_bytes$/);

            if (rxMatch) {
              const name = rxMatch[1];
              let iface = m.interfaces.find(i => i.name === name);
              if (!iface) {
                iface = { name, status: 'up', rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0, rxErrors: 0, txErrors: 0 };
                m.interfaces.push(iface);
              }
              iface.rxBytes = row.metric_value;
            } else if (txMatch) {
              const name = txMatch[1];
              let iface = m.interfaces.find(i => i.name === name);
              if (!iface) {
                iface = { name, status: 'up', rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0, rxErrors: 0, txErrors: 0 };
                m.interfaces.push(iface);
              }
              iface.txBytes = row.metric_value;
            }
          }
          results.push(...Array.from(metricsByTime.values()));
        }

        results.sort((a, b) => a.timestamp - b.timestamp);
        return results;
      } catch (error) {
        logger.warn(`Failed to query interface metrics from DB for device ${deviceId}:`, error);
      }
    }

    const dates = this.getDateRange(from, to);

    for (const dateStr of dates) {
      const data = await this.readInterfaceMetricsFile(dateStr);
      for (const entry of data) {
        if (entry.timestamp >= from && entry.timestamp <= to) {
          results.push(entry);
        }
      }
    }

    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }

  /**
   * 检查服务是否正在运行
   */
  isServiceRunning(): boolean {
    return this.isRunning;
  }

  /**
   * 获取流量采集状态
   * 用于前端显示采集状态和诊断问题
   * @param deviceId 设备 ID (可选)
   */
  getTrafficCollectionStatus(deviceId?: string): {
    isRunning: boolean;
    isRouterConnected: boolean;
    interfaceCount: number;
    hasData: boolean;
    lastCollectionTime: number | null;
    consecutiveErrors: number;
  } {
    let hasData = false;
    let lastCollectionTime: number | null = null;
    let interfaceCount = 0;

    // 如果指定了设备 ID，只检查该设备的数据
    if (deviceId) {
      for (const [key, history] of this.trafficHistory) {
        // 检查 key 是否属于该设备 (key 格式: "deviceId:interface" 或 "interface" (legacy))
        if (key.startsWith(`${deviceId}:`)) {
          interfaceCount++;
          if (history.points.length > 0) {
            hasData = true;
            const lastPoint = history.points[history.points.length - 1];
            if (!lastCollectionTime || lastPoint.timestamp > lastCollectionTime) {
              lastCollectionTime = lastPoint.timestamp;
            }
          }
        }
      }

      // 检查设备连接状态
      let isRouterConnected = false;
      if (this.devicePool) {
        const connections = this.devicePool.getConnectionsMap();
        const conn = connections.get(deviceId);
        if (conn && conn.status === 'connected' && conn.client.isConnected()) {
          isRouterConnected = true;
        }
      } else {
        // 单设备模式兼容
        isRouterConnected = routerosClient.isConnected();
      }

      return {
        isRunning: this.isRunning,
        isRouterConnected,
        interfaceCount,
        hasData,
        lastCollectionTime,
        consecutiveErrors: this.consecutiveErrors,
      };
    }

    // 如果未指定设备 ID，返回汇总状态 (Legacy logic)
    hasData = Array.from(this.trafficHistory.values()).some(h => h.points.length > 0);

    // 找到最近的数据点时间
    for (const history of this.trafficHistory.values()) {
      if (history.points.length > 0) {
        const lastPoint = history.points[history.points.length - 1];
        if (!lastCollectionTime || lastPoint.timestamp > lastCollectionTime) {
          lastCollectionTime = lastPoint.timestamp;
        }
      }
    }

    return {
      isRunning: this.isRunning,
      isRouterConnected: routerosClient.isConnected(),
      interfaceCount: this.trafficHistory.size,
      hasData,
      lastCollectionTime,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  // ==================== 流量速率采集 ====================

  /**
   * 启动流量速率采集
   */
  private startTrafficCollection(): void {
    // 加载上次的字节快照
    this.loadLastBytesSnapshot();

    // 从文件加载最近 1 小时的历史数据到内存（解决重启后数据不显示的问题）
    this.loadTrafficHistoryFromFile();

    // 立即执行一次
    this.collectTrafficRates();

    // 设置定时采集
    this.trafficIntervalId = setInterval(() => {
      this.collectTrafficRates();
    }, TRAFFIC_COLLECTION_INTERVAL_MS);

    logger.info('Traffic rate collection started');
  }

  /**
   * 从文件加载最近 1 小时的流量历史数据到内存
   * 解决服务重启后流量图表不显示的问题
   * 如果最近 1 小时没有数据，会尝试加载最近 24 小时内的最新数据
   */
  private async loadTrafficHistoryFromFile(): Promise<void> {
    try {
      const now = Date.now();
      const oneHourAgo = now - 3600000;
      const oneDayAgo = now - 86400000; // 24 小时
      const dates = this.getDateRange(oneDayAgo, now);

      let loadedCount = 0;
      let latestTimestamp = 0;

      // 首先尝试加载最近 1 小时的数据
      for (const dateStr of dates) {
        const filePath = path.join(TRAFFIC_METRICS_DIR, `${dateStr}.json`);

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const data = JSON.parse(content) as Array<{
            timestamp: number;
            interfaces: { name: string; rxRate: number; txRate: number }[];
          }>;

          for (const entry of data) {
            // 记录最新的时间戳
            if (entry.timestamp > latestTimestamp) {
              latestTimestamp = entry.timestamp;
            }

            // 只加载最近 1 小时的数据
            if (entry.timestamp >= oneHourAgo && entry.timestamp <= now) {
              for (const iface of entry.interfaces) {
                // Determine composite key. Old data might be just interface name (single device 'local')
                // New data stores name as 'deviceId:interfaceName'
                let compositeKey = iface.name;

                // Heuristic: if no colon, assume legacy data (local device)
                // Note: Interface names usually don't have colons, but deviceIds might (if not UUIDs).
                // Our system generates UUIDs for deviceIds, so no colons there.
                // But let's be safe: if it doesn't look like a composite key and we are in legacy mode...
                // Actually, simplest is to check if it matches our composite key pattern or just assume backward compatibility 
                // by checking if it starts with a known deviceId? No, that's too heavy.

                // If the name is just "ether1", it's legacy 'local'.
                // If it is "uuid:ether1", it is multi-device.
                if (!compositeKey.includes(':')) {
                  compositeKey = `local:${iface.name}`;
                }

                let history = this.trafficHistory.get(compositeKey);
                if (!history) {
                  history = {
                    name: iface.name, // this might be composite key now if we loaded it from file?
                    // Wait, trafficHistory.name should be the interface name (short).
                    // In collectTrafficRates, we set history.name = iface.name (short) when creating new history.
                    // But here if iface.name IS composite from file, we need to extract short name?
                    // Actually, for display purposes, we might want short name. 
                    // Let's strip the deviceId prefix if present for the 'name' property.
                    points: [],
                    lastBytes: null,
                  };

                  if (compositeKey.includes(':')) {
                    const parts = compositeKey.split(':');
                    if (parts.length >= 2) {
                      // Take the last part as interface name? 
                      // What if interface name has colon (e.g. VLAN)? Unlikely in RouterOS generally but possible?
                      // Let's safe-guard: everything after the first colon
                      const firstColon = compositeKey.indexOf(':');
                      history.name = compositeKey.substring(firstColon + 1);
                    }
                  } else {
                    history.name = iface.name;
                  }

                  this.trafficHistory.set(compositeKey, history);
                }

                // 添加历史数据点（避免重复）
                const exists = history.points.some(p => p.timestamp === entry.timestamp);
                if (!exists) {
                  history.points.push({
                    timestamp: entry.timestamp,
                    rxRate: iface.rxRate,
                    txRate: iface.txRate,
                  });
                  loadedCount++;
                }
              }
            }
          }
        } catch (error) {
          // 文件不存在或读取失败，跳过
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug(`Failed to load traffic history from ${dateStr}:`, error);
          }
        }
      }

      // 如果没有加载到最近 1 小时的数据，但有更早的数据，加载最近 1 小时的历史数据（基于最新时间戳）
      if (loadedCount === 0 && latestTimestamp > 0) {
        const adjustedOneHourAgo = latestTimestamp - 3600000;
        logger.info(`No recent data found, loading data from ${new Date(adjustedOneHourAgo).toISOString()} to ${new Date(latestTimestamp).toISOString()}`);

        for (const dateStr of dates) {
          const filePath = path.join(TRAFFIC_METRICS_DIR, `${dateStr}.json`);

          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content) as Array<{
              timestamp: number;
              interfaces: { name: string; rxRate: number; txRate: number }[];
            }>;

            for (const entry of data) {
              // 加载最新时间戳前 1 小时的数据
              if (entry.timestamp >= adjustedOneHourAgo && entry.timestamp <= latestTimestamp) {
                for (const iface of entry.interfaces) {
                  let compositeKey = iface.name;
                  if (!compositeKey.includes(':')) {
                    compositeKey = `local:${iface.name}`;
                  }

                  let history = this.trafficHistory.get(compositeKey);
                  if (!history) {
                    history = {
                      name: iface.name,
                      points: [],
                      lastBytes: null,
                    };

                    if (compositeKey.includes(':')) {
                      const parts = compositeKey.split(':');
                      if (parts.length >= 2) {
                        const firstColon = compositeKey.indexOf(':');
                        history.name = compositeKey.substring(firstColon + 1);
                      }
                    } else {
                      history.name = iface.name;
                    }

                    this.trafficHistory.set(compositeKey, history);
                  }

                  const exists = history.points.some(p => p.timestamp === entry.timestamp);
                  if (!exists) {
                    history.points.push({
                      timestamp: entry.timestamp,
                      rxRate: iface.rxRate,
                      txRate: iface.txRate,
                    });
                    loadedCount++;
                  }
                }
              }
            }
          } catch {
            // 忽略错误
          }
        }
      }

      // 对每个接口的数据点按时间排序
      for (const history of this.trafficHistory.values()) {
        history.points.sort((a, b) => a.timestamp - b.timestamp);
      }

      if (loadedCount > 0) {
        logger.info(`Loaded ${loadedCount} traffic history points from file for ${this.trafficHistory.size} interfaces`);
      } else {
        logger.info('No traffic history data found in files');
      }
    } catch (error) {
      logger.error('Failed to load traffic history from file:', error);
    }
  }

  /**
   * 采集流量速率并持久化存储
   */
  /**
   * 采集流量速率并持久化存储
   */
  private async collectTrafficRates(): Promise<void> {
    try {
      // Use map to store clients to collect from: deviceId -> client
      const targets = new Map<string, RouterOSClient>();

      // 1. Device Pool (Multi-device)
      if (this.devicePool) {
        const connectionsMap = this.devicePool.getConnectionsMap();
        for (const [deviceId, pooledConn] of connectionsMap) {
          if (pooledConn.status === 'connected' && pooledConn.client.isConnected()) {
            targets.set(deviceId, pooledConn.client);
          }
        }
      }

      // 2. Legacy / Single Device
      if (targets.size === 0 && routerosClient.isConnected()) {
        targets.set('local', routerosClient);
      }

      if (targets.size === 0) {
        return;
      }

      const now = Date.now();
      const dateStr = getDateString(now);
      const trafficPoints: { name: string; rxRate: number; txRate: number }[] = [];

      // Iterate all targets
      for (const [deviceId, client] of targets) {
        try {
          const interfaces = await client.print<{
            name: string;
            'rx-byte': string;
            'tx-byte': string;
          }>('/interface');

          if (!interfaces || interfaces.length === 0) {
            continue;
          }

          for (const iface of interfaces) {
            const name = iface.name;
            const rxBytes = parseInt(iface['rx-byte'] || '0', 10);
            const txBytes = parseInt(iface['tx-byte'] || '0', 10);

            // Composite key: deviceId:interfaceName
            const compositeKey = `${deviceId}:${name}`;

            let history = this.trafficHistory.get(compositeKey);
            if (!history) {
              history = {
                name: iface.name, // keep original name
                points: [],
                lastBytes: null,
              };
              this.trafficHistory.set(compositeKey, history);
            }

            // 计算速率
            if (history.lastBytes) {
              const timeDiffMs = now - history.lastBytes.timestamp;

              if (timeDiffMs > 0 && timeDiffMs < 120000) {
                const rxResult = this.calculateRateWithSmoothing(compositeKey, 'rx', rxBytes, history.lastBytes.rx, timeDiffMs);
                const txResult = this.calculateRateWithSmoothing(compositeKey, 'tx', txBytes, history.lastBytes.tx, timeDiffMs);

                let rxRate = 0;
                let txRate = 0;

                if (rxResult.rate !== null) {
                  rxRate = rxResult.smoothedRate ?? rxResult.rate;
                } else if (rxResult.isCounterReset || rxResult.isOverflow) {
                  const lastPoint = history.points.length > 0 ? history.points[history.points.length - 1] : null;
                  rxRate = lastPoint ? lastPoint.rxRate : 0;
                  if (rxResult.isOverflow) {
                    logger.warn(`Interface ${compositeKey} RX overflow`);
                  }
                }

                if (txResult.rate !== null) {
                  txRate = txResult.smoothedRate ?? txResult.rate;
                } else if (txResult.isCounterReset || txResult.isOverflow) {
                  const lastPoint = history.points.length > 0 ? history.points[history.points.length - 1] : null;
                  txRate = lastPoint ? lastPoint.txRate : 0;
                  if (txResult.isOverflow) {
                    logger.warn(`Interface ${compositeKey} TX overflow`);
                  }
                }

                // Add to memory
                history.points.push({ timestamp: now, rxRate, txRate });
                if (history.points.length > 720) history.points.shift();

                // Persist with composite key as name
                trafficPoints.push({ name: compositeKey, rxRate, txRate });
              }
            }
            history.lastBytes = { rx: rxBytes, tx: txBytes, timestamp: now };
          }
        } catch (err) {
          logger.warn(`Traffic collection failed for device ${deviceId}:`, err);
        }
      }

      // 持久化存储流量数据
      if (trafficPoints.length > 0) {
        await this.appendTrafficData(dateStr, now, trafficPoints);
      }

      // 保存字节快照（用于重启恢复）
      await this.saveLastBytesSnapshot();

      // 清理不再存在的接口 (using composite keys from current collection)
      const currentKeys = new Set(trafficPoints.map(p => p.name));
      // Only cleanup if we collected something, to avoid wiping out history on partial failure
      if (currentKeys.size > 0) {
        // Implement cleanup logic if needed, or skip for now to avoid complexity in hotfix
        // this.cleanupStaleInterfaces(...) 
      }

    } catch (error) {
      logger.error('Traffic collection process failed:', error);
    }
  }

  /**
   * 追加流量数据到日期文件
   */
  private async appendTrafficData(
    dateStr: string,
    timestamp: number,
    points: { name: string; rxRate: number; txRate: number }[]
  ): Promise<void> {
    const filePath = path.join(TRAFFIC_METRICS_DIR, `${dateStr}.json`);

    try {
      let data: Array<{ timestamp: number; interfaces: { name: string; rxRate: number; txRate: number }[] }> = [];

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        data = JSON.parse(content);
      } catch {
        // 文件不存在，使用空数组
      }

      data.push({
        timestamp,
        interfaces: points,
      });

      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
    } catch (error) {
      logger.error('Failed to append traffic data:', error);
    }
  }

  /**
   * 保存字节快照（用于重启后恢复速率计算）
   */
  private async saveLastBytesSnapshot(): Promise<void> {
    try {
      const snapshot: Record<string, { rx: number; tx: number; timestamp: number }> = {};

      for (const [name, history] of this.trafficHistory) {
        if (history.lastBytes) {
          snapshot[name] = history.lastBytes;
        }
      }

      const filePath = path.join(TRAFFIC_METRICS_DIR, 'last-bytes.json');
      await fs.writeFile(filePath, JSON.stringify(snapshot), 'utf-8');
    } catch (error) {
      logger.error('Failed to save bytes snapshot:', error);
    }
  }

  /**
   * 加载字节快照
   */
  private async loadLastBytesSnapshot(): Promise<void> {
    try {
      const filePath = path.join(TRAFFIC_METRICS_DIR, 'last-bytes.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const snapshot = JSON.parse(content) as Record<string, { rx: number; tx: number; timestamp: number }>;

      const now = Date.now();

      for (const [name, bytes] of Object.entries(snapshot)) {
        // 只加载 2 分钟内的快照（避免计算出错误的速率）
        if (now - bytes.timestamp < 120000) {
          this.trafficHistory.set(name, {
            name,
            points: [],
            lastBytes: bytes,
          });
        }
      }

      logger.info(`Loaded bytes snapshot for ${this.trafficHistory.size} interfaces`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load bytes snapshot:', error);
      }
    }
  }

  /**
   * 清理不再存在的接口数据
   */
  private cleanupStaleInterfaces(currentInterfaces: string[]): void {
    const currentSet = new Set(currentInterfaces);

    // 如果接口数量超过限制，删除不在当前列表中的接口
    if (this.trafficHistory.size > TRAFFIC_MAX_INTERFACES) {
      for (const [name] of this.trafficHistory) {
        if (!currentSet.has(name)) {
          this.trafficHistory.delete(name);
        }
      }
    }
  }

  /**
   * 获取接口流量历史
   * @param interfaces 接口列表 (可选，如果不传则返回所有)
   * @param deviceId 设备 ID (可选，如果不传则返回所有设备的或者尝试匹配 local)
   * @param duration 时间范围（毫秒），默认 1 小时
   */
  getTrafficHistory(interfaces?: string[], deviceId?: string, duration: number = 3600000): Record<string, TrafficRatePoint[]> {
    const result: Record<string, TrafficRatePoint[]> = {};
    const cutoff = Date.now() - duration;

    for (const [key, history] of this.trafficHistory) {
      // Key format: "deviceId:interfaceName" or just "interfaceName" (legacy/local)
      const parts = key.split(':');
      let itemDeviceId = 'local';
      let itemName = key;

      if (parts.length > 1) {
        itemDeviceId = parts[0];
        itemName = parts.slice(1).join(':');
      }

      // Filter by deviceId if provided
      if (deviceId && itemDeviceId !== deviceId) {
        continue;
      }

      // Filter by interfaces if provided
      if (interfaces && !interfaces.includes(itemName)) {
        continue;
      }

      const filtered = history.points.filter(p => p.timestamp >= cutoff);
      if (filtered.length > 0) {
        result[itemName] = filtered;
      }
    }

    return result;
  }

  /**
   * 获取接口流量历史，带数据可用性状态
   * Requirements: 6.2 - 返回明确的状态指示而非默认值
   * 
   * @param interfaceName 接口名称
   * @param duration 时间范围（毫秒），默认 1 小时
   * @returns 包含数据和状态的结果
   */
  getTrafficHistoryWithStatus(
    interfaceName: string,
    duration: number = 3600000
  ): {
    data: TrafficRatePoint[];
    status: DataAvailabilityStatus;
    message: string;
  } {
    const history = this.trafficHistory.get(interfaceName);

    // 检查接口是否存在
    if (!history) {
      return {
        data: [],
        status: 'interface_not_found',
        message: `Interface '${interfaceName}' not found in traffic history`,
      };
    }

    // 检查是否有数据点
    if (history.points.length === 0) {
      // 检查是否有 lastBytes（表示正在采集但还没有足够的数据点）
      if (history.lastBytes) {
        return {
          data: [],
          status: 'no_previous_data',
          message: `Interface '${interfaceName}' is being monitored but no rate data available yet (first collection)`,
        };
      }
      return {
        data: [],
        status: 'no_previous_data',
        message: `No traffic data available for interface '${interfaceName}'`,
      };
    }

    const cutoff = Date.now() - duration;
    const filteredPoints = history.points.filter(p => p.timestamp >= cutoff);

    // 检查数据是否过期
    if (filteredPoints.length === 0) {
      const latestPoint = history.points[history.points.length - 1];
      const ageMs = Date.now() - latestPoint.timestamp;
      return {
        data: [],
        status: 'stale_data',
        message: `Traffic data for interface '${interfaceName}' is stale (last update: ${Math.round(ageMs / 1000)}s ago)`,
      };
    }

    return {
      data: filteredPoints,
      status: 'available',
      message: `${filteredPoints.length} data points available for interface '${interfaceName}'`,
    };
  }

  /**
   * 获取所有接口的流量历史，带数据可用性状态
   * Requirements: 6.2 - 返回明确的状态指示
   * 
   * @param duration 时间范围（毫秒），默认 1 小时
   * @returns 包含每个接口数据和状态的结果
   */
  getAllTrafficHistoryWithStatus(duration: number = 3600000): {
    interfaces: Record<string, {
      data: TrafficRatePoint[];
      status: DataAvailabilityStatus;
      message: string;
    }>;
    summary: {
      totalInterfaces: number;
      availableInterfaces: number;
      staleInterfaces: number;
      noDataInterfaces: number;
    };
  } {
    const result: Record<string, {
      data: TrafficRatePoint[];
      status: DataAvailabilityStatus;
      message: string;
    }> = {};

    let availableCount = 0;
    let staleCount = 0;
    let noDataCount = 0;

    for (const [name] of this.trafficHistory) {
      const historyWithStatus = this.getTrafficHistoryWithStatus(name, duration);
      result[name] = historyWithStatus;

      switch (historyWithStatus.status) {
        case 'available':
          availableCount++;
          break;
        case 'stale_data':
          staleCount++;
          break;
        case 'no_previous_data':
        case 'interface_not_found':
          noDataCount++;
          break;
      }
    }

    return {
      interfaces: result,
      summary: {
        totalInterfaces: this.trafficHistory.size,
        availableInterfaces: availableCount,
        staleInterfaces: staleCount,
        noDataInterfaces: noDataCount,
      },
    };
  }

  /**
   * 检查接口是否存在于监控列表中
   * Requirements: 6.2 - 区分"暂时无数据"和"接口不存在"
   * 
   * @param interfaceName 接口名称
   * @returns 接口存在状态
   */
  isInterfaceMonitored(interfaceName: string): {
    exists: boolean;
    hasData: boolean;
    lastUpdate: number | null;
  } {
    const history = this.trafficHistory.get(interfaceName);

    if (!history) {
      return {
        exists: false,
        hasData: false,
        lastUpdate: null,
      };
    }

    const hasData = history.points.length > 0;
    const lastUpdate = history.lastBytes?.timestamp ??
      (history.points.length > 0 ? history.points[history.points.length - 1].timestamp : null);

    return {
      exists: true,
      hasData,
      lastUpdate,
    };
  }

  /**
   * 获取所有接口的流量历史（从内存获取最近 1 小时）
   * @param duration 时间范围（毫秒），默认 1 小时
   */
  getAllTrafficHistory(duration: number = 3600000): Record<string, TrafficRatePoint[]> {
    const result: Record<string, TrafficRatePoint[]> = {};
    const cutoff = Date.now() - duration;

    for (const [name, history] of this.trafficHistory) {
      const filtered = history.points.filter(p => p.timestamp >= cutoff);
      if (filtered.length > 0) {
        result[name] = filtered;
      }
    }

    return result;
  }

  /**
   * 获取历史流量数据（从文件读取，支持 7 天）
   * @param interfaceName 接口名称
   * @param from 开始时间戳
   * @param to 结束时间戳
   */
  async getTrafficHistoryFromFile(
    interfaceName: string,
    from: number,
    to: number
  ): Promise<TrafficRatePoint[]> {
    const dates = this.getDateRange(from, to);
    const result: TrafficRatePoint[] = [];

    for (const dateStr of dates) {
      const filePath = path.join(TRAFFIC_METRICS_DIR, `${dateStr}.json`);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content) as Array<{
          timestamp: number;
          interfaces: { name: string; rxRate: number; txRate: number }[];
        }>;

        for (const entry of data) {
          if (entry.timestamp >= from && entry.timestamp <= to) {
            const iface = entry.interfaces.find(i => i.name === interfaceName);
            if (iface) {
              result.push({
                timestamp: entry.timestamp,
                rxRate: iface.rxRate,
                txRate: iface.txRate,
              });
            }
          }
        }
      } catch {
        // 文件不存在，跳过
      }
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 获取可用的接口列表（有流量数据的）
   * @param deviceId 设备 ID
   */
  getAvailableTrafficInterfaces(deviceId?: string): string[] {
    const interfaces: string[] = [];

    for (const [key, history] of this.trafficHistory) {
      if (history.points.length === 0) continue;

      const parts = key.split(':');
      let itemDeviceId = 'local';
      let itemName = key;

      if (parts.length > 1) {
        itemDeviceId = parts[0];
        itemName = parts.slice(1).join(':');
      }

      if (deviceId && itemDeviceId !== deviceId) {
        continue;
      }

      interfaces.push(itemName);
    }

    return interfaces;
  }

  /**
   * 清理过期的流量数据文件
   */
  async cleanupExpiredTrafficData(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);
    const cutoffDateStr = getDateString(cutoffDate.getTime());

    let deletedCount = 0;

    try {
      const files = await fs.readdir(TRAFFIC_METRICS_DIR);

      for (const file of files) {
        if (file.endsWith('.json') && file !== 'last-bytes.json') {
          const dateStr = file.replace('.json', '');
          if (dateStr < cutoffDateStr) {
            await fs.unlink(path.join(TRAFFIC_METRICS_DIR, file));
            deletedCount++;
            logger.info(`Deleted expired traffic data file: ${file}`);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup expired traffic data:', error);
    }

    return deletedCount;
  }

  /**
   * 注册告警评估回调
   * 每次采集完指标后会调用此回调进行告警评估
   * @param callback 告警评估回调函数
   */
  registerAlertEvaluationCallback(callback: AlertEvaluationCallback): void {
    this.alertEvaluationCallback = callback;
    logger.info('Alert evaluation callback registered');
  }

  /**
   * 取消注册告警评估回调
   */
  unregisterAlertEvaluationCallback(): void {
    this.alertEvaluationCallback = null;
    logger.info('Alert evaluation callback unregistered');
  }

  /**
   * 检查服务是否支持降级模式
   * Requirements: 5.2 - 支持优雅降级模式
   */
  supportsDegradedMode(): boolean {
    // MetricsCollector 作为数据采集服务，不支持降级模式
    // 如果采集服务不可用，整个监控系统将无法工作
    return false;
  }


  /**
   * 执行健康检查
   * Requirements: 5.4 - 提供服务健康状态检查接口
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    lastCheck: number;
    consecutiveFailures: number;
  }> {
    const now = Date.now();

    try {
      // 检查配置是否已加载
      if (!this.config) {
        return {
          healthy: false,
          message: 'MetricsCollector config not loaded',
          lastCheck: now,
          consecutiveFailures: 1,
        };
      }

      // 检查采集是否启用
      if (!this.config.enabled) {
        return {
          healthy: true,
          message: 'MetricsCollector is disabled',
          lastCheck: now,
          consecutiveFailures: 0,
        };
      }

      // 检查采集定时器是否运行
      if (!this.intervalId) {
        return {
          healthy: false,
          message: 'Collection timer not running',
          lastCheck: now,
          consecutiveFailures: 1,
        };
      }

      // 检查最近是否有成功的采集
      const lastMetrics = await this.getLatest();
      if (!lastMetrics || !lastMetrics.system) {
        return {
          healthy: false,
          message: 'No recent metrics available',
          lastCheck: now,
          consecutiveFailures: 1,
        };
      }

      return {
        healthy: true,
        message: 'MetricsCollector is healthy',
        lastCheck: now,
        consecutiveFailures: 0,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Health check failed',
        lastCheck: now,
        consecutiveFailures: 1,
      };
    }
  }
}

// 导出单例实例
export const metricsCollector = new MetricsCollector();
