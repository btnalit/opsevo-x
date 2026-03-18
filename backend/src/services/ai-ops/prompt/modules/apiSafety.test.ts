/**
 * APISafety 模块单元测试
 *
 * 验证 API 路径安全规则内容、风险等级分组、知识库指引和 Token 预算合规。
 *
 * @see Requirements 2.1 - 仅内联 Top 20 高频 API 路径，按风险等级分为三组
 * @see Requirements 2.2 - 在内联路径列表末尾包含指引文本"完整路径参考请查询知识库"
 * @see Requirements 2.3 - API 路径引用部分 Token 数不超过 300
 */

import { apiSafety, RiskLevel, TOP_API_PATHS } from './apiSafety';
import { PromptComposer } from '../promptComposer';

describe('APISafety module', () => {
  it('should have the correct module name', () => {
    expect(apiSafety.name).toBe('APISafety');
  });

  it('should have a token budget of 300', () => {
    expect(apiSafety.tokenBudget).toBe(300);
  });

  it('should have no dependencies', () => {
    expect(apiSafety.dependencies).toEqual([]);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof apiSafety.name).toBe('string');
    expect(typeof apiSafety.tokenBudget).toBe('number');
    expect(Array.isArray(apiSafety.dependencies)).toBe(true);
    expect(typeof apiSafety.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = apiSafety.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });

  describe('TOP_API_PATHS data', () => {
    it('should contain exactly 20 API paths', () => {
      expect(TOP_API_PATHS).toHaveLength(20);
    });

    it('should have 6 high-risk paths', () => {
      const highRisk = TOP_API_PATHS.filter(p => p.riskLevel === RiskLevel.HIGH);
      expect(highRisk).toHaveLength(6);
    });

    it('should have 7 medium-risk paths', () => {
      const mediumRisk = TOP_API_PATHS.filter(p => p.riskLevel === RiskLevel.MEDIUM);
      expect(mediumRisk).toHaveLength(7);
    });

    it('should have 7 low-risk paths', () => {
      const lowRisk = TOP_API_PATHS.filter(p => p.riskLevel === RiskLevel.LOW);
      expect(lowRisk).toHaveLength(7);
    });

    it('should have unique paths', () => {
      const paths = TOP_API_PATHS.map(p => p.path);
      const uniquePaths = new Set(paths);
      expect(uniquePaths.size).toBe(paths.length);
    });
  });

  describe('render() output', () => {
    let content: string;

    beforeEach(() => {
      content = apiSafety.render();
    });

    it('should include the 🔴 high-risk group header', () => {
      expect(content).toContain('🔴');
      expect(content).toContain('高危');
    });

    it('should include the 🟡 medium-risk group header', () => {
      expect(content).toContain('🟡');
      expect(content).toContain('中等');
    });

    it('should include the 🟢 low-risk group header', () => {
      expect(content).toContain('🟢');
      expect(content).toContain('低危');
    });

    it('should include all 20 API paths in the output', () => {
      for (const entry of TOP_API_PATHS) {
        expect(content).toContain(entry.path);
      }
    });

    it('should include descriptions for all paths', () => {
      for (const entry of TOP_API_PATHS) {
        expect(content).toContain(entry.description);
      }
    });

    it('should include queryHints where available', () => {
      const entriesWithHints = TOP_API_PATHS.filter(p => p.queryHints);
      expect(entriesWithHints.length).toBeGreaterThan(0);
      for (const entry of entriesWithHints) {
        expect(content).toContain(entry.queryHints!);
      }
    });

    it('should include the knowledge base guidance text at the end', () => {
      expect(content).toContain('完整路径参考请查询知识库');
    });

    it('should have the knowledge base guidance as the last section', () => {
      const lines = content.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toContain('完整路径参考请查询知识库');
    });

    it('should order risk groups as high → medium → low', () => {
      const highIndex = content.indexOf('🔴');
      const mediumIndex = content.indexOf('🟡');
      const lowIndex = content.indexOf('🟢');
      expect(highIndex).toBeLessThan(mediumIndex);
      expect(mediumIndex).toBeLessThan(lowIndex);
    });

    it('should render content within the 300 token budget', () => {
      const composer = new PromptComposer([]);
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(apiSafety.tokenBudget);
    });
  });

  describe('RiskLevel enum', () => {
    it('should have HIGH value as "high"', () => {
      expect(RiskLevel.HIGH).toBe('high');
    });

    it('should have MEDIUM value as "medium"', () => {
      expect(RiskLevel.MEDIUM).toBe('medium');
    });

    it('should have LOW value as "low"', () => {
      expect(RiskLevel.LOW).toBe('low');
    });
  });
});
