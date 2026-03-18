/**
 * ReActLoopAdapter - 将 ReActLoopController 包装为 StateHandler
 *
 * 适配器模式实现，将现有的 ReActLoopController 包装为状态机的 StateHandler 接口，
 * 实现 StateContext ↔ ReActExecutionContext + IntentAnalysis 格式转换。
 * 不修改 ReActLoopController 内部实现。
 *
 * 需求: 9.1, 9.2
 */

import { StateHandler, StateContext, TransitionResult } from '../types';
import { ReActLoopController, ReActExecutionContext } from '../../rag/reactLoopController';
import { ConversationMemory } from '../../rag/mastraAgent';
import { IntentAnalysis } from '../../../../types/ai-ops';

/**
 * ReActLoopAdapter - 将 ReActLoopController 包装为 StateHandler
 *
 * 数据映射:
 *   StateContext → ReActLoopController 输入:
 *     context.get('message')             → message
 *     context.get('intentAnalysis')      → intentAnalysis
 *     context.get('conversationContext') → ConversationMemory
 *     context.get('executionContext')    → ReActExecutionContext
 *
 *   ReActLoopController 输出 → StateContext:
 *     ReActLoopResult                    → context.set('result', ...)
 *     result.steps                       → context.set('steps', ...)
 *     result.finalAnswer                 → context.set('finalAnswer', ...)
 *     result.iterations                  → context.set('iterations', ...)
 *     result.ragContext                  → context.set('ragContext', ...)
 *     result.knowledgeReferences         → context.set('knowledgeReferences', ...)
 */
export class ReActLoopAdapter implements StateHandler {
  readonly name = 'ReActLoopAdapter';

  private readonly controller: ReActLoopController;

  constructor(controller: ReActLoopController) {
    this.controller = controller;
  }

  /**
   * 判断上下文是否包含 ReActLoopController 所需的必要数据
   */
  canHandle(context: StateContext): boolean {
    const message = context.get<string>('message');
    const executionContext = context.get<ReActExecutionContext>('executionContext');
    return message !== undefined && executionContext !== undefined;
  }

  /**
   * 执行适配：从 StateContext 提取数据，调用 ReActLoopController.executeLoop，
   * 将结果写回 StateContext
   */
  async handle(context: StateContext): Promise<TransitionResult> {
    try {
      // === StateContext → ReActLoopController 输入格式转换 ===
      const message = context.get<string>('message') ?? '';
      const intentAnalysis = context.get<IntentAnalysis>('intentAnalysis') ?? this.defaultIntentAnalysis(message);
      const conversationContext = context.get<ConversationMemory>('conversationContext') ?? this.defaultConversationMemory();
      const executionContext = context.get<ReActExecutionContext>('executionContext')!;

      // === 调用 ReActLoopController（不修改其内部实现） ===
      const result = await this.controller.executeLoop(
        message,
        intentAnalysis,
        conversationContext,
        executionContext,
      );

      // === ReActLoopController 输出 → StateContext 格式转换 ===
      context.set('result', result);
      context.set('steps', result.steps);
      context.set('finalAnswer', result.finalAnswer);
      context.set('iterations', result.iterations);

      if (result.ragContext) {
        context.set('ragContext', result.ragContext);
      }
      if (result.knowledgeReferences) {
        context.set('knowledgeReferences', result.knowledgeReferences);
      }

      return { outcome: 'success', context };
    } catch (error) {
      context.set('error', error instanceof Error ? error.message : String(error));
      return { outcome: 'error', context };
    }
  }

  /** 当 StateContext 中没有 intentAnalysis 时使用的默认值 */
  private defaultIntentAnalysis(message: string): IntentAnalysis {
    return {
      intent: message,
      tools: [],
      confidence: 0.5,
      requiresMultiStep: false,
    };
  }

  /** 当 StateContext 中没有 conversationContext 时使用的默认值 */
  private defaultConversationMemory(): ConversationMemory {
    return {
      sessionId: `default_${Date.now()}`,
      messages: [],
      context: {},
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    };
  }
}
