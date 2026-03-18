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
import { DataStore } from '../services/core/dataStore';
import path from 'path';

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

/**
 * 创建默认的认证路由（使用默认 DataStore 和 AuthService）
 *
 * 用于在 index.ts 中快速注册路由，无需手动创建 DataStore 和 AuthService。
 * 注意：这会创建独立的 DataStore 实例，适用于简单场景。
 * 在生产环境中，建议使用 createAuthRoutes() 并传入共享的 AuthService 实例。
 */
export async function createDefaultAuthRoutes(): Promise<Router> {
  const dataStore = new DataStore({
    dbPath: path.join(process.cwd(), 'data', 'routeros-ai-ops.db'),
    migrationsPath: path.join(__dirname, '..', 'migrations'),
  });
  await dataStore.initialize();

  const authService = new AuthService(dataStore);
  return createAuthRoutes(authService);
}

export default createAuthRoutes;
