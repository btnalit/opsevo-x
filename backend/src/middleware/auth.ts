/**
 * 认证中间件
 *
 * JWT 验证中间件，从 Authorization 请求头中提取 Bearer token，
 * 验证令牌有效性后将 tenantId 和 username 注入到 req 对象中。
 *
 * - 有效令牌：注入 req.tenantId 和 req.username，调用 next()
 * - 缺失令牌：返回 401 状态码
 * - 无效/过期令牌：返回 401 状态码
 *
 * Requirements: 4.4, 4.5
 */

import { Request, Response, NextFunction } from 'express';
import { AuthService, AuthServiceError } from '../services/auth/authService';
import { logger } from '../utils/logger';

/**
 * 创建认证中间件
 *
 * 使用工厂函数模式，接受 AuthService 实例作为参数，
 * 便于测试时注入 mock 或不同配置的 AuthService。
 *
 * @param authService AuthService 实例
 * @returns Express 中间件函数
 */
export function createAuthMiddleware(authService: AuthService) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // 从 Authorization 请求头提取 Bearer token，或从 query 参数获取（SSE 连接使用）
      const authHeader = req.headers.authorization;
      const queryToken = req.query.token as string | undefined;

      if (!authHeader && !queryToken) {
        res.status(401).json({ error: '未提供认证令牌' });
        return;
      }

      let token: string;

      if (authHeader) {
        // 验证 Bearer 格式
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
          res.status(401).json({ error: '认证令牌格式无效，需要 Bearer token' });
          return;
        }
        token = parts[1];
      } else {
        // SSE 连接通过 query 参数传递 token（EventSource 不支持自定义 header）
        token = queryToken!;
      }
      if (!token || token.trim().length === 0) {
        res.status(401).json({ error: '认证令牌为空' });
        return;
      }

      // 验证 JWT 令牌并提取 payload
      const payload = await authService.validateToken(token);

      // 注入 tenantId 和 username 到请求对象
      req.tenantId = payload.tenantId;
      req.username = payload.username;

      next();
    } catch (error) {
      if (error instanceof AuthServiceError) {
        logger.debug(`认证失败: ${error.message} (code: ${error.code})`);
        res.status(401).json({
          error: error.message,
          code: error.code,
        });
        return;
      }

      // 未预期的错误
      logger.error('认证中间件异常:', error);
      res.status(401).json({ error: '认证失败' });
    }
  };
}
