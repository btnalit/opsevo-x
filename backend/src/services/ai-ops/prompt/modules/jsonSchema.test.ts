/**
 * JsonSchema 模块单元测试
 *
 * 验证 JSON Schema 输出约束模板的正确性、参数化能力和 Token 预算合规。
 *
 * @see Requirements 3.2 - 告警分析包含显式 JSON Schema 定义
 * @see Requirements 3.3 - 批量告警分析包含显式 JSON Schema 定义
 */

import {
  jsonSchema,
  JsonSchemaField,
  ALERT_ANALYSIS_SCHEMA,
  BATCH_ANALYSIS_SCHEMA,
  HEALTH_REPORT_SCHEMA,
  CONFIG_CHANGE_SCHEMA,
  FAULT_DIAGNOSIS_SCHEMA,
  PREDEFINED_SCHEMAS,
} from './jsonSchema';
import { PromptComposer } from '../promptComposer';

describe('JsonSchema module', () => {
  describe('module metadata', () => {
    it('should have the correct module name', () => {
      expect(jsonSchema.name).toBe('JsonSchema');
    });

    it('should have a token budget of 100', () => {
      expect(jsonSchema.tokenBudget).toBe(100);
    });

    it('should have no dependencies', () => {
      expect(jsonSchema.dependencies).toEqual([]);
    });

    it('should implement the PromptModule interface correctly', () => {
      expect(typeof jsonSchema.name).toBe('string');
      expect(typeof jsonSchema.tokenBudget).toBe('number');
      expect(Array.isArray(jsonSchema.dependencies)).toBe(true);
      expect(typeof jsonSchema.render).toBe('function');
    });
  });

  describe('predefined schemas', () => {
    it('should define alert analysis schema with required fields', () => {
      expect(ALERT_ANALYSIS_SCHEMA.length).toBeGreaterThan(0);
      const fieldNames = ALERT_ANALYSIS_SCHEMA.map((f) => f.name);
      expect(fieldNames).toContain('summary');
      expect(fieldNames).toContain('problemAnalysis');
      expect(fieldNames).toContain('impactAssessment');
      expect(fieldNames).toContain('recommendations');
      expect(fieldNames).toContain('riskLevel');
      expect(fieldNames).toContain('confidence');
    });

    it('should define batch analysis schema', () => {
      expect(BATCH_ANALYSIS_SCHEMA.length).toBeGreaterThan(0);
      const fieldNames = BATCH_ANALYSIS_SCHEMA.map((f) => f.name);
      expect(fieldNames).toContain('overallSummary');
      expect(fieldNames).toContain('alertGroups');
    });

    it('should define health report schema', () => {
      expect(HEALTH_REPORT_SCHEMA.length).toBeGreaterThan(0);
      const fieldNames = HEALTH_REPORT_SCHEMA.map((f) => f.name);
      expect(fieldNames).toContain('summary');
      expect(fieldNames).toContain('healthScore');
    });

    it('should define config change schema', () => {
      expect(CONFIG_CHANGE_SCHEMA.length).toBeGreaterThan(0);
      const fieldNames = CONFIG_CHANGE_SCHEMA.map((f) => f.name);
      expect(fieldNames).toContain('summary');
      expect(fieldNames).toContain('changeDetails');
    });

    it('should define fault diagnosis schema', () => {
      expect(FAULT_DIAGNOSIS_SCHEMA.length).toBeGreaterThan(0);
      const fieldNames = FAULT_DIAGNOSIS_SCHEMA.map((f) => f.name);
      expect(fieldNames).toContain('summary');
      expect(fieldNames).toContain('possibleCauses');
    });

    it('should have all predefined schemas in the PREDEFINED_SCHEMAS map', () => {
      expect(PREDEFINED_SCHEMAS).toHaveProperty('alertAnalysis');
      expect(PREDEFINED_SCHEMAS).toHaveProperty('batchAnalysis');
      expect(PREDEFINED_SCHEMAS).toHaveProperty('healthReport');
      expect(PREDEFINED_SCHEMAS).toHaveProperty('configChange');
      expect(PREDEFINED_SCHEMAS).toHaveProperty('faultDiagnosis');
    });

    it('should have valid field types in all schemas', () => {
      const validTypes = ['string', 'number', 'boolean', 'array', 'object'];
      const allSchemas = [
        ALERT_ANALYSIS_SCHEMA,
        BATCH_ANALYSIS_SCHEMA,
        HEALTH_REPORT_SCHEMA,
        CONFIG_CHANGE_SCHEMA,
        FAULT_DIAGNOSIS_SCHEMA,
      ];
      for (const schema of allSchemas) {
        for (const field of schema) {
          expect(validTypes).toContain(field.type);
        }
      }
    });

    it('should have constraints on riskLevel and confidence fields', () => {
      const riskLevel = ALERT_ANALYSIS_SCHEMA.find((f) => f.name === 'riskLevel');
      expect(riskLevel?.constraints).toBe('low|medium|high');

      const confidence = ALERT_ANALYSIS_SCHEMA.find((f) => f.name === 'confidence');
      expect(confidence?.constraints).toBe('0-1');
    });
  });

  describe('render()', () => {
    it('should return a non-empty string', () => {
      const content = jsonSchema.render();
      expect(content.trim().length).toBeGreaterThan(0);
    });

    it('should default to alert analysis schema when no context provided', () => {
      const content = jsonSchema.render();
      expect(content).toContain('summary');
      expect(content).toContain('problemAnalysis');
      expect(content).toContain('riskLevel');
      expect(content).toContain('confidence');
    });

    it('should default to alert analysis schema when context has no schema key', () => {
      const content = jsonSchema.render({ otherKey: 'value' });
      expect(content).toContain('summary');
      expect(content).toContain('problemAnalysis');
    });

    it('should select predefined schema by string key', () => {
      const content = jsonSchema.render({ schema: 'healthReport' });
      expect(content).toContain('healthScore');
      expect(content).toContain('abnormalIndicators');
      expect(content).not.toContain('problemAnalysis');
    });

    it('should select batch analysis schema by string key', () => {
      const content = jsonSchema.render({ schema: 'batchAnalysis' });
      expect(content).toContain('overallSummary');
      expect(content).toContain('alertGroups');
    });

    it('should select config change schema by string key', () => {
      const content = jsonSchema.render({ schema: 'configChange' });
      expect(content).toContain('changeDetails');
      expect(content).toContain('rollbackPlan');
    });

    it('should select fault diagnosis schema by string key', () => {
      const content = jsonSchema.render({ schema: 'faultDiagnosis' });
      expect(content).toContain('possibleCauses');
      expect(content).toContain('diagnosticSteps');
    });

    it('should fall back to alert analysis for unknown string key', () => {
      const content = jsonSchema.render({ schema: 'unknownType' });
      expect(content).toContain('problemAnalysis');
    });

    it('should accept custom schema array', () => {
      const customSchema: JsonSchemaField[] = [
        { name: 'customField', type: 'string', description: '自定义字段', required: true },
        { name: 'optionalField', type: 'number', description: '可选字段', required: false },
      ];
      const content = jsonSchema.render({ schema: customSchema });
      expect(content).toContain('customField');
      expect(content).toContain('optionalField');
      expect(content).not.toContain('problemAnalysis');
    });

    it('should format as JSON Schema definition text', () => {
      const content = jsonSchema.render();
      expect(content).toContain('(string, 必填)');
      expect(content).toContain('(number, 必填)');
      expect(content).toContain('(array, 必填)');
    });

    it('should include required fields in the required array', () => {
      const content = jsonSchema.render();
      expect(content).toContain('summary');
      expect(content).toContain('problemAnalysis');
    });

    it('should include constraints when defined', () => {
      const content = jsonSchema.render();
      expect(content).toContain('[low|medium|high]');
      expect(content).toContain('[0-1]');
    });

    it('should include section header', () => {
      const content = jsonSchema.render();
      expect(content).toContain('## 输出格式要求');
    });

    it('should format fields as a list', () => {
      const content = jsonSchema.render();
      expect(content).toContain('- summary');
      expect(content).toContain('- riskLevel');
    });
  });

  describe('token budget compliance', () => {
    const composer = new PromptComposer([]);

    it('should render default content within the 100 token budget', () => {
      const content = jsonSchema.render();
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(jsonSchema.tokenBudget);
    });

    it('should render alert analysis schema within budget', () => {
      const content = jsonSchema.render({ schema: 'alertAnalysis' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(jsonSchema.tokenBudget);
    });

    it('should render batch analysis schema within budget', () => {
      const content = jsonSchema.render({ schema: 'batchAnalysis' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(jsonSchema.tokenBudget);
    });

    it('should render health report schema within budget', () => {
      const content = jsonSchema.render({ schema: 'healthReport' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(jsonSchema.tokenBudget);
    });

    it('should render config change schema within budget', () => {
      const content = jsonSchema.render({ schema: 'configChange' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(jsonSchema.tokenBudget);
    });

    it('should render fault diagnosis schema within budget', () => {
      const content = jsonSchema.render({ schema: 'faultDiagnosis' });
      const tokens = composer.estimateTokens(content);
      expect(tokens).toBeLessThanOrEqual(jsonSchema.tokenBudget);
    });
  });
});
