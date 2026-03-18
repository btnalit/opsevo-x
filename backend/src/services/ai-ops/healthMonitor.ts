/**
 * HealthMonitor - 健康监控组件
 * 
 * 实现主动式运维伙伴能力的健康监控功能
 * 
 * Requirements: 5.1.1, 5.1.2, 5.1.3, 5.1.4, 5.1.5
 * - 5.1.1: 健康指标采集
 * - 5.1.2: 健康分数计算
 * - 5.1.3: 健康画像生成
 * - 5.1.4: 健康快照存储
 * - 5.1.5: 历史趋势查询
 */

import { logger } from '../../utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DevicePool } from '../device/devicePool';
import type { DataStore } from '../dataStore';
import type { SystemHealthSummary } from '../../types/autonomous-brain';
import { deviceDriverManager } from '../device/deviceDriverManager';

/**
 * Promise 超时包装器
 * 用于保护文件 I/O 锁不由于底层 I/O 挂起而永久持有
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timeout [${label}]: Action exceeded ${ms}ms`));
    }, ms);
  });

  return Promise.race([
    promise.then(result => {
      clearTimeout(timeoutId);
      return result;
    }),
    timeoutPromise,
  ]);
}

/**
 * 健康指标
 */
export interface HealthMetrics {
  /** CPU 使用率 (0-100) */
  cpuUsage: number;
  /** 内存使用率 (0-100) */
  memoryUsage: number;
  /** 磁盘使用率 (0-100) */
  diskUsage: number;
  /** 网络接口状态 */
  interfaceStatus: {
    total: number;
    up: number;
    down: number;
  };
  /** 活跃连接数 */
  activeConnections: number;
  /** 错误率 (0-1) */
  errorRate: number;
  /** 平均响应时间 (ms) */
  avgResponseTime: number;
  /** 采集时间 */
  timestamp: number;
}

/**
 * 健康分数
 */
export interface HealthScore {
  /** 总体健康分数 (0-100) */
  overall: number;
  /** 各维度分数 */
  dimensions: {
    system: number;      // 系统资源
    network: number;     // 网络状态
    performance: number; // 性能指标
    reliability: number; // 可靠性
  };
  /** 健康等级 */
  level: 'healthy' | 'warning' | 'critical';
  /** 问题摘要 */
  issues: string[];
}

/**
 * 健康快照 (内部存储格式)
 */
export interface InternalHealthSnapshot {
  id: string;
  metrics: HealthMetrics;
  score: HealthScore;
  timestamp: number;
  deviceId?: string;
}

/**
 * 健康趋势
 */
export interface HealthTrend {
  period: 'hour' | '6hour' | 'day' | 'week';
  dataPoints: Array<{
    timestamp: number;
    score: number;
    level: string;
  }>;
  avgScore: number;
  minScore: number;
  maxScore: number;
  trend: 'improving' | 'stable' | 'degrading';
  /** 数据来源：database 表示从持久化存储查询，memory_fallback 表示 DB 不可用时回退到内存缓存 */
  source?: 'database' | 'memory_fallback';
}

/**
 * 健康监控配置
 */
export interface HealthMonitorConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 采集间隔 (ms) */
  collectInterval: number;
  /** 快照保留天数 */
  retentionDays: number;
  /** 健康阈值 */
  thresholds: {
    cpuWarning: number;
    cpuCritical: number;
    memoryWarning: number;
    memoryCritical: number;
    diskWarning: number;
    diskCritical: number;
    errorRateWarning: number;
    errorRateCritical: number;
  };
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  enabled: true,
  collectInterval: 60000, // 1 分钟
  retentionDays: 30,
  thresholds: {
    cpuWarning: 70,
    cpuCritical: 90,
    memoryWarning: 75,
    memoryCritical: 90,
    diskWarning: 80,
    diskCritical: 95,
    errorRateWarning: 0.05,
    errorRateCritical: 0.1,
  },
};

const HEALTH_DATA_DIR = 'data/ai-ops/health';

/**
 * HealthMonitor 类
 */
export class HealthMonitor {
  private config: HealthMonitorConfig;
  private snapshots: Map<string, InternalHealthSnapshot> = new Map();
  /** 最新快照缓存 (Audit suggested O(1) query) */
  private lastSnapshots: Map<string, InternalHealthSnapshot> = new Map();
  private initialized: boolean = false;
  private initializing: boolean = false;
  private collectTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private dataDir: string;
  private devicePool: DevicePool | null = null;
  private dataStore: DataStore | null = null;
  /** 基于设备 ID 的写入排队锁，防止并发写入导致的数据丢失 (Audit suggest) */
  private fileWriteLocks: Map<string, Promise<void>> = new Map();

  constructor(config?: Partial<HealthMonitorConfig>, dataDir?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataDir = dataDir || HEALTH_DATA_DIR;
    logger.debug('HealthMonitor created', { config: this.config });
  }

  /**
   * 设置设备连接池（多设备模式）
   * 设置后，采集指标时将遍历所有已连接设备
   */
  setDevicePool(pool: DevicePool): void {
    this.devicePool = pool;
    logger.info('HealthMonitor: DevicePool set, multi-device mode enabled');
  }

