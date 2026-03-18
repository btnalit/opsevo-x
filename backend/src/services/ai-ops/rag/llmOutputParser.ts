/**
 * LLM 输出解析器 — 纯函数模块
 *
 * 从 ReActLoopController 中提取的 LLM 输出解析逻辑，
 * 包括 Action/ActionInput/FinalAnswer 提取、JSON 修复、回退键值提取。
 *
 * 这些函数不依赖任何实例状态，可被 RALC、ActionSelector、
 * 以及未来的中间件管道共同使用。
 *
 * Requirements: 3.1-3.6, 8.3
 */

import { logger } from '../../../utils/logger';

// ==================== 类型定义 ====================

/**
 * LLM 输出解析结果
 * Requirements: 8.3 - 添加解析状态和原始输出
 */
export interface ParsedLLMOutput {
  thought: string;
  action?: string;
  actionInput?: Record<string, unknown>;
  finalAnswer?: string;
  /** 解析是否成功 */
  parseSuccess: boolean;
  /** 解析错误信息 */
  parseError?: string;
  /** 原始输出（用于调试） */
  rawOutput?: string;
}

// ==================== 核心解析函数 ====================

/**
 * 解析 LLM 输出，提取 Thought / Action / ActionInput / FinalAnswer
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.3
 */
export function parseLLMOutput(output: string): ParsedLLMOutput {
  logger.debug('parseLLMOutput: raw LLM output', { rawSnippet: output.substring(0, 500) });

  const result: ParsedLLMOutput = {
    thought: '',
    parseSuccess: true,
    rawOutput: output,
  };

  try {
    // 提取 Thought（全面兼容中英文及 Markdown 加粗）
    const thoughtMatch = output.match(/(?:Thought|思考|思考过程)\s*\*?\*?\s*[：:]\s*(.+?)(?=(?:Action|action|操作|动作|工具|Tool|Final Answer|最终答案|回答)\s*\*?\*?\s*[：:]|$)/si);
    if (thoughtMatch) {
      result.thought = thoughtMatch[1].trim();
    }

    // 提取 Final Answer（全面兼容中英文）
    const finalAnswerMatch = output.match(/(?:Final Answer|最终答案|回答|最终回答)\s*\*?\*?\s*[：:]\s*(.+?)$/si);
    if (finalAnswerMatch) {
      result.finalAnswer = finalAnswerMatch[1].trim();
      return result;
    }

    // 提取 Action（全面兼容中英文）
    const actionMatch = output.match(/(?:Action|action|操作|动作|工具|Tool)\s*\*?\*?\s*[：:]\s*([\w\-_]+)/i);
    if (actionMatch) {
      result.action = actionMatch[1].trim();
    }

    // 提取 Action Input（增强的 JSON 解析）
    const actionInputRaw = extractBalancedJson(output);
    if (actionInputRaw) {
      const rawInput = actionInputRaw;
      const parsedInput = parseActionInput(rawInput);
      if (parsedInput) {
        result.actionInput = parsedInput;
      } else {
        result.parseError = `Failed to parse Action Input: ${rawInput.substring(0, 100)}`;
        result.parseSuccess = false;
      }
    } else if (result.action) {
      // 如果有 Action 但没有 Action Input，尝试备用提取
      const fallbackInput = extractFallbackKeyValues(output);
      if (Object.keys(fallbackInput).length > 0) {
        result.actionInput = fallbackInput;
      } else {
        result.actionInput = {};
      }
    }
  } catch (error) {
    result.parseSuccess = false;
    result.parseError = error instanceof Error ? error.message : String(error);
    logger.warn('parseLLMOutput failed', { error: result.parseError, rawOutput: output.substring(0, 200) });
  }

  // 缺陷 A 修复：空参数工具调用前置验证
  if (result.action === 'execute_command') {
    const actionInput = result.actionInput || {};
    const command = actionInput['command'];
    if (!command || (typeof command === 'string' && command.trim() === '')) {
      logger.warn('parseLLMOutput: execute_command 缺少必需的 command 参数，放行交由底层报错反哺', {
        action: result.action,
        actionInput: JSON.stringify(actionInput).substring(0, 200),
      });
    }
  }

  return result;
}

// ==================== JSON 提取与修复 ====================

