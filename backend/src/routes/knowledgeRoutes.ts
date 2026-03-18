/**
 * Knowledge Routes
 *
 * 定义 Prompt 知识库相关的路由。
 *
 * 路由分组：
 * - POST /api/v1/knowledge/prompts - 上传自定义 Prompt 到知识库
 *
 * @see Requirements F1.6 - REST API 上传自定义 Prompt
 */

import { Router } from 'express';
import { uploadKnowledgePrompt } from '../controllers/knowledgePromptController';

const router = Router();

// POST /api/v1/knowledge/prompts - 上传自定义 Prompt
router.post('/prompts', uploadKnowledgePrompt);

export default router;
