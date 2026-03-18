import { alertPipeline } from '../alertPipeline';
import { autonomousBrainService } from '../brain/autonomousBrainService';
import { eventProcessingTracker } from '../eventProcessingTracker';
import { AlertEvent } from '../../../types/ai-ops';

// Mock dependencies
jest.mock('../brain/autonomousBrainService', () => ({
    autonomousBrainService: {
        triggerTick: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('../eventProcessingTracker', () => ({
    eventProcessingTracker: {
        startProcessing: jest.fn(),
        markCompleted: jest.fn(),
        markProcessing: jest.fn().mockReturnValue(true),
        isProcessing: jest.fn().mockReturnValue(false),
    },
}));

jest.mock('../auditLogger', () => ({
    auditLogger: {
        log: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('../decisionEngine', () => ({
    decisionEngine: {
        initialize: jest.fn().mockResolvedValue(undefined),
        executeDecision: jest.fn().mockResolvedValue(undefined),
        saveDecision: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock('../remediationAdvisor', () => ({
    remediationAdvisor: {
        generatePlan: jest.fn().mockResolvedValue(undefined),
    },
}));

// Mock featureFlagManager
jest.mock('../stateMachine/featureFlagManager', () => ({
    FeatureFlagManager: {
        getInstance: jest.fn().mockReturnValue({
            isFeatureEnabled: jest.fn().mockReturnValue(false),
            getRoutingPercentage: jest.fn().mockReturnValue(0),
        })
    },
}));

// Mock the rest of pipeline stages selectively
alertPipeline['stageNormalize'] = jest.fn().mockImplementation((event) => Promise.resolve(event));
alertPipeline['stageDeduplicate'] = jest.fn().mockImplementation((event) => Promise.resolve(false));
alertPipeline['stageFilter'] = jest.fn().mockImplementation((event) => Promise.resolve({ filtered: false, event }));
alertPipeline['stageAnalyze'] = jest.fn().mockResolvedValue({ eventId: 'test-1', rootCause: 'test' });
alertPipeline['stageDecide'] = jest.fn().mockResolvedValue({ id: 'dec-1', action: 'remediate' });

describe('Autonomous Brain Integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should trigger Brain tick on critical severity alert', async () => {
        const criticalEvent: AlertEvent = {
            id: 'test-critical-alert-1',
            ruleId: 'r1',
            ruleName: 'System Down',
            severity: 'critical',
            metric: 'cpu',
            currentValue: 100,
            threshold: 90,
            message: 'Server unreachable',
            status: 'active',
            triggeredAt: Date.now(),
        };

        await alertPipeline.process(criticalEvent);

        expect(autonomousBrainService.triggerTick).toHaveBeenCalledWith(
            'critical_alert',
            expect.objectContaining({
                eventId: criticalEvent.id,
                severity: 'critical',
            })
        );
    });

    it('should not trigger Brain tick on warning severity alert unless action is escalate', async () => {
        const warningEvent: AlertEvent = {
            id: 'test-warning-alert-2',
            ruleId: 'r2',
            ruleName: 'High Mem',
            severity: 'warning',
            metric: 'memory',
            currentValue: 80,
            threshold: 70,
            message: 'High memory usage',
            status: 'active',
            triggeredAt: Date.now(),
        };

        await alertPipeline.process(warningEvent);

        expect(autonomousBrainService.triggerTick).not.toHaveBeenCalled();
    });
});
