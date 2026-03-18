/**
 * 设备管理路由
 *
 * 定义设备管理相关的路由：
 * - GET    /api/devices              - 获取设备列表（支持过滤）
 * - POST   /api/devices              - 创建新设备
 * - GET    /api/devices/:deviceId    - 获取单个设备
 * - PUT    /api/devices/:deviceId    - 更新设备
 * - DELETE /api/devices/:deviceId    - 删除设备
 * - POST   /api/devices/:deviceId/connect    - 连接设备
 * - POST   /api/devices/:deviceId/disconnect - 断开设备连接
 *
 * 所有路由需经过 authMiddleware 认证。
 *
 * Requirements: 5.1, 5.3
 */

import { Router, RequestHandler } from 'express';
import { createDeviceController } from '../controllers/deviceController';
import { DeviceManager } from '../services/device/deviceManager';
import { DevicePool } from '../services/device/devicePool';

/**
 * 创建设备管理路由
 *
 * 使用工厂函数模式，接受 DeviceManager、DevicePool 和 authMiddleware 作为参数。
 *
 * @param deviceManager DeviceManager 实例
 * @param devicePool DevicePool 实例
 * @param authMiddleware 认证中间件
 * @returns Express Router
 */
export function createDeviceRoutes(
  deviceManager: DeviceManager,
  devicePool: DevicePool,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();
  const controller = createDeviceController(deviceManager, devicePool);

  // 所有设备路由需经过认证中间件
  router.use(authMiddleware);

  // GET /api/devices - 获取设备列表
  router.get('/', controller.listDevices);

  // POST /api/devices - 创建新设备
  router.post('/', controller.createDevice);

  // GET /api/devices/:deviceId - 获取单个设备
  router.get('/:deviceId', controller.getDevice);

  // PUT /api/devices/:deviceId - 更新设备
  router.put('/:deviceId', controller.updateDevice);

  // DELETE /api/devices/:deviceId - 删除设备
  router.delete('/:deviceId', controller.deleteDevice);

  // POST /api/devices/:deviceId/connect - 连接设备
  router.post('/:deviceId/connect', controller.connectDevice);

  // POST /api/devices/:deviceId/disconnect - 断开设备连接
  router.post('/:deviceId/disconnect', controller.disconnectDevice);

  return router;
}

export default createDeviceRoutes;
