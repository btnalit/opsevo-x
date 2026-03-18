/**
 * Iteration 编排流程定义
 *
 * 定义 Iteration 编排流程的状态机配置，包含 4 个核心状态节点 + 3 个终止/错误状态节点。
 * 转移规则：循环流程（Decide → Execute）+ 升级/完成分支
 *
 * 需求: 5.1
 */

import { StateDefinition } from '../types';

export const ITERATION_DEFINITION_ID = 'iteration-loop';

/**
 * Iteration 编排流程状态定义
 *
 * 状态流程：
 *   Execute → Evaluate → Reflect → Decide
 *     → Execute (continue - loop back)
 *     → Escalation (escalate)
 *     → Completed (complete / maxIterations reached)
 *
 * 错误处理：
 *   Execute / Evaluate / Reflect → ErrorHandler → Escalation
 */
export const iterationDefinition: StateDefinition = {
  id: ITERATION_DEFINITION_ID,
  name: 'Iteration Loop Orchestration',
  version: '1.0.0',
  states: [
    'execute',
    'evaluate',
    'reflect',
    'decide',
    'escalation',
    'completed',
    'errorHandler',
  ],
  initialState: 'execute',
  terminalStates: ['escalation', 'completed', 'errorHandler'],
  transitions: [
    // Linear flow: Execute → Evaluate → Reflect → Decide
    { from: 'execute', to: 'evaluate' },
    { from: 'evaluate', to: 'reflect' },
    { from: 'reflect', to: 'decide' },

    // Decide branch (outcome matching)
    { from: 'decide', to: 'execute', condition: 'continue' },
    { from: 'decide', to: 'escalation', condition: 'escalate' },
    { from: 'decide', to: 'completed', condition: 'complete' },

    // Error transitions
    { from: 'execute', to: 'errorHandler', condition: 'error' },
    { from: 'evaluate', to: 'errorHandler', condition: 'error' },
    { from: 'reflect', to: 'errorHandler', condition: 'error' },

    // ErrorHandler → Escalation
    { from: 'errorHandler', to: 'escalation' },
  ],
  errorState: 'errorHandler',
  maxSteps: 50, // Allow up to ~12 iterations (4 states per iteration + overhead)
};

/**
 * Iteration 编排流程的 StateContext 扩展数据类型
 *
 * 通过 context.get/set 存取，定义各阶段写入的数据键和类型。
 */
export interface IterationStateData {
  // 输入
  'alertEvent': unknown;
  'decision': unknown;
  'currentPlan': unknown;

  // Execute 阶段写入
  'executionResults': unknown[];
  'preMetrics': unknown;
  'postMetrics': unknown;

  // Evaluate 阶段写入
  'evaluation': unknown;

  // Reflect 阶段写入
  'reflection': unknown;

  // Decide 阶段写入
  'nextAction': 'retry_same' | 'retry_modified' | 'try_alternative' | 'escalate' | 'complete' | 'rollback';
  'currentIteration': number;
  'maxIterations': number;
}
