/**
 * DegradationIntegration - 降级集成层
 *
 * 将 DegradationManager 与状态机执行器集成，提供：
 * - 降级节点自动跳过（shouldSkip）
 * - Handler 执行包装（wrapExecution）：成功时 recordSuccess，失败时 recordFailure
 * - 全路径降级检测（isFullPathDegraded）
 * - 降级节点追踪（getDegradedNodes）
 *
 * 需求: 7.1, 7.2, 7.3, 7.4
 */

import { DegradationManager } from '../../degradationManager';
import { StateHandler, StateContext, TransitionResult } from '../types';

export class DegradationIntegration {
  private degradationManager: DegradationManager;
  private degradedNodes: string[] = [];

  constructor(degradationManager: DegradationManager) {
    this.degradationManager = degradationManager;
  }

  /**
   * Check if a handler should be skipped due to its capability being degraded.
   * Handlers without a capability are never skipped.
   *
   * Requirement 7.1: Auto-skip degraded nodes
   */
  shouldSkip(handler: StateHandler): boolean {
    if (!handler.capability) {
      return false;
    }
    return !this.degradationManager.isAvailable(handler.capability);
  }

  /**
   * Wrap handler execution with degradation checks and success/failure recording.
   *
   * 1. If the handler's capability is degraded, skip execution and return a degraded outcome
   * 2. Execute the handler via the provided executeFn
   * 3. On success: call recordSuccess (Requirement 7.3)
   * 4. On failure: call recordFailure (Requirement 7.2)
   */
  async wrapExecution(
    handler: StateHandler,
    context: StateContext,
    executeFn: () => Promise<TransitionResult>,
  ): Promise<TransitionResult> {
    // Check degradation before execution
    if (this.shouldSkip(handler)) {
      this.degradedNodes.push(handler.name);
      return {
        outcome: 'degraded',
        context,
        metadata: {
          skipped: true,
          reason: 'capability_degraded',
          capability: handler.capability,
          handlerName: handler.name,
        },
      };
    }

    // Execute the handler
    try {
      const result = await executeFn();

      // Record success if handler has a capability
      if (handler.capability) {
        this.degradationManager.recordSuccess(handler.capability);
      }

      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Record failure if handler has a capability
      if (handler.capability) {
        this.degradationManager.recordFailure(handler.capability, error.message);
      }

      return {
        outcome: 'error',
        context,
        metadata: {
          error: error.message,
          errorName: error.name,
        },
      };
    }
  }

  /**
   * Check if all handlers in a path have degraded capabilities.
   * Returns true only when every handler with a capability is degraded
   * and there are no handlers without capabilities (which are always available).
   *
   * Requirement 7.4: Full-path degradation detection
   */
  isFullPathDegraded(handlers: StateHandler[]): boolean {
    if (handlers.length === 0) {
      return false;
    }

    for (const handler of handlers) {
      // Handlers without capability are always available
      if (!handler.capability) {
        return false;
      }
      // If any capability handler is available, path is not fully degraded
      if (this.degradationManager.isAvailable(handler.capability)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the list of handler names that were skipped due to degradation
   * during the current execution.
   */
  getDegradedNodes(): string[] {
    return [...this.degradedNodes];
  }

  /**
   * Reset the tracked degraded nodes. Call this at the start of each execution.
   */
  reset(): void {
    this.degradedNodes = [];
  }
}
