/**
 * HealthReportService 健康报告服务
 * 负责生成系统健康报告
 *
 * Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10
 * - 4.3: 健康报告包含 CPU、内存、磁盘使用率统计
 * - 4.4: 健康报告包含各接口流量统计和趋势
 * - 4.5: 健康报告包含最近告警事件汇总
 * - 4.6: 调用 AI 服务分析数据并生成风险评估
 * - 4.7: 包含 AI 生成的优化建议
 * - 4.8: 健康报告生成完成时通过配置的渠道发送报告
 * - 4.9: 支持导出为 Markdown 和 PDF 格式
 * - 4.10: 提供报告列表和详情查看功能
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  HealthReport,
  IHealthReportService,
  AlertSeverity,
  HealthStatus,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { metricsCollector } from './metricsCollector';
import { alertEngine } from './alertEngine';
import { configSnapshotService } from './configSnapshotService';
import { notificationService } from './notificationService';
import { scheduler } from './scheduler';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');


/**
 * 存储的系统指标数据点
 */
interface StoredSystemMetrics {
  timestamp: number;
  metrics: {
    cpu: { usage: number };
    memory: { total: number; used: number; free: number; usage: number };
    disk: { total: number; used: number; free: number; usage: number };
    uptime: number;
  };
}

/**
 * 存储的接口指标数据点
 */
interface StoredInterfaceMetrics {
  timestamp: number;
  interfaces: Array<{
    name: string;
    status: 'up' | 'down';
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    rxErrors: number;
    txErrors: number;
  }>;
}

