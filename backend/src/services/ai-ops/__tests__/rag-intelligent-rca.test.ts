/**
 * RAG Intelligent RCA 单元测试
 * 验证基于 AI 驱动的“理解 -> 检索 -> 合成”完整链路。
 */

import { RAGEngine } from '../rag/ragEngine';
import { aiAnalyzer } from '../aiAnalyzer';
import { knowledgeBase } from '../rag/knowledgeBase';
import { AlertEvent } from '../../../types/ai-ops';

// Mock 外部依赖
jest.mock('../aiAnalyzer', () => ({
    aiAnalyzer: {
        analyzeClassifyAlert: jest.fn(),
        analyzeIntelligentRootCause: jest.fn(),
        analyzeAlert: jest.fn(),
    },
}));

jest.mock('../rag/knowledgeBase', () => ({
    knowledgeBase: {
        search: jest.fn(),
        recordUsage: jest.fn(),
        initialize: jest.fn(),
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

describe('RAG Intelligent RCA Flow', () => {
    let ragEngine: RAGEngine;

    beforeEach(() => {
        ragEngine = new RAGEngine();
        ragEngine.setAIAnalyzer(aiAnalyzer as any);
        (ragEngine as any).initialized = true;
        jest.clearAllMocks();
    });

    it('executeRootCauseAnalysis 应正确执行 AI 分类并进行类别过滤检索', async () => {
        const mockEvent: AlertEvent = {
            id: 'test-dhcp-alert',
            ruleId: 'rule-123',
            ruleName: 'Syslog: dhcp',
            source: 'syslog',
            metric: 'syslog',
            currentValue: 0,
            threshold: 0,
            status: 'active',
            severity: 'warning',
            message: 'dhcp-lan02 offering lease 10.20.2.154 without success',
            triggeredAt: Date.now(),
            timestamp: Date.now(),
        } as any;

        // 1. Mock AI 分类结果
        (aiAnalyzer.analyzeClassifyAlert as jest.Mock).mockResolvedValue({
            category: 'dhcp',
            subCategory: 'lease_offering_failure',
            reasoning: 'DHCP offer sent but no request received.',
            searchKeywords: ['dhcp lease failure'],
            isProtocolIssue: true,
            confidence: 0.9,
        });

        // 2. Mock 知识库搜索结果
        (knowledgeBase.search as jest.Mock).mockResolvedValue([]);

        // 3. Mock 最终智能合成结果
        (aiAnalyzer.analyzeIntelligentRootCause as jest.Mock).mockResolvedValue({
            rootCauses: [
                {
                    description: 'DHCP 租约分配失败',
                    confidence: 85,
                    evidence: ['日志证据'],
                },
            ],
            impact: {
                scope: 'local',
                affectedResources: [],
            },
        });

        // 模拟 metrics 采集成功
        (ragEngine as any).getSystemMetricsForEvent = jest.fn().mockResolvedValue({
            cpu: { usage: 0 },
            memory: { usage: 0 },
            disk: { usage: 0 },
            uptime: 0
        });

        // 执行分析
        const result = await (ragEngine as any).executeRootCauseAnalysis(mockEvent);

        // 验证 AI 分类被调用
        expect(aiAnalyzer.analyzeClassifyAlert).toHaveBeenCalledWith(mockEvent.message);

        // 验证知识库搜索使用了 AI 提取的类别进行过滤
        expect(knowledgeBase.search).toHaveBeenCalledWith(expect.objectContaining({
            category: 'dhcp',
        }));

        // 验证结果
        expect(result.rootCauses[0].description).toBe('DHCP 租约分配失败');
        expect(result.metadata.aiCategory).toBe('dhcp');
    });

    it('analyzeAlert 应返回 EnhancedAlertAnalysis 结构并处理无结果情况', async () => {
        const mockEvent: AlertEvent = {
            id: 'test-alert',
            ruleId: 'rule-456',
            ruleName: 'Test Rule',
            source: 'metrics',
            metric: 'cpu',
            currentValue: 95,
            threshold: 90,
            status: 'active',
            severity: 'critical',
            message: 'CPU usage too high',
            triggeredAt: Date.now(),
            timestamp: Date.now(),
        } as any;

        (aiAnalyzer.analyzeClassifyAlert as jest.Mock).mockResolvedValue({
            category: 'resource',
            confidence: 1.0,
            searchKeywords: ['cpu high'],
        });

        (knowledgeBase.search as jest.Mock).mockResolvedValue([]);

        // Mock feedback service
        (ragEngine as any)._feedbackService = {
            getFeedback: jest.fn().mockResolvedValue([]),
            getRuleStats: jest.fn().mockResolvedValue({ totalAlerts: 0, falsePositiveRate: 0 }),
        };

        // 执行分析
        const result = await ragEngine.analyzeAlert(mockEvent);

        // 验证结构
        expect(result).toHaveProperty('analysis');
        expect(result).toHaveProperty('classification');
        expect(result.classification.category).toBe('resource');
        expect(result.referenceStatus).toBe('not_found');
    });
});
