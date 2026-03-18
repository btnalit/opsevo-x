/**
 * Express Request 类型扩展
 *
 * 为 Express Request 对象添加多租户认证和多设备管理相关字段：
 * - tenantId：从 JWT 令牌中提取的租户 ID（即用户 ID）
 * - username：从 JWT 令牌中提取的用户名
 * - deviceDriver：由设备代理中间件注入的泛化设备驱动实例
 * - deviceId：由设备代理中间件注入的当前设备 ID
 */

import type { DeviceDriver } from './device-driver';

declare global {
  namespace Express {
    interface Request {
      /** 租户 ID（用户 ID），由认证中间件从 JWT 令牌中提取并注入 */
      tenantId?: string;
      /** 用户名，由认证中间件从 JWT 令牌中提取并注入 */
      username?: string;
      /** 泛化设备驱动实例，由设备代理中间件注入 */
      deviceDriver?: DeviceDriver;
      /** 当前设备 ID，由设备代理中间件注入 */
      deviceId?: string;
    }
  }
}

export {};
