/**
 * MastraAgent 智能代理服务
 * 基于 Mastra 框架的智能代理，支持多步骤推理和工具调用
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
 * - 5.1: 初始化时注册可用工具（知识检索、设备查询、脚本执行）
 * - 5.2: 处理请求时根据任务确定要调用的工具
 * - 5.3: 调用工具时处理工具响应并继续推理
 * - 5.4: 支持多轮交互的会话记忆
 * - 5.5: 工具调用失败时优雅处理并尝试替代方案
 * - 5.6: 强制执行 LLM 调用的速率限制和 token 预算
 * - 5.7: 任务完成时提供带推理轨迹的结构化响应
 * - 5.8: 记录所有工具调用和 LLM 交互用于审计
 */

import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AIProvider, IAIProviderAdapter, ChatMessage as AIChatMessage } from '../../../types/ai';
import { AdapterFactory } from '../../ai/adapters';
import { apiConfigService } from '../../ai/apiConfigService';

// ==================== 类型定义 ====================

/**
 * Agent 工具定义
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Agent 消息
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolResults?: Array<{
    id: string;
    result: unknown;
  }>;
}

/**
 * Agent 响应
 */
export interface AgentResponse {
  message: string;
  reasoning: string[];
  toolCalls: Array<{
    tool: string;
    input: Record<string, unknown>;
    output: unknown;
    duration: number;
    /** 输出截断元数据（如果被截断） */
    truncationInfo?: {
      truncated: boolean;
      originalSize: number;
      truncatedSize: number;
    };
  }>;
  confidence: number;
  /** API 响应截断摘要 */
  truncationSummary?: {
    /** 是否有任何输出被截断 */
    anyTruncated: boolean;
    /** 被截断的工具数量 */
    truncatedCount: number;
    /** 总原始大小 */
    totalOriginalSize: number;
    /** 总截断后大小 */
    totalTruncatedSize: number;
  };
  /** LLM token 使用量 */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Agent 配置
 */
export interface AgentConfig {
  maxIterations: number;      // 最大迭代次数，默认 10
  maxTokens: number;          // 最大 token 数，默认 4000
  temperature: number;        // 温度，默认 0.7
  tools: AgentTool[];
}

/**
 * 会话记忆
 */
export interface ConversationMemory {
  sessionId: string;
  messages: AgentMessage[];
  context: Record<string, unknown>;
  createdAt: number;
  lastUpdated: number;
}

/**
 * 审计日志条目
 */
export interface AgentAuditEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  type: 'tool_call' | 'llm_request' | 'error';
  details: {
    tool?: string;
    input?: unknown;
    output?: unknown;
    duration?: number;
    error?: string;
    tokens?: number;
    /** 输出是否被截断 */
    truncated?: boolean;
    /** 原始输出大小（字符数） */
    originalSize?: number;
  };
}

/**
 * Agent 统计
 */
export interface AgentStats {
  totalSessions: number;
  totalToolCalls: number;
  totalLLMRequests: number;
  avgResponseTime: number;
  errorCount: number;
}

// 默认配置
const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxIterations: 10,
  maxTokens: 4000,
  temperature: 0.7,
  tools: [],
};

// 数据目录
const SESSIONS_DATA_DIR = 'data/ai-ops/rag/sessions';
const AUDIT_DATA_DIR = 'data/ai-ops/rag/audit';

// API 响应截断配置
const API_TRUNCATION_CONFIG = {
  /** 单个工具输出的最大字符数（50KB） */
  maxToolOutputSize: 50 * 1024,
  /** 所有工具输出的总最大字符数（200KB） */
  maxTotalOutputSize: 200 * 1024,
  /** 是否启用 API 截断 */
  enabled: true,
};

/**
 * API 响应截断元数据
 */
interface TruncationMetadata {
  /** 是否被截断 */
  truncated: boolean;
  /** 原始大小（字节） */
  originalSize: number;
  /** 截断后大小（字节） */
  truncatedSize: number;
  /** 截断原因 */
  reason?: string;
}

/**
 * 截断工具输出用于 API 响应
 * 防止大量数据返回给前端导致性能问题
 * 
 * @param output 工具输出
 * @param maxSize 最大字符数
 * @returns 截断后的输出和元数据
 */
