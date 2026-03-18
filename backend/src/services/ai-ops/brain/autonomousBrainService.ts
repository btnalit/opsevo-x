/**
 * AutonomousBrainService - 7x24 全局指挥中心 (Tier 0)
 * 
 * 大脑的运行轨迹基于连续不断的 OODA (观察-调整-决策-行动) 循环。
 * - Observe: 汇聚全域数据 (Alerts, Metrics, Syslogs)
 * - Orient & Decide: 依赖现有智能进化子模块 (AP/PL/KG) 与大模型推理
 * - Act: 下发指令给 StateMachineOrchestrator 或 RouterOSClient
 */

import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { getEvolutionConfig, addConfigChangeListener } from '../evolutionConfig';
import { BrainTickContext, BrainMemory, SystemHealthSummary, EpisodicMemory } from '../../../types/autonomous-brain';
import { ConversationMemory } from '../rag/mastraAgent';
import { ReActLoopController, createExecutionContext, ReActLoopResult } from '../rag/reactLoopController';
import { getIntentSummaryForPrompt, getIntentSummaryForPromptFiltered, setCurrentInjectedCategories, updateDeviceRequirement, updateSkillToolDescription, IntentCategory } from './brainTools';
import { perceptionCache } from './perceptionCache';
import { knowledgeDistiller } from './knowledgeDistiller';
import { IntentAnalysis } from '../../../types/ai-ops';
import { AdapterFactory } from '../../ai/adapters';
import { apiConfigService } from '../../ai/apiConfigService';

// 导入现有业务模块以获取全局数据
import { alertEngine } from '../alertEngine';
import { healthMonitor } from '../healthMonitor';
// P2: Orient 深度认知模块
import { anomalyPredictor } from '../anomalyPredictor';
import { knowledgeGraphBuilder } from '../knowledgeGraphBuilder';
import { patternLearner } from '../patternLearner';
import { continuousLearner } from '../continuousLearner';
// P1: 决策引擎 — 获取待决决策
import { decisionEngine } from '../decisionEngine';
// 多设备感知：通过 ServiceRegistry 获取 DeviceManager 和 DevicePool
import { serviceRegistry } from '../../serviceRegistry';
import { SERVICE_NAMES } from '../../bootstrap';
import { DeviceSummary } from '../../../types/autonomous-brain';
import type { Device } from '../../device/deviceManager';

/** 最大短期记忆条目数 */
const MAX_MEMORY_NOTES = 10;
/** 会话轮换周期（每 N 次 tick 换一个 sessionId，防止 Agent 历史无限膨胀） */
const SESSION_ROTATION_INTERVAL = 20;
/** P1: 情景记忆上限 */
const MAX_EPISODIC_MEMORY = 100;
/** P1: 衰减系数 — 每小时乘以此系数的幂次 */
const DECAY_FACTOR_PER_HOUR = 0.98;
/** P1: 巩固阈值 — 频次超过这个值才固化到长期知识库 */
const CONSOLIDATION_THRESHOLD = 5;
/** P1: 废弃阈值 — 衰减下降到这个值以下的记忆被遗忘 */
const FORGET_THRESHOLD = 0.1;

/**
 * 带超时的 Promise 包装器
 * 使用 AbortController + Promise.race 实现 5 秒超时取消
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), ms);
    return Promise.race([
        promise.finally(() => clearTimeout(timeoutHandle)),
        new Promise<never>((_, reject) =>
            controller.signal.addEventListener('abort', () =>
                reject(new Error(`${label} 超时 (${ms}ms)`))
            )
        ),
    ]);
}

/**
 * 带并发上限的并行采集函数
 * 当 items 数量超过 concurrencyLimit 时分批执行
 */
async function parallelCollectWithLimit<T, I>(
    items: I[],
    collector: (item: I) => Promise<T>,
    concurrencyLimit = 10
): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = [];
    for (let i = 0; i < items.length; i += concurrencyLimit) {
        const batch = items.slice(i, i + concurrencyLimit);
        const batchResults = await Promise.allSettled(batch.map(item => collector(item)));
        results.push(...batchResults);
    }
    return results;
}

/** 压缩告警列表：超过 5 条时按 severity 分组计数 + 最近 3 条详情 */
function compressAlerts(alerts: any[]): string {
    if (alerts.length <= 5) return JSON.stringify(alerts);
    const groups: Record<string, number> = {};
    for (const a of alerts) {
        const sev = a.severity ?? 'unknown';
        groups[sev] = (groups[sev] ?? 0) + 1;
    }
    const stats = Object.entries(groups).map(([sev, cnt]) => `${sev}: ${cnt}`).join(', ');
    const recent = alerts.slice(0, 3);
    return `[摘要: ${alerts.length}条告警 (${stats})] 最近3条: ${JSON.stringify(recent)}`;
}

/** 压缩异常预测：超过 3 条时仅保留 confidence > 0.5 的项，其余压缩为计数摘要 */
function compressPredictions(predictions: any[]): string {
    if (predictions.length <= 3) return JSON.stringify(predictions);
    const high = predictions.filter(p => p.confidence > 0.5);
    const lowCount = predictions.length - high.length;
    let result = JSON.stringify(high);
    if (lowCount > 0) result += ` ...及另外 ${lowCount} 个低置信度预测`;
    return result;
}

/** 压缩检测到的模式：超过 3 条时仅展示 confidence 排名前 3 的详情，其余压缩为计数摘要 */
function compressPatterns(patterns: any[]): string {
    if (patterns.length <= 3) return JSON.stringify(patterns);
    const sorted = [...patterns].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const top3 = sorted.slice(0, 3);
    return `${JSON.stringify(top3)} ...及另外 ${patterns.length - 3} 个低置信度模式`;
}

export class AutonomousBrainService {
    private reActController: ReActLoopController;
    private brainTools: import('../rag/mastraAgent').AgentTool[] = [];
    /** SkillFactory 引用（L3 封装，提供统一工具列表：Skill + MCP + DeviceDriver） */
    private _skillFactory: import('../skill/skillFactory').SkillFactory | null = null;
    private tickIntervalPath?: NodeJS.Timeout;
    private isRunning: boolean = false;
    private memory: BrainMemory;
    private sessionId: string;

    /** P1: 互斥锁 — 防止并发 tick */
    private isTickRunning: boolean = false;
    /** 🟡 FIX 1.7: 中断标志 — stop() 时通知正在运行的 tick 提前退出 */
    private isStopping: boolean = false;
    /** P2: tick 计数器 — 用于会话轮换 */
    private tickCount: number = 0;
    /** 冷却时间：上次 tick 结束时间戳，防止连续 critical 告警导致串行轰炸 */
    private lastTickEndTime: number = 0;
    private readonly TICK_COOLDOWN_MS = 30_000; // 30 秒冷却
    /** P6: 夜间记忆巩固定时任务 */
    private consolidationCronJob: CronScheduledTask | null = null;
    /** P6: 每日 Token 消耗跟踪 */
    private dailyTokensUsed: number = 0;
    private lastTokenResetDate: string = new Date().toISOString().split('T')[0];
    /** 配置变更监听器取消函数 */
    private unsubscribeConfigChange: (() => void) | null = null;
    /** 补偿 tick 的延迟句柄 — stop() 时需要取消 */
    private deferredTickTimeout: NodeJS.Timeout | null = null;

    /** 🟢 FIX 1.13: AI 适配器缓存 — 仅在配置变化时重新创建 */
    private cachedAdapter: { adapter: any; configKey: string } | null = null;

    /** 🟢 FIX 1.14: 上一次 triggerTick 的 payload 指纹，用于去重 */
    private lastTriggerPayloadHash: string = '';

    /** 感知缓存守护进程使用的设备列表缓存（每次 tick 后更新） */
    private _cachedManagedDevices: DeviceSummary[] = [];
    /** 🟡 FIX: 感知降级标志，用于注入 Prompt 告知 LLM 缓存可能过时 */
    private _isDevicePerceptionDegraded: boolean = false;
    /** 感知缓存守护进程使用的 DevicePool 引用缓存 */
    private _cachedPool: import('../../device/devicePool').DevicePool | null = null;
    /** 大脑感知层连续失败计数器 */
    private _deviceFetchFailCount: number = 0;
    /** 🟡 FIX (Gemini audit): 上次记入失败的时间，防止多感知源并行调用时重复计数 */
    private _lastDeviceFetchFailTime: number = 0;
    /** 🟡 FIX (Gemini audit): 上一次感知降级告警时间，用于防止告警风暴 */
    private _lastDegradationAlertTime: number = 0;
    /** 🔴 FIX (Gemini audit): 系统失明标志（0设备+获取失败） */
    private _isSystemBlind: boolean = false;

    /** Brain 会话记忆（用于 ReActLoopController 的 ConversationMemory） */
    private conversationMemory: ConversationMemory;

    /** 事件发射器 — 用于 SSE 实时推送大脑思考过程 */
    public readonly events = new EventEmitter();

    constructor() {
        this.memory = {
            lastTickTime: Date.now(),
            ongoingInvestigations: [],
            notes: [],
            episodicMemory: []  // P1: 初始化情景记忆
        };

        // 使用 ReActLoopController 替代 MastraAgent — 复用成熟的 ReAct 循环引擎
        // 获得：循环检测、LLM 重试、工具失败分析、反思纠错、上下文压缩、并行执行等能力
        this.reActController = new ReActLoopController({
            maxIterations: 15,
            temperature: 0.2, // 较低的温度，保持决策稳定性
            knowledgeEnhancedMode: false, // Brain 不需要知识检索
            enableIntelligentRetrieval: false,
            enableOutputValidation: false,
            enableSmartSummarization: true, // 工具输出自动摘要
            enableUsageTracking: false,
            parallelExecution: {
                enabled: true,
                mode: 'auto',
                maxConcurrency: 3,
                batchTimeout: 60000,
                enablePlanning: false, // Brain 不需要计划模式
                planningTimeout: 1000,
                retryCount: 1,
                enableCircuitBreaker: true,
                rolloutPercentage: 100,
            },
        });

        // 注册 Brain 专属工具（延迟 require 避免循环依赖：brainTools → alertPipeline → autonomousBrainService）
        // 使用 setImmediate 推迟到当前模块初始化完成后再注册，彻底解决循环依赖问题
        setImmediate(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { brainTools: tools } = require('./brainTools') as { brainTools: import('../rag/mastraAgent').AgentTool[] };
            if (Array.isArray(tools)) {
                this.brainTools = tools;
                this.reActController.registerTools(tools);
            }
        });

        // 生成一个持久化的 Session ID，让大脑在运行期间保持上下文记忆
        this.sessionId = uuidv4();

        // 初始化会话记忆
        this.conversationMemory = {
            sessionId: this.sessionId,
            messages: [],
            context: {},
            createdAt: Date.now(),
            lastUpdated: Date.now(),
        };

