/**
 * Unified Agent Routes
 * 统一 AI Agent API 路由
 *
 * 路由分组：
 * - /api/ai/unified/chat - 统一聊天功能（支持标准和知识增强模式）
 * - /api/ai/unified/sessions - 统一会话管理
 * - /api/ai/unified/scripts - 脚本执行（带 AI 分析）
 * - /api/ai/unified/history - 统一执行历史
 *
 * Requirements: 1.1, 7.1, 7.2, 7.3, 7.4
 * - 7.1: 返回包含 reactSteps 数组的响应
 * - 7.2: reactSteps 数组包含每个步骤的类型、内容和时间戳
 * - 7.3: 保持与现有 API 响应格式的向后兼容性
 * - 7.4: 返回包含错误代码和描述的错误响应
 * 
 * Skill System Integration: 6.1, 7.10
 * - 知识增强模式统一通过 UnifiedAgentService 处理
 * - Skill 系统在 UnifiedAgentService 中自动介入
 */

import { Router, Request, Response } from 'express';
import {
  unifiedAgentService,
  chatSessionService,
  apiConfigService,
  rateLimiterService,
  conversationCollector,
  UnifiedChatRequest,
  StreamChunk,
} from '../services/ai';
import { ErrorEvent } from '../types/ai-ops';
import { logger } from '../utils/logger';

const router = Router();

// ==================== 初始化服务 ====================

// 确保 UnifiedAgentService 已初始化
let serviceInitialized = false;

const initializeService = async (): Promise<void> => {
  if (!serviceInitialized && !unifiedAgentService.isInitialized()) {
    await unifiedAgentService.initialize();
    serviceInitialized = true;
  }
};

// ==================== 聊天功能 ====================

/**
 * 发送统一聊天消息（非流式）
 * POST /api/ai/unified/chat
 *
 * Request Body:
 * - configId: string - API 配置 ID（可选，默认使用默认配置）
 * - sessionId?: string - 会话 ID（可选，不提供则创建新会话）
 * - message: string - 用户消息
 * - mode: 'standard' | 'knowledge-enhanced' - 对话模式
 * - includeContext?: boolean - 是否包含设备上下文（默认 true）
 * - ragOptions?: { topK?: number; minScore?: number; includeTools?: boolean }
 *
 * Requirements: 1.1, 1.4, 1.5, 7.1, 7.2, 7.3, 7.4
 * - 7.1: 返回包含 reactSteps 数组的响应
 * - 7.2: reactSteps 数组包含每个步骤的类型、内容和时间戳
 * - 7.3: 保持与现有 API 响应格式的向后兼容性
 * - 7.4: 返回包含错误代码和描述的错误响应
 */
router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const {
      configId,
      sessionId,
      message,
      mode = 'standard',
      includeContext = true,
      ragOptions,
    } = req.body;

    // 验证必填字段
    if (!message) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: '消息内容不能为空' }
      });
      return;
    }

    // 验证模式
    if (mode !== 'standard' && mode !== 'knowledge-enhanced') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_MODE', message: '无效的对话模式，必须是 standard 或 knowledge-enhanced' },
      });
      return;
    }

    // 获取配置
    const config = configId
      ? await apiConfigService.getById(configId)
      : await apiConfigService.getDefault();

    if (!config) {
      res.status(400).json({
        success: false,
        error: { code: 'CONFIG_NOT_FOUND', message: configId ? '配置不存在' : '未配置默认 AI 提供商' },
      });
      return;
    }

    // 检查速率限制
    if (!rateLimiterService.checkLimit(config.id)) {
      const waitTime = rateLimiterService.getWaitTimeMs(config.id);
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' },
        retryAfter: Math.ceil(waitTime / 1000),
      });
      return;
    }

    // 知识增强模式和标准模式统一使用 UnifiedAgentService
    // 修复：之前知识增强模式直接使用 reactAgent，绕过了 Skill 系统
    // 现在统一通过 UnifiedAgentService，确保 Skill 系统正确介入
    // Requirement 7.1, 7.2: 返回 reactSteps
    // Skill System Integration: 6.1, 7.10
    const request: UnifiedChatRequest = {
      configId: config.id,
      sessionId,
      message,
      mode,
      includeContext,
      ragOptions,
      // 多设备支持：从设备中间件注入的上下文传递到 AI 服务
      // Requirements: 8.1, 8.2, 8.4
      deviceId: req.deviceId,
      tenantId: req.tenantId,
    };

    try {
      const response = await unifiedAgentService.chat(request);

      // 构建响应数据，保持向后兼容性
      // Requirement 7.3: 保持与现有 API 响应格式的向后兼容性
      const responseData: Record<string, unknown> = {
        content: response.content,
        sessionId: response.sessionId,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
        confidence: response.confidence,
      };

      // 知识增强模式特有字段
      if (mode === 'knowledge-enhanced') {
        responseData.reactSteps = response.reactSteps;
        responseData.intentAnalysis = response.intentAnalysis;
        responseData.ragContext = response.ragContext;
        responseData.citations = response.citations;
      }

      // Skill 信息（如果有）
      if (response.skill) {
        responseData.skill = response.skill;
      }

      // Token 使用信息
      if (response.usage) {
        responseData.usage = response.usage;
      }

      res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      logger.error('Unified chat request failed:', error);
      // Requirement 7.4: 返回包含错误代码和描述的错误响应
      const errorCode = mode === 'knowledge-enhanced' ? 'REACT_ERROR' : 'CHAT_ERROR';
      res.status(500).json({
        success: false,
        error: { code: errorCode, message: (error as Error).message },
      });
    }
  } catch (error) {
    logger.error('Unified chat request failed:', error);
    // Requirement 7.4: 返回包含错误代码和描述的错误响应
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '聊天请求失败' },
    });
  }
});

