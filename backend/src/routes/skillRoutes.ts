/**
 * Skill Routes
 * 定义 Skill 系统管理相关的路由
 *
 * 路由分组:
 * - GET /api/skills - 列出所有 Skill
 * - GET /api/skills/metrics/all - 获取所有 Skill 指标（静态路由优先）
 * - GET /api/skills/templates/list - 获取模板列表（静态路由优先）
 * - POST /api/skills/from-template - 从模板创建（静态路由优先）
 * - POST /api/skills/import - 导入 Skill（静态路由优先）
 * - GET /api/skills/:name - 获取 Skill 详情
 * - POST /api/skills - 创建 Skill
 * - PUT /api/skills/:name - 更新 Skill
 * - DELETE /api/skills/:name - 删除 Skill
 * - PUT /api/skills/:name/toggle - 启用/禁用 Skill
 * - GET /api/skills/:name/metrics - 获取 Skill 指标
 * - POST /api/skills/:name/test - 测试 Skill
 *
 * Requirements: 13.1-13.18
 * 
 * 注意: 静态路由必须定义在动态路由 /:name 之前，否则会被错误匹配
 */

/* eslint-disable @typescript-eslint/no-misused-promises */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { logger } from '../utils/logger';
import { skillManager } from '../services/ai-ops/skill/skillManager';
import { skillLoader, importSkillFromZip, exportSkillToZip } from '../services/ai-ops/skill/skillLoader';

const router = Router();

// 配置 multer 用于文件上传
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB 限制
  },
  fileFilter: (_req, file, cb) => {
    // 只接受 ZIP 文件
    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('只支持 ZIP 文件格式'));
    }
  },
});

// ==================== 静态路由（必须在动态路由之前）====================

/**
 * GET /api/skills/metrics/all
 * 获取所有 Skill 指标
 * 注意: 必须在 /:name 路由之前定义
 */
router.get('/metrics/all', async (_req: Request, res: Response) => {
  try {
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metrics = skillManager.getAllMetrics();

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    logger.error('Failed to get all skill metrics', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get all skill metrics',
    });
  }
});

// ==================== 工具健康度监控 API ====================
// Requirements: 4.4.1, 4.4.2, 4.4.3, 4.4.4

/**
 * GET /api/skills/tools/health
 * 获取所有工具健康状态
 * Requirements: 4.4.1, 4.4.2
 */
router.get('/tools/health', async (_req: Request, res: Response) => {
  try {
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metricsService = skillManager.getMetricsService();
    const healthStatus = metricsService.getAllToolHealthStatus();
    const unhealthyTools = metricsService.getUnhealthyTools();
    const globalStats = metricsService.getGlobalFailureStats();

    res.json({
      success: true,
      data: {
        tools: healthStatus,
        unhealthyCount: unhealthyTools.length,
        unhealthyTools: unhealthyTools.map(t => t.toolName),
        globalStats,
      },
    });
  } catch (error) {
    logger.error('Failed to get tool health status', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get tool health status',
    });
  }
});

/**
 * GET /api/skills/tools/health/:toolName
 * 获取单个工具健康状态
 * Requirements: 4.4.1
 */
router.get('/tools/health/:toolName', async (req: Request, res: Response) => {
  try {
    const { toolName } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metricsService = skillManager.getMetricsService();
    const healthStatus = metricsService.getToolHealthStatus(toolName);

    if (!healthStatus) {
      res.status(404).json({
        success: false,
        error: `No metrics found for tool: ${toolName}`,
      });
      return;
    }

    // 获取失败模式分析
    const failureAnalysis = metricsService.analyzeFailurePatterns(toolName);

    res.json({
      success: true,
      data: {
        health: healthStatus,
        failureAnalysis,
      },
    });
  } catch (error) {
    logger.error('Failed to get tool health status', { error, toolName: req.params.toolName });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get tool health status',
    });
  }
});

/**
 * GET /api/skills/tools/metrics
 * 获取所有工具指标
 * Requirements: 4.4.3
 */
