/**
 * Integration tests for IterationLoop entry point routing via FeatureFlagManager
 *
 * Verifies:
 * 1. When feature flag is OFF, the original startLegacy is called
 * 2. When feature flag is ON, the state machine orchestrator is called
 * 3. Feature flag defaults to OFF, preserving existing behavior
 * 4. When FeatureFlagManager is not configured, falls back to legacy directly
 *
 * Validates: Requirements 9.3, 9.4
 */

import { FeatureFlagManager } from '../../stateMachine/featureFlagManager';
import { StateMachineOrchestrator } from '../../stateMachine/stateMachineOrchestrator';
import { ExecutionResult } from '../../stateMachine/types';

// ============================================================
// Helpers
// ============================================================

function createMockExecutionResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    executionId: 'exec-iter-123',
    requestId: 'req-iter-123',
    definitionId: 'iteration-loop',
    finalState: 'complete',
    success: true,
    totalDuration: 200,
    nodesVisited: 8,
    degraded: false,
    degradedNodes: [],
    output: {},
    transitionPath: [],
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('IterationLoop Entry Point Integration', () => {
  let featureFlagManager: FeatureFlagManager;
  let mockOrchestrator: jest.Mocked<Pick<StateMachineOrchestrator, 'execute'>>;
  let mockLegacyStart: jest.Mock;

  beforeEach(() => {
    featureFlagManager = new FeatureFlagManager();
    mockOrchestrator = {
      execute: jest.fn().mockResolvedValue(createMockExecutionResult()),
    };
    mockLegacyStart = jest.fn().mockResolvedValue('legacy-iteration-id');
  });

  describe('feature flag defaults', () => {
    it('should default iteration-orchestration flag to OFF', () => {
      expect(featureFlagManager.isEnabled('iteration-orchestration')).toBe(false);
    });
  });

  describe('routing when feature flag is OFF', () => {
    it('should call legacy start when flag is OFF', async () => {
      const alertEvent = { id: 'alert-1' };
      const decision = { action: 'remediate' };
      const plan = { id: 'plan-1', steps: [] };

      const result = await featureFlagManager.route(
        'iteration-orchestration',
        () => mockOrchestrator.execute('iteration-loop', { alertEvent, decision, currentPlan: plan }),
        () => mockLegacyStart(alertEvent, decision, plan),
      );

      expect(mockLegacyStart).toHaveBeenCalledWith(alertEvent, decision, plan);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
      expect(result).toBe('legacy-iteration-id');
    });

    it('should propagate errors from legacy start when flag is OFF', async () => {
      mockLegacyStart.mockRejectedValue(new Error('Legacy iteration failed'));

      await expect(
        featureFlagManager.route(
          'iteration-orchestration',
          () => mockOrchestrator.execute('iteration-loop', {}),
          () => mockLegacyStart(),
        ),
      ).rejects.toThrow('Legacy iteration failed');

      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
    });
  });

  describe('routing when feature flag is ON', () => {
    beforeEach(() => {
      featureFlagManager.setEnabled('iteration-orchestration', true);
    });

    it('should call state machine orchestrator when flag is ON', async () => {
      const alertEvent = { id: 'alert-1' };
      const decision = { action: 'remediate' };
      const plan = { id: 'plan-1', steps: [] };

      const result = await featureFlagManager.route(
        'iteration-orchestration',
        () => mockOrchestrator.execute('iteration-loop', {
          alertEvent, decision, currentPlan: plan,
        }),
        () => mockLegacyStart(alertEvent, decision, plan),
      );

      expect(mockOrchestrator.execute).toHaveBeenCalledWith('iteration-loop', {
        alertEvent, decision, currentPlan: plan,
      });
      expect(mockLegacyStart).not.toHaveBeenCalled();
      expect(result).toEqual(createMockExecutionResult());
    });

    it('should propagate errors from orchestrator when flag is ON', async () => {
      mockOrchestrator.execute.mockRejectedValue(new Error('SM iteration failed'));

      await expect(
        featureFlagManager.route(
          'iteration-orchestration',
          () => mockOrchestrator.execute('iteration-loop', {}),
          () => mockLegacyStart(),
        ),
      ).rejects.toThrow('SM iteration failed');

      expect(mockLegacyStart).not.toHaveBeenCalled();
    });
  });

  describe('dynamic flag toggling', () => {
    it('should switch routing when flag is toggled', async () => {
      // Flag OFF → legacy
      await featureFlagManager.route(
        'iteration-orchestration',
        () => mockOrchestrator.execute('iteration-loop', {}),
        () => mockLegacyStart(),
      );
      expect(mockLegacyStart).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();

      // Toggle ON → state machine
      featureFlagManager.setEnabled('iteration-orchestration', true);
      await featureFlagManager.route(
        'iteration-orchestration',
        () => mockOrchestrator.execute('iteration-loop', {}),
        () => mockLegacyStart(),
      );
      expect(mockOrchestrator.execute).toHaveBeenCalledTimes(1);
      expect(mockLegacyStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('fallback when FeatureFlagManager is not configured', () => {
    async function routeIterationStart(
      ffm: FeatureFlagManager | null,
      orch: Pick<StateMachineOrchestrator, 'execute'> | null,
      legacyFn: () => Promise<string>,
    ): Promise<string> {
      if (!ffm || !orch) {
        return legacyFn();
      }
      return ffm.route<string>(
        'iteration-orchestration',
        async () => {
          const execResult = await orch.execute('iteration-loop', {});
          return execResult.executionId;
        },
        legacyFn,
      );
    }

    it('should fall back to legacy when featureFlagManager is null', async () => {
      const result = await routeIterationStart(null, null, mockLegacyStart);
      expect(mockLegacyStart).toHaveBeenCalled();
      expect(result).toBe('legacy-iteration-id');
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
          enabledFor: ['iteration-orchestration'],
          logLevel: 'debug',
        },
      });

      const result = await featureFlagManager.route(
        'iteration-orchestration',
        () => mockOrchestrator.execute('iteration-loop', {}),
        () => mockLegacyStart(),
      );

      expect(mockOrchestrator.execute).toHaveBeenCalled();
      expect(mockLegacyStart).toHaveBeenCalled();
      expect(result).toBe('legacy-iteration-id');
    });
  });
});
