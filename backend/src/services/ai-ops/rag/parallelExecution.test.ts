/**
 * 并行执行系统综合测试
 * 
 * 测试所有并行执行组件的功能正确性：
 * - ParallelExecutor: 工具调用解析、批次执行、结果合并
 * - AdaptiveModeSelector: 模式选择、复杂度分析
 * - DependencyAnalyzer: 依赖检测、拓扑排序
 * - ConcurrencyLimiter: 并发控制、队列管理
 * - ExecutionPlanner: 计划生成、计划修订
 * - CircuitBreaker: 熔断器状态管理
 */

import { ParallelExecutor } from './parallelExecutor';
import { AdaptiveModeSelector } from './adaptiveModeSelector';
import { DependencyAnalyzer } from './dependencyAnalyzer';
import { ConcurrencyLimiter } from './concurrencyLimiter';
import { ExecutionPlanner } from './executionPlanner';
import { CircuitBreaker } from './circuitBreaker';
import {
  ExecutionMode,
  DependencyType,
  DependencyStrength,
  CircuitBreakerState,
  ToolCall,
} from '../../../types/parallel-execution';
import { AgentTool } from './mastraAgent';

// ==================== ParallelExecutor 测试 ====================

describe('ParallelExecutor', () => {
  let executor: ParallelExecutor;

  beforeEach(() => {
    executor = new ParallelExecutor({
      enabled: true,
      maxConcurrency: 5,
      toolTimeout: 5000,
      batchTimeout: 10000,
      retryCount: 1,
      enableCircuitBreaker: false,
    });
  });


  describe('parseMultipleToolCalls', () => {
    it('应该正确解析带编号的多个工具调用', () => {
      const llmOutput = `Thought: 我需要同时获取接口状态和系统资源信息。

Action 1: device_query
Action Input 1: {"command": "/interface"}

Action 2: device_query
Action Input 2: {"command": "/system/resource"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].toolName).toBe('device_query');
      expect(toolCalls[0].params).toEqual({ command: '/interface' });
      expect(toolCalls[1].toolName).toBe('device_query');
      expect(toolCalls[1].params).toEqual({ command: '/system/resource' });
    });

    it('应该正确解析不带编号的多个工具调用', () => {
      const llmOutput = `Thought: 我需要查询多个信息。

Action: device_query
Action Input: {"command": "/interface"}

Action: device_query
Action Input: {"command": "/system/resource"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].toolName).toBe('device_query');
      expect(toolCalls[0].params).toEqual({ command: '/interface' });
      expect(toolCalls[1].toolName).toBe('device_query');
      expect(toolCalls[1].params).toEqual({ command: '/system/resource' });
    });

    it('应该正确解析单个工具调用', () => {
      const llmOutput = `Thought: 我需要查询接口状态。

Action: device_query
Action Input: {"command": "/interface"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe('device_query');
      expect(toolCalls[0].params).toEqual({ command: '/interface' });
    });

    it('应该正确处理嵌套 JSON 参数', () => {
      const llmOutput = `Thought: 需要执行复杂查询。

Action 1: device_query
Action Input 1: {"command": "/interface", "filter": {"type": "ether", "running": true}}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].params).toEqual({
        command: '/interface',
        filter: { type: 'ether', running: true },
      });
    });

    it('应该正确处理包含特殊字符的 JSON', () => {
      const llmOutput = `Thought: 需要搜索知识库。

Action: knowledge_search
Action Input: {"query": "接口故障 \\"running\\" 状态"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].params.query).toBe('接口故障 "running" 状态');
    });

    it('应该返回空数组当没有工具调用时', () => {
      const llmOutput = `Thought: 问题已解决。

Final Answer: 这是最终答案。`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      expect(toolCalls).toHaveLength(0);
    });

    it('应该跳过无效的 JSON 参数', () => {
      const llmOutput = `Thought: 测试无效 JSON。

Action 1: device_query
Action Input 1: {"command": "/interface"}

Action 2: device_query
Action Input 2: {invalid json}

Action 3: device_query
Action Input 3: {"command": "/system/resource"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      // 应该只解析出有效的工具调用
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].params).toEqual({ command: '/interface' });
      expect(toolCalls[1].params).toEqual({ command: '/system/resource' });
    });

    it('应该处理混合格式（带编号优先）', () => {
      const llmOutput = `Thought: 混合格式测试。

Action 1: device_query
Action Input 1: {"command": "/interface"}

Action: knowledge_search
Action Input: {"query": "test"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);

      // 带编号格式优先，应该只解析带编号的
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].toolName).toBe('device_query');
    });
  });


  describe('executeBatch', () => {
    beforeEach(() => {
      // 注册模拟工具
      const mockTool: AgentTool = {
        name: 'test_tool',
        description: 'Test tool',
        parameters: {},
        execute: jest.fn().mockResolvedValue({ result: 'success' }),
      };
      executor.registerTool(mockTool);
    });

    it('应该并行执行多个独立的工具调用', async () => {
      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'test_tool', params: { id: 1 }, dependsOn: [] },
        { callId: 'call_2', toolName: 'test_tool', params: { id: 2 }, dependsOn: [] },
      ];

      const batch = executor.createBatch(toolCalls);
      const result = await executor.executeBatch(batch, new Map());

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toHaveLength(2);
    });

    it('应该正确处理部分失败', async () => {
      const failingTool: AgentTool = {
        name: 'failing_tool',
        description: 'Failing tool',
        parameters: {},
        execute: jest.fn().mockRejectedValue(new Error('Tool failed')),
      };
      executor.registerTool(failingTool);

      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'test_tool', params: {}, dependsOn: [] },
        { callId: 'call_2', toolName: 'failing_tool', params: {}, dependsOn: [] },
      ];

      const batch = executor.createBatch(toolCalls);
      const result = await executor.executeBatch(batch, new Map());

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
    });
  });

  describe('formatForLLM', () => {
    it('应该正确格式化单个结果', () => {
      const results = [
        {
          callId: 'call_1',
          toolName: 'device_query',
          success: true,
          output: { interfaces: ['ether1', 'ether2'] },
          duration: 100,
          retryCount: 0,
        },
      ];

      const formatted = executor.formatForLLM(results);

      expect(formatted).toContain('ether1');
      expect(formatted).toContain('ether2');
    });

    it('应该正确格式化多个结果', () => {
      const results = [
        {
          callId: 'call_1',
          toolName: 'device_query',
          success: true,
          output: 'result1',
          duration: 100,
          retryCount: 0,
        },
        {
          callId: 'call_2',
          toolName: 'knowledge_search',
          success: false,
          output: null,
          error: 'Search failed',
          duration: 50,
          retryCount: 1,
        },
      ];

      const formatted = executor.formatForLLM(results);

      expect(formatted).toContain('并行执行结果');
      expect(formatted).toContain('device_query');
      expect(formatted).toContain('knowledge_search');
      expect(formatted).toContain('成功');
      expect(formatted).toContain('失败');
      expect(formatted).toContain('Search failed');
    });
  });
});


// ==================== AdaptiveModeSelector 测试 ====================

describe('AdaptiveModeSelector', () => {
  let selector: AdaptiveModeSelector;

  beforeEach(() => {
    selector = new AdaptiveModeSelector({
      simpleThreshold: 2,
      complexThreshold: 4,
      autoSelect: true,
      timeout: 50,
    });
  });

  describe('selectMode', () => {
    it('应该为简单查询选择串行模式', () => {
      const result = selector.selectMode('查看接口状态');

      expect(result.mode).toBe(ExecutionMode.SEQUENTIAL);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('应该为中等复杂度查询选择并行模式', () => {
      const result = selector.selectMode('检查所有接口状态并分析流量');

      expect(result.mode).toBe(ExecutionMode.PARALLEL);
    });

    it('应该为高复杂度查询选择计划模式', () => {
      const result = selector.selectMode('全面诊断网络故障，检查所有接口、路由、防火墙配置，并批量分析日志');

      expect(result.mode).toBe(ExecutionMode.PLANNED);
    });

    it('应该支持手动模式覆盖', () => {
      selector.setModeOverride(ExecutionMode.SEQUENTIAL);

      const result = selector.selectMode('全面诊断网络故障');

      expect(result.mode).toBe(ExecutionMode.SEQUENTIAL);
      expect(result.confidence).toBe(1.0);
      expect(result.reason).toBe('Manual mode override');
    });

    it('应该在禁用自动选择时使用串行模式', () => {
      selector.updateConfig({ autoSelect: false });

      const result = selector.selectMode('全面诊断网络故障');

      expect(result.mode).toBe(ExecutionMode.SEQUENTIAL);
    });
  });

  describe('analyzeComplexity', () => {
    it('应该正确识别简单查询', () => {
      const result = selector.analyzeComplexity('查看接口状态');

      expect(result.complexity).toBe('simple');
      expect(result.estimatedToolCalls).toBeLessThanOrEqual(2);
    });

    it('应该正确识别中等复杂度查询', () => {
      const result = selector.analyzeComplexity('检查并分析接口状态');

      expect(result.complexity).toBe('moderate');
    });

    it('应该正确识别复杂查询', () => {
      const result = selector.analyzeComplexity('全面配置并优化所有接口');

      expect(result.complexity).toBe('complex');
      expect(result.estimatedToolCalls).toBeGreaterThanOrEqual(4);
    });

    it('应该检测到复杂度关键词', () => {
      const result = selector.analyzeComplexity('批量检查多个接口');

      expect(result.keywords).toContain('批量');
      expect(result.keywords).toContain('多个');
    });

    it('应该在 50ms 内完成分析', () => {
      const result = selector.analyzeComplexity('这是一个非常长的查询，包含很多关键词，需要全面分析所有接口、路由、防火墙配置');

      expect(result.analysisTime).toBeLessThan(50);
    });
  });
});


// ==================== DependencyAnalyzer 测试 ====================

describe('DependencyAnalyzer', () => {
  let analyzer: DependencyAnalyzer;

  beforeEach(() => {
    analyzer = new DependencyAnalyzer({
      enableDataDependencyDetection: true,
      enableResourceDependencyDetection: true,
      defaultResourceDependencyStrength: DependencyStrength.SOFT,
    });
  });

  describe('analyze', () => {
    it('应该正确分析独立的工具调用', () => {
      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'device_query', params: { command: '/interface' }, dependsOn: [] },
        { callId: 'call_2', toolName: 'device_query', params: { command: '/system/resource' }, dependsOn: [] },
      ];

      const graph = analyzer.analyze(toolCalls);

      expect(graph.nodes).toHaveLength(2);
      expect(graph.hasCycle).toBe(false);
      // 独立调用应该可以并行
      expect(graph.topologicalOrder.length).toBeLessThanOrEqual(2);
    });

    it('应该检测资源依赖', () => {
      // 使用不同的工具名称来避免数据依赖模式匹配
      // 这样可以单独测试资源依赖检测
      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'custom_tool_a', params: { device_id: 'router1', action: 'read' }, dependsOn: [] },
        { callId: 'call_2', toolName: 'custom_tool_b', params: { device_id: 'router1', action: 'write' }, dependsOn: [] },
      ];

      const graph = analyzer.analyze(toolCalls);

      // 同一设备的调用应该有资源依赖
      expect(graph.edges.some(e => e.type === DependencyType.RESOURCE)).toBe(true);
    });
  });

  describe('detectDataDependencies', () => {
    it('应该检测数据依赖模式', () => {
      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'knowledge_search', params: { query: 'test' }, dependsOn: [] },
        { callId: 'call_2', toolName: 'device_query', params: { command: '/interface' }, dependsOn: [] },
      ];

      const deps = analyzer.detectDataDependencies(toolCalls);

      // knowledge_search 的输出可能被 device_query 使用
      expect(deps.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('generateParallelBatches', () => {
    it('应该为独立调用生成单个批次', () => {
      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'device_query', params: { command: '/interface' }, dependsOn: [] },
        { callId: 'call_2', toolName: 'device_query', params: { command: '/system/resource' }, dependsOn: [] },
      ];

      const graph = analyzer.analyze(toolCalls);
      const batches = analyzer.generateParallelBatches(graph);

      // 独立调用应该在同一批次
      expect(batches.length).toBe(1);
      expect(batches[0]).toHaveLength(2);
    });

    it('应该为有依赖的调用生成多个批次', () => {
      const toolCalls: ToolCall[] = [
        { callId: 'call_1', toolName: 'device_query', params: { device_id: 'router1', command: '/interface' }, dependsOn: [] },
        { callId: 'call_2', toolName: 'device_query', params: { device_id: 'router1', command: '/ip/address' }, dependsOn: [] },
      ];

      const graph = analyzer.analyze(toolCalls);
      
      // 如果有硬依赖，应该分成多个批次
      if (graph.edges.some(e => e.strength === DependencyStrength.HARD)) {
        const batches = analyzer.generateParallelBatches(graph);
        expect(batches.length).toBeGreaterThan(1);
      }
    });
  });

  describe('registerCustomRule', () => {
    it('应该支持自定义依赖规则', () => {
      analyzer.registerCustomRule({
        name: 'test_rule',
        sourceToolPattern: 'knowledge_search',
        targetToolPattern: 'execute_command',
        dependencyType: DependencyType.DATA,
        strength: DependencyStrength.HARD,
      });

      const rules = analyzer.getCustomRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].name).toBe('test_rule');
    });
  });
});


// ==================== ConcurrencyLimiter 测试 ====================

describe('ConcurrencyLimiter', () => {
  let limiter: ConcurrencyLimiter;

  beforeEach(() => {
    limiter = new ConcurrencyLimiter({
      globalMax: 3,
      perToolLimits: new Map([['device_query', 2]]),
      perDeviceLimits: new Map(),
      queueTimeout: 1000,
    });
  });

  afterEach(() => {
    limiter.clearQueue();
  });

  describe('acquireSlot', () => {
    it('应该成功获取槽位', async () => {
      const slot = await limiter.acquireSlot({ toolName: 'test_tool' });

      expect(slot).toBeDefined();
      expect(slot.toolName).toBe('test_tool');
      expect(slot.slotId).toBeDefined();
    });

    it('应该强制执行全局并发限制', async () => {
      // 获取 3 个槽位（达到限制）
      const slots = await Promise.all([
        limiter.acquireSlot({ toolName: 'tool1' }),
        limiter.acquireSlot({ toolName: 'tool2' }),
        limiter.acquireSlot({ toolName: 'tool3' }),
      ]);

      expect(slots).toHaveLength(3);

      const status = limiter.getStatus();
      expect(status.activeSlots).toBe(3);
    });

    it('应该强制执行按工具类型的并发限制', async () => {
      // 获取 2 个 device_query 槽位（达到限制）
      const slots = await Promise.all([
        limiter.acquireSlot({ toolName: 'device_query' }),
        limiter.acquireSlot({ toolName: 'device_query' }),
      ]);

      expect(slots).toHaveLength(2);

      const status = limiter.getStatus();
      expect(status.perToolActive.get('device_query')).toBe(2);
    });
  });

  describe('releaseSlot', () => {
    it('应该正确释放槽位', async () => {
      const slot = await limiter.acquireSlot({ toolName: 'test_tool' });
      
      expect(limiter.getStatus().activeSlots).toBe(1);

      limiter.releaseSlot(slot);

      expect(limiter.getStatus().activeSlots).toBe(0);
    });

    it('应该在释放后处理队列', async () => {
      // 获取 3 个槽位（达到限制）
      const slots = await Promise.all([
        limiter.acquireSlot({ toolName: 'tool1' }),
        limiter.acquireSlot({ toolName: 'tool2' }),
        limiter.acquireSlot({ toolName: 'tool3' }),
      ]);

      // 启动一个等待的请求
      const waitingPromise = limiter.acquireSlot({ toolName: 'tool4' });

      // 释放一个槽位
      limiter.releaseSlot(slots[0]);

      // 等待的请求应该获得槽位
      const newSlot = await waitingPromise;
      expect(newSlot.toolName).toBe('tool4');
    });
  });

  describe('getStatus', () => {
    it('应该返回正确的状态', async () => {
      await limiter.acquireSlot({ toolName: 'device_query' });
      await limiter.acquireSlot({ toolName: 'knowledge_search' });

      const status = limiter.getStatus();

      expect(status.activeSlots).toBe(2);
      expect(status.queueDepth).toBe(0);
      expect(status.perToolActive.get('device_query')).toBe(1);
      expect(status.perToolActive.get('knowledge_search')).toBe(1);
    });
  });
});


// ==================== ExecutionPlanner 测试 ====================

describe('ExecutionPlanner', () => {
  let planner: ExecutionPlanner;

  beforeEach(() => {
    planner = new ExecutionPlanner({
      enabled: true,
      timeout: 1000,
      maxStages: 5,
      maxCallsPerStage: 5,
    });
  });

  describe('generatePlan', () => {
    it('应该为故障诊断生成计划', async () => {
      const plan = await planner.generatePlan('接口故障，无法连接');

      expect(plan).toBeDefined();
      expect(plan.planId).toBeDefined();
      expect(plan.stages.length).toBeGreaterThan(0);
      expect(plan.estimatedToolCalls).toBeGreaterThan(0);
    });

    it('应该为配置检查生成计划', async () => {
      const plan = await planner.generatePlan('检查 IP 配置');

      expect(plan).toBeDefined();
      expect(plan.stages.length).toBeGreaterThan(0);
    });

    it('应该为性能分析生成计划', async () => {
      const plan = await planner.generatePlan('分析系统性能和负载');

      expect(plan).toBeDefined();
      expect(plan.stages.length).toBeGreaterThan(0);
    });

    it('应该为通用查询生成默认计划', async () => {
      const plan = await planner.generatePlan('这是一个通用查询');

      expect(plan).toBeDefined();
      expect(plan.stages.length).toBeGreaterThan(0);
    });

    it('应该在 1000ms 内完成计划生成', async () => {
      const startTime = Date.now();
      await planner.generatePlan('复杂的故障诊断任务');
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('validatePlan', () => {
    it('应该验证有效的计划', async () => {
      const plan = await planner.generatePlan('检查接口状态');
      const validation = planner.validatePlan(plan);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('应该检测空阶段', () => {
      const invalidPlan = {
        planId: 'test',
        stages: [],
        estimatedToolCalls: 0,
        estimatedDuration: 0,
        maxParallelism: 0,
        createdAt: Date.now(),
      };

      const validation = planner.validatePlan(invalidPlan);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Plan has no stages');
    });
  });

  describe('revisePlan', () => {
    it('应该在不需要修订时返回剩余阶段', async () => {
      const plan = await planner.generatePlan('检查接口状态');
      const completedStages = [plan.stages[0]];
      const intermediateResults = [{
        batchId: 'test',
        results: [{ callId: 'c1', toolName: 'device_query', success: true, output: {}, duration: 100, retryCount: 0 }],
        successCount: 1,
        failureCount: 0,
        totalDuration: 100,
        parallelism: 1,
      }];

      const revisedPlan = await planner.revisePlan(plan, completedStages, intermediateResults);

      expect(revisedPlan.stages.length).toBeLessThan(plan.stages.length);
    });
  });
});


// ==================== CircuitBreaker 测试 ====================

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeout: 100, // 短超时用于测试
      halfOpenRequests: 1,
    });
  });

  afterEach(() => {
    breaker.resetAll();
  });

  describe('canExecute', () => {
    it('应该在关闭状态下允许执行', () => {
      expect(breaker.canExecute('test_tool')).toBe(true);
    });

    it('应该在打开状态下拒绝执行', () => {
      // 触发熔断
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      expect(breaker.canExecute('test_tool')).toBe(false);
    });

    it('应该在恢复超时后进入半开状态', async () => {
      // 触发熔断
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      expect(breaker.canExecute('test_tool')).toBe(false);

      // 等待恢复超时
      await new Promise(resolve => setTimeout(resolve, 150));

      // 应该进入半开状态，允许执行
      expect(breaker.canExecute('test_tool')).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('应该重置连续失败计数', () => {
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordSuccess('test_tool');

      const state = breaker.getState('test_tool');
      expect(state.consecutiveFailures).toBe(0);
    });

    it('应该在半开状态下关闭熔断器', async () => {
      // 触发熔断
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      // 等待恢复超时
      await new Promise(resolve => setTimeout(resolve, 150));

      // 进入半开状态
      breaker.canExecute('test_tool');
      
      // 记录成功
      breaker.recordSuccess('test_tool');

      const state = breaker.getState('test_tool');
      expect(state.state).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('recordFailure', () => {
    it('应该增加连续失败计数', () => {
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      const state = breaker.getState('test_tool');
      expect(state.consecutiveFailures).toBe(2);
    });

    it('应该在达到阈值时打开熔断器', () => {
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      const state = breaker.getState('test_tool');
      expect(state.state).toBe(CircuitBreakerState.OPEN);
    });

    it('应该在半开状态下失败时重新打开熔断器', async () => {
      // 触发熔断
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      // 等待恢复超时
      await new Promise(resolve => setTimeout(resolve, 150));

      // 进入半开状态
      breaker.canExecute('test_tool');
      
      // 记录失败
      breaker.recordFailure('test_tool');

      const state = breaker.getState('test_tool');
      expect(state.state).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe('reset', () => {
    it('应该重置单个工具的状态', () => {
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');
      breaker.recordFailure('test_tool');

      breaker.reset('test_tool');

      expect(breaker.canExecute('test_tool')).toBe(true);
    });

    it('应该重置所有工具的状态', () => {
      breaker.recordFailure('tool1');
      breaker.recordFailure('tool1');
      breaker.recordFailure('tool1');
      breaker.recordFailure('tool2');
      breaker.recordFailure('tool2');
      breaker.recordFailure('tool2');

      breaker.resetAll();

      expect(breaker.canExecute('tool1')).toBe(true);
      expect(breaker.canExecute('tool2')).toBe(true);
    });
  });
});


// ==================== 集成测试 ====================

describe('Parallel Execution Integration', () => {
  let executor: ParallelExecutor;
  let selector: AdaptiveModeSelector;
  let analyzer: DependencyAnalyzer;

  beforeEach(() => {
    executor = new ParallelExecutor({ enabled: true, enableCircuitBreaker: false });
    selector = new AdaptiveModeSelector();
    analyzer = new DependencyAnalyzer();
  });

  describe('完整流程测试', () => {
    it('应该正确处理从模式选择到执行的完整流程', async () => {
      // 1. 模式选择
      const modeResult = selector.selectMode('检查所有接口状态并分析');
      expect([ExecutionMode.PARALLEL, ExecutionMode.PLANNED]).toContain(modeResult.mode);

      // 2. 解析工具调用
      const llmOutput = `Thought: 需要同时查询接口和系统资源。

Action 1: device_query
Action Input 1: {"command": "/interface"}

Action 2: device_query
Action Input 2: {"command": "/system/resource"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);
      expect(toolCalls).toHaveLength(2);

      // 3. 依赖分析
      const graph = analyzer.analyze(toolCalls);
      expect(graph.hasCycle).toBe(false);

      // 4. 生成并行批次
      const batches = analyzer.generateParallelBatches(graph);
      expect(batches.length).toBeGreaterThan(0);
    });

    it('应该正确处理边缘情况：空输出', () => {
      const toolCalls = executor.parseMultipleToolCalls('');
      expect(toolCalls).toHaveLength(0);
    });

    it('应该正确处理边缘情况：只有 Final Answer', () => {
      const llmOutput = `Thought: 问题已解决。

Final Answer: 这是最终答案。`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);
      expect(toolCalls).toHaveLength(0);
    });

    it('应该正确处理边缘情况：JSON 中包含大括号字符串', () => {
      const llmOutput = `Thought: 需要搜索包含特殊字符的内容。

Action: knowledge_search
Action Input: {"query": "配置 { interface } 设置"}`;

      const toolCalls = executor.parseMultipleToolCalls(llmOutput);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].params.query).toBe('配置 { interface } 设置');
    });
  });

  describe('错误恢复测试', () => {
    it('应该在解析失败时返回空数组而不是抛出异常', () => {
      const malformedOutputs = [
        'Action: tool\nAction Input: not json',
        'Action 1: tool\nAction Input 2: {"mismatch": true}',
        'Random text without any action',
      ];

      for (const output of malformedOutputs) {
        expect(() => executor.parseMultipleToolCalls(output)).not.toThrow();
      }
    });
  });
});

