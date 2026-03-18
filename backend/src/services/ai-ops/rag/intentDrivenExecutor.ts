/**
 * IntentDrivenExecutor - 意图驱动执行器
 * 
 * 从 reactLoopController.ts 抽取的独立模块
 * 负责处理高置信度+低风险的意图驱动自动化执行流程
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4 - 意图驱动自动化
 */

import { logger } from '../../../utils/logger';
import { intentParser, type ParsedIntent } from '../intentParser';
import { toolFeedbackCollector } from '../toolFeedbackCollector';
import { continuousLearner } from '../continuousLearner';
import { isCapabilityEnabled, getCapabilityConfig } from '../evolutionConfig';
import type { AgentTool } from './mastraAgent';
import type { ReActStep, ReActStepType } from '../../../types/ai-ops';
import type { ReActExecutionContext, ToolInterceptor } from './reactLoopController';
import type { RouterOSClient } from '../../routerosClient';
import type { IAIProviderAdapter, AIProvider } from '../../../types/ai';
import type { ConversationMemory } from './mastraAgent';

/**
 * 意图驱动执行配置
 */
export interface IntentDrivenConfig {
    /** 置信度阈值 */
    confidenceThreshold: number;
    /** 需要确认的风险等级 */
    riskLevelForConfirmation: 'L1' | 'L2' | 'L3' | 'L4';
    /** 是否启用持续学习 */
    enableContinuousLearning: boolean;
    /** 是否启用工具反馈 */
    enableToolFeedback: boolean;
}

/**
 * 意图执行结果
 */
export interface IntentExecutionResult {
    /** 是否执行成功 */
    success: boolean;
    /** 执行的步骤 */
    steps: ReActStep[];
    /** 最终答案（如果有） */
    finalAnswer?: string;
    /** 是否已执行工具 */
    hasExecutedTool: boolean;
    /** 是否使用了意图驱动路径 */
    usedIntentPath: boolean;
    /** 意图上下文（如果未执行，可用于注入常规循环） */
    intentContext?: {
        parsedIntent: ParsedIntent;
        riskLevel: string;
        mappedRiskLevel: string;
    };
}

/**
 * 工具输入参数类型
 */
export type ToolInputParams = Record<string, unknown>;

/**
 * 工具执行观察结果
 */
export interface ToolObservation {
    output: unknown;
    success: boolean;
    duration: number;
}

/**
 * 工具执行超时时间（毫秒）
 */
const TOOL_EXECUTION_TIMEOUT = 30000;

/**
 * 风险等级映射
 */
export const RISK_TO_LEVEL: Record<string, string> = {
    low: 'L1',
    medium: 'L2',
    high: 'L3',
};

/**
 * 风险等级顺序
 */
export const RISK_LEVEL_ORDER: Record<string, number> = {
    L1: 0,
    L2: 1,
    L3: 2,
    L4: 3,
};

/**
 * 意图到工具的映射
 */
export const INTENT_TO_TOOL_MAP: Record<string, string> = {
    // 监控类
    'monitoring/status': 'monitor_metrics',
    'monitoring/interfaces': 'device_query',
    'monitoring/routing': 'device_query',
    'monitoring/logs': 'device_query',

    // 配置类
    'configuration/interface': 'routeros_exec',
    'configuration/firewall': 'routeros_exec',
    'configuration/routing': 'routeros_exec',
    'configuration/system': 'routeros_exec',

    // 诊断类
    'diagnosis/connectivity': 'routeros_exec',
    'diagnosis/performance': 'monitor_metrics',
    'diagnosis/logs': 'device_query',

    // 知识查询类
    'query/knowledge': 'knowledge_search',
    'query/alert': 'alert_analysis',
};

/**
 * IntentDrivenExecutor 类
 * 处理意图驱动的自动化执行
 */
export class IntentDrivenExecutor {
    private tools: Map<string, AgentTool>;
    private executeActionFn: (
        toolName: string,
        toolInput: ToolInputParams,
        interceptors: Map<string, ToolInterceptor>,
        routerosClient?: RouterOSClient
    ) => Promise<ToolObservation>;
    private formatObservationFn: (output: unknown, success: boolean) => string;
    private generateFinalAnswerFn: (
        message: string,
        steps: ReActStep[],
        context: ConversationMemory,
        adapter: IAIProviderAdapter,
        provider: AIProvider,
        model: string,
        temperature: number
    ) => Promise<string>;

