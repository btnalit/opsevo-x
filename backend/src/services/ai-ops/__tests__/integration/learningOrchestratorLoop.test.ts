/**
 * Task 33.2 — LearningOrchestrator 闭环验证
 *
 * 验证:
 * - Tick → Critic → Reflector → PatternLearner → EvolutionEngine → prompt_knowledge
 * - 每步独立容错：单步失败不阻塞后续流程
 * - EvolutionEngine 可选绑定
 *
 * Requirements: F2.8, F2.9, F3.12, F4.13
 */

import {
  LearningOrchestrator,
  TickResult,
  LearningResult,
  CriticServiceLike,
  ReflectorServiceLike,
  PatternLearnerLike,
  EvolutionEngineLike,
} from '../../learningOrchestrator';

// ─── Mock factories ───

function makeTickResult(overrides?: Partial<TickResult>): TickResult {
  return {
    tickId: 'tick-001',
    plan: { id: 'plan-1', steps: [] } as any,
    results: [{ success: true }] as any,
    context: { deviceId: 'dev-1' } as any,
    reflectionContext: { history: [] } as any,
    userId: 'user-1',
    ...overrides,
  };
}

function makeCritic(overrides?: Partial<CriticServiceLike>): CriticServiceLike {
  return {
    evaluatePlan: jest.fn().mockResolvedValue({
      overallScore: 0.85,
      dimensions: {},
      recommendations: [],
    }),
    ...overrides,
  };
}

function makeReflector(overrides?: Partial<ReflectorServiceLike>): ReflectorServiceLike {
  return {
    reflect: jest.fn().mockResolvedValue({
      nextAction: 'continue',
      insights: ['insight-1'],
    }),
    ...overrides,
  };
}

function makePatternLearner(overrides?: Partial<PatternLearnerLike>): PatternLearnerLike {
  return {
    identifyPatterns: jest.fn().mockReturnValue([
      { type: 'recurring-failure', confidence: 0.9 },
    ]),
    ...overrides,
  };
}

function makeEvolutionEngine(overrides?: Partial<EvolutionEngineLike>): EvolutionEngineLike {
  return {
    evolve: jest.fn().mockResolvedValue({
      updatedEntries: 2,
      newEntries: 1,
    }),
    ...overrides,
  };
}

// ─── Tests ───

describe('Task 33.2 — LearningOrchestrator 闭环验证', () => {
  describe('完整闭环流程 (F4.13)', () => {
    it('Tick → Critic → Reflector → PatternLearner → EvolutionEngine 全链路执行', async () => {
      const critic = makeCritic();
      const reflector = makeReflector();
      const patternLearner = makePatternLearner();
      const evolutionEngine = makeEvolutionEngine();

      const orchestrator = new LearningOrchestrator({
        critic,
        reflector,
        patternLearner,
        evolutionEngine,
      });

      const tickResult = makeTickResult();
      const result = await orchestrator.orchestrate(tickResult);

      // 验证四步全部执行
      expect(critic.evaluatePlan).toHaveBeenCalledTimes(1);
      expect(reflector.reflect).toHaveBeenCalledTimes(1);
      expect(patternLearner.identifyPatterns).toHaveBeenCalledTimes(1);
      expect(evolutionEngine.evolve).toHaveBeenCalledTimes(1);

      // 验证结果完整
      expect(result.evaluation).not.toBeNull();
      expect(result.evaluation!.overallScore).toBe(0.85);
      expect(result.reflection).not.toBeNull();
      expect(result.patterns).toHaveLength(1);
      expect(result.evolution).not.toBeNull();
      expect(result.evolution!.updatedEntries).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('无 EvolutionEngine 时前三步仍正常执行', async () => {
      const orchestrator = new LearningOrchestrator({
        critic: makeCritic(),
        reflector: makeReflector(),
        patternLearner: makePatternLearner(),
        // 不传 evolutionEngine
      });

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).not.toBeNull();
      expect(result.patterns).toHaveLength(1);
      expect(result.evolution).toBeNull();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('独立容错', () => {
    it('Critic 失败不阻塞 PatternLearner', async () => {
      const critic = makeCritic({
        evaluatePlan: jest.fn().mockRejectedValue(new Error('Critic down')),
      });

      const orchestrator = new LearningOrchestrator({
        critic,
        reflector: makeReflector(),
        patternLearner: makePatternLearner(),
      });

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).toBeNull();
      // Reflector 依赖 evaluation，所以也跳过
      expect(result.reflection).toBeNull();
      // PatternLearner 独立执行
      expect(result.patterns).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].step).toBe('evaluate');
    });

    it('Reflector 失败不阻塞 PatternLearner 和 EvolutionEngine', async () => {
      const reflector = makeReflector({
        reflect: jest.fn().mockRejectedValue(new Error('Reflector error')),
      });

      const orchestrator = new LearningOrchestrator({
        critic: makeCritic(),
        reflector,
        patternLearner: makePatternLearner(),
        evolutionEngine: makeEvolutionEngine(),
      });

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).toBeNull();
      expect(result.patterns).toHaveLength(1);
      // EvolutionEngine 仍执行（有 evaluation）
      expect(result.evolution).not.toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].step).toBe('reflect');
    });

    it('PatternLearner 失败不阻塞 EvolutionEngine', async () => {
      const patternLearner = makePatternLearner({
        identifyPatterns: jest.fn().mockImplementation(() => {
          throw new Error('Pattern error');
        }),
      });

      const orchestrator = new LearningOrchestrator({
        critic: makeCritic(),
        reflector: makeReflector(),
        patternLearner,
        evolutionEngine: makeEvolutionEngine(),
      });

      const result = await orchestrator.orchestrate(makeTickResult());

      expect(result.evaluation).not.toBeNull();
      expect(result.reflection).not.toBeNull();
      expect(result.patterns).toHaveLength(0);
      expect(result.evolution).not.toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].step).toBe('pattern');
    });
  });

  describe('运行时绑定 EvolutionEngine', () => {
    it('setEvolutionEngine 后续 orchestrate 应使用新引擎', async () => {
      const orchestrator = new LearningOrchestrator({
        critic: makeCritic(),
        reflector: makeReflector(),
        patternLearner: makePatternLearner(),
      });

      // 第一次无 EvolutionEngine
      const r1 = await orchestrator.orchestrate(makeTickResult());
      expect(r1.evolution).toBeNull();

      // 运行时绑定
      const engine = makeEvolutionEngine();
      orchestrator.setEvolutionEngine(engine);

      const r2 = await orchestrator.orchestrate(makeTickResult({ tickId: 'tick-002' }));
      expect(r2.evolution).not.toBeNull();
      expect(engine.evolve).toHaveBeenCalledTimes(1);
    });
  });
});
