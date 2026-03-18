/**
 * ReactFailureAnalyzer - 故障分析与恢复模块
 *
 * 从 ReActLoopController 拆分的故障分析相关功能。
 * 当前阶段作为委托模块，后续可逐步将方法从主控制器迁移到此处。
 *
 * 包含方法：
 * - analyzeToolFailure
 * - performFailureAnalysis
 * - classifyFailureType
 * - generateModifiedParams
 *
 * Requirements: 8.1, 8.2
 */

import type { FailureType } from '../../../types/ai-ops';

/**
 * 分类失败类型（独立版本，可用于模块外部）
 */
export function classifyFailureTypeStandalone(errorMessage: string): FailureType {
  const msg = errorMessage.toLowerCase();

  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('permission') || msg.includes('denied') || msg.includes('unauthorized')) return 'permission';
  if (msg.includes('not found') || msg.includes('no such') || msg.includes('missing')) return 'resource';
  if (msg.includes('network') || msg.includes('connection') || msg.includes('econnrefused')) return 'network';
  if (msg.includes('parameter') || msg.includes('invalid') || msg.includes('argument')) return 'parameter_error';

  return 'unknown';
}
