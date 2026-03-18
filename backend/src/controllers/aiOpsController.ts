/**
 * AI-Ops Controller
 * 处理 AI-Ops 智能运维相关的 API 请求
 *
 * 功能：
 * - 指标采集管理
 * - 告警规则和事件管理
 * - 调度器任务管理
 * - 配置快照管理
 * - 健康报告管理
 * - 故障模式管理
 * - 通知渠道管理
 * - 审计日志查询
 * - 运维仪表盘数据
 * - 并行执行指标 (Requirements: 7.4, 7.5)
 *
 * Requirements: 1.1-10.6
 */

import { Request, Response } from 'express';
import {
  metricsCollector,
  alertEngine,
  scheduler,
  configSnapshotService,
  healthReportService,
  faultHealer,
  notificationService,
  auditLogger,
} from '../services/ai-ops';
import { parallelExecutionMetrics } from '../services/ai-ops/rag/parallelExecutionMetrics';
import { AuditAction } from '../types/ai-ops';
import { logger } from '../utils/logger';

// ==================== 指标相关 ====================

/**
 * 获取最新指标
 * GET /api/ai-ops/metrics/latest
 */
export async function getLatestMetrics(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const metrics = await metricsCollector.getLatest(deviceId as string);
    res.json({ success: true, data: metrics });
  } catch (error) {
    logger.error('Failed to get latest metrics:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取最新指标失败',
    });
  }
}

/**
 * 获取历史指标
 * GET /api/ai-ops/metrics/history
 */
export async function getMetricsHistory(req: Request, res: Response): Promise<void> {
  try {
    const { metric, from, to } = req.query;

    if (!metric || !from || !to) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：metric, from, to',
      });
      return;
    }

    const history = await metricsCollector.getHistory(
      metric as string,
      parseInt(from as string, 10),
      parseInt(to as string, 10)
    );
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get metrics history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取历史指标失败',
    });
  }
}

/**
 * 获取接口流量历史
 * GET /api/ai-ops/metrics/traffic
 */
export async function getTrafficHistory(req: Request, res: Response): Promise<void> {
  try {
    const { interface: interfaceName, interfaces, deviceId, duration } = req.query;
    const durationMs = duration ? parseInt(duration as string, 10) : 3600000; // 默认 1 小时

    let targetInterfaces: string[] | undefined;
    if (interfaces) {
      targetInterfaces = (interfaces as string).split(',');
    } else if (interfaceName) {
      targetInterfaces = [interfaceName as string];
    }

    const history = metricsCollector.getTrafficHistory(targetInterfaces, deviceId as string, durationMs);
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get traffic history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取流量历史失败',
    });
  }
}

/**
 * 获取可用的流量接口列表
 * GET /api/ai-ops/metrics/traffic/interfaces
 */
export async function getTrafficInterfaces(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const interfaces = metricsCollector.getAvailableTrafficInterfaces(deviceId as string);
    res.json({ success: true, data: interfaces });
  } catch (error) {
    logger.error('Failed to get traffic interfaces:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取流量接口列表失败',
    });
  }
}

/**
 * 获取流量采集状态
 * GET /api/ai-ops/metrics/traffic/status
 */
export async function getTrafficCollectionStatus(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const status = metricsCollector.getTrafficCollectionStatus(deviceId as string);
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get traffic collection status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取流量采集状态失败',
    });
  }
}

/**
 * 获取采集配置
 * GET /api/ai-ops/metrics/config
 */
export async function getMetricsConfig(_req: Request, res: Response): Promise<void> {
  try {
    const config = metricsCollector.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get metrics config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取采集配置失败',
    });
  }
}

/**
 * 更新采集配置
 * PUT /api/ai-ops/metrics/config
 */
export async function updateMetricsConfig(req: Request, res: Response): Promise<void> {
  try {
    const config = await metricsCollector.saveConfig(req.body);
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to update metrics config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新采集配置失败',
    });
  }
}

/**
 * 获取速率计算配置
 * GET /api/ai-ops/metrics/rate-config
 * Requirements: 6.5 - 支持配置速率计算的平滑窗口大小
 */
export async function getRateCalculationConfig(_req: Request, res: Response): Promise<void> {
  try {
    const config = metricsCollector.getRateCalculationConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get rate calculation config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取速率计算配置失败',
    });
  }
}

/**
 * 更新速率计算配置
 * PUT /api/ai-ops/metrics/rate-config
 * Requirements: 6.5 - 支持配置速率计算的平滑窗口大小
 */
export async function updateRateCalculationConfig(req: Request, res: Response): Promise<void> {
  try {
    const { smoothingWindowSize, maxValidRate, counterBits } = req.body as {
      smoothingWindowSize?: number;
      maxValidRate?: number;
      counterBits?: number;
    };

    // 验证参数
    if (smoothingWindowSize !== undefined && (smoothingWindowSize < 1 || smoothingWindowSize > 100)) {
      res.status(400).json({
        success: false,
        error: '平滑窗口大小必须在 1-100 之间',
      });
      return;
    }

    if (maxValidRate !== undefined && maxValidRate <= 0) {
      res.status(400).json({
        success: false,
        error: '最大有效速率必须大于 0',
      });
      return;
    }

    if (counterBits !== undefined && counterBits !== 32 && counterBits !== 64) {
      res.status(400).json({
        success: false,
        error: '计数器位数必须是 32 或 64',
      });
      return;
    }

    metricsCollector.setRateCalculationConfig(req.body);
    const config = metricsCollector.getRateCalculationConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to update rate calculation config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新速率计算配置失败',
    });
  }
}

/**
 * 获取接口速率统计信息
 * GET /api/ai-ops/metrics/rate-statistics/:interfaceName/:direction
 * Requirements: 6.4 - 用于异常值检测
 */
export async function getRateStatistics(req: Request, res: Response): Promise<void> {
  try {
    const { interfaceName, direction } = req.params;

    if (direction !== 'rx' && direction !== 'tx') {
      res.status(400).json({
        success: false,
        error: '方向必须是 rx 或 tx',
      });
      return;
    }

    const statistics = metricsCollector.getRateStatistics(interfaceName, direction as 'rx' | 'tx');

    if (!statistics) {
      res.status(404).json({
        success: false,
        error: `没有找到接口 ${interfaceName} 的 ${direction} 速率统计数据`,
      });
      return;
    }

    res.json({ success: true, data: statistics });
  } catch (error) {
    logger.error('Failed to get rate statistics:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取速率统计失败',
    });
  }
}

/**
 * 获取流量历史（带数据可用性状态）
 * GET /api/ai-ops/traffic/history-with-status
 * Requirements: 6.2 - 返回明确的状态指示
 */
export async function getTrafficHistoryWithStatus(req: Request, res: Response): Promise<void> {
  try {
    const { interfaceName, duration } = req.query;
    const durationMs = duration ? parseInt(duration as string, 10) : 3600000;

    if (interfaceName) {
      // 获取单个接口的流量历史（带状态）
      const result = metricsCollector.getTrafficHistoryWithStatus(interfaceName as string, durationMs);
      res.json({ success: true, data: result });
    } else {
      // 获取所有接口的流量历史（带状态）
      const result = metricsCollector.getAllTrafficHistoryWithStatus(durationMs);
      res.json({ success: true, data: result });
    }
  } catch (error) {
    logger.error('Failed to get traffic history with status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取流量历史失败',
    });
  }
}

/**
 * 立即采集指标
 * POST /api/ai-ops/metrics/collect
 */
export async function collectMetricsNow(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    // 优先从认证信息中获取 tenantId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const tenantId = (req as any).tenantId || req.query.tenantId;

    if (!deviceId) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：deviceId',
      });
      return;
    }

    const metrics = await metricsCollector.collectNow(deviceId as string, tenantId as string);
    res.json({ success: true, data: metrics });
  } catch (error) {
    logger.error('Failed to collect metrics:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '采集指标失败',
    });
  }
}

/**
 * 获取并行执行指标
 * GET /api/ai-ops/metrics/parallel-execution
 * Requirements: 7.4, 7.5 - 暴露并行执行指标到 API
 */
export async function getParallelExecutionMetrics(req: Request, res: Response): Promise<void> {
  try {
    const { from, to, verbose } = req.query;

    // 解析时间范围
    const fromTs = from ? parseInt(from as string, 10) : undefined;
    const toTs = to ? parseInt(to as string, 10) : undefined;

    // 获取聚合指标
    const aggregated = parallelExecutionMetrics.getAggregatedMetrics(fromTs, toTs);

    // 根据 verbose 参数决定是否返回详细数据
    if (verbose === 'true') {
      const exported = parallelExecutionMetrics.exportMetrics();
      res.json({
        success: true,
        data: {
          aggregated: exported.aggregated,
          recent: exported.recent,
          accuracy: exported.accuracy,
        },
      });
    } else {
      res.json({
        success: true,
        data: { aggregated },
      });
    }
  } catch (error) {
    logger.error('Failed to get parallel execution metrics:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取并行执行指标失败',
    });
  }
}


// ==================== 告警规则相关 ====================

/**
 * 获取告警规则列表
 * GET /api/ai-ops/alerts/rules
 */
export async function getAlertRules(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    // deviceId is optional, if not provided, return all rules
    const rules = await alertEngine.getRules(deviceId as string);
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error('Failed to get alert rules:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取告警规则失败',
    });
  }
}

/**
 * 获取单个告警规则
 * GET /api/ai-ops/alerts/rules/:id
 */
export async function getAlertRuleById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const rule = await alertEngine.getRuleById(id);

    if (!rule) {
      res.status(404).json({ success: false, error: '告警规则不存在' });
      return;
    }

    res.json({ success: true, data: rule });
  } catch (error) {
    logger.error('Failed to get alert rule:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取告警规则失败',
    });
  }
}

/**
 * 创建告警规则
 * POST /api/ai-ops/alerts/rules
 */
export async function createAlertRule(req: Request, res: Response): Promise<void> {
  try {
    const rule = await alertEngine.createRule(req.body);
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    logger.error('Failed to create alert rule:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建告警规则失败',
    });
  }
}

/**
 * 更新告警规则
 * PUT /api/ai-ops/alerts/rules/:id
 */
export async function updateAlertRule(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const rule = await alertEngine.updateRule(id, req.body);
    res.json({ success: true, data: rule });
  } catch (error) {
    logger.error('Failed to update alert rule:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新告警规则失败',
    });
  }
}

/**
 * 删除告警规则
 * DELETE /api/ai-ops/alerts/rules/:id
 */
export async function deleteAlertRule(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await alertEngine.deleteRule(id);
    res.json({ success: true, message: '告警规则已删除' });
  } catch (error) {
    logger.error('Failed to delete alert rule:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除告警规则失败',
    });
  }
}

/**
 * 启用告警规则
 * POST /api/ai-ops/alerts/rules/:id/enable
 */
export async function enableAlertRule(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await alertEngine.enableRule(id);
    res.json({ success: true, message: '告警规则已启用' });
  } catch (error) {
    logger.error('Failed to enable alert rule:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '启用告警规则失败',
    });
  }
}

/**
 * 禁用告警规则
 * POST /api/ai-ops/alerts/rules/:id/disable
 */
export async function disableAlertRule(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await alertEngine.disableRule(id);
    res.json({ success: true, message: '告警规则已禁用' });
  } catch (error) {
    logger.error('Failed to disable alert rule:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '禁用告警规则失败',
    });
  }
}


// ==================== 告警事件相关 ====================

/**
 * 获取告警事件列表
 * GET /api/ai-ops/alerts/events
 * 
 * Requirements: 4.1, 4.2, 4.3
 * Requirements: syslog-alert-integration 7.1, 7.2 - 支持 source 参数过滤
 * 
 * Query Parameters:
 * - from: 开始时间戳 (必填)
 * - to: 结束时间戳 (必填)
 * - page: 页码 (可选，默认 1)
 * - pageSize: 每页数量 (可选，默认 20)
 * - source: 来源过滤 (可选，'all' | 'metrics' | 'syslog'，默认 'all')
 */
