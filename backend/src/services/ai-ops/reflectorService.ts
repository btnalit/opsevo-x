/**
 * ReflectorService 反思服务
 * 负责深度反思，决定下一步行动，提取可学习经验
 *
 * Requirements: 5.1-7.5, 18.3, 18.4
 * - 5.1-5.5: 深度反思分析
 * - 6.1-6.7: 行动决策
 * - 7.1-7.5: 学习提取和持久化
 * - 18.3, 18.4: 统计功能
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import {
  EvaluationReport,
  ReflectionResult,
  ReflectionContext,
  NextAction,
  LearningEntry,
  IterationState,
  ReflectorStats,
  IReflectorService,
  RemediationPlan,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { aiAnalyzer } from './aiAnalyzer';
import { auditLogger } from './auditLogger';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const LEARNING_DIR = path.join(DATA_DIR, 'learning');
const ENTRIES_DIR = path.join(LEARNING_DIR, 'entries');
const INDEX_FILE = path.join(LEARNING_DIR, 'index.json');

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 向后兼容：为缺少新字段的 LearningEntry 补充默认值
 * Requirements: conversation-and-reflection-optimization 5.3
 */
export function ensureLearningEntryDefaults(entry: Partial<LearningEntry>): LearningEntry {
  return {
    ...entry,
    feedbackPositiveCount: entry.feedbackPositiveCount ?? 0,
    feedbackNegativeCount: entry.feedbackNegativeCount ?? 0,
    status: entry.status ?? 'active',
  } as LearningEntry;
}

/**
 * 学习条目索引
 */
interface LearningIndex {
  entries: Array<{
    id: string;
    timestamp: number;
    failurePattern: string;
    dateFile: string;
  }>;
  lastUpdated: number;
}

export class ReflectorService implements IReflectorService {
  private initialized = false;
  private learningIndex: LearningIndex = { entries: [], lastUpdated: 0 };
  /** 🔴 FIX (Missing Declaration): 学习条目内存缓存 */
  private learningCache: Map<string, LearningEntry> = new Map();

  // 🟡 FIX (Gemini audit): 文件写入锁，防止并发 saveEntry 导致的 Read-Modify-Write 竞态
  private writeQueue: Map<string, Promise<any>> = new Map();

  // 缓存清理定时器
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  // 文件归档清理定时器
  private fileCleanupTimer: NodeJS.Timeout | null = null;

  // 学习条目文件保留天数
  private readonly FILE_RETENTION_DAYS = 90;

  // 最大缓存条目数
  private readonly MAX_CACHE_SIZE = 200;

  // 缓存 TTL（24 小时）
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // 知识库服务引用（延迟加载避免循环依赖）
  private knowledgeBase: typeof import('./rag').knowledgeBase | null = null;

  // 事件发射器 - 用于 SSE 实时推送学习事件
  public readonly events = new EventEmitter();

  /**
   * 获取知识库服务
   */
  private async getKnowledgeBase() {
    if (!this.knowledgeBase) {
      const { knowledgeBase } = await import('./rag');
      this.knowledgeBase = knowledgeBase;
    }
    // 🔴 FIX: 确保 KB 已初始化后再返回
    // 之前缺少此检查，导致 persistLearning 中 kb.add()/kb.search() 调用
    // ensureInitialized() 抛异常，反思记录无法写入知识库
    if (!this.knowledgeBase.isInitialized()) {
      await this.knowledgeBase.initialize();
    }
    return this.knowledgeBase;
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDirs(): Promise<void> {
    try {
      await fs.mkdir(ENTRIES_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create learning directories:', error);
    }
  }

  /**
   * 初始化服务
   * Requirements: 20.3
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDataDirs();
    await this.loadIndex();
    await this.loadRecentEntries();

    // 启动缓存清理定时器
    this.startCacheCleanupTimer();

    // 启动文件归档清理定时器（每24小时清理过期文件，启动时立即执行一次）
    this.startFileCleanupTimer();

    this.initialized = true;
    logger.info('ReflectorService initialized');
  }

  /**
   * 启动缓存清理定时器
   */
  private startCacheCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
    }

    const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
    this.cacheCleanupTimer = setInterval(() => {
      this.cleanupExpiredCache();
    }, CLEANUP_INTERVAL_MS);

    logger.debug('ReflectorService cache cleanup timer started');
  }

  /**
   * 停止缓存清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.debug('ReflectorService cache cleanup timer stopped');
    }
    if (this.fileCleanupTimer) {
      clearInterval(this.fileCleanupTimer);
      this.fileCleanupTimer = null;
      logger.debug('ReflectorService file cleanup timer stopped');
    }
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    // FIX: 收集所有条目并按时间排序，确保至少保留 MIN_RETAIN_COUNT 条最新记录
    // 原来的逻辑会把超过24小时的全部删除，导致 queryLearning('') 返回空 → 反思记录消失
    const MIN_RETAIN_COUNT = 20;

    const expiredIds: string[] = [];
    for (const [id, entry] of this.learningCache) {
      if (now - entry.timestamp > this.CACHE_TTL_MS) {
        expiredIds.push(id);
      }
    }

    // 只有当删除后仍能保留足够条目时才执行清理
    const remainAfterExpiry = this.learningCache.size - expiredIds.length;
    if (remainAfterExpiry >= MIN_RETAIN_COUNT) {
      // 安全删除所有过期条目
      for (const id of expiredIds) {
        this.learningCache.delete(id);
        cleanedCount++;
      }
    } else {
      // 过期条目太多，只删除最旧的，保留 MIN_RETAIN_COUNT 条
      const allEntries = Array.from(this.learningCache.entries())
        .sort((a, b) => b[1].timestamp - a[1].timestamp); // 最新在前

      const toKeep = new Set(allEntries.slice(0, MIN_RETAIN_COUNT).map(([id]) => id));
      for (const id of expiredIds) {
        if (!toKeep.has(id)) {
          this.learningCache.delete(id);
          cleanedCount++;
        }
      }
    }

    // 超出最大缓存大小时，删除最旧的
    if (this.learningCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.learningCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, this.learningCache.size - this.MAX_CACHE_SIZE);
      for (const [id] of toRemove) {
        this.learningCache.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`ReflectorService cleaned up ${cleanedCount} expired cache entries, ${this.learningCache.size} remaining`);
    }
  }


  /**
   * 启动文件归档清理定时器
   * 每24小时清理超过 FILE_RETENTION_DAYS 天的学习条目文件
   */
  private startFileCleanupTimer(): void {
    if (this.fileCleanupTimer) {
      clearInterval(this.fileCleanupTimer);
    }

    // 启动时立即清理一次
    this.cleanupOldEntryFiles().catch(err => {
      logger.error('Initial learning entry file cleanup failed:', err);
    });

    // 每24小时执行一次
    const DAILY_MS = 24 * 60 * 60 * 1000;
    this.fileCleanupTimer = setInterval(() => {
      this.cleanupOldEntryFiles().catch(err => {
        logger.error('Scheduled learning entry file cleanup failed:', err);
      });
    }, DAILY_MS);

    logger.debug('ReflectorService file cleanup timer started');
  }

  /**
   * 清理过期的学习条目文件
   * 删除 ENTRIES_DIR 中超过 FILE_RETENTION_DAYS 天的 JSON 文件
   * 同时清理索引中对应的过期条目
   */
  private async cleanupOldEntryFiles(): Promise<void> {
    try {
      const files = await fs.readdir(ENTRIES_DIR);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.FILE_RETENTION_DAYS);
      const cutoffStr = cutoffDate.toISOString().split('T')[0];

      let deletedCount = 0;
      for (const file of files) {
        if (!file.endsWith('.json') || file === '.gitkeep') continue;
        // 文件名格式: YYYY-MM-DD.json
        const dateStr = file.replace('.json', '');
        if (dateStr < cutoffStr) {
          await fs.unlink(path.join(ENTRIES_DIR, file));
          deletedCount++;
        }
      }

      // 同步清理索引中的过期条目
      if (deletedCount > 0) {
        const cutoffTs = cutoffDate.getTime();
        const beforeCount = this.learningIndex.entries.length;
        this.learningIndex.entries = this.learningIndex.entries.filter(e => e.timestamp >= cutoffTs);
        this.learningIndex.lastUpdated = Date.now();
        try {
          await fs.writeFile(INDEX_FILE, JSON.stringify(this.learningIndex, null, 2), 'utf-8');
        } catch { /* index write failure is non-critical */ }

        logger.info(`ReflectorService cleaned up ${deletedCount} old entry files (>${this.FILE_RETENTION_DAYS} days), pruned ${beforeCount - this.learningIndex.entries.length} index entries`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to cleanup old learning entry files:', error);
      }
    }
  }

  /**
   * 加载索引
   */
  private async loadIndex(): Promise<void> {
    try {
      const content = await fs.readFile(INDEX_FILE, 'utf-8');
      this.learningIndex = JSON.parse(content);
      logger.info(`Loaded learning index with ${this.learningIndex.entries.length} entries`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load learning index:', error);
      }
      this.learningIndex = { entries: [], lastUpdated: Date.now() };
    }
  }

