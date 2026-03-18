/**
 * FeedbackService 用户反馈服务
 * 负责收集和管理用户对告警的反馈
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 * - 10.1: 记录用户对告警的有用/无用反馈，包含时间戳和用户标识
 * - 10.2: 记录用户标记的漏报（false negative）
 * - 10.3: 记录用户标记的误报（false positive/noise）
 * - 10.4: 聚合每个告警规则的反馈统计
 * - 10.5: 标记高误报率的规则以供审查
 * - 10.6: 提供 API 查询反馈统计
 *
 * RAG Integration:
 * - 反馈记录时自动索引到向量数据库
 * - 支持通过语义匹配检索相关反馈
 * 
 * AI-OPS 智能进化系统扩展 (Requirements: 2.2.1, 2.2.2, 2.2.3, 2.2.4)
 * - 2.2.1: 当 useful: true 时触发经验提取
 * - 2.2.2: 使用 LLM 摘要化经验
 * - 2.2.3: 调用 KnowledgeBase.add() 存入 experiences_kb
 * - 2.2.4: 经验质量评估和审核
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertFeedback,
  CreateAlertFeedbackInput,
  FeedbackStats,
  IFeedbackService,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { isCapabilityEnabled, getCapabilityConfig } from './evolutionConfig';
import type { DataStore } from '../dataStore';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const FEEDBACK_DIR = path.join(DATA_DIR, 'feedback');
const ALERTS_FEEDBACK_DIR = path.join(FEEDBACK_DIR, 'alerts');
const STATS_FILE = path.join(FEEDBACK_DIR, 'stats.json');

// 默认高误报率阈值（30%）
const DEFAULT_FALSE_POSITIVE_THRESHOLD = 0.3;

/**
 * 获取日期字符串 (YYYY-MM-DD) - 使用 UTC 时间
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取反馈文件路径
 */
function getFeedbackFilePath(dateStr: string): string {
  return path.join(ALERTS_FEEDBACK_DIR, `${dateStr}.json`);
}

/**
 * 反馈索引处理器类型
 * 用于将反馈索引到向量数据库
 */
export type FeedbackIndexHandler = (feedback: AlertFeedback, alertInfo?: {
  ruleName?: string;
  message?: string;
  metric?: string;
  severity?: string;
}) => Promise<void>;

/**
 * 经验提取处理器类型
 * Requirements: 2.2.1
 * 用于在正面反馈时触发经验提取
 */
export type ExperienceExtractionHandler = (
  sessionId: string,
  feedback: AlertFeedback,
  context?: {
    conversationHistory?: Array<{ role: string; content: string }>;
    reActSteps?: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>;
  }
) => Promise<{
  experienceId: string;
  summary: string;
  indexed: boolean;
} | null>;

/**
 * 经验条目接口
 * Requirements: 2.2.2
 */
export interface ExperienceEntry {
  id: string;
  feedbackId: string;
  sessionId: string;
  timestamp: number;
  summary: string;
  problemPattern: string;
  solutionApproach: string;
  effectiveTools: string[];
  confidence: number;
  status: 'pending' | 'approved' | 'rejected';
  knowledgeEntryId?: string;
}

/**
 * 工具使用统计
 */
export interface ToolStats {
  toolName: string;
  useCount: number;
  successCount: number;
  failCount: number;
  successRate: number;
  avgDurationMs: number;
  lastUsed: number;
}

export class FeedbackService implements IFeedbackService {
  private initialized = false;
  private statsCache: Map<string, FeedbackStats> = new Map();
  private feedbackIndexHandler: FeedbackIndexHandler | null = null;
  private experienceExtractionHandler: ExperienceExtractionHandler | null = null;

  // 经验缓存 (Requirements: 2.2.3)
  private experienceCache: Map<string, ExperienceEntry> = new Map();

  // PostgreSQL DataStore (Requirements: C3.12)
  private pgDataStore: DataStore | null = null;

  /** Check if PostgreSQL DataStore is available */
  private get usePg(): boolean {
    return this.pgDataStore !== null;
  }

  // 知识库服务引用（延迟加载避免循环依赖）
  private knowledgeBase: typeof import('./rag').knowledgeBase | null = null;

  // AI 分析器引用（延迟加载）
  private aiAnalyzer: typeof import('./aiAnalyzer').aiAnalyzer | null = null;

  /**
   * 设置 PostgreSQL DataStore 实例
   * Requirements: C3.12 - 统一迁移至 PostgreSQL
   */
  setDataStore(ds: DataStore): void {
    this.pgDataStore = ds;
    logger.info('FeedbackService: PgDataStore configured, PostgreSQL persistence enabled');
  }

