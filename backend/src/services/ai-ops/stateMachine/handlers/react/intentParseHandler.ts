/**
 * IntentParseHandler - 意图解析状态处理器
 *
 * 从 StateContext 读取 message 和 conversationContext，
 * 调用 IntentParser 解析用户意图，将 ParsedIntent 和 intentAnalysis 写入 StateContext。
 *
 * 需求: 3.2
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface IntentParseHandlerDeps {
  intentParser: {
    parse(message: string, conversationContext?: unknown): Promise<{
      confidence: number;
      intent: string;
      [key: string]: unknown;
    }>;
  };
}

export class IntentParseHandler implements StateHandler {
  readonly name = 'intentParseHandler';
  readonly capability: CapabilityName = 'intentDriven';

  constructor(private deps: IntentParseHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const message = context.get<string>('message');
    if (!message) {
      return {
        outcome: 'error',
        context,
        metadata: { error: 'Missing message in context' },
      };
    }

    const conversationContext = context.get<unknown>('conversationContext');
    const parsedIntent = await this.deps.intentParser.parse(message, conversationContext);

    context.set('parsedIntent', parsedIntent);
    // Fix #2: Store parsed intent overview separately instead of overwriting
    // the original intentAnalysis. The original intentAnalysis (from the caller)
    // contains tools, entities, requiresMultiStep etc. that SARC needs.
    // Only set intentAnalysis if it wasn't already provided in the initial context.
    const existingIntentAnalysis = context.get<unknown>('intentAnalysis');
    if (!existingIntentAnalysis) {
      context.set('intentAnalysis', {
        intent: parsedIntent.intent,
        confidence: parsedIntent.confidence,
      });
    }
    // Always store the parsed overview for routing decisions
    context.set('parsedIntentOverview', {
      intent: parsedIntent.intent,
      confidence: parsedIntent.confidence,
    });

    return { outcome: 'success', context };
  }
}
