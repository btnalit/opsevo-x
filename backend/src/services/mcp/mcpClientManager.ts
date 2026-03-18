/**
 * McpClientManager - 外部 MCP Server 连接管理
 *
 * 管理与外部 MCP Server 的连接（stdio/SSE/HTTP 三种传输），
 * 工具发现，拦截器链，健康检查，配置热更新。
 *
 * Requirements: 7.1-7.6, 8.2-8.3, 16.1-16.5, 17.1-17.5, 18.1-18.5
 */

import { Mutex } from 'async-mutex';
import * as fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../../utils/logger';
import { auditLogger } from '../ai-ops/auditLogger';
import { ToolRegistry, McpToolDefinition, IToolForwarder } from './toolRegistry';
import { EnvVarResolver } from './envVarResolver';
import { OAuthTokenManager, OAuthConfig } from './oauthTokenManager';
import { OAuthToolCallInterceptor, ToolCallContext, ToolCallInterceptor } from './oauthInterceptor';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 外部 MCP Server 配置 */
export interface McpServerConfig {
  serverId: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  enabled: boolean;
  connectionParams: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  oauth?: OAuthConfig;
}

/** MCP 连接状态 */
interface McpConnection {
  serverId: string;
  client: Client;
  transport: Transport;
  status: 'connecting' | 'connected' | 'disconnected';
  discoveredTools: McpToolDefinition[];
  lastHealthCheck: number;
  lock: Mutex;
  consecutiveFailures: number;
  lastConfigMtime: number;
  config: McpServerConfig;
}

// ─── McpClientManager ────────────────────────────────────────────────────────

export class McpClientManager implements IToolForwarder {
  private connections: Map<string, McpConnection> = new Map();
  private configChangeLock = new Mutex();
  private toolRegistry: ToolRegistry;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private interceptors: ToolCallInterceptor[] = [];
  private oauthManager: OAuthTokenManager | null = null;
  private oauthInterceptor: OAuthToolCallInterceptor | null = null;
  private configFilePath: string;
  private forwardTimeoutMs: number;
  private healthCheckIntervalMs: number;
  private healthCheckTimeoutMs: number;
  private maxConsecutiveFailures: number;

  constructor(
    toolRegistry: ToolRegistry,
    configFilePath: string,
    options?: {
      forwardTimeoutMs?: number;
      healthCheckIntervalMs?: number;
      healthCheckTimeoutMs?: number;
      maxConsecutiveFailures?: number;
    }
  ) {
    this.toolRegistry = toolRegistry;
    this.configFilePath = configFilePath;
    this.forwardTimeoutMs = options?.forwardTimeoutMs ?? 30_000;
    this.healthCheckIntervalMs = options?.healthCheckIntervalMs ?? 30_000;
    this.healthCheckTimeoutMs = options?.healthCheckTimeoutMs ?? 5_000;
    this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 3;

    // 注入自身作为 ToolForwarder
    this.toolRegistry.setToolForwarder(this);
  }

