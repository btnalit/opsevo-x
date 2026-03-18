/**
 * AI Agent Client Integration Tests
 * 
 * 集成测试覆盖：
 * - API 配置管理流程 (Requirements: 1.1-1.7)
 * - 聊天流程 (Requirements: 2.1-2.8)
 * - 脚本执行流程 (Requirements: 4.1-4.7)
 */

import request from 'supertest';
import express, { Application } from 'express';
import fs from 'fs/promises';
import path from 'path';
import aiRoutes from '../../routes/aiRoutes';
import { AIProvider } from '../../types/ai';

// 创建测试用 Express 应用
function createTestApp(): Application {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRoutes);
  return app;
}

// 测试数据文件路径
const DATA_DIR = path.join(process.cwd(), 'data');
const AI_DATA_FILE = path.join(DATA_DIR, 'ai-agent.json');
const BACKUP_FILE = path.join(DATA_DIR, 'ai-agent.backup.json');

// 测试前备份数据，测试后恢复
async function backupData(): Promise<void> {
  try {
    await fs.access(AI_DATA_FILE);
    await fs.copyFile(AI_DATA_FILE, BACKUP_FILE);
  } catch {
    // 文件不存在，无需备份
  }
}

async function restoreData(): Promise<void> {
  try {
    await fs.access(BACKUP_FILE);
    await fs.copyFile(BACKUP_FILE, AI_DATA_FILE);
    await fs.unlink(BACKUP_FILE);
  } catch {
    // 备份文件不存在，删除测试数据
    try {
      await fs.unlink(AI_DATA_FILE);
    } catch {
      // 忽略
    }
  }
}

