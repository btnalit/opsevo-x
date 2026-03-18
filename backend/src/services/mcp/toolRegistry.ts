/**
 * ToolRegistry - 统一工具注册表 + 工具缓存 + mtime 过期检测
 *
 * 管理本地 brainTools 和外部 MCP 工具的合并列表
 * 提供 getAllTools() 供大脑 OODA 循环使用
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 14.1, 14.2, 14.3, 14.4, 14.5
 */

import { Mutex } from 'async-mutex';
import * as fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { auditLogger } from '../ai-ops/auditLogger';

// ─── Types ───────────────────────────────────────────────────────────────────

/** AgentTool 兼容接口（与 mastraAgent.ts 一致） */
export interface AgentToolCompat {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/** 统一工具接口 */
export interface UnifiedTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  source: 'local' | 'mcp';
  serverId?: string;
  healthy: boolean;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/** MCP 工具定义（从外部 Server 发现） */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

/** 工具缓存条目 */
interface ToolCacheEntry {
  tools: UnifiedTool[];
  cachedAt: number;
  configMtime: number;
}

/** McpClientManager 前向引用接口 */
export interface IToolForwarder {
  forwardCall(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

// ─── ToolRegistry ────────────────────────────────────────────────────────────

/**
 * 🔴 FIX 1.10: 将 MCP JSON Schema 格式的 inputSchema 归一化为扁平的 ToolParam 格式
 * MCP 工具的 inputSchema 是标准 JSON Schema（{ type: "object", properties: {...}, required: [...] }）
 * 而 Brain 的 brainTools 使用扁平格式（{ paramName: { type, description, required } }）
 * 此函数将前者转换为后者，确保 ReAct 循环能统一解析参数
 */
export function normalizeInputSchema(inputSchema: Record<string, any>): Record<string, { type: string; description: string; required?: boolean }> {
  if (!inputSchema || typeof inputSchema !== 'object') return {};

  // 如果已经是扁平格式（没有 properties 字段，且值都有 type），直接返回
  if (!inputSchema.properties && !inputSchema.type) {
    // 可能已经是扁平格式，检查第一个值
    const firstVal = Object.values(inputSchema)[0];
    if (firstVal && typeof firstVal === 'object' && 'type' in (firstVal as any)) {
      return inputSchema as Record<string, { type: string; description: string; required?: boolean }>;
    }
    return {};
  }

  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object') return {};

  const requiredFields = new Set<string>(
    Array.isArray(inputSchema.required) ? inputSchema.required : []
  );

  const result: Record<string, { type: string; description: string; required?: boolean }> = {};

  for (const [key, schema] of Object.entries(properties)) {
    const prop = schema as Record<string, any>;
    result[key] = {
      type: typeof prop.type === 'string' ? prop.type : 'string',
      description: typeof prop.description === 'string' ? prop.description : '',
      required: requiredFields.has(key),
    };
  }

  return result;
}

export class ToolRegistry {
  private localTools: Map<string, UnifiedTool> = new Map();
  private externalTools: Map<string, UnifiedTool> = new Map();
  private cache: ToolCacheEntry | null = null;
  private cacheLock: Mutex = new Mutex();
  private configFilePath: string;
  private toolForwarder: IToolForwarder | null = null;
  /** 外部回调：缓存失效时触发重新发现 */
  private onCacheInvalidated: (() => Promise<void>) | null = null;

  constructor(configFilePath: string) {
    this.configFilePath = configFilePath;
  }

  /**
   * 设置工具转发器（McpClientManager 注入）
   */
  setToolForwarder(forwarder: IToolForwarder): void {
    this.toolForwarder = forwarder;
  }

  /**
   * 设置缓存失效回调（McpClientManager 注入）
   */
  setOnCacheInvalidated(callback: () => Promise<void>): void {
    this.onCacheInvalidated = callback;
  }

  /**
   * 注册本地 brainTools
   */
  registerLocalTools(brainTools: AgentToolCompat[]): void {
    for (const tool of brainTools) {
      const unified: UnifiedTool = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source: 'local',
        healthy: true,
        execute: tool.execute,
      };
      this.localTools.set(tool.name, unified);
    }
    logger.info(`[ToolRegistry] Registered ${brainTools.length} local tools`);
  }

  /**
   * 注册外部 MCP 工具（名称格式 mcp:{serverId}:{toolName}）
   */
  registerExternalTools(serverId: string, tools: McpToolDefinition[]): void {
    for (const tool of tools) {
      const unifiedName = `mcp:${serverId}:${tool.name}`;
      const unified: UnifiedTool = {
        name: unifiedName,
        description: tool.description || '',
        parameters: tool.inputSchema || {},
        source: 'mcp',
        serverId,
        healthy: true,
        execute: async (params) => {
          // 🔴 FIX 1.10: 调用前检查 MCP 服务器连接健康状态
          const currentTool = this.externalTools.get(unifiedName);
          if (currentTool && !currentTool.healthy) {
            return {
              success: false,
              error: `MCP server "${serverId}" disconnected`,
              _brainHint: `此 MCP 工具 (${unifiedName}) 不可用，对应的 MCP 服务器已断连。请尝试本地替代工具或跳过此操作。`,
            };
          }
          if (!this.toolForwarder) {
            throw new Error(`No tool forwarder set. Cannot call external tool: ${unifiedName}`);
          }
          // 🔴 FIX 1.10e: 捕获 forwardCall 异常，返回带 _brainHint 的结构化错误
          try {
            return await this.toolForwarder.forwardCall(serverId, tool.name, params);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            // 标记服务器为不健康，后续调用直接走健康检查拦截
            this.setServerHealth(serverId, false);
            return {
              success: false,
              error: `MCP tool "${unifiedName}" execution failed: ${errMsg}`,
              _brainHint: `MCP 工具 (${unifiedName}) 调用失败 (${errMsg})。该 MCP 服务器已标记为不可用。请尝试功能等价的本地工具或跳过此操作。`,
            };
          }
        },
      };
      this.externalTools.set(unifiedName, unified);
    }
    // 清除缓存，下次 getAllTools 会重建
    this.cache = null;
    logger.info(`[ToolRegistry] Registered ${tools.length} external tools from server: ${serverId}`);
  }

  /**
   * 注销外部工具（按 serverId）
   */
  unregisterExternalTools(serverId: string): void {
    let removed = 0;
    for (const [name, tool] of this.externalTools) {
      if (tool.serverId === serverId) {
        this.externalTools.delete(name);
        removed++;
      }
    }
    this.cache = null;
    logger.info(`[ToolRegistry] Unregistered ${removed} external tools from server: ${serverId}`);
  }

  /**
   * 标记外部 Server 健康状态
   */
  setServerHealth(serverId: string, healthy: boolean): void {
    for (const tool of this.externalTools.values()) {
      if (tool.serverId === serverId) {
        tool.healthy = healthy;
      }
    }
    // 健康状态变化时清除缓存
    this.cache = null;
  }

  /**
   * 获取全量工具列表（本地 + 健康的外部工具）
   * 内部先检查 mtime 是否过期
   */
  async getAllTools(): Promise<UnifiedTool[]> {
    // 检查缓存 mtime 是否过期
    const isStale = await this.checkCacheStaleness();
    if (isStale) {
      await this.invalidateAndRefresh();
    }

    // 如果有有效缓存，直接返回
    if (this.cache) {
      return this.cache.tools;
    }

    // 构建工具列表
    const tools: UnifiedTool[] = [];

    // 本地工具全部加入
    for (const tool of this.localTools.values()) {
      tools.push(tool);
    }

    // 外部工具仅加入 healthy=true 的，并归一化 parameters
    for (const tool of this.externalTools.values()) {
      if (tool.healthy) {
        tools.push({
          ...tool,
          parameters: normalizeInputSchema(tool.parameters),
        });
      }
    }

    // 缓存结果
    const mtime = await this.getConfigMtime();
    this.cache = {
      tools,
      cachedAt: Date.now(),
      configMtime: mtime,
    };

    return tools;
  }

  /**
   * 执行工具（自动路由本地/外部）
   */
  async executeTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    // 优先查找本地工具
    const localTool = this.localTools.get(toolName);
    if (localTool) {
      return localTool.execute(params);
    }

    // 查找外部工具
    const externalTool = this.externalTools.get(toolName);
    if (externalTool) {
      if (!externalTool.healthy) {
        throw new Error(`External tool ${toolName} is unhealthy`);
      }
      const startTime = Date.now();
      try {
        const result = await externalTool.execute(params);
        const duration = Date.now() - startTime;
        // 审计日志
        auditLogger.log({
          action: 'mcp_external_tool_call' as any,
          actor: 'system',
          source: 'mcp_client',
          details: {
            toolName,
            serverId: externalTool.serverId,
            inputParams: params,
            result: typeof result === 'object' ? JSON.stringify(result).slice(0, 500) : String(result).slice(0, 500),
            durationMs: duration,
            success: true,
          },
        }).catch(() => { /* non-critical */ });
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        auditLogger.log({
          action: 'mcp_external_tool_call' as any,
          actor: 'system',
          source: 'mcp_client',
          details: {
            toolName,
            serverId: externalTool.serverId,
            inputParams: params,
            error: error instanceof Error ? error.message : String(error),
            durationMs: duration,
            success: false,
          },
        }).catch(() => { /* non-critical */ });
        throw error;
      }
    }

    throw new Error(`Tool not found: ${toolName}`);
  }

