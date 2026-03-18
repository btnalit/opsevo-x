/**
 * 认证中间件单元测试
 *
 * 测试 authMiddleware 核心功能：
 * - 有效 Bearer token：注入 tenantId 和 username，调用 next()
 * - 缺失 Authorization 头：返回 401
 * - 无效 Bearer 格式：返回 401
 * - 空 token：返回 401
 * - 过期/无效 JWT：返回 401
 *
 * Requirements: 4.4, 4.5
 */

import { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware } from './auth';
import { AuthService, AuthServiceError } from '../services/auth/authService';
import type { DataStore } from '../services/dataStore';
import { createMockPgDataStore } from '../test/helpers/mockPgDataStore';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'test-middleware-secret';

function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

function createMockRequest(headers: Record<string, string> = {}): Request {
  const req: Partial<Request> = {
    headers: headers as any,
    query: {},
  };
  return req as Request;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  let dataStore: DataStore;
  let authService: AuthService;
  let middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;

  beforeEach(async () => {
    dataStore = createMockPgDataStore();
    authService = new AuthService(dataStore, {
      jwtSecret: TEST_JWT_SECRET,
      saltRounds: 4,
    });
    middleware = createAuthMiddleware(authService);
  });

  afterEach(async () => {
    if (dataStore) {
      await dataStore.close();
    }
  });

  // ─── Valid Token ─────────────────────────────────────────────────────────

  describe('valid token', () => {
    it('should inject tenantId and username on valid token and call next()', async () => {
      const user = await authService.register('testuser', 'test@example.com', 'password123');
      const tokenPair = await authService.login('testuser', 'password123');

      const req = createMockRequest({
        authorization: `Bearer ${tokenPair.accessToken}`,
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(req.tenantId).toBe(user.id);
      expect(req.username).toBe('testuser');
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  // ─── Missing Authorization Header ───────────────────────────────────────

  describe('missing authorization header', () => {
    it('should return 401 when no Authorization header is present', async () => {
      const req = createMockRequest({});
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '未提供认证令牌' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Invalid Bearer Format ──────────────────────────────────────────────

  describe('invalid bearer format', () => {
    it('should return 401 when Authorization header is not Bearer format', async () => {
      const req = createMockRequest({
        authorization: 'Basic sometoken',
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '认证令牌格式无效，需要 Bearer token' }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when Authorization header has no space', async () => {
      const req = createMockRequest({
        authorization: 'Bearertoken',
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when Bearer token is empty', async () => {
      const req = createMockRequest({
        authorization: 'Bearer ',
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Invalid/Expired Token ──────────────────────────────────────────────

  describe('invalid or expired token', () => {
    it('should return 401 for an invalid JWT token', async () => {
      const req = createMockRequest({
        authorization: 'Bearer invalid.jwt.token',
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_TOKEN' }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 for an expired access token', async () => {
      const shortLivedService = new AuthService(dataStore, {
        jwtSecret: TEST_JWT_SECRET,
        saltRounds: 4,
        accessTokenExpiry: 1, // 1 second
      });
      const shortLivedMiddleware = createAuthMiddleware(shortLivedService);

      await shortLivedService.register('expiring', 'expire@example.com', 'password');
      const tokens = await shortLivedService.login('expiring', 'password');

      // Wait for the token to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const req = createMockRequest({
        authorization: `Bearer ${tokens.accessToken}`,
      });
      const res = createMockResponse();
      const next = jest.fn();

      await shortLivedMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when using a refresh token instead of access token', async () => {
      await authService.register('refreshuser', 'refresh@example.com', 'password');
      const tokens = await authService.login('refreshuser', 'password');

      const req = createMockRequest({
        authorization: `Bearer ${tokens.refreshToken}`,
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Does not modify response on success ────────────────────────────────

  describe('response behavior', () => {
    it('should not send any response on successful authentication', async () => {
      await authService.register('noresponse', 'noresponse@example.com', 'password');
      const tokens = await authService.login('noresponse', 'password');

      const req = createMockRequest({
        authorization: `Bearer ${tokens.accessToken}`,
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
