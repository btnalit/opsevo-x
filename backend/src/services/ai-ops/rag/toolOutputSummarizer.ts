/**
 * ToolOutputSummarizer - 工具输出智能摘要器
 * 
 * 负责对工具调用结果进行智能摘要处理，确保 LLM 能够理解关键信息
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 5.5
 * - 2.1: 将单个工具输出限制从 8000 字符降低到 2000 字符
 * - 2.2: 智能提取 JSON 关键字段
 * - 2.3: 在总 Token 预算内按重要性分配空间
 * - 2.4: 添加截断提示，包含原始数据大小信息
 * - 2.5: 保留数组长度信息并智能选择代表性条目
 * - 5.1: 识别并保留关键字段
 * - 5.2: 展平到最多 2 层深度
 * - 5.3: 数组保留前 3 个和最后 1 个元素
 * - 5.4: 保留 JSON 数据的类型信息
 * - 5.5: 截断大型字符串值
 */

import { logger } from '../../../utils/logger';

// ==================== 常量定义 ====================

/**
 * JSON 关键字段列表
 * Requirement 5.1: 识别并保留关键字段
 */
const KEY_FIELDS = [
  'id', 'name', 'title', 'status', 'state',
  'error', 'message', 'code',
  'count', 'total', 'size', 'length',
  'cpu', 'memory', 'disk', 'usage',
  'success', 'result', 'data',
  'type', 'category', 'level',
  'timestamp', 'createdAt', 'updatedAt',
  'ip', 'address', 'interface', 'port',
  'enabled', 'disabled', 'active',
];

/**
 * 需要保留的数组字段
 */
const ARRAY_FIELDS = [
  'results', 'items', 'list', 'records', 'entries',
  'data', 'rows', 'interfaces', 'routes', 'rules',
];

// ==================== 接口定义 ====================

/**
 * 摘要后的工具输出
 */
export interface SummarizedToolOutput {
  /** 工具名称 */
  toolName: string;
  /** 摘要后的输出 */
  summarizedOutput: string;
  /** 使用的 Token 数 */
  tokenCount: number;
  /** 是否被截断 */
  isTruncated: boolean;
  /** 原始数据大小（字符数） */
  originalSize: number;
}

/**
 * 工具输出摘要器配置
 */
export interface ToolOutputSummarizerConfig {
  /** 是否启用智能摘要，默认 true */
  enabled: boolean;
  /** 单个工具输出最大字符数，默认 2000 */
  maxCharsPerOutput: number;
  /** JSON 数组最大保留元素数，默认 5 */
  maxArrayElements: number;
  /** JSON 字符串最大长度，默认 200 */
  maxStringLength: number;
  /** JSON 最大嵌套深度，默认 2 */
  maxNestingDepth: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ToolOutputSummarizerConfig = {
  enabled: true,
  maxCharsPerOutput: 2000,
  maxArrayElements: 5,
  maxStringLength: 200,
  maxNestingDepth: 2,
};

// ==================== ToolOutputSummarizer 类 ====================

/**
 * 工具输出摘要器类
 */
export class ToolOutputSummarizer {
  private config: ToolOutputSummarizerConfig;

  constructor(config?: Partial<ToolOutputSummarizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('ToolOutputSummarizer created', { config: this.config });
  }

  /**
   * 摘要处理工具输出列表
   * Requirements: 2.1, 2.3
   * 
   * @param outputs 工具输出列表
   * @param totalBudget 总 Token 预算（可选）
   * @returns 摘要后的工具输出列表
   */
  summarize(
    outputs: Array<{ toolName: string; output: unknown }>,
    totalBudget?: number
  ): SummarizedToolOutput[] {
    if (!this.config.enabled) {
      // 禁用时使用简单截断
      return outputs.map(o => this.createSimpleSummarizedOutput(o.toolName, o.output));
    }

    if (outputs.length === 0) {
      return [];
    }

    try {
      const results: SummarizedToolOutput[] = [];
      
      // 计算每个输出的预算（防止除零）
      const budgetPerOutput = totalBudget && outputs.length > 0
        ? Math.floor(totalBudget / outputs.length)
        : this.config.maxCharsPerOutput;

      for (const { toolName, output } of outputs) {
        const summarized = this.summarizeOutput(toolName, output, budgetPerOutput);
        results.push(summarized);
      }

      logger.info('Tool outputs summarized', {
        count: outputs.length,
        totalBudget,
        totalChars: results.reduce((sum, r) => sum + r.summarizedOutput.length, 0),
        truncatedCount: results.filter(r => r.isTruncated).length,
      });

      return results;
    } catch (error) {
      logger.warn('ToolOutputSummarizer failed, using fallback', { error });
      return outputs.map(o => this.createSimpleSummarizedOutput(o.toolName, o.output));
    }
  }

