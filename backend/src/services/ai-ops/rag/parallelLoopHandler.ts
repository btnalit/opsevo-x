/**
 * ParallelLoopHandler - 并行循环处理器
 * 
 * 从 reactLoopController.ts 抽取的独立模块
 * 负责处理并行执行模式下的工具批次执行和回退逻辑
 * 
 * Requirements: 1.1, 1.2, 1.6, 4.1, 8.1 - 并行执行系统
 */

import { logger } from '../../../utils/logger';
import {
    ToolCall,
    ToolCallBatch,
    ToolCallResult,
    MergedObservation,
} from '../../../types/parallel-execution';
import {
    parallelExecutor,
} from './parallelExecutor';
import { parallelExecutionMetrics } from './parallelExecutionMetrics';
import { toolFeedbackCollector } from '../toolFeedbackCollector';
import { isCapabilityEnabled } from '../evolutionConfig';
import { hashToolParams, ToolInterceptor, SkillContext } from './reactLoopController';
import type { AgentTool, ConversationMemory } from './mastraAgent';
import type { ReActStep } from '../../../types/ai-ops';
import type { ReActExecutionContext } from './reactLoopController';
import type { RAGContext } from './ragEngine';
import type { FormattedKnowledge } from './types/intelligentRetrieval';
import type { AIProvider, IAIProviderAdapter } from '../../../types/ai';

/**
 * 执行模式枚举
 */
export enum ExecutionMode {
    SEQUENTIAL = 'sequential',
    PARALLEL = 'parallel',
    PLANNED = 'planned',
}

/**
 * 并行循环配置
 */
export interface ParallelLoopConfig {
    /** 最大并发数 */
    maxConcurrency: number;
    /** 批次超时时间（毫秒） */
    batchTimeout: number;
    /** 是否启用依赖分析 */
    enableDependencyAnalysis: boolean;
    /** 回退链 */
    fallbackChain: ExecutionMode[];
    /** 是否启用规划模式 */
    enablePlanning: boolean;
}

/**
 * 默认并行循环配置
 */
export const DEFAULT_PARALLEL_LOOP_CONFIG: ParallelLoopConfig = {
    maxConcurrency: 5,
    batchTimeout: 60000,
    enableDependencyAnalysis: true,
    fallbackChain: [ExecutionMode.PLANNED, ExecutionMode.PARALLEL, ExecutionMode.SEQUENTIAL],
    enablePlanning: true,
};

/**
 * 工具调用模式历史最大长度（滑动窗口）
 * 防止长时间会话导致内存泄漏
 */
const MAX_TOOL_PATTERN_HISTORY = 100;

/**
 * 回退状态
 */
export interface FallbackState {
    /** 原始模式 */
    originalMode: ExecutionMode;
    /** 当前模式 */
    currentMode: ExecutionMode;
    /** 回退次数 */
    fallbackCount: number;
    /** 回退原因列表 */
    reasons: string[];
    /** 回滚点（步骤索引） */
    rollbackPoint?: number;
}

/**
 * 回退信息（用于结果返回）
 */
export interface FallbackInfo {
    /** 是否发生了回退 */
    hasFallback: boolean;
    /** 原始模式 */
    originalMode: ExecutionMode;
    /** 最终模式 */
    finalMode: ExecutionMode;
    /** 回退次数 */
    fallbackCount: number;
    /** 回退原因列表 */
    reasons: string[];
}

/**
 * 并行执行结果
 */
export interface ParallelExecutionResult {
    /** 是否成功 */
    success: boolean;
    /** 执行的步骤 */
    steps: ReActStep[];
    /** 已执行工具 */
    hasExecutedTool: boolean;
    /** 合并后的观察结果 */
    observation?: {
        output: string;
        duration: number;
        success: boolean;
    };
    /** 是否应继续循环 */
    shouldContinue: boolean;
    /** 最终答案（如果有） */
    finalAnswer?: string;
    /** 回退状态 */
    fallbackState: FallbackState;
}

/**
 * ParallelLoopHandler 类
 * 处理并行执行模式下的批次执行
 */
