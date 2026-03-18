/**
 * IterationLoop 迭代优化循环服务
 * 整合 Critic 和 Reflector，实现自动化迭代优化循环
 *
 * Requirements: 8.1-10.5, 17.1-17.4, 18.5, 18.6, 21.1-22.5
 * - 8.1-8.7: 迭代循环核心逻辑
 * - 9.1-9.5: 迭代状态管理
 * - 10.1-10.5: 中止功能
 * - 17.1-17.4: SSE 事件流
 * - 18.5, 18.6: 统计功能
 * - 21.1-21.6: 功能配置管理
 * - 22.1-22.5: 异步处理和并发控制
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedEvent,
  Decision,
  RemediationPlan,
  IterationConfig,
  IterationState,
  IterationStatus,
  IterationEvent,
  IterationEventType,
  IterationStats,
  CriticReflectorConfig,
  DEFAULT_CRITIC_REFLECTOR_CONFIG,
  DEFAULT_ITERATION_CONFIG,
  EvaluationContext,
  ReflectionContext,
  IIterationLoop,
  SystemMetrics,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { auditLogger } from './auditLogger';
import { criticService } from './criticService';
import { reflectorService } from './reflectorService';
import { notificationService } from './notificationService';

// State Machine Integration (lightweight-state-machine)
// Requirements: 9.3, 9.4 - Feature flag routing for gradual migration
import { FeatureFlagManager } from './stateMachine/featureFlagManager';
import { StateMachineOrchestrator } from './stateMachine/stateMachineOrchestrator';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const ITERATIONS_DIR = path.join(DATA_DIR, 'iterations');
const ACTIVE_DIR = path.join(ITERATIONS_DIR, 'active');
const COMPLETED_DIR = path.join(ITERATIONS_DIR, 'completed');
const CONFIG_FILE = path.join(DATA_DIR, 'critic', 'config.json');

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 事件订阅者
 */
interface EventSubscriber {
  iterationId: string;
  callback: (event: IterationEvent) => void;
  aborted: boolean;
}

export class IterationLoop implements IIterationLoop {
  private initialized = false;
  private config: CriticReflectorConfig = { ...DEFAULT_CRITIC_REFLECTOR_CONFIG };
  private activeIterations: Map<string, IterationState> = new Map();
  private subscribers: Map<string, EventSubscriber[]> = new Map();
  
  // 并发控制
  private runningCount = 0;
  private pendingQueue: Array<{
    alertEvent: UnifiedEvent;
    decision: Decision;
    plan: RemediationPlan;
    config: IterationConfig;
    resolve: (id: string) => void;
    reject: (error: Error) => void;
    queuedAt: number; // 入队时间，用于超时检查
  }> = [];
  
  // 队列大小限制
  private readonly MAX_QUEUE_SIZE = 100;
  // 队列项超时时间（5分钟）
  private readonly QUEUE_ITEM_TIMEOUT_MS = 5 * 60 * 1000;

  // 服务引用（延迟加载避免循环依赖）
  private metricsCollector: typeof import('./metricsCollector').metricsCollector | null = null;
  private remediationAdvisor: typeof import('./remediationAdvisor').remediationAdvisor | null = null;

  // State Machine Integration (lightweight-state-machine)
  // Requirements: 9.3, 9.4
  private _featureFlagManager: FeatureFlagManager | null = null;
  private _stateMachineOrchestrator: StateMachineOrchestrator | null = null;

