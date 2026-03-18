/**
 * MCP Routes - MCP Server 端点 + API Key 管理 + Server 状态 + MCP Client 管理
 *
 * 路由分组：
 * - ALL /mcp — MCP Server Streamable HTTP 端点（SecurityGateway 保护）
 * - GET/POST/DELETE /api/mcp/keys — API Key 管理（内部认证）
 * - GET /api/mcp/server/status — MCP Server 运行状态
 * - GET/POST/PUT/DELETE /api/mcp/client/servers — MCP Client 外部 Server 管理
 * - GET /api/mcp/client/status — MCP Client 整体状态
 *
 * Requirements: 3.1, 9.1, 9.3, 10.1, 10.2, 10.3, 12.1, 12.2, 12.4
 */

import { Router, Request, Response } from 'express';
import { ApiKeyManager } from '../services/mcp/apiKeyManager';
import { McpServerHandler } from '../services/mcp/mcpServerHandler';
import { McpClientManager, McpServerConfig } from '../services/mcp/mcpClientManager';
import { createSecurityGateway } from '../services/mcp/securityGateway';
import { getEvolutionConfig, updateEvolutionConfig } from '../services/ai-ops/evolutionConfig';
import { logger } from '../utils/logger';

/**
 * 创建 MCP 路由
 */
export function createMcpRoutes(
  apiKeyManager: ApiKeyManager,
  mcpServerHandler: McpServerHandler,
  mcpClientManager?: McpClientManager
): Router {
  const router = Router();

  // ── SecurityGateway 中间件 ──
  const securityGateway = createSecurityGateway(apiKeyManager);

  // ── MCP Server 端点（Streamable HTTP） ──
  router.all('/mcp', securityGateway, mcpServerHandler.getHttpHandler());

  // ── API Key 管理 API（内部认证，非 MCP 协议） ──

  // 列出所有 API Keys
  router.get('/api/mcp/keys', async (_req: Request, res: Response) => {
    try {
      const keys = await apiKeyManager.listKeys();
      res.json({ success: true, keys });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[MCP Routes] List keys error: ${msg}`);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // 创建 API Key
  router.post('/api/mcp/keys', async (req: Request, res: Response) => {
    try {
      const { tenantId, role, label } = req.body || {};
      if (!tenantId || !role || !label) {
        res.status(400).json({ success: false, error: 'Missing required fields: tenantId, role, label' });
        return;
      }
      if (!['viewer', 'operator', 'admin'].includes(role)) {
        res.status(400).json({ success: false, error: 'Invalid role. Must be viewer, operator, or admin' });
        return;
      }
      const result = await apiKeyManager.createKey(tenantId, role, label);
      res.json({ success: true, ...result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[MCP Routes] Create key error: ${msg}`);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // 撤销 API Key
  router.delete('/api/mcp/keys/:keyId', async (req: Request, res: Response) => {
    try {
      const { keyId } = req.params;
      await apiKeyManager.revokeKey(keyId);
      res.json({ success: true, message: `Key ${keyId} revoked` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[MCP Routes] Revoke key error: ${msg}`);
      res.status(500).json({ success: false, error: msg });
    }
  });

  // ── MCP Server 状态 API ──
  router.get('/api/mcp/server/status', (_req: Request, res: Response) => {
    res.json({
      success: true,
      status: {
        enabled: true,
        serverName: 'opsevo-mcp-server',
        version: '1.0.0',
        transport: 'streamable-http',
        endpoint: '/mcp',
      },
    });
  });

  // ── MCP Client 管理 API ──

  if (mcpClientManager) {
    // 列出已配置的外部 Server
    router.get('/api/mcp/client/servers', (_req: Request, res: Response) => {
      try {
        const config = getEvolutionConfig();
        const servers = config.mcpClient?.servers || [];
        const status = mcpClientManager!.getConnectionStatus();
        // 合并配置和运行时状态
        const result = servers.map(s => {
          const runtime = status.find(st => st.serverId === s.serverId);
          return {
            ...s,
            connectionStatus: runtime?.status || 'disconnected',
            toolCount: runtime?.toolCount || 0,
            healthy: runtime?.healthy || false,
          };
        });
        res.json({ success: true, servers: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] List client servers error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });

    // 添加外部 Server 配置
    router.post('/api/mcp/client/servers', async (req: Request, res: Response) => {
      try {
        const serverConfig = req.body as McpServerConfig;
        if (!serverConfig.serverId || !serverConfig.name || !serverConfig.transport) {
          res.status(400).json({ success: false, error: 'Missing required fields: serverId, name, transport' });
          return;
        }
        const config = getEvolutionConfig();
        const servers = config.mcpClient?.servers || [];
        if (servers.some(s => s.serverId === serverConfig.serverId)) {
          res.status(409).json({ success: false, error: `Server ${serverConfig.serverId} already exists` });
          return;
        }
        servers.push(serverConfig);
        updateEvolutionConfig({ mcpClient: { enabled: true, servers } } as any);
        res.json({ success: true, message: `Server ${serverConfig.serverId} added` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] Add client server error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });

    // 更新外部 Server 配置
    router.put('/api/mcp/client/servers/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const updates = req.body;
        const config = getEvolutionConfig();
        const servers = config.mcpClient?.servers || [];
        const idx = servers.findIndex(s => s.serverId === id);
        if (idx === -1) {
          res.status(404).json({ success: false, error: `Server ${id} not found` });
          return;
        }
        servers[idx] = { ...servers[idx], ...updates, serverId: id };
        updateEvolutionConfig({ mcpClient: { enabled: config.mcpClient?.enabled ?? true, servers } } as any);
        res.json({ success: true, message: `Server ${id} updated` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] Update client server error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });

    // 移除外部 Server 配置
    router.delete('/api/mcp/client/servers/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const config = getEvolutionConfig();
        const servers = (config.mcpClient?.servers || []).filter(s => s.serverId !== id);
        updateEvolutionConfig({ mcpClient: { enabled: config.mcpClient?.enabled ?? true, servers } } as any);
        res.json({ success: true, message: `Server ${id} removed` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] Remove client server error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });

    // 启用/禁用外部 Server
    router.put('/api/mcp/client/servers/:id/toggle', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { enabled } = req.body;
        const config = getEvolutionConfig();
        const servers = config.mcpClient?.servers || [];
        const server = servers.find(s => s.serverId === id);
        if (!server) {
          res.status(404).json({ success: false, error: `Server ${id} not found` });
          return;
        }
        server.enabled = !!enabled;
        updateEvolutionConfig({ mcpClient: { enabled: config.mcpClient?.enabled ?? true, servers } } as any);
        res.json({ success: true, message: `Server ${id} ${enabled ? 'enabled' : 'disabled'}` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] Toggle client server error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });

    // 获取某 Server 已发现的工具列表
    router.get('/api/mcp/client/servers/:id/tools', (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const tools = mcpClientManager!.getServerTools(id);
        res.json({ success: true, tools });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] Get server tools error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });

    // MCP Client 整体状态
    router.get('/api/mcp/client/status', (_req: Request, res: Response) => {
      try {
        const status = mcpClientManager!.getConnectionStatus();
        res.json({ success: true, connections: status });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[MCP Routes] Client status error: ${msg}`);
        res.status(500).json({ success: false, error: msg });
      }
    });
  }

  return router;
}