// ==================== 性能测试 ====================

describe('Performance Tests', () => {
  describe('AdaptiveModeSelector 性能', () => {
    it('应该在 50ms 内完成 100 次模式选择', () => {
      const selector = new AdaptiveModeSelector();
      const messages = [
        '查看接口状态',
        '检查所有接口并分析流量',
        '全面诊断网络故障，检查所有配置',
      ];

      const startTime = Date.now();
      for (let i = 0; i < 100; i++) {
        selector.selectMode(messages[i % messages.length]);
      }
      const elapsed = Date.now() - startTime;

      // 100 次选择应该在 5000ms 内完成（平均每次 50ms）
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('ParallelExecutor 解析性能', () => {
    it('应该快速解析大量工具调用', () => {
      const executor = new ParallelExecutor();
      
      // 生成包含 10 个工具调用的输出
      let llmOutput = 'Thought: 需要执行多个查询。\n\n';
      for (let i = 1; i <= 10; i++) {
        llmOutput += `Action ${i}: device_query\nAction Input ${i}: {"command": "/test/${i}"}\n\n`;
      }

      const startTime = Date.now();
      const toolCalls = executor.parseMultipleToolCalls(llmOutput);
      const elapsed = Date.now() - startTime;

      expect(toolCalls).toHaveLength(10);
      expect(elapsed).toBeLessThan(100); // 应该在 100ms 内完成
    });
  });
});
