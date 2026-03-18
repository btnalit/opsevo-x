/**
 * Action 选择器 — 从 ReActLoopController 中提取的 Action 选择逻辑
 *
 * 包含：
 * - selectAction: 主入口，协调 LLM 调用、解析、回退提取
 * - extractActionFromThought: 从 thought 中提取工具（Skill 感知）
 * - generateToolInput: 语义路由，根据用户消息生成工具参数
 * - buildActionSelectionPrompt: 构建 action 选择提示词
 * - validateActionRequiredParams: 验证必需参数
 *
 * 通过 ActionSelectorDeps 接口注入 RALC 的 LLM 调用能力和工具注册表，
 * 使本模块可独立测试，也为未来中间件管道集成提供干净的插入点。
 *
 * Requirements: 2.1-2.4, 7.1-7.4, 8.2, 8.3
 */

import { logger } from '../../../utils/logger';
import { IAIProviderAdapter, AIProvider } from '../../../types/ai';
import { ReActStep, RAGContext } from '../../../types/ai-ops';
import { AgentTool } from './mastraAgent';
import { parseLLMOutput, ParsedLLMOutput } from './llmOutputParser';
import { isCapabilityEnabled, getCapabilityConfig } from '../evolutionConfig';
import { toolFeedbackCollector } from '../toolFeedbackCollector';

// 从 reactLoopController 导入 SkillContext（保留在 RALC 中导出）
import type { SkillContext } from './reactLoopController';
import type { MiddlewareCorrection } from './middleware/types';

// ==================== 依赖注入接口 ====================

/**
 * ActionSelector 所需的外部依赖
 * 由 ReActLoopController 在构造时注入
 */
export interface ActionSelectorDeps {
  /** 调用 LLM（简单模式，无上下文） */
  callLLMSimple: (
    prompt: string,
    adapter: IAIProviderAdapter,
    provider: AIProvider,
    model: string,
    temperature: number,
  ) => Promise<string>;
  /** 获取已注册工具的 Map（用于参数验证） */
  getToolsMap: () => Map<string, AgentTool>;
  /** 是否启用知识增强模式 */
  knowledgeEnhancedMode: boolean;
  /**
   * 中间件管道执行函数（可选）
   * 由 RALC 注入，在 parseLLMOutput 后调用，修正 LLM 输出
   * 返回修正后的 output 和修正记录
   * Requirements: 4.1, 4.2
   */
  executeMiddleware?: (
    output: ParsedLLMOutput,
    availableToolNames: string[],
    skillContext?: SkillContext,
  ) => Promise<{ output: ParsedLLMOutput; corrections: MiddlewareCorrection[] }>;
}

// ==================== ActionSelector 类 ====================

export class ActionSelector {
  private deps: ActionSelectorDeps;

  constructor(deps: ActionSelectorDeps) {
    this.deps = deps;
  }

  /** 更新依赖（当 RALC 配置变更时调用） */
  updateDeps(partial: Partial<ActionSelectorDeps>): void {
    this.deps = { ...this.deps, ...partial };
  }

