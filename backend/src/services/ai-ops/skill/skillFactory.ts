/**
 * SkillFactory — 向量检索 + 执行引擎
 *
 * 根据意图描述自动发现最匹配的工具候选，并按工具类型路由执行。
 *
 * 核心能力：
 * 1. findTools(intentDescription) — 向量相似度检索 Top-K 工具候选
 *    - FeatureFlag `use_vector_search_tools` OFF 时回退关键词匹配
 *    - 综合排序：向量相似度 × (1-historyWeight) + 历史成功率 × historyWeight
 *    - 低相似度 (< minSimilarity) 返回空列表并发布 skill_not_found 事件
 * 2. executeTool(toolId, input) — 按工具类型自动路由执行
 *    - Skill → SkillLoader.executeCapsule() (runtime 分发)
 *    - MCP → MCP ToolRegistry.executeTool() (协议调用)
 *    - DeviceDriver → DeviceManager (设备操作)
 * 3. recordSuccess / recordFailure — 更新历史成功率
 *
 * Requirements: E3.8, E3.9, E3.10, E3.11
 */

import { logger } from '../../../utils/logger';
import { VectorStoreClient, VectorSearchResult } from '../rag/vectorStoreClient';
import { UnifiedToolRegistry, RegisteredTool } from './toolRegistry';
import { SkillLoader } from './skillLoader';
import { EventBus } from '../../eventBus';
import { FeatureFlagManager } from '../stateMachine/featureFlagManager';
import type { ToolRegistry as McpToolRegistry } from '../../mcp/toolRegistry';
import type { DeviceManager } from '../../device/deviceManager';
import type { AgentTool } from '../rag/mastraAgent';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 工具候选结果 */
export interface ToolCandidate {
  /** 匹配到的工具 */
  tool: RegisteredTool;
  /** 综合评分 (0-1) */
  score: number;
}

/** 工具执行结果 */
export interface ToolExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 输出数据 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/** SkillFactory 配置 */
export interface SkillFactoryConfig {
  /** 向量检索返回的 Top-K 候选数，默认 5 */
  topK: number;
  /** 最低相似度阈值，低于此值返回空列表，默认 0.5 (E3.11) */
  minSimilarity: number;
  /** 历史成功率权重，默认 0.3 (E3.9) */
  historyWeight: number;
  /** tool_vectors 集合名称，默认 'tool_vectors' */
  vectorCollection: string;
  /** 历史成功率默认值（无记录时使用），默认 0.5 */
  defaultSuccessRate: number;
}

/** 历史执行记录（用于计算成功率） */
interface ExecutionHistory {
  successes: number;
  failures: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_PREFIX = '[SkillFactory]';

const DEFAULT_CONFIG: SkillFactoryConfig = {
  topK: 5,
  minSimilarity: 0.5,
  historyWeight: 0.3,
  vectorCollection: 'tool_vectors',
  defaultSuccessRate: 0.5,
};

// ─── SkillFactory ────────────────────────────────────────────────────────────

export class SkillFactory {
  private vectorClient: VectorStoreClient;
  private toolRegistry: UnifiedToolRegistry;
  private skillLoader: SkillLoader;
  private eventBus: EventBus;
  private featureFlags: FeatureFlagManager;
  private mcpToolRegistry: McpToolRegistry;
  private deviceManager: DeviceManager;
  private config: SkillFactoryConfig;

  /** 工具执行历史（toolId → 成功/失败计数） */
  private executionHistory: Map<string, ExecutionHistory> = new Map();

  constructor(deps: {
    vectorClient: VectorStoreClient;
    toolRegistry: UnifiedToolRegistry;
    skillLoader: SkillLoader;
    eventBus: EventBus;
    featureFlags: FeatureFlagManager;
    mcpToolRegistry: McpToolRegistry;
    deviceManager: DeviceManager;
    config?: Partial<SkillFactoryConfig>;
  }) {
    this.vectorClient = deps.vectorClient;
    this.toolRegistry = deps.toolRegistry;
    this.skillLoader = deps.skillLoader;
    this.eventBus = deps.eventBus;
    this.featureFlags = deps.featureFlags;
    this.mcpToolRegistry = deps.mcpToolRegistry;
    this.deviceManager = deps.deviceManager;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };

    logger.info(`${LOG_PREFIX} Initialized`, {
      topK: this.config.topK,
      minSimilarity: this.config.minSimilarity,
      historyWeight: this.config.historyWeight,
    });
  }

  // ── findTools (E3.8, E3.9, E3.11) ──────────────────────────────────────

  /**
   * 根据意图描述检索最匹配的工具候选列表。
   *
   * - FeatureFlag `use_vector_search_tools` ON → 向量相似度检索
   * - FeatureFlag `use_vector_search_tools` OFF → 关键词匹配回退
   * - 综合排序：vectorScore × (1 - historyWeight) + successRate × historyWeight
   * - 最高相似度 < minSimilarity → 返回空列表 + 发布 skill_not_found 事件
   *
   * Requirements: E3.8, E3.9, E3.11
   */
  async findTools(intentDescription: string): Promise<ToolCandidate[]> {
    if (!this.featureFlags.isControlPointEnabled('use_vector_search_tools')) {
      logger.debug(`${LOG_PREFIX} Vector search disabled, falling back to keyword matching`);
      return this.findToolsByKeyword(intentDescription);
    }

    return this.findToolsByVector(intentDescription);
  }