export async function getAlertEvents(req: Request, res: Response): Promise<void> {
  try {
    const { from, to, page, pageSize, source, deviceId } = req.query;

    if (!from || !to) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：from, to',
      });
      return;
    }

    const fromTs = parseInt(from as string, 10);
    const toTs = parseInt(to as string, 10);
    const sourceFilter = (source as string) || 'all';

    // 如果提供了分页参数，使用分页查询
    if (page || pageSize) {
      const pageNum = page ? parseInt(page as string, 10) : 1;
      const pageSizeNum = pageSize ? parseInt(pageSize as string, 10) : 20;

      // 修复：先获取所有事件，过滤后再分页
      // 原来的实现是先分页再过滤，导致 total 和 totalPages 计算错误
      const allEvents = await alertEngine.getAlertHistory(fromTs, toTs, deviceId as string);

      // 根据 source 过滤 (Requirements: syslog-alert-integration 7.2)
      let filteredEvents = allEvents;
      if (sourceFilter === 'metrics') {
        filteredEvents = allEvents.filter(e => !e.source || e.source === 'metrics');
      } else if (sourceFilter === 'syslog') {
        filteredEvents = allEvents.filter(e => e.source === 'syslog');
      }

      // 计算正确的分页信息
      const total = filteredEvents.length;
      const totalPages = Math.ceil(total / pageSizeNum);
      const start = (pageNum - 1) * pageSizeNum;
      const items = filteredEvents.slice(start, start + pageSizeNum);

      res.json({
        success: true,
        data: {
          items,
          total,
          page: pageNum,
          pageSize: pageSizeNum,
          totalPages,
        },
      });
    } else {
      // 兼容旧的非分页查询
      const events = await alertEngine.getAlertHistory(fromTs, toTs, deviceId as string);

      // 根据 source 过滤
      let filteredEvents = events;
      if (sourceFilter === 'metrics') {
        filteredEvents = events.filter(e => !e.source || e.source === 'metrics');
      } else if (sourceFilter === 'syslog') {
        filteredEvents = events.filter(e => e.source === 'syslog');
      }

      res.json({ success: true, data: filteredEvents });
    }
  } catch (error) {
    logger.error('Failed to get alert events:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取告警事件失败',
    });
  }
}

/**
 * 获取活跃告警
 * GET /api/ai-ops/alerts/events/active
 */
export async function getActiveAlerts(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const events = await alertEngine.getActiveAlerts(deviceId as string);
    res.json({ success: true, data: events });
  } catch (error) {
    logger.error('Failed to get active alerts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取活跃告警失败',
    });
  }
}

/**
 * 获取合并事件（AlertEvent + SyslogEvent）
 * GET /api/ai-ops/alerts/events/unified
 * 
 * Requirements: syslog-alert-integration 7.1, 7.2
 * 改造后：Syslog 事件已经存储在 AlertEvent 中，通过 source 字段区分
 * includeSyslog 参数现在用于过滤是否包含 syslog 来源的事件
 * source 参数用于按来源过滤：'metrics' | 'syslog' | undefined (全部)
 */
export async function getUnifiedEvents(req: Request, res: Response): Promise<void> {
  try {
    const { from, to, page, pageSize, includeSyslog, source, deviceId, severity, status } = req.query;

    if (!from || !to) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：from, to',
      });
      return;
    }

    const fromTs = parseInt(from as string, 10);
    const toTs = parseInt(to as string, 10);
    const shouldIncludeSyslog = includeSyslog !== 'false'; // 默认包含 syslog
    const sourceFilter = source as 'metrics' | 'syslog' | undefined;
    const severityFilter = severity as string | undefined;
    const statusFilter = status as string | undefined;

    const pageNum = page ? parseInt(page as string, 10) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize as string, 10) : 20;

    // 获取所有 AlertEvent（包含 metrics 和 syslog 来源）
    const alertResult = await alertEngine.getAlertHistoryPaginated(
      fromTs,
      toTs,
      1,
      10000,
      deviceId as string
    );

    let allEvents: Array<{
      id: string;
      type: 'alert' | 'syslog';
      severity: string;
      message: string;
      timestamp: number;
      status: string;
      category?: string;
      ruleName?: string;
      ruleId?: string;
      metric?: string;
      metricLabel?: string;
      currentValue?: number;
      threshold?: number;
      resolvedAt?: number;
      rawData?: unknown;
      metadata?: unknown;
      source?: string;
      syslogData?: unknown;
    }> = [];

    // 转换 AlertEvent，根据 source 字段区分类型
    for (const event of alertResult.items) {
      const isSyslogEvent = event.source === 'syslog';

      // 如果不包含 syslog 且是 syslog 事件，跳过
      if (!shouldIncludeSyslog && isSyslogEvent) {
        continue;
      }

      // 按 source 参数过滤
      if (sourceFilter) {
        if (sourceFilter === 'syslog' && !isSyslogEvent) {
          continue;
        }
        if (sourceFilter === 'metrics' && isSyslogEvent) {
          continue;
        }
      }

      // 按 severity 参数过滤
      if (severityFilter && event.severity !== severityFilter) {
        continue;
      }

      // 按 status 参数过滤
      if (statusFilter && event.status !== statusFilter) {
        continue;
      }

      allEvents.push({
        id: event.id,
        type: isSyslogEvent ? 'syslog' : 'alert',
        severity: event.severity,
        message: event.message,
        timestamp: event.triggeredAt,
        status: event.status,
        ruleName: event.ruleName,
        ruleId: event.ruleId,
        metric: event.metric,
        metricLabel: event.metricLabel,
        currentValue: event.currentValue,
        threshold: event.threshold,
        resolvedAt: event.resolvedAt,
        // Syslog 特有字段
        category: isSyslogEvent ? event.syslogData?.category : undefined,
        metadata: isSyslogEvent ? {
          hostname: event.syslogData?.hostname,
          facility: event.syslogData?.facility,
          syslogSeverity: event.syslogData?.syslogSeverity,
        } : undefined,
        source: event.source,
        syslogData: event.syslogData,
      });
    }

    // Syslog 事件已经在 AlertEvent 中，不再需要单独获取
    // Requirements: syslog-alert-integration 1.2, 7.1

    // 按时间倒序排序
    allEvents.sort((a, b) => b.timestamp - a.timestamp);

    // 分页
    const total = allEvents.length;
    const totalPages = Math.ceil(total / pageSizeNum);
    const startIndex = (pageNum - 1) * pageSizeNum;
    const endIndex = startIndex + pageSizeNum;
    const paginatedEvents = allEvents.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        items: paginatedEvents,
        total,
        page: pageNum,
        pageSize: pageSizeNum,
        totalPages,
      },
    });
  } catch (error) {
    logger.error('Failed to get unified events:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取合并事件失败',
    });
  }
}

/**
 * 获取活跃的合并事件（AlertEvent + SyslogEvent）
 * GET /api/ai-ops/alerts/events/unified/active
 * 
 * Requirements: syslog-alert-integration 7.1, 7.2
 * 改造后：Syslog 事件已经存储在 AlertEvent 中，通过 source 字段区分
 * source 参数用于按来源过滤：'metrics' | 'syslog' | undefined (全部)
 */
export async function getActiveUnifiedEvents(req: Request, res: Response): Promise<void> {
  try {
    const { includeSyslog, source, deviceId } = req.query;
    const shouldIncludeSyslog = includeSyslog !== 'false';
    const sourceFilter = source as 'metrics' | 'syslog' | undefined;

    // 获取活跃的 AlertEvent（包含 metrics 和 syslog 来源）
    const activeAlerts = await alertEngine.getActiveAlerts(deviceId as string);

    let allEvents: Array<{
      id: string;
      type: 'alert' | 'syslog';
      severity: string;
      message: string;
      timestamp: number;
      status: string;
      category?: string;
      ruleName?: string;
      ruleId?: string;
      metric?: string;
      metricLabel?: string;
      currentValue?: number;
      threshold?: number;
      resolvedAt?: number;
      rawData?: unknown;
      metadata?: unknown;
      aiAnalysis?: string;
      autoResponseResult?: unknown;
      source?: string;
      syslogData?: unknown;
    }> = [];

    // 转换 AlertEvent，根据 source 字段区分类型
    for (const event of activeAlerts) {
      const isSyslogEvent = event.source === 'syslog';

      // 如果不包含 syslog 且是 syslog 事件，跳过
      if (!shouldIncludeSyslog && isSyslogEvent) {
        continue;
      }

      // 按 source 参数过滤
      if (sourceFilter) {
        if (sourceFilter === 'syslog' && !isSyslogEvent) {
          continue;
        }
        if (sourceFilter === 'metrics' && isSyslogEvent) {
          continue;
        }
      }

      allEvents.push({
        id: event.id,
        type: isSyslogEvent ? 'syslog' : 'alert',
        severity: event.severity,
        message: event.message,
        timestamp: event.triggeredAt,
        status: event.status,
        ruleName: event.ruleName,
        ruleId: event.ruleId,
        metric: event.metric,
        metricLabel: event.metricLabel,
        currentValue: event.currentValue,
        threshold: event.threshold,
        resolvedAt: event.resolvedAt,
        aiAnalysis: event.aiAnalysis,
        autoResponseResult: event.autoResponseResult,
        // Syslog 特有字段
        category: isSyslogEvent ? event.syslogData?.category : undefined,
        metadata: isSyslogEvent ? {
          hostname: event.syslogData?.hostname,
          facility: event.syslogData?.facility,
          syslogSeverity: event.syslogData?.syslogSeverity,
        } : undefined,
        source: event.source,
        syslogData: event.syslogData,
      });
    }

    // Syslog 事件已经在 AlertEvent 中，不再需要单独获取
    // Requirements: syslog-alert-integration 1.2, 7.1

    // 按时间倒序排序
    allEvents.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ success: true, data: allEvents });
  } catch (error) {
    logger.error('Failed to get active unified events:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取活跃合并事件失败',
    });
  }
}

/**
 * 获取单个告警事件
 * GET /api/ai-ops/alerts/events/:id
 */
export async function getAlertEventById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const event = await alertEngine.getAlertEventById(id);

    if (!event) {
      res.status(404).json({ success: false, error: '告警事件不存在' });
      return;
    }

    res.json({ success: true, data: event });
  } catch (error) {
    logger.error('Failed to get alert event:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取告警事件失败',
    });
  }
}

/**
 * 解决告警
 * POST /api/ai-ops/alerts/events/:id/resolve
 */
export async function resolveAlertEvent(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await alertEngine.resolveAlert(id);
    res.json({ success: true, message: '告警已解决' });
  } catch (error) {
    logger.error('Failed to resolve alert:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '解决告警失败',
    });
  }
}

/**
 * 删除告警事件
 * DELETE /api/ai-ops/alerts/events/:id
 * Requirements: 4.5, 4.7
 */
export async function deleteAlertEvent(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await alertEngine.deleteAlertEvent(id);
    res.json({ success: true, message: '告警事件已删除' });
  } catch (error) {
    logger.error('Failed to delete alert event:', error);
    const errorMessage = error instanceof Error ? error.message : '删除告警事件失败';
    const status = errorMessage.includes('不存在') ? 404 :
      errorMessage.includes('活跃') ? 400 : 500;
    res.status(status).json({
      success: false,
      error: errorMessage,
    });
  }
}

/**
 * 批量删除告警事件
 * POST /api/ai-ops/alerts/events/batch-delete
 * Requirements: 4.6, 4.7
 */
export async function batchDeleteAlertEvents(req: Request, res: Response): Promise<void> {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：ids（告警事件ID数组）',
      });
      return;
    }

    const result = await alertEngine.deleteAlertEvents(ids);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to batch delete alert events:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '批量删除告警事件失败',
    });
  }
}

// ==================== 调度器相关 ====================

/**
 * 获取任务列表
 * GET /api/ai-ops/scheduler/tasks
 */
export async function getSchedulerTasks(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const tasks = await scheduler.getTasks(deviceId as string);
    res.json({ success: true, data: tasks });
  } catch (error) {
    logger.error('Failed to get scheduler tasks:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取任务列表失败',
    });
  }
}

