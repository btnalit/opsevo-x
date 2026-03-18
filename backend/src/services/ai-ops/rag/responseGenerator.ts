/**
 * ResponseGenerator - LLM 驱动的响应生成服务
 * 
 * 基于 ReAct 循环的执行结果生成自然语言响应
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4
 * - 3.1: 调用 AI_Adapter 基于工具结果和对话上下文生成自然语言响应
 * - 3.2: 综合所有工具调用结果，而非简单拼接
 * - 3.3: 包含具体的建议和下一步操作指引
 * - 3.4: 响应生成失败时返回工具结果的结构化摘要
 * 
 * Knowledge Content Summarization Requirements: 4.2, 4.3, 4.4
 * - 4.2: 集成 ToolOutputSummarizer 进行智能摘要
 * - 4.3: 错误回退逻辑
 * - 4.4: 导出新服务
 * 
 * Prompt 模板管理集成:
 * - 支持从 PromptTemplateService 动态获取提示词模板
 * - 支持模板热更新，无需重启服务
 */

import { logger } from '../../../utils/logger';
import { ReActStep, RAGContext } from '../../../types/ai-ops';
import { IAIProviderAdapter, ChatMessage, ChatRequest, AIProvider } from '../../../types/ai';
import { ConversationMemory } from './mastraAgent';
import { ToolOutputSummarizer, toolOutputSummarizer } from './toolOutputSummarizer';
import { promptTemplateService } from '../../ai/promptTemplateService';

// ==================== 提示词模板 ====================

/**
 * 提示词模板名称常量
 */
const TEMPLATE_NAME_RESPONSE_GENERATION = '响应生成提示词';

/**
 * 默认响应生成提示词模板（回退用）
 * 用于指导 LLM 基于 ReAct 步骤生成最终响应
 */
const DEFAULT_RESPONSE_GENERATION_PROMPT = `基于以下信息，生成一个完整、详细的回答。

用户请求：{{message}}

执行的步骤：
{{steps}}

工具调用结果（完整数据）：
{{results}}

请生成一个自然流畅的回答，包含：
1. 问题的分析
2. 执行的操作
3. 完整的结果说明（如果有数据列表，请完整列出所有条目的关键信息，不要省略）
4. 下一步建议（如果有）

注意：
- 使用中文回答
- 回答要完整详细，确保所有数据都被展示
- 如果有具体数据，请完整引用数据，不要省略
- 如果有问题未解决，请说明原因并给出建议
- 直接输出回答内容，不要包含任何前缀`;

// 保留原有常量用于向后兼容
const RESPONSE_GENERATION_PROMPT = DEFAULT_RESPONSE_GENERATION_PROMPT;

/**
 * 简洁响应提示词模板
 * 用于生成更简洁的响应
 */
const CONCISE_RESPONSE_PROMPT = `基于以下工具执行结果，为用户生成简洁的回答。

用户请求：{{message}}

工具执行结果：
{{results}}

要求：
- 直接回答用户的问题
- 如果有数据，简要说明关键信息
- 如果有建议，简要列出
- 不要重复用户的问题
- 直接输出回答内容`;

/**
 * 错误恢复提示词模板
 * 用于在部分工具失败时生成响应
 */
const ERROR_RECOVERY_PROMPT = `用户请求：{{message}}

部分工具执行失败，以下是可用的信息：
{{availableInfo}}

失败的操作：
{{failedOps}}

请基于可用信息生成一个有帮助的回答，并说明哪些信息无法获取。`;

// ==================== 配置类型 ====================

/**
 * ResponseGenerator 配置
 */