function truncateToolOutputForApi(
  output: unknown,
  maxSize: number = API_TRUNCATION_CONFIG.maxToolOutputSize
): { output: unknown; metadata: TruncationMetadata } {
  // 如果截断未启用，直接返回
  if (!API_TRUNCATION_CONFIG.enabled) {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    return {
      output,
      metadata: {
        truncated: false,
        originalSize: outputStr.length,
        truncatedSize: outputStr.length,
      },
    };
  }

  // 转换为字符串以计算大小
  let outputStr: string;
  try {
    outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  } catch {
    outputStr = String(output);
  }

  const originalSize = outputStr.length;

  // 如果不需要截断
  if (originalSize <= maxSize) {
    return {
      output,
      metadata: {
        truncated: false,
        originalSize,
        truncatedSize: originalSize,
      },
    };
  }

  // 需要截断
  const truncatedStr = outputStr.substring(0, maxSize);
  
  // 尝试解析回原始类型
  let truncatedOutput: unknown;
  if (typeof output === 'string') {
    truncatedOutput = truncatedStr + `\n\n...[数据已截断: 原始 ${originalSize} 字符，显示前 ${maxSize} 字符]`;
  } else {
    // 对于对象/数组，尝试找到最后一个完整的 JSON 结构
    try {
      // 尝试找到最后一个完整的数组元素或对象
      let lastValidIndex = truncatedStr.lastIndexOf('},');
      if (lastValidIndex === -1) {
        lastValidIndex = truncatedStr.lastIndexOf('}');
      }
      
      if (lastValidIndex > 0 && Array.isArray(output)) {
        // 对于数组，尝试截断到最后一个完整元素
        const partialStr = truncatedStr.substring(0, lastValidIndex + 1) + ']';
        try {
          truncatedOutput = JSON.parse(partialStr);
          // 添加截断标记
          if (Array.isArray(truncatedOutput)) {
            truncatedOutput.push({
              _truncation_notice: `数据已截断: 原始 ${originalSize} 字符，显示前 ${maxSize} 字符`,
              _original_size: originalSize,
              _truncated_size: maxSize,
            });
          }
        } catch {
          // 解析失败，使用字符串形式
          truncatedOutput = {
            _truncated_data: truncatedStr,
            _truncation_notice: `数据已截断: 原始 ${originalSize} 字符，显示前 ${maxSize} 字符`,
            _original_size: originalSize,
            _truncated_size: maxSize,
          };
        }
      } else {
        // 对于对象或解析失败的情况
        truncatedOutput = {
          _truncated_data: truncatedStr,
          _truncation_notice: `数据已截断: 原始 ${originalSize} 字符，显示前 ${maxSize} 字符`,
          _original_size: originalSize,
          _truncated_size: maxSize,
        };
      }
    } catch {
      truncatedOutput = {
        _truncated_data: truncatedStr,
        _truncation_notice: `数据已截断: 原始 ${originalSize} 字符，显示前 ${maxSize} 字符`,
        _original_size: originalSize,
        _truncated_size: maxSize,
      };
    }
  }

  logger.warn('Tool output truncated for API response', {
    originalSize,
    truncatedSize: maxSize,
    truncationRatio: ((originalSize - maxSize) / originalSize * 100).toFixed(1) + '%',
  });

  return {
    output: truncatedOutput,
    metadata: {
      truncated: true,
      originalSize,
      truncatedSize: maxSize,
      reason: `数据超过 ${maxSize} 字符限制`,
    },
  };
}


/**
 * MastraAgent 智能代理类
 */
export class MastraAgent {
  private config: AgentConfig;
  private tools: Map<string, AgentTool> = new Map();
  private sessions: Map<string, ConversationMemory> = new Map();
  private initialized: boolean = false;
  private sessionsDir: string;
  private auditDir: string;

  // 统计信息
  private stats: AgentStats = {
    totalSessions: 0,
    totalToolCalls: 0,
    totalLLMRequests: 0,
    avgResponseTime: 0,
    errorCount: 0,
  };

  // 速率限制
  private lastRequestTime: number = 0;
  private requestCount: number = 0;
  private readonly rateLimitWindow: number = 60000; // 1 分钟
  private readonly maxRequestsPerWindow: number = 30;

  constructor(config?: Partial<AgentConfig>) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    this.sessionsDir = SESSIONS_DATA_DIR;
    this.auditDir = AUDIT_DATA_DIR;
    
