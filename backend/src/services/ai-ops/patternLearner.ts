/**
 * PatternLearner - 模式学习器
 * 
 * 学习运维人员的操作习惯和模式
 * 
 * Requirements: 8.1.1, 8.1.2, 8.1.3, 8.1.4, 8.1.5
 * - 8.1.1: 操作记录
 * - 8.1.2: 模式识别
 * - 8.1.3: 模式存储
 * - 8.1.4: 推荐生成
 * - 8.1.5: 模式管理
 */

import { logger } from '../../utils/logger';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getCapabilityConfig } from './evolutionConfig';
import { knowledgeBase } from './rag/knowledgeBase';
import type { DataStore } from '../dataStore';

/**
 * 用户操作记录
 */
export interface UserOperation {
  /** 操作 ID */
  id: string;
  /** 用户 ID */
  userId: string;
  /** 会话 ID */
  sessionId: string;
  /** 工具名称 */
  toolName: string;
  /** 操作参数 */
  parameters: Record<string, unknown>;
  /** 操作结果 */
  result: 'success' | 'failure';
  /** 时间戳 */
  timestamp: number;
  /** 上下文信息 */
  context?: Record<string, unknown>;
}

/**
 * 操作模式
 */
export interface OperationPattern {
  /** 模式 ID */
  id: string;
  /** 用户 ID */
  userId: string;
  /** 模式类型 */
  type: 'sequence' | 'combination' | 'preference';
  /** 操作序列 */
  sequence: string[];
  /** 出现频率 */
  frequency: number;
  /** 置信度 */
  confidence: number;
  /** 首次发现时间 */
  firstSeen: number;
  /** 最后出现时间 */
  lastSeen: number;
  /** 平均间隔 (ms) */
  avgInterval?: number;
  /** 成功率 */
  successRate: number;
  /** 是否已验证（超过延迟天数后标记为 true） */
  verified?: boolean;
  /** 正面反馈次数 */
  positiveFeedbackCount?: number;
  /** 关联上下文 */
  associatedContext?: Record<string, unknown>;
}

/**
 * 操作推荐
 */
export interface OperationRecommendation {
  /** 推荐 ID */
  id: string;
  /** 推荐的工具 */
  toolName: string;
  /** 推荐的参数 */
  suggestedParams?: Record<string, unknown>;
  /** 置信度 */
  confidence: number;
  /** 基于的模式 */
  basedOnPattern: string;
  /** 推荐原因 */
  reason: string;
}

/**
 * 操作上下文
 */
export interface OperationContext {
  /** 用户 ID */
  userId: string;
  /** 当前会话 ID */
  sessionId: string;
  /** 最近的操作 */
  recentOperations: string[];
  /** 当前时间 */
  currentTime: number;
  /** 其他上下文 */
  metadata?: Record<string, unknown>;
}

/**
 * 模式学习器配置
 */
export interface PatternLearnerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 最小序列长度 */
  minSequenceLength: number;
  /** 最大序列长度 */
  maxSequenceLength: number;
  /** 最小频率阈值 */
  minFrequencyThreshold: number;
  /** 最小置信度阈值 */
  minConfidenceThreshold: number;
  /** 操作历史保留数量 */
  maxOperationHistory: number;
  /** 模式存储路径 */
  storagePath: string;
  /** 学习延迟天数 */
  learningDelayDays: number;
}

const DEFAULT_CONFIG: PatternLearnerConfig = {
  enabled: true,
  minSequenceLength: 2,
  maxSequenceLength: 5,
  minFrequencyThreshold: 3,
  minConfidenceThreshold: 0.6,
  maxOperationHistory: 1000,
  storagePath: 'data/ai-ops/patterns',
  learningDelayDays: 7,
};


/**
 * PatternLearner 类
 */
export class PatternLearner extends EventEmitter {
  private config: PatternLearnerConfig;
  private operations: Map<string, UserOperation[]> = new Map(); // userId -> operations
  private patterns: Map<string, OperationPattern[]> = new Map(); // userId -> patterns
  private operationIdCounter = 0;
  private patternIdCounter = 0;
  private recommendationIdCounter = 0;

  // PostgreSQL DataStore (Requirements: C3.12)
  private pgDataStore: DataStore | null = null;

  /** Check if PostgreSQL DataStore is available */
  private get usePg(): boolean {
    return this.pgDataStore !== null;
  }

  constructor(config?: Partial<PatternLearnerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('PatternLearner created', { config: this.config });
  }

