/**
 * bootstrapSkillSystem — Skill 系统单一初始化入口（L3 封装）
 *
 * 所有 Skill 系统内部逻辑（实例化、加载、注册、热加载、桥接）封装在此文件。
 * Bootstrap 层（index.ts）仅调用 initializeSkillSystem(deps) 并将返回的
 * skillFactory 注入到 Brain 和 Agent。
 *
 * Requirements: E7.17, E7.18, E7.19
 */

import { logger } from '../../../utils/logger';
import { VectorStoreClient } from '../rag/vectorStoreClient';
import { UnifiedToolRegistry, RegisteredTool } from './toolRegistry';
import { SkillFactory } from './skillFactory';
import { SkillLoader, skillLoader } from './skillLoader';
import { EventBus } from '../../eventBus';
import { FeatureFlagManager } from '../stateMachine/featureFlagManager';
import type { ToolRegistry as McpToolRegistry } from '../../mcp/toolRegistry';
import type { DeviceManager } from '../../device/deviceManager';
import type { LoadedSkillCapsule } from '../../../types/skillCapsule';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillSystemDeps {
  vectorClient: VectorStoreClient;
  eventBus: EventBus;
  deviceManager: DeviceManager;
  mcpToolRegistry: McpToolRegistry;
  featureFlags: FeatureFlagManager;
}

export interface SkillSystemResult {
  toolRegistry: UnifiedToolRegistry;
  skillFactory: SkillFactory;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_PREFIX = '[SkillBootstrap]';

// ─── initializeSkillSystem ───────────────────────────────────────────────────

/**
 * Skill 系统单一初始化入口（L3 封装）
 *
 * 内部执行：
 * 1. 实例化 UnifiedToolRegistry（注入 VectorStoreClient）
 * 2. 实例化 SkillFactory（注入所有依赖）
 * 3. 加载所有 Skill Capsule 并注册到 ToolRegistry
 * 4. 桥接 MCP 工具到 ToolRegistry
 * 5. 桥接 DeviceDriver 工具到 ToolRegistry
 * 6. 启动热加载监听
 */
export async function initializeSkillSystem(
  deps: SkillSystemDeps,
): Promise<SkillSystemResult> {
  // 1. 实例化 UnifiedToolRegistry
  const toolRegistry = new UnifiedToolRegistry(deps.vectorClient);
  logger.info(`${LOG_PREFIX} UnifiedToolRegistry created`);

  // 2. 实例化 SkillFactory
  const skillFactory = new SkillFactory({
    vectorClient: deps.vectorClient,
    toolRegistry,
    skillLoader,
    eventBus: deps.eventBus,
    featureFlags: deps.featureFlags,
    mcpToolRegistry: deps.mcpToolRegistry,
    deviceManager: deps.deviceManager,
  });
  logger.info(`${LOG_PREFIX} SkillFactory created with all dependencies`);

  // 3. 加载所有 Skill Capsule 并注册到 ToolRegistry (E7.18)
  try {
    const capsules = await skillLoader.loadAllCapsules();
    for (const loaded of capsules) {
      const regTool: RegisteredTool = {
        id: loaded.capsule.id,
        name: loaded.capsule.name,
        type: 'skill',
        description: loaded.capsule.description,
        capabilities: loaded.capsule.capabilities,
        inputSchema: loaded.capsule.inputSchema,
        metadata: {
          capsule: loaded.capsule,
          capsuleId: loaded.capsule.id,
          path: loaded.path,
          runtime: loaded.capsule.runtime,
        },
      };
      await toolRegistry.register(regTool);
    }
    logger.info(`${LOG_PREFIX} Registered ${capsules.length} Skill Capsules to UnifiedToolRegistry`);
  } catch (err) {
    logger.warn(`${LOG_PREFIX} Failed to load/register Skill Capsules: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. 桥接 MCP 工具到 ToolRegistry (E7.18)
  try {
    const mcpTools = await deps.mcpToolRegistry.getAllTools();
    for (const mcpTool of mcpTools) {
      const regTool: RegisteredTool = {
        id: `mcp:${mcpTool.name}`,
        name: mcpTool.name,
        type: 'mcp',
        description: mcpTool.description,
        capabilities: [],
        inputSchema: { type: 'object', properties: mcpTool.parameters },
        metadata: {
          source: mcpTool.source,
          serverId: mcpTool.serverId,
          mcpToolName: mcpTool.name,
        },
      };
      await toolRegistry.register(regTool);
    }
    logger.info(`${LOG_PREFIX} Bridged ${mcpTools.length} MCP tools to UnifiedToolRegistry`);
  } catch (err) {
    logger.warn(`${LOG_PREFIX} Failed to bridge MCP tools: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. 桥接 DeviceDriver 工具到 ToolRegistry (E7.19)
  try {
    const deviceBridgeTool: RegisteredTool = {
      id: 'device_driver:execute',
      name: 'device_execute',
      type: 'device_driver',
      description: 'Execute operations on managed devices through the unified DeviceManager interface',
      capabilities: ['device_management', 'device_query', 'device_configure', 'device_monitor'],
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device ID' },
          tenantId: { type: 'string', description: 'Tenant ID' },
          action: { type: 'string', description: 'Action type (query, execute, configure, monitor)' },
          payload: { type: 'object', description: 'Action-specific payload' },
        },
        required: ['deviceId', 'tenantId', 'action'],
      },
      metadata: {
        driverType: 'bridge',
        actionType: 'execute',
      },
    };
    await toolRegistry.register(deviceBridgeTool);
    logger.info(`${LOG_PREFIX} Bridged DeviceDriver tool to UnifiedToolRegistry`);
  } catch (err) {
    logger.warn(`${LOG_PREFIX} Failed to bridge DeviceDriver tool: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. 启动热加载，回调接入 ToolRegistry (E7.19)
  skillLoader.startCapsuleHotReload(
    async (capsule: LoadedSkillCapsule) => {
      const regTool: RegisteredTool = {
        id: capsule.capsule.id,
        name: capsule.capsule.name,
        type: 'skill',
        description: capsule.capsule.description,
        capabilities: capsule.capsule.capabilities,
        inputSchema: capsule.capsule.inputSchema,
        metadata: {
          capsule: capsule.capsule,
          capsuleId: capsule.capsule.id,
          path: capsule.path,
          runtime: capsule.capsule.runtime,
        },
      };
      await toolRegistry.updateTool(regTool);
      logger.info(`${LOG_PREFIX} Hot-reloaded capsule registered/updated: ${capsule.capsule.name}`);
    },
    async (capsuleId: string) => {
      await toolRegistry.unregister(capsuleId);
      logger.info(`${LOG_PREFIX} Hot-reload removed capsule: ${capsuleId}`);
    },
  );
  logger.info(`${LOG_PREFIX} Capsule hot reload started`);

  logger.info(`${LOG_PREFIX} Skill system initialization complete`);
  return { toolRegistry, skillFactory };
}
