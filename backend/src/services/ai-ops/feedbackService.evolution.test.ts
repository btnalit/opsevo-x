/**
 * FeedbackService Evolution Config Integration Tests
 *
 * Tests for task 1.1: triggerExperienceExtraction() integration with Evolution Config
 * - isCapabilityEnabled('experience') gate check
 * - autoApprove config determines experience status ('approved' vs 'pending')
 *
 * Requirements: 1.4, 1.5
 */

import {
  updateCapabilityConfig,
  resetEvolutionConfig,
  enableCapability,
  disableCapability,
} from './evolutionConfig';
import { FeedbackService, ExperienceEntry } from './feedbackService';

// We need to test through the public API (recordFeedback) since triggerExperienceExtraction is private.
// The method is called when feedback.useful === true and sessionContext.sessionId is provided.

describe('FeedbackService - Evolution Config Integration', () => {
  let service: FeedbackService;

  beforeEach(async () => {
    resetEvolutionConfig();
    service = new FeedbackService();
    await service.initialize();
  });

  afterEach(() => {
    resetEvolutionConfig();
  });

  const createUsefulFeedbackInput = () => ({
    alertId: 'test-alert-001',
    useful: true,
    comment: 'This was helpful',
  });

  const createSessionContext = () => ({
    sessionId: 'test-session-001',
    conversationHistory: [
      { role: 'user', content: 'How to fix high CPU usage?' },
      { role: 'assistant', content: 'Let me check the system metrics.' },
    ],
    reActSteps: [
      {
        thought: 'I should check CPU metrics',
        action: { tool: 'check_metrics', params: { metric: 'cpu' } },
        observation: 'CPU at 95%',
        success: true,
      },
    ],
  });

  describe('Requirement 1.4: Experience capability gate', () => {
    it('should NOT extract experience when experience capability is disabled', async () => {
      // Ensure experience is disabled (default)
      disableCapability('experience');

      await service.recordFeedback(
        createUsefulFeedbackInput(),
        undefined,
        createSessionContext()
      );

      // No experiences should be created when capability is disabled
      const experiences = await service.getExperiences();
      expect(experiences.length).toBe(0);
    });

    it('should extract experience when experience capability is enabled', async () => {
      enableCapability('experience');
      updateCapabilityConfig('experience', { autoApprove: true });

      await service.recordFeedback(
        createUsefulFeedbackInput(),
        undefined,
        createSessionContext()
      );

      const experiences = await service.getExperiences();
      expect(experiences.length).toBe(1);
    });
  });

  describe('Requirement 1.5: autoApprove determines experience status', () => {
    it('should set status to "approved" when autoApprove is true', async () => {
      enableCapability('experience');
      updateCapabilityConfig('experience', { autoApprove: true });

      await service.recordFeedback(
        createUsefulFeedbackInput(),
        undefined,
        createSessionContext()
      );

      const experiences = await service.getExperiences();
      expect(experiences.length).toBe(1);
      expect(experiences[0].status).toBe('approved');
    });

    it('should set status to "pending" when autoApprove is false', async () => {
      enableCapability('experience');
      updateCapabilityConfig('experience', { autoApprove: false });

      await service.recordFeedback(
        createUsefulFeedbackInput(),
        undefined,
        createSessionContext()
      );

      // getExperiences without status filter returns all
      const allExperiences = await service.getExperiences();
      expect(allExperiences.length).toBe(1);
      expect(allExperiences[0].status).toBe('pending');

      // Pending experiences should not appear in default approved-only retrieval
      const approvedExperiences = await service.getExperiences({ status: 'approved' });
      expect(approvedExperiences.length).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('should not extract experience when feedback is not useful (regardless of config)', async () => {
      enableCapability('experience');
      updateCapabilityConfig('experience', { autoApprove: true });

      await service.recordFeedback(
        { alertId: 'test-alert-002', useful: false },
        undefined,
        createSessionContext()
      );

      const experiences = await service.getExperiences();
      expect(experiences.length).toBe(0);
    });

    it('should not extract experience when sessionId is missing (regardless of config)', async () => {
      enableCapability('experience');
      updateCapabilityConfig('experience', { autoApprove: true });

      await service.recordFeedback(
        createUsefulFeedbackInput(),
        undefined,
        // No sessionContext
        undefined
      );

      const experiences = await service.getExperiences();
      expect(experiences.length).toBe(0);
    });
  });
});
