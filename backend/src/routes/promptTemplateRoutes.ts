/**
 * PromptTemplateRoutes - 提示词模板路由
 *
 * 定义提示词模板相关的 API 路由。
 *
 * Requirements: 4.1, 4.3-4.9
 * - 4.1: 实现在 backend/src/routes/promptTemplateRoutes.ts
 * - 4.3: GET /api/prompt-templates
 * - 4.4: GET /api/prompt-templates/:id
 * - 4.5: POST /api/prompt-templates
 * - 4.6: PUT /api/prompt-templates/:id
 * - 4.7: DELETE /api/prompt-templates/:id
 * - 4.8: GET /api/prompt-templates/placeholders
 * - 4.9: POST /api/prompt-templates/:id/render
 */

import { Router } from 'express';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getPlaceholders,
  renderTemplate,
  getDefaultTemplate,
  setDefaultTemplate,
  getOverrides,
  setOverride,
  clearOverride,
} from '../controllers/promptTemplateController';

const router = Router();

// ==================== 特殊路由（放在参数路由之前） ====================

// GET /api/prompt-templates/placeholders - 获取可用占位符
// Requirement 4.8
router.get('/placeholders', getPlaceholders);

// GET /api/prompt-templates/default - 获取默认模板
router.get('/default', getDefaultTemplate);

// ==================== 模板覆盖路由 ====================

// GET /api/prompt-templates/overrides - 获取所有覆盖配置
router.get('/overrides', getOverrides);

// POST /api/prompt-templates/overrides - 设置模板覆盖
router.post('/overrides', setOverride);

// DELETE /api/prompt-templates/overrides/:systemTemplateName - 清除模板覆盖
router.delete('/overrides/:systemTemplateName', clearOverride);

// ==================== CRUD 路由 ====================

// GET /api/prompt-templates - 获取所有模板
// Requirement 4.3
router.get('/', getTemplates);

// POST /api/prompt-templates - 创建模板
// Requirement 4.5
router.post('/', createTemplate);

// GET /api/prompt-templates/:id - 获取单个模板
// Requirement 4.4
router.get('/:id', getTemplateById);

// PUT /api/prompt-templates/:id - 更新模板
// Requirement 4.6
router.put('/:id', updateTemplate);

// DELETE /api/prompt-templates/:id - 删除模板
// Requirement 4.7
router.delete('/:id', deleteTemplate);

// POST /api/prompt-templates/:id/render - 渲染模板
// Requirement 4.9
router.post('/:id/render', renderTemplate);

// POST /api/prompt-templates/:id/default - 设置为默认模板
router.post('/:id/default', setDefaultTemplate);

export default router;