/**
 * 发送统一聊天消息（流式 SSE）
 * POST /api/ai/unified/chat/stream
 *
 * Request Body: 同 /chat
 *
 * SSE Events:
 * - content: 响应内容片段
 * - citation: 知识引用（知识增强模式）
 * - tool_call: 工具调用详情（知识增强模式）
 * - reasoning: 推理过程（知识增强模式）
 * - react_step: ReAct 步骤（知识增强模式）
 * - done: 完成信号（包含 reactSteps 数组）
 * - error: 错误信息
 *
 * Requirements: 1.1, 2.2, 2.4, 7.1, 7.2, 7.3, 7.4
 * - 7.1: 返回包含 reactSteps 数组的响应
 * - 7.2: reactSteps 数组包含每个步骤的类型、内容和时间戳
 * - 7.3: 保持与现有 API 响应格式的向后兼容性
 * - 7.4: 返回包含错误代码和描述的错误响应
 */
router.post('/chat/stream', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const {
      configId,
      sessionId,
      message,
      mode = 'standard',
      includeContext = true,
      ragOptions,
    } = req.body;

    // 验证必填字段
    if (!message) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: '消息内容不能为空' }
      });
      return;
    }

    // 验证模式
    if (mode !== 'standard' && mode !== 'knowledge-enhanced') {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_MODE', message: '无效的对话模式，必须是 standard 或 knowledge-enhanced' },
      });
      return;
    }

    // 获取配置
    const config = configId
      ? await apiConfigService.getById(configId)
      : await apiConfigService.getDefault();

    if (!config) {
      res.status(400).json({
        success: false,
        error: { code: 'CONFIG_NOT_FOUND', message: configId ? '配置不存在' : '未配置默认 AI 提供商' },
      });
      return;
    }

    // 检查速率限制
    if (!rateLimiterService.checkLimit(config.id)) {
      const waitTime = rateLimiterService.getWaitTimeMs(config.id);
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' },
        retryAfter: Math.ceil(waitTime / 1000),
      });
      return;
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 知识增强模式和标准模式统一使用 UnifiedAgentService
    // 修复：之前知识增强模式直接使用 reactAgent，绕过了 Skill 系统
    // 现在统一通过 UnifiedAgentService.chatStream()，确保 Skill 系统正确介入
    // Requirement 7.1, 7.2: 返回 reactSteps
    // Skill System Integration: 6.1, 7.10
    const request: UnifiedChatRequest = {
      configId: config.id,
      sessionId,
      message,
      mode,
      includeContext,
      ragOptions,
      // 多设备支持：从设备中间件注入的上下文传递到 AI 服务
      // Requirements: 8.1, 8.2, 8.4
      deviceId: req.deviceId,
      tenantId: req.tenantId,
    };

    // 流式响应处理
    const onChunk = (chunk: StreamChunk): void => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    try {
      // 发送开始事件
      res.write(`data: ${JSON.stringify({ type: 'start', message: '开始处理请求...' })}\n\n`);

      await unifiedAgentService.chatStream(request, onChunk);
      res.end();
    } catch (streamError) {
      logger.error('Stream error:', streamError);
      // Requirement 7.4: 返回包含错误代码和描述的错误响应
      const errorCode = mode === 'knowledge-enhanced' ? 'REACT_ERROR' : 'STREAM_ERROR';
      const errorEvent: ErrorEvent = {
        type: 'error',
        data: {
          code: errorCode,
          message: (streamError as Error).message,
        },
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.end();
    }
  } catch (error) {
    logger.error('Unified chat stream request failed:', error);
    // 如果还没开始流式响应，返回 JSON 错误
    // Requirement 7.4: 返回包含错误代码和描述的错误响应
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '聊天请求失败' },
      });
    } else {
      const errorEvent: ErrorEvent = {
        type: 'error',
        data: {
          code: 'INTERNAL_ERROR',
          message: (error as Error).message,
        },
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.end();
    }
  }
});

