/**
 * OAuthTokenManager - OAuth 令牌管理器
 *
 * 管理外部 MCP Server 的 OAuth 令牌获取、缓存和自动刷新。
 * 支持 client_credentials 和 refresh_token 两种 grant_type。
 * 使用 per-server async-mutex + double-check 模式确保并发安全。
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */

import { Mutex } from 'async-mutex';
import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/** OAuth 配置 */
export interface OAuthConfig {
  token_url: string;
  grant_type: 'client_credentials' | 'refresh_token';
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  scope?: string;
  /** 提前刷新秒数（距过期 < 此值则判定需刷新），默认 60 */
  refresh_skew_seconds?: number;
  /** 自定义字段映射 */
  token_field?: string;        // 默认 "access_token"
  token_type_field?: string;   // 默认 "token_type"
  expires_in_field?: string;   // 默认 "expires_in"
}

/** 缓存的 OAuth 令牌 */
export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;  // Unix timestamp (ms)
  refreshToken?: string;
}

// ─── OAuthTokenManager ──────────────────────────────────────────────────────

export class OAuthTokenManager {
  private tokenCache: Map<string, OAuthToken> = new Map();
  private locks: Map<string, Mutex> = new Map();
  private fetchTimeoutMs: number;

  constructor(fetchTimeoutMs: number = 10_000) {
    this.fetchTimeoutMs = fetchTimeoutMs;
  }

  /**
   * 获取有效令牌（缓存优先，过期则刷新）
   */
  async getToken(serverId: string, config: OAuthConfig): Promise<OAuthToken> {
    const skew = (config.refresh_skew_seconds ?? 60) * 1000;

    // 快速路径：缓存命中且未过期
    const cached = this.tokenCache.get(serverId);
    if (cached && !this.isTokenExpiringSoon(cached, skew)) {
      return cached;
    }

    // 获取 per-server lock
    const lock = this.getOrCreateLock(serverId);
    return lock.runExclusive(async () => {
      // double-check：锁内再次检查缓存
      const rechecked = this.tokenCache.get(serverId);
      if (rechecked && !this.isTokenExpiringSoon(rechecked, skew)) {
        return rechecked;
      }

      // 获取新令牌
      const token = await this.fetchToken(config);
      this.tokenCache.set(serverId, token);
      logger.info(`[OAuthTokenManager] Token acquired for server: ${serverId}`);
      return token;
    });
  }

  /**
   * 强制刷新令牌
   */
  async refreshToken(serverId: string, config: OAuthConfig): Promise<OAuthToken> {
    const lock = this.getOrCreateLock(serverId);
    return lock.runExclusive(async () => {
      const token = await this.fetchToken(config);
      this.tokenCache.set(serverId, token);
      logger.info(`[OAuthTokenManager] Token refreshed for server: ${serverId}`);
      return token;
    });
  }

  /**
   * 通过 HTTP POST 请求 token_url 获取令牌
   */
  async fetchToken(config: OAuthConfig): Promise<OAuthToken> {
    const body = new URLSearchParams();
    body.append('grant_type', config.grant_type);
    body.append('client_id', config.client_id);
    body.append('client_secret', config.client_secret);

    if (config.grant_type === 'refresh_token' && config.refresh_token) {
      body.append('refresh_token', config.refresh_token);
    }
    if (config.scope) {
      body.append('scope', config.scope);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      const response = await fetch(config.token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`OAuth token request failed: ${response.status} ${response.statusText} — ${text}`);
      }

      const data = await response.json() as Record<string, any>;
      return this.parseTokenResponse(data, config);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OAuth token request timed out after ${this.fetchTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 解析 token 响应（支持自定义字段映射）
   */
  parseTokenResponse(response: Record<string, any>, config: OAuthConfig): OAuthToken {
    const tokenField = config.token_field || 'access_token';
    const tokenTypeField = config.token_type_field || 'token_type';
    const expiresInField = config.expires_in_field || 'expires_in';

    const accessToken = response[tokenField];
    if (!accessToken || typeof accessToken !== 'string') {
      throw new Error(`OAuth response missing or invalid token field: ${tokenField}`);
    }

    const tokenType = response[tokenTypeField] || 'Bearer';
    const expiresIn = Number(response[expiresInField]) || 3600; // 默认 1 小时
    const expiresAt = Date.now() + expiresIn * 1000;

    return {
      accessToken,
      tokenType: String(tokenType),
      expiresAt,
      refreshToken: response.refresh_token,
    };
  }

  /**
   * 判断令牌是否即将过期
   */
  isTokenExpiringSoon(token: OAuthToken, skewMs: number): boolean {
    return Date.now() >= token.expiresAt - skewMs;
  }

  /**
   * 清除指定 server 的缓存令牌
   */
  clearToken(serverId: string): void {
    this.tokenCache.delete(serverId);
  }

  /**
   * 获取或创建 per-server lock
   */
  private getOrCreateLock(serverId: string): Mutex {
    let lock = this.locks.get(serverId);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(serverId, lock);
    }
    return lock;
  }
}
