/**
 * FaultHealer Evolution Integration Tests
 * 
 * Tests for the selfHealing capability integration in handleAlertEvent(),
 * and periodic health detection timer management.
 * Validates that the method correctly checks Evolution_Config and applies
 * the appropriate behavior based on autoHealingLevel.
 * 
 * Requirements: 4.1, 4.2
 */

import { FaultHealer } from './faultHealer';
import * as evolutionConfig from './evolutionConfig';
import { AlertEvent, FaultPattern, RemediationExecution } from '../../types/ai-ops';

// Mock evolutionConfig
jest.mock('./evolutionConfig', () => ({
  isCapabilityEnabled: jest.fn(),
  getCapabilityConfig: jest.fn(),
}));

// Mock dependencies that faultHealer uses internally
jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('./auditLogger', () => ({
  auditLogger: { log: jest.fn() },
}));

jest.mock('./notificationService', () => ({
  notificationService: {
    getChannels: jest.fn().mockResolvedValue([]),
    send: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('./configSnapshotService', () => ({
  configSnapshotService: {
    createSnapshot: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
  },
}));

jest.mock('../device/devicePool', () => ({
  DevicePool: jest.fn(),
}));

jest.mock('./rag', () => ({
  knowledgeBase: {
    indexPattern: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock fs/promises to avoid file system operations
jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

const mockIsCapabilityEnabled = evolutionConfig.isCapabilityEnabled as jest.MockedFunction<typeof evolutionConfig.isCapabilityEnabled>;
const mockGetCapabilityConfig = evolutionConfig.getCapabilityConfig as jest.MockedFunction<typeof evolutionConfig.getCapabilityConfig>;

/**
 * Create a test AlertEvent with the given severity
 */
function createAlertEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'alert-001',
    tenantId: 'test-tenant',
    deviceId: 'test-device',
    ruleId: 'rule-001',
    ruleName: 'Test Rule',
    severity: 'warning',
    metric: 'cpu',
    currentValue: 95,
    threshold: 90,
    message: 'CPU usage high',
    status: 'active',
    triggeredAt: Date.now(),
    ...overrides,
  };
}

describe('FaultHealer.handleAlertEvent - Evolution Config Integration', () => {
  let healer: FaultHealer;

  beforeEach(() => {
    jest.clearAllMocks();
    healer = new FaultHealer();
  });

  describe('when selfHealing capability is disabled', () => {
    beforeEach(() => {
      mockIsCapabilityEnabled.mockReturnValue(false);
    });

    it('should return null without processing the alert', async () => {
      const alertEvent = createAlertEvent();
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
      expect(mockIsCapabilityEnabled).toHaveBeenCalledWith('selfHealing');
      // Should not call getCapabilityConfig when disabled
      expect(mockGetCapabilityConfig).not.toHaveBeenCalled();
    });
  });

  describe('when selfHealing is enabled but autoHealingLevel is disabled', () => {
    beforeEach(() => {
      mockIsCapabilityEnabled.mockReturnValue(true);
      mockGetCapabilityConfig.mockReturnValue({
        enabled: true,
        autoHealingLevel: 'disabled',
        faultDetectionIntervalSeconds: 30,
        rootCauseAnalysisTimeoutSeconds: 60,
      } as evolutionConfig.SelfHealingConfig);
    });

    it('should return null without processing the alert', async () => {
      const alertEvent = createAlertEvent();
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
    });
  });

  describe('when autoHealingLevel is notify (manual)', () => {
    let matchPatternSpy: jest.SpyInstance;
    let sendNotificationSpy: jest.SpyInstance;

    beforeEach(() => {
      mockIsCapabilityEnabled.mockReturnValue(true);
      mockGetCapabilityConfig.mockReturnValue({
        enabled: true,
        autoHealingLevel: 'notify',
        faultDetectionIntervalSeconds: 30,
        rootCauseAnalysisTimeoutSeconds: 60,
      } as evolutionConfig.SelfHealingConfig);

      // Mock matchPattern to return a pattern
      matchPatternSpy = jest.spyOn(healer, 'matchPattern').mockResolvedValue({
        id: 'pattern-001',
        name: 'Test Pattern',
        description: 'Test',
        enabled: true,
        autoHeal: true,
        builtin: false,
        conditions: [],
        remediationScript: '/test script',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as FaultPattern);

      // Mock the private sendRemediationSuggestionNotification
      sendNotificationSpy = jest.spyOn(healer as any, 'sendRemediationSuggestionNotification')
        .mockResolvedValue(undefined);
    });

    it('should send suggestion notification and return null', async () => {
      const alertEvent = createAlertEvent();
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
      expect(sendNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pattern-001' }),
        alertEvent.id
      );
    });

    it('should not call executeRemediation', async () => {
      const executeRemediationSpy = jest.spyOn(healer, 'executeRemediation');
      const alertEvent = createAlertEvent();
      await healer.handleAlertEvent(alertEvent);

      expect(executeRemediationSpy).not.toHaveBeenCalled();
    });

    it('should return null when no pattern matches', async () => {
      matchPatternSpy.mockResolvedValue(null);
      const alertEvent = createAlertEvent();
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
      expect(sendNotificationSpy).not.toHaveBeenCalled();
    });
  });

  describe('when autoHealingLevel is low_risk (semi-auto)', () => {
    let matchPatternSpy: jest.SpyInstance;
    let executeRemediationSpy: jest.SpyInstance;
    let sendNotificationSpy: jest.SpyInstance;

    const mockRemediation: RemediationExecution = {
      id: 'rem-001',
      patternId: 'pattern-001',
      patternName: 'Test Pattern',
      alertEventId: 'alert-001',
      status: 'success',
      retryCount: 0,
      startedAt: Date.now(),
    };

    beforeEach(() => {
      mockIsCapabilityEnabled.mockReturnValue(true);
      mockGetCapabilityConfig.mockReturnValue({
        enabled: true,
        autoHealingLevel: 'low_risk',
        faultDetectionIntervalSeconds: 30,
        rootCauseAnalysisTimeoutSeconds: 60,
      } as evolutionConfig.SelfHealingConfig);

      matchPatternSpy = jest.spyOn(healer, 'matchPattern').mockResolvedValue({
        id: 'pattern-001',
        name: 'Test Pattern',
        description: 'Test',
        enabled: true,
        autoHeal: true,
        builtin: false,
        conditions: [],
        remediationScript: '/test script',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as FaultPattern);

      executeRemediationSpy = jest.spyOn(healer, 'executeRemediation')
        .mockResolvedValue(mockRemediation);

      sendNotificationSpy = jest.spyOn(healer as any, 'sendRemediationSuggestionNotification')
        .mockResolvedValue(undefined);
    });

    it('should auto-execute remediation for info severity alerts', async () => {
      const alertEvent = createAlertEvent({ severity: 'info' });
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toEqual(mockRemediation);
      expect(executeRemediationSpy).toHaveBeenCalledWith('pattern-001', alertEvent.id, 'test-tenant', 'test-device');
      expect(sendNotificationSpy).not.toHaveBeenCalled();
    });

    it('should auto-execute remediation for warning severity alerts', async () => {
      const alertEvent = createAlertEvent({ severity: 'warning' });
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toEqual(mockRemediation);
      expect(executeRemediationSpy).toHaveBeenCalledWith('pattern-001', alertEvent.id, 'test-tenant', 'test-device');
      expect(sendNotificationSpy).not.toHaveBeenCalled();
    });

    it('should only send suggestion for critical severity alerts', async () => {
      const alertEvent = createAlertEvent({ severity: 'critical' });
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
      expect(executeRemediationSpy).not.toHaveBeenCalled();
      expect(sendNotificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pattern-001' }),
        alertEvent.id
      );
    });

    it('should only send suggestion for emergency severity alerts', async () => {
      const alertEvent = createAlertEvent({ severity: 'emergency' });
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
      expect(executeRemediationSpy).not.toHaveBeenCalled();
      expect(sendNotificationSpy).toHaveBeenCalled();
    });
  });

  describe('when autoHealingLevel is full (full-auto)', () => {
    let matchPatternSpy: jest.SpyInstance;
    let executeRemediationSpy: jest.SpyInstance;

    const mockRemediation: RemediationExecution = {
      id: 'rem-001',
      patternId: 'pattern-001',
      patternName: 'Test Pattern',
      alertEventId: 'alert-001',
      status: 'success',
      retryCount: 0,
      startedAt: Date.now(),
    };

    beforeEach(() => {
      mockIsCapabilityEnabled.mockReturnValue(true);
      mockGetCapabilityConfig.mockReturnValue({
        enabled: true,
        autoHealingLevel: 'full',
        faultDetectionIntervalSeconds: 30,
        rootCauseAnalysisTimeoutSeconds: 60,
      } as evolutionConfig.SelfHealingConfig);

      matchPatternSpy = jest.spyOn(healer, 'matchPattern').mockResolvedValue({
        id: 'pattern-001',
        name: 'Test Pattern',
        description: 'Test',
        enabled: true,
        autoHeal: true,
        builtin: false,
        conditions: [],
        remediationScript: '/test script',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as FaultPattern);

      executeRemediationSpy = jest.spyOn(healer, 'executeRemediation')
        .mockResolvedValue(mockRemediation);
    });

    it('should auto-execute remediation for all severity levels', async () => {
      for (const severity of ['info', 'warning', 'critical', 'emergency'] as const) {
        executeRemediationSpy.mockClear();
        const alertEvent = createAlertEvent({ severity });
        const result = await healer.handleAlertEvent(alertEvent);

        expect(result).toEqual(mockRemediation);
        expect(executeRemediationSpy).toHaveBeenCalledWith('pattern-001', alertEvent.id, 'test-tenant', 'test-device');
      }
    });

    it('should return null when no pattern matches', async () => {
      matchPatternSpy.mockResolvedValue(null);
      const alertEvent = createAlertEvent({ severity: 'critical' });
      const result = await healer.handleAlertEvent(alertEvent);

      expect(result).toBeNull();
      expect(executeRemediationSpy).not.toHaveBeenCalled();
    });
  });
});

describe('FaultHealer.getAIConfirmationWithTimeout - Root Cause Analysis Timeout', () => {
  let healer: FaultHealer;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    healer = new FaultHealer();
  });

  afterEach(() => {
    healer.shutdown();
    jest.useRealTimers();
  });

  const mockPattern: FaultPattern = {
    id: 'pattern-001',
    name: 'Test Pattern',
    description: 'Test',
    enabled: true,
    autoHeal: true,
    builtin: false,
    conditions: [{ metric: 'cpu', operator: 'gt', threshold: 90 }],
    remediationScript: '/test script',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const mockAlertEvent: AlertEvent = {
    id: 'alert-001',
    tenantId: 'test-tenant',
    deviceId: 'test-device',
    ruleId: 'rule-001',
    ruleName: 'Test Rule',
    severity: 'warning',
    metric: 'cpu',
    currentValue: 95,
    threshold: 90,
    message: 'CPU usage high',
    status: 'active',
    triggeredAt: Date.now(),
  };

  it('should use rootCauseAnalysisTimeoutSeconds from config', async () => {
    mockIsCapabilityEnabled.mockReturnValue(true);
    mockGetCapabilityConfig.mockReturnValue({
      enabled: true,
      autoHealingLevel: 'full',
      faultDetectionIntervalSeconds: 30,
      rootCauseAnalysisTimeoutSeconds: 45,
    } as evolutionConfig.SelfHealingConfig);

    // getAIConfirmation resolves immediately, so no timeout
    const result = await (healer as any).getAIConfirmationWithTimeout(mockPattern, mockAlertEvent);

    expect(result.confirmed).toBe(true);
    expect(result.confidence).toBe(0.85);
    expect(mockGetCapabilityConfig).toHaveBeenCalledWith('selfHealing');
  });

  it('should return timeout error when analysis exceeds configured timeout', async () => {
    mockIsCapabilityEnabled.mockReturnValue(true);
    mockGetCapabilityConfig.mockReturnValue({
      enabled: true,
      autoHealingLevel: 'full',
      faultDetectionIntervalSeconds: 30,
      rootCauseAnalysisTimeoutSeconds: 5,
    } as evolutionConfig.SelfHealingConfig);

    // Mock getAIConfirmation to be slow (never resolves within timeout)
    jest.spyOn(healer as any, 'getAIConfirmation').mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(() => resolve({ confirmed: true, confidence: 0.85, reasoning: 'ok' }), 10000);
      })
    );

    const resultPromise = (healer as any).getAIConfirmationWithTimeout(mockPattern, mockAlertEvent);

    // Advance time past the timeout (5 seconds)
    jest.advanceTimersByTime(5000);

    const result = await resultPromise;

    expect(result.confirmed).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain('根因分析超时');
    expect(result.reasoning).toContain('5');
  });

  it('should use default 60s timeout when selfHealing is not enabled', async () => {
    mockIsCapabilityEnabled.mockReturnValue(false);

    // getAIConfirmation resolves immediately
    const result = await (healer as any).getAIConfirmationWithTimeout(mockPattern, mockAlertEvent);

    expect(result.confirmed).toBe(true);
    // Should not call getCapabilityConfig when disabled
    expect(mockGetCapabilityConfig).not.toHaveBeenCalled();
  });

  it('should use default timeout when config read fails', async () => {
    mockIsCapabilityEnabled.mockImplementation(() => {
      throw new Error('Config error');
    });

    // getAIConfirmation resolves immediately, so default timeout doesn't matter
    const result = await (healer as any).getAIConfirmationWithTimeout(mockPattern, mockAlertEvent);

    expect(result.confirmed).toBe(true);
    expect(result.confidence).toBe(0.85);
  });

  it('should return successful result when analysis completes within timeout', async () => {
    mockIsCapabilityEnabled.mockReturnValue(true);
    mockGetCapabilityConfig.mockReturnValue({
      enabled: true,
      autoHealingLevel: 'full',
      faultDetectionIntervalSeconds: 30,
      rootCauseAnalysisTimeoutSeconds: 10,
    } as evolutionConfig.SelfHealingConfig);

    // Mock getAIConfirmation to resolve after 2 seconds (within 10s timeout)
    jest.spyOn(healer as any, 'getAIConfirmation').mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(() => resolve({ confirmed: true, confidence: 0.9, reasoning: 'Confirmed' }), 2000);
      })
    );

    const resultPromise = (healer as any).getAIConfirmationWithTimeout(mockPattern, mockAlertEvent);

    // Advance time to 2 seconds (analysis completes)
    jest.advanceTimersByTime(2000);

    const result = await resultPromise;

    expect(result.confirmed).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toBe('Confirmed');
  });
});

describe('FaultHealer.periodicDetection - Timer Management', () => {
  let healer: FaultHealer;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    healer = new FaultHealer();
  });

  afterEach(() => {
    healer.shutdown();
    jest.useRealTimers();
  });

  describe('startPeriodicDetection', () => {
    it('should set up an interval timer with the specified interval in seconds', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      healer.startPeriodicDetection(30);

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
      setIntervalSpy.mockRestore();
    });

    it('should stop any existing timer before starting a new one', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      healer.startPeriodicDetection(30);
      // Starting again should clear the first timer
      healer.startPeriodicDetection(60);

      // clearInterval should have been called (once for the first timer)
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('should not start timer when intervalSeconds is 0 or negative', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      healer.startPeriodicDetection(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();

      healer.startPeriodicDetection(-5);
      expect(setIntervalSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
    });
  });

  describe('stopPeriodicDetection', () => {
    it('should clear the detection timer', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      healer.startPeriodicDetection(30);
      healer.stopPeriodicDetection();

      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('should be safe to call when no timer is running', () => {
      // Should not throw
      expect(() => healer.stopPeriodicDetection()).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should stop the periodic detection timer', () => {
      const stopSpy = jest.spyOn(healer, 'stopPeriodicDetection');

      healer.startPeriodicDetection(30);
      healer.shutdown();

      expect(stopSpy).toHaveBeenCalled();
      stopSpy.mockRestore();
    });
  });
});