router.get('/tools/metrics', async (_req: Request, res: Response) => {
  try {
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metricsService = skillManager.getMetricsService();
    const toolMetrics = metricsService.getAllToolMetrics();
    const priorityRanking = metricsService.getToolPriorityRanking();

    res.json({
      success: true,
      data: {
        metrics: toolMetrics,
        priorityRanking,
      },
    });
  } catch (error) {
    logger.error('Failed to get tool metrics', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get tool metrics',
    });
  }
});

/**
 * POST /api/skills/tools/circuit-breaker/:toolName/reset
 * 重置工具熔断器
 * Requirements: 4.4.4
 */
router.post('/tools/circuit-breaker/:toolName/reset', async (req: Request, res: Response) => {
  try {
    const { toolName } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metricsService = skillManager.getMetricsService();
    const metrics = metricsService.getToolMetrics(toolName);

    if (!metrics) {
      res.status(404).json({
        success: false,
        error: `No metrics found for tool: ${toolName}`,
      });
      return;
    }

    // 关闭熔断器
    metricsService.closeCircuitBreaker(toolName);

    res.json({
      success: true,
      data: {
        toolName,
        circuitBreakerOpen: false,
        message: 'Circuit breaker reset successfully',
      },
    });
  } catch (error) {
    logger.error('Failed to reset circuit breaker', { error, toolName: req.params.toolName });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset circuit breaker',
    });
  }
});

/**
 * POST /api/skills/tools/:toolName/reset-metrics
 * 重置工具指标
 * Requirements: 4.4.4
 */
router.post('/tools/:toolName/reset-metrics', async (req: Request, res: Response) => {
  try {
    const { toolName } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metricsService = skillManager.getMetricsService();
    const success = metricsService.resetToolMetrics(toolName);

    if (!success) {
      res.status(404).json({
        success: false,
        error: `No metrics found for tool: ${toolName}`,
      });
      return;
    }

    res.json({
      success: true,
      data: {
        toolName,
        message: 'Tool metrics reset successfully',
      },
    });
  } catch (error) {
    logger.error('Failed to reset tool metrics', { error, toolName: req.params.toolName });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset tool metrics',
    });
  }
});

/**
 * GET /api/skills/templates/list
 * 获取 Skill 模板列表
 * Requirements: 13.14
 * 注意: 必须在 /:name 路由之前定义
 */
router.get('/templates/list', async (_req: Request, res: Response) => {
  try {
    // 返回预定义的 Skill 模板
    const templates = [
      {
        id: 'basic',
        name: '基础 Skill',
        description: '最简单的 Skill 模板，包含基本配置',
        config: {
          allowedTools: ['*'],
          caps: { temperature: 0.7, maxIterations: 5 },
        },
      },
      {
        id: 'diagnostic',
        name: '诊断型 Skill',
        description: '用于故障诊断的 Skill 模板',
        config: {
          allowedTools: ['get_system_info', 'get_interface_status', 'get_logs', 'analyze_metrics'],
          caps: { temperature: 0.3, maxIterations: 10 },
          knowledgeConfig: { types: ['alert', 'remediation'], minRelevance: 0.7 },
        },
      },
      {
        id: 'configurator',
        name: '配置型 Skill',
        description: '用于生成配置的 Skill 模板',
        config: {
          allowedTools: ['generate_config', 'validate_config', 'apply_config'],
          toolDefaults: { dryRun: true },
          caps: { temperature: 0.5, maxIterations: 5 },
        },
      },
      {
        id: 'auditor',
        name: '审计型 Skill',
        description: '用于安全审计的 Skill 模板',
        config: {
          allowedTools: ['get_firewall_rules', 'get_users', 'get_services', 'check_security'],
          caps: { temperature: 0.2, maxIterations: 8 },
          requireCitations: true,
        },
      },
    ];

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    logger.error('Failed to get skill templates', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill templates',
    });
  }
});

/**
 * POST /api/skills/from-template
 * 从模板创建 Skill
 * Requirements: 13.14
 * 注意: 必须在 /:name 路由之前定义
 */
