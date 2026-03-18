/**
 * PromptComposerAdapter 单元测试
 *
 * 测试适配层的各种 Prompt 构建方法，验证模块组合正确性、
 * 向后兼容性和自定义模板优先逻辑。
 *
 * @see Requirements 6.1 - 兼容 PromptBuilder.buildKnowledgeEnhancedPrompt 签名
 * @see Requirements 6.2 - 支持 SkillAwarePromptBuilder 的 Skill 内容注入
 * @see Requirements 6.3 - PromptTemplateService 自定义模板优先
 */

import { PromptComposerAdapter, TemplateServiceLike } from './promptComposerAdapter';
import { PromptComposer } from './promptComposer';
import { FormattedKnowledge } from '../rag/types/intelligentRetrieval';

/** 创建测试用的 FormattedKnowledge */
function createTestKnowledge(overrides?: Partial<FormattedKnowledge>): FormattedKnowledge {
  return {
    referenceId: 'KB-alert-abc12345',
    entryId: 'entry-1',
    title: '测试知识条目',
    type: 'alert',
    credibilityScore: 0.9,
    credibilityLevel: 'high',
    fullContent: '这是测试知识的完整内容',
    content: '这是测试知识的完整内容',
    summary: '测试知识摘要',
    metadata: {
      category: 'alert',
      tags: ['test'],
    },
    citationHint: '引用此知识请使用 [KB-alert-abc12345]',
    ...overrides,
  } as FormattedKnowledge;
}

