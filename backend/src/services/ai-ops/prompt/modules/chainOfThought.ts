/**
 * ChainOfThought 模块 - 链式思维推理步骤模板
 *
 * 提供可参数化的推理步骤列表，引导 LLM 按步骤进行分析推理。
 * 包含预定义步骤集：告警分析、健康报告、配置变更、故障诊断、批量分析。
 *
 * @see Requirements 3.1 - 告警分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.3 - 批量告警分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.5 - 健康报告分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.6 - 配置变更分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.7 - 故障诊断包含 ChainOfThought 推理步骤
 */

import { PromptModule } from '../types';

/**
 * 链式思维推理步骤定义
 */
export interface ChainOfThoughtStep {
  /** 步骤序号 */
  order: number;
  /** 步骤标签 */
  label: string;
  /** 步骤描述 */
  description: string;
}

/**
 * 告警分析推理步骤（4步）
 * @see Requirements 3.1
 */
export const ALERT_ANALYSIS_STEPS: ChainOfThoughtStep[] = [
  { order: 1, label: '识别告警类型和严重程度', description: '分析告警名称、指标类型、严重级别和告警消息内容' },
  { order: 2, label: '分析告警根本原因', description: '基于告警消息内容分析根本原因，如有系统指标数据则结合分析' },
  { order: 3, label: '评估影响范围', description: '评估此告警对网络服务和用户的影响' },
  { order: 4, label: '制定处理建议', description: '基于分析结果给出具体的、针对性的处理步骤' },
];

/**
 * 健康报告分析推理步骤
 * @see Requirements 3.5
 */
export const HEALTH_REPORT_STEPS: ChainOfThoughtStep[] = [
  { order: 1, label: '评估整体健康状态', description: '分析健康评分和各项指标的综合状态' },
  { order: 2, label: '识别异常指标', description: '找出偏离正常范围的关键指标' },
  { order: 3, label: '分析趋势变化', description: '对比历史数据，分析指标变化趋势' },
  { order: 4, label: '制定优化建议', description: '基于分析结果给出健康改善建议' },
];

/**
 * 配置变更分析推理步骤
 * @see Requirements 3.6
 */
export const CONFIG_CHANGE_STEPS: ChainOfThoughtStep[] = [
  { order: 1, label: '识别变更内容', description: '分析配置变更的具体项目和范围' },
  { order: 2, label: '评估变更风险', description: '评估配置变更可能带来的风险和影响' },
  { order: 3, label: '验证配置一致性', description: '检查变更后的配置是否与其他配置项一致' },
  { order: 4, label: '制定回滚方案', description: '提供变更失败时的回滚建议' },
];

/**
 * 故障诊断推理步骤
 * @see Requirements 3.7
 */
export const FAULT_DIAGNOSIS_STEPS: ChainOfThoughtStep[] = [
  { order: 1, label: '收集故障现象', description: '整理故障表现、影响范围和发生时间' },
  { order: 2, label: '分析可能原因', description: '基于故障现象列举可能的根本原因' },
  { order: 3, label: '制定排查步骤', description: '按优先级制定逐步排查方案' },
  { order: 4, label: '提供修复建议', description: '针对各可能原因给出具体修复方案' },
];

/**
 * 批量告警分析推理步骤
 * @see Requirements 3.3
 */
export const BATCH_ANALYSIS_STEPS: ChainOfThoughtStep[] = [
  { order: 1, label: '告警分类汇总', description: '按类型和严重程度对批量告警进行分类统计' },
  { order: 2, label: '识别关联告警', description: '分析告警之间的关联关系和因果链' },
  { order: 3, label: '确定优先级', description: '根据影响范围和紧急程度确定处理优先级' },
  { order: 4, label: '制定批量处理方案', description: '给出批量告警的统一处理建议' },
];

/**
 * 预定义步骤集映射
 */
export const PREDEFINED_STEPS: Record<string, ChainOfThoughtStep[]> = {
  alertAnalysis: ALERT_ANALYSIS_STEPS,
  healthReport: HEALTH_REPORT_STEPS,
  configChange: CONFIG_CHANGE_STEPS,
  faultDiagnosis: FAULT_DIAGNOSIS_STEPS,
  batchAnalysis: BATCH_ANALYSIS_STEPS,
};

/**
 * 将步骤列表格式化为编号列表文本
 *
 * @param steps - 推理步骤列表
 * @returns 格式化后的编号列表字符串
 */
function formatSteps(steps: ChainOfThoughtStep[]): string {
  return steps
    .map((step) => `${step.order}. **${step.label}**：${step.description}`)
    .join('\n');
}

/**
 * ChainOfThought 模块实例
 *
 * render() 方法接受 context 参数：
 * - context.steps: string - 选择预定义步骤集的键名（如 'alertAnalysis'、'healthReport' 等）
 * - context.steps: ChainOfThoughtStep[] - 直接传入自定义步骤列表
 *
 * 默认使用告警分析步骤集。
 */
export const chainOfThought: PromptModule = {
  name: 'ChainOfThought',
  tokenBudget: 100,
  dependencies: [],
  templateName: '[模块化] ChainOfThought - 推理链',
  render(context?: Record<string, unknown>): string {
    let steps: ChainOfThoughtStep[] = ALERT_ANALYSIS_STEPS;

    if (context?.steps) {
      if (typeof context.steps === 'string') {
        // 通过键名选择预定义步骤集
        steps = PREDEFINED_STEPS[context.steps] ?? ALERT_ANALYSIS_STEPS;
      } else if (Array.isArray(context.steps)) {
        // 直接传入自定义步骤列表
        steps = context.steps as ChainOfThoughtStep[];
      }
    }

    return `## 分析推理步骤

请按以下步骤进行分析：
${formatSteps(steps)}`;
  },
};