router.post('/from-template', async (req: Request, res: Response) => {
  try {
    const { templateId, name, description } = req.body;

    if (!templateId || !name || !description) {
      res.status(400).json({
        success: false,
        error: 'templateId, name, and description are required',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    // 检查是否已存在
    const existing = skillManager.getSkill(name);
    if (existing) {
      res.status(409).json({
        success: false,
        error: `Skill already exists: ${name}`,
      });
      return;
    }

    // 获取模板配置
    const templates: Record<string, { config: object }> = {
      basic: {
        config: {
          allowedTools: ['*'],
          caps: { temperature: 0.7, maxIterations: 5 },
        },
      },
      diagnostic: {
        config: {
          allowedTools: ['get_system_info', 'get_interface_status', 'get_logs', 'analyze_metrics'],
          caps: { temperature: 0.3, maxIterations: 10 },
          knowledgeConfig: { types: ['alert', 'remediation'], minRelevance: 0.7 },
        },
      },
      configurator: {
        config: {
          allowedTools: ['generate_config', 'validate_config', 'apply_config'],
          toolDefaults: { dryRun: true },
          caps: { temperature: 0.5, maxIterations: 5 },
        },
      },
      auditor: {
        config: {
          allowedTools: ['get_firewall_rules', 'get_users', 'get_services', 'check_security'],
          caps: { temperature: 0.2, maxIterations: 8 },
          requireCitations: true,
        },
      },
    };

    const template = templates[templateId];
    if (!template) {
      res.status(400).json({
        success: false,
        error: `Unknown template: ${templateId}`,
      });
      return;
    }

    // 创建 Skill
    const skill = await skillLoader.createSkill(name, {
      description,
      content: `# ${name}\n\n${description}\n\n## 使用说明\n\n此 Skill 基于 ${templateId} 模板创建。`,
      config: template.config,
    });

    // 注册到 SkillManager
    skillManager.getRegistry().register(skill);

    res.status(201).json({
      success: true,
      data: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        path: skill.path,
        templateId,
      },
    });
  } catch (error) {
    logger.error('Failed to create skill from template', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create skill from template',
    });
  }
});

/**
 * POST /api/skills/import
 * 导入 Skill (支持 ZIP 文件上传或 JSON 数据)
 * Requirements: 13.11
 * 注意: 必须在 /:name 路由之前定义
 */
router.post('/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    // 检查是否有上传的 ZIP 文件
    if (req.file) {
      const overwrite = req.body.overwrite === 'true' || req.body.overwrite === true;
      
      const result = await importSkillFromZip(req.file.buffer, overwrite);
      
      if (!result.success) {
        res.status(400).json({
          success: false,
          error: result.error,
        });
        return;
      }
      
      // 注册到 SkillManager
      if (result.skill) {
        skillManager.getRegistry().register(result.skill);
        
        // 刷新语义匹配器的嵌入向量
        const matcher = skillManager.getMatcher();
        if (matcher) {
          await matcher.refreshSkillEmbedding(result.skillName);
        }
      }
      
      res.status(201).json({
        success: true,
        data: {
          name: result.skillName,
          description: result.skill?.metadata.description,
          path: result.skill?.path,
          imported: true,
          source: 'zip',
        },
      });
      return;
    }

    // 兼容旧的 JSON 导入方式
    const { data, overwrite = false } = req.body;

    if (!data || !data.skill) {
      res.status(400).json({
        success: false,
        error: '请上传 ZIP 文件或提供有效的 JSON 数据',
      });
      return;
    }

    const { metadata, config, content } = data.skill;

    if (!metadata?.name || !metadata?.description) {
      res.status(400).json({
        success: false,
        error: 'Invalid import data: missing name or description',
      });
      return;
    }

    // 检查是否已存在
    const existing = skillManager.getSkill(metadata.name);
    if (existing && !overwrite) {
      res.status(409).json({
        success: false,
        error: `Skill already exists: ${metadata.name}. Set overwrite=true to replace.`,
      });
      return;
    }

    // 如果存在且允许覆盖，先删除
    if (existing && overwrite) {
      if (existing.isBuiltin) {
        res.status(403).json({
          success: false,
          error: 'Cannot overwrite builtin skill',
        });
        return;
      }
      skillManager.getRegistry().unregister(metadata.name);
      await skillLoader.deleteSkill(metadata.name);
    }

    // 创建 Skill
    const skill = await skillLoader.createSkill(metadata.name, {
      description: metadata.description,
      content: content || `# ${metadata.name}\n\n${metadata.description}`,
      config: config || {},
    });

    // 注册到 SkillManager
    skillManager.getRegistry().register(skill);

    res.status(201).json({
      success: true,
      data: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        path: skill.path,
        imported: true,
        source: 'json',
      },
    });
  } catch (error) {
    logger.error('Failed to import skill', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to import skill',
    });
  }
});

