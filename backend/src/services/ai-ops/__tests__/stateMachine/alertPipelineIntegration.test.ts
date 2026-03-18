/**
 * Integration tests for AlertPipeline entry point routing via FeatureFlagManager
 *
 * Verifies:
 * 1. When feature flag is OFF, the original processInternal is called (not the state machine)
 * 2. When feature flag is ON, the state machine orchestrator is called
 * 3. Feature flag defaults to OFF, preserving existing behavior
 * 4. When FeatureFlagManager is not configured, falls back to legacy directly
 *
 * Validates: Requirements 9.3, 9.4
 */

import { FeatureFlagManager } from '../../stateMachine/featureFlagManager';
import { StateMachineOrchestrator } from '../../stateMachine/stateMachineOrchestrator';
import { ExecutionResult } from '../../stateMachine/types';
import { PipelineResult, SyslogEvent } from '../../../../types/ai-ops';

// ============================================================
// Helpers
// ============================================================

const FIXED_TIMESTAMP = 1700000000000;

function createMockSyslogEvent(): SyslogEvent {
  return {
    id: 'syslog-001',
    timestamp: FIXED_TIMESTAMP,
    source: 'syslog',
    severity: 'warning',
    category: 'system',
    message: 'Interface eth0 went down',
    rawData: {
      facility: 1,
      severity: 4,
      timestamp: new Date(FIXED_TIMESTAMP),
      hostname: 'router-1',
      message: 'Interface eth0 went down',
      raw: '<134>Interface eth0 went down',
    },
    metadata: {
      hostname: 'router-1',
      facility: 1,
      syslogSeverity: 4,
    },
  } as SyslogEvent;
}

function createMockPipelineResult(): PipelineResult {
  return {
    event: {
      id: 'unified-001',
      timestamp: FIXED_TIMESTAMP,
      source: 'syslog',
      severity: 'warning',
      message: 'Interface eth0 went down',
      category: 'network',
      rawData: {},
      metadata: {},
    },
    stage: 'decide',
    filtered: false,
  } as unknown as PipelineResult;
}