export class ParallelLoopHandler {
    private config: ParallelLoopConfig;
    private tools: Map<string, AgentTool>;
    private formatObservationFn: (output: unknown, success: boolean) => string;
    private storeKnowledgeResultsFn: (
        observation: { output: unknown; duration: number; success: boolean },
        ragContext: RAGContext
    ) => void;
    private shouldContinueFn: (
        steps: ReActStep[],
        message: string,
        adapter: IAIProviderAdapter,
        provider: AIProvider,
        model: string,
        temperature: number,
        hasExecutedTool: boolean,
        skillContext?: SkillContext
    ) => Promise<boolean>;
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
        formatObservation: (output: unknown, success: boolean) => string,
        storeKnowledgeResults: (
            observation: { output: unknown; duration: number; success: boolean },
            ragContext: RAGContext
        ) => void,
        shouldContinue: (
            steps: ReActStep[],
            message: string,
            adapter: IAIProviderAdapter,
            provider: AIProvider,
            model: string,
            temperature: number,
            hasExecutedTool: boolean,
            skillContext?: SkillContext
        ) => Promise<boolean>,
        generateFinalAnswer: (
            message: string,
            steps: ReActStep[],
            context: ConversationMemory,
            adapter: IAIProviderAdapter,
            provider: AIProvider,
            model: string,
            temperature: number
        ) => Promise<string>,
        config?: Partial<ParallelLoopConfig>
    ) {
        this.config = { ...DEFAULT_PARALLEL_LOOP_CONFIG, ...config };
        this.tools = tools;
        this.formatObservationFn = formatObservation;
        this.storeKnowledgeResultsFn = storeKnowledgeResults;
        this.shouldContinueFn = shouldContinue;
        this.generateFinalAnswerFn = generateFinalAnswer;
    }

    /**
     * 更新工具集
     */
    setTools(tools: Map<string, AgentTool>): void {
        this.tools = tools;
        parallelExecutor.setTools(tools);
    }

    /**
     * 创建回退状态
     */
    createFallbackState(initialMode: ExecutionMode): FallbackState {
        return {
            originalMode: initialMode,
            currentMode: initialMode,
            fallbackCount: 0,
            reasons: [],
        };
    }

    /**
     * 回退到下一个模式
     */
    fallbackToNextMode(
        currentMode: ExecutionMode,
        reason: string,
        state: FallbackState
    ): ExecutionMode | null {
        const chain = this.config.fallbackChain;
        const currentIndex = chain.indexOf(currentMode);

        if (currentIndex === -1 || currentIndex >= chain.length - 1) {
            logger.warn('Fallback chain exhausted, using sequential mode', {
                currentMode,
                reason,
                fallbackCount: state.fallbackCount,
            });
            return ExecutionMode.SEQUENTIAL;
        }

        const nextMode = chain[currentIndex + 1];
        state.currentMode = nextMode;
        state.fallbackCount++;
        state.reasons.push(reason);

        logger.info('Falling back to next execution mode', {
            from: currentMode,
            to: nextMode,
            reason,
            fallbackCount: state.fallbackCount,
        });

        return nextMode;
    }

    /**
     * 构建回退信息
     */
    buildFallbackInfo(state: FallbackState): FallbackInfo {
        return {
            hasFallback: state.fallbackCount > 0,
            originalMode: state.originalMode,
            finalMode: state.currentMode,
            fallbackCount: state.fallbackCount,
            reasons: state.reasons,
        };
    }

    /**
     * 构建并行执行提示词
     */
    buildParallelPrompt(message: string, steps: ReActStep[], maxConcurrency: number): string {
        const stepsText = steps
            .map((s, i) => `Step ${i + 1} [${s.type}]: ${s.content.substring(0, 200)}...`)
            .join('\n');

        return `你正在进行并行工具调用模式。可以同时调用多个独立的工具。

## 用户问题
${message}

## 已执行步骤
${stepsText || '(无)'}

## 并行调用格式
如果需要调用多个独立的工具，请使用以下格式：

Thought: 分析问题，确定需要并行调用的多个工具
Action 1: 工具名称1
Action Input 1: {"参数": "值"}
Action 2: 工具名称2
Action Input 2: {"参数": "值"}
...

最多可同时调用 ${maxConcurrency} 个工具。

注意：
1. 只有相互独立的工具调用才能并行执行
2. 如果某个工具的输入依赖另一个工具的输出，应该分步执行
3. 如果只需要调用一个工具，使用标准格式即可`;
    }

    /**
     * 执行并行工具调用
     */
    async executeParallel(
        toolCalls: ToolCall[],
        steps: ReActStep[],
        message: string,
        context: ConversationMemory,
        executionContext: ReActExecutionContext,
        effectiveInterceptors: Map<string, ToolInterceptor>,
        effectiveAdapter: IAIProviderAdapter,
        effectiveProvider: AIProvider,
        effectiveModel: string,
        effectiveTemperature: number,
        ragContext: RAGContext,
        formattedKnowledge: FormattedKnowledge[],
        selectedMode: ExecutionMode,
        skillContext?: SkillContext,
        enableOutputValidation?: boolean,
        validateAndCorrectOutputFn?: (
            answer: string,
            knowledge: FormattedKnowledge[],
            message: string,
            steps: ReActStep[],
            context: ConversationMemory,
            adapter: IAIProviderAdapter,
            provider: AIProvider,
            model: string,
            temperature: number
        ) => Promise<{ correctedAnswer: string; validatedReferences: unknown[] }>
    ): Promise<ParallelExecutionResult> {
        const fallbackState = this.createFallbackState(selectedMode);
        const rollbackPoint = steps.length;

        logger.debug('Recording rollback point for parallel execution', {
            rollbackPoint,
            toolCount: toolCalls.length,
            requestId: executionContext.requestId,
        });

        try {
            // L1: 空 toolCalls 数组验证
            if (!toolCalls || toolCalls.length === 0) {
                logger.warn('executeParallel called with empty toolCalls array', {
                    requestId: executionContext.requestId,
                });
                return {
                    success: false,
                    steps,
                    hasExecutedTool: false,
                    shouldContinue: true,
                    fallbackState,
                };
            }

            logger.info('Executing parallel tool calls', {
                count: toolCalls.length,
                tools: toolCalls.map((tc) => tc.toolName),
                requestId: executionContext.requestId,
            });

            // 为每个工具调用记录 Action 步骤
            for (const toolCall of toolCalls) {
                steps.push({
                    type: 'action',
                    content: `调用工具: ${toolCall.toolName}`,
                    timestamp: Date.now(),
                    toolName: toolCall.toolName,
                    toolInput: toolCall.params,
                });
            }

            // 设置工具到 ParallelExecutor
            parallelExecutor.setTools(this.tools);

            // 创建批次并执行
            const batch = parallelExecutor.createBatch(toolCalls);
            const mergedObservation = await parallelExecutor.executeBatch(
                batch,
                effectiveInterceptors,
                executionContext
            );

            // 记录并行执行指标
            parallelExecutionMetrics.recordExecution({
                executionId: batch.batchId,
                mode: selectedMode,
                toolCallCount: toolCalls.length,
                batchCount: 1,
                totalDuration: mergedObservation.totalDuration,
                theoreticalSequentialDuration: mergedObservation.results.reduce(
                    (sum, r) => sum + r.duration,
                    0
                ),
                speedupRatio: parallelExecutionMetrics.calculateSpeedupRatio(
                    mergedObservation.totalDuration,
                    mergedObservation.results.map((r) => r.duration)
                ),
                avgParallelism: mergedObservation.parallelism,
                failureRate: mergedObservation.failureCount / toolCalls.length,
                retryCount: mergedObservation.results.reduce((sum, r) => sum + r.retryCount, 0),
            });

            // 记录工具调用模式（用于循环检测）
            // M2: 添加滑动窗口限制防止内存泄漏
            for (const toolCall of toolCalls) {
                const paramsHash = hashToolParams(toolCall.params);
                // 缺陷 B 修复：记录失败状态
                const toolResult = mergedObservation.results?.find((r: any) => r.toolName === toolCall.toolName);
                executionContext.toolCallPatterns.push({
                    toolName: toolCall.toolName,
                    paramsHash,
                    timestamp: Date.now(),
                    failed: toolResult ? !toolResult.success : false,
                });

                // 滑动窗口：超出限制时移除最旧的记录
                if (executionContext.toolCallPatterns.length > MAX_TOOL_PATTERN_HISTORY) {
                    executionContext.toolCallPatterns.shift();
                }
            }

            // 记录工具反馈
            this.recordToolFeedback(mergedObservation.results);

            // 处理知识搜索结果
            for (const result of mergedObservation.results) {
                if (result.toolName === 'knowledge_search') {
                    this.storeKnowledgeResultsFn(
                        { output: result.output, duration: result.duration, success: result.success },
                        ragContext
                    );
                }
            }

            // 构建观察结果
            const observation = {
                output:
                    mergedObservation.formattedText ||
                    parallelExecutor.formatForLLM(mergedObservation.results),
                duration: mergedObservation.totalDuration,
                success: mergedObservation.successCount > 0,
            };

            steps.push({
                type: 'observation',
                content: this.formatObservationFn(observation.output, observation.success),
                timestamp: Date.now(),
                toolOutput: observation.output,
                duration: observation.duration,
                success: observation.success,
            });

            // 判断是否需要继续循环
            const shouldContinue = await this.shouldContinueFn(
                steps,
                message,
                effectiveAdapter,
                effectiveProvider,
                effectiveModel,
                effectiveTemperature,
                true,
                skillContext
            );

            let finalAnswer: string | undefined;
            if (!shouldContinue) {
                finalAnswer = await this.generateFinalAnswerFn(
                    message,
                    steps,
                    context,
                    effectiveAdapter,
                    effectiveProvider,
                    effectiveModel,
                    effectiveTemperature
                );

                // 输出验证
                if (
                    enableOutputValidation &&
                    formattedKnowledge.length > 0 &&
                    validateAndCorrectOutputFn
                ) {
                    const validationResult = await validateAndCorrectOutputFn(
                        finalAnswer,
                        formattedKnowledge,
                        message,
                        steps,
                        context,
                        effectiveAdapter,
                        effectiveProvider,
                        effectiveModel,
                        effectiveTemperature
                    );
                    finalAnswer = validationResult.correctedAnswer;
                }

                steps.push({
                    type: 'final_answer',
                    content: finalAnswer,
                    timestamp: Date.now(),
                });
            }

            return {
                success: true,
                steps,
                hasExecutedTool: true,
                observation,
                shouldContinue,
                finalAnswer,
                fallbackState,
            };
        } catch (error) {
            logger.error('Parallel execution failed, rolling back', {
                error: error instanceof Error ? error.message : String(error),
                rollbackPoint,
                requestId: executionContext.requestId,
            });

            // 回滚步骤
            steps.splice(rollbackPoint);

            // P2: 同时回滚 toolCallPatterns，防止循环检测误判
            const patternRollbackPoint = executionContext.toolCallPatterns.length - toolCalls.length;
            if (patternRollbackPoint >= 0) {
                executionContext.toolCallPatterns.splice(patternRollbackPoint);
            }

            // 尝试回退到下一个模式
            const nextMode = this.fallbackToNextMode(
                selectedMode,
                error instanceof Error ? error.message : String(error),
                fallbackState
            );

            return {
                success: false,
                steps,
                hasExecutedTool: false,
                shouldContinue: true,
                fallbackState: {
                    ...fallbackState,
                    currentMode: nextMode || ExecutionMode.SEQUENTIAL,
                },
            };
        }
    }

    /**
     * 记录工具反馈
     */
    private recordToolFeedback(
        results: Array<{
            toolName: string;
            duration: number;
            success: boolean;
            output: unknown;
        }>
    ): void {
        try {
            if (isCapabilityEnabled('toolFeedback')) {
                for (const result of results) {
                    toolFeedbackCollector.recordMetric({
                        toolName: result.toolName,
                        timestamp: Date.now(),
                        duration: result.duration,
                        success: result.success,
                        errorMessage: result.success ? undefined : String(result.output),
                    });
                }
            }
        } catch (toolFeedbackError) {
            logger.warn('Failed to record parallel tool feedback metrics', {
                error:
                    toolFeedbackError instanceof Error
                        ? toolFeedbackError.message
                        : String(toolFeedbackError),
            });
        }
    }
}

/**
 * 创建 ParallelLoopHandler 实例
 */
export function createParallelLoopHandler(
    tools: Map<string, AgentTool>,
    formatObservation: (output: unknown, success: boolean) => string,
    storeKnowledgeResults: (
        observation: { output: unknown; duration: number; success: boolean },
        ragContext: RAGContext
    ) => void,
    shouldContinue: (
        steps: ReActStep[],
        message: string,
        adapter: IAIProviderAdapter,
        provider: AIProvider,
        model: string,
        temperature: number,
        hasExecutedTool: boolean,
        skillContext?: SkillContext
    ) => Promise<boolean>,
    generateFinalAnswer: (
        message: string,
        steps: ReActStep[],
        context: ConversationMemory,
        adapter: IAIProviderAdapter,
        provider: AIProvider,
        model: string,
        temperature: number
    ) => Promise<string>,
    config?: Partial<ParallelLoopConfig>
): ParallelLoopHandler {
    return new ParallelLoopHandler(
        tools,
        formatObservation,
        storeKnowledgeResults,
        shouldContinue,
        generateFinalAnswer,
        config
    );
}