// ==================== 基础路由 ====================

/**
 * GET /api/skills
 * 列出所有 Skill
 * Requirements: 13.1
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { builtin, enabled, page = '1', limit = '20' } = req.query;
    
    // 确保 SkillManager 已初始化
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    // 获取 Skill 列表
    const filter: { builtin?: boolean; enabled?: boolean } = {};
    if (builtin !== undefined) {
      filter.builtin = builtin === 'true';
    }
    if (enabled !== undefined) {
      filter.enabled = enabled === 'true';
    }

    const skills = skillManager.listSkills(filter);

    // 分页
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    const paginatedSkills = skills.slice(startIndex, endIndex);

    // 转换为响应格式
    const response = paginatedSkills.map(skill => ({
      name: skill.metadata.name,
      description: skill.metadata.description,
      version: skill.metadata.version,
      author: skill.metadata.author,
      tags: skill.metadata.tags,
      isBuiltin: skill.isBuiltin,
      enabled: skill.enabled,
      loadedAt: skill.loadedAt,
      modifiedAt: skill.modifiedAt,
    }));

    res.json({
      success: true,
      data: response,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: skills.length,
        totalPages: Math.ceil(skills.length / limitNum),
      },
    });
  } catch (error) {
    logger.error('Failed to list skills', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list skills',
    });
  }
});

/**
 * POST /api/skills
 * 创建 Skill
 * Requirements: 13.3
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, content, config } = req.body;

    if (!name || !description) {
      res.status(400).json({
        success: false,
        error: 'Name and description are required',
      });
      return;
    }

    // 检查是否已存在
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const existing = skillManager.getSkill(name);
    if (existing) {
      res.status(409).json({
        success: false,
        error: `Skill already exists: ${name}`,
      });
      return;
    }

    // 创建 Skill 目录和文件
    const skill = await skillLoader.createSkill(name, {
      description,
      content: content || `# ${name}\n\n${description}`,
      config: config || {},
    });

    // 注册到 SkillManager
    skillManager.getRegistry().register(skill);

    res.status(201).json({
      success: true,
      data: {
        name: skill.metadata.name,
        description: skill.metadata.description,
        path: skill.path,
      },
    });
  } catch (error) {
    logger.error('Failed to create skill', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create skill',
    });
  }
});

// ==================== 动态路由 /:name ====================

/**
 * GET /api/skills/:name
 * 获取 Skill 详情
 * Requirements: 13.2
 */
router.get('/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    res.json({
      success: true,
      data: {
        metadata: skill.metadata,
        config: skill.config,
        content: skill.content,
        path: skill.path,
        files: skill.files,
        isBuiltin: skill.isBuiltin,
        enabled: skill.enabled,
        loadedAt: skill.loadedAt,
        modifiedAt: skill.modifiedAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill',
    });
  }
});

/**
 * PUT /api/skills/:name
 * 更新 Skill
 * Requirements: 13.4
 */
