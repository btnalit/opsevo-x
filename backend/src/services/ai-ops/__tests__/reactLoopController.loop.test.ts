import { ReActLoopController, createExecutionContext, ParallelExecutionConfig } from '../rag/reactLoopController';
import { AIProvider, IAIProviderAdapter } from '../../../types/ai';
import { ExecutionMode } from '../../../types/parallel-execution';
import { ConversationMemory } from '../rag/mastraAgent';

jest.mock('../evolutionConfig', () => ({
  isCapabilityEnabled: jest.fn().mockReturnValue(false),
  getCapabilityConfig: jest.fn().mockReturnValue({ enabled: false, maxRetries: 0, timeoutMs: 0, patternLearningEnabled: false }),
}));

jest.mock('../criticService', () => ({
  criticService: {
    getRecentFailedReports: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../reflectorService', () => ({
  reflectorService: {
    reflect: jest.fn(),
    decideNextAction: jest.fn(),
    extractLearning: jest.fn(),
    persistLearning: jest.fn(),
  },
}));

jest.mock('../../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../rag/adaptiveModeSelector', () => ({
  adaptiveModeSelector: {
    selectMode: jest.fn(),
  },
  AdaptiveModeSelector: jest.fn(),
}));

jest.mock('../rag/parallelExecutor', () => ({
  parallelExecutor: {
    parseMultipleToolCalls: jest.fn(),
    setTools: jest.fn(),
    createBatch: jest.fn(),
    executeBatch: jest.fn(),
    formatForLLM: jest.fn(),
  },
  ParallelExecutor: jest.fn(),
}));

jest.mock('../brain/intentRegistry', () => ({
  executeIntent: jest.fn().mockResolvedValue({ success: true, output: { ok: true } }),
  getRegisteredIntents: jest.fn().mockReturnValue([]),
  listIntentCategories: jest.fn().mockReturnValue([]),
  getIntentSummaryForPrompt: jest.fn().mockReturnValue(''),
  getIntentSummaryForPromptFiltered: jest.fn().mockReturnValue(''),
  classifyIntentError: jest.fn().mockReturnValue('unknown'),
}));

const createMockAdapter = (): IAIProviderAdapter => ({
  chat: jest.fn().mockResolvedValue({ content: 'ok' } as any),
  chatStream: jest.fn().mockImplementation(async function* () {
    yield 'ok';
  }),
  validateApiKey: jest.fn().mockResolvedValue(true),
  listModels: jest.fn().mockResolvedValue(['test']),
});

const PARALLEL_DISABLED: ParallelExecutionConfig = {
  enabled: false,
  mode: 'auto',
  maxConcurrency: 5,
  batchTimeout: 60000,
  enablePlanning: true,
  planningTimeout: 1000,
  retryCount: 1,
  enableCircuitBreaker: true,
  rolloutPercentage: 100,
};

const PARALLEL_ENABLED: ParallelExecutionConfig = {
  ...PARALLEL_DISABLED,
  enabled: true,
};

const createMemory = (): ConversationMemory => ({
  sessionId: 's1',
  messages: [],
  context: {},
  createdAt: Date.now(),
  lastUpdated: Date.now(),
});

const createController = (parallelExecution: ParallelExecutionConfig = PARALLEL_DISABLED): ReActLoopController =>
  new ReActLoopController({
    maxIterations: 5,
    enableOutputValidation: false,
    enableSmartSummarization: false,
    enableUsageTracking: false,
    enableIntelligentRetrieval: false,
    knowledgeEnhancedMode: false,
    parallelExecution,
  });

describe('ReActLoopController - loop scenarios', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should continue when verification directive is pending (avoid early exit after first tool)', async () => {
    const controller = createController();
    const executeIntent = jest.fn()
      .mockResolvedValueOnce({
        success: true,
        output: { ok: true },
        verification_directive: {
          verify_action: 'verify_status',
          expected_condition: 'ok',
          verify_params: { id: '1' },
        },
      })
      .mockResolvedValueOnce({ success: true, output: { status: 'ok' } });

    controller.registerTool({
      name: 'execute_intent',
      description: 'execute intent',
      parameters: { action: { type: 'string', description: 'intent action', required: true } },
      execute: executeIntent,
    });

    jest.spyOn(controller as any, 'generateThoughtWithRawResponse').mockResolvedValue({ thought: 't', rawResponse: '' });
    const selectAction = jest.spyOn(controller as any, 'selectAction');
    selectAction
      .mockResolvedValueOnce({ toolName: 'execute_intent', toolInput: { action: 'apply_fix' } })
      .mockResolvedValueOnce({ toolName: 'execute_intent', toolInput: { action: 'verify_status' } });
    jest.spyOn(controller as any, 'shouldContinue').mockResolvedValue(false);
    jest.spyOn(controller as any, 'generateFinalAnswerFromSteps').mockResolvedValue('done');

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_DISABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(result.iterations).toBe(2);
    expect(executeIntent).toHaveBeenCalledTimes(2);
    expect(executeIntent.mock.calls[1][0].action).toBe('verify_status');
  });

  test('should auto-verify after threshold when verification is not executed by LLM', async () => {
    const { executeIntent: executeRegisteredIntent } = await import('../brain/intentRegistry');

    const controller = createController();
    const executeIntent = jest.fn().mockResolvedValue({
      success: true,
      output: { ok: true },
      verification_directive: {
        verify_action: 'verify_status',
        expected_condition: 'ok',
        verify_params: { id: '1' },
      },
    });
    const deviceQuery = jest.fn().mockResolvedValue({ success: true, data: [] });

    controller.registerTool({
      name: 'execute_intent',
      description: 'execute intent',
      parameters: { action: { type: 'string', description: 'intent action', required: true } },
      execute: executeIntent,
    });
    controller.registerTool({
      name: 'device_query',
      description: 'device query',
      parameters: { command: { type: 'string', description: 'command', required: true } },
      execute: deviceQuery,
    });

    jest.spyOn(controller as any, 'generateThoughtWithRawResponse').mockResolvedValue({ thought: 't', rawResponse: '' });
    const selectAction = jest.spyOn(controller as any, 'selectAction');
    selectAction
      .mockResolvedValueOnce({ toolName: 'execute_intent', toolInput: { action: 'apply_fix' } })
      .mockResolvedValueOnce({ toolName: 'device_query', toolInput: { command: '/system/resource' } });
    jest.spyOn(controller as any, 'shouldContinue').mockResolvedValue(false);
    jest.spyOn(controller as any, 'generateFinalAnswerFromSteps').mockResolvedValue('done');

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_DISABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(result.iterations).toBe(2);
    expect(executeRegisteredIntent as jest.Mock).toHaveBeenCalledTimes(1);
    expect((executeRegisteredIntent as jest.Mock).mock.calls[0][0]).toBe('verify_status');
  });

  test('planned mode should return early when plan succeeds', async () => {
    const { adaptiveModeSelector } = await import('../rag/adaptiveModeSelector');
    (adaptiveModeSelector.selectMode as jest.Mock).mockReturnValue({
      mode: ExecutionMode.PLANNED,
      confidence: 1,
      reason: 'test planned',
      estimatedToolCalls: 2,
      estimatedParallelism: 2,
    });

    const controller = createController(PARALLEL_ENABLED);
    const executePlannedMode = jest.spyOn(controller as any, 'executePlannedMode').mockResolvedValue({
      success: true,
      finalAnswer: 'planned done',
      iterations: 2,
      hasExecutedTool: true,
    });

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_ENABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(executePlannedMode).toHaveBeenCalledTimes(1);
    expect(result.finalAnswer).toBe('planned done');
    expect(result.iterations).toBe(2);
  });

  test('parallel mode should execute multiple tool calls in one iteration', async () => {
    const { adaptiveModeSelector } = await import('../rag/adaptiveModeSelector');
    const { parallelExecutor } = await import('../rag/parallelExecutor');

    (adaptiveModeSelector.selectMode as jest.Mock).mockReturnValue({
      mode: ExecutionMode.PARALLEL,
      confidence: 0.9,
      reason: 'test parallel',
      estimatedToolCalls: 2,
      estimatedParallelism: 2,
    });

    (parallelExecutor.parseMultipleToolCalls as jest.Mock).mockReturnValue([
      { toolName: 'device_query', params: { command: 'a' }, callId: 'c1', dependsOn: [] },
      { toolName: 'device_query', params: { command: 'b' }, callId: 'c2', dependsOn: [] },
    ]);
    (parallelExecutor.createBatch as jest.Mock).mockReturnValue({
      batchId: 'b1',
      calls: [],
      dependencies: { nodes: [], edges: [], hasCycle: false, topologicalOrder: [] },
      priority: 0,
    });
    (parallelExecutor.executeBatch as jest.Mock).mockResolvedValue({
      batchId: 'b1',
      totalDuration: 10,
      parallelism: 2,
      failureCount: 0,
      successCount: 2,
      results: [
        { callId: 'c1', toolName: 'device_query', duration: 5, success: true, output: { ok: 1 }, retryCount: 0 },
        { callId: 'c2', toolName: 'device_query', duration: 5, success: true, output: { ok: 2 }, retryCount: 0 },
      ],
      formattedText: 'ok',
    });
    (parallelExecutor.formatForLLM as jest.Mock).mockReturnValue('ok');

    const controller = createController(PARALLEL_ENABLED);
    const deviceQuery = jest.fn().mockResolvedValue({ success: true, data: [] });
    controller.registerTool({
      name: 'device_query',
      description: 'device query',
      parameters: { command: { type: 'string', description: 'command', required: true } },
      execute: deviceQuery,
    });

    jest.spyOn(controller as any, 'generateThoughtWithRawResponse').mockResolvedValue({
      thought: 't',
      rawResponse: 'Action 1: device_query\nAction Input 1: {}\nAction 2: device_query\nAction Input 2: {}',
    });
    jest.spyOn(controller as any, 'shouldContinue').mockResolvedValue(false);
    jest.spyOn(controller as any, 'generateFinalAnswerFromSteps').mockResolvedValue('done');

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_ENABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(parallelExecutor.executeBatch as jest.Mock).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(1);
    expect(result.finalAnswer).toBe('done');
  });

  test('should complete a specific tool chain in sequential mode', async () => {
    const controller = createController();
    const toolA = jest.fn().mockResolvedValue({ success: true, output: { ok: 'a' } });
    const toolB = jest.fn().mockResolvedValue({ success: true, output: { ok: 'b' } });

    controller.registerTool({
      name: 'tool_a',
      description: 'tool a',
      parameters: {},
      execute: toolA,
    });
    controller.registerTool({
      name: 'tool_b',
      description: 'tool b',
      parameters: {},
      execute: toolB,
    });

    jest.spyOn(controller as any, 'generateThoughtWithRawResponse').mockResolvedValue({ thought: 't', rawResponse: '' });
    const selectAction = jest.spyOn(controller as any, 'selectAction');
    selectAction
      .mockResolvedValueOnce({ toolName: 'tool_a', toolInput: {} })
      .mockResolvedValueOnce({ toolName: 'tool_b', toolInput: {} });
    const shouldContinue = jest.spyOn(controller as any, 'shouldContinue');
    shouldContinue.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    jest.spyOn(controller as any, 'generateFinalAnswerFromSteps').mockResolvedValue('done');

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_DISABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(result.iterations).toBe(2);
    expect(toolA).toHaveBeenCalledTimes(1);
    expect(toolB).toHaveBeenCalledTimes(1);
    expect(toolA.mock.invocationCallOrder[0]).toBeLessThan(toolB.mock.invocationCallOrder[0]);
  });

  test('should stop at max iterations when shouldContinue keeps returning true', async () => {
    const controller = new ReActLoopController({
      maxIterations: 2,
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_DISABLED,
    });

    const deviceQuery = jest.fn().mockResolvedValue({ success: true, data: [] });
    controller.registerTool({
      name: 'device_query',
      description: 'device query',
      parameters: { command: { type: 'string', description: 'command', required: true } },
      execute: deviceQuery,
    });

    jest.spyOn(controller as any, 'generateThoughtWithRawResponse').mockResolvedValue({ thought: 't', rawResponse: '' });
    jest.spyOn(controller as any, 'selectAction').mockResolvedValue({ toolName: 'device_query', toolInput: { command: '/system/resource' } });
    jest.spyOn(controller as any, 'shouldContinue').mockResolvedValue(true);
    jest.spyOn(controller as any, 'generateForcedFinalAnswer').mockResolvedValue('forced');

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_DISABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(result.iterations).toBe(2);
    expect(result.reachedMaxIterations).toBe(true);
    expect(result.finalAnswer).toBe('forced');
  });

  test('should stop normally when shouldContinue returns false', async () => {
    const controller = createController();
    const deviceQuery = jest.fn().mockResolvedValue({ success: true, data: [] });
    controller.registerTool({
      name: 'device_query',
      description: 'device query',
      parameters: { command: { type: 'string', description: 'command', required: true } },
      execute: deviceQuery,
    });

    jest.spyOn(controller as any, 'generateThoughtWithRawResponse').mockResolvedValue({ thought: 't', rawResponse: '' });
    jest.spyOn(controller as any, 'selectAction').mockResolvedValue({ toolName: 'device_query', toolInput: { command: '/system/resource' } });
    jest.spyOn(controller as any, 'shouldContinue').mockResolvedValue(false);
    jest.spyOn(controller as any, 'generateFinalAnswerFromSteps').mockResolvedValue('done');

    const executionContext = createExecutionContext(createMockAdapter(), AIProvider.OPENAI, 'test');
    executionContext.configOverrides = {
      enableOutputValidation: false,
      enableSmartSummarization: false,
      enableUsageTracking: false,
      enableIntelligentRetrieval: false,
      knowledgeEnhancedMode: false,
      parallelExecution: PARALLEL_DISABLED,
    };

    const result = await controller.executeLoop(
      'msg',
      { intent: 'test', tools: [], confidence: 1, requiresMultiStep: true },
      createMemory(),
      executionContext
    );

    expect(result.iterations).toBe(1);
    expect(result.reachedMaxIterations).toBe(false);
    expect(result.finalAnswer).toBe('done');
  });
});