  /**
   * 保存索引
   */
  private async saveIndex(): Promise<void> {
    await this.ensureDataDirs();
    this.learningIndex.lastUpdated = Date.now();
    await fs.writeFile(INDEX_FILE, JSON.stringify(this.learningIndex, null, 2), 'utf-8');
  }

  /**
   * 加载最近的学习条目
   */
  private async loadRecentEntries(): Promise<void> {
    try {
      const files = await fs.readdir(ENTRIES_DIR);
      const recentFiles = files
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(-7);

      // 先收集所有条目
      const allEntries: LearningEntry[] = [];
      for (const file of recentFiles) {
        try {
          const content = await fs.readFile(path.join(ENTRIES_DIR, file), 'utf-8');
          const entries = JSON.parse(content) as LearningEntry[];
          allEntries.push(...entries);
        } catch (error) {
          logger.warn(`Failed to load learning file ${file}:`, error);
        }
      }

      // 按意图去重：相同意图保留最新的一条
      const intentMap = new Map<string, LearningEntry>();
      for (const entry of allEntries) {
        const withDefaults = ensureLearningEntryDefaults(entry);
        const intent = withDefaults.contextFactors?.intent?.trim().toLowerCase();
        if (intent) {
          const existing = intentMap.get(intent);
          if (!existing || withDefaults.timestamp > existing.timestamp) {
            intentMap.set(intent, withDefaults);
          }
        } else {
          // 无意图的条目直接按 ID 存入缓存
          this.learningCache.set(withDefaults.id, withDefaults);
        }
      }

      // 将去重后的条目存入缓存
      for (const entry of intentMap.values()) {
        this.learningCache.set(entry.id, entry);
      }

      logger.info(`Loaded ${this.learningCache.size} learning entries (deduped from ${allEntries.length})`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load learning entries:', error);
      }
    }
  }

  /**
   * 判断两个学习条目是否具有相同意图
   * 比较 contextFactors.intent 字段的相似性
   */
  private isSameIntent(a: LearningEntry, b: LearningEntry): boolean {
    const intentA = a.contextFactors?.intent;
    const intentB = b.contextFactors?.intent;
    if (!intentA || !intentB) return false;
    // 完全匹配或忽略大小写匹配
    return intentA.trim().toLowerCase() === intentB.trim().toLowerCase();
  }

  /**
   * 在内存缓存中跨天查找相同意图的已有条目
   */
  private findSameIntentInCache(entry: LearningEntry): LearningEntry | null {
    const entryIntent = entry.contextFactors?.intent?.trim().toLowerCase();
    if (!entryIntent) return null;

    for (const cached of this.learningCache.values()) {
      if (cached.id === entry.id) continue;
      const cachedIntent = cached.contextFactors?.intent?.trim().toLowerCase();
      if (cachedIntent && cachedIntent === entryIntent) {
        return cached;
      }
    }
    return null;
  }

  /**
   * 合并两个学习条目的字段（existing 为基础，newEntry 为增量）
   */
  private mergeEntryFields(existing: LearningEntry, newEntry: LearningEntry): LearningEntry {
    return {
      ...existing,
      confidence: Math.max(existing.confidence, newEntry.confidence),
      timestamp: Math.max(existing.timestamp, newEntry.timestamp),
      effectiveSolution: newEntry.effectiveSolution || existing.effectiveSolution,
      rootCause: newEntry.rootCause || existing.rootCause,
      failurePattern: newEntry.failurePattern,
      ineffectiveApproaches: [...new Set([...existing.ineffectiveApproaches, ...newEntry.ineffectiveApproaches])],
      contextFactors: { ...existing.contextFactors, ...newEntry.contextFactors },
      id: existing.id,
      iterationId: newEntry.iterationId,
      indexed: newEntry.indexed || existing.indexed,
      knowledgeEntryId: newEntry.knowledgeEntryId || existing.knowledgeEntryId,
      feedbackPositiveCount: existing.feedbackPositiveCount ?? 0,
      feedbackNegativeCount: existing.feedbackNegativeCount ?? 0,
      status: existing.status ?? 'active',
    };
  }

  /**
   * 保存学习条目到磁盘
   * 🟡 FIX (Gemini audit): 
   * 1. 引入写锁队列 (writeQueue) 确保对同一文件的并发写入是串行的，防止数据丢失
   * 2. 移除对 entry 对象的副作用，改用明确的返回值
   */
  private async saveEntry(entry: LearningEntry): Promise<LearningEntry> {
    await this.ensureDataDirs();
    const dateStr = getDateString(entry.timestamp);
    const filePath = path.join(ENTRIES_DIR, `${dateStr}.json`);

    // 获取该文件的写锁（Promise 链）
    const previousWrite = this.writeQueue.get(filePath) || Promise.resolve();
    const currentWrite = (async () => {
      try {
        await previousWrite;
      } catch { /* ignore previous error */ }

      let entries: LearningEntry[] = [];
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        entries = JSON.parse(content);
      } catch { /* 文件不存在 */ }

      const existingIndex = entries.findIndex(e => e.id === entry.id);
      if (existingIndex >= 0) {
        entries[existingIndex] = entry;
      } else {
        // 意图去重：先在内存缓存中跨天查找相同意图的已有条目
        const crossDayMatch = this.findSameIntentInCache(entry);
        if (crossDayMatch) {
          // 找到跨天的同意图条目，更新该条目所在的原始文件
          const existingDateStr = getDateString(crossDayMatch.timestamp);
          const existingFilePath = path.join(ENTRIES_DIR, `${existingDateStr}.json`);

          // 跨天文件同样需要加锁（简单处理：由于跨天合并较少，这里递归调用 saveEntry 或简单加锁）
          // 实际上为了严谨，这里也应该纳入队列管理，但如果跨天文件与当前文件不同，需要额外处理
          // 如果 existingFilePath !== filePath，我们需要确保也锁住它
          // 🟡 FIX (Gemini audit): 解耦跨天合并，避免锁耦合。
          // 异步触发合并，不阻塞当前文件的写入流。
          if (existingFilePath !== filePath) {
            const merged = this.mergeEntryFields(crossDayMatch, entry);
            this.saveEntry(merged).catch(err => {
              logger.warn(`Failed to save decoupled cross-day merged entry ${merged.id}:`, err);
            });
            return merged;
          }
        }

        // 当天文件内去重：查找相同意图的已有条目
        const sameIntentIndex = entries.findIndex(e => e.id !== entry.id && this.isSameIntent(e, entry));
        if (sameIntentIndex >= 0) {
          const existing = entries[sameIntentIndex];
          const merged = this.mergeEntryFields(existing, entry);
          entries[sameIntentIndex] = merged;
          this.learningCache.set(existing.id, merged);
          await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
          logger.info(`Learning entry merged by intent: ${entry.id} -> ${existing.id}`);
          return merged;
        }
        entries.push(entry);
      }

      await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
      this.learningCache.set(entry.id, entry);

      // 更新索引
      const indexEntry = this.learningIndex.entries.find(e => e.id === entry.id);
      if (!indexEntry) {
        this.learningIndex.entries.push({
          id: entry.id,
          timestamp: entry.timestamp,
          failurePattern: entry.failurePattern,
          dateFile: dateStr,
        });
        await this.saveIndex();
      }
      return entry;
    })();

    // 将当前写操作放入队列，并设置清理逻辑
    this.writeQueue.set(filePath, currentWrite);
    currentWrite.finally(() => {
      if (this.writeQueue.get(filePath) === currentWrite) {
        this.writeQueue.delete(filePath);
      }
    });

