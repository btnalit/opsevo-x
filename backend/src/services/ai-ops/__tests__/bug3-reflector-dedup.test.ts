/**
 * Bug 3: 反思系统学习条目重复 — 单元测试
 * 
 * 验证:
 * - 相同意图条目被合并而非创建新条目
 * - 合并策略各字段处理正确
 * - 知识库索引失败时本地文件层仍执行去重
 * - loadRecentEntries 返回去重后的条目
 * - 不同意图条目继续创建独立新条目（保持检查）
 */

import fs from 'fs/promises';
import path from 'path';
import { ReflectorService } from '../reflectorService';

// Mock 所有外部依赖
jest.mock('../../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../rag', () => ({
  knowledgeBase: { search: jest.fn(), add: jest.fn(), initialize: jest.fn() },
}));

jest.mock('../aiAnalyzer', () => ({
  aiAnalyzer: {
    analyze: jest.fn(),
    analyzeAlert: jest.fn(),
    analyzeClassifyAlert: jest.fn(),
    analyzeIntelligentRootCause: jest.fn(),
    confirmFaultDiagnosis: jest.fn(),
  },
}));

jest.mock('../auditLogger', () => ({
  auditLogger: { log: jest.fn(), query: jest.fn(), cleanup: jest.fn() },
}));

jest.mock('fs/promises');

const mockFs = fs as jest.Mocked<typeof fs>;

function createEntry(overrides: Partial<any> = {}): any {
  return {
    id: 'entry-1',
    timestamp: Date.now(),
    iterationId: 'iter-1',
    failurePattern: 'interface down',
    rootCause: 'cable disconnected',
    effectiveSolution: 'reconnect cable',
    ineffectiveApproaches: ['restart router'],
    contextFactors: { intent: '检查接口状态' },
    confidence: 0.7,
    indexed: false,
    ...overrides,
  };
}

