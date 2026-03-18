/**
 * RAG Routes
 * 定义 Agentic RAG 智能检索增强相关的路由
 *
 * 路由分组：
 * - /api/ai-ops/rag/knowledge - 知识库管理
 * - /api/ai-ops/rag/vector - 向量数据库管理
 * - /api/ai-ops/rag/embedding - 嵌入服务管理
 * - /api/ai-ops/rag/query - RAG 查询
 * - /api/ai-ops/rag/analyze - 增强分析
 *
 * Requirements: 4.1, 4.2, 4.3, 10.1, 10.2, 10.3, 10.4
 * - 4.1: 分析告警时检索相关历史告警及其解决方案
 * - 4.2: 生成修复方案时检索类似的历史修复方案及其结果
 * - 4.3: 执行根因分析时检索相关历史事件
 * - 10.1: 提供 API 列出、搜索和浏览知识条目
 * - 10.2: 支持手动编辑和删除知识条目
 * - 10.3: 支持从外部来源批量导入知识
 * - 10.4: 支持导出知识用于备份或迁移
 */

import { Router, Request, Response } from 'express';
import {
  KnowledgeBase,
  embeddingService,
  ragEngine,
  mastraAgent,
  registerPredefinedTools,
  getToolDescriptions,
  type KnowledgeQuery,
  type KnowledgeEntryType,
} from '../services/ai-ops/rag';
import { VectorStoreClient } from '../services/ai-ops/rag/vectorStoreClient';
import { getService, SERVICE_NAMES } from '../services/bootstrap';
import { logger } from '../utils/logger';
import { AlertEvent, SystemMetrics, RootCauseAnalysis, SnapshotDiff, UnifiedEvent } from '../types/ai-ops';

const router = Router();

// ==================== 辅助函数 ====================

/**
 * 获取知识库服务实例（确保已初始化）
 * 使用 getServiceAsync 触发延迟初始化
 */
async function getKnowledgeBaseService(): Promise<KnowledgeBase> {
  const { getServiceAsync, SERVICE_NAMES } = await import('../services/bootstrap');
  return await getServiceAsync<KnowledgeBase>(SERVICE_NAMES.KNOWLEDGE_BASE);
}

// ==================== 知识库管理 ====================

/**
 * GET /api/ai-ops/rag/knowledge
 * 获取知识条目列表
 * 支持分页参数: page (页码，从1开始), pageSize (每页数量)
 */
