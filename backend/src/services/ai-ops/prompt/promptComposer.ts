/**
 * PromptComposer - Prompt 组合器
 *
 * 负责将多个 PromptModule 按需组合为完整的 Prompt，
 * 支持段落级去重、模板变量替换、动态上下文注入和 Token 估算。
 *
 * @see Requirements 1.2 - compose 方法按声明顺序组合模块
 * @see Requirements 1.3 - 自动去除模块间的重复内容段落
 * @see Requirements 4.1 - injectContext 方法注入动态上下文
 */

import { PromptModule, DynamicContext, ComposeOptions } from './types';

export class PromptComposer {
  constructor(private modules: PromptModule[]) { }

  /**
   * 按声明顺序组合模块为完整 Prompt
   *
   * 1. 按顺序调用各模块的 render() 方法生成内容片段
   * 2. 用双换行符连接各模块输出
   * 3. 如果启用去重（默认启用），执行段落级去重
   * 4. 如果提供了变量，替换 {{key}} 模式的占位符
   *
   * @param options - 组合选项（变量替换、去重开关）
   * @returns 组合后的完整 Prompt 字符串
   *
   * @see Requirements 1.2 - 按声明顺序组合
   * @see Requirements 1.3 - 段落级去重
   */
  compose(options?: ComposeOptions): string {
    const deduplication = options?.deduplication ?? true;
    const variables = options?.variables;

    // 按声明顺序调用各模块的 render() 生成内容
    const renderedParts = this.modules
      .map((mod) => mod.render())
      .filter((content) => content.trim().length > 0);

    // 用双换行符连接各模块输出
    let result = renderedParts.join('\n\n');

    // 段落级去重：以空行分隔的文本块为单位
    if (deduplication) {
      result = this.deduplicateParagraphs(result);
    }

    // 模板变量替换：替换 {{key}} 模式
    if (variables) {
      result = this.replaceVariables(result, variables);
    }

    return result;
  }

  /**
   * 注入动态上下文到已组合的 Prompt 中
   *
   * 根据 DynamicContext 中的条件，有选择地注入上下文信息：
   * - healthScore < 60 时注入健康状态摘要
   * - activeAlerts 非空时注入最近 5 条告警摘要
   * - anomalyPredictions 非空时注入预测摘要
   *
   * 完整实现将在 Task 5.1 中完成，当前提供基本结构。
   *
   * @param prompt - 已组合的 Prompt 字符串
   * @param context - 动态上下文对象
   * @returns 注入上下文后的 Prompt 字符串
   *
   * @see Requirements 4.1 - injectContext 方法
   * @see Requirements 4.2 - 健康评分低于 60 时注入健康摘要
   * @see Requirements 4.3 - 存在活跃告警时注入告警摘要
   * @see Requirements 4.4 - 存在预测结果时注入预测摘要
   */
  injectContext(prompt: string, context: DynamicContext): string {
    const sections: string[] = [];

    // 健康评分低于 60 时注入健康状态摘要
    if (
      context.healthScore !== undefined &&
      context.healthScore < 60
    ) {
      const riskInfo =
        context.riskIndicators && context.riskIndicators.length > 0
          ? `，主要风险指标：${context.riskIndicators.join('、')}`
          : '';
      sections.push(
        `[当前设备健康状态] 健康评分：${context.healthScore}/100${riskInfo}`
      );
    }

    // 存在活跃告警时注入最近 5 条告警摘要
    if (context.activeAlerts && context.activeAlerts.length > 0) {
      const alerts = context.activeAlerts.slice(0, 5);
      const alertLines = alerts.map(
        (a) => `- [${a.severity}] ${a.name}: ${a.message}`
      );
      sections.push(
        `[活跃告警] 共 ${alerts.length} 条：\n${alertLines.join('\n')}`
      );
    }

    // 存在异常预测时注入预测摘要
    if (
      context.anomalyPredictions &&
      context.anomalyPredictions.length > 0
    ) {
      const predLines = context.anomalyPredictions.map(
        (p) =>
          `- ${p.type}（置信度：${(p.confidence * 100).toFixed(0)}%）：${p.description}`
      );
      sections.push(
        `[异常预测] 共 ${context.anomalyPredictions.length} 条：\n${predLines.join('\n')}`
      );
    }

    // 存在改进建议时注入
    if (
      context.improvementSuggestions &&
      context.improvementSuggestions.length > 0
    ) {
      const suggestionLines = context.improvementSuggestions.map(
        (s) => `- ${s.advice} (原因: ${s.reason})`
      );
      sections.push(
        `[历史改进建议] (请在制定计划时避免重复类似的错误)：\n${suggestionLines.join('\n')}`
      );
    }

    // 存在工具统计信息时注入
    if (
      context.toolStats &&
      context.toolStats.length > 0
    ) {
      const statLines = context.toolStats.map(
        (t) => `- ${t.toolName} - 成功率: ${(t.successRate * 100).toFixed(1)}% (总调用: ${t.totalCalls}次)`
      );
      sections.push(
        `[工具可靠性统计] (请优先使用成功率高的工具)：\n${statLines.join('\n')}`
      );
    }

    // 如果没有需要注入的上下文，直接返回原始 Prompt
    if (sections.length === 0) {
      return prompt;
    }

    const contextBlock = `\n\n---\n## 运行时上下文\n${sections.join('\n\n')}\n---`;
    return prompt + contextBlock;
  }

  /**
   * 估算文本的 Token 数
   *
   * 使用启发式方法分别计算中文和非中文字符的 Token 数：
   * - 中文字符：约 1.5 字符/Token
   * - 非中文字符（英文等）：约 4 字符/Token
   *
   * @param text - 待估算的文本
   * @returns 估算的 Token 数
   */
  estimateTokens(text: string): number {
    if (!text) {
      return 0;
    }

    // 匹配中文字符（CJK 统一表意文字）
    const chineseRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
    const chineseChars = text.match(chineseRegex);
    const chineseCount = chineseChars ? chineseChars.length : 0;

    // 非中文字符数
    const nonChineseCount = text.length - chineseCount;

    // 中文约 1.5 字符/Token，非中文约 4 字符/Token
    const chineseTokens = chineseCount / 1.5;
    const nonChineseTokens = nonChineseCount / 4;

    return Math.ceil(chineseTokens + nonChineseTokens);
  }

  /**
   * 段落级去重
   *
   * 将文本按空行分割为段落，移除重复段落（保留首次出现的）。
   *
   * @param text - 待去重的文本
   * @returns 去重后的文本
   */
  private deduplicateParagraphs(text: string): string {
    // 按空行（连续两个或以上换行）分割为段落
    const paragraphs = text.split(/\n\s*\n/);
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const paragraph of paragraphs) {
      // 标准化段落内容用于比较（去除首尾空白）
      const normalized = paragraph.trim();
      if (normalized.length === 0) {
        continue;
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    }

    return unique.join('\n\n');
  }

  /**
   * 模板变量替换
   *
   * 替换文本中的 {{key}} 模式为对应的变量值。
   *
   * @param text - 待替换的文本
   * @param variables - 变量映射
   * @returns 替换后的文本
   */
  private replaceVariables(
    text: string,
    variables: Record<string, string>
  ): string {
    let result = text;
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      result = result.replace(pattern, value);
    }
    return result;
  }
}