  /**
   * 选择下一步 Action
   *
   * 协调流程：构建提示词 → 调用 LLM → 解析输出 → 回退提取 → 参数验证
   *
   * Requirements: 2.1-2.4, 7.1-7.4, 8.2
   */
  async selectAction(
    thought: string,
    availableTools: AgentTool[],
    hasExecutedTool: boolean = false,
    steps: ReActStep[] = [],
    originalMessage: string = '',
    ragContext?: RAGContext,
    effectiveAdapter?: IAIProviderAdapter | null,
    effectiveProvider?: AIProvider,
    effectiveModel?: string,
    effectiveTemperature?: number,
    skillContext?: SkillContext,
    intentTools?: Array<{ name: string; params?: Record<string, unknown>; reason?: string }>,
  ): Promise<{ toolName: string; toolInput: Record<string, unknown> } | null> {
    const adapter = effectiveAdapter ?? null;
    const provider = effectiveProvider ?? AIProvider.OPENAI;
    const model = effectiveModel ?? 'gpt-4o';
    const temperature = effectiveTemperature ?? 0.5;

    // 如果没有 AI 适配器，尝试从 thought 中提取
    if (!adapter) {
      return this.validateActionRequiredParams(
        this.extractActionFromThought(thought, availableTools, steps, originalMessage, ragContext, skillContext, intentTools),
      );
    }

    try {
      let prompt = this.buildActionSelectionPrompt(thought, availableTools, steps, originalMessage, hasExecutedTool, skillContext);

      // 工具反馈闭环：注入工具历史统计信息
      try {
        if (isCapabilityEnabled('toolFeedback')) {
          const tfConfig = getCapabilityConfig('toolFeedback');
          if (tfConfig.priorityOptimizationEnabled) {
            const toolStats = await toolFeedbackCollector.getToolStats();
            if (toolStats.length > 0) {
              const statsText = toolStats.map(s =>
                `- ${s.toolName}: 成功率 ${(s.successRate * 100).toFixed(1)}%, 平均耗时 ${Math.round(s.avgDuration)}ms (共 ${s.totalCalls} 次调用)`
              ).join('\n');
              prompt += `\n\n## 工具历史统计\n以下是各工具的历史执行统计，请优先选择成功率高、耗时短的工具：\n${statsText}`;
            }
          }
        }
      } catch (toolStatsError) {
        logger.warn('Failed to inject tool stats into prompt', {
          error: toolStatsError instanceof Error ? toolStatsError.message : String(toolStatsError),
        });
      }

      const response = await this.deps.callLLMSimple(prompt, adapter, provider, model, temperature);
      let parsed = parseLLMOutput(response);

      // 中间件管道：修正 LLM 输出（悬空调用、JSON 修复、工具名模糊匹配）
      if (this.deps.executeMiddleware) {
        try {
          const toolNames = availableTools.map(t => t.name);
          const middlewareResult = await this.deps.executeMiddleware(parsed, toolNames, skillContext);
          parsed = middlewareResult.output;
        } catch (mwError) {
          logger.warn('selectAction: middleware pipeline execution failed, using original parsed output', {
            error: mwError instanceof Error ? mwError.message : String(mwError),
          });
        }
      }

      if (!parsed.parseSuccess) {
        logger.warn('selectAction: LLM output parsing failed', {
          parseError: parsed.parseError,
          rawOutput: parsed.rawOutput?.substring(0, 200),
        });
      }

      // 如果有 Final Answer 但还没执行过任何工具，强制从 thought 中提取 action
      if (parsed.finalAnswer && !hasExecutedTool) {
        logger.info('LLM returned Final Answer without executing tools, forcing action extraction', {
          skillContext: skillContext?.skillName,
        });

        const forcedAction = this.extractActionFromThought(thought, availableTools, steps, originalMessage, ragContext, skillContext, intentTools);
        if (forcedAction) {
          logger.debug('Forced action extraction succeeded', {
            toolName: forcedAction.toolName,
            skillContext: skillContext?.skillName,
          });
          const validated = this.validateActionRequiredParams(forcedAction);
          if (validated) return validated;
        }

        // 最后手段：直接选择 toolPriority 中第一个可用工具
        if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
          const firstAvailableTool = skillContext.toolPriority.find(toolName =>
            availableTools.some(t => t.name === toolName),
          );

          if (firstAvailableTool) {
            logger.warn('Using last-resort fallback: selecting first tool from toolPriority', {
              toolName: firstAvailableTool,
              skillContext: skillContext.skillName,
            });

            const defaultParams = skillContext.toolDefaults?.[firstAvailableTool] || {};
            const generatedInput = this.generateToolInput(firstAvailableTool, originalMessage);
            return this.validateActionRequiredParams({
              toolName: firstAvailableTool,
              toolInput: { ...defaultParams, ...(generatedInput || {}) },
            });
          }
        }
      }

      // 如果有 Final Answer 且已执行过工具，检查是否还有必要的查询未完成
      if (parsed.finalAnswer && hasExecutedTool) {
        const pendingAction = this.extractActionFromThought(thought, availableTools, steps, originalMessage, ragContext, skillContext, intentTools);
        if (pendingAction) {
          logger.info('LLM returned Final Answer but there are pending queries, continuing', {
            pendingTool: pendingAction.toolName,
            pendingInput: pendingAction.toolInput,
            skillContext: skillContext?.skillName,
          });
          const validated = this.validateActionRequiredParams(pendingAction);
          if (validated) return validated;
        }
        return null;
      }

      // 验证工具名称和参数
      if (parsed.action) {
        const tool = availableTools.find(t => t.name === parsed.action);
        if (tool) {
          const requiredParams = Object.entries(tool.parameters)
            .filter(([, info]) => info.required)
            .map(([name]) => name);
          const input = parsed.actionInput || {};
          const missingParams = requiredParams.filter(p => !(p in input) || !input[p]);

          if (missingParams.length > 0) {
            logger.warn('Missing required parameters, trying to extract from message', {
              tool: parsed.action,
              missingParams,
            });

            const extractedParams = this.generateToolInput(parsed.action, originalMessage);
            const defaultParams = skillContext?.toolDefaults?.[parsed.action] || {};
            const mergedInput = { ...defaultParams, ...input, ...(extractedParams || {}) };

            const stillMissing = requiredParams.filter(p => !(p in mergedInput) || !mergedInput[p]);
            if (stillMissing.length > 0) {
              logger.warn('Still missing required parameters after extraction, passing to executor for feedback', {
                tool: parsed.action,
                stillMissing,
              });
              return { toolName: parsed.action, toolInput: mergedInput };
            }

            return this.validateActionRequiredParams({
              toolName: parsed.action,
              toolInput: mergedInput,
            });
          }

          // 合并 skillContext 中的默认参数
          const defaultParams = skillContext?.toolDefaults?.[parsed.action] || {};
          const mergedFinalInput = { ...defaultParams, ...input };

          // device_query 命令语义校正 — 弱模型安全网
          if (parsed.action === 'device_query' && originalMessage) {
            const semanticInput = this.generateToolInput('device_query', originalMessage);
            if (semanticInput && semanticInput.command && mergedFinalInput.command) {
              const llmCommand = String(mergedFinalInput.command);
              const semanticCommand = String(semanticInput.command);
              if (llmCommand !== semanticCommand && semanticCommand !== '/interface') {
                logger.info('device_query command corrected by semantic routing', {
                  llmCommand,
                  semanticCommand,
                  originalMessage: originalMessage.substring(0, 100),
                });
                mergedFinalInput.command = semanticCommand;
                for (const [k, v] of Object.entries(semanticInput)) {
                  if (k !== 'command' && !(k in mergedFinalInput)) {
                    mergedFinalInput[k] = v;
                  }
                }
              }
            }
          }

          return this.validateActionRequiredParams({
            toolName: parsed.action,
            toolInput: mergedFinalInput,
          });
        }

        // Knife 2: 工具名称未找到，强行返回让底层报错
        logger.warn('Selected tool not found, triggering Knife 2 for fallback identification', { action: parsed.action });
        return { toolName: parsed.action, toolInput: parsed.actionInput || {} };
      }

      // LLM 没有选择工具，尝试从 thought 中提取
      const fallbackAction = this.extractActionFromThought(thought, availableTools, steps, originalMessage, ragContext, skillContext, intentTools);
      if (fallbackAction) {
        return this.validateActionRequiredParams(fallbackAction);
      }

      // Knife 2: 最后兜底
      if (parsed.action) {
        logger.warn('Final identification fallback: triggering Knife 2', { action: parsed.action });
        return { toolName: parsed.action, toolInput: parsed.actionInput || {} };
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to select action', { error: errorMessage });
      return this.validateActionRequiredParams(
        this.extractActionFromThought(thought, availableTools, steps, originalMessage, ragContext, skillContext, intentTools),
      );
    }
  }