  /**
   * 检查缓存是否过期（配置文件 mtime 变化）
   */
  private async checkCacheStaleness(): Promise<boolean> {
    if (!this.cache) return false; // 无缓存不算过期

    try {
      const currentMtime = await this.getConfigMtime();
      return currentMtime > this.cache.configMtime;
    } catch {
      // 无法读取 mtime，跳过检测
      return false;
    }
  }

  /**
   * 缓存失效并触发重新发现（通过 cacheLock 串行化）
   */
  private async invalidateAndRefresh(): Promise<void> {
    await this.cacheLock.runExclusive(async () => {
      // double-check：锁内再次检查是否仍然过期
      const stillStale = await this.checkCacheStaleness();
      if (!stillStale && this.cache) return;

      logger.info('[ToolRegistry] Cache invalidated due to config mtime change. Triggering rediscovery...');
      this.cache = null;

      if (this.onCacheInvalidated) {
        try {
          await this.onCacheInvalidated();
        } catch (err) {
          logger.warn(`[ToolRegistry] Cache invalidation callback failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
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

  /**
   * 获取已注册的外部工具数量（按 serverId）
   */
  getExternalToolCount(serverId: string): number {
    let count = 0;
    for (const tool of this.externalTools.values()) {
      if (tool.serverId === serverId) count++;
    }
    return count;
  }

  /**
   * 获取所有外部工具（按 serverId）
   */
  getExternalToolsByServer(serverId: string): UnifiedTool[] {
    const tools: UnifiedTool[] = [];
    for (const tool of this.externalTools.values()) {
      if (tool.serverId === serverId) tools.push(tool);
    }
    return tools;
  }
}
