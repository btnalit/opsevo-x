/**
 * PatternLearner unit tests
 * Tests for task 9.2: pattern verification delay and best practice extraction
 */

import { PatternLearner, OperationPattern } from './patternLearner';
import * as evolutionConfig from './evolutionConfig';
import { knowledgeBase } from './rag/knowledgeBase';

// Mock dependencies
jest.mock('./evolutionConfig', () => ({
  getCapabilityConfig: jest.fn(),
  isCapabilityEnabled: jest.fn(),
}));

jest.mock('./rag/knowledgeBase', () => ({
  knowledgeBase: {
    add: jest.fn(),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('PatternLearner - Task 9.2', () => {
  let learner: PatternLearner;

  beforeEach(() => {
    jest.clearAllMocks();
    learner = new PatternLearner({
      enabled: true,
      minSequenceLength: 2,
      maxSequenceLength: 3,
      minFrequencyThreshold: 2,
      minConfidenceThreshold: 0.0, // low threshold for testing
      maxOperationHistory: 100,
      storagePath: 'test-data/patterns',
      learningDelayDays: 7,
    });
  });

  // Helper to record operations that will form a pattern
  function recordOperations(pl: PatternLearner, userId: string, toolSequence: string[], count: number, timestampBase: number) {
    for (let c = 0; c < count; c++) {
      for (let i = 0; i < toolSequence.length; i++) {
        pl.recordOperation({
          userId,
          sessionId: `session_${c}`,
          toolName: toolSequence[i],
          parameters: {},
          result: 'success',
          timestamp: timestampBase + c * 10000 + i * 1000,
          context: {},
        });
      }
    }
  }

  describe('identifyPatterns() - verification delay', () => {
    it('should mark patterns as verified when firstSeen exceeds patternLearningDelayDays', () => {
      const delayDays = 7;
      const delayMs = delayDays * 86400000;
      // Patterns created 10 days ago
      const oldTimestamp = Date.now() - 10 * 86400000;

      (evolutionConfig.getCapabilityConfig as jest.Mock).mockReturnValue({
        patternLearningDelayDays: delayDays,
        bestPracticeThreshold: 5,
        patternLearningEnabled: true,
        enabled: true,
        strategyEvaluationIntervalDays: 7,
        knowledgeGraphUpdateIntervalHours: 24,
      });

      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, oldTimestamp);

      const patterns = learner.identifyPatterns('user1');
      expect(patterns.length).toBeGreaterThan(0);
      for (const pattern of patterns) {
        expect(pattern.verified).toBe(true);
      }
    });

    it('should NOT mark patterns as verified when firstSeen is within patternLearningDelayDays', () => {
      const delayDays = 7;
      // Patterns created just now
      const recentTimestamp = Date.now() - 1000;

      (evolutionConfig.getCapabilityConfig as jest.Mock).mockReturnValue({
        patternLearningDelayDays: delayDays,
        bestPracticeThreshold: 5,
        patternLearningEnabled: true,
        enabled: true,
        strategyEvaluationIntervalDays: 7,
        knowledgeGraphUpdateIntervalHours: 24,
      });

      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, recentTimestamp);

      const patterns = learner.identifyPatterns('user1');
      expect(patterns.length).toBeGreaterThan(0);
      for (const pattern of patterns) {
        expect(pattern.verified).toBeUndefined();
      }
    });

    it('should gracefully handle config unavailability and skip verification', () => {
      (evolutionConfig.getCapabilityConfig as jest.Mock).mockImplementation(() => {
        throw new Error('Config not available');
      });

      const recentTimestamp = Date.now() - 1000;
      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, recentTimestamp);

      // Should not throw
      const patterns = learner.identifyPatterns('user1');
      expect(patterns.length).toBeGreaterThan(0);
      // verified should not be set
      for (const pattern of patterns) {
        expect(pattern.verified).toBeUndefined();
      }
    });

    it('should return empty array when user has no operations', () => {
      const patterns = learner.identifyPatterns('nonexistent');
      expect(patterns).toEqual([]);
    });
  });

  describe('promoteToBestPractice()', () => {
    it('should create a knowledge base document from a stored pattern', async () => {
      const mockEntry = {
        id: 'kb_123',
        title: '最佳实践: toolA -> toolB',
        type: 'learning',
        content: 'test content',
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      (knowledgeBase.add as jest.Mock).mockResolvedValue(mockEntry);

      // Disable config check in identifyPatterns to avoid interference
      (evolutionConfig.getCapabilityConfig as jest.Mock).mockImplementation(() => {
        throw new Error('not available');
      });

      // Record operations to create patterns
      const timestamp = Date.now() - 1000;
      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, timestamp);

      // Get patterns to find a valid patternId
      const patterns = learner.getPatterns('user1');
      expect(patterns.length).toBeGreaterThan(0);
      const patternId = patterns[0].id;

      const result = await learner.promoteToBestPractice(patternId);

      expect(result).not.toBeNull();
      expect(result!.id).toBe('kb_123');
      expect(result!.title).toBe('最佳实践: toolA -> toolB');

      expect(knowledgeBase.add).toHaveBeenCalledTimes(1);
      const addCall = (knowledgeBase.add as jest.Mock).mock.calls[0][0];
      expect(addCall.type).toBe('learning');
      expect(addCall.title).toContain('最佳实践');
      expect(addCall.metadata.source).toBe('pattern-learner');
      expect(addCall.metadata.category).toBe('best-practice');
      expect(addCall.metadata.tags).toContain('best-practice');
      expect(addCall.metadata.originalData.patternId).toBe(patternId);
    });

    it('should return null when pattern is not found', async () => {
      const result = await learner.promoteToBestPractice('nonexistent_pattern');
      expect(result).toBeNull();
      expect(knowledgeBase.add).not.toHaveBeenCalled();
    });

    it('should return null and log error when knowledgeBase.add fails', async () => {
      (knowledgeBase.add as jest.Mock).mockRejectedValue(new Error('KB error'));
      (evolutionConfig.getCapabilityConfig as jest.Mock).mockImplementation(() => {
        throw new Error('not available');
      });

      const timestamp = Date.now() - 1000;
      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, timestamp);

      const patterns = learner.getPatterns('user1');
      expect(patterns.length).toBeGreaterThan(0);
      const patternId = patterns[0].id;

      const result = await learner.promoteToBestPractice(patternId);
      expect(result).toBeNull();
    });

    it('should emit bestPracticePromoted event on success', async () => {
      const mockEntry = {
        id: 'kb_456',
        title: '最佳实践: toolA -> toolB',
        type: 'learning',
        content: 'test',
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      (knowledgeBase.add as jest.Mock).mockResolvedValue(mockEntry);
      (evolutionConfig.getCapabilityConfig as jest.Mock).mockImplementation(() => {
        throw new Error('not available');
      });

      const timestamp = Date.now() - 1000;
      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, timestamp);

      const patterns = learner.getPatterns('user1');
      const patternId = patterns[0].id;

      const eventPromise = new Promise<any>((resolve) => {
        learner.on('bestPracticePromoted', resolve);
      });

      await learner.promoteToBestPractice(patternId);

      const event = await eventPromise;
      expect(event.patternId).toBe(patternId);
      expect(event.userId).toBe('user1');
      expect(event.knowledgeEntryId).toBe('kb_456');
    });
  });

  describe('mergePatterns - verified preservation', () => {
    it('should preserve verified status when merging patterns', () => {
      (evolutionConfig.getCapabilityConfig as jest.Mock).mockReturnValue({
        patternLearningDelayDays: 7,
        bestPracticeThreshold: 5,
        patternLearningEnabled: true,
        enabled: true,
        strategyEvaluationIntervalDays: 7,
        knowledgeGraphUpdateIntervalHours: 24,
      });

      // Create patterns with old timestamps so they get verified
      const oldTimestamp = Date.now() - 10 * 86400000;
      recordOperations(learner, 'user1', ['toolA', 'toolB'], 3, oldTimestamp);

      let patterns = learner.getPatterns('user1');
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.some(p => p.verified === true)).toBe(true);

      // Record more operations (recent) - this triggers learnPatterns which merges
      const recentTimestamp = Date.now() - 1000;
      recordOperations(learner, 'user1', ['toolA', 'toolB'], 1, recentTimestamp);

      // Patterns should still be verified after merge
      patterns = learner.getPatterns('user1');
      expect(patterns.some(p => p.verified === true)).toBe(true);
    });
  });
});