  // ==================== 辅助方法 ====================

  /**
   * 验证 action 的必需参数
   * Knife 1: 不返回 null，让 action 带着缺失参数继续执行，触发结构化报错
   */
  validateActionRequiredParams(
    action: { toolName: string; toolInput: Record<string, unknown> } | null,
  ): { toolName: string; toolInput: Record<string, unknown> } | null {
    if (!action) return null;

    const tool = this.deps.getToolsMap().get(action.toolName);
    if (!tool) return action;

    const requiredParams = Object.entries(tool.parameters)
      .filter(([, info]) => info.required)
      .map(([name]) => name);

    if (requiredParams.length === 0) return action;

    const missingOrEmpty = requiredParams.filter(p => {
      const val = action.toolInput[p];
      return val === undefined || val === null || (typeof val === 'string' && val.trim() === '');
    });

    if (missingOrEmpty.length > 0) {
      // Knife 1: 不再返回 null，让 action 带着缺失参数继续执行
      return action;
    }

    return action;
  }

  /**
   * 从 thought 中提取工具调用（Skill 感知）
   *
   * Requirements: 1.1-1.4, 4.3, 4.5
   */
  extractActionFromThought(
    thought: string,
    availableTools: AgentTool[],
    steps: ReActStep[] = [],
    originalMessage: string = '',
    ragContext?: RAGContext,
    skillContext?: SkillContext,
    intentTools?: Array<{ name: string; params?: Record<string, unknown>; reason?: string }>,
  ): { toolName: string; toolInput: Record<string, unknown> } | null {
    const executedTools = steps
      .filter(s => s.type === 'action' && s.toolName)
      .map(s => s.toolName);

    const isToolAvailable = (name: string) => availableTools.some(t => t.name === name);

    const isToolExecutedSuccessfully = (name: string) => {
      const actionIndex = steps.findIndex(s => s.type === 'action' && s.toolName === name);
      if (actionIndex === -1) return false;
      const nextObs = steps.slice(actionIndex + 1).find(s => s.type === 'observation');
      return nextObs?.success === true;
    };

    // Skill 感知的工具优先级选择
    if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
      logger.debug('Using Skill-aware tool priority selection', {
        skillName: skillContext.skillName,
        toolPriority: skillContext.toolPriority,
        executedTools,
      });

      for (const toolName of skillContext.toolPriority) {
        if (isToolAvailable(toolName) && !isToolExecutedSuccessfully(toolName)) {
          if (intentTools && intentTools.length > 0) {
            const isIntentTool = intentTools.some(t => t.name === toolName);
            if (!isIntentTool) {
              logger.debug('Skipping tool not in intentAnalysis.tools', {
                toolName,
                skillName: skillContext.skillName,
                intentTools: intentTools.map(t => t.name),
              });
              continue;
            }
          }

          const defaultParams = skillContext.toolDefaults?.[toolName] || {};
          const generatedInput = this.generateToolInput(toolName, originalMessage);
          if (generatedInput === null && Object.keys(defaultParams).length === 0) {
            logger.debug('Skipping tool due to null generateToolInput and no defaults', {
              toolName,
              skillName: skillContext.skillName,
            });
            continue;
          }
          const toolInput = { ...defaultParams, ...(generatedInput || {}) };

          logger.debug('Selected tool from Skill toolPriority', {
            skillName: skillContext.skillName,
            selectedTool: toolName,
            reason: 'first available unexecuted tool in priority list',
          });

          return { toolName, toolInput };
        }
      }

      logger.debug('All toolPriority tools have been executed', {
        skillName: skillContext.skillName,
        toolPriority: skillContext.toolPriority,
      });
      return null;
    }