// ==================== 会话管理 ====================

/**
 * 获取所有会话
 * GET /api/ai/unified/sessions
 *
 * Query Parameters:
 * - mode?: 'standard' | 'knowledge-enhanced' - 按模式筛选
 *
 * Requirements: 4.1
 */
router.get('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { mode } = req.query;
    // Pass tenantId and deviceId to getAll for filtering
    let sessions = await chatSessionService.getAll(req.tenantId, req.deviceId);

    // Filter by mode
    if (mode && (mode === 'standard' || mode === 'knowledge-enhanced')) {
      sessions = sessions.filter(s => s.mode === mode);
    }

    res.json({ success: true, data: sessions });
  } catch (error) {
    logger.error('Failed to get unified sessions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取会话列表失败',
    });
  }
});

/**
 * 创建会话
 * POST /api/ai/unified/sessions
 *
 * Request Body:
 * - configId?: string - API 配置 ID
 * - mode?: 'standard' | 'knowledge-enhanced' - 会话模式（默认 standard）
 *
 * Requirements: 4.1
 */
router.post('/sessions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { configId, mode = 'standard' } = req.body;

    // 验证模式
    if (mode !== 'standard' && mode !== 'knowledge-enhanced') {
      res.status(400).json({
        success: false,
        error: '无效的会话模式，必须是 standard 或 knowledge-enhanced',
      });
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

    // Pass tenantId and deviceId to create
    // Fix: Foreign Key constraint failed when tenantId defaults to 'default'
    const session = await chatSessionService.create(
      config.provider,
      config.model,
      mode,
      req.tenantId,
      req.deviceId
    );
    res.status(201).json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to create unified session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '创建会话失败',
    });
  }
});

/**
 * 获取单个会话
 * GET /api/ai/unified/sessions/:id
 */
router.get('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const session = await chatSessionService.getById(id);

    if (!session) {
      res.status(404).json({ success: false, error: '会话不存在' });
      return;
    }

    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to get unified session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取会话失败',
    });
  }
});

/**
 * 更新会话
 * PUT /api/ai/unified/sessions/:id
 *
 * Request Body:
 * - title?: string
 * - mode?: 'standard' | 'knowledge-enhanced'
 *
 * Requirements: 4.2
 */
router.put('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, mode } = req.body;

    // 验证模式（如果提供）
    if (mode && mode !== 'standard' && mode !== 'knowledge-enhanced') {
      res.status(400).json({
        success: false,
        error: '无效的会话模式，必须是 standard 或 knowledge-enhanced',
      });
      return;
    }

    const updates: { title?: string; mode?: 'standard' | 'knowledge-enhanced' } = {};
    if (title !== undefined) updates.title = title;
    if (mode !== undefined) updates.mode = mode;

    const session = await chatSessionService.update(id, updates);
    res.json({ success: true, data: session });
  } catch (error) {
    logger.error('Failed to update unified session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '更新会话失败',
    });
  }
});

/**
 * 删除会话
 * DELETE /api/ai/unified/sessions/:id
 */
router.delete('/sessions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await chatSessionService.delete(id);
    res.json({ success: true, message: '会话已删除' });
  } catch (error) {
    logger.error('Failed to delete unified session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '删除会话失败',
    });
  }
});

/**
 * 导出会话为 Markdown（包含知识引用）
 * GET /api/ai/unified/sessions/:id/export
 *
 * Requirements: 4.4
 */
router.get('/sessions/:id/export', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const markdown = await chatSessionService.exportAsMarkdown(id);

    // 获取会话信息用于文件名
    const session = await chatSessionService.getById(id);
    const filename = session
      ? `${session.title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}.md`
      : 'chat_export.md';

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(markdown);
  } catch (error) {
    logger.error('Failed to export unified session:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '导出会话失败',
    });
  }
});

// ==================== 脚本执行 ====================

/**
 * 执行脚本（带 AI 分析）
 * POST /api/ai/unified/scripts/execute
 *
 * Request Body:
 * - script: string - 脚本内容
 * - sessionId?: string - 会话 ID
 * - dryRun?: boolean - 是否模拟执行
 * - analyze?: boolean - 是否进行 AI 分析（默认 true）
 * - configId?: string - AI 配置 ID（用于分析）
 *
 * Requirements: 3.1, 3.4
 */