  /**
   * 设置数据存储（用于写入 health_metrics 表）
   */
  setDataStore(store: DataStore): void {
    this.dataStore = store;
    logger.info('HealthMonitor: DataStore set, metrics will be persisted to database');
  }

  /**
   * 初始化健康监控
   */
  async initialize(): Promise<void> {
    if (this.initialized || this.initializing) {
      return;
    }

    this.initializing = true;

    try {
      // 确保数据目录存在
      await fs.mkdir(this.dataDir, { recursive: true });

      // 加载历史快照
      await this.loadSnapshots();

      this.initialized = true;
      logger.info('HealthMonitor initialized', { snapshotsCount: this.snapshots.size });

      // 启动自动采集
      if (this.config.enabled) {
        this.startAutoCollect();
      }
    } catch (error) {
      logger.error('Failed to initialize HealthMonitor', { error });
      this.initialized = false;
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * 启动自动采集定时器
   * Requirements: 1.3, 5.1
   * 根据配置的间隔定期采集健康数据
   */
  startAutoCollect(): void {
    // 如果已有定时器，先停止
    if (this.collectTimer) {
      this.stopAutoCollect();
    }

    if (!this.config.enabled) {
      logger.debug('HealthMonitor auto-collect disabled');
      return;
    }

    logger.info('Starting health auto-collect', {
      interval: this.config.collectInterval
    });

    // 立即采集一次
    if (this.devicePool) {
      this.collectAllDeviceMetrics().catch(err => {
        logger.warn('Initial multi-device health snapshot failed', { error: err });
      });
    } else {
      this.createSnapshot().catch(err => {
        logger.warn('Initial health snapshot failed', { error: err });
      });
    }

    // 设置定时采集（使用递归 setTimeout 防止异步任务重叠）
    const runCollect = async () => {
      try {
        if (this.devicePool) {
          await this.collectAllDeviceMetrics();
          logger.debug('Auto multi-device health snapshot created');
        } else {
          await this.createSnapshot();
          logger.debug('Auto health snapshot created');
        }
        this.consecutiveFailures = 0; // 成功后重置计数器
      } catch (error) {
        this.consecutiveFailures++;
        const logMethod = this.consecutiveFailures > 3 ? 'error' : 'warn';
        logger[logMethod]('Auto health snapshot failed', {
          error,
          consecutiveFailures: this.consecutiveFailures
        });

        if (this.consecutiveFailures >= 10) {
          logger.error('HealthMonitor has failed 10 consecutive times — stopping auto-collection (circuit breaker triggered)');
          this.stopAutoCollect();
          return; // 熔断后不再调度
        }
      } finally {
        // 只要没被停止，就调度下一次（确保上一次完成后才开始下一次）
        if (this.collectTimer) {
          this.collectTimer = setTimeout(runCollect, this.config.collectInterval);
        }
      }
    };

    this.collectTimer = setTimeout(runCollect, this.config.collectInterval);

    logger.info('Health auto-collect started');

    // 定时清理过期快照（每小时执行一次），防止文件无限积压
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup().catch(err => {
          logger.warn('Health snapshot cleanup failed', { error: err });
        });
      }, 60 * 60 * 1000); // 1 小时
      // 启动时立即执行一次清理
      this.cleanup().catch(err => {
        logger.warn('Initial health snapshot cleanup failed', { error: err });
      });
    }
  }

  /**
   * 停止自动采集定时器
   * Requirements: 5.1
   */
  stopAutoCollect(): void {
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
      logger.info('Health auto-collect stopped');
    }
  }


  /**
   * 采集健康指标
   * Requirements: 5.1.1, 9.1
   * 从设备获取真实指标数据
   * @param deviceId 可选的设备 ID（多设备模式下传入特定设备 ID）
   */
  async collectMetrics(deviceId?: string): Promise<HealthMetrics> {
    // 如果提供了 deviceId，优先走泛化路径
    if (deviceId) {
      return this.collectMetricsFromDriver(deviceId);
    }

    const now = Date.now();
    const startTime = Date.now();

    // 默认指标（当无法获取真实数据时使用）
    const metrics: HealthMetrics = {
      cpuUsage: 0,
      memoryUsage: 0,
      diskUsage: 0,
      interfaceStatus: { total: 0, up: 0, down: 0 },
      activeConnections: 0,
      errorRate: 0,
      avgResponseTime: 0,
      timestamp: now,
    };

    // 无全局客户端 — 单设备模式需通过 DevicePool 获取连接
    // 尝试从 DevicePool 获取第一个可用连接
    let targetClient: any = null;
    if (this.devicePool) {
      const connections = this.devicePool.getConnectionsMap();
      for (const [, conn] of connections) {
        if (conn.status === 'connected' && conn.client.isConnected()) {
          targetClient = conn.client;
          break;
        }
      }
    }

    if (!targetClient) {
      logger.debug('No device client available, returning default metrics');
      metrics.cpuUsage = -1;
      metrics.memoryUsage = -1;
      metrics.diskUsage = -1;
      return metrics;
    }

    try {
      // 并行获取各项指标以提高效率
      const [resourceResult, interfaceResult, connectionResult] = await Promise.allSettled([
        this.fetchSystemResource(targetClient),
        this.fetchInterfaceStatus(targetClient),
        this.fetchActiveConnections(targetClient),
      ]);

      // 处理系统资源指标
      if (resourceResult.status === 'fulfilled' && resourceResult.value) {
        const resource = resourceResult.value;
        metrics.cpuUsage = resource.cpuUsage;
        metrics.memoryUsage = resource.memoryUsage;
        metrics.diskUsage = resource.diskUsage;
      }

      // 处理接口状态
      if (interfaceResult.status === 'fulfilled' && interfaceResult.value) {
        metrics.interfaceStatus = interfaceResult.value;
      }

      // 处理活跃连接数
      if (connectionResult.status === 'fulfilled') {
        metrics.activeConnections = connectionResult.value;
      }

      // 计算响应时间
      metrics.avgResponseTime = Date.now() - startTime;

      // 计算错误率（基于获取失败的指标数量）
      const totalRequests = 3;
      const failedRequests = [resourceResult, interfaceResult, connectionResult]
        .filter(r => r.status === 'rejected').length;
      metrics.errorRate = failedRequests / totalRequests;

      logger.debug('Health metrics collected from device', {
        timestamp: now,
        cpuUsage: metrics.cpuUsage,
        memoryUsage: metrics.memoryUsage,
        interfaceUp: metrics.interfaceStatus.up,
        responseTime: metrics.avgResponseTime,
      });

    } catch (error) {
      logger.warn('Failed to collect some health metrics', { error });
      metrics.errorRate = 1;
    }

    return metrics;
  }

  /**
   * 通过 DeviceDriverManager 采集设备指标（泛化路径）
   * Requirements: A4.15
   * @param deviceId 目标设备 ID
   */
  async collectMetricsFromDriver(deviceId: string): Promise<HealthMetrics> {
    const now = Date.now();
    const metrics: HealthMetrics = {
      cpuUsage: 0, memoryUsage: 0, diskUsage: 0,
      interfaceStatus: { total: 0, up: 0, down: 0 },
      activeConnections: 0, errorRate: 0, avgResponseTime: 0, timestamp: now,
    };

    const driver = deviceDriverManager.getDriver(deviceId);
    if (!driver) {
      metrics.cpuUsage = -1;
      metrics.memoryUsage = -1;
      metrics.diskUsage = -1;
      return metrics;
    }

    try {
      const startTime = Date.now();
      const deviceMetrics = await driver.collectMetrics();
      metrics.cpuUsage = deviceMetrics.cpuUsage ?? 0;
      metrics.memoryUsage = deviceMetrics.memoryUsage ?? 0;
      metrics.diskUsage = deviceMetrics.diskUsage ?? 0;

      if (deviceMetrics.interfaces) {
        metrics.interfaceStatus.total = deviceMetrics.interfaces.length;
        metrics.interfaceStatus.up = deviceMetrics.interfaces.filter(i => i.status === 'up').length;
        metrics.interfaceStatus.down = deviceMetrics.interfaces.filter(i => i.status === 'down').length;
      }

      metrics.avgResponseTime = Date.now() - startTime;
    } catch (error) {
      logger.warn('Failed to collect metrics from DeviceDriver', { deviceId, error });
      metrics.errorRate = 1;
    }

    return metrics;
  }

  /**
   * 从设备获取系统资源信息
   * @deprecated 使用 collectMetricsFromDriver 替代
   */
  private async fetchSystemResource(client?: any): Promise<{
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
  } | null> {
    try {
      const targetClient = client || null;
      if (!targetClient) return null;
      const response = await targetClient.executeRaw(
        '/system/resource/print',
        ['=.proplist=cpu-load,total-memory,free-memory,total-hdd-space,free-hdd-space'],
      ) as unknown as Array<Record<string, string>>;

      if (!response || !Array.isArray(response) || response.length === 0) {
        return null;
      }

      const resource = response[0];

      // 计算 CPU 使用率
      const cpuLoad = parseInt(resource['cpu-load'] || '0', 10);

      // 计算内存使用率
      const totalMemory = parseInt(resource['total-memory'] || '0', 10);
      const freeMemory = parseInt(resource['free-memory'] || '0', 10);
      const memoryUsage = totalMemory > 0
        ? Math.round(((totalMemory - freeMemory) / totalMemory) * 100)
        : 0;

      // 计算磁盘使用率
      const totalHdd = parseInt(resource['total-hdd-space'] || '0', 10);
      const freeHdd = parseInt(resource['free-hdd-space'] || '0', 10);
      const diskUsage = totalHdd > 0
        ? Math.round(((totalHdd - freeHdd) / totalHdd) * 100)
        : 0;

      return {
        cpuUsage: cpuLoad,
        memoryUsage,
        diskUsage,
      };
    } catch (error) {
      logger.debug('Failed to fetch system resource', { error });
      return null;
    }
  }

  /**
   * 从设备获取接口状态
   * @deprecated 使用 collectMetricsFromDriver 替代
   */
  private async fetchInterfaceStatus(client?: any): Promise<{
    total: number;
    up: number;
    down: number;
  } | null> {
    try {
      const targetClient = client || null;
      if (!targetClient) return null;
      // 只获取 running 字段，大幅减少数据传输量
      const response = await targetClient.executeRaw('/interface/print', ['=.proplist=running']);

      if (!response || !Array.isArray(response)) {
        return null;
      }

      const total = response.length;
      const up = response.filter((iface: Record<string, unknown>) =>
        iface.running === 'true' || iface.running === true
      ).length;
      const down = total - up;

      return { total, up, down };
    } catch (error) {
      logger.debug('Failed to fetch interface status', { error });
      return null;
    }
  }

  /**
   * 从设备获取活跃连接数
   * @deprecated 使用 collectMetricsFromDriver 替代
   */
  private async fetchActiveConnections(client?: any): Promise<number> {
    try {
      const targetClient = client || null;
      if (!targetClient) return 0;
      // 只使用 count-only 获取数量
      const response = await targetClient.executeRaw('/ip/firewall/connection/print', ['=count-only=']);

      if (response && typeof response === 'object' && 'ret' in response) {
        return parseInt(String((response as Record<string, unknown>).ret) || '0', 10);
      }

      // count-only 返回格式不符预期时，返回 0 而非拉全表
      if (Array.isArray(response) && response.length > 0 && response[0]?.ret !== undefined) {
        return parseInt(String(response[0].ret) || '0', 10);
      }

      return 0;
    } catch (error) {
      logger.debug('Failed to fetch active connections', { error });
      return 0;
    }
  }

  /**
   * 计算健康分数
   * Requirements: 5.1.2
   */
  calculateScore(metrics: HealthMetrics): HealthScore {
    const issues: string[] = [];
    const thresholds = this.config.thresholds;

    // 计算系统资源分数
    let systemScore = 100;
    if (metrics.cpuUsage >= thresholds.cpuCritical) {
      systemScore -= 40;
      issues.push(`CPU 使用率过高 (${metrics.cpuUsage}%)`);
    } else if (metrics.cpuUsage >= thresholds.cpuWarning) {
      systemScore -= 20;
      issues.push(`CPU 使用率较高 (${metrics.cpuUsage}%)`);
    }

    if (metrics.memoryUsage >= thresholds.memoryCritical) {
      systemScore -= 40;
      issues.push(`内存使用率过高 (${metrics.memoryUsage}%)`);
    } else if (metrics.memoryUsage >= thresholds.memoryWarning) {
      systemScore -= 20;
      issues.push(`内存使用率较高 (${metrics.memoryUsage}%)`);
    }

    if (metrics.diskUsage >= thresholds.diskCritical) {
      systemScore -= 20;
      issues.push(`磁盘使用率过高 (${metrics.diskUsage}%)`);
    } else if (metrics.diskUsage >= thresholds.diskWarning) {
      systemScore -= 10;
      issues.push(`磁盘使用率较高 (${metrics.diskUsage}%)`);
    }

    // 计算网络状态分数
    let networkScore = 100;
    const { total, down } = metrics.interfaceStatus;
    if (total > 0 && down > 0) {
      const downRate = down / total;
      networkScore -= Math.round(downRate * 100);
      issues.push(`${down}/${total} 个接口离线`);
    }

    // 计算性能分数
    let performanceScore = 100;
    if (metrics.avgResponseTime > 5000) {
      performanceScore -= 40;
      issues.push(`响应时间过长 (${metrics.avgResponseTime}ms)`);
    } else if (metrics.avgResponseTime > 2000) {
      performanceScore -= 20;
      issues.push(`响应时间较长 (${metrics.avgResponseTime}ms)`);
    }

    // 计算可靠性分数
    let reliabilityScore = 100;
    if (metrics.errorRate >= thresholds.errorRateCritical) {
      reliabilityScore -= 50;
      issues.push(`错误率过高 (${(metrics.errorRate * 100).toFixed(1)}%)`);
    } else if (metrics.errorRate >= thresholds.errorRateWarning) {
      reliabilityScore -= 25;
      issues.push(`错误率较高 (${(metrics.errorRate * 100).toFixed(1)}%)`);
    }

    // 计算总体分数
    const overall = Math.round(
      systemScore * 0.3 +
      networkScore * 0.3 +
      performanceScore * 0.2 +
      reliabilityScore * 0.2
    );

    // 确定健康等级
    let level: 'healthy' | 'warning' | 'critical';
    if (overall >= 80) {
      level = 'healthy';
    } else if (overall >= 60) {
      level = 'warning';
    } else {
      level = 'critical';
    }

    return {
      overall,
      dimensions: {
        system: Math.max(0, systemScore),
        network: Math.max(0, networkScore),
        performance: Math.max(0, performanceScore),
        reliability: Math.max(0, reliabilityScore),
      },
      level,
      issues,
    };
  }

  /**
   * 创建健康快照
   * Requirements: 5.1.3, 5.1.4
   */
  async createSnapshot(deviceId?: string): Promise<InternalHealthSnapshot> {
    // 🔴 防御：多设备模式下必须指定 deviceId，否则会静默采集全局默认设备（幽灵越权）
    if (this.devicePool && !deviceId) {
      throw new Error('In multi-device mode, deviceId must be provided to createSnapshot. Refusing to fall back to global default client.');
    }

    const metrics = await this.collectMetrics(deviceId);
    const score = this.calculateScore(metrics);
    const now = Date.now();

    const snapshot: InternalHealthSnapshot = {
      id: `health_${deviceId || 'global'}_${now}`,
      metrics,
      score,
      timestamp: now,
      deviceId: deviceId || 'global',
    };

    // 存储快照（内存 + 文件）
    this.snapshots.set(snapshot.id, snapshot);
    this.lastSnapshots.set(snapshot.deviceId || 'global', snapshot);
    await this.saveSnapshot(snapshot);

    // 如果启用了 DB 且是多设备模式，写入数据库
    // Requirements: 9.1
    if (this.dataStore && deviceId && this.devicePool) {
      const connectionsMap = this.devicePool.getConnectionsMap();
      const pooledConn = connectionsMap.get(deviceId);
      if (pooledConn) {
        await this.writeMetricsToDb(pooledConn.tenantId, deviceId, metrics);
      }
    }

    // 将快照数据喂给异常预测器，用于趋势分析和异常预测
    try {
      const { anomalyPredictor } = await import('./anomalyPredictor');
      anomalyPredictor.updateFromSnapshot(snapshot);

      // 智能进化: 预测性自愈集成 (Predictive Healing Integration)
      // 如果预测到即将发生严重异常(置信度 > 0.85)，提前触发自愈机制
      const { isCapabilityEnabled } = await import('./evolutionConfig');
      if (isCapabilityEnabled('selfHealing')) {
        const predictions = await anomalyPredictor.predict(deviceId || 'global', metrics);
        const highConfidencePredictions = predictions.filter(p => p.confidence > 0.85);

        if (highConfidencePredictions.length > 0) {
          const { getServiceAsync, SERVICE_NAMES } = await import('../bootstrap');
          const faultHealer = await getServiceAsync<any>(SERVICE_NAMES.FAULT_HEALER);

          for (const prediction of highConfidencePredictions) {
            logger.info(`[Preemptive Healing] Detected high confidence anomaly prediction: ${prediction.type} (${(prediction.confidence * 100).toFixed(1)}%)`);

            // 构造模拟的告警事件，用于触发自愈匹配
            let mockMetricName: any = 'cpu';
            if (prediction.type === 'memory_exhaustion') mockMetricName = 'memory';
            if (prediction.type === 'disk_full') mockMetricName = 'disk';
            if (prediction.type === 'interface_failure') mockMetricName = 'interface_status';

            const tenantId = deviceId && this.devicePool ? this.devicePool.getConnectionsMap().get(deviceId)?.tenantId : undefined;

            const mockAlertEvent = {
              id: `preempt_${prediction.id}`,
              ruleId: 'preemptive_healing_rule',
              ruleName: '预测性提前自愈',
              severity: 'critical' as const,
              metric: mockMetricName,
              currentValue: prediction.predictedValue,
              threshold: prediction.threshold,
              message: `[提前自愈] 预测到即将发生: ${prediction.type} (置信度 ${Math.round(prediction.confidence * 100)}%)`,
              status: 'active' as const,
              triggeredAt: Date.now(),
              tenantId: tenantId,
              deviceId: deviceId
            };

            const matchedPattern = await faultHealer.matchPattern(mockAlertEvent);
            if (matchedPattern && matchedPattern.autoHeal) {
              logger.info(`[Preemptive Healing] Preemptively triggering remediation for pattern: ${matchedPattern.name}`);
              // 异步执行，不阻塞快照生成
              faultHealer.executeRemediation(
                matchedPattern.id,
                mockAlertEvent.id,
                tenantId,
                deviceId
              ).catch((err: Error) => logger.warn(`[Preemptive Healing] Failed to execute preemptive remediation: ${err.message}`));
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to update anomaly predictor or trigger preemptive healing', { error });
    }

    logger.info('Health snapshot created', {
      id: snapshot.id,
      score: score.overall,
      level: score.level,
    });

    return snapshot;
  }

  /**
   * 遍历所有已连接设备采集指标（多设备模式）
   * Requirements: 9.1, 9.5
   * 跳过 offline/error 状态的设备，为每个设备创建快照并写入数据库
   */
  private async collectAllDeviceMetrics(): Promise<void> {
    if (!this.devicePool) {
      return;
    }

    const connectionsMap = this.devicePool.getConnectionsMap();

    // 并行采集所有设备的快照
    const tasks: Promise<InternalHealthSnapshot>[] = [];
    const taskDeviceIds: string[] = [];

    for (const [deviceId, pooledConn] of connectionsMap) {
      // 跳过非 connected 状态的设备 (Requirements: 9.5)
      if (pooledConn.status !== 'connected') {
        continue;
      }

      // 跳过未连接的客户端
      if (!pooledConn.client.isConnected()) {
        continue;
      }

      tasks.push(this.createSnapshot(deviceId));
      taskDeviceIds.push(deviceId);
    }

    const results = await Promise.allSettled(tasks);

    // 统计并记录失败设备，方便快速定位采集异常
    const failedDevices: Array<{ deviceId: string; reason: string }> = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const reason = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        failedDevices.push({ deviceId: taskDeviceIds[index], reason });
      }
    });

    if (failedDevices.length > 0) {
      logger.warn(`Health collection: ${failedDevices.length}/${results.length} devices failed`, {
        failedDevices,
        successCount: results.length - failedDevices.length,
      });
    }
  }

  /**
   * 将指标数据写入 health_metrics 表
   * Requirements: 9.1
   * @param tenantId 租户 ID
   * @param deviceId 设备 ID
   * @param metrics 健康指标
   */
  private async writeMetricsToDb(tenantId: string, deviceId: string, metrics: HealthMetrics): Promise<void> {
    if (!this.dataStore) {
      return;
    }

    try {
      const collectedAt = new Date(metrics.timestamp).toISOString();

      const metricEntries: Array<{ name: string; value: number }> = [
        { name: 'overall_health_score', value: this.calculateScore(metrics).overall },
        { name: 'cpu_usage', value: metrics.cpuUsage },
        { name: 'memory_usage', value: metrics.memoryUsage },
        { name: 'disk_usage', value: metrics.diskUsage },
        { name: 'interface_up', value: metrics.interfaceStatus.up },
        { name: 'interface_down', value: metrics.interfaceStatus.down },
        { name: 'active_connections', value: metrics.activeConnections },
        { name: 'error_rate', value: metrics.errorRate },
        { name: 'avg_response_time', value: metrics.avgResponseTime },
      ];

      await this.dataStore.transaction(async (tx) => {
        for (const entry of metricEntries) {
          await tx.execute(
            'INSERT INTO health_metrics (tenant_id, device_id, metric_name, metric_value, collected_at) VALUES ($1, $2, $3, $4, $5)',
            [tenantId, deviceId, entry.name, entry.value, collectedAt]
          );
        }
      });

      logger.debug(`Wrote ${metricEntries.length} metrics to health_metrics for device ${deviceId}`);
    } catch (error) {
      logger.warn('Failed to write metrics to database', { error, tenantId, deviceId });
    }
  }

  /**
   * 获取最新健康状态 (供 Brain 感知，返回解耦后的外部类型)
   */
  async getLatestHealth(deviceId?: string): Promise<SystemHealthSummary | null> {
    const targetDeviceId = deviceId || 'global';
    let snapshot = this.lastSnapshots.get(targetDeviceId);

    // 💡 师傅的“单机智能兜底”修复：
    // 如果按 'global' 找不到，但系统缓存里其实是有快照的，
    // 直接把缓存里唯一的那份数据交出去！（完美兼容单机模式）
    if (!snapshot && targetDeviceId === 'global' && this.lastSnapshots.size > 0) {
      snapshot = Array.from(this.lastSnapshots.values())[0];
    }

    if (!snapshot) return null;

    // 将内部快照转换为大脑感知的健康摘要 
    return {
      cpuUsage: snapshot.metrics.cpuUsage,
      memoryUsage: snapshot.metrics.memoryUsage,
      diskUsage: snapshot.metrics.diskUsage,
      uptime: 'N/A',
      interfaces: [],
      interfaceStats: {
        up: snapshot.metrics.interfaceStatus.up,
        total: snapshot.metrics.interfaceStatus.total
      },
      score: snapshot.score.overall,
      level: snapshot.score.level as any,
      issues: snapshot.score.issues,
      dimensions: snapshot.score.dimensions,
      timestamp: snapshot.timestamp,
    };
  }

  /**
   * 获取健康趋势
   * Requirements: 5.1.5
   */
  async getHealthTrend(period: HealthTrend['period'] = 'hour', deviceId ?: string): Promise < HealthTrend > {
      const now = Date.now();
      let duration = 3600000; // 1 hour

      switch(period) {
      case '6hour': duration = 6 * 3600000; break;
      case 'day': duration = 24 * 3600000; break;
      case 'week': duration = 7 * 24 * 3600000; break;
    }

    const startTime = now - duration;

    // 🔴 BUG FIX: 增加对数据库持久化趋势的查询，内存快照仅作为降级兜底方案
    // 内存 Map 只存最近 100 条，对于 'week' 趋势完全不够，必须查询 health_metrics 表
    if (this.dataStore) {
      try {
        let paramIdx = 1;
        let query = `
          SELECT 
            metric_value as score,
            collected_at as timestamp
          FROM health_metrics 
          WHERE metric_name = 'overall_health_score'
          AND collected_at >= $${paramIdx++}`;
        const params: unknown[] = [new Date(startTime).toISOString()];
        if (deviceId) {
          query += ` AND device_id = $${paramIdx++}`;
          params.push(deviceId);
        }
        query += ' ORDER BY collected_at ASC';

        const dbRows = await this.dataStore.query<any>(query, params);
        if (dbRows && dbRows.length > 0) {
          const dataPoints = dbRows.map((r: any) => {
            const score = Math.round(r.score);
            let level: 'healthy' | 'warning' | 'critical';
            // 采用标准健康分阈值
            if (score >= 80) level = 'healthy';
            else if (score >= 60) level = 'warning';
            else level = 'critical';

            return {
              timestamp: new Date(r.timestamp).getTime(),
              score: score,
              level: level
            };
          });

          const scores = dataPoints.map(d => d.score);
          const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

          let trend: HealthTrend['trend'] = 'stable';
          if (dataPoints.length >= 2) {
            const first = dataPoints[0].score;
            const last = dataPoints[dataPoints.length - 1].score;
            if (last > first + 5) trend = 'improving';
            else if (last < first - 5) trend = 'degrading';
          }

          return {
            period,
            dataPoints,
            avgScore: Math.round(avgScore),
            minScore: Math.min(...scores),
            maxScore: Math.max(...scores),
            trend,
            source: 'database'
          };
        }
      } catch (dbErr) {
        logger.warn('Failed to fetch health trend from database, falling back to memory', { error: dbErr });
      }
    }

    // 内存回退方案 (Fallback to legacy memory implementation)
    const filteredSnapshots = Array.from(this.snapshots.values())
      .filter(s => s.timestamp >= startTime && (!deviceId || s.deviceId === deviceId))
      .sort((a, b) => a.timestamp - b.timestamp);

    const dataPoints = filteredSnapshots.map(s => ({
      timestamp: s.timestamp,
      score: s.score.overall,
      level: s.score.level,
    }));

    if (dataPoints.length === 0) {
      return {
        period,
        dataPoints: [],
        avgScore: 0,
        minScore: 0,
        maxScore: 0,
        trend: 'stable',
        source: 'memory_fallback'
      };
    }

    const scores = dataPoints.map(d => d.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);

    let trend: HealthTrend['trend'] = 'stable';
    if (dataPoints.length >= 2) {
      const first = dataPoints[0].score;
      const last = dataPoints[dataPoints.length - 1].score;
      if (last > first + 5) trend = 'improving';
      else if (last < first - 5) trend = 'degrading';
    }

    return {
      period,
      dataPoints,
      avgScore: Math.round(avgScore),
      minScore,
      maxScore,
      trend,
      source: 'memory_fallback' as const,
    };
  }

  /**
   * 获取健康摘要（用于注入到对话上下文）
   */
  async getHealthSummary(): Promise<string> {
    const latest = await this.getLatestHealth();
    if (!latest) {
      return '暂无健康数据';
    }

    const { score, level, cpuUsage, memoryUsage, diskUsage, interfaceStats, issues } = latest;
    const lines: string[] = [
      `健康状态: ${this.getLevelLabel(level)} (${score}分)`,
      `系统资源: CPU ${cpuUsage}%, 内存 ${memoryUsage}%, 磁盘 ${diskUsage}%`,
    ];

    if (interfaceStats) {
      lines.push(`网络状态: ${interfaceStats.up}/${interfaceStats.total} 接口在线`);
    }

    if (issues && issues.length > 0) {
      lines.push(`问题: ${issues.slice(0, 3).join('; ')}`);
    }

    return lines.join('\n');
  }

  /**
   * 清理过期快照
   * 🔴 FIX (Audit suggest): 并行化处理，显著提升面对海量旧碎片文件时的清理效率
   */
  async cleanup(): Promise<number> {
    const cutoffTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    const CONCURRENCY_LIMIT = 50; // 控制并行规模
    let deleted = 0;

    try {
      const allFiles = await fs.readdir(this.dataDir);
      const jsonFiles = allFiles.filter(f => f.endsWith('.json'));

      for (let i = 0; i < jsonFiles.length; i += CONCURRENCY_LIMIT) {
        const batch = jsonFiles.slice(i, i + CONCURRENCY_LIMIT);
        const batchPromises = batch.map(async (file) => {
          try {
            const filePath = path.join(this.dataDir, file);
            const stats = await fs.stat(filePath);

            let shouldDelete = false;

            if (file.startsWith('health_rolling_')) {
              if (stats.mtimeMs < cutoffTime) shouldDelete = true;
            } else {
              const parts = file.replace('.json', '').split('_');
              const timestampStr = parts[parts.length - 1];
              const timestamp = parseInt(timestampStr, 10);

              if (!isNaN(timestamp) && timestamp < cutoffTime) {
                shouldDelete = true;
              } else if (isNaN(timestamp) && stats.mtimeMs < cutoffTime) {
                shouldDelete = true;
              }
            }

            if (shouldDelete) {
              await fs.unlink(filePath);
              const id = file.replace('.json', '');
              this.snapshots.delete(id);
              return true;
            }
          } catch (e) {
            // 记录单个文件处理失败，但不中断整个批处理
            logger.debug(`Failed to process snapshot file during cleanup: ${file}`, { error: e });
          }
          return false;
        });

        const results = await Promise.allSettled(batchPromises);
        results.forEach(res => {
          if (res.status === 'fulfilled' && res.value) {
            deleted++;
          }
        });
      }
    } catch (dirErr) {
      logger.error('Failed to read data directory during cleanup', { error: dirErr });
    }

    if (deleted > 0) {
      logger.info('Cleaned up exhaustive health snapshots from disk (Parallel)', { deleted });
    }

    return deleted;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<HealthMonitorConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('HealthMonitor config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): HealthMonitorConfig {
    return { ...this.config };
  }

  /**
   * 优雅关闭 HealthMonitor，清理所有定时器和资源
   */
  shutdown(): void {
    logger.info('Shutting down HealthMonitor...');
    this.stopAutoCollect();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.initialized = false;
    this.consecutiveFailures = 0;
    logger.info('HealthMonitor shutdown complete');
  }

  // ==================== 私有方法 ====================

  private getLevelLabel(level: string): string {
    const labels: Record<string, string> = {
      healthy: '健康 ✓',
      warning: '警告 ⚠',
      critical: '严重 ✗',
    };
    return labels[level] || level;
  }

  private async loadSnapshots(): Promise<void> {
    try {
      const files = await fs.readdir(this.dataDir);

      // 优先从新格式（合并文件）加载
      const rollingFiles = files.filter(f => f.startsWith('health_rolling_') && f.endsWith('.json'));
      if (rollingFiles.length > 0) {
        let loadCount = 0;
        let deviceCount = new Set<string>();

        for (const file of rollingFiles) {
          try {
            const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
            const data = JSON.parse(content) as { snapshots: InternalHealthSnapshot[] };
            if (data.snapshots && Array.isArray(data.snapshots)) {
              for (const s of data.snapshots) {
                this.snapshots.set(s.id, s);
                loadCount++;

                // 更新最新快照缓存
                const deviceId = s.deviceId || 'global';
                deviceCount.add(deviceId);
                const existingLast = this.lastSnapshots.get(deviceId);
                if (!existingLast || s.timestamp > existingLast.timestamp) {
                  this.lastSnapshots.set(deviceId, s);
                }
              }
            }
          } catch (e) {
            logger.warn(`Failed to load rolling snapshot file: ${file}`, { error: e });
          }
        }
        logger.info(`HealthMonitor initialized from rolling snapshots. Loaded ${loadCount} records for ${deviceCount.size} devices.`);
        return; // 如果有新格式，优先使用并返回
      }

      // 回退逻辑：加载旧格式文件（仅前 50 个，避免海量文件阻塞）
      const legacyFiles = files.filter(f => !f.startsWith('health_rolling_') && f.endsWith('.json'));
      legacyFiles.sort().reverse();
      const recentFiles = legacyFiles.slice(0, 50);

      const readPromises = recentFiles.map(async (file) => {
        try {
          const content = await fs.readFile(path.join(this.dataDir, file), 'utf-8');
          return JSON.parse(content) as InternalHealthSnapshot;
        } catch (error) {
          logger.debug(`Failed to parse legacy snapshot file: ${file}`, { error });
          return null;
        }
      });

      const snapshots = await Promise.all(readPromises);
      let loadCount = 0;
      const deviceCount = new Set<string>();

      for (const snapshot of snapshots) {
        if (snapshot) {
          this.snapshots.set(snapshot.id, snapshot);
          loadCount++;

          // 更新最新快照缓存
          const deviceId = snapshot.deviceId || 'global';
          deviceCount.add(deviceId);
          const existingLast = this.lastSnapshots.get(deviceId);
          if (!existingLast || snapshot.timestamp > existingLast.timestamp) {
            this.lastSnapshots.set(deviceId, snapshot);
          }
        }
      }
      logger.info(`HealthMonitor loaded ${loadCount} legacy snapshots for ${deviceCount.size} devices`);
    } catch (error) {
      logger.debug('No existing snapshots to load');
    }
  }

  private async saveSnapshot(snapshot: InternalHealthSnapshot): Promise<void> {
    const deviceId = snapshot.deviceId || 'global';

    // 🔴 FIX (Audit suggest): 实现基于设备 ID 的写入排队锁，防止并发重命名导致的数据丢失
    let resolveLock: () => void = () => { };
    const lockPromise = new Promise<void>(resolve => {
      resolveLock = resolve;
    });

    const previousLock = this.fileWriteLocks.get(deviceId) || Promise.resolve();
    this.fileWriteLocks.set(deviceId, lockPromise);

    try {
      // 等待该设备的上一轮写入任务完成
      await previousLock;

      await fs.mkdir(this.dataDir, { recursive: true });

      const rollingPath = path.join(this.dataDir, `health_rolling_${deviceId}.json`);
      const MAX_ROLLING_HISTORY = 120; // 每个设备保留最近 2 小时（120分钟）的精细快照

      // 获取当前设备的滚动历史
      const deviceSnapshots = Array.from(this.snapshots.values())
        .filter(s => s.deviceId === deviceId)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_ROLLING_HISTORY);

      const data = {
        deviceId,
        updatedAt: Date.now(),
        snapshots: deviceSnapshots
      };

      const tempPath = `${rollingPath}.${Date.now()}.tmp`;

      // 🟡 FIX (Gemini audit): 为文件 I/O 增加 10s 超时保护，防止底层 I/O 挂起导致锁无法释放
      await withTimeout(
        (async () => {
          await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
          await fs.rename(tempPath, rollingPath);
        })(),
        10000,
        `saveSnapshot I/O for ${deviceId}`
      );

      // --- 新增内存清理逻辑 (Audit suggest: Prevent memory leak) ---
      const snapshotsToKeep = new Set(deviceSnapshots.map(s => s.id));
      const allDeviceSnapshotsInMemory = Array.from(this.snapshots.values())
        .filter(s => s.deviceId === deviceId);

      for (const snap of allDeviceSnapshotsInMemory) {
        if (!snapshotsToKeep.has(snap.id)) {
          this.snapshots.delete(snap.id);
        }
      }
      logger.debug(`Pruned in-memory snapshots for device ${deviceId}, keeping ${snapshotsToKeep.size}`);
    } catch (error) {
      logger.error('Failed to save health rolling snapshot', { error, snapshotId: snapshot.id, deviceId });
    } finally {
      // 释放当前锁，让后续任务执行
      resolveLock();
      if (this.fileWriteLocks.get(deviceId) === lockPromise) {
        this.fileWriteLocks.delete(deviceId);
      }
    }
  }

}

// 导出单例实例
export const healthMonitor = new HealthMonitor();
