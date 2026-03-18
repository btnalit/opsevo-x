/**
 * 工具修正中间件 — 修复 LLM 输出中的常见问题
 *
 * 三阶段修正：
 * 1. 悬空工具调用修复（thought 有内容但 action/finalAnswer 均空）
 * 2. 损坏 JSON 修正（parseSuccess=false 且 action 已定义）
 * 3. 工具名称模糊匹配（action 不在可用工具列表中，Levenshtein ≤ 2）
 *
 * 安全限制：单次 ReAct 循环内最多修正 3 次，防止无限修正循环。
 *
 * Requirements: 2.1-2.6, 3.1-3.6
 */

import type { ParsedLLMOutput } from '../llmOutputParser';
import { extractFallbackKeyValues } from '../llmOutputParser';
import type { MiddlewareContext, ReActMiddleware } from './types';
import { logger } from '../../../../utils/logger';

/** 单次 ReAct 循环内最大修正次数 */
const MAX_CORRECTIONS_PER_LOOP = 3;

export class ToolCorrectionMiddleware implements ReActMiddleware {
  readonly name = 'tool-correction';

  process(output: ParsedLLMOutput, context: MiddlewareContext): ParsedLLMOutput {
    // 已达修正上限，直接返回
    if (context.totalCorrectionsInLoop >= MAX_CORRECTIONS_PER_LOOP) {
      return output;
    }

    let corrected = { ...output };

    // 阶段 1: 悬空工具调用修复 (Req 2)
    corrected = this.fixDanglingToolCall(corrected, context);

    // 阶段 2: 损坏 JSON 修正 (Req 3)
    corrected = this.repairBrokenJson(corrected, context);

    // 阶段 3: 工具名称模糊匹配 (Req 3.5)
    corrected = this.fuzzyMatchToolName(corrected, context);

    return corrected;
  }

  /**
   * 悬空工具调用修复
   * 条件: thought 非空，但 action 和 finalAnswer 均为 undefined
   * 策略: 从 thought 中关键词匹配工具名 → 成功则设置 action
   *        → 失败则注入合成 finalAnswer 请求用户澄清
   */
  private fixDanglingToolCall(output: ParsedLLMOutput, context: MiddlewareContext): ParsedLLMOutput {
    // 仅在 thought 非空且 action/finalAnswer 均缺失时触发
    if (!output.thought || output.thought.trim() === '' || output.action || output.finalAnswer) {
      return output;
    }

    // 再次检查修正上限
    if (context.totalCorrectionsInLoop >= MAX_CORRECTIONS_PER_LOOP) {
      return output;
    }

    const thoughtLower = output.thought.toLowerCase();

    // 从 thought 中匹配工具名
    const matchedTool = context.availableToolNames.find(toolName =>
      thoughtLower.includes(toolName.toLowerCase()),
    );

    const corrected = { ...output };

    if (matchedTool) {
      // 找到工具名，设置 action
      corrected.action = matchedTool;
      corrected.actionInput = corrected.actionInput || {};

      logger.info('ToolCorrectionMiddleware: fixed dangling tool call', {
        matchedTool,
        thoughtSnippet: output.thought.substring(0, 100),
      });

      this.recordCorrection(context, 'dangling_tool_call', output.rawOutput || '', ['action']);
    } else {
      // 未找到工具名，注入合成 finalAnswer
      corrected.finalAnswer = '我需要更多信息来确定应该执行什么操作。请提供更具体的指令。';

      logger.info('ToolCorrectionMiddleware: injected synthetic finalAnswer for dangling call', {
        thoughtSnippet: output.thought.substring(0, 100),
      });

      this.recordCorrection(context, 'synthetic_final_answer', output.rawOutput || '', ['finalAnswer']);
    }

    return corrected;
  }

  /**
   * 损坏 JSON 修正
   * 条件: parseSuccess === false 且 action 已定义
   * 策略: 单引号→双引号 → 尾逗号移除 → 未引用键加引号 → 换行规范化 → 括号平衡
   *        → 修复后重新 JSON.parse → 失败则回退到键值提取
   */
  private repairBrokenJson(output: ParsedLLMOutput, context: MiddlewareContext): ParsedLLMOutput {
    // 仅在解析失败且有 action 时触发
    if (output.parseSuccess || !output.action) {
      return output;
    }

    if (context.totalCorrectionsInLoop >= MAX_CORRECTIONS_PER_LOOP) {
      return output;
    }

    const raw = output.rawOutput || '';
    if (!raw) return output;

    // 尝试从 rawOutput 中提取并修复 JSON
    const repaired = this.attemptJsonRepair(raw);
    if (repaired !== null) {
      const corrected = { ...output, actionInput: repaired, parseSuccess: true, parseError: undefined };

      logger.info('ToolCorrectionMiddleware: repaired broken JSON', {
        action: output.action,
        repairedKeys: Object.keys(repaired),
      });

      this.recordCorrection(context, 'json_repair', raw, ['actionInput', 'parseSuccess']);
      return corrected;
    }

    // JSON 修复失败，回退到键值提取
    const fallback = extractFallbackKeyValues(raw);
    if (Object.keys(fallback).length > 0) {
      const corrected = { ...output, actionInput: fallback, parseSuccess: true, parseError: undefined };

      logger.info('ToolCorrectionMiddleware: used fallback key-value extraction', {
        action: output.action,
        extractedKeys: Object.keys(fallback),
      });

      this.recordCorrection(context, 'json_repair', raw, ['actionInput', 'parseSuccess']);
      return corrected;
    }

    return output;
  }

