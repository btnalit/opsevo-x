/**
 * Config Service
 * 处理连接配置的持久化存储
 *
 * 迁移说明（Requirements: 2.1）：
 * - 在多设备架构中，设备连接配置已迁移到 devices 表，由 DeviceManager 管理
 * - 本服务保留用于向后兼容（单设备模式 / 自动恢复连接等遗留场景）
 * - 当 DataStore 可用时，从 devices 表读取第一个设备配置作为默认连接
 * - 当 DataStore 不可用时，回退到 JSON 文件读写（connection.json）
 *
 * @deprecated 新代码应使用 DeviceManager 进行设备配置管理
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';
import type { DataStore } from './dataStore';

/**
 * 设备连接配置（向后兼容）
 * 新代码应使用 DeviceManager + DeviceConnectionConfig
 */
interface LegacyConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  useTLS: boolean;
}

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'connection.json');

/** devices 表行结构（仅需要的字段） */
interface DeviceRow {
  id: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
  use_tls: number;
}

export class ConfigService {
  // ==================== DataStore 集成 ====================
  private dataStore: DataStore | null = null;

  // ==================== 密码解密 ====================
  // Requirements: 3.1, 3.2 - 解密 devices 表中的加密密码
  private decryptFn: ((cipherText: string) => string) | null = null;

  /**
   * 设置 DataStore 实例
   * 当 DataStore 可用时，配置将从 devices 表读取
   * Requirements: 2.1
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('ConfigService: DataStore backend configured, using devices table for connection config');
  }

  /**
   * 设置 PgDataStore 实例，启用 PostgreSQL 读取
   */
  setPgDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('ConfigService: PgDataStore backend configured, using PostgreSQL devices table');
  }

  /**
   * 设置密码解密函数（由 DeviceManager 提供）
   * 用于解密 devices 表中的 password_encrypted 字段
   * Requirements: 3.1, 3.2
   */
  setDecryptFunction(fn: (cipherText: string) => string): void {
    this.decryptFn = fn;
    logger.info('ConfigService: Decrypt function configured for password decryption');
  }

  /**
   * 确保配置目录存在（JSON 回退模式使用）
   */
  private async ensureConfigDir(): Promise<void> {
    try {
      await fs.access(CONFIG_DIR);
    } catch {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      logger.info(`Created config directory: ${CONFIG_DIR}`);
    }
  }

  /**
   * 加载保存的配置
   * - DataStore 模式：从 devices 表读取第一个设备作为默认连接配置
   * - JSON 回退模式：从 connection.json 读取
   * @returns 配置对象或 null
   */
  async loadConfig(): Promise<LegacyConnectionConfig | null> {
    // DataStore 模式：从 PostgreSQL devices 表读取
    if (this.dataStore) {
      return this.loadConfigFromPgDataStore();
    }

    // JSON 回退模式
    return this.loadConfigFromFile();
  }

  /**
   * 保存配置
   * - DataStore 模式：不执行操作（设备配置由 DeviceManager 管理）
   * - JSON 回退模式：写入 connection.json
   * @param config 配置对象
   */
  async saveConfig(config: LegacyConnectionConfig): Promise<void> {
    // DataStore 模式：设备配置由 DeviceManager 管理，此处仅记录日志
    if (this.dataStore) {
      logger.info('ConfigService: saveConfig called in DataStore mode - device configs are managed by DeviceManager');
      return;
    }

    // JSON 回退模式
    return this.saveConfigToFile(config);
  }

  /**
   * 删除保存的配置
   * - DataStore 模式：不执行操作（设备配置由 DeviceManager 管理）
   * - JSON 回退模式：删除 connection.json
   */
  async deleteConfig(): Promise<void> {
    // DataStore 模式：设备配置由 DeviceManager 管理
    if (this.dataStore) {
      logger.info('ConfigService: deleteConfig called in DataStore mode - device configs are managed by DeviceManager');
      return;
    }

    // JSON 回退模式
    return this.deleteConfigFromFile();
  }

  // ==================== DataStore 操作 ====================

  /**
   * 从 PostgreSQL devices 表加载第一个设备配置
   */
  private async loadConfigFromPgDataStore(): Promise<LegacyConnectionConfig | null> {
    try {
      const row = await this.dataStore!.queryOne<DeviceRow>(
        `SELECT id, host, port, username, password_encrypted, use_tls
         FROM devices ORDER BY created_at ASC LIMIT 1`
      );

      if (!row) {
        logger.info('ConfigService: No devices found in PostgreSQL');
        return null;
      }

      let password: string;
      if (this.decryptFn) {
        try {
          password = this.decryptFn(row.password_encrypted);
        } catch (error) {
          logger.error('ConfigService: Failed to decrypt device password:', error);
          return null;
        }
      } else {
        logger.warn('ConfigService: No decrypt function set');
        return null;
      }

      logger.info('ConfigService: Loaded connection config from PostgreSQL devices table');
      return {
        host: row.host,
        port: row.port,
        username: row.username,
        password,
        useTLS: row.use_tls === 1,
      };
    } catch (error) {
      logger.error('ConfigService: Failed to load config from PostgreSQL:', error);
      return null;
    }
  }

  // ==================== JSON 文件操作（回退模式） ====================

  /**
   * 从 JSON 文件加载配置
   * 如果文件不存在，尝试从环境变量读取（Docker 首次启动支持）
   */
  private async loadConfigFromFile(): Promise<LegacyConnectionConfig | null> {
    try {
      await this.ensureConfigDir();
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(data) as LegacyConnectionConfig;
      logger.info('Loaded connection config from file');
      return config;
    } catch (error) {
      // 文件不存在是正常情况
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const envConfig = this.loadConfigFromEnv();
        if (envConfig) {
          logger.info('Loaded connection config from environment variables (Docker init)');
          return envConfig;
        }
        logger.info('No saved connection config found');
        return null;
      }
      logger.error('Failed to load config:', error);
      throw new Error('加载配置失败');
    }
  }

  /**
   * 从环境变量加载配置
   * 支持 Docker 容器首次启动时的零配置部署
   */
  private loadConfigFromEnv(): LegacyConnectionConfig | null {
    const host = process.env.DEVICE_HOST || process.env.ROUTEROS_HOST;
    const user = process.env.DEVICE_USER || process.env.ROUTEROS_USER;
    const password = process.env.DEVICE_PASSWORD || process.env.ROUTEROS_PASSWORD;

    if (host && user && password) {
      return {
        host,
        port: parseInt(process.env.DEVICE_PORT || process.env.ROUTEROS_PORT || '8728', 10),
        username: user,
        password: password,
        useTLS: (process.env.DEVICE_USE_TLS || process.env.ROUTEROS_USE_TLS) === 'true',
      };
    }
    return null;
  }

  /**
   * 保存配置到 JSON 文件
   */
  private async saveConfigToFile(config: LegacyConnectionConfig): Promise<void> {
    try {
      await this.ensureConfigDir();
      const data = JSON.stringify(config, null, 2);
      await fs.writeFile(CONFIG_FILE, data, 'utf-8');
      logger.info('Saved connection config to file');
    } catch (error) {
      logger.error('Failed to save config:', error);
      throw new Error('保存配置失败');
    }
  }

  /**
   * 删除 JSON 配置文件
   */
  private async deleteConfigFromFile(): Promise<void> {
    try {
      await fs.unlink(CONFIG_FILE);
      logger.info('Deleted connection config file');
    } catch (error) {
      // 文件不存在是正常情况
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to delete config:', error);
        throw new Error('删除配置失败');
      }
    }
  }
}

// 导出单例实例
export const configService = new ConfigService();