  /**
   * 设置 PostgreSQL DataStore 实例
   * Requirements: C3.12 - 统一迁移至 PostgreSQL
   */
  setDataStore(ds: DataStore): void {
    this.pgDataStore = ds;
    logger.info('PatternLearner: PgDataStore configured, PostgreSQL persistence enabled');
  }

  /**
   * 记录用户操作
   * Requirements: 8.1.1
   */
  recordOperation(operation: Omit<UserOperation, 'id'>): UserOperation {
    if (!this.config.enabled) {
      return { ...operation, id: 'disabled' } as UserOperation;
    }

    const fullOperation: UserOperation = {
      ...operation,
      id: `op_${++this.operationIdCounter}_${Date.now()}`,
    };

    // 获取或创建用户操作历史
    const userOps = this.operations.get(operation.userId) || [];
    userOps.push(fullOperation);

    // 保持历史大小限制
    while (userOps.length > this.config.maxOperationHistory) {
      userOps.shift();
    }

    this.operations.set(operation.userId, userOps);

    logger.debug('Operation recorded', {
      operationId: fullOperation.id,
      userId: operation.userId,
      toolName: operation.toolName,
    });

    this.emit('operationRecorded', fullOperation);

    // 触发模式学习
    this.learnPatterns(operation.userId);

    return fullOperation;
  }

  /**
   * 识别用户模式
   * Requirements: 8.1.2
   */
  identifyPatterns(userId: string): OperationPattern[] {
    const userOps = this.operations.get(userId);
    if (!userOps || userOps.length < this.config.minSequenceLength) {
      return [];
    }

    const patterns: OperationPattern[] = [];
    const sequenceCounts = new Map<string, { count: number; timestamps: number[]; successes: number }>();

    // 提取所有可能的序列
    for (let len = this.config.minSequenceLength; len <= this.config.maxSequenceLength; len++) {
      for (let i = 0; i <= userOps.length - len; i++) {
        const sequence = userOps.slice(i, i + len).map(op => op.toolName);
        const key = sequence.join('->');
        
        const existing = sequenceCounts.get(key) || { count: 0, timestamps: [], successes: 0 };
        existing.count++;
        existing.timestamps.push(userOps[i].timestamp);
        if (userOps[i + len - 1].result === 'success') {
          existing.successes++;
        }
        sequenceCounts.set(key, existing);
      }
    }

    // 过滤并创建模式
    for (const [key, data] of sequenceCounts) {
      if (data.count >= this.config.minFrequencyThreshold) {
        const sequence = key.split('->');
        const confidence = this.calculateConfidence(data.count, userOps.length, sequence.length);
        
        if (confidence >= this.config.minConfidenceThreshold) {
          const avgInterval = this.calculateAverageInterval(data.timestamps);
          
          patterns.push({
            id: `pat_${++this.patternIdCounter}_${Date.now()}`,
            userId,
            type: 'sequence',
            sequence,
            frequency: data.count,
            confidence,
            firstSeen: Math.min(...data.timestamps),
            lastSeen: Math.max(...data.timestamps),
            avgInterval,
            successRate: data.successes / data.count,
          });
        }
      }
    }

    // 按频率和置信度排序
    patterns.sort((a, b) => (b.frequency * b.confidence) - (a.frequency * a.confidence));

    // Requirements 5.2: 检查模式验证延迟
    // 当模式创建时间超过 patternLearningDelayDays 天后，标记为 verified
    try {
      const clConfig = getCapabilityConfig('continuousLearning');
      const delayMs = clConfig.patternLearningDelayDays * 86400000;
      const now = Date.now();
      for (const pattern of patterns) {
        if (now - pattern.firstSeen > delayMs) {
          pattern.verified = true;
        }
      }
    } catch {
      // 配置不可用时跳过验证标记
      logger.debug('PatternLearner: Could not read continuousLearning config for verification delay');
    }

    return patterns;
  }

  /**
   * 学习并更新模式
   * Requirements: 8.1.3
   */
  /**
   * 触发模式学习并存储结果
   * 公开方法，供 ContinuousLearner 定时器调用
   * @param userId 用户 ID
   */
  triggerLearnPatterns(userId: string): void {
    this.learnPatterns(userId);
  }

  private learnPatterns(userId: string): void {
    const newPatterns = this.identifyPatterns(userId);
    const existingPatterns = this.patterns.get(userId) || [];

    // 合并新旧模式
    const mergedPatterns = this.mergePatterns(existingPatterns, newPatterns);
    this.patterns.set(userId, mergedPatterns);

    if (newPatterns.length > 0) {
      this.emit('patternsLearned', { userId, patterns: newPatterns });
    }
  }

