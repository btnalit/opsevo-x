/**
 * ChatSessionService - 聊天会话管理服务
 *
 * 管理聊天会话的持久化，支持两种存储后端：
 * - DataStore (PostgreSQL)：多租户多设备场景，按 user_id + device_id 隔离
 *   会话存储在 chat_sessions 表，消息存储在 chat_messages 表（规范化）
 *   provider/model/mode/collectedCount 存储在 config JSONB 字段中
 * - JSON 文件：向后兼容的单设备模式
 *
 * Requirements: 8.4 - 对话历史按 tenant_id 和 device_id 隔离存储
 * Requirements: J1.1, J1.2, J1.3 - 会话管理、上下文管理、会话配置
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  IChatSessionService,
  ChatSession,
  ChatSessionMode,
  ChatMessage,
  UpdateSessionInput,
  AIAgentData,
  AIAgentSettings,
  AIProvider,
  SessionConfig,
  ContextStats,
  DEFAULT_SESSION_CONFIG,
} from '../../types/ai';
import type { DataStore } from '../dataStore';
import { logger } from '../../utils/logger';

/**
 * 数据文件路径配置（JSON 文件后备模式）
 */
const DATA_DIR = path.join(process.cwd(), 'data');
const AI_DATA_FILE = path.join(DATA_DIR, 'ai-agent.json');

/**
 * 默认 AI Agent 设置
 */
const DEFAULT_SETTINGS: AIAgentSettings = {
  rateLimitPerMinute: 60,
  maxContextTokens: 4096,
};

/**
 * 默认 AI Agent 数据结构
 */
const DEFAULT_AI_DATA: AIAgentData = {
  apiConfigs: [],
  sessions: [],
  scriptHistory: [],
  settings: DEFAULT_SETTINGS,
};

/**
 * 默认会话标题
 */
const DEFAULT_SESSION_TITLE = '新会话';

/**
 * 最大会话数量限制
 */
const MAX_SESSIONS = 100;

// ==================== PostgreSQL 行类型 ====================

/**
 * PostgreSQL chat_sessions 行类型
 * 对应 PG migration 001_core_tables 中的 chat_sessions 表
 * provider/model/mode/collectedCount 存储在 config JSONB 中
 */
interface PgChatSessionRow {
  id: string;
  title: string | null;
  user_id: string | null;
  device_id: string | null;
  config: Record<string, unknown> | null;  // JSONB, pg driver 自动解析
  message_count: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * PostgreSQL chat_messages 行类型
 * 对应 PG migration 001_core_tables 中的 chat_messages 表
 */
interface PgChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;  // JSONB
  is_favorited: boolean;
  created_at: string;
}

/**
 * 将 PostgreSQL chat_sessions 行 + 消息列表转换为 ChatSession 对象
 */
function pgRowToSession(row: PgChatSessionRow, messages: ChatMessage[] = []): ChatSession {
  // config JSONB 由 pg driver 自动解析为对象
  const cfg = (row.config && typeof row.config === 'object') ? row.config : {};

  // 从 config 中提取 provider/model/mode/collectedCount
  const provider = (cfg.provider as string) || 'openai';
  const model = (cfg.model as string) || '';
  const mode = (cfg.mode as string) || 'standard';
  const collectedCount = (typeof cfg.collectedCount === 'number') ? cfg.collectedCount : 0;

  // 提取 SessionConfig 字段（排除 provider/model/mode/collectedCount）
  const { provider: _p, model: _m, mode: _mo, collectedCount: _cc, ...sessionConfigFields } = cfg;
  const sessionConfig: SessionConfig | undefined =
    Object.keys(sessionConfigFields).length > 0
      ? { ...DEFAULT_SESSION_CONFIG, ...sessionConfigFields } as SessionConfig
      : undefined;

  return {
    id: row.id,
    title: row.title || DEFAULT_SESSION_TITLE,
    provider: provider as AIProvider,
    model,
    mode: mode as ChatSessionMode,
    messages,
    collectedCount,
    config: sessionConfig,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * 将 PostgreSQL chat_messages 行转换为 ChatMessage 对象
 */
function pgMessageRowToMessage(row: PgChatMessageRow): ChatMessage {
  const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};

  const msg: ChatMessage = {
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    timestamp: new Date(row.created_at),
  };

  // 从 metadata JSONB 恢复扩展字段
  if (meta.citations) msg.citations = meta.citations as ChatMessage['citations'];
  if (meta.toolCalls) msg.toolCalls = meta.toolCalls as ChatMessage['toolCalls'];
  if (meta.reasoning) msg.reasoning = meta.reasoning as ChatMessage['reasoning'];
  if (typeof meta.confidence === 'number') msg.confidence = meta.confidence;
  if (typeof meta.collected === 'boolean') msg.collected = meta.collected;
  if (meta.collectedAt) msg.collectedAt = new Date(meta.collectedAt as string);
  if (meta.metadata) msg.metadata = meta.metadata as Record<string, unknown>;

  return msg;
}

/**
 * 从 ChatMessage 构建 metadata JSONB 对象（存入 chat_messages.metadata）
 */
function buildMessageMetadata(message: ChatMessage): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (message.citations) meta.citations = message.citations;
  if (message.toolCalls) meta.toolCalls = message.toolCalls;
  if (message.reasoning) meta.reasoning = message.reasoning;
  if (message.confidence !== undefined) meta.confidence = message.confidence;
  if (message.collected !== undefined) meta.collected = message.collected;
  if (message.collectedAt) meta.collectedAt = message.collectedAt.toISOString();
  if (message.metadata) meta.metadata = message.metadata;
  return meta;
}