  /**
   * 初始化：从配置读取并连接所有 enabled 的外部 Server
   */
  async initialize(configs: McpServerConfig[]): Promise<void> {
    // 解析环境变量
    const resolvedConfigs = configs.map(c => EnvVarResolver.resolve(c));

    // 检查是否需要 OAuth
    const hasOAuth = resolvedConfigs.some(c => c.oauth);
    if (hasOAuth) {
      this.oauthManager = new OAuthTokenManager();
      this.oauthInterceptor = new OAuthToolCallInterceptor(this.oauthManager);
      this.registerInterceptor(this.oauthInterceptor);
    }

    // 连接所有 enabled 的 server
    for (const config of resolvedConfigs) {
      if (!config.enabled) continue;

      // 注册 OAuth 配置
      if (config.oauth && this.oauthInterceptor) {
        this.oauthInterceptor.registerServerOAuth(config.serverId, config.oauth);
      }

      try {
        await this.connectServer(config);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[McpClientManager] Failed to connect server ${config.serverId}: ${msg}`);
      }
    }

    // 启动健康检查
    this.startHealthCheck();

    // 设置缓存失效回调
    this.toolRegistry.setOnCacheInvalidated(async () => {
      await this.rediscoverAllTools();
    });

    logger.info(`[McpClientManager] Initialized with ${this.connections.size} connections`);
  }

  /**
   * 连接外部 MCP Server（per-server lock 串行化）
   */
  async connectServer(config: McpServerConfig): Promise<void> {
    let conn = this.connections.get(config.serverId);
    if (!conn) {
      conn = {
        serverId: config.serverId,
        client: new Client({ name: 'opsevo-mcp-client', version: '1.0.0' }),
        transport: null as any,
        status: 'connecting',
        discoveredTools: [],
        lastHealthCheck: 0,
        lock: new Mutex(),
        consecutiveFailures: 0,
        lastConfigMtime: await this.getConfigMtime(),
        config,
      };
      this.connections.set(config.serverId, conn);
    }

    await conn.lock.runExclusive(async () => {
      try {
        conn!.status = 'connecting';

        // 创建传输
        const transport = this.createTransport(config);
        conn!.transport = transport;

        // 监听传输层断开事件
        transport.onclose = () => {
          logger.warn(`[McpClientManager] Transport closed for server: ${config.serverId}`);
          conn!.status = 'disconnected';
          this.toolRegistry.setServerHealth(config.serverId, false);
        };

        transport.onerror = (error: Error) => {
          logger.error(`[McpClientManager] Transport error for ${config.serverId}: ${error.message}`);
        };

        // 连接并执行 MCP initialize 握手
        conn!.client = new Client({ name: 'opsevo-mcp-client', version: '1.0.0' });
        await conn!.client.connect(transport);

        // 工具发现
        const toolsResult = await conn!.client.listTools();
        const tools: McpToolDefinition[] = (toolsResult.tools || []).map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));

        conn!.discoveredTools = tools;
        conn!.status = 'connected';
        conn!.consecutiveFailures = 0;
        conn!.lastHealthCheck = Date.now();

        // 注册到 ToolRegistry
        this.toolRegistry.registerExternalTools(config.serverId, tools);
        this.toolRegistry.setServerHealth(config.serverId, true);

        logger.info(`[McpClientManager] Connected to ${config.serverId}, discovered ${tools.length} tools`);
      } catch (error) {
        conn!.status = 'disconnected';
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[McpClientManager] Connect failed for ${config.serverId}: ${msg}`);
        throw error;
      }
    });
  }

  /**
   * 断开外部 MCP Server（per-server lock 串行化）
   */
  async disconnectServer(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    await conn.lock.runExclusive(async () => {
      try {
        await conn.client.close();
      } catch (error) {
        logger.warn(`[McpClientManager] Error closing client for ${serverId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      conn.status = 'disconnected';
      this.toolRegistry.unregisterExternalTools(serverId);
      this.toolRegistry.setServerHealth(serverId, false);

      // 清理 OAuth
      if (this.oauthInterceptor) {
        this.oauthInterceptor.unregisterServerOAuth(serverId);
      }

      this.connections.delete(serverId);
      logger.info(`[McpClientManager] Disconnected from ${serverId}`);
    });
  }

  /**
   * 转发工具调用到外部 MCP Server（执行拦截器链 + 超时控制）
   */
  async forwardCall(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`Server ${serverId} is not connected`);
    }

    // 构建初始 ToolCallContext
    let context: ToolCallContext = {
      serverId,
      toolName,
      args,
      headers: {},
    };

    // 执行拦截器链
    for (const interceptor of this.interceptors) {
      try {
        context = await interceptor.intercept(context);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[McpClientManager] Interceptor ${interceptor.name} failed: ${msg}`);
        throw new Error(`Interceptor ${interceptor.name} failed: ${msg}`);
      }
    }

    // 超时控制
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.forwardTimeoutMs);

    try {
      const result = await conn.client.callTool(
        { name: context.toolName, arguments: context.args },
        undefined,
        { signal: controller.signal }
      );
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Tool call ${toolName} on ${serverId} timed out after ${this.forwardTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 注册拦截器
   */
  registerInterceptor(interceptor: ToolCallInterceptor): void {
    this.interceptors.push(interceptor);
    logger.info(`[McpClientManager] Registered interceptor: ${interceptor.name}`);
  }

  /**
   * 配置热更新：差异化更新（新增连接、断开移除、保持未变更）
   */
  async onConfigChange(newConfigs: McpServerConfig[]): Promise<void> {
    await this.configChangeLock.runExclusive(async () => {
      const resolvedConfigs = newConfigs.map(c => EnvVarResolver.resolve(c));
      const newConfigMap = new Map(resolvedConfigs.map(c => [c.serverId, c]));
      const currentIds = new Set(this.connections.keys());

      // 断开已移除的 server
      for (const serverId of currentIds) {
        if (!newConfigMap.has(serverId)) {
          await this.disconnectServer(serverId);
        }
      }

      // 连接新增或重新启用的 server
      for (const config of resolvedConfigs) {
        if (!config.enabled) {
          // 如果已连接但被禁用，断开
          if (currentIds.has(config.serverId)) {
            await this.disconnectServer(config.serverId);
          }
          continue;
        }

        if (!currentIds.has(config.serverId)) {
          // 新增 server
          if (config.oauth && this.oauthInterceptor) {
            this.oauthInterceptor.registerServerOAuth(config.serverId, config.oauth);
          } else if (config.oauth && !this.oauthInterceptor) {
            // 首次出现 OAuth 配置，初始化 OAuth 组件
            this.oauthManager = new OAuthTokenManager();
            this.oauthInterceptor = new OAuthToolCallInterceptor(this.oauthManager);
            this.registerInterceptor(this.oauthInterceptor);
            this.oauthInterceptor.registerServerOAuth(config.serverId, config.oauth);
          }

          try {
            await this.connectServer(config);
          } catch (error) {
            logger.error(`[McpClientManager] Failed to connect new server ${config.serverId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          // 已存在且 enabled 的 server — 检查配置是否变更
          const conn = this.connections.get(config.serverId);
          if (conn && JSON.stringify(conn.config) !== JSON.stringify(config)) {
            logger.info(`[McpClientManager] Config changed for ${config.serverId}, reconnecting...`);
            await this.disconnectServer(config.serverId);

            // 更新 OAuth 配置
            if (config.oauth && this.oauthInterceptor) {
              this.oauthInterceptor.registerServerOAuth(config.serverId, config.oauth);
            } else if (config.oauth && !this.oauthInterceptor) {
              this.oauthManager = new OAuthTokenManager();
              this.oauthInterceptor = new OAuthToolCallInterceptor(this.oauthManager);
              this.registerInterceptor(this.oauthInterceptor);
              this.oauthInterceptor.registerServerOAuth(config.serverId, config.oauth);
            }

            try {
              await this.connectServer(config);
            } catch (error) {
              logger.error(`[McpClientManager] Failed to reconnect server ${config.serverId}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }

      logger.info(`[McpClientManager] Config change processed. Active connections: ${this.connections.size}`);
    });
  }

  /**
   * 应用层健康检查（每 30 秒）
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      for (const [serverId, conn] of this.connections) {
        if (conn.status !== 'connected') continue;

        await conn.lock.runExclusive(async () => {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.healthCheckTimeoutMs);

            try {
              await conn.client.listTools({ signal: controller.signal } as any);
              conn.consecutiveFailures = 0;
              conn.lastHealthCheck = Date.now();
              this.toolRegistry.setServerHealth(serverId, true);
            } finally {
              clearTimeout(timeout);
            }
          } catch (error) {
            conn.consecutiveFailures++;
            logger.warn(`[McpClientManager] Health check failed for ${serverId} (${conn.consecutiveFailures}/${this.maxConsecutiveFailures})`);

            if (conn.consecutiveFailures >= this.maxConsecutiveFailures) {
              conn.status = 'disconnected';
              this.toolRegistry.setServerHealth(serverId, false);
              logger.error(`[McpClientManager] Server ${serverId} marked unhealthy after ${this.maxConsecutiveFailures} consecutive failures`);

              auditLogger.log({
                action: 'mcp_server_unhealthy' as any,
                actor: 'system',
                source: 'mcp_client',
                details: { serverId, consecutiveFailures: conn.consecutiveFailures },
              }).catch(() => {});
            }
          }
        });
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * 重新发现所有已连接 server 的工具
   */
  private async rediscoverAllTools(): Promise<void> {
    for (const [serverId, conn] of this.connections) {
      if (conn.status !== 'connected') continue;

      try {
        const toolsResult = await conn.client.listTools();
        const tools: McpToolDefinition[] = (toolsResult.tools || []).map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));

        conn.discoveredTools = tools;
        this.toolRegistry.unregisterExternalTools(serverId);
        this.toolRegistry.registerExternalTools(serverId, tools);
        logger.info(`[McpClientManager] Rediscovered ${tools.length} tools from ${serverId}`);
      } catch (error) {
        logger.warn(`[McpClientManager] Tool rediscovery failed for ${serverId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus(): Array<{ serverId: string; name: string; status: string; transport: string; toolCount: number; healthy: boolean }> {
    return Array.from(this.connections.values()).map(conn => ({
      serverId: conn.serverId,
      name: conn.config.name,
      status: conn.status,
      transport: conn.config.transport,
      toolCount: conn.discoveredTools.length,
      healthy: conn.status === 'connected' && conn.consecutiveFailures < this.maxConsecutiveFailures,
    }));
  }

  /**
   * 获取指定 server 的已发现工具
   */
  getServerTools(serverId: string): McpToolDefinition[] {
    const conn = this.connections.get(serverId);
    return conn?.discoveredTools || [];
  }

  /**
   * 优雅关闭所有连接
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const serverIds = Array.from(this.connections.keys());
    for (const serverId of serverIds) {
      await this.disconnectServer(serverId);
    }

    logger.info('[McpClientManager] Shutdown complete');
  }

  // ─── 内部辅助 ──────────────────────────────────────────────────────────────

  /**
   * 根据传输类型创建对应的 Transport 实例
   */
  private createTransport(config: McpServerConfig): Transport {
    switch (config.transport) {
      case 'stdio': {
        if (!config.connectionParams.command) {
          throw new Error(`stdio transport requires 'command' in connectionParams for server ${config.serverId}`);
        }
        return new StdioClientTransport({
          command: config.connectionParams.command,
          args: config.connectionParams.args,
          env: config.connectionParams.env,
        });
      }

      case 'sse': {
        if (!config.connectionParams.url) {
          throw new Error(`SSE transport requires 'url' in connectionParams for server ${config.serverId}`);
        }
        return new SSEClientTransport(
          new URL(config.connectionParams.url),
          config.connectionParams.headers
            ? { requestInit: { headers: config.connectionParams.headers } }
            : undefined
        );
      }

      case 'http': {
        if (!config.connectionParams.url) {
          throw new Error(`HTTP transport requires 'url' in connectionParams for server ${config.serverId}`);
        }
        return new StreamableHTTPClientTransport(
          new URL(config.connectionParams.url),
          config.connectionParams.headers
            ? { requestInit: { headers: config.connectionParams.headers } }
            : undefined
        );
      }

      default:
        throw new Error(`Unsupported transport type: ${config.transport} for server ${config.serverId}`);
    }
  }

  /**
   * 读取配置文件 mtime
   */
  private async getConfigMtime(): Promise<number> {
    try {
      const stat = await fs.stat(this.configFilePath);
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }
}
