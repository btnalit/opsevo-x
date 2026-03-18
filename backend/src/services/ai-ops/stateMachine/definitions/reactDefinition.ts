/**
 * ReAct 编排流程定义
 *
 * 定义 ReAct 编排流程的状态机配置，包含 8 个核心状态节点 + ErrorHandler 错误状态。
 * 转移规则：线性流程 + RoutingDecision 三路分支（FastPath / IntentDrivenExecution / ReActLoop）
 *
 * 需求: 3.1, 3.4, 3.5, 3.6
 */

import { StateDefinition } from '../types';

export const REACT_DEFINITION_ID = 'react-orchestration';

/**
 * ReAct 编排流程状态定义
 *
 * 状态流程：
 *   IntentParse → KnowledgeRetrieval → RoutingDecision
 *     → FastPath → Response
 *     → IntentDrivenExecution → PostProcessing → Response
 *     → ReActLoop → PostProcessing → Response
 *
 * 错误处理：
 *   IntentParse / KnowledgeRetrieval / IntentDrivenExecution / ReActLoop → ErrorHandler → Response
 */
export const reactDefinition: StateDefinition = {
  id: REACT_DEFINITION_ID,
  name: 'ReAct Orchestration Flow',
  version: '1.0.0',
  states: [
    'intentParse',
    'knowledgeRetrieval',
    'routingDecision',
    'fastPath',
    'intentDrivenExecution',
    'reactLoop',
    'postProcessing',
    'response',
    'errorHandler',
  ],
  initialState: 'intentParse',
  terminalStates: ['response', 'errorHandler'],
  transitions: [
    // Linear flow: IntentParse → KnowledgeRetrieval → RoutingDecision
    { from: 'intentParse', to: 'knowledgeRetrieval' },
    { from: 'knowledgeRetrieval', to: 'routingDecision' },

    // RoutingDecision 3-way branch (outcome matching)
    { from: 'routingDecision', to: 'fastPath', condition: 'fastPath' },
    { from: 'routingDecision', to: 'intentDrivenExecution', condition: 'intentDriven' },
    { from: 'routingDecision', to: 'reactLoop', condition: 'reactLoop' },

    // FastPath → Response
    { from: 'fastPath', to: 'response' },

    // IntentDrivenExecution → PostProcessing
    { from: 'intentDrivenExecution', to: 'postProcessing' },

    // ReActLoop → PostProcessing
    { from: 'reactLoop', to: 'postProcessing' },

    // PostProcessing → Response
    { from: 'postProcessing', to: 'response' },

    // Error transitions
    { from: 'intentParse', to: 'errorHandler', condition: 'error' },
    { from: 'knowledgeRetrieval', to: 'errorHandler', condition: 'error' },
    { from: 'intentDrivenExecution', to: 'errorHandler', condition: 'error' },
    { from: 'reactLoop', to: 'errorHandler', condition: 'error' },

    // ErrorHandler → Response (degraded response)
    { from: 'errorHandler', to: 'response' },
  ],
  errorState: 'errorHandler',
  maxSteps: 20,
};

/**
 * ReAct 编排流程的 StateContext 扩展数据类型
 *
 * 通过 context.get/set 存取，定义各阶段写入的数据键和类型。
 */
export interface ReActStateData {
  // 输入数据
  'message': string;
  'conversationContext': unknown;
  'executionContext': unknown;

  // IntentParse 阶段写入
  'parsedIntent': unknown;
  'intentAnalysis': unknown;

  // KnowledgeRetrieval 阶段写入
  'ragContext': unknown;
  'formattedKnowledge': unknown[];
  'knowledgeReferences': unknown[];

  // RoutingDecision 阶段写入
  'routingPath': 'fastPath' | 'intentDriven' | 'reactLoop';
  'routingConfidence': number;

  // ReActLoop / FastPath / IntentDrivenExecution 阶段写入
  'steps': unknown[];
  'finalAnswer': string;
  'iterations': number;

  // PostProcessing 阶段写入
  'validationResult': unknown;
  'reflectionResult': unknown;

  // Response 阶段写入
  'result': unknown;
}