router.get('/knowledge', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { type, category, tags, from, to, limit, page, pageSize } = req.query;

    const query: Partial<KnowledgeQuery> = {};
    if (type) query.type = type as KnowledgeEntryType;
    if (category) query.category = category as string;
    if (tags) query.tags = (tags as string).split(',');
    if (from || to) {
      query.dateRange = {
        from: from ? parseInt(from as string) : 0,
        to: to ? parseInt(to as string) : Date.now(),
      };
    }

    const entries = await kb.export(query);
    const total = entries.length;

    // 支持分页
    const pageNum = page ? Math.max(1, parseInt(page as string)) : 1;
    const pageSizeNum = pageSize ? parseInt(pageSize as string) : (limit ? parseInt(limit as string) : 100);
    const offset = (pageNum - 1) * pageSizeNum;
    const paginatedEntries = entries.slice(offset, offset + pageSizeNum);

    res.json({
      success: true,
      data: paginatedEntries,
      total,
      page: pageNum,
      pageSize: pageSizeNum,
    });
  } catch (error) {
    logger.error('Failed to get knowledge entries', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge
 * 添加知识条目
 */
router.post('/knowledge', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { type, title, content, metadata } = req.body;

    if (!type || !title || !content) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: type, title, content',
      });
      return;
    }

    const entry = await kb.add({
      type,
      title,
      content,
      metadata: {
        source: metadata?.source || 'api',
        timestamp: Date.now(),
        category: metadata?.category || 'general',
        tags: metadata?.tags || [],
        usageCount: 0,
        feedbackScore: 0,
        feedbackCount: 0,
        ...metadata,
      },
    });

    res.status(201).json({
      success: true,
      data: entry,
    });
  } catch (error) {
    logger.error('Failed to add knowledge entry', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/knowledge/stats
 * 获取知识库统计
 */
router.get('/knowledge/stats', async (_req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const stats = await kb.getStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get knowledge stats', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/search
 * 语义检索知识条目
 */
router.post('/knowledge/search', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { query, type, category, tags, dateRange, limit, minScore } = req.body;

    if (!query) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: query',
      });
      return;
    }

    const searchQuery: KnowledgeQuery = {
      query,
      type,
      category,
      tags,
      dateRange,
      limit: limit || 10,
      minScore: minScore || 0.3,
    };

    const results = await kb.search(searchQuery);

    res.json({
      success: true,
      data: results,
      total: results.length,
    });
  } catch (error) {
    logger.error('Failed to search knowledge', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/bulk
 * 批量添加知识条目
 */
router.post('/knowledge/bulk', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { entries } = req.body;

    if (!entries || !Array.isArray(entries)) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: entries (array)',
      });
      return;
    }

    const results = await kb.bulkAdd(entries);

    res.status(201).json({
      success: true,
      data: results,
      total: results.length,
    });
  } catch (error) {
    logger.error('Failed to bulk add knowledge entries', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * DELETE /api/ai-ops/rag/knowledge/bulk
 * 批量删除知识条目
 */
router.delete('/knowledge/bulk', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids)) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: ids (array)',
      });
      return;
    }

    await kb.bulkDelete(ids);

    res.json({
      success: true,
      message: `Deleted ${ids.length} entries`,
    });
  } catch (error) {
    logger.error('Failed to bulk delete knowledge entries', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/export
 * 导出知识条目
 */
router.post('/knowledge/export', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { type, category, tags, dateRange } = req.body;

    const filter: Partial<KnowledgeQuery> = {};
    if (type) filter.type = type;
    if (category) filter.category = category;
    if (tags) filter.tags = tags;
    if (dateRange) filter.dateRange = dateRange;

    const entries = await kb.export(filter);

    res.json({
      success: true,
      data: entries,
      total: entries.length,
      exportedAt: Date.now(),
    });
  } catch (error) {
    logger.error('Failed to export knowledge', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/import
 * 导入知识条目
 */
router.post('/knowledge/import', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { entries } = req.body;

    if (!entries || !Array.isArray(entries)) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: entries (array)',
      });
      return;
    }

    const result = await kb.import(entries);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to import knowledge', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/reindex
 * 重建知识库索引
 */
router.post('/knowledge/reindex', async (_req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    await kb.reindex();

    res.json({
      success: true,
      message: 'Reindex completed',
    });
  } catch (error) {
    logger.error('Failed to reindex knowledge', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});


/**
 * GET /api/ai-ops/rag/knowledge/:id
 * 获取单个知识条目
 */
router.get('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;
    const entry = await kb.get(id);

    if (!entry) {
      res.status(404).json({
        success: false,
        error: 'Knowledge entry not found',
      });
      return;
    }

    res.json({
      success: true,
      data: entry,
    });
  } catch (error) {
    logger.error('Failed to get knowledge entry', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * PUT /api/ai-ops/rag/knowledge/:id
 * 更新知识条目
 */
router.put('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;
    const updates = req.body;

    const entry = await kb.update(id, updates);

    res.json({
      success: true,
      data: entry,
    });
  } catch (error) {
    logger.error('Failed to update knowledge entry', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * DELETE /api/ai-ops/rag/knowledge/:id
 * 删除知识条目
 */
router.delete('/knowledge/:id', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;
    await kb.delete(id);

    res.json({
      success: true,
      message: 'Knowledge entry deleted',
    });
  } catch (error) {
    logger.error('Failed to delete knowledge entry', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/:id/feedback
 * 提交知识条目反馈
 */
router.post('/knowledge/:id/feedback', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;
    const { score } = req.body;

    if (typeof score !== 'number' || score < 0 || score > 5) {
      res.status(400).json({
        success: false,
        error: 'Invalid score: must be a number between 0 and 5',
      });
      return;
    }

    await kb.recordFeedback(id, score);
    await kb.recordUsage(id);

    res.json({
      success: true,
      message: 'Feedback recorded',
    });
  } catch (error) {
    logger.error('Failed to record feedback', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// ==================== 知识-规则关联管理 ====================

/**
 * POST /api/ai-ops/rag/knowledge/:id/link-rule
 * 关联知识条目与告警规则
 * Requirements: 6.1
 */
router.post('/knowledge/:id/link-rule', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;
    const { ruleId } = req.body;

    if (!ruleId) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: ruleId',
      });
      return;
    }

    await kb.linkToRule(id, ruleId);

    res.json({
      success: true,
      message: 'Knowledge entry linked to rule',
    });
  } catch (error) {
    logger.error('Failed to link knowledge to rule', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * DELETE /api/ai-ops/rag/knowledge/:id/link-rule/:ruleId
 * 取消知识条目与告警规则的关联
 * Requirements: 6.1
 */
router.delete('/knowledge/:id/link-rule/:ruleId', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id, ruleId } = req.params;

    await kb.unlinkFromRule(id, ruleId);

    res.json({
      success: true,
      message: 'Knowledge entry unlinked from rule',
    });
  } catch (error) {
    logger.error('Failed to unlink knowledge from rule', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/knowledge/by-rule/:ruleId
 * 获取规则关联的知识条目
 * Requirements: 6.2
 */
router.get('/knowledge/by-rule/:ruleId', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { ruleId } = req.params;

    const entries = await kb.getEntriesByRule(ruleId);

    res.json({
      success: true,
      data: entries,
      total: entries.length,
    });
  } catch (error) {
    logger.error('Failed to get entries by rule', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/knowledge/:id/rules
 * 获取知识条目关联的规则
 * Requirements: 6.3
 */
router.get('/knowledge/:id/rules', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;

    const ruleIds = await kb.getRulesByEntry(id);

    res.json({
      success: true,
      data: ruleIds,
      total: ruleIds.length,
    });
  } catch (error) {
    logger.error('Failed to get rules by entry', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/knowledge/suggest-for-rule/:ruleId
 * 基于内容相似度建议关联
 * Requirements: 6.4
 */
router.get('/knowledge/suggest-for-rule/:ruleId', async (req: Request, res: Response): Promise<void> => {
  try {
    const kb = await getKnowledgeBaseService();
    const { ruleId } = req.params;
    const { ruleName, ruleDescription, limit } = req.query;

    if (!ruleName) {
      res.status(400).json({
        success: false,
        error: 'ruleName query parameter is required',
      });
      return;
    }

    const suggestions = await kb.suggestAssociations(
      ruleId,
      ruleName as string,
      ruleDescription as string | undefined,
      0.5,
      limit ? parseInt(limit as string) : 5
    );

    res.json({
      success: true,
      data: suggestions.map(s => ({
        entryId: s.entry.id,
        title: s.entry.title,
        type: s.entry.type,
        similarity: s.score,
        excerpt: s.entry.content.substring(0, 200) + (s.entry.content.length > 200 ? '...' : ''),
      })),
      total: suggestions.length,
    });
  } catch (error) {
    logger.error('Failed to suggest associations', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/knowledge/:id/effectiveness
 * 获取知识条目效果指标
 * Requirements: 6.5
 */
router.get('/knowledge/:id/effectiveness', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { id } = req.params;

    const entry = await kb.get(id);
    if (!entry) {
      res.status(404).json({
        success: false,
        error: 'Knowledge entry not found',
      });
      return;
    }

    // 获取效果指标
    const effectiveness = await kb.getEffectiveness(id);

    res.json({
      success: true,
      data: effectiveness,
    });
  } catch (error) {
    logger.error('Failed to get knowledge effectiveness', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/bulk-link-rule
 * 批量关联知识条目与规则
 * Requirements: 6.1
 */
router.post('/knowledge/bulk-link-rule', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { entryIds, ruleId } = req.body;

    if (!entryIds || !Array.isArray(entryIds) || !ruleId) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: entryIds (array), ruleId',
      });
      return;
    }

    let success = 0;
    let failed = 0;

    for (const entryId of entryIds) {
      try {
        await kb.linkToRule(entryId, ruleId);
        success++;
      } catch {
        failed++;
      }
    }

    res.json({
      success: true,
      data: { success, failed },
    });
  } catch (error) {
    logger.error('Failed to bulk link knowledge to rule', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/knowledge/from-feedback
 * 从反馈创建知识条目
 * Requirements: 5.5, 5.6
 */
router.post('/knowledge/from-feedback', async (req: Request, res: Response) => {
  try {
    const kb = await getKnowledgeBaseService();
    const { ruleId, title, content, category, tags, linkToRule } = req.body;

    if (!ruleId || !title || !content) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: ruleId, title, content',
      });
      return;
    }

    // 创建知识条目
    const entry = await kb.add({
      type: 'manual',
      title,
      content,
      metadata: {
        source: 'feedback',
        timestamp: Date.now(),
        category: category || 'feedback',
        tags: tags || ['from_feedback', ruleId],
        usageCount: 0,
        feedbackScore: 0,
        feedbackCount: 0,
        createdFromFeedback: true,
        feedbackSourceId: ruleId,
        linkedRuleIds: linkToRule !== false ? [ruleId] : [],
      },
    });

    // 如果需要关联到规则
    if (linkToRule !== false) {
      await kb.linkToRule(entry.id, ruleId);
    }

    res.status(201).json({
      success: true,
      data: entry,
    });
  } catch (error) {
    logger.error('Failed to create knowledge from feedback', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// ==================== 向量数据库管理 ====================

/**
 * 获取向量数据库服务实例
 */
function getVectorDatabase(): VectorStoreClient {
  return getService<VectorStoreClient>(SERVICE_NAMES.VECTOR_DATABASE);
}

/**
 * GET /api/ai-ops/rag/vector/stats
 * 获取向量数据库统计
 */
router.get('/vector/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getVectorDatabase().getStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get vector database stats', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/vector/collections
 * 获取向量数据库集合列表
 */
router.get('/vector/collections', async (_req: Request, res: Response) => {
  try {
    const collections = await getVectorDatabase().listCollections();
    res.json({
      success: true,
      data: collections,
    });
  } catch (error) {
    logger.error('Failed to get vector collections', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/vector/search
 * 向量检索
 */
router.post('/vector/search', async (req: Request, res: Response) => {
  try {
    const { collection, query, topK, minScore } = req.body;

    if (!collection || !query) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: collection, query',
      });
      return;
    }

    // 生成查询向量
    const embedding = await embeddingService.embed(query);

    // 执行向量搜索
    const results = await getVectorDatabase().searchByVector(collection, embedding.vector, {
      topK: topK || 10,
      minScore: minScore || 0.3,
    });

    res.json({
      success: true,
      data: results,
      total: results.length,
    });
  } catch (error) {
    logger.error('Failed to search vectors', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// ==================== 嵌入服务管理 ====================

/**
 * GET /api/ai-ops/rag/embedding/config
 * 获取嵌入服务配置
 */
router.get('/embedding/config', (_req: Request, res: Response) => {
  try {
    const config = embeddingService.getConfig();
    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    logger.error('Failed to get embedding config', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * PUT /api/ai-ops/rag/embedding/config
 * 更新嵌入服务配置
 */
router.put('/embedding/config', async (req: Request, res: Response) => {
  try {
    const config = req.body;
    await embeddingService.updateConfig(config);

    res.json({
      success: true,
      data: embeddingService.getConfig(),
    });
  } catch (error) {
    logger.error('Failed to update embedding config', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/embedding/embed
 * 生成文本嵌入向量
 */
router.post('/embedding/embed', async (req: Request, res: Response) => {
  try {
    const { text, texts } = req.body;

    if (!text && !texts) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: text or texts',
      });
      return;
    }

    if (texts && Array.isArray(texts)) {
      const results = await embeddingService.embedBatch(texts);
      res.json({
        success: true,
        data: results,
      });
    } else {
      const result = await embeddingService.embed(text);
      res.json({
        success: true,
        data: result,
      });
    }
  } catch (error) {
    logger.error('Failed to generate embedding', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/embedding/cache/stats
 * 获取嵌入缓存统计
 */
router.get('/embedding/cache/stats', (_req: Request, res: Response) => {
  try {
    const stats = embeddingService.getCacheStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get embedding cache stats', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/embedding/cache/clear
 * 清空嵌入缓存
 */
router.post('/embedding/cache/clear', (_req: Request, res: Response) => {
  try {
    embeddingService.clearCache();
    res.json({
      success: true,
      message: 'Embedding cache cleared',
    });
  } catch (error) {
    logger.error('Failed to clear embedding cache', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// ==================== RAG 引擎 ====================

/**
 * POST /api/ai-ops/rag/query
 * RAG 查询
 * Requirement 4.1, 4.2, 4.3
 */
router.post('/query', async (req: Request, res: Response) => {
  try {
    const { question, context } = req.body;

    if (!question) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: question',
      });
      return;
    }

    // 确保 RAG 引擎已初始化
    if (!ragEngine.isInitialized()) {
      await ragEngine.initialize();
    }

    const result = await ragEngine.query(question, context);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to execute RAG query', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/config
 * 获取 RAG 配置
 */
router.get('/config', (_req: Request, res: Response) => {
  try {
    const config = ragEngine.getConfig();
    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    logger.error('Failed to get RAG config', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * PUT /api/ai-ops/rag/config
 * 更新 RAG 配置
 */
router.put('/config', (req: Request, res: Response) => {
  try {
    const config = req.body;
    ragEngine.updateConfig(config);

    res.json({
      success: true,
      data: ragEngine.getConfig(),
    });
  } catch (error) {
    logger.error('Failed to update RAG config', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/stats
 * 获取 RAG 统计
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = ragEngine.getStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get RAG stats', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// ==================== 增强分析 ====================

/**
 * POST /api/ai-ops/rag/analyze/alert/:id
 * RAG 增强告警分析
 * Requirement 4.1
 */
router.post('/analyze/alert/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { alertEvent, metrics } = req.body;

    if (!alertEvent) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: alertEvent',
      });
      return;
    }

    // 确保 RAG 引擎已初始化
    if (!ragEngine.isInitialized()) {
      await ragEngine.initialize();
    }

    // 使用标准 RAG 分析
    const result = await ragEngine.analyzeAlert(
      alertEvent as AlertEvent,
      metrics as SystemMetrics | undefined
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to analyze alert with RAG', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/analyze/remediation
 * RAG 增强修复方案生成
 * Requirement 4.2
 */
router.post('/analyze/remediation', async (req: Request, res: Response) => {
  try {
    const { analysis } = req.body;

    if (!analysis) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: analysis',
      });
      return;
    }

    // 确保 RAG 引擎已初始化
    if (!ragEngine.isInitialized()) {
      await ragEngine.initialize();
    }

    const result = await ragEngine.generateRemediation(analysis as RootCauseAnalysis);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to generate remediation with RAG', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/analyze/config-risk
 * 配置变更风险评估
 * Requirement 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */
router.post('/analyze/config-risk', async (req: Request, res: Response) => {
  try {
    const { diff } = req.body;

    if (!diff) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: diff',
      });
      return;
    }

    // 确保 RAG 引擎已初始化
    if (!ragEngine.isInitialized()) {
      await ragEngine.initialize();
    }

    const result = await ragEngine.assessConfigRisk(diff as SnapshotDiff);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to assess config risk with RAG', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/analyze/root-cause
 * RAG 增强根因分析
 * Requirement 4.3
 */
router.post('/analyze/root-cause', async (req: Request, res: Response) => {
  try {
    const { event } = req.body;

    if (!event) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: event',
      });
      return;
    }

    // 确保 RAG 引擎已初始化
    if (!ragEngine.isInitialized()) {
      await ragEngine.initialize();
    }

    const result = await ragEngine.analyzeRootCause(event as UnifiedEvent);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to analyze root cause with RAG', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

// ==================== Agent 相关 ====================

/**
 * 确保 Agent 已初始化并注册工具
 */
async function ensureAgentInitialized(): Promise<void> {
  if (!mastraAgent.isInitialized()) {
    await mastraAgent.initialize();
    registerPredefinedTools(mastraAgent);
  }
}

/**
 * POST /api/ai-ops/rag/agent/chat
 * Agent 对话
 * Requirement 5.4, 5.7
 */
router.post('/agent/chat', async (req: Request, res: Response) => {
  try {
    const { message, sessionId } = req.body;

    if (!message) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: message',
      });
      return;
    }

    await ensureAgentInitialized();

    const result = await mastraAgent.chat(message, sessionId);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to process agent chat', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/agent/task
 * 执行任务
 * Requirement 5.7
 */
router.post('/agent/task', async (req: Request, res: Response) => {
  try {
    const { task, context } = req.body;

    if (!task) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: task',
      });
      return;
    }

    await ensureAgentInitialized();

    const result = await mastraAgent.executeTask(task, context);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to execute agent task', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/agent/sessions
 * 获取会话列表
 * Requirement 5.4
 */
router.get('/agent/sessions', async (_req: Request, res: Response) => {
  try {
    await ensureAgentInitialized();

    const sessions = mastraAgent.getSessions();

    res.json({
      success: true,
      data: sessions.map(s => ({
        sessionId: s.sessionId,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        lastUpdated: s.lastUpdated,
      })),
      total: sessions.length,
    });
  } catch (error) {
    logger.error('Failed to get agent sessions', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/agent/sessions/:id
 * 获取会话详情
 * Requirement 5.4
 */
router.get('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await ensureAgentInitialized();

    const session = mastraAgent.getSession(id);

    if (!session) {
      res.status(404).json({
        success: false,
        error: 'Session not found',
      });
      return;
    }

    res.json({
      success: true,
      data: session,
    });
  } catch (error) {
    logger.error('Failed to get agent session', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * DELETE /api/ai-ops/rag/agent/sessions/:id
 * 删除会话
 * Requirement 5.4
 */
router.delete('/agent/sessions/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await ensureAgentInitialized();

    await mastraAgent.clearSession(id);

    res.json({
      success: true,
      message: 'Session deleted',
    });
  } catch (error) {
    logger.error('Failed to delete agent session', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/ai-ops/rag/agent/sessions
 * 创建新会话
 * Requirement 5.4
 */
router.post('/agent/sessions', async (_req: Request, res: Response) => {
  try {
    await ensureAgentInitialized();

    const sessionId = mastraAgent.createSession();

    res.status(201).json({
      success: true,
      data: {
        sessionId,
        createdAt: Date.now(),
      },
    });
  } catch (error) {
    logger.error('Failed to create agent session', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/agent/tools
 * 获取可用工具列表
 * Requirement 5.1
 */
router.get('/agent/tools', async (_req: Request, res: Response) => {
  try {
    await ensureAgentInitialized();

    const tools = getToolDescriptions();

    res.json({
      success: true,
      data: tools,
      total: tools.length,
    });
  } catch (error) {
    logger.error('Failed to get agent tools', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/agent/stats
 * 获取 Agent 统计
 */
router.get('/agent/stats', async (_req: Request, res: Response) => {
  try {
    await ensureAgentInitialized();

    const stats = mastraAgent.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get agent stats', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * GET /api/ai-ops/rag/agent/config
 * 获取 Agent 配置
 */
router.get('/agent/config', async (_req: Request, res: Response) => {
  try {
    await ensureAgentInitialized();

    const config = mastraAgent.getConfig();

    res.json({
      success: true,
      data: {
        maxIterations: config.maxIterations,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        toolCount: config.tools.length,
      },
    });
  } catch (error) {
    logger.error('Failed to get agent config', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

/**
 * PUT /api/ai-ops/rag/agent/config
 * 更新 Agent 配置
 */
router.put('/agent/config', async (req: Request, res: Response) => {
  try {
    const { maxIterations, maxTokens, temperature } = req.body;

    await ensureAgentInitialized();

    mastraAgent.updateConfig({
      maxIterations,
      maxTokens,
      temperature,
    });

    res.json({
      success: true,
      data: mastraAgent.getConfig(),
    });
  } catch (error) {
    logger.error('Failed to update agent config', { error });
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

export default router;
