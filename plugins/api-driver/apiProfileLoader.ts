/**
 * ApiProfileLoader — API Profile 加载器
 *
 * 启动时从文件 seed → 数据库导入 → LRUCache 缓存。
 * 运行时数据库为唯一真理之源。
 * getProfile 使用 Promise-based single-flight 防止 Thundering Herd。
 *
 * Requirements: A2.6, A2.7
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ApiProfile } from './types';
import type { DataStore } from '../../backend/src/services/dataStore';

const DEFAULT_CACHE_SIZE = 50;
const DEFAULT_SCAN_INTERVAL_MS = 30000;

export class ApiProfileLoader {
  private cache: Map<string, ApiProfile> = new Map();
  private maxCacheSize: number;
  private pgDataStore: DataStore | null = null;
  /** In-flight promises for single-flight pattern */
  private inflight: Map<string, Promise<ApiProfile | null>> = new Map();
  private scanTimer: NodeJS.Timeout | null = null;
  private profileDirs: string[] = [];

  constructor(options?: { maxCacheSize?: number }) {
    this.maxCacheSize = options?.maxCacheSize ?? DEFAULT_CACHE_SIZE;
  }

  setPgDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
  }

  /**
   * 初始化：扫描文件目录 seed 到数据库
   */
  async initialize(profileDirs: string[]): Promise<void> {
    this.profileDirs = profileDirs;
    await this.seedFromFiles();
  }

  /**
   * 获取 Profile（single-flight 模式）
   */
  async getProfile(profileId: string): Promise<ApiProfile | null> {
    // 1. 缓存命中
    const cached = this.cache.get(profileId);
    if (cached) return cached;

    // 2. Single-flight: 如果已有相同请求在飞行中，复用
    const existing = this.inflight.get(profileId);
    if (existing) return existing;

    // 3. 从数据库加载
    const promise = this.loadFromDb(profileId).then(profile => {
      this.inflight.delete(profileId);
      if (profile) this.putCache(profileId, profile);
      return profile;
    }).catch(err => {
      this.inflight.delete(profileId);
      throw err;
    });

    this.inflight.set(profileId, promise);
    return promise;
  }

  /**
   * 获取所有 Profile
   */
  async getAllProfiles(): Promise<ApiProfile[]> {
    if (!this.pgDataStore) return Array.from(this.cache.values());

    const rows = await this.pgDataStore.query<{
      profile_id: string; display_name: string; config: ApiProfile;
    }>('SELECT profile_id, display_name, config FROM api_profiles ORDER BY display_name');

    return rows.map(r => {
      const profile = typeof r.config === 'string' ? JSON.parse(r.config) : r.config;
      return { ...profile, profileId: r.profile_id, displayName: r.display_name };
    });
  }

  /**
   * 保存 Profile 到数据库
   */
  async saveProfile(profile: ApiProfile): Promise<void> {
    if (!this.pgDataStore) {
      this.putCache(profile.profileId, profile);
      return;
    }

    const manifest = {
      vendor: profile.vendor,
      model: profile.model,
      endpoints: profile.endpoints.length,
      metricsCapabilities: Object.keys(profile.metricsEndpoints || {}),
      dataCapabilities: Object.keys(profile.dataEndpoints || {}),
    };

    await this.pgDataStore.execute(
      `INSERT INTO api_profiles (profile_id, display_name, config, capability_manifest, is_builtin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, false, NOW(), NOW())
       ON CONFLICT (profile_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, config = EXCLUDED.config,
         capability_manifest = EXCLUDED.capability_manifest, updated_at = NOW()`,
      [profile.profileId, profile.displayName, JSON.stringify(profile), JSON.stringify(manifest)]
    );

    this.putCache(profile.profileId, profile);
  }

  /**
   * 启动热加载扫描
   */
  startHotReload(intervalMs: number = DEFAULT_SCAN_INTERVAL_MS): void {
    this.stopHotReload();
    this.scanTimer = setInterval(() => {
      this.seedFromFiles().catch(() => {});
    }, intervalMs);
  }

  stopHotReload(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async loadFromDb(profileId: string): Promise<ApiProfile | null> {
    if (!this.pgDataStore) return null;

    const row = await this.pgDataStore.queryOne<{ config: ApiProfile }>(
      'SELECT config FROM api_profiles WHERE profile_id = $1', [profileId]
    );

    if (!row) return null;
    return typeof row.config === 'string' ? JSON.parse(row.config as any) : row.config;
  }

  private async seedFromFiles(): Promise<void> {
    for (const dir of this.profileDirs) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const profile: ApiProfile = JSON.parse(content);
          if (profile.profileId) {
            await this.saveProfile(profile);
          }
        } catch {
          // skip invalid files
        }
      }
    }
  }

  private putCache(key: string, value: ApiProfile): void {
    if (this.cache.size >= this.maxCacheSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

export const apiProfileLoader = new ApiProfileLoader();
