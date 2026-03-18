/**
 * 设备管理控制器
 *
 * 处理设备管理相关的 HTTP 请求：
 * - listDevices：获取设备列表（支持过滤）
 * - createDevice：创建新设备
 * - getDevice：获取单个设备
 * - updateDevice：更新设备
 * - deleteDevice：删除设备
 * - connectDevice：连接设备（通过 DevicePool）
 * - disconnectDevice：断开设备连接
 *
 * 使用工厂函数模式，接受 DeviceManager 和 DevicePool 实例作为参数。
 * 所有路由需经过 authMiddleware，通过 req.tenantId 实现租户隔离。
 * GET 响应中不暴露 password_encrypted，替换为 hasPassword 布尔字段。
 *
 * Requirements: 5.1, 5.3
 */

import { Request, Response } from 'express';
import { DeviceManager, DeviceManagerError, Device } from '../services/device/deviceManager';
import { DevicePool, DevicePoolError } from '../services/device/devicePool';
import { alertEngine } from '../services/ai-ops/alertEngine';
import { logger } from '../utils/logger';

/**
 * 将 Device 对象转换为安全的响应格式（隐藏密码）
 */
function toSafeDevice(device: Device) {
  const { password_encrypted, ...rest } = device;
  return {
    ...rest,
    hasPassword: !!password_encrypted,
  };
}

/**
 * 根据 DeviceManagerError code 映射 HTTP 状态码
 */
function getStatusCodeForDeviceError(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'CREATE_FAILED':
    case 'UPDATE_FAILED':
    case 'DELETE_FAILED':
    case 'QUERY_FAILED':
    case 'STATUS_UPDATE_FAILED':
    case 'DECRYPT_FAILED':
    case 'INVALID_STATUS':
    default:
      return 500;
  }
}

/**
 * 根据 DevicePoolError code 映射 HTTP 状态码
 */
function getStatusCodeForPoolError(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'CONNECTION_FAILED':
    case 'DECRYPT_FAILED':
      return 502;
    default:
      return 500;
  }
}

/**
 * 创建设备管理控制器
 *
 * @param deviceManager DeviceManager 实例
 * @param devicePool DevicePool 实例
 * @returns 包含所有设备管理方法的控制器对象
 */
