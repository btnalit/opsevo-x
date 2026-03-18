/**
 * FaultPatternLibrary — 故障模式库
 *
 * 存储已知的故障模式、根因分析路径和推荐修复方案，
 * 供 FaultHealer 和 AlertPipeline 的分析阶段使用。
 *
 * 通过 LearningOrchestrator 的反馈闭环持续更新：
 * - 成功修复的案例自动提取为新的故障模式（pending_review）
 * - 失败案例标记为需人工审核
 *
 * Requirements: H4.15, H4.16
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import type {
  FaultPattern,
  FaultPatternStatus,
  FaultPatternSource,
  AnalysisResult,
  HealResult,
} from '../../types/ai-ops';
import type { DataStore } from '../dataStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 故障模式过滤条件 */
export interface FaultPatternFilter {
  status?: FaultPatternStatus;
  source?: FaultPatternSource;
  deviceId?: string;
  tenantId?: string;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const LIBRARY_DIR = path.join(DATA_DIR, 'pattern-library');
const LIBRARY_FILE = path.join(LIBRARY_DIR, 'patterns.json');

// ---------------------------------------------------------------------------
// FaultPatternLibrary
// ---------------------------------------------------------------------------

export class FaultPatternLibrary {
  private dataStore: DataStore | null = null;
  private patterns: FaultPattern[] = [];
  private initialized = false;

  // ==================== Dependency Injection ====================

  /** 注入 DataStore（PostgreSQL），注入后优先使用 PostgreSQL */
  setDataStore(ds: DataStore): void {
    this.dataStore = ds;
    logger.info('[FaultPatternLibrary] DataStore injected');
  }

  // ==================== Initialization ====================

  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(LIBRARY_DIR, { recursive: true });
    } catch (error) {
      logger.error('[FaultPatternLibrary] Failed to create data directory:', error);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDataDir();
    await this.loadPatterns();
    this.initialized = true;
    logger.info('[FaultPatternLibrary] Initialized');
  }

  private async loadPatterns(): Promise<void> {
    try {
      const data = await fs.readFile(LIBRARY_FILE, 'utf-8');
      this.patterns = JSON.parse(data) as FaultPattern[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.patterns = [];
        await this.savePatterns();
      } else {
        logger.error('[FaultPatternLibrary] Failed to load patterns:', error);
        this.patterns = [];
      }
    }
  }

  private async savePatterns(): Promise<void> {
    await this.ensureDataDir();
    await fs.writeFile(LIBRARY_FILE, JSON.stringify(this.patterns, null, 2), 'utf-8');
  }

  // ==================== H4.15: 故障模式匹配 ====================

  /**
   * 根据分析结果匹配故障模式。
   * 使用关键词匹配：将 analysis.summary 和 analysis.details 中的词
   * 与模式的 name/description 进行比对，返回第一个 active + enabled 的匹配。
   */
  async findMatch(analysis: AnalysisResult): Promise<FaultPattern | null> {
    await this.initialize();

    const searchText = [
      analysis.summary ?? '',
      analysis.details ?? '',
      ...(analysis.recommendations ?? []),
    ]
      .join(' ')
      .toLowerCase();

    if (!searchText.trim()) {
      return null;
    }

    // 提取关键词（去除常见停用词，取长度 >= 2 的词）
    const keywords = searchText
      .split(/[\s,.:;!?/\\|()[\]{}<>]+/)
      .filter((w) => w.length >= 2);

    if (keywords.length === 0) {
      return null;
    }

    let bestMatch: FaultPattern | null = null;
    let bestScore = 0;

    for (const pattern of this.patterns) {
      // 只匹配 active + enabled 的模式
      if (!pattern.enabled) continue;
      if (pattern.status && pattern.status !== 'active') continue;

      const patternText = `${pattern.name} ${pattern.description}`.toLowerCase();

      let score = 0;
      for (const kw of keywords) {
        if (patternText.includes(kw)) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = pattern;
      }
    }

    // 至少需要 1 个关键词匹配
    if (bestScore < 1) {
      return null;
    }

    logger.info(
      `[FaultPatternLibrary] Matched pattern "${bestMatch!.name}" (score=${bestScore}) for analysis: "${analysis.summary?.substring(0, 80)}"`,
    );
    return bestMatch;
  }

  // ==================== H4.16: 反馈闭环更新 ====================