/**
 * 获取单个任务
 * GET /api/ai-ops/scheduler/tasks/:id
 */
export async function getSchedulerTaskById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const task = await scheduler.getTaskById(id);

    if (!task) {
      res.status(404).json({ success: false, error: '任务不存在' });
      return;
    }

    res.json({ success: true, data: task });
  } catch (error) {
    logger.error('Failed to get scheduler task:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取任务失败',
    });
  }
}

/**
 * 创建任务
 * POST /api/ai-ops/scheduler/tasks
 */
export async function createSchedulerTask(req: Request, res: Response): Promise<void> {
  try {
    // Extract tenantId from authenticated request
    const tenantId = (req as any).tenantId;
    // Extract deviceId from query or body (if applicable for the task)
    const deviceId = (req.query.deviceId || req.body.deviceId) as string | undefined;

    if (!tenantId) {
      res.status(401).json({ success: false, error: 'Unauthorized: Missing tenant context' });
      return;
    }

    const taskData = {
      ...req.body,
      tenant_id: tenantId,
      device_id: deviceId || null,
    };

    const task = await scheduler.createTask(taskData);
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    logger.error('Failed to create scheduler task:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建任务失败',
    });
  }
}

/**
 * 更新任务
 * PUT /api/ai-ops/scheduler/tasks/:id
 */
export async function updateSchedulerTask(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const task = await scheduler.updateTask(id, req.body);
    res.json({ success: true, data: task });
  } catch (error) {
    logger.error('Failed to update scheduler task:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新任务失败',
    });
  }
}

/**
 * 删除任务
 * DELETE /api/ai-ops/scheduler/tasks/:id
 */
export async function deleteSchedulerTask(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await scheduler.deleteTask(id);
    res.json({ success: true, message: '任务已删除' });
  } catch (error) {
    logger.error('Failed to delete scheduler task:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除任务失败',
    });
  }
}

/**
 * 立即执行任务
 * POST /api/ai-ops/scheduler/tasks/:id/run
 */
export async function runSchedulerTaskNow(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { deviceId } = req.query;
    // 强制校验 deviceId 确保任务在正确设备执行
    if (!deviceId) {
      res.status(400).json({ success: false, error: '缺少必填属性：deviceId' });
      return;
    }
    const execution = await scheduler.runTaskNow(id, deviceId as string);
    res.json({ success: true, data: execution });
  } catch (error) {
    logger.error('Failed to run scheduler task:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '执行任务失败',
    });
  }
}

/**
 * 获取执行历史
 * GET /api/ai-ops/scheduler/executions
 */
export async function getSchedulerExecutions(req: Request, res: Response): Promise<void> {
  try {
    const { taskId, limit } = req.query;
    const executions = await scheduler.getExecutions(
      taskId as string | undefined,
      limit ? parseInt(limit as string, 10) : undefined
    );
    res.json({ success: true, data: executions });
  } catch (error) {
    logger.error('Failed to get scheduler executions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取执行历史失败',
    });
  }
}


// ==================== 配置快照相关 ====================

/**
 * 获取快照列表
 * GET /api/ai-ops/snapshots
 */
export async function getSnapshots(req: Request, res: Response): Promise<void> {
  try {
    const { limit, deviceId } = req.query;
    const snapshots = await configSnapshotService.getSnapshots(
      limit ? parseInt(limit as string, 10) : undefined,
      deviceId as string
    );
    res.json({ success: true, data: snapshots });
  } catch (error) {
    logger.error('Failed to get snapshots:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取快照列表失败',
    });
  }
}

/**
 * 获取单个快照
 * GET /api/ai-ops/snapshots/:id
 */
export async function getSnapshotById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const snapshot = await configSnapshotService.getSnapshotById(id);

    if (!snapshot) {
      res.status(404).json({ success: false, error: '快照不存在' });
      return;
    }

    res.json({ success: true, data: snapshot });
  } catch (error) {
    logger.error('Failed to get snapshot:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取快照失败',
    });
  }
}

/**
 * 创建快照
 * POST /api/ai-ops/snapshots
 */
export async function createSnapshot(req: Request, res: Response): Promise<void> {
  try {
    const deviceId = (req.params.deviceId || req.query.deviceId || req.body.deviceId) as string;
    // 尝试从认证用户信息中获取 tenantId，如果没有则尝试从 query/body 获取
    const tenantId = (req as any).tenantId || req.query.tenantId || req.body.tenantId as string;

    const snapshot = await configSnapshotService.createSnapshot('manual', tenantId, deviceId);
    res.status(201).json({ success: true, data: snapshot });
  } catch (error) {
    logger.error('Failed to create snapshot:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建快照失败',
    });
  }
}

/**
 * 删除快照
 * DELETE /api/ai-ops/snapshots/:id
 */
export async function deleteSnapshot(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await configSnapshotService.deleteSnapshot(id);
    res.json({ success: true, message: '快照已删除' });
  } catch (error) {
    logger.error('Failed to delete snapshot:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除快照失败',
    });
  }
}

/**
 * 下载快照
 * GET /api/ai-ops/snapshots/:id/download
 */
export async function downloadSnapshot(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const content = await configSnapshotService.downloadSnapshot(id);
    const snapshot = await configSnapshotService.getSnapshotById(id);

    const filename = snapshot
      ? `config_${new Date(snapshot.timestamp).toISOString().replace(/[:.]/g, '-')}.rsc`
      : `config_${id}.rsc`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (error) {
    logger.error('Failed to download snapshot:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '下载快照失败',
    });
  }
}

/**
 * 恢复快照
 * POST /api/ai-ops/snapshots/:id/restore
 */
export async function restoreSnapshot(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const result = await configSnapshotService.restoreSnapshot(id);
    res.json({ success: result.success, message: result.message });
  } catch (error) {
    logger.error('Failed to restore snapshot:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '恢复快照失败',
    });
  }
}

/**
 * 对比快照
 * GET /api/ai-ops/snapshots/diff
 */
export async function compareSnapshots(req: Request, res: Response): Promise<void> {
  try {
    const { idA, idB } = req.query;

    if (!idA || !idB) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：idA, idB',
      });
      return;
    }

    const diff = await configSnapshotService.compareSnapshots(
      idA as string,
      idB as string
    );
    const analyzedDiff = await configSnapshotService.analyzeConfigDiff(diff);
    res.json({ success: true, data: analyzedDiff });
  } catch (error) {
    logger.error('Failed to compare snapshots:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '对比快照失败',
    });
  }
}

/**
 * 获取最新差异
 * GET /api/ai-ops/snapshots/diff/latest
 */
export async function getLatestDiff(_req: Request, res: Response): Promise<void> {
  try {
    const diff = await configSnapshotService.getLatestDiff();
    if (diff) {
      const analyzedDiff = await configSnapshotService.analyzeConfigDiff(diff);
      res.json({ success: true, data: analyzedDiff });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (error) {
    logger.error('Failed to get latest diff:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取最新差异失败',
    });
  }
}

/**
 * 获取变更时间线
 * GET /api/ai-ops/snapshots/timeline
 */
export async function getChangeTimeline(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query;
    const timeline = await configSnapshotService.getChangeTimeline(
      limit ? parseInt(limit as string, 10) : undefined
    );
    res.json({ success: true, data: timeline });
  } catch (error) {
    logger.error('Failed to get change timeline:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取变更时间线失败',
    });
  }
}


// ==================== 健康报告相关 ====================

/**
 * 获取报告列表
 * GET /api/ai-ops/reports
 */
export async function getReports(req: Request, res: Response): Promise<void> {
  try {
    const { limit, deviceId } = req.query;
    const reports = await healthReportService.getReports(
      limit ? parseInt(limit as string, 10) : undefined,
      deviceId as string
    );
    res.json({ success: true, data: reports });
  } catch (error) {
    logger.error('Failed to get reports:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取报告列表失败',
    });
  }
}

/**
 * 获取单个报告
 * GET /api/ai-ops/reports/:id
 */
export async function getReportById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const report = await healthReportService.getReportById(id);

    if (!report) {
      res.status(404).json({ success: false, error: '报告不存在' });
      return;
    }

    res.json({ success: true, data: report });
  } catch (error) {
    logger.error('Failed to get report:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取报告失败',
    });
  }
}

/**
 * 生成报告
 * POST /api/ai-ops/reports/generate
 */
export async function generateReport(req: Request, res: Response): Promise<void> {
  try {
    const { from, to, channelIds, deviceId } = req.body;

    if (!from || !to) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：from, to',
      });
      return;
    }

    let report;
    if (channelIds && channelIds.length > 0) {
      report = await healthReportService.generateAndSendReport(from, to, channelIds, deviceId);
    } else {
      report = await healthReportService.generateReport(from, to, deviceId);
    }

    res.status(201).json({ success: true, data: report });
  } catch (error) {
    logger.error('Failed to generate report:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '生成报告失败',
    });
  }
}

/**
 * 导出报告
 * GET /api/ai-ops/reports/:id/export
 */
export async function exportReport(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { format } = req.query;

    const report = await healthReportService.getReportById(id);
    if (!report) {
      res.status(404).json({ success: false, error: '报告不存在' });
      return;
    }

    if (format === 'pdf') {
      const pdf = await healthReportService.exportAsPdf(id);
      const filename = `health_report_${new Date(report.generatedAt).toISOString().split('T')[0]}.txt`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdf);
    } else {
      // 默认 Markdown 格式
      const markdown = await healthReportService.exportAsMarkdown(id);
      const filename = `health_report_${new Date(report.generatedAt).toISOString().split('T')[0]}.md`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(markdown);
    }
  } catch (error) {
    logger.error('Failed to export report:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '导出报告失败',
    });
  }
}

/**
 * 删除报告
 * DELETE /api/ai-ops/reports/:id
 */
export async function deleteReport(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await healthReportService.deleteReport(id);
    res.json({ success: true, message: '报告已删除' });
  } catch (error) {
    logger.error('Failed to delete report:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '删除报告失败',
    });
  }
}


// ==================== 故障模式相关 ====================

/**
 * 获取故障模式列表
 * GET /api/ai-ops/patterns
 */
export async function getFaultPatterns(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const patterns = await faultHealer.getPatterns(undefined, deviceId as string);
    res.json({ success: true, data: patterns });
  } catch (error) {
    logger.error('Failed to get fault patterns:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取故障模式失败',
    });
  }
}

/**
 * 获取单个故障模式
 * GET /api/ai-ops/patterns/:id
 */
export async function getFaultPatternById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const pattern = await faultHealer.getPatternById(id);

    if (!pattern) {
      res.status(404).json({ success: false, error: '故障模式不存在' });
      return;
    }

    res.json({ success: true, data: pattern });
  } catch (error) {
    logger.error('Failed to get fault pattern:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取故障模式失败',
    });
  }
}

/**
 * 创建故障模式
 * POST /api/ai-ops/patterns
 */
export async function createFaultPattern(req: Request, res: Response): Promise<void> {
  try {
    const pattern = await faultHealer.createPattern(req.body);
    res.status(201).json({ success: true, data: pattern });
  } catch (error) {
    logger.error('Failed to create fault pattern:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建故障模式失败',
    });
  }
}

/**
 * 更新故障模式
 * PUT /api/ai-ops/patterns/:id
 */
export async function updateFaultPattern(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const pattern = await faultHealer.updatePattern(id, req.body);
    res.json({ success: true, data: pattern });
  } catch (error) {
    logger.error('Failed to update fault pattern:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新故障模式失败',
    });
  }
}

/**
 * 删除故障模式
 * DELETE /api/ai-ops/patterns/:id
 */
export async function deleteFaultPattern(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await faultHealer.deletePattern(id);
    res.json({ success: true, message: '故障模式已删除' });
  } catch (error) {
    logger.error('Failed to delete fault pattern:', error);
    const status = (error as Error).message.includes('not found') ||
      (error as Error).message.includes('builtin') ? 400 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除故障模式失败',
    });
  }
}

/**
 * 启用自动修复
 * POST /api/ai-ops/patterns/:id/enable-auto-heal
 */
