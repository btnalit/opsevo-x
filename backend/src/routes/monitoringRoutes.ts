/**
 * 监控路由
 *
 * 定义多设备监控概览相关的路由：
 * - GET /api/monitoring/overview - 多设备健康概览（需 authMiddleware，不需 deviceMiddleware）
 *
 * 设备级监控路由（/api/devices/:deviceId/monitoring/...）在 index.ts 中通过
 * deviceScopedRouter 挂载 aiOpsRoutes 实现。
 *
 * Requirements: 9.4
 */

import { Router, RequestHandler } from 'express';
import { createMonitoringController } from '../controllers/monitoringController';
import { DeviceManager } from '../services/device/deviceManager';
import { DevicePool } from '../services/device/devicePool';
import type { DataStore } from '../services/dataStore';

/**
 * 创建监控路由
 *
 * 使用工厂函数模式，接受 DeviceManager、DevicePool、DataStore 和 authMiddleware 作为参数。
 *
 * @param deviceManager DeviceManager 实例
 * @param devicePool DevicePool 实例
 * @param dataStore DataStore 实例
 * @param authMiddleware 认证中间件
 * @returns Express Router
 */
export function createMonitoringRoutes(
  deviceManager: DeviceManager,
  devicePool: DevicePool,
  dataStore: DataStore,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();
  const controller = createMonitoringController(deviceManager, devicePool, dataStore);

  // 所有监控概览路由需经过认证中间件
  router.use(authMiddleware);

  // GET /api/monitoring/overview - 多设备健康概览
  router.get('/overview', controller.getOverview);

  return router;
}

export default createMonitoringRoutes;
