/**
 * ChainOfThought 模块单元测试
 *
 * 验证链式思维推理步骤模板的正确性、参数化能力和 Token 预算合规。
 *
 * @see Requirements 3.1 - 告警分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.3 - 批量告警分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.5 - 健康报告分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.6 - 配置变更分析包含 ChainOfThought 推理步骤
 * @see Requirements 3.7 - 故障诊断包含 ChainOfThought 推理步骤
 */

import {
  chainOfThought,
  ChainOfThoughtStep,
  ALERT_ANALYSIS_STEPS,
  HEALTH_REPORT_STEPS,
  CONFIG_CHANGE_STEPS,
  FAULT_DIAGNOSIS_STEPS,
  BATCH_ANALYSIS_STEPS,
  PREDEFINED_STEPS,
} from './chainOfThought';
import { PromptComposer } from '../promptComposer';

describe('ChainOfThought module', () => {
  describe('module metadata', () => {
    it('should have the correct module name', () => {
      expect(chainOfThought.name).toBe('ChainOfThought');
    });

    it('should have a token budget of 100', () => {
      expect(chainOfThought.tokenBudget).toBe(100);
    });

    it('should have no dependencies', () => {
      expect(chainOfThought.dependencies).toEqual([]);
    });

    it('should implement the PromptModule interface correctly', () => {
      expect(typeof chainOfThought.name).toBe('string');
      expect(typeof chainOfThought.tokenBudget).toBe('number');
      expect(Array.isArray(chainOfThought.dependencies)).toBe(true);
      expect(typeof chainOfThought.render).toBe('function');
    });
  });

  describe('predefined step sets', () => {
    it('should define alert analysis steps with 4 steps', () => {
      expect(ALERT_ANALYSIS_STEPS).toHaveLength(4);
      expect(ALERT_ANALYSIS_STEPS[0].label).toBe('识别告警类型和严重程度');
      expect(ALERT_ANALYSIS_STEPS[1].label).toBe('分析告警根本原因');
      expect(ALERT_ANALYSIS_STEPS[2].label).toBe('评估影响范围');
      expect(ALERT_ANALYSIS_STEPS[3].label).toBe('制定处理建议');
    });

    it('should define health report steps', () => {
      expect(HEALTH_REPORT_STEPS.length).toBeGreaterThan(0);
      expect(HEALTH_REPORT_STEPS.every((s) => s.order > 0 && s.label && s.description)).toBe(true);
    });

    it('should define config change steps', () => {
      expect(CONFIG_CHANGE_STEPS.length).toBeGreaterThan(0);
      expect(CONFIG_CHANGE_STEPS.every((s) => s.order > 0 && s.label && s.description)).toBe(true);
    });

    it('should define fault diagnosis steps', () => {
      expect(FAULT_DIAGNOSIS_STEPS.length).toBeGreaterThan(0);
      expect(FAULT_DIAGNOSIS_STEPS.every((s) => s.order > 0 && s.label && s.description)).toBe(true);
    });

    it('should define batch analysis steps', () => {
      expect(BATCH_ANALYSIS_STEPS.length).toBeGreaterThan(0);
      expect(BATCH_ANALYSIS_STEPS.every((s) => s.order > 0 && s.label && s.description)).toBe(true);
    });

    it('should have all predefined step sets in the PREDEFINED_STEPS map', () => {
      expect(PREDEFINED_STEPS).toHaveProperty('alertAnalysis');
      expect(PREDEFINED_STEPS).toHaveProperty('healthReport');
      expect(PREDEFINED_STEPS).toHaveProperty('configChange');
      expect(PREDEFINED_STEPS).toHaveProperty('faultDiagnosis');
      expect(PREDEFINED_STEPS).toHaveProperty('batchAnalysis');
    });

    it('should have sequential order numbers in all step sets', () => {
      const allStepSets = [
        ALERT_ANALYSIS_STEPS,
        HEALTH_REPORT_STEPS,
        CONFIG_CHANGE_STEPS,
        FAULT_DIAGNOSIS_STEPS,
        BATCH_ANALYSIS_STEPS,
      ];
      for (const steps of allStepSets) {
        steps.forEach((step, index) => {
          expect(step.order).toBe(index + 1);
        });
      }
    });
  });

  describe('render()', () => {
    it('should return a non-empty string', () => {
      const content = chainOfThought.render();
      expect(content.trim().length).toBeGreaterThan(0);
    });

    it('should default to alert analysis steps when no context provided', () => {
      const content = chainOfThought.render();
      expect(content).toContain('识别告警类型和严重程度');
      expect(content).toContain('分析告警根本原因');
      expect(content).toContain('评估影响范围');
      expect(content).toContain('制定处理建议');
    });

    it('should default to alert analysis steps when context has no steps key', () => {
      const content = chainOfThought.render({ otherKey: 'value' });
      expect(content).toContain('识别告警类型和严重程度');
    });

    it('should select predefined steps by string key', () => {
      const content = chainOfThought.render({ steps: 'healthReport' });
      expect(content).toContain('评估整体健康状态');
      expect(content).not.toContain('识别告警类型和严重程度');
    });

    it('should select config change steps by string key', () => {
      const content = chainOfThought.render({ steps: 'configChange' });
      expect(content).toContain('识别变更内容');
      expect(content).toContain('评估变更风险');
    });

    it('should select fault diagnosis steps by string key', () => {
      const content = chainOfThought.render({ steps: 'faultDiagnosis' });
      expect(content).toContain('收集故障现象');
      expect(content).toContain('提供修复建议');
    });

    it('should select batch analysis steps by string key', () => {
      const content = chainOfThought.render({ steps: 'batchAnalysis' });
      expect(content).toContain('告警分类汇总');
      expect(content).toContain('制定批量处理方案');
    });

    it('should fall back to alert analysis for unknown string key', () => {
      const content = chainOfThought.render({ steps: 'unknownType' });
      expect(content).toContain('识别告警类型和严重程度');
    });

    it('should accept custom steps array', () => {
      const customSteps: ChainOfThoughtStep[] = [
        { order: 1, label: '自定义步骤一', description: '第一步描述' },
        { order: 2, label: '自定义步骤二', description: '第二步描述' },
      ];
      const content = chainOfThought.render({ steps: customSteps });
      expect(content).toContain('自定义步骤一');
      expect(content).toContain('自定义步骤二');
      expect(content).not.toContain('识别告警类型和严重程度');
    });

    it('should format steps as numbered list', () => {
      const content = chainOfThought.render();
      expect(content).toMatch(/1\.\s+\*\*识别告警类型和严重程度\*\*/);
      expect(content).toMatch(/2\.\s+\*\*分析告警根本原因\*\*/);
      expect(content).toMatch(/3\.\s+\*\*评估影响范围\*\*/);
      expect(content).toMatch(/4\.\s+\*\*制定处理建议\*\*/);
    });

    it('should include section header', () => {
      const content = chainOfThought.render();
      expect(content).toContain('## 分析推理步骤');
    });
  });

  describe('token budget compliance', () => {
    const composer = new PromptComposer([]);

    it('should render default content within the 100 token budget', () => {
      const content = chainOfThought.render();
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(chainOfThought.tokenBudget);
    });

    it('should render alert analysis steps within budget', () => {
      const content = chainOfThought.render({ steps: 'alertAnalysis' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(chainOfThought.tokenBudget);
    });

    it('should render health report steps within budget', () => {
      const content = chainOfThought.render({ steps: 'healthReport' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(chainOfThought.tokenBudget);
    });

    it('should render config change steps within budget', () => {
      const content = chainOfThought.render({ steps: 'configChange' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(chainOfThought.tokenBudget);
    });

    it('should render fault diagnosis steps within budget', () => {
      const content = chainOfThought.render({ steps: 'faultDiagnosis' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(chainOfThought.tokenBudget);
    });

    it('should render batch analysis steps within budget', () => {
      const content = chainOfThought.render({ steps: 'batchAnalysis' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(chainOfThought.tokenBudget);
    });
  });
});
