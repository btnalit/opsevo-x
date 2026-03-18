/**
 * BasePersona 模块单元测试
 *
 * 验证统一人设定义、核心职责描述和 Token 预算合规。
 *
 * @see Requirements 5.1 - 统一人设为"RouterOS 智能运维助手"
 * @see Requirements 5.5 - 包含核心职责描述
 */

import { basePersona } from './basePersona';
import { PromptComposer } from '../promptComposer';

describe('BasePersona module', () => {
  it('should have the correct module name', () => {
    expect(basePersona.name).toBe('BasePersona');
  });

  it('should have a token budget of 150', () => {
    expect(basePersona.tokenBudget).toBe(150);
  });

  it('should have no dependencies', () => {
    expect(basePersona.dependencies).toEqual([]);
  });

  it('should define the unified persona as "RouterOS 智能运维助手"', () => {
    const content = basePersona.render();
    expect(content).toContain('RouterOS 智能运维助手');
  });

  it('should include the core responsibility: 设备监控与诊断', () => {
    const content = basePersona.render();
    expect(content).toContain('设备监控与诊断');
  });

  it('should include the core responsibility: 智能告警分析', () => {
    const content = basePersona.render();
    expect(content).toContain('智能告警分析');
  });

  it('should include the core responsibility: 配置管理与优化', () => {
    const content = basePersona.render();
    expect(content).toContain('配置管理与优化');
  });

  it('should include the core responsibility: 知识驱动的运维决策', () => {
    const content = basePersona.render();
    expect(content).toContain('知识驱动的运维决策');
  });

  it('should render content within the 150 token budget', () => {
    const content = basePersona.render();
    const composer = new PromptComposer([]);
    const tokens = composer.estimateTokens(content);
    expect(tokens).toBeLessThanOrEqual(basePersona.tokenBudget);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof basePersona.name).toBe('string');
    expect(typeof basePersona.tokenBudget).toBe('number');
    expect(Array.isArray(basePersona.dependencies)).toBe(true);
    expect(typeof basePersona.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = basePersona.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });
});