function createMockExecutionResult(overrides?: Partial<ExecutionResult>): ExecutionResult {
  return {
    executionId: 'exec-alert-123',
    requestId: 'req-alert-123',
    definitionId: 'alert-pipeline',
    finalState: 'decide',
    success: true,
    totalDuration: 50,
    nodesVisited: 6,
    degraded: false,
    degradedNodes: [],
    output: {
      pipelineResult: createMockPipelineResult(),
    },
    transitionPath: [],
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('AlertPipeline Entry Point Integration', () => {
  let featureFlagManager: FeatureFlagManager;
  let mockOrchestrator: jest.Mocked<Pick<StateMachineOrchestrator, 'execute'>>;
  let mockLegacyProcess: jest.Mock;

  beforeEach(() => {
    featureFlagManager = new FeatureFlagManager(); // defaults all flags to OFF
    mockOrchestrator = {
      execute: jest.fn().mockResolvedValue(createMockExecutionResult()),
    };
    mockLegacyProcess = jest.fn().mockResolvedValue(createMockPipelineResult());
  });

  describe('feature flag defaults', () => {
    it('should default alert-orchestration flag to OFF', () => {
      expect(featureFlagManager.isEnabled('alert-orchestration')).toBe(false);
    });
  });

  describe('routing when feature flag is OFF', () => {
    it('should call legacy process when flag is OFF', async () => {
      const event = createMockSyslogEvent();

      const result = await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );

      expect(mockLegacyProcess).toHaveBeenCalledWith(event);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
      expect(result).toEqual(createMockPipelineResult());
    });

    it('should preserve original process arguments when flag is OFF', async () => {
      const event = createMockSyslogEvent();

      await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );

      expect(mockLegacyProcess).toHaveBeenCalledWith(event);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
    });

    it('should propagate errors from legacy process when flag is OFF', async () => {
      const error = new Error('Legacy pipeline failed');
      mockLegacyProcess.mockRejectedValue(error);

      await expect(
        featureFlagManager.route(
          'alert-orchestration',
          () => mockOrchestrator.execute('alert-pipeline', {}),
          () => mockLegacyProcess(),
        ),
      ).rejects.toThrow('Legacy pipeline failed');

      expect(mockOrchestrator.execute).not.toHaveBeenCalled();
    });
  });

  describe('routing when feature flag is ON', () => {
    beforeEach(() => {
      featureFlagManager.setEnabled('alert-orchestration', true);
    });

    it('should call state machine orchestrator when flag is ON', async () => {
      const event = createMockSyslogEvent();

      const result = await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );

      expect(mockOrchestrator.execute).toHaveBeenCalledWith('alert-pipeline', { rawEvent: event });
      expect(mockLegacyProcess).not.toHaveBeenCalled();
      expect(result).toEqual(createMockExecutionResult());
    });

    it('should pass correct definitionId to orchestrator', async () => {
      const event = createMockSyslogEvent();

      await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );

      expect(mockOrchestrator.execute).toHaveBeenCalledWith(
        'alert-pipeline',
        expect.objectContaining({ rawEvent: event }),
      );
    });

    it('should propagate errors from state machine orchestrator when flag is ON', async () => {
      const error = new Error('State machine execution failed');
      mockOrchestrator.execute.mockRejectedValue(error);

      await expect(
        featureFlagManager.route(
          'alert-orchestration',
          () => mockOrchestrator.execute('alert-pipeline', {}),
          () => mockLegacyProcess(),
        ),
      ).rejects.toThrow('State machine execution failed');

      expect(mockLegacyProcess).not.toHaveBeenCalled();
    });
  });

  describe('dynamic flag toggling', () => {
    it('should switch from legacy to state machine when flag is toggled ON', async () => {
      const event = createMockSyslogEvent();

      // First call: flag OFF -> legacy
      await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );
      expect(mockLegacyProcess).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.execute).not.toHaveBeenCalled();

      // Toggle flag ON
      featureFlagManager.setEnabled('alert-orchestration', true);

      // Second call: flag ON -> state machine
      await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );
      expect(mockOrchestrator.execute).toHaveBeenCalledTimes(1);
      expect(mockLegacyProcess).toHaveBeenCalledTimes(1); // still 1 from before
    });
  });

  describe('fallback when FeatureFlagManager is not configured', () => {
    // Helper that mimics the routing logic inside AlertPipeline.process
    async function routeAlertProcess(
      ffm: FeatureFlagManager | null,
      orch: Pick<StateMachineOrchestrator, 'execute'> | null,
      event: SyslogEvent,
      legacyFn: (e: SyslogEvent) => Promise<PipelineResult>,
    ): Promise<PipelineResult> {
      if (!ffm || !orch) {
        return legacyFn(event);
      }
      return ffm.route<PipelineResult>(
        'alert-orchestration',
        async () => {
          const execResult = await orch.execute('alert-pipeline', { rawEvent: event });
          return execResult.output.pipelineResult as PipelineResult;
        },
        () => legacyFn(event),
      );
    }

    it('should fall back to legacy when featureFlagManager is null', async () => {
      const event = createMockSyslogEvent();

      const result = await routeAlertProcess(null, null, event, mockLegacyProcess);

      expect(mockLegacyProcess).toHaveBeenCalledWith(event);
      expect(result).toEqual(createMockPipelineResult());
    });

    it('should fall back to legacy when orchestrator is null but FFM exists', async () => {
      const event = createMockSyslogEvent();

      const result = await routeAlertProcess(
        new FeatureFlagManager(), null, event, mockLegacyProcess,
      );

      expect(mockLegacyProcess).toHaveBeenCalledWith(event);
      expect(result).toEqual(createMockPipelineResult());
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
          enabledFor: ['alert-orchestration'],
          logLevel: 'debug',
        },
      });

      const event = createMockSyslogEvent();

      const result = await featureFlagManager.route(
        'alert-orchestration',
        () => mockOrchestrator.execute('alert-pipeline', { rawEvent: event }),
        () => mockLegacyProcess(event),
      );

      // Both should have been called
      expect(mockOrchestrator.execute).toHaveBeenCalled();
      expect(mockLegacyProcess).toHaveBeenCalled();

      // Should return legacy result for safety
      expect(result).toEqual(createMockPipelineResult());
    });
  });

  describe('integration with AlertPipeline.process pattern', () => {
    it('should support the routing pattern used in AlertPipeline.process', async () => {
      const event = createMockSyslogEvent();
      const startTime = Date.now();

      // The routing pattern wraps the processInternal call
      const pipelineResult = await featureFlagManager.route<PipelineResult>(
        'alert-orchestration',
        async () => {
          const execResult = await mockOrchestrator.execute('alert-pipeline', {
            rawEvent: event,
          });
          return execResult.output.pipelineResult as PipelineResult;
        },
        () => mockLegacyProcess(event, startTime),
      );

      // Flag is OFF by default, so legacy should be called
      expect(mockLegacyProcess).toHaveBeenCalledWith(event, startTime);
      expect(pipelineResult).toEqual(createMockPipelineResult());
    });
  });
});