        // 允许多个 SSE 客户端同时监听思考事件
        this.events.setMaxListeners(50);
    }

    /**
     * 注入 SkillFactory（向量检索 + 执行引擎）
     * Requirements: E7.21 — AutonomousBrainService 通过 SkillFactory 发现和执行统一工具
     */
    public setSkillFactory(sf: import('../skill/skillFactory').SkillFactory): void {
        this._skillFactory = sf;
        logger.info('[AutonomousBrain] SkillFactory injected');
    }

    /**
     * 发射大脑思考事件，供前端意识流实时展示 OODA 推理过程
     * @param phase OODA 阶段
     * @param message 思考内容
     * @param meta 可选元数据
     */
    private emitThinking(phase: 'observe' | 'orient' | 'decide' | 'act' | 'learn' | 'error', message: string, meta?: Record<string, unknown>): void {
        try {
            this.events.emit('brain:thinking', {
                phase,
                message,
                timestamp: Date.now(),
                tickCount: this.tickCount,
                ...meta,
            });
        } catch { /* SSE 推送失败不影响核心逻辑 */ }
    }

    /**
     * 启动自主大脑 7x24 OODA 循环
     */
    public async start(): Promise<void> {
        const config = getEvolutionConfig().autonomousBrain;
        if (!config || !config.enabled) {
            logger.info('AutonomousBrainService is disabled in config.');
            return;
        }

        if (this.isRunning) {
            logger.warn('AutonomousBrainService is already running.');
            return;
        }

        // ReActLoopController 不需要异步初始化（无文件系统依赖）
        // 工具已在构造函数中注册

        const intervalMs = config.tickIntervalMinutes * 60 * 1000;

        logger.info(`Starting Autonomous Brain (Tier 0 Commander). Tick interval: ${config.tickIntervalMinutes} minutes.`);
        this.isRunning = true;
        // 🟡 FIX 1.7: 重置中断标志
        this.isStopping = false;

        // 立即执行第一次 Tick
        setImmediate(() => this.tick('schedule'));

        // 设置定时轮询
        this.tickIntervalPath = setInterval(() => {
            this.tick('schedule');
        }, Math.max(intervalMs, 60000)); // 最少1分钟

        // P0-1 FIX: 注册凌晨3点的夜间记忆巩固 cron 任务
        this.consolidationCronJob = cron.schedule('0 3 * * *', () => {
            logger.info('[Brain] Nightly memory consolidation triggered by cron.');
            this.consolidateMemory().catch(err => {
                logger.error('[Brain] Nightly consolidation failed:', err);
            });
        });

        // P2-2 FIX: 监听配置变更，当大脑被禁用时自动停止（可取消订阅）
        this.unsubscribeConfigChange = addConfigChangeListener((newConfig) => {
            if (!newConfig.autonomousBrain?.enabled && this.isRunning) {
                logger.warn('[Brain] Config change detected: autonomousBrain disabled. Stopping brain.');
                this.stop();
            }
        });

        // 感知缓存守护进程：注册 6 个感知源，后台预热缓存
        // 注意：感知源采集函数与 gatherContext() 中的 collect* lambda 保持一致
        // 守护进程以 30s 间隔轮询，使 schedule Tick 的 OBSERVE 阶段从 ~5s 降至 <100ms
        this._registerPerceptionSources();
        perceptionCache.startDaemon();
    }

    /**
     * 停止大脑服务
     */
    public stop(): void {
        // 🟡 FIX 1.7: 设置中断标志，通知正在运行的 tick 提前退出
        this.isStopping = true;
        if (this.tickIntervalPath) {
            clearInterval(this.tickIntervalPath);
            this.tickIntervalPath = undefined;
        }
        // P0-1: 停止巩固 cron
        if (this.consolidationCronJob) {
            this.consolidationCronJob.stop();
            this.consolidationCronJob = null;
        }
        // FIX: 取消配置变更监听，防止反复 start/stop 泄漏
        if (this.unsubscribeConfigChange) {
            this.unsubscribeConfigChange();
            this.unsubscribeConfigChange = null;
        }
        // FIX: 取消待执行的补偿 tick，防止 stop 后仍触发
        if (this.deferredTickTimeout) {
            clearTimeout(this.deferredTickTimeout);
            this.deferredTickTimeout = null;
        }
        this.isRunning = false;
        perceptionCache.stopDaemon();
        logger.info('Autonomous Brain stopped.');
    }

    /**
     * 允许系统的其他组件抛出中断，唤醒大脑（被感知总线的主动事件触发）
     */
    /** FIX: 标志位 — 冷却期内有紧急事件被排队，tick 结束后需补偿执行 */
    private hasQueuedEmergencyTick: boolean = false;

    public async triggerTick(reason: 'critical_alert' | 'decision_pending' | 'manual', payload?: unknown): Promise<void> {
        const config = getEvolutionConfig().autonomousBrain;
        if (!config?.enabled) return;

        // 冷却检查：防止连续 critical 告警导致串行轰炸（manual 触发不受限）
        if (reason !== 'manual') {
            const elapsed = Date.now() - this.lastTickEndTime;
            if (elapsed < this.TICK_COOLDOWN_MS) {
                // 🟢 FIX: 仅在冷却期内做去重 — 冷却期外的相同事件是合法的独立事件，不应丢弃
                if (payload) {
                    const payloadStr = JSON.stringify(payload);
                    const payloadHash = `${reason}:${payloadStr}`;
                    if (payloadHash === this.lastTriggerPayloadHash) {
                        logger.debug(`[Brain] Duplicate trigger payload during cooldown, skipping note. Hash: ${payloadHash.slice(0, 60)}`);
                    } else {
                        this.pushNote(`Woken up by ${reason}: ${payloadStr}`);
                        this.lastTriggerPayloadHash = payloadHash;
                    }
                }
                logger.debug(`[Brain] Tick cooldown active (${Math.round((this.TICK_COOLDOWN_MS - elapsed) / 1000)}s remaining). Payload saved to inbox, deferring ${reason} trigger.`);
                this.hasQueuedEmergencyTick = true;
                return;
            }
        }

        // 不在冷却期 — 事件被实际处理，更新哈希并写入收件箱
        if (payload) {
            const payloadStr = JSON.stringify(payload);
            this.lastTriggerPayloadHash = `${reason}:${payloadStr}`;
            this.pushNote(`Woken up by ${reason}: ${payloadStr}`);
        } else {
            // 无 payload 的触发清空哈希，防止后续合法事件被误判为重复
            this.lastTriggerPayloadHash = '';
        }

        logger.warn(`Brain waken up proactively by [${reason}]. Triggering emergency OODA loop.`);

        await this.tick(reason);
    }

    /**
     * 核心 OODA 循环
     * P1 修复: 使用互斥锁防止并发执行
     */
    private async tick(trigger: 'schedule' | 'critical_alert' | 'decision_pending' | 'manual'): Promise<void> {
        // P1: 互斥锁 — 如果有 tick 正在运行，设置排队标志并跳过本次
        if (this.isTickRunning) {
            logger.debug(`[Brain] Tick skipped (another tick is already running). Trigger: ${trigger}`);
            if (trigger !== 'schedule') {
                this.hasQueuedEmergencyTick = true;
            }
            return;
        }

        // Token 预算硬阻断：schedule 类 tick 在超预算时跳过（告警/手动触发不受限）
        if (trigger === 'schedule') {
            const config = getEvolutionConfig().autonomousBrain;
            if (config && config.dailyTokenBudget && this.dailyTokensUsed > config.dailyTokenBudget) {
                logger.warn(`[Brain] ⛔ Schedule tick blocked — daily token budget exceeded (${this.dailyTokensUsed}/${config.dailyTokenBudget}). Only critical_alert/manual triggers allowed.`);
                return;
            }
        }

        this.isTickRunning = true;
        const tickId = `tick-${this.tickCount + 1}-${Date.now()}`;
        logger.debug(`[Brain Tick ${tickId}] Starting OODA loop triggered by ${trigger}.`);
        this.emitThinking('observe', `OODA 循环启动 [${trigger}]，Tick #${this.tickCount + 1}`, { tickId, trigger });

        try {
            // P2: 会话轮换 — 每 N 次 tick 换一个 sessionId，防止上下文历史占用过多内存
            this.tickCount++;
            if (this.tickCount % SESSION_ROTATION_INTERVAL === 0) {
                this.sessionId = uuidv4();
                logger.info(`[Brain Tick ${tickId}] Session rotated (tick #${this.tickCount}). New session: ${this.sessionId.slice(0, 8)}...`);
                this.emitThinking('observe', `会话轮换 — 第 ${this.tickCount} 次 tick，重置上下文防止历史膨胀`);
                // 重置会话记忆
                this.conversationMemory = {
                    sessionId: this.sessionId,
                    messages: [],
                    context: {},
                    createdAt: Date.now(),
                    lastUpdated: Date.now(),
                };
            }

            // FIX: 将 notes 克隆为"只读一次"的收件箱，然后立即清空原数组
            // 这样 Prompt 中只包含上一次 tick 到当前 tick 之间的新事件，防止 LLM 对陈旧事件产生幻觉
            const currentNotes = [...this.memory.notes];
            this.memory.notes = [];

            // 1. OBSERVE (观察) - 汇聚全域感知数据
            // P1: 每次 tick 前执行记忆衰减
            this.decayMemory();

            this.emitThinking('observe', '正在汇聚全域感知数据：健康指标、活跃告警、异常预测、拓扑图谱...');
            const context = await this.gatherContext(tickId, trigger);

            // 🟡 FIX 1.7: 在 gatherContext 后检查中断标志
            if (this.isStopping) {
                logger.info(`[Brain Tick ${tickId}] Stopping flag detected after gatherContext. Aborting tick.`);
                this.emitThinking('observe', '检测到停止信号，中止当前 OODA 循环');
                return;
            }

            // 发射观察阶段的汇总
            this.emitThinking('observe', `感知完成 — 活跃告警: ${context.activeAlerts.length}, 异常预测: ${context.anomalyPredictions.length}, 操作模式: ${context.detectedPatterns.length}`, {
                alertCount: context.activeAlerts.length,
                predictionCount: context.anomalyPredictions.length,
                patternCount: context.detectedPatterns.length,
                topologySummary: context.topologySummary,
            });

            // 🟢 FIX: 将感知源健康度摘要推送到意识流，让运维人员直接看到传感器是否降级
            if (context.perceptionSummary) {
                this.emitThinking('observe', context.perceptionSummary);
            }

            // 2. ORIENT & DECIDE (认知与决策) - 构建系统 Prompt 并交由 ReAct 循环推理
            // 🔴 FIX 1.5: 在 buildPrompt 之前显式执行副作用（从 _buildFilteredIntentSummary 移出）
            // 确保 Schema 修改在 Prompt 构建之前完成
            const resolvedCategories = this._resolveIntentCategories(context);
            setCurrentInjectedCategories(resolvedCategories);
            updateDeviceRequirement(context.managedDevices?.length ?? 0);

            // 🔴 FIX 1.4: 在 buildPrompt 之前推断 tickDeviceId，注入到 Prompt 中
            const tickDeviceId = this.inferTickDeviceId(context, trigger);

            // 🔴 FIX 1.9: 每次 tick 动态更新 invoke_skill 工具的技能列表
            updateSkillToolDescription();

            const prompt = this.buildPrompt(context, currentNotes, tickDeviceId);

            this.emitThinking('orient', '认知阶段 — 构建系统 Prompt，交由 ReAct 循环推理决策...');
            logger.info(`[Brain Tick ${tickId}] Context gathered. Orienting & Deciding (calling ReActLoopController)...`);
            const startTime = Date.now();

            // 🟡 FIX 1.7: 在 ReAct 循环前检查中断标志
            if (this.isStopping) {
                logger.info(`[Brain Tick ${tickId}] Stopping flag detected before ReAct loop. Aborting tick.`);
                this.emitThinking('orient', '检测到停止信号，中止当前 OODA 循环');
                return;
            }

            // 获取 AI 适配器（🟢 FIX 1.13: 缓存复用，仅在配置变化时重新创建）
            const aiConfig = await apiConfigService.getDefault();
            if (!aiConfig) {
                throw new Error('No AI provider configured for Brain. Please configure an AI provider in settings.');
            }
            const apiKey = await apiConfigService.getDecryptedApiKey(aiConfig.id);
            const configKey = `${aiConfig.provider}:${aiConfig.endpoint}:${aiConfig.model}`;
            let adapter;
            if (this.cachedAdapter && this.cachedAdapter.configKey === configKey) {
                adapter = this.cachedAdapter.adapter;
            } else {
                adapter = AdapterFactory.createAdapter(aiConfig.provider, {
                    apiKey,
                    endpoint: aiConfig.endpoint,
                });
                this.cachedAdapter = { adapter, configKey };
                logger.debug(`[Brain] AI adapter created/refreshed for config: ${configKey}`);
            }

            // 🔴 FIX: 获取 fresh routerosClient 传递给执行上下文
            // tickDeviceId 已在 buildPrompt 之前通过 inferTickDeviceId() 推断完成
            let tickRouterosClient: import('../../routerosClient').RouterOSClient | undefined;

            const hasManagedDevices = context.managedDevices && context.managedDevices.length > 0;

            if (hasManagedDevices) {
                const devices = context.managedDevices;

                // 单台受管设备时，获取全局 routerosClient 作为后备
                if (devices.length === 1) {
                    try {
                        const { routerosClient: globalClient } = await import('../../routerosClient');
                        const reconnected = await globalClient.ensureConnectedOrReconnect();
                        if (reconnected) {
                            tickRouterosClient = globalClient;
                            logger.info(`[Brain] Single managed device: global routerosClient acquired as fallback for standalone mode.`);
                        }
                    } catch (err) {
                        logger.debug(`[Brain] Single managed device: global routerosClient unavailable (${err instanceof Error ? err.message : String(err)}). Will rely on DevicePool Route A.`);
                    }
                }
                // 多设备（>1）不获取 tickRouterosClient — 让 intentRegistry Route A 按 deviceId 独立获取连接
            }

            if (!hasManagedDevices) {
                // ── 单设备模式（无受管设备）：保持全局 routerosClient 自愈 ──
                try {
                    const { routerosClient: globalClient } = await import('../../routerosClient');
                    const reconnected = await globalClient.ensureConnectedOrReconnect();
                    if (reconnected) {
                        tickRouterosClient = globalClient;
                        logger.debug('[Brain] Using global routerosClient (auto-reconnected if needed).');
                    } else {
                        logger.warn('[Brain] Global routerosClient unavailable. execute_intent will fail gracefully with _brainHint.');
                    }
                } catch (err) {
                    logger.warn(`[Brain] Failed to obtain routerosClient for tick: ${err instanceof Error ? err.message : String(err)}. Continuing without it.`);
                }
            }

            // 创建执行上下文 — 每次 tick 独立，并发安全
            const executionContext = createExecutionContext(
                adapter,
                aiConfig.provider,
                aiConfig.model,
                0.2, // Brain 使用低温度保持决策稳定性
                undefined, // skillContext — Brain 不使用 Skill 系统
                tickRouterosClient, // 单设备模式：fresh routerosClient；多设备模式：undefined
                tickDeviceId // 🔴 FIX: tick 上下文推断的目标设备 ID，brainTools 用作 LLM 未传 deviceId 时的兜底
            );
            // Brain 的完整 Prompt 作为系统提示词覆盖
            executionContext.systemPromptOverride = prompt;
            // Brain 不需要知识增强
            executionContext.configOverrides = {
                knowledgeEnhancedMode: false,
                enableIntelligentRetrieval: false,
                enableOutputValidation: false,
            };

            // 构建合成的 IntentAnalysis — Brain 不需要意图路由
            // 🟢 SkillFactory 集成：通过 L3 SkillFactory 获取全量工具（Skill + MCP + DeviceDriver）
            let allToolsForBrain = this.brainTools;
            if (this._skillFactory) {
                try {
                    allToolsForBrain = this._skillFactory.getAllToolsAsAgentTools();
                    // 同步更新 ReAct 控制器的工具列表
                    this.reActController.registerTools(allToolsForBrain);
                } catch (err) {
                    logger.warn(`[Brain] SkillFactory.getAllToolsAsAgentTools() failed, falling back to local brainTools: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const brainIntentAnalysis: IntentAnalysis = {
                intent: 'autonomous_brain_ooda_tick',
                tools: allToolsForBrain.map(t => ({
                    name: t.name,
                    params: {},
                    reason: 'Brain registered tool',
                })),
                confidence: 1.0,
                requiresMultiStep: true,
            };

            // 调用 ReAct 循环 — 复用成熟的推理引擎
            const reActResult: ReActLoopResult = await this.reActController.executeLoop(
                `Execute OODA loop analysis for tick ${tickId}. Trigger: ${context.trigger}. Analyze the system state and take necessary actions.`,
                brainIntentAnalysis,
                this.conversationMemory,
                executionContext
            );

            const duration = Date.now() - startTime;

            // 从 ReAct 结果中提取 Brain 需要的数据
            const toolCallSteps = reActResult.steps.filter(s => s.type === 'action' && s.toolName);

            logger.info(`[Brain Tick ${tickId}] Decision process completed in ${duration}ms. Iterations: ${reActResult.iterations}`);

            // 发射推理过程中的 reasoning 步骤（去重：跳过与上一条完全相同的 thought）
            let lastThoughtContent = '';
            for (const step of reActResult.steps) {
                if (step.type === 'thought') {
                    if (step.content === lastThoughtContent) continue; // 跳过重复
                    lastThoughtContent = step.content;
                    this.emitThinking('decide', step.content);
                }
            }
            this.emitThinking('decide', `决策完成 — 耗时 ${duration}ms，迭代 ${reActResult.iterations} 次`, { duration, iterations: reActResult.iterations });

            // Token 预算跟踪
            // P1 FIX: ReActLoopResult 不暴露 token 计数，使用改进的估算：
            // 每次迭代包含 1 次 LLM 调用（prompt ~1500 tokens + completion ~500 tokens）
            // 加上工具调用的输出（每个工具调用 ~300 tokens）
            const toolCallCount = toolCallSteps.length;
            const estimatedTokens = (reActResult.iterations * 2000) + (toolCallCount * 300);
            this.trackTokenUsage({ usage: { totalTokens: estimatedTokens } });

            // 将 Brain 的消息追加到会话记忆（供下次 tick 参考）
            this.conversationMemory.messages.push(
                { role: 'user', content: `OODA tick ${tickId} [${context.trigger}]` },
                { role: 'assistant', content: reActResult.finalAnswer || '(no actions taken)' }
            );
            // 裁剪会话消息，防止无限增长
            if (this.conversationMemory.messages.length > 20) {
                this.conversationMemory.messages = this.conversationMemory.messages.slice(-20);
            }
            this.conversationMemory.lastUpdated = Date.now();

            // 3. ACT (行动) - ReActLoopController 已在循环中自主调用了 brainTools。
            //    这里我们主要负责记录行动轨迹和反馈。
            if (toolCallSteps.length > 0) {
                logger.info(`[Brain Tick ${tickId}] Brain opted to use ${toolCallSteps.length} tools.`);

                const toolsUsed = toolCallSteps.map(tc => tc.toolName).join(', ');
                this.pushNote(`At ${new Date().toISOString()}, executed tools: ${toolsUsed}`);

                // 🔴 FIX: 发射每个工具调用的行动事件 + 对应的 observation 结果
                // 之前只发射 action step（没有 duration 和 success），导致全息座舱看不到工具执行结果
                // 现在：为每个 action step 查找对应的 observation step，获取真实 duration 和 success/error
                // NOTE: 并行执行时多个 action 共享一个 merged observation（ReActLoopController 设计如此），
                //       此时所有 action 会关联到同一个 observation，这是预期行为。
                const SUMMARY_MAX = 500;
                const allSteps = reActResult.steps;

                // 辅助函数：为 action step 查找对应的 observation step
                const findObsForAction = (action: typeof allSteps[number]): typeof allSteps[number] | undefined => {
                    const idx = allSteps.indexOf(action);
                    return idx >= 0 ? allSteps.slice(idx + 1).find(s => s.type === 'observation') : undefined;
                };

                for (const tc of toolCallSteps) {
                    const obs = findObsForAction(tc);
                    const realDuration = obs?.duration ?? tc.duration ?? 0;
                    // 🟡 FIX (Gemini audit): 默认 false（fail-safe），缺失 observation 视为失败而非成功
                    const toolSuccess = obs?.success ?? false;

                    const rawInput = { ...(tc.toolInput || {}) } as Record<string, unknown>;
                    if (typeof rawInput.justification === 'string') {
                        const saved = rawInput.justification;
                        rawInput.justification = '';
                        const skeletonLen = JSON.stringify(rawInput).length;
                        const budget = Math.max(60, SUMMARY_MAX - skeletonLen - 3);
                        rawInput.justification = saved.length > budget
                            ? saved.slice(0, budget) + '...'
                            : saved;
                    }
                    const inputSummary = JSON.stringify(rawInput).slice(0, SUMMARY_MAX);
                    const statusIcon = toolSuccess ? '✅' : '❌';
                    this.emitThinking('act', `${statusIcon} 执行工具: ${tc.toolName}(${inputSummary}) — ${realDuration}ms`, {
                        tool: tc.toolName,
                        duration: realDuration,
                        success: toolSuccess,
                    });

                    // 🔴 FIX: 发射 observation 结果到意识流，让运维人员看到工具返回的实际数据或错误
                    if (obs) {
                        const obsContent = typeof obs.toolOutput === 'object'
                            ? JSON.stringify(obs.toolOutput).slice(0, 300)
                            : String(obs.toolOutput || obs.content || '').slice(0, 300);
                        if (!toolSuccess) {
                            this.emitThinking('act', `⚠️ 工具失败: ${obsContent}`, { tool: tc.toolName, error: true });
                        } else {
                            this.emitThinking('act', `📋 返回结果: ${obsContent}`, { tool: tc.toolName });
                        }
                    }
                }

                // 4. LEARN (学习闭环) — 将本轮操作记录到 ContinuousLearner
                // 🔴 FIX: 使用 observation 的实际 success 状态，不再硬编码 'success'
                let successCount = 0;
                let failCount = 0;
                for (const tc of toolCallSteps) {
                    const obs = findObsForAction(tc);
                    // 🟡 FIX (Gemini audit): 默认 false（fail-safe），缺失 observation 视为失败
                    const toolSuccess = obs?.success ?? false;
                    if (toolSuccess) successCount++; else failCount++;
                    try {
                        continuousLearner.recordOperation('brain', {
                            userId: 'brain',
                            sessionId: this.sessionId,
                            toolName: tc.toolName || 'unknown',
                            parameters: tc.toolInput || {},
                            result: toolSuccess ? 'success' : 'failure',
                            timestamp: Date.now()
                        });
                    } catch { /* non-critical */ }
                }
                this.emitThinking('learn', `学习闭环 — 记录 ${toolCallSteps.length} 个操作 (${successCount} 成功, ${failCount} 失败)`);
                // Note: ContinuousLearner 会通过内置定时器自动执行策略评估和最佳实践提升

                // 需求 4.1, 4.6, 4.7: 知识写入（每次 Tick 最多 1 次）
                // 🔴 FIX: 扩展触发条件 — 不再仅限 P0/P1 场景
                // 原因：schedule/manual 触发的 tick 如果执行了工具且成功，也应该生产知识
                // activeWrite 内部会根据 trigger 类型决定知识条目的优先级和标签
                {
                    const knowledgeBase = await import('../rag/knowledgeBase').then(m => m.knowledgeBase);
                    // 🔴 FIX: 确保 KB 已初始化，否则 kb.add() 会因 ensureInitialized() 抛异常
                    if (!knowledgeBase.isInitialized()) {
                        await knowledgeBase.initialize();
                    }
                    knowledgeDistiller.activeWrite(context, reActResult.steps, knowledgeBase).catch(err => {
                        logger.warn(`[Brain] KnowledgeDistiller.activeWrite failed: ${err instanceof Error ? err.message : String(err)}`);
                        // 失败补偿：记录到情景记忆，下次巩固周期补偿写入知识库
                        const actionNames = reActResult.steps.filter(s => s.type === 'action' && s.toolName).map(s => s.toolName).join(', ');
                        this.addEpisode(
                            `[ActiveWrite 失败补偿] trigger=${context.trigger}, actions=${actionNames}, error=${err instanceof Error ? err.message : String(err)}`,
                            `Trigger: ${context.trigger}, Alerts: ${context.activeAlerts.length}`,
                            'brain_tick',
                        );
                    });
                }
            } else {
                logger.debug(`[Brain Tick ${tickId}] No actions taken this cycle.`);
                this.emitThinking('decide', '本轮无需行动 — 系统状态正常，继续监控');
            }

            // P1: 将本轮的工具调用摘要保存为情景记忆
            // 🔴 FIX: 去掉 tickId（每次唯一），改用 trigger + 工具名称作为内容前缀
            // 原因：addEpisode 用内容前 50 字符匹配相似记忆来递增 verificationCount
            // 旧格式 "Tick tick-N-timestamp: Used tools: ..." 前 50 字符永远不同，
            // 导致 verificationCount 永远为 1，永远达不到 CONSOLIDATION_THRESHOLD(5)
            if (toolCallSteps.length > 0) {
                // 🔴 FIX: 对 toolCallSteps 排序后再生成 summary，确保并行执行时顺序一致
                // 否则前 50 字符可能因顺序不同而匹配失败，无法累加 verificationCount
                const sortedToolCallSteps = [...toolCallSteps].sort((a, b) => (a.toolName || '').localeCompare(b.toolName || ''));
                const toolNames = sortedToolCallSteps.map(tc => tc.toolName).join(', ');
                const summary = sortedToolCallSteps.map(tc => `${tc.toolName}(${JSON.stringify(tc.toolInput || {}).slice(0, 80)})`).join('; ');
                this.addEpisode(
                    `[${context.trigger}] Tools: ${toolNames} | ${summary}`,
                    `Trigger: ${context.trigger}, Alerts: ${context.activeAlerts.length}`,
                    'brain_tick'
                );
            }

            // P0 FIX: 维护 ongoingInvestigations — 追踪活跃告警 ID
            // 新增当前活跃告警到追踪列表，移除已消失的告警
            const currentAlertIds = new Set(context.activeAlerts.map(a => a.id).filter(Boolean));
            // 添加新出现的告警
            for (const alertId of currentAlertIds) {
                if (!this.memory.ongoingInvestigations.includes(alertId)) {
                    this.memory.ongoingInvestigations.push(alertId);
                }
            }
            // 移除已消失的告警（不再活跃）
            this.memory.ongoingInvestigations = this.memory.ongoingInvestigations.filter(
                id => currentAlertIds.has(id)
            );
            // 上限保护
            if (this.memory.ongoingInvestigations.length > 50) {
                this.memory.ongoingInvestigations = this.memory.ongoingInvestigations.slice(-50);
            }

            // 5. Update Memory for the next cycle
            this.memory.lastTickTime = Date.now();

        } catch (error) {
            logger.error(`[Brain Tick ${tickId}] Severe failure in OODA loop. Error: ${error}`);
            this.emitThinking('error', `OODA 循环异常: ${error instanceof Error ? error.message : String(error)}`);

            // 记录一次系统故障，可以由外部监控捕获
            this.pushNote(`Failure occurred during tick ${tickId}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // P1: 释放互斥锁
            this.isTickRunning = false;
            // 记录 tick 结束时间，用于冷却计算
            this.lastTickEndTime = Date.now();

            // FIX: 如果冷却期内有紧急事件被排队，在冷却结束后立即补偿执行
            if (this.hasQueuedEmergencyTick) {
                this.hasQueuedEmergencyTick = false;
                // 如果已有计划的补偿 tick，取消它，以最新的为准
                if (this.deferredTickTimeout) {
                    clearTimeout(this.deferredTickTimeout);
                }
                // P2 FIX: 直接使用 TICK_COOLDOWN_MS 作为延迟，因为 lastTickEndTime 刚刚被设置，
                // 之前的 remaining 计算 (TICK_COOLDOWN_MS - (Date.now() - lastTickEndTime)) 总是约等于 TICK_COOLDOWN_MS
                const delay = Math.max(this.TICK_COOLDOWN_MS, 100);
                logger.info(`[Brain] Deferred emergency tick scheduled in ${delay}ms.`);
                this.deferredTickTimeout = setTimeout(() => {
                    this.deferredTickTimeout = null;
                    if (this.isRunning) {
                        this.tick('critical_alert').catch(err => {
                            logger.error('[Brain] Deferred emergency tick failed:', err);
                        });
                    }
                }, delay);
            }
        }
    }

    /**
     * P8 修复: 安全地向短期记忆追加笔记，自动裁剪至上限
     * 也供外部模块（如 intentRegistry 审批后验证）推送系统笔记
     * @param note 笔记内容
     * @param source 调用来源标识，便于日志追踪（如 'intentRegistry:post-approval'）
     */
    public pushNote(note: string, source = 'internal'): void {
        logger.debug(`[Brain:pushNote] source=${source} note=${note.slice(0, 80)}`);
        this.memory.notes.push(note);
        while (this.memory.notes.length > MAX_MEMORY_NOTES) {
            this.memory.notes.shift();
        }
    }

    // ==========================================================================
    // P1: 双轨记忆模型
    // ==========================================================================

    /**
     * 🔴 FIX 1.3: 构建情景记忆的结构化匹配键
     * 从 content 中提取 trigger 类型和工具名称集合，生成稳定的匹配键
     * 格式: "source:trigger:toolA,toolB,toolC"
     * 解决前 50 字符匹配不稳定的问题（并行执行时工具顺序不同、参数不同等）
     */
    private buildEpisodeMatchKey(content: string, source: string): string {
        // 提取 trigger 类型
        const triggerMatch = content.match(/\[(schedule|critical_alert|decision_pending|manual)\]/);
        const trigger = triggerMatch?.[1] || 'unknown';

        // 提取工具名称集合（格式: "Tools: toolA, toolB |"）
        const toolsMatch = content.match(/Tools:\s*(.+?)\s*\|/);
        const toolNames = toolsMatch?.[1]
            ?.split(',')
            .map(t => t.trim())
            .filter(Boolean)
            .sort()
            .join(',') || '';

        return `${source}:${trigger}:${toolNames}`;
    }

    /**
     * 添加情景记忆（短期层）
     * 师傅教导：任何反思结果必须先进短期记忆，不能直接修改底层 Prompt
     */
    private addEpisode(content: string, context: string, source: EpisodicMemory['source']): void {
        // 🔴 FIX 1.3: 使用结构化匹配键优先匹配，fallback 到前 50 字符匹配
        const matchKey = this.buildEpisodeMatchKey(content, source);

        // 优先按 matchKey 匹配（更精确）
        let existing = this.memory.episodicMemory.find(
            ep => ep.source === source && ep.matchKey && ep.matchKey === matchKey && !ep.promoted
        );

        // Fallback: 前 50 字符匹配（向后兼容旧记忆条目，它们没有 matchKey）
        if (!existing) {
            const contentPrefix = content.slice(0, 50);
            existing = this.memory.episodicMemory.find(
                ep => ep.source === source && !ep.matchKey && ep.content.slice(0, 50) === contentPrefix && !ep.promoted
            );
        }

        if (existing) {
            existing.verificationCount++;
            existing.lastVerifiedAt = Date.now();
            existing.decayWeight = Math.min(1.0, existing.decayWeight + 0.1);
            // 补写 matchKey（旧条目升级）
            if (!existing.matchKey) existing.matchKey = matchKey;
            logger.debug(`[Brain Memory] Reinforced existing episode (verified ${existing.verificationCount}x, key=${matchKey})`);
            return;
        }

        const episode: EpisodicMemory = {
            id: uuidv4(),
            content,
            context,
            source,
            createdAt: Date.now(),
            lastVerifiedAt: Date.now(),
            verificationCount: 1,
            decayWeight: 1.0,
            promoted: false,
            matchKey,
        };

        this.memory.episodicMemory.push(episode);

        // 超出上限时，淘汰最低权重的记忆
        while (this.memory.episodicMemory.length > MAX_EPISODIC_MEMORY) {
            let minIdx = 0;
            for (let i = 1; i < this.memory.episodicMemory.length; i++) {
                if (this.memory.episodicMemory[i].decayWeight < this.memory.episodicMemory[minIdx].decayWeight) {
                    minIdx = i;
                }
            }
            this.memory.episodicMemory.splice(minIdx, 1);
        }

        logger.debug(`[Brain Memory] Added episode: ${content.slice(0, 60)}... (key=${matchKey}, total: ${this.memory.episodicMemory.length})`);
    }

    /**
 * 记忆衰减（遗忘因子）
 * P3 FIX: 使用 createdAt 作为基准计算绝对衰减，不再将衰减本身视为"验证"
 * 这样衰减速率与 tick 频率解耦，无论 tick 间隔多长结果一致
 * 验证次数越多，衰减越慢（每次验证相当于减少 2 小时的等效衰减）
 */
    private decayMemory(): void {
        const now = Date.now();
        for (const ep of this.memory.episodicMemory) {
            const hoursSinceCreation = (now - ep.createdAt) / (1000 * 3600);
            const effectiveHours = Math.max(0, hoursSinceCreation - ep.verificationCount * 2);
            ep.decayWeight = Math.pow(DECAY_FACTOR_PER_HOUR, effectiveHours);
        }
        // 清除已废弃的记忆
        this.memory.episodicMemory = this.memory.episodicMemory.filter(ep => ep.decayWeight >= FORGET_THRESHOLD);
    }

    /**
     * 夜间记忆巩固（长期知识库转化）
     * 师傅教导：
     * - 频次够高的短期记忆 → 固化到知识库
     * - 孤证 + 过期记忆 → 抹除
     * 每天凌晨执行一次
     */
    private async consolidateMemory(): Promise<void> {
        logger.info('[Brain Memory] Starting nightly memory consolidation...');
        const knowledgeBase = await import('../rag/knowledgeBase').then(m => m.knowledgeBase);
        // 🔴 FIX: 确保 KB 已初始化，否则 kb.add() 会因 ensureInitialized() 抛异常
        if (!knowledgeBase.isInitialized()) {
            await knowledgeBase.initialize();
        }

        let promoted = 0;
        let forgotten = 0;

        // 需求 4.3, 4.5: 先对待巩固记忆做提炼和去重
        const candidateEpisodes = this.memory.episodicMemory.filter(
            ep => !ep.promoted && ep.verificationCount >= CONSOLIDATION_THRESHOLD && ep.decayWeight > 0.5
        );

        // 提炼每条情景记忆为结构化知识条目
        const rawEntries = await Promise.all(
            candidateEpisodes.map(ep => knowledgeDistiller.distillEpisode(ep).catch(() => null))
        );
        const validEntries = rawEntries.filter((e): e is NonNullable<typeof e> => e !== null);

        // 合并去重
        const deduplicatedEntries = validEntries.length > 0
            ? await knowledgeDistiller.mergeAndDeduplicate(validEntries).catch(() => validEntries)
            : [];

        // 建立提炼结果与原始 episode 的精确 ID 映射
        // 注意：mergeAndDeduplicate 会打乱顺序，不能用索引对应，必须用 episodeId 精确匹配
        const episodeToEntry = new Map<string, (typeof deduplicatedEntries)[number]>();
        for (const entry of deduplicatedEntries) {
            episodeToEntry.set(entry.episodeId, entry);
        }

        for (const ep of this.memory.episodicMemory) {
            if (ep.promoted) continue;

            // 频次够高且权重还可以 → 固化为长期知识
            if (ep.verificationCount >= CONSOLIDATION_THRESHOLD && ep.decayWeight > 0.5) {
                try {
                    // 优先使用提炼后的结构化内容，降级到原始内容
                    const distilled = episodeToEntry.get(ep.id);
                    const title = distilled
                        ? distilled.title
                        : `[巩固] ${new Date().toISOString().split('T')[0]} ${ep.content.slice(0, 50)}`;
                    const content = distilled
                        ? distilled.summary
                        : [
                            `触发源: ${ep.source} ${new Date(ep.createdAt).toISOString().split('T')[0]}`,
                            `感知状态 (Observe): ${ep.context || '(无上下文)'}`,
                            `执行动作 (Act): ${ep.content}`,
                            `经验价值评分: 中 (巩固记忆，验证 ${ep.verificationCount} 次)`,
                        ].join('\n');

                    await knowledgeBase.add({
                        type: 'pattern',
                        title,
                        content,
                        metadata: {
                            source: 'brain-consolidation',
                            timestamp: Date.now(),
                            category: 'pattern',
                            tags: ['brain-consolidated', ep.source],
                            usageCount: 0,
                            feedbackScore: 0,
                            feedbackCount: 0,
                        },
                    });
                    ep.promoted = true;
                    promoted++;
                    logger.info(`[Brain Memory] Promoted to long-term: ${ep.content.slice(0, 60)}`);
                } catch { /* non-critical */ }
            }
        }

        // 清除已固化和已废弃的记忆
        const before = this.memory.episodicMemory.length;
        this.memory.episodicMemory = this.memory.episodicMemory.filter(
            ep => !ep.promoted && ep.decayWeight >= FORGET_THRESHOLD
        );
        forgotten = before - this.memory.episodicMemory.length;

        logger.info(`[Brain Memory] Consolidation done. Promoted: ${promoted}, Forgotten: ${forgotten}, Remaining: ${this.memory.episodicMemory.length}`);
    }

    /**
     * P1-2 FIX: Token 预算跟踪
     * 每日重置并累计 token 消耗，超出预算时发出警告并跳过非紧急 tick
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private trackTokenUsage(response: any): void {
        const today = new Date().toISOString().split('T')[0];
        if (today !== this.lastTokenResetDate) {
            this.dailyTokensUsed = 0;
            this.lastTokenResetDate = today;
        }

        // 从 Agent 响应中提取 token 消耗（优先使用 usage.totalTokens）
        const tokensUsed = response?.usage?.totalTokens
            || response?.tokenCount
            || 0;
        this.dailyTokensUsed += tokensUsed;

        const config = getEvolutionConfig().autonomousBrain;
        if (config && this.dailyTokensUsed > config.dailyTokenBudget) {
            logger.warn(`[Brain] ⚠️ Daily token budget exceeded! Used: ${this.dailyTokensUsed}, Budget: ${config.dailyTokenBudget}. Non-critical ticks will be throttled.`);
        }
    }

    /**
     * 🔴 FIX 1.4: 提取 tickDeviceId 推断逻辑为独立方法
     * 推断优先级：
     *   a. 触发告警关联的设备（critical_alert 场景）
     *   b. 唯一在线/可达设备
     *   c. 唯一受管设备
     *   d. undefined — 交给 brainTools / intentRegistry 兜底
     */
    private inferTickDeviceId(context: BrainTickContext, trigger: string): string | undefined {
        const devices = context.managedDevices;
        if (!devices || devices.length === 0) return undefined;

        // 优先级 a: 从触发告警中提取关联设备
        if ((trigger === 'critical_alert' || trigger === 'decision_pending') && context.activeAlerts.length > 0) {
            const alertWithDevice = context.activeAlerts
                .filter((a: any) => a.deviceId && devices.some(d => d.id === a.deviceId))
                .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))[0];
            if (alertWithDevice) {
                const deviceId = (alertWithDevice as any).deviceId;
                logger.info(`[Brain] tickDeviceId inferred from alert source: ${deviceId}`);
                return deviceId;
            }
        }

        // 优先级 b: 唯一在线/可达设备
        const onlineDevices = devices.filter(d => d.reachable || d.status === 'online' || d.status === 'connected');
        if (onlineDevices.length === 1) {
            logger.info(`[Brain] tickDeviceId inferred from sole online device: ${onlineDevices[0].id} (${onlineDevices[0].name})`);
            return onlineDevices[0].id;
        }

        // 优先级 c: 唯一受管设备
        if (devices.length === 1) {
            logger.info(`[Brain] tickDeviceId inferred from sole managed device: ${devices[0].id} (${devices[0].name})`);
            return devices[0].id;
        }

        logger.debug(`[Brain] tickDeviceId could not be inferred (${devices.length} devices, multiple online). LLM must specify deviceId.`);
        return undefined;
    }

    /**
     * 注册 6 个感知源到 PerceptionCache 守护进程
     * 在 start() 中调用一次，守护进程以 30s 间隔预热缓存
     * 注意：每个采集函数在执行时动态获取最新设备列表，避免依赖闭包中的旧引用
     */
    private _registerPerceptionSources(): void {
        // 辅助：在守护进程采集时动态获取最新设备列表和 DevicePool
        // 避免依赖 _cachedManagedDevices（可能是上一次 tick 的旧数据）
        const DEVICE_FETCH_FAIL_THRESHOLD = 3;
        const getLatestDevices = async (): Promise<{
            devices: DeviceSummary[];
            pool: import('../../device/devicePool').DevicePool | null;
            managedDevices: DeviceSummary[];
            isPerceptionDegraded: boolean;
        }> => {
            try {
                const deviceManager = await serviceRegistry.getAsync<{ getDevices(tenantId: string, filter?: any, options?: { allowCrossTenant?: boolean }): Promise<import('../../device/deviceManager').Device[]> }>(SERVICE_NAMES.DEVICE_MANAGER);
                const rawDevices = await deviceManager.getDevices('*', undefined, { allowCrossTenant: true });
                const { DevicePool } = await import('../../device/devicePool');
                const pool = await serviceRegistry.getAsync<InstanceType<typeof DevicePool>>(SERVICE_NAMES.DEVICE_POOL);
                const devices: DeviceSummary[] = rawDevices
                    .map(d => {
                        const tenantId = pool.findTenantIdForDevice(d.id) ?? d.tenant_id ?? null;
                        if (!tenantId) return null;
                        return { id: d.id, name: d.name || d.id, host: d.host || 'unknown', status: d.status, tenantId, reachable: false } as DeviceSummary;
                    })
                    .filter((d): d is DeviceSummary => d !== null);
                // 成功后重置失败计数和失明标志
                this._deviceFetchFailCount = 0;
                this._isDevicePerceptionDegraded = false;
                this._isSystemBlind = false;
                return {
                    devices,
                    pool,
                    managedDevices: devices,
                    isPerceptionDegraded: false
                };
            } catch (err) {
                const now = Date.now();
                // 🟡 FIX (Gemini audit): 5秒内只记一次失败，防止由于多个感知源并行调用导致的计数虚高
                if (now - this._lastDeviceFetchFailTime > 5000) {
                    this._deviceFetchFailCount++;
                    this._lastDeviceFetchFailTime = now;
                }

                // 🔴 FIX (Gemini audit): 启动时边界条件检查
                // 如果第一次抓取就失败且缓存为空，说明大脑处于“失明”状态，不应继续降级
                if (this._cachedManagedDevices.length === 0) {
                    const errorMsg = `[CRITICAL_PERCEPTION_FAILURE] Initial device list fetch failed and cache is empty. Brain is now in BLIND mode.`;
                    logger.error(errorMsg, { originalError: err instanceof Error ? err.message : String(err) });
                    this._isSystemBlind = true;
                    this._isDevicePerceptionDegraded = true;
                    return {
                        devices: [],
                        pool: null,
                        managedDevices: [],
                        isPerceptionDegraded: true,
                    };
                }

                // DeviceManager/DevicePool 不可用时降级到缓存引用，并记录告警
                logger.warn(
                    `[PerceptionCache Daemon] Failed to get latest devices from ServiceRegistry: ${err instanceof Error ? err.message : String(err)}. ` +
                    `Falling back to cached list (${this._cachedManagedDevices.length} devices). Cache may become stale. ` +
                    `Consecutive failures: ${this._deviceFetchFailCount}/${DEVICE_FETCH_FAIL_THRESHOLD}`
                );
                // 连续失败超过阈值时升级为系统告警
                if (this._deviceFetchFailCount >= DEVICE_FETCH_FAIL_THRESHOLD) {
                    const DEGRADATION_ALERT_COOLDOWN = 1000 * 60 * 60; // 1小时冷却
                    if (now - this._lastDegradationAlertTime > DEGRADATION_ALERT_COOLDOWN) {
                        try {
                            const { notificationService } = await import('../notificationService');
                            const channels = await notificationService.getChannels();
                            const enabledIds = channels.filter((c: any) => c.enabled).map((c: any) => c.id);
                            if (enabledIds.length > 0) {
                                await notificationService.send(enabledIds, {
                                    type: 'alert',
                                    title: '🚨 大脑感知层降级：DeviceManager 持续不可用',
                                    body: `感知缓存守护进程已连续 ${this._deviceFetchFailCount} 次无法从 DeviceManager 获取设备列表，当前使用 ${this._cachedManagedDevices.length} 台缓存设备数据（可能已过时）。请检查 DeviceManager 服务状态。`,
                                });
                                this._lastDegradationAlertTime = now;
                            }
                        } catch (notifyErr) {
                            logger.error(`[PerceptionCache Daemon] Failed to send degradation alert:`, notifyErr);
                        }
                    }
                    // 🟡 FIX (Gemini audit): 不再清空缓存，而是标记降级，防止大脑认知坍塌
                    this._isDevicePerceptionDegraded = true;
                }
                // 🟡 FIX: 注入感知降级状态
                return {
                    devices: this._cachedManagedDevices,
                    pool: this._cachedPool,
                    managedDevices: this._cachedManagedDevices,
                    isPerceptionDegraded: this._isDevicePerceptionDegraded,
                };
            }
        };
        // 感知源 1: 系统健康指标
        perceptionCache.registerSource('healthMonitor', async () => {
            const { devices, pool } = await getLatestDevices();
            if (devices.length > 0 && pool) {
                const results = await parallelCollectWithLimit(
                    devices,
                    async (device) => {
                        const client = await pool!.getConnection(device.tenantId, device.id);
                        return healthMonitor.collectMetrics(client);
                    },
                    10
                );
                let totalCpu = 0, totalMem = 0, totalDisk = 0, count = 0;
                for (const r of results) {
                    if (r.status === 'fulfilled') {
                        totalCpu += r.value.cpuUsage;
                        totalMem += r.value.memoryUsage;
                        totalDisk += r.value.diskUsage;
                        count++;
                    }
                }
                return {
                    cpuUsage: count > 0 ? totalCpu / count : -1,
                    memoryUsage: count > 0 ? totalMem / count : -1,
                    diskUsage: count > 0 ? totalDisk / count : -1,
                    uptime: process.uptime(),
                    interfaces: [],
                };
            }
            return healthMonitor.collectMetrics();
        });

        // 感知源 2: 活跃告警
        perceptionCache.registerSource('alertEngine', async () => {
            const { devices } = await getLatestDevices();
            if (devices.length > 0) {
                const results = await parallelCollectWithLimit(
                    devices,
                    async (device) => alertEngine.getActiveAlerts(device.id),
                    10
                );
                const alerts: unknown[] = [];
                for (const r of results) {
                    if (r.status === 'fulfilled') alerts.push(...r.value);
                }
                const global = await alertEngine.getActiveAlerts();
                const ids = new Set(alerts.map((a: any) => a.id));
                for (const g of global) { if (!ids.has(g.id)) alerts.push(g); }
                return alerts;
            }
            return alertEngine.getActiveAlerts();
        });

        // 感知源 3: 待决决策
        perceptionCache.registerSource('decisionEngine', async () => {
            const recent = await decisionEngine.getDecisionHistory(undefined, 50);
            return recent.filter(d => !d.executed).slice(0, 10).map(d => ({
                decisionId: d.id, alertId: d.alertId, action: d.action, reasoning: d.reasoning,
            }));
        });

        // 感知源 4: 异常预测
        perceptionCache.registerSource('anomalyPredictor', async () => {
            const preds = await anomalyPredictor.predict();
            return preds.map(p => ({
                type: p.type, confidence: p.confidence, predictedValue: p.predictedValue,
                threshold: p.threshold, trend: p.trend, suggestedActions: p.suggestedActions || [],
            }));
        });

        // 感知源 5: 拓扑图谱
        perceptionCache.registerSource('knowledgeGraph', async () => {
            const topo = knowledgeGraphBuilder.discoverTopology();
            const freshnessMs = Date.now() - topo.lastUpdated;
            const freshLabel = freshnessMs > 30000 ? '⚠️ STALE' : '✅ FRESH';
            return {
                summary: `${freshLabel} (age: ${freshnessMs}ms): Nodes: ${topo.nodes.length}, Edges: ${topo.edges.length}, Version: ${topo.version}`,
                freshnessMs,
            };
        });

        // 感知源 6: 操作模式
        perceptionCache.registerSource('patternLearner', async () => {
            const all = patternLearner.getAllPatterns();
            const patterns: BrainTickContext['detectedPatterns'] = [];
            all.forEach(ps => {
                for (const p of ps) {
                    patterns.push({ id: p.id, type: p.type, sequence: p.sequence, frequency: p.frequency, confidence: p.confidence });
                }
            });
            patterns.sort((a, b) => b.confidence - a.confidence);
            return patterns.slice(0, 10);
        });

        logger.info('[Brain] Registered 6 perception sources with PerceptionCache daemon.');
    }

    /**
     * 步骤 1: OODA 之 Observe，汇聚系统各项关键指标
     * P4 修复: 接入 healthMonitor 获取真实系统指标
     * P5 修复: 接入 decisionEngine 获取待决决策
     */
    private async gatherContext(tickId: string, trigger: 'schedule' | 'critical_alert' | 'decision_pending' | 'manual'): Promise<BrainTickContext> {
        // P2 FIX: 感知源健康度追踪 — 让大脑知道自己是否"瞎了"
        const perceptionHealth: { source: string; ok: boolean; error?: string; durationMs?: number; degraded?: boolean }[] = [];

        // 多设备感知：发现所有受管设备
        // 🔴 FIX: Brain 是全局指挥中心，需要看到所有租户的设备
        // 使用特殊标记 '*' 查询所有租户的设备，并明确授权跨租户访问
        let managedDevices: DeviceSummary[] = [];
        // 🔴 FIX: 提升到外层作用域，供 managedDevices 构建和后续 collectHealthMonitor 共用
        let poolForTenantLookup: import('../../device/devicePool').DevicePool | null = null;
        try {
            const deviceManager = await serviceRegistry.getAsync<{ getDevices(tenantId: string, filter?: any, options?: { allowCrossTenant?: boolean }): Promise<Device[]> }>(SERVICE_NAMES.DEVICE_MANAGER);
            // 🔴 FIX (Gemini audit): 明确授权跨租户查询，防止权限提升漏洞
            const devices = await deviceManager.getDevices('*', undefined, { allowCrossTenant: true });

            // 🔴 FIX: 展示所有设备给 LLM（不再按 status 过滤）
            // 之前只保留 online/connecting，offline 设备被完全隐藏，导致 TOCTOU 竞态：
            //   - 感知阶段设备 offline → managedDevices=[] → prompt 告诉 LLM "单设备模式，不需要 deviceId"
            //   - LLM 思考期间设备上线 → execute_intent 校验发现有设备但没传 deviceId → 拒绝
            // 修复：所有设备都进入 managedDevices，连通性探测标记 reachable/unreachable，
            // prompt 用 ✅/❌ 标记，directive 10 指示 LLM 不对 ❌ 设备调用 execute_intent
            const availableDevices = devices;

            // 🔴 FIX: tenantId 消失根本原因修复
            // d.tenant_id 可能是 undefined（数据库字段缺失），JSON 序列化后消失，LLM 看不到 tenantId
            // 修复策略：优先从 DevicePool 连接映射查找真实 tenantId（连接建立时用的 tenantId 一定正确），
            // fallback 到 d.tenant_id，最后 fallback 到 'default'（兜底，避免字段消失）
            // 提前获取 pool 用于 tenantId 补全（pool 可能还未初始化，用 try/catch 保护）
            try {
                const { DevicePool } = await import('../../device/devicePool');
                poolForTenantLookup = await serviceRegistry.getAsync<InstanceType<typeof DevicePool>>(SERVICE_NAMES.DEVICE_POOL);
            } catch { /* pool 不可用时降级 */ }

            const rawSummaries = availableDevices.map((d) => {
                // tenantId 解析优先级：
                // 1. DevicePool 连接映射（连接建立时用的 tenantId 一定正确）
                // 2. 数据库 tenant_id 字段（createDevice 时写入，应该是正确的）
                // 3. 不 fallback 到 'default'——'default' 是错误的兜底，会导致 TENANT_ID_MISMATCH
                //    如果两个来源都没有，记录 error 并跳过该设备（宁可不展示，也不展示错误的 tenantId）
                const poolTenantId = poolForTenantLookup?.findTenantIdForDevice(d.id) ?? null;
                const resolvedTenantId = poolTenantId || d.tenant_id || null;
                if (!resolvedTenantId) {
                    logger.error(`[Brain] ⛔ 设备 ${d.id} (${d.name}) 的 tenantId 无法确定：DevicePool 无连接且数据库 tenant_id 为空。该设备将被排除在 Managed Devices 列表之外，避免 LLM 使用错误的 tenantId。请检查数据库中该设备的 tenant_id 字段。`);
                    return null;
                }
                if (!d.tenant_id && poolTenantId) {
                    logger.debug(`[Brain] tenantId补全: device=${d.id} tenant_id=undefined → 从DevicePool补全为 "${poolTenantId}"`);
                }
                return {
                    id: d.id,
                    name: d.name || d.id,
                    host: d.host || 'unknown',
                    status: d.status,
                    tenantId: resolvedTenantId,
                    reachable: false,
                } as DeviceSummary;
            });
            managedDevices = rawSummaries.filter((d): d is DeviceSummary => d !== null);
            perceptionHealth.push({ source: 'deviceManager', ok: true });
            // 更新守护进程缓存引用（供 _registerPerceptionSources 中的感知源采集函数使用）
            this._cachedManagedDevices = managedDevices;
            this._cachedPool = poolForTenantLookup;
            const onlineCount = managedDevices.filter(d => d.status === 'online' || d.status === 'connecting').length;
            logger.debug(`[Brain Tick ${tickId}] Discovered ${managedDevices.length} devices (${onlineCount} online/connecting) across all tenants.`);

            // 如果所有设备都不可用，记录警告但不阻断 tick（Brain 可以使用其他工具如 send_notification）
            if (managedDevices.length > 0 && onlineCount === 0) {
                logger.warn(`[Brain Tick ${tickId}] ⚠️ All ${managedDevices.length} devices are offline/error. Brain should use send_notification instead of execute_intent.`);
                perceptionHealth.push({ source: 'deviceAvailability', ok: false, error: `All ${managedDevices.length} devices offline/error` });
            }
        } catch (err) {
            logger.debug(`[Brain Tick ${tickId}] DeviceManager not available, using single-device mode.`, { error: err });
            perceptionHealth.push({ source: 'deviceManager', ok: false, error: String(err) });
            // 单设备模式：不阻断，继续使用全局 routerosClient
        }

        // ── 连通性探测：对每台受管设备做 tick 级别的可达性快照 ──────────────────
        // 目的：给 LLM 提供准确的设备可达性信息，让它自己决定是否调用 execute_intent
        // 探测策略：优先复用 DevicePool 已有连接（零开销），无连接时尝试建立（带重试）
        // 结果写回 managedDevices[].reachable，不影响其他感知源的并行采集
        if (managedDevices.length > 0 && poolForTenantLookup) {
            const PROBE_TIMEOUT_MS = 5000;
            const PROBE_MAX_RETRIES = 2;

            const probeResults = await parallelCollectWithLimit(
                managedDevices,
                async (device) => {
                    let lastError = '';
                    for (let attempt = 0; attempt <= PROBE_MAX_RETRIES; attempt++) {
                        try {
                            // getConnection 内部：有活跃连接直接复用，无连接则尝试建立
                            await withTimeout(
                                poolForTenantLookup!.getConnection(device.tenantId, device.id),
                                PROBE_TIMEOUT_MS,
                                `probe-${device.id}`
                            );
                            return { deviceId: device.id, reachable: true };
                        } catch (err) {
                            lastError = err instanceof Error ? err.message : String(err);
                            if (attempt < PROBE_MAX_RETRIES) {
                                logger.debug(`[Brain Tick ${tickId}] Device ${device.id} probe attempt ${attempt + 1} failed: ${lastError}. Retrying...`);
                            }
                        }
                    }
                    return { deviceId: device.id, reachable: false, reason: lastError };
                },
                10
            );

            // 将探测结果写回 managedDevices
            const probeMap = new Map<string, { reachable: boolean; reason?: string }>();
            for (const r of probeResults) {
                if (r.status === 'fulfilled') {
                    probeMap.set(r.value.deviceId, { reachable: r.value.reachable, reason: r.value.reason });
                }
            }
            managedDevices = managedDevices.map(d => ({
                ...d,
                reachable: probeMap.get(d.id)?.reachable ?? false,
                unreachableReason: probeMap.get(d.id)?.reason,
            }));

            const reachableCount = managedDevices.filter(d => d.reachable).length;
            logger.info(`[Brain Tick ${tickId}] Connectivity probe: ${reachableCount}/${managedDevices.length} devices reachable.`);
            perceptionHealth.push({
                source: 'connectivityProbe',
                ok: reachableCount > 0,
                error: reachableCount === 0 ? 'All devices unreachable' : undefined,
            });
        }

        // ── 并行采集 6 个独立感知源（需求 2.1 / 4.1 / 4.2）──────────────────────
        // 每个源包装 withTimeout(5000ms)，Promise.allSettled 保证任一失败不阻断其他源

        // 预先获取 DevicePool（供 healthMonitor 多设备采集使用）
        // 修复：条件从 > 1 改为 > 0，确保单台受管设备也能通过 DevicePool 获取正确客户端
        // 🔴 FIX: 复用 poolForTenantLookup（已在 managedDevices 构建时获取，同一单例）
        const pool: import('../../device/devicePool').DevicePool | null = poolForTenantLookup;
        // 定义 6 个感知源的采集 lambda
        const collectHealthMonitor = async (): Promise<SystemHealthSummary> => {
            // 修复：条件从 > 1 改为 > 0，确保单台受管设备也通过 DevicePool 采集
            // 只有在无受管设备（length === 0）时才回退到全局 routerosClient
            if (managedDevices.length > 0 && pool) {
                // 5.2: 多设备健康指标并行采集（parallelCollectWithLimit）
                const metricsResults = await parallelCollectWithLimit(
                    managedDevices,
                    async (device) => {
                        const deviceClient = await pool.getConnection(device.tenantId || 'default', device.id);
                        return { device, metrics: await healthMonitor.collectMetrics(deviceClient) };
                    },
                    10
                );
                const allInterfaces: SystemHealthSummary['interfaces'] = [];
                const allIssues = new Set<string>();
                const aggregatedDimensions = { system: 0, network: 0, performance: 0, reliability: 0 };
                let totalCpu = 0, totalMem = 0, totalDisk = 0, totalScore = 0, deviceCount = 0;
                for (const r of metricsResults) {
                    if (r.status === 'fulfilled') {
                        const { device, metrics } = r.value;
                        totalCpu += metrics.cpuUsage;
                        totalMem += metrics.memoryUsage;
                        totalDisk += metrics.diskUsage;
                        deviceCount++;
                        if (metrics.interfaceStatus && metrics.interfaceStatus.total > 0) {
                            allInterfaces.push({
                                name: `${device.name} (${metrics.interfaceStatus.total} ifaces)`,
                                status: metrics.interfaceStatus.down > 0 ? 'down' : 'up',
                                rxBytes: 0, txBytes: 0,
                                errors: metrics.interfaceStatus.down,
                            });
                        }
                        // 累加分数以计算平均值
                        const latestSnapshot = await healthMonitor.getLatestHealth(device.id);
                        if (latestSnapshot) {
                            totalScore += latestSnapshot.score;
                            (latestSnapshot.issues || []).forEach(issue => allIssues.add(issue));
                            if (latestSnapshot.dimensions) {
                                aggregatedDimensions.system += latestSnapshot.dimensions.system;
                                aggregatedDimensions.network += latestSnapshot.dimensions.network;
                                aggregatedDimensions.performance += latestSnapshot.dimensions.performance;
                                aggregatedDimensions.reliability += latestSnapshot.dimensions.reliability;
                            }
                        } else {
                            totalScore += 100;
                        }
                    } else {
                        const device = managedDevices[metricsResults.indexOf(r)];
                        logger.debug(`[Brain Tick ${tickId}] Failed to collect metrics for device ${device?.id}`, { error: r.reason });
                        allInterfaces.push({
                            name: `${device?.name ?? 'unknown'} (UNREACHABLE)`,
                            status: 'down', rxBytes: 0, txBytes: 0, errors: 1,
                        });
                    }
                }
                const avgScore = deviceCount > 0 ? Math.round(totalScore / deviceCount) : -1;

                // 计算平均维度得分
                if (deviceCount > 0) {
                    aggregatedDimensions.system = Math.round(aggregatedDimensions.system / deviceCount);
                    aggregatedDimensions.network = Math.round(aggregatedDimensions.network / deviceCount);
                    aggregatedDimensions.performance = Math.round(aggregatedDimensions.performance / deviceCount);
                    aggregatedDimensions.reliability = Math.round(aggregatedDimensions.reliability / deviceCount);
                }

                return {
                    cpuUsage: deviceCount > 0 ? totalCpu / deviceCount : -1,
                    memoryUsage: deviceCount > 0 ? totalMem / deviceCount : -1,
                    diskUsage: deviceCount > 0 ? totalDisk / deviceCount : -1,
                    uptime: process.uptime(),
                    interfaces: allInterfaces,
                    score: avgScore,
                    level: avgScore < 60 ? 'critical' : avgScore < 85 ? 'warning' : 'healthy',
                    issues: Array.from(allIssues),
                    dimensions: aggregatedDimensions,
                };
            } else {
                // 单设备模式
                const metrics = await healthMonitor.collectMetrics();
                const latestSnapshot = await healthMonitor.getLatestHealth();
                const interfaces: SystemHealthSummary['interfaces'] = [];
                if (metrics.interfaceStatus && metrics.interfaceStatus.total > 0) {
                    interfaces.push({
                        name: `summary (${metrics.interfaceStatus.total} total)`,
                        status: metrics.interfaceStatus.down > 0 ? 'down' : 'up',
                        rxBytes: 0, txBytes: 0,
                        errors: metrics.interfaceStatus.down,
                    });
                }
                return {
                    cpuUsage: metrics.cpuUsage,
                    memoryUsage: metrics.memoryUsage,
                    diskUsage: metrics.diskUsage,
                    uptime: process.uptime(),
                    interfaces,
                    score: latestSnapshot ? latestSnapshot.score : 100,
                    level: latestSnapshot ? latestSnapshot.level : 'healthy',
                };
            }
        };

        const collectAlertEngine = async (): Promise<any[]> => {
            // 构建当前有效设备 ID 集合，用于过滤孤儿告警
            const validDeviceIds = new Set(managedDevices.map(d => d.id));

            let collected: any[];

            // 修复：条件从 > 1 改为 > 0，与 collectHealthMonitor 保持一致
            if (managedDevices.length > 0) {
                // 5.2: 多设备告警并行采集（parallelCollectWithLimit）
                const alertResults = await parallelCollectWithLimit(
                    managedDevices,
                    async (device) => alertEngine.getActiveAlerts(device.id),
                    10
                );
                collected = [];
                for (let i = 0; i < alertResults.length; i++) {
                    const r = alertResults[i];
                    if (r.status === 'fulfilled') {
                        collected.push(...r.value);
                    } else {
                        logger.warn(`[Brain Tick ${tickId}] Failed to fetch alerts for device ${managedDevices[i]?.id}`, { error: r.reason });
                    }
                }
                // 合并全局告警并去重
                const globalAlerts = await alertEngine.getActiveAlerts();
                const existingIds = new Set(collected.map((a: any) => a.id));
                for (const ga of globalAlerts) {
                    if (!existingIds.has(ga.id)) collected.push(ga);
                }
            } else {
                collected = await alertEngine.getActiveAlerts();
            }

            // 过滤孤儿告警：deviceId 存在但不属于任何当前受管设备
            // 场景：设备被删除/重建后 UUID 变了，但旧告警仍残留在缓存中
            // 仅在多设备模式下生效：managedDevices 为空时（真正的单设备模式或 deviceManager 故障），
            // validDeviceIds 是空 Set，会误杀所有带 deviceId 的告警，导致 Brain 丢失关键信息
            let filtered = collected;
            if (managedDevices.length > 0) {
                filtered = collected.filter((a: any) => {
                    if (!a.deviceId) return true; // 无 deviceId 的告警保留，Brain 可自行判断
                    return validDeviceIds.has(a.deviceId);
                });
                const orphaned = collected.length - filtered.length;
                if (orphaned > 0) {
                    logger.warn(`[Brain Tick ${tickId}] Filtered ${orphaned} orphan alert(s) with stale deviceId not matching any managed device`);
                }
            }
            return filtered;
        };

        const collectDecisionEngine = async (): Promise<BrainTickContext['pendingDecisions']> => {
            const recentDecisions = await decisionEngine.getDecisionHistory(undefined, 50);
            return recentDecisions
                .filter(d => !d.executed)
                .slice(0, 10)
                .map(d => ({
                    decisionId: d.id,
                    alertId: d.alertId,
                    action: d.action,
                    reasoning: d.reasoning,
                }));
        };

        const collectAnomalyPredictor = async (): Promise<BrainTickContext['anomalyPredictions']> => {
            const predictions = await anomalyPredictor.predict();
            return predictions.map(p => ({
                type: p.type,
                confidence: p.confidence,
                predictedValue: p.predictedValue,
                threshold: p.threshold,
                trend: p.trend,
                suggestedActions: p.suggestedActions || [],
            }));
        };

        const collectKnowledgeGraph = async (): Promise<{ summary: string; freshnessMs: number }> => {
            const topo = knowledgeGraphBuilder.discoverTopology();
            const freshnessMs = Date.now() - topo.lastUpdated;
            const freshLabel = freshnessMs > 30000 ? '⚠️ STALE' : '✅ FRESH';
            return {
                summary: `${freshLabel} (age: ${freshnessMs}ms): Nodes: ${topo.nodes.length}, Edges: ${topo.edges.length}, Version: ${topo.version}`,
                freshnessMs,
            };
        };

        const collectPatternLearner = async (): Promise<BrainTickContext['detectedPatterns']> => {
            const allPatterns = patternLearner.getAllPatterns();
            const patterns: BrainTickContext['detectedPatterns'] = [];
            allPatterns.forEach((ps) => {
                for (const p of ps) {
                    patterns.push({ id: p.id, type: p.type, sequence: p.sequence, frequency: p.frequency, confidence: p.confidence });
                }
            });
            patterns.sort((a, b) => b.confidence - a.confidence);
            return patterns.slice(0, 10);
        };

        // ── 感知缓存集成（需求 2.3, 2.4, 2.5）──────────────────────────────────
        // schedule 触发且缓存新鲜 → 直接从缓存读取，跳过实时采集（OBSERVE 阶段从 ~5s 降至 <100ms）
        // critical_alert 触发 → 告警相关感知源（alertEngine）强制实时采集，其他可用缓存
        // 缓存不新鲜 → 回退到实时采集（现有逻辑）
        const isCacheSchedule = trigger === 'schedule';
        const isCriticalAlert = trigger === 'critical_alert';

        // 辅助：从缓存读取并包装为 timed 结果格式
        const fromCache = <T>(source: string): { value: T; durationMs: number } | null => {
            if (!perceptionCache.isFresh(source)) return null;
            const entry = perceptionCache.get<T>(source);
            if (!entry) return null;
            return { value: entry.data, durationMs: 0 };
        };

        // 4.2: Promise.allSettled 并行执行 6 个感知源，每个包装 5s 超时并独立计时
        const t0 = Date.now();
        // 用 timed 包装器记录每个感知源的实际耗时
        const timed = <T>(promise: Promise<T>): Promise<{ value: T; durationMs: number }> => {
            const start = Date.now();
            return promise.then(
                value => ({ value, durationMs: Date.now() - start }),
                err => Promise.reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { _durationMs: Date.now() - start }))
            );
        };

        // 对每个感知源决定：读缓存 or 实时采集
        // schedule 触发：所有源优先读缓存
        // critical_alert 触发：alertEngine 强制实时，其他读缓存
        // 其他触发（manual/decision_pending）：全部实时采集
        const resolveSource = <T>(
            source: string,
            collector: () => Promise<T>,
            forceRealtime = false,
        ): Promise<{ value: T; durationMs: number }> => {
            if (!forceRealtime && (isCacheSchedule || isCriticalAlert)) {
                const cached = fromCache<T>(source);
                if (cached) {
                    logger.debug(`[Brain Tick ${tickId}] Cache HIT for ${source} (trigger=${trigger})`);
                    return Promise.resolve(cached);
                }
            }
            return timed(withTimeout(collector(), 5000, source));
        };

        const [
            healthMonitorResult,
            alertEngineResult,
            decisionEngineResult,
            anomalyPredictorResult,
            knowledgeGraphResult,
            patternLearnerResult,
        ] = await Promise.allSettled([
            resolveSource('healthMonitor', collectHealthMonitor),
            // critical_alert 时强制实时采集告警源，确保告警数据最新
            resolveSource('alertEngine', collectAlertEngine, isCriticalAlert),
            resolveSource('decisionEngine', collectDecisionEngine),
            resolveSource('anomalyPredictor', collectAnomalyPredictor),
            resolveSource('knowledgeGraph', collectKnowledgeGraph),
            resolveSource('patternLearner', collectPatternLearner),
        ]);
        const parallelDurationMs = Date.now() - t0;
        logger.debug(`[Brain Tick ${tickId}] Parallel perception completed in ${parallelDurationMs}ms`);

        // 处理 healthMonitor 结果
        let systemHealth: SystemHealthSummary;
        if (healthMonitorResult.status === 'fulfilled') {
            systemHealth = healthMonitorResult.value.value;
            perceptionHealth.push({ source: 'healthMonitor', ok: true, durationMs: healthMonitorResult.value.durationMs });
        } else {
            const isTimeout = String(healthMonitorResult.reason).includes('超时');
            logger.warn(`[Brain Tick ${tickId}] Failed to collect real health metrics, using fallback.`, { error: healthMonitorResult.reason });
            systemHealth = { cpuUsage: -1, memoryUsage: -1, diskUsage: -1, uptime: process.uptime(), interfaces: [], score: -1, level: 'unknown' };
            perceptionHealth.push({ source: 'healthMonitor', ok: false, error: String(healthMonitorResult.reason), durationMs: (healthMonitorResult.reason as any)?._durationMs, degraded: isTimeout });
        }

        // 处理 alertEngine 结果
        let activeAlerts: any[] = [];
        if (alertEngineResult.status === 'fulfilled') {
            activeAlerts = alertEngineResult.value.value;
            perceptionHealth.push({ source: 'alertEngine', ok: true, durationMs: alertEngineResult.value.durationMs });
        } else {
            const isTimeout = String(alertEngineResult.reason).includes('超时');
            logger.warn(`[Brain Tick ${tickId}] Failed to fetch active alerts.`, { error: alertEngineResult.reason });
            perceptionHealth.push({ source: 'alertEngine', ok: false, error: String(alertEngineResult.reason), durationMs: (alertEngineResult.reason as any)?._durationMs, degraded: isTimeout });
        }

        // 处理 decisionEngine 结果
        let pendingDecisions: BrainTickContext['pendingDecisions'] = [];
        if (decisionEngineResult.status === 'fulfilled') {
            pendingDecisions = decisionEngineResult.value.value;
            perceptionHealth.push({ source: 'decisionEngine', ok: true, durationMs: decisionEngineResult.value.durationMs });
        } else {
            const isTimeout = String(decisionEngineResult.reason).includes('超时');
            logger.warn(`[Brain Tick ${tickId}] Failed to fetch pending decisions.`, { error: decisionEngineResult.reason });
            perceptionHealth.push({ source: 'decisionEngine', ok: false, error: String(decisionEngineResult.reason), durationMs: (decisionEngineResult.reason as any)?._durationMs, degraded: isTimeout });
        }

        // 处理 anomalyPredictor 结果
        let anomalyPredictions: BrainTickContext['anomalyPredictions'] = [];
        if (anomalyPredictorResult.status === 'fulfilled') {
            anomalyPredictions = anomalyPredictorResult.value.value;
            perceptionHealth.push({ source: 'anomalyPredictor', ok: true, durationMs: anomalyPredictorResult.value.durationMs });
        } else {
            const isTimeout = String(anomalyPredictorResult.reason).includes('超时');
            logger.warn(`[Brain Tick ${tickId}] Failed to get anomaly predictions.`, { error: anomalyPredictorResult.reason });
            perceptionHealth.push({ source: 'anomalyPredictor', ok: false, error: String(anomalyPredictorResult.reason), durationMs: (anomalyPredictorResult.reason as any)?._durationMs, degraded: isTimeout });
        }

        // 处理 knowledgeGraph 结果
        let topologySummary = '';
        let topologyFreshnessMs = -1;
        if (knowledgeGraphResult.status === 'fulfilled') {
            topologySummary = knowledgeGraphResult.value.value.summary;
            topologyFreshnessMs = knowledgeGraphResult.value.value.freshnessMs;
            perceptionHealth.push({ source: 'knowledgeGraph', ok: true, durationMs: knowledgeGraphResult.value.durationMs });
        } else {
            const isTimeout = String(knowledgeGraphResult.reason).includes('超时');
            logger.warn(`[Brain Tick ${tickId}] Failed to discover topology.`, { error: knowledgeGraphResult.reason });
            perceptionHealth.push({ source: 'knowledgeGraph', ok: false, error: String(knowledgeGraphResult.reason), durationMs: (knowledgeGraphResult.reason as any)?._durationMs, degraded: isTimeout });
        }

        // 处理 patternLearner 结果
        let detectedPatterns: BrainTickContext['detectedPatterns'] = [];
        if (patternLearnerResult.status === 'fulfilled') {
            detectedPatterns = patternLearnerResult.value.value;
            perceptionHealth.push({ source: 'patternLearner', ok: true, durationMs: patternLearnerResult.value.durationMs });
        } else {
            const isTimeout = String(patternLearnerResult.reason).includes('超时');
            logger.warn(`[Brain Tick ${tickId}] Failed to get detected patterns.`, { error: patternLearnerResult.reason });
            perceptionHealth.push({ source: 'patternLearner', ok: false, error: String(patternLearnerResult.reason), durationMs: (patternLearnerResult.reason as any)?._durationMs, degraded: isTimeout });
        }

        // P2 FIX: 计算感知健康度摘要
        const failedSources = perceptionHealth.filter(p => !p.ok);
        const perceptionSummary = failedSources.length === 0
            ? `✅ ALL SENSORS OPERATIONAL (${perceptionHealth.length}/${perceptionHealth.length})`
            : `⚠️ DEGRADED: ${failedSources.length}/${perceptionHealth.length} sensors failed [${failedSources.map(f => f.source).join(', ')}]. Data may be incomplete — DO NOT assume "all clear".`;

        return {
            tickId,
            timestamp: Date.now(),
            trigger,
            managedDevices,
            systemHealth,
            activeAlerts,
            pendingDecisions,
            anomalyPredictions,
            topologySummary,
            topologyFreshnessMs,
            detectedPatterns,
            recentEvolutionEvents: (() => {
                // P1 FIX: 从进化子模块收集近期状态摘要（各模块无事件流 API，使用统计快照）
                const events: BrainTickContext['recentEvolutionEvents'] = [];
                try {
                    const plStats = patternLearner.getStats();
                    events.push({
                        source: 'PatternLearner',
                        event: `Patterns: ${plStats.totalPatterns}, Operations: ${plStats.totalOperations}, Users: ${plStats.totalUsers}`,
                        status: plStats.totalPatterns > 0 ? 'active' : 'idle',
                        timestamp: Date.now(),
                    });
                } catch { /* non-critical */ }
                try {
                    const allPatterns = patternLearner.getAllPatterns();
                    let recentCount = 0;
                    allPatterns.forEach(patterns => { recentCount += patterns.length; });
                    if (recentCount > 0) {
                        events.push({
                            source: 'PatternLearner',
                            event: `${recentCount} active patterns detected across all users`,
                            status: 'detected',
                            timestamp: Date.now(),
                        });
                    }
                } catch { /* non-critical */ }
                // P2 FIX: 补充 AnomalyPredictor 状态
                try {
                    if (anomalyPredictions.length > 0) {
                        const highConf = anomalyPredictions.filter(p => p.confidence > 0.7);
                        events.push({
                            source: 'Reflector' as const,
                            event: `AnomalyPredictor: ${anomalyPredictions.length} predictions (${highConf.length} high-confidence)`,
                            status: highConf.length > 0 ? 'warning' : 'normal',
                            timestamp: Date.now(),
                        });
                    }
                } catch { /* non-critical */ }
                // P2 FIX: 补充 ContinuousLearner 状态
                try {
                    const clRunning = continuousLearner.isRunning();
                    const runningCount = [clRunning.patternLearning, clRunning.strategyEval, clRunning.knowledgeGraph].filter(Boolean).length;
                    events.push({
                        source: 'Healer' as const,
                        event: `ContinuousLearner: ${runningCount}/3 timers active (pattern: ${clRunning.patternLearning}, strategy: ${clRunning.strategyEval}, kg: ${clRunning.knowledgeGraph})`,
                        status: runningCount > 0 ? 'active' : 'idle',
                        timestamp: Date.now(),
                    });
                } catch { /* non-critical */ }
                return events;
            })(),
            perceptionSummary,
        };
    }

    /**
     * 动态获取已注册且启用的 Skill 列表，用于注入 Brain prompt。
     * 使用延迟 require 避免循环依赖（skillManager → ... → autonomousBrainService）。
     */
    private getAvailableSkillsLine(): string {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { skillManager } = require('../skill/skillManager') as { skillManager: { listSkills(filter?: { enabled?: boolean }): Array<{ metadata: { name: string; description?: string } }> } };
            const skills = skillManager.listSkills({ enabled: true });
            if (skills.length === 0) {
                return 'Available specialists: (no skills registered)';
            }
            const list = skills.map(s => `${s.metadata.name}${s.metadata.description ? ': ' + s.metadata.description : ''}`).join('; ');
            // 🔴 FIX 1.9: 增加设备指导
            return `Available specialists (${skills.length}): ${list}\n    NOTE: If a skill needs to operate on a device, specify deviceName or ip in invoke_skill parameters.`;
        } catch (err) {
            logger.warn('Failed to load dynamic skill list for Brain prompt', err);
            this.pushNote('CRITICAL_SUBSYSTEM_FAILURE: SkillManager is unavailable. invoke_skill tool will not work this tick.', 'internal-error');
            return 'Available specialists: (skill list unavailable - SUBSYSTEM OFFLINE)';
        }
    }

    /**
     * 根据触发场景和告警内容，映射出应注入的意图类别
     * 场景→类别映射规则（需求 1.2, 1.3, 1.4）
     */
    private _resolveIntentCategories(context: BrainTickContext): IntentCategory[] {
        const { trigger, activeAlerts } = context;

        // manual 触发：注入全部类别，不限制
        if (trigger === 'manual') {
            return ['network_query', 'firewall_ops', 'system_config', 'system_danger', 'dhcp_dns', 'monitoring', 'routing'];
        }

        // critical_alert 触发：🔴 FIX 1.8 累加式匹配，根据告警内容细化类别
        if (trigger === 'critical_alert') {
            const alertText = JSON.stringify(activeAlerts).toLowerCase();
            const cats = new Set<IntentCategory>(['monitoring']); // 始终包含基础类别

            if (/firewall|filter|nat|rule|block|drop|reject|address.list/.test(alertText)) {
                cats.add('firewall_ops');
                cats.add('network_query');
            }
            if (/interface|ether|wlan|bridge|vlan|link.down|port/.test(alertText)) {
                cats.add('network_query');
                cats.add('system_config');
            }
            if (/dhcp|dns|lease|pool/.test(alertText)) {
                cats.add('dhcp_dns');
                cats.add('network_query');
            }
            if (/route|gateway|bgp|ospf/.test(alertText)) {
                cats.add('routing');
                cats.add('network_query');
            }

            // 如果没有任何正则匹配（仅有基础 monitoring），返回默认集合
            if (cats.size <= 1) {
                return ['network_query', 'monitoring', 'system_config'];
            }

            return Array.from(cats);
        }

        // decision_pending：根据待决决策类型动态选择
        if (trigger === 'decision_pending') {
            const decisionText = JSON.stringify(context.pendingDecisions).toLowerCase();
            const cats: IntentCategory[] = ['network_query', 'monitoring'];
            if (/firewall|nat|rule/.test(decisionText)) cats.push('firewall_ops');
            if (/route|gateway/.test(decisionText)) cats.push('routing');
            if (/dhcp|dns/.test(decisionText)) cats.push('dhcp_dns');
            if (/interface|port/.test(decisionText)) cats.push('system_config');
            return cats;
        }

        // schedule（无活跃告警）：🔴 FIX 1.7 扩展基础类别，加入 system_config
        return ['monitoring', 'network_query', 'system_config'];
    }

    /** 返回当前场景注入的类别标签（用于 Prompt 说明） */
    private _buildIntentCategoryLabel(context: BrainTickContext): string {
        const cats = this._resolveIntentCategories(context);
        return cats.join(', ');
    }

    /** 生成按场景过滤后的意图摘要（需求 1.2, 1.8） */
    private _buildFilteredIntentSummary(context: BrainTickContext, categories?: IntentCategory[]): string {
        const cats = categories || this._resolveIntentCategories(context);
        // 🔴 FIX 1.5: 副作用已移到 tick() 中 buildPrompt 之前执行
        // 此方法现在是纯函数，不再调用 setCurrentInjectedCategories 和 updateDeviceRequirement
        const summary = getIntentSummaryForPromptFiltered(cats);
        // 降级保护：如果过滤后为空，回退到全量注入
        if (!summary.trim()) {
            return getIntentSummaryForPrompt();
        }
        return summary;
    }

    /**
     * 步骤 2: OODA 之 Orient，构建大模型所需的系统提示词和上下文
     */
    private buildPrompt(context: BrainTickContext, currentNotes: string[], tickDeviceId?: string): string {
        const config = getEvolutionConfig().autonomousBrain;

        // 构建可变区段内容
        let observedStateContent = `Perception Health: ${context.perceptionSummary || 'UNKNOWN'}
Managed Devices (${context.managedDevices.length} total, ${context.managedDevices.filter(d => d.reachable).length} reachable):
${context.managedDevices.length > 0
                ? context.managedDevices.map(d => {
                    const label = d.name === d.host ? d.name : `${d.name} (${d.host})`;
                    return d.reachable
                        ? `  [✅ REACHABLE] Device: ${label}`
                        : `  [❌ UNREACHABLE] Device: ${label}${d.unreachableReason ? ` reason="${d.unreachableReason}"` : ''}`;
                }).join('\n')
                : '  (no managed devices — single-device mode, using default connection)'}
System Health: ${JSON.stringify(context.systemHealth)}
Active Alerts (${context.activeAlerts.length}): ${compressAlerts(context.activeAlerts)}
Pending Human Decisions (${context.pendingDecisions.length}): ${JSON.stringify(context.pendingDecisions)}
Short-Term Memory Notes (new since last tick): ${currentNotes.length > 0 ? JSON.stringify(currentNotes) : '(no new events)'}
Ongoing Investigations (${this.memory.ongoingInvestigations.length} tracked alerts): ${this.memory.ongoingInvestigations.length > 0 ? JSON.stringify(this.memory.ongoingInvestigations.slice(0, 20)) : '(none)'}
Episodic Memory (${this.memory.episodicMemory.length}): ${JSON.stringify(this.memory.episodicMemory.filter(e => e.decayWeight > 0.3).slice(0, 5).map(e => ({ content: e.content, confidence: e.decayWeight.toFixed(2), verified: e.verificationCount })))}`;

        let orientContent = `Anomaly Predictions (${context.anomalyPredictions.length}): ${compressPredictions(context.anomalyPredictions)}
Network Topology: ${context.topologySummary || 'No topology data available'} (freshness: ${context.topologyFreshnessMs}ms)
Detected Operation Patterns (${context.detectedPatterns.length}): ${compressPatterns(context.detectedPatterns)}
Recent Evolution Events (${context.recentEvolutionEvents.length}): ${JSON.stringify(context.recentEvolutionEvents)}`;

        // 4000 字符上限截断
        const variableContent = observedStateContent + '\n' + orientContent;
        if (variableContent.length > 4000) {
            // 按优先级从低到高截断
            // 1. detectedPatterns → 仅保留计数摘要
            // 注意：不使用 /s 标志，避免贪婪匹配吞掉后续行（Recent Evolution Events 等）
            orientContent = orientContent.replace(
                /Detected Operation Patterns \(\d+\): [^\n]*/,
                `Detected Operation Patterns (${context.detectedPatterns.length}): [已截断，共 ${context.detectedPatterns.length} 条]`
            );
            if ((observedStateContent + '\n' + orientContent).length > 4000) {
                // 2. anomalyPredictions → 仅保留 top 1
                const top1 = context.anomalyPredictions.slice(0, 1);
                orientContent = orientContent.replace(
                    /Anomaly Predictions \(\d+\): [^\n]*/,
                    `Anomaly Predictions (${context.anomalyPredictions.length}): ${JSON.stringify(top1)} ...及另外 ${context.anomalyPredictions.length - 1} 条`
                );
            }
            if ((observedStateContent + '\n' + orientContent).length > 4000) {
                // 3. activeAlerts → 仅保留分类统计
                const groups: Record<string, number> = {};
                for (const a of context.activeAlerts) { const sev = (a as any).severity ?? 'unknown'; groups[sev] = (groups[sev] ?? 0) + 1; }
                const stats = Object.entries(groups).map(([sev, cnt]) => `${sev}: ${cnt}`).join(', ');
                observedStateContent = observedStateContent.replace(
                    /Active Alerts \(\d+\): [^\n]*/,
                    `Active Alerts (${context.activeAlerts.length}): [摘要: ${stats}]`
                );
            }
            // 4. systemHealth 保留（最高优先级）
            // 硬截断兜底
            const combined = observedStateContent + '\n' + orientContent;
            if (combined.length > 4000) {
                const truncated = combined.substring(0, 3950) + '... [内容因超出上限被强制截断]';
                // 重新分配截断后的内容
                observedStateContent = truncated;
                orientContent = '';
            }
        }

        return `[SYSTEM INSTRUCTION: TIER 0 AUTONOMOUS BRAIN]
You are Opsevo's Autonomous Brain, the 7x24 Tier 0 Global Commander.
Your goal is to actively monitor, troubleshoot, and orchestrate the AI-Ops subsystems using OODA loops.

${this._isSystemBlind ? `☢️ CRITICAL PERCEPTION FAILURE: THE BRAIN IS BLIND.
Current managed devices: 0. Perception sensors are OFFLINE.
DO NOT attempt any 'execute_intent' or 'invoke_skill' operations that require a device.
Focus ONLY on knowledge management or wait for sensor recovery in subsequent ticks.
` : ''}

[SECURITY: ABSOLUTE WHITELIST POLICY]
☢️ CRITICAL: You are FORBIDDEN from generating raw RouterOS commands.
You MUST ONLY use the 'execute_intent' tool with a pre-registered intent action.
Any attempt to bypass this by generating raw CLI commands will be rejected by the system.

[MANAGED DEVICES: Registered Hardware]
NAME                 | IP (HOST)            | REACHABLE | DEVICE_STATUS
--------------------|----------------------|-----------|--------------
${context.managedDevices?.map((d: any) => `${(d.name || 'Unknown').padEnd(20)} | ${(d.host || 'Unknown').padEnd(20)} | ${(!d.unreachable ? '✅ YES' : '❌ NO').padEnd(9)} | ${d.status}`).join('\n') || '(No managed devices found)'}

[REGISTERED INTENTS (Whitelist — current context: ${this._buildIntentCategoryLabel(context)})]
${this._buildFilteredIntentSummary(context)}
NOTE: Only intents relevant to the current trigger context are shown above (≤20). If you need an intent not listed here, call the 'list_intent_categories' tool to discover all available categories, then the system will guide you.

[CURRENT OODA LOOP CONTEXT]
Tick ID: ${context.tickId}
Trigger: ${context.trigger}
Timestamp: ${new Date(context.timestamp).toISOString()}
${tickDeviceId ? `Inferred Target Device: ${tickDeviceId} (auto-detected from context — use as default 'device' parameter if not specified)` : ''}
Auto-Approve High Risk: ${config?.autoApproveHighRisk ? 'ENABLED' : 'DISABLED (Intervention Required)'}

[OBSERVED STATE]
${observedStateContent}

[ORIENT - DEEP COGNITION]
${orientContent}

[OPERATIONAL DECISION FRAMEWORK]
Process priorities TOP-DOWN. Execute the HIGHEST applicable priority first, then continue to lower ones if iteration budget allows.

P0 — INCIDENT RESPONSE (Active Alerts > 0):
  1. manage_knowledge("search", <alert keywords>) → check known issues / existing remediation
  2. execute_intent(query relevant subsystem) → gather live evidence. Choose based on alert type:
     - Network/connectivity alerts → query_interfaces, query_routes, query_arp_table
     - Firewall/security alerts → query_firewall_filter, query_firewall_nat, query_firewall_address_list, query_active_connections
     - DHCP/DNS alerts → query_dhcp_leases, query_dns, query_ip_pools
     - Performance alerts → query_system_resource, query_queue, query_active_connections
     - General/unknown → query_system_resource + query_interfaces + query_logs
  3. query_topology(<affected component ID>) → assess upstream/downstream blast radius
  4. IF known remediation found → invoke_skill(<most relevant specialist from P4 list>, <remediation context>)
  5. IF new unknown issue → manage_knowledge("add", type="pattern", <your findings>) to record for future
  6. IF severity = critical/emergency → send_notification("alert", "emergency", <summary + recommendation>)

P1 — PREDICTIVE DEFENSE (Anomaly Predictions with confidence > 0.7):
  1. execute_intent(query the predicted metric in real-time) → verify prediction accuracy
  2. read_analysis_report(<last 7 days>) → check if similar pattern occurred historically
  3. IF confirmed trend → propose_decision_rule(name, priority, conditions, action) to auto-handle next occurrence
  4. send_notification("frontend", "warning", <prediction + evidence + recommendation>)

P2 — ROUTINE HEALTH BASELINE (trigger=schedule, no alerts, no high-confidence predictions):
  Your job is to build a COMPLETE picture of the network, not just CPU. Rotate through these subsystems across ticks:
  CORE (every tick):
    1. execute_intent(query_system_resource) → CPU/memory/disk baseline
    2. execute_intent(query_interfaces) → check for silent interface failures (link down, high error counters)
  ROTATION (pick 1-2 per tick, cycle through all over multiple ticks):
    - execute_intent(query_firewall_filter) → check for unexpected rules, high hit counters, or blocked traffic patterns
    - execute_intent(query_routes) → verify routing table integrity, check for missing or blackhole routes
    - execute_intent(query_dhcp_leases) → check lease pool utilization, detect rogue DHCP clients
    - execute_intent(query_dns) → verify DNS configuration, check for misconfigurations
    - execute_intent(query_arp_table) → detect ARP anomalies or potential spoofing
    - execute_intent(query_logs) → scan recent logs for warnings, errors, or login attempts
    - execute_intent(query_firewall_nat) → verify NAT rules are intact
    - execute_intent(query_active_connections) → check connection table size for potential DDoS or resource exhaustion
  ANALYSIS (after gathering data):
    3. IF episodic memory contains previous health data → compare_state(before_json, after_json) to detect drift
    4. IF significant drift detected → read_analysis_report(<last 3 days>) to check if this is a trend
    5. extract_pattern("brain", "identify") → discover recurring operational patterns (do this every ~3 ticks, not every tick)
  IMPORTANT: Check your episodic memory to see which subsystems you checked recently. Prioritize subsystems you haven't inspected in a while.

P3 — KNOWLEDGE EVOLUTION (Detected Patterns > 0 OR episodic memory shows repeated failures):
  1. manage_knowledge("search", <pattern/failure keywords>) → check existing knowledge base
  2. IF knowledge gap found → manage_knowledge("add", type="remediation", <new entry>) to fill it
  3. IF actionable pattern → propose_decision_rule to codify automated response
  4. invoke_skill(<most relevant specialist from P4 list>, <optimization or improvement suggestion>)

P4 — ORCHESTRATION & COMMUNICATION:
  - Pending Human Decisions > 0 → send_notification with your analysis and recommendation to help the human decide
  - Complex multi-step remediation → trigger_state_machine_flow("alert-orchestration", <event>, <payload>)
  - Domain-specific deep analysis → invoke_skill(<specialist>, <task description>)
    ${this.getAvailableSkillsLine()}

[HARD RULES]
HR-1. SECURITY: NEVER generate raw RouterOS commands. ONLY use execute_intent with whitelisted actions from [REGISTERED INTENTS].
HR-2. FRESHNESS: IF topology freshnessMs > 30000 → call query_topology to refresh BEFORE trusting stale topology data.
HR-3. VERIFICATION: After any remediation or config change → call execute_intent to verify the fix took effect.
HR-4. LEARNING: Record significant findings via manage_knowledge("add") for future reference. The knowledge base is your long-term memory.
HR-5. EFFICIENCY: Focus on the highest applicable priority. Do NOT redundantly query the same data twice in one tick.
    - Common redundant pairs (calling BOTH is wasteful): query_system_resource ↔ query_health_snapshot, query_interfaces ↔ query_health_snapshot.
    - Before calling any query tool, review your previous steps (shown above) to check if you already have the needed data. If a prior step already returned the information, reuse it instead of querying again.
HR-6. DEVICE IDENTIFICATION:
    - Identification: Use the EXACT [Name] or [IP (HOST)] from the "MANAGED DEVICES" table above for the 'device' parameter.
    - Hallucination Warning: Do NOT search for or guess UUID strings. Use readable names only.
    - Unreachable (❌): Do NOT call 'execute_intent' for unreachable devices. Notify the operator instead.
    - Single Device Mode: If "Managed Devices" list is EMPTY, you may omit the 'device' parameter.
    - Inferred Target Device: If an "Inferred Target Device" is shown in [CURRENT OODA LOOP CONTEXT], use it as the default 'device' parameter when you do not have a more specific target.
HR-7. MCP TOOLS: If an MCP tool call fails or returns a disconnection error, do NOT retry. Try a local alternative tool or skip the step and proceed with the next priority.

[AVAILABLE TOOLS]
{{tools}}

${this._skillFactory ? `[MCP TOOLS NOTE]
Some tools above use the naming convention mcp:{toolName}. These are external MCP (Model Context Protocol) tools provided by connected MCP servers.
- Call them exactly like local tools, using the full mcp:{toolName} as the tool name.
- MCP tools may be slower or less reliable than local tools. If an MCP tool fails, check if a local alternative exists and use that instead.
- If an MCP tool returns a disconnection error, do NOT retry — skip it and proceed with local tools or alternative approaches.
` : ''}[ACTION REQUIRED]
Perform your reasoning and execute the necessary operational tools for this cycle.`;
    }
}

export const autonomousBrainService = new AutonomousBrainService();
