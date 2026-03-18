/**
 * KnowledgeGuide 模块单元测试
 *
 * 验证知识优先原则、知识库使用指引、引用格式和 Token 预算合规。
 *
 * @see Requirements 1.8 - KNOWLEDGE_FIRST_REACT_PROMPT 模块化重构
 */

import { knowledgeGuide } from './knowledgeGuide';
import { PromptComposer } from '../promptComposer';

describe('KnowledgeGuide module', () => {
  it('should have the correct module name', () => {
    expect(knowledgeGuide.name).toBe('KnowledgeGuide');
  });

  it('should have a token budget of 150', () => {
    expect(knowledgeGuide.tokenBudget).toBe(150);
  });

  it('should have no dependencies', () => {
    expect(knowledgeGuide.dependencies).toEqual([]);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof knowledgeGuide.name).toBe('string');
    expect(typeof knowledgeGuide.tokenBudget).toBe('number');
    expect(Array.isArray(knowledgeGuide.dependencies)).toBe(true);
    expect(typeof knowledgeGuide.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = knowledgeGuide.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('should include the knowledge-first principle header', () => {
    const content = knowledgeGuide.render();
    expect(content).toContain('知识优先原则');
  });

  it('should instruct to query knowledge base before handling problems', () => {
    const content = knowledgeGuide.render();
    expect(content).toContain('处理问题前必须先查询知识库');
  });

  it('should include the knowledge_search tool reference', () => {
    const content = knowledgeGuide.render();
    expect(content).toContain('knowledge_search');
  });

  it('should include the citation format [KB-xxx]', () => {
    const content = knowledgeGuide.render();
    expect(content).toContain('[KB-xxx]');
  });

  it('should include knowledge base content categories', () => {
    const content = knowledgeGuide.render();
    expect(content).toContain('历史告警案例');
    expect(content).toContain('配置方案');
    expect(content).toContain('最佳实践');
    expect(content).toContain('故障排查');
    expect(content).toContain('操作指南');
  });

  it('should include step-by-step usage guide', () => {
    const content = knowledgeGuide.render();
    expect(content).toContain('知识库使用指引');
    // Verify numbered steps exist
    expect(content).toMatch(/1\./);
    expect(content).toMatch(/2\./);
    expect(content).toMatch(/3\./);
    expect(content).toMatch(/4\./);
  });

  it('should render content within the 150 token budget', () => {
    const content = knowledgeGuide.render();
    const composer = new PromptComposer([]);
    const tokens = composer.estimateTokens(content);
    expect(tokens).toBeLessThanOrEqual(knowledgeGuide.tokenBudget);
  });
});