router.put('/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { description, content, config } = req.body;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    // 内置 Skill 不能修改
    if (skill.isBuiltin) {
      res.status(403).json({
        success: false,
        error: 'Cannot modify builtin skill',
      });
      return;
    }

    // 更新 Skill 文件
    const updatedSkill = await skillLoader.updateSkill(name, {
      description,
      content,
      config,
    });

    // 重新注册
    skillManager.getRegistry().register(updatedSkill);

    res.json({
      success: true,
      data: {
        name: updatedSkill.metadata.name,
        description: updatedSkill.metadata.description,
        modifiedAt: updatedSkill.modifiedAt,
      },
    });
  } catch (error) {
    logger.error('Failed to update skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update skill',
    });
  }
});

/**
 * DELETE /api/skills/:name
 * 删除 Skill
 * Requirements: 13.5
 */
router.delete('/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    // 内置 Skill 不能删除
    if (skill.isBuiltin) {
      res.status(403).json({
        success: false,
        error: 'Cannot delete builtin skill',
      });
      return;
    }

    // 从注册表中移除
    skillManager.getRegistry().unregister(name);

    // 删除文件
    await skillLoader.deleteSkill(name);

    res.json({
      success: true,
      message: `Skill deleted: ${name}`,
    });
  } catch (error) {
    logger.error('Failed to delete skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete skill',
    });
  }
});

/**
 * PUT /api/skills/:name/toggle
 * 启用/禁用 Skill
 * Requirements: 13.9
 */
router.put('/:name/toggle', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'enabled must be a boolean',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const success = skillManager.toggleSkill(name, enabled);
    if (!success) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    res.json({
      success: true,
      data: {
        name,
        enabled,
      },
    });
  } catch (error) {
    logger.error('Failed to toggle skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to toggle skill',
    });
  }
});


/**
 * GET /api/skills/:name/metrics
 * 获取 Skill 指标
 * Requirements: 13.6
 */
router.get('/:name/metrics', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const metrics = skillManager.getSkillMetrics(name);
    if (!metrics) {
      res.status(404).json({
        success: false,
        error: `No metrics found for skill: ${name}`,
      });
      return;
    }

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    logger.error('Failed to get skill metrics', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get skill metrics',
    });
  }
});

/**
 * POST /api/skills/:name/test
 * 测试 Skill
 * Requirements: 13.15
 */
router.post('/:name/test', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { message } = req.body;

    if (!message) {
      res.status(400).json({
        success: false,
        error: 'message is required',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    // 测试 Skill 匹配
    const matchResult = await skillManager.selectSkill(message, 'test-session', {
      skillOverride: name,
    });

    res.json({
      success: true,
      data: {
        skill: matchResult.skill.metadata.name,
        matchType: matchResult.matchType,
        confidence: matchResult.confidence,
        matchReason: matchResult.matchReason,
      },
    });
  } catch (error) {
    logger.error('Failed to test skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to test skill',
    });
  }
});

/**
 * POST /api/skills/:name/clone
 * 克隆 Skill
 * Requirements: 13.13
 */
router.post('/:name/clone', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { newName } = req.body;

    if (!newName) {
      res.status(400).json({
        success: false,
        error: 'newName is required',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const sourceSkill = skillManager.getSkill(name);
    if (!sourceSkill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    // 检查新名称是否已存在
    const existing = skillManager.getSkill(newName);
    if (existing) {
      res.status(409).json({
        success: false,
        error: `Skill already exists: ${newName}`,
      });
      return;
    }

    // 克隆 Skill
    const clonedSkill = await skillLoader.cloneSkill(name, newName);

    // 注册克隆的 Skill
    skillManager.getRegistry().register(clonedSkill);

    res.status(201).json({
      success: true,
      data: {
        name: clonedSkill.metadata.name,
        description: clonedSkill.metadata.description,
        path: clonedSkill.path,
        clonedFrom: name,
      },
    });
  } catch (error) {
    logger.error('Failed to clone skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clone skill',
    });
  }
});


/**
 * GET /api/skills/:name/files
 * 列出 Skill 文件
 * Requirements: 13.16
 */
router.get('/:name/files', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    res.json({
      success: true,
      data: {
        path: skill.path,
        files: skill.files,
      },
    });
  } catch (error) {
    logger.error('Failed to list skill files', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list skill files',
    });
  }
});