/**
 * ChatSessionService 实现类
 *
 * 支持 DataStore (PostgreSQL) 和 JSON 文件两种存储后端。
 * 当 DataStore 可用时，使用 PostgreSQL 存储并支持 tenant/device 隔离。
 * 当 DataStore 不可用时，回退到 JSON 文件存储（向后兼容）。
 *
 * PostgreSQL 表结构：
 * - chat_sessions: 会话元数据，config JSONB 存储 provider/model/mode/collectedCount + SessionConfig
 * - chat_messages: 消息数据（规范化），metadata JSONB 存储扩展字段
 *
 * Requirements: 8.4 - 对话历史按 tenant_id 和 device_id 隔离存储
 * Requirements: J1.1, J1.2, J1.3
 */
export class ChatSessionService implements IChatSessionService {
  private dataStore: DataStore | null = null;

  /**
   * 初始化 DataStore 后端
   * 调用后，所有操作将使用 PostgreSQL 存储
   */
  initializeDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('ChatSessionService: DataStore backend initialized (PostgreSQL)');
  }

  /**
   * 检查是否使用 DataStore 后端
   */
  isUsingDataStore(): boolean {
    return this.dataStore !== null;
  }

  // ==================== JSON 文件后备方法 ====================

  private async ensureDataDir(): Promise<void> {
    try {
      await fs.access(DATA_DIR);
    } catch {
      await fs.mkdir(DATA_DIR, { recursive: true });
      logger.info(`Created AI data directory: ${DATA_DIR}`);
    }
  }

  private async loadData(): Promise<AIAgentData> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(AI_DATA_FILE, 'utf-8');
      const parsed = JSON.parse(data) as AIAgentData;
      if (!parsed.sessions) {
        parsed.sessions = [];
      }
      parsed.sessions = parsed.sessions.map(session => ({
        ...session,
        createdAt: new Date(session.createdAt),
        updatedAt: new Date(session.updatedAt),
      }));
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No AI agent data file found, using defaults');
        return { ...DEFAULT_AI_DATA };
      }
      logger.error('Failed to load AI agent data:', error);
      throw new Error('加载 AI 配置数据失败');
    }
  }

  private async saveData(data: AIAgentData): Promise<void> {
    try {
      await this.ensureDataDir();
      const jsonData = JSON.stringify(data, null, 2);
      await fs.writeFile(AI_DATA_FILE, jsonData, 'utf-8');
      logger.info('Saved AI agent data to file');
    } catch (error) {
      logger.error('Failed to save AI agent data:', error);
      throw new Error('保存 AI 配置数据失败');
    }
  }


  // ==================== 辅助方法 ====================

  private generateTitle(messages: ChatMessage[]): string {
    const firstUserMessage = messages.find(m => m.role === 'user');
    if (!firstUserMessage) {
      return DEFAULT_SESSION_TITLE;
    }
    const content = firstUserMessage.content.trim();
    if (content.length <= 30) {
      return content;
    }
    return content.substring(0, 30) + '...';
  }

  private getRoleLabel(role: ChatMessage['role']): string {
    switch (role) {
      case 'user':
        return '👤 用户';
      case 'assistant':
        return '🤖 助手';
      case 'system':
        return '⚙️ 系统';
      default:
        return role;
    }
  }

  private estimateTokens(text: string): number {
    let tokens = 0;
    const chinesePattern = /[\u4e00-\u9fa5]/g;
    const chineseChars = text.match(chinesePattern) || [];
    tokens += chineseChars.length;
    const withoutChinese = text.replace(chinesePattern, ' ');
    const words = withoutChinese.split(/\s+/).filter((w) => w.length > 0);
    tokens += words.length;
    return tokens;
  }

  private estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => {
      return total + this.estimateTokens(msg.content);
    }, 0);
  }

  /**
   * 构建 config JSONB 对象（合并 provider/model/mode/collectedCount + SessionConfig）
   */
  private buildConfigJsonb(
    provider: string,
    model: string,
    mode: string,
    collectedCount: number,
    sessionConfig?: Partial<SessionConfig>,
  ): Record<string, unknown> {
    return {
      provider,
      model,
      mode,
      collectedCount,
      ...(sessionConfig || {}),
    };
  }

  /**
   * 从 PG 加载会话的所有消息
   */
  private async loadPgMessages(sessionId: string): Promise<ChatMessage[]> {
    if (!this.dataStore) return [];
    const rows = await this.dataStore.query<PgChatMessageRow>(
      `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
    return rows.map(pgMessageRowToMessage);
  }


  // ==================== CRUD 方法 ====================

  /**
   * 创建新的聊天会话
   *
   * @param provider AI 提供商
   * @param model 模型名称
   * @param mode 会话模式
   * @param tenantId 租户 ID（DataStore 模式下映射为 user_id）
   * @param deviceId 设备 ID（DataStore 模式下使用）
   */
  async create(
    provider: AIProvider,
    model: string,
    mode?: ChatSessionMode,
    tenantId?: string,
    deviceId?: string,
  ): Promise<ChatSession> {
    const now = new Date();
    const id = uuidv4();
    const sessionMode = mode || 'standard';

    if (this.dataStore) {
      const effectiveUserId = tenantId || null;
      const effectiveDeviceId = deviceId || null;
      const configJsonb = this.buildConfigJsonb(provider, model, sessionMode, 0);

      await this.dataStore.execute(
        `INSERT INTO chat_sessions (id, title, user_id, device_id, config, message_count, is_archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, DEFAULT_SESSION_TITLE, effectiveUserId, effectiveDeviceId, JSON.stringify(configJsonb), 0, false, now.toISOString(), now.toISOString()],
      );

      // 限制每个 user+device 的会话数量
      const countRows = await this.dataStore.query<{ cnt: string }>(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE ($1::uuid IS NULL AND user_id IS NULL OR user_id = $1::uuid)
           AND ($2::uuid IS NULL AND device_id IS NULL OR device_id = $2::uuid)`,
        [effectiveUserId, effectiveDeviceId],
      );
      const cnt = parseInt(countRows[0]?.cnt || '0', 10);
      if (cnt > MAX_SESSIONS) {
        await this.dataStore.execute(
          `DELETE FROM chat_sessions WHERE id IN (
            SELECT id FROM chat_sessions
            WHERE ($1::uuid IS NULL AND user_id IS NULL OR user_id = $1::uuid)
              AND ($2::uuid IS NULL AND device_id IS NULL OR device_id = $2::uuid)
            ORDER BY updated_at ASC
            LIMIT $3
          )`,
          [effectiveUserId, effectiveDeviceId, cnt - MAX_SESSIONS],
        );
      }

      logger.info(`Created chat session: ${id} (user: ${effectiveUserId || 'none'}, device: ${effectiveDeviceId || 'none'})`);
      return {
        id,
        title: DEFAULT_SESSION_TITLE,
        provider,
        model,
        mode: sessionMode,
        messages: [],
        collectedCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const newSession: ChatSession = {
      id,
      title: DEFAULT_SESSION_TITLE,
      provider,
      model,
      mode: sessionMode,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    data.sessions.push(newSession);
    if (data.sessions.length > MAX_SESSIONS) {
      data.sessions.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      data.sessions = data.sessions.slice(0, MAX_SESSIONS);
    }
    await this.saveData(data);
    logger.info(`Created chat session: ${id}`);
    return newSession;
  }


  /**
   * 更新会话信息
   */
  async update(id: string, updates: UpdateSessionInput): Promise<ChatSession> {
    if (this.dataStore) {
      const now = new Date();

      // 先获取当前会话以合并 config
      const existing = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [id],
      );
      if (!existing) {
        throw new Error(`会话不存在: ${id}`);
      }

      const currentConfig = (existing.config && typeof existing.config === 'object') ? { ...existing.config } : {};

      // 更新 config 中的 provider/model/mode
      if (updates.provider !== undefined) currentConfig.provider = updates.provider;
      if (updates.model !== undefined) currentConfig.model = updates.model;
      if (updates.mode !== undefined) currentConfig.mode = updates.mode;

      const setClauses: string[] = ['updated_at = $1', 'config = $2'];
      const params: unknown[] = [now.toISOString(), JSON.stringify(currentConfig)];
      let paramIdx = 3;

      if (updates.title !== undefined) {
        setClauses.push(`title = $${paramIdx}`);
        params.push(updates.title);
        paramIdx++;
      }

      params.push(id);
      const { rowCount } = await this.dataStore.execute(
        `UPDATE chat_sessions SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
        params,
      );

      if (rowCount === 0) {
        throw new Error(`会话不存在: ${id}`);
      }

      const session = await this.getById(id);
      if (!session) {
        throw new Error(`会话不存在: ${id}`);
      }
      logger.info(`Updated chat session: ${id}`);
      return session;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const index = data.sessions.findIndex(session => session.id === id);
    if (index === -1) {
      throw new Error(`会话不存在: ${id}`);
    }
    const now = new Date();
    const updatedSession: ChatSession = {
      ...data.sessions[index],
      ...updates,
      updatedAt: now,
    };
    data.sessions[index] = updatedSession;
    await this.saveData(data);
    logger.info(`Updated chat session: ${id}`);
    return updatedSession;
  }

  /**
   * 删除会话（CASCADE 自动删除关联的 chat_messages）
   */
  async delete(id: string): Promise<void> {
    if (this.dataStore) {
      const { rowCount } = await this.dataStore.execute(
        `DELETE FROM chat_sessions WHERE id = $1`,
        [id],
      );
      if (rowCount === 0) {
        throw new Error(`会话不存在: ${id}`);
      }
      logger.info(`Deleted chat session: ${id}`);
      return;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const index = data.sessions.findIndex(session => session.id === id);
    if (index === -1) {
      throw new Error(`会话不存在: ${id}`);
    }
    data.sessions.splice(index, 1);
    await this.saveData(data);
    logger.info(`Deleted chat session: ${id}`);
  }


  /**
   * 根据 ID 获取会话（包含所有消息）
   */
  async getById(id: string): Promise<ChatSession | null> {
    if (this.dataStore) {
      const row = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [id],
      );
      if (!row) return null;

      const messages = await this.loadPgMessages(id);
      return pgRowToSession(row, messages);
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    return data.sessions.find(session => session.id === id) || null;
  }

  /**
   * 获取所有会话（支持按 tenant/device 过滤）
   * 注意：为性能考虑，getAll 不加载消息，messages 为空数组
   *
   * @param tenantId 租户 ID（DataStore 模式下映射为 user_id）
   * @param deviceId 设备 ID（DataStore 模式下过滤）
   */
  async getAll(tenantId?: string, deviceId?: string): Promise<ChatSession[]> {
    if (this.dataStore) {
      let sql = 'SELECT * FROM chat_sessions';
      const params: unknown[] = [];
      const conditions: string[] = [];
      let paramIdx = 1;

      if (tenantId) {
        conditions.push(`user_id = $${paramIdx}`);
        params.push(tenantId);
        paramIdx++;
      }
      if (deviceId) {
        conditions.push(`device_id = $${paramIdx}`);
        params.push(deviceId);
        paramIdx++;
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY updated_at DESC';

      const rows = await this.dataStore.query<PgChatSessionRow>(sql, params);
      // 加载每个会话的消息以保持与旧版行为一致
      const sessions: ChatSession[] = [];
      for (const row of rows) {
        const messages = await this.loadPgMessages(row.id);
        sessions.push(pgRowToSession(row, messages));
      }
      return sessions;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    return data.sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }


  // ==================== 消息管理方法 ====================

  /**
   * 向会话添加消息
   */
  async addMessage(sessionId: string, message: ChatMessage): Promise<void> {
    if (!message.id) {
      message.id = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
    }

    if (this.dataStore) {
      // 验证会话存在
      const session = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [sessionId],
      );
      if (!session) {
        throw new Error(`会话不存在: ${sessionId}`);
      }

      const now = new Date();
      const metadata = buildMessageMetadata(message);

      // 插入消息到 chat_messages 表
      await this.dataStore.execute(
        `INSERT INTO chat_messages (id, session_id, role, content, metadata, is_favorited, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          message.id,
          sessionId,
          message.role,
          message.content,
          JSON.stringify(metadata),
          message.collected || false,
          (message.timestamp || now).toISOString(),
        ],
      );

      // 更新会话的 message_count、title、updated_at
      let title = session.title;
      if (title === DEFAULT_SESSION_TITLE || !title) {
        // 加载所有消息来生成标题
        const allMessages = await this.loadPgMessages(sessionId);
        title = this.generateTitle(allMessages);
      }

      await this.dataStore.execute(
        `UPDATE chat_sessions SET message_count = message_count + 1, title = $1, updated_at = $2 WHERE id = $3`,
        [title, now.toISOString(), sessionId],
      );

      logger.info(`Added message to session: ${sessionId}, role: ${message.role}, id: ${message.id}`);
      return;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const index = data.sessions.findIndex(session => session.id === sessionId);
    if (index === -1) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    const now = new Date();
    data.sessions[index].messages.push(message);
    data.sessions[index].updatedAt = now;
    if (data.sessions[index].title === DEFAULT_SESSION_TITLE) {
      data.sessions[index].title = this.generateTitle(data.sessions[index].messages);
    }
    await this.saveData(data);
    logger.info(`Added message to session: ${sessionId}, role: ${message.role}, id: ${message.id}`);
  }


  /**
   * 批量添加消息
   */
  async addMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      if (!message.id) {
        message.id = `msg_${Date.now()}_${uuidv4().substring(0, 8)}`;
      }
    }

    if (this.dataStore) {
      // 验证会话存在
      const session = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [sessionId],
      );
      if (!session) {
        throw new Error(`会话不存在: ${sessionId}`);
      }

      const now = new Date();

      // 在事务中批量插入消息
      await this.dataStore.transaction(async (tx) => {
        for (const message of messages) {
          const metadata = buildMessageMetadata(message);
          await tx.execute(
            `INSERT INTO chat_messages (id, session_id, role, content, metadata, is_favorited, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              message.id!,
              sessionId,
              message.role,
              message.content,
              JSON.stringify(metadata),
              message.collected || false,
              (message.timestamp || now).toISOString(),
            ],
          );
        }

        // 更新会话的 message_count、title、updated_at
        let title = session.title;
        if (title === DEFAULT_SESSION_TITLE || !title) {
          const allMessages = await tx.query<PgChatMessageRow>(
            `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
            [sessionId],
          );
          title = this.generateTitle(allMessages.map(pgMessageRowToMessage));
        }

        await tx.execute(
          `UPDATE chat_sessions SET message_count = message_count + $1, title = $2, updated_at = $3 WHERE id = $4`,
          [messages.length, title, now.toISOString(), sessionId],
        );
      });

      logger.info(`Added ${messages.length} messages to session: ${sessionId}`);
      return;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const index = data.sessions.findIndex(session => session.id === sessionId);
    if (index === -1) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    const now = new Date();
    data.sessions[index].messages.push(...messages);
    data.sessions[index].updatedAt = now;
    if (data.sessions[index].title === DEFAULT_SESSION_TITLE) {
      data.sessions[index].title = this.generateTitle(data.sessions[index].messages);
    }
    await this.saveData(data);
    logger.info(`Added ${messages.length} messages to session: ${sessionId}`);
  }

  /**
   * 获取会话的所有消息
   */
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    if (this.dataStore) {
      // 验证会话存在
      const exists = await this.dataStore.queryOne<{ id: string }>(
        `SELECT id FROM chat_sessions WHERE id = $1`,
        [sessionId],
      );
      if (!exists) {
        throw new Error(`会话不存在: ${sessionId}`);
      }
      return this.loadPgMessages(sessionId);
    }

    // JSON 文件后备模式
    const session = await this.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    return session.messages;
  }

  /**
   * 清除会话的所有消息
   */
  async clearMessages(sessionId: string): Promise<void> {
    if (this.dataStore) {
      const now = new Date();

      // 验证会话存在并清除消息
      await this.dataStore.transaction(async (tx) => {
        const session = await tx.queryOne<PgChatSessionRow>(
          `SELECT id FROM chat_sessions WHERE id = $1`,
          [sessionId],
        );
        if (!session) {
          throw new Error(`会话不存在: ${sessionId}`);
        }

        // 删除所有消息
        await tx.execute(
          `DELETE FROM chat_messages WHERE session_id = $1`,
          [sessionId],
        );

        // 重置会话标题和消息计数
        await tx.execute(
          `UPDATE chat_sessions SET message_count = 0, title = $1, updated_at = $2 WHERE id = $3`,
          [DEFAULT_SESSION_TITLE, now.toISOString(), sessionId],
        );
      });

      logger.info(`Cleared messages for session: ${sessionId}`);
      return;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const index = data.sessions.findIndex(session => session.id === sessionId);
    if (index === -1) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    const now = new Date();
    data.sessions[index].messages = [];
    data.sessions[index].title = DEFAULT_SESSION_TITLE;
    data.sessions[index].updatedAt = now;
    await this.saveData(data);
    logger.info(`Cleared messages for session: ${sessionId}`);
  }


  // ==================== 导出/搜索/工具方法 ====================

  /**
   * 导出会话为 Markdown 格式
   */
  async exportAsMarkdown(id: string): Promise<string> {
    const session = await this.getById(id);
    if (!session) {
      throw new Error(`会话不存在: ${id}`);
    }

    const lines: string[] = [];
    lines.push(`# ${session.title}`);
    lines.push('');
    lines.push(`**提供商**: ${session.provider}`);
    lines.push(`**模型**: ${session.model}`);
    lines.push(`**模式**: ${session.mode === 'knowledge-enhanced' ? '知识增强' : '标准'}`);
    lines.push(`**创建时间**: ${session.createdAt.toLocaleString()}`);
    lines.push(`**更新时间**: ${session.updatedAt.toLocaleString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const message of session.messages) {
      const roleLabel = this.getRoleLabel(message.role);
      lines.push(`## ${roleLabel}`);
      lines.push('');
      lines.push(message.content);
      lines.push('');

      if (message.citations && message.citations.length > 0) {
        lines.push('### 📚 知识引用');
        lines.push('');
        for (const citation of message.citations) {
          lines.push(`- **${citation.title}** (相关度: ${(citation.score * 100).toFixed(1)}%)`);
          lines.push(`  - 类型: ${citation.type}`);
          lines.push(`  - 内容摘要: ${citation.content.substring(0, 200)}${citation.content.length > 200 ? '...' : ''}`);
          lines.push('');
        }
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        lines.push('### 🔧 工具调用');
        lines.push('');
        for (const call of message.toolCalls) {
          lines.push(`- **${call.tool}** (耗时: ${call.duration}ms)`);
          lines.push(`  - 输入: \`${JSON.stringify(call.input)}\``);
          lines.push('');
        }
      }

      if (message.confidence !== undefined) {
        lines.push(`> 置信度: ${(message.confidence * 100).toFixed(0)}%`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * 重命名会话
   */
  async rename(id: string, title: string): Promise<ChatSession> {
    return this.update(id, { title });
  }

  /**
   * 复制会话
   */
  async duplicate(id: string): Promise<ChatSession> {
    const original = await this.getById(id);
    if (!original) {
      throw new Error(`会话不存在: ${id}`);
    }

    if (this.dataStore) {
      const now = new Date();
      const newId = uuidv4();

      // 获取原始行以保留 user_id 和 device_id
      const originalRow = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [id],
      );

      if (!originalRow) {
        throw new Error(`会话不存在: ${id}`);
      }

      // 在事务中复制会话和消息
      await this.dataStore.transaction(async (tx) => {
        // 复制会话，重置 collectedCount
        const currentConfig = (originalRow.config && typeof originalRow.config === 'object')
          ? { ...originalRow.config }
          : {};
        currentConfig.collectedCount = 0;

        await tx.execute(
          `INSERT INTO chat_sessions (id, title, user_id, device_id, config, message_count, is_archived, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            newId,
            `${original.title} (副本)`,
            originalRow.user_id,
            originalRow.device_id,
            JSON.stringify(currentConfig),
            originalRow.message_count,
            false,
            now.toISOString(),
            now.toISOString(),
          ],
        );

        // 复制所有消息
        const originalMessages = await tx.query<PgChatMessageRow>(
          `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
          [id],
        );

        for (const msg of originalMessages) {
          const newMsgId = uuidv4();
          await tx.execute(
            `INSERT INTO chat_messages (id, session_id, role, content, metadata, is_favorited, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [newMsgId, newId, msg.role, msg.content, JSON.stringify(msg.metadata || {}), msg.is_favorited, msg.created_at],
          );
        }
      });

      logger.info(`Duplicated session ${id} to ${newId}`);
      return {
        ...original,
        id: newId,
        title: `${original.title} (副本)`,
        collectedCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const now = new Date();
    const newSession: ChatSession = {
      id: uuidv4(),
      title: `${original.title} (副本)`,
      provider: original.provider,
      model: original.model,
      mode: original.mode,
      messages: [...original.messages],
      createdAt: now,
      updatedAt: now,
    };
    data.sessions.push(newSession);
    await this.saveData(data);
    logger.info(`Duplicated session ${id} to ${newSession.id}`);
    return newSession;
  }


  /**
   * 获取会话数量
   */
  async count(tenantId?: string, deviceId?: string): Promise<number> {
    if (this.dataStore) {
      let sql = 'SELECT COUNT(*) as cnt FROM chat_sessions';
      const params: unknown[] = [];
      const conditions: string[] = [];
      let paramIdx = 1;

      if (tenantId) {
        conditions.push(`user_id = $${paramIdx}`);
        params.push(tenantId);
        paramIdx++;
      }
      if (deviceId) {
        conditions.push(`device_id = $${paramIdx}`);
        params.push(deviceId);
        paramIdx++;
      }
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      const row = await this.dataStore.queryOne<{ cnt: string }>(sql, params);
      return parseInt(row?.cnt || '0', 10);
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    return data.sessions.length;
  }

  /**
   * 搜索会话（按标题和消息内容）
   */
  async search(query: string, tenantId?: string, deviceId?: string): Promise<ChatSession[]> {
    if (this.dataStore) {
      let paramIdx = 1;
      const params: unknown[] = [];

      // 搜索标题匹配或消息内容匹配的会话
      let sql = `SELECT DISTINCT cs.* FROM chat_sessions cs
        LEFT JOIN chat_messages cm ON cm.session_id = cs.id
        WHERE (cs.title ILIKE $${paramIdx} OR cm.content ILIKE $${paramIdx})`;
      params.push(`%${query}%`);
      paramIdx++;

      if (tenantId) {
        sql += ` AND cs.user_id = $${paramIdx}`;
        params.push(tenantId);
        paramIdx++;
      }
      if (deviceId) {
        sql += ` AND cs.device_id = $${paramIdx}`;
        params.push(deviceId);
        paramIdx++;
      }
      sql += ' ORDER BY cs.updated_at DESC';

      const rows = await this.dataStore.query<PgChatSessionRow>(sql, params);
      // 加载每个会话的消息以保持与旧行为一致
      const sessions: ChatSession[] = [];
      for (const row of rows) {
        const messages = await this.loadPgMessages(row.id);
        sessions.push(pgRowToSession(row, messages));
      }
      return sessions;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const lowerQuery = query.toLowerCase();
    return data.sessions.filter(session => {
      if (session.title.toLowerCase().includes(lowerQuery)) return true;
      return session.messages.some(msg =>
        msg.content.toLowerCase().includes(lowerQuery)
      );
    }).sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * 删除所有会话（CASCADE 自动删除关联消息）
   */
  async deleteAll(tenantId?: string, deviceId?: string): Promise<void> {
    if (this.dataStore) {
      let sql = 'DELETE FROM chat_sessions';
      const params: unknown[] = [];
      const conditions: string[] = [];
      let paramIdx = 1;

      if (tenantId) {
        conditions.push(`user_id = $${paramIdx}`);
        params.push(tenantId);
        paramIdx++;
      }
      if (deviceId) {
        conditions.push(`device_id = $${paramIdx}`);
        params.push(deviceId);
        paramIdx++;
      }
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      const { rowCount } = await this.dataStore.execute(sql, params);
      logger.info(`Deleted all ${rowCount} chat sessions`);
      return;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const count = data.sessions.length;
    data.sessions = [];
    await this.saveData(data);
    logger.info(`Deleted all ${count} chat sessions`);
  }


  // ==================== 会话配置方法 ====================

  /**
   * 获取会话配置
   */
  async getSessionConfig(sessionId: string): Promise<SessionConfig> {
    if (this.dataStore) {
      const row = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [sessionId],
      );
      if (!row) {
        throw new Error(`会话不存在: ${sessionId}`);
      }

      const cfg = (row.config && typeof row.config === 'object') ? row.config : {};
      // 排除 provider/model/mode/collectedCount，提取 SessionConfig 字段
      const { provider: _p, model: _m, mode: _mo, collectedCount: _cc, ...sessionConfigFields } = cfg;

      return {
        ...DEFAULT_SESSION_CONFIG,
        ...sessionConfigFields,
      } as SessionConfig;
    }

    // JSON 文件后备模式
    const session = await this.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    return {
      ...DEFAULT_SESSION_CONFIG,
      ...session.config,
    };
  }

  /**
   * 更新会话配置
   */
  async updateSessionConfig(
    sessionId: string,
    config: Partial<SessionConfig>,
  ): Promise<SessionConfig> {
    if (this.dataStore) {
      const row = await this.dataStore.queryOne<PgChatSessionRow>(
        `SELECT * FROM chat_sessions WHERE id = $1`,
        [sessionId],
      );
      if (!row) {
        throw new Error(`会话不存在: ${sessionId}`);
      }

      // 合并现有 config（保留 provider/model/mode/collectedCount）
      const currentConfig = (row.config && typeof row.config === 'object') ? { ...row.config } : {};

      // 提取当前 SessionConfig 字段
      const { provider, model, mode, collectedCount, ...currentSessionConfig } = currentConfig;

      const newSessionConfig: SessionConfig = {
        ...DEFAULT_SESSION_CONFIG,
        ...currentSessionConfig,
        ...config,
      } as SessionConfig;

      // 重新合并回完整 config JSONB
      const fullConfig = {
        provider,
        model,
        mode,
        collectedCount,
        ...newSessionConfig,
      };

      const now = new Date();
      await this.dataStore.execute(
        `UPDATE chat_sessions SET config = $1, updated_at = $2 WHERE id = $3`,
        [JSON.stringify(fullConfig), now.toISOString(), sessionId],
      );
      logger.info(`Updated session config: ${sessionId}`);
      return newSessionConfig;
    }

    // JSON 文件后备模式
    const data = await this.loadData();
    const index = data.sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    const now = new Date();
    const currentConfig = data.sessions[index].config || {};
    const newConfig: SessionConfig = {
      ...DEFAULT_SESSION_CONFIG,
      ...currentConfig,
      ...config,
    };
    data.sessions[index].config = newConfig;
    data.sessions[index].updatedAt = now;
    await this.saveData(data);
    logger.info(`Updated session config: ${sessionId}`);
    return newConfig;
  }


  // ==================== 上下文管理方法 ====================

  /**
   * 获取上下文消息（应用历史轮数和 Token 限制）
   */
  async getContextMessages(sessionId: string): Promise<ChatMessage[]> {
    const session = await this.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    const config = await this.getSessionConfig(sessionId);
    const messages = session.messages;

    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    if (!config.multiTurnEnabled) {
      const lastUserMessage = [...nonSystemMessages]
        .reverse()
        .find((m) => m.role === 'user');
      return lastUserMessage
        ? [...systemMessages, lastUserMessage]
        : systemMessages;
    }

    const maxMessages = config.maxHistoryTurns * 2;
    let limitedMessages = nonSystemMessages.slice(-maxMessages);

    if (config.compressionStrategy === 'sliding_window') {
      limitedMessages = this.applySlidingWindow(
        limitedMessages,
        config.maxContextTokens,
        systemMessages,
      );
    }

    return [...systemMessages, ...limitedMessages];
  }

  /**
   * 应用滑动窗口压缩策略
   */
  private applySlidingWindow(
    messages: ChatMessage[],
    maxTokens: number,
    systemMessages: ChatMessage[],
  ): ChatMessage[] {
    const systemTokens = this.estimateMessagesTokens(systemMessages);
    const availableTokens = maxTokens - systemTokens;

    if (availableTokens <= 0) {
      return [];
    }

    const result: ChatMessage[] = [];
    let currentTokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens(messages[i].content);
      if (currentTokens + msgTokens <= availableTokens) {
        result.unshift(messages[i]);
        currentTokens += msgTokens;
      } else {
        break;
      }
    }

    return result;
  }

  /**
   * 获取上下文统计信息
   */
  async getContextStats(sessionId: string): Promise<ContextStats> {
    const session = await this.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    const contextMessages = await this.getContextMessages(sessionId);
    const originalMessageCount = session.messages.length;
    const messageCount = contextMessages.length;
    const estimatedTokens = this.estimateMessagesTokens(contextMessages);
    const isCompressed = messageCount < originalMessageCount;

    return {
      messageCount,
      estimatedTokens,
      isCompressed,
      originalMessageCount,
    };
  }
}

/**
 * 默认 ChatSessionService 单例实例
 */
export const chatSessionService = new ChatSessionService();

export default chatSessionService;