    constructor(
        tools: Map<string, AgentTool>,
        executeAction: (
            toolName: string,
            toolInput: ToolInputParams,
            interceptors: Map<string, ToolInterceptor>,
            routerosClient?: RouterOSClient
        ) => Promise<ToolObservation>,
        formatObservation: (output: unknown, success: boolean) => string,
        generateFinalAnswer: (
            message: string,
            steps: ReActStep[],
            context: ConversationMemory,
            adapter: IAIProviderAdapter,
            provider: AIProvider,
            model: string,
            temperature: number
        ) => Promise<string>
    ) {
        this.tools = tools;
        this.executeActionFn = executeAction;
        this.formatObservationFn = formatObservation;
        this.generateFinalAnswerFn = generateFinalAnswer;
    }

    /**
     * 更新工具集
     */
    setTools(tools: Map<string, AgentTool>): void {
        this.tools = tools;
    }

    /**
     * 尝试执行意图驱动路径
     * 
     * @param message 用户消息
     * @param context 对话上下文
     * @param executionContext 执行上下文
     * @param effectiveInterceptors 工具拦截器
     * @param effectiveAdapter AI适配器
     * @param effectiveProvider AI提供商
     * @param effectiveModel 模型名称
     * @param effectiveTemperature 温度参数
     * @returns 执行结果
     */
    async tryExecute(
        message: string,
        context: ConversationMemory,
        executionContext: ReActExecutionContext,
        effectiveInterceptors: Map<string, ToolInterceptor>,
        effectiveAdapter: IAIProviderAdapter,
        effectiveProvider: AIProvider,
        effectiveModel: string,
        effectiveTemperature: number
    ): Promise<IntentExecutionResult> {
        const steps: ReActStep[] = [];

        // 检查是否启用意图驱动
        if (!isCapabilityEnabled('intentDriven')) {
            return {
                success: false,
                steps,
                hasExecutedTool: false,
                usedIntentPath: false,
            };
        }

        try {
            const idConfig = getCapabilityConfig('intentDriven');
            const parsedIntent = await intentParser.parse(message);

            // 低置信度或未知类别，不使用快速路径
            if (parsedIntent.confidence < idConfig.confidenceThreshold) {
                // 如果不是 unknown 类别，注入参考信息
                if (parsedIntent.category !== 'unknown') {
                    steps.push({
                        type: 'thought' as ReActStepType,
                        content: `[意图预解析参考] 可能的运维意图: ${parsedIntent.category}/${parsedIntent.action}, ` +
                            `置信度: ${parsedIntent.confidence}（低于阈值 ${idConfig.confidenceThreshold}）。` +
                            `仅作为参考信息，将通过常规推理流程处理。`,
                        timestamp: Date.now(),
                    });
                }

                return {
                    success: false,
                    steps,
                    hasExecutedTool: false,
                    usedIntentPath: false,
                    intentContext: {
                        parsedIntent,
                        riskLevel: intentParser.getRiskLevel(parsedIntent),
                        mappedRiskLevel: RISK_TO_LEVEL[intentParser.getRiskLevel(parsedIntent)] || 'L3',
                    },
                };
            }

            // 高置信度，检查风险等级
            const riskLevel = intentParser.getRiskLevel(parsedIntent);
            const mappedRiskLevel = RISK_TO_LEVEL[riskLevel] || 'L3';
            const configRiskLevel = idConfig.riskLevelForConfirmation || 'L3';

            // 高风险，注入上下文但不直接执行
            if (RISK_LEVEL_ORDER[mappedRiskLevel] >= RISK_LEVEL_ORDER[configRiskLevel]) {
                logger.info('Intent-driven: high confidence but high risk, injecting context', {
                    intentId: parsedIntent.id,
                    category: parsedIntent.category,
                    action: parsedIntent.action,
                    confidence: parsedIntent.confidence,
                    riskLevel,
                    requestId: executionContext.requestId,
                });

                steps.push({
                    type: 'thought' as ReActStepType,
                    content: `[意图预解析参考] 检测到运维意图: ${parsedIntent.category}/${parsedIntent.action}` +
                        `${parsedIntent.target ? `, 目标: ${parsedIntent.target}` : ''}` +
                        `, 置信度: ${parsedIntent.confidence}, 风险等级: ${riskLevel}(${mappedRiskLevel})。` +
                        `由于风险等级不低于确认阈值(${configRiskLevel})，需要通过常规推理流程进行详细分析和确认。` +
                        (Object.keys(parsedIntent.parameters).length > 0
                            ? ` 提取的参数: ${JSON.stringify(parsedIntent.parameters)}`
                            : ''),
                    timestamp: Date.now(),
                });

                return {
                    success: false,
                    steps,
                    hasExecutedTool: false,
                    usedIntentPath: false,
                    intentContext: { parsedIntent, riskLevel, mappedRiskLevel },
                };
            }

            // 高置信度 + 低风险 → 直接执行
            logger.info('Intent-driven: high confidence + low risk, executing directly', {
                intentId: parsedIntent.id,
                category: parsedIntent.category,
                action: parsedIntent.action,
                confidence: parsedIntent.confidence,
                riskLevel,
                requestId: executionContext.requestId,
            });

            // 映射意图到工具
            const intentToolName = this.mapIntentToTool(parsedIntent);
            const intentToolInput: ToolInputParams = {
                ...parsedIntent.parameters,
                ...(parsedIntent.target ? { target: parsedIntent.target } : {}),
            };

            // 记录思考步骤
            steps.push({
                type: 'thought' as ReActStepType,
                content: `[意图驱动自动化] 识别到高置信度意图: ${parsedIntent.category}/${parsedIntent.action}` +
                    `${parsedIntent.target ? `, 目标: ${parsedIntent.target}` : ''}` +
                    `, 置信度: ${parsedIntent.confidence}, 风险等级: ${riskLevel}。直接执行对应操作。`,
                timestamp: Date.now(),
            });

            // 检查工具是否可用
            if (!intentToolName || !this.tools.has(intentToolName)) {
                logger.info('Intent-driven: no matching tool found, falling back to ReAct loop', {
                    intentAction: parsedIntent.action,
                    intentCategory: parsedIntent.category,
                });

                steps.push({
                    type: 'thought' as ReActStepType,
                    content: `[意图驱动自动化] 未找到与意图 "${parsedIntent.category}/${parsedIntent.action}" 直接匹配的工具，将通过常规推理流程处理。`,
                    timestamp: Date.now(),
                });

                return {
                    success: false,
                    steps,
                    hasExecutedTool: false,
                    usedIntentPath: false,
                    intentContext: { parsedIntent, riskLevel, mappedRiskLevel },
                };
            }

            // 记录动作步骤
            steps.push({
                type: 'action' as ReActStepType,
                content: `调用工具: ${intentToolName}`,
                timestamp: Date.now(),
                toolName: intentToolName,
                toolInput: intentToolInput,
            });

            // 执行工具 - M3: 添加超时保护
            const startTime = Date.now();
            let observation: ToolObservation;

            try {
                observation = await Promise.race([
                    this.executeActionFn(
                        intentToolName,
                        intentToolInput,
                        effectiveInterceptors,
                        executionContext.routerosClient
                    ),
                    new Promise<never>((_, reject) =>
                        setTimeout(
                            () => reject(new Error(`Tool execution timeout after ${TOOL_EXECUTION_TIMEOUT}ms`)),
                            TOOL_EXECUTION_TIMEOUT
                        )
                    ),
                ]);
            } catch (timeoutError) {
                logger.warn('Intent-driven tool execution timed out', {
                    toolName: intentToolName,
                    timeout: TOOL_EXECUTION_TIMEOUT,
                    requestId: executionContext.requestId,
                });

                observation = {
                    output: timeoutError instanceof Error ? timeoutError.message : 'Tool execution timed out',
                    success: false,
                    duration: Date.now() - startTime,
                };
            }

            // 记录观察步骤
            steps.push({
                type: 'observation' as ReActStepType,
                content: this.formatObservationFn(observation.output, observation.success),
                timestamp: Date.now(),
                toolOutput: observation.output,
                duration: observation.duration,
                success: observation.success,
            });

            // 记录工具反馈指标
            this.recordToolFeedback(intentToolName, observation);

            // 生成最终答案
            const finalAnswer = await this.generateFinalAnswerFn(
                message,
                steps,
                context,
                effectiveAdapter,
                effectiveProvider,
                effectiveModel,
                effectiveTemperature
            );

            steps.push({
                type: 'final_answer' as ReActStepType,
                content: finalAnswer,
                timestamp: Date.now(),
            });

            // 记录持续学习
            this.recordContinuousLearning(
                executionContext.requestId,
                intentToolName,
                parsedIntent,
                observation.success,
                riskLevel
            );

            return {
                success: true,
                steps,
                finalAnswer,
                hasExecutedTool: true,
                usedIntentPath: true,
            };

        } catch (intentError) {
            logger.warn('Intent parsing failed, falling back to regular ReAct loop', {
                error: intentError instanceof Error ? intentError.message : String(intentError),
                requestId: executionContext.requestId,
            });

            return {
                success: false,
                steps,
                hasExecutedTool: false,
                usedIntentPath: false,
            };
        }
    }