  /**
   * 获取操作推荐
   * Requirements: 8.1.4
   */
  getRecommendations(context: OperationContext): OperationRecommendation[] {
    if (!this.config.enabled) {
      return [];
    }

    const userPatterns = this.patterns.get(context.userId) || [];
    if (userPatterns.length === 0) {
      return [];
    }

    const recommendations: OperationRecommendation[] = [];
    const recentOps = context.recentOperations;

    for (const pattern of userPatterns) {
      // Requirements 5.2: 仅已验证的模式参与推荐
      if (!pattern.verified) {
        continue;
      }

      // 检查最近操作是否匹配模式前缀
      const matchLength = this.findPrefixMatch(recentOps, pattern.sequence);
      
      if (matchLength > 0 && matchLength < pattern.sequence.length) {
        // 推荐下一个操作
        const nextTool = pattern.sequence[matchLength];
        
        recommendations.push({
          id: `rec_${++this.recommendationIdCounter}_${Date.now()}`,
          toolName: nextTool,
          confidence: pattern.confidence * (matchLength / pattern.sequence.length),
          basedOnPattern: pattern.id,
          reason: `基于历史模式 "${pattern.sequence.join(' -> ')}"，建议执行 ${nextTool}`,
        });
      }
    }

    // 按置信度排序并去重
    const uniqueRecommendations = this.deduplicateRecommendations(recommendations);
    uniqueRecommendations.sort((a, b) => b.confidence - a.confidence);

    return uniqueRecommendations.slice(0, 5); // 最多返回 5 个推荐
  }

  /**
   * 获取用户模式
   */
  getPatterns(userId: string): OperationPattern[] {
    return [...(this.patterns.get(userId) || [])];
  }

  /**
   * 获取所有模式
   */
  getAllPatterns(): Map<string, OperationPattern[]> {
    return new Map(this.patterns);
  }

  /**
   * 删除模式
   * Requirements: 8.1.5
   */
  deletePattern(patternId: string): boolean {
    for (const [userId, patterns] of this.patterns) {
      const index = patterns.findIndex(p => p.id === patternId);
      if (index !== -1) {
        patterns.splice(index, 1);
        this.patterns.set(userId, patterns);
        logger.info('Pattern deleted', { patternId, userId });
        this.emit('patternDeleted', { patternId, userId });
        return true;
      }
    }
    return false;
  }

  /**
   * 将模式提取为最佳实践文档并通过 Knowledge_Base 索引存储
   * Requirements: 5.3
   * @param patternId 模式 ID
   * @returns 创建的知识条目，如果模式未找到则返回 null
   */
  async promoteToBestPractice(patternId: string): Promise<{ id: string; title: string } | null> {
    // 在所有用户的模式中查找目标模式
    let targetPattern: OperationPattern | null = null;
    let targetUserId: string | null = null;

    for (const [userId, patterns] of this.patterns) {
      const found = patterns.find(p => p.id === patternId);
      if (found) {
        targetPattern = found;
        targetUserId = userId;
        break;
      }
    }

    if (!targetPattern || !targetUserId) {
      logger.warn('PatternLearner: Pattern not found for best practice promotion', { patternId });
      return null;
    }

    try {
      // 构建最佳实践文档内容
      const content = this.buildBestPracticeContent(targetPattern, targetUserId);

      // 通过 Knowledge_Base 索引存储
      const entry = await knowledgeBase.add({
        type: 'learning',
        title: `最佳实践: ${targetPattern.sequence.join(' -> ')}`,
        content,
        metadata: {
          source: 'pattern-learner',
          timestamp: Date.now(),
          category: 'best-practice',
          tags: ['best-practice', 'pattern', ...targetPattern.sequence],
          usageCount: 0,
          feedbackScore: 0,
          feedbackCount: 0,
          originalData: {
            patternId: targetPattern.id,
            userId: targetUserId,
            sequence: targetPattern.sequence,
            frequency: targetPattern.frequency,
            confidence: targetPattern.confidence,
            successRate: targetPattern.successRate,
          },
        },
      });

      logger.info('PatternLearner: Pattern promoted to best practice', {
        patternId,
        userId: targetUserId,
        knowledgeEntryId: entry.id,
        sequence: targetPattern.sequence,
      });

      this.emit('bestPracticePromoted', {
        patternId,
        userId: targetUserId,
        knowledgeEntryId: entry.id,
      });

      return { id: entry.id, title: entry.title };
    } catch (error) {
      logger.error('PatternLearner: Failed to promote pattern to best practice', {
        patternId,
        error,
      });
      return null;
    }
  }