    // 注册初始工具
    if (config?.tools) {
      for (const tool of config.tools) {
        this.registerTool(tool);
      }
    }
    
    logger.info('MastraAgent created', { 
      maxIterations: this.config.maxIterations,
      toolCount: this.tools.size 
    });
  }

  /**
   * 初始化 Agent
   * Requirement 5.1: 初始化时注册可用工具
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('MastraAgent already initialized');
      return;
    }

    try {
      // 确保数据目录存在
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.mkdir(this.auditDir, { recursive: true });

      // 加载现有会话
      await this.loadSessions();

      this.initialized = true;
      logger.info('MastraAgent initialized', { 
        sessionsLoaded: this.sessions.size,
        toolsRegistered: this.tools.size 
      });
    } catch (error) {
      logger.error('Failed to initialize MastraAgent', { error });
      throw error;
    }
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MastraAgent not initialized. Call initialize() first.');
    }
  }

  // ==================== 工具管理 ====================

  /**
   * 注册工具
   * Requirement 5.1: 注册可用工具
   */
  registerTool(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool ${tool.name} already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    logger.info(`Registered tool: ${tool.name}`);
  }

  /**
   * 注销工具
   */
  unregisterTool(name: string): void {
    if (this.tools.delete(name)) {
      logger.info(`Unregistered tool: ${name}`);
    } else {
      logger.warn(`Tool ${name} not found`);
    }
  }

  /**
   * 获取所有注册的工具
   */
  getTools(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取工具描述（用于 LLM 提示词）
   */
  // getToolDescriptions() 已被 buildToolDescriptionsForLLM() 替代，已删除

  // ==================== 会话管理 ====================

  /**
   * 创建新会话
   * Requirement 5.4: 支持多轮交互的会话记忆
   */
  createSession(): string {
    const sessionId = uuidv4();
    const session: ConversationMemory = {
      sessionId,
      messages: [],
      context: {},
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };
    
    this.sessions.set(sessionId, session);
    this.stats.totalSessions++;
    
    logger.info(`Created session: ${sessionId}`);
    return sessionId;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): ConversationMemory | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * 清除会话
   */
  async clearSession(sessionId: string): Promise<void> {
    if (this.sessions.delete(sessionId)) {
      // 删除会话文件
      try {
        const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
        await fs.unlink(sessionPath);
      } catch {
        // 文件可能不存在
      }
      logger.info(`Cleared session: ${sessionId}`);
    }
  }

  /**
   * 获取所有会话
   */
  getSessions(): ConversationMemory[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 保存会话到文件
   */
  private async saveSession(session: ConversationMemory): Promise<void> {
    const sessionPath = path.join(this.sessionsDir, `${session.sessionId}.json`);
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
  }

  /**
   * 加载所有会话
   */
  private async loadSessions(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const sessionPath = path.join(this.sessionsDir, file);
            const data = await fs.readFile(sessionPath, 'utf-8');
            const session = JSON.parse(data) as ConversationMemory;
            this.sessions.set(session.sessionId, session);
          } catch (error) {
            logger.warn(`Failed to load session file: ${file}`, { error });
          }
        }
      }
    } catch {
      // 目录可能不存在
    }
  }


  // ==================== 对话处理 ====================

  // ==================== LLM 适配器管理 ====================

  /**
   * 获取 AI 适配器（延迟获取，每次从最新配置创建）
   */
  private async getAIAdapter(): Promise<{ adapter: IAIProviderAdapter; provider: AIProvider; model: string }> {
    const config = await apiConfigService.getDefault();
    if (!config) {
      throw new Error('No AI provider configured. Please configure an AI provider in settings.');
    }
    const apiKey = await apiConfigService.getDecryptedApiKey(config.id);
    const adapter = AdapterFactory.createAdapter(config.provider, {
      apiKey,
      endpoint: config.endpoint,
    });
    return { adapter, provider: config.provider, model: config.model };
  }

  /**
   * 构建 OpenAI function-calling 格式的工具描述
   */
  private buildToolDescriptionsForLLM(): string {
    const toolDefs: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
    for (const tool of this.tools.values()) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [paramName, paramInfo] of Object.entries(tool.parameters)) {
        properties[paramName] = {
          type: paramInfo.type === 'number' ? 'number' : 'string',
          description: paramInfo.description,
        };
        if (paramInfo.required) required.push(paramName);
      }
      toolDefs.push({
        name: tool.name,
        description: tool.description,
        parameters: { type: 'object', properties, required },
      });
    }
    return JSON.stringify(toolDefs, null, 2);
  }

  /**
   * 从 LLM 响应中解析工具调用指令
   * 支持格式: [TOOL_CALL] {"tool":"xxx","params":{...}} [/TOOL_CALL]
   */
  private parseToolCalls(content: string): Array<{ tool: string; params: Record<string, unknown> }> {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const regex = /\[TOOL_CALL\]\s*([\s\S]*?)\s*\[\/TOOL_CALL\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.tool && typeof parsed.tool === 'string') {
          calls.push({ tool: parsed.tool, params: parsed.params || {} });
        }
      } catch {
        logger.warn('[MastraAgent] Failed to parse tool call JSON', { raw: match[1] });
      }
    }
    return calls;
  }

  /**
   * 处理对话消息 — 真正的 LLM function-calling 循环
   * Requirements: 5.2, 5.3, 5.4, 5.5, 5.7
   */
  async chat(message: string, sessionId?: string): Promise<AgentResponse> {
    this.ensureInitialized();

    const startTime = Date.now();
    const reasoning: string[] = [];
    const toolCallResults: AgentResponse['toolCalls'] = [];

    // 获取或创建会话
    let session: ConversationMemory;
    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      const newSessionId = sessionId || this.createSession();
      session = this.sessions.get(newSessionId)!;
    }

    // 添加用户消息
    session.messages.push({
      role: 'user',
      content: message,
    });

    try {
      // 检查速率限制
      await this.checkRateLimit();

      // 获取 AI 适配器
      const { adapter, provider, model } = await this.getAIAdapter();
      reasoning.push('已获取 AI 适配器，开始 LLM 推理循环...');

      // 构建系统提示词（包含工具描述）
      const toolDescriptions = this.buildToolDescriptionsForLLM();
      const systemPrompt = `You are an intelligent agent with access to the following tools.

[AVAILABLE TOOLS]
${toolDescriptions}

[TOOL CALLING FORMAT]
When you need to call a tool, output EXACTLY this format (you may call multiple tools):
[TOOL_CALL] {"tool": "tool_name", "params": {"param1": "value1"}} [/TOOL_CALL]

[RULES]
- You may call zero or more tools per response.
- After tool results are provided, continue reasoning and optionally call more tools.
- When you have enough information, provide your final answer WITHOUT any [TOOL_CALL] tags.
- Always reason step by step before deciding which tools to call.
- If no tools are needed, respond directly.`;

      // 构建对话历史（限制最近消息，防止 token 膨胀）
      const recentMessages = session.messages.slice(-10);
      const chatMessages: AIChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...recentMessages.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        })),
      ];

      // LLM 推理循环：LLM 决定调用工具 → 执行 → 反馈结果 → LLM 继续推理
      let iterations = 0;
      let finalResponse = '';
      let lastUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;

      while (iterations < this.config.maxIterations) {
        iterations++;

        const llmResponse = await adapter.chat({
          provider,
          model,
          messages: chatMessages,
          stream: false,
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
        });

        this.stats.totalLLMRequests++;

        // 追踪 token 使用量
        if (llmResponse.usage) {
          lastUsage = lastUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          lastUsage.promptTokens = (lastUsage.promptTokens || 0) + (llmResponse.usage.promptTokens || 0);
          lastUsage.completionTokens = (lastUsage.completionTokens || 0) + (llmResponse.usage.completionTokens || 0);
          lastUsage.totalTokens = (lastUsage.totalTokens || 0) + (llmResponse.usage.totalTokens || 0);
        }

        const content = llmResponse.content || '';
        const parsedCalls = this.parseToolCalls(content);

        // 提取 reasoning（工具调用标签之外的文本）
        const reasoningText = content.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/g, '').trim();
        if (reasoningText) {
          reasoning.push(reasoningText);
        }

        // 如果没有工具调用，这是最终响应
        if (parsedCalls.length === 0) {
          finalResponse = content;
          break;
        }

        // 执行工具调用
        const toolResultMessages: string[] = [];

        for (const call of parsedCalls) {
          const tool = this.tools.get(call.tool);
          if (!tool) {
            const errMsg = `工具 ${call.tool} 未注册，跳过`;
            reasoning.push(errMsg);
            toolResultMessages.push(`[TOOL_RESULT] ${call.tool}: ERROR - ${errMsg} [/TOOL_RESULT]`);
            continue;
          }

          try {
            reasoning.push(`调用工具 ${call.tool}...`);
            const toolStartTime = Date.now();
            const result = await tool.execute(call.params);
            const duration = Date.now() - toolStartTime;

            const { output: truncatedOutput, metadata: truncationMetadata } = truncateToolOutputForApi(result);

            toolCallResults.push({
              tool: call.tool,
              input: call.params,
              output: truncatedOutput,
              duration,
              truncationInfo: truncationMetadata.truncated ? {
                truncated: true,
                originalSize: truncationMetadata.originalSize,
                truncatedSize: truncationMetadata.truncatedSize,
              } : undefined,
            });

            await this.logAudit({
              sessionId: session.sessionId,
              type: 'tool_call',
              details: {
                tool: call.tool,
                input: call.params,
                output: result,
                duration,
                truncated: truncationMetadata.truncated,
                originalSize: truncationMetadata.originalSize,
              },
            });

            // 截断工具结果用于反馈给 LLM（防止 token 爆炸）
            const resultStr = JSON.stringify(truncatedOutput);
            const maxResultLen = 4000;
            const feedbackResult = resultStr.length > maxResultLen
              ? resultStr.slice(0, maxResultLen) + '...[truncated]'
              : resultStr;
            toolResultMessages.push(`[TOOL_RESULT] ${call.tool}: ${feedbackResult} [/TOOL_RESULT]`);
            reasoning.push(`工具 ${call.tool} 执行成功，耗时 ${duration}ms`);
            this.stats.totalToolCalls++;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            reasoning.push(`工具 ${call.tool} 执行失败: ${errorMessage}`);
            toolResultMessages.push(`[TOOL_RESULT] ${call.tool}: ERROR - ${errorMessage} [/TOOL_RESULT]`);

            await this.logAudit({
              sessionId: session.sessionId,
              type: 'error',
              details: { tool: call.tool, error: errorMessage },
            });
            this.stats.errorCount++;
          }
        }

        // 将工具结果反馈给 LLM，继续推理
        chatMessages.push({ role: 'assistant', content });
        chatMessages.push({ role: 'user', content: toolResultMessages.join('\n') });

        // P1: 滑动窗口压缩 — 防止长迭代链导致 context window 溢出
        // 保留 system prompt (index 0) + 最近 6 条消息（3 轮对话），中间压缩为摘要
        const MAX_CONTEXT_MESSAGES = 20;
        if (chatMessages.length > MAX_CONTEXT_MESSAGES) {
          const systemMsg = chatMessages[0]; // system prompt 永远保留
          const keepRecent = 6; // 保留最近 3 轮（assistant + user 各 1 条 = 1 轮）
          const middleMessages = chatMessages.slice(1, chatMessages.length - keepRecent);

          // 压缩中间消息为摘要：只保留工具名和简短结果
          const summaryParts: string[] = [];
          for (const msg of middleMessages) {
            if (msg.role === 'assistant') {
              const toolMatches = msg.content.match(/\[TOOL_CALL\]\s*\{[^}]*"tool"\s*:\s*"([^"]+)"/g);
              if (toolMatches) {
                const toolNames = toolMatches.map(m => {
                  const match = m.match(/"tool"\s*:\s*"([^"]+)"/);
                  return match ? match[1] : 'unknown';
                });
                summaryParts.push(`Called: ${toolNames.join(', ')}`);
              }
            } else if (msg.role === 'user' && msg.content.includes('[TOOL_RESULT]')) {
              const resultMatches = msg.content.match(/\[TOOL_RESULT\]\s*(\S+?):\s*(.{0,80})/g);
              if (resultMatches) {
                for (const r of resultMatches) {
                  summaryParts.push(r.slice(0, 120));
                }
              }
            }
          }

          const contextSummary = `[CONTEXT SUMMARY - ${middleMessages.length} messages compressed]\n${summaryParts.join('\n')}`;
          const recentMessages = chatMessages.slice(chatMessages.length - keepRecent);

          chatMessages.length = 0;
          chatMessages.push(systemMsg);
          chatMessages.push({ role: 'user', content: contextSummary });
          chatMessages.push(...recentMessages);
        }
      }

      if (!finalResponse && iterations >= this.config.maxIterations) {
        finalResponse = reasoning[reasoning.length - 1] || '达到最大推理迭代次数，已完成可用的工具调用。';
        reasoning.push('达到最大迭代次数限制，结束推理循环');
      }

      // 添加助手消息到会话
      session.messages.push({
        role: 'assistant',
        content: finalResponse,
        toolCalls: toolCallResults.map((tc, i) => ({
          id: `call_${i}`,
          name: tc.tool,
          arguments: tc.input,
        })),
      });

      // 裁剪会话消息，防止无限增长（保留最近 30 条）
      const MAX_SESSION_MESSAGES = 30;
      if (session.messages.length > MAX_SESSION_MESSAGES) {
        session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
      }

      session.lastUpdated = Date.now();
      await this.saveSession(session);

      const confidence = this.calculateConfidence(toolCallResults, reasoning);
      const totalTime = Date.now() - startTime;
      this.updateStats(totalTime);
      const truncationSummary = this.calculateTruncationSummary(toolCallResults);

      return {
        message: finalResponse,
        reasoning,
        toolCalls: toolCallResults,
        confidence,
        truncationSummary: truncationSummary.anyTruncated ? truncationSummary : undefined,
        usage: lastUsage,
      } as AgentResponse;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      reasoning.push(`处理失败: ${errorMessage}`);

      await this.logAudit({
        sessionId: session.sessionId,
        type: 'error',
        details: { error: errorMessage },
      });

      this.stats.errorCount++;
      const truncationSummary = this.calculateTruncationSummary(toolCallResults);
      const errorConfidence = toolCallResults.length > 0
        ? Math.max(0.1, this.calculateConfidence(toolCallResults, reasoning) * 0.5)
        : 0.1;

      return {
        message: `处理请求时遇到问题: ${errorMessage}`,
        reasoning,
        toolCalls: toolCallResults,
        confidence: errorConfidence,
        truncationSummary: truncationSummary.anyTruncated ? truncationSummary : undefined,
      };
    }
  }

  /**
   * 执行任务
   * Requirement 5.7: 任务完成时提供带推理轨迹的结构化响应
   */
  async executeTask(task: string, context?: Record<string, unknown>): Promise<AgentResponse> {
    this.ensureInitialized();

    // 创建临时会话
    const sessionId = this.createSession();
    const session = this.sessions.get(sessionId)!;
    
    // 设置上下文
    if (context) {
      session.context = { ...session.context, ...context };
    }

    // 执行任务
    const response = await this.chat(task, sessionId);

    // 清理临时会话，防止 sessions Map 无限增长
    await this.clearSession(sessionId);

    return response;
  }


  // ==================== 私有辅助方法 ====================

  // analyzeIntent, extractToolParams, generateResponse 已被移除
  // chat() 现在使用真正的 LLM function-calling 循环，由 LLM 自主决定调用哪些工具

  /**
   * 计算置信度
   */
  private calculateConfidence(
      toolCalls: AgentResponse['toolCalls'],
      reasoning: string[]
    ): number {
      if (toolCalls.length === 0 && reasoning.length === 0) {
        return 0.3; // 无任何工具调用和推理时的基础值
      }

      // 维度1: 工具调用成功率 (权重 0.45)
      let toolSuccessScore = 0;
      if (toolCalls.length > 0) {
        const successfulCalls = toolCalls.filter(tc => tc.output !== null && tc.output !== undefined);
        toolSuccessScore = successfulCalls.length / toolCalls.length;
      }

      // 维度2: 推理深度 (权重 0.25)
      const reasoningDepth = Math.min(1.0, reasoning.length * 0.15);

      // 维度3: 错误惩罚 (权重 0.30)
      const errorCount = reasoning.filter(r => r.includes('失败') || r.includes('错误')).length;
      const errorPenalty = Math.max(0, 1.0 - errorCount * 0.25);

      const confidence = toolSuccessScore * 0.45 + reasoningDepth * 0.25 + errorPenalty * 0.30;

      return Math.max(0.1, Math.min(0.98, confidence));
    }


  /**
   * 计算截断摘要
   * 统计所有工具输出的截断情况
   */
  private calculateTruncationSummary(toolCalls: AgentResponse['toolCalls']): NonNullable<AgentResponse['truncationSummary']> {
    let anyTruncated = false;
    let truncatedCount = 0;
    let totalOriginalSize = 0;
    let totalTruncatedSize = 0;

    for (const tc of toolCalls) {
      // 检查输出是否包含截断标记
      const output = tc.output;
      if (output && typeof output === 'object') {
        const outputObj = output as Record<string, unknown>;
        if (outputObj._truncation_notice || outputObj._truncated_data) {
          anyTruncated = true;
          truncatedCount++;
          totalOriginalSize += (outputObj._original_size as number) || 0;
          totalTruncatedSize += (outputObj._truncated_size as number) || 0;
        } else if (Array.isArray(output)) {
          // 检查数组最后一个元素是否是截断标记
          const lastItem = output[output.length - 1] as Record<string, unknown> | undefined;
          if (lastItem && lastItem._truncation_notice) {
            anyTruncated = true;
            truncatedCount++;
            totalOriginalSize += (lastItem._original_size as number) || 0;
            totalTruncatedSize += (lastItem._truncated_size as number) || 0;
          }
        }
      } else if (typeof output === 'string' && output.includes('[数据已截断')) {
        anyTruncated = true;
        truncatedCount++;
        // 尝试从字符串中提取大小信息
        const match = output.match(/原始 (\d+) 字符，显示前 (\d+) 字符/);
        if (match) {
          totalOriginalSize += parseInt(match[1], 10);
          totalTruncatedSize += parseInt(match[2], 10);
        }
      }
    }

    return {
      anyTruncated,
      truncatedCount,
      totalOriginalSize,
      totalTruncatedSize,
    };
  }

  /**
   * 检查速率限制
   * Requirement 5.6: 强制执行速率限制
   */
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    
    // 重置窗口
    if (now - this.lastRequestTime > this.rateLimitWindow) {
      this.requestCount = 0;
      this.lastRequestTime = now;
    }

    // 检查限制
    if (this.requestCount >= this.maxRequestsPerWindow) {
      const waitTime = this.rateLimitWindow - (now - this.lastRequestTime);
      throw new Error(`速率限制：请等待 ${Math.ceil(waitTime / 1000)} 秒后重试`);
    }

    this.requestCount++;
  }

  /**
   * 更新统计信息
   */
  private updateStats(responseTime: number): void {
    // totalLLMRequests 已在 chat() 循环中按实际 LLM 调用次数累加，此处不再重复 ++
    const totalReqs = Math.max(this.stats.totalLLMRequests, 1);
    this.stats.avgResponseTime = 
      (this.stats.avgResponseTime * (totalReqs - 1) + responseTime) / totalReqs;
  }

  /**
   * 记录审计日志
   * Requirement 5.8: 记录所有工具调用和 LLM 交互
   */
  private async logAudit(entry: Omit<AgentAuditEntry, 'id' | 'timestamp'>): Promise<void> {
    const auditEntry: AgentAuditEntry = {
      id: uuidv4(),
      timestamp: Date.now(),
      ...entry,
    };

    try {
      // 按日期分片存储
      const date = new Date().toISOString().split('T')[0];
      const auditPath = path.join(this.auditDir, `${date}.json`);

      let entries: AgentAuditEntry[] = [];
      try {
        const data = await fs.readFile(auditPath, 'utf-8');
        entries = JSON.parse(data);
      } catch {
        // 文件不存在
      }

      entries.push(auditEntry);
      await fs.writeFile(auditPath, JSON.stringify(entries, null, 2));
    } catch (error) {
      logger.warn('Failed to write audit log', { error });
    }
  }

  // ==================== 配置和统计 ====================

  /**
   * 获取配置
   */
  getConfig(): AgentConfig {
    return { ...this.config, tools: this.getTools() };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<Omit<AgentConfig, 'tools'>>): void {
    this.config = { ...this.config, ...config };
    logger.info('MastraAgent config updated', { config: this.config });
  }

  /**
   * 获取统计信息
   */
  getStats(): AgentStats {
    return { ...this.stats };
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// 导出单例实例
export const mastraAgent = new MastraAgent();
