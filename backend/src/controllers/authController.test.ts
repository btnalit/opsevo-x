/**
 * 认证控制器单元测试
 *
 * 测试 authController 核心功能：
 * - register：成功注册、缺少参数、重复用户名/邮箱
 * - login：成功登录、缺少参数、错误凭据
 * - refresh：成功刷新、缺少参数、无效 token
 *
 * Requirements: 4.1, 4.2, 4.4, 4.5, 4.6
 */

import { Request, Response } from 'express';
import { createAuthController, getStatusCodeForError } from './authController';
import { AuthService } from '../services/auth/authService';
import { DataStore } from '../services/core/dataStore';
import * as path from 'path';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'test-controller-secret';

async function createTestDataStore(): Promise<DataStore> {
  const store = new DataStore({
    inMemory: true,
    migrationsPath: path.join(__dirname, '__no_migrations__'),
  });
  await store.initialize();

  store.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  return store;
}

function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

function createMockRequest(body: Record<string, any> = {}): Request {
  const req: Partial<Request> = {
    body,
  };
  return req as Request;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authController', () => {
  let dataStore: DataStore;
  let authService: AuthService;
  let controller: ReturnType<typeof createAuthController>;

  beforeEach(async () => {
    dataStore = await createTestDataStore();
    authService = new AuthService(dataStore, {
      jwtSecret: TEST_JWT_SECRET,
      saltRounds: 4,
    });
    controller = createAuthController(authService);
  });

  afterEach(async () => {
    if (dataStore) {
      await dataStore.close();
    }
  });

  // ─── register ────────────────────────────────────────────────────────────

  describe('register', () => {
    it('should register a new user and return 201', async () => {
      const req = createMockRequest({
        username: 'newuser',
        email: 'new@example.com',
        password: 'password123',
        invitationCode: 'OpsEvo888',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            user: expect.objectContaining({
              username: 'newuser',
              email: 'new@example.com',
            }),
          }),
        }),
      );
    });

    it('should not include password_hash in the response', async () => {
      const req = createMockRequest({
        username: 'nohash',
        email: 'nohash@example.com',
        password: 'password123',
        invitationCode: 'OpsEvo888',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.data.user.password_hash).toBeUndefined();
    });

    it('should return 400 when username is missing', async () => {
      const req = createMockRequest({
        email: 'test@example.com',
        password: 'password123',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MISSING_PARAMS' }),
      );
    });

    it('should return 400 when email is missing', async () => {
      const req = createMockRequest({
        username: 'testuser',
        password: 'password123',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when password is missing', async () => {
      const req = createMockRequest({
        username: 'testuser',
        email: 'test@example.com',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 409 when username already exists', async () => {
      // Register first user
      await authService.register('duplicate', 'first@example.com', 'password');

      const req = createMockRequest({
        username: 'duplicate',
        email: 'second@example.com',
        password: 'password123',
        invitationCode: 'OpsEvo888',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'USERNAME_CONFLICT' }),
      );
    });

    it('should return 409 when email already exists', async () => {
      await authService.register('user1', 'same@example.com', 'password');

      const req = createMockRequest({
        username: 'user2',
        email: 'same@example.com',
        password: 'password123',
        invitationCode: 'OpsEvo888',
      });
      const res = createMockResponse();

      await controller.register(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'EMAIL_CONFLICT' }),
      );
    });
  });

  // ─── login ───────────────────────────────────────────────────────────────

  describe('login', () => {
    beforeEach(async () => {
      await authService.register('loginuser', 'login@example.com', 'correctPassword');
    });

    it('should login successfully and return 200 with tokens', async () => {
      const req = createMockRequest({
        username: 'loginuser',
        password: 'correctPassword',
      });
      const res = createMockResponse();

      await controller.login(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.success).toBe(true);
      expect(responseBody.data.token).toBeDefined();
      expect(responseBody.data.refreshToken).toBeDefined();
      expect(typeof responseBody.data.token).toBe('string');
      expect(typeof responseBody.data.refreshToken).toBe('string');
    });

    it('should return 400 when username is missing', async () => {
      const req = createMockRequest({
        password: 'password',
      });
      const res = createMockResponse();

      await controller.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MISSING_PARAMS' }),
      );
    });

    it('should return 400 when password is missing', async () => {
      const req = createMockRequest({
        username: 'loginuser',
      });
      const res = createMockResponse();

      await controller.login(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 401 for wrong password', async () => {
      const req = createMockRequest({
        username: 'loginuser',
        password: 'wrongPassword',
      });
      const res = createMockResponse();

      await controller.login(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_CREDENTIALS' }),
      );
    });

    it('should return 401 for non-existent user', async () => {
      const req = createMockRequest({
        username: 'nonexistent',
        password: 'anyPassword',
      });
      const res = createMockResponse();

      await controller.login(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_CREDENTIALS' }),
      );
    });
  });

  // ─── refresh ─────────────────────────────────────────────────────────────

  describe('refresh', () => {
    let validRefreshToken: string;

    beforeEach(async () => {
      await authService.register('refreshuser', 'refresh@example.com', 'password');
      const tokens = await authService.login('refreshuser', 'password');
      validRefreshToken = tokens.refreshToken;
    });

    it('should refresh tokens successfully and return 200', async () => {
      const req = createMockRequest({
        refreshToken: validRefreshToken,
      });
      const res = createMockResponse();

      await controller.refresh(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const responseBody = (res.json as jest.Mock).mock.calls[0][0];
      expect(responseBody.success).toBe(true);
      expect(responseBody.data.token).toBeDefined();
      expect(responseBody.data.refreshToken).toBeDefined();
    });

    it('should return 400 when refreshToken is missing', async () => {
      const req = createMockRequest({});
      const res = createMockResponse();

      await controller.refresh(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MISSING_PARAMS' }),
      );
    });

    it('should return 401 for invalid refresh token', async () => {
      const req = createMockRequest({
        refreshToken: 'invalid.token.string',
      });
      const res = createMockResponse();

      await controller.refresh(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_TOKEN' }),
      );
    });
  });

  // ─── getStatusCodeForError ───────────────────────────────────────────────

  describe('getStatusCodeForError', () => {
    it('should return 400 for INVALID_INPUT', () => {
      expect(getStatusCodeForError('INVALID_INPUT')).toBe(400);
    });

    it('should return 401 for INVALID_CREDENTIALS', () => {
      expect(getStatusCodeForError('INVALID_CREDENTIALS')).toBe(401);
    });

    it('should return 401 for INVALID_TOKEN', () => {
      expect(getStatusCodeForError('INVALID_TOKEN')).toBe(401);
    });

    it('should return 401 for TOKEN_EXPIRED', () => {
      expect(getStatusCodeForError('TOKEN_EXPIRED')).toBe(401);
    });

    it('should return 409 for USERNAME_CONFLICT', () => {
      expect(getStatusCodeForError('USERNAME_CONFLICT')).toBe(409);
    });

    it('should return 409 for EMAIL_CONFLICT', () => {
      expect(getStatusCodeForError('EMAIL_CONFLICT')).toBe(409);
    });

    it('should return 404 for USER_NOT_FOUND', () => {
      expect(getStatusCodeForError('USER_NOT_FOUND')).toBe(404);
    });

    it('should return 500 for unknown error codes', () => {
      expect(getStatusCodeForError('UNKNOWN')).toBe(500);
    });
  });
});
