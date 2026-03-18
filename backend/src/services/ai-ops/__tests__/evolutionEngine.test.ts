/**
 * EvolutionEngine unit tests
 *
 * Requirements: F4.14, F4.15, F4.16, F4.17, F4.18, F4.19
 */

import { EvolutionEngine, type EvolutionEngineDeps, type RuleEvolutionServiceLike } from '../evolutionEngine';
import type { EvolutionInput } from '../learningOrchestrator';
import type { VectorStoreClient, VectorDocument, VectorSearchResult } from '../rag/vectorStoreClient';
import type { DataStore } from '../../dataStore';
import type { EventBus } from '../../eventBus';
import type { EvaluationReport, ReflectionResult, RemediationPlan, EvaluationContext, ReflectionContext } from '../../../types/ai-ops';

// Suppress logger output during tests
jest.mock('../../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvaluation(overrides?: Partial<EvaluationReport>): EvaluationReport {
  return {
    id: 'eval-1',
    planId: 'plan-1',
    alertId: 'alert-1',
    timestamp: Date.now(),
    overallSuccess: true,
    overallScore: 85,
    stepEvaluations: [],
    rootCauseAddressed: true,
    residualIssues: [],
    improvementSuggestions: [],
    ...overrides,
  };
}

function makeReflection(overrides?: Partial<ReflectionResult>): ReflectionResult {
  return {
    id: 'ref-1',
    evaluationId: 'eval-1',
    timestamp: Date.now(),
    summary: 'Test reflection summary',
    insights: ['insight-a', 'insight-b'],
    gapAnalysis: 'No gap found',
    contextFactors: { timeOfDay: 'morning', systemLoad: 'low', recentChanges: [] },
    nextAction: 'complete',
    ...overrides,
  };
}

function makeEvolutionInput(overrides?: Partial<EvolutionInput>): EvolutionInput {
  return {
    evaluation: makeEvaluation(),
    reflection: makeReflection(),
    patterns: [],
    tickResult: {
      tickId: 'tick-1',
      plan: {
        id: 'plan-1',
        alertId: 'alert-1',
        rootCauseId: 'rc-1',
        description: 'Fix high CPU usage',
        timestamp: Date.now(),
        steps: [],
        rollback: [],
        overallRisk: 'low',
        estimatedDuration: 10,
        requiresConfirmation: false,
        status: 'completed',
      } as RemediationPlan,
      results: [],
      context: { preExecutionState: {}, postExecutionState: {} } as unknown as EvaluationContext,
      reflectionContext: {
        alertEvent: {} as any,
        plan: {} as any,
        iterationHistory: { evaluations: [], reflections: [] },
        systemContext: { currentTime: new Date(), systemLoad: {} as any, recentChanges: [] },
      } as ReflectionContext,
    },
    ...overrides,
  };
}