export class HealthReportService implements IHealthReportService {
  private initialized = false;

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(REPORTS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create reports directory:', error);
    }
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureDataDir();
    this.initialized = true;
    logger.info('HealthReportService initialized');
  }

  /**
   * 获取报告文件路径
   */
  private getReportFilePath(id: string): string {
    return path.join(REPORTS_DIR, `${id}.json`);
  }


  /**
   * 计算指标统计（平均值、最大值、最小值）
   */
  private calculateMetricStats(values: number[]): { avg: number; max: number; min: number } {
    if (values.length === 0) {
      return { avg: 0, max: 0, min: 0 };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = Math.round((sum / values.length) * 100) / 100;
    const max = Math.max(...values);
    const min = Math.min(...values);

    return { avg, max, min };
  }

  /**
   * 计算健康评分
   * 基于 CPU、内存、磁盘使用率和告警数量
   */
  private calculateHealthScore(
    metrics: HealthReport['metrics'],
    alertsTotal: number
  ): number {
    let score = 100;

    // CPU 使用率扣分（超过 80% 开始扣分）
    if (metrics.cpu.avg > 80) {
      score -= Math.min(20, (metrics.cpu.avg - 80) * 1);
    }
    if (metrics.cpu.max > 95) {
      score -= 10;
    }

    // 内存使用率扣分（超过 80% 开始扣分）
    if (metrics.memory.avg > 80) {
      score -= Math.min(20, (metrics.memory.avg - 80) * 1);
    }
    if (metrics.memory.max > 95) {
      score -= 10;
    }

    // 磁盘使用率扣分（超过 80% 开始扣分）
    if (metrics.disk.avg > 80) {
      score -= Math.min(15, (metrics.disk.avg - 80) * 0.75);
    }
    if (metrics.disk.max > 95) {
      score -= 10;
    }

    // 告警数量扣分
    score -= Math.min(25, alertsTotal * 2);

    return Math.max(0, Math.round(score));
  }

  /**
   * 确定健康状态
   */
  private determineHealthStatus(score: number): HealthStatus {
    if (score >= 80) {
      return 'healthy';
    } else if (score >= 50) {
      return 'warning';
    } else {
      return 'critical';
    }
  }


  /**
   * 聚合系统指标数据
   */
  private async aggregateSystemMetrics(
    from: number,
    to: number,
    deviceId?: string
  ): Promise<HealthReport['metrics']> {
    const cpuValues: number[] = [];
    const memoryValues: number[] = [];
    const diskValues: number[] = [];

    try {
      // 获取系统指标历史数据
      const systemHistory = await metricsCollector.getSystemMetricsHistory(from, to, deviceId);

      logger.info(`Aggregating system metrics from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`);
      logger.info(`Found ${systemHistory.length} metric records in time range`);

      for (const entry of systemHistory) {
        cpuValues.push(entry.metrics.cpu.usage);
        memoryValues.push(entry.metrics.memory.usage);
        diskValues.push(entry.metrics.disk.usage);
      }

      if (systemHistory.length > 0) {
        logger.info(`Sample metrics - CPU: ${cpuValues[0]}%, Memory: ${memoryValues[0]}%, Disk: ${diskValues[0]}%`);
        logger.info(`Aggregated values - CPU count: ${cpuValues.length}, Memory count: ${memoryValues.length}, Disk count: ${diskValues.length}`);
      } else {
        logger.warn(`No metrics data found in time range ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`);
      }
    } catch (error) {
      logger.warn('Failed to get system metrics history:', error);
    }

    const result = {
      cpu: this.calculateMetricStats(cpuValues),
      memory: this.calculateMetricStats(memoryValues),
      disk: this.calculateMetricStats(diskValues),
    };

    logger.info(`Final aggregated metrics - CPU: avg=${result.cpu.avg}, Memory: avg=${result.memory.avg}, Disk: avg=${result.disk.avg}`);

    return result;
  }

  /**
   * 聚合接口流量统计
   */
  private async aggregateInterfaceStats(
    from: number,
    to: number,
    deviceId?: string
  ): Promise<HealthReport['interfaces']> {
    const interfaceData: Map<string, {
      rxBytes: number[];
      txBytes: number[];
      downtime: number;
      lastStatus: 'up' | 'down';
      lastTimestamp: number;
    }> = new Map();

    try {
      // 获取接口指标历史数据
      const interfaceHistory = await metricsCollector.getInterfaceMetricsHistory(from, to, deviceId);

      for (const entry of interfaceHistory) {
        for (const iface of entry.interfaces) {
          let data = interfaceData.get(iface.name);
          if (!data) {
            data = {
              rxBytes: [],
              txBytes: [],
              downtime: 0,
              lastStatus: iface.status,
              lastTimestamp: entry.timestamp,
            };
            interfaceData.set(iface.name, data);
          }

          data.rxBytes.push(iface.rxBytes);
          data.txBytes.push(iface.txBytes);

          // 计算停机时间
          if (data.lastStatus === 'up' && iface.status === 'down') {
            // 接口从 up 变为 down
            data.lastTimestamp = entry.timestamp;
          } else if (data.lastStatus === 'down' && iface.status === 'up') {
            // 接口从 down 变为 up，累加停机时间
            data.downtime += entry.timestamp - data.lastTimestamp;
          } else if (iface.status === 'down') {
            // 持续 down 状态
            data.downtime += entry.timestamp - data.lastTimestamp;
            data.lastTimestamp = entry.timestamp;
          }

          data.lastStatus = iface.status;
        }
      }
    } catch (error) {
      logger.warn('Failed to get interface metrics history:', error);
    }

    // 计算每个接口的平均流量速率
    const duration = (to - from) / 1000; // 秒
    const result: HealthReport['interfaces'] = [];

    for (const [name, data] of interfaceData) {
      // 计算流量差值（最后一个值减去第一个值）
      const rxDiff = data.rxBytes.length > 1
        ? data.rxBytes[data.rxBytes.length - 1] - data.rxBytes[0]
        : 0;
      const txDiff = data.txBytes.length > 1
        ? data.txBytes[data.txBytes.length - 1] - data.txBytes[0]
        : 0;

      result.push({
        name,
        avgRxRate: duration > 0 ? Math.round(rxDiff / duration) : 0, // bytes/s
        avgTxRate: duration > 0 ? Math.round(txDiff / duration) : 0, // bytes/s
        downtime: Math.round(data.downtime / 1000), // 秒
      });
    }

    return result;
  }


  /**
   * 聚合告警事件统计
   */
  private async aggregateAlertStats(
    from: number,
    to: number,
    deviceId?: string
  ): Promise<HealthReport['alerts']> {
    const bySeverity: Record<AlertSeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
      emergency: 0,
    };
    const ruleCount: Map<string, number> = new Map();

    try {
      // 需要在 alertEngine 中也支持 deviceId 过滤，或者在此过滤
      const alertHistory = await alertEngine.getAlertHistory(from, to);
      const filteredAlerts = deviceId
        ? alertHistory.filter(a => a.deviceId === deviceId)
        : alertHistory;

      for (const event of filteredAlerts) {
        // 按严重级别统计
        bySeverity[event.severity]++;

        // 按规则统计
        const count = ruleCount.get(event.ruleName) || 0;
        ruleCount.set(event.ruleName, count + 1);
      }
    } catch (error) {
      logger.warn('Failed to get alert history:', error);
    }

    // 获取触发次数最多的规则
    const topRules = Array.from(ruleCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ruleName, count]) => ({ ruleName, count }));

    const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);

    return {
      total,
      bySeverity,
      topRules,
    };
  }

  /**
   * 获取配置变更数量
   */
  private async getConfigChangesCount(from: number, to: number, deviceId?: string): Promise<number> {
    try {
      const snapshots = await configSnapshotService.getSnapshots();
      // 统计在时间范围内创建且设备 ID 匹配的快照数量
      const count = snapshots.filter(
        (s) => s.timestamp >= from && s.timestamp <= to && (!deviceId || s.deviceId === deviceId)
      ).length;
      // 配置变更数量 = 快照数量 - 1（第一个快照不算变更）
      return Math.max(0, count - 1);
    } catch (error) {
      logger.warn('Failed to get config snapshots:', error);
      return 0;
    }
  }

  /**
   * 生成 AI 分析（基础实现，后续集成 AIAnalyzer）
   */
  private generateAIAnalysis(
    metrics: HealthReport['metrics'],
    alerts: HealthReport['alerts'],
    interfaces: HealthReport['interfaces']
  ): HealthReport['aiAnalysis'] {
    const risks: string[] = [];
    const recommendations: string[] = [];
    const trends: string[] = [];

    // 分析 CPU 使用率
    if (metrics.cpu.avg > 80) {
      risks.push('CPU 使用率较高，可能影响系统性能');
      recommendations.push('建议检查高 CPU 占用的进程，考虑优化或升级硬件');
    } else if (metrics.cpu.avg > 60) {
      trends.push('CPU 使用率处于中等水平，建议持续监控');
    } else {
      trends.push('CPU 使用率正常');
    }

    // 分析内存使用率
    if (metrics.memory.avg > 85) {
      risks.push('内存使用率过高，可能导致系统不稳定');
      recommendations.push('建议清理不必要的缓存或增加内存');
    } else if (metrics.memory.avg > 70) {
      trends.push('内存使用率处于中等水平');
    } else {
      trends.push('内存使用率正常');
    }

    // 分析磁盘使用率
    if (metrics.disk.avg > 90) {
      risks.push('磁盘空间严重不足');
      recommendations.push('建议立即清理磁盘空间或扩展存储');
    } else if (metrics.disk.avg > 80) {
      risks.push('磁盘空间不足');
      recommendations.push('建议清理日志文件和临时文件');
    } else {
      trends.push('磁盘空间充足');
    }

    // 分析告警情况
    if (alerts.bySeverity.emergency > 0) {
      risks.push(`存在 ${alerts.bySeverity.emergency} 个紧急告警需要立即处理`);
      recommendations.push('建议优先处理紧急告警');
    }
    if (alerts.bySeverity.critical > 0) {
      risks.push(`存在 ${alerts.bySeverity.critical} 个严重告警`);
      recommendations.push('建议尽快处理严重告警');
    }
    if (alerts.total > 10) {
      trends.push('告警数量较多，建议优化告警规则或解决根本问题');
    } else if (alerts.total > 0) {
      trends.push(`报告期间共触发 ${alerts.total} 次告警`);
    } else {
      trends.push('报告期间无告警触发');
    }

    // 分析接口状态
    const downInterfaces = interfaces.filter((i) => i.downtime > 60);
    if (downInterfaces.length > 0) {
      risks.push(`${downInterfaces.length} 个接口存在停机时间`);
      recommendations.push('建议检查网络连接和接口配置');
    }

    // 如果没有风险，添加正面评价
    if (risks.length === 0) {
      trends.push('系统运行状态良好，无明显风险');
    }

    // 如果没有建议，添加通用建议
    if (recommendations.length === 0) {
      recommendations.push('建议继续保持当前配置，定期检查系统状态');
    }

    return { risks, recommendations, trends };
  }


  // ==================== 报告生成 ====================

  /**
   * 生成健康报告
   */
  async generateReport(from: number, to: number, deviceId?: string): Promise<HealthReport> {
    await this.initialize();

    logger.info(`Generating health report for period: ${new Date(from).toISOString()} - ${new Date(to).toISOString()}${deviceId ? ` for device ${deviceId}` : ''}`);

    // 获取设备名称
    let deviceName: string | undefined;
    if (deviceId) {
      try {
        const { serviceRegistry } = await import('../serviceRegistry');
        const deviceManager = serviceRegistry.get('deviceManager') as any; // Temporary any cast to avoid circular dep issues if types not exported
        // 尝试获取设备信息 (假设默认租户)
        const device = await deviceManager.getDevice('default', deviceId);
        if (device) {
          deviceName = device.name;
        }
      } catch (error) {
        logger.warn(`Failed to fetch device name for report: ${error}`);
      }
    }

    // 聚合系统指标
    const metrics = await this.aggregateSystemMetrics(from, to, deviceId);

    // 聚合接口统计
    const interfaces = await this.aggregateInterfaceStats(from, to, deviceId);

    // 聚合告警统计
    const alerts = await this.aggregateAlertStats(from, to, deviceId);

    // 获取配置变更数量
    const configChanges = await this.getConfigChangesCount(from, to, deviceId);

    // 计算健康评分
    const score = this.calculateHealthScore(metrics, alerts.total);
    const overallHealth = this.determineHealthStatus(score);

    // 生成 AI 分析
    const aiAnalysis = this.generateAIAnalysis(metrics, alerts, interfaces);

    // 创建报告
    const report: HealthReport = {
      id: uuidv4(),
      generatedAt: Date.now(),
      period: { from, to },
      deviceId, // 注入设备 ID
      deviceName, // 注入设备名称
      summary: {
        overallHealth,
        score,
      },
      metrics,
      interfaces,
      alerts,
      configChanges,
      aiAnalysis,
    };

    // 保存报告
    await this.saveReport(report);

    // 记录审计日志
    const { auditLogger } = await import('./auditLogger');
    await auditLogger.log({
      action: 'script_execute',
      actor: 'system',
      details: {
        trigger: 'report_generate',
        result: 'success',
        metadata: {
          reportId: report.id,
          periodFrom: from,
          periodTo: to,
          score: report.summary.score,
          status: report.summary.overallHealth,
        },
      },
    });

    logger.info(`Health report generated: ${report.id} (score: ${score}, status: ${overallHealth})`);
    return report;
  }

  /**
   * 保存报告
   */
  private async saveReport(report: HealthReport): Promise<void> {
    await this.ensureDataDir();
    const filePath = this.getReportFilePath(report.id);
    await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
  }

  // ==================== 报告管理 ====================

  /**
   * 获取报告列表
   */
  async getReports(limit?: number, deviceId?: string): Promise<HealthReport[]> {
    await this.initialize();

    try {
      const files = await fs.readdir(REPORTS_DIR);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const reports: HealthReport[] = [];

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(REPORTS_DIR, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const report = JSON.parse(data) as HealthReport;

          if (deviceId && report.deviceId && report.deviceId !== deviceId) {
            continue;
          }

          reports.push(report);
        } catch (error) {
          logger.warn(`Failed to read report file ${file}:`, error);
        }
      }

      // 按生成时间降序排序
      reports.sort((a, b) => b.generatedAt - a.generatedAt);

      // 应用限制
      if (limit && limit > 0) {
        return reports.slice(0, limit);
      }

      return reports;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error('Failed to list reports:', error);
      return [];
    }
  }

  /**
   * 根据 ID 获取报告
   */
  async getReportById(id: string): Promise<HealthReport | null> {
    await this.initialize();

    const filePath = this.getReportFilePath(id);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as HealthReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.error(`Failed to read report ${id}:`, error);
      return null;
    }
  }

  /**
   * 删除报告
   */
  async deleteReport(id: string): Promise<void> {
    await this.initialize();

    // 先获取报告信息用于审计日志
    const report = await this.getReportById(id);

    const filePath = this.getReportFilePath(id);
    try {
      await fs.unlink(filePath);

      // 记录审计日志
      if (report) {
        const { auditLogger } = await import('./auditLogger');
        await auditLogger.log({
          action: 'config_change',
          actor: 'user',
          details: {
            trigger: 'report_delete',
            metadata: {
              reportId: id,
              reportGeneratedAt: report.generatedAt,
              reportScore: report.summary.score,
              reportStatus: report.summary.overallHealth,
            },
          },
        });
      }

      logger.info(`Deleted health report: ${id}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }


  // ==================== 报告导出 ====================

  /**
   * 导出为 Markdown 格式
   */
  async exportAsMarkdown(id: string): Promise<string> {
    const report = await this.getReportById(id);
    if (!report) {
      throw new Error(`Report not found: ${id}`);
    }

    const healthStatusEmoji: Record<HealthStatus, string> = {
      healthy: '✅',
      warning: '⚠️',
      critical: '🔴',
    };

    const severityEmoji: Record<AlertSeverity, string> = {
      info: 'ℹ️',
      warning: '⚠️',
      critical: '🔴',
      emergency: '🚨',
    };

    const formatDate = (timestamp: number): string => {
      return new Date(timestamp).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    };

    const formatBytes = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B/s`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB/s`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB/s`;
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
    };

    const formatDuration = (seconds: number): string => {
      if (seconds < 60) return `${seconds} 秒`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
      return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
    };

    let markdown = `# 系统健康报告

## 报告概要

- **报告 ID**: ${report.id}
- **生成时间**: ${formatDate(report.generatedAt)}
- **报告周期**: ${formatDate(report.period.from)} - ${formatDate(report.period.to)}
- **健康状态**: ${healthStatusEmoji[report.summary.overallHealth]} ${report.summary.overallHealth.toUpperCase()}
- **健康评分**: ${report.summary.score}/100

---

## 系统资源使用情况

### CPU 使用率
| 指标 | 值 |
|------|-----|
| 平均值 | ${report.metrics.cpu.avg}% |
| 最大值 | ${report.metrics.cpu.max}% |
| 最小值 | ${report.metrics.cpu.min}% |

### 内存使用率
| 指标 | 值 |
|------|-----|
| 平均值 | ${report.metrics.memory.avg}% |
| 最大值 | ${report.metrics.memory.max}% |
| 最小值 | ${report.metrics.memory.min}% |

### 磁盘使用率
| 指标 | 值 |
|------|-----|
| 平均值 | ${report.metrics.disk.avg}% |
| 最大值 | ${report.metrics.disk.max}% |
| 最小值 | ${report.metrics.disk.min}% |

---

## 接口流量统计

`;

    if (report.interfaces.length > 0) {
      markdown += `| 接口名称 | 平均接收速率 | 平均发送速率 | 停机时间 |
|----------|--------------|--------------|----------|
`;
      for (const iface of report.interfaces) {
        markdown += `| ${iface.name} | ${formatBytes(iface.avgRxRate)} | ${formatBytes(iface.avgTxRate)} | ${formatDuration(iface.downtime)} |
`;
      }
    } else {
      markdown += `*无接口数据*
`;
    }

    markdown += `
---

## 告警事件汇总

- **告警总数**: ${report.alerts.total}
- **配置变更次数**: ${report.configChanges}

### 按严重级别分布

| 级别 | 数量 |
|------|------|
| ${severityEmoji.emergency} 紧急 | ${report.alerts.bySeverity.emergency} |
| ${severityEmoji.critical} 严重 | ${report.alerts.bySeverity.critical} |
| ${severityEmoji.warning} 警告 | ${report.alerts.bySeverity.warning} |
| ${severityEmoji.info} 信息 | ${report.alerts.bySeverity.info} |

`;

    if (report.alerts.topRules.length > 0) {
      markdown += `### 触发最多的告警规则

| 规则名称 | 触发次数 |
|----------|----------|
`;
      for (const rule of report.alerts.topRules) {
        markdown += `| ${rule.ruleName} | ${rule.count} |
`;
      }
    }

    markdown += `
---

## AI 分析与建议

### 风险评估

`;

    if (report.aiAnalysis.risks.length > 0) {
      for (const risk of report.aiAnalysis.risks) {
        markdown += `- ⚠️ ${risk}
`;
      }
    } else {
      markdown += `- ✅ 未发现明显风险
`;
    }

    markdown += `
### 优化建议

`;

    for (const rec of report.aiAnalysis.recommendations) {
      markdown += `- 💡 ${rec}
`;
    }

    markdown += `
### 趋势分析

`;

    for (const trend of report.aiAnalysis.trends) {
      markdown += `- 📊 ${trend}
`;
    }

    markdown += `
---

*此报告由 AI-Ops 智能运维系统自动生成*
`;

    return markdown;
  }


  /**
   * 导出为 PDF 格式
   * 注意：PDF 生成需要额外的库（如 puppeteer 或 pdfkit）
   * 这里提供基础实现，将 Markdown 转换为简单的 PDF 格式
   */
  async exportAsPdf(id: string): Promise<Buffer> {
    const report = await this.getReportById(id);
    if (!report) {
      throw new Error(`Report not found: ${id}`);
    }

    // 获取 Markdown 内容
    const markdown = await this.exportAsMarkdown(id);

    // 简单的 PDF 生成（使用纯文本格式）
    // 实际生产环境应使用 puppeteer 或 pdfkit 生成真正的 PDF
    // 这里返回一个包含报告内容的简单文本 Buffer

    // 移除 Markdown 格式符号，生成纯文本
    const plainText = markdown
      .replace(/#{1,6}\s/g, '') // 移除标题标记
      .replace(/\*\*/g, '') // 移除粗体标记
      .replace(/\|/g, ' | ') // 格式化表格
      .replace(/---+/g, '─'.repeat(50)) // 替换分隔线
      .replace(/- /g, '• ') // 替换列表标记
      .replace(/✅|⚠️|🔴|🚨|ℹ️|💡|📊/g, '') // 移除 emoji（PDF 可能不支持）
      .trim();

    // 添加 PDF 头部信息（简化版）
    const pdfContent = `
================================================================================
                           系统健康报告
================================================================================

报告 ID: ${report.id}
生成时间: ${new Date(report.generatedAt).toLocaleString('zh-CN')}
健康评分: ${report.summary.score}/100
健康状态: ${report.summary.overallHealth.toUpperCase()}

================================================================================

${plainText}

================================================================================
                    此报告由 AI-Ops 智能运维系统自动生成
================================================================================
`;

    return Buffer.from(pdfContent, 'utf-8');
  }

  // ==================== 清理功能 ====================

  /**
   * 清理过期报告
   */
  async cleanupReports(retentionDays: number = 90): Promise<number> {
    await this.initialize();

    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const reports = await this.getReports();
    let deletedCount = 0;

    for (const report of reports) {
      if (report.generatedAt < cutoffTime) {
        try {
          await this.deleteReport(report.id);
          deletedCount++;
        } catch (error) {
          logger.warn(`Failed to delete old report ${report.id}:`, error);
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} old health reports`);
    }

    return deletedCount;
  }

  // ==================== 调度器集成 ====================

  /**
   * 注册调度器任务处理器
   * 用于定时生成健康报告
   */
  registerSchedulerHandler(): void {
    scheduler.registerHandler('inspection', async (task) => {
      // 获取报告周期配置
      const config = task.config as { periodHours?: number; channelIds?: string[] } | undefined;
      const periodHours = config?.periodHours || 24; // 默认 24 小时
      const channelIds = config?.channelIds || [];

      const to = Date.now();
      const from = to - periodHours * 60 * 60 * 1000;

      // 生成报告
      const report = await this.generateReport(from, to);

      // 如果配置了通知渠道，发送报告
      if (channelIds.length > 0) {
        await this.sendReportNotification(report, channelIds);
      }

      return {
        reportId: report.id,
        score: report.summary.score,
        status: report.summary.overallHealth,
      };
    });

    logger.info('Registered health report handler for scheduler');
  }

  // ==================== 通知集成 ====================

  /**
   * 发送报告通知
   */
  async sendReportNotification(report: HealthReport, channelIds: string[]): Promise<void> {
    if (channelIds.length === 0) {
      logger.debug('No notification channels configured for report');
      return;
    }

    const healthStatusEmoji: Record<HealthStatus, string> = {
      healthy: '✅',
      warning: '⚠️',
      critical: '🔴',
    };

    const formatDate = (timestamp: number): string => {
      return new Date(timestamp).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    };

    const title = `${healthStatusEmoji[report.summary.overallHealth]} 系统健康报告 - 评分: ${report.summary.score}/100`;

    let body = `报告周期: ${formatDate(report.period.from)} - ${formatDate(report.period.to)}\n\n`;
    body += `健康状态: ${report.summary.overallHealth.toUpperCase()}\n`;
    body += `健康评分: ${report.summary.score}/100\n\n`;
    body += `资源使用:\n`;
    body += `- CPU: 平均 ${report.metrics.cpu.avg}%, 最高 ${report.metrics.cpu.max}%\n`;
    body += `- 内存: 平均 ${report.metrics.memory.avg}%, 最高 ${report.metrics.memory.max}%\n`;
    body += `- 磁盘: 平均 ${report.metrics.disk.avg}%, 最高 ${report.metrics.disk.max}%\n\n`;
    body += `告警统计: 共 ${report.alerts.total} 次\n`;

    if (report.aiAnalysis.risks.length > 0) {
      body += `\n风险提示:\n`;
      for (const risk of report.aiAnalysis.risks.slice(0, 3)) {
        body += `- ${risk}\n`;
      }
    }

    try {
      await notificationService.send(channelIds, {
        type: 'report',
        title,
        body,
        data: {
          reportId: report.id,
          score: report.summary.score,
          status: report.summary.overallHealth,
          period: report.period,
        },
      });
      logger.info(`Report notification sent for report: ${report.id}`);
    } catch (error) {
      logger.error(`Failed to send report notification for ${report.id}:`, error);
    }
  }

  /**
   * 生成并发送报告
   * 便捷方法，用于手动触发报告生成并发送
   */
  async generateAndSendReport(
    from: number,
    to: number,
    channelIds: string[],
    deviceId?: string
  ): Promise<HealthReport> {
    const report = await this.generateReport(from, to, deviceId);

    if (channelIds.length > 0) {
      await this.sendReportNotification(report, channelIds);
    }

    return report;
  }
}

// 导出单例实例
export const healthReportService = new HealthReportService();