describe('Bug 3: 反思系统学习条目重复', () => {
  let service: any;

  beforeEach(() => {
    service = new ReflectorService();
    // 跳过初始化
    (service as any).initialized = true;
    (service as any).learningCache = new Map();
    (service as any).learningIndex = { entries: [], lastUpdated: 0 };
    // Mock ensureDataDirs
    (service as any).ensureDataDirs = jest.fn();
    // Mock saveIndex
    (service as any).saveIndex = jest.fn();
    // 清除所有 mock 调用记录
    jest.clearAllMocks();
  });

  afterEach(() => {
    // 清理可能的定时器，防止 timer 泄漏
    if (service) {
      service.stopCleanupTimer();
    }
  });

  // ==================== Task 3.4.1 ====================
  describe('相同意图条目合并', () => {
    it('相同意图的新条目应合并到已有条目', async () => {
      const existing = createEntry({ id: 'existing-1', confidence: 0.6, timestamp: 1000 });
      const newEntry = createEntry({ id: 'new-1', confidence: 0.8, timestamp: 2000 });

      // Mock 文件读取返回已有条目
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);
      mockFs.mkdir.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      // 验证写入的内容
      const writeCall = mockFs.writeFile.mock.calls[0];
      const written = JSON.parse(writeCall[1] as string);

      // 应该只有 1 条（合并后），而非 2 条
      expect(written.length).toBe(1);
      // 保留已有条目 ID
      expect(written[0].id).toBe('existing-1');
    });
  });

  // ==================== Task 3.4.2 ====================
  describe('合并策略字段处理', () => {
    it('confidence 应取较高值', async () => {
      const existing = createEntry({ id: 'e1', confidence: 0.6, timestamp: 1000 });
      const newEntry = createEntry({ id: 'n1', confidence: 0.9, timestamp: 2000 });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written[0].confidence).toBe(0.9);
    });

    it('timestamp 应取最新', async () => {
      const existing = createEntry({ id: 'e1', timestamp: 1000 });
      const newEntry = createEntry({ id: 'n1', timestamp: 5000 });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written[0].timestamp).toBe(5000);
    });

    it('effectiveSolution 应优先取最新非空值', async () => {
      const existing = createEntry({ id: 'e1', effectiveSolution: 'old solution', timestamp: 1000 });
      const newEntry = createEntry({ id: 'n1', effectiveSolution: 'new solution', timestamp: 2000 });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written[0].effectiveSolution).toBe('new solution');
    });

    it('ineffectiveApproaches 应合并去重', async () => {
      const existing = createEntry({ id: 'e1', ineffectiveApproaches: ['a', 'b'], timestamp: 1000 });
      const newEntry = createEntry({ id: 'n1', ineffectiveApproaches: ['b', 'c'], timestamp: 2000 });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written[0].ineffectiveApproaches).toEqual(expect.arrayContaining(['a', 'b', 'c']));
      expect(written[0].ineffectiveApproaches.length).toBe(3);
    });

    it('contextFactors 应浅合并', async () => {
      const existing = createEntry({
        id: 'e1',
        contextFactors: { intent: '检查接口状态', device: 'router1' },
        timestamp: 1000,
      });
      const newEntry = createEntry({
        id: 'n1',
        contextFactors: { intent: '检查接口状态', version: '7.0' },
        timestamp: 2000,
      });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written[0].contextFactors.device).toBe('router1');
      expect(written[0].contextFactors.version).toBe('7.0');
      expect(written[0].contextFactors.intent).toBe('检查接口状态');
    });
  });

  // ==================== Task 3.4.3 ====================
  describe('知识库索引失败时本地去重', () => {
    it('persistLearning 的 catch 分支调用 saveEntry 时仍执行去重', async () => {
      const existing = createEntry({ id: 'e1', timestamp: 1000 });
      const newEntry = createEntry({ id: 'n1', timestamp: 2000 });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      // saveEntry 内部会执行去重
      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written.length).toBe(1);
    });
  });

  // ==================== Task 3.4.4 ====================
  describe('loadRecentEntries 去重', () => {
    it('相同意图条目应只保留最新的一条', async () => {
      const entries1 = [
        createEntry({ id: 'e1', timestamp: 1000, contextFactors: { intent: '检查接口状态' } }),
        createEntry({ id: 'e2', timestamp: 3000, contextFactors: { intent: '检查接口状态' } }),
      ];
      const entries2 = [
        createEntry({ id: 'e3', timestamp: 2000, contextFactors: { intent: '检查接口状态' } }),
      ];

      mockFs.readdir.mockResolvedValue(['2026-01-01.json', '2026-01-02.json'] as any);
      mockFs.readFile.mockImplementation(async (filePath: any) => {
        if (String(filePath).includes('2026-01-01')) return JSON.stringify(entries1);
        if (String(filePath).includes('2026-01-02')) return JSON.stringify(entries2);
        throw new Error('ENOENT');
      });

      await (service as any).loadRecentEntries();

      // 应该只有 1 条（最新的 e2，timestamp=3000）
      expect((service as any).learningCache.size).toBe(1);
      expect((service as any).learningCache.has('e2')).toBe(true);
    });
  });

  // ==================== Task 3.4.5 ====================
  describe('不同意图条目保持检查', () => {
    it('不同意图的条目应创建独立新条目', async () => {
      const existing = createEntry({
        id: 'e1',
        contextFactors: { intent: '检查接口状态' },
        timestamp: 1000,
      });
      const newEntry = createEntry({
        id: 'n1',
        contextFactors: { intent: '检查 CPU 状态' },
        timestamp: 2000,
      });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      // 应该有 2 条（不同意图）
      expect(written.length).toBe(2);
    });
  });

  // ==================== 补充：indexed/knowledgeEntryId 字段保留 ====================
  describe('合并时保留 KB 索引状态', () => {
    it('已有条目的 indexed 和 knowledgeEntryId 应在合并后保留', async () => {
      const existing = createEntry({
        id: 'e1',
        indexed: true,
        knowledgeEntryId: 'kb-123',
        timestamp: 1000,
      });
      // 新条目没有 indexed/knowledgeEntryId（模拟 persistLearning 第二次调用前的状态）
      const newEntry = createEntry({
        id: 'n1',
        indexed: false,
        knowledgeEntryId: undefined,
        timestamp: 2000,
      });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written.length).toBe(1);
      expect(written[0].indexed).toBe(true);
      expect(written[0].knowledgeEntryId).toBe('kb-123');
    });

    it('新条目带有 indexed=true 时应覆盖旧值', async () => {
      const existing = createEntry({
        id: 'e1',
        indexed: false,
        knowledgeEntryId: undefined,
        timestamp: 1000,
      });
      const newEntry = createEntry({
        id: 'n1',
        indexed: true,
        knowledgeEntryId: 'kb-456',
        timestamp: 2000,
      });

      mockFs.readFile.mockResolvedValueOnce(JSON.stringify([existing]));
      mockFs.writeFile.mockResolvedValueOnce(undefined);

      await (service as any).saveEntry(newEntry);

      const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(written.length).toBe(1);
      expect(written[0].indexed).toBe(true);
      expect(written[0].knowledgeEntryId).toBe('kb-456');
    });
  });
});