export interface ResponseGeneratorConfig {
  /** 响应生成超时时间（毫秒），默认 30000 */
  timeout: number;
  /** 最大响应长度（字符），默认 2000 */
  maxResponseLength: number;
  /** 是否包含详细推理过程，默认 false */
  includeDetailedReasoning: boolean;
  /** 响应风格：detailed（详细）或 concise（简洁），默认 detailed */
  responseStyle: 'detailed' | 'concise';
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ResponseGeneratorConfig = {
  timeout: 90000, // 增加到 90 秒，给 LLM 足够时间处理大量数据
  maxResponseLength: 8000, // 增加最大响应长度
  includeDetailedReasoning: false,
  responseStyle: 'detailed',
};

/**
 * 工具结果摘要
 */
interface ToolResultSummary {
  toolName: string;
  success: boolean;
  summary: string;
  keyData?: Record<string, unknown>;
}

// ==================== ResponseGenerator 类 ====================

/**
 * ResponseGenerator 类
 * 负责基于 ReAct 步骤生成最终的自然语言响应
 */
export class ResponseGenerator {
  private config: ResponseGeneratorConfig;
  private aiAdapter: IAIProviderAdapter | null = null;
  private provider: AIProvider = AIProvider.OPENAI;
  private model: string = 'gpt-4o';
  
  // 智能摘要服务
  // Requirements: 4.2 - 集成 ToolOutputSummarizer
  private toolOutputSummarizer: ToolOutputSummarizer;

  constructor(config?: Partial<ResponseGeneratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 初始化工具输出摘要器，使用 2000 字符限制
    this.toolOutputSummarizer = new ToolOutputSummarizer({
      maxCharsPerOutput: 2000, // 从 8000 降低到 2000
    });
    logger.info('ResponseGenerator created', { config: this.config });
  }

  /**
   * 设置 AI 适配器
   * @param adapter AI 适配器实例
   * @param provider AI 提供商
   * @param model 模型名称
   */
  setAIAdapter(adapter: IAIProviderAdapter, provider: AIProvider, model: string): void {
    this.aiAdapter = adapter;
    this.provider = provider;
    this.model = model;
    logger.info('ResponseGenerator AI adapter set', { provider, model });
  }

  /**
   * 生成最终答案
   * Requirements: 3.1, 3.2, 3.3, 6.2, 6.3
   * 
   * @param message 用户原始消息
   * @param steps ReAct 循环步骤
   * @param context 对话上下文
   * @param ragContext RAG 上下文（可选，用于引用知识库内容）
   * @returns 生成的自然语言响应
   */
  async generateFinalAnswer(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    ragContext?: RAGContext
  ): Promise<string> {
    // 如果没有 AI 适配器，使用回退方法
    if (!this.aiAdapter) {
      logger.warn('No AI adapter configured, using fallback response generation');
      return this.generateFallbackResponse(message, steps, ragContext);
    }

    try {
      // 构建提示词（包含 RAGContext）
      const prompt = this.buildPrompt(message, steps, context, ragContext);
      
      // 调用 LLM 生成响应
      const response = await this.callLLM(prompt, context);
      
      // 后处理响应
      const processedResponse = this.postProcessResponse(response, steps);
      
      logger.info('Final answer generated', {
        messageLength: message.length,
        stepsCount: steps.length,
        responseLength: processedResponse.length,
        hasRagContext: !!ragContext && ragContext.hasRetrieved,
      });
      
      return processedResponse;
    } catch (error) {
      // Requirement 3.4: 响应生成失败时返回结构化摘要
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('LLM response generation failed, using fallback', { error: errorMessage });
      return this.generateFallbackResponse(message, steps, ragContext);
    }
  }