export async function enableAutoHeal(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await faultHealer.enableAutoHeal(id);
    res.json({ success: true, message: '自动修复已启用' });
  } catch (error) {
    logger.error('Failed to enable auto-heal:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '启用自动修复失败',
    });
  }
}

/**
 * 禁用自动修复
 * POST /api/ai-ops/patterns/:id/disable-auto-heal
 */
export async function disableAutoHeal(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await faultHealer.disableAutoHeal(id);
    res.json({ success: true, message: '自动修复已禁用' });
  } catch (error) {
    logger.error('Failed to disable auto-heal:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '禁用自动修复失败',
    });
  }
}

/**
 * 获取修复历史
 * GET /api/ai-ops/remediations
 */
export async function getRemediations(req: Request, res: Response): Promise<void> {
  try {
    const { limit, deviceId } = req.query;
    const remediations = await faultHealer.getRemediationHistory(
      limit ? parseInt(limit as string, 10) : undefined,
      deviceId as string
    );
    res.json({ success: true, data: remediations });
  } catch (error) {
    logger.error('Failed to get remediations:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取修复历史失败',
    });
  }
}

/**
 * 获取单个修复记录
 * GET /api/ai-ops/remediations/:id
 */
export async function getRemediationById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const remediation = await faultHealer.getRemediationById(id);

    if (!remediation) {
      res.status(404).json({ success: false, error: '修复记录不存在' });
      return;
    }

    res.json({ success: true, data: remediation });
  } catch (error) {
    logger.error('Failed to get remediation:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取修复记录失败',
    });
  }
}

/**
 * 手动执行修复
 * POST /api/ai-ops/patterns/:id/execute
 */
export async function executeFaultRemediation(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { alertEventId } = req.body;

    if (!alertEventId) {
      res.status(400).json({
        success: false,
        error: '缺少必填参数：alertEventId',
      });
      return;
    }

    const remediation = await faultHealer.executeRemediation(id, alertEventId);
    res.json({ success: true, data: remediation });
  } catch (error) {
    logger.error('Failed to execute remediation:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '执行修复失败',
    });
  }
}


// ==================== 通知渠道相关 ====================

/**
 * 获取渠道列表
 * GET /api/ai-ops/channels
 */
export async function getNotificationChannels(_req: Request, res: Response): Promise<void> {
  try {
    const channels = await notificationService.getChannels();
    res.json({ success: true, data: channels });
  } catch (error) {
    logger.error('Failed to get notification channels:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取通知渠道失败',
    });
  }
}

/**
 * 获取单个渠道
 * GET /api/ai-ops/channels/:id
 */
export async function getNotificationChannelById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const channel = await notificationService.getChannelById(id);

    if (!channel) {
      res.status(404).json({ success: false, error: '通知渠道不存在' });
      return;
    }

    res.json({ success: true, data: channel });
  } catch (error) {
    logger.error('Failed to get notification channel:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取通知渠道失败',
    });
  }
}

/**
 * 创建渠道
 * POST /api/ai-ops/channels
 */
export async function createNotificationChannel(req: Request, res: Response): Promise<void> {
  try {
    const channel = await notificationService.createChannel(req.body);
    res.status(201).json({ success: true, data: channel });
  } catch (error) {
    logger.error('Failed to create notification channel:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建通知渠道失败',
    });
  }
}

/**
 * 更新渠道
 * PUT /api/ai-ops/channels/:id
 */
export async function updateNotificationChannel(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const channel = await notificationService.updateChannel(id, req.body);
    res.json({ success: true, data: channel });
  } catch (error) {
    logger.error('Failed to update notification channel:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新通知渠道失败',
    });
  }
}

/**
 * 删除渠道
 * DELETE /api/ai-ops/channels/:id
 */
export async function deleteNotificationChannel(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await notificationService.deleteChannel(id);
    res.json({ success: true, message: '通知渠道已删除' });
  } catch (error) {
    logger.error('Failed to delete notification channel:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除通知渠道失败',
    });
  }
}

/**
 * 测试渠道
 * POST /api/ai-ops/channels/:id/test
 */
export async function testNotificationChannel(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const result = await notificationService.testChannel(id);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to test notification channel:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '测试通知渠道失败',
    });
  }
}

/**
 * 获取 Web Push 待推送通知
 * GET /api/ai-ops/channels/:id/pending
 */
export async function getPendingNotifications(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const notifications = await notificationService.getPendingWebPushNotifications(id);
    res.json({ success: true, data: notifications });
  } catch (error) {
    logger.error('Failed to get pending notifications:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取待推送通知失败',
    });
  }
}

/**
 * 获取通知历史
 * GET /api/ai-ops/notifications/history
 */
export async function getNotificationHistory(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query;
    const history = await notificationService.getNotificationHistory(
      limit ? parseInt(limit as string, 10) : undefined
    );
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get notification history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取通知历史失败',
    });
  }
}


// ==================== 审计日志相关 ====================

/**
 * 查询审计日志
 * GET /api/ai-ops/audit
 */
export async function getAuditLogs(req: Request, res: Response): Promise<void> {
  try {
    const { action, module, from, to, limit } = req.query;

    const logs = await auditLogger.query({
      action: action as AuditAction | undefined,
      from: from ? parseInt(from as string, 10) : undefined,
      to: to ? parseInt(to as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });

    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error('Failed to get audit logs:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取审计日志失败',
    });
  }
}


// ==================== 仪表盘数据 ====================

/**
 * 获取运维仪表盘数据
 * GET /api/ai-ops/dashboard
 */
export async function getDashboardData(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;

    // 并行获取各项数据
    const [
      latestMetrics,
      activeAlerts,
      recentRemediations,
      recentReports,
      schedulerTasks,
    ] = await Promise.all([
      metricsCollector.getLatest(deviceId as string).catch(() => null),
      alertEngine.getActiveAlerts(deviceId as string).catch(() => []),
      faultHealer.getRemediationHistory(5, deviceId as string).catch(() => []),
      healthReportService.getReports(5, deviceId as string).catch(() => []),
      scheduler.getTasks(deviceId as string).catch(() => []),
    ]);

    // 计算统计数据
    const enabledTasks = schedulerTasks.filter((t: { enabled: boolean }) => t.enabled).length;
    const successfulRemediations = recentRemediations.filter(
      (r: { status: string }) => r.status === 'success'
    ).length;

    const dashboard = {
      metrics: latestMetrics,
      alerts: {
        active: activeAlerts.length,
        critical: activeAlerts.filter((a: { severity: string }) => a.severity === 'critical').length,
        warning: activeAlerts.filter((a: { severity: string }) => a.severity === 'warning').length,
        info: activeAlerts.filter((a: { severity: string }) => a.severity === 'info').length,
        list: activeAlerts.slice(0, 10),
      },
      remediations: {
        recent: recentRemediations.length,
        successful: successfulRemediations,
        list: recentRemediations,
      },
      reports: {
        recent: recentReports.length,
        list: recentReports,
      },
      scheduler: {
        total: schedulerTasks.length,
        enabled: enabledTasks,
      },
      timestamp: Date.now(),
    };

    res.json({ success: true, data: dashboard });
  } catch (error) {
    logger.error('Failed to get dashboard data:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取仪表盘数据失败',
    });
  }
}


// ==================== AI-Ops Enhancement: Syslog 相关 ====================
// Requirements: 1.1, 1.7

import {
  syslogReceiver,
  fingerprintCache,
  analysisCache,
  noiseFilter,
  rootCauseAnalyzer,
  remediationAdvisor,
  decisionEngine,
  feedbackService,
} from '../services/ai-ops';
import { chatSessionService } from '../services/ai/chatSessionService';

/**
 * 获取 Syslog 配置
 * GET /api/ai-ops/syslog/config
 * Requirements: 1.7
 */
export async function getSyslogConfig(_req: Request, res: Response): Promise<void> {
  try {
    const config = syslogReceiver.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get syslog config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Syslog 配置失败',
    });
  }
}

/**
 * 更新 Syslog 配置
 * PUT /api/ai-ops/syslog/config
 * Requirements: 1.7
 */
export async function updateSyslogConfig(req: Request, res: Response): Promise<void> {
  try {
    await syslogReceiver.updateConfig(req.body);
    const config = syslogReceiver.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to update syslog config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新 Syslog 配置失败',
    });
  }
}

/**
 * 获取 Syslog 服务状态
 * GET /api/ai-ops/syslog/status
 * Requirements: 1.1
 */
export async function getSyslogStatus(_req: Request, res: Response): Promise<void> {
  try {
    const status = syslogReceiver.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get syslog status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Syslog 状态失败',
    });
  }
}

/**
 * 获取 Syslog 事件历史
 * GET /api/ai-ops/syslog/events
 * 
 * Requirements: syslog-alert-integration 4.3, 7.3
 * 已废弃：Syslog 事件现在通过统一的告警事件 API 获取
 * 请使用 /api/ai-ops/alerts/events?source=syslog
 */
export async function getSyslogEvents(req: Request, res: Response): Promise<void> {
  try {
    const { from, to, limit } = req.query;

    // 从统一存储中获取 syslog 来源的事件
    const fromTs = from ? parseInt(from as string, 10) : Date.now() - 24 * 60 * 60 * 1000;
    const toTs = to ? parseInt(to as string, 10) : Date.now();
    const maxLimit = limit ? parseInt(limit as string, 10) : 1000;

    const result = await alertEngine.getAlertHistoryPaginated(fromTs, toTs, 1, maxLimit);

    // 过滤出 syslog 来源的事件
    const syslogEvents = result.items
      .filter(event => event.source === 'syslog')
      .map(event => ({
        id: event.id,
        source: 'syslog' as const,
        timestamp: event.triggeredAt,
        severity: event.severity,
        category: event.syslogData?.category || 'unknown',
        message: event.message,
        rawData: {
          facility: event.syslogData?.facility || 0,
          severity: event.syslogData?.syslogSeverity || 6,
          timestamp: new Date(event.triggeredAt).toISOString(),
          hostname: event.syslogData?.hostname || 'unknown',
          topic: event.syslogData?.category || 'unknown',
          message: event.message,
          raw: event.syslogData?.rawMessage || event.message,
        },
        metadata: {
          hostname: event.syslogData?.hostname || 'unknown',
          facility: event.syslogData?.facility || 0,
          syslogSeverity: event.syslogData?.syslogSeverity || 6,
        },
      }));

    res.json({
      success: true,
      data: syslogEvents,
      message: '此 API 已废弃，请使用 /api/ai-ops/alerts/events?source=syslog',
    });
  } catch (error) {
    logger.error('Failed to get syslog events:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Syslog 事件失败',
    });
  }
}

/**
 * 获取 Syslog 统计信息
 * GET /api/ai-ops/syslog/stats
 */
export async function getSyslogStats(_req: Request, res: Response): Promise<void> {
  try {
    const stats = syslogReceiver.getStats();
    const pipelineStatus = alertEngine.getPipelineStatus();

    res.json({
      success: true,
      data: {
        syslog: stats,
        pipeline: {
          active: pipelineStatus.active,
          queued: pipelineStatus.queued,
          queueUsagePercent: pipelineStatus.queueUsagePercent,
          totalProcessed: pipelineStatus.totalProcessed,
          totalDropped: pipelineStatus.totalDropped,
          totalTimedOut: pipelineStatus.totalTimedOut,
          avgProcessingTimeMs: pipelineStatus.avgProcessingTimeMs,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get syslog stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Syslog 统计失败',
    });
  }
}

/**
 * 重置 Syslog 统计信息
 * POST /api/ai-ops/syslog/stats/reset
 */
export async function resetSyslogStats(_req: Request, res: Response): Promise<void> {
  try {
    syslogReceiver.resetStats();
    res.json({ success: true, message: 'Syslog 统计已重置' });
  } catch (error) {
    logger.error('Failed to reset syslog stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '重置 Syslog 统计失败',
    });
  }
}


// ==================== AI-Ops Enhancement: 过滤器相关 ====================
// Requirements: 5.7, 5.8

/**
 * 获取维护窗口列表
 * GET /api/ai-ops/filters/maintenance
 * Requirements: 5.7
 */
export async function getMaintenanceWindows(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    await noiseFilter.initialize();
    const windows = noiseFilter.getMaintenanceWindows(deviceId as string);
    res.json({ success: true, data: windows });
  } catch (error) {
    logger.error('Failed to get maintenance windows:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取维护窗口失败',
    });
  }
}