    // 没有 Skill 上下文时，回退到原有默认逻辑
    logger.debug('No Skill context, using default fallback logic');

    if (this.deps.knowledgeEnhancedMode && !ragContext?.hasRetrieved) {
      if (isToolAvailable('knowledge_search') && !isToolExecutedSuccessfully('knowledge_search')) {
        const input = this.generateToolInput('knowledge_search', originalMessage);
        if (input) {
          return { toolName: 'knowledge_search', toolInput: input };
        }
      }
    }

    if (isToolAvailable('monitor_metrics') && !isToolExecutedSuccessfully('monitor_metrics')) {
      return { toolName: 'monitor_metrics', toolInput: {} };
    }

    if (isToolAvailable('device_query') && !executedTools.includes('device_query')) {
      const semanticInput = this.generateToolInput('device_query', originalMessage);
      return {
        toolName: 'device_query',
        toolInput: semanticInput || { command: '/interface' },
      };
    }

    if (isToolAvailable('execute_command') && !isToolExecutedSuccessfully('execute_command')) {
      const writeKeywords = /添加|删除|启用|禁用|创建|移除|重启|add|remove|enable|disable|create|delete|restart/i;
      if (writeKeywords.test(originalMessage)) {
        const toolInput = this.generateToolInput('execute_command', originalMessage);
        if (toolInput !== null && Object.keys(toolInput).length > 0) {
          logger.debug('Detected write-operation intent in user message, selecting execute_command');
          return { toolName: 'execute_command', toolInput };
        } else {
          logger.debug('Write-operation intent detected but cannot generate valid params, skipping execute_command');
        }
      }
    }

