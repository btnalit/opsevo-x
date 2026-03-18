/**
 * ReActFormat 模块单元测试
 *
 * 验证 ReAct 格式规范内容、关键格式元素和 Token 预算合规。
 *
 * @see Requirements 1.5 - ReActFormat 模块生成不超过 150 Token 的 ReAct 格式规范内容
 */

import { reActFormat } from './reActFormat';
import { PromptComposer } from '../promptComposer';

describe('ReActFormat module', () => {
  it('should have the correct module name', () => {
    expect(reActFormat.name).toBe('ReActFormat');
  });

  it('should have a token budget of 150', () => {
    expect(reActFormat.tokenBudget).toBe(150);
  });

  it('should have no dependencies', () => {
    expect(reActFormat.dependencies).toEqual([]);
  });

  it('should include the Thought format element', () => {
    const content = reActFormat.render();
    expect(content).toContain('Thought:');
  });

  it('should include the Action format element', () => {
    const content = reActFormat.render();
    expect(content).toContain('Action:');
  });

  it('should include the Action Input format element', () => {
    const content = reActFormat.render();
    expect(content).toContain('Action Input:');
  });

  it('should include the Final Answer format element', () => {
    const content = reActFormat.render();
    expect(content).toContain('Final Answer:');
  });

  it('should include the rule about one tool per step', () => {
    const content = reActFormat.render();
    expect(content).toContain('每次只能选择一个工具执行');
  });

  it('should include the rule about valid JSON format for Action Input', () => {
    const content = reActFormat.render();
    expect(content).toContain('JSON 格式');
  });

  it('should include the rule about using Chinese for responses', () => {
    const content = reActFormat.render();
    expect(content).toContain('使用中文');
  });

  it('should render content within the 150 token budget', () => {
    const content = reActFormat.render();
    const composer = new PromptComposer([]);
    const tokens = composer.estimateTokens(content);
    expect(tokens).toBeLessThanOrEqual(reActFormat.tokenBudget);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof reActFormat.name).toBe('string');
    expect(typeof reActFormat.tokenBudget).toBe('number');
    expect(Array.isArray(reActFormat.dependencies)).toBe(true);
    expect(typeof reActFormat.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = reActFormat.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });
});
