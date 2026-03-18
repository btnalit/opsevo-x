/**
 * ReactFinalAnswer - 最终答案生成模块
 *
 * 从 ReActLoopController 拆分的最终答案生成相关功能。
 * 当前阶段作为委托模块，后续可逐步将方法从主控制器迁移到此处。
 *
 * 包含方法：
 * - extractFinalAnswer
 * - generateFinalAnswerFromSteps
 * - generateForcedFinalAnswer
 * - generateDetailedFallbackAnswer
 *
 * Requirements: 8.1, 8.2
 */

import type { ReActStep } from '../../../types/ai-ops';

/**
 * 从步骤中提取收集到的数据摘要
 */
export function extractCollectedDataStandalone(steps: ReActStep[]): string {
  const observations = steps
    .filter(s => s.type === 'observation' && s.success !== false)
    .map(s => s.content);

  if (observations.length === 0) return '无收集到的数据';

  return observations
    .map((obs, i) => `[${i + 1}] ${obs.substring(0, 300)}`)
    .join('\n');
}

/**
 * 生成步骤摘要
 */
export function summarizeStepsStandalone(steps: ReActStep[]): string {
  return steps
    .filter(s => s.type === 'action' || s.type === 'thought')
    .map(s => {
      if (s.type === 'action') return `- 执行工具: ${s.toolName}`;
      return `- 思考: ${s.content.substring(0, 100)}`;
    })
    .join('\n');
}