  /**
   * 生成回退响应
   * Requirement 3.4, 6.3: 生成结构化摘要作为回退，引用知识库内容
   * 
   * @param message 用户原始消息
   * @param steps ReAct 循环步骤
   * @param ragContext RAG 上下文（可选）
   * @returns 结构化摘要响应
   */
  generateFallbackResponse(message: string, steps: ReActStep[], ragContext?: RAGContext): string {
    // 提取工具调用结果
    const toolResults = this.extractToolResults(steps);
    
    // 如果没有任何工具调用结果
    if (toolResults.length === 0) {
      return this.generateNoResultsResponse(message, steps);
    }

    // 分离成功和失败的结果
    const successfulResults = toolResults.filter(r => r.success);
    const failedResults = toolResults.filter(r => !r.success);

    // 构建响应
    const parts: string[] = [];

    // 添加问题分析
    parts.push(`针对您的问题"${this.truncateText(message, 50)}"，我进行了以下分析：`);
    parts.push('');

    // 添加知识库参考（Requirements: 6.3）
    if (ragContext && ragContext.hasRetrieved && ragContext.documents.length > 0) {
      parts.push('**知识库参考：**');
      for (const doc of ragContext.documents.slice(0, 3)) {
        parts.push(`- [${doc.type}] ${doc.title} (相关度: ${(doc.score * 100).toFixed(0)}%)`);
        if (doc.excerpt) {
          parts.push(`  摘要: ${this.truncateText(doc.excerpt, 100)}`);
        }
      }
      parts.push('');
    }

    // 添加成功的结果
    if (successfulResults.length > 0) {
      parts.push('**执行结果：**');
      for (const result of successfulResults) {
        parts.push(`- ${result.toolName}: ${result.summary}`);
        if (result.keyData && Object.keys(result.keyData).length > 0) {
          const dataStr = this.formatKeyData(result.keyData);
          if (dataStr) {
            parts.push(`  ${dataStr}`);
          }
        }
      }
      parts.push('');
    }

    // 添加失败的结果
    if (failedResults.length > 0) {
      parts.push('**未能完成的操作：**');
      for (const result of failedResults) {
        parts.push(`- ${result.toolName}: ${result.summary}`);
      }
      parts.push('');
    }

    // 添加建议
    const suggestions = this.generateSuggestions(message, toolResults);
    if (suggestions.length > 0) {
      parts.push('**建议：**');
      for (const suggestion of suggestions) {
        parts.push(`- ${suggestion}`);
      }
    }

    return parts.join('\n');
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 构建响应生成提示词
   * Requirements: 6.2 - 将 RAGContext 注入到提示词中
   * 
   * 模板管理集成：
   * - 优先从 PromptTemplateService 获取模板
   * - 支持模板热更新
   */
  private async buildPromptAsync(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    ragContext?: RAGContext
  ): Promise<string> {
    // 从模板服务获取提示词模板
    let template = this.config.responseStyle === 'concise' 
      ? CONCISE_RESPONSE_PROMPT 
      : RESPONSE_GENERATION_PROMPT;
    
    try {
      template = await promptTemplateService.getTemplateContent(
        TEMPLATE_NAME_RESPONSE_GENERATION,
        template
      );
    } catch (error) {
      logger.debug('Failed to get response generation template, using default', { error });
    }

    // 格式化步骤
    const stepsText = this.formatStepsForPrompt(steps);
    
    // 格式化工具结果
    const resultsText = this.formatResultsForPrompt(steps);

    // 格式化 RAG 上下文（Requirements: 6.2）
    const ragContextText = this.formatRAGContextForPrompt(ragContext);

    // 替换模板变量
    let prompt = template
      .replace('{{message}}', message)
      .replace('{{steps}}', stepsText)
      .replace('{{results}}', resultsText);

    // 如果有 RAG 上下文，添加到提示词中
    if (ragContextText) {
      prompt += `\n\n知识库参考：\n${ragContextText}\n\n请在回答中引用相关的知识库内容。`;
    }

    return prompt;
  }

  /**
   * 构建响应生成提示词（同步版本，用于向后兼容）
   * Requirements: 6.2 - 将 RAGContext 注入到提示词中
   */
  private buildPrompt(
    message: string,
    steps: ReActStep[],
    context: ConversationMemory,
    ragContext?: RAGContext
  ): string {
    // 选择提示词模板
    const template = this.config.responseStyle === 'concise' 
      ? CONCISE_RESPONSE_PROMPT 
      : RESPONSE_GENERATION_PROMPT;

    // 格式化步骤
    const stepsText = this.formatStepsForPrompt(steps);
    
    // 格式化工具结果
    const resultsText = this.formatResultsForPrompt(steps);

    // 格式化 RAG 上下文（Requirements: 6.2）
    const ragContextText = this.formatRAGContextForPrompt(ragContext);

    // 替换模板变量
    let prompt = template
      .replace('{{message}}', message)
      .replace('{{steps}}', stepsText)
      .replace('{{results}}', resultsText);

    // 如果有 RAG 上下文，添加到提示词中
    if (ragContextText) {
      prompt += `\n\n知识库参考：\n${ragContextText}\n\n请在回答中引用相关的知识库内容。`;
    }

    return prompt;
  }

  /**
   * 格式化 RAG 上下文用于提示词
   * Requirements: 6.2, 6.3
   */
  private formatRAGContextForPrompt(ragContext?: RAGContext): string {
    if (!ragContext || !ragContext.hasRetrieved || ragContext.documents.length === 0) {
      return '';
    }

    const docs = ragContext.documents.slice(0, 5); // 最多 5 个文档
    return docs.map((doc, index) => {
      return `${index + 1}. [${doc.type}] ${doc.title} (相关度: ${(doc.score * 100).toFixed(0)}%)
   摘要: ${doc.excerpt}`;
    }).join('\n\n');
  }

  /**
   * 格式化步骤用于提示词
   */
  private formatStepsForPrompt(steps: ReActStep[]): string {
    if (steps.length === 0) {
      return '无';
    }

    return steps.map((step, index) => {
      switch (step.type) {
        case 'thought':
          return `${index + 1}. 思考: ${step.content}`;
        case 'action':
          return `${index + 1}. 行动: 调用工具 ${step.toolName || '未知'}`;
        case 'observation':
          const status = step.success ? '成功' : '失败';
          const duration = step.duration ? ` (耗时 ${step.duration}ms)` : '';
          return `${index + 1}. 观察: ${status}${duration}`;
        case 'final_answer':
          return `${index + 1}. 结论: ${step.content}`;
        default:
          return `${index + 1}. ${step.content}`;
      }
    }).join('\n');
  }

  /**
   * 格式化工具结果用于提示词
   * Requirements: 4.2, 4.3 - 使用智能摘要处理工具输出
   */
  private formatResultsForPrompt(steps: ReActStep[]): string {
    const observations = steps.filter(s => s.type === 'observation');
    
    if (observations.length === 0) {
      return '无工具调用结果';
    }

    try {
      // 提取工具输出用于智能摘要
      const outputs: Array<{ toolName: string; output: unknown }> = [];
      
      for (let index = 0; index < observations.length; index++) {
        const obs = observations[index];
        const toolName = this.findToolNameForObservation(steps, index);
        outputs.push({
          toolName,
          output: obs.toolOutput,
        });
      }

      // 使用智能摘要处理工具输出
      // Requirements: 4.2 - 将单个工具输出限制从 8000 降低到 2000 字符
      const summarized = this.toolOutputSummarizer.summarize(outputs, 4000);
      
      // 格式化输出
      const result = summarized.map((s, index) => {
        const obs = observations[index];
        const status = obs.success ? '成功' : '失败';
        let output = s.summarizedOutput;
        
        // 如果被截断，添加提示
        if (s.isTruncated) {
          output += `\n[数据已智能摘要，原始大小: ${s.originalSize} 字符]`;
        }
        
        return `工具: ${s.toolName}\n状态: ${status}\n结果:\n${output}`;
      }).join('\n\n');

      logger.debug('Tool outputs summarized for prompt', {
        outputCount: outputs.length,
        totalOriginalSize: summarized.reduce((sum, s) => sum + s.originalSize, 0),
        totalSummarizedSize: summarized.reduce((sum, s) => sum + s.summarizedOutput.length, 0),
        truncatedCount: summarized.filter(s => s.isTruncated).length,
      });

      return result;
    } catch (error) {
      // Requirement 4.3: 错误回退逻辑
      logger.warn('Tool output summarization failed, using fallback', { error });
      
      // 回退到原有的简单截断逻辑
      return observations.map((obs, index) => {
        const toolName = this.findToolNameForObservation(steps, index);
        const status = obs.success ? '成功' : '失败';
        
        let output = '';
        if (obs.toolOutput !== undefined) {
          if (typeof obs.toolOutput === 'string') {
            output = obs.toolOutput;
          } else {
            try {
              output = JSON.stringify(obs.toolOutput, null, 2);
            } catch {
              output = String(obs.toolOutput);
            }
          }
          // 使用降低后的限制 2000 字符
          if (output.length > 2000) {
            output = output.substring(0, 2000) + '...[数据已截断，共' + output.length + '字符]';
          }
        }

        return `工具: ${toolName}\n状态: ${status}\n结果:\n${output}`;
      }).join('\n\n');
    }
  }

  /**
   * 查找 observation 对应的工具名称
   */
  private findToolNameForObservation(steps: ReActStep[], obsIndex: number): string {
    // 找到所有 observation 步骤
    const observations = steps.filter(s => s.type === 'observation');
    const targetObs = observations[obsIndex];
    
    if (!targetObs) {
      return '未知工具';
    }

    // 在原始步骤中找到这个 observation 的位置
    const obsPosition = steps.indexOf(targetObs);
    
    // 向前查找最近的 action 步骤
    for (let i = obsPosition - 1; i >= 0; i--) {
      if (steps[i].type === 'action' && steps[i].toolName) {
        return steps[i].toolName!;
      }
    }

    return '未知工具';
  }

  /**
   * 调用 LLM 生成响应
   */
  private async callLLM(prompt: string, context: ConversationMemory): Promise<string> {
    if (!this.aiAdapter) {
      throw new Error('AI adapter not configured');
    }

    // 构建历史消息（最近 5 条）
    // 对话意图修复：排除最后一条用户消息，因为它已经包含在 prompt 中
    let historyMessages: ChatMessage[] = context.messages
      .slice(-5)
      .map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));
    