    if (!this.deps.knowledgeEnhancedMode && isToolAvailable('knowledge_search') && !isToolExecutedSuccessfully('knowledge_search')) {
      const input = this.generateToolInput('knowledge_search', originalMessage);
      if (input) {
        return { toolName: 'knowledge_search', toolInput: input };
      }
    }

    return null;
  }

  /**
   * 语义路由：根据用户消息内容生成工具参数（回退默认值）
   * 当 LLM 无法正确生成工具参数时，使用关键词匹配猜测路径。
   * 这些路径是常见设备 API 的默认映射，实际路径应由 CapabilityManifest 动态提供。
   * TODO: 优先从 CapabilityManifest 获取设备支持的路径映射
   */
  generateToolInput(toolName: string, message: string): Record<string, unknown> | null {
    switch (toolName) {
      case 'monitor_metrics':
        return {};

      case 'device_query': {
        if (/ip\s*v?4|ip\s*地址|ipv4|ip\s*address|地址配置|ip\s*配置/i.test(message)) {
          return { command: '/ip/address' };
        }
        if (/路由表|route|路由信息|静态路由|默认路由|网关/i.test(message)) {
          return { command: '/ip/route' };
        }
        if (/dns|域名/i.test(message)) {
          return { command: '/ip/dns' };
        }
        if (/arp|mac.*地址|mac.*address/i.test(message)) {
          return { command: '/ip/arp', limit: 50 };
        }
        if (/dhcp|租约|lease/i.test(message)) {
          return { command: '/ip/dhcp-server/lease', limit: 50 };
        }
        if (/防火墙|firewall|filter|过滤/i.test(message)) {
          return { command: '/ip/firewall/filter', limit: 20, proplist: 'chain,action,src-address,dst-address,comment' };
        }
        if (/nat|端口转发|port forward|映射/i.test(message)) {
          return { command: '/ip/firewall/nat', limit: 20 };
        }
        if (/ospf/i.test(message)) {
          if (/邻居|neighbor/i.test(message)) {
            return { command: '/routing/ospf/neighbor' };
          }
          return { command: '/routing/ospf/instance' };
        }
        if (/bgp/i.test(message)) {
          return { command: '/routing/bgp/connection' };
        }
        if (/系统资源|system.*resource|cpu|内存|memory|磁盘|disk/i.test(message)) {
          return { command: '/system/resource' };
        }
        const interfaceMatch = message.match(/接口\s*(\w+)|接口\s*\((\w+)\)|lan\d+|wan\d+|ether\d+/i);
        if (interfaceMatch) {
          const interfaceName = interfaceMatch[1] || interfaceMatch[2] || interfaceMatch[0];
          return { command: '/interface', filter: `name=${interfaceName}` };
        }
        return { command: '/interface' };
      }

      case 'knowledge_search': {
        const ruleMatch = message.match(/规则名称[：:]\s*(.+?)(?:\n|$)/);
        const metricMatch = message.match(/指标[：:]\s*(.+?)(?:\n|$)/);
        const ifMatch = message.match(/接口\s*(\w+)|接口\s*\((\w+)\)|lan\d+|wan\d+/i);

        if (ruleMatch) return { query: ruleMatch[1].trim() };
        if (metricMatch) return { query: `${metricMatch[1].trim()} 告警` };
        if (ifMatch) {
          const name = ifMatch[1] || ifMatch[2] || ifMatch[0];
          return { query: `${name} 接口故障` };
        }
        if (message.includes('down') || message.includes('断开')) return { query: '接口断开故障处理' };
        if (message.includes('ospf')) return { query: 'OSPF 配置' };
        return { query: '网络故障处理' };
      }

      case 'generate_remediation': {
        const alertIdMatch = message.match(/告警\s*ID[：:]\s*([a-f0-9-]+)/i);
        if (alertIdMatch) return { alertId: alertIdMatch[1] };
        return null;
      }

      case 'alert_analysis': {
        const alertIdMatch = message.match(/告警\s*ID[：:]\s*([a-f0-9-]+)/i);
        if (alertIdMatch) return { alertId: alertIdMatch[1] };
        return null;
      }

      case 'execute_command': {
        const pathMatch = message.match(/\/[\w\/\-]+/);
        if (pathMatch) {
          const fullCliMatch = message.match(/(\/[\w\/\-]+(?:\s+[\w\-]+=\S+)*)/);
          if (fullCliMatch && fullCliMatch[0].includes('=')) {
            return { command: fullCliMatch[0] };
          }
          return { command: pathMatch[0] };
        }

        const ipMatch = message.match(/(?:IP|ip|地址)[：:\s]*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)/);
        const ifMatch = message.match(/(?:接口|interface)[：:\s]*([\w\-]+)/i);

        if (message.match(/添加|add/i) && ipMatch) {
          let cmd = `/ip/address/add address=${ipMatch[1]}`;
          if (ifMatch) cmd += ` interface=${ifMatch[1]}`;
          return { command: cmd };
        }
        if (message.match(/删除|remove|移除/i) && ipMatch) {
          return { command: `/ip/address/remove`, args: { address: ipMatch[1] } };
        }
        if (message.match(/启用|enable/i) && ifMatch) {
          return { command: `/interface/enable`, args: { numbers: ifMatch[1] } };
        }
        if (message.match(/禁用|disable/i) && ifMatch) {
          return { command: `/interface/disable`, args: { numbers: ifMatch[1] } };
        }

        return null;
      }

      default:
        return null;
    }
  }

  /**
   * 构建 Action 选择提示词
   * Requirements: 7.1-7.4
   */
  buildActionSelectionPrompt(
    thought: string,
    availableTools: AgentTool[],
    steps: ReActStep[] = [],
    originalMessage: string = '',
    hasExecutedTool?: boolean,
    skillContext?: SkillContext,
  ): string {
    const toolDescriptions = availableTools.map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
        .join('\n');
      return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
    }).join('\n\n');

    const executedTools = steps
      .filter(s => s.type === 'action' && s.toolName)
      .map(s => s.toolName);
    const failedTools = steps
      .filter(s => s.type === 'observation' && !s.success)
      .map((s, i) => {
        const actionStep = steps.filter(st => st.type === 'action')[i];
        return actionStep?.toolName;
      })
      .filter(Boolean);

    const hasTruncatedData = steps.some(s =>
      s.type === 'observation' &&
      typeof s.content === 'string' &&
      s.content.includes('数据截断警告'),
    );

    let contextInfo = '';
    if (originalMessage) contextInfo += `\n用户原始请求：${originalMessage}\n`;
    if (executedTools.length > 0) contextInfo += `\n已执行的工具：${executedTools.join(', ')}`;
    if (failedTools.length > 0) contextInfo += `\n执行失败的工具：${failedTools.join(', ')}（请避免重复调用或使用正确的参数）`;
    if (hasTruncatedData) contextInfo += `\n\n⚠️ 【重要】之前的查询结果被截断了！请使用 limit 和 proplist 参数重新查询。`;

    let finalAnswerRestriction = `
## Final Answer 限制
只有在以下情况下才能输出 Final Answer：
1. 已经执行了至少一个工具并获得了实际数据
2. 收集到的数据足以回答用户的问题`;

    if (hasExecutedTool === false) {
      finalAnswerRestriction += `

⚠️ **警告：你还没有执行任何工具！**
在执行至少一个工具之前，你不能输出 Final Answer。
如果你现在输出 Final Answer，它将被拒绝，系统会强制你执行工具。`;
    }

    let skillPriorityInfo = '';
    if (skillContext && skillContext.toolPriority && skillContext.toolPriority.length > 0) {
      skillPriorityInfo = `

## Skill 工具优先级 (${skillContext.skillName})
请按以下顺序优先使用工具：
${skillContext.toolPriority.map((t, i) => `${i + 1}. ${t}`).join('\n')}

这些工具是当前 Skill 推荐的，请优先考虑使用。`;
    }

    const formatExamples = `

## 正确的输出格式示例

示例 1 - 查询设备数据：
Action: device_query
Action Input: {"command": "<设备API路径>"}

示例 2 - 搜索知识库：
Action: knowledge_search
Action Input: {"query": "接口故障处理"}

示例 3 - 监控指标：
Action: monitor_metrics
Action Input: {}

示例 4 - 执行写入命令（推荐：将路径和参数写在 command 中）：
Action: execute_command
Action Input: {"command": "<设备API路径> <参数名>=<值>"}

示例 5 - 执行写入命令（路径 + args 分离写法）：
Action: execute_command
Action Input: {"command": "<设备API路径>", "args": {"<参数名>": "<值>"}}

示例 6 - 删除/禁用操作：
Action: execute_command
Action Input: {"command": "<设备API路径> <参数>"}`;

    return `## 设备信息
- 设备类型: 由 CapabilityManifest 动态提供
- API 协议: 由设备驱动决定

## 设备操作说明
设备 API 路径格式由设备驱动决定，请根据知识库或设备能力清单选择正确的路径。
常见操作类型包括：接口管理、IP 地址配置、路由管理、防火墙规则、系统资源查询等。

⚠️ 重要：请仔细分析用户请求中的关键词，选择最匹配的 API 路径。如果不确定路径，请先查询知识库。

## ⚠️ 分批处理提醒
对于可能返回大量数据的路径，**必须使用 limit 和 proplist 参数**：
- 防火墙/连接跟踪类路径 - limit=10~20, 使用 proplist 限制字段
- 日志类路径 - limit=20
- ARP/DHCP/DNS 缓存类路径 - limit=50
${finalAnswerRestriction}
${skillPriorityInfo}

基于以下思考，选择下一步行动：

思考：${thought}
${contextInfo}

可用工具（包含参数说明）：
${toolDescriptions}
${formatExamples}

重要规则：
1. device_query 用于只读查询，execute_command 用于写入/执行操作（如删除、添加、修改、脚本执行）
2. device_query 和 execute_command 的 command 参数使用设备驱动支持的格式
3. 正确示例: {"command": "<设备API路径>"} — 路径格式由设备驱动决定
4. 错误示例: {"command": "<路径>/print"}, {"command": "show ip route"} — 不要附加 CLI 动词
5. 如果工具返回 "no such command"，说明路径不对，尝试其他路径
6. 只有在已经执行过工具并获得了实际数据后，才能输出 Final Answer
7. **对于高危数据路径，必须使用 limit 和 proplist 参数！**
8. 需要执行清理、删除、添加、修改等写操作时，必须使用 execute_command，不要使用 device_query

请输出：
Action: 工具名称
Action Input: {"参数名": "参数值", ...}

注意：
- Action Input 必须是有效的 JSON 格式
- 必须提供所有标记为"必需"的参数`;
  }
}