  /**
   * 注册反馈索引处理器
   * 用于将反馈自动索引到向量数据库
   */
  setFeedbackIndexHandler(handler: FeedbackIndexHandler): void {
    this.feedbackIndexHandler = handler;
    logger.info('Feedback index handler registered');
  }

  /**
   * 注册经验提取处理器
   * Requirements: 2.2.1
   */
  setExperienceExtractionHandler(handler: ExperienceExtractionHandler): void {
    this.experienceExtractionHandler = handler;
    logger.info('Experience extraction handler registered');
  }

  /**
   * 工具反馈处理器类型
   */
  private toolStats: Map<string, ToolStats> = new Map();

  /**
   * 获取知识库服务
   */
  private async getKnowledgeBase() {
    if (!this.knowledgeBase) {
      const { knowledgeBase } = await import('./rag');
      this.knowledgeBase = knowledgeBase;
    }
    return this.knowledgeBase;
  }

  /**
   * 获取 AI 分析器
   */
  private async getAIAnalyzer() {
    if (!this.aiAnalyzer) {
      const { aiAnalyzer } = await import('./aiAnalyzer');
      this.aiAnalyzer = aiAnalyzer;
    }
    return this.aiAnalyzer;
  }

  /**
   * 获取反思服务
   */
  private async getReflectorService() {
    const { reflectorService } = await import('./reflectorService');
    return reflectorService;
  }

  /**
   * 获取规则进化服务
   */
  private async getRuleEvolutionService() {
    const { ruleEvolutionService } = await import('./ruleEvolutionService');
    return ruleEvolutionService;
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(FEEDBACK_DIR, { recursive: true });
      await fs.mkdir(ALERTS_FEEDBACK_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create feedback directories:', error);
    }
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureDataDir();
    await this.loadStats();
    this.initialized = true;
    logger.info('FeedbackService initialized');
  }

  /**
   * 加载统计数据
   */
  private async loadStats(): Promise<void> {
    try {
      const data = await fs.readFile(STATS_FILE, 'utf-8');
      const stats = JSON.parse(data) as FeedbackStats[];
      this.statsCache.clear();
      for (const stat of stats) {
        this.statsCache.set(stat.ruleId, stat);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // 文件不存在，使用空缓存
        this.statsCache.clear();
      } else {
        logger.error('Failed to load feedback stats:', error);
        this.statsCache.clear();
      }
    }
  }

  /**
   * 保存统计数据
   */
  private async saveStats(): Promise<void> {
    await this.ensureDataDir();
    const stats = Array.from(this.statsCache.values());
    await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  }