  /**
   * 设置 FeatureFlagManager（用于状态机迁移路由）
   * Requirements: 9.3, 9.4
   */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this._featureFlagManager = manager;
  }

  /**
   * 设置 StateMachineOrchestrator（用于状态机迁移路由）
   * Requirements: 9.3, 9.4
   */
  setStateMachineOrchestrator(orchestrator: StateMachineOrchestrator): void {
    this._stateMachineOrchestrator = orchestrator;
  }

  /**
   * 获取指标采集器
   */
  private async getMetricsCollector() {
    if (!this.metricsCollector) {
      const { metricsCollector } = await import('./metricsCollector');
      this.metricsCollector = metricsCollector;
    }
    return this.metricsCollector;
  }

  /**
   * 获取修复顾问
   */
  private async getRemediationAdvisor() {
    if (!this.remediationAdvisor) {
      const { remediationAdvisor } = await import('./remediationAdvisor');
      this.remediationAdvisor = remediationAdvisor;
    }
    return this.remediationAdvisor;
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDirs(): Promise<void> {
    try {
      await fs.mkdir(ACTIVE_DIR, { recursive: true });
      await fs.mkdir(COMPLETED_DIR, { recursive: true });
      await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    } catch (error) {
      logger.error('Failed to create iteration directories:', error);
    }
  }

  /**
   * 初始化服务
   * Requirements: 20.2
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDataDirs();
    await this.loadConfig();
    await this.loadActiveIterations();
    
    this.initialized = true;
    logger.info('IterationLoop initialized');
  }

  /**
   * 加载配置
   * Requirements: 21.4
   */
  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = { ...DEFAULT_CRITIC_REFLECTOR_CONFIG, ...JSON.parse(content) };
      logger.info('Loaded Critic/Reflector config');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load config:', error);
      }
      this.config = { ...DEFAULT_CRITIC_REFLECTOR_CONFIG };
      await this.saveConfig();
    }
  }

  /**
   * 保存配置
   * Requirements: 21.5
   */
  private async saveConfig(): Promise<void> {
    await this.ensureDataDirs();
    this.config.updatedAt = Date.now();
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * 加载活跃迭代
   */
  private async loadActiveIterations(): Promise<void> {
    try {
      const files = await fs.readdir(ACTIVE_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await fs.readFile(path.join(ACTIVE_DIR, file), 'utf-8');
          const state = JSON.parse(content) as IterationState;
          this.activeIterations.set(state.id, state);
        } catch (error) {
          logger.warn(`Failed to load active iteration ${file}:`, error);
        }
      }
      logger.info(`Loaded ${this.activeIterations.size} active iterations`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load active iterations:', error);
      }
    }
  }

  /**
   * 保存迭代状态
   * Requirements: 9.3
   */
  private async saveIterationState(state: IterationState): Promise<void> {
    await this.ensureDataDirs();
    
    if (state.status === 'completed' || state.status === 'aborted' || state.status === 'escalated') {
      // 移动到已完成目录
      const dateStr = getDateString(state.startTime);
      const completedFile = path.join(COMPLETED_DIR, `${dateStr}.json`);
      
      let completedStates: IterationState[] = [];
      try {
        const content = await fs.readFile(completedFile, 'utf-8');
        completedStates = JSON.parse(content);
      } catch {
        // 文件不存在
      }
      
      const existingIndex = completedStates.findIndex(s => s.id === state.id);
      if (existingIndex >= 0) {
        completedStates[existingIndex] = state;
      } else {
        completedStates.push(state);
      }
      
      await fs.writeFile(completedFile, JSON.stringify(completedStates, null, 2), 'utf-8');
      
      // 删除活跃文件
      try {
        await fs.unlink(path.join(ACTIVE_DIR, `${state.id}.json`));
      } catch {
        // 文件可能不存在
      }
      
      this.activeIterations.delete(state.id);
    } else {
      // 保存到活跃目录
      const activeFile = path.join(ACTIVE_DIR, `${state.id}.json`);
      await fs.writeFile(activeFile, JSON.stringify(state, null, 2), 'utf-8');
      this.activeIterations.set(state.id, state);
    }
  }


  /**
   * 发送事件给订阅者
   * Requirements: 17.2, 17.3
   */
  private emitEvent(iterationId: string, type: IterationEventType, data: unknown): void {
    const event: IterationEvent = {
      type,
      iterationId,
      timestamp: Date.now(),
      data,
    };

    const subs = this.subscribers.get(iterationId) || [];
    for (const sub of subs) {
      if (!sub.aborted) {
        try {
          sub.callback(event);
        } catch (error) {
          logger.warn(`Failed to emit event to subscriber:`, error);
        }
      }
    }
  }

  /**
   * 检查功能是否启用
   * Requirements: 21.1
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 获取功能配置
   * Requirements: 21.4, 21.5
   */
  getConfig(): CriticReflectorConfig {
    return { ...this.config };
  }

  /**
   * 更新功能配置
   * Requirements: 21.5, 21.6
   */
  async updateConfig(updates: Partial<CriticReflectorConfig>): Promise<void> {
    await this.initialize();
    this.config = { ...this.config, ...updates, updatedAt: Date.now() };
    await this.saveConfig();
    logger.info('Critic/Reflector config updated');
  }

  /**
   * 启动迭代循环（同步等待完成）
   * Requirements: 8.1-8.7
   */
  async start(
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan,
    config?: Partial<IterationConfig>
  ): Promise<string> {
    await this.initialize();

    // 检查功能是否启用
    if (!this.config.enabled) {
      throw new Error('Critic/Reflector feature is disabled');
    }

    // State Machine routing (Requirements: 9.3, 9.4)
    if (this._featureFlagManager && this._stateMachineOrchestrator) {
      return this._featureFlagManager.route<string>(
        'iteration-orchestration',
        async () => {
          const execResult = await this._stateMachineOrchestrator!.execute('iteration-loop', {
            alertEvent,
            decision,
            currentPlan: plan,
            config,
          });
          return execResult.executionId;
        },
        () => this.startLegacy(alertEvent, decision, plan, config),
      );
    }

    // Legacy path (no FeatureFlagManager configured)
    return this.startLegacy(alertEvent, decision, plan, config);
  }

  /**
   * 原始启动迭代循环逻辑
   */
  private async startLegacy(
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan,
    config?: Partial<IterationConfig>
  ): Promise<string> {

    // 合并配置
    const iterationConfig: IterationConfig = {
      ...this.config.defaultIterationConfig,
      ...config,
    };

    // 创建迭代状态
    const iterationId = uuidv4();
    const state: IterationState = {
      id: iterationId,
      alertId: alertEvent.id,
      planId: plan.id,
      currentIteration: 0,
      maxIterations: iterationConfig.maxIterations,
      status: 'pending',
      startTime: Date.now(),
      evaluations: [],
      reflections: [],
      learningEntries: [],
      config: iterationConfig,
    };

    // 保存初始状态
    await this.saveIterationState(state);

    // 记录审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      details: {
        trigger: 'iteration_state_change',
        metadata: {
          iterationId,
          alertId: alertEvent.id,
          planId: plan.id,
          status: 'pending',
        },
      },
    });

    // 发送开始事件
    this.emitEvent(iterationId, 'iteration_started', { alertId: alertEvent.id, planId: plan.id });

    // 执行迭代循环
    try {
      await this.runIterationLoop(state, alertEvent, decision, plan);
    } catch (error) {
      state.status = 'aborted';
      state.lastError = error instanceof Error ? error.message : String(error);
      state.endTime = Date.now();
      await this.saveIterationState(state);
      throw error;
    }

    return iterationId;
  }

  /**
   * 异步启动迭代循环（不阻塞调用方）
   * Requirements: 22.1, 22.2
   * 修复: 使用真正的 Promise resolve/reject 回调替代空函数
   * Requirements: 1.1, 1.2, 1.3
   */
  startAsync(
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan,
    config?: Partial<IterationConfig>
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // 检查功能是否启用
      if (!this.config.enabled) {
        reject(new Error('Critic/Reflector feature is disabled'));
        return;
      }

      // 合并配置
      const iterationConfig: IterationConfig = {
        ...this.config.defaultIterationConfig,
        ...config,
      };

      // 创建迭代 ID
      const iterationId = uuidv4();

      // 检查并发限制
      if (this.runningCount >= this.config.maxConcurrentIterations) {
        // 检查队列大小限制
        if (this.pendingQueue.length >= this.MAX_QUEUE_SIZE) {
          logger.warn(`Iteration queue is full (${this.MAX_QUEUE_SIZE}), rejecting new iteration`);
          reject(new Error('Iteration queue is full, please try again later'));
          return;
        }
        
        // 加入队列，使用真正的 resolve/reject 回调
        this.pendingQueue.push({
          alertEvent,
          decision,
          plan,
          config: iterationConfig,
          resolve,  // 真正的 resolve 回调
          reject,   // 真正的 reject 回调
          queuedAt: Date.now(),
        });
        logger.info(`Iteration ${iterationId} queued, current running: ${this.runningCount}, queue size: ${this.pendingQueue.length}`);
      } else {
        // 立即启动
        this.runningCount++;
        this.startIterationAsync(iterationId, alertEvent, decision, plan, iterationConfig)
          .then(() => resolve(iterationId))
          .catch(reject);
      }
    });
  }

  /**
   * 异步启动迭代（内部方法）
   * 修复：异常时正确更新迭代状态为 aborted
   */
  private async startIterationAsync(
    iterationId: string,
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan,
    config: IterationConfig
  ): Promise<void> {
    let state: IterationState | null = null;
    
    try {
      await this.initialize();

      // 创建迭代状态
      state = {
        id: iterationId,
        alertId: alertEvent.id,
        planId: plan.id,
        currentIteration: 0,
        maxIterations: config.maxIterations,
        status: 'pending',
        startTime: Date.now(),
        evaluations: [],
        reflections: [],
        learningEntries: [],
        config,
      };

      // 保存初始状态
      await this.saveIterationState(state);

      // 发送开始事件
      this.emitEvent(iterationId, 'iteration_started', { alertId: alertEvent.id, planId: plan.id });

      // 执行迭代循环
      await this.runIterationLoop(state, alertEvent, decision, plan);
    } catch (error) {
      logger.error(`Async iteration ${iterationId} failed:`, error);
      
      // 修复：异常时更新状态为 aborted
      if (state) {
        state.status = 'aborted';
        state.lastError = error instanceof Error ? error.message : String(error);
        state.endTime = Date.now();
        try {
          await this.saveIterationState(state);
          this.emitEvent(iterationId, 'iteration_complete', { 
            success: false, 
            error: state.lastError 
          });
        } catch (saveError) {
          logger.error(`Failed to save aborted state for iteration ${iterationId}:`, saveError);
        }
      }
    } finally {
      this.runningCount--;
      this.processQueue();
    }
  }

  /**
   * 处理队列
   * 包含超时检查，清理过期的队列项
   */
  private processQueue(): void {
    const now = Date.now();
    
    // 清理超时的队列项
    const expiredItems: typeof this.pendingQueue = [];
    this.pendingQueue = this.pendingQueue.filter(item => {
      if (now - item.queuedAt > this.QUEUE_ITEM_TIMEOUT_MS) {
        expiredItems.push(item);
        return false;
      }
      return true;
    });
    
    // 记录超时的项目
    for (const item of expiredItems) {
      logger.warn(`Queue item expired after ${this.QUEUE_ITEM_TIMEOUT_MS}ms`, {
        alertId: item.alertEvent.id,
        planId: item.plan.id,
      });
      item.reject(new Error('Queue item timeout'));
    }
    
    // 处理队列中的项目
    while (this.pendingQueue.length > 0 && this.runningCount < this.config.maxConcurrentIterations) {
      const item = this.pendingQueue.shift();
      if (item) {
        this.runningCount++;
        const iterationId = uuidv4();
        this.startIterationAsync(iterationId, item.alertEvent, item.decision, item.plan, item.config)
          .then(() => item.resolve(iterationId))
          .catch(item.reject);
      }
    }
  }

  /**
   * 执行迭代循环
   * Requirements: 8.1-8.7
   */
  private async runIterationLoop(
    state: IterationState,
    alertEvent: UnifiedEvent,
    decision: Decision,
    plan: RemediationPlan
  ): Promise<void> {
    const startTime = Date.now();
    const { config } = state;

    // 更新状态为运行中
    state.status = 'running';
    await this.saveIterationState(state);

    // 获取服务
    const metricsCollector = await this.getMetricsCollector();
    const remediationAdvisor = await this.getRemediationAdvisor();

    let currentPlan = plan;

    while (state.currentIteration < config.maxIterations) {
      // 8.4 检查超时
      if (Date.now() - startTime > config.timeoutMs) {
        logger.warn(`Iteration ${state.id} timeout after ${config.timeoutMs}ms`);
        state.status = 'escalated';
        state.lastError = 'Iteration timeout';
        await this.handleEscalation(state, alertEvent);
        break;
      }

      // 检查是否被中止
      const currentState = this.activeIterations.get(state.id);
      if (currentState?.status === 'aborted') {
        break;
      }

      state.currentIteration++;
      logger.info(`Starting iteration ${state.currentIteration}/${config.maxIterations} for ${state.id}`);

      // 获取执行前状态
      const preMetrics = await metricsCollector.collectNow();
      const preExecutionState: SystemMetrics = preMetrics.system;

      // 执行修复步骤
      state.status = 'running';
      await this.saveIterationState(state);

      const results = await remediationAdvisor.executeAutoSteps(currentPlan.id);
      
      // 发送步骤执行事件
      this.emitEvent(state.id, 'step_executed', {
        iteration: state.currentIteration,
        stepsExecuted: results.length,
        success: results.every(r => r.success),
      });

      // 获取执行后状态
      const postMetrics = await metricsCollector.collectNow();
      const postExecutionState: SystemMetrics = postMetrics.system;

      // 构建评估上下文
      const evaluationContext: EvaluationContext = {
        alertEvent,
        preExecutionState,
        postExecutionState,
      };

      // 评估执行结果
      state.status = 'evaluating';
      await this.saveIterationState(state);

      const evaluation = await criticService.evaluatePlan(currentPlan, results, evaluationContext);
      state.evaluations.push(evaluation);

      // 发送评估事件
      this.emitEvent(state.id, 'step_evaluated', {
        iteration: state.currentIteration,
        overallSuccess: evaluation.overallSuccess,
        overallScore: evaluation.overallScore,
      });

      // 8.3 检查成功阈值
      if (evaluation.overallSuccess && evaluation.overallScore >= config.successThreshold) {
        logger.info(`Iteration ${state.id} succeeded with score ${evaluation.overallScore}`);
        state.status = 'completed';
        state.endTime = Date.now();
        
        // 提取学习内容
        const learning = await reflectorService.extractLearning(state);
        state.learningEntries.push(learning);
        await reflectorService.persistLearning(learning);
        
        await this.saveIterationState(state);
        
        // Requirements: critic-reflector 15.1-15.4 - 记录反馈
        await this.recordIterationFeedback(state, alertEvent, true, evaluation.overallScore);
        
        this.emitEvent(state.id, 'iteration_complete', { success: true, score: evaluation.overallScore });
        return;
      }

      // 反思
      state.status = 'reflecting';
      await this.saveIterationState(state);

      const reflectionContext: ReflectionContext = {
        alertEvent,
        plan: currentPlan,
        iterationHistory: {
          evaluations: state.evaluations,
          reflections: state.reflections,
        },
        systemContext: {
          currentTime: new Date(),
          systemLoad: postExecutionState,
          recentChanges: [],
        },
      };

      const reflection = await reflectorService.reflect(evaluation, reflectionContext);
      state.reflections.push(reflection);

      // 发送反思事件
      this.emitEvent(state.id, 'reflection_complete', {
        iteration: state.currentIteration,
        nextAction: reflection.nextAction,
      });

      // 决定下一步行动
      const nextAction = await reflectorService.decideNextAction(reflection, state);

      // 发送决策事件
      this.emitEvent(state.id, 'decision_made', {
        iteration: state.currentIteration,
        action: nextAction,
      });

      // 根据决策执行
      switch (nextAction) {
        case 'complete':
          state.status = 'completed';
          state.endTime = Date.now();
          await this.saveIterationState(state);
          // Requirements: critic-reflector 15.1-15.4 - 记录反馈
          await this.recordIterationFeedback(state, alertEvent, true);
          this.emitEvent(state.id, 'iteration_complete', { success: true });
          return;

        case 'escalate':
          state.status = 'escalated';
          state.endTime = Date.now();
          await this.handleEscalation(state, alertEvent);
          await this.saveIterationState(state);
          // Requirements: critic-reflector 15.1-15.4 - 记录反馈
          await this.recordIterationFeedback(state, alertEvent, false);
          this.emitEvent(state.id, 'iteration_complete', { success: false, escalated: true });
          return;

        case 'rollback':
          await this.handleRollback(state, currentPlan);
          state.status = 'aborted';
          state.endTime = Date.now();
          await this.saveIterationState(state);
          // Requirements: critic-reflector 15.1-15.4 - 记录反馈
          await this.recordIterationFeedback(state, alertEvent, false);
          this.emitEvent(state.id, 'iteration_complete', { success: false, rolledBack: true });
          return;

        case 'retry_modified':
          if (reflection.actionDetails?.modifiedParams) {
            // 应用修改后的参数（简化处理）
            logger.info(`Retrying with modified params for iteration ${state.id}`);
          }
          break;

        case 'try_alternative':
          if (reflection.actionDetails?.alternativePlan) {
            currentPlan = reflection.actionDetails.alternativePlan;
            logger.info(`Trying alternative plan for iteration ${state.id}`);
          }
          break;

        case 'retry_same':
        default:
          // 继续下一次迭代
          break;
      }

      await this.saveIterationState(state);
    }

    // 8.2 达到最大迭代次数
    // 检查是否需要升级（如果循环正常结束但未成功完成）
    // 使用类型断言避免 TypeScript 类型收窄问题
    const finalStatus = state.status as IterationStatus;
    if (finalStatus !== 'completed' && finalStatus !== 'aborted' && finalStatus !== 'escalated') {
      logger.warn(`Iteration ${state.id} reached max iterations`);
      state.status = 'escalated';
      state.lastError = 'Max iterations reached';
      state.endTime = Date.now();
      await this.handleEscalation(state, alertEvent);
      await this.saveIterationState(state);
      // Requirements: critic-reflector 15.1-15.4 - 记录反馈
      await this.recordIterationFeedback(state, alertEvent, false);
      this.emitEvent(state.id, 'iteration_complete', { success: false, maxIterationsReached: true });
    }

    // 提取学习内容
    const learning = await reflectorService.extractLearning(state);
    state.learningEntries.push(learning);
    await reflectorService.persistLearning(learning);
  }


  /**
   * 处理升级
   */
  private async handleEscalation(state: IterationState, alertEvent: UnifiedEvent): Promise<void> {
    // 发送升级通知
    try {
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels.filter(c => c.enabled).map(c => c.id);

      if (enabledChannelIds.length > 0) {
        const lastEvaluation = state.evaluations[state.evaluations.length - 1];
        const lastReflection = state.reflections[state.reflections.length - 1];

        await notificationService.send(enabledChannelIds, {
          type: 'alert',
          title: `🚨 迭代修复升级: ${alertEvent.category}`,
          body: `自动修复迭代已升级，需要人工介入。\n\n` +
                `告警: ${alertEvent.message}\n` +
                `迭代次数: ${state.currentIteration}/${state.maxIterations}\n` +
                `最终评分: ${lastEvaluation?.overallScore || 'N/A'}\n` +
                `失败原因: ${lastEvaluation?.failureCategory || 'N/A'}\n` +
                `建议: ${lastReflection?.summary || '需要人工分析'}`,
          data: {
            iterationId: state.id,
            alertId: alertEvent.id,
            planId: state.planId,
            escalated: true,
          },
        });
      }
    } catch (error) {
      logger.error('Failed to send escalation notification:', error);
    }

    // 记录审计日志
    await auditLogger.log({
      action: 'alert_trigger',
      actor: 'system',
      details: {
        trigger: 'iteration_escalated',
        metadata: {
          iterationId: state.id,
          alertId: alertEvent.id,
          iterations: state.currentIteration,
          reason: state.lastError,
        },
      },
    });
  }

  /**
   * 处理回滚
   */
  private async handleRollback(state: IterationState, plan: RemediationPlan): Promise<void> {
    if (!state.config.enableRollbackOnAbort) {
      logger.info(`Rollback disabled for iteration ${state.id}`);
      return;
    }

    try {
      const remediationAdvisor = await this.getRemediationAdvisor();
      await remediationAdvisor.executeRollback(plan.id);
      logger.info(`Rollback executed for iteration ${state.id}`);
    } catch (error) {
      logger.error(`Rollback failed for iteration ${state.id}:`, error);
    }

    // 记录审计日志
    await auditLogger.log({
      action: 'config_restore',
      actor: 'system',
      details: {
        trigger: 'iteration_rollback',
        metadata: {
          iterationId: state.id,
          planId: plan.id,
        },
      },
    });
  }

  /**
   * 记录迭代反馈到 FeedbackService
   * Requirements: critic-reflector 15.1-15.4
   * - 15.1: 迭代完成时创建反馈记录
   * - 15.2: 包含迭代结果、质量分数、学习摘要
   * - 15.3: 聚合每个规则的迭代统计
   * - 15.4: 在规则统计中暴露迭代成功率
   */
  private async recordIterationFeedback(
    state: IterationState,
    alertEvent: UnifiedEvent,
    success: boolean,
    qualityScore?: number
  ): Promise<void> {
    try {
      const { feedbackService } = await import('./feedbackService');
      
      // 构建反馈标签
      const tags: string[] = ['iteration'];
      if (success) {
        tags.push('success');
      } else {
        tags.push('failure');
        if (state.status === 'escalated') tags.push('escalated');
        if (state.status === 'aborted') tags.push('aborted');
      }

      // 构建反馈评论
      const lastEvaluation = state.evaluations[state.evaluations.length - 1];
      const lastReflection = state.reflections[state.reflections.length - 1];
      
      const comment = [
        `迭代次数: ${state.currentIteration}/${state.maxIterations}`,
        `最终状态: ${state.status}`,
        qualityScore !== undefined ? `质量分数: ${qualityScore.toFixed(2)}` : '',
        lastEvaluation?.failureCategory ? `失败类别: ${lastEvaluation.failureCategory}` : '',
        lastReflection?.summary ? `反思摘要: ${lastReflection.summary}` : '',
      ].filter(Boolean).join('\n');

      // 记录反馈
      await feedbackService.recordFeedback({
        alertId: alertEvent.id,
        useful: success,
        tags,
        comment,
        userId: 'system',
      }, {
        ruleName: alertEvent.alertRuleInfo?.ruleName,
        message: alertEvent.message,
        metric: alertEvent.alertRuleInfo?.metric,
        severity: alertEvent.severity,
      });

      logger.debug(`Iteration feedback recorded for ${state.id}: success=${success}`);
    } catch (error) {
      // 反馈记录失败不影响主流程
      logger.warn('Failed to record iteration feedback:', error);
    }
  }

  /**
   * 中止迭代
   * Requirements: 10.1-10.5
   */
  async abort(iterationId: string, reason?: string): Promise<void> {
    await this.initialize();

    const state = this.activeIterations.get(iterationId);
    if (!state) {
      throw new Error(`Iteration not found: ${iterationId}`);
    }

    if (state.status === 'completed' || state.status === 'aborted' || state.status === 'escalated') {
      throw new Error(`Iteration ${iterationId} is already ${state.status}`);
    }

    // 10.2 更新状态为中止
    state.status = 'aborted';
    state.lastError = reason || 'Manually aborted';
    state.endTime = Date.now();

    // 10.3 条件回滚
    if (state.config.enableRollbackOnAbort && state.evaluations.length > 0) {
      const lastEvaluation = state.evaluations[state.evaluations.length - 1];
      if (lastEvaluation && !lastEvaluation.overallSuccess) {
        // 获取计划并执行回滚
        try {
          const remediationAdvisor = await this.getRemediationAdvisor();
          const plan = await remediationAdvisor.getPlan(state.planId);
          if (plan) {
            await this.handleRollback(state, plan);
          }
        } catch (error) {
          logger.error(`Failed to rollback on abort for ${iterationId}:`, error);
        }
      }
    }

    // 保存状态
    await this.saveIterationState(state);

    // 10.4 发送通知
    try {
      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels.filter(c => c.enabled).map(c => c.id);

      if (enabledChannelIds.length > 0) {
        await notificationService.send(enabledChannelIds, {
          type: 'alert',
          title: `⚠️ 迭代修复已中止`,
          body: `迭代 ${iterationId} 已被中止。\n原因: ${reason || '手动中止'}`,
          data: {
            iterationId,
            aborted: true,
            reason,
          },
        });
      }
    } catch (error) {
      logger.error('Failed to send abort notification:', error);
    }

    // 记录审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'user',
      details: {
        trigger: 'iteration_state_change',
        metadata: {
          iterationId,
          status: 'aborted',
          reason,
        },
      },
    });

    // 通知订阅者
    const subs = this.subscribers.get(iterationId) || [];
    for (const sub of subs) {
      sub.aborted = true;
    }

    logger.info(`Iteration ${iterationId} aborted: ${reason}`);
  }

  /**
   * 获取迭代状态
   * Requirements: 9.1-9.5
   */
  async getState(iterationId: string): Promise<IterationState | null> {
    await this.initialize();

    // 先从活跃迭代查找
    const active = this.activeIterations.get(iterationId);
    if (active) {
      return active;
    }

    // 从已完成目录查找
    try {
      const files = await fs.readdir(COMPLETED_DIR);
      for (const file of files.sort().reverse()) {
        if (!file.endsWith('.json')) continue;
        const content = await fs.readFile(path.join(COMPLETED_DIR, file), 'utf-8');
        const states = JSON.parse(content) as IterationState[];
        const found = states.find(s => s.id === iterationId);
        if (found) {
          return found;
        }
      }
    } catch (error) {
      logger.error('Failed to search for iteration state:', error);
    }

    return null;
  }

  /**
   * 列出活跃迭代
   */
  async listActive(): Promise<IterationState[]> {
    await this.initialize();
    return Array.from(this.activeIterations.values());
  }

  /**
   * 列出最近迭代
   */
  async listRecent(limit: number = 20): Promise<IterationState[]> {
    await this.initialize();

    const results: IterationState[] = [];

    // 添加活跃迭代
    results.push(...Array.from(this.activeIterations.values()));

    // 从已完成目录加载
    try {
      const files = await fs.readdir(COMPLETED_DIR);
      for (const file of files.sort().reverse()) {
        if (!file.endsWith('.json')) continue;
        if (results.length >= limit) break;

        const content = await fs.readFile(path.join(COMPLETED_DIR, file), 'utf-8');
        const states = JSON.parse(content) as IterationState[];
        results.push(...states);

        if (results.length >= limit) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to list recent iterations:', error);
      }
    }

    // 按开始时间排序并限制数量
    return results
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  /**
   * 订阅迭代事件（SSE）
   * Requirements: 17.1-17.4
   */
  async *subscribe(iterationId: string): AsyncIterable<IterationEvent> {
    await this.initialize();

    const subscriber: EventSubscriber = {
      iterationId,
      callback: () => {},
      aborted: false,
    };

    // 创建事件队列
    const eventQueue: IterationEvent[] = [];
    let resolveWait: (() => void) | null = null;

    subscriber.callback = (event: IterationEvent) => {
      eventQueue.push(event);
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
      }
    };

    // 注册订阅者
    if (!this.subscribers.has(iterationId)) {
      this.subscribers.set(iterationId, []);
    }
    this.subscribers.get(iterationId)!.push(subscriber);

    try {
      while (!subscriber.aborted) {
        // 等待事件
        if (eventQueue.length === 0) {
          await new Promise<void>(resolve => {
            resolveWait = resolve;
            // 设置超时，避免无限等待
            setTimeout(() => {
              if (resolveWait === resolve) {
                resolveWait = null;
                resolve();
              }
            }, 30000);
          });
        }

        // 发送所有待处理事件
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;

          // 如果是完成事件，结束订阅
          if (event.type === 'iteration_complete') {
            subscriber.aborted = true;
            break;
          }
        }
      }
    } finally {
      // 清理订阅者
      const subs = this.subscribers.get(iterationId);
      if (subs) {
        const index = subs.indexOf(subscriber);
        if (index >= 0) {
          subs.splice(index, 1);
        }
        if (subs.length === 0) {
          this.subscribers.delete(iterationId);
        }
      }
    }
  }

  /**
   * 获取迭代统计
   * Requirements: 18.5, 18.6
   */
  async getStats(): Promise<IterationStats> {
    await this.initialize();

    const recentIterations = await this.listRecent(100);

    const totalIterations = recentIterations.length;
    const completedIterations = recentIterations.filter(s => s.status === 'completed');
    const abortedIterations = recentIterations.filter(s => s.status === 'aborted');
    const escalatedIterations = recentIterations.filter(s => s.status === 'escalated');

    // 计算成功率
    const successRate = totalIterations > 0
      ? completedIterations.length / totalIterations
      : 0;

    // 计算平均持续时间
    const completedWithDuration = recentIterations.filter(s => s.endTime);
    const averageDuration = completedWithDuration.length > 0
      ? completedWithDuration.reduce((sum, s) => sum + (s.endTime! - s.startTime), 0) / completedWithDuration.length
      : 0;

    // 计算中止率
    const abortRate = totalIterations > 0
      ? abortedIterations.length / totalIterations
      : 0;

    // 计算升级率
    const escalationRate = totalIterations > 0
      ? escalatedIterations.length / totalIterations
      : 0;

    return {
      totalIterations,
      successRate: Math.round(successRate * 10000) / 100,
      averageDuration: Math.round(averageDuration),
      abortRate: Math.round(abortRate * 10000) / 100,
      escalationRate: Math.round(escalationRate * 10000) / 100,
      lastUpdated: Date.now(),
    };
  }
}

// 导出单例
export const iterationLoop = new IterationLoop();
