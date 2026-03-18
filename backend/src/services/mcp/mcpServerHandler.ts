/**
 * McpServerHandler - MCP SDK Server 核心
 *
 * 使用 @modelcontextprotocol/sdk 创建 MCP Server，通过 Streamable HTTP 传输
 * 对外暴露 OPSEVO 的网络运维工具和资源。
 *
 * 每个 HTTP 请求创建独立的 StreamableHTTPServerTransport（无状态模式），
 * SecurityContext 从 req.mcpContext（SecurityGateway 注入）获取。
 *
 * Requirements: 2.1-2.5, 3.1-3.5, 4.1-4.5, 5.1-5.2
 */

import { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../../utils/logger';
import { auditLogger } from '../ai-ops/auditLogger';
import { executeIntent, resolveIntent } from '../ai-ops/brain/intentRegistry';
import { metricsCollector } from '../ai-ops/metricsCollector';
import { knowledgeGraphBuilder } from '../ai-ops/knowledgeGraphBuilder';
import { alertPipeline } from '../ai-ops/alertPipeline';
import { configSnapshotService } from '../ai-ops/configSnapshotService';
import { getEvolutionConfig } from '../ai-ops/evolutionConfig';
import { checkRolePermission, getToolMinRole } from './securityGateway';
import { SecurityContext } from './apiKeyManager';
import { z } from 'zod';

// ─── Types ───────────────────────────────────────────────────────────────────

/** MCP 工具调用结果 */
interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

// ─── McpServerHandler ────────────────────────────────────────────────────────

export class McpServerHandler {
  private serverName: string;
  private serverVersion: string;

  constructor(
    serverName: string = 'opsevo-mcp-server',
    serverVersion: string = '1.0.0'
  ) {
    this.serverName = serverName;
    this.serverVersion = serverVersion;
    logger.info(`[McpServerHandler] Initialized (${serverName} v${serverVersion})`);
  }

  /**
   * 创建一个配置好所有工具和资源的 McpServer 实例
   */
  private createServer(securityContext?: SecurityContext): McpServer {
    const server = new McpServer(
      { name: this.serverName, version: this.serverVersion },
      { capabilities: { tools: {}, resources: {} } }
    );

    this.registerTools(server, securityContext);
    this.registerResources(server, securityContext);

    return server;
  }

  /**
   * 注册所有 MCP 工具到 server 实例
   */
  registerTools(server: McpServer, securityContext?: SecurityContext): void {
    // ── 高层服务工具（直接调用内部服务，不走 Intent 系统）──

    server.registerTool('network.diagnose', {
      description: 'Diagnose network issues for a device or interface',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID'),
        interfaceName: z.string().optional().describe('Target interface name'),
        symptoms: z.string().optional().describe('Observed symptoms description'),
      },
    }, async (args) => {
      return this.handleDataQueryTool('network.diagnose', securityContext, async () => {
        // 收集诊断数据：接口状态 + 拓扑依赖 + 最近告警
        const results: Record<string, unknown> = {};

        // 1. 获取最新指标
        try {
          results.metrics = await metricsCollector.getLatest(args.deviceId);
        } catch (e) {
          results.metrics = { error: e instanceof Error ? e.message : String(e) };
        }

        // 2. 拓扑依赖分析
        if (args.deviceId) {
          try {
            results.dependencies = knowledgeGraphBuilder.queryDependencies(args.deviceId, 'both');
          } catch (e) {
            results.dependencies = { error: e instanceof Error ? e.message : String(e) };
          }
        }

        // 3. 最近告警历史
        try {
          const now = Date.now();
          results.recentAlerts = await auditLogger.query({
            from: now - 3600000, // 最近 1 小时
            to: now,
            limit: 20,
          });
        } catch (e) {
          results.recentAlerts = { error: e instanceof Error ? e.message : String(e) };
        }

        results.symptoms = args.symptoms || 'No symptoms provided';
        results.interfaceName = args.interfaceName;
        return results;
      });
    });

    server.registerTool('alert.analyze', {
      description: 'Analyze an alert event and provide root cause analysis',
      inputSchema: {
        alertId: z.string().optional().describe('Alert ID to analyze'),
        alertMessage: z.string().optional().describe('Alert message text'),
        severity: z.string().optional().describe('Alert severity level'),
      },
    }, async (args) => {
      return this.handleDataQueryTool('alert.analyze', securityContext, async () => {
        const results: Record<string, unknown> = {};

        // 1. 查询告警历史
        try {
          const now = Date.now();
          results.alertHistory = await auditLogger.query({
            from: now - 86400000, // 最近 24 小时
            to: now,
            limit: 50,
          });
        } catch (e) {
          results.alertHistory = { error: e instanceof Error ? e.message : String(e) };
        }

        // 2. 流水线统计
        try {
          results.pipelineStats = alertPipeline.getDetailedStats();
        } catch (e) {
          results.pipelineStats = { error: e instanceof Error ? e.message : String(e) };
        }

        results.alertId = args.alertId;
        results.alertMessage = args.alertMessage;
        results.severity = args.severity;
        return results;
      });
    });

    server.registerTool('topology.query', {
      description: 'Query network topology information',
      inputSchema: {
        nodeId: z.string().optional().describe('Specific node ID to query'),
        nodeType: z.string().optional().describe('Filter by node type'),
        depth: z.number().optional().describe('Traversal depth'),
      },
    }, async (args) => {
      return this.handleDataQueryTool('topology.query', securityContext, async () => {
        if (args.nodeId) {
          // 查询特定节点的依赖关系
          const deps = knowledgeGraphBuilder.queryDependencies(args.nodeId, 'both');
          const node = knowledgeGraphBuilder.getNode(args.nodeId);
          return { node: node || null, dependencies: deps };
        }
        if (args.nodeType) {
          // 按类型过滤节点
          const nodes = knowledgeGraphBuilder.getNodesByType(args.nodeType as any);
          return { nodes, count: nodes.length };
        }
        // 默认返回完整拓扑
        return knowledgeGraphBuilder.discoverTopology();
      });
    });

    // ── Intent 工具（设备操作，走 Intent 白名单系统）──
    this.registerIntentTool(server, securityContext, {
      mcpName: 'device.executeCommand',
      intentAction: 'execute_command',
      description: 'Execute a command on a managed device (requires admin role, always requires approval)',
      inputSchema: {
        deviceId: z.string().describe('Target device ID'),
        command: z.string().describe('Device command to execute'),
      },
    });

    this.registerIntentTool(server, securityContext, {
      mcpName: 'device.getConfig',
      intentAction: 'export_config',
      description: 'Export configuration from a managed device',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID'),
      },
    });

    // ── 数据查询工具 ──
    server.registerTool('metrics.getLatest', {
      description: 'Get latest system and interface metrics',
      inputSchema: {
        deviceId: z.string().optional().describe('Device ID (optional, defaults to primary)'),
      },
    }, async (args) => {
      return this.handleDataQueryTool('metrics.getLatest', securityContext, async () => {
        const result = await metricsCollector.getLatest(args.deviceId);
        return result;
      });
    });

    server.registerTool('metrics.getHistory', {
      description: 'Get historical metrics for a specific metric type',
      inputSchema: {
        metric: z.string().describe('Metric name (cpu, memory, disk, or interface:<name>)'),
        from: z.number().describe('Start timestamp (ms)'),
        to: z.number().describe('End timestamp (ms)'),
      },
    }, async (args) => {
      return this.handleDataQueryTool('metrics.getHistory', securityContext, async () => {
        const result = await metricsCollector.getHistory(args.metric, args.from, args.to);
        return result;
      });
    });

    server.registerTool('alert.getHistory', {
      description: 'Get alert history from audit logs',
      inputSchema: {
        from: z.number().optional().describe('Start timestamp (ms)'),
        to: z.number().optional().describe('End timestamp (ms)'),
        limit: z.number().optional().describe('Max number of results'),
      },
    }, async (args) => {
      return this.handleDataQueryTool('alert.getHistory', securityContext, async () => {
        const result = await auditLogger.query({
          from: args.from,
          to: args.to,
          limit: args.limit || 50,
        });
        return result;
      });
    });

    server.registerTool('topology.getSnapshot', {
      description: 'Get current network topology snapshot',
      inputSchema: {},
    }, async () => {
      return this.handleDataQueryTool('topology.getSnapshot', securityContext, async () => {
        const graph = knowledgeGraphBuilder.discoverTopology();
        return graph;
      });
    });

    logger.info('[McpServerHandler] All tools registered');
  }

  /**
   * 注册所有 MCP 资源到 server 实例
   */
  registerResources(server: McpServer, securityContext?: SecurityContext): void {
    // 设备配置快照资源
    server.registerResource(
      'device-config',
      'device-config://{deviceId}',
      { description: 'Device configuration snapshot', mimeType: 'text/plain' },
      async (uri) => {
        // 从 URI 提取 deviceId
        const deviceId = uri.pathname || uri.host || '';
        return this.handleResourceRead('device-config', deviceId, securityContext, async () => {
          const snapshots = await configSnapshotService.getSnapshots(1, deviceId);
          if (snapshots.length === 0) {
            return `No configuration snapshot found for device: ${deviceId}`;
          }
          const content = await configSnapshotService.downloadSnapshot(snapshots[0].id);
          return content;
        });
      }
    );

    // 网络拓扑快照资源
    server.registerResource(
      'topology-current',
      'topology://current',
      { description: 'Current network topology graph', mimeType: 'application/json' },
      async () => {
        return this.handleResourceRead('topology', 'current', securityContext, async () => {
          const graph = knowledgeGraphBuilder.discoverTopology();
          return JSON.stringify(graph, null, 2);
        });
      }
    );

    // 告警历史摘要资源
    server.registerResource(
      'alerts-recent',
      'alerts://recent',
      { description: 'Recent alerts summary', mimeType: 'application/json' },
      async () => {
        return this.handleResourceRead('alerts', 'recent', securityContext, async () => {
          const now = Date.now();
          const oneDayAgo = now - 24 * 60 * 60 * 1000;
          const alerts = await auditLogger.query({ from: oneDayAgo, to: now, limit: 100 });
          return JSON.stringify(alerts, null, 2);
        });
      }
    );

    logger.info('[McpServerHandler] All resources registered');
  }

  /**
   * 获取 Express request handler（无状态模式：每个请求创建独立 transport）
   */
  getHttpHandler(): (req: Request, res: Response) => Promise<void> {
    return async (req: Request, res: Response): Promise<void> => {
      const securityContext = req.mcpContext;

      try {
        // 为每个请求创建独立的 McpServer + Transport（无状态模式）
        const server = this.createServer(securityContext);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // 无状态模式
        });

        transport.onerror = (error: Error) => {
          logger.error(`[McpServerHandler] Transport error: ${error.message}`);
        };

        // 连接 server 和 transport
        await server.connect(transport);

        // 处理请求
        await transport.handleRequest(req, res, req.body);

        // 请求完成后关闭
        await server.close();
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[McpServerHandler] Request handling error: ${errMsg}`);

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    };
  }

  // ─── 内部辅助方法 ──────────────────────────────────────────────────────────

  /**
   * 注册意图工具（高层意图 + 低层操作）
   * handler 将 MCP 调用转换为 IntentRegistry action + params
   */
  private registerIntentTool(
    server: McpServer,
    securityContext: SecurityContext | undefined,
    config: {
      mcpName: string;
      intentAction: string;
      description: string;
      inputSchema: Record<string, any>;
    }
  ): void {
    server.registerTool(config.mcpName, {
      description: config.description,
      inputSchema: config.inputSchema,
    }, async (args) => {
      return this.handleIntentTool(config.mcpName, config.intentAction, args, securityContext);
    });
  }

  /**
   * 处理意图工具调用
   */
  private async handleIntentTool(
    toolName: string,
    intentAction: string,
    args: Record<string, unknown>,
    securityContext?: SecurityContext
  ): Promise<McpToolResult> {
    const startTime = Date.now();

    try {
      // 角色权限检查
      const minRole = getToolMinRole(toolName);
      if (securityContext && !checkRolePermission(securityContext.role, minRole)) {
        await this.logToolAudit(toolName, args, securityContext, false, Date.now() - startTime, 'Permission denied');
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Permission denied', requiredRole: minRole }) }],
          isError: true,
        };
      }

      // device.executeCommand 默认禁用检查
      if (toolName === 'device.executeCommand') {
        const config = getEvolutionConfig();
        const mcpConfig = (config as any).mcpServer;
        if (!mcpConfig?.enableDeviceExecuteCommand) {
          await this.logToolAudit(toolName, args, securityContext, false, Date.now() - startTime, 'device.executeCommand is disabled');
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'device.executeCommand is disabled. Enable it in EvolutionConfig.' }) }],
            isError: true,
          };
        }
      }

      // 检查意图是否已注册
      const intent = resolveIntent(intentAction);
      if (!intent) {
        await this.logToolAudit(toolName, args, securityContext, false, Date.now() - startTime, `Intent not found: ${intentAction}`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Intent not registered: ${intentAction}` }) }],
          isError: true,
        };
      }

      // 执行意图
      const result = await executeIntent(intentAction, args as any);
      const duration = Date.now() - startTime;

      await this.logToolAudit(toolName, args, securityContext, result.success, duration);

      // 审批拦截
      if (result.status === 'pending_approval') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'pending_approval',
              approvalId: result.approvalId,
              message: 'This operation requires human approval before execution.',
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: result.success,
            status: result.status,
            output: result.output,
            error: result.error,
          }),
        }],
        isError: !result.success,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.logToolAudit(toolName, args, securityContext, false, duration, errMsg);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errMsg }) }],
        isError: true,
      };
    }
  }

  /**
   * 处理数据查询工具调用（直接调用服务单例，不走 IntentRegistry）
   */
  private async handleDataQueryTool(
    toolName: string,
    securityContext: SecurityContext | undefined,
    queryFn: () => Promise<unknown>
  ): Promise<McpToolResult> {
    const startTime = Date.now();

    try {
      // 角色权限检查
      const minRole = getToolMinRole(toolName);
      if (securityContext && !checkRolePermission(securityContext.role, minRole)) {
        await this.logToolAudit(toolName, {}, securityContext, false, Date.now() - startTime, 'Permission denied');
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Permission denied', requiredRole: minRole }) }],
          isError: true,
        };
      }

      const result = await queryFn();
      const duration = Date.now() - startTime;

      await this.logToolAudit(toolName, {}, securityContext, true, duration);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result),
        }],
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.logToolAudit(toolName, {}, securityContext, false, duration, errMsg);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errMsg }) }],
        isError: true,
      };
    }
  }

  /**
   * 处理资源读取
   */
  private async handleResourceRead(
    resourceType: string,
    resourceId: string,
    securityContext: SecurityContext | undefined,
    readFn: () => Promise<string>
  ): Promise<{ contents: Array<{ uri: string; text: string; mimeType?: string }> }> {
    try {
      // Resources 使用 viewer 最低权限
      if (securityContext && !checkRolePermission(securityContext.role, 'viewer')) {
        auditLogger.log({
          action: 'mcp_resource_read' as any,
          actor: 'system',
          source: 'mcp_server',
          details: { resourceType, resourceId, success: false, error: 'Permission denied' },
        }).catch(() => {});
        return {
          contents: [{ uri: `${resourceType}://${resourceId}`, text: JSON.stringify({ error: 'Permission denied' }) }],
        };
      }

      const content = await readFn();

      auditLogger.log({
        action: 'mcp_resource_read' as any,
        actor: 'system',
        source: 'mcp_server',
        details: {
          resourceType,
          resourceId,
          success: true,
          tenantId: securityContext?.tenantId,
        },
      }).catch(() => {});

      return {
        contents: [{
          uri: `${resourceType}://${resourceId}`,
          text: content,
          mimeType: resourceType === 'device-config' ? 'text/plain' : 'application/json',
        }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[McpServerHandler] Resource read error (${resourceType}://${resourceId}): ${errMsg}`);

      auditLogger.log({
        action: 'mcp_resource_read' as any,
        actor: 'system',
        source: 'mcp_server',
        details: { resourceType, resourceId, success: false, error: errMsg },
      }).catch(() => {});

      return {
        contents: [{
          uri: `${resourceType}://${resourceId}`,
          text: JSON.stringify({ error: errMsg }),
        }],
      };
    }
  }

  /**
   * 记录工具调用审计日志
   */
  private async logToolAudit(
    toolName: string,
    args: Record<string, unknown>,
    securityContext: SecurityContext | undefined,
    success: boolean,
    durationMs: number,
    error?: string
  ): Promise<void> {
    auditLogger.log({
      action: 'mcp_tool_call' as any,
      actor: 'system',
      source: 'mcp_server',
      details: {
        toolName,
        inputParams: args,
        success,
        durationMs,
        error,
        tenantId: securityContext?.tenantId,
        role: securityContext?.role,
        apiKeyId: securityContext?.apiKeyId,
      },
    }).catch(() => { /* non-critical */ });
  }
}