/**
 * 创建维护窗口
 * POST /api/ai-ops/filters/maintenance
 * Requirements: 5.7
 */
export async function createMaintenanceWindow(req: Request, res: Response): Promise<void> {
  try {
    const window = await noiseFilter.createMaintenanceWindow(req.body);
    res.status(201).json({ success: true, data: window });
  } catch (error) {
    logger.error('Failed to create maintenance window:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建维护窗口失败',
    });
  }
}

/**
 * 更新维护窗口
 * PUT /api/ai-ops/filters/maintenance/:id
 * Requirements: 5.7
 */
export async function updateMaintenanceWindow(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const window = await noiseFilter.updateMaintenanceWindow(id, req.body);
    res.json({ success: true, data: window });
  } catch (error) {
    logger.error('Failed to update maintenance window:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新维护窗口失败',
    });
  }
}

/**
 * 删除维护窗口
 * DELETE /api/ai-ops/filters/maintenance/:id
 * Requirements: 5.7
 */
export async function deleteMaintenanceWindow(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    noiseFilter.removeMaintenanceWindow(id);
    res.json({ success: true, message: '维护窗口已删除' });
  } catch (error) {
    logger.error('Failed to delete maintenance window:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '删除维护窗口失败',
    });
  }
}

/**
 * 获取已知问题列表
 * GET /api/ai-ops/filters/known-issues
 * Requirements: 5.8
 */
export async function getKnownIssues(_req: Request, res: Response): Promise<void> {
  try {
    await noiseFilter.initialize();
    const issues = noiseFilter.getKnownIssues();
    res.json({ success: true, data: issues });
  } catch (error) {
    logger.error('Failed to get known issues:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取已知问题失败',
    });
  }
}

/**
 * 创建已知问题
 * POST /api/ai-ops/filters/known-issues
 * Requirements: 5.8
 */
export async function createKnownIssue(req: Request, res: Response): Promise<void> {
  try {
    const issue = await noiseFilter.createKnownIssue(req.body);
    res.status(201).json({ success: true, data: issue });
  } catch (error) {
    logger.error('Failed to create known issue:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建已知问题失败',
    });
  }
}

/**
 * 更新已知问题
 * PUT /api/ai-ops/filters/known-issues/:id
 * Requirements: 5.8
 */
export async function updateKnownIssue(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const issue = await noiseFilter.updateKnownIssue(id, req.body);
    res.json({ success: true, data: issue });
  } catch (error) {
    logger.error('Failed to update known issue:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新已知问题失败',
    });
  }
}

/**
 * 删除已知问题
 * DELETE /api/ai-ops/filters/known-issues/:id
 * Requirements: 5.8
 */
export async function deleteKnownIssue(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    noiseFilter.removeKnownIssue(id);
    res.json({ success: true, message: '已知问题已删除' });
  } catch (error) {
    logger.error('Failed to delete known issue:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '删除已知问题失败',
    });
  }
}


// ==================== AI-Ops Enhancement: 分析相关 ====================
// Requirements: 6.1, 6.2, 6.4

/**
 * 获取告警的根因分析
 * GET /api/ai-ops/analysis/:alertId
 * Requirements: 6.1
 * 
 * 优化：先检查缓存，如果已有分析结果则直接返回，避免重复调用 AI
 */
export async function getAlertAnalysis(req: Request, res: Response): Promise<void> {
  try {
    const { alertId } = req.params;

    // 首先检查是否已有缓存的分析结果
    const cachedAnalysis = await rootCauseAnalyzer.getAnalysisByAlertId(alertId);
    if (cachedAnalysis) {
      logger.info(`Returning cached analysis for alert: ${alertId}`);
      res.json({ success: true, data: cachedAnalysis });
      return;
    }

    // 获取告警事件
    const alertEvent = await alertEngine.getAlertEventById(alertId);
    if (!alertEvent) {
      res.status(404).json({ success: false, error: '告警事件不存在' });
      return;
    }

    // 转换为 UnifiedEvent 格式进行分析
    const unifiedEvent = {
      id: alertEvent.id,
      source: 'metrics' as const,
      timestamp: alertEvent.triggeredAt,
      severity: alertEvent.severity,
      category: alertEvent.metric,
      message: alertEvent.message,
      rawData: alertEvent,
      metadata: {
        ruleId: alertEvent.ruleId,
        currentValue: alertEvent.currentValue,
        threshold: alertEvent.threshold,
      },
      alertRuleInfo: {
        ruleId: alertEvent.ruleId,
        ruleName: alertEvent.ruleName,
        metric: alertEvent.metric,
        threshold: alertEvent.threshold,
        currentValue: alertEvent.currentValue,
      },
    };

    const analysis = await rootCauseAnalyzer.analyzeSingle(unifiedEvent);
    res.json({ success: true, data: analysis });
  } catch (error) {
    logger.error('Failed to get alert analysis:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取告警分析失败',
    });
  }
}

/**
 * 重新分析告警
 * POST /api/ai-ops/analysis/:alertId/refresh
 * Requirements: 6.1
 */
export async function refreshAlertAnalysis(req: Request, res: Response): Promise<void> {
  try {
    const { alertId } = req.params;

    const alertEvent = await alertEngine.getAlertEventById(alertId);
    if (!alertEvent) {
      res.status(404).json({ success: false, error: '告警事件不存在' });
      return;
    }

    const unifiedEvent = {
      id: alertEvent.id,
      source: 'metrics' as const,
      timestamp: alertEvent.triggeredAt,
      severity: alertEvent.severity,
      category: alertEvent.metric,
      message: alertEvent.message,
      rawData: alertEvent,
      metadata: {
        ruleId: alertEvent.ruleId,
        currentValue: alertEvent.currentValue,
        threshold: alertEvent.threshold,
      },
      alertRuleInfo: {
        ruleId: alertEvent.ruleId,
        ruleName: alertEvent.ruleName,
        metric: alertEvent.metric,
        threshold: alertEvent.threshold,
        currentValue: alertEvent.currentValue,
      },
    };

    // 强制重新分析
    const analysis = await rootCauseAnalyzer.analyzeSingle(unifiedEvent);
    res.json({ success: true, data: analysis });
  } catch (error) {
    logger.error('Failed to refresh alert analysis:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '重新分析告警失败',
    });
  }
}

/**
 * 获取事件时间线
 * GET /api/ai-ops/analysis/:alertId/timeline
 * Requirements: 6.4
 */
export async function getAlertTimeline(req: Request, res: Response): Promise<void> {
  try {
    const { alertId } = req.params;

    const alertEvent = await alertEngine.getAlertEventById(alertId);
    if (!alertEvent) {
      res.status(404).json({ success: false, error: '告警事件不存在' });
      return;
    }

    const analysis = await rootCauseAnalyzer.getAnalysisByAlertId(alertId);
    const timeline = analysis?.timeline || {
      events: [{
        timestamp: alertEvent.triggeredAt,
        eventId: alertEvent.id,
        description: alertEvent.message,
        type: 'trigger'
      }],
      startTime: alertEvent.triggeredAt,
      endTime: alertEvent.triggeredAt
    };

    res.json({ success: true, data: timeline });
  } catch (error) {
    logger.error('Failed to get alert timeline:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取事件时间线失败',
    });
  }
}

/**
 * 获取关联告警
 * GET /api/ai-ops/analysis/:alertId/related
 * Requirements: 6.2
 */
export async function getRelatedAlerts(req: Request, res: Response): Promise<void> {
  try {
    const { alertId } = req.params;
    const { windowMs } = req.query;

    const alertEvent = await alertEngine.getAlertEventById(alertId);
    if (!alertEvent) {
      res.status(404).json({ success: false, error: '告警事件不存在' });
      return;
    }

    // 获取时间窗口内的其他告警
    const window = windowMs ? parseInt(windowMs as string, 10) : 5 * 60 * 1000;
    const from = alertEvent.triggeredAt - window;
    const to = alertEvent.triggeredAt + window;

    const allAlerts = await alertEngine.getAlertHistory(from, to);
    const relatedAlerts = allAlerts.filter(a => a.id !== alertId);

    res.json({ success: true, data: relatedAlerts });
  } catch (error) {
    logger.error('Failed to get related alerts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取关联告警失败',
    });
  }
}


// ==================== AI-Ops Enhancement: 修复方案相关 ====================
// Requirements: 7.1, 7.4

/**
 * 获取修复方案
 * GET /api/ai-ops/remediation/:alertId
 * Requirements: 7.1
 */
export async function getRemediationPlan(req: Request, res: Response): Promise<void> {
  try {
    const { alertId } = req.params;

    // 尝试获取已有的修复方案
    const plans = await remediationAdvisor.getPlansByAlertId(alertId);

    if (plans.length > 0) {
      // 返回最新的方案
      res.json({ success: true, data: plans[0] });
    } else {
      res.json({ success: true, data: null, message: '暂无修复方案' });
    }
  } catch (error) {
    logger.error('Failed to get remediation plan:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取修复方案失败',
    });
  }
}

/**
 * 生成修复方案
 * POST /api/ai-ops/remediation/:alertId
 * Requirements: 7.1
 */
export async function generateRemediationPlan(req: Request, res: Response): Promise<void> {
  try {
    const { alertId } = req.params;

    const alertEvent = await alertEngine.getAlertEventById(alertId);
    if (!alertEvent) {
      res.status(404).json({ success: false, error: '告警事件不存在' });
      return;
    }

    // 先进行根因分析
    const unifiedEvent = {
      id: alertEvent.id,
      source: 'metrics' as const,
      timestamp: alertEvent.triggeredAt,
      severity: alertEvent.severity,
      category: alertEvent.metric,
      message: alertEvent.message,
      rawData: alertEvent,
      metadata: {},
      alertRuleInfo: {
        ruleId: alertEvent.ruleId,
        ruleName: alertEvent.ruleName,
        metric: alertEvent.metric,
        threshold: alertEvent.threshold,
        currentValue: alertEvent.currentValue,
      },
    };

    const analysis = await rootCauseAnalyzer.analyzeSingle(unifiedEvent);

    // 生成修复方案
    const plan = await remediationAdvisor.generatePlan(analysis);
    res.status(201).json({ success: true, data: plan });
  } catch (error) {
    logger.error('Failed to generate remediation plan:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '生成修复方案失败',
    });
  }
}

/**
 * 执行修复方案
 * POST /api/ai-ops/remediation/:planId/execute
 * Requirements: 7.1
 */
export async function executeRemediationPlan(req: Request, res: Response): Promise<void> {
  try {
    const { planId } = req.params;
    const { stepOrder } = req.body;

    if (stepOrder !== undefined) {
      // 执行单个步骤
      const result = await remediationAdvisor.executeStep(planId, stepOrder);
      res.json({ success: true, data: result });
    } else {
      // 执行所有自动步骤
      const results = await remediationAdvisor.executeAutoSteps(planId);
      res.json({ success: true, data: results });
    }
  } catch (error) {
    logger.error('Failed to execute remediation plan:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '执行修复方案失败',
    });
  }
}

/**
 * 执行回滚
 * POST /api/ai-ops/remediation/:planId/rollback
 * Requirements: 7.4
 */
export async function executeRemediationRollback(req: Request, res: Response): Promise<void> {
  try {
    const { planId } = req.params;
    const results = await remediationAdvisor.executeRollback(planId);
    res.json({ success: true, data: results });
  } catch (error) {
    logger.error('Failed to execute rollback:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '执行回滚失败',
    });
  }
}


// ==================== AI-Ops Enhancement: 决策相关 ====================
// Requirements: 8.8

/**
 * 获取决策规则列表
 * GET /api/ai-ops/decisions/rules
 * Requirements: 8.8
 */
