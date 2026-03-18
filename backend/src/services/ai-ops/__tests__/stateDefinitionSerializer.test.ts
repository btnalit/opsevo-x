/**
 * StateDefinitionSerializer 单元测试
 *
 * 验证:
 * - serialize: 将 StateDefinition 序列化为 JSON 字符串
 * - deserialize: 将 JSON 字符串反序列化为 StateDefinition，包含格式验证
 * - prettyPrint: 格式化输出状态列表、转移规则和初始/终止状态
 *
 * 需求: 10.1, 10.2, 10.3, 10.4
 */

import { StateDefinitionSerializer } from '../stateMachine/stateDefinitionSerializer';
import { StateDefinition } from '../stateMachine/types';

const sampleDefinition: StateDefinition = {
  id: 'alert-pipeline',
  name: 'Alert Pipeline Orchestration',
  version: '1.0.0',
  states: ['rateLimit', 'normalize', 'deduplicate', 'filter', 'analyze', 'decide', 'rateLimited', 'dropped', 'filtered', 'error'],
  initialState: 'rateLimit',
  terminalStates: ['decide', 'rateLimited', 'dropped', 'filtered'],
  transitions: [
    { from: 'rateLimit', to: 'normalize', condition: 'passed' },
    { from: 'rateLimit', to: 'rateLimited', condition: 'limited' },
    { from: 'normalize', to: 'deduplicate' },
    { from: 'deduplicate', to: 'dropped', condition: 'isDuplicate' },
    { from: 'deduplicate', to: 'filter', condition: 'isUnique' },
    { from: 'filter', to: 'filtered', condition: 'isFiltered' },
    { from: 'filter', to: 'analyze', condition: 'passed' },
    { from: 'analyze', to: 'decide' },
  ],
  errorState: 'error',
  maxSteps: 20,
};

const minimalDefinition: StateDefinition = {
  id: 'minimal',
  name: 'Minimal',
  version: '0.1.0',
  states: ['start', 'end'],
  initialState: 'start',
  terminalStates: ['end'],
  transitions: [{ from: 'start', to: 'end' }],
};