  /**
   * 向量相似度检索 (E3.8)
   */
  private async findToolsByVector(intentDescription: string): Promise<ToolCandidate[]> {
    try {
      const vectorResults = await this.vectorClient.search(
        this.config.vectorCollection,
        {
          collection: this.config.vectorCollection,
          query: intentDescription,
          top_k: this.config.topK,
          min_score: this.config.minSimilarity,
        },
      );

      if (vectorResults.length === 0) {
        await this.publishSkillNotFound(intentDescription);
        return [];
      }

      return this.rankCandidates(vectorResults);
    } catch (err) {
      logger.error(`${LOG_PREFIX} Vector search failed, falling back to keyword matching`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // 向量检索失败时降级到关键词匹配
      return this.findToolsByKeyword(intentDescription);
    }
  }

  /**
   * 关键词匹配回退（FeatureFlag OFF 或向量检索失败时使用）
   *
   * 将意图描述拆分为关键词，与工具的 name/description/capabilities 进行匹配。
   */
  private findToolsByKeyword(intentDescription: string): ToolCandidate[] {
    const keywords = intentDescription
      .toLowerCase()
      .split(/[\s,;.!?]+/)
      .filter(w => w.length > 1);

    if (keywords.length === 0) return [];

    const allTools = this.toolRegistry.getAllTools();
    const scored: ToolCandidate[] = [];

    for (const tool of allTools) {
      const searchText = `${tool.name} ${tool.description} ${tool.capabilities.join(' ')}`.toLowerCase();
      let matchCount = 0;
      for (const kw of keywords) {
        if (searchText.includes(kw)) matchCount++;
      }

      if (matchCount === 0) continue;

      // 关键词匹配度作为 "相似度" 代理
      const keywordScore = matchCount / keywords.length;

      // 低于阈值的跳过
      if (keywordScore < this.config.minSimilarity) continue;

      const successRate = this.getSuccessRate(tool.id);
      const compositeScore =
        keywordScore * (1 - this.config.historyWeight) +
        successRate * this.config.historyWeight;

      scored.push({ tool, score: compositeScore });
    }

    // 按综合评分降序排列，取 Top-K
    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, this.config.topK);

    if (topK.length === 0) {
      // 异步发布事件，不阻塞返回
      this.publishSkillNotFound(intentDescription).catch(() => {});
    }

    return topK;
  }