  /**
   * 读取指定日期的反馈文件
   */
  private async readFeedbackFile(dateStr: string): Promise<AlertFeedback[]> {
    const filePath = getFeedbackFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as AlertFeedback[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read feedback file ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * 写入指定日期的反馈文件
   */
  private async writeFeedbackFile(dateStr: string, feedbacks: AlertFeedback[]): Promise<void> {
    const filePath = getFeedbackFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(feedbacks, null, 2), 'utf-8');
  }

  /**
   * 列出所有反馈文件
   */
  private async listFeedbackFiles(): Promise<string[]> {
    try {
      await this.ensureDataDir();
      const files = await fs.readdir(ALERTS_FEEDBACK_DIR);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 从告警 ID 中提取规则 ID
   * 告警 ID 格式通常包含规则信息，这里简化处理
   */
  private extractRuleIdFromAlertId(alertId: string): string {
    // 如果告警 ID 包含规则 ID 前缀，提取它
    // 否则返回 'unknown'
    // 实际实现中可能需要查询告警事件来获取规则 ID
    return alertId.split('-')[0] || 'unknown';
  }

  /**
   * 更新规则统计
   * Requirements: 10.4
   */
  private async updateRuleStats(
    ruleId: string,
    useful: boolean,
    tags?: string[]
  ): Promise<void> {
    let stats = this.statsCache.get(ruleId);

    if (!stats) {
      stats = {
        ruleId,
        totalAlerts: 0,
        usefulCount: 0,
        notUsefulCount: 0,
        falsePositiveRate: 0,
        lastUpdated: Date.now(),
      };
    }

    stats.totalAlerts++;

    if (useful) {
      stats.usefulCount++;
    } else {
      stats.notUsefulCount++;
    }

    // 检查是否标记为误报
    const isFalsePositive = tags?.includes('false_positive') || tags?.includes('noise');

    // 计算误报率
    // 误报 = 标记为无用且带有 false_positive 或 noise 标签
    // 简化处理：将所有 notUseful 视为潜在误报
    if (stats.totalAlerts > 0) {
      stats.falsePositiveRate = stats.notUsefulCount / stats.totalAlerts;
    }

    stats.lastUpdated = Date.now();
    this.statsCache.set(ruleId, stats);

    await this.saveStats();
  }

  /**
   * 记录反馈
   * Requirements: 10.1, 10.2, 10.3, 2.2.1
   * 
   * @param feedback 反馈输入（不含 id 和 timestamp）
   * @param alertInfo 可选的告警信息，用于向量索引
   * @param sessionContext 可选的会话上下文，用于经验提取
   * @returns 完整的反馈记录
   */
  async recordFeedback(
    feedback: CreateAlertFeedbackInput,
    alertInfo?: {
      ruleName?: string;
      message?: string;
      metric?: string;
      severity?: string;
    },
    sessionContext?: {
      sessionId?: string;
      conversationHistory?: Array<{ role: string; content: string }>;
      reActSteps?: Array<{
        thought: string;
        action?: { tool: string; params: Record<string, unknown> };
        observation?: string;
        success?: boolean;
      }>;
      usedLearningEntryIds?: string[];
    }
  ): Promise<AlertFeedback> {
    await this.ensureDataDir();

    const timestamp = Date.now();
    const alertFeedback: AlertFeedback = {
      id: uuidv4(),
      timestamp,
      ...feedback,
    };

    // 保存到 PostgreSQL 或日期分片文件
    if (this.usePg) {
      try {
        await this.pgDataStore!.execute(
          `INSERT INTO feedback_records (id, alert_id, user_id, useful, comment, tags, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            alertFeedback.id,
            alertFeedback.alertId,
            alertFeedback.userId || null,
            alertFeedback.useful,
            alertFeedback.comment || null,
            JSON.stringify(alertFeedback.tags || []),
            alertFeedback.timestamp,
          ]
        );
      } catch (error) {
        logger.warn('Failed to save feedback to PostgreSQL, falling back to file:', error);
        const dateStr = getDateString(timestamp);
        const feedbacks = await this.readFeedbackFile(dateStr);
        feedbacks.push(alertFeedback);
        await this.writeFeedbackFile(dateStr, feedbacks);
      }
    } else {
      const dateStr = getDateString(timestamp);
      const feedbacks = await this.readFeedbackFile(dateStr);
      feedbacks.push(alertFeedback);
      await this.writeFeedbackFile(dateStr, feedbacks);
    }

    // 更新规则统计
    const ruleId = this.extractRuleIdFromAlertId(feedback.alertId);
    await this.updateRuleStats(ruleId, feedback.useful, feedback.tags);

    // 如果有索引处理器，将反馈索引到向量数据库
    if (this.feedbackIndexHandler) {
      try {
        await this.feedbackIndexHandler(alertFeedback, alertInfo);
        logger.debug(`Feedback indexed to vector database: ${alertFeedback.id}`);
      } catch (error) {
        // 索引失败不影响反馈记录
        logger.warn(`Failed to index feedback to vector database: ${alertFeedback.id}`, { error });
      }
    }

    // 新增：将反馈传播到关联的 LearningEntry
    // Requirements: conversation-and-reflection-optimization 3.1, 6.1, 8.2, 8.3
    const learningEntryIds = sessionContext?.usedLearningEntryIds ?? [];
    if (learningEntryIds.length > 0) {
      try {
        const reflector = await this.getReflectorService();
        for (const entryId of learningEntryIds) {
          try {
            if (feedback.useful) {
              await reflector.applyPositiveFeedback(entryId);
            } else {
              await reflector.applyNegativeFeedback(entryId);
            }
          } catch (entryError) {
            logger.warn(`Failed to apply feedback to learning entry ${entryId}`, { error: entryError });
          }
        }
      } catch (error) {
        logger.warn('ReflectorService not available for feedback propagation', { error });
      }
    }

    // Requirements: 2.2.1 - 当 useful: true 时触发经验提取
    if (feedback.useful && sessionContext?.sessionId) {
      try {
        await this.triggerExperienceExtraction(
          alertFeedback,
          sessionContext.sessionId,
          sessionContext
        );
      } catch (error) {
        // 经验提取失败不影响反馈记录
        logger.warn(`Failed to extract experience for feedback: ${alertFeedback.id}`, { error });
      }
    } else if (!feedback.useful && sessionContext?.reActSteps) {
      // 当 useful: false 且有 ReAct 步骤时，触发反思与规则学习
      this.triggerReflectionAndRuleLearning(alertFeedback, sessionContext.reActSteps)
        .catch(err => logger.error('Failed to trigger reflection:', err));
    }

    logger.debug(`Feedback recorded for alert ${feedback.alertId}: useful=${feedback.useful}`);
    return alertFeedback;
  }

  /**
   * 触发反思与规则学习
   */
  private async triggerReflectionAndRuleLearning(
    feedback: AlertFeedback,
    reActSteps: Array<{
      thought: string;
      action?: { tool: string; params: Record<string, unknown> };
      observation?: string;
      success?: boolean;
    }>
  ): Promise<void> {
    try {
      if (!isCapabilityEnabled('reflection')) return;

      const reflector = await this.getReflectorService();
      const ruleLearner = await this.getRuleEvolutionService();

      // 1. 构造 ReflectionContext
      // 我们模拟一个符合 EvaluationReport 接口的对象
      const evaluation: any = {
        id: uuidv4(),
        timestamp: Date.now(),
        alertId: feedback.alertId,
        success: false,
        score: 0,
        issues: [feedback.comment || 'User reported not useful'],
        metrics: {}
      };

      const lastStep = reActSteps[reActSteps.length - 1];
      const context = {
        goal: 'Unknown goal (from user feedback)', // 理想情况下应从 Session 获取 Goal
        steps: reActSteps.map(s => ({
          action: s.action?.tool || 'unknown',
          input: s.action?.params || {},
          output: s.observation || '',
          success: s.success || false,
          timestamp: Date.now()
        })),
        finalResult: lastStep?.observation,
        metrics: {}
      };

      // 2. 执行反思
      const reflection = await reflector.reflect(evaluation, context as any);

      // 3. 学习规则
      const rules = await ruleLearner.learnFromReflection(reflection);

      if (rules.length > 0) {
        logger.info(`Learned ${rules.length} rules from negative feedback ${feedback.id}`);
      }
    } catch (error) {
      logger.error('Error in reflection/learning loop:', error);
    }
  }

  /**
   * 触发经验提取
   * Requirements: 1.4, 1.5, 2.2.1, 2.2.2, 2.2.3
   */
  private async triggerExperienceExtraction(
    feedback: AlertFeedback,
    sessionId: string,
    context?: {
      conversationHistory?: Array<{ role: string; content: string }>;
      reActSteps?: Array<{
        thought: string;
        action?: { tool: string; params: Record<string, unknown> };
        observation?: string;
        success?: boolean;
      }>;
    }
  ): Promise<void> {
    // Requirements 1.4: 检查 Experience 能力是否启用，仅在启用时执行提取逻辑
    if (!isCapabilityEnabled('experience')) {
      return;
    }

    // 如果有自定义处理器，使用它
    if (this.experienceExtractionHandler) {
      const result = await this.experienceExtractionHandler(sessionId, feedback, context);
      if (result) {
        logger.info(`Experience extracted via handler: ${result.experienceId}`);
      }
      return;
    }

    // 默认经验提取逻辑
    const experienceId = uuidv4();

    // 生成经验摘要 (Requirements: 2.2.2)
    const summary = await this.generateExperienceSummary(feedback, context);

    // 提取问题模式和解决方案
    const problemPattern = this.extractProblemPattern(context);
    const solutionApproach = this.extractSolutionApproach(context);
    const effectiveTools = this.extractEffectiveTools(context);

    // 计算置信度
    const confidence = this.calculateExperienceConfidence(context);

    // Requirements 1.5: 根据 autoApprove 配置决定经验状态
    const experienceConfig = getCapabilityConfig('experience');
    const status: ExperienceEntry['status'] = experienceConfig.autoApprove ? 'approved' : 'pending';

    const experience: ExperienceEntry = {
      id: experienceId,
      feedbackId: feedback.id,
      sessionId,
      timestamp: Date.now(),
      summary,
      problemPattern,
      solutionApproach,
      effectiveTools,
      confidence,
      status,
    };

    // 缓存经验
    this.experienceCache.set(experienceId, experience);

    // 如果置信度足够高，自动索引到知识库 (Requirements: 2.2.3)
    if (experience.status === 'approved') {
      await this.indexExperienceToKnowledgeBase(experience);
    }

    logger.info(`Experience extracted: ${experienceId}, status: ${experience.status}`);
  }

  /**
   * 生成经验摘要
   * Requirements: 2.2.2
   */
  private async generateExperienceSummary(
    feedback: AlertFeedback,
    context?: {
      conversationHistory?: Array<{ role: string; content: string }>;
      reActSteps?: Array<{
        thought: string;
        action?: { tool: string; params: Record<string, unknown> };
        observation?: string;
        success?: boolean;
      }>;
    }
  ): Promise<string> {
    const parts: string[] = [];

    // 从对话历史提取问题描述
    if (context?.conversationHistory && context.conversationHistory.length > 0) {
      const userMessages = context.conversationHistory.filter(m => m.role === 'user');
      if (userMessages.length > 0) {
        const firstQuestion = userMessages[0].content.substring(0, 150);
        parts.push(`问题: ${firstQuestion}${userMessages[0].content.length > 150 ? '...' : ''}`);
      }
    }

    // 从 ReAct 步骤提取解决方案
    if (context?.reActSteps && context.reActSteps.length > 0) {
      const successfulSteps = context.reActSteps.filter(s => s.success === true);
      if (successfulSteps.length > 0) {
        const tools = successfulSteps
          .filter(s => s.action)
          .map(s => s.action!.tool);
        if (tools.length > 0) {
          parts.push(`使用工具: ${[...new Set(tools)].join(', ')}`);
        }
      }
      parts.push(`执行步骤: ${context.reActSteps.length}, 成功: ${successfulSteps.length}`);
    }

    // 添加反馈信息
    if (feedback.comment) {
      parts.push(`用户评价: ${feedback.comment.substring(0, 100)}`);
    }

    // 尝试使用 AI 生成更好的摘要
    try {
      const aiAnalyzer = await this.getAIAnalyzer();
      const aiResult = await aiAnalyzer.analyze({
        type: 'fault_diagnosis',
        context: {
          analysisType: 'experience_summary',
          conversationHistory: context?.conversationHistory?.slice(-6),
          reActSteps: context?.reActSteps?.slice(-5),
          feedback: {
            useful: feedback.useful,
            comment: feedback.comment,
          },
        },
      });

      if (aiResult.summary) {
        return aiResult.summary;
      }
    } catch (error) {
      logger.debug('AI summary generation failed, using fallback:', error);
    }

    return parts.join('。') || '成功解决用户问题';
  }

  /**
   * 提取问题模式
   */
  private extractProblemPattern(
    context?: {
      conversationHistory?: Array<{ role: string; content: string }>;
    }
  ): string {
    if (!context?.conversationHistory || context.conversationHistory.length === 0) {
      return '通用问题';
    }

    const userMessages = context.conversationHistory.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      return '通用问题';
    }

    const firstQuestion = userMessages[0].content.toLowerCase();

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
    context?: {
      reActSteps?: Array<{
        thought: string;
        action?: { tool: string; params: Record<string, unknown> };
        observation?: string;
        success?: boolean;
      }>;
    }
  ): string {
    if (!context?.reActSteps || context.reActSteps.length === 0) {
      return '对话式问答';
    }

    const successfulSteps = context.reActSteps.filter(s => s.success === true);
    if (successfulSteps.length === 0) {
      return '诊断分析';
    }

    const approaches: string[] = [];
    for (const step of successfulSteps) {
      if (step.action) {
        approaches.push(`使用 ${step.action.tool}`);
      }
    }

    return approaches.length > 0 ? approaches.slice(0, 3).join('，') : '多步骤诊断';
  }

  /**
   * 提取有效工具
   */
  private extractEffectiveTools(
    context?: {
      reActSteps?: Array<{
        thought: string;
        action?: { tool: string; params: Record<string, unknown> };
        observation?: string;
        success?: boolean;
      }>;
    }
  ): string[] {
    if (!context?.reActSteps) return [];

    const tools: string[] = [];
    for (const step of context.reActSteps) {
      if (step.action && step.success === true) {
        tools.push(step.action.tool);
      }
    }

    return [...new Set(tools)];
  }

  /**
   * 计算经验置信度
   */
  private calculateExperienceConfidence(
    context?: {
      conversationHistory?: Array<{ role: string; content: string }>;
      reActSteps?: Array<{
        thought: string;
        action?: { tool: string; params: Record<string, unknown> };
        observation?: string;
        success?: boolean;
      }>;
    }
  ): number {
    let confidence = 0.5;

    // 有 ReAct 步骤增加置信度
    if (context?.reActSteps && context.reActSteps.length > 0) {
      confidence += 0.1;

      // 成功率影响置信度
      const successCount = context.reActSteps.filter(s => s.success === true).length;
      const successRate = successCount / context.reActSteps.length;
      confidence += successRate * 0.2;
    }

    // 对话长度影响置信度
    if (context?.conversationHistory && context.conversationHistory.length > 4) {
      confidence += 0.1;
    }

    // 有明确的工具使用增加置信度
    if (context?.reActSteps?.some(s => s.action)) {
      confidence += 0.1;
    }

    return Math.min(1, confidence);
  }

  /**
   * 将经验索引到知识库
   * Requirements: 2.2.3
   */
  private async indexExperienceToKnowledgeBase(experience: ExperienceEntry): Promise<void> {
    try {
      const kb = await this.getKnowledgeBase();

      // 构建知识条目内容
      const content = this.buildExperienceContent(experience);

      // 添加到知识库
      const knowledgeEntry = await kb.add({
        title: `经验: ${experience.problemPattern} - ${experience.solutionApproach}`,
        content,
        type: 'experience',
        metadata: {
          source: 'feedback_service',
          timestamp: experience.timestamp,
          category: 'experience',
          tags: ['experience', experience.problemPattern.replace(/\s+/g, '-'), ...experience.effectiveTools],
          usageCount: 0,
          feedbackScore: 1, // 正面反馈
          feedbackCount: 1,
          originalData: {
            experienceId: experience.id,
            feedbackId: experience.feedbackId,
            sessionId: experience.sessionId,
            confidence: experience.confidence,
          },
        },
      });

      // 更新经验条目
      experience.knowledgeEntryId = knowledgeEntry.id;
      this.experienceCache.set(experience.id, experience);

      logger.info(`Experience indexed to knowledge base: ${experience.id} -> ${knowledgeEntry.id}`);
    } catch (error) {
      logger.warn(`Failed to index experience ${experience.id} to knowledge base:`, error);
    }
  }

  /**
   * 构建经验内容
   */
  private buildExperienceContent(experience: ExperienceEntry): string {
    const parts: string[] = [];

    parts.push(`# 经验记录: ${experience.problemPattern}`);
    parts.push('');
    parts.push(`## 摘要`);
    parts.push(experience.summary);
    parts.push('');
    parts.push(`## 问题类型`);
    parts.push(experience.problemPattern);
    parts.push('');
    parts.push(`## 解决方案`);
    parts.push(experience.solutionApproach);
    parts.push('');

    if (experience.effectiveTools.length > 0) {
      parts.push(`## 有效工具`);
      for (const tool of experience.effectiveTools) {
        parts.push(`- ${tool}`);
      }
      parts.push('');
    }

    parts.push(`## 元数据`);
    parts.push(`- 置信度: ${(experience.confidence * 100).toFixed(0)}%`);
    parts.push(`- 记录时间: ${new Date(experience.timestamp).toISOString()}`);
    parts.push(`- 会话 ID: ${experience.sessionId}`);

    return parts.join('\n');
  }

  /**
   * 获取经验列表
   * Requirements: 2.4.1
   * 
   * 优化: 如果内存缓存不足，则从知识库搜索已持久化的经验
   */
  async getExperiences(options?: {
    status?: 'pending' | 'approved' | 'rejected';
    limit?: number;
    query?: string;
  }): Promise<ExperienceEntry[]> {
    const limit = options?.limit ?? 10;
    let results: ExperienceEntry[] = Array.from(this.experienceCache.values());

    if (options?.status) {
      results = results.filter(e => e.status === options.status);
    }

    // 如果指定了查询或结果不足且状态为 approved，尝试从知识库补充
    if ((options?.query || (results.length < limit && (!options?.status || options.status === 'approved')))) {
      try {
        const kb = await this.getKnowledgeBase();
        const searchResults = await kb.search({
          query: options?.query || '',
          type: 'experience',
          limit: limit * 2, // 获取更多以进行过滤
        });

        for (const sr of searchResults) {
          const originalData = sr.entry.metadata?.originalData as any;
          if (originalData?.experienceId) {
            // 避免重复并确保状态匹配
            if (!this.experienceCache.has(originalData.experienceId)) {
              const entry: ExperienceEntry = {
                id: originalData.experienceId,
                feedbackId: originalData.feedbackId || '',
                sessionId: originalData.sessionId || '',
                timestamp: sr.entry.metadata.timestamp || Date.now(),
                summary: sr.entry.content.split('\n## ')[1]?.split('\n')[1] || sr.entry.title, // 简单提取摘要
                problemPattern: sr.entry.title.split(': ')[1]?.split(' - ')[0] || '未知模式',
                solutionApproach: sr.entry.title.split(' - ')[1] || '未知方案',
                effectiveTools: sr.entry.metadata.tags?.filter(t => t !== 'experience' && t !== 'experience-kb') || [],
                confidence: originalData.confidence || 0.8,
                status: 'approved',
                knowledgeEntryId: sr.entry.id
              };
              
              if (!options?.status || entry.status === options.status) {
                results.push(entry);
                // 更新到内存缓存以备后用
                this.experienceCache.set(entry.id, entry);
              }
            }
          }
        }
      } catch (error) {
        logger.warn('Failed to fetch experiences from knowledge base', { error });
      }
    }

    // 去重
    const seen = new Set<string>();
    results = results.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    // 按时间降序排序
    results.sort((a, b) => b.timestamp - a.timestamp);

    return results.slice(0, limit);
  }

  /**
   * 审核经验
   * Requirements: 2.4.2
   */
  async reviewExperience(
    experienceId: string,
    action: 'approve' | 'reject'
  ): Promise<ExperienceEntry | null> {
    const experience = this.experienceCache.get(experienceId);
    if (!experience) {
      return null;
    }

    experience.status = action === 'approve' ? 'approved' : 'rejected';

    // 如果批准且尚未索引，则索引到知识库
    if (action === 'approve' && !experience.knowledgeEntryId) {
      await this.indexExperienceToKnowledgeBase(experience);
    }

    this.experienceCache.set(experienceId, experience);
    logger.info(`Experience ${experienceId} ${action}d`);

    return experience;
  }

  /**
   * 获取告警的反馈
   * Requirements: 10.6
   * 
   * @param alertId 告警 ID
   * @returns 该告警的所有反馈
   */
  async getFeedback(alertId: string): Promise<AlertFeedback[]> {
    // PostgreSQL path
    if (this.usePg) {
      try {
        const rows = await this.pgDataStore!.query<{
          id: string;
          alert_id: string;
          user_id: string | null;
          useful: boolean;
          comment: string | null;
          tags: string | null;
          timestamp: number;
        }>('SELECT * FROM feedback_records WHERE alert_id = $1 ORDER BY timestamp DESC', [alertId]);

        return rows.map(row => ({
          id: row.id,
          alertId: row.alert_id,
          userId: row.user_id || undefined,
          useful: Boolean(row.useful),
          comment: row.comment || undefined,
          tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : undefined,
          timestamp: typeof row.timestamp === 'number' ? row.timestamp : new Date(row.timestamp as any).getTime(),
        } as AlertFeedback));
      } catch (error) {
        logger.warn('Failed to get feedback from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    await this.ensureDataDir();

    const allFiles = await this.listFeedbackFiles();
    const result: AlertFeedback[] = [];

    for (const dateStr of allFiles) {
      const feedbacks = await this.readFeedbackFile(dateStr);
      const matching = feedbacks.filter((f) => f.alertId === alertId);
      result.push(...matching);
    }

    // 按时间戳降序排序
    result.sort((a, b) => b.timestamp - a.timestamp);
    return result;
  }

  /**
   * 获取规则的反馈统计
   * Requirements: 10.4, 10.6
   * 
   * @param ruleId 规则 ID
   * @returns 规则的反馈统计
   */
  async getRuleStats(ruleId: string): Promise<FeedbackStats> {
    // 确保统计已加载
    if (!this.initialized) {
      await this.initialize();
    }

    const stats = this.statsCache.get(ruleId);

    if (!stats) {
      // 返回空统计
      return {
        ruleId,
        totalAlerts: 0,
        usefulCount: 0,
        notUsefulCount: 0,
        falsePositiveRate: 0,
        lastUpdated: Date.now(),
      };
    }

    return stats;
  }

  /**
   * 获取所有规则的反馈统计
   * Requirements: 10.4, 10.6
   * 
   * @returns 所有规则的反馈统计列表
   */
  async getAllRuleStats(): Promise<FeedbackStats[]> {
    // 确保统计已加载
    if (!this.initialized) {
      await this.initialize();
    }

    return Array.from(this.statsCache.values());
  }

  /**
   * 获取需要审查的规则（高误报率）
   * Requirements: 10.5
   * 
   * @param threshold 误报率阈值，默认 30%
   * @returns 高误报率的规则统计列表
   */
  async getRulesNeedingReview(threshold: number = DEFAULT_FALSE_POSITIVE_THRESHOLD): Promise<FeedbackStats[]> {
    // 确保统计已加载
    if (!this.initialized) {
      await this.initialize();
    }

    const allStats = Array.from(this.statsCache.values());

    // 过滤出高误报率的规则
    // 要求至少有一定数量的反馈才能判断
    const minFeedbackCount = 3;

    return allStats.filter((stats) =>
      stats.totalAlerts >= minFeedbackCount &&
      stats.falsePositiveRate >= threshold
    ).sort((a, b) => b.falsePositiveRate - a.falsePositiveRate);
  }

  /**
   * 导出反馈数据
   * Requirements: 10.6
   * 
   * @param from 开始时间戳（可选）
   * @param to 结束时间戳（可选）
   * @returns 时间范围内的所有反馈
   */
  async exportFeedback(from?: number, to?: number): Promise<AlertFeedback[]> {
    // PostgreSQL path
    if (this.usePg) {
      try {
        let query = 'SELECT * FROM feedback_records';
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIdx = 1;

        if (from !== undefined) {
          conditions.push(`timestamp >= $${paramIdx++}`);
          params.push(from);
        }
        if (to !== undefined) {
          conditions.push(`timestamp <= $${paramIdx++}`);
          params.push(to);
        }

        if (conditions.length > 0) {
          query += ' WHERE ' + conditions.join(' AND ');
        }
        query += ' ORDER BY timestamp ASC';

        const rows = await this.pgDataStore!.query<{
          id: string;
          alert_id: string;
          user_id: string | null;
          useful: boolean;
          comment: string | null;
          tags: string | null;
          timestamp: number;
        }>(query, params);

        return rows.map(row => ({
          id: row.id,
          alertId: row.alert_id,
          userId: row.user_id || undefined,
          useful: Boolean(row.useful),
          comment: row.comment || undefined,
          tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : undefined,
          timestamp: typeof row.timestamp === 'number' ? row.timestamp : new Date(row.timestamp as any).getTime(),
        } as AlertFeedback));
      } catch (error) {
        logger.warn('Failed to export feedback from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    await this.ensureDataDir();

    const allFiles = await this.listFeedbackFiles();
    let result: AlertFeedback[] = [];

    for (const dateStr of allFiles) {
      const feedbacks = await this.readFeedbackFile(dateStr);
      result.push(...feedbacks);
    }

    // 应用时间过滤
    if (from !== undefined) {
      result = result.filter((f) => f.timestamp >= from);
    }
    if (to !== undefined) {
      result = result.filter((f) => f.timestamp <= to);
    }

    // 按时间戳升序排序（导出时通常按时间顺序）
    result.sort((a, b) => a.timestamp - b.timestamp);
    return result;
  }

  /**
   * 重新计算所有规则的统计数据
   * 用于数据修复或初始化
   */
  async recalculateAllStats(): Promise<void> {
    await this.ensureDataDir();

    const allFiles = await this.listFeedbackFiles();
    const statsMap = new Map<string, FeedbackStats>();

    for (const dateStr of allFiles) {
      const feedbacks = await this.readFeedbackFile(dateStr);

      for (const feedback of feedbacks) {
        const ruleId = this.extractRuleIdFromAlertId(feedback.alertId);

        let stats = statsMap.get(ruleId);
        if (!stats) {
          stats = {
            ruleId,
            totalAlerts: 0,
            usefulCount: 0,
            notUsefulCount: 0,
            falsePositiveRate: 0,
            lastUpdated: 0,
          };
          statsMap.set(ruleId, stats);
        }

        stats.totalAlerts++;
        if (feedback.useful) {
          stats.usefulCount++;
        } else {
          stats.notUsefulCount++;
        }

        if (feedback.timestamp > stats.lastUpdated) {
          stats.lastUpdated = feedback.timestamp;
        }
      }
    }

    // 计算误报率
    for (const stats of statsMap.values()) {
      if (stats.totalAlerts > 0) {
        stats.falsePositiveRate = stats.notUsefulCount / stats.totalAlerts;
      }
    }

    this.statsCache = statsMap;
    await this.saveStats();

    logger.info(`Recalculated stats for ${statsMap.size} rules`);
  }

  /**
   * 记录工具运行结果
   * @param toolName 工具名称
   * @param duration 持续时间（ms）
   * @param success 是否成功
   */
  async recordToolExecution(
    toolName: string,
    duration: number,
    success: boolean
  ): Promise<void> {
    if (!this.initialized) await this.initialize();

    let stats = this.toolStats.get(toolName);
    if (!stats) {
      stats = {
        toolName,
        useCount: 0,
        successCount: 0,
        failCount: 0,
        successRate: 0,
        avgDurationMs: 0,
        lastUsed: 0
      };
    }

    const oldTotal = stats.useCount;
    stats.useCount++;
    if (success) {
      stats.successCount++;
    } else {
      stats.failCount++;
    }

    stats.successRate = stats.successCount / stats.useCount;
    stats.avgDurationMs = (stats.avgDurationMs * oldTotal + duration) / stats.useCount;
    stats.lastUsed = Date.now();

    this.toolStats.set(toolName, stats);
  }

  /**
   * 获取所有工具的统计数据
   * @param limit 限制数量
   * @returns 工具统计列表
   */
  async getToolStats(limit: number = 20): Promise<ToolStats[]> {
    if (!this.initialized) await this.initialize();

    const stats = Array.from(this.toolStats.values());
    // 按成功率降序，成功率相同按使用次数降序
    stats.sort((a, b) => {
      if (b.successRate !== a.successRate) {
        return b.successRate - a.successRate;
      }
      return b.useCount - a.useCount;
    });

    return stats.slice(0, limit);
  }
}

// 导出单例实例
export const feedbackService = new FeedbackService();
