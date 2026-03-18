/**
 * StateRegistry - 状态定义注册表
 *
 * 存储 StateDefinition 和 StateHandler 映射，提供注册和验证功能。
 * 需求: 1.1 (注册 StateDefinition), 1.2 (注册 StateHandler), 1.3 (验证完整性)
 */

import { StateDefinition, StateHandler, StateTransition } from './types';

/**
 * 验证错误 - 状态定义或处理器注册验证失败时抛出
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * StateRegistry - 管理状态定义和处理器的注册与查询
 */
export class StateRegistry {
  private definitions: Map<string, StateDefinition> = new Map();
  private handlers: Map<string, StateHandler> = new Map();
  private scopedHandlers: Map<string, Map<string, StateHandler>> = new Map();

  /**
   * 注册状态定义
   * 需求 1.1: 存储 StateDefinition 并验证结构完整性
   *
   * 验证规则:
   * - initialState 必须在 states[] 中
   * - 所有 terminalStates 必须在 states[] 中
   * - errorState（如设置）必须在 states[] 中
   * - degradedState（如设置）必须在 states[] 中
   * - 所有 transitions 的 from 和 to 必须在 states[] 中
   */
  registerDefinition(definition: StateDefinition): void {
    const stateSet = new Set(definition.states);

    // Validate initialState
    if (!stateSet.has(definition.initialState)) {
      throw new ValidationError(
        `Invalid initialState '${definition.initialState}': not found in states [${definition.states.join(', ')}]`,
      );
    }

    // Validate terminalStates
    for (const terminal of definition.terminalStates) {
      if (!stateSet.has(terminal)) {
        throw new ValidationError(
          `Invalid terminalState '${terminal}': not found in states [${definition.states.join(', ')}]`,
        );
      }
    }

    // Validate errorState
    if (definition.errorState !== undefined && !stateSet.has(definition.errorState)) {
      throw new ValidationError(
        `Invalid errorState '${definition.errorState}': not found in states [${definition.states.join(', ')}]`,
      );
    }

    // Validate degradedState
    if (definition.degradedState !== undefined && !stateSet.has(definition.degradedState)) {
      throw new ValidationError(
        `Invalid degradedState '${definition.degradedState}': not found in states [${definition.states.join(', ')}]`,
      );
    }

    // Validate transitions
    for (const transition of definition.transitions) {
      if (!stateSet.has(transition.from)) {
        throw new ValidationError(
          `Invalid transition: source state '${transition.from}' not found in states [${definition.states.join(', ')}]`,
        );
      }
      if (!stateSet.has(transition.to)) {
        throw new ValidationError(
          `Invalid transition: target state '${transition.to}' not found in states [${definition.states.join(', ')}]`,
        );
      }
    }

    this.definitions.set(definition.id, definition);
  }

  /**
   * 注册状态处理器
   * 需求 1.2: 建立 stateName → StateHandler 映射
   */
  registerHandler(stateName: string, handler: StateHandler): void {
    this.handlers.set(stateName, handler);
  }

  /**
   * 注册 definition-scoped 状态处理器
   * 使用 definitionId 作为作用域，避免不同流程的同名状态冲突
   */
  registerScopedHandler(definitionId: string, stateName: string, handler: StateHandler): void {
    let defHandlers = this.scopedHandlers.get(definitionId);
    if (!defHandlers) {
      defHandlers = new Map();
      this.scopedHandlers.set(definitionId, defHandlers);
    }
    defHandlers.set(stateName, handler);
  }

  /**
   * 验证状态定义的处理器完整性
   * 需求 1.3: 检查所有非终止状态节点均有对应的 StateHandler
   *
   * 终止状态不需要处理器，因为执行到达终止状态后即停止。
   */
  validate(definitionId: string): void {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new ValidationError(`Definition '${definitionId}' not found`);
    }

    const terminalSet = new Set(definition.terminalStates);
    const missingHandlers: string[] = [];

    for (const state of definition.states) {
      // Terminal states don't need handlers
      if (terminalSet.has(state)) {
        continue;
      }
      if (!this.hasHandler(state, definitionId)) {
        missingHandlers.push(state);
      }
    }

    if (missingHandlers.length > 0) {
      throw new ValidationError(
        `Missing handlers for non-terminal states in '${definitionId}': [${missingHandlers.join(', ')}]`,
      );
    }
  }

  /**
   * 获取状态定义
   */
  getDefinition(definitionId: string): StateDefinition | undefined {
    return this.definitions.get(definitionId);
  }

  /**
   * 获取状态处理器
   * 优先从 scoped map 查找（如果提供 definitionId），回退到全局 map
   */
  getHandler(stateName: string, definitionId?: string): StateHandler | undefined {
    if (definitionId) {
      const defHandlers = this.scopedHandlers.get(definitionId);
      if (defHandlers?.has(stateName)) {
        return defHandlers.get(stateName);
      }
    }
    return this.handlers.get(stateName);
  }

  /**
   * 检查是否存在指定状态的处理器
   * 同时检查 scoped（如果提供 definitionId）和全局
   */
  hasHandler(stateName: string, definitionId?: string): boolean {
    if (definitionId) {
      const defHandlers = this.scopedHandlers.get(definitionId);
      if (defHandlers?.has(stateName)) {
        return true;
      }
    }
    return this.handlers.has(stateName);
  }

  /**
   * 运行时注册新 StateHandler
   * 需求 6.1: 新注册的 StateHandler 可被已有 StateDefinition 的转移规则引用
   *
   * @param stateName - 状态名称
   * @param handler - 状态处理器
   * @throws ValidationError 当 stateName 为空时
   */
  registerHandlerRuntime(stateName: string, handler: StateHandler): void {
    if (!stateName) {
      throw new ValidationError('stateName must not be empty for runtime handler registration');
    }
    this.handlers.set(stateName, handler);
  }

  /**
   * 运行时添加新 StateTransition
   * 需求 6.2: 新转移规则可将已有状态连接到新注册的状态节点
   *
   * @param definitionId - 状态定义 ID
   * @param transition - 新的转移规则
   * @throws ValidationError 当定义不存在或转移的源/目标状态不在定义的状态枚举中
   */
  addTransitionRuntime(definitionId: string, transition: StateTransition): void {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new ValidationError(`Definition '${definitionId}' not found`);
    }

    const stateSet = new Set(definition.states);

    if (!stateSet.has(transition.from)) {
      throw new ValidationError(
        `Invalid transition: source state '${transition.from}' not found in states [${definition.states.join(', ')}]`,
      );
    }
    if (!stateSet.has(transition.to)) {
      throw new ValidationError(
        `Invalid transition: target state '${transition.to}' not found in states [${definition.states.join(', ')}]`,
      );
    }

    definition.transitions.push(transition);
  }

}
