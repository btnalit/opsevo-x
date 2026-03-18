/**
 * KnowledgeRetrievalHandler - 知识检索状态处理器
 *
 * 执行知识检索，将 ragContext、formattedKnowledge、knowledgeReferences 写入 StateContext。
 *
 * 需求: 3.3
 */

import { StateHandler, StateContext, TransitionResult } from '../../types';
import { CapabilityName } from '../../../degradationManager';

export interface KnowledgeRetrievalHandlerDeps {
  knowledgeRetriever: {
    retrieve(query: string, intentAnalysis?: unknown): Promise<{
      ragContext: unknown;
      formattedKnowledge: unknown[];
      knowledgeReferences: unknown[];
    }>;
  };
}

export class KnowledgeRetrievalHandler implements StateHandler {
  readonly name = 'knowledgeRetrievalHandler';
  readonly capability: CapabilityName = 'experience';

  constructor(private deps: KnowledgeRetrievalHandlerDeps) {}

  canHandle(_context: StateContext): boolean {
    return true;
  }

  async handle(context: StateContext): Promise<TransitionResult> {
    const message = context.get<string>('message');
    const intentAnalysis = context.get<unknown>('intentAnalysis');

    const result = await this.deps.knowledgeRetriever.retrieve(
      message ?? '',
      intentAnalysis,
    );

    context.set('ragContext', result.ragContext);
    context.set('formattedKnowledge', result.formattedKnowledge);
    context.set('knowledgeReferences', result.knowledgeReferences);

    return { outcome: 'success', context };
  }
}