describe('AI Agent Client Integration Tests', () => {
  let app: Application;

  beforeAll(async () => {
    app = createTestApp();
    await backupData();
  });

  afterAll(async () => {
    await restoreData();
  });

  // ==================== API 配置管理集成测试 ====================
  describe('API Configuration Management (Requirements: 1.1-1.7)', () => {
    let createdConfigId: string;

    it('should get providers list', async () => {
      const res = await request(app)
        .get('/api/ai/providers')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
      
      // 验证包含所有支持的提供商
      const providerIds = res.body.data.map((p: any) => p.id);
      expect(providerIds).toContain(AIProvider.OPENAI);
      expect(providerIds).toContain(AIProvider.GEMINI);
      expect(providerIds).toContain(AIProvider.DEEPSEEK);
    });

    it('should create a new API configuration', async () => {
      const newConfig = {
        provider: AIProvider.OPENAI,
        name: 'Test OpenAI Config',
        apiKey: 'sk-test-key-12345678901234567890',
        model: 'gpt-4o',
        isDefault: true,
      };

      const res = await request(app)
        .post('/api/ai/configs')
        .send(newConfig)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.provider).toBe(AIProvider.OPENAI);
      expect(res.body.data.name).toBe('Test OpenAI Config');
      expect(res.body.data.model).toBe('gpt-4o');
      expect(res.body.data.isDefault).toBe(true);
      // API Key 应该被掩码
      expect(res.body.data.apiKeyMasked).toBeDefined();
      expect(res.body.data.apiKeyMasked).toMatch(/^\*+.{4}$/);

      createdConfigId = res.body.data.id;
    });

    it('should get all API configurations', async () => {
      const res = await request(app)
        .get('/api/ai/configs')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('should get a single API configuration by ID', async () => {
      const res = await request(app)
        .get(`/api/ai/configs/${createdConfigId}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdConfigId);
    });

    it('should get default API configuration', async () => {
      const res = await request(app)
        .get('/api/ai/configs/default')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBe(createdConfigId);
    });

    it('should update an API configuration', async () => {
      const updates = {
        name: 'Updated OpenAI Config',
        model: 'gpt-4-turbo',
      };

      const res = await request(app)
        .put(`/api/ai/configs/${createdConfigId}`)
        .send(updates)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Updated OpenAI Config');
      expect(res.body.data.model).toBe('gpt-4-turbo');
    });

    it('should create a second configuration and set it as default', async () => {
      const secondConfig = {
        provider: AIProvider.DEEPSEEK,
        name: 'Test DeepSeek Config',
        apiKey: 'sk-deepseek-test-key-1234567890',
        model: 'deepseek-chat',
        isDefault: false,
      };

      const createRes = await request(app)
        .post('/api/ai/configs')
        .send(secondConfig)
        .expect(201);

      const secondConfigId = createRes.body.data.id;

      // 设置为默认
      await request(app)
        .post(`/api/ai/configs/${secondConfigId}/default`)
        .expect(200);

      // 验证默认配置已更改
      const defaultRes = await request(app)
        .get('/api/ai/configs/default')
        .expect(200);

      expect(defaultRes.body.data.id).toBe(secondConfigId);
    });

    it('should return 400 for invalid provider type', async () => {
      const invalidConfig = {
        provider: 'invalid-provider',
        name: 'Invalid Config',
        apiKey: 'test-key',
        model: 'test-model',
      };

      const res = await request(app)
        .post('/api/ai/configs')
        .send(invalidConfig)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('不支持的提供商类型');
    });

    it('should return 400 for missing required fields', async () => {
      const incompleteConfig = {
        provider: AIProvider.OPENAI,
        name: 'Incomplete Config',
        // missing apiKey and model
      };

      const res = await request(app)
        .post('/api/ai/configs')
        .send(incompleteConfig)
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('缺少必填字段');
    });

    it('should return 404 for non-existent configuration', async () => {
      const res = await request(app)
        .get('/api/ai/configs/non-existent-id')
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('should delete an API configuration', async () => {
      // 先创建一个要删除的配置
      const configToDelete = {
        provider: AIProvider.QWEN,
        name: 'Config to Delete',
        apiKey: 'qwen-test-key-1234567890',
        model: 'qwen-turbo',
        isDefault: false,
      };

      const createRes = await request(app)
        .post('/api/ai/configs')
        .send(configToDelete)
        .expect(201);

      const deleteId = createRes.body.data.id;

      // 删除配置
      await request(app)
        .delete(`/api/ai/configs/${deleteId}`)
        .expect(200);

      // 验证已删除
      await request(app)
        .get(`/api/ai/configs/${deleteId}`)
        .expect(404);
    });
  });


  // ==================== 会话管理集成测试 ====================
  describe('Session Management (Requirements: 5.1-5.6)', () => {
    let createdSessionId: string;
    let configId: string;

    beforeAll(async () => {
      // 确保有一个配置可用
      const configRes = await request(app)
        .post('/api/ai/configs')
        .send({
          provider: AIProvider.OPENAI,
          name: 'Session Test Config',
          apiKey: 'sk-session-test-key-1234567890',
          model: 'gpt-4o',
          isDefault: true,
        });
      configId = configRes.body.data?.id;
    });

    it('should create a new session', async () => {
      const res = await request(app)
        .post('/api/ai/sessions')
        .send({
          provider: AIProvider.OPENAI,
          model: 'gpt-4o',
        })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.provider).toBe(AIProvider.OPENAI);
      expect(res.body.data.model).toBe('gpt-4o');
      expect(res.body.data.messages).toEqual([]);

      createdSessionId = res.body.data.id;
    });

    it('should get all sessions', async () => {
      const res = await request(app)
        .get('/api/ai/sessions')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('should get a single session by ID', async () => {
      const res = await request(app)
        .get(`/api/ai/sessions/${createdSessionId}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(createdSessionId);
    });

    it('should rename a session', async () => {
      const newTitle = 'Renamed Test Session';

      const res = await request(app)
        .put(`/api/ai/sessions/${createdSessionId}/rename`)
        .send({ title: newTitle })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe(newTitle);
    });

    it('should update a session', async () => {
      const res = await request(app)
        .put(`/api/ai/sessions/${createdSessionId}`)
        .send({ title: 'Updated Session Title' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Updated Session Title');
    });

    it('should duplicate a session', async () => {
      const res = await request(app)
        .post(`/api/ai/sessions/${createdSessionId}/duplicate`)
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data.id).not.toBe(createdSessionId);
      expect(res.body.data.title).toContain('(副本)');
    });

    it('should export session as markdown', async () => {
      const res = await request(app)
        .get(`/api/ai/sessions/${createdSessionId}/export`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.text).toContain('Updated Session Title');
    });

    it('should search sessions', async () => {
      const res = await request(app)
        .get('/api/ai/sessions/search')
        .query({ q: 'Updated' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
    });

    it('should return 400 for empty search query', async () => {
      const res = await request(app)
        .get('/api/ai/sessions/search')
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should return 400 for empty rename title', async () => {
      const res = await request(app)
        .put(`/api/ai/sessions/${createdSessionId}/rename`)
        .send({ title: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .get('/api/ai/sessions/non-existent-id')
        .expect(404);

      expect(res.body.success).toBe(false);
    });

    it('should clear session messages', async () => {
      const res = await request(app)
        .post(`/api/ai/sessions/${createdSessionId}/clear`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should delete a session', async () => {
      // 创建一个要删除的会话
      const createRes = await request(app)
        .post('/api/ai/sessions')
        .send({
          provider: AIProvider.OPENAI,
          model: 'gpt-4o',
        })
        .expect(201);

      const deleteId = createRes.body.data.id;

      // 删除会话
      await request(app)
        .delete(`/api/ai/sessions/${deleteId}`)
        .expect(200);

      // 验证已删除
      await request(app)
        .get(`/api/ai/sessions/${deleteId}`)
        .expect(404);
    });
  });

  // ==================== 脚本执行集成测试 ====================
  describe('Script Execution (Requirements: 4.1-4.7)', () => {
    let sessionId: string;

    beforeAll(async () => {
      // 创建一个会话用于脚本执行测试
      const res = await request(app)
        .post('/api/ai/sessions')
        .send({
          provider: AIProvider.OPENAI,
          model: 'gpt-4o',
        });
      sessionId = res.body.data?.id;
    });

    it('should validate a valid script', async () => {
      const script = `/ip/address/print
/interface/print`;

      const res = await request(app)
        .post('/api/ai/scripts/validate')
        .send({ script })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
    });

    it('should detect dangerous commands in script', async () => {
      const script = `/system/reboot`;

      const res = await request(app)
        .post('/api/ai/scripts/validate')
        .send({ script })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.hasDangerousCommands).toBe(true);
      expect(res.body.data.dangerousCommands).toContain('reboot');
    });

    it('should return error for empty script', async () => {
      const res = await request(app)
        .post('/api/ai/scripts/validate')
        .send({ script: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
    });

    it('should return error for missing script in execute', async () => {
      const res = await request(app)
        .post('/api/ai/scripts/execute')
        .send({ sessionId })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('脚本内容不能为空');
    });

    it('should return error for missing sessionId in execute', async () => {
      const res = await request(app)
        .post('/api/ai/scripts/execute')
        .send({ script: '/ip/address/print' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('会话 ID 不能为空');
    });

    it('should execute script in dry run mode', async () => {
      const script = `/ip/address/print`;

      const res = await request(app)
        .post('/api/ai/scripts/execute')
        .send({ script, sessionId, dryRun: true })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.result.success).toBe(true);
      expect(res.body.data.result.output).toContain('dry run');
      expect(res.body.data.historyId).toBeDefined();
    });

    it('should get script execution history', async () => {
      const res = await request(app)
        .get('/api/ai/scripts/history')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
    });

    it('should get script execution history filtered by session', async () => {
      const res = await request(app)
        .get('/api/ai/scripts/history')
        .query({ sessionId })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
      // 所有返回的历史记录应该属于该会话
      res.body.data.forEach((history: any) => {
        expect(history.sessionId).toBe(sessionId);
      });
    });

    it('should clear session script history', async () => {
      const res = await request(app)
        .delete(`/api/ai/scripts/history/session/${sessionId}`)
        .expect(200);

      expect(res.body.success).toBe(true);

      // 验证历史已清除
      const historyRes = await request(app)
        .get('/api/ai/scripts/history')
        .query({ sessionId })
        .expect(200);

      expect(historyRes.body.data.length).toBe(0);
    });
  });

  // ==================== 上下文集成测试 ====================
  describe('Context Management (Requirements: 3.1-3.5)', () => {
    it('should get available context sections', async () => {
      const res = await request(app)
        .get('/api/ai/context/sections')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeInstanceOf(Array);
    });

    it('should get connection context', async () => {
      const res = await request(app)
        .get('/api/ai/context')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.connectionStatus).toBeDefined();
    });
  });

  // ==================== 聊天流程集成测试 ====================
  describe('Chat Flow (Requirements: 2.1-2.8)', () => {
    let sessionId: string;
    let configId: string;

    beforeAll(async () => {
      // 创建配置
      const configRes = await request(app)
        .post('/api/ai/configs')
        .send({
          provider: AIProvider.OPENAI,
          name: 'Chat Test Config',
          apiKey: 'sk-chat-test-key-1234567890',
          model: 'gpt-4o',
          isDefault: true,
        });
      configId = configRes.body.data?.id;

      // 创建会话
      const sessionRes = await request(app)
        .post('/api/ai/sessions')
        .send({
          provider: AIProvider.OPENAI,
          model: 'gpt-4o',
        });
      sessionId = sessionRes.body.data?.id;
    });

    it('should return error for empty message', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .send({ message: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('消息内容不能为空');
    });

    it('should return error for empty message in stream', async () => {
      const res = await request(app)
        .post('/api/ai/chat/stream')
        .send({ message: '' })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('消息内容不能为空');
    });

    // 注意：实际的聊天测试需要有效的 API Key，这里只测试错误处理
    it('should handle chat request with invalid config', async () => {
      const res = await request(app)
        .post('/api/ai/chat')
        .send({
          configId: 'non-existent-config',
          message: 'Hello',
        })
        .expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('配置不存在');
    });
  });
});
