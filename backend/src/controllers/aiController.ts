/**
 * AI Controller
 * 处理 AI Agent Client 相关的 API 请求
 *
 * 功能：
 * - API 配置管理（CRUD、默认提供商、连接测试）
 * - 聊天功能（流式/非流式响应）
 * - 脚本执行（执行、验证、历史记录）
 * - 会话管理（CRUD、消息、导出）
 *
 * Requirements: 1.1-1.7, 2.1-2.8, 4.1-4.7, 5.1-5.6
 */

import { Request, Response } from 'express';
import {
  apiConfigService,
  chatSessionService,
  scriptExecutorService,
  contextBuilderService,
  rateLimiterService,
  AdapterFactory,
  conversationCollector,
} from '../services/ai';
import {
  AIProvider,
  ChatMessage,
  CreateAPIConfigInput,
  UpdateAPIConfigInput,
  DEFAULT_ENDPOINTS,
  DEFAULT_MODELS,
  SessionConfig,
  UpdateSessionInput,
  ConvertToKnowledgeRequest,
} from '../types/ai';
import { logger } from '../utils/logger';

// ==================== API 配置管理 ====================

/**
 * 获取所有 API 配置
 * GET /api/ai/configs
 */
export async function getConfigs(_req: Request, res: Response): Promise<void> {
  try {
    const configs = await apiConfigService.getAllDisplay();
    res.json({ success: true, data: configs });
  } catch (error) {
    logger.error('Failed to get API configs:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取配置失败',
    });
  }
}


/**
 * 获取单个 API 配置
 * GET /api/ai/configs/:id
 */
export async function getConfigById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const config = await apiConfigService.getByIdDisplay(id);

    if (!config) {
      res.status(404).json({ success: false, error: '配置不存在' });
      return;
    }

    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get API config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取配置失败',
    });
  }
}

/**
 * 创建 API 配置
 * POST /api/ai/configs
 */
export async function createConfig(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as CreateAPIConfigInput;

    // 验证必填字段
    if (!input.provider || !input.name || !input.apiKey || !input.model) {
      res.status(400).json({
        success: false,
        error: '缺少必填字段：provider, name, apiKey, model',
      });
      return;
    }

    // 验证提供商类型
    if (!Object.values(AIProvider).includes(input.provider)) {
      res.status(400).json({
        success: false,
        error: `不支持的提供商类型: ${input.provider}`,
      });
      return;
    }

    // 自定义供应商必须提供端点
    if (input.provider === AIProvider.CUSTOM && !input.endpoint) {
      res.status(400).json({
        success: false,
        error: '自定义供应商必须提供 API 端点地址',
      });
      return;
    }

    const config = await apiConfigService.create(input);
    const display = await apiConfigService.getByIdDisplay(config.id);

    res.status(201).json({ success: true, data: display });
  } catch (error) {
    logger.error('Failed to create API config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建配置失败',
    });
  }
}


/**
 * 更新 API 配置
 * PUT /api/ai/configs/:id
 */
export async function updateConfig(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const updates = req.body as UpdateAPIConfigInput;

    // 验证提供商类型（如果提供）
    if (updates.provider && !Object.values(AIProvider).includes(updates.provider)) {
      res.status(400).json({
        success: false,
        error: `不支持的提供商类型: ${updates.provider}`,
      });
      return;
    }

    const config = await apiConfigService.update(id, updates);
    const display = await apiConfigService.getByIdDisplay(config.id);

    res.json({ success: true, data: display });
  } catch (error) {
    logger.error('Failed to update API config:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新配置失败',
    });
  }
}

/**
 * 删除 API 配置
 * DELETE /api/ai/configs/:id
 */
export async function deleteConfig(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await apiConfigService.delete(id);
    res.json({ success: true, message: '配置已删除' });
  } catch (error) {
    logger.error('Failed to delete API config:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除配置失败',
    });
  }
}

/**
 * 获取默认 API 配置
 * GET /api/ai/configs/default
 */