export async function getDecisionRules(_req: Request, res: Response): Promise<void> {
  try {
    await decisionEngine.initialize();
    const rules = decisionEngine.getRules();
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error('Failed to get decision rules:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取决策规则失败',
    });
  }
}

/**
 * 获取单个决策规则
 * GET /api/ai-ops/decisions/rules/:id
 * Requirements: 8.8
 */
export async function getDecisionRuleById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const rule = await decisionEngine.getRuleById(id);

    if (!rule) {
      res.status(404).json({ success: false, error: '决策规则不存在' });
      return;
    }

    res.json({ success: true, data: rule });
  } catch (error) {
    logger.error('Failed to get decision rule:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取决策规则失败',
    });
  }
}

/**
 * 创建决策规则
 * POST /api/ai-ops/decisions/rules
 * Requirements: 8.8
 */
export async function createDecisionRule(req: Request, res: Response): Promise<void> {
  try {
    const rule = await decisionEngine.createRule(req.body);
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    logger.error('Failed to create decision rule:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建决策规则失败',
    });
  }
}

/**
 * 更新决策规则
 * PUT /api/ai-ops/decisions/rules/:id
 * Requirements: 8.8
 */
export async function updateDecisionRule(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const rule = await decisionEngine.updateRuleAsync(id, req.body);
    res.json({ success: true, data: rule });
  } catch (error) {
    logger.error('Failed to update decision rule:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新决策规则失败',
    });
  }
}

/**
 * 删除决策规则
 * DELETE /api/ai-ops/decisions/rules/:id
 * Requirements: 8.8
 */
export async function deleteDecisionRule(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await decisionEngine.deleteRule(id);
    res.json({ success: true, message: '决策规则已删除' });
  } catch (error) {
    logger.error('Failed to delete decision rule:', error);
    const status = (error as Error).message.includes('not found') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除决策规则失败',
    });
  }
}

/**
 * 获取决策历史
 * GET /api/ai-ops/decisions/history
 * Requirements: 8.8
 */
export async function getDecisionHistory(req: Request, res: Response): Promise<void> {
  try {
    const { alertId, limit } = req.query;
    const history = await decisionEngine.getDecisionHistory(
      alertId as string | undefined,
      limit ? parseInt(limit as string, 10) : undefined
    );
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get decision history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取决策历史失败',
    });
  }
}


// ==================== AI-Ops Enhancement: 反馈相关 ====================
// Requirements: 10.1, 10.4, 10.5, 10.6

/**
 * 提交反馈
 * POST /api/ai-ops/feedback
 * Requirements: 10.1
 */
export async function submitFeedback(req: Request, res: Response): Promise<void> {
  try {
    // Fix: 从会话中提取 usedLearningEntryIds，传递给 recordFeedback 实现反馈闭环
    // 前端提交反馈时可携带 sessionId，后端从最后一条 assistant 消息的 metadata 中提取
    let sessionContext: {
      sessionId?: string;
      usedLearningEntryIds?: string[];
    } | undefined;

    const { sessionId } = req.body;
    if (sessionId) {
      try {
        const session = await chatSessionService.getById(sessionId);
        if (session && session.messages.length > 0) {
          // 从最后一条 assistant 消息的 metadata 中提取 usedLearningEntryIds
          for (let i = session.messages.length - 1; i >= 0; i--) {
            const msg = session.messages[i];
            if (msg.role === 'assistant' && msg.metadata?.usedLearningEntryIds) {
              sessionContext = {
                sessionId,
                usedLearningEntryIds: msg.metadata.usedLearningEntryIds as string[],
              };
              break;
            }
          }
        }
      } catch (sessionError) {
        logger.warn('Failed to extract usedLearningEntryIds from session', {
          sessionId,
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
        });
      }
    }

    const feedback = await feedbackService.recordFeedback(req.body, undefined, sessionContext);
    res.status(201).json({ success: true, data: feedback });
  } catch (error) {
    logger.error('Failed to submit feedback:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '提交反馈失败',
    });
  }
}

/**
 * 获取反馈统计
 * GET /api/ai-ops/feedback/stats
 * Requirements: 10.4, 10.6
 */
export async function getFeedbackStats(req: Request, res: Response): Promise<void> {
  try {
    const { ruleId } = req.query;

    if (ruleId) {
      const stats = await feedbackService.getRuleStats(ruleId as string);
      res.json({ success: true, data: stats });
    } else {
      const stats = await feedbackService.getAllRuleStats();
      res.json({ success: true, data: stats });
    }
  } catch (error) {
    logger.error('Failed to get feedback stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取反馈统计失败',
    });
  }
}

/**
 * 获取需要审查的规则
 * GET /api/ai-ops/feedback/review
 * Requirements: 10.5, 10.6
 */
export async function getRulesNeedingReview(req: Request, res: Response): Promise<void> {
  try {
    const { threshold } = req.query;
    const rules = await feedbackService.getRulesNeedingReview(
      threshold ? parseFloat(threshold as string) : undefined
    );
    res.json({ success: true, data: rules });
  } catch (error) {
    logger.error('Failed to get rules needing review:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取需审查规则失败',
    });
  }
}


// ==================== AI-Ops Enhancement: 缓存管理相关 ====================
// Requirements: 2.5, 3.5

/**
 * 获取指纹缓存统计
 * GET /api/ai-ops/cache/fingerprint/stats
 * Requirements: 2.5
 */
export async function getFingerprintCacheStats(_req: Request, res: Response): Promise<void> {
  try {
    const stats = fingerprintCache.getStats();
    const config = fingerprintCache.getConfig();
    res.json({ success: true, data: { ...stats, config } });
  } catch (error) {
    logger.error('Failed to get fingerprint cache stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取指纹缓存统计失败',
    });
  }
}

/**
 * 清空指纹缓存
 * POST /api/ai-ops/cache/fingerprint/clear
 * Requirements: 2.5
 */
export async function clearFingerprintCache(_req: Request, res: Response): Promise<void> {
  try {
    fingerprintCache.clear();
    res.json({ success: true, message: '指纹缓存已清空' });
  } catch (error) {
    logger.error('Failed to clear fingerprint cache:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '清空指纹缓存失败',
    });
  }
}

/**
 * 获取分析缓存统计
 * GET /api/ai-ops/cache/analysis/stats
 * Requirements: 3.5
 */
export async function getAnalysisCacheStats(_req: Request, res: Response): Promise<void> {
  try {
    const stats = analysisCache.getStats();
    const config = analysisCache.getConfig();
    res.json({ success: true, data: { ...stats, config } });
  } catch (error) {
    logger.error('Failed to get analysis cache stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取分析缓存统计失败',
    });
  }
}

/**
 * 清空分析缓存
 * POST /api/ai-ops/cache/analysis/clear
 * Requirements: 3.5
 */
export async function clearAnalysisCache(_req: Request, res: Response): Promise<void> {
  try {
    analysisCache.clear();
    res.json({ success: true, message: '分析缓存已清空' });
  } catch (error) {
    logger.error('Failed to clear analysis cache:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '清空分析缓存失败',
    });
  }
}


// ==================== 服务健康检查 ====================

/**
 * 获取所有服务的健康状态
 * GET /api/ai-ops/health
 * Requirements: 5.4 - 提供服务健康状态检查接口
 */
export async function getServicesHealth(_req: Request, res: Response): Promise<void> {
  try {
    // 动态导入以避免循环依赖
    const { serviceLifecycle } = await import('../services/ai-ops/serviceLifecycle');

    const summary = serviceLifecycle.getHealthSummary();
    const healthResults = await serviceLifecycle.healthCheckAll();

    // 转换 Map 为对象
    const servicesHealth: Record<string, {
      healthy: boolean;
      message?: string;
      lastCheck: number;
      consecutiveFailures: number;
    }> = {};

    for (const [name, result] of healthResults) {
      servicesHealth[name] = result;
    }

    res.json({
      success: true,
      data: {
        summary: {
          total: summary.total,
          healthy: summary.healthy,
          unhealthy: summary.unhealthy,
        },
        services: servicesHealth,
      },
    });
  } catch (error) {
    logger.error('Failed to get services health:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取服务健康状态失败',
    });
  }
}

/**
 * 获取单个服务的健康状态
 * GET /api/ai-ops/health/:serviceName
 * Requirements: 5.4 - 提供服务健康状态检查接口
 */
export async function getServiceHealth(req: Request, res: Response): Promise<void> {
  try {
    const { serviceName } = req.params;

    // 动态导入以避免循环依赖
    const { serviceLifecycle } = await import('../services/ai-ops/serviceLifecycle');

    const result = await serviceLifecycle.healthCheck(serviceName);
    const serviceInfo = serviceLifecycle.getServiceInfo(serviceName);

    if (!serviceInfo) {
      res.status(404).json({
        success: false,
        error: `服务 ${serviceName} 不存在`,
      });
      return;
    }

    res.json({
      success: true,
      data: {
        name: serviceName,
        state: serviceInfo.state,
        category: serviceInfo.category,
        health: result,
        startedAt: serviceInfo.startedAt,
        stoppedAt: serviceInfo.stoppedAt,
        restartAttempts: serviceInfo.restartAttempts,
        lastStateChange: serviceInfo.lastStateChange,
      },
    });
  } catch (error) {
    logger.error('Failed to get service health:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取服务健康状态失败',
    });
  }
}

/**
 * 获取服务生命周期配置
 * GET /api/ai-ops/lifecycle/config
 * Requirements: 5.4 - 提供服务健康状态检查接口
 */
export async function getLifecycleConfig(_req: Request, res: Response): Promise<void> {
  try {
    // 动态导入以避免循环依赖
    const { serviceLifecycle } = await import('../services/ai-ops/serviceLifecycle');

    const config = serviceLifecycle.getConfig();
    const registeredServices = serviceLifecycle.getRegisteredServices();

    res.json({
      success: true,
      data: {
        config,
        registeredServices,
      },
    });
  } catch (error) {
    logger.error('Failed to get lifecycle config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取生命周期配置失败',
    });
  }
}


// ==================== Pipeline 状态监控 ====================

/**
 * 获取 Pipeline 并发状态
 * GET /api/ai-ops/pipeline/status
 * Requirements: 2.5 - 提供 Pipeline 并发状态监控接口
 */
export async function getPipelineStatus(_req: Request, res: Response): Promise<void> {
  try {
    const status = alertEngine.getPipelineStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get pipeline status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Pipeline 状态失败',
    });
  }
}

/**
 * 获取 Pipeline 详细并发状态
 * GET /api/ai-ops/pipeline/concurrency
 * Requirements: 2.5 - 提供 Pipeline 并发状态监控接口
 */
export async function getPipelineConcurrencyStatus(_req: Request, res: Response): Promise<void> {
  try {
    const status = alertEngine.getPipelineConcurrencyStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get pipeline concurrency status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Pipeline 并发状态失败',
    });
  }
}


// ==================== 事件缓存统计监控 ====================

/**
 * 获取事件缓存统计
 * GET /api/ai-ops/cache/events/stats
 * Requirements: 3.6 - 记录缓存命中率和淘汰统计信息
 */
export async function getEventsCacheStats(_req: Request, res: Response): Promise<void> {
  try {
    const stats = alertEngine.getCacheStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get events cache stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取事件缓存统计失败',
    });
  }
}


// ==================== Critic/Reflector 模块 ====================
// Requirements: critic-reflector 16.1-18.6, 21.5

/**
 * 获取迭代状态
 * GET /api/ai-ops/iterations/:id
 * Requirements: 16.1
 */
export async function getIterationState(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');

    const state = await iterationLoop.getState(id);
    if (!state) {
      res.status(404).json({
        success: false,
        error: '迭代不存在',
      });
      return;
    }

    res.json({ success: true, data: state });
  } catch (error) {
    logger.error('Failed to get iteration state:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取迭代状态失败',
    });
  }
}

/**
 * 列出迭代
 * GET /api/ai-ops/iterations
 * Requirements: 16.2
 */