  /**
   * 摘要单个工具输出
   */
  private summarizeOutput(
    toolName: string,
    output: unknown,
    maxChars: number
  ): SummarizedToolOutput {
    const originalStr = this.stringify(output);
    const originalSize = originalStr.length;

    // 如果在限制内，直接返回
    if (originalSize <= maxChars) {
      return {
        toolName,
        summarizedOutput: originalStr,
        tokenCount: this.estimateTokens(originalStr),
        isTruncated: false,
        originalSize,
      };
    }

    // 尝试智能提取
    try {
      const extracted = this.extractKeyFields(output);
      const extractedStr = this.stringify(extracted);
      
      if (extractedStr.length <= maxChars) {
        return {
          toolName,
          summarizedOutput: extractedStr,
          tokenCount: this.estimateTokens(extractedStr),
          isTruncated: true,
          originalSize,
        };
      }

      // 仍然太大，进行截断
      const truncated = this.truncateString(extractedStr, maxChars);
      return {
        toolName,
        summarizedOutput: truncated,
        tokenCount: this.estimateTokens(truncated),
        isTruncated: true,
        originalSize,
      };
    } catch (error) {
      // 回退到简单截断
      const truncated = this.truncateString(originalStr, maxChars);
      return {
        toolName,
        summarizedOutput: truncated,
        tokenCount: this.estimateTokens(truncated),
        isTruncated: true,
        originalSize,
      };
    }
  }

  /**
   * 智能提取 JSON 关键字段
   * Requirements: 2.2, 5.1, 5.4
   * 
   * @param data 原始数据
   * @returns 提取后的数据
   */
  extractKeyFields(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data !== 'object') {
      // 基本类型，检查字符串长度
      if (typeof data === 'string' && data.length > this.config.maxStringLength) {
        return this.truncateString(data, this.config.maxStringLength);
      }
      return data;
    }

    if (Array.isArray(data)) {
      return this.summarizeArray(data, this.config.maxArrayElements);
    }

    // 对象处理
    return this.extractObjectKeyFields(data as Record<string, unknown>, 0);
  }

  /**
   * 提取对象的关键字段
   * Requirement 5.2: 展平到最多 2 层深度
   */
  private extractObjectKeyFields(
    obj: Record<string, unknown>,
    depth: number
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // 检查是否是关键字段
      const isKeyField = KEY_FIELDS.some(kf => 
        key.toLowerCase().includes(kf.toLowerCase())
      );
      const isArrayField = ARRAY_FIELDS.some(af => 
        key.toLowerCase().includes(af.toLowerCase())
      );

      if (isKeyField || isArrayField || depth === 0) {
        if (value === null || value === undefined) {
          result[key] = value;
        } else if (typeof value !== 'object') {
          // 基本类型
          if (typeof value === 'string' && value.length > this.config.maxStringLength) {
            result[key] = this.truncateString(value, this.config.maxStringLength);
          } else {
            result[key] = value;
          }
        } else if (Array.isArray(value)) {
          // 数组
          result[key] = this.summarizeArray(value, this.config.maxArrayElements);
        } else if (depth < this.config.maxNestingDepth) {
          // 嵌套对象
          result[key] = this.extractObjectKeyFields(value as Record<string, unknown>, depth + 1);
        } else {
          // 超过深度限制，用类型标记替代
          result[key] = `[Object: ${Object.keys(value as object).length} keys]`;
        }
      }
    }

    // 如果结果为空但原对象不为空，保留一些基本信息
    if (Object.keys(result).length === 0 && Object.keys(obj).length > 0) {
      result['_keys'] = Object.keys(obj).slice(0, 5);
      result['_totalKeys'] = Object.keys(obj).length;
    }

