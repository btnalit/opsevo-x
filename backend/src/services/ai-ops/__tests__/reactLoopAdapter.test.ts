/**
 * ReActLoopAdapter 单元测试
 *
 * 验证:
 * - 将 ReActLoopController 包装为 StateHandler 接口
 * - StateContext → ReActLoopController 输入格式转换（message, intentAnalysis, conversationContext, executionContext）
 * - ReActLoopController 输出 → StateContext 格式转换（result, steps, finalAnswer）
 * - canHandle 正确判断上下文是否包含必要数据
 * - 不修改 ReActLoopController 内部实现
 *
 * 需求: 9.1, 9.2
 */

import { ReActLoopAdapter } from '../stateMachine/adapters/reactLoopAdapter';
import { StateContext, TransitionResult } from '../stateMachine/types';
import { ReActLoopController, ReActLoopResult, ReActExecutionContext } from '../rag/reactLoopController';
import { ConversationMemory } from '../rag/mastraAgent';
import { IntentAnalysis } from '../../../types/ai-ops';

// ============================================================
// Helpers
// ============================================================

/** Create a minimal StateContext stub */
function makeContext(overrides: Partial<StateContext> = {}): StateContext {
  const data = new Map<string, unknown>();
  return {
    requestId: 'req-test-1',
    executionId: 'exec-test-1',
    currentState: 'ReActLoop',
    stateHistory: [],
    data,
    metadata: {},
    timings: new Map(),
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      data.set(key, value);
    },
    ...overrides,
  };
}

function makeIntentAnalysis(overrides: Partial<IntentAnalysis> = {}): IntentAnalysis {
  return {
    intent: 'check system status',
    tools: [{ name: 'system_check', params: {}, reason: 'check status' }],
    confidence: 0.8,
    requiresMultiStep: false,
    ...overrides,
  };
}