  /**
   * 构建最佳实践文档内容
   */
  private buildBestPracticeContent(pattern: OperationPattern, userId: string): string {
    const lines: string[] = [
      `# 最佳实践: ${pattern.sequence.join(' -> ')}`,
      '',
      `## 概述`,
      `该操作模式由用户 ${userId} 的历史操作中自动识别并提取。`,
      '',
      `## 操作序列`,
      pattern.sequence.map((step, i) => `${i + 1}. ${step}`).join('\n'),
      '',
      `## 统计信息`,
      `- 出现频率: ${pattern.frequency} 次`,
      `- 置信度: ${(pattern.confidence * 100).toFixed(1)}%`,
      `- 成功率: ${(pattern.successRate * 100).toFixed(1)}%`,
      `- 首次发现: ${new Date(pattern.firstSeen).toISOString()}`,
      `- 最后出现: ${new Date(pattern.lastSeen).toISOString()}`,
    ];

    if (pattern.avgInterval) {
      lines.push(`- 平均间隔: ${(pattern.avgInterval / 1000).toFixed(1)} 秒`);
    }

    return lines.join('\n');
  }

  /**
   * 清除用户数据
   */
  clearUserData(userId: string): void {
    this.operations.delete(userId);
    this.patterns.delete(userId);
    logger.info('User data cleared', { userId });
  }

