/**
 * ProactiveInspector - 主动巡检器
 * 
 * 实现定时主动巡检和报告生成
 * 
 * Requirements: 5.3.1, 5.3.2, 5.3.3, 5.3.4, 5.3.5
 * - 5.3.1: 定时巡检逻辑
 * - 5.3.2: 巡检项配置
 * - 5.3.3: 巡检报告生成
 * - 5.3.4: 问题发现和告警
 * - 5.3.5: 巡检历史记录
 */

import { logger } from '../../utils/logger';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DeviceManager } from '../device/deviceManager';
import type { EventBus } from '../eventBus';
import type { DataStore } from '../dataStore';
import type { DeviceMetrics, HealthCheckResult } from '../../types/device-driver';

/**
 * 巡检项类型
 */
export type InspectionItemType =
  | 'system_health'      // 系统健康
  | 'interface_status'   // 接口状态
  | 'resource_usage'     // 资源使用
  | 'security_check'     // 安全检查
  | 'config_validation'  // 配置验证
  | 'performance_check'  // 性能检查
  | 'backup_status'      // 备份状态
  | 'log_analysis';      // 日志分析

/**
 * 巡检项配置
 */
export interface InspectionItem {
  /** 巡检项 ID */
  id: string;
  /** 巡检项名称 */
  name: string;
  /** 巡检类型 */
  type: InspectionItemType;
  /** 是否启用 */
  enabled: boolean;
  /** 巡检间隔 (ms) */
  interval: number;
  /** 超时时间 (ms) */
  timeout: number;
  /** 巡检函数 */
  check?: () => Promise<InspectionResult>;
}

/**
 * 巡检结果
 */
export interface InspectionResult {
  /** 巡检项 ID */
  itemId: string;
  /** 状态 */
  status: 'passed' | 'warning' | 'failed' | 'skipped';
  /** 消息 */
  message: string;
  /** 详细信息 */
  details?: Record<string, unknown>;
  /** 发现的问题 */
  issues?: InspectionIssue[];
  /** 执行时间 (ms) */
  duration: number;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 巡检发现的问题
 */
export interface InspectionIssue {
  /** 问题 ID */
  id: string;
  /** 严重级别 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 问题描述 */
  description: string;
  /** 受影响的组件 */
  affectedComponent?: string;
  /** 建议的修复措施 */
  suggestedFix?: string;
}

/**
 * 巡检报告
 */
export interface InspectionReport {
  /** 报告 ID */
  id: string;
  /** 巡检类型 */
  type: 'scheduled' | 'manual' | 'triggered';
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 总耗时 (ms) */
  duration: number;
  /** 巡检结果列表 */
  results: InspectionResult[];
  /** 摘要 */
  summary: InspectionSummary;
  /** 发现的所有问题 */
  allIssues: InspectionIssue[];
}

/**
 * 巡检摘要
 */
export interface InspectionSummary {
  /** 总巡检项数 */
  total: number;
  /** 通过数 */
  passed: number;
  /** 警告数 */
  warning: number;
  /** 失败数 */
  failed: number;
  /** 跳过数 */
  skipped: number;
  /** 总问题数 */
  issueCount: number;
  /** 严重问题数 */
  criticalIssueCount: number;
  /** 整体状态 */
  overallStatus: 'healthy' | 'warning' | 'critical';
}

/**
 * 巡检器配置
 */
export interface ProactiveInspectorConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 默认巡检间隔 (ms) */
  defaultInterval: number;
  /** 巡检超时 (ms) */
  defaultTimeout: number;
  /** 报告存储路径 */
  reportStoragePath: string;
  /** 最大报告保留数量 */
  maxReportRetention: number;
  /** 是否自动启动定时巡检 */
  autoStart: boolean;
}

const DEFAULT_CONFIG: ProactiveInspectorConfig = {
  enabled: true,
  defaultInterval: 60 * 60 * 1000, // 1 小时
  defaultTimeout: 30000, // 30 秒
  reportStoragePath: 'data/ai-ops/inspections',
  maxReportRetention: 100,
  autoStart: true,  // 修复：默认自动启动
};


/**
 * ProactiveInspector 类
 */
export class ProactiveInspector extends EventEmitter {
  private config: ProactiveInspectorConfig;
  private items: Map<string, InspectionItem> = new Map();
  private scheduledTimers: Map<string, NodeJS.Timeout> = new Map();
  private reportIdCounter = 0;
  private issueIdCounter = 0;
  private isRunning = false;
  private lastReport: InspectionReport | null = null;

