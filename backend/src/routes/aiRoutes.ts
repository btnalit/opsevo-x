/**
 * AI Routes
 * 定义 AI Agent Client 相关的路由
 *
 * 路由分组：
 * - /api/ai/configs - API 配置管理
 * - /api/ai/chat - 聊天功能
 * - /api/ai/context - RouterOS 上下文
 * - /api/ai/scripts - 脚本执行
 * - /api/ai/sessions - 会话管理
 * - /api/ai/providers - 提供商信息
 *
 * Requirements: 1.1-1.7, 2.1-2.8, 4.1-4.7, 5.1-5.6
 */

import { Router } from 'express';
import {
  // API 配置管理
  getConfigs,
  getConfigById,
  createConfig,
  updateConfig,
  deleteConfig,
  getDefaultConfig,
  setDefaultConfig,
  testConfigConnection,
  getProviders,
  // 聊天功能
  chat,
  chatStream,
  // 上下文
  getContext,
  getContextSections,
  getContextSection,
  // 脚本执行
  executeScript,
  validateScript,
  getScriptHistory,
  deleteScriptHistory,
  clearSessionScriptHistory,
  // 会话管理
  getSessions,
  getSessionById,
  createSession,
  updateSession,
  deleteSession,
  renameSession,
  clearSessionMessages,
  exportSession,
  duplicateSession,
  searchSessions,
  deleteAllSessions,
  // 对话收藏管理
  collectMessage,
  uncollectMessage,
  getCollectedMessages,
  getSessionsWithCollections,
  // 对话转知识库
  convertToKnowledge,
  batchConvertToKnowledge,
  suggestTags,
  exportCollectedMessages,
  // 会话配置管理
  getSessionConfig,
  updateSessionConfig,
  getContextStats,
  getContextMessages,
} from '../controllers/aiController';

const router = Router();


// ==================== 提供商信息 ====================

// GET /api/ai/providers - 获取所有支持的提供商
router.get('/providers', getProviders);

// ==================== API 配置管理 ====================

// GET /api/ai/configs/default - 获取默认配置（放在 :id 路由之前）
router.get('/configs/default', getDefaultConfig);

// GET /api/ai/configs - 获取所有配置
router.get('/configs', getConfigs);

// GET /api/ai/configs/:id - 获取单个配置
router.get('/configs/:id', getConfigById);

// POST /api/ai/configs - 创建配置
router.post('/configs', createConfig);

// PUT /api/ai/configs/:id - 更新配置
router.put('/configs/:id', updateConfig);

// DELETE /api/ai/configs/:id - 删除配置
router.delete('/configs/:id', deleteConfig);

// POST /api/ai/configs/:id/default - 设置为默认配置
router.post('/configs/:id/default', setDefaultConfig);

// POST /api/ai/configs/:id/test - 测试配置连接
router.post('/configs/:id/test', testConfigConnection);

// ==================== 聊天功能 ====================

// POST /api/ai/chat - 发送聊天消息（非流式）
router.post('/chat', chat);

// POST /api/ai/chat/stream - 发送聊天消息（流式 SSE）
router.post('/chat/stream', chatStream);

// ==================== RouterOS 上下文 ====================

// GET /api/ai/context - 获取当前上下文
router.get('/context', getContext);

// GET /api/ai/context/sections - 获取可用配置段列表
router.get('/context/sections', getContextSections);

// GET /api/ai/context/sections/:section - 获取指定配置段
router.get('/context/sections/:section', getContextSection);


// ==================== 脚本执行 ====================

// POST /api/ai/scripts/execute - 执行脚本
router.post('/scripts/execute', executeScript);

// POST /api/ai/scripts/validate - 验证脚本
router.post('/scripts/validate', validateScript);

// GET /api/ai/scripts/history - 获取执行历史
router.get('/scripts/history', getScriptHistory);

// DELETE /api/ai/scripts/history/session/:sessionId - 清除会话的执行历史
router.delete('/scripts/history/session/:sessionId', clearSessionScriptHistory);

// DELETE /api/ai/scripts/history/:id - 删除单条执行历史
router.delete('/scripts/history/:id', deleteScriptHistory);

// ==================== 会话管理 ====================

// GET /api/ai/sessions/search - 搜索会话（放在 :id 路由之前）
router.get('/sessions/search', searchSessions);

// GET /api/ai/sessions - 获取所有会话
router.get('/sessions', getSessions);

// POST /api/ai/sessions - 创建会话
router.post('/sessions', createSession);

// DELETE /api/ai/sessions - 删除所有会话
router.delete('/sessions', deleteAllSessions);

// GET /api/ai/sessions/:id - 获取单个会话
router.get('/sessions/:id', getSessionById);

// PUT /api/ai/sessions/:id - 更新会话
router.put('/sessions/:id', updateSession);

// DELETE /api/ai/sessions/:id - 删除会话
router.delete('/sessions/:id', deleteSession);

// PUT /api/ai/sessions/:id/rename - 重命名会话
router.put('/sessions/:id/rename', renameSession);

// POST /api/ai/sessions/:id/clear - 清除会话消息
router.post('/sessions/:id/clear', clearSessionMessages);

// GET /api/ai/sessions/:id/export - 导出会话为 Markdown
router.get('/sessions/:id/export', exportSession);

// POST /api/ai/sessions/:id/duplicate - 复制会话
router.post('/sessions/:id/duplicate', duplicateSession);

// ==================== 会话配置管理 ====================

// GET /api/ai/sessions/:id/config - 获取会话配置
router.get('/sessions/:id/config', getSessionConfig);

// PUT /api/ai/sessions/:id/config - 更新会话配置
router.put('/sessions/:id/config', updateSessionConfig);

// GET /api/ai/sessions/:id/context-stats - 获取上下文统计
router.get('/sessions/:id/context-stats', getContextStats);

// GET /api/ai/sessions/:id/context-messages - 获取上下文消息
router.get('/sessions/:id/context-messages', getContextMessages);

// ==================== 对话收藏管理 ====================

// GET /api/ai/sessions/with-collections - 获取所有有收藏消息的会话
router.get('/sessions/with-collections', getSessionsWithCollections);

// POST /api/ai/sessions/:sessionId/messages/:messageId/collect - 收藏消息
router.post('/sessions/:sessionId/messages/:messageId/collect', collectMessage);

// DELETE /api/ai/sessions/:sessionId/messages/:messageId/collect - 取消收藏消息
router.delete('/sessions/:sessionId/messages/:messageId/collect', uncollectMessage);

// GET /api/ai/sessions/:sessionId/collected - 获取会话中的收藏消息
router.get('/sessions/:sessionId/collected', getCollectedMessages);

// GET /api/ai/sessions/:sessionId/collected/export - 导出收藏消息为 Markdown
router.get('/sessions/:sessionId/collected/export', exportCollectedMessages);

// ==================== 对话转知识库 ====================

// POST /api/ai/conversations/convert - 转换收藏消息为知识条目
router.post('/conversations/convert', convertToKnowledge);

// POST /api/ai/conversations/batch-convert - 批量转换收藏消息为知识条目
router.post('/conversations/batch-convert', batchConvertToKnowledge);

// POST /api/ai/conversations/suggest-tags - 获取标签建议
router.post('/conversations/suggest-tags', suggestTags);

export default router;
