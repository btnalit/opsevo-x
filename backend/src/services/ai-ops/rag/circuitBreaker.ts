/**
 * CircuitBreaker - 熔断器
 * 
 * 实现熔断器模式，防止对失败工具的重复调用
 * 
 * Requirements: 6.5
 * - 实现三态状态机（CLOSED, OPEN, HALF_OPEN）
 * - 连续失败超过阈值时打开熔断器
 * - 恢复超时后进入半开状态尝试恢复
 */

import { logger } from '../../../utils/logger';
import {
  CircuitBreakerState,
  CircuitBreakerConfig,
  ToolCircuitBreakerState,
  ParallelExecutionError,
  ParallelExecutionErrorType,
} from '../../../types/parallel-execution';

/**
 * 默认熔断器配置
 */
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  recoveryTimeout: 30000,
  halfOpenRequests: 1,
};

/**
 * CircuitBreaker 类
 * 管理工具的熔断状态
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  
  /** 各工具的熔断状态 */
  private toolStates: Map<string, ToolCircuitBreakerState> = new Map();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('CircuitBreaker initialized', { config: this.config });
  }

  /**
   * 检查是否允许执行
   * Requirements: 6.5
   * 
   * @param toolName 工具名称
   * @returns 是否允许执行
   * @throws ParallelExecutionError 如果熔断器打开
   */
  canExecute(toolName: string): boolean {
    const state = this.getOrCreateState(toolName);
    
    switch (state.state) {
      case CircuitBreakerState.CLOSED:
        return true;
        
      case CircuitBreakerState.OPEN:
        // 检查是否可以进入半开状态
        if (this.shouldTransitionToHalfOpen(state)) {
          this.transitionToHalfOpen(toolName);
          return true;
        }
        return false;
        
      case CircuitBreakerState.HALF_OPEN:
        // 半开状态下允许有限的请求
        return state.halfOpenSuccesses < this.config.halfOpenRequests;
        
      default:
        return true;
    }
  }

  /**
   * 检查是否允许执行（抛出异常版本）
   * 
   * @param toolName 工具名称
   * @throws ParallelExecutionError 如果熔断器打开
   */
  checkCanExecute(toolName: string): void {
    if (!this.canExecute(toolName)) {
      const state = this.getOrCreateState(toolName);
      throw new ParallelExecutionError(
        ParallelExecutionErrorType.CIRCUIT_BREAKER_OPEN,
        `Circuit breaker is open for tool: ${toolName}`,
        {
          toolName,
          state: state.state,
          consecutiveFailures: state.consecutiveFailures,
          lastFailureTime: state.lastFailureTime,
        },
        true
      );
    }
  }

  /**
   * 记录成功
   * Requirements: 6.5
   * 
   * @param toolName 工具名称
   */
  recordSuccess(toolName: string): void {
    const state = this.getOrCreateState(toolName);
    
    state.lastSuccessTime = Date.now();
    state.consecutiveFailures = 0;
    
    if (state.state === CircuitBreakerState.HALF_OPEN) {
      state.halfOpenSuccesses++;
      
      // 检查是否可以关闭熔断器
      if (state.halfOpenSuccesses >= this.config.halfOpenRequests) {
        this.transitionToClosed(toolName);
      }
    }
    
    logger.debug('Circuit breaker recorded success', {
      toolName,
      state: state.state,
    });
  }

  /**
   * 记录失败
   * Requirements: 6.5
   * 
   * @param toolName 工具名称
   */
  recordFailure(toolName: string): void {
    const state = this.getOrCreateState(toolName);
    
    state.lastFailureTime = Date.now();
    state.consecutiveFailures++;
    
    if (state.state === CircuitBreakerState.HALF_OPEN) {
      // 半开状态下失败，立即打开熔断器
      this.transitionToOpen(toolName);
    } else if (state.state === CircuitBreakerState.CLOSED) {
      // 检查是否需要打开熔断器
      if (state.consecutiveFailures >= this.config.failureThreshold) {
        this.transitionToOpen(toolName);
      }
    }
    
    logger.debug('Circuit breaker recorded failure', {
      toolName,
      state: state.state,
      consecutiveFailures: state.consecutiveFailures,
    });
  }

  /**
   * 获取工具的熔断状态
   * 
   * @param toolName 工具名称
   * @returns 熔断状态
   */
  getState(toolName: string): ToolCircuitBreakerState {
    return this.getOrCreateState(toolName);
  }

  /**
   * 获取所有工具的熔断状态
   * 
   * @returns 所有工具的熔断状态
   */
  getAllStates(): Map<string, ToolCircuitBreakerState> {
    return new Map(this.toolStates);
  }

  /**
   * 重置工具的熔断状态
   * 
   * @param toolName 工具名称
   */
  reset(toolName: string): void {
    this.toolStates.delete(toolName);
    logger.debug('Circuit breaker reset', { toolName });
  }

  /**
   * 重置所有熔断状态
   */
  resetAll(): void {
    this.toolStates.clear();
    logger.debug('All circuit breakers reset');
  }

  /**
   * 更新配置
   * 
   * @param config 部分配置更新
   */
  updateConfig(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('CircuitBreaker config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  // ==================== 私有方法 ====================

  /**
   * 获取或创建工具状态
   */
  private getOrCreateState(toolName: string): ToolCircuitBreakerState {
    let state = this.toolStates.get(toolName);
    
    if (!state) {
      state = {
        toolName,
        state: CircuitBreakerState.CLOSED,
        consecutiveFailures: 0,
        halfOpenSuccesses: 0,
      };
      this.toolStates.set(toolName, state);
    }
    
    return state;
  }

  /**
   * 检查是否应该从 OPEN 转换到 HALF_OPEN
   */
  private shouldTransitionToHalfOpen(state: ToolCircuitBreakerState): boolean {
    if (state.state !== CircuitBreakerState.OPEN) {
      return false;
    }
    
    if (!state.lastFailureTime) {
      return true;
    }
    
    const elapsed = Date.now() - state.lastFailureTime;
    return elapsed >= this.config.recoveryTimeout;
  }

  /**
   * 转换到 OPEN 状态
   */
  private transitionToOpen(toolName: string): void {
    const state = this.getOrCreateState(toolName);
    state.state = CircuitBreakerState.OPEN;
    state.halfOpenSuccesses = 0;
    
    logger.warn('Circuit breaker opened', {
      toolName,
      consecutiveFailures: state.consecutiveFailures,
    });
  }

  /**
   * 转换到 HALF_OPEN 状态
   * 
   * @risk CIRCUIT_BREAKER_RACE_CONDITION
   * @impact 半开状态下多个并发请求可能同时通过 canExecute 检查，
   *         导致超过 halfOpenRequests 限制的请求被执行
   * @mitigation
   *   1. 使用原子操作或锁来保护状态转换
   *   2. 限制半开状态下的并发请求数
   *   3. 实现请求排队机制
   *   4. 当前实现依赖 halfOpenSuccesses 计数，在高并发场景下可能不精确
   */
  private transitionToHalfOpen(toolName: string): void {
    const state = this.getOrCreateState(toolName);
    state.state = CircuitBreakerState.HALF_OPEN;
    state.halfOpenSuccesses = 0;
    
    logger.info('Circuit breaker half-open', { toolName });
  }

  /**
   * 转换到 CLOSED 状态
   */
  private transitionToClosed(toolName: string): void {
    const state = this.getOrCreateState(toolName);
    state.state = CircuitBreakerState.CLOSED;
    state.consecutiveFailures = 0;
    state.halfOpenSuccesses = 0;
    
    logger.info('Circuit breaker closed', { toolName });
  }
}

// 导出单例实例
export const circuitBreaker = new CircuitBreaker();
