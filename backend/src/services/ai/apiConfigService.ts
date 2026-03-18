/**
 * APIConfigService - API 配置管理服务
 *
 * 管理 AI 提供商的 API 配置，包括：
 * - CRUD 操作（创建、读取、更新、删除）
 * - 默认提供商管理
 * - API Key 加密存储和掩码显示
 * - 双路径存储：PostgreSQL（优先）/ JSON 文件（回退）
 *
 * Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, J6.15, J6.16, J6.17
 */

import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  APIConfig,
  CreateAPIConfigInput,
  UpdateAPIConfigInput,
  APIConfigDisplay,
  IAPIConfigService,
  AIAgentData,
  AIAgentSettings,
  AIProvider,
} from '../../types/ai';
import { CryptoService, cryptoService } from './cryptoService';
import { logger } from '../../utils/logger';
import type { DataStore } from '../dataStore';

/**
 * 数据文件路径配置
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
 * PostgreSQL api_configs 行类型
 */
interface PgApiConfigRow {
  id: string;
  provider: string;
  name: string;
  config: Record<string, unknown>;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * APIConfigService 实现类
 *
 * 提供 API 配置的完整 CRUD 功能和默认提供商管理。
 * 支持 PostgreSQL（通过 DataStore）和 JSON 文件双路径存储。
 */
export class APIConfigService extends EventEmitter implements IAPIConfigService {
  private readonly crypto: CryptoService;
  private dataStore: DataStore | null = null;

  /**
   * 创建 APIConfigService 实例
   * @param cryptoServiceInstance 加密服务实例（可选，默认使用全局单例）
   */
  constructor(cryptoServiceInstance?: CryptoService) {
    super();
    this.crypto = cryptoServiceInstance || cryptoService;
  }

  /**
   * 注入 PgDataStore，启用 PostgreSQL 存储路径
   */
  setDataStore(ds: DataStore): void {
    this.dataStore = ds;
    logger.info('[APIConfigService] DataStore injected, using PostgreSQL storage');
  }

  /**
   * 是否使用 PostgreSQL 存储
   */
  private get usePg(): boolean {
    return this.dataStore !== null;
  }

  // ─── PostgreSQL ↔ APIConfig 映射 ─────────────────────────────────────────

  /**
   * 将 PostgreSQL 行映射为 APIConfig 对象
   */
  private rowToConfig(row: PgApiConfigRow): APIConfig {
    const cfg = row.config as Record<string, unknown>;
    return {
      id: row.id,
      provider: row.provider as AIProvider,
      name: row.name,
      apiKey: (cfg.apiKey as string) || '',
      endpoint: cfg.endpoint as string | undefined,
      model: (cfg.model as string) || '',
      isDefault: (cfg.isDefault as boolean) || false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * 将 APIConfig 字段打包为 JSONB config 列
   */
  private buildConfigJsonb(input: {
    apiKey: string;
    model?: string;
    endpoint?: string;
    isDefault?: boolean;
  }): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      apiKey: input.apiKey,
    };
    if (input.model !== undefined) cfg.model = input.model;
    if (input.endpoint !== undefined) cfg.endpoint = input.endpoint;
    if (input.isDefault !== undefined) cfg.isDefault = input.isDefault;
    return cfg;
  }