export async function getDefaultConfig(_req: Request, res: Response): Promise<void> {
  try {
    const config = await apiConfigService.getDefault();
    if (!config) {
      res.json({ success: true, data: null });
      return;
    }
    const display = await apiConfigService.getByIdDisplay(config.id);
    res.json({ success: true, data: display });
  } catch (error) {
    logger.error('Failed to get default config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取默认配置失败',
    });
  }
}


/**
 * 设置默认 API 配置
 * POST /api/ai/configs/:id/default
 */
export async function setDefaultConfig(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await apiConfigService.setDefault(id);
    res.json({ success: true, message: '已设置为默认配置' });
  } catch (error) {
    logger.error('Failed to set default config:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '设置默认配置失败',
    });
  }
}

/**
 * 测试 API 配置连接
 * POST /api/ai/configs/:id/test
 */
export async function testConfigConnection(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const config = await apiConfigService.getById(id);

    if (!config) {
      res.status(404).json({ success: false, error: '配置不存在' });
      return;
    }

    // 获取解密的 API Key
    const apiKey = await apiConfigService.getDecryptedApiKey(id);

    // 创建适配器并验证
    const adapter = AdapterFactory.createAdapter(config.provider, {
      apiKey,
      endpoint: config.endpoint,
    });

    const isValid = await adapter.validateApiKey(apiKey);

    res.json({
      success: true,
      data: {
        connected: isValid,
        message: isValid ? '连接成功' : '连接失败，请检查 API Key',
      },
    });
  } catch (error) {
    logger.error('Failed to test config connection:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '测试连接失败',
    });
  }
}

/**
 * 获取提供商默认配置
 * GET /api/ai/providers
 */
export function getProviders(_req: Request, res: Response): void {
  try {
    const providers = Object.values(AIProvider).map(provider => ({
      id: provider,
      name: getProviderDisplayName(provider),
      defaultEndpoint: DEFAULT_ENDPOINTS[provider],
      defaultModels: DEFAULT_MODELS[provider],
    }));
    res.json({ success: true, data: providers });
  } catch (error) {
    logger.error('Failed to get providers:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取提供商列表失败',
    });
  }
}


/**
 * 获取提供商显示名称
 */
function getProviderDisplayName(provider: AIProvider): string {
  const names: Record<AIProvider, string> = {
    [AIProvider.OPENAI]: 'OpenAI (ChatGPT)',
    [AIProvider.GEMINI]: 'Google Gemini',
    [AIProvider.CLAUDE]: 'Anthropic Claude',
    [AIProvider.DEEPSEEK]: 'DeepSeek',
    [AIProvider.QWEN]: '通义千问 (Qwen)',
    [AIProvider.ZHIPU]: '智谱AI (Zhipu)',
    [AIProvider.CUSTOM]: '自定义供应商 (Custom)',
  };
  return names[provider] || provider;
}

// ==================== 聊天功能 ====================

/**
 * 发送聊天消息（非流式）
 * POST /api/ai/chat
 */
export async function chat(req: Request, res: Response): Promise<void> {
  try {
    const { configId, sessionId, message, includeContext = true } = req.body as { configId?: string; sessionId?: string; message: string; includeContext?: boolean };

    if (!message) {
      res.status(400).json({ success: false, error: '消息内容不能为空' });
      return;
    }

    // 获取配置
    const config = configId
      ? await apiConfigService.getById(configId)
      : await apiConfigService.getDefault();

    if (!config) {
      res.status(400).json({
        success: false,
        error: configId ? '配置不存在' : '未配置默认 AI 提供商',
      });
      return;
    }

    // 检查速率限制
    if (!rateLimiterService.checkLimit(config.id)) {
      const waitTime = rateLimiterService.getWaitTimeMs(config.id);
      res.status(429).json({
        success: false,
        error: '请求过于频繁，请稍后再试',
        retryAfter: Math.ceil(waitTime / 1000),
      });
      return;
    }

    // 构建消息列表
    const messages: ChatMessage[] = [];

    // 添加系统提示词
    if (includeContext) {
      const context = await contextBuilderService.getConnectionContext();
      const systemPrompt = contextBuilderService.buildSystemPromptWithContext(context);
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 如果有会话，加载历史消息
    if (sessionId) {
      const session = await chatSessionService.getById(sessionId);
      if (session) {
        messages.push(...session.messages);
      }
    }

    // 添加用户消息
    messages.push({ role: 'user', content: message });

    // 获取解密的 API Key 并创建适配器
    const apiKey = await apiConfigService.getDecryptedApiKey(config.id);
    const adapter = AdapterFactory.createAdapter(config.provider, {
      apiKey,
      endpoint: config.endpoint,
    });

    // 发送请求
    const response = await adapter.chat({
      provider: config.provider,
      model: config.model,
      messages,
      stream: false,
    });

    // 保存消息到会话
    if (sessionId) {
      await chatSessionService.addMessage(sessionId, { role: 'user', content: message });
      await chatSessionService.addMessage(sessionId, { role: 'assistant', content: response.content });
    }

    res.json({
      success: true,
      data: {
        content: response.content,
        usage: response.usage,
      },
    });
  } catch (error) {
    logger.error('Chat request failed:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '聊天请求失败',
    });
  }
}