  /**
   * 综合排序：向量相似度 × (1-historyWeight) + 历史成功率 × historyWeight (E3.9)
   */
  private rankCandidates(vectorResults: VectorSearchResult[]): ToolCandidate[] {
    const candidates: ToolCandidate[] = [];

    for (const result of vectorResults) {
      const tool = this.toolRegistry.getTool(result.id);
      if (!tool) {
        logger.warn(`${LOG_PREFIX} Vector result references unknown tool: ${result.id}`);
        continue;
      }

      const successRate = this.getSuccessRate(tool.id);
      const compositeScore =
        result.score * (1 - this.config.historyWeight) +
        successRate * this.config.historyWeight;

      candidates.push({ tool, score: compositeScore });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  // ── executeTool (E3.10) ────────────────────────────────────────────────

  /**
   * 根据工具类型自动路由执行 (E3.10)
   *
   * - skill → SkillLoader.executeCapsule() (按 runtime 分发)
   * - mcp → MCP ToolRegistry.executeTool() (协议调用)
   * - device_driver → DeviceManager.execute() (设备操作)
   */
  async executeTool(
    toolId: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const tool = this.toolRegistry.getTool(toolId);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolId}`,
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      let result: ToolExecutionResult;

      switch (tool.type) {
        case 'skill':
          result = await this.executeSkill(tool, input);
          break;
        case 'mcp':
          result = await this.executeMcp(tool, input);
          break;
        case 'device_driver':
          result = await this.executeDeviceDriver(tool, input);
          break;
        default:
          result = {
            success: false,
            error: `Unknown tool type: ${(tool as RegisteredTool).type}`,
            durationMs: Date.now() - startTime,
          };
      }

      // 自动记录成功/失败
      if (result.success) {
        this.recordSuccess(toolId);
      } else {
        this.recordFailure(toolId);
      }

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      this.recordFailure(toolId);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
  }

  // ── Execution Routing ──────────────────────────────────────────────────

  /**
   * 执行 Skill Capsule — 通过 SkillLoader.executeCapsule() 按 runtime 分发
   */
  private async executeSkill(
    tool: RegisteredTool,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const capsuleId = (tool.metadata.capsuleId as string) ?? tool.id;

    logger.info(`${LOG_PREFIX} Executing Skill: ${tool.name}`, { capsuleId });

    const result = await this.skillLoader.executeCapsule(capsuleId, input);

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs || (Date.now() - startTime),
    };
  }

  /**
   * 执行 MCP 工具 — 通过 MCP ToolRegistry.executeTool() 协议调用
   */
  private async executeMcp(
    tool: RegisteredTool,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const mcpToolName = (tool.metadata.mcpToolName as string) ?? tool.id;

    logger.info(`${LOG_PREFIX} Executing MCP tool: ${tool.name}`, { mcpToolName });

    const result = await this.mcpToolRegistry.executeTool(mcpToolName, input);

    return {
      success: true,
      output: result,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 执行 DeviceDriver 工具 — 通过 DeviceManager 设备操作
   */
  private async executeDeviceDriver(
    tool: RegisteredTool,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const deviceId = input.deviceId as string;
    const actionType = (tool.metadata.actionType as string) ?? 'execute';

    if (!deviceId) {
      return {
        success: false,
        error: 'deviceId is required for device_driver tool execution',
        durationMs: Date.now() - startTime,
      };
    }

    logger.info(`${LOG_PREFIX} Executing DeviceDriver tool: ${tool.name}`, {
      deviceId,
      actionType,
    });

    // DeviceManager 当前是 CRUD 管理器，设备操作通过 metadata 中的
    // execute 函数或未来的 DeviceDriver 接口执行。
    // 这里通过 tool.metadata.execute 回调执行（如果注册时提供了）。
    const executeFn = tool.metadata.execute as
      | ((input: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    if (typeof executeFn === 'function') {
      const output = await executeFn(input);
      return {
        success: true,
        output,
        durationMs: Date.now() - startTime,
      };
    }

    // 回退：无 execute 回调时返回错误
    return {
      success: false,
      error: `DeviceDriver tool "${tool.name}" has no execute handler in metadata`,
      durationMs: Date.now() - startTime,
    };
  }

  // ── History Success Rate ───────────────────────────────────────────────

  /**
   * 记录工具执行成功
   */
  recordSuccess(toolId: string): void {
    const history = this.executionHistory.get(toolId) ?? { successes: 0, failures: 0 };
    history.successes++;
    this.executionHistory.set(toolId, history);
  }

  /**
   * 记录工具执行失败
   */
  recordFailure(toolId: string): void {
    const history = this.executionHistory.get(toolId) ?? { successes: 0, failures: 0 };
    history.failures++;
    this.executionHistory.set(toolId, history);
  }

  /**
   * 获取工具的历史成功率 (0-1)
   * 无记录时返回 defaultSuccessRate
   */
  getSuccessRate(toolId: string): number {
    const history = this.executionHistory.get(toolId);
    if (!history) return this.config.defaultSuccessRate;

    const total = history.successes + history.failures;
    if (total === 0) return this.config.defaultSuccessRate;

    return history.successes / total;
  }

  // ── Event Publishing ───────────────────────────────────────────────────

  /**
   * 发布 skill_not_found 事件 (E3.11)
   */
  private async publishSkillNotFound(intentDescription: string): Promise<void> {
    try {
      await this.eventBus.publish({
        type: 'internal',
        priority: 'medium',
        source: 'SkillFactory',
        payload: {
          event: 'skill_not_found',
          intent: intentDescription,
          threshold: this.config.minSimilarity,
        },
        schemaVersion: '1.0',
      });
      logger.info(`${LOG_PREFIX} Published skill_not_found event`, {
        intent: intentDescription.slice(0, 100),
      });
    } catch (err) {
      logger.warn(`${LOG_PREFIX} Failed to publish skill_not_found event`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  /** 获取当前配置（只读副本） */
  getConfig(): Readonly<SkillFactoryConfig> {
    return { ...this.config };
  }

  /** 获取所有工具的执行历史统计 */
  getExecutionStats(): Map<string, { successes: number; failures: number; successRate: number }> {
    const stats = new Map<string, { successes: number; failures: number; successRate: number }>();
    for (const [toolId, history] of this.executionHistory) {
      const total = history.successes + history.failures;
      stats.set(toolId, {
        ...history,
        successRate: total > 0 ? history.successes / total : this.config.defaultSuccessRate,
      });
    }
    return stats;
  }

  // ── AgentTool Conversion (E7.20) ───────────────────────────────────────

  /**
   * 获取所有已注册工具，转换为 AgentTool 格式供 Brain/Agent 的 ReAct 循环使用。
   * 这是 Brain/Agent 获取工具列表的唯一入口，替代旧的 mcp/ToolRegistry.getAllTools()。
   *
   * Requirements: E7.20
   */
  getAllToolsAsAgentTools(): AgentTool[] {
    const allTools = this.toolRegistry.getAllTools();
    return allTools.map(tool => ({
      name: tool.id,
      description: tool.description,
      parameters: (tool.inputSchema ?? {}) as AgentTool['parameters'],
      execute: async (params: Record<string, unknown>) => {
        const result = await this.executeTool(tool.id, params);
        return result;
      },
    }));
  }
}