function makeConversationMemory(overrides: Partial<ConversationMemory> = {}): ConversationMemory {
  return {
    sessionId: 'session-1',
    messages: [],
    context: {},
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function makeExecutionContext(overrides: Partial<ReActExecutionContext> = {}): ReActExecutionContext {
  return {
    requestId: 'req-exec-1',
    toolInterceptors: new Map(),
    systemPromptOverride: null,
    aiAdapter: null,
    provider: 'openai' as any,
    model: 'gpt-4o',
    toolCallPatterns: [],
    hasExecutedTool: false,
    ...overrides,
  };
}

function makeReActLoopResult(overrides: Partial<ReActLoopResult> = {}): ReActLoopResult {
  return {
    steps: [
      {
        type: 'thought' as any,
        content: 'Analyzing the request',
        timestamp: Date.now(),
      },
    ],
    finalAnswer: 'System is running normally.',
    iterations: 2,
    reachedMaxIterations: false,
    totalDuration: 1500,
    ...overrides,
  };
}

/** Create a mock ReActLoopController */
function makeMockController(result?: ReActLoopResult): ReActLoopController {
  const mockResult = result ?? makeReActLoopResult();
  const controller = {
    executeLoop: jest.fn().mockResolvedValue(mockResult),
  } as unknown as ReActLoopController;
  return controller;
}

// ============================================================
// Tests
// ============================================================

describe('ReActLoopAdapter', () => {
  describe('constructor and properties', () => {
    it('should have name "ReActLoopAdapter"', () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);
      expect(adapter.name).toBe('ReActLoopAdapter');
    });

    it('should implement StateHandler interface', () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);
      expect(typeof adapter.canHandle).toBe('function');
      expect(typeof adapter.handle).toBe('function');
      expect(typeof adapter.name).toBe('string');
    });
  });

  describe('canHandle', () => {
    it('should return true when context has message and executionContext', () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);
      const ctx = makeContext();
      ctx.set('message', 'hello');
      ctx.set('executionContext', makeExecutionContext());

      expect(adapter.canHandle(ctx)).toBe(true);
    });

    it('should return false when context is missing message', () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);
      const ctx = makeContext();
      ctx.set('executionContext', makeExecutionContext());

      expect(adapter.canHandle(ctx)).toBe(false);
    });

    it('should return false when context is missing executionContext', () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);
      const ctx = makeContext();
      ctx.set('message', 'hello');

      expect(adapter.canHandle(ctx)).toBe(false);
    });
  });

  describe('handle - format conversion StateContext → ReActLoopController input', () => {
    it('should extract message, intentAnalysis, conversationContext, executionContext from StateContext and call executeLoop', async () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);

      const message = 'Check the router status';
      const intentAnalysis = makeIntentAnalysis();
      const conversationContext = makeConversationMemory();
      const executionContext = makeExecutionContext();

      const ctx = makeContext();
      ctx.set('message', message);
      ctx.set('intentAnalysis', intentAnalysis);
      ctx.set('conversationContext', conversationContext);
      ctx.set('executionContext', executionContext);

      await adapter.handle(ctx);

      expect(controller.executeLoop).toHaveBeenCalledTimes(1);
      expect(controller.executeLoop).toHaveBeenCalledWith(
        message,
        intentAnalysis,
        conversationContext,
        executionContext,
      );
    });

    it('should use default intentAnalysis when not provided in context', async () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'hello');
      ctx.set('executionContext', makeExecutionContext());

      await adapter.handle(ctx);

      expect(controller.executeLoop).toHaveBeenCalledTimes(1);
      const callArgs = (controller.executeLoop as jest.Mock).mock.calls[0];
      // message
      expect(callArgs[0]).toBe('hello');
      // intentAnalysis should be a default/fallback
      expect(callArgs[1]).toBeDefined();
      expect(callArgs[1].intent).toBeDefined();
      expect(callArgs[1].confidence).toBeDefined();
    });

    it('should use default conversationContext when not provided in context', async () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'hello');
      ctx.set('executionContext', makeExecutionContext());
      ctx.set('intentAnalysis', makeIntentAnalysis());

      await adapter.handle(ctx);

      const callArgs = (controller.executeLoop as jest.Mock).mock.calls[0];
      // conversationContext should be a default/fallback
      expect(callArgs[2]).toBeDefined();
      expect(callArgs[2].sessionId).toBeDefined();
      expect(callArgs[2].messages).toBeDefined();
    });
  });

  describe('handle - format conversion ReActLoopController output → StateContext', () => {
    it('should write result, steps, and finalAnswer to StateContext', async () => {
      const expectedResult = makeReActLoopResult({
        steps: [
          { type: 'thought' as any, content: 'Step 1', timestamp: 1000 },
          { type: 'action' as any, content: 'Step 2', timestamp: 2000 },
        ],
        finalAnswer: 'All systems operational.',
        iterations: 3,
      });
      const controller = makeMockController(expectedResult);
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'check status');
      ctx.set('executionContext', makeExecutionContext());

      const result = await adapter.handle(ctx);

      // Verify result is written to context
      expect(result.context.get('result')).toEqual(expectedResult);
      expect(result.context.get('steps')).toEqual(expectedResult.steps);
      expect(result.context.get('finalAnswer')).toBe('All systems operational.');
    });

    it('should write iterations to StateContext', async () => {
      const expectedResult = makeReActLoopResult({ iterations: 5 });
      const controller = makeMockController(expectedResult);
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'test');
      ctx.set('executionContext', makeExecutionContext());

      const result = await adapter.handle(ctx);

      expect(result.context.get('iterations')).toBe(5);
    });

    it('should return outcome "success" on successful execution', async () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'test');
      ctx.set('executionContext', makeExecutionContext());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('success');
    });

    it('should return outcome "error" when executeLoop throws', async () => {
      const controller = {
        executeLoop: jest.fn().mockRejectedValue(new Error('LLM timeout')),
      } as unknown as ReActLoopController;
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'test');
      ctx.set('executionContext', makeExecutionContext());

      const result = await adapter.handle(ctx);

      expect(result.outcome).toBe('error');
      expect(result.context.get('error')).toBeDefined();
    });

    it('should preserve ragContext and knowledgeReferences in StateContext when present', async () => {
      const ragContext = { documents: [], query: 'test' };
      const knowledgeRefs = [{ id: 'ref-1', source: 'kb', relevance: 0.9 }];
      const expectedResult = makeReActLoopResult({
        ragContext: ragContext as any,
        knowledgeReferences: knowledgeRefs as any,
      });
      const controller = makeMockController(expectedResult);
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'test');
      ctx.set('executionContext', makeExecutionContext());

      const result = await adapter.handle(ctx);

      expect(result.context.get('ragContext')).toEqual(ragContext);
      expect(result.context.get('knowledgeReferences')).toEqual(knowledgeRefs);
    });
  });

  describe('handle - does not modify ReActLoopController', () => {
    it('should only call executeLoop without modifying controller state', async () => {
      const controller = makeMockController();
      const adapter = new ReActLoopAdapter(controller);

      const ctx = makeContext();
      ctx.set('message', 'test');
      ctx.set('executionContext', makeExecutionContext());

      await adapter.handle(ctx);

      // Only executeLoop should have been called
      const mockController = controller as any;
      expect(mockController.executeLoop).toHaveBeenCalledTimes(1);
      // No other methods should have been called
      expect(Object.keys(mockController).filter(k => typeof mockController[k] === 'function' && k !== 'executeLoop')
        .every(k => !mockController[k].mock || mockController[k].mock.calls.length === 0)).toBe(true);
    });
  });
});