  // ─── JSON 文件存储（回退路径） ────────────────────────────────────────────

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.access(DATA_DIR);
    } catch {
      await fs.mkdir(DATA_DIR, { recursive: true });
      logger.info(`Created AI data directory: ${DATA_DIR}`);
    }
  }

  /**
   * 加载 AI Agent 数据
   */
  private async loadData(): Promise<AIAgentData> {
    try {
      await this.ensureDataDir();
      const data = await fs.readFile(AI_DATA_FILE, 'utf-8');
      const parsed = JSON.parse(data) as AIAgentData;

      const result: AIAgentData = {
        apiConfigs: parsed.apiConfigs || [],
        sessions: parsed.sessions || [],
        scriptHistory: parsed.scriptHistory || [],
        settings: parsed.settings || { ...DEFAULT_SETTINGS },
      };

      result.apiConfigs = result.apiConfigs.map(config => ({
        ...config,
        createdAt: new Date(config.createdAt),
        updatedAt: new Date(config.updatedAt),
      }));

      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No AI agent data file found, using defaults');
        return { ...DEFAULT_AI_DATA };
      }
      logger.error('Failed to load AI agent data:', error);
      throw new Error('加载 AI 配置数据失败');
    }
  }

  /**
   * 保存 AI Agent 数据
   */
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

  // ─── 公共工具方法 ─────────────────────────────────────────────────────────

  /**
   * 掩码 API Key，只显示最后 4 个字符
   */
  maskApiKey(apiKey: string): string {
    if (!apiKey || apiKey.length < 4) {
      return '****';
    }
    const lastFour = apiKey.slice(-4);
    const maskedLength = apiKey.length - 4;
    return '*'.repeat(maskedLength) + lastFour;
  }

  /**
   * 将 APIConfig 转换为显示格式（API Key 已掩码）
   */
  private toDisplayFormat(config: APIConfig): APIConfigDisplay {
    let decryptedKey: string;
    try {
      decryptedKey = this.crypto.decrypt(config.apiKey);
    } catch {
      decryptedKey = '';
    }

    const { apiKey, ...rest } = config;
    return {
      ...rest,
      apiKeyMasked: this.maskApiKey(decryptedKey),
    };
  }

  // ─── CRUD 方法（双路径） ──────────────────────────────────────────────────

  /**
   * 创建新的 API 配置
   */
  async create(input: CreateAPIConfigInput): Promise<APIConfig> {
    const encryptedApiKey = this.crypto.encrypt(input.apiKey);
    const now = new Date();
    const id = uuidv4();

    if (this.usePg) {
      const ds = this.dataStore!;

      // 如果设置为默认，先清除其他配置的默认状态
      if (input.isDefault) {
        await ds.execute(
          `UPDATE api_configs SET config = jsonb_set(config, '{isDefault}', 'false'), updated_at = $1`,
          [now.toISOString()]
        );
      }

      const configJsonb = this.buildConfigJsonb({
        apiKey: encryptedApiKey,
        model: input.model,
        endpoint: input.endpoint,
        isDefault: input.isDefault,
      });

      await ds.execute(
        `INSERT INTO api_configs (id, provider, name, config, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, input.provider, input.name, JSON.stringify(configJsonb), true, now.toISOString(), now.toISOString()]
      );

      const newConfig: APIConfig = {
        ...input,
        id,
        apiKey: encryptedApiKey,
        createdAt: now,
        updatedAt: now,
      };

      logger.info(`Created API config (PG): ${id} (${input.provider})`);
      this.emit('configUpdated');
      return newConfig;
    }

    // JSON 文件回退路径
    const data = await this.loadData();

    if (input.isDefault) {
      data.apiConfigs = data.apiConfigs.map(config => ({
        ...config,
        isDefault: false,
        updatedAt: now,
      }));
    }

    const newConfig: APIConfig = {
      ...input,
      id,
      apiKey: encryptedApiKey,
      createdAt: now,
      updatedAt: now,
    };

    data.apiConfigs.push(newConfig);

    if (input.isDefault) {
      data.settings.defaultProviderId = newConfig.id;
    }

    await this.saveData(data);
    logger.info(`Created API config: ${newConfig.id} (${newConfig.provider})`);
    this.emit('configUpdated');
    return newConfig;
  }

  /**
   * 更新现有的 API 配置
   */
  async update(id: string, updates: UpdateAPIConfigInput): Promise<APIConfig> {
    if (this.usePg) {
      const ds = this.dataStore!;
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`API 配置不存在: ${id}`);
      }

      const now = new Date();
      const processedUpdates = { ...updates };
      if (updates.apiKey) {
        processedUpdates.apiKey = this.crypto.encrypt(updates.apiKey);
      }

      // 如果设置为默认，先清除其他配置的默认状态
      if (updates.isDefault) {
        await ds.execute(
          `UPDATE api_configs SET config = jsonb_set(config, '{isDefault}', 'false'), updated_at = $1`,
          [now.toISOString()]
        );
      }

      // 合并更新
      const merged: APIConfig = { ...existing, ...processedUpdates, updatedAt: now };
      const configJsonb = this.buildConfigJsonb({
        apiKey: merged.apiKey,
        model: merged.model,
        endpoint: merged.endpoint,
        isDefault: merged.isDefault,
      });

      await ds.execute(
        `UPDATE api_configs SET provider = $1, name = $2, config = $3, updated_at = $4 WHERE id = $5`,
        [merged.provider, merged.name, JSON.stringify(configJsonb), now.toISOString(), id]
      );

      logger.info(`Updated API config (PG): ${id}`);
      this.emit('configUpdated');
      return merged;
    }

    // JSON 文件回退路径
    const data = await this.loadData();
    const index = data.apiConfigs.findIndex(config => config.id === id);

    if (index === -1) {
      throw new Error(`API 配置不存在: ${id}`);
    }

    const now = new Date();
    const processedUpdates = { ...updates };
    if (updates.apiKey) {
      processedUpdates.apiKey = this.crypto.encrypt(updates.apiKey);
    }

    if (updates.isDefault) {
      data.apiConfigs = data.apiConfigs.map(config => ({
        ...config,
        isDefault: config.id === id ? true : false,
        updatedAt: config.id === id ? now : config.updatedAt,
      }));
      data.settings.defaultProviderId = id;
    }

    const updatedConfig: APIConfig = {
      ...data.apiConfigs[index],
      ...processedUpdates,
      updatedAt: now,
    };

    data.apiConfigs[index] = updatedConfig;
    await this.saveData(data);
    logger.info(`Updated API config: ${id}`);
    this.emit('configUpdated');
    return updatedConfig;
  }

  /**
   * 删除 API 配置
   */
  async delete(id: string): Promise<void> {
    if (this.usePg) {
      const ds = this.dataStore!;
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`API 配置不存在: ${id}`);
      }

      await ds.execute(`DELETE FROM api_configs WHERE id = $1`, [id]);
      logger.info(`Deleted API config (PG): ${id}`);
      this.emit('configUpdated');
      return;
    }

    // JSON 文件回退路径
    const data = await this.loadData();
    const index = data.apiConfigs.findIndex(config => config.id === id);

    if (index === -1) {
      throw new Error(`API 配置不存在: ${id}`);
    }

    if (data.apiConfigs[index].isDefault) {
      data.settings.defaultProviderId = undefined;
    }

    data.apiConfigs.splice(index, 1);
    await this.saveData(data);
    logger.info(`Deleted API config: ${id}`);
    this.emit('configUpdated');
  }

  /**
   * 获取所有 API 配置
   */
  async getAll(): Promise<APIConfig[]> {
    if (this.usePg) {
      const rows = await this.dataStore!.query<PgApiConfigRow>(
        `SELECT * FROM api_configs ORDER BY created_at`
      );
      return rows.map(row => this.rowToConfig(row));
    }

    const data = await this.loadData();
    return data.apiConfigs;
  }

  /**
   * 获取所有 API 配置的显示格式
   */
  async getAllDisplay(): Promise<APIConfigDisplay[]> {
    const configs = await this.getAll();
    return configs.map(config => this.toDisplayFormat(config));
  }

  /**
   * 根据 ID 获取 API 配置
   */
  async getById(id: string): Promise<APIConfig | null> {
    if (this.usePg) {
      const row = await this.dataStore!.queryOne<PgApiConfigRow>(
        `SELECT * FROM api_configs WHERE id = $1`,
        [id]
      );
      return row ? this.rowToConfig(row) : null;
    }

    const data = await this.loadData();
    return data.apiConfigs.find(config => config.id === id) || null;
  }

  /**
   * 根据 ID 获取 API 配置的显示格式
   */
  async getByIdDisplay(id: string): Promise<APIConfigDisplay | null> {
    const config = await this.getById(id);
    return config ? this.toDisplayFormat(config) : null;
  }

  /**
   * 获取默认 API 配置
   */
  async getDefault(): Promise<APIConfig | null> {
    if (this.usePg) {
      const row = await this.dataStore!.queryOne<PgApiConfigRow>(
        `SELECT * FROM api_configs WHERE config->>'isDefault' = 'true' LIMIT 1`
      );
      return row ? this.rowToConfig(row) : null;
    }

    // JSON 文件回退路径
    const data = await this.loadData();

    if (data.settings.defaultProviderId) {
      const config = data.apiConfigs.find(
        c => c.id === data.settings.defaultProviderId
      );
      if (config) return config;
    }

    return data.apiConfigs.find(config => config.isDefault) || null;
  }

  /**
   * 设置默认 API 配置
   */
  async setDefault(id: string): Promise<void> {
    if (this.usePg) {
      const ds = this.dataStore!;
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`API 配置不存在: ${id}`);
      }

      const now = new Date();
      await ds.transaction(async (tx) => {
        // 清除所有配置的默认状态
        await tx.execute(
          `UPDATE api_configs SET config = jsonb_set(config, '{isDefault}', 'false'), updated_at = $1`,
          [now.toISOString()]
        );
        // 设置目标配置为默认
        await tx.execute(
          `UPDATE api_configs SET config = jsonb_set(config, '{isDefault}', 'true'), updated_at = $1 WHERE id = $2`,
          [now.toISOString(), id]
        );
      });

      logger.info(`Set default API config (PG): ${id}`);
      this.emit('configUpdated');
      return;
    }

    // JSON 文件回退路径
    const data = await this.loadData();
    const targetConfig = data.apiConfigs.find(config => config.id === id);

    if (!targetConfig) {
      throw new Error(`API 配置不存在: ${id}`);
    }

    const now = new Date();
    data.apiConfigs = data.apiConfigs.map(config => ({
      ...config,
      isDefault: config.id === id,
      updatedAt: config.id === id ? now : config.updatedAt,
    }));

    data.settings.defaultProviderId = id;
    await this.saveData(data);
    logger.info(`Set default API config: ${id}`);
    this.emit('configUpdated');
  }

  /**
   * 测试 API 配置的连接
   */
  async testConnection(id: string): Promise<boolean> {
    const config = await this.getById(id);

    if (!config) {
      throw new Error(`API 配置不存在: ${id}`);
    }

    try {
      this.crypto.decrypt(config.apiKey);
      logger.info(`Tested API config connection: ${id} - success`);
      return true;
    } catch (error) {
      logger.error(`API config connection test failed: ${id}`, error);
      return false;
    }
  }

  /**
   * 获取解密后的 API Key
   */
  async getDecryptedApiKey(id: string): Promise<string> {
    const config = await this.getById(id);

    if (!config) {
      throw new Error(`API 配置不存在: ${id}`);
    }

    return this.crypto.decrypt(config.apiKey);
  }

  /**
   * 根据提供商类型获取配置列表
   */
  async getByProvider(provider: AIProvider): Promise<APIConfig[]> {
    if (this.usePg) {
      const rows = await this.dataStore!.query<PgApiConfigRow>(
        `SELECT * FROM api_configs WHERE provider = $1 ORDER BY created_at`,
        [provider]
      );
      return rows.map(row => this.rowToConfig(row));
    }

    const data = await this.loadData();
    return data.apiConfigs.filter(config => config.provider === provider);
  }
}

/**
 * 默认 APIConfigService 单例实例
 */
export const apiConfigService = new APIConfigService();

export default apiConfigService;