export async function listIterations(req: Request, res: Response): Promise<void> {
  try {
    const { active, limit } = req.query;
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');

    let iterations;
    if (active === 'true') {
      iterations = await iterationLoop.listActive();
    } else {
      iterations = await iterationLoop.listRecent(limit ? parseInt(limit as string, 10) : 20);
    }

    res.json({ success: true, data: iterations });
  } catch (error) {
    logger.error('Failed to list iterations:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取迭代列表失败',
    });
  }
}

/**
 * 中止迭代
 * POST /api/ai-ops/iterations/:id/abort
 * Requirements: 16.3
 */
export async function abortIteration(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');

    await iterationLoop.abort(id, reason);

    res.json({ success: true, message: '迭代已中止' });
  } catch (error) {
    logger.error('Failed to abort iteration:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '中止迭代失败',
    });
  }
}

/**
 * 获取评估报告
 * GET /api/ai-ops/evaluations/:planId
 * Requirements: 16.4
 */
export async function getEvaluationReport(req: Request, res: Response): Promise<void> {
  try {
    const { planId } = req.params;
    const { criticService } = await import('../services/ai-ops/criticService');

    const report = await criticService.getReportByPlanId(planId);
    if (!report) {
      res.status(404).json({
        success: false,
        error: '评估报告不存在',
      });
      return;
    }

    res.json({ success: true, data: report });
  } catch (error) {
    logger.error('Failed to get evaluation report:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取评估报告失败',
    });
  }
}

/**
 * 查询学习条目
 * GET /api/ai-ops/learning
 * Requirements: 16.5
 */
export async function queryLearning(req: Request, res: Response): Promise<void> {
  try {
    const { query, pattern, limit } = req.query;
    const { reflectorService } = await import('../services/ai-ops/reflectorService');

    let entries;
    if (pattern) {
      entries = await reflectorService.searchByFailurePattern(
        pattern as string,
        limit ? parseInt(limit as string, 10) : 10
      );
    } else if (query) {
      entries = await reflectorService.queryLearning(
        query as string,
        limit ? parseInt(limit as string, 10) : 10
      );
    } else {
      // 返回最近的学习条目
      entries = await reflectorService.queryLearning(
        '',
        limit ? parseInt(limit as string, 10) : 20
      );
    }

    // 转换为前端期望的格式: { type, timestamp, title, content, ...enrichedFields }
    const formattedEntries = entries.map((entry: any) => {
      // 兼容不同来源的 contextFactors
      const factors = entry.contextFactors || entry.details?.contextFactors || {};
      const intent = factors.intent || '';
      const originalMessage = factors.originalMessage || '';

      const type = entry.effectiveSolution ? 'experience' : 'reflection';

      return {
        id: entry.id,
        type: type,
        color: type === 'experience' ? '#67C23A' : '#E6A23C', // 对应 success 和 warning 颜色
        learningType: 'learning',
        timestamp: entry.timestamp,
        title: entry.failurePattern || (type === 'experience' ? '经验记录' : '反思记录'),
        intent: intent,
        originalMessage: originalMessage,
        confidence: entry.confidence,
        iterationId: entry.iterationId,
        content: [
          entry.rootCause,
          entry.effectiveSolution ? `基础方案: ${entry.effectiveSolution}` : null,
          entry.ineffectiveApproaches?.length > 0
            ? `无效尝试: ${entry.ineffectiveApproaches.join(', ')}`
            : null,
        ].filter(Boolean).join('；'),
        details: {
          rootCause: entry.rootCause,
          effectiveSolution: entry.effectiveSolution,
          ineffectiveApproaches: entry.ineffectiveApproaches,
          contextFactors: factors
        }
      };
    });

    // 确保按时间降序排列
    formattedEntries.sort((a: any, b: any) => b.timestamp - a.timestamp);

    res.json({ success: true, data: formattedEntries });
  } catch (error) {
    logger.error('Failed to query learning:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '查询学习条目失败',
    });
  }
}

/**
 * SSE 学习事件流 - 实时推送新学习条目
 * GET /api/ai-ops/learning/stream
 */
