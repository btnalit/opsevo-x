/**
 * AuthService 单元测试
 *
 * 测试 AuthService 核心功能：
 * - register()：用户注册、唯一性检查、密码哈希
 * - login()：凭据验证、JWT 令牌生成
 * - refreshToken()：令牌刷新
 * - validateToken()：令牌验证、tenant_id 提取
 * - 错误处理（无效输入、重复注册、错误凭据等）
 *
 * Requirements: 4.1, 4.2, 4.3, 4.6
 */

import type { DataStore } from '../dataStore';
import { createMockPgDataStore } from '../../test/helpers/mockPgDataStore';
import { AuthService, AuthServiceError, User, TokenPair } from './authService';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'test-secret-key-for-unit-tests';

/**
 * Create a mock PgDataStore for testing.
 */
async function createTestDataStore(): Promise<DataStore> {
  return createMockPgDataStore();
}

/** Create an AuthService with test configuration */
function createTestAuthService(dataStore: DataStore, options?: { accessTokenExpiry?: number; refreshTokenExpiry?: number }): AuthService {
  return new AuthService(dataStore, {
    jwtSecret: TEST_JWT_SECRET,
    saltRounds: 4, // Lower rounds for faster tests
    ...options,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let dataStore: DataStore;
  let authService: AuthService;

  beforeEach(async () => {
    dataStore = await createTestDataStore();
    authService = createTestAuthService(dataStore);
  });

  afterEach(async () => {
    if (dataStore) {
      await dataStore.close();
    }
  });

  // ─── register() ──────────────────────────────────────────────────────────

  describe('register', () => {
    it('should register a new user successfully', async () => {
      const user = await authService.register('testuser', 'test@example.com', 'password123');

      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.username).toBe('testuser');
      expect(user.email).toBe('test@example.com');
      expect(user.password_hash).toBeDefined();
      expect(user.created_at).toBeDefined();
      expect(user.updated_at).toBeDefined();
    });

    it('should hash the password with bcrypt', async () => {
      const password = 'mySecurePassword';
      const user = await authService.register('hashtest', 'hash@example.com', password);

      // Password hash should not equal the plain text password
      expect(user.password_hash).not.toBe(password);

      // bcrypt.compare should return true for the original password
      const isMatch = await bcrypt.compare(password, user.password_hash);
      expect(isMatch).toBe(true);
    });

    it('should reject duplicate username', async () => {
      await authService.register('duplicate', 'first@example.com', 'password1');

      await expect(
        authService.register('duplicate', 'second@example.com', 'password2'),
      ).rejects.toThrow(AuthServiceError);

      await expect(
        authService.register('duplicate', 'second@example.com', 'password2'),
      ).rejects.toThrow('用户名已存在');
    });

    it('should reject duplicate email', async () => {
      await authService.register('user1', 'same@example.com', 'password1');

      await expect(
        authService.register('user2', 'same@example.com', 'password2'),
      ).rejects.toThrow(AuthServiceError);

      await expect(
        authService.register('user2', 'same@example.com', 'password2'),
      ).rejects.toThrow('邮箱已存在');
    });

    it('should reject empty username', async () => {
      await expect(
        authService.register('', 'test@example.com', 'password'),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject empty email', async () => {
      await expect(
        authService.register('testuser', '', 'password'),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject empty password', async () => {
      await expect(
        authService.register('testuser', 'test@example.com', ''),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should generate unique user IDs', async () => {
      const user1 = await authService.register('user1', 'user1@example.com', 'pass1');
      const user2 = await authService.register('user2', 'user2@example.com', 'pass2');

      expect(user1.id).not.toBe(user2.id);
    });

    it('should store user in the database', async () => {
      const user = await authService.register('dbuser', 'db@example.com', 'password');

      const rows = await dataStore.query<User>(
        'SELECT * FROM users WHERE id = $1',
        [user.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].username).toBe('dbuser');
      expect(rows[0].email).toBe('db@example.com');
    });
  });

  // ─── login() ─────────────────────────────────────────────────────────────

  describe('login', () => {
    beforeEach(async () => {
      await authService.register('loginuser', 'login@example.com', 'correctPassword');
    });

    it('should login with correct credentials and return token pair', async () => {
      const tokenPair = await authService.login('loginuser', 'correctPassword');

      expect(tokenPair).toBeDefined();
      expect(tokenPair.accessToken).toBeDefined();
      expect(tokenPair.refreshToken).toBeDefined();
      expect(typeof tokenPair.accessToken).toBe('string');
      expect(typeof tokenPair.refreshToken).toBe('string');
    });

    it('should generate a valid access token with correct payload', async () => {
      const tokenPair = await authService.login('loginuser', 'correctPassword');

      const decoded = jwt.verify(tokenPair.accessToken, TEST_JWT_SECRET) as any;
      expect(decoded.username).toBe('loginuser');
      expect(decoded.tenantId).toBeDefined();
      expect(decoded.type).toBe('access');
    });

    it('should generate a valid refresh token with correct payload', async () => {
      const tokenPair = await authService.login('loginuser', 'correctPassword');

      const decoded = jwt.verify(tokenPair.refreshToken, TEST_JWT_SECRET) as any;
      expect(decoded.username).toBe('loginuser');
      expect(decoded.tenantId).toBeDefined();
      expect(decoded.type).toBe('refresh');
    });

    it('should reject login with wrong password', async () => {
      await expect(
        authService.login('loginuser', 'wrongPassword'),
      ).rejects.toThrow(AuthServiceError);

      await expect(
        authService.login('loginuser', 'wrongPassword'),
      ).rejects.toThrow('用户名或密码错误');
    });

    it('should reject login with non-existent username', async () => {
      await expect(
        authService.login('nonexistent', 'anyPassword'),
      ).rejects.toThrow(AuthServiceError);

      await expect(
        authService.login('nonexistent', 'anyPassword'),
      ).rejects.toThrow('用户名或密码错误');
    });

    it('should reject login with empty username', async () => {
      await expect(
        authService.login('', 'password'),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject login with empty password', async () => {
      await expect(
        authService.login('loginuser', ''),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should set access token tenant_id to the user id', async () => {
      const users = await dataStore.query<User>(
        'SELECT * FROM users WHERE username = $1',
        ['loginuser'],
      );
      const tokenPair = await authService.login('loginuser', 'correctPassword');

      const decoded = jwt.verify(tokenPair.accessToken, TEST_JWT_SECRET) as any;
      expect(decoded.tenantId).toBe(users[0].id);
    });
  });

  // ─── refreshToken() ──────────────────────────────────────────────────────

  describe('refreshToken', () => {
    let validTokenPair: TokenPair;

    beforeEach(async () => {
      await authService.register('refreshuser', 'refresh@example.com', 'password');
      validTokenPair = await authService.login('refreshuser', 'password');
    });

    it('should return a new token pair with a valid refresh token', async () => {
      const newTokenPair = await authService.refreshToken(validTokenPair.refreshToken);

      expect(newTokenPair).toBeDefined();
      expect(newTokenPair.accessToken).toBeDefined();
      expect(newTokenPair.refreshToken).toBeDefined();
    });

    it('should preserve tenant_id in the new tokens', async () => {
      const originalDecoded = jwt.verify(validTokenPair.accessToken, TEST_JWT_SECRET) as any;
      const newTokenPair = await authService.refreshToken(validTokenPair.refreshToken);
      const newDecoded = jwt.verify(newTokenPair.accessToken, TEST_JWT_SECRET) as any;

      expect(newDecoded.tenantId).toBe(originalDecoded.tenantId);
      expect(newDecoded.username).toBe(originalDecoded.username);
    });

    it('should reject an access token used as refresh token', async () => {
      await expect(
        authService.refreshToken(validTokenPair.accessToken),
      ).rejects.toThrow(AuthServiceError);

      await expect(
        authService.refreshToken(validTokenPair.accessToken),
      ).rejects.toThrow('无效的 refresh token 类型');
    });

    it('should reject an expired refresh token', async () => {
      // Create a service with very short refresh token expiry
      const shortLivedService = createTestAuthService(dataStore, {
        refreshTokenExpiry: 1, // 1 second
      });

      await shortLivedService.register('shortlived', 'short@example.com', 'password');
      const tokens = await shortLivedService.login('shortlived', 'password');

      // Wait for the token to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await expect(
        shortLivedService.refreshToken(tokens.refreshToken),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject an invalid refresh token', async () => {
      await expect(
        authService.refreshToken('invalid.token.string'),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject an empty refresh token', async () => {
      await expect(
        authService.refreshToken(''),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject a refresh token signed with a different secret', async () => {
      const fakeToken = jwt.sign(
        { tenantId: 'fake-id', username: 'fake', type: 'refresh' },
        'different-secret',
        { expiresIn: 3600 },
      );

      await expect(
        authService.refreshToken(fakeToken),
      ).rejects.toThrow(AuthServiceError);
    });
  });

  // ─── validateToken() ─────────────────────────────────────────────────────

  describe('validateToken', () => {
    let validTokenPair: TokenPair;
    let userId: string;

    beforeEach(async () => {
      const user = await authService.register('validateuser', 'validate@example.com', 'password');
      userId = user.id;
      validTokenPair = await authService.login('validateuser', 'password');
    });

    it('should validate a valid access token and return tenant info', async () => {
      const result = await authService.validateToken(validTokenPair.accessToken);

      expect(result).toBeDefined();
      expect(result.tenantId).toBe(userId);
      expect(result.username).toBe('validateuser');
    });

    it('should reject a refresh token used as access token', async () => {
      await expect(
        authService.validateToken(validTokenPair.refreshToken),
      ).rejects.toThrow(AuthServiceError);

      await expect(
        authService.validateToken(validTokenPair.refreshToken),
      ).rejects.toThrow('无效的令牌类型');
    });

    it('should reject an expired access token', async () => {
      const shortLivedService = createTestAuthService(dataStore, {
        accessTokenExpiry: 1, // 1 second
      });

      await shortLivedService.register('expiring', 'expire@example.com', 'password');
      const tokens = await shortLivedService.login('expiring', 'password');

      // Wait for the token to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await expect(
        shortLivedService.validateToken(tokens.accessToken),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject an invalid token', async () => {
      await expect(
        authService.validateToken('not.a.valid.jwt'),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject an empty token', async () => {
      await expect(
        authService.validateToken(''),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject a token signed with a different secret', async () => {
      const fakeToken = jwt.sign(
        { tenantId: 'fake-id', username: 'fake', type: 'access' },
        'wrong-secret',
        { expiresIn: 3600 },
      );

      await expect(
        authService.validateToken(fakeToken),
      ).rejects.toThrow(AuthServiceError);
    });

    it('should reject a tampered token', async () => {
      // Tamper with the token by changing a character
      const tampered = validTokenPair.accessToken.slice(0, -2) + 'XX';

      await expect(
        authService.validateToken(tampered),
      ).rejects.toThrow(AuthServiceError);
    });
  });

  // ─── Integration: register → login → validate ────────────────────────────

  describe('full flow: register → login → validate → refresh', () => {
    it('should complete the full authentication flow', async () => {
      // 1. Register
      const user = await authService.register('flowuser', 'flow@example.com', 'securePass123');
      expect(user.username).toBe('flowuser');

      // 2. Login
      const tokenPair = await authService.login('flowuser', 'securePass123');
      expect(tokenPair.accessToken).toBeDefined();

      // 3. Validate access token
      const validated = await authService.validateToken(tokenPair.accessToken);
      expect(validated.tenantId).toBe(user.id);
      expect(validated.username).toBe('flowuser');

      // 4. Refresh token
      const newTokenPair = await authService.refreshToken(tokenPair.refreshToken);
      expect(newTokenPair.accessToken).toBeDefined();

      // 5. Validate new access token
      const revalidated = await authService.validateToken(newTokenPair.accessToken);
      expect(revalidated.tenantId).toBe(user.id);
      expect(revalidated.username).toBe('flowuser');
    });
  });
});
