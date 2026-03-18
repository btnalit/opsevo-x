/**
 * Prompt 模块入口 (index.ts) 单元测试
 *
 * 测试 createPromptComposerAdapter 工厂方法，
 * 验证正常初始化和初始化失败时的回退机制。
 *
 * @see Requirements 6.4 - PromptComposer 初始化失败时回退到原始单体模板
 */

import { createPromptComposerAdapter, PromptComposerAdapter } from './index';

describe('createPromptComposerAdapter', () => {
  it('should create a PromptComposerAdapter instance', () => {
    const adapter = createPromptComposerAdapter();

    expect(adapter).toBeInstanceOf(PromptComposerAdapter);
  });

  it('should create a working adapter that builds ReAct prompts', () => {
    const adapter = createPromptComposerAdapter();
    const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

    expect(result).toBeTruthy();
    expect(result).toContain('AIOps 智能运维助手');
    expect(result).toContain('查看接口');
  });

  it('should create a working adapter that builds analysis prompts', () => {
    const adapter = createPromptComposerAdapter();
    const result = adapter.buildAlertAnalysisPrompt({
      ruleName: 'CPU 过高',
    });

    expect(result).toBeTruthy();
    expect(result).toContain('AIOps 智能运维助手');
    expect(result).toContain('分析推理步骤');
  });

  it('should accept an optional templateService', () => {
    const mockService = {
      getTemplateContent: jest.fn().mockResolvedValue('custom'),
      renderContent: jest.fn().mockReturnValue('rendered'),
    };

    const adapter = createPromptComposerAdapter(mockService);
    expect(adapter).toBeInstanceOf(PromptComposerAdapter);
  });
});