/**
 * GET /api/skills/:name/files/:filename
 * 读取 Skill 文件
 * Requirements: 13.17
 */
router.get('/:name/files/:filename', async (req: Request, res: Response) => {
  try {
    const { name, filename } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    if (!skill.files.includes(filename)) {
      res.status(404).json({
        success: false,
        error: `File not found: ${filename}`,
      });
      return;
    }

    const content = await skillLoader.readSkillFile(name, filename);

    res.json({
      success: true,
      data: {
        filename,
        content,
      },
    });
  } catch (error) {
    logger.error('Failed to read skill file', { error, name: req.params.name, filename: req.params.filename });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read skill file',
    });
  }
});

/**
 * PUT /api/skills/:name/files/:filename
 * 更新 Skill 文件
 * Requirements: 13.18
 */
router.put('/:name/files/:filename', async (req: Request, res: Response) => {
  try {
    const { name, filename } = req.params;
    const { content } = req.body;

    if (content === undefined) {
      res.status(400).json({
        success: false,
        error: 'content is required',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    // 内置 Skill 不能修改
    if (skill.isBuiltin) {
      res.status(403).json({
        success: false,
        error: 'Cannot modify builtin skill files',
      });
      return;
    }

    await skillLoader.writeSkillFile(name, filename, content);

    // 如果修改的是 SKILL.md 或 config.json，需要重新加载 Skill
    if (filename === 'SKILL.md' || filename === 'config.json') {
      const updatedSkill = await skillLoader.reloadSkill(name);
      if (updatedSkill) {
        skillManager.getRegistry().register(updatedSkill);
      }
    }

    res.json({
      success: true,
      data: {
        filename,
        updated: true,
      },
    });
  } catch (error) {
    logger.error('Failed to update skill file', { error, name: req.params.name, filename: req.params.filename });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update skill file',
    });
  }
});

/**
 * GET /api/skills/:name/export
 * 导出 Skill 为 ZIP 或 JSON
 * Requirements: 13.10
 */
router.get('/:name/export', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const format = req.query.format as string || 'zip';

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const skill = skillManager.getSkill(name);
    if (!skill) {
      res.status(404).json({
        success: false,
        error: `Skill not found: ${name}`,
      });
      return;
    }

    // ZIP 格式导出
    if (format === 'zip') {
      const zipBuffer = await exportSkillToZip(name);
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.skill.zip"`);
      res.send(zipBuffer);
      return;
    }

    // JSON 格式导出 (兼容旧版)
    // 读取所有文件内容
    const files: Record<string, string> = {};
    for (const filename of skill.files) {
      try {
        files[filename] = await skillLoader.readSkillFile(name, filename);
      } catch {
        // 跳过无法读取的文件
      }
    }

    // 导出为 JSON 格式
    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      skill: {
        metadata: skill.metadata,
        config: skill.config,
        content: skill.content,
        files,
      },
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.skill.json"`);
    res.json(exportData);
  } catch (error) {
    logger.error('Failed to export skill', { error, name: req.params.name });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to export skill',
    });
  }
});

// ==================== 链式调用 API ====================

/**
 * GET /api/skills/chain/stats
 * 获取链式调用统计信息
 * Requirements: 18.7
 */
router.get('/chain/stats', async (_req: Request, res: Response) => {
  try {
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const chainManager = skillManager.getChainManager();
    const stats = chainManager.getChainStats();
    const config = chainManager.getConfig();

    res.json({
      success: true,
      data: {
        stats,
        config,
      },
    });
  } catch (error) {
    logger.error('Failed to get chain stats', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get chain stats',
    });
  }
});

/**
 * GET /api/skills/chain/:sessionId/history
 * 获取会话的链式调用历史
 * Requirements: 18.7
 */
router.get('/chain/:sessionId/history', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const history = skillManager.getChainHistory(sessionId);

    res.json({
      success: true,
      data: {
        sessionId,
        history,
        totalSteps: history.length,
      },
    });
  } catch (error) {
    logger.error('Failed to get chain history', { error, sessionId: req.params.sessionId });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get chain history',
    });
  }
});