    return result;
  }

  /**
   * 处理 JSON 数组
   * Requirement 5.3: 保留前 3 个和最后 1 个元素
   * 
   * @param arr 原始数组
   * @param maxElements 最大元素数
   * @returns 处理后的数组
   */
  summarizeArray(arr: unknown[], maxElements: number): unknown[] {
    if (arr.length <= maxElements) {
      // 递归处理每个元素
      return arr.map(item => this.extractKeyFields(item));
    }

    // 保留前 3 个和最后 1 个
    const keepFirst = Math.min(3, maxElements - 1);
    const result: unknown[] = [];

    // 添加前几个元素
    for (let i = 0; i < keepFirst; i++) {
      result.push(this.extractKeyFields(arr[i]));
    }

    // 计算省略的元素数量
    const omittedCount = arr.length - keepFirst - 1;
    
    // 只有当确实省略了元素时才添加省略提示
    if (omittedCount > 0) {
      result.push(`...省略 ${omittedCount} 个元素...`);
    }

    // 添加最后一个元素
    result.push(this.extractKeyFields(arr[arr.length - 1]));

    return result;
  }

  /**
   * 截断大型字符串
   * Requirements: 2.4, 5.5
   * 
   * @param str 原始字符串
   * @param maxLength 最大长度
   * @returns 截断后的字符串
   */
  truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }

    // 确保 maxLength 足够容纳截断提示
    const minLength = 30; // 最小长度，确保有足够空间放提示信息
    const effectiveMaxLength = Math.max(maxLength, minLength);
    const suffixLength = `...[共${str.length}字符]`.length;
    const truncateAt = Math.max(1, effectiveMaxLength - suffixLength);
    
    const truncated = str.substring(0, truncateAt);
    return `${truncated}...[共${str.length}字符]`;
  }

  /**
   * 展平嵌套对象
   * Requirement 5.2: 展平到最多 2 层深度
   * 
   * @param obj 原始对象
   * @param maxDepth 最大深度
   * @returns 展平后的对象
   */
  flattenObject(
    obj: Record<string, unknown>,
    maxDepth: number
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const seen = new WeakSet<object>(); // 用于检测循环引用
    
    const flatten = (
      current: Record<string, unknown>,
      prefix: string,
      depth: number
    ) => {
      // 检测循环引用
      if (seen.has(current)) {
        result[prefix || '_root'] = '[Circular Reference]';
        return;
      }
      seen.add(current);
      
      for (const [key, value] of Object.entries(current)) {
        const newKey = prefix ? `${prefix}.${key}` : key;
        
        if (value === null || value === undefined || typeof value !== 'object') {
          result[newKey] = value;
        } else if (Array.isArray(value)) {
          result[newKey] = `[Array: ${value.length} items]`;
        } else if (depth < maxDepth) {
          flatten(value as Record<string, unknown>, newKey, depth + 1);
        } else {
          result[newKey] = `[Object: ${Object.keys(value as object).length} keys]`;
        }
      }
    };

    flatten(obj, '', 0);
    return result;
  }

  /**
   * 将数据转换为字符串
   */
  private stringify(data: unknown): string {
    if (data === null || data === undefined) {
      return String(data);
    }
    
    if (typeof data === 'string') {
      return data;
    }
    
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  /**
   * 估算 Token 数
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    
    // 简单估算
    let tokens = 0;
    const chinesePattern = /[\u4e00-\u9fa5]/g;
    const chineseChars = text.match(chinesePattern) || [];
    tokens += chineseChars.length;
    
    const withoutChinese = text.replace(chinesePattern, ' ');
    const words = withoutChinese.split(/\s+/).filter(w => w.length > 0);
    tokens += words.length;
    
    return tokens;
  }

  /**
   * 创建简单摘要的输出（回退方法）
   */
  private createSimpleSummarizedOutput(
    toolName: string,
    output: unknown
  ): SummarizedToolOutput {
    const originalStr = this.stringify(output);
    const originalSize = originalStr.length;
    
    if (originalSize <= this.config.maxCharsPerOutput) {
      return {
        toolName,
        summarizedOutput: originalStr,
        tokenCount: this.estimateTokens(originalStr),
        isTruncated: false,
        originalSize,
      };
    }

    const truncated = this.truncateString(originalStr, this.config.maxCharsPerOutput);
    return {
      toolName,
      summarizedOutput: truncated,
      tokenCount: this.estimateTokens(truncated),
      isTruncated: true,
      originalSize,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): ToolOutputSummarizerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ToolOutputSummarizerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('ToolOutputSummarizer config updated', { config: this.config });
  }
}

// 导出单例实例
export const toolOutputSummarizer = new ToolOutputSummarizer();