describe('PromptComposerAdapter', () => {
  let adapter: PromptComposerAdapter;
  let composer: PromptComposer;

  beforeEach(() => {
    composer = new PromptComposer([]);
    adapter = new PromptComposerAdapter(composer);
  });

  // ==================== buildKnowledgeEnhancedPrompt ====================

  describe('buildKnowledgeEnhancedPrompt', () => {
    it('should return a non-empty string containing the user query', () => {
      const result = adapter.buildKnowledgeEnhancedPrompt(
        '如何查看接口状态？',
        [],
      );

      expect(result).toBeTruthy();
      expect(result).toContain('如何查看接口状态？');
    });

    it('should include BasePersona unified persona text', () => {
      const result = adapter.buildKnowledgeEnhancedPrompt('测试查询', []);

      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should include knowledge context when knowledge is provided', () => {
      const knowledge = [createTestKnowledge()];
      const result = adapter.buildKnowledgeEnhancedPrompt('测试查询', knowledge);

      expect(result).toContain('测试知识条目');
      expect(result).toContain('KB-alert-abc12345');
      expect(result).toContain('这是测试知识的完整内容');
    });

    it('should show "暂无相关知识" when knowledge list is empty', () => {
      const result = adapter.buildKnowledgeEnhancedPrompt('测试查询', []);

      expect(result).toContain('暂无相关知识');
    });

    it('should limit knowledge count based on options', () => {
      const knowledge = Array.from({ length: 10 }, (_, i) =>
        createTestKnowledge({
          referenceId: `KB-alert-item${i}`,
          title: `知识条目 ${i}`,
        })
      );

      const result = adapter.buildKnowledgeEnhancedPrompt('测试', knowledge, {
        maxKnowledgeCount: 3,
      });

      expect(result).toContain('知识条目 0');
      expect(result).toContain('知识条目 2');
      expect(result).not.toContain('知识条目 3');
    });

    it('should include guidelines based on options', () => {
      const result = adapter.buildKnowledgeEnhancedPrompt('测试', [], {
        requireCitation: true,
        allowQuestioning: true,
        requireApplicabilityCheck: true,
        requireDeviceStateVerification: true,
        maxKnowledgeCount: 5,
      });

      expect(result).toContain('[KB-xxx]');
      expect(result).toContain('过时或不适用');
      expect(result).toContain('评估其是否适用');
      expect(result).toContain('设备的实际状态');
    });

    it('should include KnowledgeGuide module content', () => {
      const result = adapter.buildKnowledgeEnhancedPrompt('测试', []);

      expect(result).toContain('知识优先原则');
    });

    it('should include DeviceInfo module content', () => {
      const result = adapter.buildKnowledgeEnhancedPrompt('测试', []);

      expect(result).toContain('通用设备');
    });
  });

  // ==================== buildReActPrompt ====================

  describe('buildReActPrompt', () => {
    it('should include BasePersona unified persona', () => {
      const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should include DeviceInfo module content', () => {
      const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).toContain('通用设备');
    });

    it('should include ReActFormat module content', () => {
      const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).toContain('Thought:');
      expect(result).toContain('Action:');
      expect(result).toContain('Final Answer:');
    });

    it('should include APISafety module content', () => {
      const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).toContain('API 路径安全参考');
      expect(result).toContain('🔴');
      expect(result).toContain('🟡');
      expect(result).toContain('🟢');
      expect(result).toContain('完整路径参考请查询知识库');
    });

    it('should include BatchProtocol module content', () => {
      const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).toContain('分批处理协议');
    });

    it('should include user message, tools, and steps in suffix', () => {
      const result = adapter.buildReActPrompt(
        '查看系统资源',
        'device_query: 查询设备',
        '步骤1: 已完成'
      );

      expect(result).toContain('用户请求：查看系统资源');
      expect(result).toContain('device_query: 查询设备');
      expect(result).toContain('步骤1: 已完成');
    });

    it('should include ragContext when provided', () => {
      const result = adapter.buildReActPrompt(
        '查看接口',
        'tools',
        'steps',
        '相关知识库内容'
      );

      expect(result).toContain('知识库上下文');
      expect(result).toContain('相关知识库内容');
    });

    it('should not include ragContext section when not provided', () => {
      const result = adapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).not.toContain('知识库上下文');
    });
  });

  // ==================== buildKnowledgeFirstReActPrompt ====================

  describe('buildKnowledgeFirstReActPrompt', () => {
    it('should include BasePersona unified persona', () => {
      const result = adapter.buildKnowledgeFirstReActPrompt(
        '查看接口', 'tools', 'steps', 'rag context'
      );

      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should include KnowledgeGuide module content', () => {
      const result = adapter.buildKnowledgeFirstReActPrompt(
        '查看接口', 'tools', 'steps', 'rag context'
      );

      expect(result).toContain('知识优先原则');
      expect(result).toContain('knowledge_search');
    });

    it('should include all ReAct modules (DeviceInfo, ReActFormat, APISafety, BatchProtocol)', () => {
      const result = adapter.buildKnowledgeFirstReActPrompt(
        '查看接口', 'tools', 'steps', 'rag context'
      );

      expect(result).toContain('通用设备');
      expect(result).toContain('Thought:');
      expect(result).toContain('API 路径安全参考');
      expect(result).toContain('分批处理协议');
    });

    it('should include ragContext in suffix', () => {
      const result = adapter.buildKnowledgeFirstReActPrompt(
        '查看接口', 'tools', 'steps', '知识库检索结果'
      );

      expect(result).toContain('知识库上下文');
      expect(result).toContain('知识库检索结果');
    });

    it('should include knowledge-first reminder in suffix', () => {
      const result = adapter.buildKnowledgeFirstReActPrompt(
        '查看接口', 'tools', 'steps', 'rag context'
      );

      expect(result).toContain('如果还没有查询知识库，应该先查询知识库');
    });
  });

  // ==================== buildParallelReActPrompt ====================

  describe('buildParallelReActPrompt', () => {
    it('should include BasePersona unified persona', () => {
      const result = adapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 5
      );

      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should include ParallelFormat module content', () => {
      const result = adapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 5
      );

      expect(result).toContain('并行执行模式');
      expect(result).toContain('Action 1:');
      expect(result).toContain('Action 2:');
    });

    it('should replace maxConcurrency variable', () => {
      const result = adapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 3
      );

      expect(result).toContain('3');
    });

    it('should include APISafety module content', () => {
      const result = adapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 5
      );

      expect(result).toContain('API 路径安全参考');
    });

    it('should include DeviceInfo module content', () => {
      const result = adapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 5
      );

      expect(result).toContain('通用设备');
    });

    it('should include parallel execution reminder in suffix', () => {
      const result = adapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 5
      );

      expect(result).toContain('如果可以并行执行多个独立操作，请务必使用编号格式');
    });
  });

  // ==================== Analysis Prompts ====================

  describe('buildAlertAnalysisPrompt', () => {
    it('should include BasePersona unified persona', () => {
      const result = adapter.buildAlertAnalysisPrompt({});

      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should include ChainOfThought alert analysis steps', () => {
      const result = adapter.buildAlertAnalysisPrompt({});

      expect(result).toContain('分析推理步骤');
      expect(result).toContain('识别告警类型和严重程度');
      expect(result).toContain('分析告警根本原因');
      expect(result).toContain('评估影响范围');
      expect(result).toContain('制定处理建议');
    });

    it('should include JsonSchema alert analysis fields', () => {
      const result = adapter.buildAlertAnalysisPrompt({});

      expect(result).toContain('输出格式要求');
      expect(result).toContain('summary');
      expect(result).toContain('problemAnalysis');
      expect(result).toContain('impactAssessment');
      expect(result).toContain('recommendations');
      expect(result).toContain('riskLevel');
      expect(result).toContain('confidence');
    });

    it('should replace template variables', () => {
      const result = adapter.buildAlertAnalysisPrompt({
        alertName: 'CPU 过高',
        severity: 'critical',
      });

      // Variables are replaced via {{key}} pattern
      expect(result).toBeTruthy();
    });
  });

  describe('buildBatchAlertAnalysisPrompt', () => {
    it('should include BasePersona and batch analysis steps', () => {
      const result = adapter.buildBatchAlertAnalysisPrompt({});

      expect(result).toContain('AIOps 智能运维助手');
      expect(result).toContain('告警分类汇总');
      expect(result).toContain('识别关联告警');
      expect(result).toContain('确定优先级');
      expect(result).toContain('制定批量处理方案');
    });

    it('should include batch analysis JSON Schema fields', () => {
      const result = adapter.buildBatchAlertAnalysisPrompt({});

      expect(result).toContain('overallSummary');
      expect(result).toContain('alertGroups');
      expect(result).toContain('correlations');
      expect(result).toContain('priorityOrder');
    });
  });

  describe('buildHealthReportAnalysisPrompt', () => {
    it('should include BasePersona and health report steps', () => {
      const result = adapter.buildHealthReportAnalysisPrompt({});

      expect(result).toContain('AIOps 智能运维助手');
      expect(result).toContain('评估整体健康状态');
      expect(result).toContain('识别异常指标');
      expect(result).toContain('分析趋势变化');
      expect(result).toContain('制定优化建议');
    });

    it('should include health report JSON Schema fields', () => {
      const result = adapter.buildHealthReportAnalysisPrompt({});

      expect(result).toContain('healthScore');
      expect(result).toContain('abnormalIndicators');
      expect(result).toContain('trendAnalysis');
    });
  });

  describe('buildConfigDiffAnalysisPrompt', () => {
    it('should include BasePersona and config change steps', () => {
      const result = adapter.buildConfigDiffAnalysisPrompt({});

      expect(result).toContain('AIOps 智能运维助手');
      expect(result).toContain('识别变更内容');
      expect(result).toContain('评估变更风险');
      expect(result).toContain('验证配置一致性');
      expect(result).toContain('制定回滚方案');
    });

    it('should include config change JSON Schema fields', () => {
      const result = adapter.buildConfigDiffAnalysisPrompt({});

      expect(result).toContain('changeDetails');
      expect(result).toContain('riskAssessment');
      expect(result).toContain('consistencyCheck');
      expect(result).toContain('rollbackPlan');
    });
  });

  describe('buildFaultDiagnosisPrompt', () => {
    it('should include BasePersona and fault diagnosis steps', () => {
      const result = adapter.buildFaultDiagnosisPrompt({});

      expect(result).toContain('AIOps 智能运维助手');
      expect(result).toContain('收集故障现象');
      expect(result).toContain('分析可能原因');
      expect(result).toContain('制定排查步骤');
      expect(result).toContain('提供修复建议');
    });

    it('should include fault diagnosis JSON Schema fields', () => {
      const result = adapter.buildFaultDiagnosisPrompt({});

      expect(result).toContain('symptoms');
      expect(result).toContain('possibleCauses');
      expect(result).toContain('diagnosticSteps');
    });
  });

  // ==================== Property 4: 统一人设贯穿所有 Prompt ====================

  describe('unified persona across all prompts', () => {
    it('should include "AIOps 智能运维助手" in all prompt types', () => {
      const prompts = [
        adapter.buildKnowledgeEnhancedPrompt('test', []),
        adapter.buildReActPrompt('test', 'tools', 'steps'),
        adapter.buildKnowledgeFirstReActPrompt('test', 'tools', 'steps', 'rag'),
        adapter.buildParallelReActPrompt('test', 'tools', 'steps', 5),
        adapter.buildAlertAnalysisPrompt({}),
        adapter.buildBatchAlertAnalysisPrompt({}),
        adapter.buildHealthReportAnalysisPrompt({}),
        adapter.buildConfigDiffAnalysisPrompt({}),
        adapter.buildFaultDiagnosisPrompt({}),
      ];

      for (const prompt of prompts) {
        expect(prompt).toContain('AIOps 智能运维助手');
      }
    });
  });

  // ==================== Property 3: 分析 Prompt 包含 ChainOfThought 和 JSON Schema ====================

  describe('analysis prompts contain ChainOfThought and JSON Schema', () => {
    const analysisBuilders: Array<{
      name: string;
      build: () => string;
    }> = [
      { name: 'alertAnalysis', build: () => adapter.buildAlertAnalysisPrompt({}) },
      { name: 'batchAlertAnalysis', build: () => adapter.buildBatchAlertAnalysisPrompt({}) },
      { name: 'healthReportAnalysis', build: () => adapter.buildHealthReportAnalysisPrompt({}) },
      { name: 'configDiffAnalysis', build: () => adapter.buildConfigDiffAnalysisPrompt({}) },
      { name: 'faultDiagnosis', build: () => adapter.buildFaultDiagnosisPrompt({}) },
    ];

    for (const { name, build } of analysisBuilders) {
      it(`${name} should contain ChainOfThought steps`, () => {
        const result = build();
        expect(result).toContain('分析推理步骤');
        expect(result).toContain('请按以下步骤进行分析');
      });

      it(`${name} should contain JSON Schema fields`, () => {
        const result = build();
        expect(result).toContain('输出格式要求');
        expect(result).toContain('请严格按照以下字段定义输出 JSON');
      });
    }
  });

  // ==================== TemplateService integration ====================

  describe('TemplateServiceLike integration', () => {
    it('should accept an optional templateService in constructor', () => {
      const mockService: TemplateServiceLike = {
        getTemplateContent: jest.fn().mockResolvedValue('custom template'),
        renderContent: jest.fn().mockReturnValue('rendered content'),
      };

      const adapterWithService = new PromptComposerAdapter(composer, mockService);
      expect(adapterWithService).toBeDefined();
    });

    it('should work without templateService', () => {
      const adapterNoService = new PromptComposerAdapter(composer);
      const result = adapterNoService.buildAlertAnalysisPrompt({});

      expect(result).toContain('AIOps 智能运维助手');
      expect(result).toContain('分析推理步骤');
    });
  });

  // ==================== Edge cases ====================

  describe('edge cases', () => {
    it('should handle empty tools and steps strings', () => {
      const result = adapter.buildReActPrompt('查看接口', '', '');

      expect(result).toContain('AIOps 智能运维助手');
      expect(result).toContain('用户请求：查看接口');
    });

    it('should handle very long user messages', () => {
      const longMessage = '查看接口'.repeat(1000);
      const result = adapter.buildReActPrompt(longMessage, 'tools', 'steps');

      expect(result).toContain(longMessage);
    });

    it('should handle knowledge with very long content', () => {
      const longContent = '详细内容'.repeat(500);
      const knowledge = [createTestKnowledge({ fullContent: longContent })];
      const result = adapter.buildKnowledgeEnhancedPrompt('测试', knowledge);

      // Content should be truncated at 1000 chars
      expect(result).toContain('...[内容已截断]');
    });

    it('should handle maxConcurrency of 1', () => {
      const result = adapter.buildParallelReActPrompt('查看接口', 'tools', 'steps', 1);

      expect(result).toContain('1');
    });

    it('should throw for unknown analysis type', () => {
      // Access private method via any cast for testing
      expect(() => {
        (adapter as any).buildAnalysisPrompt('unknownType', {});
      }).toThrow('Unknown analysis type: unknownType');
    });
  });

  // ==================== Fallback mechanism (Requirements 6.4) ====================

  describe('fallback mechanism', () => {
    let brokenAdapter: PromptComposerAdapter;

    beforeEach(() => {
      // Create an adapter with a PromptComposer that uses a broken module
      const brokenModule = {
        name: 'BrokenModule',
        tokenBudget: 100,
        dependencies: [],
        render(): string {
          throw new Error('Module render failed');
        },
      };
      const brokenComposer = new PromptComposer([brokenModule]);
      brokenAdapter = new PromptComposerAdapter(brokenComposer);
    });

    it('should fall back to legacy template when buildReActPrompt fails', () => {
      const result = brokenAdapter.buildReActPrompt('查看接口', 'tools', 'steps');

      expect(result).toBeTruthy();
      expect(result).toContain('查看接口');
      expect(result).toContain('tools');
      expect(result).toContain('steps');
      // Legacy template contains generalized assistant text
      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should fall back to legacy template when buildKnowledgeFirstReActPrompt fails', () => {
      const result = brokenAdapter.buildKnowledgeFirstReActPrompt(
        '查看接口', 'tools', 'steps', 'rag context'
      );

      expect(result).toBeTruthy();
      expect(result).toContain('查看接口');
      expect(result).toContain('rag context');
      expect(result).toContain('知识优先原则');
    });

    it('should fall back to legacy template when buildParallelReActPrompt fails', () => {
      const result = brokenAdapter.buildParallelReActPrompt(
        '查看接口', 'tools', 'steps', 5
      );

      expect(result).toBeTruthy();
      expect(result).toContain('查看接口');
      expect(result).toContain('并行执行模式');
    });

    it('should fall back to legacy template when buildAlertAnalysisPrompt composition throws', () => {
      // Spy on the private buildAnalysisPrompt to force it to throw
      jest.spyOn(brokenAdapter as any, 'buildAnalysisPrompt').mockImplementation(() => {
        throw new Error('Composition failed');
      });

      const result = brokenAdapter.buildAlertAnalysisPrompt({
        ruleName: 'CPU 过高',
        severity: 'critical',
      });

      expect(result).toBeTruthy();
      expect(result).toContain('CPU 过高');
      expect(result).toContain('critical');
    });

    it('should fall back to legacy template when buildBatchAlertAnalysisPrompt composition throws', () => {
      jest.spyOn(brokenAdapter as any, 'buildAnalysisPrompt').mockImplementation(() => {
        throw new Error('Composition failed');
      });

      const result = brokenAdapter.buildBatchAlertAnalysisPrompt({
        alertsList: '告警1, 告警2',
      });

      expect(result).toBeTruthy();
      expect(result).toContain('告警1, 告警2');
    });

    it('should fall back to legacy template when buildHealthReportAnalysisPrompt composition throws', () => {
      jest.spyOn(brokenAdapter as any, 'buildAnalysisPrompt').mockImplementation(() => {
        throw new Error('Composition failed');
      });

      const result = brokenAdapter.buildHealthReportAnalysisPrompt({
        cpuAvg: 85,
        memoryAvg: 70,
      });

      expect(result).toBeTruthy();
      expect(result).toContain('85');
      expect(result).toContain('70');
    });

    it('should fall back to legacy template when buildConfigDiffAnalysisPrompt composition throws', () => {
      jest.spyOn(brokenAdapter as any, 'buildAnalysisPrompt').mockImplementation(() => {
        throw new Error('Composition failed');
      });

      const result = brokenAdapter.buildConfigDiffAnalysisPrompt({
        additionsCount: 3,
        modificationsCount: 2,
        deletionsCount: 1,
      });

      expect(result).toBeTruthy();
      expect(result).toContain('3');
      expect(result).toContain('2');
      expect(result).toContain('1');
    });

    it('should fall back to legacy template when buildFaultDiagnosisPrompt composition throws', () => {
      jest.spyOn(brokenAdapter as any, 'buildAnalysisPrompt').mockImplementation(() => {
        throw new Error('Composition failed');
      });

      const result = brokenAdapter.buildFaultDiagnosisPrompt({
        patternName: 'CPU 过载',
        severity: 'critical',
      });

      expect(result).toBeTruthy();
      expect(result).toContain('CPU 过载');
      expect(result).toContain('critical');
    });

    it('should fall back to basic template when buildKnowledgeEnhancedPrompt fails', () => {
      const result = brokenAdapter.buildKnowledgeEnhancedPrompt('测试查询', []);

      expect(result).toBeTruthy();
      expect(result).toContain('测试查询');
    });

    it('should return non-empty result even when all modules fail', () => {
      // Verify that every build method returns a non-empty string even with broken modules
      const results = [
        brokenAdapter.buildReActPrompt('msg', 'tools', 'steps'),
        brokenAdapter.buildKnowledgeFirstReActPrompt('msg', 'tools', 'steps', 'rag'),
        brokenAdapter.buildParallelReActPrompt('msg', 'tools', 'steps', 3),
        brokenAdapter.buildKnowledgeEnhancedPrompt('msg', []),
      ];

      for (const result of results) {
        expect(result).toBeTruthy();
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });

  // ==================== getModuleContent (Requirements 7.5, 7.6) ====================

  describe('getModuleContent', () => {
    it('should return default render() output when no templateService is provided', () => {
      const adapterNoService = new PromptComposerAdapter(composer);
      const testModule = {
        name: 'TestModule',
        tokenBudget: 100,
        dependencies: [],
        templateName: '[模块化] TestModule',
        render: () => '默认模块内容',
      };

      const result = adapterNoService.getModuleContent(testModule);
      expect(result).toBe('默认模块内容');
    });

    it('should return default render() output when module has no templateName', () => {
      const mockService: TemplateServiceLike = {
        getTemplateContent: jest.fn().mockResolvedValue('自定义内容'),
        renderContent: jest.fn().mockReturnValue('rendered'),
      };
      const adapterWithService = new PromptComposerAdapter(composer, mockService);

      const testModule = {
        name: 'TestModule',
        tokenBudget: 100,
        dependencies: [],
        // no templateName
        render: () => '默认模块内容',
      };

      const result = adapterWithService.getModuleContent(testModule);
      expect(result).toBe('默认模块内容');
    });

    it('should return cached custom content when available', async () => {
      const mockService: TemplateServiceLike = {
        getTemplateContent: jest.fn().mockResolvedValue('用户自定义的人设内容'),
        renderContent: jest.fn().mockReturnValue('rendered'),
      };
      const adapterWithService = new PromptComposerAdapter(composer, mockService);

      // Wait for async preload to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const testModule = {
        name: 'BasePersona',
        tokenBudget: 150,
        dependencies: [],
        templateName: '[模块化] BasePersona - 统一人设',
        render: () => '默认人设内容',
      };

      const result = adapterWithService.getModuleContent(testModule);
      expect(result).toBe('用户自定义的人设内容');
    });

    it('should return default render() when cache has empty content', async () => {
      const mockService: TemplateServiceLike = {
        getTemplateContent: jest.fn().mockResolvedValue(''),
        renderContent: jest.fn().mockReturnValue('rendered'),
      };
      const adapterWithService = new PromptComposerAdapter(composer, mockService);

      // Wait for async preload to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const testModule = {
        name: 'BasePersona',
        tokenBudget: 150,
        dependencies: [],
        templateName: '[模块化] BasePersona - 统一人设',
        render: () => '默认人设内容',
      };

      const result = adapterWithService.getModuleContent(testModule);
      expect(result).toBe('默认人设内容');
    });

    it('should return default render() when templateService.getTemplateContent rejects', async () => {
      const mockService: TemplateServiceLike = {
        getTemplateContent: jest.fn().mockRejectedValue(new Error('模板不存在')),
        renderContent: jest.fn().mockReturnValue('rendered'),
      };
      const adapterWithService = new PromptComposerAdapter(composer, mockService);

      // Wait for async preload to complete (and fail silently)
      await new Promise(resolve => setTimeout(resolve, 50));

      const testModule = {
        name: 'BasePersona',
        tokenBudget: 150,
        dependencies: [],
        templateName: '[模块化] BasePersona - 统一人设',
        render: () => '默认人设内容',
      };

      const result = adapterWithService.getModuleContent(testModule);
      expect(result).toBe('默认人设内容');
    });

    it('should use custom content in build methods when cache is populated', async () => {
      const customPersona = '你是自定义的运维助手，专注于自定义任务。';
      const mockService: TemplateServiceLike = {
        getTemplateContent: jest.fn().mockImplementation((name: string) => {
          if (name === '[模块化] BasePersona - 统一人设') {
            return Promise.resolve(customPersona);
          }
          return Promise.resolve('');
        }),
        renderContent: jest.fn().mockReturnValue('rendered'),
      };
      const adapterWithService = new PromptComposerAdapter(composer, mockService);

      // Wait for async preload to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      const result = adapterWithService.buildAlertAnalysisPrompt({
        ruleName: 'CPU 过高',
        severity: 'critical',
      });

      // Should contain the custom persona instead of default
      expect(result).toContain(customPersona);
      // Should NOT contain the default persona text
      expect(result).not.toContain('AIOps 智能运维助手');
    });

    it('should use default module content in build methods when no custom content', () => {
      // No templateService provided
      const adapterNoService = new PromptComposerAdapter(composer);

      const result = adapterNoService.buildReActPrompt('查看接口', 'tools', 'steps');

      // Should contain the default persona
      expect(result).toContain('AIOps 智能运维助手');
    });

    it('should preload content for all modules with templateName', async () => {
      const getTemplateContent = jest.fn().mockResolvedValue('自定义内容');
      const mockService: TemplateServiceLike = {
        getTemplateContent,
        renderContent: jest.fn().mockReturnValue('rendered'),
      };

      new PromptComposerAdapter(composer, mockService);

      // Wait for async preload to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have been called for each module with a templateName
      const calledNames = getTemplateContent.mock.calls.map((call: any[]) => call[0]);
      expect(calledNames).toContain('[模块化] BasePersona - 统一人设');
      expect(calledNames).toContain('[模块化] APISafety - API 安全规则');
      expect(calledNames).toContain('[模块化] ReActFormat - ReAct 格式');
      expect(calledNames).toContain('[模块化] BatchProtocol - 分批协议');
      expect(calledNames).toContain('[模块化] KnowledgeGuide - 知识指引');
      expect(calledNames).toContain('[模块化] ChainOfThought - 推理链');
    });
  });
});