export async function streamLearningEvents(req: Request, res: Response): Promise<void> {
  try {
    const { reflectorService } = await import('../services/ai-ops/reflectorService');

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 发送初始连接事件
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // 监听学习事件
    const onLearning = (data: any) => {
      if (!res.writableEnded) {
        res.write(`event: learning:new\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    reflectorService.events.on('learning:new', onLearning);

    // 心跳保活 — 使用数据事件格式，确保前端 EventSource 能检测到
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      }
    }, 30000);

    // 处理客户端断开
    req.on('close', () => {
      reflectorService.events.off('learning:new', onLearning);
      clearInterval(heartbeat);
      logger.debug('Learning SSE client disconnected');
    });
  } catch (error) {
    logger.error('Failed to stream learning events:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '学习事件流失败',
      });
    }
  }
}

/**
 * SSE 迭代事件流
 * GET /api/ai-ops/iterations/:id/stream
 * Requirements: 17.1-17.4
 */
export async function streamIterationEvents(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 发送初始连接事件
    res.write(`data: ${JSON.stringify({ type: 'connected', iterationId: id })}\n\n`);

    // 订阅迭代事件
    const eventStream = iterationLoop.subscribe(id);

    // 处理客户端断开连接
    req.on('close', () => {
      logger.debug(`SSE client disconnected for iteration ${id}`);
    });

    // 发送事件
    for await (const event of eventStream) {
      if (res.writableEnded) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // 发送结束事件
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
      res.end();
    }
  } catch (error) {
    logger.error('Failed to stream iteration events:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '事件流失败',
      });
    }
  }
}

/**
 * 获取 Critic 统计
 * GET /api/ai-ops/stats/critic
 * Requirements: 18.1, 18.2
 */
export async function getCriticStats(_req: Request, res: Response): Promise<void> {
  try {
    const { criticService } = await import('../services/ai-ops/criticService');
    const stats = await criticService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get critic stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Critic 统计失败',
    });
  }
}

/**
 * 获取 Reflector 统计
 * GET /api/ai-ops/stats/reflector
 * Requirements: 18.3, 18.4
 */
export async function getReflectorStats(_req: Request, res: Response): Promise<void> {
  try {
    const { reflectorService } = await import('../services/ai-ops/reflectorService');
    const stats = await reflectorService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get reflector stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取 Reflector 统计失败',
    });
  }
}

/**
 * 获取迭代统计
 * GET /api/ai-ops/stats/iterations
 * Requirements: 18.5, 18.6
 */
export async function getIterationStats(_req: Request, res: Response): Promise<void> {
  try {
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');
    const stats = await iterationLoop.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get iteration stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取迭代统计失败',
    });
  }
}

/**
 * 获取 Critic/Reflector 功能配置
 * GET /api/ai-ops/critic/config
 * Requirements: 21.5
 */
export async function getCriticReflectorConfig(_req: Request, res: Response): Promise<void> {
  try {
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');
    const config = iterationLoop.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get critic/reflector config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取配置失败',
    });
  }
}

/**
 * 更新 Critic/Reflector 功能配置
 * POST /api/ai-ops/critic/config
 * Requirements: 21.5
 */
export async function updateCriticReflectorConfig(req: Request, res: Response): Promise<void> {
  try {
    const updates = req.body;
    const { iterationLoop } = await import('../services/ai-ops/iterationLoop');

    await iterationLoop.updateConfig(updates);
    const config = iterationLoop.getConfig();

    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to update critic/reflector config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新配置失败',
    });
  }
}

// ==================== 智能进化配置管理 ====================

/**
 * 获取智能进化配置
 * GET /api/ai-ops/evolution/config
 * Requirements: evolution-frontend 1.7, 6.1, 6.2
 */
export async function getEvolutionConfig(_req: Request, res: Response): Promise<void> {
  try {
    const { getEvolutionConfig: getConfig } = await import('../services/ai-ops/evolutionConfig');
    const config = getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get evolution config:', error);
    try {
      const { DEFAULT_EVOLUTION_CONFIG } = await import('../services/ai-ops/evolutionConfig');
      res.json({ success: true, data: DEFAULT_EVOLUTION_CONFIG, fallback: true });
      return;
    } catch {
      // ignore fallback import errors
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取进化配置失败',
    });
  }
}

/**
 * 更新智能进化配置
 * PUT /api/ai-ops/evolution/config
 * Requirements: evolution-frontend 1.5, 6.2
 */
export async function updateEvolutionConfig(req: Request, res: Response): Promise<void> {
  try {
    const updates = req.body;
    const {
      updateEvolutionConfig: updateConfig,
      getEvolutionConfig: getConfig,
      validateConfig,
      saveConfigToFile
    } = await import('../services/ai-ops/evolutionConfig');

    // 验证配置
    const validation = validateConfig(updates);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: `配置验证失败: ${validation.errors.join(', ')}`,
      });
      return;
    }

    updateConfig(updates);
    const saved = saveConfigToFile();
    if (!saved) {
      res.status(500).json({
        success: false,
        error: '配置已更新但保存失败，重启后可能丢失',
      });
      return;
    }

    const config = getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to update evolution config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '更新进化配置失败',
    });
  }
}

/**
 * 获取能力状态摘要
 * GET /api/ai-ops/evolution/status
 * Requirements: evolution-frontend 6.2
 */
export async function getEvolutionStatus(_req: Request, res: Response): Promise<void> {
  try {
    const { getCapabilityStatusSummary } = await import('../services/ai-ops/evolutionConfig');
    const capabilities = getCapabilityStatusSummary();

    let systemLoad: { currentDegradationLevel: 'none' | 'moderate' | 'severe'; primaryBottleneck: string } | null = null;

    try {
      const { metricsCollector } = await import('../services/ai-ops');
      const metricsPromise = metricsCollector.getLatest();
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
      const metrics = await Promise.race([metricsPromise, timeoutPromise]);

      if (metrics && metrics.system) {
        const cpuUsage = metrics.system.cpu.usage;
        const memoryUsage = metrics.system.memory.usage;

        if (cpuUsage > 80 || memoryUsage > 85) {
          systemLoad = {
            currentDegradationLevel: 'severe',
            primaryBottleneck: cpuUsage > memoryUsage ? 'CPU 高负载' : '内存高负载'
          };
        } else if (cpuUsage > 50 || memoryUsage > 60) {
          systemLoad = {
            currentDegradationLevel: 'moderate',
            primaryBottleneck: cpuUsage > memoryUsage ? 'CPU 中等负载' : '内存中等负载'
          };
        } else {
          systemLoad = {
            currentDegradationLevel: 'none',
            primaryBottleneck: ''
          };
        }
      }
    } catch (metricsError) {
      logger.warn('Failed to get metrics for evolution status, returning without systemLoad:', metricsError);
    }

    res.json({
      success: true,
      data: {
        capabilities,
        systemLoad
      }
    });
  } catch (error) {
    logger.error('Failed to get evolution status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取能力状态失败',
    });
  }
}

/**
 * 获取工具使用统计
 * GET /api/ai-ops/evolution/tool-stats
 * Requirements: evolution-frontend 6.2
 */
export async function getToolStats(req: Request, res: Response): Promise<void> {
  try {
    const { limit } = req.query;
    const { toolFeedbackCollector } = await import('../services/ai-ops/toolFeedbackCollector');
    const rawStats = await toolFeedbackCollector.getToolStats(
      undefined,
      undefined
    );

    // 映射字段名，使前端兼容（前端使用 useCount/successRate，后端使用 totalCalls/successRate）
    const mappedStats = rawStats
      .map(s => ({
        toolName: s.toolName,
        useCount: s.totalCalls,
        successCount: s.successCount,
        successRate: s.successRate,
        avgDuration: s.avgDuration,
      }))
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, limit ? parseInt(limit as string, 10) : 20);

    res.json({ success: true, data: mappedStats });
  } catch (error) {
    logger.error('Failed to get tool stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取工具统计失败',
    });
  }
}

/**
 * 启用能力
 * POST /api/ai-ops/evolution/capability/:name/enable
 * Requirements: evolution-frontend 1.3, 6.2
 */
export async function enableEvolutionCapability(req: Request, res: Response): Promise<void> {
  try {
    const { name } = req.params;
    const {
      enableCapability,
      getEvolutionConfig: getConfig,
      saveConfigToFile
    } = await import('../services/ai-ops/evolutionConfig');

    // 验证能力名称
    type CapabilityName = 'reflection' | 'experience' | 'planRevision' | 'toolFeedback' |
      'proactiveOps' | 'intentDriven' | 'selfHealing' | 'continuousLearning' | 'tracing' | 'autonomousBrain';

    const validCapabilities: CapabilityName[] = [
      'reflection', 'experience', 'planRevision', 'toolFeedback',
      'proactiveOps', 'intentDriven', 'selfHealing', 'continuousLearning', 'tracing', 'autonomousBrain'
    ];

    if (!validCapabilities.includes(name as CapabilityName)) {
      res.status(400).json({
        success: false,
        error: `无效的能力名称: ${name}`,
      });
      return;
    }

    enableCapability(name as CapabilityName);
    const saved = saveConfigToFile();
    if (!saved) {
      res.status(500).json({
        success: false,
        error: '能力已启用但配置保存失败，重启后可能丢失',
      });
      return;
    }

    res.json({ success: true, data: getConfig() });
  } catch (error) {
    logger.error('Failed to enable capability:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '启用能力失败',
    });
  }
}

/**
 * 禁用能力
 * POST /api/ai-ops/evolution/capability/:name/disable
 * Requirements: evolution-frontend 1.3, 6.2
 */
export async function disableEvolutionCapability(req: Request, res: Response): Promise<void> {
  try {
    const { name } = req.params;
    const {
      disableCapability,
      getEvolutionConfig: getConfig,
      saveConfigToFile
    } = await import('../services/ai-ops/evolutionConfig');

    // 验证能力名称
    type CapabilityName = 'reflection' | 'experience' | 'planRevision' | 'toolFeedback' |
      'proactiveOps' | 'intentDriven' | 'selfHealing' | 'continuousLearning' | 'tracing' | 'autonomousBrain';

    const validCapabilities: CapabilityName[] = [
      'reflection', 'experience', 'planRevision', 'toolFeedback',
      'proactiveOps', 'intentDriven', 'selfHealing', 'continuousLearning', 'tracing', 'autonomousBrain'
    ];

    if (!validCapabilities.includes(name as CapabilityName)) {
      res.status(400).json({
        success: false,
        error: `无效的能力名称: ${name}`,
      });
      return;
    }

    disableCapability(name as CapabilityName);
    const saved = saveConfigToFile();
    if (!saved) {
      res.status(500).json({
        success: false,
        error: '能力已禁用但配置保存失败，重启后可能丢失',
      });
      return;
    }

    res.json({ success: true, data: getConfig() });
  } catch (error) {
    logger.error('Failed to disable capability:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '禁用能力失败',
    });
  }
}

// ==================== 健康监控 API ====================

/**
 * 获取当前健康状态
 * GET /api/ai-ops/health/current
 * Requirements: evolution-frontend 2.1, 6.3
 */
export async function getHealthCurrent(req: Request, res: Response): Promise<void> {
  try {
    const { deviceId } = req.query;
    const { healthMonitor } = await import('../services/ai-ops/healthMonitor');
    const snapshot = await healthMonitor.getLatestHealth(deviceId as string);

    if (!snapshot) {
      try {
        const createPromise = healthMonitor.createSnapshot(deviceId as string);
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
        const newSnapshot = await Promise.race([createPromise, timeoutPromise]);

        if (!newSnapshot) {
          res.json({
            success: true,
            data: {
              score: 0,
              level: 'unknown',
              dimensions: { system: 0, network: 0, performance: 0, reliability: 0 },
              issues: [],
              timestamp: Date.now(),
            }
          });
          return;
        }

        const formattedIssues = newSnapshot.score.issues.map((msg: string, idx: number) => ({
          id: `issue-${idx}`,
          severity: msg.includes('过高') ? 'critical' : 'warning',
          message: msg,
          suggestion: getIssueSuggestion(msg),
        }));
        res.json({
          success: true,
          data: {
            score: newSnapshot.score.overall,
            level: newSnapshot.score.level,
            dimensions: {
              system: newSnapshot.score.dimensions.system,
              network: newSnapshot.score.dimensions.network,
              performance: newSnapshot.score.dimensions.performance,
              reliability: newSnapshot.score.dimensions.reliability,
            },
            issues: formattedIssues,
            timestamp: newSnapshot.timestamp,
          }
        });
      } catch (createError) {
        logger.warn('Failed to create health snapshot, returning default:', createError);
        res.json({
          success: true,
          data: {
            score: 0,
            level: 'unknown',
            dimensions: { system: 0, network: 0, performance: 0, reliability: 0 },
            issues: [],
            timestamp: Date.now(),
          }
        });
      }
      return;
    }

    // 将 issues 字符串数组转换为前端期望的对象数组格式
    const formattedIssues = (snapshot.issues || []).map((msg, idx) => ({
      id: `issue-${idx}`,
      severity: msg.includes('过高') ? 'critical' : 'warning',
      message: msg,
      suggestion: getIssueSuggestion(msg),
    }));

    res.json({
      success: true,
      data: {
        score: snapshot.score,
        level: snapshot.level,
        dimensions: snapshot.dimensions || { system: 0, network: 0, performance: 0, reliability: 0 },
        issues: formattedIssues,
        timestamp: snapshot.timestamp || Date.now(),
      }
    });
  } catch (error) {
    logger.error('Failed to get current health status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取健康状态失败',
    });
  }
}

/**
 * 根据问题消息生成建议
 */
function getIssueSuggestion(message: string): string {
  if (message.includes('CPU')) {
    return '检查高 CPU 占用的进程，考虑优化或重启相关服务';
  }
  if (message.includes('内存')) {
    return '检查内存泄漏，考虑增加内存或优化内存使用';
  }
  if (message.includes('磁盘')) {
    return '清理不必要的文件，考虑扩展存储空间';
  }
  if (message.includes('接口') || message.includes('离线')) {
    return '检查网络连接和接口配置，确认物理连接正常';
  }
  if (message.includes('响应时间')) {
    return '检查网络延迟和服务负载，优化性能瓶颈';
  }
  if (message.includes('错误率')) {
    return '检查错误日志，排查并修复导致错误的根本原因';
  }
  return '请检查相关配置和日志，排查问题原因';
}

/**
 * 获取健康趋势
 * GET /api/ai-ops/health/trend
 * Requirements: evolution-frontend 2.4, 2.5, 6.3
 */
export async function getHealthTrend(req: Request, res: Response): Promise<void> {
  try {
    const { range, deviceId } = req.query;
    const validRanges = ['1h', '6h', '24h', '7d'];
    const selectedRange = validRanges.includes(range as string) ? range as string : '1h';

    // 映射到 healthMonitor 的 period 参数
    let period: 'hour' | '6hour' | 'day' | 'week';
    switch (selectedRange) {
      case '1h':
        period = 'hour';
        break;
      case '6h':
        period = '6hour';
        break;
      case '24h':
        period = 'day';
        break;
      case '7d':
        period = 'week';
        break;
      default:
        period = 'hour';
    }

    const { healthMonitor } = await import('../services/ai-ops/healthMonitor');
    const trend = await healthMonitor.getHealthTrend(period, deviceId as string);
    res.json({ success: true, data: trend.dataPoints });
  } catch (error) {
    logger.error('Failed to get health trend:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取健康趋势失败',
    });
  }
}

// ==================== 异常预测 API ====================

/**
 * 获取异常预测列表
 * GET /api/ai-ops/anomaly/predictions
 * Requirements: evolution-frontend 3.1, 6.3
 */
export async function getAnomalyPredictions(_req: Request, res: Response): Promise<void> {
  try {
    const { anomalyPredictor } = await import('../services/ai-ops/anomalyPredictor');
    const predictions = await anomalyPredictor.predict();
    res.json({ success: true, data: predictions });
  } catch (error) {
    logger.error('Failed to get anomaly predictions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取异常预测失败',
    });
  }
}

// ==================== 自主意图 API ====================
// Requirements: evolution-frontend - Autonomous Intent Generation

/**
 * SSE 自主意图事件流
 * GET /api/ai-ops/intents/stream
 */
export async function streamAutonomousIntents(req: Request, res: Response): Promise<void> {
  try {
    const { proactiveInspector } = await import('../services/ai-ops/proactiveInspector');

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 发送初始连接事件
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Autonomous Intent Stream Connected' })}\n\n`);

    // 监听事件
    const onIntent = (data: any) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'intent', data })}\n\n`);
      }
    };

    proactiveInspector.on('autonomousIntentGenerated', onIntent);

    // 心跳保活 — 使用数据事件格式，确保前端 EventSource 能检测到心跳
    // 注意：SSE 注释格式（:heartbeat）会被浏览器 EventSource 静默丢弃，无法触发前端心跳检测
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      }
    }, 30000);

    // 处理客户端断开连接
    req.on('close', () => {
      logger.debug(`SSE client disconnected for autonomous intents`);
      proactiveInspector.off('autonomousIntentGenerated', onIntent);
      clearInterval(heartbeat);
    });

  } catch (error) {
    logger.error('Failed to stream autonomous intents:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '事件流失败',
      });
    }
  }
}

// ==================== 巡检报告 API ====================

// Inspection report functions removed - consolidated into health reports at /ai-ops/reports

// ==================== 大脑思考过程 SSE ====================

/**
 * SSE 大脑思考事件流 — 实时推送 OODA 循环的推理过程
 * GET /api/ai-ops/brain/thinking/stream
 */
export async function streamBrainThinking(req: Request, res: Response): Promise<void> {
  try {
    // 🟡 FIX 1.8: 使用顶层静态导入替代每次 SSE 连接的动态导入
    const { autonomousBrainService } = require('../services/ai-ops/brain/autonomousBrainService');

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 发送初始连接事件
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Brain Thinking Stream Connected' })}\n\n`);

    // 🟢 FIX 1.11: 使用不含冒号的事件名 brain-thinking，确保代理兼容性
    const onThinking = (data: any) => {
      if (!res.writableEnded) {
        res.write(`event: brain-thinking\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    autonomousBrainService.events.on('brain:thinking', onThinking);

    // 心跳保活 — 使用数据事件格式，确保前端 EventSource 能检测到心跳
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      }
    }, 30000);

    // 处理客户端断开连接
    req.on('close', () => {
      logger.debug('SSE client disconnected for brain thinking');
      autonomousBrainService.events.off('brain:thinking', onThinking);
      clearInterval(heartbeat);
    });

  } catch (error) {
    logger.error('Failed to stream brain thinking:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '大脑思考事件流失败',
      });
    }
  }
}

// ==================== 自主大脑 Air-Lock ====================
// Requirements: Phase 5 - Human-in-the-loop

import { getPendingIntents, grantPendingIntent, rejectPendingIntent } from '../services/ai-ops/brain/intentRegistry';

/**
 * 获取当前等待审批的高危意图列表
 * GET /api/ai-ops/intents/pending
 */
export async function getPendingIntentsHandler(req: Request, res: Response): Promise<void> {
  try {
    const intents = getPendingIntents();
    res.json({ success: true, data: intents });
  } catch (error) {
    logger.error('Failed to get pending intents:', error);
    res.status(500).json({ success: false, error: '获取挂起意图失败' });
  }
}

/**
 * 同意执行高危意图
 * POST /api/ai-ops/intents/grant/:id
 */
export async function grantIntentHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const result = await grantPendingIntent(id);
    res.json({ success: true, message: '指令已授权通过并执行', data: result });
  } catch (error) {
    logger.error(`Failed to grant intent ${req.params.id}:`, error);
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : '执行授权失败' });
  }
}

/**
 * 驳回高危意图
 * POST /api/ai-ops/intents/reject/:id
 */
export async function rejectIntentHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    rejectPendingIntent(id);
    res.json({ success: true, message: '指令已被销毁' });
  } catch (error) {
    logger.error(`Failed to reject intent ${req.params.id}:`, error);
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : '驳回失败' });
  }
}
