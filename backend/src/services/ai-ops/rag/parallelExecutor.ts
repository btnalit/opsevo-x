/**
 * ParallelExecutor - 并行执行器
 * 
 * 负责并发执行多个工具调用并合并结果
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 * - 1.1: 提取并并发执行多个工具调用
 * - 1.2: 合并所有 Observation 结果
 * - 1.3: 处理部分失败，继续执行其他调用
 * - 1.4: 支持工具拦截器机制
 * - 1.5: 追踪每个工具调用的执行时间
 */

import { logger } from '../../../utils/logger';
import {
  ToolCall,
  ToolCallBatch,
  ToolCallResult,
  MergedObservation,
  ParallelExecutorConfig,
  DependencyGraph,
  ParallelExecutionError,
  ParallelExecutionErrorType,
  CancellableTimeout,
} from '../../../types/parallel-execution';
import { DependencyAnalyzer, dependencyAnalyzer } from './dependencyAnalyzer';
import { ConcurrencyLimiter, concurrencyLimiter, SlotRequest } from './concurrencyLimiter';
import { CircuitBreaker, circuitBreaker } from './circuitBreaker';
import { ToolInterceptor, ReActExecutionContext } from './reactLoopController';
import { AgentTool } from './mastraAgent';

/**
 * 默认并行执行器配置
 * 
 * 注意：默认启用并行执行，与 ReActLoopController 配置保持一致
 */
const DEFAULT_CONFIG: ParallelExecutorConfig = {
  enabled: true,
  maxConcurrency: 5,
  toolTimeout: 30000,
  batchTimeout: 60000,
  retryCount: 1,
  enableCircuitBreaker: true,
};

/**
 * ParallelExecutor 类
 * 管理并行工具调用的执行
 */
export class ParallelExecutor {
  private config: ParallelExecutorConfig;
  private dependencyAnalyzer: DependencyAnalyzer;
  private concurrencyLimiter: ConcurrencyLimiter;
  private circuitBreaker: CircuitBreaker;
  
  /** 已注册的工具 */
  private tools: Map<string, AgentTool> = new Map();
  
  /** 批次 ID 计数器 */
  private batchIdCounter = 0;

