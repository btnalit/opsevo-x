/**
 * KnowledgePromptController - 自定义 Prompt 知识上传控制器
 *
 * 处理 POST /api/v1/knowledge/prompts 请求，
 * 允许用户上传自定义 Prompt 模板到 prompt_knowledge 向量知识库。
 *
 * 上传的 Prompt 同时通过 PromptTemplateService 存储（CRUD 管理）
 * 和 VectorStoreClient 向量化（语义检索）。
 *
 * @see Requirements F1.6 - REST API 上传自定义 Prompt
 * @see Requirements F1.7 - 写入时同步向量化
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import type { VectorStoreClient } from '../services/ai-ops/rag/vectorStoreClient';

/** 模块级 vectorClient 引用，由 bootstrap 注入 */
let _vectorClient: VectorStoreClient | null = null;

/**
 * 注入 VectorStoreClient 依赖
 * 在系统启动时由 bootstrap 调用
 */
export function setKnowledgePromptVectorClient(client: VectorStoreClient): void {
  _vectorClient = client;
}

/**
 * POST /api/v1/knowledge/prompts
 *
 * 上传自定义 Prompt 到 prompt_knowledge 向量知识库。
 *
 * Request Body:
 * - text (string, required): Prompt 文本内容
 * - category (string, optional): 类别标签，默认 'system_prompt'
 * - deviceTypes (string[], optional): 适用设备类型，默认 ['*']
 * - tags (string[], optional): 标签列表
 *
 * @see Requirements F1.6
 */
export const uploadKnowledgePrompt = async (req: Request, res: Response): Promise<void> => {
  try {
    const { text, category, deviceTypes, tags } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Prompt 文本内容 (text) 为必填项且不能为空',
      });
      return;
    }

    if (!_vectorClient) {
      res.status(503).json({
        success: false,
        error: '向量存储服务不可用，请稍后重试',
      });
      return;
    }

    const id = `custom_prompt_${uuidv4()}`;
    const now = new Date().toISOString();

    // 向量化存入 prompt_knowledge 集合
    await _vectorClient.upsert('prompt_knowledge', [{
      id,
      content: text.trim(),
      metadata: {
        id,
        category: category || 'system_prompt',
        deviceTypes: Array.isArray(deviceTypes) ? deviceTypes : ['*'],
        tags: Array.isArray(tags) ? tags : [],
        version: 1,
        feedbackScore: 0.5,
        hitCount: 0,
        source: 'user-upload',
        createdAt: now,
      },
    }]);

    logger.info(`[KnowledgePrompt] Custom prompt uploaded: ${id}`);

    res.status(201).json({
      success: true,
      data: {
        id,
        text: text.trim(),
        category: category || 'system_prompt',
        deviceTypes: Array.isArray(deviceTypes) ? deviceTypes : ['*'],
        tags: Array.isArray(tags) ? tags : [],
        createdAt: now,
      },
    });
  } catch (error) {
    logger.error('[KnowledgePrompt] Failed to upload custom prompt:', error);
    res.status(500).json({
      success: false,
      error: '上传自定义 Prompt 失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