    /**
     * 映射意图到工具名称
     */
    private mapIntentToTool(intent: ParsedIntent): string | null {
        const key = `${intent.category}/${intent.action}`;
        return INTENT_TO_TOOL_MAP[key] || null;
    }

    /**
     * 记录工具反馈
     */
    private recordToolFeedback(toolName: string, observation: ToolObservation): void {
        try {
            if (isCapabilityEnabled('toolFeedback')) {
                toolFeedbackCollector.recordMetric({
                    toolName,
                    timestamp: Date.now(),
                    duration: observation.duration,
                    success: observation.success,
                    errorMessage: observation.success ? undefined : String(observation.output),
                });
            }
        } catch (tfError) {
            logger.warn('Failed to record intent-driven tool feedback', {
                error: tfError instanceof Error ? tfError.message : String(tfError),
            });
        }
    }

    /**
     * 记录持续学习
     */
    private recordContinuousLearning(
        requestId: string,
        toolName: string,
        intent: ParsedIntent,
        success: boolean,
        riskLevel: string,
        userId?: string,
        sessionId?: string
    ): void {
        try {
            if (isCapabilityEnabled('continuousLearning')) {
                const clConfig = getCapabilityConfig('continuousLearning');
                if (clConfig.patternLearningEnabled) {
                    // L2: 使用实际的 userId 和 sessionId，默认回退到 requestId
                    continuousLearner.recordOperation(requestId, {
                        userId: userId || requestId,
                        sessionId: sessionId || requestId,
                        toolName,
                        parameters: {
                            type: 'intent_driven_execution',
                            intentCategory: intent.category,
                            intentAction: intent.action,
                        },
                        result: success ? 'success' : 'failure',
                        timestamp: Date.now(),
                        context: {
                            confidence: intent.confidence,
                            riskLevel,
                        },
                    });
                }
            }
        } catch (clError) {
            logger.warn('Failed to record intent-driven continuous learning', {
                error: clError instanceof Error ? clError.message : String(clError),
            });
        }
    }
}

/**
 * 创建 IntentDrivenExecutor 实例
 */
export function createIntentDrivenExecutor(
    tools: Map<string, AgentTool>,
    executeAction: (
        toolName: string,
        toolInput: ToolInputParams,
        interceptors: Map<string, ToolInterceptor>,
        routerosClient?: RouterOSClient
    ) => Promise<ToolObservation>,
    formatObservation: (output: unknown, success: boolean) => string,
    generateFinalAnswer: (
        message: string,
        steps: ReActStep[],
        context: ConversationMemory,
        adapter: IAIProviderAdapter,
        provider: AIProvider,
        model: string,
        temperature: number
    ) => Promise<string>
): IntentDrivenExecutor {
    return new IntentDrivenExecutor(tools, executeAction, formatObservation, generateFinalAnswer);
}
