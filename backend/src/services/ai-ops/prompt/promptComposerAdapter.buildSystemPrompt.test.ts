/**
 * PromptComposerAdapter.buildSystemPrompt 单元测试
 *
 * 测试动态 Prompt 组装功能：
 * - 向量检索 Top-K Prompt 片段 (F1.3)
 * - 注入设备 CapabilityManifest (F1.4)
 * - 回退到通用默认 Prompt (F1.5)
 */

import { PromptComposerAdapter } from './promptComposerAdapter';
import { PromptComposer } from './promptComposer';
import type { VectorStoreClient, VectorSearchResult, VectorSearchQuery } from '../rag/vectorStoreClient';
import type { DeviceDriverManager } from '../../device/deviceDriverManager';
import type { CapabilityManifest } from '../../../types/device-driver';

// ── Mock Factories ──────────────────────────────────────────────────────────

function createMockVectorClient(
  searchResults: VectorSearchResult[] = [],
  shouldThrow = false,
): Partial<VectorStoreClient> {
  return {
    search: jest.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Vector store unavailable');
      return searchResults;
    }),
    upsert: jest.fn().mockResolvedValue([]),
  };
}

function createMockDeviceDriverManager(
  manifest: CapabilityManifest | null = null,
): Partial<DeviceDriverManager> {
  return {
    getCapabilityManifest: jest.fn().mockReturnValue(manifest),
  };
}

const sampleManifest: CapabilityManifest = {
  driverType: 'api',
  vendor: 'GenericVendor',
  model: 'Model-X',
  commands: [
    {
      actionType: 'query',
      description: '查询设备状态',
      readOnly: true,
      riskLevel: 'low',
    },
    {
      actionType: 'configure',
      description: '修改设备配置',
      readOnly: false,
      riskLevel: 'high',
    },
  ],
  metricsCapabilities: ['cpu', 'memory', 'interfaces'],
  dataCapabilities: ['topology'],
};

const sampleFragments: VectorSearchResult[] = [
  {
    id: 'frag-1',
    text: '当设备 CPU 使用率超过 80% 时，应检查进程列表并考虑重启高负载服务。',
    score: 0.92,
    metadata: { category: 'experience', deviceTypes: ['*'] },
  },
  {
    id: 'frag-2',
    text: '执行配置变更前，务必创建配置快照以支持回滚。',
    score: 0.85,
    metadata: { category: 'operation_rule', deviceTypes: ['*'] },
  },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PromptComposerAdapter.buildSystemPrompt', () => {
  it('should return default prompt when no vectorClient is provided', async () => {
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer);

    const result = await adapter.buildSystemPrompt({
      intentDescription: '检查设备健康状态',
    });

    expect(result).toContain('智能运维助手');
    expect(result).toContain('检查设备健康状态');
  });

  it('should use vector search results when available (F1.3)', async () => {
    const mockVector = createMockVectorClient(sampleFragments);
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer, undefined, {
      vectorClient: mockVector as VectorStoreClient,
    });

    const result = await adapter.buildSystemPrompt({
      intentDescription: 'CPU 过高诊断',
    });

    // Should contain fragment text
    expect(result).toContain('CPU 使用率超过 80%');
    expect(result).toContain('配置快照');
    // Should contain relevance scores
    expect(result).toContain('0.92');
    // Should contain intent
    expect(result).toContain('CPU 过高诊断');
    // Should NOT contain default prompt (fragments were found)
    expect(result).not.toContain('智能运维助手');

    // Verify search was called with correct params
    expect(mockVector.search).toHaveBeenCalledWith('prompt_knowledge', expect.objectContaining({
      collection: 'prompt_knowledge',
      query: 'CPU 过高诊断',
      top_k: 3,
    }));
  });

  it('should fall back to default prompt when vector search returns empty (F1.5)', async () => {
    const mockVector = createMockVectorClient([]);
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer, undefined, {
      vectorClient: mockVector as VectorStoreClient,
    });

    const result = await adapter.buildSystemPrompt({
      intentDescription: '未知操作',
    });

    expect(result).toContain('智能运维助手');
    expect(result).toContain('未知操作');
  });

  it('should fall back to default prompt when vector search throws (F1.5)', async () => {
    const mockVector = createMockVectorClient([], true);
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer, undefined, {
      vectorClient: mockVector as VectorStoreClient,
    });

    const result = await adapter.buildSystemPrompt({
      intentDescription: '故障诊断',
    });

    expect(result).toContain('智能运维助手');
    expect(result).toContain('故障诊断');
  });

  it('should inject device CapabilityManifest when deviceId is provided (F1.4)', async () => {
    const mockVector = createMockVectorClient(sampleFragments);
    const mockDriverMgr = createMockDeviceDriverManager(sampleManifest);
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer, undefined, {
      vectorClient: mockVector as VectorStoreClient,
      deviceDriverManager: mockDriverMgr as unknown as DeviceDriverManager,
    });

    const result = await adapter.buildSystemPrompt({
      deviceId: 'device-123',
      intentDescription: '查看设备状态',
    });

    // Should contain capability info
    expect(result).toContain('目标设备能力');
    expect(result).toContain('GenericVendor');
    expect(result).toContain('Model-X');
    expect(result).toContain('查询设备状态');
    expect(result).toContain('修改设备配置');
    expect(result).toContain('[风险: high]');
    expect(result).toContain('cpu, memory, interfaces');

    // Verify device type filter was used in search
    expect(mockVector.search).toHaveBeenCalledWith('prompt_knowledge', expect.objectContaining({
      filter: { deviceTypes: { $in: ['api', '*'] } },
    }));
  });

  it('should work without deviceDriverManager when deviceId is provided', async () => {
    const mockVector = createMockVectorClient(sampleFragments);
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer, undefined, {
      vectorClient: mockVector as VectorStoreClient,
      // no deviceDriverManager
    });

    const result = await adapter.buildSystemPrompt({
      deviceId: 'device-123',
      intentDescription: '查看设备状态',
    });

    // Should still work, just without capabilities section
    expect(result).not.toContain('目标设备能力');
    expect(result).toContain('查看设备状态');
  });

  it('should include tickContext when provided', async () => {
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer);

    const result = await adapter.buildSystemPrompt({
      intentDescription: '巡检任务',
      tickContext: { tickId: 'tick-42', phase: 'orient' },
    });

    expect(result).toContain('执行上下文');
    expect(result).toContain('tick-42');
    expect(result).toContain('orient');
  });

  it('should not include tickContext section when tickContext is empty', async () => {
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer);

    const result = await adapter.buildSystemPrompt({
      intentDescription: '简单查询',
      tickContext: {},
    });

    expect(result).not.toContain('执行上下文');
  });

  it('should preserve backward compatibility — existing build methods still work', () => {
    const composer = new PromptComposer([]);
    const adapter = new PromptComposerAdapter(composer);

    // buildReActPrompt should still work
    const reactResult = adapter.buildReActPrompt('test message', 'tools', 'steps');
    expect(reactResult).toBeTruthy();
    expect(typeof reactResult).toBe('string');

    // buildAlertAnalysisPrompt should still work
    const alertResult = adapter.buildAlertAnalysisPrompt({
      ruleName: 'test',
      severity: 'high',
      alertData: '{}',
    });
    expect(alertResult).toBeTruthy();
    expect(typeof alertResult).toBe('string');
  });
});