router.post('/scripts/execute', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const {
      script,
      sessionId,
      dryRun = false,
      analyze = true,
      configId,
    } = req.body;

    if (!script) {
      res.status(400).json({ success: false, error: '脚本内容不能为空' });
      return;
    }

    if (analyze) {
      // 获取配置用于 AI 分析
      const config = configId
        ? await apiConfigService.getById(configId)
        : await apiConfigService.getDefault();

      if (!config) {
        res.status(400).json({
          success: false,
          error: '需要 AI 配置才能进行分析',
        });
        return;
      }

      const response = await unifiedAgentService.executeScriptWithAnalysis(
        { script, sessionId, dryRun },
        config.id
      );

      res.json({
        success: true,
        data: response,
      });
    } else {
      // 仅执行脚本，不进行分析
      const result = await unifiedAgentService.executeScript({
        script,
        sessionId,
        dryRun,
      });

      res.json({
        success: true,
        data: { result, sessionId },
      });
    }
  } catch (error) {
    logger.error('Failed to execute script:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '脚本执行失败',
    });
  }
});

/**
 * 执行脚本（SSE 流式）
 * POST /api/ai/unified/scripts/execute/stream
 *
 * Request Body:
 * - script: string
 * - sessionId?: string
 * - dryRun?: boolean
 * - analyze?: boolean
 * - configId?: string
 */
