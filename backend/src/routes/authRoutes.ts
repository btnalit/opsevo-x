/**
 * 认证路由
 *
 * 定义用户认证相关的路由：
 * - POST /api/auth/register - 用户注册
 * - POST /api/auth/login    - 用户登录
 * - POST /api/auth/refresh  - 令牌刷新
 *
 * 这些路由不需要认证中间件（公开接口）。
 *
 * Requirements: 4.1, 4.2, 4.6
 */

import { Router } from 'express';
import { createAuthController } from '../controllers/authController';
import { AuthService } from '../services/auth/authService';

/**
 * 创建认证路由
 *
 * 使用工厂函数模式，接受 AuthService 实例作为参数。
 * 这样可以在应用启动时注入已初始化的 AuthService 实例。
 *
 * @param authService AuthService 实例
 * @returns Express Router
 */
export function createAuthRoutes(authService: AuthService): Router {
  const router = Router();
  const controller = createAuthController(authService);

  // POST /api/auth/register - 用户注册
  router.post('/register', controller.register);

  // POST /api/auth/login - 用户登录
  router.post('/login', controller.login);

  // POST /api/auth/refresh - 令牌刷新
  router.post('/refresh', controller.refresh);

  return router;
}

export default createAuthRoutes;