    // 如果最后一条消息是用户消息，移除它（因为 prompt 中已包含当前用户请求）
    if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].role === 'user') {
      historyMessages = historyMessages.slice(0, -1);
    }

    const request: ChatRequest = {
      provider: this.provider,
      model: this.model,
      messages: [
        {
          role: 'system',
          content: '你是一个专业的 RouterOS 网络设备运维助手。请基于提供的信息生成清晰、有帮助的回答。',
        },
        ...historyMessages,
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature: 0.7,
      maxTokens: 4096, // 使用固定的 token 限制，确保响应完整
    };

    // 设置超时
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('响应生成超时')), this.config.timeout);
    });

    const response = await Promise.race([
      this.aiAdapter.chat(request),
      timeoutPromise,
    ]);

    return response.content;
  }

  /**
   * 后处理响应
   */
  private postProcessResponse(response: string, steps: ReActStep[]): string {
    let processed = response.trim();

    // 移除可能的前缀
    const prefixes = ['Final Answer:', 'Answer:', '回答:', '答案:'];
    for (const prefix of prefixes) {
      if (processed.startsWith(prefix)) {
        processed = processed.substring(prefix.length).trim();
      }
    }

    // 不再截断响应，让 LLM 的 maxTokens 来控制长度
    return processed;
  }

  /**
   * 提取工具调用结果
   */
  private extractToolResults(steps: ReActStep[]): ToolResultSummary[] {
    const results: ToolResultSummary[] = [];
    
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      
      if (step.type === 'observation') {
        // 查找对应的 action
        let toolName = '未知工具';
        for (let j = i - 1; j >= 0; j--) {
          if (steps[j].type === 'action' && steps[j].toolName) {
            toolName = steps[j].toolName!;
            break;
          }
        }

        results.push({
          toolName,
          success: step.success ?? false,
          summary: this.summarizeToolOutput(step.toolOutput, step.success ?? false),
          keyData: this.extractKeyData(step.toolOutput),
        });
      }
    }

    return results;
  }

  /**
   * 总结工具输出
   */
  private summarizeToolOutput(output: unknown, success: boolean): string {
    if (!success) {
      if (typeof output === 'object' && output !== null) {
        const obj = output as Record<string, unknown>;
        if ('error' in obj) {
          return `执行失败: ${obj.error}`;
        }
      }
      return '执行失败';
    }

    if (output === null || output === undefined) {
      return '执行成功，无返回数据';
    }

    if (typeof output === 'string') {
      return output.length > 100 ? output.substring(0, 100) + '...' : output;
    }

    if (typeof output === 'object') {
      const obj = output as Record<string, unknown>;
      
      // 检查常见的结果结构
      if ('results' in obj && Array.isArray(obj.results)) {
        return `找到 ${obj.results.length} 条相关记录`;
      }
      if ('data' in obj) {
        return '成功获取数据';
      }
      if ('message' in obj && typeof obj.message === 'string') {
        return obj.message;
      }
      if ('success' in obj) {
        return obj.success ? '执行成功' : '执行失败';
      }

      // 默认返回对象键数量
      const keys = Object.keys(obj);
      return `返回 ${keys.length} 个字段的数据`;
    }

    return '执行成功';
  }

  /**
   * 提取关键数据
   */
  private extractKeyData(output: unknown): Record<string, unknown> | undefined {
    if (typeof output !== 'object' || output === null) {
      return undefined;
    }

    const obj = output as Record<string, unknown>;
    const keyData: Record<string, unknown> = {};

    // 提取常见的关键字段
    const keyFields = ['cpu', 'memory', 'disk', 'status', 'count', 'total', 'usage'];
    
    for (const field of keyFields) {
      if (field in obj) {
        keyData[field] = obj[field];
      }
    }

    // 如果有 data 字段，尝试从中提取
    if ('data' in obj && typeof obj.data === 'object' && obj.data !== null) {
      const data = obj.data as Record<string, unknown>;
      for (const field of keyFields) {
        if (field in data) {
          keyData[field] = data[field];
        }
      }
    }

    return Object.keys(keyData).length > 0 ? keyData : undefined;
  }

  /**
   * 格式化关键数据
   */
  private formatKeyData(keyData: Record<string, unknown>): string {
    const parts: string[] = [];
    
    for (const [key, value] of Object.entries(keyData)) {
      if (typeof value === 'number') {
        // 格式化数字
        if (key.includes('usage') || key.includes('percent')) {
          parts.push(`${key}: ${value.toFixed(1)}%`);
        } else {
          parts.push(`${key}: ${value}`);
        }
      } else if (typeof value === 'string') {
        parts.push(`${key}: ${value}`);
      }
    }

    return parts.join(', ');
  }

  /**
   * 生成无结果时的响应
   */
  private generateNoResultsResponse(message: string, steps: ReActStep[]): string {
    const thoughts = steps.filter(s => s.type === 'thought');
    
    if (thoughts.length > 0) {
      const lastThought = thoughts[thoughts.length - 1];
      return `针对您的问题"${this.truncateText(message, 50)}"，${lastThought.content}\n\n如需更多帮助，请提供更具体的信息。`;
    }

    return `针对您的问题"${this.truncateText(message, 50)}"，我尝试进行了分析但未能获取到有效信息。请检查设备连接状态或提供更多具体信息。`;
  }

  /**
   * 生成建议
   * Requirement 3.3: 包含具体的建议和下一步操作指引
   */
  private generateSuggestions(message: string, results: ToolResultSummary[]): string[] {
    const suggestions: string[] = [];
    const lowerMessage = message.toLowerCase();

    // 基于失败的操作生成建议
    const failedResults = results.filter(r => !r.success);
    if (failedResults.length > 0) {
      suggestions.push('检查设备连接状态是否正常');
      
      for (const result of failedResults) {
        if (result.toolName === 'device_query') {
          suggestions.push('确认 RouterOS API 服务已启用');
        } else if (result.toolName === 'knowledge_search') {
          suggestions.push('尝试使用不同的关键词进行搜索');
        }
      }
    }

    // 基于消息内容生成建议
    if (lowerMessage.includes('告警') || lowerMessage.includes('问题')) {
      suggestions.push('查看告警历史以了解问题趋势');
    }
    if (lowerMessage.includes('配置') || lowerMessage.includes('设置')) {
      suggestions.push('建议在修改配置前创建配置快照');
    }
    if (lowerMessage.includes('性能') || lowerMessage.includes('慢')) {
      suggestions.push('可以使用监控工具查看详细的性能指标');
    }

    // 去重
    return [...new Set(suggestions)].slice(0, 3);
  }

  /**
   * 截断文本
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + '...';
  }

  // ==================== 配置方法 ====================

  /**
   * 获取配置
   */
  getConfig(): ResponseGeneratorConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ResponseGeneratorConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('ResponseGenerator config updated', { config: this.config });
  }

  /**
   * 检查是否已配置 AI 适配器
   */
  hasAIAdapter(): boolean {
    return this.aiAdapter !== null;
  }
}

// 导出单例实例
export const responseGenerator = new ResponseGenerator();
