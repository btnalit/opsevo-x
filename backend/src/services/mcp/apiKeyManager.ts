/**
 * ApiKeyManager - MCP Server API Key CRUD + 加密存储
 *
 * 管理 MCP Server 的 API Key 生命周期：创建、验证、撤销、列表
 * 使用 CryptoService (AES-256) 加密存储，async-mutex 防止并发竞态
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

import { Mutex } from 'async-mutex';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { cryptoService } from '../ai/cryptoService';
import { logger } from '../../utils/logger';
import type { DataStore } from '../dataStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McpApiKey {
  id: string;
  keyHash: string;           // CryptoService 加密后的 Key
  keyPrefix: string;         // 明文前 8 位（如 mcp_a1b2），用于验证时快速过滤
  tenantId: string;
  role: 'admin' | 'operator' | 'viewer';
  label: string;
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt?: number;
}

export interface SecurityContext {
  tenantId: string;
  role: 'admin' | 'operator' | 'viewer';
  apiKeyId: string;
  clientId?: string;
}

// ─── ApiKeyManager ───────────────────────────────────────────────────────────

export class ApiKeyManager {
  private dataStore: DataStore | null = null;
  private writeMutex: Mutex;

  constructor() {
    this.writeMutex = new Mutex();
  }

  /**
   * 注入 DataStore（PostgreSQL），启用持久化
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('[ApiKeyManager] DataStore injected, using PostgreSQL for API key storage');
  }

  /**
   * 读取所有 Key（从 PostgreSQL）
   */
  private async readKeys(): Promise<McpApiKey[]> {
    if (!this.dataStore) {
      logger.warn('[ApiKeyManager] No DataStore configured, returning empty key list');
      return [];
    }
    const rows = await this.dataStore.query<{
      id: string;
      key_hash: string;
      key_prefix: string;
      tenant_id: string;
      role: string;
      label: string;
      status: string;
      created_at: number;
      revoked_at: number | null;
    }>('SELECT id, key_hash, key_prefix, tenant_id, role, label, status, created_at, revoked_at FROM mcp_api_keys');
    return rows.map(r => ({
      id: r.id,
      keyHash: r.key_hash,
      keyPrefix: r.key_prefix,
      tenantId: r.tenant_id,
      role: r.role as McpApiKey['role'],
      label: r.label,
      status: r.status as McpApiKey['status'],
      createdAt: r.created_at,
      revokedAt: r.revoked_at ?? undefined,
    }));
  }

  /**
   * 创建新的 API Key
   * 返回明文 Key（仅此一次）和元数据
   */
  async createKey(
    tenantId: string,
    role: McpApiKey['role'],
    label: string
  ): Promise<{ key: string; metadata: Omit<McpApiKey, 'keyHash'> }> {
    if (!this.dataStore) {
      throw new Error('ApiKeyManager: DataStore not configured');
    }

    return this.writeMutex.runExclusive(async () => {
      // 生成明文 Key: mcp_ 前缀 + UUID
      const rawKey = `mcp_${uuidv4().replace(/-/g, '')}`;
      const keyPrefix = rawKey.substring(0, 8);
      const keyHash = cryptoService.encrypt(rawKey);
      const id = uuidv4();
      const now = Date.now();

      await this.dataStore!.execute(
        `INSERT INTO mcp_api_keys (id, key_hash, key_prefix, tenant_id, role, label, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, keyHash, keyPrefix, tenantId, role, label, 'active', now]
      );

      logger.info(`[ApiKeyManager] Created API Key: id=${id}, tenant=${tenantId}, role=${role}, label=${label}`);

      const metadata: Omit<McpApiKey, 'keyHash'> = {
        id, keyPrefix, tenantId, role, label, status: 'active', createdAt: now,
      };
      return { key: rawKey, metadata };
    });
  }

  /**
   * 撤销 API Key — 立即生效
   */
  async revokeKey(keyId: string): Promise<void> {
    if (!this.dataStore) {
      throw new Error('ApiKeyManager: DataStore not configured');
    }

    return this.writeMutex.runExclusive(async () => {
      const key = await this.dataStore!.queryOne<{ id: string; status: string }>(
        'SELECT id, status FROM mcp_api_keys WHERE id = $1',
        [keyId]
      );

      if (!key) {
        throw new Error(`API Key not found: ${keyId}`);
      }

      if (key.status === 'revoked') {
        logger.warn(`[ApiKeyManager] Key already revoked: ${keyId}`);
        return;
      }

      await this.dataStore!.execute(
        'UPDATE mcp_api_keys SET status = $1, revoked_at = $2 WHERE id = $3',
        ['revoked', Date.now(), keyId]
      );

      logger.info(`[ApiKeyManager] Revoked API Key: id=${keyId}`);
    });
  }

  /**
   * 列出所有 Key 元数据（排除 keyHash）
   */
  async listKeys(): Promise<Omit<McpApiKey, 'keyHash'>[]> {
    const keys = await this.readKeys();
    return keys.map(({ keyHash: _, ...rest }) => rest);
  }

  /**
   * 验证 API Key — 恒定时间比较，防定时攻击
   * 返回 SecurityContext 或 null
   */
  async validateKey(rawKey: string): Promise<SecurityContext | null> {
    if (!rawKey || typeof rawKey !== 'string') {
      return null;
    }

    const keys = await this.readKeys();
    const prefix = rawKey.substring(0, 8);

    // 按 keyPrefix 快速过滤 active 候选集
    const candidates = keys.filter(
      k => k.status === 'active' && k.keyPrefix === prefix
    );

    for (const candidate of candidates) {
      try {
        const decrypted = cryptoService.decrypt(candidate.keyHash);
        // 恒定时间比较
        const a = Buffer.from(rawKey, 'utf-8');
        const b = Buffer.from(decrypted, 'utf-8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          return {
            tenantId: candidate.tenantId,
            role: candidate.role,
            apiKeyId: candidate.id,
          };
        }
      } catch {
        // 解密失败，跳过此候选
        continue;
      }
    }

    return null;
  }
}

// ─── 单例 ────────────────────────────────────────────────────────────────────

export const apiKeyManager = new ApiKeyManager();
