/**
 * OAuthToolCallInterceptor - OAuth 拦截器
 *
 * 实现 ToolCallInterceptor 接口，在外部 MCP 工具调用前
 * 自动注入 OAuth Bearer token 到请求 headers。
 *
 * Requirements: 16.3
 */

import { OAuthTokenManager, OAuthConfig } from './oauthTokenManager';
import { logger } from '../../utils/logger';

// ─── Interceptor Types（共享接口） ───────────────────────────────────────────

/** 工具调用上下文（在拦截器链中传递） */
export interface ToolCallContext {
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
}

/** 工具调用拦截器接口 */
export interface ToolCallInterceptor {
  name: string;
  intercept(context: ToolCallContext): Promise<ToolCallContext>;
}

// ─── OAuthToolCallInterceptor ────────────────────────────────────────────────

export class OAuthToolCallInterceptor implements ToolCallInterceptor {
  readonly name = 'oauth-interceptor';
  private oauthManager: OAuthTokenManager;
  private oauthConfigs: Map<string, OAuthConfig> = new Map();

  constructor(oauthManager: OAuthTokenManager) {
    this.oauthManager = oauthManager;
  }

  /**
   * 注册 server 的 OAuth 配置
   */
  registerServerOAuth(serverId: string, config: OAuthConfig): void {
    this.oauthConfigs.set(serverId, config);
    logger.info(`[OAuthInterceptor] Registered OAuth config for server: ${serverId}`);
  }

  /**
   * 注销 server 的 OAuth 配置
   */
  unregisterServerOAuth(serverId: string): void {
    this.oauthConfigs.delete(serverId);
    this.oauthManager.clearToken(serverId);
  }

  /**
   * 拦截工具调用，注入 OAuth Bearer token
   * 若该 server 无 OAuth 配置则直接透传
   */
  async intercept(context: ToolCallContext): Promise<ToolCallContext> {
    const config = this.oauthConfigs.get(context.serverId);
    if (!config) {
      // 无 OAuth 配置，直接透传
      return context;
    }

    try {
      const token = await this.oauthManager.getToken(context.serverId, config);
      return {
        ...context,
        headers: {
          ...context.headers,
          Authorization: `${token.tokenType} ${token.accessToken}`,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[OAuthInterceptor] Failed to get token for server ${context.serverId}: ${msg}`);
      throw new Error(`OAuth token acquisition failed for server ${context.serverId}: ${msg}`);
    }
  }
}
