/**
 * ConfigSnapshotService 配置快照服务
 * 负责配置备份、恢复和差异对比
 *
 * Requirements: 5.2-5.9, 6.1-6.9
 * - 5.2: 导出设备完整配置
 * - 5.3: 记录快照时间戳和触发方式
 * - 5.4: 支持手动触发立即备份
 * - 5.5: 保留最近 30 个快照
 * - 5.6: 自动删除最旧的快照
 * - 5.7: 显示快照时间、大小和触发方式
 * - 5.8: 支持下载指定快照文件
 * - 5.9: 支持从快照恢复配置
 * - 6.1: 自动与上一个快照进行对比
 * - 6.2: 生成可读的变更差异报告
 * - 6.3: 标注新增、修改和删除的配置项
 * - 6.4: 调用 AI 服务分析变更影响
 * - 6.5: 在报告中包含变更风险评估
 * - 6.6: 检测到危险配置变更时触发告警
 * - 6.7: 预定义危险配置模式
 * - 6.8: 提供时间线视图展示变更记录
 * - 6.9: 支持对比任意两个快照的差异
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  ConfigSnapshot,
  SnapshotDiff,
  SnapshotTrigger,
  IConfigSnapshotService,
  RiskLevel,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import type { DevicePool, DeviceClient } from '../device/devicePool';
import { auditLogger } from './auditLogger';
import { knowledgeBase } from './rag';
import type { DataStore } from '../dataStore';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const INDEX_FILE = path.join(SNAPSHOTS_DIR, 'index.json');
const MAX_SNAPSHOTS = 30;

/**
 * 危险配置模式定义
 */
interface DangerousPattern {
  name: string;
  description: string;
  patterns: RegExp[];
  riskLevel: RiskLevel;
}

/**
 * 危险变更检测结果
 */
export interface DangerousChangesResult {
  detected: boolean;
  patterns: Array<{
    name: string;
    description: string;
    riskLevel: RiskLevel;
    matchedLines: string[];
  }>;
  overallRiskLevel: RiskLevel;
}

/**
 * 预定义的危险配置模式
 */
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    name: 'firewall_rule_deletion',
    description: '删除防火墙规则',
    patterns: [
      /^-\s*\/ip\s+firewall\s+filter/i,
      /^-\s*\/ip\s+firewall\s+nat/i,
      /^-\s*\/ip\s+firewall\s+mangle/i,
      /^-\s*\/ipv6\s+firewall\s+filter/i,
    ],
    riskLevel: 'high',
  },
  {
    name: 'password_change',
    description: '修改用户密码',
    patterns: [
      /password=/i,
      /\/user\s+.*password/i,
    ],
    riskLevel: 'high',
  },
  {
    name: 'admin_user_change',
    description: '修改管理员用户',
    patterns: [
      /\/user\s+(add|remove|set)/i,
      /group=full/i,
    ],
    riskLevel: 'high',
  },
  {
    name: 'interface_disable',
    description: '禁用网络接口',
    patterns: [
      /\/interface\s+.*disable/i,
      /\/interface\s+.*set.*disabled=yes/i,
    ],
    riskLevel: 'medium',
  },
  {
    name: 'routing_change',
    description: '修改路由配置',
    patterns: [
      /\/ip\s+route\s+(add|remove|set)/i,
      /\/routing\s+/i,
    ],
    riskLevel: 'medium',
  },
  {
    name: 'dns_change',
    description: '修改 DNS 配置',
    patterns: [
      /\/ip\s+dns\s+set/i,
      /\/ip\s+dns\s+static/i,
    ],
    riskLevel: 'low',
  },
  {
    name: 'service_disable',
    description: '禁用系统服务',
    patterns: [
      /\/ip\s+service\s+.*disable/i,
      /\/ip\s+service\s+set.*disabled=yes/i,
    ],
    riskLevel: 'medium',
  },
  {
    name: 'system_reset',
    description: '系统重置或重启',
    patterns: [
      /\/system\s+reset/i,
      /\/system\s+reboot/i,
    ],
    riskLevel: 'high',
  },
];

export class ConfigSnapshotService implements IConfigSnapshotService {
  private snapshots: ConfigSnapshot[] = [];
  private initialized = false;

  // ==================== DataStore 集成 ====================
  // Requirements: 2.1, 2.2 - 使用 DataStore (PostgreSQL) 替代 JSON 文件存储，注入 tenant_id
  private dataStore: DataStore | null = null;
  private devicePool: DevicePool | null = null;