/**
 * 发送聊天消息（流式 SSE）
 * POST /api/ai/chat/stream
 */
export async function chatStream(req: Request, res: Response): Promise<void> {
  try {
    const { configId, sessionId, message, includeContext = true } = req.body as { configId?: string; sessionId?: string; message: string; includeContext?: boolean };

    if (!message) {
      res.status(400).json({ success: false, error: '消息内容不能为空' });
      return;
    }

    // 获取配置
    const config = configId
      ? await apiConfigService.getById(configId)
      : await apiConfigService.getDefault();

    if (!config) {
      res.status(400).json({
        success: false,
        error: configId ? '配置不存在' : '未配置默认 AI 提供商',
      });
      return;
    }

    // 检查速率限制
    if (!rateLimiterService.checkLimit(config.id)) {
      const waitTime = rateLimiterService.getWaitTimeMs(config.id);
      res.status(429).json({
        success: false,
        error: '请求过于频繁，请稍后再试',
        retryAfter: Math.ceil(waitTime / 1000),
      });
      return;
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 构建消息列表
    const messages: ChatMessage[] = [];

    // 添加系统提示词
    if (includeContext) {
      const context = await contextBuilderService.getConnectionContext();
      const systemPrompt = contextBuilderService.buildSystemPromptWithContext(context);
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 如果有会话，加载历史消息
    if (sessionId) {
      const session = await chatSessionService.getById(sessionId);
      if (session) {
        messages.push(...session.messages);
      }
    }

    // 添加用户消息
    messages.push({ role: 'user', content: message });

    // 获取解密的 API Key 并创建适配器
    const apiKey = await apiConfigService.getDecryptedApiKey(config.id);
    const adapter = AdapterFactory.createAdapter(config.provider, {
      apiKey,
      endpoint: config.endpoint,
    });

    // 保存用户消息到会话
    let assistantMessageId: string | undefined;
    if (sessionId) {
      await chatSessionService.addMessage(sessionId, { role: 'user', content: message });
    }

    // 流式响应
    let fullContent = '';
    try {
      const stream = adapter.chatStream({
        provider: config.provider,
        model: config.model,
        messages,
        stream: true,
      });

      for await (const chunk of stream) {
        fullContent += chunk;
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }

      // 保存助手消息到会话
      if (sessionId) {
        assistantMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        await chatSessionService.addMessage(sessionId, {
          id: assistantMessageId,
          role: 'assistant',
          content: fullContent
        });
      }

      // 发送完成事件（包含消息 ID）
      res.write(`data: ${JSON.stringify({ done: true, fullContent, messageId: assistantMessageId })}\n\n`);
      res.end();
    } catch (streamError) {
      logger.error('Stream error:', streamError);
      res.write(`data: ${JSON.stringify({ error: (streamError as Error).message })}\n\n`);
      res.end();
    }
  } catch (error) {
    logger.error('Chat stream request failed:', error);
    // 如果还没开始流式响应，返回 JSON 错误
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '聊天请求失败',
      });
    } else {
      res.write(`data: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
      res.end();
    }
  }
}


/**
 * 获取 RouterOS 上下文
 * GET /api/ai/context
 */
export async function getContext(_req: Request, res: Response): Promise<void> {
  try {
    const context = await contextBuilderService.getConnectionContext();
    res.json({ success: true, data: context });
  } catch (error) {
    logger.error('Failed to get context:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取上下文失败',
    });
  }
}

/**
 * 获取可用的配置段列表
 * GET /api/ai/context/sections
 */
export function getContextSections(_req: Request, res: Response): void {
  try {
    const sections = contextBuilderService.getAvailableConfigSections();
    res.json({ success: true, data: sections });
  } catch (error) {
    logger.error('Failed to get context sections:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取配置段列表失败',
    });
  }
}

/**
 * 获取指定配置段
 * GET /api/ai/context/sections/:section
 */
export async function getContextSection(req: Request, res: Response): Promise<void> {
  try {
    const { section } = req.params;
    const data = await contextBuilderService.getConfigSection(section);
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get context section:', error);
    const status = (error as Error).message.includes('Unknown') ? 400 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '获取配置段失败',
    });
  }
}

// ==================== 脚本执行 ====================

/**
 * 执行脚本
 * POST /api/ai/scripts/execute
 */
export async function executeScript(req: Request, res: Response): Promise<void> {
  try {
    const { script, sessionId, dryRun = false } = req.body as { script: string; sessionId: string; dryRun?: boolean };

    if (!script) {
      res.status(400).json({ success: false, error: '脚本内容不能为空' });
      return;
    }

    if (!sessionId) {
      res.status(400).json({ success: false, error: '会话 ID 不能为空' });
      return;
    }

    const { result, history } = await scriptExecutorService.executeAndRecord(
      { script, dryRun },
      sessionId
    );

    res.json({
      success: true,
      data: {
        result,
        historyId: history.id,
      },
    });
  } catch (error) {
    logger.error('Failed to execute script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '脚本执行失败',
    });
  }
}


/**
 * 验证脚本
 * POST /api/ai/scripts/validate
 */
export async function validateScript(req: Request, res: Response): Promise<void> {
  try {
    const { script } = req.body as { script: string };

    if (!script) {
      res.status(400).json({ success: false, error: '脚本内容不能为空' });
      return;
    }

    const result = await scriptExecutorService.validate(script);
    const dangerousCommands = scriptExecutorService.checkDangerousCommands(script);

    res.json({
      success: true,
      data: {
        ...result,
        dangerousCommands,
        hasDangerousCommands: dangerousCommands.length > 0,
      },
    });
  } catch (error) {
    logger.error('Failed to validate script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '脚本验证失败',
    });
  }
}

/**
 * 获取脚本执行历史
 * GET /api/ai/scripts/history
 */
export async function getScriptHistory(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.query;
    const history = await scriptExecutorService.getHistory(sessionId as string | undefined);
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get script history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取执行历史失败',
    });
  }
}

/**
 * 删除脚本执行历史
 * DELETE /api/ai/scripts/history/:id
 */
export async function deleteScriptHistory(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await scriptExecutorService.deleteHistory(id);
    res.json({ success: true, message: '历史记录已删除' });
  } catch (error) {
    logger.error('Failed to delete script history:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除历史记录失败',
    });
  }
}

/**
 * 清除会话的脚本执行历史
 * DELETE /api/ai/scripts/history/session/:sessionId
 */
export async function clearSessionScriptHistory(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.params;
    await scriptExecutorService.clearSessionHistory(sessionId);
    res.json({ success: true, message: '会话历史记录已清除' });
  } catch (error) {
    logger.error('Failed to clear session script history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '清除历史记录失败',
    });
  }
}


// ==================== 会话管理 ====================

/**
 * 获取所有会话
 * GET /api/ai/sessions
 */
export async function getSessions(req: Request, res: Response): Promise<void> {
  try {
    const sessions = await chatSessionService.getAll(req.tenantId, req.deviceId);
    res.json({ success: true, data: sessions });
  } catch (error) {
    logger.error('Failed to get sessions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取会话列表失败',
    });
  }
}

/**
 * 获取单个会话
 * GET /api/ai/sessions/:id
 */
export async function getSessionById(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const session = await chatSessionService.getById(id);

    if (!session) {
      res.status(404).json({ success: false, error: '会话不存在' });
      return;
    }

    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to get session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取会话失败',
    });
  }
}

/**
 * 创建会话
 * POST /api/ai/sessions
 */
export async function createSession(req: Request, res: Response): Promise<void> {
  try {
    const { provider, model, configId, mode = 'standard' } = req.body as { provider?: string; model?: string; configId?: string; mode?: string };

    // 验证模式
    if (mode !== 'standard' && mode !== 'knowledge-enhanced') {
      res.status(400).json({
        success: false,
        error: '无效的会话模式，必须是 standard 或 knowledge-enhanced',
      });
      return;
    }

    let sessionProvider = provider;
    let sessionModel = model;

    // 如果提供了 configId，从配置中获取 provider 和 model
    if (configId) {
      const config = await apiConfigService.getById(configId);
      if (config) {
        sessionProvider = config.provider;
        sessionModel = config.model;
      }
    }

    // 如果没有指定，使用默认配置
    if (!sessionProvider || !sessionModel) {
      const defaultConfig = await apiConfigService.getDefault();
      if (defaultConfig) {
        sessionProvider = sessionProvider || defaultConfig.provider;
        sessionModel = sessionModel || defaultConfig.model;
      }
    }

    // 最终验证
    if (!sessionProvider || !sessionModel) {
      res.status(400).json({
        success: false,
        error: '请指定 provider 和 model，或配置默认 AI 提供商',
      });
      return;
    }

    const session = await chatSessionService.create(
      sessionProvider as AIProvider,
      sessionModel,
      mode,
      req.tenantId,
      req.deviceId
    );
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to create session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建会话失败',
    });
  }
}


/**
 * 更新会话
 * PUT /api/ai/sessions/:id
 */
export async function updateSession(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const updates = req.body as UpdateSessionInput;

    const session = await chatSessionService.update(id, updates);
    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to update session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新会话失败',
    });
  }
}

/**
 * 删除会话
 * DELETE /api/ai/sessions/:id
 */
export async function deleteSession(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await chatSessionService.delete(id);
    res.json({ success: true, message: '会话已删除' });
  } catch (error) {
    logger.error('Failed to delete session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除会话失败',
    });
  }
}

/**
 * 重命名会话
 * PUT /api/ai/sessions/:id/rename
 */
export async function renameSession(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { title } = req.body as { title: string };

    if (!title) {
      res.status(400).json({ success: false, error: '标题不能为空' });
      return;
    }

    const session = await chatSessionService.rename(id, title);
    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to rename session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '重命名会话失败',
    });
  }
}

/**
 * 清除会话消息
 * POST /api/ai/sessions/:id/clear
 */
export async function clearSessionMessages(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    await chatSessionService.clearMessages(id);
    res.json({ success: true, message: '会话消息已清除' });
  } catch (error) {
    logger.error('Failed to clear session messages:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '清除消息失败',
    });
  }
}


/**
 * 导出会话为 Markdown
 * GET /api/ai/sessions/:id/export
 */
export async function exportSession(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const markdown = await chatSessionService.exportAsMarkdown(id);

    // 获取会话信息用于文件名
    const session = await chatSessionService.getById(id);
    const filename = session?.title
      ? `${session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.md`
      : 'chat_export.md';

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(markdown);
  } catch (error) {
    logger.error('Failed to export session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '导出会话失败',
    });
  }
}

/**
 * 复制会话
 * POST /api/ai/sessions/:id/duplicate
 */
export async function duplicateSession(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const newSession = await chatSessionService.duplicate(id);
    res.status(201).json({ success: true, data: newSession });
  } catch (error) {
    logger.error('Failed to duplicate session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '复制会话失败',
    });
  }
}

/**
 * 搜索会话
 * GET /api/ai/sessions/search
 */
export async function searchSessions(req: Request, res: Response): Promise<void> {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      res.status(400).json({ success: false, error: '搜索关键词不能为空' });
      return;
    }

    const sessions = await chatSessionService.search(q);
    res.json({ success: true, data: sessions });
  } catch (error) {
    logger.error('Failed to search sessions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '搜索会话失败',
    });
  }
}

/**
 * 删除所有会话
 * DELETE /api/ai/sessions
 */
export async function deleteAllSessions(_req: Request, res: Response): Promise<void> {
  try {
    await chatSessionService.deleteAll();
    res.json({ success: true, message: '所有会话已删除' });
  } catch (error) {
    logger.error('Failed to delete all sessions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '删除所有会话失败',
    });
  }
}


// ==================== 对话收藏管理 ====================

/**
 * 收藏消息
 * POST /api/ai/sessions/:sessionId/messages/:messageId/collect
 * Requirements: 13.1, 13.2, 14.1
 */
export async function collectMessage(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId, messageId } = req.params;
    await conversationCollector.collectMessage(sessionId, messageId);
    res.json({ success: true, message: '消息已收藏' });
  } catch (error) {
    logger.error('Failed to collect message:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '收藏消息失败',
    });
  }
}

/**
 * 取消收藏消息
 * DELETE /api/ai/sessions/:sessionId/messages/:messageId/collect
 * Requirements: 14.2
 */
export async function uncollectMessage(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId, messageId } = req.params;
    await conversationCollector.uncollectMessage(sessionId, messageId);
    res.json({ success: true, message: '已取消收藏' });
  } catch (error) {
    logger.error('Failed to uncollect message:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '取消收藏失败',
    });
  }
}

/**
 * 获取会话中的收藏消息
 * GET /api/ai/sessions/:sessionId/collected
 * Requirements: 13.4
 */
export async function getCollectedMessages(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.params;
    const collectedMessages = await conversationCollector.getCollectedMessages(sessionId);
    res.json({ success: true, data: collectedMessages });
  } catch (error) {
    logger.error('Failed to get collected messages:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '获取收藏消息失败',
    });
  }
}

/**
 * 获取所有有收藏消息的会话
 * GET /api/ai/sessions/with-collections
 * Requirements: 14.3, 14.4
 */
export async function getSessionsWithCollections(_req: Request, res: Response): Promise<void> {
  try {
    const summaries = await conversationCollector.getSessionsWithCollections();
    res.json({ success: true, data: summaries });
  } catch (error) {
    logger.error('Failed to get sessions with collections:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取收藏会话列表失败',
    });
  }
}


// ==================== 对话转知识库 ====================

/**
 * 转换收藏消息为知识条目
 * POST /api/ai/conversations/convert
 * Requirements: 13.5, 13.6, 13.7, 13.10
 */
export async function convertToKnowledge(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId, questionMessageId, answerMessageId, title, content, category, tags } = req.body as ConvertToKnowledgeRequest;

    if (!sessionId || !questionMessageId || !answerMessageId) {
      res.status(400).json({
        success: false,
        error: '缺少必填字段：sessionId, questionMessageId, answerMessageId',
      });
      return;
    }

    const entry = await conversationCollector.convertToKnowledge({
      sessionId,
      questionMessageId,
      answerMessageId,
      title,
      content,
      category,
      tags,
    }) as unknown;

    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error('Failed to convert conversation to knowledge:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '转换失败',
    });
  }
}

/**
 * 批量转换收藏消息为知识条目
 * POST /api/ai/conversations/batch-convert
 * Requirements: 13.11
 */
export async function batchConvertToKnowledge(req: Request, res: Response): Promise<void> {
  try {
    const { requests } = req.body as { requests: ConvertToKnowledgeRequest[] };

    if (!requests || !Array.isArray(requests) || requests.length === 0) {
      res.status(400).json({
        success: false,
        error: '请提供要转换的消息列表',
      });
      return;
    }

    const entries = await conversationCollector.batchConvertToKnowledge(requests) as unknown[];

    res.json({
      success: true,
      data: {
        entries,
        total: requests.length,
        succeeded: entries.length,
        failed: requests.length - entries.length,
      },
    });
  } catch (error) {
    logger.error('Failed to batch convert conversations:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '批量转换失败',
    });
  }
}

/**
 * 获取标签建议
 * POST /api/ai/conversations/suggest-tags
 * Requirements: 13.9
 */
export async function suggestTags(req: Request, res: Response): Promise<void> {
  try {
    const { content } = req.body as { content: string };

    if (!content) {
      res.status(400).json({
        success: false,
        error: '请提供内容文本',
      });
      return;
    }

    const tags = await conversationCollector.suggestTags(content);
    res.json({ success: true, data: tags });
  } catch (error) {
    logger.error('Failed to suggest tags:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取标签建议失败',
    });
  }
}

/**
 * 导出收藏消息为 Markdown
 * GET /api/ai/sessions/:sessionId/collected/export
 * Requirements: 14.6
 */
export async function exportCollectedMessages(req: Request, res: Response): Promise<void> {
  try {
    const { sessionId } = req.params;
    const markdown = await conversationCollector.exportAsMarkdown(sessionId);

    // 获取会话信息用于文件名
    const session = await chatSessionService.getById(sessionId);
    const filename = session?.title
      ? `${session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_collected.md`
      : 'collected_export.md';

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(markdown);
  } catch (error) {
    logger.error('Failed to export collected messages:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '导出失败',
    });
  }
}

// ==================== 会话配置管理 ====================

/**
 * 获取会话配置
 * GET /api/ai/sessions/:id/config
 * Requirement 7.2
 */
export async function getSessionConfig(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const config = await chatSessionService.getSessionConfig(id);
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to get session config:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '获取会话配置失败',
    });
  }
}

/**
 * 更新会话配置
 * PUT /api/ai/sessions/:id/config
 * Requirements 7.3, 7.4, 7.5
 */
export async function updateSessionConfig(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const updates = req.body as Partial<SessionConfig>;

    // Requirement 7.4: 验证 maxHistoryTurns 在 1-100 之间
    if (updates.maxHistoryTurns !== undefined) {
      const turns = updates.maxHistoryTurns;
      if (!Number.isInteger(turns) || turns < 1 || turns > 100) {
        res.status(400).json({
          success: false,
          error: 'maxHistoryTurns 必须是 1-100 之间的整数',
        });
        return;
      }
    }

    // Requirement 7.5: 验证 compressionStrategy
    if (updates.compressionStrategy !== undefined) {
      const validStrategies = ['sliding_window', 'smart'];
      if (!validStrategies.includes(updates.compressionStrategy)) {
        res.status(400).json({
          success: false,
          error: `compressionStrategy 必须是 ${validStrategies.join(' 或 ')}`,
        });
        return;
      }
    }

    // 验证 maxContextTokens
    if (updates.maxContextTokens !== undefined) {
      const tokens = updates.maxContextTokens;
      if (!Number.isInteger(tokens) || tokens < 100 || tokens > 128000) {
        res.status(400).json({
          success: false,
          error: 'maxContextTokens 必须是 100-128000 之间的整数',
        });
        return;
      }
    }

    const config = await chatSessionService.updateSessionConfig(id, updates);
    res.json({ success: true, data: config });
  } catch (error) {
    logger.error('Failed to update session config:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新会话配置失败',
    });
  }
}

/**
 * 获取上下文统计信息
 * GET /api/ai/sessions/:id/context-stats
 * Requirement 7.6
 */
export async function getContextStats(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const stats = await chatSessionService.getContextStats(id);
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get context stats:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '获取上下文统计失败',
    });
  }
}

/**
 * 获取上下文消息
 * GET /api/ai/sessions/:id/context-messages
 */
export async function getContextMessages(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const messages = await chatSessionService.getContextMessages(id);
    res.json({ success: true, data: messages });
  } catch (error) {
    logger.error('Failed to get context messages:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '获取上下文消息失败',
    });
  }
}