  constructor(
    config?: Partial<ParallelExecutorConfig>,
    deps?: {
      dependencyAnalyzer?: DependencyAnalyzer;
      concurrencyLimiter?: ConcurrencyLimiter;
      circuitBreaker?: CircuitBreaker;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dependencyAnalyzer = deps?.dependencyAnalyzer || dependencyAnalyzer;
    this.concurrencyLimiter = deps?.concurrencyLimiter || concurrencyLimiter;
    this.circuitBreaker = deps?.circuitBreaker || circuitBreaker;
    
    logger.debug('ParallelExecutor initialized', { config: this.config });
  }

  /**
   * 注册工具
   */
  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 注册多个工具
   */
  registerTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * 清除所有工具
   */
  clearTools(): void {
    this.tools.clear();
  }

  /**
   * 设置工具（从外部传入）
   * 
   * 注意：创建 Map 副本以确保并发安全
   * 避免多个请求共享同一个工具集合引用导致的竞态条件
   */
  setTools(tools: Map<string, AgentTool>): void {
    this.tools = new Map(tools);
  }

  /**
   * 解析 LLM 输出中的多个工具调用
   * Requirements: 1.1
   * Requirements: 2.1, 2.4, 2.6 (react-parallel-bugfix) - 使用平衡括号匹配
   * 
   * 支持格式：
   * 1. 带编号格式（推荐）：
   *    Action 1: tool_name
   *    Action Input 1: {"param": "value"}
   * 
   * 2. 不带编号的多个 Action 块：
   *    Action: tool_name
   *    Action Input: {"param": "value"}
   *    
   *    Action: tool_name2
   *    Action Input: {"param": "value"}
   * 
   * @param llmOutput LLM 输出文本
   * @returns 解析出的工具调用列表
   */
  parseMultipleToolCalls(llmOutput: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    
    // 添加调试日志
    logger.debug('Parsing LLM output for multiple tool calls', {
      outputLength: llmOutput.length,
      outputPreview: llmOutput.substring(0, 300),
      containsNumberedAction: /Action\s*\d+\s*:/i.test(llmOutput),
      actionMatches: (llmOutput.match(/Action\s*[\d]*\s*:/gi) || []).length,
    });
    
    // 方法 1：匹配带编号的 Action 格式（优先）
    // 支持 "Action 1:", "Action1:", "Action  1:" 等变体
    const numberedPattern = /Action\s*(\d+)\s*:\s*([\w\-_]+)\s*[\n\r]+\s*Action\s*Input\s*\1\s*:\s*/gi;
    let match;
    
    while ((match = numberedPattern.exec(llmOutput)) !== null) {
      const [fullMatch, number, toolName] = match;
      const jsonStartIndex = match.index + fullMatch.length;
      
      // 使用平衡括号匹配提取 JSON
      const paramsStr = this.extractBalancedJson(llmOutput, jsonStartIndex);
      
      if (paramsStr === null) {
        logger.warn('Failed to extract balanced JSON for numbered tool call', {
          number,
          toolName,
          position: jsonStartIndex,
        });
        continue;
      }
      
      try {
        const params = JSON.parse(paramsStr);
        toolCalls.push({
          callId: `call_${Date.now()}_${number}`,
          toolName: toolName.trim(),
          params,
          dependsOn: [],
        });
        logger.debug('Parsed numbered tool call', { number, toolName });
      } catch (error) {
        logger.warn('Failed to parse numbered tool call params', {
          number,
          toolName,
          paramsStr: paramsStr.substring(0, 100),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 方法 2：如果没有匹配到带编号的格式，尝试匹配多个不带编号的 Action 块
    if (toolCalls.length === 0) {
      logger.debug('No numbered actions found, trying unnumbered format');
      
      // 使用更宽松的正则表达式，支持多种换行格式
      // 匹配 "Action: tool_name" 后跟 "Action Input:"
      const unnumberedPattern = /Action\s*:\s*([\w\-_]+)\s*[\n\r]+\s*Action\s*Input\s*:\s*/gi;
      
      while ((match = unnumberedPattern.exec(llmOutput)) !== null) {
        const [fullMatch, toolName] = match;
        const jsonStartIndex = match.index + fullMatch.length;
        
        // 使用平衡括号匹配提取 JSON
        const paramsStr = this.extractBalancedJson(llmOutput, jsonStartIndex);
        
        if (paramsStr === null) {
          logger.warn('Failed to extract balanced JSON for unnumbered tool call', {
            toolName,
            position: jsonStartIndex,
          });
          continue;
        }
        
        try {
          const params = JSON.parse(paramsStr);
          toolCalls.push({
            callId: `call_${Date.now()}_${toolCalls.length + 1}`,
            toolName: toolName.trim(),
            params,
            dependsOn: [],
          });
          logger.debug('Parsed unnumbered tool call', { toolName, index: toolCalls.length });
        } catch (error) {
          logger.warn('Failed to parse unnumbered tool call params', {
            toolName,
            paramsStr: paramsStr.substring(0, 100),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.info('Parsed tool calls from LLM output', {
      count: toolCalls.length,
      tools: toolCalls.map(tc => tc.toolName),
      usedNumberedFormat: toolCalls.length > 0 && /Action\s*\d+\s*:/i.test(llmOutput),
    });

    return toolCalls;
  }

  /**
   * 执行工具调用批次
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
   * 
   * @param batch 工具调用批次
   * @param interceptors 工具拦截器
   * @param context 执行上下文
   * @returns 合并的观察结果
   */
  async executeBatch(
    batch: ToolCallBatch,
    interceptors: Map<string, ToolInterceptor>,
    context?: ReActExecutionContext
  ): Promise<MergedObservation> {
    const startTime = Date.now();
    const results: ToolCallResult[] = [];
    
    logger.info('Executing tool call batch', {
      batchId: batch.batchId,
      callCount: batch.calls.length,
      tools: batch.calls.map(c => c.toolName),
    });

    // 分析依赖关系，生成可并行的批次
    const parallelBatches = this.dependencyAnalyzer.generateParallelBatches(batch.dependencies);
    
    // 按批次顺序执行
    for (const parallelGroup of parallelBatches) {
      const groupCalls = batch.calls.filter(c => parallelGroup.includes(c.callId));
      
      if (groupCalls.length === 0) continue;
      
      // 并行执行当前组的所有调用
      const groupResults = await this.executeParallelGroup(
        groupCalls,
        interceptors,
        context
      );
      
      results.push(...groupResults);
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    const merged: MergedObservation = {
      batchId: batch.batchId,
      results,
      successCount,
      failureCount,
      totalDuration,
      parallelism: Math.max(...parallelBatches.map(b => b.length)),
      formattedText: this.formatForLLM(results),
    };

    logger.info('Batch execution completed', {
      batchId: batch.batchId,
      successCount,
      failureCount,
      totalDuration,
      parallelism: merged.parallelism,
    });

    return merged;
  }

  /**
   * 创建工具调用批次
   * 
   * @param toolCalls 工具调用列表
   * @returns 工具调用批次
   */
  createBatch(toolCalls: ToolCall[]): ToolCallBatch {
    const batchId = `batch_${++this.batchIdCounter}_${Date.now()}`;
    const dependencies = this.dependencyAnalyzer.analyze(toolCalls);
    
    return {
      batchId,
      calls: toolCalls,
      dependencies,
      priority: 0,
    };
  }

  /**
   * 合并观察结果
   * Requirements: 1.2
   * 
   * @param results 工具调用结果列表
   * @returns 合并后的文本
   */
  mergeObservations(results: ToolCallResult[]): string {
    return this.formatForLLM(results);
  }

  /**
   * 格式化结果供 LLM 使用
   * Requirements: 1.2
   * 
   * @param results 工具调用结果列表
   * @returns 格式化的文本
   */
  formatForLLM(results: ToolCallResult[]): string {
    if (results.length === 0) {
      return 'No tool calls were executed.';
    }

    if (results.length === 1) {
      const result = results[0];
      if (result.success) {
        return this.formatOutput(result.output);
      } else {
        return `执行失败: ${result.error || 'Unknown error'}`;
      }
    }

    // 多个结果的格式化
    const lines: string[] = ['## 并行执行结果\n'];
    
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      lines.push(`### 工具 ${i + 1}: ${result.toolName}`);
      
      if (result.success) {
        lines.push(`状态: 成功 (耗时 ${result.duration}ms)`);
        lines.push(`结果:\n${this.formatOutput(result.output)}`);
      } else {
        lines.push(`状态: 失败 (耗时 ${result.duration}ms)`);
        lines.push(`错误: ${result.error || 'Unknown error'}`);
        if (result.retryCount > 0) {
          lines.push(`重试次数: ${result.retryCount}`);
        }
      }
      
      lines.push('');
    }

    // 添加摘要
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;
    lines.push(`---\n摘要: ${successCount} 成功, ${failureCount} 失败`);

    return lines.join('\n');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ParallelExecutorConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('ParallelExecutor config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): ParallelExecutorConfig {
    return { ...this.config };
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ==================== 私有方法 ====================

  /**
   * 并行执行一组工具调用
   * Requirements: 1.2, 1.6 (react-parallel-bugfix) - 使用 try-finally 确保批次超时清理
   * 
   * @risk BATCH_TIMEOUT_RESOURCE_CLEANUP
   * @impact 当批次超时时，正在运行的工具调用会继续执行，槽位被释放但工具不会停止
   * @mitigation 
   *   1. 工具实现应支持 AbortController 以便取消
   *   2. 考虑实现工具级别的取消机制
   *   3. 监控超时后的资源使用情况
   */
  private async executeParallelGroup(
    calls: ToolCall[],
    interceptors: Map<string, ToolInterceptor>,
    context?: ReActExecutionContext
  ): Promise<ToolCallResult[]> {
    // 获取并发槽位
    const slotRequests: SlotRequest[] = calls.map(call => ({
      toolName: call.toolName,
      deviceId: this.extractDeviceId(call),
    }));

    let slots;
    try {
      slots = await this.concurrencyLimiter.acquireSlots(slotRequests);
    } catch (error) {
      // 并发限制超时，返回所有调用失败
      return calls.map(call => ({
        callId: call.callId,
        toolName: call.toolName,
        success: false,
        output: null,
        error: error instanceof Error ? error.message : 'Concurrency limit timeout',
        duration: 0,
        retryCount: 0,
      }));
    }

    // 创建可取消的批次超时 - Fix 1: 内存泄漏修复
    const batchTimeout = this.createBatchTimeout(calls);

    try {
      // 使用 Promise.all 并行执行
      const promises = calls.map((call, index) =>
        this.executeToolCall(call, interceptors, context, slots[index])
      );

      // 设置批次超时
      const results = await Promise.race([
        Promise.all(promises),
        batchTimeout.promise,
      ]);

      return results;
    } finally {
      // 确保批次超时被清理 - Fix 1: 内存泄漏修复
      batchTimeout.cancel();
      // 释放槽位
      this.concurrencyLimiter.releaseSlots(slots);
    }
  }

  /**
   * 执行单个工具调用
   * Requirements: 1.3, 1.4, 1.5
   * Requirements: 1.1, 1.6 (react-parallel-bugfix) - 使用 try-finally 确保超时清理
   */
  private async executeToolCall(
    call: ToolCall,
    interceptors: Map<string, ToolInterceptor>,
    context?: ReActExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _slot?: unknown
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    let retryCount = 0;
    let lastError: string | undefined;

    // 检查熔断器
    if (this.config.enableCircuitBreaker) {
      if (!this.circuitBreaker.canExecute(call.toolName)) {
        return {
          callId: call.callId,
          toolName: call.toolName,
          success: false,
          output: null,
          error: `Circuit breaker is open for tool: ${call.toolName}`,
          duration: Date.now() - startTime,
          retryCount: 0,
        };
      }
    }

    // 重试循环
    while (retryCount <= this.config.retryCount) {
      // 创建可取消的超时 - Fix 1: 内存泄漏修复
      const timeout = this.createToolTimeout(call.toolName);
      
      try {
        // 检查拦截器
        const interceptor = interceptors.get(call.toolName) || context?.toolInterceptors.get(call.toolName);
        if (interceptor) {
          const interceptResult = await interceptor(call.toolName, call.params);
          if (interceptResult.intercepted) {
            // 记录成功
            if (this.config.enableCircuitBreaker) {
              this.circuitBreaker.recordSuccess(call.toolName);
            }
            
            return {
              callId: call.callId,
              toolName: call.toolName,
              success: true,
              output: interceptResult.result,
              duration: Date.now() - startTime,
              retryCount,
              intercepted: true,
            };
          }
        }

        // 执行工具
        const tool = this.tools.get(call.toolName);
        if (!tool) {
          throw new Error(`Tool not found: ${call.toolName}`);
        }

        // 设置单个工具超时
        const result = await Promise.race([
          tool.execute(context?.tickDeviceId ? { ...call.params, tickDeviceId: context.tickDeviceId } : call.params),
          timeout.promise,
        ]);

        // 记录成功
        if (this.config.enableCircuitBreaker) {
          this.circuitBreaker.recordSuccess(call.toolName);
        }

        return {
          callId: call.callId,
          toolName: call.toolName,
          success: true,
          output: result,
          duration: Date.now() - startTime,
          retryCount,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        retryCount++;
        
        logger.warn('Tool call failed', {
          callId: call.callId,
          toolName: call.toolName,
          error: lastError,
          retryCount,
          maxRetries: this.config.retryCount,
        });

        // 如果还有重试机会，等待一小段时间
        if (retryCount <= this.config.retryCount) {
          await this.delay(100 * retryCount); // 指数退避
        }
      } finally {
        // 确保超时被清理，即使发生异常 - Fix 1: 内存泄漏修复
        timeout.cancel();
      }
    }

    // 所有重试都失败
    if (this.config.enableCircuitBreaker) {
      this.circuitBreaker.recordFailure(call.toolName);
    }

    return {
      callId: call.callId,
      toolName: call.toolName,
      success: false,
      output: null,
      error: lastError,
      duration: Date.now() - startTime,
      retryCount: retryCount - 1,
    };
  }

  /**
   * 创建可取消的工具执行超时
   * Requirements: 1.1, 1.3, 1.4 (react-parallel-bugfix)
   * 
   * 修复内存泄漏：返回可取消的超时对象，确保正常执行完成后清理 setTimeout
   * 
   * @param toolName 工具名称
   * @returns 可取消的超时对象
   */
  private createToolTimeout(toolName: string): CancellableTimeout<never> {
    let timeoutId: NodeJS.Timeout;
    
    const promise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new ParallelExecutionError(
          ParallelExecutionErrorType.TOOL_EXECUTION_ERROR,
          `Tool execution timeout: ${toolName}`,
          { toolName, timeout: this.config.toolTimeout },
          true
        ));
      }, this.config.toolTimeout);
    });
    
    const cancel = () => {
      clearTimeout(timeoutId);
    };
    
    return { promise, cancel };
  }

  /**
   * 创建可取消的批次执行超时
   * Requirements: 1.2, 1.3, 1.4 (react-parallel-bugfix)
   * 
   * 修复内存泄漏：返回可取消的超时对象，确保正常执行完成后清理 setTimeout
   * 
   * @param calls 工具调用列表
   * @returns 可取消的超时对象
   */
  private createBatchTimeout(calls: ToolCall[]): CancellableTimeout<ToolCallResult[]> {
    let timeoutId: NodeJS.Timeout;
    
    const promise = new Promise<ToolCallResult[]>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new ParallelExecutionError(
          ParallelExecutionErrorType.BATCH_TIMEOUT,
          'Batch execution timeout',
          {
            callCount: calls.length,
            timeout: this.config.batchTimeout,
          },
          true
        ));
      }, this.config.batchTimeout);
    });
    
    const cancel = () => {
      clearTimeout(timeoutId);
    };
    
    return { promise, cancel };
  }

  /**
   * 提取设备 ID
   */
  private extractDeviceId(call: ToolCall): string | undefined {
    const deviceParams = ['device_id', 'deviceId', 'device', 'host', 'hostname'];
    for (const param of deviceParams) {
      const value = call.params[param];
      if (value && typeof value === 'string') {
        return value;
      }
    }
    return undefined;
  }

  /**
   * 格式化输出
   */
  private formatOutput(output: unknown): string {
    if (output === null || output === undefined) {
      return '(无输出)';
    }
    if (typeof output === 'string') {
      return output;
    }
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 使用平衡括号匹配提取 JSON
   * Requirements: 2.1, 2.2, 2.3, 2.5 (react-parallel-bugfix)
   * 
   * 修复 JSON 解析边界情况：使用平衡括号匹配替代非贪婪正则表达式
   * 正确处理嵌套对象、字符串内的 `}` 字符和转义字符
   * 
   * @param text 包含 JSON 的文本
   * @param startIndex JSON 开始位置（{ 的位置）
   * @returns 提取的 JSON 字符串，如果无效则返回 null
   */
  private extractBalancedJson(text: string, startIndex: number): string | null {
    if (startIndex >= text.length || text[startIndex] !== '{') {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      // 处理转义字符
      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      // 在字符串内检测转义
      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      // 切换字符串状态
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      // 只在非字符串状态下计算括号深度
      if (!inString) {
        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            return text.substring(startIndex, i + 1);
          }
        }
      }
    }

    // 未找到匹配的闭合括号
    return null;
  }
}

// 导出单例实例
export const parallelExecutor = new ParallelExecutor();
