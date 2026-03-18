/**
 * StateDefinitionSerializer - JSON 序列化/反序列化/pretty print
 *
 * 提供 StateDefinition 的序列化、反序列化和格式化输出功能。
 * 需求: 10.1, 10.2, 10.3, 10.4
 */

import { StateDefinition, StateTransition } from './types';

export class StateDefinitionSerializer {
  /**
   * 将 StateDefinition 序列化为 JSON 字符串
   * 需求 10.1
   */
  static serialize(definition: StateDefinition): string {
    return JSON.stringify(definition);
  }

  /**
   * 将 JSON 字符串反序列化为 StateDefinition 对象，包含格式验证
   * 需求 10.2
   */
  static deserialize(json: string): StateDefinition {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('Invalid JSON: failed to parse input string');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid format: expected a JSON object');
    }

    const obj = parsed as Record<string, unknown>;

    // Validate required string fields
    for (const field of ['id', 'name', 'version', 'initialState'] as const) {
      if (typeof obj[field] !== 'string') {
        throw new Error(`Invalid format: "${field}" must be a string`);
      }
    }

    // Validate required array fields
    if (!Array.isArray(obj.states)) {
      throw new Error('Invalid format: "states" must be an array');
    }
    if (!Array.isArray(obj.terminalStates)) {
      throw new Error('Invalid format: "terminalStates" must be an array');
    }
    if (!Array.isArray(obj.transitions)) {
      throw new Error('Invalid format: "transitions" must be an array');
    }

    // Validate each transition
    for (const t of obj.transitions as unknown[]) {
      if (typeof t !== 'object' || t === null) {
        throw new Error('Invalid format: each transition must be an object');
      }
      const transition = t as Record<string, unknown>;
      if (typeof transition.from !== 'string') {
        throw new Error('Invalid format: transition "from" must be a string');
      }
      if (typeof transition.to !== 'string') {
        throw new Error('Invalid format: transition "to" must be a string');
      }
    }

    const definition: StateDefinition = {
      id: obj.id as string,
      name: obj.name as string,
      version: obj.version as string,
      states: obj.states as string[],
      initialState: obj.initialState as string,
      terminalStates: obj.terminalStates as string[],
      transitions: (obj.transitions as Record<string, unknown>[]).map((t) => {
        const transition: StateTransition = {
          from: t.from as string,
          to: t.to as string,
        };
        if (t.condition !== undefined) transition.condition = t.condition as string;
        if (t.priority !== undefined) transition.priority = t.priority as number;
        return transition;
      }),
    };

    // Copy optional fields only when present
    if (obj.errorState !== undefined) definition.errorState = obj.errorState as string;
    if (obj.degradedState !== undefined) definition.degradedState = obj.degradedState as string;
    if (obj.maxSteps !== undefined) definition.maxSteps = obj.maxSteps as number;
    if (obj.maxExecutionTime !== undefined) definition.maxExecutionTime = obj.maxExecutionTime as number;

    return definition;
  }

  /**
   * 格式化输出状态列表、转移规则和初始/终止状态
   * 需求 10.3
   */
  static prettyPrint(definition: StateDefinition): string {
    const lines: string[] = [];

    lines.push(`State Machine: ${definition.name} (v${definition.version})`);
    lines.push(`ID: ${definition.id}`);
    lines.push('');

    // States
    lines.push(`States (${definition.states.length}):`);
    for (const state of definition.states) {
      let label = `  - ${state}`;
      if (state === definition.initialState) label += ' [initial]';
      if (definition.terminalStates.includes(state)) label += ' [terminal]';
      if (state === definition.errorState) label += ' [error]';
      if (state === definition.degradedState) label += ' [degraded]';
      lines.push(label);
    }
    lines.push('');

    // Transitions
    lines.push(`Transitions (${definition.transitions.length}):`);
    for (const t of definition.transitions) {
      let rule = `  ${t.from} → ${t.to}`;
      if (t.condition) rule += ` [${t.condition}]`;
      if (t.priority !== undefined) rule += ` (priority: ${t.priority})`;
      lines.push(rule);
    }
    lines.push('');

    // Initial / Terminal
    lines.push(`Initial State: ${definition.initialState}`);
    lines.push(`Terminal States: ${definition.terminalStates.join(', ')}`);

    // Optional config
    if (definition.maxSteps !== undefined) {
      lines.push(`Max Steps: ${definition.maxSteps}`);
    }
    if (definition.maxExecutionTime !== undefined) {
      lines.push(`Max Execution Time: ${definition.maxExecutionTime}ms`);
    }

    return lines.join('\n');
  }
}
