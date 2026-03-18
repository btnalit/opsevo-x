/**
 * ParallelFormat 模块单元测试
 *
 * 验证并行执行编号格式、并行规则、最大并发数占位符、
 * ReActFormat 依赖声明和 Token 预算合规。
 *
 * @see Requirements 1.9 - PARALLEL_REACT_PROMPT 模块化重构
 */

import { parallelFormat } from './parallelFormat';
import { PromptComposer } from '../promptComposer';

describe('ParallelFormat module', () => {
  it('should have the correct module name', () => {
    expect(parallelFormat.name).toBe('ParallelFormat');
  });

  it('should have a token budget of 150', () => {
    expect(parallelFormat.tokenBudget).toBe(150);
  });

  it('should declare ReActFormat as a dependency', () => {
    expect(parallelFormat.dependencies).toEqual(['ReActFormat']);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof parallelFormat.name).toBe('string');
    expect(typeof parallelFormat.tokenBudget).toBe('number');
    expect(Array.isArray(parallelFormat.dependencies)).toBe(true);
    expect(typeof parallelFormat.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = parallelFormat.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('should include the parallel execution mode header', () => {
    const content = parallelFormat.render();
    expect(content).toContain('并行执行模式');
  });

  it('should include the numbered Action format', () => {
    const content = parallelFormat.render();
    expect(content).toContain('Action 1:');
    expect(content).toContain('Action Input 1:');
    expect(content).toContain('Action 2:');
    expect(content).toContain('Action Input 2:');
  });

  it('should include the rule about no data dependencies for parallel execution', () => {
    const content = parallelFormat.render();
    expect(content).toContain('无数据依赖');
  });

  it('should include the rule about dependent operations in subsequent steps', () => {
    const content = parallelFormat.render();
    expect(content).toContain('依赖关系的操作必须在后续步骤执行');
  });

  it('should include the maxConcurrency template variable', () => {
    const content = parallelFormat.render();
    expect(content).toContain('{{maxConcurrency}}');
  });

  it('should support variable substitution for maxConcurrency via PromptComposer', () => {
    const composer = new PromptComposer([parallelFormat]);
    const result = composer.compose({
      variables: { maxConcurrency: '5' },
    });
    expect(result).toContain('最大并行数: 5');
    expect(result).not.toContain('{{maxConcurrency}}');
  });

  it('should render content within the 150 token budget', () => {
    const content = parallelFormat.render();
    const composer = new PromptComposer([]);
    const tokens = composer.estimateTokens(content);
    expect(tokens).toBeLessThanOrEqual(parallelFormat.tokenBudget);
  });
});
