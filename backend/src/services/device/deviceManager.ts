/**
 * DeviceManager - 设备管理器
 *
 * 提供设备 CRUD 操作和状态管理：
 * - createDevice()：创建设备，密码使用 AES 加密存储
 * - getDevices()：获取设备列表，支持按标签和分组过滤
 * - getDevice()：获取单个设备
 * - updateDevice()：更新设备配置
 * - deleteDevice()：删除设备
 * - updateStatus()：更新设备连接状态
 *
 * 设备密码使用 crypto-js AES 加密存储，密钥从环境变量 DEVICE_ENCRYPTION_KEY 获取。
 * Tags 以 JSON 数组字符串存储在 SQLite 中，use_tls 以 INTEGER (0/1) 存储但对外暴露为 boolean。
 *
 * Requirements: 5.1, 5.2, 5.3, 5.6
 */

import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';
import { DataStore, DataStoreError } from '../core/dataStore';
import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * 设备接口（对外暴露的完整设备信息）
 */
export interface Device {
  id: string;
  tenant_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
  use_tls: boolean;
  group_name?: string;
  tags: string[];
  status: 'online' | 'offline' | 'connecting' | 'error';
  last_seen?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

/**
 * 数据库中的设备行（SQLite 原始格式）
 */
interface DeviceRow {
  id: string;
  tenant_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
  use_tls: number;        // SQLite INTEGER: 0 or 1
  group_name: string | null;
  tags: string;           // JSON 数组字符串
  status: string;
  last_seen: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 创建设备输入
 */
export interface CreateDeviceInput {
  name: string;
  host: string;
  port?: number;
  username: string;
  password: string;       // 明文密码，存储时加密
  use_tls?: boolean;
  group_name?: string;
  tags?: string[];
}

/**
 * 更新设备输入（所有字段可选）
 */
export interface UpdateDeviceInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;      // 明文密码，存储时加密
  use_tls?: boolean;
  group_name?: string;
  tags?: string[];
}

/**
 * 设备过滤条件
 */
export interface DeviceFilter {
  /** 按分组名称过滤 */
  group_name?: string;
  /** 按标签过滤（包含任一标签即匹配） */
  tags?: string[];
  /** 按状态过滤 */
  status?: Device['status'];
}

/**
 * DeviceManager 配置选项
 */
export interface DeviceManagerOptions {
  /** 设备密码加密密钥 */
  encryptionKey?: string;
}

/**
 * DeviceManager 结构化错误
 */
export class DeviceManagerError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DeviceManagerError';
    this.code = code;
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8728;
const DEFAULT_ENCRYPTION_KEY = 'routeros-device-encryption-key-2024';
const VALID_STATUSES: Device['status'][] = ['online', 'offline', 'connecting', 'error'];

// ─── DeviceManager Class ─────────────────────────────────────────────────────

export class DeviceManager {
  private readonly dataStore: DataStore;
  private readonly encryptionKey: string;

  constructor(dataStore: DataStore, options: DeviceManagerOptions = {}) {
    this.dataStore = dataStore;
    this.encryptionKey = options.encryptionKey
      ?? process.env.DEVICE_ENCRYPTION_KEY
      ?? DEFAULT_ENCRYPTION_KEY;
  }

  // ─── CRUD Operations ─────────────────────────────────────────────────────