/**
 * POST /api/skills/chain/:sessionId/confirm
 * 确认链式切换
 * Requirements: 18.3
 */
router.post('/chain/:sessionId/confirm', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { skillName, reason } = req.body;

    if (!skillName) {
      res.status(400).json({
        success: false,
        error: 'skillName is required',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const result = await skillManager.confirmChainSwitch(
      sessionId,
      skillName,
      reason || '用户确认切换'
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to confirm chain switch', { error, sessionId: req.params.sessionId });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to confirm chain switch',
    });
  }
});

/**
 * POST /api/skills/chain/:sessionId/end
 * 结束当前链
 * Requirements: 18.7
 */
router.post('/chain/:sessionId/end', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { success = true, resultSummary } = req.body;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const chainState = skillManager.endCurrentChain(sessionId, success, resultSummary);

    res.json({
      success: true,
      data: {
        ended: !!chainState,
        chainState,
      },
    });
  } catch (error) {
    logger.error('Failed to end chain', { error, sessionId: req.params.sessionId });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to end chain',
    });
  }
});

/**
 * PUT /api/skills/chain/config
 * 更新链式调用配置
 * Requirements: 18.6
 */
router.put('/chain/config', async (req: Request, res: Response) => {
  try {
    const { enabled, maxChainDepth, chainTimeoutMs, requireConfirmation } = req.body;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const chainManager = skillManager.getChainManager();
    
    const updates: Record<string, unknown> = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (typeof maxChainDepth === 'number') updates.maxChainDepth = maxChainDepth;
    if (typeof chainTimeoutMs === 'number') updates.chainTimeoutMs = chainTimeoutMs;
    if (typeof requireConfirmation === 'boolean') updates.requireConfirmation = requireConfirmation;

    chainManager.updateConfig(updates);

    res.json({
      success: true,
      data: chainManager.getConfig(),
    });
  } catch (error) {
    logger.error('Failed to update chain config', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update chain config',
    });
  }
});

// ==================== 批量操作 API ====================

/**
 * POST /api/skills/batch/toggle
 * 批量启用/禁用 Skill
 * Requirements: 14.12
 */