describe('StateDefinitionSerializer', () => {
  describe('serialize', () => {
    it('should serialize a StateDefinition to a valid JSON string', () => {
      const json = StateDefinitionSerializer.serialize(sampleDefinition);
      expect(typeof json).toBe('string');
      const parsed = JSON.parse(json);
      expect(parsed.id).toBe('alert-pipeline');
    });

    it('should include all fields in the serialized output', () => {
      const json = StateDefinitionSerializer.serialize(sampleDefinition);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe(sampleDefinition.id);
      expect(parsed.name).toBe(sampleDefinition.name);
      expect(parsed.version).toBe(sampleDefinition.version);
      expect(parsed.states).toEqual(sampleDefinition.states);
      expect(parsed.initialState).toBe(sampleDefinition.initialState);
      expect(parsed.terminalStates).toEqual(sampleDefinition.terminalStates);
      expect(parsed.transitions).toEqual(sampleDefinition.transitions);
      expect(parsed.errorState).toBe(sampleDefinition.errorState);
      expect(parsed.maxSteps).toBe(sampleDefinition.maxSteps);
    });

    it('should handle optional fields being undefined', () => {
      const json = StateDefinitionSerializer.serialize(minimalDefinition);
      const parsed = JSON.parse(json);

      expect(parsed.errorState).toBeUndefined();
      expect(parsed.degradedState).toBeUndefined();
      expect(parsed.maxSteps).toBeUndefined();
      expect(parsed.maxExecutionTime).toBeUndefined();
    });

    it('should include optional fields when present', () => {
      const def: StateDefinition = {
        ...minimalDefinition,
        errorState: 'error',
        degradedState: 'degraded',
        maxSteps: 50,
        maxExecutionTime: 30000,
      };
      const json = StateDefinitionSerializer.serialize(def);
      const parsed = JSON.parse(json);

      expect(parsed.errorState).toBe('error');
      expect(parsed.degradedState).toBe('degraded');
      expect(parsed.maxSteps).toBe(50);
      expect(parsed.maxExecutionTime).toBe(30000);
    });
  });

  describe('deserialize', () => {
    it('should deserialize a valid JSON string to a StateDefinition', () => {
      const json = JSON.stringify(sampleDefinition);
      const result = StateDefinitionSerializer.deserialize(json);

      expect(result.id).toBe(sampleDefinition.id);
      expect(result.name).toBe(sampleDefinition.name);
      expect(result.version).toBe(sampleDefinition.version);
      expect(result.states).toEqual(sampleDefinition.states);
      expect(result.initialState).toBe(sampleDefinition.initialState);
      expect(result.terminalStates).toEqual(sampleDefinition.terminalStates);
      expect(result.transitions).toEqual(sampleDefinition.transitions);
    });

    it('should throw on invalid JSON', () => {
      expect(() => StateDefinitionSerializer.deserialize('not-json')).toThrow();
    });

    it('should throw when required field "id" is missing', () => {
      const invalid = { name: 'test', version: '1.0.0', states: ['a'], initialState: 'a', terminalStates: ['a'], transitions: [] };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(invalid))).toThrow();
    });

    it('should throw when required field "name" is missing', () => {
      const invalid = { id: 'test', version: '1.0.0', states: ['a'], initialState: 'a', terminalStates: ['a'], transitions: [] };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(invalid))).toThrow();
    });

    it('should throw when required field "states" is missing', () => {
      const invalid = { id: 'test', name: 'test', version: '1.0.0', initialState: 'a', terminalStates: ['a'], transitions: [] };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(invalid))).toThrow();
    });

    it('should throw when "states" is not an array', () => {
      const invalid = { id: 'test', name: 'test', version: '1.0.0', states: 'not-array', initialState: 'a', terminalStates: ['a'], transitions: [] };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(invalid))).toThrow();
    });

    it('should throw when "transitions" is not an array', () => {
      const invalid = { id: 'test', name: 'test', version: '1.0.0', states: ['a'], initialState: 'a', terminalStates: ['a'], transitions: 'bad' };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(invalid))).toThrow();
    });

    it('should throw when a transition is missing "from" or "to"', () => {
      const missingFrom = {
        id: 'test', name: 'test', version: '1.0.0',
        states: ['a', 'b'], initialState: 'a', terminalStates: ['b'],
        transitions: [{ to: 'b' }],
      };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(missingFrom))).toThrow();

      const missingTo = {
        id: 'test', name: 'test', version: '1.0.0',
        states: ['a', 'b'], initialState: 'a', terminalStates: ['b'],
        transitions: [{ from: 'a' }],
      };
      expect(() => StateDefinitionSerializer.deserialize(JSON.stringify(missingTo))).toThrow();
    });

    it('should preserve optional fields when present', () => {
      const full: StateDefinition = {
        ...sampleDefinition,
        degradedState: 'degraded',
        maxExecutionTime: 60000,
      };
      const json = JSON.stringify(full);
      const result = StateDefinitionSerializer.deserialize(json);

      expect(result.errorState).toBe('error');
      expect(result.degradedState).toBe('degraded');
      expect(result.maxSteps).toBe(20);
      expect(result.maxExecutionTime).toBe(60000);
    });
  });

  describe('round-trip (serialize → deserialize)', () => {
    it('should produce an equivalent object after round-trip', () => {
      const json = StateDefinitionSerializer.serialize(sampleDefinition);
      const result = StateDefinitionSerializer.deserialize(json);

      expect(result).toEqual(sampleDefinition);
    });

    it('should produce an equivalent object for minimal definition', () => {
      const json = StateDefinitionSerializer.serialize(minimalDefinition);
      const result = StateDefinitionSerializer.deserialize(json);

      expect(result).toEqual(minimalDefinition);
    });

    it('should produce an equivalent object with all optional fields', () => {
      const full: StateDefinition = {
        ...sampleDefinition,
        degradedState: 'degraded',
        maxExecutionTime: 60000,
      };
      const json = StateDefinitionSerializer.serialize(full);
      const result = StateDefinitionSerializer.deserialize(json);

      expect(result).toEqual(full);
    });
  });

  describe('prettyPrint', () => {
    it('should include the state machine name and version', () => {
      const output = StateDefinitionSerializer.prettyPrint(sampleDefinition);
      expect(output).toContain('Alert Pipeline Orchestration');
      expect(output).toContain('1.0.0');
    });

    it('should include all state names', () => {
      const output = StateDefinitionSerializer.prettyPrint(sampleDefinition);
      for (const state of sampleDefinition.states) {
        expect(output).toContain(state);
      }
    });

    it('should include the initial state', () => {
      const output = StateDefinitionSerializer.prettyPrint(sampleDefinition);
      expect(output).toContain('rateLimit');
    });

    it('should include terminal states', () => {
      const output = StateDefinitionSerializer.prettyPrint(sampleDefinition);
      for (const ts of sampleDefinition.terminalStates) {
        expect(output).toContain(ts);
      }
    });

    it('should include transition rules with from → to', () => {
      const output = StateDefinitionSerializer.prettyPrint(sampleDefinition);
      // Check that transitions are represented
      expect(output).toContain('rateLimit');
      expect(output).toContain('normalize');
      expect(output).toContain('→');
    });

    it('should include transition conditions when present', () => {
      const output = StateDefinitionSerializer.prettyPrint(sampleDefinition);
      expect(output).toContain('passed');
      expect(output).toContain('limited');
      expect(output).toContain('isDuplicate');
    });

    it('should work for minimal definition', () => {
      const output = StateDefinitionSerializer.prettyPrint(minimalDefinition);
      expect(output).toContain('Minimal');
      expect(output).toContain('start');
      expect(output).toContain('end');
    });

    it('should include transition priority when present', () => {
      const defWithPriority: StateDefinition = {
        ...minimalDefinition,
        transitions: [{ from: 'start', to: 'end', priority: 1 }],
      };
      const output = StateDefinitionSerializer.prettyPrint(defWithPriority);
      expect(output).toContain('1');
    });
  });
});