/**
 * 从 LLM 输出中提取平衡的 JSON 字符串
 * 使用括号计数法，正确处理字符串内的括号
 */
export function extractBalancedJson(output: string): string | null {
  // 找到 Action Input 后面的第一个 {（全面兼容中英文和 Markdown）
  const actionInputMatch = output.match(/(?:Action Input|action input|参数|输入|参数输入|工具参数)\s*\*?\*?\s*[：:]\s*/i);
  if (!actionInputMatch || actionInputMatch.index === undefined) {
    return null;
  }

  const startSearch = actionInputMatch.index + actionInputMatch[0].length;
  const braceStart = output.indexOf('{', startSearch);
  if (braceStart === -1) {
    return null;
  }

  // 括号计数，正确处理字符串内的括号
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = braceStart; i < output.length; i++) {
    const ch = output[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth === 0) {
      return output.substring(braceStart, i + 1);
    }
  }

  // 括号不平衡，回退到原有非贪婪正则（兼容性）
  const fallbackMatch = output.substring(startSearch).match(/\{[\s\S]*?\}/);
  return fallbackMatch ? fallbackMatch[0] : null;
}

/**
 * 解析 Action Input JSON 字符串，包含常见格式修复
 * Requirements: 3.2
 */
export function parseActionInput(rawInput: string): Record<string, unknown> | null {
  // 尝试直接解析
  try {
    return JSON.parse(rawInput);
  } catch {
    // 继续尝试修复
  }

  // 尝试修复常见的 JSON 格式问题
  try {
    let fixed = rawInput;

    // 1. 单引号转双引号
    fixed = fixed.replace(/'/g, '"');

    // 2. 移除尾随逗号
    fixed = fixed.replace(/,\s*}/g, '}');
    fixed = fixed.replace(/,\s*]/g, ']');

    // 3. 给未引用的键添加引号
    fixed = fixed.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

    // 4. 处理多行 JSON
    fixed = fixed.replace(/\n\s*/g, ' ');

    return JSON.parse(fixed);
  } catch {
    // 继续尝试其他方法
  }

  // 尝试提取 JSON 块（处理嵌入的换行符）
  try {
    const compacted = rawInput.replace(/\s+/g, ' ').trim();
    return JSON.parse(compacted);
  } catch {
    logger.warn('Failed to parse Action Input after all attempts', { raw: rawInput.substring(0, 100) });
    return null;
  }
}

/**
 * 回退键值提取 — 当 JSON 解析完全失败时，从原始文本中提取 key=value 或 key: value
 */
export function extractFallbackKeyValues(output: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // 匹配 key=value 格式
  const equalMatches = output.matchAll(/(\w+)\s*=\s*["']?([^"'\n,}]+)["']?/g);
  for (const match of equalMatches) {
    const key = match[1].toLowerCase();
    if (!['thought', 'action', 'final'].includes(key)) {
      result[match[1]] = match[2].trim();
    }
  }

  // 匹配 key: value 格式（排除已知的结构化键）
  const colonMatches = output.matchAll(/(?<!Thought|Action|Final Answer|工具|Tool)(\w+)[：:]\s*["']?([^"'\n,}]+)["']?/gi);
  for (const match of colonMatches) {
    const key = match[1].toLowerCase();
    if (!['thought', 'action', 'final', 'answer', 'input', '工具', 'tool'].includes(key)) {
      result[match[1]] = match[2].trim();
    }
  }

  // Fix 9: 当结果包含 command 键且值为设备命令路径时，将其他参数合并为 CLI 格式
  if (result['command'] && typeof result['command'] === 'string') {
    const cmd = result['command'] as string;
    if (cmd.startsWith('/')) {
      const otherKeys = Object.keys(result).filter(k => k !== 'command');
      if (otherKeys.length > 0) {
        const paramParts = otherKeys.map(k => `${k}=${result[k]}`);
        result['command'] = `${cmd} ${paramParts.join(' ')}`;
        for (const k of otherKeys) {
          delete result[k];
        }
        logger.debug('extractFallbackKeyValues: merged device params into CLI command', {
          mergedCommand: result['command'],
          mergedKeys: otherKeys,
        });
      }
    }
  }

  return result;
}