  /**
   * 设置 DataStore 实例
   * 当 DataStore 可用时，配置快照将使用 PostgreSQL 存储
   * Requirements: 2.1, 2.2
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('ConfigSnapshotService: DataStore backend configured for config snapshots storage');
  }

  /**
   * 设置 DevicePool 实例
   * 用于获取设备连接
   */
  setDevicePool(devicePool: DevicePool): void {
    this.devicePool = devicePool;
    logger.info('ConfigSnapshotService: DevicePool configured');
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create snapshots directory:', error);
    }
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureDataDir();
    await this.loadIndex();
    this.initialized = true;
    logger.info('ConfigSnapshotService initialized');
  }

  /**
   * 加载快照索引
   * Requirements: 2.1 - 当 DataStore 可用时从 config_snapshots 表读取
   */
  private async loadIndex(): Promise<void> {
    // 当 DataStore 可用时，从 PostgreSQL 读取
    if (this.dataStore) {
      try {
        const rows = await this.dataStore.query<{
          id: string;
          tenant_id: string;
          device_id: string;
          snapshot_data: string;
          description: string | null;
          created_at: string;
          size: number;
          checksum: string | null;
          metadata: string | null;
        }>('SELECT id, tenant_id, device_id, description, created_at, length(cast(snapshot_data as text)) as size, checksum, metadata FROM config_snapshots ORDER BY created_at DESC');

        this.snapshots = rows.map((row) => ({
          id: row.id,
          timestamp: new Date(row.created_at).getTime(),
          trigger: (row.description?.includes('manual') ? 'manual' : 'scheduled') as SnapshotTrigger,
          size: row.size || 0,
          checksum: row.checksum || '',
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
          tenant_id: row.tenant_id,
          device_id: row.device_id,
        })) as (ConfigSnapshot & { tenant_id?: string; device_id?: string })[];
        logger.info(`Loaded ${this.snapshots.length} config snapshots from DataStore`);
        return;
      } catch (error) {
        logger.error('Failed to load config snapshots from DataStore, falling back to JSON:', error);
      }
    }

    // Fallback: 从 JSON 文件读取
    try {
      const data = await fs.readFile(INDEX_FILE, 'utf-8');
      this.snapshots = JSON.parse(data) as ConfigSnapshot[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.snapshots = [];
        await this.saveIndex();
      } else {
        logger.error('Failed to load snapshot index:', error);
        this.snapshots = [];
      }
    }
  }

  /**
   * 保存快照索引
   * Requirements: 2.1 - 当 DataStore 可用时，索引信息已在 createSnapshot 中写入 PostgreSQL
   */
  private async saveIndex(): Promise<void> {
    // 当 DataStore 可用时，快照数据已在 createSnapshot/deleteSnapshot 中直接操作 PostgreSQL
    if (this.dataStore) {
      return;
    }

    // Fallback: 写入 JSON 文件
    await this.ensureDataDir();
    await fs.writeFile(INDEX_FILE, JSON.stringify(this.snapshots, null, 2), 'utf-8');
  }

  /**
   * 获取快照文件路径
   */
  private getSnapshotFilePath(id: string): string {
    return path.join(SNAPSHOTS_DIR, `${id}.rsc`);
  }

  /**
   * 计算内容的 MD5 校验和
   */
  private calculateChecksum(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }


  /**
   * 获取设备客户端
   * 如果指定了 deviceId，则从 DevicePool 获取
   * 如果未指定且有 DataStore，则获取第一个可用设备（回退模式）
   */
  private async getClient(tenantId?: string, deviceId?: string): Promise<DeviceClient> {
    if (this.devicePool && deviceId && tenantId) {
      return this.devicePool.getConnection(tenantId, deviceId);
    }

    // Fallback: 尝试从 DataStore 获取第一个设备
    // 仅用于遗留代码或单设备场景
    if (this.dataStore && this.devicePool) {
      try {
        const rows = await this.dataStore.query<{ id: string, tenant_id: string }>(
          'SELECT id, tenant_id FROM devices ORDER BY created_at ASC LIMIT 1'
        );
        if (rows.length > 0) {
          const device = rows[0];
          logger.info(`ConfigSnapshotService: Using default device ${device.id} for snapshot operation`);
          return this.devicePool.getConnection(device.tenant_id, device.id);
        }
      } catch (error) {
        logger.warn('ConfigSnapshotService: Failed to get default device from DataStore', error);
      }
    }

    throw new Error('No device connection available and no default device found');
  }

  /**
   * 从设备导出配置
   */
  private async exportConfig(tenantId?: string, deviceId?: string): Promise<string> {
    const client = await this.getClient(tenantId, deviceId);

    // Check connection status
    if (!client.isConnected()) {
      // Try to use print to check connection, sometimes isConnected() might be out of sync
      try {
        await client.print('/system/resource');
      } catch (e) {
      throw new Error('Device not connected');
      }
    }

    try {
      // 直接使用分部分导出，避免 /export 命令导致连接断开
      // Requirements: 5.2 - 导出完整配置
      return await this.exportConfigByParts(client);
    } catch (error) {
      logger.error('Failed to export config:', error);
      throw error;
    }
  }

  /**
   * 分部分导出配置（备用方法）
   * TODO: P2 架构优化 — configPaths 应从 DeviceDriver.getCapabilityManifest() 动态获取，
   * 当前硬编码路径仅适用于 RouterOS API 协议设备，其他设备类型需要各自的配置路径列表。
   */
  private async exportConfigByParts(client: DeviceClient): Promise<string> {
    const parts: string[] = [];
    // 默认配置路径列表（适用于 RouterOS API 协议设备）
    // TODO: 应从设备驱动的 CapabilityManifest 动态获取
    const configPaths = [
      '/system/identity',
      '/interface',
      '/ip/address',
      '/ip/route',
      '/ip/firewall/filter',
      '/ip/firewall/nat',
      '/ip/firewall/mangle',
      '/ip/dns',
      '/ip/dhcp-server',
      '/ip/dhcp-client',
      '/ip/pool',
      '/user',
      '/system/scheduler',
      '/system/script',
    ];

    for (const configPath of configPaths) {
      try {
        const response = await client.print<Record<string, unknown>>(configPath);
        if (response && response.length > 0) {
          parts.push(`# ${configPath}`);
          for (const item of response) {
            const line = Object.entries(item)
              .filter(([key]) => !key.startsWith('.'))
              .map(([key, value]) => `${key}=${value}`)
              .join(' ');
            parts.push(`${configPath} add ${line}`);
          }
          parts.push('');
        }
      } catch (error) {
        // 忽略不存在的配置路径
        logger.debug(`Skipping config path ${configPath}:`, error);
      }
    }

    if (parts.length === 0) {
      throw new Error('Failed to export any configuration');
    }

    return parts.join('\n');
  }

  /**
   * 获取设备元数据
   * TODO: P2 架构优化 — 应通过 DeviceDriver.getMetadata() 获取，当前实现仅适用于 RouterOS API 协议设备
   */
  private async getDeviceMetadata(client: DeviceClient): Promise<{ deviceVersion?: string; deviceModel?: string }> {
    try {
      const resources = await client.print<Record<string, string>>('/system/resource');
      if (resources && resources.length > 0) {
        const resource = resources[0];
        return {
          deviceVersion: resource.version,
          deviceModel: resource['board-name'] || resource['platform'],
        };
      }
    } catch (error) {
      logger.warn('Failed to get device metadata:', error);
    }
    return {};
  }

  /**
   * 强制执行快照保留策略
   */
  private async enforceRetentionPolicy(): Promise<void> {
    // 按时间戳排序（最新的在前）
    this.snapshots.sort((a, b) => b.timestamp - a.timestamp);

    // 删除超出限制的快照
    while (this.snapshots.length > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.pop();
      if (oldest) {
        try {
          const filePath = this.getSnapshotFilePath(oldest.id);
          await fs.unlink(filePath);
          logger.info(`Deleted old snapshot: ${oldest.id} (${new Date(oldest.timestamp).toISOString()})`);
        } catch (error) {
          logger.warn(`Failed to delete snapshot file ${oldest.id}:`, error);
        }
      }
    }

    await this.saveIndex();
  }

  // ==================== 快照管理 ====================

  /**
   * 创建配置快照
   * Requirements: 2.1, 2.2 - 当 DataStore 可用时写入 config_snapshots 表
   */
  async createSnapshot(trigger: SnapshotTrigger, tenantId?: string, deviceId?: string): Promise<ConfigSnapshot> {
    await this.initialize();

    // 获取客户端用于获取元数据
    const client = await this.getClient(tenantId, deviceId);

    // 导出配置
    const content = await this.exportConfig(tenantId, deviceId);
    const metadata = await this.getDeviceMetadata(client);

    // 创建快照记录
    const snapshot: ConfigSnapshot & { tenant_id?: string; device_id?: string } = {
      id: uuidv4(),
      timestamp: Date.now(),
      trigger,
      size: Buffer.byteLength(content, 'utf-8'),
      checksum: this.calculateChecksum(content),
      metadata,
      tenant_id: tenantId,
      device_id: deviceId,
    };

    // 当 DataStore 可用时，写入 PostgreSQL
    if (this.dataStore) {
      try {
        const tId = tenantId || 'default';
        const dId = deviceId ?? tenantId ?? 'unknown';
        const createdAt = new Date(snapshot.timestamp).toISOString();
        const description = `${trigger} snapshot - ${JSON.stringify(metadata)}`;

        const metadataStr = JSON.stringify(metadata);

        await this.dataStore.execute(
          `INSERT INTO config_snapshots (id, tenant_id, device_id, snapshot_data, description, created_at, checksum, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [snapshot.id, tId, dId, content, description, createdAt, snapshot.checksum, metadataStr]
        );
      } catch (error) {
        logger.error('Failed to save snapshot to DataStore, falling back to file:', error);
        // Fallback: save to file
        const filePath = this.getSnapshotFilePath(snapshot.id);
        await fs.writeFile(filePath, content, 'utf-8');
      }
    } else {
      // Fallback: 保存快照文件
      const filePath = this.getSnapshotFilePath(snapshot.id);
      await fs.writeFile(filePath, content, 'utf-8');
    }

    // 添加到索引
    this.snapshots.unshift(snapshot);
    await this.saveIndex();

    // 强制执行保留策略
    await this.enforceRetentionPolicy();

    // 记录审计日志
    await auditLogger.log({
      action: 'snapshot_create',
      actor: trigger === 'manual' ? 'user' : 'system',
      details: {
        trigger,
        metadata: {
          snapshotId: snapshot.id,
          size: snapshot.size,
          checksum: snapshot.checksum,
        },
      },
    });

    // 自动与上一个快照对比并检测危险变更（Requirements 6.1, 6.6）
    let diff: SnapshotDiff | undefined;
    if (this.snapshots.length >= 2 && trigger !== 'pre-remediation') {
      try {
        const previousSnapshot = this.snapshots[1]; // 第二个是上一个快照
        diff = await this.compareSnapshots(previousSnapshot.id, snapshot.id);
        const dangerousChanges = this.detectDangerousChanges(diff);

        if (dangerousChanges.detected) {
          await this.triggerDangerousChangeAlert(diff, dangerousChanges);
        }
      } catch (error) {
        logger.warn('Failed to detect dangerous changes:', error);
      }
    }

    // 索引到知识库 (Requirements: 3.3 - 配置快照创建时自动索引)
    try {
      await knowledgeBase.indexConfig(snapshot, diff);
      logger.debug(`Config snapshot indexed to knowledge base: ${snapshot.id}`);
    } catch (error) {
      logger.warn(`Failed to index config snapshot to knowledge base: ${snapshot.id}`, error);
    }

    logger.info(`Created config snapshot: ${snapshot.id} (trigger: ${trigger})`);
    return snapshot;
  }

  /**
   * 获取快照列表
   */
  async getSnapshots(limit?: number, deviceId?: string): Promise<ConfigSnapshot[]> {
    await this.initialize();

    // 按时间戳降序排序
    let sorted = [...this.snapshots].sort((a, b) => b.timestamp - a.timestamp);

    if (deviceId) {
      sorted = sorted.filter((s) => !(s as any).device_id || (s as any).device_id === deviceId);
    }

    if (limit && limit > 0) {
      return sorted.slice(0, limit);
    }
    return sorted;
  }

  /**
   * 根据 ID 获取快照
   */
  async getSnapshotById(id: string): Promise<ConfigSnapshot | null> {
    await this.initialize();
    return this.snapshots.find((s) => s.id === id) || null;
  }

  /**
   * 删除快照
   * Requirements: 2.1 - 当 DataStore 可用时从 config_snapshots 表删除
   */
  async deleteSnapshot(id: string): Promise<void> {
    await this.initialize();

    const index = this.snapshots.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new Error(`Snapshot not found: ${id}`);
    }

    const snapshot = this.snapshots[index];

    // 当 DataStore 可用时，从 PostgreSQL 删除
    if (this.dataStore) {
      try {
        await this.dataStore.execute('DELETE FROM config_snapshots WHERE id = $1', [id]);
      } catch (error) {
        logger.warn(`Failed to delete snapshot from DataStore ${id}:`, error);
      }
    }

    // 删除文件（fallback storage）
    const filePath = this.getSnapshotFilePath(id);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      logger.warn(`Failed to delete snapshot file ${id}:`, error);
    }

    // 从索引中移除
    this.snapshots.splice(index, 1);
    await this.saveIndex();

    // 记录审计日志
    await auditLogger.log({
      action: 'config_change',
      actor: 'user',
      details: {
        trigger: 'snapshot_delete',
        metadata: {
          snapshotId: id,
          snapshotTimestamp: snapshot.timestamp,
          snapshotTrigger: snapshot.trigger,
        },
      },
    });

    logger.info(`Deleted snapshot: ${id}`);
  }

  /**
   * 下载快照内容
   * Requirements: 2.1 - 当 DataStore 可用时从 config_snapshots 表读取
   */
  async downloadSnapshot(id: string): Promise<string> {
    await this.initialize();

    const snapshot = await this.getSnapshotById(id);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${id}`);
    }

    // 当 DataStore 可用时，从 PostgreSQL 读取
    if (this.dataStore) {
      try {
        const rows = await this.dataStore.query<{
          snapshot_data: string;
        }>('SELECT snapshot_data FROM config_snapshots WHERE id = $1', [id]);

        if (rows.length > 0) {
          return rows[0].snapshot_data;
        }
      } catch (error) {
        logger.error('Failed to read snapshot from DataStore, falling back to file:', error);
      }
    }

    // Fallback: 从文件读取
    const filePath = this.getSnapshotFilePath(id);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(`Failed to read snapshot file: ${id}`);
    }
  }


  // ==================== 配置恢复 ====================

  /**
   * 从快照恢复配置
   */
  async restoreSnapshot(id: string): Promise<{ success: boolean; message: string }> {
    await this.initialize();

    const snapshot = await this.getSnapshotById(id);
    if (!snapshot) {
      return { success: false, message: `Snapshot not found: ${id}` };
    }

    // 获取对应的设备连接
    let client: DeviceClient;
    try {
      // 尝试使用快照中记录的 tenant_id 和 device_id
      const tenantId = (snapshot as any).tenant_id;
      const deviceId = (snapshot as any).device_id;
      client = await this.getClient(tenantId, deviceId);
    } catch (error) {
      return { success: false, message: `Failed to get device connection: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (!client.isConnected()) {
      return { success: false, message: 'Device not connected' };
    }

    try {
      // 读取快照内容
      const content = await this.downloadSnapshot(id);

      // 在恢复前创建一个快照作为回滚点
      // 使用快照中记录的 tenant_id 和 device_id
      const tenantId = (snapshot as any).tenant_id;
      const deviceId = (snapshot as any).device_id;
      const preRestoreSnapshot = await this.createSnapshot('pre-remediation', tenantId, deviceId);
      logger.info(`Created pre-restore snapshot: ${preRestoreSnapshot.id}`);

      // 记录恢复操作到审计日志
      await auditLogger.log({
        action: 'config_restore',
        actor: 'user',
        details: {
          trigger: 'manual_restore',
          metadata: {
            snapshotId: id,
            snapshotTimestamp: snapshot.timestamp,
            preRestoreSnapshotId: preRestoreSnapshot.id,
          },
        },
      });

      // 执行恢复
      // 设备的 /import 命令需要文件，我们需要逐行执行配置
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (const line of lines) {
        try {
          // 跳过空行和注释
          if (!line || line.startsWith('#') || line.startsWith(':')) {
            continue;
          }

          // 转换为 API 格式并执行
          const { apiCommand, params } = this.convertToIntentCommand(line);
          if (apiCommand) {
            await (client as any).executeRaw(apiCommand, params);
            successCount++;
          }
        } catch (error) {
          errorCount++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`${line}: ${errorMessage}`);
          logger.warn(`Failed to execute config line: ${line}`, error);
        }
      }

      // 记录恢复结果
      await auditLogger.log({
        action: 'config_restore',
        actor: 'user',
        details: {
          result: errorCount === 0 ? 'success' : 'partial',
          metadata: {
            snapshotId: id,
            successCount,
            errorCount,
            errors: errors.slice(0, 10), // 只记录前 10 个错误
          },
        },
      });

      if (errorCount === 0) {
        return {
          success: true,
          message: `Configuration restored successfully from snapshot ${id}. ${successCount} commands executed.`,
        };
      } else {
        return {
          success: true,
          message: `Configuration partially restored from snapshot ${id}. ${successCount} commands succeeded, ${errorCount} failed.`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await auditLogger.log({
        action: 'config_restore',
        actor: 'user',
        details: {
          result: 'failed',
          error: errorMessage,
          metadata: {
            snapshotId: id,
          },
        },
      });

      return { success: false, message: `Failed to restore configuration: ${errorMessage}` };
    }
  }

  /**
   * 将配置行转换为 API 格式
   */
  private convertToIntentCommand(line: string): { apiCommand: string; params: string[] } {
    const trimmed = line.trim();

    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) {
      return { apiCommand: '', params: [] };
    }

    // 解析意图格式: "intent:category/operation param=value"
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && !trimmed.startsWith('/')) {
      const afterColon = trimmed.substring(colonIdx + 1).trim();
      const parts = afterColon.split(/\s+/);
      const pathPart = parts[0];
      const paramParts = parts.slice(1);

      const apiCommand = '/' + pathPart.replace(/\./g, '/');
      const params = paramParts
        .filter(p => p.includes('='))
        .map(p => `=${p.replace(/^["']|["']$/g, '')}`);

      return { apiCommand, params };
    }

    // 路径格式: "/category/operation param=value"
    if (trimmed.startsWith('/')) {
      const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      if (parts.length === 0) {
        return { apiCommand: '', params: [] };
      }

      const pathParts: string[] = [];
      const params: string[] = [];
      let foundFirstParam = false;

      for (const part of parts) {
        if (part.includes('=')) {
          foundFirstParam = true;
          const cleanPart = part.replace(/^["']|["']$/g, '');
          params.push(`=${cleanPart}`);
        } else if (!foundFirstParam) {
          pathParts.push(part);
        }
      }

      let apiCommand = '';
      for (const part of pathParts) {
        if (part.startsWith('/')) {
          apiCommand += part;
        } else {
          apiCommand += '/' + part;
        }
      }
      apiCommand = apiCommand.replace(/\/+/g, '/');

      return { apiCommand, params };
    }

    return { apiCommand: '', params: [] };
  }

  // ==================== 差异对比 ====================

  /**
   * 对比两个快照的差异
   */
  async compareSnapshots(idA: string, idB: string): Promise<SnapshotDiff> {
    await this.initialize();

    // 获取两个快照的内容
    const contentA = await this.downloadSnapshot(idA);
    const contentB = await this.downloadSnapshot(idB);

    // 解析配置为行数组
    const linesA = this.parseConfigLines(contentA);
    const linesB = this.parseConfigLines(contentB);

    // 计算差异
    const diff = this.computeDiff(linesA, linesB);

    // 构建差异结果
    const snapshotDiff: SnapshotDiff = {
      snapshotA: idA,
      snapshotB: idB,
      additions: diff.additions,
      modifications: diff.modifications,
      deletions: diff.deletions,
    };

    // 注意：对比快照是只读操作，不记录审计日志
    // Requirements: 7.1, 7.5 - 只读操作不产生审计记录

    return snapshotDiff;
  }

  /**
   * 解析配置内容为行数组
   */
  private parseConfigLines(content: string): Map<string, string> {
    const lines = new Map<string, string>();
    const rawLines = content.split('\n');

    for (const line of rawLines) {
      const trimmed = line.trim();
      // 跳过空行和注释
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // 跳过动态变化的统计数据（网口收发包等）
      if (this.shouldIgnoreLine(trimmed)) {
        continue;
      }

      // 使用行内容的哈希作为键（简化处理）
      // 实际上应该解析配置路径作为键
      const key = this.extractConfigKey(trimmed);
      // 对于需要规范化的行，移除动态字段后再存储
      const normalizedLine = this.normalizeConfigLine(trimmed);
      lines.set(key, normalizedLine);
    }

    return lines;
  }

  /**
   * 判断是否应该忽略该配置行
   * 忽略动态变化的统计数据，如网口收发包、流量统计等
   */
  private shouldIgnoreLine(line: string): boolean {
    // 完全忽略的行模式
    const ignorePatterns = [
      // 纯统计信息行
      /^\s*(?:rx|tx)-(?:byte|packet|error|drop)=/i,
      /^\s*(?:fp-rx|fp-tx)-(?:byte|packet)=/i,
    ];

    for (const pattern of ignorePatterns) {
      if (pattern.test(line)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 规范化配置行，移除动态变化的字段
   * 这样即使这些字段变化，也不会被识别为配置变更
   */
  private normalizeConfigLine(line: string): string {
    // 需要从行中移除的动态字段模式
    const dynamicFieldPatterns = [
      // 通用统计字段（防火墙规则、NAT、Mangle等都会有）
      /\s+bytes=\d+/gi,
      /\s+packets=\d+/gi,

      // 网口收发包统计
      /\s+rx-byte=\d+/gi,
      /\s+tx-byte=\d+/gi,
      /\s+rx-packet=\d+/gi,
      /\s+tx-packet=\d+/gi,
      /\s+rx-error=\d+/gi,
      /\s+tx-error=\d+/gi,
      /\s+rx-drop=\d+/gi,
      /\s+tx-drop=\d+/gi,
      /\s+fp-rx-byte=\d+/gi,
      /\s+fp-tx-byte=\d+/gi,
      /\s+fp-rx-packet=\d+/gi,
      /\s+fp-tx-packet=\d+/gi,
      /\s+tx-queue-drop=\d+/gi,

      // 链路状态时间（会随时间变化）
      /\s+last-link-up-time=[^\s]+/gi,
      /\s+last-link-down-time=[^\s]+/gi,
      /\s+link-downs=\d+/gi,

      // 连接跟踪统计
      /\s+connection-bytes=\d+/gi,
      /\s+connection-packets=\d+/gi,
      /\s+connection-rate=\d+/gi,

      // 队列统计
      /\s+queued-bytes=\d+/gi,
      /\s+queued-packets=\d+/gi,

      // 运行时间和计数器
      /\s+uptime=[^\s]+/gi,
      /\s+since=[^\s]+/gi,
      /\s+last-seen=[^\s]+/gi,
    ];

    let normalized = line;
    for (const pattern of dynamicFieldPatterns) {
      normalized = normalized.replace(pattern, '');
    }

    // 清理多余的空格
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
  }

  /**
   * 提取配置行的键
   */
  private extractConfigKey(line: string): string {
    // 尝试提取配置路径和标识符
    // 例如: "/ip address add address=192.168.1.1/24 interface=ether1"
    // 键应该是: "/ip/address/192.168.1.1/24"

    const parts = line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const pathParts: string[] = [];
    let identifier = '';

    for (const part of parts) {
      if (part.startsWith('/')) {
        pathParts.push(part);
      } else if (part === 'add' || part === 'set' || part === 'remove') {
        pathParts.push(part);
      } else if (part.includes('=')) {
        // 提取可能的标识符（如 name=, address=, .id=）
        const [key, value] = part.split('=', 2);
        if (key === 'name' || key === 'address' || key === '.id' || key === 'comment') {
          identifier = value.replace(/^["']|["']$/g, '');
          break;
        }
      }
    }

    const basePath = pathParts.join('/').replace(/\/+/g, '/');
    return identifier ? `${basePath}:${identifier}` : `${basePath}:${line.substring(0, 50)}`;
  }

  /**
   * 计算两个配置的差异
   */
  private computeDiff(
    linesA: Map<string, string>,
    linesB: Map<string, string>
  ): {
    additions: string[];
    modifications: Array<{ path: string; oldValue: string; newValue: string }>;
    deletions: string[];
  } {
    const additions: string[] = [];
    const modifications: Array<{ path: string; oldValue: string; newValue: string }> = [];
    const deletions: string[] = [];

    // 查找新增和修改
    for (const [key, valueB] of linesB) {
      const valueA = linesA.get(key);
      if (valueA === undefined) {
        // 新增
        additions.push(valueB);
      } else if (valueA !== valueB) {
        // 修改
        modifications.push({
          path: key,
          oldValue: valueA,
          newValue: valueB,
        });
      }
    }

    // 查找删除
    for (const [key, valueA] of linesA) {
      if (!linesB.has(key)) {
        deletions.push(valueA);
      }
    }

    return { additions, modifications, deletions };
  }

  /**
   * 获取最新的差异（与上一个快照对比）
   */
  async getLatestDiff(): Promise<SnapshotDiff | null> {
    await this.initialize();

    if (this.snapshots.length < 2) {
      return null;
    }

    // 获取最新的两个快照
    const sorted = [...this.snapshots].sort((a, b) => b.timestamp - a.timestamp);
    const latest = sorted[0];
    const previous = sorted[1];

    return this.compareSnapshots(previous.id, latest.id);
  }


  // ==================== 危险变更检测 ====================

  /**
   * 检测危险配置变更
   */
  detectDangerousChanges(diff: SnapshotDiff): DangerousChangesResult {
    const detectedPatterns: Array<{
      name: string;
      description: string;
      riskLevel: RiskLevel;
      matchedLines: string[];
    }> = [];

    // 合并所有变更行
    const allChanges = [
      ...diff.additions.map((line) => `+ ${line}`),
      ...diff.deletions.map((line) => `- ${line}`),
      ...diff.modifications.map((m) => `~ ${m.oldValue} -> ${m.newValue}`),
    ];

    // 检查每个危险模式
    for (const pattern of DANGEROUS_PATTERNS) {
      const matchedLines: string[] = [];

      for (const change of allChanges) {
        for (const regex of pattern.patterns) {
          if (regex.test(change)) {
            matchedLines.push(change);
            break;
          }
        }
      }

      if (matchedLines.length > 0) {
        detectedPatterns.push({
          name: pattern.name,
          description: pattern.description,
          riskLevel: pattern.riskLevel,
          matchedLines,
        });
      }
    }

    // 计算总体风险级别
    let overallRiskLevel: RiskLevel = 'low';
    for (const detected of detectedPatterns) {
      if (detected.riskLevel === 'high') {
        overallRiskLevel = 'high';
        break;
      } else if (detected.riskLevel === 'medium') {
        // 只有当当前总体风险级别不是 high 时才升级到 medium
        if (overallRiskLevel === 'low') {
          overallRiskLevel = 'medium';
        }
      }
    }

    return {
      detected: detectedPatterns.length > 0,
      patterns: detectedPatterns,
      overallRiskLevel,
    };
  }

  /**
   * 触发危险变更告警
   * 当检测到危险配置变更时，记录审计日志并可选择性地触发通知
   */
  async triggerDangerousChangeAlert(
    diff: SnapshotDiff,
    dangerousChanges: DangerousChangesResult
  ): Promise<void> {
    if (!dangerousChanges.detected) {
      return;
    }

    const riskText = {
      low: '低风险',
      medium: '中等风险',
      high: '高风险',
    };

    // 构建告警消息
    const patternNames = dangerousChanges.patterns.map((p) => p.description).join('、');
    const message = `检测到${riskText[dangerousChanges.overallRiskLevel]}配置变更: ${patternNames}`;

    // 记录到审计日志
    await auditLogger.log({
      action: 'config_change',
      actor: 'system',
      details: {
        trigger: 'dangerous_change_detection',
        metadata: {
          snapshotA: diff.snapshotA,
          snapshotB: diff.snapshotB,
          riskLevel: dangerousChanges.overallRiskLevel,
          patterns: dangerousChanges.patterns.map((p) => ({
            name: p.name,
            description: p.description,
            riskLevel: p.riskLevel,
            matchCount: p.matchedLines.length,
          })),
          message,
        },
      },
    });

    logger.warn(`Dangerous config change detected: ${message}`);

    // TODO: 集成 NotificationService 发送告警通知
    // 可以在这里调用 notificationService.send() 发送告警
  }

  /**
   * 分析配置差异并添加 AI 分析（占位实现）
   */
  async analyzeConfigDiff(diff: SnapshotDiff): Promise<SnapshotDiff> {
    // 检测危险变更
    const dangerousChanges = this.detectDangerousChanges(diff);

    // 生成基础分析
    const summary = this.generateDiffSummary(diff, dangerousChanges);
    const recommendations = this.generateRecommendations(diff, dangerousChanges);

    // 添加 AI 分析结果
    diff.aiAnalysis = {
      riskLevel: dangerousChanges.overallRiskLevel,
      summary,
      recommendations,
    };

    return diff;
  }

  /**
   * 生成差异摘要
   */
  private generateDiffSummary(
    diff: SnapshotDiff,
    dangerousChanges: DangerousChangesResult
  ): string {
    const parts: string[] = [];

    if (diff.additions.length > 0) {
      parts.push(`新增 ${diff.additions.length} 项配置`);
    }
    if (diff.modifications.length > 0) {
      parts.push(`修改 ${diff.modifications.length} 项配置`);
    }
    if (diff.deletions.length > 0) {
      parts.push(`删除 ${diff.deletions.length} 项配置`);
    }

    if (parts.length === 0) {
      return '无配置变更';
    }

    let summary = parts.join('，') + '。';

    if (dangerousChanges.detected) {
      const riskText = {
        low: '低风险',
        medium: '中等风险',
        high: '高风险',
      };
      summary += ` 检测到 ${dangerousChanges.patterns.length} 个${riskText[dangerousChanges.overallRiskLevel]}变更模式。`;
    }

    return summary;
  }

  /**
   * 生成建议
   */
  private generateRecommendations(
    diff: SnapshotDiff,
    dangerousChanges: DangerousChangesResult
  ): string[] {
    const recommendations: string[] = [];

    if (dangerousChanges.detected) {
      for (const pattern of dangerousChanges.patterns) {
        switch (pattern.name) {
          case 'firewall_rule_deletion':
            recommendations.push('检测到防火墙规则变更，请确认这些变更不会影响网络安全');
            break;
          case 'password_change':
            recommendations.push('检测到密码变更，请确保新密码符合安全策略');
            break;
          case 'admin_user_change':
            recommendations.push('检测到管理员用户变更，请确认授权操作');
            break;
          case 'interface_disable':
            recommendations.push('检测到接口禁用操作，请确认不会影响网络连通性');
            break;
          case 'routing_change':
            recommendations.push('检测到路由配置变更，请验证网络可达性');
            break;
          case 'system_reset':
            recommendations.push('检测到系统重置/重启操作，请确认这是预期行为');
            break;
          default:
            recommendations.push(`检测到 ${pattern.description}，请仔细审查变更内容`);
        }
      }
    }

    if (diff.deletions.length > 5) {
      recommendations.push('删除了较多配置项，建议在执行前创建备份');
    }

    if (recommendations.length === 0) {
      recommendations.push('配置变更看起来是安全的，但仍建议在生产环境应用前进行测试');
    }

    return recommendations;
  }

  /**
   * 获取变更历史时间线
   */
  async getChangeTimeline(limit?: number): Promise<Array<{
    snapshot: ConfigSnapshot;
    diff?: SnapshotDiff;
    dangerousChanges?: DangerousChangesResult;
  }>> {
    await this.initialize();

    const sorted = [...this.snapshots].sort((a, b) => b.timestamp - a.timestamp);
    const limited = limit ? sorted.slice(0, limit) : sorted;

    const timeline: Array<{
      snapshot: ConfigSnapshot;
      diff?: SnapshotDiff;
      dangerousChanges?: DangerousChangesResult;
    }> = [];

    for (let i = 0; i < limited.length; i++) {
      const snapshot = limited[i];
      let diff: SnapshotDiff | undefined;
      let dangerousChanges: DangerousChangesResult | undefined;

      // 如果不是最后一个快照，计算与下一个（更旧的）快照的差异
      if (i < limited.length - 1) {
        const previousSnapshot = limited[i + 1];
        try {
          diff = await this.compareSnapshots(previousSnapshot.id, snapshot.id);
          dangerousChanges = this.detectDangerousChanges(diff);
        } catch (error) {
          logger.warn(`Failed to compute diff for snapshot ${snapshot.id}:`, error);
        }
      }

      timeline.push({ snapshot, diff, dangerousChanges });
    }

    return timeline;
  }
}

// 导出单例实例
export const configSnapshotService = new ConfigSnapshotService();
