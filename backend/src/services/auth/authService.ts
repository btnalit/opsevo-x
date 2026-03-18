/**
 * AuthService - 用户认证服务
 *
 * 提供用户注册、登录、JWT 令牌管理功能：
 * - register()：用户名/邮箱唯一性检查、bcrypt 密码哈希、插入 users 表
 * - login()：凭据验证、生成 JWT access token（15 分钟）和 refresh token（7 天）
 * - refreshToken()：验证 refresh token、生成新 token pair
 * - validateToken()：JWT 验证、提取 tenant_id
 *
 * Requirements: 4.1, 4.2, 4.3, 4.6
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type { DataStore } from '../dataStore';
import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role?: string;
  created_at: string;
  updated_at: string;
}

export interface TokenPair {
  /** 短期令牌，15 分钟 */
  accessToken: string;
  /** 长期令牌，7 天 */
  refreshToken: string;
}

export interface TokenPayload {
  tenantId: string;
  username: string;
  type: 'access' | 'refresh';
}

export interface AuthServiceOptions {
  /** JWT 签名密钥 */
  jwtSecret?: string;
  /** Access token 过期时间（秒），默认 900（15 分钟） */
  accessTokenExpiry?: number;
  /** Refresh token 过期时间（秒），默认 604800（7 天） */
  refreshTokenExpiry?: number;
  /** bcrypt salt rounds，默认 10 */
  saltRounds?: number;
}

/**
 * AuthService 结构化错误
 */
export class AuthServiceError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AuthServiceError';
    this.code = code;
  }
}

// ─── AuthService Class ───────────────────────────────────────────────────────

export class AuthService {
  private dataStore: DataStore;
  private readonly jwtSecret: string;
  private readonly accessTokenExpiry: number;
  private readonly refreshTokenExpiry: number;
  private readonly saltRounds: number;

  constructor(dataStore: DataStore, options: AuthServiceOptions = {}) {
    this.dataStore = dataStore;
    this.jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET ?? 'default-jwt-secret-change-in-production';
    this.accessTokenExpiry = options.accessTokenExpiry ?? 900;       // 15 minutes
    this.refreshTokenExpiry = options.refreshTokenExpiry ?? 604800;  // 7 days
    this.saltRounds = options.saltRounds ?? 10;
  }

