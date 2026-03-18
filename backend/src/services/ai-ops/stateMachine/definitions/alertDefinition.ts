/**
 * Alert 编排流程定义
 *
 * 定义 Alert 编排流程的状态机配置，包含 6 个核心状态节点 + 4 个终止/错误状态节点。
 * 转移规则：线性流程 + RateLimit/Deduplicate/Filter 条件分支（使用 outcome 匹配）
 *
 * 需求: 4.1
 */

import { StateDefinition } from '../types';

export const ALERT_DEFINITION_ID = 'alert-pipeline';

/**
 * Alert 编排流程状态定义
 *
 * 状态流程：
 *   RateLimit → Normalize → Deduplicate → Filter → Analyze → Decide
 *
 * 条件分支：
 *   RateLimit → RateLimited (outcome: 'limited')
 *   Deduplicate → Dropped (outcome: 'isDuplicate')
 *   Filter → Filtered (outcome: 'isFiltered')
 *
 * 错误处理：
 *   Normalize / Analyze → ErrorHandler
 */
export const alertDefinition: StateDefinition = {
  id: ALERT_DEFINITION_ID,
  name: 'Alert Pipeline Orchestration',
  version: '1.0.0',
  states: [
    'rateLimit',
    'normalize',
    'deduplicate',
    'filter',
    'analyze',
    'decide',
    'rateLimited',
    'dropped',
    'filtered',
    'errorHandler',
  ],
  initialState: 'rateLimit',
  terminalStates: ['decide', 'rateLimited', 'dropped', 'filtered', 'errorHandler'],
  transitions: [
    // RateLimit branch
    { from: 'rateLimit', to: 'normalize', condition: 'passed' },
    { from: 'rateLimit', to: 'rateLimited', condition: 'limited' },

    // Normalize → Deduplicate (unconditional)
    { from: 'normalize', to: 'deduplicate' },

    // Deduplicate branch
    { from: 'deduplicate', to: 'dropped', condition: 'isDuplicate' },
    { from: 'deduplicate', to: 'filter', condition: 'isUnique' },

    // Filter branch
    { from: 'filter', to: 'filtered', condition: 'isFiltered' },
    { from: 'filter', to: 'analyze', condition: 'passed' },

    // Analyze → Decide (unconditional)
    { from: 'analyze', to: 'decide' },

    // Error transitions
    { from: 'normalize', to: 'errorHandler', condition: 'error' },
    { from: 'analyze', to: 'errorHandler', condition: 'error' },
  ],
  errorState: 'errorHandler',
  maxSteps: 20,
};

/**
 * Alert 编排流程的 StateContext 扩展数据类型
 *
 * 通过 context.get/set 存取，定义各阶段写入的数据键和类型。
 */
export interface AlertStateData {
  // 输入
  'rawEvent': unknown;

  // RateLimit 阶段写入
  'rateLimitPassed': boolean;
  'aggregatedEvent': unknown | null;

  // Normalize 阶段写入
  'normalizedEvent': unknown;

  // Deduplicate 阶段写入
  'isDuplicate': boolean;

  // Filter 阶段写入
  'filterResult': unknown;

  // Analyze 阶段写入
  'rootCauseAnalysis': unknown;

  // Decide 阶段写入
  'decision': unknown;
  'remediationPlan': unknown;
  'pipelineResult': unknown;
}
