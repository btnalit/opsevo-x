/**
 * 设备代理中间件
 *
 * 解析请求路径中的 deviceId 参数，验证设备归属（tenant 匹配），
 * 从 DevicePool 获取或创建 RouterOS 连接，并注入到请求上下文中。
 *
 * - 缺少 deviceId：返回 400
 * - 设备不属于当前租户：返回 403
 * - 设备未连接时自动尝试连接
 * - 连接成功：注入 req.routerosClient 和 req.deviceId，调用 next()
 * - 连接失败：返回 502
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { Request, Response, NextFunction } from 'express';
import { DeviceManager } from '../services/device/deviceManager';
import { DevicePool, DevicePoolError } from '../services/device/devicePool';
import { deviceDriverManager } from '../services/device/deviceDriverManager';
import { logger } from '../utils/logger';

/**
 * 创建设备代理中间件
 *
 * 使用工厂函数模式，接受 DeviceManager 和 DevicePool 实例作为参数，
 * 便于测试时注入 mock 或不同配置的实例。
 *
 * @param deviceManager DeviceManager 实例
 * @param devicePool DevicePool 实例
 * @returns Express 中间件函数
 */
export function createDeviceMiddleware(
  deviceManager: DeviceManager,
  devicePool: DevicePool,
) {
  return async function deviceMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // 1. 解析 deviceId
      const { deviceId } = req.params;
      if (!deviceId) {
        res.status(400).json({ error: '缺少设备 ID' });
        return;
      }

      // 2. 验证 tenantId 已注入（需要 authMiddleware 先执行）
      const tenantId = req.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: '未提供认证信息' });
        return;
      }

      // 3. 验证设备归属（tenant 匹配）
      const device = await deviceManager.getDevice(tenantId, deviceId);
      if (!device) {
        logger.warn(
          `租户 ${tenantId} 尝试访问不属于自己的设备 ${deviceId}`,
        );
        res.status(403).json({ error: '无权访问该设备' });
        return;
      }

      // 4. 从 DevicePool 获取或创建连接（设备未连接时自动尝试连接）
      const client = await devicePool.getConnection(tenantId, deviceId);

      // 5. 注入到请求上下文
      req.routerosClient = client;
      req.deviceId = deviceId;

      // 6. 注入泛化设备驱动（如果已通过 DeviceDriverManager 连接）
      const driver = deviceDriverManager.getDriver(deviceId);
      if (driver) {
        req.deviceDriver = driver;
      }

      next();
    } catch (error) {
      if (error instanceof DevicePoolError) {
        logger.error(
          `设备连接失败: ${error.message} (code: ${error.code})`,
        );

        if (error.code === 'FORBIDDEN') {
          res.status(403).json({
            error: '无权访问该设备',
            code: error.code,
          });
          return;
        }

        // 连接失败（设备不可达、认证失败等）
        res.status(502).json({
          error: `设备连接失败: ${error.message}`,
          code: error.code,
        });
        return;
      }

      // 未预期的错误
      logger.error('设备代理中间件异常:', error);
      res.status(500).json({ error: '内部服务器错误' });
    }
  };
}