  /**
   * 从成功修复中提取新模式（status=pending_review, source=learned）。
   * 成功修复的案例自动提取为新的故障模式，等待人工审核后激活。
   */
  async addFromSuccessfulRepair(healResult: HealResult): Promise<void> {
    if (!healResult.success) {
      logger.warn('[FaultPatternLibrary] addFromSuccessfulRepair called with unsuccessful result, skipping');
      return;
    }

    const successSteps = healResult.steps.filter((s) => s.success);
    if (successSteps.length === 0) {
      return;
    }

    const description = successSteps
      .map((s) => s.description)
      .join('; ');

    const remediationScript = successSteps
      .map((s) => `# ${s.description}`)
      .join('\n');

    const now = Date.now();
    const newPattern: FaultPattern = {
      id: uuidv4(),
      name: `Learned: repair ${healResult.planId ?? 'unknown'}`,
      description: `Auto-extracted from successful repair (duration: ${healResult.duration}ms). Steps: ${description}`,
      enabled: false, // 待审核，不自动启用
      status: 'pending_review',
      source: 'learned',
      autoHeal: false,
      builtin: false,
      conditions: [],
      remediationScript,
      createdAt: now,
      updatedAt: now,
    };

    await this.create(newPattern);
    logger.info(
      `[FaultPatternLibrary] Extracted new pattern from successful repair: ${newPattern.id} (planId=${healResult.planId})`,
    );
  }

  /**
   * 标记失败修复案例为待审核。
   * 记录失败的修复结果，供人工审核分析。
   */
  async markForReview(healResult: HealResult): Promise<void> {
    const failedSteps = healResult.steps.filter((s) => !s.success);
    const description = failedSteps
      .map((s) => `${s.description}: ${s.error ?? 'unknown error'}`)
      .join('; ');

    const now = Date.now();
    const reviewPattern: FaultPattern = {
      id: uuidv4(),
      name: `Review: failed repair ${healResult.planId ?? 'unknown'}`,
      description: `Failed repair case for review (error: ${healResult.error ?? 'unknown'}). Failed steps: ${description}`,
      enabled: false,
      status: 'pending_review',
      source: 'learned',
      autoHeal: false,
      builtin: false,
      conditions: [],
      remediationScript: '',
      createdAt: now,
      updatedAt: now,
    };

    await this.create(reviewPattern);
    logger.info(
      `[FaultPatternLibrary] Marked failed repair for review: ${reviewPattern.id} (planId=${healResult.planId}, error=${healResult.error})`,
    );
  }

  // ==================== CRUD ====================

  async create(pattern: FaultPattern): Promise<void> {
    await this.initialize();

    // 确保必要字段
    if (!pattern.id) {
      pattern.id = uuidv4();
    }
    if (!pattern.createdAt) {
      pattern.createdAt = Date.now();
    }
    if (!pattern.updatedAt) {
      pattern.updatedAt = Date.now();
    }

    this.patterns.push(pattern);
    await this.savePatterns();
    logger.debug(`[FaultPatternLibrary] Created pattern: ${pattern.name} (${pattern.id})`);
  }

  async update(patternId: string, updates: Partial<FaultPattern>): Promise<void> {
    await this.initialize();

    const index = this.patterns.findIndex((p) => p.id === patternId);
    if (index === -1) {
      throw new Error(`[FaultPatternLibrary] Pattern not found: ${patternId}`);
    }

    this.patterns[index] = {
      ...this.patterns[index],
      ...updates,
      id: patternId, // id 不可变
      updatedAt: Date.now(),
    };

    await this.savePatterns();
    logger.debug(`[FaultPatternLibrary] Updated pattern: ${patternId}`);
  }

  async delete(patternId: string): Promise<void> {
    await this.initialize();

    const index = this.patterns.findIndex((p) => p.id === patternId);
    if (index === -1) {
      throw new Error(`[FaultPatternLibrary] Pattern not found: ${patternId}`);
    }

    const pattern = this.patterns[index];
    if (pattern.builtin) {
      throw new Error('[FaultPatternLibrary] Cannot delete builtin pattern');
    }

    this.patterns.splice(index, 1);
    await this.savePatterns();
    logger.debug(`[FaultPatternLibrary] Deleted pattern: ${patternId}`);
  }

  async list(filter?: FaultPatternFilter): Promise<FaultPattern[]> {
    await this.initialize();

    let result = [...this.patterns];

    if (filter) {
      if (filter.status !== undefined) {
        result = result.filter((p) => p.status === filter.status);
      }
      if (filter.source !== undefined) {
        result = result.filter((p) => p.source === filter.source);
      }
      if (filter.deviceId !== undefined) {
        result = result.filter((p) => !p.deviceId || p.deviceId === filter.deviceId);
      }
      if (filter.tenantId !== undefined) {
        result = result.filter((p) => !p.tenantId || p.tenantId === filter.tenantId);
      }
      if (filter.enabled !== undefined) {
        result = result.filter((p) => p.enabled === filter.enabled);
      }
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const faultPatternLibrary = new FaultPatternLibrary();
