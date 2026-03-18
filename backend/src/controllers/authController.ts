/**
 * 认证控制器
 *
 * 处理用户认证相关的 HTTP 请求：
 * - register：用户注册
 * - login：用户登录
 * - refresh：令牌刷新
 *
 * Requirements: 4.1, 4.2, 4.4, 4.5, 4.6
 */

import { Request, Response } from 'express';
import { AuthService, AuthServiceError } from '../services/auth/authService';
import { logger } from '../utils/logger';

/**
 * 创建认证控制器
 *
 * 使用工厂函数模式，接受 AuthService 实例作为参数。
 *
 * @param authService AuthService 实例
 * @returns 包含 register、login、refresh 方法的控制器对象
 */
export function createAuthController(authService: AuthService) {
  return {
    /**
     * POST /api/auth/register
     *
     * 用户注册接口
     * Body: { username: string, email: string, password: string }
     * 成功返回: 201 { success: true, data: { user } }
     * 失败返回: 400/409/500 { success: false, error, code }
     */
    async register(req: Request, res: Response): Promise<void> {
      try {
        const { username, email, password, invitationCode } = req.body;


        // 基本参数检查
        if (!username || !email || !password) {
          res.status(400).json({
            success: false,
            error: '缺少必要参数：username、email、password',
            code: 'MISSING_PARAMS',
          });
          return;
        }


        // 邀请码验证 (Requirements: Registration Invitation Code)
        if (invitationCode !== 'OpsEvo888') {
          res.status(403).json({
            success: false,
            error: '注册码无效',
            code: 'INVALID_INVITATION_CODE',
          });
          return;
        }

        const user = await authService.register(username, email, password);

        // 返回用户信息（排除密码哈希）
        res.status(201).json({
          success: true,
          data: {
            user: {
              id: user.id,
              username: user.username,
              email: user.email,
              created_at: user.created_at,
              updated_at: user.updated_at,
            },
          },
        });
      } catch (error) {
        if (error instanceof AuthServiceError) {
          const statusCode = getStatusCodeForError(error.code);
          res.status(statusCode).json({
            success: false,
            error: error.message,
            code: error.code,
          });
          return;
        }

        logger.error('注册请求处理失败:', error);
        res.status(500).json({
          success: false,
          error: '服务器内部错误',
          code: 'INTERNAL_ERROR',
        });
      }
    },

    /**
     * POST /api/auth/login
     *
     * 用户登录接口
     * Body: { username: string, password: string }
     * 成功返回: 200 { success: true, data: { token, refreshToken, user } }
     * 凭据错误: 401 { success: false, error }
     */
    async login(req: Request, res: Response): Promise<void> {
      try {
        const { username, password } = req.body;

        // 基本参数检查
        if (!username || !password) {
          res.status(400).json({
            success: false,
            error: '缺少必要参数：username、password',
            code: 'MISSING_PARAMS',
          });
          return;
        }

        const result = await authService.loginWithUser(username, password);

        res.status(200).json({
          success: true,
          data: {
            token: result.tokenPair.accessToken,
            refreshToken: result.tokenPair.refreshToken,
            user: {
              id: result.user.id,
              username: result.user.username,
              email: result.user.email,
              tenantId: result.user.id,
            },
          },
        });
      } catch (error) {
        if (error instanceof AuthServiceError) {
          const statusCode = getStatusCodeForError(error.code);
          res.status(statusCode).json({
            success: false,
            error: error.message,
            code: error.code,
          });
          return;
        }

        logger.error('登录请求处理失败:', error);
        res.status(500).json({
          success: false,
          error: '服务器内部错误',
        });
      }
    },

    /**
     * POST /api/auth/refresh
     *
     * 令牌刷新接口
     * Body: { refreshToken: string }
     * 成功返回: 200 { success: true, data: { token, refreshToken } }
     * 令牌无效: 401 { success: false, error }
     */
    async refresh(req: Request, res: Response): Promise<void> {
      try {
        const { refreshToken } = req.body;

        // 基本参数检查
        if (!refreshToken) {
          res.status(400).json({
            success: false,
            error: '缺少必要参数：refreshToken',
            code: 'MISSING_PARAMS',
          });
          return;
        }

        const tokenPair = await authService.refreshToken(refreshToken);

        res.status(200).json({
          success: true,
          data: {
            token: tokenPair.accessToken,
            refreshToken: tokenPair.refreshToken,
          },
        });
      } catch (error) {
        if (error instanceof AuthServiceError) {
          const statusCode = getStatusCodeForError(error.code);
          res.status(statusCode).json({
            success: false,
            error: error.message,
            code: error.code,
          });
          return;
        }

        logger.error('令牌刷新请求处理失败:', error);
        res.status(500).json({
          success: false,
          error: '服务器内部错误',
        });
      }
    },
  };
}

/**
 * 根据 AuthServiceError code 映射 HTTP 状态码
 */
function getStatusCodeForError(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
    case 'MISSING_PARAMS':
      return 400;
    case 'INVALID_CREDENTIALS':
    case 'INVALID_TOKEN':
    case 'TOKEN_EXPIRED':
      return 401;
    case 'USER_NOT_FOUND':
      return 404;
    case 'USERNAME_CONFLICT':
    case 'EMAIL_CONFLICT':
      return 409;
    case 'INTERNAL_ERROR':
    default:
      return 500;
  }
}

// Export the helper for testing
export { getStatusCodeForError };
