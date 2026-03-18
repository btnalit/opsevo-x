/**
 * Unit tests for stateMachine/index.ts barrel file
 *
 * Verifies:
 * 1. All expected public types and classes are exported
 * 2. The factory function creates a valid StateMachineOrchestrator instance
 */

import * as StateMachine from '../../stateMachine';

describe('stateMachine/index barrel exports', () => {
  // === Core types (re-exported from types.ts) ===
  describe('core type exports', () => {
    it('should export StateMachineEngine class', () => {
      expect(StateMachine.StateMachineEngine).toBeDefined();
      expect(typeof StateMachine.StateMachineEngine).toBe('function');
    });

    it('should export StateRegistry class', () => {
      expect(StateMachine.StateRegistry).toBeDefined();
      expect(typeof StateMachine.StateRegistry).toBe('function');
    });

    it('should export StateExecutor class', () => {
      expect(StateMachine.StateExecutor).toBeDefined();
      expect(typeof StateMachine.StateExecutor).toBe('function');
    });

    it('should export ContextManager', () => {
      expect(StateMachine.ContextManager).toBeDefined();
      expect(typeof StateMachine.ContextManager.createContext).toBe('function');
      expect(typeof StateMachine.ContextManager.snapshot).toBe('function');
      expect(typeof StateMachine.ContextManager.recordTiming).toBe('function');
    });

    it('should export StateDefinitionSerializer class', () => {
      expect(StateMachine.StateDefinitionSerializer).toBeDefined();
      expect(typeof StateMachine.StateDefinitionSerializer.serialize).toBe('function');
      expect(typeof StateMachine.StateDefinitionSerializer.deserialize).toBe('function');
      expect(typeof StateMachine.StateDefinitionSerializer.prettyPrint).toBe('function');
    });
  });


  // === Integration classes ===
  describe('integration class exports', () => {
    it('should export ConcurrencyGuard class', () => {
      expect(StateMachine.ConcurrencyGuard).toBeDefined();
      expect(typeof StateMachine.ConcurrencyGuard).toBe('function');
    });

    it('should export DegradationIntegration class', () => {
      expect(StateMachine.DegradationIntegration).toBeDefined();
      expect(typeof StateMachine.DegradationIntegration).toBe('function');
    });

    it('should export TracingIntegration class', () => {
      expect(StateMachine.TracingIntegration).toBeDefined();
      expect(typeof StateMachine.TracingIntegration).toBe('function');
    });
  });

  // === Adapter classes ===
  describe('adapter class exports', () => {
    it('should export ReActLoopAdapter class', () => {
      expect(StateMachine.ReActLoopAdapter).toBeDefined();
      expect(typeof StateMachine.ReActLoopAdapter).toBe('function');
    });

    it('should export AlertPipelineAdapter class', () => {
      expect(StateMachine.AlertPipelineAdapter).toBeDefined();
      expect(typeof StateMachine.AlertPipelineAdapter).toBe('function');
    });

    it('should export IterationLoopAdapter class', () => {
      expect(StateMachine.IterationLoopAdapter).toBeDefined();
      expect(typeof StateMachine.IterationLoopAdapter).toBe('function');
    });
  });

  // === FeatureFlagManager ===
  describe('feature flag exports', () => {
    it('should export FeatureFlagManager class', () => {
      expect(StateMachine.FeatureFlagManager).toBeDefined();
      expect(typeof StateMachine.FeatureFlagManager).toBe('function');
    });
  });

  // === Orchestrator ===
  describe('orchestrator exports', () => {
    it('should export StateMachineOrchestrator class', () => {
      expect(StateMachine.StateMachineOrchestrator).toBeDefined();
      expect(typeof StateMachine.StateMachineOrchestrator).toBe('function');
    });
  });

  // === registerFlows ===
  describe('registerFlows exports', () => {
    it('should export registerAllFlows function', () => {
      expect(StateMachine.registerAllFlows).toBeDefined();
      expect(typeof StateMachine.registerAllFlows).toBe('function');
    });
  });

  // === Flow definitions ===
  describe('flow definition exports', () => {
    it('should export reactDefinition and REACT_DEFINITION_ID', () => {
      expect(StateMachine.reactDefinition).toBeDefined();
      expect(StateMachine.REACT_DEFINITION_ID).toBe('react-orchestration');
      expect(StateMachine.reactDefinition.id).toBe(StateMachine.REACT_DEFINITION_ID);
    });

    it('should export alertDefinition and ALERT_DEFINITION_ID', () => {
      expect(StateMachine.alertDefinition).toBeDefined();
      expect(StateMachine.ALERT_DEFINITION_ID).toBe('alert-pipeline');
      expect(StateMachine.alertDefinition.id).toBe(StateMachine.ALERT_DEFINITION_ID);
    });

    it('should export iterationDefinition and ITERATION_DEFINITION_ID', () => {
      expect(StateMachine.iterationDefinition).toBeDefined();
      expect(StateMachine.ITERATION_DEFINITION_ID).toBe('iteration-loop');
      expect(StateMachine.iterationDefinition.id).toBe(StateMachine.ITERATION_DEFINITION_ID);
    });
  });

  // === Factory function ===
  describe('createStateMachineOrchestrator factory', () => {
    it('should export createStateMachineOrchestrator function', () => {
      expect(StateMachine.createStateMachineOrchestrator).toBeDefined();
      expect(typeof StateMachine.createStateMachineOrchestrator).toBe('function');
    });

    it('should create a valid StateMachineOrchestrator instance with all flows registered', () => {
      // Create mock deps matching RegisterFlowsDeps
      const mockDeps: StateMachine.RegisterFlowsDeps = {
        react: {
          intentParser: { parse: jest.fn() } as any,
          knowledgeRetriever: { retrieve: jest.fn() } as any,
          routingDecider: { decide: jest.fn() } as any,
          fastPathRouter: { route: jest.fn() } as any,
          intentDrivenExecutor: { execute: jest.fn() } as any,
          reactLoopExecutor: { execute: jest.fn() } as any,
          postProcessing: {
            outputValidator: { validate: jest.fn() } as any,
            reflectorService: { reflect: jest.fn() } as any,
            continuousLearner: { learn: jest.fn() } as any,
            toolFeedbackCollector: { collect: jest.fn() } as any,
          } as any,
        },
        alert: {
          rateLimiter: { check: jest.fn() } as any,
          normalizer: { normalize: jest.fn() } as any,
          deduplicator: { check: jest.fn() } as any,
          filter: { filter: jest.fn() } as any,
          analyzer: { analyze: jest.fn() } as any,
          decider: { decide: jest.fn() } as any,
        },
        iteration: {
          executor: { execute: jest.fn() } as any,
          criticService: { evaluate: jest.fn() } as any,
          reflectorService: { reflect: jest.fn() } as any,
          decisionService: { decide: jest.fn() } as any,
        },
      };

      const tracingService = {
        startTrace: jest.fn().mockReturnValue({ traceId: 'test' }),
        startSpan: jest.fn().mockReturnValue({ traceId: 'test' }),
        endSpan: jest.fn(),
        endTrace: jest.fn(),
      } as any;

      const orchestrator = StateMachine.createStateMachineOrchestrator(mockDeps, {
        tracingService,
      });

      expect(orchestrator).toBeInstanceOf(StateMachine.StateMachineOrchestrator);

      // Verify the orchestrator has working methods
      expect(typeof orchestrator.execute).toBe('function');
      expect(typeof orchestrator.registerDefinition).toBe('function');
      expect(typeof orchestrator.registerHandler).toBe('function');
      expect(typeof orchestrator.getConcurrencyStatus).toBe('function');

      // Verify concurrency status returns valid structure
      const status = orchestrator.getConcurrencyStatus();
      expect(status).toHaveProperty('active');
      expect(status).toHaveProperty('queued');
      expect(status).toHaveProperty('maxConcurrent');
    });
  });
});