    return await currentWrite;
  }


  /**
   * 执行深度反思
   * Requirements: 5.1-5.5
   */
  async reflect(
    evaluation: EvaluationReport,
    context: ReflectionContext
  ): Promise<ReflectionResult> {
    await this.initialize();

    const reflectionId = uuidv4();
    const now = Date.now();

    // 5.1 分析预期与实际结果的差距
    const gapAnalysis = this.analyzeGap(evaluation, context);

    // 5.2 识别与已知问题的模式匹配
    const patternMatch = await this.findPatternMatch(evaluation, context);

    // 5.3 考虑上下文因素
    const contextFactors = this.analyzeContextFactors(context);

    // 5.4 生成反思摘要和洞察
    const { summary, insights } = await this.generateInsights(evaluation, context, gapAnalysis);

    // 6.1 决定下一步行动
    const nextAction = await this.determineNextAction(evaluation, context, patternMatch);

    // 生成行动详情
    const actionDetails = await this.generateActionDetails(nextAction, evaluation, context);

    const result: ReflectionResult = {
      id: reflectionId,
      evaluationId: evaluation.id,
      timestamp: now,
      summary,
      insights,
      gapAnalysis,
      patternMatch,
      contextFactors,
      nextAction,
      actionDetails,
    };

    // 记录审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      details: {
        trigger: 'reflector_reflect',
        metadata: {
          reflectionId,
          evaluationId: evaluation.id,
          nextAction,
          patternMatch: patternMatch?.patternId,
        },
      },
    });

    logger.info(`Reflection completed: ${reflectionId}, next action: ${nextAction}`);
    return result;
  }

  /**
   * 分析预期与实际结果的差距
   * Requirements: 5.1
   */
  private analyzeGap(evaluation: EvaluationReport, context: ReflectionContext): string {
    const gaps: string[] = [];

    // 分析整体成功率差距
    if (!evaluation.overallSuccess) {
      gaps.push(`修复方案未能成功完成，整体评分 ${evaluation.overallScore}/100`);
    }

    // 分析根因解决差距
    if (!evaluation.rootCauseAddressed) {
      gaps.push('根本原因未能完全解决');
    }

    // 分析残留问题
    if (evaluation.residualIssues.length > 0) {
      gaps.push(`存在 ${evaluation.residualIssues.length} 个残留问题`);
    }

    // 分析各步骤差距
    const failedSteps = evaluation.stepEvaluations.filter(e => !e.success);
    if (failedSteps.length > 0) {
      gaps.push(`${failedSteps.length} 个步骤执行失败`);
    }

    // 分析维度差距
    const lowScoreSteps = evaluation.stepEvaluations.filter(e => e.qualityScore < 60);
    if (lowScoreSteps.length > 0) {
      gaps.push(`${lowScoreSteps.length} 个步骤质量评分较低`);
    }

    return gaps.length > 0 ? gaps.join('；') : '执行结果符合预期';
  }

  /**
   * 查找模式匹配
   * Requirements: 5.2
   */
  private async findPatternMatch(
    evaluation: EvaluationReport,
    _context: ReflectionContext
  ): Promise<{ patternId: string; similarity: number } | undefined> {
    if (!evaluation.failureCategory) {
      return undefined;
    }

    // 从学习缓存中查找相似的失败模式
    let bestMatch: { patternId: string; similarity: number } | undefined;
    let maxSimilarity = 0;

    for (const entry of this.learningCache.values()) {
      const similarity = this.calculatePatternSimilarity(evaluation, entry);
      if (similarity > maxSimilarity && similarity > 0.6) {
        maxSimilarity = similarity;
        bestMatch = {
          patternId: entry.id,
          similarity,
        };
      }
    }

    return bestMatch;
  }

  /**
   * 计算模式相似度
   */
  private calculatePatternSimilarity(evaluation: EvaluationReport, entry: LearningEntry): number {
    let similarity = 0;
    let factors = 0;

    // 失败类型匹配
    if (evaluation.failureCategory) {
      const categoryMatch = entry.failurePattern.toLowerCase().includes(evaluation.failureCategory);
      similarity += categoryMatch ? 0.4 : 0;
      factors++;
    }

    // 残留问题匹配
    if (evaluation.residualIssues.length > 0 && entry.ineffectiveApproaches.length > 0) {
      const issueMatch = evaluation.residualIssues.some(issue =>
        entry.ineffectiveApproaches.some(approach =>
          issue.toLowerCase().includes(approach.toLowerCase()) ||
          approach.toLowerCase().includes(issue.toLowerCase())
        )
      );
      similarity += issueMatch ? 0.3 : 0;
      factors++;
    }

    // 上下文因素匹配
    const contextMatch = Object.keys(entry.contextFactors).some(key =>
      evaluation.residualIssues.some(issue => issue.toLowerCase().includes(key.toLowerCase()))
    );
    similarity += contextMatch ? 0.3 : 0;
    factors++;

    return factors > 0 ? similarity / factors : 0;
  }

  /**
   * 分析上下文因素
   * Requirements: 5.3
   */
  private analyzeContextFactors(context: ReflectionContext): {
    timeOfDay: string;
    systemLoad: string;
    recentChanges: string[];
  } {
    const { systemContext } = context;
    const hour = systemContext.currentTime.getHours();

    // 时间段分析
    let timeOfDay: string;
    if (hour >= 9 && hour < 18) {
      timeOfDay = '工作时间';
    } else if (hour >= 18 && hour < 22) {
      timeOfDay = '晚间时段';
    } else if (hour >= 22 || hour < 6) {
      timeOfDay = '深夜时段';
    } else {
      timeOfDay = '清晨时段';
    }

    // 系统负载分析
    const { systemLoad } = systemContext;
    let loadLevel: string;
    if (systemLoad.cpu.usage > 80 || systemLoad.memory.usage > 85) {
      loadLevel = '高负载';
    } else if (systemLoad.cpu.usage > 50 || systemLoad.memory.usage > 60) {
      loadLevel = '中等负载';
    } else {
      loadLevel = '低负载';
    }

    return {
      timeOfDay,
      systemLoad: loadLevel,
      recentChanges: systemContext.recentChanges,
    };
  }

  /**
   * 生成反思洞察
   * Requirements: 5.4, 5.5
   */
  private async generateInsights(
    evaluation: EvaluationReport,
    context: ReflectionContext,
    gapAnalysis: string
  ): Promise<{ summary: string; insights: string[] }> {
    const insights: string[] = [];

    // 基于评估结果生成洞察
    if (!evaluation.overallSuccess) {
      if (evaluation.failureCategory === 'wrong_diagnosis') {
        insights.push('根因分析可能不准确，建议重新诊断');
      } else if (evaluation.failureCategory === 'insufficient_action') {
        insights.push('修复措施力度不足，需要更强力的干预');
      } else if (evaluation.failureCategory === 'side_effect') {
        insights.push('修复操作产生了副作用，需要考虑回滚');
      }
    }

    // 基于历史模式生成洞察
    const patternMatch = await this.findPatternMatch(evaluation, context);
    if (patternMatch && patternMatch.similarity > 0.7) {
      const matchedEntry = this.learningCache.get(patternMatch.patternId);
      if (matchedEntry?.effectiveSolution) {
        insights.push(`历史相似问题的有效解决方案: ${matchedEntry.effectiveSolution}`);
      }
      if (matchedEntry?.ineffectiveApproaches.length) {
        insights.push(`应避免的方法: ${matchedEntry.ineffectiveApproaches.join(', ')}`);
      }
    }

    // 基于上下文生成洞察
    const contextFactors = this.analyzeContextFactors(context);
    if (contextFactors.systemLoad === '高负载') {
      insights.push('系统当前处于高负载状态，可能影响修复效果');
    }
    if (contextFactors.recentChanges.length > 0) {
      insights.push(`近期有配置变更，可能与问题相关: ${contextFactors.recentChanges.slice(0, 3).join(', ')}`);
    }

    // 尝试使用 AI 生成更深入的洞察
    try {
      const aiInsights = await this.getAIInsights(evaluation, context, gapAnalysis);
      if (aiInsights.length > 0) {
        insights.push(...aiInsights);
      }
    } catch (error) {
      logger.debug('AI insights generation failed:', error);
    }

    // 生成摘要
    const summary = this.generateSummary(evaluation, gapAnalysis, insights);

    return { summary, insights };
  }

  /**
   * 使用 AI 生成洞察
   */
  private async getAIInsights(
    evaluation: EvaluationReport,
    context: ReflectionContext,
    gapAnalysis: string
  ): Promise<string[]> {
    const result = await aiAnalyzer.analyze({
      type: 'fault_diagnosis',
      context: {
        evaluationReport: evaluation,
        alertEvent: context.alertEvent,
        plan: context.plan,
        gapAnalysis,
        analysisType: 'reflection_insights',
      },
    });

    return result.recommendations || [];
  }

  /**
   * 生成摘要
   */
  private generateSummary(
    evaluation: EvaluationReport,
    gapAnalysis: string,
    insights: string[]
  ): string {
    const parts: string[] = [];

    if (evaluation.overallSuccess) {
      parts.push(`修复方案执行成功，整体评分 ${evaluation.overallScore}/100`);
    } else {
      parts.push(`修复方案执行未达预期，整体评分 ${evaluation.overallScore}/100`);
      if (evaluation.failureCategory) {
        parts.push(`主要失败原因: ${this.translateFailureCategory(evaluation.failureCategory)}`);
      }
    }

    if (gapAnalysis !== '执行结果符合预期') {
      parts.push(`差距分析: ${gapAnalysis}`);
    }

    if (insights.length > 0) {
      parts.push(`关键洞察: ${insights[0]}`);
    }

    return parts.join('。');
  }

  /**
   * 翻译失败类型
   */
  private translateFailureCategory(category: string): string {
    const translations: Record<string, string> = {
      execution_error: '执行错误',
      verification_failed: '验证失败',
      wrong_diagnosis: '诊断错误',
      insufficient_action: '行动不足',
      side_effect: '副作用',
      timeout: '超时',
      external_factor: '外部因素',
    };
    return translations[category] || category;
  }


  /**
   * 确定下一步行动
   * Requirements: 6.1-6.7
   */
  private async determineNextAction(
    evaluation: EvaluationReport,
    context: ReflectionContext,
    patternMatch?: { patternId: string; similarity: number }
  ): Promise<NextAction> {
    // 6.6 如果成功，标记完成
    if (evaluation.overallSuccess && evaluation.rootCauseAddressed) {
      return 'complete';
    }

    const { iterationHistory } = context;
    const currentIteration = iterationHistory.evaluations.length;

    // 6.5 如果有严重副作用，触发回滚
    const hasSevereSideEffects = evaluation.stepEvaluations.some(
      e => e.dimensions.sideEffects < 40
    );
    if (hasSevereSideEffects) {
      return 'rollback';
    }

    // 6.1 如果是瞬态失败且重试次数未达上限，重试相同方案
    if (this.isTransientFailure(evaluation) && currentIteration < 2) {
      return 'retry_same';
    }

    // 6.3 如果诊断错误或行动不足，尝试替代方案
    if (
      evaluation.failureCategory === 'wrong_diagnosis' ||
      evaluation.failureCategory === 'insufficient_action'
    ) {
      return 'try_alternative';
    }

    // 6.2 如果有历史模式匹配，使用修改后的方案重试
    if (patternMatch && patternMatch.similarity > 0.7) {
      const matchedEntry = this.learningCache.get(patternMatch.patternId);
      if (matchedEntry?.effectiveSolution) {
        return 'retry_modified';
      }
    }

    // 6.4 如果多次失败或分数很低，升级处理
    if (currentIteration >= 2 || evaluation.overallScore < 30) {
      return 'escalate';
    }

    // 默认尝试替代方案
    return 'try_alternative';
  }

  /**
   * 判断是否为瞬态失败
   */
  private isTransientFailure(evaluation: EvaluationReport): boolean {
    const transientCategories = ['timeout', 'external_factor', 'execution_error'];
    return (
      evaluation.failureCategory !== undefined &&
      transientCategories.includes(evaluation.failureCategory) &&
      evaluation.overallScore >= 40
    );
  }

  /**
   * 生成行动详情
   */
  private async generateActionDetails(
    nextAction: NextAction,
    evaluation: EvaluationReport,
    context: ReflectionContext
  ): Promise<ReflectionResult['actionDetails']> {
    switch (nextAction) {
      case 'retry_modified':
        return {
          modifiedParams: await this.generateModifiedParams(evaluation, context),
        };

      case 'try_alternative':
        return {
          alternativePlan: await this.generateAlternativePlan(evaluation, context),
        };

      case 'escalate':
        return {
          escalationSummary: this.generateEscalationSummary(evaluation, context),
        };

      default:
        return undefined;
    }
  }

  /**
   * 生成修改后的参数
   */
  private async generateModifiedParams(
    evaluation: EvaluationReport,
    _context: ReflectionContext
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};

    // 根据失败类型调整参数
    if (evaluation.failureCategory === 'timeout') {
      params.timeout = 120000; // 增加超时时间
      params.retryDelay = 5000; // 增加重试延迟
    }

    if (evaluation.failureCategory === 'execution_error') {
      params.validateBeforeExecute = true;
      params.dryRun = true; // 先进行干运行
    }

    // 根据低分维度调整
    const avgTimeEfficiency = evaluation.stepEvaluations.reduce(
      (sum, e) => sum + e.dimensions.timeEfficiency, 0
    ) / evaluation.stepEvaluations.length;

    if (avgTimeEfficiency < 50) {
      params.parallelExecution = false; // 禁用并行执行
      params.stepDelay = 2000; // 增加步骤间延迟
    }

    return params;
  }

  /**
   * 生成替代方案
   */
  private async generateAlternativePlan(
    evaluation: EvaluationReport,
    context: ReflectionContext
  ): Promise<RemediationPlan | undefined> {
    try {
      // 使用 AI 生成替代方案
      const result = await aiAnalyzer.analyze({
        type: 'fault_diagnosis',
        context: {
          evaluationReport: evaluation,
          alertEvent: context.alertEvent,
          originalPlan: context.plan,
          failedSteps: evaluation.stepEvaluations.filter(e => !e.success),
          analysisType: 'alternative_plan',
        },
      });

      if (result.recommendations && result.recommendations.length > 0) {
        // 构建替代方案（简化版本）
        return {
          id: uuidv4(),
          alertId: evaluation.alertId,
          rootCauseId: context.plan.rootCauseId,
          timestamp: Date.now(),
          steps: result.recommendations.map((rec, index) => ({
            order: index + 1,
            description: rec,
            command: '/system/resource/print', // 默认诊断命令
            verification: {
              command: '/system/resource/print',
              expectedResult: '验证操作结果',
            },
            autoExecutable: true,
            riskLevel: 'low' as const,
            estimatedDuration: 10,
          })),
          rollback: [],
          overallRisk: 'low',
          estimatedDuration: result.recommendations.length * 10,
          requiresConfirmation: false,
          status: 'pending',
        };
      }
    } catch (error) {
      logger.debug('Failed to generate alternative plan:', error);
    }

    return undefined;
  }

  /**
   * 生成升级摘要
   */
  private generateEscalationSummary(
    evaluation: EvaluationReport,
    context: ReflectionContext
  ): string {
    const parts: string[] = [];

    parts.push(`告警 ID: ${evaluation.alertId}`);
    parts.push(`修复方案 ID: ${evaluation.planId}`);
    parts.push(`整体评分: ${evaluation.overallScore}/100`);

    if (evaluation.failureCategory) {
      parts.push(`失败类型: ${this.translateFailureCategory(evaluation.failureCategory)}`);
    }

    parts.push(`迭代次数: ${context.iterationHistory.evaluations.length}`);

    if (evaluation.residualIssues.length > 0) {
      parts.push(`残留问题: ${evaluation.residualIssues.join('; ')}`);
    }

    parts.push('建议: 需要人工介入处理');

    return parts.join('\n');
  }

  /**
   * 决定下一步行动（公开方法）
   * Requirements: 6.1-6.7
   */
  async decideNextAction(
    reflection: ReflectionResult,
    iterationState: IterationState
  ): Promise<NextAction> {
    // 如果反思已经决定了行动，直接返回
    if (reflection.nextAction) {
      return reflection.nextAction;
    }

    // 检查迭代限制
    if (iterationState.currentIteration >= iterationState.maxIterations) {
      return 'escalate';
    }

    // 默认返回完成
    return 'complete';
  }

  /**
   * 提取学习内容
   * Requirements: 7.1, 7.2
   */
  async extractLearning(iterationState: IterationState): Promise<LearningEntry> {
    await this.initialize();

    const entryId = uuidv4();
    const now = Date.now();

    // 从迭代历史中提取信息
    const evaluations = iterationState.evaluations;
    const reflections = iterationState.reflections;

    // 7.1 提取失败模式
    const failurePattern = this.extractFailurePattern(evaluations);

    // 提取根因
    const rootCause = this.extractRootCause(evaluations, reflections);

    // 记录有效方案
    const effectiveSolution = this.extractEffectiveSolution(evaluations, iterationState);

    // 记录无效方案
    const ineffectiveApproaches = this.extractIneffectiveApproaches(evaluations);

    // 记录上下文因素
    const contextFactors = this.extractContextFactors(reflections);

    // 计算置信度
    const confidence = this.calculateLearningConfidence(evaluations, reflections);

    const entry: LearningEntry = {
      id: entryId,
      timestamp: now,
      iterationId: iterationState.id,
      failurePattern,
      rootCause,
      effectiveSolution,
      ineffectiveApproaches,
      contextFactors,
      confidence,
      indexed: false,
      feedbackPositiveCount: 0,
      feedbackNegativeCount: 0,
      status: 'active',
    };

    logger.info(`Learning entry extracted: ${entryId}, pattern: ${failurePattern}`);
    return entry;
  }

  /**
   * 提取失败模式
   */
  private extractFailurePattern(evaluations: EvaluationReport[]): string {
    const failureCategories = evaluations
      .filter(e => e.failureCategory)
      .map(e => e.failureCategory);

    if (failureCategories.length === 0) {
      return '无明显失败模式';
    }

    // 统计最常见的失败类型
    const counts: Record<string, number> = {};
    for (const category of failureCategories) {
      if (category) {
        counts[category] = (counts[category] || 0) + 1;
      }
    }

    const mostCommon = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])[0];

    return mostCommon ? this.translateFailureCategory(mostCommon[0]) : '混合失败模式';
  }

  /**
   * 提取根因
   */
  private extractRootCause(
    evaluations: EvaluationReport[],
    reflections: ReflectionResult[]
  ): string {
    // 从反思中提取根因分析
    for (const reflection of reflections) {
      if (reflection.gapAnalysis && reflection.gapAnalysis !== '执行结果符合预期') {
        return reflection.gapAnalysis;
      }
    }

    // 从评估中提取
    const failedEval = evaluations.find(e => !e.overallSuccess);
    if (failedEval?.residualIssues.length) {
      return failedEval.residualIssues[0];
    }

    return '根因未明确识别';
  }

  /**
   * 提取有效方案
   */
  private extractEffectiveSolution(
    evaluations: EvaluationReport[],
    iterationState: IterationState
  ): string | undefined {
    // 如果最终成功，记录成功的方案
    if (iterationState.status === 'completed') {
      const successfulEval = evaluations.find(e => e.overallSuccess);
      if (successfulEval) {
        return `方案 ${successfulEval.planId} 成功解决问题，评分 ${successfulEval.overallScore}`;
      }
    }

    return undefined;
  }

  /**
   * 提取无效方案
   */
  private extractIneffectiveApproaches(evaluations: EvaluationReport[]): string[] {
    const ineffective: string[] = [];

    for (const evaluation of evaluations) {
      if (!evaluation.overallSuccess) {
        const failedSteps = evaluation.stepEvaluations
          .filter(e => !e.success)
          .map(e => `步骤 ${e.stepOrder}: ${e.failureDetails || '执行失败'}`);
        ineffective.push(...failedSteps);
      }
    }

    return ineffective.slice(0, 10); // 限制数量
  }

  /**
   * 提取上下文因素
   */
  private extractContextFactors(reflections: ReflectionResult[]): Record<string, string> {
    const factors: Record<string, string> = {};

    for (const reflection of reflections) {
      if (reflection.contextFactors) {
        factors.timeOfDay = reflection.contextFactors.timeOfDay;
        factors.systemLoad = reflection.contextFactors.systemLoad;
        if (reflection.contextFactors.recentChanges.length > 0) {
          factors.recentChanges = reflection.contextFactors.recentChanges.join(', ');
        }
        // Bug fix: 保留 originalMessage 和 intent 等自定义字段，避免反思记录丢失原始请求信息
        if ((reflection.contextFactors as any).originalMessage) {
          factors.originalMessage = (reflection.contextFactors as any).originalMessage;
        }
        if ((reflection.contextFactors as any).intent) {
          factors.intent = (reflection.contextFactors as any).intent;
        }
        if ((reflection.contextFactors as any).intentConfidence !== undefined) {
          factors.intentConfidence = String((reflection.contextFactors as any).intentConfidence);
        }
      }
    }

    return factors;
  }

  /**
   * 计算学习置信度
   */
  private calculateLearningConfidence(
    evaluations: EvaluationReport[],
    reflections: ReflectionResult[],
    feedbackPositiveCount: number = 0,
    feedbackNegativeCount: number = 0
  ): number {
    // 多维度加权置信度计算
    // 维度1: 数据充分性 (权重 0.25)
    let dataSufficiency = 0;
    const evalCount = evaluations.length;
    if (evalCount >= 3) dataSufficiency = 1.0;
    else if (evalCount >= 2) dataSufficiency = 0.7;
    else if (evalCount >= 1) dataSufficiency = 0.4;
    // 反思深度加成
    if (reflections.length >= 2) dataSufficiency = Math.min(1, dataSufficiency + 0.2);
    else if (reflections.length >= 1) dataSufficiency = Math.min(1, dataSufficiency + 0.1);

    // 维度2: 模式确定性 (权重 0.22)
    let patternCertainty = 0;
    const hasPatternMatch = reflections.some(r => r.patternMatch);
    const hasFailureCategory = evaluations.some(e => e.failureCategory);
    const hasGapAnalysis = reflections.some(r => r.gapAnalysis && r.gapAnalysis !== '执行结果符合预期');
    if (hasPatternMatch) patternCertainty += 0.4;
    if (hasFailureCategory) patternCertainty += 0.35;
    if (hasGapAnalysis) patternCertainty += 0.25;

    // 维度3: 方案验证度 (权重 0.22)
    let solutionVerification = 0;
    const hasEffectiveSolution = evaluations.some(e => e.overallSuccess);
    const hasSpecificScore = evaluations.some(e => e.overallScore > 0);
    if (hasEffectiveSolution) solutionVerification += 0.6;
    if (hasSpecificScore) {
      const avgScore = evaluations.reduce((sum, e) => sum + e.overallScore, 0) / evalCount;
      solutionVerification += Math.min(0.4, avgScore * 0.04); // 0-10 分映射到 0-0.4
    }

    // 维度4: 上下文丰富度 (权重 0.16)
    let contextRichness = 0;
    const allFactors = reflections.flatMap(r => r.contextFactors ? Object.keys(r.contextFactors) : []);
    const uniqueFactors = new Set(allFactors).size;
    contextRichness = Math.min(1, uniqueFactors * 0.2);
    // 有无效方法记录说明探索充分
    const hasIneffective = evaluations.some(e => !e.overallSuccess);
    if (hasIneffective && hasEffectiveSolution) contextRichness = Math.min(1, contextRichness + 0.3);

    // 维度5: 用户反馈 (权重 0.15)
    // Requirements: conversation-and-reflection-optimization 4.1, 4.2, 4.3, 4.4
    let feedbackDimension: number;
    const totalFeedback = feedbackPositiveCount + feedbackNegativeCount;
    if (totalFeedback === 0) {
      feedbackDimension = 0.5; // 无反馈时默认中性
    } else {
      feedbackDimension = Math.max(0, Math.min(1,
        (feedbackPositiveCount - feedbackNegativeCount * 2) / Math.max(totalFeedback, 1)
      ));
    }

    // 加权汇总
    const confidence =
      dataSufficiency * 0.25 +
      patternCertainty * 0.22 +
      solutionVerification * 0.22 +
      contextRichness * 0.16 +
      feedbackDimension * 0.15;

    // 上限 0.98，无硬性下限
    // Fix: 移除 0.3 下限，让负面反馈（applyNegativeFeedback）能有效降低置信度
    // queryLearning 中的 0.2 过滤阈值是真正的安全网
    return Math.min(0.98, Math.max(0, confidence));
  }


  /**
   * 持久化学习内容
   * 将 LearningEntry 转换为 KnowledgeEntry 并存储到知识库
   * Requirements: 7.3, 7.4
   */
  async persistLearning(entry: LearningEntry): Promise<void> {
    await this.initialize();

    // 确保新字段有默认值
    entry.feedbackPositiveCount = entry.feedbackPositiveCount ?? 0;
    entry.feedbackNegativeCount = entry.feedbackNegativeCount ?? 0;
    entry.status = entry.status ?? 'active';

    // 保存到本地文件（备份）
    // 🟡 FIX (Gemini audit): 使用 saveEntry 的返回结果（可能是合并后的条目），确保后续 ID/状态一致
    const savedEntry = await this.saveEntry(entry);

    // 同步到内存缓存
    this.learningCache.set(savedEntry.id, savedEntry);

    // 尝试索引到知识库
    try {
      const kb = await this.getKnowledgeBase();

      // === 去重检查: 查找相似的已有条目 ===
      const existingEntry = await this.findSimilarExisting(kb, savedEntry);

      if (existingEntry) {
        // 合并到已有条目
        await this.mergeIntoExisting(kb, existingEntry, savedEntry);
        savedEntry.indexed = true;
        savedEntry.knowledgeEntryId = existingEntry.id;
        await this.saveEntry(savedEntry);
        logger.info(`Learning entry merged into existing: ${savedEntry.id} -> ${existingEntry.id}`);
      } else {
        // 构建知识条目内容
        const content = this.buildKnowledgeContent(savedEntry);

        // 添加到知识库
        const knowledgeEntry = await kb.add({
          title: `[学习] ${new Date(savedEntry.timestamp).toISOString().split('T')[0]} ${savedEntry.contextFactors?.intent || '未知意图'}: ${savedEntry.failurePattern.slice(0, 40)}`,
          content,
          type: 'learning',
          metadata: {
            source: 'reflector_service',
            timestamp: savedEntry.timestamp,
            category: 'learning',
            tags: ['learning', 'failure-pattern', savedEntry.failurePattern.replace(/\s+/g, '-')],
            usageCount: 0,
            feedbackScore: 0,
            feedbackCount: 0,
            originalData: {
              learningEntryId: savedEntry.id,
              iterationId: savedEntry.iterationId,
              rootCause: savedEntry.rootCause,
              effectiveSolution: savedEntry.effectiveSolution,
              confidence: savedEntry.confidence,
              contextFactors: savedEntry.contextFactors,
              mergeCount: 0,
            },
          },
        });

        // 更新学习条目的索引状态
        savedEntry.indexed = true;
        savedEntry.knowledgeEntryId = knowledgeEntry.id;
        await this.saveEntry(savedEntry);

        logger.info(`Learning entry indexed to knowledge base: ${savedEntry.id} -> ${knowledgeEntry.id}`);
      }

      // === SSE 事件广播: 通知前端有新学习条目 ===
      this.events.emit('learning:new', {
        id: savedEntry.id,
        timestamp: savedEntry.timestamp,
        failurePattern: savedEntry.failurePattern,
        confidence: savedEntry.confidence,
        intent: savedEntry.contextFactors?.intent,
        originalMessage: savedEntry.contextFactors?.originalMessage,
        merged: !!existingEntry,
      });
    } catch (error) {
      logger.warn(`Failed to index learning entry ${savedEntry.id} to knowledge base:`, error);
      // 不抛出错误，本地备份已保存
      // 仍然发送 SSE 事件（本地保存成功即可通知前端）
      this.events.emit('learning:new', {
        id: savedEntry.id,
        timestamp: savedEntry.timestamp,
        failurePattern: savedEntry.failurePattern,
        confidence: savedEntry.confidence,
        intent: savedEntry.contextFactors?.intent,
        originalMessage: savedEntry.contextFactors?.originalMessage,
        merged: false,
      });
    }
  }

  /**
   * 查找相似的已有学习条目（去重核心）
   * 基于意图 + 失败模式的相似度匹配
   */
  /**
   * 正面反馈：增加正面计数，提升置信度
   * Requirements: conversation-and-reflection-optimization 6.2, 6.3
   */
  async applyPositiveFeedback(entryId: string): Promise<void> {
    await this.initialize();
    const entry = await this.getLearningEntry(entryId);
    if (!entry) {
      logger.warn(`applyPositiveFeedback: entry not found: ${entryId}`);
      return;
    }

    entry.feedbackPositiveCount = (entry.feedbackPositiveCount ?? 0) + 1;
    entry.confidence = Math.min(0.98, entry.confidence + 0.05);

    await this.saveEntry(entry);
    this.learningCache.set(entry.id, entry);

    // 同步更新知识库中的 feedbackScore/feedbackCount
    try {
      if (entry.knowledgeEntryId) {
        const kb = await this.getKnowledgeBase();
        await kb.update(entry.knowledgeEntryId, {
          metadata: {
            source: 'reflector_service',
            timestamp: entry.timestamp,
            category: 'learning',
            tags: ['learning', 'failure-pattern'],
            usageCount: 0,
            feedbackScore: entry.feedbackPositiveCount - entry.feedbackNegativeCount,
            feedbackCount: entry.feedbackPositiveCount + entry.feedbackNegativeCount,
          },
        });
      }
    } catch (error) {
      logger.warn(`Failed to update KB for positive feedback on ${entryId}:`, error);
    }
  }

  /**
   * 负面反馈：增加负面计数，降低置信度，3次后标记 deprecated
   * Requirements: conversation-and-reflection-optimization 3.2, 3.4
   */
  async applyNegativeFeedback(entryId: string): Promise<void> {
    await this.initialize();
    const entry = await this.getLearningEntry(entryId);
    if (!entry) {
      logger.warn(`applyNegativeFeedback: entry not found: ${entryId}`);
      return;
    }

    entry.feedbackNegativeCount = (entry.feedbackNegativeCount ?? 0) + 1;
    entry.confidence = Math.max(0, entry.confidence - 0.15);

    // 累计 3 次负面反馈 → deprecated
    if (entry.feedbackNegativeCount >= 3) {
      entry.status = 'deprecated';
    }

    await this.saveEntry(entry);
    this.learningCache.set(entry.id, entry);

    // 同步更新知识库
    try {
      if (entry.knowledgeEntryId) {
        const kb = await this.getKnowledgeBase();
        await kb.update(entry.knowledgeEntryId, {
          metadata: {
            source: 'reflector_service',
            timestamp: entry.timestamp,
            category: 'learning',
            tags: ['learning', 'failure-pattern'],
            usageCount: 0,
            feedbackScore: entry.feedbackPositiveCount - entry.feedbackNegativeCount,
            feedbackCount: entry.feedbackPositiveCount + entry.feedbackNegativeCount,
          },
        });
      }
    } catch (error) {
      logger.warn(`Failed to update KB for negative feedback on ${entryId}:`, error);
    }
  }

  private async findSimilarExisting(
    kb: Awaited<ReturnType<typeof this.getKnowledgeBase>>,
    entry: LearningEntry
  ): Promise<{ id: string; metadata: any; content: string; title: string } | null> {
    try {
      // 用失败模式搜索已有条目
      const searchResults = await kb.search({
        query: entry.failurePattern,
        type: 'learning',
        limit: 5,
      });

      if (searchResults.length === 0) return null;

      const entryIntent = entry.contextFactors?.intent?.toLowerCase() || '';

      for (const result of searchResults) {
        const existingData = result.entry.metadata?.originalData as Record<string, unknown> | undefined;
        if (!existingData) continue;

        const existingFactors = existingData.contextFactors as Record<string, string> | undefined;
        const existingIntent = existingFactors?.intent?.toLowerCase() || '';

        // 意图完全匹配 → 高概率是同类问题
        if (entryIntent && existingIntent && entryIntent === existingIntent) {
          return result.entry as any;
        }

        // 失败模式高度相似（包含关系）
        const existingPattern = (existingData.rootCause as string || '').toLowerCase();
        const newPattern = entry.failurePattern.toLowerCase();
        if (newPattern.length > 10 && existingPattern.includes(newPattern.substring(0, Math.min(40, newPattern.length)))) {
          return result.entry as any;
        }
      }

      return null;
    } catch (error) {
      logger.debug('findSimilarExisting failed, treating as new entry:', error);
      return null;
    }
  }

  /**
   * 将新学习条目合并到已有条目
   * 提升置信度、更新方案、增加合并计数
   */
  private async mergeIntoExisting(
    kb: Awaited<ReturnType<typeof this.getKnowledgeBase>>,
    existing: { id: string; metadata: any; content: string; title: string },
    newEntry: LearningEntry
  ): Promise<void> {
    try {
      const existingData = existing.metadata?.originalData as Record<string, unknown> || {};
      const mergeCount = ((existingData.mergeCount as number) || 0) + 1;
      const existingConfidence = (existingData.confidence as number) || 0.5;

      // 合并置信度: 每次合并提升，但递减增长
      const confidenceBoost = Math.min(0.05, 0.1 / (mergeCount + 1));
      const mergedConfidence = Math.min(0.98, Math.max(existingConfidence, newEntry.confidence) + confidenceBoost);

      // 合并有效方案
      let mergedSolution = existingData.effectiveSolution as string || '';
      if (newEntry.effectiveSolution && !mergedSolution.includes(newEntry.effectiveSolution.substring(0, 30))) {
        mergedSolution = mergedSolution
          ? `${mergedSolution}\n---\n${newEntry.effectiveSolution}`
          : newEntry.effectiveSolution;
      }

      // 更新知识库条目
      const updatedContent = this.buildKnowledgeContent({
        ...newEntry,
        effectiveSolution: mergedSolution || newEntry.effectiveSolution,
        confidence: mergedConfidence,
      });

      await kb.update(existing.id, {
        content: updatedContent,
        metadata: {
          ...existing.metadata,
          timestamp: newEntry.timestamp, // 更新时间戳为最新
          originalData: {
            ...existingData,
            confidence: mergedConfidence,
            effectiveSolution: mergedSolution || newEntry.effectiveSolution,
            mergeCount,
            lastMergedEntryId: newEntry.id,
            lastMergedAt: newEntry.timestamp,
          },
        },
      });

      logger.info(`Merged learning entry, mergeCount=${mergeCount}, confidence=${mergedConfidence.toFixed(2)}`);
    } catch (error) {
      logger.warn('Failed to merge learning entry:', error);
      throw error;
    }
  }

  /**
   * 构建知识条目内容
   */
  private buildKnowledgeContent(entry: LearningEntry): string {
    const parts: string[] = [];
    const dateStr = new Date(entry.timestamp).toISOString().split('T')[0];
    const intent = entry.contextFactors?.intent || '未知';
    const originalMessage = entry.contextFactors?.originalMessage || '';

    // 触发源
    parts.push(`触发源: ${intent} ${dateStr}`);

    // 感知状态 (Observe) — 从失败模式和原始消息构建
    if (originalMessage) {
      parts.push(`感知状态 (Observe): 用户请求「${originalMessage.length > 100 ? originalMessage.slice(0, 100) + '...' : originalMessage}」`);
    } else {
      parts.push(`感知状态 (Observe): ${entry.failurePattern}`);
    }

    // 思考过程 (Thought) — 根因分析
    parts.push(`思考过程 (Thought): ${entry.rootCause}`);

    // 执行动作 (Act) — 从上下文因素中提取工具信息
    const toolCount = entry.contextFactors?.toolCount || '0';
    const duration = entry.contextFactors?.totalDuration || '未知';
    const iterations = entry.contextFactors?.iterationCount || '未知';
    parts.push(`执行动作 (Act): 经过 ${iterations} 轮迭代，调用 ${toolCount} 个工具，耗时 ${duration}`);

    // 执行结果 (Outcome)
    if (entry.effectiveSolution) {
      parts.push(`执行结果 (Outcome): ✅ ${entry.effectiveSolution}`);
    } else {
      parts.push(`执行结果 (Outcome): ⚠️ 未找到有效解决方案`);
    }

    // 无效方法（如果有）
    if (entry.ineffectiveApproaches.length > 0) {
      parts.push(`无效尝试:`);
      for (const approach of entry.ineffectiveApproaches) {
        parts.push(`- ${approach}`);
      }
    }

    // 经验价值评分
    const confidencePercent = (entry.confidence * 100).toFixed(0);
    const valueLabel = entry.confidence >= 0.8 ? '高' : entry.confidence >= 0.5 ? '中' : '低';
    parts.push(`经验价值评分: ${valueLabel} (置信度 ${confidencePercent}%)`);

    return parts.join('\n');
  }

  /**
   * 查询相关学习内容
   * 使用 KnowledgeBase.search() 查询 type='learning' 的条目
   * Requirements: 7.5
   */
  async queryLearning(query: string, limit: number = 10): Promise<LearningEntry[]> {
    await this.initialize();

    // FIX: 空查询时直接从本地缓存返回最近条目，跳过知识库向量搜索
    // 避免对空字符串调用嵌入 API（耗时且无意义），这是进化配置页面加载慢的根因
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      let localResults = this.searchLocalCache('', limit);

      // FIX: 如果缓存为空或不足（可能被 cleanupExpiredCache 清理了），从磁盘重新加载
      // 这是反思记录消失的根因：缓存清理后 loadRecentEntries 不会自动重新执行
      if (localResults.length < limit && this.learningCache.size < limit) {
        logger.info(`queryLearning: cache insufficient (${this.learningCache.size} entries), reloading from disk`);
        await this.loadRecentEntries();
        localResults = this.searchLocalCache('', limit);
      }

      return localResults
        .map(e => ensureLearningEntryDefaults(e))
        .filter(e => e.status !== 'deprecated' && e.confidence >= 0.2)
        .slice(0, limit);
    }

    const results: LearningEntry[] = [];

    try {
      const kb = await this.getKnowledgeBase();

      // 从知识库搜索
      const searchResults = await kb.search({
        query: trimmedQuery,
        type: 'learning',
        limit,
      });

      // 转换回 LearningEntry
      for (const result of searchResults) {
        const originalData = result.entry.metadata?.originalData as Record<string, unknown> | undefined;
        const learningEntryId = originalData?.learningEntryId as string;

        if (learningEntryId) {
          // 从缓存或磁盘加载完整的学习条目（自动补充默认值）
          const entry = await this.getLearningEntry(learningEntryId);
          if (entry) {
            results.push(entry);
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to query learning from knowledge base:', error);
    }

    // 如果知识库查询失败或结果不足，从本地缓存补充
    if (results.length < limit) {
      const localResults = this.searchLocalCache(trimmedQuery, limit - results.length);
      // 对本地缓存结果也补充默认值
      results.push(...localResults.map(e => ensureLearningEntryDefaults(e)));
    }

    // 过滤掉 deprecated 和低置信度条目
    // Requirements: conversation-and-reflection-optimization 3.3, 3.5
    return results
      .filter(e => e.status !== 'deprecated' && e.confidence >= 0.2)
      .slice(0, limit);
  }

  /**
   * 获取学习条目
   */
  private async getLearningEntry(id: string): Promise<LearningEntry | null> {
    // 先从缓存查找
    const cached = this.learningCache.get(id);
    if (cached) {
      return ensureLearningEntryDefaults(cached);
    }

    // 从索引查找文件位置
    const indexEntry = this.learningIndex.entries.find(e => e.id === id);
    if (indexEntry) {
      try {
        const filePath = path.join(ENTRIES_DIR, `${indexEntry.dateFile}.json`);
        const content = await fs.readFile(filePath, 'utf-8');
        const entries = JSON.parse(content) as LearningEntry[];
        const found = entries.find(e => e.id === id);
        if (found) {
          const withDefaults = ensureLearningEntryDefaults(found);
          this.learningCache.set(withDefaults.id, withDefaults);
          return withDefaults;
        }
      } catch (error) {
        logger.debug(`Failed to load learning entry ${id}:`, error);
      }
    }

    return null;
  }

  /**
   * 搜索本地缓存
   */
  private searchLocalCache(query: string, limit: number): LearningEntry[] {
    const queryLower = query.toLowerCase().trim();

    // 空查询时，按时间戳降序返回最新条目
    if (!queryLower) {
      return Array.from(this.learningCache.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    }

    const results: Array<{ entry: LearningEntry; score: number }> = [];

    for (const entry of this.learningCache.values()) {
      let score = 0;

      // 匹配失败模式
      if (entry.failurePattern.toLowerCase().includes(queryLower)) {
        score += 3;
      }

      // 匹配根因
      if (entry.rootCause.toLowerCase().includes(queryLower)) {
        score += 2;
      }

      // 匹配有效方案
      if (entry.effectiveSolution?.toLowerCase().includes(queryLower)) {
        score += 2;
      }

      // 匹配无效方法
      if (entry.ineffectiveApproaches.some(a => a.toLowerCase().includes(queryLower))) {
        score += 1;
      }

      // 匹配意图 (新增: 支持意图级别匹配)
      if (entry.contextFactors?.intent?.toLowerCase().includes(queryLower)) {
        score += 4; // 意图匹配权重最高
      }

      // 匹配原始消息
      if (entry.contextFactors?.originalMessage?.toLowerCase().includes(queryLower)) {
        score += 2;
      }

      if (score > 0) {
        results.push({ entry, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit)
      .map(r => r.entry);
  }

  /**
   * 按失败模式搜索学习内容
   * Requirements: 14.5
   */
  async searchByFailurePattern(pattern: string, limit: number = 10): Promise<LearningEntry[]> {
    await this.initialize();

    const results: LearningEntry[] = [];
    const patternLower = pattern.toLowerCase();

    // 从索引中查找匹配的条目
    const matchingIndexEntries = this.learningIndex.entries
      .filter(e => e.failurePattern.toLowerCase().includes(patternLower))
      .slice(0, limit);

    for (const indexEntry of matchingIndexEntries) {
      const entry = await this.getLearningEntry(indexEntry.id);
      if (entry) {
        results.push(entry);
      }
    }

    // 如果结果不足，从缓存补充
    if (results.length < limit) {
      for (const entry of this.learningCache.values()) {
        if (
          entry.failurePattern.toLowerCase().includes(patternLower) &&
          !results.some(r => r.id === entry.id)
        ) {
          results.push(entry);
          if (results.length >= limit) break;
        }
      }
    }

    return results;
  }

  /**
   * 获取反思统计
   * Requirements: 18.3, 18.4
   */
  async getStats(): Promise<ReflectorStats> {
    await this.initialize();

    const entries = Array.from(this.learningCache.values());

    // 统计决策分布（从索引推断）
    const decisionDistribution: Record<NextAction, number> = {
      retry_same: 0,
      retry_modified: 0,
      try_alternative: 0,
      escalate: 0,
      rollback: 0,
      complete: 0,
    };

    // 从学习条目推断决策分布
    for (const entry of entries) {
      if (entry.effectiveSolution) {
        decisionDistribution.complete++;
      } else if (entry.ineffectiveApproaches.length > 2) {
        decisionDistribution.escalate++;
      } else if (entry.ineffectiveApproaches.length > 0) {
        decisionDistribution.try_alternative++;
      } else {
        decisionDistribution.retry_same++;
      }
    }

    // 计算平均成功迭代次数
    const successfulEntries = entries.filter(e => e.effectiveSolution);
    const avgIterations = successfulEntries.length > 0
      ? successfulEntries.reduce((sum, e) => sum + (e.ineffectiveApproaches.length + 1), 0) / successfulEntries.length
      : 0;

    return {
      totalReflections: this.learningIndex.entries.length,
      decisionDistribution,
      learningEntriesCount: entries.length,
      averageIterationsToSuccess: Math.round(avgIterations * 100) / 100,
      lastUpdated: Date.now(),
    };
  }

  // ==================== 经验提取方法 ====================
  // Requirements: 2.1.1, 2.1.2, 2.1.4

  /**
   * 从对话历史中提取经验
   * Requirements: 2.1.1, 2.1.2, 2.1.4
   * 
   * @param sessionId 会话 ID
   * @param conversationHistory 对话历史
   * @param reActSteps ReAct 步骤（Thought-Action-Observation 链条）
   * @returns 提取的经验
   */
  async extractExperienceFromSession(
    sessionId: string,
    conversationHistory: Array<{ role: string; content: string }>,
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>
  ): Promise<{
    id: string;
    sessionId: string;
    timestamp: number;
    summary: string;
    thoughtActionChain: string;
    keyInsights: string[];
    effectiveTools: string[];
    problemPattern: string;
    solutionApproach: string;
    confidence: number;
  }> {
    await this.initialize();

    const experienceId = uuidv4();
    const now = Date.now();

    // 提取 Thought-Action-Observation 链条
    const thoughtActionChain = this.extractThoughtActionChain(reActSteps);

    // 提取关键洞察
    const keyInsights = this.extractKeyInsights(conversationHistory, reActSteps);

    // 提取有效工具
    const effectiveTools = this.extractEffectiveTools(reActSteps);

    // 识别问题模式
    const problemPattern = this.identifyProblemPattern(conversationHistory);

    // 提取解决方案方法
    const solutionApproach = this.extractSolutionApproach(reActSteps, conversationHistory);

    // 生成摘要
    const summary = await this.generateExperienceSummary(
      conversationHistory,
      reActSteps,
      problemPattern,
      solutionApproach
    );

    // 计算置信度
    const confidence = this.calculateExperienceConfidence(reActSteps, conversationHistory);

    logger.info(`Experience extracted from session ${sessionId}: ${experienceId}`);

    return {
      id: experienceId,
      sessionId,
      timestamp: now,
      summary,
      thoughtActionChain,
      keyInsights,
      effectiveTools,
      problemPattern,
      solutionApproach,
      confidence,
    };
  }

  /**
   * 提取 Thought-Action-Observation 链条
   * Requirements: 2.1.2
   */
  private extractThoughtActionChain(
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>
  ): string {
    if (!reActSteps || reActSteps.length === 0) {
      return '无 ReAct 步骤记录';
    }

    const chains: string[] = [];
    for (let i = 0; i < reActSteps.length; i++) {
      const step = reActSteps[i];
      const parts: string[] = [];

      parts.push(`步骤 ${i + 1}:`);
      parts.push(`  思考: ${step.thought.substring(0, 200)}${step.thought.length > 200 ? '...' : ''}`);

      if (step.action) {
        parts.push(`  行动: ${step.action.tool}(${JSON.stringify(step.action.params).substring(0, 100)})`);
      }

      if (step.observation) {
        parts.push(`  观察: ${step.observation.substring(0, 150)}${step.observation.length > 150 ? '...' : ''}`);
      }

      if (step.success !== undefined) {
        parts.push(`  结果: ${step.success ? '成功' : '失败'}`);
      }

      chains.push(parts.join('\n'));
    }

    return chains.join('\n\n');
  }

  /**
   * 提取关键洞察
   * Requirements: 2.1.4
   */
  private extractKeyInsights(
    conversationHistory: Array<{ role: string; content: string }>,
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>
  ): string[] {
    const insights: string[] = [];

    // 从成功的步骤中提取洞察
    if (reActSteps) {
      const successfulSteps = reActSteps.filter(s => s.success === true);
      for (const step of successfulSteps) {
        if (step.thought && step.thought.length > 20) {
          // 提取思考中的关键点
          const keyPoint = this.extractKeyPoint(step.thought);
          if (keyPoint) {
            insights.push(keyPoint);
          }
        }
      }
    }

    // 从对话中提取用户确认的洞察
    for (let i = 0; i < conversationHistory.length - 1; i++) {
      const current = conversationHistory[i];
      const next = conversationHistory[i + 1];

      if (current.role === 'assistant' && next.role === 'user') {
        // 检查用户是否确认了助手的建议
        const userContent = next.content.toLowerCase();
        if (userContent.includes('好的') || userContent.includes('可以') ||
          userContent.includes('执行') || userContent.includes('确认')) {
          const insight = this.extractKeyPoint(current.content);
          if (insight) {
            insights.push(insight);
          }
        }
      }
    }

    // 去重并限制数量
    return [...new Set(insights)].slice(0, 5);
  }

  /**
   * 提取关键点
   */
  private extractKeyPoint(text: string): string | null {
    // 查找包含关键词的句子
    const keywords = ['因为', '所以', '建议', '需要', '应该', '发现', '问题是', '解决方案'];
    const sentences = text.split(/[。！？\n]/);

    for (const sentence of sentences) {
      for (const keyword of keywords) {
        if (sentence.includes(keyword) && sentence.length > 10 && sentence.length < 200) {
          return sentence.trim();
        }
      }
    }

    // 如果没有找到关键句，返回第一个有意义的句子
    const firstMeaningful = sentences.find(s => s.trim().length > 20 && s.trim().length < 200);
    return firstMeaningful?.trim() || null;
  }

  /**
   * 提取有效工具
   */
  private extractEffectiveTools(
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>
  ): string[] {
    if (!reActSteps) return [];

    const effectiveTools: string[] = [];
    for (const step of reActSteps) {
      if (step.action && step.success === true) {
        effectiveTools.push(step.action.tool);
      }
    }

    return [...new Set(effectiveTools)];
  }

  /**
   * 识别问题模式
   */
  private identifyProblemPattern(
    conversationHistory: Array<{ role: string; content: string }>
  ): string {
    // 查找用户的第一个问题
    const userMessages = conversationHistory.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      return '未识别问题模式';
    }

    const firstQuestion = userMessages[0].content;

    // 识别问题类型
    const patterns = [
      { keywords: ['故障', '错误', '失败', '不工作', '异常'], pattern: '故障诊断' },
      { keywords: ['配置', '设置', '修改', '更改'], pattern: '配置管理' },
      { keywords: ['性能', '慢', '延迟', '负载'], pattern: '性能优化' },
      { keywords: ['安全', '防火墙', '访问', '权限'], pattern: '安全管理' },
      { keywords: ['监控', '告警', '日志', '状态'], pattern: '监控运维' },
      { keywords: ['网络', '连接', '路由', '接口'], pattern: '网络管理' },
    ];

    for (const { keywords, pattern } of patterns) {
      if (keywords.some(k => firstQuestion.includes(k))) {
        return pattern;
      }
    }

    return '通用运维问题';
  }

  /**
   * 提取解决方案方法
   */
  private extractSolutionApproach(
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>,
    conversationHistory?: Array<{ role: string; content: string }>
  ): string {
    const approaches: string[] = [];

    // 从成功的 ReAct 步骤中提取方法
    if (reActSteps) {
      const successfulSteps = reActSteps.filter(s => s.success === true);
      for (const step of successfulSteps) {
        if (step.action) {
          approaches.push(`使用 ${step.action.tool} 工具`);
        }
      }
    }

    // 从对话中提取方法描述
    if (conversationHistory) {
      const assistantMessages = conversationHistory.filter(m => m.role === 'assistant');
      for (const msg of assistantMessages) {
        if (msg.content.includes('解决方案') || msg.content.includes('建议')) {
          const approach = this.extractKeyPoint(msg.content);
          if (approach) {
            approaches.push(approach);
          }
        }
      }
    }

    if (approaches.length === 0) {
      return '未提取到明确的解决方案方法';
    }

    return approaches.slice(0, 3).join('；');
  }

  /**
   * 生成经验摘要
   */
  private async generateExperienceSummary(
    conversationHistory: Array<{ role: string; content: string }>,
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>,
    problemPattern?: string,
    solutionApproach?: string
  ): Promise<string> {
    const parts: string[] = [];

    // 问题描述
    const userMessages = conversationHistory.filter(m => m.role === 'user');
    if (userMessages.length > 0) {
      const firstQuestion = userMessages[0].content.substring(0, 100);
      parts.push(`问题: ${firstQuestion}${userMessages[0].content.length > 100 ? '...' : ''}`);
    }

    // 问题类型
    if (problemPattern) {
      parts.push(`类型: ${problemPattern}`);
    }

    // 解决方案
    if (solutionApproach) {
      parts.push(`方案: ${solutionApproach}`);
    }

    // 结果
    if (reActSteps && reActSteps.length > 0) {
      const successCount = reActSteps.filter(s => s.success === true).length;
      const totalSteps = reActSteps.length;
      parts.push(`结果: ${successCount}/${totalSteps} 步骤成功`);
    }

    return parts.join('。');
  }

  /**
   * 计算经验置信度
   */
  private calculateExperienceConfidence(
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>,
    conversationHistory?: Array<{ role: string; content: string }>
  ): number {
    // 多维度加权置信度计算
    // 维度1: 步骤成功率 (权重 0.35)
    let stepSuccessScore = 0;
    if (reActSteps && reActSteps.length > 0) {
      const successCount = reActSteps.filter(s => s.success === true).length;
      const successRate = successCount / reActSteps.length;
      stepSuccessScore = successRate; // 0-1 线性映射
    }

    // 维度2: 对话深度与质量 (权重 0.20)
    let conversationDepth = 0;
    if (conversationHistory) {
      const msgCount = conversationHistory.length;
      // 渐进式评分，不再是简单的 >4 阈值
      if (msgCount >= 8) conversationDepth = 1.0;
      else if (msgCount >= 6) conversationDepth = 0.8;
      else if (msgCount >= 4) conversationDepth = 0.6;
      else if (msgCount >= 2) conversationDepth = 0.4;
      else conversationDepth = 0.2;
    }

    // 维度3: 工具使用多样性 (权重 0.25)
    let toolDiversity = 0;
    if (reActSteps) {
      const uniqueTools = new Set(reActSteps.filter(s => s.action).map(s => s.action!.tool));
      const toolCount = uniqueTools.size;
      if (toolCount >= 3) toolDiversity = 1.0;
      else if (toolCount >= 2) toolDiversity = 0.7;
      else if (toolCount >= 1) toolDiversity = 0.4;
    }

    // 维度4: 解决方案完整性 (权重 0.20)
    let solutionCompleteness = 0;
    if (reActSteps && reActSteps.length > 0) {
      // 有思考过程
      const hasThoughts = reActSteps.some(s => s.thought && s.thought.length > 20);
      // 有观察结果
      const hasObservations = reActSteps.some(s => s.observation && s.observation.length > 10);
      // 最后一步成功
      const lastStepSuccess = reActSteps[reActSteps.length - 1]?.success === true;

      if (hasThoughts) solutionCompleteness += 0.3;
      if (hasObservations) solutionCompleteness += 0.3;
      if (lastStepSuccess) solutionCompleteness += 0.4;
    }

    // 加权汇总
    const confidence =
      stepSuccessScore * 0.35 +
      conversationDepth * 0.20 +
      toolDiversity * 0.25 +
      solutionCompleteness * 0.20;

    // 基础下限 0.1，上限 0.98
    return Math.min(0.98, Math.max(0.1, confidence));
  }
}

// 导出单例
export const reflectorService = new ReflectorService();
