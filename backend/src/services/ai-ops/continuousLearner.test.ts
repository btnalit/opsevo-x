/**
 * ContinuousLearner 持续学习协调器 单元测试
 *
 * Requirements: 5.1, 5.4, 5.5, 5.6
 */

import { ContinuousLearner } from './continuousLearner';
import { patternLearner } from './patternLearner';
import { knowledgeGraphBuilder } from './knowledgeGraphBuilder';
import { ContinuousLearningConfig } from './evolutionConfig';
import * as evolutionConfig from './evolutionConfig';

// Mock dependencies
jest.mock('./patternLearner', () => {
  const mockPatternLearner = {
    recordOperation: jest.fn().mockReturnValue({ id: 'op_1' }),
    identifyPatterns: jest.fn().mockReturnValue([]),
    triggerLearnPatterns: jest.fn(),
    promoteToBestPractice: jest.fn().mockResolvedValue(null),
    getAllPatterns: jest.fn().mockReturnValue(new Map()),
    getStats: jest.fn().mockReturnValue({
      totalUsers: 0,
      totalOperations: 0,
      totalPatterns: 0,
    }),
  };
  return { patternLearner: mockPatternLearner };
});

jest.mock('./knowledgeGraphBuilder', () => {
  const mockKnowledgeGraphBuilder = {
    discoverTopology: jest.fn().mockResolvedValue({
      nodes: [],
      edges: [],
      metadata: {},
    }),
  };
  return { knowledgeGraphBuilder: mockKnowledgeGraphBuilder };
});

jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('ContinuousLearner', () => {
  let learner: ContinuousLearner;
  const defaultConfig: ContinuousLearningConfig = {
    enabled: true,
    patternLearningEnabled: true,
    patternLearningDelayDays: 7,
    bestPracticeThreshold: 5,
    strategyEvaluationIntervalDays: 7,
    knowledgeGraphUpdateIntervalHours: 24,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    learner = new ContinuousLearner();
  });

  afterEach(() => {
    learner.shutdown();
    jest.useRealTimers();
  });

  describe('start()', () => {
    it('should start all three timers when config is fully enabled', () => {
      learner.start(defaultConfig);

      const status = learner.isRunning();
      expect(status.patternLearning).toBe(true);
      expect(status.strategyEval).toBe(true);
      expect(status.knowledgeGraph).toBe(true);
    });

    it('should not start pattern learning timer when patternLearningEnabled is false', () => {
      learner.start({ ...defaultConfig, patternLearningEnabled: false });

      const status = learner.isRunning();
      expect(status.patternLearning).toBe(false);
      expect(status.strategyEval).toBe(true);
      expect(status.knowledgeGraph).toBe(true);
    });

    it('should stop existing timers before starting new ones', () => {
      learner.start(defaultConfig);
      expect(learner.isRunning().patternLearning).toBe(true);

      // Start again with different config
      learner.start({ ...defaultConfig, patternLearningEnabled: false });
      expect(learner.isRunning().patternLearning).toBe(false);
    });

    it('should store the current config', () => {
      learner.start(defaultConfig);
      expect(learner.getCurrentConfig()).toEqual(defaultConfig);
    });
  });

  describe('stop()', () => {
    it('should stop all running timers', () => {
      learner.start(defaultConfig);
      expect(learner.isRunning().patternLearning).toBe(true);

      learner.stop();

      const status = learner.isRunning();
      expect(status.patternLearning).toBe(false);
      expect(status.strategyEval).toBe(false);
      expect(status.knowledgeGraph).toBe(false);
    });

    it('should be safe to call stop when no timers are running', () => {
      expect(() => learner.stop()).not.toThrow();
    });
  });

  describe('recordOperation()', () => {
    it('should delegate to patternLearner when capability is enabled and patternLearning is on', () => {
      jest.spyOn(evolutionConfig, 'isCapabilityEnabled').mockReturnValue(true);
      jest.spyOn(evolutionConfig, 'getCapabilityConfig').mockReturnValue(defaultConfig as any);

      const operation = {
        userId: 'user1',
        sessionId: 'session1',
        toolName: 'ping',
        parameters: {},
        result: 'success' as const,
        timestamp: Date.now(),
      };

      learner.recordOperation('user1', operation);

      expect(patternLearner.recordOperation).toHaveBeenCalledWith(operation);
    });

    it('should not record when continuousLearning capability is disabled', () => {
      jest.spyOn(evolutionConfig, 'isCapabilityEnabled').mockReturnValue(false);

      const operation = {
        userId: 'user1',
        sessionId: 'session1',
        toolName: 'ping',
        parameters: {},
        result: 'success' as const,
        timestamp: Date.now(),
      };

      learner.recordOperation('user1', operation);

      expect(patternLearner.recordOperation).not.toHaveBeenCalled();
    });

    it('should not record when patternLearningEnabled is false', () => {
      jest.spyOn(evolutionConfig, 'isCapabilityEnabled').mockReturnValue(true);
      jest.spyOn(evolutionConfig, 'getCapabilityConfig').mockReturnValue({
        ...defaultConfig,
        patternLearningEnabled: false,
      } as any);

      const operation = {
        userId: 'user1',
        sessionId: 'session1',
        toolName: 'ping',
        parameters: {},
        result: 'success' as const,
        timestamp: Date.now(),
      };

      learner.recordOperation('user1', operation);

      expect(patternLearner.recordOperation).not.toHaveBeenCalled();
    });

    it('should not throw when recordOperation encounters an error', () => {
      jest.spyOn(evolutionConfig, 'isCapabilityEnabled').mockImplementation(() => {
        throw new Error('Config error');
      });

      const operation = {
        userId: 'user1',
        sessionId: 'session1',
        toolName: 'ping',
        parameters: {},
        result: 'success' as const,
        timestamp: Date.now(),
      };

      expect(() => learner.recordOperation('user1', operation)).not.toThrow();
    });
  });

  describe('timer callbacks', () => {
    it('should call patternLearner.identifyPatterns for each user on pattern learning interval', () => {
      const mockPatterns = new Map([
        ['user1', [{ id: 'p1', userId: 'user1', sequence: ['a', 'b'], frequency: 3, confidence: 0.8, successRate: 0.9, firstSeen: 0, lastSeen: 0, type: 'sequence' as const }]],
        ['user2', [{ id: 'p2', userId: 'user2', sequence: ['c'], frequency: 1, confidence: 0.5, successRate: 0.7, firstSeen: 0, lastSeen: 0, type: 'sequence' as const }]],
      ]);
      (patternLearner.getAllPatterns as jest.Mock).mockReturnValue(mockPatterns);

      learner.start(defaultConfig);

      // Advance by 24 hours (pattern learning interval)
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(patternLearner.triggerLearnPatterns).toHaveBeenCalledWith('user1');
      expect(patternLearner.triggerLearnPatterns).toHaveBeenCalledWith('user2');
    });

    it('should call knowledgeGraphBuilder.discoverTopology on knowledge graph interval', () => {
      learner.start(defaultConfig);

      // Advance by 24 hours (knowledgeGraphUpdateIntervalHours)
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(knowledgeGraphBuilder.discoverTopology).toHaveBeenCalled();
    });
  });

  describe('updateConfig()', () => {
    it('should restart timers with new config when enabled', () => {
      learner.start(defaultConfig);
      expect(learner.isRunning().patternLearning).toBe(true);

      const newConfig = { ...defaultConfig, patternLearningEnabled: false };
      learner.updateConfig(newConfig);

      expect(learner.isRunning().patternLearning).toBe(false);
      expect(learner.isRunning().strategyEval).toBe(true);
    });

    it('should stop all timers when config.enabled is false', () => {
      learner.start(defaultConfig);
      expect(learner.isRunning().strategyEval).toBe(true);

      learner.updateConfig({ ...defaultConfig, enabled: false });

      const status = learner.isRunning();
      expect(status.patternLearning).toBe(false);
      expect(status.strategyEval).toBe(false);
      expect(status.knowledgeGraph).toBe(false);
    });
  });

  describe('shutdown()', () => {
    it('should stop all timers and clear config', () => {
      learner.start(defaultConfig);
      expect(learner.getCurrentConfig()).not.toBeNull();

      learner.shutdown();

      const status = learner.isRunning();
      expect(status.patternLearning).toBe(false);
      expect(status.strategyEval).toBe(false);
      expect(status.knowledgeGraph).toBe(false);
      expect(learner.getCurrentConfig()).toBeNull();
    });
  });
});
