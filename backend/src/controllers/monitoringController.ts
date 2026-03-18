/**
 * 监控控制器
 *
 * 提供多设备健康概览接口：
 * - GET /api/monitoring/overview - 获取当前租户所有设备的健康概览
 *
 * 聚合数据包括：
 * - 所有设备及其连接状态（online/offline/error）
 * - 每台设备的最近告警数量
 * - 已连接设备的基本健康指标摘要（CPU、内存、磁盘）
 *
 * Requirements: 9.4
 */

import { Request, Response } from 'express';
import { DeviceManager, Device } from '../services/device/deviceManager';
import { DevicePool, PooledConnection } from '../services/device/devicePool';
import type { DataStore } from '../services/dataStore';
import { logger } from '../utils/logger';

/**
 * 单台设备的健康概览信息
 */
interface DeviceHealthOverview {
  deviceId: string;
  name: string;
  host: string;
  status: Device['status'];
  lastSeen?: string;
  errorMessage?: string;
  /** 连接池中的连接状态 */
  poolStatus: 'connected' | 'connecting' | 'disconnected' | 'not_in_pool';
  /** 最近活跃告警数量 */
  activeAlertCount: number;
  /** 最近健康指标（仅已连接设备有数据） */
  latestMetrics?: {
    cpuUsage?: number;
    memoryUsage?: number;
    diskUsage?: number;
    collectedAt?: string;
  };
}

/**
 * 多设备健康概览响应
 */
interface MonitoringOverviewResponse {
  totalDevices: number;
  onlineCount: number;
  offlineCount: number;
  errorCount: number;
  connectingCount: number;
  totalActiveAlerts: number;
  devices: DeviceHealthOverview[];
}

/**
 * 创建监控控制器
 *
 * 使用工厂函数模式，接受 DeviceManager、DevicePool 和 DataStore 作为参数。
 *
 * @param deviceManager DeviceManager 实例
 * @param devicePool DevicePool 实例
 * @param dataStore DataStore 实例
 * @returns 控制器方法对象
 */
export function createMonitoringController(
  deviceManager: DeviceManager,
  devicePool: DevicePool,
  dataStore: DataStore,
) {
  return {
    /**
     * GET /api/monitoring/overview
     *
     * 获取当前租户所有设备的健康概览
     * 需要 authMiddleware（从 req.tenantId 获取租户 ID）
     * 不需要 deviceMiddleware（概览展示所有设备）
     *
     * 返回: 200 { MonitoringOverviewResponse }
     */
    async getOverview(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        // 1. 获取租户的所有设备
        const devices = await deviceManager.getDevices(tenantId);

        // 2. 获取连接池中的连接状态
        const connectionsMap = devicePool.getConnectionsMap();

        // 3. 构建每台设备的健康概览
        const deviceOverviews: DeviceHealthOverview[] = [];
        let totalActiveAlerts = 0;

        for (const device of devices) {
          // 获取连接池状态
          const poolConn = connectionsMap.get(device.id);
          const poolStatus: DeviceHealthOverview['poolStatus'] = poolConn
            ? poolConn.status
            : 'not_in_pool';

          // 获取该设备的活跃告警数量
          let activeAlertCount = 0;
          try {
            const rows = await dataStore.query<{ count: number }>(
              `SELECT COUNT(*) as count FROM alert_events 
               WHERE tenant_id = $1 AND device_id = $2 AND status = 'active'`,
              [tenantId, device.id],
            );
            activeAlertCount = rows[0]?.count ?? 0;
          } catch {
            // 表可能不存在或查询失败，忽略
            logger.debug(`Failed to query alert count for device ${device.id}`);
          }
          totalActiveAlerts += activeAlertCount;

          // 获取最近的健康指标（CPU、内存、磁盘）
          let latestMetrics: DeviceHealthOverview['latestMetrics'] | undefined;
          try {
            const metricRows = await dataStore.query<{
              metric_name: string;
              metric_value: number;
              collected_at: string;
            }>(
              `SELECT metric_name, metric_value, collected_at FROM health_metrics 
               WHERE tenant_id = $1 AND device_id = $2 
                 AND metric_name IN ('cpu_usage', 'memory_usage', 'disk_usage')
               ORDER BY collected_at DESC 
               LIMIT 3`,
              [tenantId, device.id],
            );

            if (metricRows.length > 0) {
              latestMetrics = {
                collectedAt: metricRows[0].collected_at,
              };
              for (const row of metricRows) {
                if (row.metric_name === 'cpu_usage') {
                  latestMetrics.cpuUsage = row.metric_value;
                } else if (row.metric_name === 'memory_usage') {
                  latestMetrics.memoryUsage = row.metric_value;
                } else if (row.metric_name === 'disk_usage') {
                  latestMetrics.diskUsage = row.metric_value;
                }
              }
            }
          } catch {
            // 表可能不存在或查询失败，忽略
            logger.debug(`Failed to query health metrics for device ${device.id}`);
          }

          deviceOverviews.push({
            deviceId: device.id,
            name: device.name,
            host: device.host,
            status: device.status,
            lastSeen: device.last_seen,
            errorMessage: device.error_message,
            poolStatus,
            activeAlertCount,
            latestMetrics,
          });
        }

        // 4. 统计设备状态
        const onlineCount = devices.filter((d) => d.status === 'online').length;
        const offlineCount = devices.filter((d) => d.status === 'offline').length;
        const errorCount = devices.filter((d) => d.status === 'error').length;
        const connectingCount = devices.filter((d) => d.status === 'connecting').length;

        const response: MonitoringOverviewResponse = {
          totalDevices: devices.length,
          onlineCount,
          offlineCount,
          errorCount,
          connectingCount,
          totalActiveAlerts,
          devices: deviceOverviews,
        };

        res.status(200).json(response);
      } catch (error) {
        logger.error('获取监控概览失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },
  };
}