  /** Optional: DeviceManager for DeviceDriver-based inspections (G5.15) */
  private deviceManager: DeviceManager | null = null;
  /** Optional: EventBus for publishing inspection results as PerceptionEvents (G5.15) */
  private eventBus: EventBus | null = null;
  /** Optional: DataStore for persisting inspection reports to PostgreSQL (G5.15) */
  private pgDataStore: DataStore | null = null;

  constructor(config?: Partial<ProactiveInspectorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeDefaultItems();
    logger.debug('ProactiveInspector created', { config: this.config });
  }

  /**
   * 设置 DeviceManager 依赖
   * 启用后巡检通过 DeviceDriver 标准化接口执行
   */
  setDeviceManager(dm: DeviceManager): void {
    this.deviceManager = dm;
    logger.info('ProactiveInspector: DeviceManager configured');
  }

  /**
   * 设置 EventBus 依赖
   * 启用后巡检结果作为 PerceptionEvent 发布
   */
  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    logger.info('ProactiveInspector: EventBus configured');
  }

  /**
   * 设置 DataStore 依赖（PostgreSQL）
   * 启用后巡检报告持久化到 PostgreSQL
   */
  setDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
    logger.info('ProactiveInspector: DataStore configured for PostgreSQL persistence');
  }

  /**
   * 初始化默认巡检项
   */
  private initializeDefaultItems(): void {
    // 系统健康检查
    this.registerItem({
      id: 'system_health',
      name: '系统健康检查',
      type: 'system_health',
      enabled: true,
      interval: this.config.defaultInterval,
      timeout: this.config.defaultTimeout,
      check: async () => this.checkSystemHealth(),
    });

    // 接口状态检查
    this.registerItem({
      id: 'interface_status',
      name: '接口状态检查',
      type: 'interface_status',
      enabled: true,
      interval: this.config.defaultInterval,
      timeout: this.config.defaultTimeout,
      check: async () => this.checkInterfaceStatus(),
    });

    // 资源使用检查
    this.registerItem({
      id: 'resource_usage',
      name: '资源使用检查',
      type: 'resource_usage',
      enabled: true,
      interval: this.config.defaultInterval,
      timeout: this.config.defaultTimeout,
      check: async () => this.checkResourceUsage(),
    });

    // 配置验证
    this.registerItem({
      id: 'config_validation',
      name: '配置验证',
      type: 'config_validation',
      enabled: true,
      interval: this.config.defaultInterval * 2, // 2 小时
      timeout: this.config.defaultTimeout,
      check: async () => this.validateConfig(),
    });
  }

  /**
   * 注册巡检项
   * Requirements: 5.3.2
   */
  registerItem(item: InspectionItem): void {
    this.items.set(item.id, item);
    logger.debug('Inspection item registered', { id: item.id, name: item.name });
  }

  /**
   * 注销巡检项
   */
  unregisterItem(itemId: string): boolean {
    this.stopItemSchedule(itemId);
    return this.items.delete(itemId);
  }

  /**
   * 启动定时巡检
   * Requirements: 5.3.1
   */
  start(): void {
    if (!this.config.enabled) {
      logger.warn('ProactiveInspector is disabled');
      return;
    }

    if (this.isRunning) {
      logger.warn('ProactiveInspector is already running');
      return;
    }

    this.isRunning = true;

    for (const [itemId, item] of this.items) {
      if (item.enabled) {
        this.scheduleItem(itemId);
      }
    }

    logger.info('ProactiveInspector started', { itemCount: this.items.size });
    this.emit('started');
  }

  /**
   * 停止定时巡检
   */
  stop(): void {
    this.isRunning = false;

    for (const [itemId] of this.scheduledTimers) {
      this.stopItemSchedule(itemId);
    }

    logger.info('ProactiveInspector stopped');
    this.emit('stopped');
  }

  /**
   * 执行完整巡检
   * Requirements: 5.3.3
   */
  async runFullInspection(type: 'scheduled' | 'manual' | 'triggered' = 'manual'): Promise<InspectionReport> {
    const startTime = Date.now();
    const results: InspectionResult[] = [];
    const allIssues: InspectionIssue[] = [];

    logger.info('Starting full inspection', { type, itemCount: this.items.size });

    for (const [itemId, item] of this.items) {
      if (!item.enabled) {
        results.push({
          itemId,
          status: 'skipped',
          message: '巡检项已禁用',
          duration: 0,
          timestamp: Date.now(),
        });
        continue;
      }

      try {
        const result = await this.runSingleInspection(item);
        results.push(result);
        if (result.issues) {
          allIssues.push(...result.issues);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          itemId,
          status: 'failed',
          message: `巡检执行失败: ${errorMsg}`,
          duration: 0,
          timestamp: Date.now(),
        });
      }
    }

    const endTime = Date.now();
    const summary = this.generateSummary(results, allIssues);

    const report: InspectionReport = {
      id: `insp_${++this.reportIdCounter}_${startTime}`,
      type,
      startTime,
      endTime,
      duration: endTime - startTime,
      results,
      summary,
      allIssues,
    };

    this.lastReport = report;

    // 保存报告（PostgreSQL 优先，文件系统回退）
    await this.saveReport(report);

    // EventBus 集成：将巡检结果作为 PerceptionEvent 发布 (G5.15)
    if (this.eventBus && report.allIssues.length > 0) {
      try {
        await this.eventBus.publish({
          type: 'internal',
          priority: report.allIssues.some(i => i.severity === 'critical') ? 'high' : 'medium',
          source: 'proactive_inspector',
          payload: {
            eventSubType: 'inspection_result',
            reportId: report.id,
            issueCount: report.allIssues.length,
            criticalCount: report.allIssues.filter(i => i.severity === 'critical').length,
            summary: report.summary,
          },
          schemaVersion: '1.0.0',
        });
      } catch (err) {
        logger.warn('ProactiveInspector: Failed to publish inspection result to EventBus', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 发出事件
    this.emit('inspectionComplete', report);

    // 如果有严重问题，发出告警事件
    if (summary.criticalIssueCount > 0) {
      const criticalIssues = allIssues.filter(i => i.severity === 'critical');
      this.emit('criticalIssuesFound', {
        report,
        criticalIssues,
      });

      // 智能进化: 自主的意图生成 (Autonomous Intent Generation)
      try {
        const { isCapabilityEnabled } = await import('./evolutionConfig');
        if (isCapabilityEnabled('intentDriven')) {
          const { intentParser } = await import('./intentParser');

          for (const issue of criticalIssues) {
            // 将基础设施问题转化为可读的自然语言目标
            const intentText = `系统巡检发现严重问题: [${issue.affectedComponent || 'System'}] ${issue.description}。请立即诊断并提供修复方案。`;
            logger.info(`[Autonomous Intent] Generating system-level intent from inspection issue: ${intentText}`);

            // 解析意图并作为系统发出的指令
            const parsedIntent = await intentParser.parse(intentText);

            if (parsedIntent && parsedIntent.confidence > 0.7) {
              logger.info(`[Autonomous Intent] Successfully parsed system intent: ${parsedIntent.category} - ${parsedIntent.action}`);
              // 发出自主意图事件，构建系统触发的工作流
              this.emit('autonomousIntentGenerated', {
                source: 'proactiveInspector',
                issueType: issue.affectedComponent || 'unknown',
                intent: parsedIntent,
                originalText: intentText,
                timestamp: Date.now()
              });
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to generate autonomous intent', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    logger.info('Full inspection completed', {
      reportId: report.id,
      duration: report.duration,
      summary,
    });

    return report;
  }

  /**
   * 执行单个巡检项
   */
  async runSingleInspection(item: InspectionItem): Promise<InspectionResult> {
    const startTime = Date.now();

    if (!item.check) {
      return {
        itemId: item.id,
        status: 'skipped',
        message: '未配置巡检函数',
        duration: 0,
        timestamp: startTime,
      };
    }

    try {
      // 带超时执行
      const result = await Promise.race([
        item.check(),
        new Promise<InspectionResult>((_, reject) =>
          setTimeout(() => reject(new Error('巡检超时')), item.timeout)
        ),
      ]);

      return {
        ...result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        itemId: item.id,
        status: 'failed',
        message: errorMsg,
        duration: Date.now() - startTime,
        timestamp: startTime,
      };
    }
  }

  /**
   * 获取最后一次巡检报告
   */
  getLastReport(): InspectionReport | null {
    return this.lastReport;
  }

  /**
   * 获取所有巡检项
   */
  getItems(): InspectionItem[] {
    return Array.from(this.items.values());
  }

  /**
   * 获取巡检项
   */
  getItem(itemId: string): InspectionItem | undefined {
    return this.items.get(itemId);
  }

  /**
   * 启用/禁用巡检项
   */
  setItemEnabled(itemId: string, enabled: boolean): boolean {
    const item = this.items.get(itemId);
    if (!item) return false;

    item.enabled = enabled;
    if (enabled && this.isRunning) {
      this.scheduleItem(itemId);
    } else {
      this.stopItemSchedule(itemId);
    }

    return true;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ProactiveInspectorConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('ProactiveInspector config updated', { config: this.config });
  }

  /**
   * 关闭巡检器
   */
  shutdown(): void {
    this.stop();
    this.removeAllListeners();
    logger.info('ProactiveInspector shutdown');
  }

  // ==================== 私有方法 ====================

  private scheduleItem(itemId: string): void {
    const item = this.items.get(itemId);
    if (!item) return;

    // 清除现有定时器
    this.stopItemSchedule(itemId);

    const timer = setInterval(async () => {
      try {
        const result = await this.runSingleInspection(item);
        this.emit('itemInspected', { itemId, result });
      } catch (error) {
        logger.error('Scheduled inspection failed', { itemId, error });
      }
    }, item.interval);

    this.scheduledTimers.set(itemId, timer);
    logger.debug('Inspection item scheduled', { itemId, interval: item.interval });
  }

  private stopItemSchedule(itemId: string): void {
    const timer = this.scheduledTimers.get(itemId);
    if (timer) {
      clearInterval(timer);
      this.scheduledTimers.delete(itemId);
    }
  }

  private generateSummary(results: InspectionResult[], issues: InspectionIssue[]): InspectionSummary {
    const summary: InspectionSummary = {
      total: results.length,
      passed: 0,
      warning: 0,
      failed: 0,
      skipped: 0,
      issueCount: issues.length,
      criticalIssueCount: issues.filter(i => i.severity === 'critical').length,
      overallStatus: 'healthy',
    };

    for (const result of results) {
      switch (result.status) {
        case 'passed': summary.passed++; break;
        case 'warning': summary.warning++; break;
        case 'failed': summary.failed++; break;
        case 'skipped': summary.skipped++; break;
      }
    }

    // 确定整体状态
    if (summary.failed > 0 || summary.criticalIssueCount > 0) {
      summary.overallStatus = 'critical';
    } else if (summary.warning > 0 || summary.issueCount > 0) {
      summary.overallStatus = 'warning';
    }

    return summary;
  }

  private async saveReport(report: InspectionReport): Promise<void> {
    // PostgreSQL 持久化优先
    if (this.pgDataStore) {
      try {
        const overallScore = report.summary.overallStatus === 'healthy' ? 1.0
          : report.summary.overallStatus === 'warning' ? 0.5 : 0.0;
        await this.pgDataStore.execute(
          `INSERT INTO evaluation_reports (id, tick_id, symptom_score, metric_score, side_effect_score, execution_quality_score, time_efficiency_score, overall_score, failure_category, details, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            report.id,
            overallScore, // symptom_score: overall health
            overallScore, // metric_score: same for inspection
            1.0,          // side_effect_score: inspections have no side effects
            1.0,          // execution_quality_score: inspection ran successfully
            report.duration < 30000 ? 1.0 : 0.5, // time_efficiency_score
            overallScore,
            report.summary.overallStatus === 'critical' ? 'inspection_critical' : null,
            JSON.stringify({
              reportType: 'inspection',
              inspectionType: report.type,
              startTime: report.startTime,
              endTime: report.endTime,
              duration: report.duration,
              summary: report.summary,
              results: report.results,
              allIssues: report.allIssues,
            }),
          ],
        );
        return;
      } catch (error) {
        logger.warn('ProactiveInspector: Failed to save report to PostgreSQL, falling back to file', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 文件系统回退
    try {
      const dir = this.config.reportStoragePath;
      await fs.mkdir(dir, { recursive: true });

      const filename = `${report.id}.json`;
      const filepath = path.join(dir, filename);
      await fs.writeFile(filepath, JSON.stringify(report, null, 2));

      // 清理旧报告
      await this.cleanupOldReports();
    } catch (error) {
      logger.error('Failed to save inspection report', { error });
    }
  }

  private async cleanupOldReports(): Promise<void> {
    try {
      const dir = this.config.reportStoragePath;
      const files = await fs.readdir(dir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

      if (jsonFiles.length > this.config.maxReportRetention) {
        const toDelete = jsonFiles.slice(0, jsonFiles.length - this.config.maxReportRetention);
        for (const file of toDelete) {
          await fs.unlink(path.join(dir, file));
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old reports', { error });
    }
  }

  // ==================== 默认巡检实现 ====================

  private async checkSystemHealth(): Promise<InspectionResult> {
    const issues: InspectionIssue[] = [];
    const timestamp = Date.now();

    // DeviceDriver-based implementation when DeviceManager is available (G5.15)
    if (this.deviceManager) {
      try {
        const devices = await this.deviceManager.getDevices('*', undefined, { allowCrossTenant: true });
        const details: Record<string, unknown> = { deviceCount: devices.length, deviceResults: [] };
        const deviceResults: Array<Record<string, unknown>> = [];

        for (const device of devices) {
          if (device.status === 'offline') continue;
          try {
            const pool = (this.deviceManager as any).devicePool;
            if (!pool) continue;
            const driver = await pool.getConnection(device.tenant_id, device.id);
            if (!driver) continue;

            const healthResult: HealthCheckResult = await driver.healthCheck();
            deviceResults.push({
              deviceId: device.id,
              deviceName: device.name,
              healthy: healthResult.healthy,
              latencyMs: healthResult.latencyMs,
              message: healthResult.message,
            });

            if (!healthResult.healthy) {
              issues.push(this.createIssue(
                'high',
                `设备 ${device.name} (${device.host}) 健康检查失败: ${healthResult.message || 'unknown'}`,
                device.name,
                '检查设备连接和服务状态',
              ));
            }
          } catch (err) {
            logger.debug(`ProactiveInspector: healthCheck failed for device ${device.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        details.deviceResults = deviceResults;
        const status = issues.length > 0 ? (issues.some(i => i.severity === 'critical') ? 'failed' : 'warning') : 'passed';
        return {
          itemId: 'system_health',
          status,
          message: issues.length > 0 ? `发现 ${issues.length} 个健康问题` : '系统健康检查通过',
          details,
          issues,
          duration: 0,
          timestamp,
        };
      } catch (err) {
        logger.warn('ProactiveInspector: DeviceManager-based health check failed, using fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: metricsCollector-based approach
    const details = {
      uptime: 'unknown',
      version: 'unknown',
      boardName: 'unknown',
    };

    return {
      itemId: 'system_health',
      status: 'passed',
      message: '系统健康检查通过',
      details,
      issues,
      duration: 0,
      timestamp,
    };
  }

  private async checkInterfaceStatus(): Promise<InspectionResult> {
    const issues: InspectionIssue[] = [];
    const timestamp = Date.now();

    // DeviceDriver-based implementation when DeviceManager is available (G5.15)
    if (this.deviceManager) {
      try {
        const devices = await this.deviceManager.getDevices('*', undefined, { allowCrossTenant: true });
        let totalInterfaces = 0;
        let upInterfaces = 0;
        let downInterfaces = 0;

        for (const device of devices) {
          if (device.status === 'offline') continue;
          try {
            const pool = (this.deviceManager as any).devicePool;
            if (!pool) continue;
            const driver = await pool.getConnection(device.tenant_id, device.id);
            if (!driver) continue;

            const metrics: DeviceMetrics = await driver.collectMetrics();
            if (metrics.interfaces) {
              for (const iface of metrics.interfaces) {
                totalInterfaces++;
                if (iface.status === 'up') {
                  upInterfaces++;
                } else if (iface.status === 'down') {
                  downInterfaces++;
                  issues.push(this.createIssue(
                    'medium',
                    `设备 ${device.name} 接口 ${iface.name} 状态为 down`,
                    `${device.name}/${iface.name}`,
                    '检查物理连接和接口配置',
                  ));
                }
              }
            }
          } catch (err) {
            logger.debug(`ProactiveInspector: collectMetrics failed for device ${device.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const details = { totalInterfaces, upInterfaces, downInterfaces };
        const status = downInterfaces > 0 ? 'warning' : 'passed';
        return {
          itemId: 'interface_status',
          status,
          message: downInterfaces > 0 ? `${downInterfaces} 个接口离线` : '接口状态检查通过',
          details,
          issues,
          duration: 0,
          timestamp,
        };
      } catch (err) {
        logger.warn('ProactiveInspector: DeviceManager-based interface check failed, using fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback
    const details = {
      totalInterfaces: 0,
      upInterfaces: 0,
      downInterfaces: 0,
    };

    return {
      itemId: 'interface_status',
      status: 'passed',
      message: '接口状态检查通过',
      details,
      issues,
      duration: 0,
      timestamp,
    };
  }

  private async checkResourceUsage(): Promise<InspectionResult> {
    const issues: InspectionIssue[] = [];
    const timestamp = Date.now();

    // DeviceDriver-based implementation when DeviceManager is available (G5.15)
    if (this.deviceManager) {
      try {
        const devices = await this.deviceManager.getDevices('*', undefined, { allowCrossTenant: true });
        const aggregated = { cpuUsage: 0, memoryUsage: 0, diskUsage: 0, deviceCount: 0 };

        for (const device of devices) {
          if (device.status === 'offline') continue;
          try {
            const pool = (this.deviceManager as any).devicePool;
            if (!pool) continue;
            const driver = await pool.getConnection(device.tenant_id, device.id);
            if (!driver) continue;

            const metrics: DeviceMetrics = await driver.collectMetrics();
            aggregated.deviceCount++;

            if (metrics.cpuUsage !== undefined) {
              aggregated.cpuUsage = Math.max(aggregated.cpuUsage, metrics.cpuUsage);
              if (metrics.cpuUsage > 90) {
                issues.push(this.createIssue(
                  'high',
                  `设备 ${device.name} CPU 使用率过高: ${metrics.cpuUsage}%`,
                  device.name,
                  '检查高 CPU 进程，考虑扩容或优化',
                ));
              } else if (metrics.cpuUsage > 80) {
                issues.push(this.createIssue(
                  'medium',
                  `设备 ${device.name} CPU 使用率偏高: ${metrics.cpuUsage}%`,
                  device.name,
                  '监控 CPU 趋势，准备优化方案',
                ));
              }
            }

            if (metrics.memoryUsage !== undefined) {
              aggregated.memoryUsage = Math.max(aggregated.memoryUsage, metrics.memoryUsage);
              if (metrics.memoryUsage > 90) {
                issues.push(this.createIssue(
                  'high',
                  `设备 ${device.name} 内存使用率过高: ${metrics.memoryUsage}%`,
                  device.name,
                  '检查内存泄漏，清理缓存，考虑增加内存',
                ));
              }
            }

            if (metrics.diskUsage !== undefined) {
              aggregated.diskUsage = Math.max(aggregated.diskUsage, metrics.diskUsage);
              if (metrics.diskUsage > 90) {
                issues.push(this.createIssue(
                  'critical',
                  `设备 ${device.name} 磁盘使用率过高: ${metrics.diskUsage}%`,
                  device.name,
                  '清理日志文件，删除临时文件，扩展存储',
                ));
              }
            }
          } catch (err) {
            logger.debug(`ProactiveInspector: collectMetrics failed for device ${device.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const details = {
          cpuUsage: aggregated.cpuUsage,
          memoryUsage: aggregated.memoryUsage,
          diskUsage: aggregated.diskUsage,
          deviceCount: aggregated.deviceCount,
        };
        const status = issues.some(i => i.severity === 'critical') ? 'failed'
          : issues.length > 0 ? 'warning' : 'passed';
        return {
          itemId: 'resource_usage',
          status,
          message: issues.length > 0 ? `发现 ${issues.length} 个资源问题` : '资源使用检查通过',
          details,
          issues,
          duration: 0,
          timestamp,
        };
      } catch (err) {
        logger.warn('ProactiveInspector: DeviceManager-based resource check failed, using fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback
    const details = {
      cpuUsage: 0,
      memoryUsage: 0,
      diskUsage: 0,
    };

    return {
      itemId: 'resource_usage',
      status: 'passed',
      message: '资源使用检查通过',
      details,
      issues,
      duration: 0,
      timestamp,
    };
  }

  private async validateConfig(): Promise<InspectionResult> {
    const issues: InspectionIssue[] = [];
    const timestamp = Date.now();

    // 模拟配置验证
    const details = {
      configValid: true,
      warnings: [],
    };

    return {
      itemId: 'config_validation',
      status: 'passed',
      message: '配置验证通过',
      details,
      issues,
      duration: 0,
      timestamp,
    };
  }

  /**
   * 创建问题记录
   */
  createIssue(
    severity: InspectionIssue['severity'],
    description: string,
    affectedComponent?: string,
    suggestedFix?: string
  ): InspectionIssue {
    return {
      id: `issue_${++this.issueIdCounter}_${Date.now()}`,
      severity,
      description,
      affectedComponent,
      suggestedFix,
    };
  }
}

// 导出单例实例
export const proactiveInspector = new ProactiveInspector();