function makeMockVectorClient(): jest.Mocked<VectorStoreClient> {
  return {
    upsert: jest.fn().mockResolvedValue(['id-1']),
    search: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(true),
    embed: jest.fn().mockResolvedValue([]),
    healthCheck: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<VectorStoreClient>;
}

function makeMockDataStore(): jest.Mocked<DataStore> {
  return {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue({ cnt: '0' }),
    execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
    transaction: jest.fn(),
    getPool: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn(),
  } as unknown as jest.Mocked<DataStore>;
}

function makeMockEventBus(): jest.Mocked<EventBus> {
  return {
    publish: jest.fn().mockResolvedValue({ id: 'evt-1', type: 'internal', priority: 'low', source: 'test', timestamp: Date.now(), payload: {}, schemaVersion: '1.0' }),
    subscribe: jest.fn(),
    registerSource: jest.fn(),
  } as unknown as jest.Mocked<EventBus>;
}

function makeDeps(overrides?: Partial<EvolutionEngineDeps>): EvolutionEngineDeps {
  return {
    vectorClient: makeMockVectorClient(),
    dataStore: makeMockDataStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvolutionEngine', () => {
  describe('evolve() — positive feedback (F4.14)', () => {
    it('should extract verified_experience when score >= 0.8', async () => {
      const deps = makeDeps();
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 90 }),
      });

      const result = await engine.evolve(input);

      expect(deps.vectorClient.upsert).toHaveBeenCalledWith(
        'prompt_knowledge',
        [expect.objectContaining({
          content: expect.stringContaining('[verified_experience]'),
          metadata: expect.objectContaining({
            type: 'verified_experience',
            feedbackScore: 90,
          }),
        })],
      );
      expect(result.newEntries).toBe(1);
    });

    it('should save version history for positive experience (F4.17)', async () => {
      const deps = makeDeps();
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 85 }),
      });

      await engine.evolve(input);

      // First call = INSERT version, second call = prune old versions
      expect(deps.dataStore.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO knowledge_version_history'),
        expect.any(Array),
      );
    });

    it('should treat score exactly at 0.8 as positive', async () => {
      const deps = makeDeps();
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 80 }),
      });

      const result = await engine.evolve(input);

      expect(deps.vectorClient.upsert).toHaveBeenCalled();
      expect(result.newEntries).toBe(1);
    });
  });

  describe('evolve() — negative feedback (F4.15)', () => {
    it('should record negative_experience when score <= 0.3', async () => {
      const deps = makeDeps();
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 20 }),
      });

      const result = await engine.evolve(input);

      expect(deps.vectorClient.upsert).toHaveBeenCalledWith(
        'prompt_knowledge',
        [expect.objectContaining({
          content: expect.stringContaining('[negative_experience]'),
          metadata: expect.objectContaining({
            type: 'negative_experience',
            feedbackScore: 20,
          }),
        })],
      );
      expect(result.newEntries).toBe(1);
    });

    it('should lower weight of related entries on negative feedback', async () => {
      const vectorClient = makeMockVectorClient();
      vectorClient.search.mockResolvedValue([
        { id: 'related-1', text: 'some text', score: 0.8, metadata: { feedbackScore: 50 } },
      ]);
      const deps = makeDeps({ vectorClient });
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 10 }),
      });

      const result = await engine.evolve(input);

      // First upsert = negative entry, second upsert = lower weight of related-1
      expect(vectorClient.upsert).toHaveBeenCalledTimes(2);
      expect(vectorClient.upsert).toHaveBeenLastCalledWith(
        'prompt_knowledge',
        [expect.objectContaining({
          id: 'related-1',
          metadata: expect.objectContaining({ feedbackScore: 40 }), // 50 * 0.8
        })],
      );
      expect(result.updatedEntries).toBe(1);
      expect(result.newEntries).toBe(1);
    });

    it('should treat score exactly at 0.3 as negative', async () => {
      const deps = makeDeps();
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 30 }),
      });

      const result = await engine.evolve(input);

      expect(deps.vectorClient.upsert).toHaveBeenCalledWith(
        'prompt_knowledge',
        [expect.objectContaining({
          metadata: expect.objectContaining({ type: 'negative_experience' }),
        })],
      );
      expect(result.newEntries).toBe(1);
    });
  });

  describe('evolve() — neutral score', () => {
    it('should not extract or record when score is between thresholds', async () => {
      const deps = makeDeps();
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 50 }),
      });

      const result = await engine.evolve(input);

      expect(deps.vectorClient.upsert).not.toHaveBeenCalled();
      expect(result.newEntries).toBe(0);
      expect(result.updatedEntries).toBe(0);
    });
  });

  describe('evolve() — rule evolution (F4.16)', () => {
    it('should call ruleEvolutionService.learnFromReflection when available', async () => {
      const ruleService: jest.Mocked<RuleEvolutionServiceLike> = {
        learnFromReflection: jest.fn().mockResolvedValue([{ id: 'rule-1' }]),
      };
      const deps = makeDeps({ ruleEvolutionService: ruleService });
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 50 }),
      });

      await engine.evolve(input);

      expect(ruleService.learnFromReflection).toHaveBeenCalledWith(input.reflection);
    });

    it('should not fail when ruleEvolutionService is not provided', async () => {
      const deps = makeDeps(); // no ruleEvolutionService
      const engine = new EvolutionEngine(deps);

      const result = await engine.evolve(makeEvolutionInput());

      expect(result).toBeDefined();
    });

    it('should handle ruleEvolutionService errors gracefully', async () => {
      const ruleService: jest.Mocked<RuleEvolutionServiceLike> = {
        learnFromReflection: jest.fn().mockRejectedValue(new Error('rule boom')),
      };
      const deps = makeDeps({ ruleEvolutionService: ruleService });
      const engine = new EvolutionEngine(deps);

      // Should not throw
      const result = await engine.evolve(makeEvolutionInput());
      expect(result).toBeDefined();
    });
  });

  describe('evolve() — rule_evolved event (F4.19)', () => {
    it('should publish rule_evolved event when patterns contain newRules', async () => {
      const eventBus = makeMockEventBus();
      const deps = makeDeps({ eventBus });
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 50 }),
        patterns: { newRules: [{ id: 'new-rule-1' }] } as any,
      });

      await engine.evolve(input);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'internal',
          priority: 'low',
          source: 'evolution-engine',
          payload: expect.objectContaining({
            event: 'rule_evolved',
            rules: [{ id: 'new-rule-1' }],
          }),
        }),
      );
    });

    it('should not publish event when patterns has no newRules', async () => {
      const eventBus = makeMockEventBus();
      const deps = makeDeps({ eventBus });
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 50 }),
        patterns: [] as any,
      });

      await engine.evolve(input);

      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('should not fail when eventBus is not provided', async () => {
      const deps = makeDeps(); // no eventBus
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        patterns: { newRules: [{ id: 'r1' }] } as any,
      });

      const result = await engine.evolve(input);
      expect(result).toBeDefined();
    });
  });

  describe('evolve() — error isolation', () => {
    it('should continue even if vectorClient.upsert fails on positive path', async () => {
      const vectorClient = makeMockVectorClient();
      vectorClient.upsert.mockRejectedValue(new Error('upsert boom'));
      const ruleService: jest.Mocked<RuleEvolutionServiceLike> = {
        learnFromReflection: jest.fn().mockResolvedValue([]),
      };
      const deps = makeDeps({ vectorClient, ruleEvolutionService: ruleService });
      const engine = new EvolutionEngine(deps);
      const input = makeEvolutionInput({
        evaluation: makeEvaluation({ overallScore: 95 }),
      });

      // Should not throw
      const result = await engine.evolve(input);

      // ruleEvolutionService should still be called
      expect(ruleService.learnFromReflection).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('cleanup() (F4.18)', () => {
    it('should delete stale low-score entries', async () => {
      const vectorClient = makeMockVectorClient();
      const dataStore = makeMockDataStore();
      dataStore.query.mockResolvedValueOnce([
        { entry_id: 'stale-1' },
        { entry_id: 'stale-2' },
      ]);
      dataStore.queryOne.mockResolvedValueOnce({ cnt: '2' });

      const engine = new EvolutionEngine({ vectorClient, dataStore });

      const result = await engine.cleanup();

      expect(vectorClient.delete).toHaveBeenCalledWith('prompt_knowledge', 'stale-1');
      expect(vectorClient.delete).toHaveBeenCalledWith('prompt_knowledge', 'stale-2');
      expect(result.deleted).toBe(2);
    });

    it('should evict lowest-value entries when count exceeds maxKnowledgeEntries', async () => {
      const vectorClient = makeMockVectorClient();
      const dataStore = makeMockDataStore();
      // Step 1: no stale entries
      dataStore.query.mockResolvedValueOnce([]);
      // Step 2: count exceeds limit
      dataStore.queryOne.mockResolvedValueOnce({ cnt: '12' });
      // Step 2: entries to evict
      dataStore.query.mockResolvedValueOnce([
        { entry_id: 'low-1' },
        { entry_id: 'low-2' },
      ]);

      const engine = new EvolutionEngine(
        { vectorClient, dataStore },
        { maxKnowledgeEntries: 10 },
      );

      const result = await engine.cleanup();

      expect(vectorClient.delete).toHaveBeenCalledWith('prompt_knowledge', 'low-1');
      expect(vectorClient.delete).toHaveBeenCalledWith('prompt_knowledge', 'low-2');
      expect(result.deleted).toBe(2);
    });

    it('should return 0 deleted when nothing to clean', async () => {
      const dataStore = makeMockDataStore();
      dataStore.query.mockResolvedValueOnce([]);
      dataStore.queryOne.mockResolvedValueOnce({ cnt: '5' });

      const engine = new EvolutionEngine({ vectorClient: makeMockVectorClient(), dataStore });

      const result = await engine.cleanup();
      expect(result.deleted).toBe(0);
    });

    it('should handle cleanup errors gracefully', async () => {
      const dataStore = makeMockDataStore();
      dataStore.query.mockRejectedValueOnce(new Error('db down'));

      const engine = new EvolutionEngine({ vectorClient: makeMockVectorClient(), dataStore });

      const result = await engine.cleanup();
      expect(result.deleted).toBe(0);
    });
  });

  describe('getConfig()', () => {
    it('should return default config', () => {
      const engine = new EvolutionEngine(makeDeps());
      const config = engine.getConfig();

      expect(config.positiveThreshold).toBe(80);
      expect(config.negativeThreshold).toBe(30);
      expect(config.maxVersions).toBe(5);
      expect(config.cleanupIntervalHours).toBe(24);
      expect(config.maxKnowledgeEntries).toBe(10000);
      expect(config.promotionThreshold).toBe(80);
    });

    it('should merge custom config', () => {
      const engine = new EvolutionEngine(makeDeps(), {
        positiveThreshold: 90,
        maxKnowledgeEntries: 5000,
      });
      const config = engine.getConfig();

      expect(config.positiveThreshold).toBe(90);
      expect(config.maxKnowledgeEntries).toBe(5000);
      // defaults preserved
      expect(config.negativeThreshold).toBe(30);
    });
  });

  describe('EvolutionEngineLike interface compliance', () => {
    it('should satisfy the EvolutionEngineLike interface from LearningOrchestrator', async () => {
      const engine = new EvolutionEngine(makeDeps());

      // The interface requires: evolve(input: EvolutionInput): Promise<EvolutionResult>
      const result = await engine.evolve(makeEvolutionInput());

      expect(result).toHaveProperty('updatedEntries');
      expect(result).toHaveProperty('newEntries');
      expect(typeof result.updatedEntries).toBe('number');
      expect(typeof result.newEntries).toBe('number');
    });
  });
});
