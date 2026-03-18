/**
 * Dashboard Controller
 * 处理系统资源监控相关的 API 请求
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * 从请求对象获取设备驱动
 * 由 deviceMiddleware 注入到 req.deviceDriver
 * @deprecated 此 controller 将在后续重构中迁移到 DeviceManager 统一接口
 */
function getDeviceContext(req: Request, res: Response): { deviceId: string } | null {
  const deviceId = req.deviceId;
  if (!deviceId) {
    res.status(500).json({ success: false, error: '未建立设备连接' });
    return null;
  }
  return { deviceId };
}

const RESOURCE_PATH = '/system/resource';

/**
 * 系统资源数据接口
 */
interface SystemResource {
  '.id'?: string;
  'cpu': string;
  'cpu-count': string;
  'cpu-frequency': string;
  'cpu-load': string;
  'architecture-name': string;
  'board-name': string;
  'version': string;
  'build-time': string;
  'uptime': string;
  'total-memory': string;
  'free-memory': string;
  'total-hdd-space': string;
  'free-hdd-space': string;
  'sector-writes-since-reboot'?: string;
  'total-sector-writes'?: string;
}

/**
 * 获取系统资源信息
 * GET /api/dashboard/resource
 */
export async function getSystemResource(req: Request, res: Response): Promise<void> {
  try {
    const ctx = getDeviceContext(req, res);
    if (!ctx) return;

    // 通过 ServiceRegistry 获取全局客户端
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    
    // 通过 DevicePool 获取设备连接（通用 AIOps 平台不再依赖全局单设备客户端）
    const devicePool = serviceRegistry.tryGet<any>(SERVICE_NAMES.DEVICE_POOL);
    if (!devicePool) {
      res.status(500).json({ success: false, error: '未建立设备连接' });
      return;
    }

    const deviceId = (req as any).deviceId;
    const tenantId = (req as any).tenantId;
    if (!deviceId || !tenantId) {
      res.status(500).json({ success: false, error: '未指定设备' });
      return;
    }

    let client: any;
    try {
      client = await devicePool.getConnection(tenantId, deviceId);
    } catch {
      res.status(500).json({ success: false, error: '未建立设备连接' });
      return;
    }
    if (!client || !client.isConnected()) {
      res.status(500).json({ success: false, error: '未建立设备连接' });
      return;
    }
    
    const result = await client.print(RESOURCE_PATH);

    if (!result || (Array.isArray(result) && result.length === 0)) {
      res.status(404).json({
        success: false,
        error: '无法获取系统资源信息',
      });
      return;
    }

    const resource = Array.isArray(result) ? result[0] : result;

    res.json({
      success: true,
      data: resource,
    });
  } catch (error) {
    logger.error('Failed to get system resource:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取系统资源信息失败',
    });
  }
}
