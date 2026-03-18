/**
 * PromptComposer 单元测试
 *
 * 测试 compose()、injectContext()、estimateTokens() 的核心功能。
 */

import { PromptComposer } from './promptComposer';
import { PromptModule, DynamicContext } from './types';

/** 创建简单的测试模块 */
function createModule(
  name: string,
  content: string,
  tokenBudget = 500,
  dependencies: string[] = []
): PromptModule {
  return {
    name,
    tokenBudget,
    dependencies,
    render: () => content,
  };
}

describe('PromptComposer', () => {
  describe('compose', () => {
    it('should compose modules in declaration order', () => {
      const modules = [
        createModule('mod1', 'First module content'),
        createModule('mod2', 'Second module content'),
        createModule('mod3', 'Third module content'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose();

      const idx1 = result.indexOf('First module content');
      const idx2 = result.indexOf('Second module content');
      const idx3 = result.indexOf('Third module content');

      expect(idx1).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx3);
    });

    it('should join modules with double newlines', () => {
      const modules = [
        createModule('mod1', 'Content A'),
        createModule('mod2', 'Content B'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose();

      expect(result).toBe('Content A\n\nContent B');
    });

    it('should skip empty module outputs', () => {
      const modules = [
        createModule('mod1', 'Content A'),
        createModule('mod2', ''),
        createModule('mod3', '   '),
        createModule('mod4', 'Content B'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose();

      expect(result).toBe('Content A\n\nContent B');
    });

    it('should deduplicate identical paragraphs by default', () => {
      const modules = [
        createModule('mod1', 'Shared paragraph\n\nUnique A'),
        createModule('mod2', 'Shared paragraph\n\nUnique B'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose();

      const occurrences = result.split('Shared paragraph').length - 1;
      expect(occurrences).toBe(1);
      expect(result).toContain('Unique A');
      expect(result).toContain('Unique B');
    });

    it('should preserve first occurrence during deduplication', () => {
      const modules = [
        createModule('mod1', 'Para A\n\nDuplicate'),
        createModule('mod2', 'Duplicate\n\nPara B'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose();

      // "Duplicate" should appear before "Para B"
      const idxDup = result.indexOf('Duplicate');
      const idxB = result.indexOf('Para B');
      expect(idxDup).toBeLessThan(idxB);

      // Only one occurrence
      const count = result.split('Duplicate').length - 1;
      expect(count).toBe(1);
    });

    it('should not deduplicate when deduplication is disabled', () => {
      const modules = [
        createModule('mod1', 'Same content'),
        createModule('mod2', 'Same content'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose({ deduplication: false });

      const occurrences = result.split('Same content').length - 1;
      expect(occurrences).toBe(2);
    });

    it('should replace {{key}} variables in the output', () => {
      const modules = [
        createModule('mod1', 'Hello {{name}}, your role is {{role}}.'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose({
        variables: { name: 'Alice', role: 'admin' },
      });

      expect(result).toBe('Hello Alice, your role is admin.');
    });

    it('should handle multiple occurrences of the same variable', () => {
      const modules = [
        createModule('mod1', '{{x}} and {{x}} again'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose({ variables: { x: 'val' } });

      expect(result).toBe('val and val again');
    });

    it('should leave unreplaced variables as-is', () => {
      const modules = [
        createModule('mod1', '{{known}} and {{unknown}}'),
      ];
      const composer = new PromptComposer(modules);
      const result = composer.compose({ variables: { known: 'yes' } });

      expect(result).toBe('yes and {{unknown}}');
    });

    it('should handle empty module list', () => {
      const composer = new PromptComposer([]);
      const result = composer.compose();

      expect(result).toBe('');
    });

    it('should handle single module', () => {
      const modules = [createModule('mod1', 'Only content')];
      const composer = new PromptComposer(modules);
      const result = composer.compose();

      expect(result).toBe('Only content');
    });
  });

  describe('injectContext', () => {
    it('should inject health summary when healthScore < 60', () => {
      const composer = new PromptComposer([]);
      const context: DynamicContext = {
        healthScore: 45,
        riskIndicators: ['CPU 过高', '内存不足'],
      };
      const result = composer.injectContext('Base prompt', context);

      expect(result).toContain('健康评分：45/100');
      expect(result).toContain('CPU 过高');
      expect(result).toContain('内存不足');
    });

    it('should not inject health summary when healthScore >= 60', () => {
      const composer = new PromptComposer([]);
      const context: DynamicContext = { healthScore: 80 };
      const result = composer.injectContext('Base prompt', context);

      expect(result).toBe('Base prompt');
    });

    it('should inject active alerts when present', () => {
      const composer = new PromptComposer([]);
      const context: DynamicContext = {
        activeAlerts: [
          { name: 'CPU Alert', severity: 'critical', message: 'CPU > 90%' },
          { name: 'Mem Alert', severity: 'warning', message: 'Memory > 80%' },
        ],
      };
      const result = composer.injectContext('Base prompt', context);

      expect(result).toContain('活跃告警');
      expect(result).toContain('[critical] CPU Alert: CPU > 90%');
      expect(result).toContain('[warning] Mem Alert: Memory > 80%');
    });

    it('should limit alerts to 5', () => {
      const composer = new PromptComposer([]);
      const alerts = Array.from({ length: 8 }, (_, i) => ({
        name: `Alert ${i}`,
        severity: 'warning',
        message: `Message ${i}`,
      }));
      const context: DynamicContext = { activeAlerts: alerts };
      const result = composer.injectContext('Base prompt', context);

      // Should contain first 5 alerts
      expect(result).toContain('Alert 0');
      expect(result).toContain('Alert 4');
      // Should not contain 6th alert
      expect(result).not.toContain('Alert 5');
    });

    it('should inject anomaly predictions when present', () => {
      const composer = new PromptComposer([]);
      const context: DynamicContext = {
        anomalyPredictions: [
          {
            type: 'CPU 异常',
            confidence: 0.85,
            description: '预计 2 小时内 CPU 将超过阈值',
          },
        ],
      };
      const result = composer.injectContext('Base prompt', context);

      expect(result).toContain('异常预测');
      expect(result).toContain('CPU 异常');
      expect(result).toContain('85%');
      expect(result).toContain('预计 2 小时内 CPU 将超过阈值');
    });

    it('should inject multiple context sections', () => {
      const composer = new PromptComposer([]);
      const context: DynamicContext = {
        healthScore: 30,
        riskIndicators: ['磁盘满'],
        activeAlerts: [
          { name: 'Disk Alert', severity: 'critical', message: 'Disk full' },
        ],
        anomalyPredictions: [
          { type: '磁盘预测', confidence: 0.9, description: '磁盘将在 1 天内满' },
        ],
      };
      const result = composer.injectContext('Base prompt', context);

      expect(result).toContain('健康评分：30/100');
      expect(result).toContain('活跃告警');
      expect(result).toContain('异常预测');
    });

    it('should return original prompt when context is empty', () => {
      const composer = new PromptComposer([]);
      const result = composer.injectContext('Base prompt', {});

      expect(result).toBe('Base prompt');
    });

    it('should return original prompt when healthScore >= 60 and no alerts/predictions', () => {
      const composer = new PromptComposer([]);
      const context: DynamicContext = {
        healthScore: 75,
        activeAlerts: [],
        anomalyPredictions: [],
      };
      const result = composer.injectContext('Base prompt', context);

      expect(result).toBe('Base prompt');
    });
  });

  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      const composer = new PromptComposer([]);
      expect(composer.estimateTokens('')).toBe(0);
    });

    it('should estimate English text at ~4 chars/token', () => {
      const composer = new PromptComposer([]);
      // 40 English chars → ~10 tokens
      const text = 'a'.repeat(40);
      expect(composer.estimateTokens(text)).toBe(10);
    });

    it('should estimate Chinese text at ~1.5 chars/token', () => {
      const composer = new PromptComposer([]);
      // 15 Chinese chars → 10 tokens
      const text = '你'.repeat(15);
      expect(composer.estimateTokens(text)).toBe(10);
    });

    it('should handle mixed Chinese and English text', () => {
      const composer = new PromptComposer([]);
      // 3 Chinese chars (3/1.5 = 2 tokens) + 8 English chars (8/4 = 2 tokens) = 4 tokens
      const text = '你好吗hello!!!';
      const tokens = composer.estimateTokens(text);
      expect(tokens).toBe(4);
    });

    it('should return 0 for null/undefined-like input', () => {
      const composer = new PromptComposer([]);
      expect(composer.estimateTokens('')).toBe(0);
    });

    it('should ceil the result', () => {
      const composer = new PromptComposer([]);
      // 1 English char → 0.25 → ceil to 1
      expect(composer.estimateTokens('a')).toBe(1);
    });
  });
});