  /**
   * 尝试修复损坏的 JSON 字符串
   * 修复策略：单引号→双引号 → 尾逗号 → 未引用键 → 换行 → 括号平衡
   */
  private attemptJsonRepair(raw: string): Record<string, unknown> | null {
    // 从 raw 中提取 JSON-like 片段
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) return null;

    // 找到最后一个 } 或截取到末尾
    const jsonEnd = raw.lastIndexOf('}');
    let jsonStr = jsonEnd > jsonStart ? raw.substring(jsonStart, jsonEnd + 1) : raw.substring(jsonStart);

    // 修复步骤
    // 1. 单引号 → 双引号
    jsonStr = jsonStr.replace(/'/g, '"');

    // 2. 移除尾逗号
    jsonStr = jsonStr.replace(/,\s*}/g, '}');
    jsonStr = jsonStr.replace(/,\s*]/g, ']');

    // 3. 给未引用的键添加引号
    jsonStr = jsonStr.replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');

    // 4. 换行规范化
    jsonStr = jsonStr.replace(/\n\s*/g, ' ');

    // 5. 括号平衡：补齐缺失的 }
    const openCount = (jsonStr.match(/\{/g) || []).length;
    const closeCount = (jsonStr.match(/\}/g) || []).length;
    if (openCount > closeCount) {
      jsonStr += '}'.repeat(openCount - closeCount);
    }

    try {
      return JSON.parse(jsonStr);
    } catch {
      // 最后尝试：压缩空白
      try {
        return JSON.parse(jsonStr.replace(/\s+/g, ' ').trim());
      } catch {
        return null;
      }
    }
  }

  /**
   * 工具名称模糊匹配
   * 条件: action 已定义但不在 availableToolNames 中
   * 策略: Levenshtein 距离 ≤ 2 的唯一匹配 → 修正 action 名称
   *        → 0 或多个匹配 → 不修改
   */
  private fuzzyMatchToolName(output: ParsedLLMOutput, context: MiddlewareContext): ParsedLLMOutput {
    if (!output.action) return output;

    // 已在可用列表中，无需修正
    if (context.availableToolNames.includes(output.action)) return output;

    if (context.totalCorrectionsInLoop >= MAX_CORRECTIONS_PER_LOOP) return output;

    // 查找 Levenshtein 距离 ≤ 2 的候选（缓存距离值避免重复计算）
    const candidates = context.availableToolNames
      .map(name => ({ name, distance: this.levenshteinDistance(output.action!, name) }))
      .filter(item => item.distance <= 2);

    // 仅在唯一匹配时修正
    if (candidates.length === 1) {
      const best = candidates[0];
      const corrected = { ...output, action: best.name };

      logger.info('ToolCorrectionMiddleware: fuzzy matched tool name', {
        original: output.action,
        corrected: best.name,
        distance: best.distance,
      });

      this.recordCorrection(context, 'action_fuzzy_match', output.rawOutput || '', ['action']);
      return corrected;
    }

    return output;
  }

  /**
   * 计算两个字符串的 Levenshtein 距离
   */
  private levenshteinDistance(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;

    // 快速路径
    if (la === 0) return lb;
    if (lb === 0) return la;
    if (a === b) return 0;

    // DP 矩阵（使用两行滚动数组节省内存）
    let prev = Array.from({ length: lb + 1 }, (_, i) => i);
    let curr = new Array<number>(lb + 1);

    for (let i = 1; i <= la; i++) {
      curr[0] = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // 删除
          curr[j - 1] + 1,  // 插入
          prev[j - 1] + cost, // 替换
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[lb];
  }

  /**
   * 记录修正到 context 并递增计数器
   */
  private recordCorrection(
    context: MiddlewareContext,
    correctionType: string,
    rawOutput: string,
    correctedFields: string[],
  ): void {
    context.corrections.push({
      middlewareName: this.name,
      correctionType,
      originalRaw: rawOutput.substring(0, 200),
      correctedFields,
      timestamp: Date.now(),
    });
    context.totalCorrectionsInLoop++;
  }
}
