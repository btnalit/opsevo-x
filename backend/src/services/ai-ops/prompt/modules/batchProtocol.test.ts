/**
 * BatchProtocol 模块单元测试
 *
 * 验证分批处理协议内容、Token 预算合规和模块接口实现。
 *
 * @see Requirements 1.7 - REACT_LOOP_PROMPT 模块化重构
 */

import { batchProtocol } from './batchProtocol';
import { PromptComposer } from '../promptComposer';

describe('BatchProtocol module', () => {
  it('should have the correct module name', () => {
    expect(batchProtocol.name).toBe('BatchProtocol');
  });

  it('should have a token budget of 200', () => {
    expect(batchProtocol.tokenBudget).toBe(200);
  });

  it('should have no dependencies', () => {
    expect(batchProtocol.dependencies).toEqual([]);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof batchProtocol.name).toBe('string');
    expect(typeof batchProtocol.tokenBudget).toBe('number');
    expect(Array.isArray(batchProtocol.dependencies)).toBe(true);
    expect(typeof batchProtocol.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = batchProtocol.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('should include the batch processing protocol header', () => {
    const content = batchProtocol.render();
    expect(content).toContain('分批处理协议');
  });

  it('should include step 1: probe total count', () => {
    const content = batchProtocol.render();
    expect(content).toContain('探测总量优先');
  });

  it('should include step 2: forced pagination', () => {
    const content = batchProtocol.render();
    expect(content).toContain('强制分页查询');
  });

  it('should include step 3: iterative processing', () => {
    const content = batchProtocol.render();
    expect(content).toContain('迭代处理模式');
  });

  it('should include step 4: truncation recovery', () => {
    const content = batchProtocol.render();
    expect(content).toContain('截断检测与恢复');
  });

  it('should include the prohibition against unlimited queries', () => {
    const content = batchProtocol.render();
    expect(content).toContain('严禁对大数据量路径使用不带限制的查询');
  });

  it('should render content within the 200 token budget', () => {
    const content = batchProtocol.render();
    const composer = new PromptComposer([]);
    const tokens = composer.estimateTokens(content);
    expect(tokens).toBeLessThanOrEqual(batchProtocol.tokenBudget);
  });
});