  /**
   * 创建设备
   *
   * - 生成唯一 ID
   * - 使用 AES 加密密码
   * - 插入 devices 表
   *
   * @param tenantId 租户 ID
   * @param config 设备配置
   * @returns 创建的设备对象
   */
  async createDevice(tenantId: string, config: CreateDeviceInput): Promise<Device> {
    this.validateCreateInput(config);

    const id = uuidv4();
    const passwordEncrypted = this.encryptPassword(config.password);
    const tags = JSON.stringify(config.tags ?? []);
    const useTls = config.use_tls ? 1 : 0;
    const port = config.port ?? DEFAULT_PORT;

    try {
      this.dataStore.run(
        `INSERT INTO devices (id, tenant_id, name, host, port, username, password_encrypted, use_tls, group_name, tags, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline')`,
        [id, tenantId, config.name, config.host, port, config.username, passwordEncrypted, useTls, config.group_name ?? null, tags],
      );

      logger.info(`设备已创建: ${config.name} (${id}) for tenant ${tenantId}`);

      const device = await this.getDevice(tenantId, id);
      if (!device) {
        throw new DeviceManagerError('设备创建后无法读取', 'CREATE_FAILED');
      }
      return device;
    } catch (error) {
      if (error instanceof DeviceManagerError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`创建设备失败: ${err.message}`);
      throw new DeviceManagerError(`创建设备失败: ${err.message}`, 'CREATE_FAILED');
    }
  }

  /**
   * 获取租户的设备列表，支持过滤
   *
   * @param tenantId 租户 ID，使用 '*' 可查询所有租户的设备（仅供 Brain 等全局服务使用）
   * @param filter 可选的过滤条件
   * @param options 可选的访问控制选项
   * @returns 设备数组
   */
  async getDevices(tenantId: string, filter?: DeviceFilter, options?: { allowCrossTenant?: boolean }): Promise<Device[]> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      // 🔴 FIX (Gemini audit): 访问控制 — 只有明确授权的调用者才能使用 '*' 查询所有租户
      if (tenantId === '*') {
        if (!options?.allowCrossTenant) {
          throw new DeviceManagerError(
            '跨租户查询被拒绝：需要 allowCrossTenant 权限',
            'FORBIDDEN'
          );
        }
        // 允许跨租户查询，不添加 tenant_id 过滤条件
        logger.warn('[DeviceManager] Cross-tenant query authorized (allowCrossTenant=true)');
      } else {
        conditions.push('tenant_id = ?');
        params.push(tenantId);
      }

      if (filter?.group_name) {
        conditions.push('group_name = ?');
        params.push(filter.group_name);
      }

