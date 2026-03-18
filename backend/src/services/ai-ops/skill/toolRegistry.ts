/**
 * ToolRegistry — 统一工具注册中心
 *
 * 统一管理三类工具：Skill Capsule、MCP 工具、DeviceDriver 桥接工具。
 * 对 Brain_Loop / SkillFactory 提供统一的 getAllTools() 接口。
 *
 * 注册时自动通过 VectorStoreClient 将工具描述向量化存入 tool_vectors 集合。
 * 工具更新时重新计算向量嵌入。
 *
 * Requirements: E2.6, E2.7, E3.12
 */

import { logger } from '../../../utils/logger';
import { VectorStoreClient } from '../rag/vectorStoreClient';
import type { JsonSchemaDefinition } from '../../../types/skillCapsule';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 工具类型：Skill Capsule / MCP 工具 / DeviceDriver 桥接工具 */
export type ToolType = 'skill' | 'mcp' | 'device_driver';

/** 统一注册工具接口 */
export interface RegisteredTool {
  /** 工具唯一标识 */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具类型 */
  type: ToolType;
  /** 工具描述（用于向量化检索） */
  description: string;
  /** 能力标签数组 */
  capabilities: string[];
  /** 输入参数 JSON Schema */
  inputSchema: JsonSchemaDefinition;
  /** tool_vectors 中的向量 ID（注册后自动填充） */
  vectorId?: string;
  /** 附加元数据（如 capsule 对象、serverId、driverType 等） */
  metadata: Record<string, unknown>;
}

/** ToolRegistry 配置 */
export interface UnifiedToolRegistryConfig {
  /** tool_vectors 集合名称，默认 'tool_vectors' */
  vectorCollection?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_VECTOR_COLLECTION = 'tool_vectors';
const LOG_PREFIX = '[UnifiedToolRegistry]';

// ─── ToolRegistry ────────────────────────────────────────────────────────────

export class UnifiedToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private vectorClient: VectorStoreClient;
  private vectorCollection: string;

  constructor(
    vectorClient: VectorStoreClient,
    config?: UnifiedToolRegistryConfig,
  ) {
    this.vectorClient = vectorClient;
    this.vectorCollection = config?.vectorCollection ?? DEFAULT_VECTOR_COLLECTION;
    logger.info(`${LOG_PREFIX} Initialized`, { vectorCollection: this.vectorCollection });
  }

  // ── Register ────────────────────────────────────────────────────

  /**
   * 注册工具并自动向量化（满足 E2.6, E2.7）
   *
   * 将工具的 description + capabilities 组合文本向量化存入 tool_vectors。
   */
  async register(tool: RegisteredTool): Promise<void> {
    this.tools.set(tool.id, { ...tool });

    try {
      const vectorText = this.buildVectorText(tool);
      const ids = await this.vectorClient.upsert(this.vectorCollection, [{
        id: tool.id,
        content: vectorText,
        metadata: {
          type: tool.type,
          name: tool.name,
          capabilities: tool.capabilities,
        },
      }]);

      // 回写 vectorId
      const registered = this.tools.get(tool.id);
      if (registered && ids.length > 0) {
        registered.vectorId = ids[0];
      }

      logger.info(`${LOG_PREFIX} Registered tool: ${tool.name} (${tool.type})`, {
        id: tool.id,
        vectorId: ids[0],
      });
    } catch (err) {
      // 向量化失败不阻塞注册，工具仍可用（降级：无法被向量检索发现）
      logger.warn(`${LOG_PREFIX} Vectorization failed for tool ${tool.name}, tool registered without vector`, {
        id: tool.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Unregister ──────────────────────────────────────────────────

  /**
   * 注销工具并删除对应向量
   */
  async unregister(toolId: string): Promise<void> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      logger.warn(`${LOG_PREFIX} Attempted to unregister unknown tool: ${toolId}`);
      return;
    }

    this.tools.delete(toolId);

    try {
      await this.vectorClient.delete(this.vectorCollection, toolId);
      logger.info(`${LOG_PREFIX} Unregistered tool: ${tool.name} (${tool.type})`, { id: toolId });
    } catch (err) {
      logger.warn(`${LOG_PREFIX} Failed to delete vector for tool ${toolId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Update ──────────────────────────────────────────────────────

  /**
   * 更新工具并重新计算向量嵌入（满足 E3.12）
   */
  async updateTool(tool: RegisteredTool): Promise<void> {
    const existing = this.tools.get(tool.id);
    if (!existing) {
      // 不存在则当作新注册
      return this.register(tool);
    }

    this.tools.set(tool.id, { ...tool, vectorId: existing.vectorId });

    try {
      const vectorText = this.buildVectorText(tool);
      const ids = await this.vectorClient.upsert(this.vectorCollection, [{
        id: tool.id,
        content: vectorText,
        metadata: {
          type: tool.type,
          name: tool.name,
          capabilities: tool.capabilities,
        },
      }]);

      const updated = this.tools.get(tool.id);
      if (updated && ids.length > 0) {
        updated.vectorId = ids[0];
      }

      logger.info(`${LOG_PREFIX} Updated tool: ${tool.name} (${tool.type})`, {
        id: tool.id,
      });
    } catch (err) {
      logger.warn(`${LOG_PREFIX} Re-vectorization failed for tool ${tool.name}`, {
        id: tool.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Query ───────────────────────────────────────────────────────

  /**
   * 获取所有已注册工具（满足 E2.6 统一接口）
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取单个工具
   */
  getTool(toolId: string): RegisteredTool | undefined {
    return this.tools.get(toolId);
  }

  /**
   * 按工具类型过滤
   */
  getToolsByType(type: ToolType): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(t => t.type === type);
  }

  /**
   * 获取已注册工具数量
   */
  getToolCount(): number {
    return this.tools.size;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * 构建用于向量化的文本
   * 格式: "{name}: {description}. Capabilities: {cap1, cap2, ...}"
   */
  private buildVectorText(tool: RegisteredTool): string {
    const caps = tool.capabilities.length > 0
      ? `Capabilities: ${tool.capabilities.join(', ')}`
      : '';
    return `${tool.name}: ${tool.description}. ${caps}`.trim();
  }
}