export function createDeviceController(deviceManager: DeviceManager, devicePool: DevicePool) {
  return {
    /**
     * GET /api/devices
     *
     * 获取当前租户的设备列表
     * Query params: group_name, tags (逗号分隔), status
     * 成功返回: 200 { devices: Device[] }
     */
    async listDevices(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        // 解析查询参数
        const filter: {
          group_name?: string;
          tags?: string[];
          status?: 'online' | 'offline' | 'connecting' | 'error';
        } = {};

        if (req.query.group_name && typeof req.query.group_name === 'string') {
          filter.group_name = req.query.group_name;
        }

        if (req.query.tags && typeof req.query.tags === 'string') {
          filter.tags = req.query.tags.split(',').map((t) => t.trim()).filter(Boolean);
        }

        if (req.query.status && typeof req.query.status === 'string') {
          const validStatuses = ['online', 'offline', 'connecting', 'error'];
          if (validStatuses.includes(req.query.status)) {
            filter.status = req.query.status as 'online' | 'offline' | 'connecting' | 'error';
          }
        }

        const devices = await deviceManager.getDevices(tenantId, Object.keys(filter).length > 0 ? filter : undefined);

        res.status(200).json({
          success: true,
          data: devices.map(toSafeDevice),
        });
      } catch (error) {
        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('获取设备列表失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },

    /**
     * POST /api/devices
     *
     * 创建新设备
     * Body: { name, host, port?, username, password, use_tls?, group_name?, tags? }
     * 成功返回: 201 { device: Device }
     */
    async createDevice(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        const { name, host, port, username, password, use_tls, group_name, tags } = req.body;

        if (!name || !host || !username || !password) {
          res.status(400).json({
            error: '缺少必要参数：name、host、username、password',
            code: 'MISSING_PARAMS',
          });
          return;
        }

        const device = await deviceManager.createDevice(tenantId, {
          name,
          host,
          port,
          username,
          password,
          use_tls,
          group_name,
          tags,
        });

        res.status(201).json({
          success: true,
          data: toSafeDevice(device),
        });
      } catch (error) {
        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('创建设备失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },

    /**
     * GET /api/devices/:deviceId
     *
     * 获取单个设备详情
     * 成功返回: 200 { device: Device }
     * 不存在: 404
     */
    async getDevice(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        const { deviceId } = req.params;
        if (!deviceId) {
          res.status(400).json({ error: '缺少设备 ID', code: 'MISSING_PARAMS' });
          return;
        }

        const device = await deviceManager.getDevice(tenantId, deviceId);
        if (!device) {
          res.status(404).json({ error: '设备不存在或无权访问', code: 'NOT_FOUND' });
          return;
        }

        res.status(200).json({
          success: true,
          data: toSafeDevice(device),
        });
      } catch (error) {
        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('获取设备详情失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },

    /**
     * PUT /api/devices/:deviceId
     *
     * 更新设备配置
     * Body: { name?, host?, port?, username?, password?, use_tls?, group_name?, tags? }
     * 成功返回: 200 { device: Device }
     * 不存在: 404
     */
    async updateDevice(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        const { deviceId } = req.params;
        if (!deviceId) {
          res.status(400).json({ error: '缺少设备 ID', code: 'MISSING_PARAMS' });
          return;
        }

        const { name, host, port, username, password, use_tls, group_name, tags } = req.body;

        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (host !== undefined) updates.host = host;
        if (port !== undefined) updates.port = port;
        if (username !== undefined) updates.username = username;
        if (password !== undefined) updates.password = password;
        if (use_tls !== undefined) updates.use_tls = use_tls;
        if (group_name !== undefined) updates.group_name = group_name;
        if (tags !== undefined) updates.tags = tags;

        const device = await deviceManager.updateDevice(tenantId, deviceId, updates);

        res.status(200).json({
          success: true,
          data: toSafeDevice(device),
        });
      } catch (error) {
        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('更新设备失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },

    /**
     * DELETE /api/devices/:deviceId
     *
     * 删除设备
     * 成功返回: 200 { message: '设备已删除' }
     * 不存在: 404
     */
    async deleteDevice(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        const { deviceId } = req.params;
        if (!deviceId) {
          res.status(400).json({ error: '缺少设备 ID', code: 'MISSING_PARAMS' });
          return;
        }

        // 先断开设备连接（如果有）
        try {
          await devicePool.releaseConnection(deviceId);
        } catch {
          // 忽略释放连接时的错误
        }

        await deviceManager.deleteDevice(tenantId, deviceId);

        // 清理 alertEngine 内存缓存中该设备的残留告警
        // 防止 Brain 拿到已删除设备的 deviceId 去调 execute_intent
        alertEngine.clearAlertsForDevice(deviceId);

        res.status(200).json({ success: true, message: '设备已删除' });
      } catch (error) {
        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('删除设备失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },

    /**
     * POST /api/devices/:deviceId/connect
     *
     * 连接到设备（通过 DevicePool）
     * 成功返回: 200 { message, device, poolStats }
     * 连接失败: 502
     */
    async connectDevice(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        const { deviceId } = req.params;
        if (!deviceId) {
          res.status(400).json({ error: '缺少设备 ID', code: 'MISSING_PARAMS' });
          return;
        }

        // 先验证设备存在且属于当前租户
        const device = await deviceManager.getDevice(tenantId, deviceId);
        if (!device) {
          res.status(404).json({ error: '设备不存在或无权访问', code: 'NOT_FOUND' });
          return;
        }

        // 通过 DevicePool 建立连接
        await devicePool.getConnection(tenantId, deviceId, { force: true });

        // 重新获取设备信息（状态已更新）
        const updatedDevice = await deviceManager.getDevice(tenantId, deviceId);

        res.status(200).json({
          success: true,
          message: '设备连接成功',
          data: updatedDevice ? toSafeDevice(updatedDevice) : toSafeDevice(device),
          poolStats: devicePool.getPoolStats(),
        });
      } catch (error) {
        if (error instanceof DevicePoolError) {
          const statusCode = getStatusCodeForPoolError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('连接设备失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },

    /**
     * POST /api/devices/:deviceId/disconnect
     *
     * 断开设备连接
     * 成功返回: 200 { message, device, poolStats }
     */
    async disconnectDevice(req: Request, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) {
          res.status(401).json({ error: '未认证', code: 'UNAUTHORIZED' });
          return;
        }

        const { deviceId } = req.params;
        if (!deviceId) {
          res.status(400).json({ error: '缺少设备 ID', code: 'MISSING_PARAMS' });
          return;
        }

        // 验证设备存在且属于当前租户
        const device = await deviceManager.getDevice(tenantId, deviceId);
        if (!device) {
          res.status(404).json({ error: '设备不存在或无权访问', code: 'NOT_FOUND' });
          return;
        }

        // 通过 DevicePool 释放连接
        await devicePool.releaseConnection(deviceId);

        // 重新获取设备信息（状态已更新）
        const updatedDevice = await deviceManager.getDevice(tenantId, deviceId);

        res.status(200).json({
          success: true,
          message: '设备已断开连接',
          data: updatedDevice ? toSafeDevice(updatedDevice) : toSafeDevice(device),
          poolStats: devicePool.getPoolStats(),
        });
      } catch (error) {
        if (error instanceof DevicePoolError) {
          const statusCode = getStatusCodeForPoolError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        if (error instanceof DeviceManagerError) {
          const statusCode = getStatusCodeForDeviceError(error.code);
          res.status(statusCode).json({ error: error.message, code: error.code });
          return;
        }

        logger.error('断开设备连接失败:', error);
        res.status(500).json({ error: '服务器内部错误', code: 'INTERNAL_ERROR' });
      }
    },
  };
}

// Export helpers for testing
export { toSafeDevice, getStatusCodeForDeviceError, getStatusCodeForPoolError };