      if (filter?.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT * FROM devices ${whereClause} ORDER BY created_at DESC`;
      const rows = this.dataStore.query<DeviceRow>(sql, params);

      let devices = rows.map((row) => this.rowToDevice(row));

      // 标签过滤在应用层处理（因为 tags 是 JSON 数组字符串）
      if (filter?.tags && filter.tags.length > 0) {
        devices = devices.filter((device) =>
          filter.tags!.some((tag) => device.tags.includes(tag)),
        );
      }

      return devices;
    } catch (error) {
      if (error instanceof DeviceManagerError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`获取设备列表失败: ${err.message}`);
      throw new DeviceManagerError(`获取设备列表失败: ${err.message}`, 'QUERY_FAILED');
    }
  }

  /**
   * 获取单个设备
   *
   * @param tenantId 租户 ID
   * @param deviceId 设备 ID
   * @returns 设备对象，不存在时返回 null
   */
  async getDevice(tenantId: string, deviceId: string): Promise<Device | null> {
    try {
      const rows = this.dataStore.query<DeviceRow>(
        'SELECT * FROM devices WHERE id = ? AND tenant_id = ?',
        [deviceId, tenantId],
      );

      if (rows.length === 0) {
        return null;
      }

      return this.rowToDevice(rows[0]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`获取设备失败: ${err.message}`);
      throw new DeviceManagerError(`获取设备失败: ${err.message}`, 'QUERY_FAILED');
    }
  }

  /**
   * 跨租户按 deviceId 精确查找设备（O(1) 主键查询）
   * 用于 intentRegistry / brainTools 等需要从 deviceId 反查 tenant_id 的场景。
   */
  async findDeviceByIdAcrossTenants(deviceId: string): Promise<Device | null> {
    try {
      const rows = this.dataStore.query<DeviceRow>(
        'SELECT * FROM devices WHERE id = ? LIMIT 1',
        [deviceId],
      );
      if (rows.length === 0) return null;
      return this.rowToDevice(rows[0]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`findDeviceByIdAcrossTenants 失败: ${err.message}`);
      throw new DeviceManagerError(`查询设备失败: ${err.message}`, 'QUERY_FAILED');
    }
  }

  /**
   * 检查数据库中是否存在任何受管设备（不限状态，LIMIT 1 查询，O(1)）
   * 供 intentRegistry ROUTE_B 使用：只要 DB 中有设备记录，就要求 LLM 传 deviceId。
   * 与 autonomousBrainService.gatherContext 保持一致——Brain 也展示所有设备（含 offline）。
   * 这消除了 TOCTOU 竞态：感知阶段设备 offline 被过滤 → LLM 不传 deviceId → 执行时设备已上线 → 拒绝。
   */
  async hasAvailableDevices(): Promise<boolean> {
    try {
      const result = this.dataStore.query<{ found: number }>(
        "SELECT 1 as found FROM devices LIMIT 1",
      );
      return result.length > 0;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`hasAvailableDevices 失败: ${err.message}`);
      return false; // 失败时安全降级，假定无设备，走单设备模式
    }
  }

  /**
   * 根据主机地址获取设备
   */
  async getDeviceByHost(host: string): Promise<Device | null> {
    try {
      const rows = this.dataStore.query<DeviceRow>(
        'SELECT * FROM devices WHERE host = ?',
        [host],
      );

      if (rows.length === 0) {
        return null;
      }

      // 如果有多个，返回第一个（假设 IP 唯一）
      return this.rowToDevice(rows[0]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`获取设备失败: ${err.message}`);
      throw new DeviceManagerError(`获取设备失败: ${err.message}`, 'QUERY_FAILED');
    }
  }

  /**
   * 更新设备配置
   *
   * @param tenantId 租户 ID
   * @param deviceId 设备 ID
   * @param updates 要更新的字段
   * @returns 更新后的设备对象
   * @throws DeviceManagerError 设备不存在时抛出 NOT_FOUND 错误
   */
  async updateDevice(tenantId: string, deviceId: string, updates: UpdateDeviceInput): Promise<Device> {
    // 先检查设备是否存在且属于该租户
    const existing = await this.getDevice(tenantId, deviceId);
    if (!existing) {
      throw new DeviceManagerError('设备不存在或无权访问', 'NOT_FOUND');
    }

    this.validateUpdateInput(updates);

    try {
      const setClauses: string[] = [];
      const params: unknown[] = [];

      if (updates.name !== undefined) {
        setClauses.push('name = ?');
        params.push(updates.name);
      }
      if (updates.host !== undefined) {
        setClauses.push('host = ?');
        params.push(updates.host);
      }
      if (updates.port !== undefined) {
        setClauses.push('port = ?');
        params.push(updates.port);
      }
      if (updates.username !== undefined) {
        setClauses.push('username = ?');
        params.push(updates.username);
      }
      if (updates.password !== undefined) {
        setClauses.push('password_encrypted = ?');
        params.push(this.encryptPassword(updates.password));
      }
      if (updates.use_tls !== undefined) {
        setClauses.push('use_tls = ?');
        params.push(updates.use_tls ? 1 : 0);
      }
      if (updates.group_name !== undefined) {
        setClauses.push('group_name = ?');
        params.push(updates.group_name);
      }
      if (updates.tags !== undefined) {
        setClauses.push('tags = ?');
        params.push(JSON.stringify(updates.tags));
      }

      if (setClauses.length === 0) {
        return existing;
      }

      setClauses.push("updated_at = datetime('now')");
      params.push(deviceId, tenantId);

      const sql = `UPDATE devices SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`;
      this.dataStore.run(sql, params);

      logger.info(`设备已更新: ${deviceId} for tenant ${tenantId}`);

      const updated = await this.getDevice(tenantId, deviceId);
      if (!updated) {
        throw new DeviceManagerError('设备更新后无法读取', 'UPDATE_FAILED');
      }
      return updated;
    } catch (error) {
      if (error instanceof DeviceManagerError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`更新设备失败: ${err.message}`);
      throw new DeviceManagerError(`更新设备失败: ${err.message}`, 'UPDATE_FAILED');
    }
  }

  /**
   * 删除设备
   *
   * @param tenantId 租户 ID
   * @param deviceId 设备 ID
   * @throws DeviceManagerError 设备不存在时抛出 NOT_FOUND 错误
   */
  async deleteDevice(tenantId: string, deviceId: string): Promise<void> {
    try {
      let changes = 0;
      // 在事务中级联清理所有引用该设备的子表数据，然后删除设备本身
      // 避免 FOREIGN KEY constraint failed
      this.dataStore.transaction(() => {
        // 1. 清理有 FK 约束的子表（device_id REFERENCES devices(id)）
        this.dataStore.run('DELETE FROM alert_rules WHERE device_id = ?', [deviceId]);
        this.dataStore.run('DELETE FROM alert_events WHERE device_id = ?', [deviceId]);
        this.dataStore.run('DELETE FROM config_snapshots WHERE device_id = ?', [deviceId]);
        this.dataStore.run('DELETE FROM chat_sessions WHERE device_id = ?', [deviceId]);
        this.dataStore.run('DELETE FROM scheduled_tasks WHERE device_id = ?', [deviceId]);

        // 2. 清理无 FK 约束但有 device_id 引用的表（保持数据一致性）
        this.dataStore.run('DELETE FROM health_metrics WHERE device_id = ?', [deviceId]);
        this.dataStore.run('DELETE FROM audit_logs WHERE device_id = ?', [deviceId]);

        // 3. 最后删除设备本身
        const result = this.dataStore.run(
          'DELETE FROM devices WHERE id = ? AND tenant_id = ?',
          [deviceId, tenantId],
        );
        changes = result.changes;
      });

      // 事务外检查结果 — 消除 check-then-act 竞态条件
      if (changes === 0) {
        throw new DeviceManagerError('设备不存在或无权访问', 'NOT_FOUND');
      }

      logger.info(`设备已删除（含关联数据级联清理）: ${deviceId} for tenant ${tenantId}`);
    } catch (error) {
      if (error instanceof DeviceManagerError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`删除设备失败: ${err.message}`);
      throw new DeviceManagerError(`删除设备失败: ${err.message}`, 'DELETE_FAILED');
    }
  }

  // ─── Status Management ───────────────────────────────────────────────────

  /**
   * 更新设备状态
   *
   * @param deviceId 设备 ID
   * @param status 新状态
   * @param errorMessage 错误信息（仅在 status 为 'error' 时使用）
   */
  async updateStatus(deviceId: string, status: Device['status'], errorMessage?: string): Promise<void> {
    if (!VALID_STATUSES.includes(status)) {
      throw new DeviceManagerError(`无效的设备状态: ${status}`, 'INVALID_STATUS');
    }

    try {
      const setClauses: string[] = ['status = ?', "updated_at = datetime('now')"];
      const params: unknown[] = [status];

      // 更新 last_seen（当设备在线时）
      if (status === 'online') {
        setClauses.push("last_seen = datetime('now')");
      }

      // 更新错误信息
      if (status === 'error' && errorMessage) {
        setClauses.push('error_message = ?');
        params.push(errorMessage);
      } else if (status !== 'error') {
        // 非错误状态时清除错误信息
        setClauses.push('error_message = NULL');
      }

      params.push(deviceId);

      const sql = `UPDATE devices SET ${setClauses.join(', ')} WHERE id = ?`;
      const result = this.dataStore.run(sql, params);

      if (result.changes === 0) {
        throw new DeviceManagerError(`设备不存在: ${deviceId}`, 'NOT_FOUND');
      }

      logger.info(`设备状态已更新: ${deviceId} → ${status}${errorMessage ? ` (${errorMessage})` : ''}`);
    } catch (error) {
      if (error instanceof DeviceManagerError) throw error;
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`更新设备状态失败: ${err.message}`);
      throw new DeviceManagerError(`更新设备状态失败: ${err.message}`, 'STATUS_UPDATE_FAILED');
    }
  }

  // ─── Password Encryption ────────────────────────────────────────────────

  /**
   * 加密设备密码
   */
  encryptPassword(plainText: string): string {
    if (!plainText) {
      throw new DeviceManagerError('密码不能为空', 'INVALID_INPUT');
    }
    return CryptoJS.AES.encrypt(plainText, this.encryptionKey).toString();
  }

  /**
   * 解密设备密码
   */
  decryptPassword(cipherText: string): string {
    if (!cipherText) {
      throw new DeviceManagerError('密文不能为空', 'INVALID_INPUT');
    }
    const decrypted = CryptoJS.AES.decrypt(cipherText, this.encryptionKey);
    const plainText = decrypted.toString(CryptoJS.enc.Utf8);
    if (!plainText) {
      throw new DeviceManagerError('密码解密失败：密文无效或密钥错误', 'DECRYPT_FAILED');
    }
    return plainText;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * 将数据库行转换为 Device 接口对象
   */
  private rowToDevice(row: DeviceRow): Device {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      password_encrypted: row.password_encrypted,
      use_tls: row.use_tls === 1,
      group_name: row.group_name ?? undefined,
      tags: this.parseTags(row.tags),
      status: row.status as Device['status'],
      last_seen: row.last_seen ?? undefined,
      error_message: row.error_message ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * 解析 tags JSON 字符串
   */
  private parseTags(tagsStr: string): string[] {
    try {
      const parsed = JSON.parse(tagsStr);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      logger.warn(`解析设备 tags 失败，原始字符串: "${tagsStr}"`);
      return [];
    }
  }

  /**
   * 验证创建设备输入
   */
  private validateCreateInput(config: CreateDeviceInput): void {
    if (!config.name || config.name.trim().length === 0) {
      throw new DeviceManagerError('设备名称不能为空', 'INVALID_INPUT');
    }
    if (!config.host || config.host.trim().length === 0) {
      throw new DeviceManagerError('设备主机地址不能为空', 'INVALID_INPUT');
    }
    if (!config.username || config.username.trim().length === 0) {
      throw new DeviceManagerError('设备用户名不能为空', 'INVALID_INPUT');
    }
    if (!config.password || config.password.trim().length === 0) {
      throw new DeviceManagerError('设备密码不能为空', 'INVALID_INPUT');
    }
    if (config.port !== undefined && (config.port < 1 || config.port > 65535)) {
      throw new DeviceManagerError('端口号必须在 1-65535 之间', 'INVALID_INPUT');
    }
  }

  /**
   * 验证更新设备输入
   */
  private validateUpdateInput(updates: UpdateDeviceInput): void {
    if (updates.name !== undefined && updates.name.trim().length === 0) {
      throw new DeviceManagerError('设备名称不能为空', 'INVALID_INPUT');
    }
    if (updates.host !== undefined && updates.host.trim().length === 0) {
      throw new DeviceManagerError('设备主机地址不能为空', 'INVALID_INPUT');
    }
    if (updates.username !== undefined && updates.username.trim().length === 0) {
      throw new DeviceManagerError('设备用户名不能为空', 'INVALID_INPUT');
    }
    if (updates.password !== undefined && updates.password.trim().length === 0) {
      throw new DeviceManagerError('设备密码不能为空', 'INVALID_INPUT');
    }
    if (updates.port !== undefined && (updates.port < 1 || updates.port > 65535)) {
      throw new DeviceManagerError('端口号必须在 1-65535 之间', 'INVALID_INPUT');
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export default DeviceManager;
