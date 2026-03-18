/**
 * Integration tests for AI-Ops Agent entry point routing via FeatureFlagManager
 *
 * Verifies:
 * 1. When feature flag is OFF, the original executeLoop is called (not the state machine)
 * 2. When feature flag is ON, the state machine orchestrator is called
 * 3. Feature flag defaults to OFF, preserving existing behavior
 *
 * Validates: Requirements 9.3, 9.4
 */

import { FeatureFlagManager, FlowId } from '../../stateMachine/featureFlagManager';
import { StateMachineOrchestrator } from '../../stateMachine/stateMachineOrchestrator';
import { ExecutionResult } from '../../stateMachine/types';

// ============================================================
// Helpers: mock SkillAwareReActResult-like object
// ============================================================

function createMockReActResult() {
  return {
    finalAnswer: 'legacy answer',
    steps: [],
    iterations: 1,
    reachedMaxIterations: false,
    knowledgeReferences: [],
  };
}

function createMockExecutionResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    executionId: 'exec-123',
    requestId: 'req-123',
    definitionId: 'react-orchestration',
    finalState: 'response',
    success: true,
    totalDuration: 100,
    nodesVisited: 5,
    degraded: false,
    degradedNodes: [],
    output: {
      result: {
        finalAnswer: 'state machine answer',
        steps: [],
        iterations: 1,
        reachedMaxIterations: false,
        knowledgeReferences: [],
      },
    },
    transitionPath: [],
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('AI-Ops Agent Entry Point Integration', () => {
  let featureFlagManager: FeatureFlagManager;
  let mockOrchestrator: jest.Mocked<Pick<StateMachineOrchestrator, 'execute'>>;
  let mockLegacyExecuteLoop: jest.Mock;

  beforeEach(() => {
    featureFlagManager = new FeatureFlagManager(); // defaults all flags to OFF
    mockOrchestrator = {
      execute: jest.fn().mockResolvedValue(createMockExecutionResult()),
    };
    mockLegacyExecuteLoop = jest.fn().mockResolvedValue(createMockReActResult());
  });

  describe('feature flag defaults', () => {
    it('should default react-orchestration flag to OFF', () => {
      expect(featureFlagManager.isEnabled('react-orchestration')).toBe(false);
    });

    it('should default all orchestration flags to OFF', () => {
      expect(featureFlagManager.isEnabled('react-orchestration')).toBe(false);
      expect(featureFlagManager.isEnabled('alert-orchestration')).toBe(false);
      expect(featureFlagManager.isEnabled('iteration-orchestration')).toBe(false);
    });
  });

  describe('routing when feature flag is OFF', () => {
    it('should call legacy executeLoop when flag is OFF', async () => {
      const result = await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', { message: 'test' }),
        () => mockLegacyExecuteLoop('test message'),
      );

      expect(mockLegacyExecuteLoop).toHaveBeenCalledWith('test message');
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
      expect(result).toEqual(createMockReActResult());
    });

    it('should preserve original executeLoop arguments when flag is OFF', async () => {
      const message = 'configure interface eth0';
      const intentAnalysis = { intent: 'configuration', tools: [], confidence: 0.9 };
      const context = { sessionId: 'sess-1', messages: [] };

      await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', {
          message,
          intentAnalysis,
          conversationContext: context,
        }),
        () => mockLegacyExecuteLoop(message, intentAnalysis, context),
      );

      expect(mockLegacyExecuteLoop).toHaveBeenCalledWith(message, intentAnalysis, context);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
    });

    it('should propagate errors from legacy executeLoop when flag is OFF', async () => {
      const error = new Error('Legacy execution failed');
      mockLegacyExecuteLoop.mockRejectedValue(error);

      await expect(
        featureFlagManager.route(
          'react-orchestration',
          () => mockOrchestrator.execute('react-orchestration', {}),
          () => mockLegacyExecuteLoop(),
        ),
      ).rejects.toThrow('Legacy execution failed');

      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
    });
  });

  describe('routing when feature flag is ON', () => {
    beforeEach(() => {
      featureFlagManager.setEnabled('react-orchestration', true);
    });

    it('should call state machine orchestrator when flag is ON', async () => {
      const input = { message: 'test', conversationContext: {} };

      const result = await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', input),
        () => mockLegacyExecuteLoop(),
      );

      expect(mockOrchestrator.execute).toHaveBeenCalledWith('react-orchestration', input);
      expect(mockLegacyExecuteLoop).not.toHaveBeenCalled();
      expect(result).toEqual(createMockExecutionResult());
    });

    it('should pass correct definitionId to orchestrator', async () => {
      await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', { message: 'hello' }),
        () => mockLegacyExecuteLoop(),
      );

      expect(mockOrchestrator.execute).toHaveBeenCalledWith(
        'react-orchestration',
        expect.objectContaining({ message: 'hello' }),
      );
    });

    it('should propagate errors from state machine orchestrator when flag is ON', async () => {
      const error = new Error('State machine execution failed');
      mockOrchestrator.execute.mockRejectedValue(error);

      await expect(
        featureFlagManager.route(
          'react-orchestration',
          () => mockOrchestrator.execute('react-orchestration', {}),
          () => mockLegacyExecuteLoop(),
        ),
      ).rejects.toThrow('State machine execution failed');

      expect(mockLegacyExecuteLoop).not.toHaveBeenCalled();
    });
  });

  describe('dynamic flag toggling', () => {
    it('should switch from legacy to state machine when flag is toggled ON', async () => {
      // First call: flag OFF → legacy
      await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', {}),
        () => mockLegacyExecuteLoop(),
      );
      expect(mockLegacyExecuteLoop).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();

      // Toggle flag ON
      featureFlagManager.setEnabled('react-orchestration', true);

      // Second call: flag ON → state machine
      await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', {}),
        () => mockLegacyExecuteLoop(),
      );
      expect(mockOrchestrator.execute).toHaveBeenCalledTimes(1);
      expect(mockLegacyExecuteLoop).toHaveBeenCalledTimes(1); // still 1 from before
    });

    it('should switch from state machine to legacy when flag is toggled OFF', async () => {
      featureFlagManager.setEnabled('react-orchestration', true);

      // First call: flag ON → state machine
      await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', {}),
        () => mockLegacyExecuteLoop(),
      );
      expect(mockOrchestrator.execute).toHaveBeenCalledTimes(1);

      // Toggle flag OFF
      featureFlagManager.setEnabled('react-orchestration', false);

      // Second call: flag OFF → legacy
      await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', {}),
        () => mockLegacyExecuteLoop(),
      );
      expect(mockLegacyExecuteLoop).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.execute).toHaveBeenCalledTimes(1); // still 1 from before
    });
  });

  describe('comparison mode', () => {
    it('should execute both paths and return legacy result in comparison mode', async () => {
      featureFlagManager.updateConfig({
        flags: {
          'react-orchestration': false,
          'alert-orchestration': false,
          'iteration-orchestration': false,
        },
        comparisonMode: {
          enabled: true,
          enabledFor: ['react-orchestration'],
          logLevel: 'debug',
        },
      });

      const result = await featureFlagManager.route(
        'react-orchestration',
        () => mockOrchestrator.execute('react-orchestration', {}),
        () => mockLegacyExecuteLoop(),
      );

      // Both should have been called
      expect(mockOrchestrator.execute).toHaveBeenCalled();
      expect(mockLegacyExecuteLoop).toHaveBeenCalled();

      // Should return legacy result for safety
      expect(result).toEqual(createMockReActResult());
    });
  });

  describe('integration with UnifiedAgentService pattern', () => {
    it('should support the routing pattern used in handleKnowledgeEnhancedChat', async () => {
      // Simulate the pattern that will be used in UnifiedAgentService
      const message = 'show me the network status';
      const intentAnalysis = { intent: 'monitoring', tools: [], confidence: 0.8 };
      const conversationMemory = { sessionId: 'sess-1', messages: [], context: {}, createdAt: Date.now(), lastUpdated: Date.now() };
      const options = { sessionId: 'sess-1', aiAdapter: null };

      // The routing pattern wraps the executeLoop call
      const reActResult = await featureFlagManager.route(
        'react-orchestration',
        async () => {
          const execResult = await mockOrchestrator.execute('react-orchestration', {
            message,
            intentAnalysis,
            conversationContext: conversationMemory,
            executionOptions: options,
          });
          // When using state machine, extract the result from ExecutionResult.output
          return execResult.output.result;
        },
        () => mockLegacyExecuteLoop(message, intentAnalysis, conversationMemory, options),
      );

      // Flag is OFF by default, so legacy should be called
      expect(mockLegacyExecuteLoop).toHaveBeenCalledWith(message, intentAnalysis, conversationMemory, options);
      expect(reActResult).toEqual(createMockReActResult());
    });
  });
});
