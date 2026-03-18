/**
 * 中间件管道核心类型定义
 *
 * 定义 ReAct 中间件系统的接口和数据结构。
 * 中间件在 selectAction() 内部 parseLLMOutput() 返回后、action 分发前执行，
 * 可修正 LLM 输出中的常见问题（悬空调用、损坏 JSON、工具名拼写错误等）。
 *
 * Requirements: 1.4, 1.5, 1.7
 */

import type { ParsedLLMOutput } from '../llmOutputParser';
import type { SkillContext } from '../reactLoopController';

/**
 * 中间件修正记录
 */
export interface MiddlewareCorrection {
  /** 中间件名称 */
  middlewareName: string;
  /** 修正类型: dangling_tool_call | json_repair | action_fuzzy_match | synthetic_final_answer */
  correctionType: string;
  /** 原始 rawOutput 片段（截断到 200 字符） */
  originalRaw: string;
  /** 被修正的字段列表 */
  correctedFields: string[];
  /** 时间戳 */
  timestamp: number;
}

/**
 * 中间件上下文 — 每次 pipeline 执行时创建，传递给每个中间件
 */
export interface MiddlewareContext {
  /** 当前 ReAct 步骤索引（从 0 开始） */
  stepIndex: number;
  /** 用户原始消息 */
  userMessage: string;
  /** 当前可用工具名称列表 */
  availableToolNames: string[];
  /** Skill 上下文（Brain 调用时为 undefined） */
  skillContext?: SkillContext;
  /** 本次 pipeline 执行中累积的修正记录 */
  corrections: MiddlewareCorrection[];
  /** 本次 ReAct 循环中所有中间件的累计修正次数（跨迭代） */
  totalCorrectionsInLoop: number;
}

/**
 * ReAct 中间件接口
 */
export interface ReActMiddleware {
  /** 中间件唯一名称 */
  readonly name: string;

  /**
   * 处理 ParsedLLMOutput，返回（可能修正过的）ParsedLLMOutput
   * 中间件不应抛出异常；如果抛出，pipeline 会跳过该中间件并继续
   */
  process(output: ParsedLLMOutput, context: MiddlewareContext): ParsedLLMOutput | Promise<ParsedLLMOutput>;
}

/**
 * 中间件注册条目（内部使用）
 */
export interface MiddlewareEntry {
  middleware: ReActMiddleware;
  priority: number;
}
