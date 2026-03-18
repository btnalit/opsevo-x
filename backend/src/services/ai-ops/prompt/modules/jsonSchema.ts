/**
 * JsonSchema 模块 - JSON Schema 输出约束模板
 *
 * 提供可参数化的 JSON Schema 字段定义，强化 LLM 的 JSON 输出约束。
 * 包含预定义 Schema：告警分析、批量分析、健康报告、配置变更、故障诊断。
 *
 * @see Requirements 3.2 - 告警分析包含显式 JSON Schema 定义
 * @see Requirements 3.3 - 批量告警分析包含显式 JSON Schema 定义
 */

import { PromptModule } from '../types';

/**
 * JSON Schema 字段定义
 */
export interface JsonSchemaField {
  /** 字段名称 */
  name: string;
  /** 字段类型 */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** 字段描述 */
  description: string;
  /** 是否必填 */
  required: boolean;
  /** 约束条件（如 "low|medium|high", "0-1"） */
  constraints?: string;
}

/**
 * 告警分析 JSON Schema
 * @see Requirements 3.2
 */
export const ALERT_ANALYSIS_SCHEMA: JsonSchemaField[] = [
  { name: 'summary', type: 'string', description: '问题概述（一句话总结）', required: true },
  { name: 'problemAnalysis', type: 'string', description: '问题分析（详细说明可能的原因）', required: true },
  { name: 'impactAssessment', type: 'string', description: '影响评估', required: true },
  { name: 'recommendations', type: 'array', description: '处理建议列表', required: true },
  { name: 'riskLevel', type: 'string', description: '风险等级', required: true, constraints: 'low|medium|high' },
  { name: 'confidence', type: 'number', description: '置信度', required: true, constraints: '0-1' },
];

/**
 * 批量告警分析 JSON Schema
 * @see Requirements 3.3
 */
export const BATCH_ANALYSIS_SCHEMA: JsonSchemaField[] = [
  { name: 'overallSummary', type: 'string', description: '批量告警总体概述', required: true },
  { name: 'alertGroups', type: 'array', description: '告警分组分析列表', required: true },
  { name: 'correlations', type: 'array', description: '告警关联关系', required: true },
  { name: 'priorityOrder', type: 'array', description: '处理优先级排序', required: true },
  { name: 'recommendations', type: 'array', description: '批量处理建议', required: true },
  { name: 'riskLevel', type: 'string', description: '整体风险等级', required: true, constraints: 'low|medium|high' },
];

/**
 * 健康报告 JSON Schema
 * @see Requirements 3.5
 */
export const HEALTH_REPORT_SCHEMA: JsonSchemaField[] = [
  { name: 'summary', type: 'string', description: '健康状态总结', required: true },
  { name: 'healthScore', type: 'number', description: '综合健康评分', required: true, constraints: '0-100' },
  { name: 'abnormalIndicators', type: 'array', description: '异常指标列表', required: true },
  { name: 'trendAnalysis', type: 'string', description: '趋势分析', required: true },
  { name: 'recommendations', type: 'array', description: '优化建议列表', required: true },
  { name: 'riskLevel', type: 'string', description: '风险等级', required: true, constraints: 'low|medium|high' },
];

/**
 * 配置变更 JSON Schema
 * @see Requirements 3.6
 */
export const CONFIG_CHANGE_SCHEMA: JsonSchemaField[] = [
  { name: 'summary', type: 'string', description: '变更概述', required: true },
  { name: 'changeDetails', type: 'array', description: '变更详情列表', required: true },
  { name: 'riskAssessment', type: 'string', description: '风险评估', required: true },
  { name: 'consistencyCheck', type: 'string', description: '一致性检查结果', required: true },
  { name: 'rollbackPlan', type: 'string', description: '回滚方案', required: true },
  { name: 'riskLevel', type: 'string', description: '风险等级', required: true, constraints: 'low|medium|high' },
];

/**
 * 故障诊断 JSON Schema
 * @see Requirements 3.7
 */
export const FAULT_DIAGNOSIS_SCHEMA: JsonSchemaField[] = [
  { name: 'summary', type: 'string', description: '故障概述', required: true },
  { name: 'symptoms', type: 'array', description: '故障现象列表', required: true },
  { name: 'possibleCauses', type: 'array', description: '可能原因列表', required: true },
  { name: 'diagnosticSteps', type: 'array', description: '排查步骤', required: true },
  { name: 'recommendations', type: 'array', description: '修复建议', required: true },
  { name: 'riskLevel', type: 'string', description: '风险等级', required: true, constraints: 'low|medium|high' },
  { name: 'confidence', type: 'number', description: '诊断置信度', required: true, constraints: '0-1' },
];

/**
 * 预定义 Schema 映射
 */
export const PREDEFINED_SCHEMAS: Record<string, JsonSchemaField[]> = {
  alertAnalysis: ALERT_ANALYSIS_SCHEMA,
  batchAnalysis: BATCH_ANALYSIS_SCHEMA,
  healthReport: HEALTH_REPORT_SCHEMA,
  configChange: CONFIG_CHANGE_SCHEMA,
  faultDiagnosis: FAULT_DIAGNOSIS_SCHEMA,
};

/**
 * 将 Schema 字段列表格式化为紧凑的字段定义文本
 *
 * 使用紧凑格式以控制 Token 预算：每个字段一行，格式为
 * - fieldName (type, required/optional): description [constraints]
 *
 * @param fields - Schema 字段列表
 * @returns 格式化后的字段定义字符串
 */
function formatSchema(fields: JsonSchemaField[]): string {
  const lines = fields.map((field) => {
    const req = field.required ? '必填' : '可选';
    const constraint = field.constraints ? ` [${field.constraints}]` : '';
    return `- ${field.name} (${field.type}, ${req}): ${field.description}${constraint}`;
  });
  return lines.join('\n');
}

/**
 * JsonSchema 模块实例
 *
 * render() 方法接受 context 参数：
 * - context.schema: string - 选择预定义 Schema 的键名（如 'alertAnalysis'、'healthReport' 等）
 * - context.schema: JsonSchemaField[] - 直接传入自定义 Schema 字段列表
 *
 * 默认使用告警分析 Schema。
 */
export const jsonSchema: PromptModule = {
  name: 'JsonSchema',
  tokenBudget: 100,
  dependencies: [],
  render(context?: Record<string, unknown>): string {
    let schema: JsonSchemaField[] = ALERT_ANALYSIS_SCHEMA;

    if (context?.schema) {
      if (typeof context.schema === 'string') {
        // 通过键名选择预定义 Schema
        schema = PREDEFINED_SCHEMAS[context.schema] ?? ALERT_ANALYSIS_SCHEMA;
      } else if (Array.isArray(context.schema)) {
        // 直接传入自定义 Schema 字段列表
        schema = context.schema as JsonSchemaField[];
      }
    }

    return `## 输出格式要求

请严格按照以下字段定义输出 JSON：
${formatSchema(schema)}`;
  },
};
