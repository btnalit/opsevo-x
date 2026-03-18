/**
 * RoutingDecisionHandler - 路由决策状态处理器
 *
 * 根据 parsedIntent、intentAnalysis、ragContext 的置信度决定路由路径。
 * 返回 outcome: 'fastPath' | 'intentDriven' | 'reactLoop'
 * 将 routingPath 和 routingConfidence 写入 StateContext。
 *
 * 需求: 3.4
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface RoutingDecisionHandlerDeps {
  routingDecider: {
    decide(params: {
      parsedIntent: unknown;
      intentAnalysis: unknown;
      ragContext: unknown;
    }): Promise<{
      path: 'fastPath' | 'intentDriven' | 'reactLoop';
      confidence: number;
    }>;
  };
}

export class RoutingDecisionHandler implements StateHandler {
  readonly name = 'routingDecisionHandler';
  readonly capability: CapabilityName = 'intentDriven';

  constructor(private deps: RoutingDecisionHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const parsedIntent = context.get<unknown>('parsedIntent');
    const intentAnalysis = context.get<unknown>('intentAnalysis');
    const ragContext = context.get<unknown>('ragContext');

    const decision = await this.deps.routingDecider.decide({
      parsedIntent,
      intentAnalysis,
      ragContext,
    });

    context.set('routingPath', decision.path);
    context.set('routingConfidence', decision.confidence);

    return { outcome: decision.path, context };
  }
}
