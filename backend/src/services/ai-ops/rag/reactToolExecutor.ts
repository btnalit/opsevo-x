/**
 * ReactToolExecutor - 工具执行与结果处理模块
 *
 * 从 ReActLoopController 拆分的工具执行相关功能。
 * 当前阶段作为委托模块，后续可逐步将方法从主控制器迁移到此处。
 *
 * 包含方法：
 * - executeAction
 * - selectAction
 * - generateToolInput
 * - isToolResultSuccess
 * - formatObservation
 *
 * Requirements: 8.1, 8.2
 */

/**
 * 判断工具执行结果是否成功
 */
export function isToolResultSuccessStandalone(result: unknown): boolean {
  if (result === null || result === undefined) return false;

  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if ('error' in obj && obj.error) return false;
    if ('success' in obj && obj.success === false) return false;
  }

  return true;
}

/**
 * 格式化工具输出为观察文本
 */
export function formatObservationStandalone(output: unknown, success: boolean): string {
  if (!success) {
    return `Error: ${typeof output === 'string' ? output : JSON.stringify(output)}`;
  }

  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return 'No output';

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
