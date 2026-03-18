/**
 * PromptTemplateController - 提示词模板控制器
 *
 * 处理提示词模板相关的 HTTP 请求。
 *
 * Requirements: 4.2-4.9
 * - 4.2: 实现在 backend/src/controllers/promptTemplateController.ts
 * - 4.3: GET /api/prompt-templates
 * - 4.4: GET /api/prompt-templates/:id
 * - 4.5: POST /api/prompt-templates
 * - 4.6: PUT /api/prompt-templates/:id
 * - 4.7: DELETE /api/prompt-templates/:id
 * - 4.8: GET /api/prompt-templates/placeholders
 * - 4.9: POST /api/prompt-templates/:id/render
 */

import { Request, Response } from 'express';
import { promptTemplateService } from '../services/ai/promptTemplateService';
import { logger } from '../utils/logger';

/**
 * 获取所有模板（支持分页和筛选）
 * Requirement 4.3: GET /api/prompt-templates
 */
export const getTemplates = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category, page = '1', pageSize = '10', search } = req.query;
    const pageNum = parseInt(page as string, 10) || 1;
    const pageSizeNum = parseInt(pageSize as string, 10) || 10;

    // 获取所有模板（可选按分类和搜索关键词筛选）
    const allTemplates = await promptTemplateService.getAll(
      category as string | undefined,
      search as string | undefined
    );
    
    // 计算分页
    const total = allTemplates.length;
    const startIndex = (pageNum - 1) * pageSizeNum;
    const endIndex = startIndex + pageSizeNum;
    const paginatedTemplates = allTemplates.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: paginatedTemplates,
      pagination: {
        page: pageNum,
        pageSize: pageSizeNum,
        total,
      },
    });
  } catch (error) {
    logger.error('Failed to get templates:', error);
    res.status(500).json({
      success: false,
      error: '获取模板列表失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 根据 ID 获取模板
 * Requirement 4.4: GET /api/prompt-templates/:id
 */
export const getTemplateById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const template = await promptTemplateService.getById(id);

    if (!template) {
      res.status(404).json({ success: false, error: '模板不存在' });
      return;
    }

    res.json({ success: true, data: template });
  } catch (error) {
    logger.error('Failed to get template:', error);
    res.status(500).json({
      success: false,
      error: '获取模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 创建模板
 * Requirement 4.5: POST /api/prompt-templates
 */
export const createTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, content, description, category, isDefault } = req.body;

    if (!name || !content) {
      res.status(400).json({ success: false, error: '名称和内容为必填项' });
      return;
    }

    const template = await promptTemplateService.create({
      name,
      content,
      description,
      category,
      placeholders: [], // 会在 service 中自动提取
      isDefault: isDefault || false,
    });

    res.status(201).json({ success: true, data: template });
  } catch (error) {
    logger.error('Failed to create template:', error);
    res.status(500).json({
      success: false,
      error: '创建模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 更新模板
 * Requirement 4.6: PUT /api/prompt-templates/:id
 */
export const updateTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, content, description, category, isDefault } = req.body;

    const template = await promptTemplateService.update(id, {
      name,
      content,
      description,
      category,
      isDefault,
    });

    res.json({ success: true, data: template });
  } catch (error) {
    if (error instanceof Error && error.message.includes('不存在')) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to update template:', error);
    res.status(500).json({
      success: false,
      error: '更新模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 删除模板
 * Requirement 4.7: DELETE /api/prompt-templates/:id
 */
export const deleteTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await promptTemplateService.delete(id);
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.includes('不存在')) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to delete template:', error);
    res.status(500).json({
      success: false,
      error: '删除模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 获取可用占位符
 * Requirement 4.8: GET /api/prompt-templates/placeholders
 */
export const getPlaceholders = async (_req: Request, res: Response): Promise<void> => {
  try {
    const placeholders = promptTemplateService.getAvailablePlaceholders();
    res.json({ success: true, data: placeholders });
  } catch (error) {
    logger.error('Failed to get placeholders:', error);
    res.status(500).json({
      success: false,
      error: '获取占位符列表失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 渲染模板
 * Requirement 4.9: POST /api/prompt-templates/:id/render
 */
export const renderTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const context = req.body;

    const rendered = await promptTemplateService.render(id, context);
    res.json({ success: true, data: { content: rendered } });
  } catch (error) {
    if (error instanceof Error && error.message.includes('不存在')) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to render template:', error);
    res.status(500).json({
      success: false,
      error: '渲染模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 获取默认模板
 */
export const getDefaultTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const { category } = req.query;
    const template = await promptTemplateService.getDefault(category as string | undefined);

    if (!template) {
      res.status(404).json({ success: false, error: '未找到默认模板' });
      return;
    }

    res.json({ success: true, data: template });
  } catch (error) {
    logger.error('Failed to get default template:', error);
    res.status(500).json({
      success: false,
      error: '获取默认模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 设置默认模板
 */
export const setDefaultTemplate = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    await promptTemplateService.setDefault(id);
    res.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes('不存在')) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to set default template:', error);
    res.status(500).json({
      success: false,
      error: '设置默认模板失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 获取所有模板覆盖配置
 */
export const getOverrides = async (_req: Request, res: Response): Promise<void> => {
  try {
    const overrides = await promptTemplateService.getOverrides();
    res.json({ success: true, data: overrides });
  } catch (error) {
    logger.error('Failed to get template overrides:', error);
    res.status(500).json({
      success: false,
      error: '获取模板覆盖配置失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 设置模板覆盖
 * POST /api/prompt-templates/overrides
 * Body: { systemTemplateName: string, customTemplateId: string }
 */
export const setOverride = async (req: Request, res: Response): Promise<void> => {
  try {
    const { systemTemplateName, customTemplateId } = req.body;

    if (!systemTemplateName || !customTemplateId) {
      res.status(400).json({ 
        success: false, 
        error: '系统模板名称和自定义模板ID为必填项' 
      });
      return;
    }

    await promptTemplateService.setOverride(systemTemplateName, customTemplateId);
    const overrides = await promptTemplateService.getOverrides();
    res.json({ success: true, data: overrides });
  } catch (error) {
    if (error instanceof Error && error.message.includes('不存在')) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }

    logger.error('Failed to set template override:', error);
    res.status(500).json({
      success: false,
      error: '设置模板覆盖失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * 清除模板覆盖
 * DELETE /api/prompt-templates/overrides/:systemTemplateName
 */
export const clearOverride = async (req: Request, res: Response): Promise<void> => {
  try {
    const { systemTemplateName } = req.params;
    await promptTemplateService.clearOverride(systemTemplateName);
    const overrides = await promptTemplateService.getOverrides();
    res.json({ success: true, data: overrides });
  } catch (error) {
    logger.error('Failed to clear template override:', error);
    res.status(500).json({
      success: false,
      error: '清除模板覆盖失败',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