  /**
   * 保存模式到文件
   */
  async savePatterns(): Promise<void> {
    // PostgreSQL path
    if (this.usePg) {
      try {
        await this.pgDataStore!.transaction(async (tx) => {
          for (const [userId, userPatterns] of this.patterns) {
            for (const pattern of userPatterns) {
              await tx.execute(
                `INSERT INTO learned_patterns (id, user_id, type, sequence, frequency, confidence, first_seen, last_seen, avg_interval, success_rate, verified, data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (id) DO UPDATE SET
                   frequency = EXCLUDED.frequency, confidence = EXCLUDED.confidence,
                   last_seen = EXCLUDED.last_seen, avg_interval = EXCLUDED.avg_interval,
                   success_rate = EXCLUDED.success_rate, verified = EXCLUDED.verified,
                   data = EXCLUDED.data`,
                [
                  pattern.id,
                  userId,
                  pattern.type,
                  JSON.stringify(pattern.sequence),
                  pattern.frequency,
                  pattern.confidence,
                  pattern.firstSeen,
                  pattern.lastSeen,
                  pattern.avgInterval || null,
                  pattern.successRate,
                  pattern.verified || false,
                  JSON.stringify(pattern),
                ]
              );
            }
          }
        });
        logger.debug('Patterns saved to PostgreSQL', { userCount: this.patterns.size });
        return;
      } catch (error) {
        logger.warn('Failed to save patterns to PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    try {
      await fs.mkdir(this.config.storagePath, { recursive: true });
      
      const data = {
        patterns: Object.fromEntries(this.patterns),
        savedAt: Date.now(),
      };
      
      const filepath = path.join(this.config.storagePath, 'patterns.json');
      await fs.writeFile(filepath, JSON.stringify(data, null, 2));
      
      logger.debug('Patterns saved', { filepath });
    } catch (error) {
      logger.error('Failed to save patterns', { error });
    }
  }

  /**
   * 从文件加载模式
   */
  async loadPatterns(): Promise<void> {
    // PostgreSQL path
    if (this.usePg) {
      try {
        const rows = await this.pgDataStore!.query<{
          id: string;
          user_id: string;
          data: string;
        }>('SELECT id, user_id, data FROM learned_patterns');

        if (rows.length > 0) {
          const patternsMap = new Map<string, OperationPattern[]>();
          for (const row of rows) {
            const pattern: OperationPattern = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            const userId = row.user_id;
            const existing = patternsMap.get(userId) || [];
            existing.push(pattern);
            patternsMap.set(userId, existing);
          }
          this.patterns = patternsMap;
          logger.info('Patterns loaded from PostgreSQL', { userCount: this.patterns.size });
          return;
        }
      } catch (error) {
        logger.warn('Failed to load patterns from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    try {
      const filepath = path.join(this.config.storagePath, 'patterns.json');
      const content = await fs.readFile(filepath, 'utf-8');
      const data = JSON.parse(content);
      
      if (data.patterns) {
        this.patterns = new Map(Object.entries(data.patterns));
        logger.info('Patterns loaded', { userCount: this.patterns.size });
      }
    } catch (error) {
      // 文件不存在是正常的
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load patterns', { error });
      }
    }
  }

  /**
   * 获取操作历史
   */
  getOperationHistory(userId: string, limit?: number): UserOperation[] {
    const ops = this.operations.get(userId) || [];
    if (limit) {
      return ops.slice(-limit);
    }
    return [...ops];
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalUsers: number;
    totalOperations: number;
    totalPatterns: number;
    avgPatternsPerUser: number;
  } {
    let totalOperations = 0;
    let totalPatterns = 0;

    for (const ops of this.operations.values()) {
      totalOperations += ops.length;
    }

    for (const patterns of this.patterns.values()) {
      totalPatterns += patterns.length;
    }

    const totalUsers = this.operations.size;

    return {
      totalUsers,
      totalOperations,
      totalPatterns,
      avgPatternsPerUser: totalUsers > 0 ? totalPatterns / totalUsers : 0,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PatternLearnerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('PatternLearner config updated', { config: this.config });
  }

  /**
   * 关闭学习器
   */
  async shutdown(): Promise<void> {
    await this.savePatterns();
    this.removeAllListeners();
    logger.info('PatternLearner shutdown');
  }

  // ==================== 私有方法 ====================

  private calculateConfidence(frequency: number, totalOps: number, seqLength: number): number {
    // 基于频率和序列长度计算置信度
    const frequencyScore = Math.min(frequency / 10, 1); // 频率得分
    const coverageScore = frequency / (totalOps - seqLength + 1); // 覆盖率得分
    const lengthBonus = Math.min(seqLength / this.config.maxSequenceLength, 1) * 0.2; // 长度奖励
    
    return Math.min((frequencyScore * 0.5 + coverageScore * 0.3 + lengthBonus), 1);
  }

  private calculateAverageInterval(timestamps: number[]): number {
    if (timestamps.length < 2) return 0;
    
    const sorted = [...timestamps].sort((a, b) => a - b);
    let totalInterval = 0;
    
    for (let i = 1; i < sorted.length; i++) {
      totalInterval += sorted[i] - sorted[i - 1];
    }
    
    return totalInterval / (sorted.length - 1);
  }

  private findPrefixMatch(recent: string[], sequence: string[]): number {
    let matchLength = 0;
    
    for (let i = 0; i < Math.min(recent.length, sequence.length); i++) {
      if (recent[recent.length - 1 - i] === sequence[sequence.length - 1 - i - (sequence.length - recent.length)]) {
        matchLength++;
      } else {
        break;
      }
    }
    
    // 从头开始匹配
    for (let start = 0; start <= sequence.length - recent.length; start++) {
      let match = true;
      for (let i = 0; i < recent.length; i++) {
        if (recent[i] !== sequence[start + i]) {
          match = false;
          break;
        }
      }
      if (match) {
        return recent.length;
      }
    }
    
    return 0;
  }

  private mergePatterns(existing: OperationPattern[], newPatterns: OperationPattern[]): OperationPattern[] {
    const merged = new Map<string, OperationPattern>();
    
    // 添加现有模式
    for (const pattern of existing) {
      const key = pattern.sequence.join('->');
      merged.set(key, pattern);
    }
    
    // 合并新模式
    for (const pattern of newPatterns) {
      const key = pattern.sequence.join('->');
      const existing = merged.get(key);
      
      if (existing) {
        // 更新现有模式
        existing.frequency = pattern.frequency;
        existing.confidence = pattern.confidence;
        existing.lastSeen = pattern.lastSeen;
        existing.successRate = pattern.successRate;
        existing.avgInterval = pattern.avgInterval;
        // 保留 verified 状态：一旦验证通过不会回退
        if (pattern.verified) {
          existing.verified = true;
        }
      } else {
        merged.set(key, pattern);
      }
    }
    
    return Array.from(merged.values());
  }

  private deduplicateRecommendations(recommendations: OperationRecommendation[]): OperationRecommendation[] {
    const seen = new Set<string>();
    return recommendations.filter(rec => {
      if (seen.has(rec.toolName)) {
        return false;
      }
      seen.add(rec.toolName);
      return true;
    });
  }
}

// 导出单例实例
export const patternLearner = new PatternLearner();