router.post('/scripts/execute/stream', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const {
      script,
      sessionId,
      dryRun = false,
      analyze = true,
      configId,
    } = req.body;

    if (!script) {
      res.status(400).json({ success: false, error: '脚本内容不能为空' });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // heartbeat to keep connection alive
    const heartbeat = setInterval(() => send({ type: 'ping' }), 15000);

    send({ type: 'status', message: '正在执行脚本...' });

    try {
      // 1. 先执行脚本，立即返回结果给前端（避免前端苦等）
      const result = await unifiedAgentService.executeScript({
        script,
        sessionId,
        dryRun,
      });

      send({ type: 'result', result });

      // 2. 如果配置了分析并且脚本有输出，则将脚本结果流式输入给大模型
      if (analyze && result.success && result.output && sessionId) {
        const config = configId
          ? await apiConfigService.getById(configId)
          : await apiConfigService.getDefault();

        if (!config) {
          send({ type: 'error', error: '需要 AI 配置才能进行分析' });
        } else {
          try {
            const analysisMessage = `请分析以下设备命令执行结果：\n\n命令：\n\`\`\`\n${script}\n\`\`\`\n\n执行结果：\n\`\`\`\n${result.output}\n\`\`\`\n\n请简要说明执行结果的含义，以及是否有需要注意的问题。`;
            
            // 调用公共接口进行单次对话（这里会阻塞，但前端已经收到了 result 事件并显示了加载动画）
            const analysisResponse = await unifiedAgentService.chat({
              configId: config.id,
              sessionId,
              message: analysisMessage,
              mode: 'standard',
              includeContext: true,
              deviceId: req.deviceId,
              tenantId: req.tenantId,
            });

            send({ type: 'analysis', analysis: analysisResponse.content });
          } catch (analysisError) {
            logger.warn('Failed to complete script analysis', { error: analysisError });
            // 分析失败不报错，为了让流程能继续，给前端发一个错误提示而不是崩溃
            send({ type: 'error', error: 'AI 分析超时或失败，但脚本已执行完成。' });
          }
        }
      }

      send({ type: 'done', sessionId });
    } catch (streamError) {
      send({ type: 'error', error: (streamError as Error).message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  } catch (error) {
    logger.error('Failed to execute script (stream):', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : '脚本执行失败',
      });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: (error as Error).message })}\n\n`);
      res.end();
    }
  }
});

// ==================== 执行历史 ====================

/**
 * 获取统一执行历史
 * GET /api/ai/unified/history
 *
 * Query Parameters:
 * - sessionId?: string - 按会话筛选
 * - type?: 'script' | 'tool_call' - 按类型筛选
 * - limit?: number - 限制数量（默认 100）
 * - offset?: number - 偏移量（默认 0）
 *
 * Requirements: 3.5
 */
router.get('/history', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const { sessionId, type, limit, offset } = req.query;

    const history = await unifiedAgentService.getExecutionHistory({
      sessionId: sessionId as string | undefined,
      type: type as 'script' | 'tool_call' | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get execution history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取执行历史失败',
    });
  }
});

/**
 * 获取执行历史统计
 * GET /api/ai/unified/history/stats
 *
 * Query Parameters:
 * - sessionId?: string - 按会话筛选
 *
 * Requirements: 3.5
 */
router.get('/history/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const { sessionId } = req.query;
    const stats = await unifiedAgentService.getExecutionHistoryStats(
      sessionId as string | undefined
    );

    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get execution history stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取执行历史统计失败',
    });
  }
});

/**
 * 清除执行历史
 * DELETE /api/ai/unified/history
 *
 * Query Parameters:
 * - sessionId?: string - 按会话清除（不提供则清除所有）
 *
 * Requirements: 3.5
 */
router.delete('/history', async (req: Request, res: Response): Promise<void> => {
  try {
    await initializeService();

    const { sessionId } = req.query;
    await unifiedAgentService.clearExecutionHistory(sessionId as string | undefined);

    res.json({
      success: true,
      message: sessionId ? '会话执行历史已清除' : '所有执行历史已清除',
    });
  } catch (error) {
    logger.error('Failed to clear execution history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '清除执行历史失败',
    });
  }
});

// ==================== 对话收藏功能 ====================

/**
 * 收藏消息
 * POST /api/ai/unified/sessions/:sessionId/messages/:messageId/collect
 *
 * Requirements: 13.1, 13.2, 14.1
 */
router.post('/sessions/:sessionId/messages/:messageId/collect', async (req: Request, res: Response): Promise<void> => {
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
});

/**
 * 取消收藏消息
 * DELETE /api/ai/unified/sessions/:sessionId/messages/:messageId/collect
 *
 * Requirements: 14.2
 */
router.delete('/sessions/:sessionId/messages/:messageId/collect', async (req: Request, res: Response): Promise<void> => {
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
});

/**
 * 获取会话中的收藏消息
 * GET /api/ai/unified/sessions/:sessionId/collected
 *
 * Requirements: 13.4
 */
router.get('/sessions/:sessionId/collected', async (req: Request, res: Response): Promise<void> => {
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
});

/**
 * 获取所有有收藏消息的会话
 * GET /api/ai/unified/sessions/with-collections
 *
 * Requirements: 14.3, 14.4
 */
router.get('/sessions-with-collections', async (req: Request, res: Response): Promise<void> => {
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
});

/**
 * 转换收藏消息为知识条目
 * POST /api/ai/unified/conversations/convert
 *
 * Request Body:
 * - sessionId: string - 会话 ID
 * - questionMessageId: string - 问题消息 ID
 * - answerMessageId: string - 回答消息 ID
 * - title?: string - 自定义标题
 * - content?: string - 自定义内容
 * - category?: string - 分类
 * - tags?: string[] - 标签
 *
 * Requirements: 13.5, 13.6, 13.7, 13.10
 */
router.post('/conversations/convert', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId, questionMessageId, answerMessageId, title, content, category, tags } = req.body;

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
    });

    res.json({ success: true, data: entry });
  } catch (error) {
    logger.error('Failed to convert conversation to knowledge:', error);
    const status = (error as Error).message.includes('不存在') ? 404 : 500;
    res.status(status).json({
      success: false,
      error: error instanceof Error ? error.message : '转换失败',
    });
  }
});

/**
 * 批量转换收藏消息为知识条目
 * POST /api/ai/unified/conversations/batch-convert
 *
 * Request Body:
 * - requests: Array<ConvertToKnowledgeRequest>
 *
 * Requirements: 13.11
 */
router.post('/conversations/batch-convert', async (req: Request, res: Response): Promise<void> => {
  try {
    const { requests } = req.body;

    if (!requests || !Array.isArray(requests) || requests.length === 0) {
      res.status(400).json({
        success: false,
        error: '请提供要转换的消息列表',
      });
      return;
    }

    const entries = await conversationCollector.batchConvertToKnowledge(requests);

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
});

/**
 * 获取标签建议
 * POST /api/ai/unified/conversations/suggest-tags
 *
 * Request Body:
 * - content: string - 内容文本
 *
 * Requirements: 13.9
 */
router.post('/conversations/suggest-tags', async (req: Request, res: Response): Promise<void> => {
  try {
    const { content } = req.body;

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
});

/**
 * 导出收藏消息为 Markdown
 * GET /api/ai/unified/sessions/:sessionId/collected/export
 *
 * Requirements: 14.6
 */
router.get('/sessions/:sessionId/collected/export', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const markdown = await conversationCollector.exportAsMarkdown(sessionId);

    // 获取会话信息用于文件名
    const session = await chatSessionService.getById(sessionId);
    const filename = session
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
});

export default router;