  /**
   * 注入 PgDataStore（向后兼容，替换构造函数注入的 DataStore）
   */
  setPgDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('AuthService: PgDataStore injected, using PostgreSQL for user storage');
  }

  // ─── Public Methods ──────────────────────────────────────────────────────

  /**
   * 用户注册
   *
   * - 检查用户名和邮箱唯一性
   * - 使用 bcrypt 哈希密码
   * - 插入 users 表
   *
   * @param username 用户名
   * @param email 邮箱
   * @param password 明文密码
   * @returns 创建的用户对象（不含密码哈希）
   * @throws AuthServiceError 用户名或邮箱已存在时抛出 CONFLICT 错误
   */
  async register(username: string, email: string, password: string): Promise<User> {
    if (!username || username.trim().length === 0) {
      throw new AuthServiceError('用户名不能为空', 'INVALID_INPUT');
    }
    if (!email || email.trim().length === 0) {
      throw new AuthServiceError('邮箱不能为空', 'INVALID_INPUT');
    }
    if (!password || password.length === 0) {
      throw new AuthServiceError('密码不能为空', 'INVALID_INPUT');
    }

    try {
      const existingByUsername = await this.dataStore.query<User>(
        'SELECT id FROM users WHERE username = $1', [username]);
      if (existingByUsername.length > 0) {
        throw new AuthServiceError('用户名已存在', 'USERNAME_CONFLICT');
      }
      const existingByEmail = await this.dataStore.query<User>(
        'SELECT id FROM users WHERE email = $1', [email]);
      if (existingByEmail.length > 0) {
        throw new AuthServiceError('邮箱已存在', 'EMAIL_CONFLICT');
      }
      const passwordHash = await bcrypt.hash(password, this.saltRounds);
      const userId = uuidv4();
      await this.dataStore.execute(
        `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)`,
        [userId, username, email, passwordHash]);
      const users = await this.dataStore.query<User>(
        'SELECT * FROM users WHERE id = $1', [userId]);
      if (users.length === 0) {
        throw new AuthServiceError('用户创建失败', 'INTERNAL_ERROR');
      }
      logger.info(`用户注册成功: ${username} (${userId})`);
      return users[0];
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`用户注册失败: ${err.message}`);
      throw new AuthServiceError(`注册失败: ${err.message}`, 'INTERNAL_ERROR');
    }
  }

  /**
   * 用户登录
   */
  async login(username: string, password: string): Promise<TokenPair> {
    const result = await this.loginWithUser(username, password);
    return result.tokenPair;
  }

  /**
   * 用户登录（含用户信息）
   */
  async loginWithUser(username: string, password: string): Promise<{ tokenPair: TokenPair; user: User }> {
    if (!username || username.trim().length === 0) {
      throw new AuthServiceError('用户名不能为空', 'INVALID_INPUT');
    }
    if (!password || password.length === 0) {
      throw new AuthServiceError('密码不能为空', 'INVALID_INPUT');
    }

    try {
      const users = await this.dataStore.query<User>(
        'SELECT * FROM users WHERE username = $1', [username]);
      if (users.length === 0) {
        throw new AuthServiceError('用户名或密码错误', 'INVALID_CREDENTIALS');
      }
      const user = users[0];
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordValid) {
        throw new AuthServiceError('用户名或密码错误', 'INVALID_CREDENTIALS');
      }
      const tokenPair = this.generateTokenPair(user.id, user.username);
      logger.info(`用户登录成功: ${username} (${user.id})`);
      return { tokenPair, user };
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`用户登录失败: ${err.message}`);
      throw new AuthServiceError(`登录失败: ${err.message}`, 'INTERNAL_ERROR');
    }
  }

  /**
   * 刷新令牌
   */
  async refreshToken(refreshToken: string): Promise<TokenPair> {
    if (!refreshToken || refreshToken.trim().length === 0) {
      throw new AuthServiceError('Refresh token 不能为空', 'INVALID_INPUT');
    }

    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret) as TokenPayload & { iat: number; exp: number };
      if (decoded.type !== 'refresh') {
        throw new AuthServiceError('无效的 refresh token 类型', 'INVALID_TOKEN');
      }

      const users = await this.dataStore.query<User>(
        'SELECT * FROM users WHERE id = $1', [decoded.tenantId]);
      if (users.length === 0) {
        throw new AuthServiceError('用户不存在', 'USER_NOT_FOUND');
      }

      const tokenPair = this.generateTokenPair(decoded.tenantId, decoded.username);
      logger.info(`令牌刷新成功: ${decoded.username} (${decoded.tenantId})`);
      return tokenPair;
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthServiceError('Refresh token 已过期', 'TOKEN_EXPIRED');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthServiceError('无效的 refresh token', 'INVALID_TOKEN');
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`令牌刷新失败: ${err.message}`);
      throw new AuthServiceError(`令牌刷新失败: ${err.message}`, 'INTERNAL_ERROR');
    }
  }

  /**
   * 验证令牌
   */
  async validateToken(token: string): Promise<{ tenantId: string; username: string }> {
    if (!token || token.trim().length === 0) {
      throw new AuthServiceError('令牌不能为空', 'INVALID_INPUT');
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret) as TokenPayload & { iat: number; exp: number };
      if (decoded.type !== 'access') {
        throw new AuthServiceError('无效的令牌类型，需要 access token', 'INVALID_TOKEN');
      }

      const users = await this.dataStore.query<User>(
        'SELECT id FROM users WHERE id = $1', [decoded.tenantId]);
      if (users.length === 0) {
        throw new AuthServiceError('用户不存在或已删除', 'USER_NOT_FOUND');
      }

      return {
        tenantId: decoded.tenantId,
        username: decoded.username,
      };
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthServiceError('令牌已过期', 'TOKEN_EXPIRED');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthServiceError('无效的令牌', 'INVALID_TOKEN');
      }
      const err = error instanceof Error ? error : new Error(String(error));
      throw new AuthServiceError(`令牌验证失败: ${err.message}`, 'INTERNAL_ERROR');
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * 生成 access token 和 refresh token 对
   */
  private generateTokenPair(tenantId: string, username: string): TokenPair {
    const accessToken = jwt.sign(
      { tenantId, username, type: 'access' } as TokenPayload,
      this.jwtSecret,
      { expiresIn: this.accessTokenExpiry },
    );

    const refreshToken = jwt.sign(
      { tenantId, username, type: 'refresh' } as TokenPayload,
      this.jwtSecret,
      { expiresIn: this.refreshTokenExpiry },
    );

    return { accessToken, refreshToken };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export default AuthService;