router.post('/batch/toggle', async (req: Request, res: Response) => {
  try {
    const { names, enabled } = req.body;

    if (!Array.isArray(names) || names.length === 0) {
      res.status(400).json({
        success: false,
        error: 'names must be a non-empty array',
      });
      return;
    }

    if (typeof enabled !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'enabled must be a boolean',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const name of names) {
      try {
        const skill = skillManager.getSkill(name);
        if (!skill) {
          results.push({ name, success: false, error: 'Skill not found' });
          continue;
        }

        // generalist 不能禁用
        if (name === 'generalist' && !enabled) {
          results.push({ name, success: false, error: 'Cannot disable generalist skill' });
          continue;
        }

        const success = skillManager.toggleSkill(name, enabled);
        results.push({ name, success });
      } catch (err) {
        results.push({ name, success: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: names.length,
          success: successCount,
          failed: failCount,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to batch toggle skills', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to batch toggle skills',
    });
  }
});

/**
 * POST /api/skills/batch/delete
 * 批量删除 Skill（仅自定义 Skill）
 * Requirements: 14.12
 */
router.post('/batch/delete', async (req: Request, res: Response) => {
  try {
    const { names } = req.body;

    if (!Array.isArray(names) || names.length === 0) {
      res.status(400).json({
        success: false,
        error: 'names must be a non-empty array',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const results: { name: string; success: boolean; error?: string }[] = [];

    for (const name of names) {
      try {
        const skill = skillManager.getSkill(name);
        if (!skill) {
          results.push({ name, success: false, error: 'Skill not found' });
          continue;
        }

        // 内置 Skill 不能删除
        if (skill.isBuiltin) {
          results.push({ name, success: false, error: 'Cannot delete builtin skill' });
          continue;
        }

        // 从注册表中移除
        skillManager.getRegistry().unregister(name);

        // 删除文件
        await skillLoader.deleteSkill(name);

        results.push({ name, success: true });
      } catch (err) {
        results.push({ name, success: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: names.length,
          success: successCount,
          failed: failCount,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to batch delete skills', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to batch delete skills',
    });
  }
});

/**
 * POST /api/skills/batch/export
 * 批量导出 Skill 为 ZIP 归档
 * Requirements: 14.12
 */
router.post('/batch/export', async (req: Request, res: Response) => {
  try {
    const { names } = req.body;

    if (!Array.isArray(names) || names.length === 0) {
      res.status(400).json({
        success: false,
        error: 'names must be a non-empty array',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    // 动态导入 archiver
    const archiver = await import('archiver');
    const archive = archiver.default('zip', { zlib: { level: 9 } });

    // 设置响应头
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="skills-export-${Date.now()}.zip"`);

    // 管道到响应
    archive.pipe(res);

    const errors: { name: string; error: string }[] = [];

    for (const name of names) {
      try {
        const skill = skillManager.getSkill(name);
        if (!skill) {
          errors.push({ name, error: 'Skill not found' });
          continue;
        }

        // 获取单个 Skill 的 ZIP buffer
        const skillZipBuffer = await exportSkillToZip(name);
        
        // 添加到归档中
        archive.append(skillZipBuffer, { name: `${name}.skill.zip` });
      } catch (err) {
        errors.push({ name, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    // 如果有错误，添加错误日志文件
    if (errors.length > 0) {
      archive.append(JSON.stringify(errors, null, 2), { name: 'export-errors.json' });
    }

    // 完成归档
    await archive.finalize();
  } catch (error) {
    logger.error('Failed to batch export skills', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to batch export skills',
    });
  }
});

// ==================== 映射配置 API ====================

/**
 * GET /api/skills/mapping
 * 获取意图-Skill 映射配置
 * Requirements: 14.18
 */
router.get('/mapping', async (_req: Request, res: Response) => {
  try {
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const matcher = skillManager.getMatcher();
    const config = matcher.getMappingConfig();

    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    logger.error('Failed to get mapping config', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get mapping config',
    });
  }
});

/**
 * PUT /api/skills/mapping
 * 更新意图-Skill 映射配置
 * Requirements: 14.18
 */
router.put('/mapping', async (req: Request, res: Response) => {
  try {
    const { intentMapping, keywordMapping, defaultSkill, semanticMatchThreshold, contextContinuationThreshold } = req.body;

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    const matcher = skillManager.getMatcher();
    
    const updates: Record<string, unknown> = {};
    if (intentMapping) updates.intentMapping = intentMapping;
    if (keywordMapping) updates.keywordMapping = keywordMapping;
    if (defaultSkill) updates.defaultSkill = defaultSkill;
    if (typeof semanticMatchThreshold === 'number') updates.semanticMatchThreshold = semanticMatchThreshold;
    if (typeof contextContinuationThreshold === 'number') updates.contextContinuationThreshold = contextContinuationThreshold;

    matcher.updateMappingConfig(updates);
    await matcher.saveMappingConfig();

    res.json({
      success: true,
      data: matcher.getMappingConfig(),
    });
  } catch (error) {
    logger.error('Failed to update mapping config', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update mapping config',
    });
  }
});

/**
 * POST /api/skills/test-match
 * 测试 Skill 匹配
 * Requirements: 14.18
 */
router.post('/test-match', async (req: Request, res: Response) => {
  try {
    const { message } = req.body;

    if (!message) {
      res.status(400).json({
        success: false,
        error: 'message is required',
      });
      return;
    }

    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }

    // 使用临时会话 ID 进行测试
    const testSessionId = `test-${Date.now()}`;
    const result = await skillManager.selectSkill(message, testSessionId);

    // 清理测试会话
    skillManager.clearSessionSkill(testSessionId);

    res.json({
      success: true,
      data: {
        skill: result.skill.metadata.name,
        confidence: result.confidence,
        matchType: result.matchType,
        matchReason: result.matchReason,
      },
    });
  } catch (error) {
    logger.error('Failed to test match', { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to test match',
    });
  }
});

export default router;
