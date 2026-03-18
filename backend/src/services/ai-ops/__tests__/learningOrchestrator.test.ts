/**
 * LearningOrchestrator unit tests
 *
 * Validates the orchestration pipeline:
 *   CriticService → ReflectorService → PatternLearner → EvolutionEngine
 *
 * Requirements: F2.8, F2.9, F2.10, F3.11, F3.12, F4.13, F4.20, F4.21
 */

import {
  LearningOrchestrator,
  type CriticServiceLike,
  type ReflectorServiceLike,
  type PatternLearnerLike,
  type EvolutionEngineLike,
  type FeedbackServiceLike,
  type TickResult,
  type LearningOrchestratorDeps,
} from '../learningOrchestrator';
import type {
  EvaluationReport,
  ReflectionResult,
  ReflectionContext,
  EvaluationContext,
  RemediationPlan,
  ExecutionResult,
} from '../../../types/ai-ops';

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

function makeEvaluationReport(overrides?: Partial<EvaluationReport>): EvaluationReport {
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

function makeReflectionResult(overrides?: Partial<ReflectionResult>): ReflectionResult {
  return {
    id: 'ref-1',
    evaluationId: 'eval-1',
    timestamp: Date.now(),
    summary: 'Reflection summary',
    insights: ['insight-1'],
    gapAnalysis: 'No gap',
    contextFactors: { timeOfDay: 'morning', systemLoad: 'low', recentChanges: [] },
    nextAction: 'complete',
    ...overrides,
  };
}

function makeTickResult(overrides?: Partial<TickResult>): TickResult {
  return {
    tickId: 'tick-1',
    plan: {
      id: 'plan-1',
      alertId: 'alert-1',
      rootCauseId: 'rc-1',
      timestamp: Date.now(),
      steps: [],
      rollback: [],
      overallRisk: 'low',
      estimatedDuration: 10,
      requiresConfirmation: false,
      status: 'pending',
    } as RemediationPlan,
    results: [{ stepOrder: 1, success: true, duration: 500 }] as ExecutionResult[],
    context: {
      preExecutionState: {} as any,
      postExecutionState: {} as any,
    } as EvaluationContext,
    reflectionContext: {
      alertEvent: { id: 'evt-1', source: 'test', timestamp: Date.now(), severity: 'warning', category: 'test', message: 'test', rawData: {}, metadata: {} } as any,
      plan: { id: 'plan-1', alertId: 'alert-1', rootCauseId: 'rc-1', timestamp: Date.now(), steps: [], rollback: [], overallRisk: 'low', estimatedDuration: 10, requiresConfirmation: false, status: 'pending' } as RemediationPlan,
      iterationHistory: { evaluations: [], reflections: [] },
      systemContext: { currentTime: new Date(), systemLoad: {} as any, recentChanges: [] },
    } as ReflectionContext,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<LearningOrchestratorDeps>): LearningOrchestratorDeps {
  return {
    critic: {
      evaluatePlan: jest.fn().mockResolvedValue(makeEvaluationReport()),
    },
    reflector: {
      reflect: jest.fn().mockResolvedValue(makeReflectionResult()),
    },
    patternLearner: {
      identifyPatterns: jest.fn().mockReturnValue([{ id: 'p1', type: 'sequence' }]),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LearningOrchestrator', () => {
  describe('orchestrate()', () => {
    it('should execute the full pipeline: evaluate → reflect → pattern → evolve', async () => {
      const evolutionEngine: EvolutionEngineLike = {
        evolve: jest.fn().mockResolvedValue({ updatedEntries: 1, newEntries: 2 }),
      };
      const deps = makeDeps({ evolutionEngine });
      const orchestrator = new LearningOrchestrator(deps);
      const tick = makeTickResult();

      const result = await orchestrator.orchestrate(tick);

      expect(deps.critic.evaluatePlan).toHaveBeenCalledWith(tick.plan, tick.results, tick.context);
      expect(deps.reflector.reflect).toHaveBeenCalledWith(expect.objectContaining({ id: 'eval-1' }), tick.reflectionContext);
      expect(deps.patternLearner.identifyPatterns).toHaveBeenCalledWith('system');
      expect(evolutionEngine.evolve).toHaveBeenCalledWith(
        expect.objectContaining({
          evaluation: expect.objectContaining({ id: 'eval-1' }),
          reflection: expect.objectContaining({ id: 'ref-1' }),
          patterns: expect.any(Array),
          tickResult: tick,
        }),
      );

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).not.toBeNull();
      expect(result.patterns).toHaveLength(1);
      expect(result.evolution).toEqual({ updatedEntries: 1, newEntries: 2 });
      expect(result.errors).toHaveLength(0);
    });

    it('should work without EvolutionEngine (optional dependency)', async () => {
      const deps = makeDeps(); // no evolutionEngine
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).not.toBeNull();
      expect(result.evolution).toBeNull();
      expect(result.errors).toHaveLength(0);
    });

    it('should use tickResult.userId for pattern identification when provided', async () => {
      const deps = makeDeps();
      const orchestrator = new LearningOrchestrator(deps);

      await orchestrator.orchestrate(makeTickResult({ userId: 'user-42' }));

      expect(deps.patternLearner.identifyPatterns).toHaveBeenCalledWith('user-42');
    });

    it('should continue pipeline when CriticService fails', async () => {
      const deps = makeDeps({
        critic: { evaluatePlan: jest.fn().mockRejectedValue(new Error('critic boom')) },
      });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      // evaluation failed → reflection skipped (needs evaluation), but pattern still runs
      expect(result.evaluation).toBeNull();
      expect(result.reflection).toBeNull();
      expect(result.patterns).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ step: 'evaluate', message: 'critic boom' });
    });

    it('should continue pipeline when ReflectorService fails', async () => {
      const deps = makeDeps({
        reflector: { reflect: jest.fn().mockRejectedValue(new Error('reflector boom')) },
      });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).toBeNull();
      expect(result.patterns).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ step: 'reflect', message: 'reflector boom' });
    });

    it('should continue pipeline when PatternLearner fails', async () => {
      const deps = makeDeps({
        patternLearner: { identifyPatterns: jest.fn().mockImplementation(() => { throw new Error('pattern boom'); }) },
      });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).not.toBeNull();
      expect(result.patterns).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ step: 'pattern', message: 'pattern boom' });
    });

    it('should continue pipeline when EvolutionEngine fails', async () => {
      const evolutionEngine: EvolutionEngineLike = {
        evolve: jest.fn().mockRejectedValue(new Error('evolve boom')),
      };
      const deps = makeDeps({ evolutionEngine });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).not.toBeNull();
      expect(result.evolution).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ step: 'evolve', message: 'evolve boom' });
    });

    it('should collect multiple errors when several steps fail', async () => {
      const deps = makeDeps({
        critic: { evaluatePlan: jest.fn().mockRejectedValue(new Error('critic fail')) },
        patternLearner: { identifyPatterns: jest.fn().mockImplementation(() => { throw new Error('pattern fail'); }) },
      });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.errors).toHaveLength(2);
      expect(result.errors.map(e => e.step)).toEqual(['evaluate', 'pattern']);
    });

    it('should skip EvolutionEngine when evaluation is null (critic failed)', async () => {
      const evolutionEngine: EvolutionEngineLike = {
        evolve: jest.fn().mockResolvedValue({ updatedEntries: 0, newEntries: 0 }),
      };
      const deps = makeDeps({
        critic: { evaluatePlan: jest.fn().mockRejectedValue(new Error('fail')) },
        evolutionEngine,
      });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(evolutionEngine.evolve).not.toHaveBeenCalled();
      expect(result.evolution).toBeNull();
    });
  });

  describe('processFeedback()', () => {
    it('should delegate to FeedbackService and return result', async () => {
      const mockFeedback = { id: 'fb-1', alertId: 'a-1', timestamp: Date.now(), useful: true };
      const feedbackService: FeedbackServiceLike = {
        recordFeedback: jest.fn().mockResolvedValue(mockFeedback),
      };
      const deps = makeDeps({ feedbackService });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.processFeedback({ alertId: 'a-1', useful: true, comment: 'good' });

      expect(feedbackService.recordFeedback).toHaveBeenCalledWith(
        { alertId: 'a-1', useful: true, comment: 'good' },
        undefined,
      );
      expect(result).toEqual(mockFeedback);
    });

    it('should return null when FeedbackService is not available', async () => {
      const deps = makeDeps(); // no feedbackService
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.processFeedback({ alertId: 'a-1', useful: false });

      expect(result).toBeNull();
    });

    it('should return null and not throw when FeedbackService errors', async () => {
      const feedbackService: FeedbackServiceLike = {
        recordFeedback: jest.fn().mockRejectedValue(new Error('feedback boom')),
      };
      const deps = makeDeps({ feedbackService });
      const orchestrator = new LearningOrchestrator(deps);

      const result = await orchestrator.processFeedback({ alertId: 'a-1', useful: true });

      expect(result).toBeNull();
    });
  });

  describe('setEvolutionEngine()', () => {
    it('should allow late binding of EvolutionEngine', async () => {
      const deps = makeDeps(); // no evolutionEngine initially
      const orchestrator = new LearningOrchestrator(deps);

      // First call — no evolution
      const result1 = await orchestrator.orchestrate(makeTickResult());
      expect(result1.evolution).toBeNull();

      // Late bind
      const evolutionEngine: EvolutionEngineLike = {
        evolve: jest.fn().mockResolvedValue({ updatedEntries: 3, newEntries: 1 }),
      };
      orchestrator.setEvolutionEngine(evolutionEngine);

      // Second call — evolution runs
      const result2 = await orchestrator.orchestrate(makeTickResult());
      expect(result2.evolution).toEqual({ updatedEntries: 3, newEntries: 1 });
      expect(evolutionEngine.evolve).toHaveBeenCalled();
    });
  });
});
