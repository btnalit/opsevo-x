/**
 * AI-OPS 智能进化系统配置测试
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AIEvolutionConfig,
  DEFAULT_EVOLUTION_CONFIG,
  getEvolutionConfig,
  getCapabilityConfig,
  isCapabilityEnabled,
  updateEvolutionConfig,
  updateCapabilityConfig,
  enableCapability,
  disableCapability,
  resetEvolutionConfig,
  validateConfig,
  getCapabilityStatusSummary,
  RiskLevel,
  AutoHealingLevel,
  loadConfigFromFile,
  saveConfigToFile,
  startConfigFileWatcher,
  stopConfigFileWatcher,
  addConfigChangeListener,
  initializeEvolutionConfig,
  shutdownEvolutionConfig,
  getConfigFilePath,
  isEvolutionConfigInitialized,
} from './evolutionConfig';

describe('evolutionConfig', () => {
  // 每个测试前重置配置
  beforeEach(() => {
    resetEvolutionConfig();
  });

  describe('DEFAULT_EVOLUTION_CONFIG', () => {
    it('should have all capabilities disabled by default except tracing', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.reflection.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.experience.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.planRevision.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.toolFeedback.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.proactiveOps.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.intentDriven.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.selfHealing.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.continuousLearning.enabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.tracing.enabled).toBe(true);
    });

    it('should have correct default values for reflection config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.reflection.maxRetries).toBe(2);
      expect(DEFAULT_EVOLUTION_CONFIG.reflection.timeoutMs).toBe(5000);
    });

    it('should have correct default values for experience config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.experience.minScoreForRetrieval).toBe(0.7);
      expect(DEFAULT_EVOLUTION_CONFIG.experience.maxFewShotExamples).toBe(2);
      expect(DEFAULT_EVOLUTION_CONFIG.experience.autoApprove).toBe(false);
    });

    it('should have correct default values for planRevision config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.planRevision.qualityThreshold).toBe(60);
      expect(DEFAULT_EVOLUTION_CONFIG.planRevision.maxAdditionalSteps).toBe(2);
    });

    it('should have correct default values for toolFeedback config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.toolFeedback.metricsRetentionDays).toBe(7);
      expect(DEFAULT_EVOLUTION_CONFIG.toolFeedback.priorityOptimizationEnabled).toBe(false);
    });

    it('should have correct default values for proactiveOps config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.proactiveOps.healthCheckIntervalSeconds).toBe(60);
      expect(DEFAULT_EVOLUTION_CONFIG.proactiveOps.predictionTimeWindowMinutes).toBe(30);
      expect(DEFAULT_EVOLUTION_CONFIG.proactiveOps.predictionConfidenceThreshold).toBe(0.7);
      expect(DEFAULT_EVOLUTION_CONFIG.proactiveOps.inspectionIntervalHours).toBe(4);
      expect(DEFAULT_EVOLUTION_CONFIG.proactiveOps.contextAwareChatEnabled).toBe(false);
    });

    it('should have correct default values for intentDriven config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.intentDriven.confidenceThreshold).toBe(0.8);
      expect(DEFAULT_EVOLUTION_CONFIG.intentDriven.confirmationTimeoutMinutes).toBe(5);
      expect(DEFAULT_EVOLUTION_CONFIG.intentDriven.riskLevelForConfirmation).toBe('L3');
    });

    it('should have correct default values for selfHealing config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.selfHealing.autoHealingLevel).toBe('notify');
      expect(DEFAULT_EVOLUTION_CONFIG.selfHealing.faultDetectionIntervalSeconds).toBe(30);
      expect(DEFAULT_EVOLUTION_CONFIG.selfHealing.rootCauseAnalysisTimeoutSeconds).toBe(60);
    });

    it('should have correct default values for continuousLearning config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.continuousLearning.patternLearningEnabled).toBe(false);
      expect(DEFAULT_EVOLUTION_CONFIG.continuousLearning.patternLearningDelayDays).toBe(7);
      expect(DEFAULT_EVOLUTION_CONFIG.continuousLearning.bestPracticeThreshold).toBe(3);
      expect(DEFAULT_EVOLUTION_CONFIG.continuousLearning.strategyEvaluationIntervalDays).toBe(7);
      expect(DEFAULT_EVOLUTION_CONFIG.continuousLearning.knowledgeGraphUpdateIntervalHours).toBe(24);
    });

    it('should have correct default values for tracing config', () => {
      expect(DEFAULT_EVOLUTION_CONFIG.tracing.traceRetentionDays).toBe(30);
      expect(DEFAULT_EVOLUTION_CONFIG.tracing.longTaskThresholdMinutes).toBe(5);
      expect(DEFAULT_EVOLUTION_CONFIG.tracing.heartbeatIntervalSeconds).toBe(30);
      expect(DEFAULT_EVOLUTION_CONFIG.tracing.enableOpenTelemetryExport).toBe(false);
    });
  });

  describe('getEvolutionConfig', () => {
    it('should return a copy of the current config', () => {
      const config = getEvolutionConfig();
      expect(config).toEqual(DEFAULT_EVOLUTION_CONFIG);
      
      // Verify it's a copy, not the same reference
      config.reflection.enabled = true;
      const config2 = getEvolutionConfig();
      expect(config2.reflection.enabled).toBe(false);
    });
  });

  describe('getCapabilityConfig', () => {
    it('should return a copy of specific capability config', () => {
      const reflectionConfig = getCapabilityConfig('reflection');
      expect(reflectionConfig).toEqual(DEFAULT_EVOLUTION_CONFIG.reflection);
      
      // Verify it's a copy
      reflectionConfig.enabled = true;
      const reflectionConfig2 = getCapabilityConfig('reflection');
      expect(reflectionConfig2.enabled).toBe(false);
    });
  });

  describe('isCapabilityEnabled', () => {
    it('should return false for disabled capabilities', () => {
      expect(isCapabilityEnabled('reflection')).toBe(false);
      expect(isCapabilityEnabled('experience')).toBe(false);
      expect(isCapabilityEnabled('selfHealing')).toBe(false);
    });

    it('should return true for enabled capabilities', () => {
      expect(isCapabilityEnabled('tracing')).toBe(true);
    });
  });

  describe('updateEvolutionConfig', () => {
    it('should update specific config values', () => {
      updateEvolutionConfig({
        reflection: {
          enabled: true,
          maxRetries: 3,
          timeoutMs: 10000,
        },
      });

      const config = getEvolutionConfig();
      expect(config.reflection.enabled).toBe(true);
      expect(config.reflection.maxRetries).toBe(3);
      expect(config.reflection.timeoutMs).toBe(10000);
    });

    it('should preserve other config values when updating', () => {
      updateEvolutionConfig({
        reflection: {
          enabled: true,
          maxRetries: 2,
          timeoutMs: 5000,
        },
      });

      const config = getEvolutionConfig();
      // Other capabilities should remain unchanged
      expect(config.experience.enabled).toBe(false);
      expect(config.experience.minScoreForRetrieval).toBe(0.7);
    });

    it('should support partial updates within a capability', () => {
      updateEvolutionConfig({
        reflection: {
          enabled: true,
          maxRetries: 2,
          timeoutMs: 5000,
        },
      });

      // Update only one field
      updateEvolutionConfig({
        reflection: {
          enabled: true,
          maxRetries: 5,
          timeoutMs: 5000,
        },
      });

      const config = getEvolutionConfig();
      expect(config.reflection.maxRetries).toBe(5);
      expect(config.reflection.timeoutMs).toBe(5000);
    });
  });

  describe('updateCapabilityConfig', () => {
    it('should update specific capability config', () => {
      updateCapabilityConfig('reflection', {
        enabled: true,
        maxRetries: 4,
      });

      const config = getCapabilityConfig('reflection');
      expect(config.enabled).toBe(true);
      expect(config.maxRetries).toBe(4);
      expect(config.timeoutMs).toBe(5000); // Unchanged
    });
  });

  describe('enableCapability / disableCapability', () => {
    it('should enable a capability', () => {
      expect(isCapabilityEnabled('reflection')).toBe(false);
      enableCapability('reflection');
      expect(isCapabilityEnabled('reflection')).toBe(true);
    });

    it('should disable a capability', () => {
      expect(isCapabilityEnabled('tracing')).toBe(true);
      disableCapability('tracing');
      expect(isCapabilityEnabled('tracing')).toBe(false);
    });
  });

  describe('resetEvolutionConfig', () => {
    it('should reset config to default values', () => {
      // Make some changes
      enableCapability('reflection');
      updateCapabilityConfig('experience', { maxFewShotExamples: 5 });

      // Reset
      resetEvolutionConfig();

      const config = getEvolutionConfig();
      expect(config.reflection.enabled).toBe(false);
      expect(config.experience.maxFewShotExamples).toBe(2);
    });
  });

  describe('validateConfig', () => {
    it('should validate correct config', () => {
      const result = validateConfig({
        reflection: {
          enabled: true,
          maxRetries: 3,
          timeoutMs: 5000,
        },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject negative maxRetries', () => {
      const result = validateConfig({
        reflection: {
          enabled: true,
          maxRetries: -1,
          timeoutMs: 5000,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('reflection.maxRetries must be non-negative');
    });

    it('should reject invalid minScoreForRetrieval', () => {
      const result = validateConfig({
        experience: {
          enabled: true,
          minScoreForRetrieval: 1.5,
          maxFewShotExamples: 2,
          autoApprove: false,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('experience.minScoreForRetrieval must be between 0 and 1');
    });

    it('should reject invalid qualityThreshold', () => {
      const result = validateConfig({
        planRevision: {
          enabled: true,
          qualityThreshold: 150,
          maxAdditionalSteps: 2,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('planRevision.qualityThreshold must be between 0 and 100');
    });

    it('should reject invalid predictionConfidenceThreshold', () => {
      const result = validateConfig({
        proactiveOps: {
          enabled: true,
          healthCheckIntervalSeconds: 60,
          predictionTimeWindowMinutes: 30,
          predictionConfidenceThreshold: -0.1,
          inspectionIntervalHours: 4,
          contextAwareChatEnabled: false,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('proactiveOps.predictionConfidenceThreshold must be between 0 and 1');
    });

    it('should reject invalid confidenceThreshold for intentDriven', () => {
      const result = validateConfig({
        intentDriven: {
          enabled: true,
          confidenceThreshold: 2.0,
          confirmationTimeoutMinutes: 5,
          riskLevelForConfirmation: 'L3',
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('intentDriven.confidenceThreshold must be between 0 and 1');
    });

    it('should reject invalid traceRetentionDays', () => {
      const result = validateConfig({
        tracing: {
          enabled: true,
          traceRetentionDays: 0,
          longTaskThresholdMinutes: 5,
          heartbeatIntervalSeconds: 30,
          enableOpenTelemetryExport: false,
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('tracing.traceRetentionDays must be at least 1');
    });
  });

  describe('getCapabilityStatusSummary', () => {
    it('should return status of all capabilities', () => {
      const summary = getCapabilityStatusSummary();
      
      expect(summary).toEqual({
        reflection: false,
        experience: false,
        planRevision: false,
        toolFeedback: false,
        proactiveOps: false,
        intentDriven: false,
        selfHealing: false,
        continuousLearning: false,
        tracing: true,
        autonomousBrain: false,
        mcpClient: false,
        mcpServer: false,
      });
    });

    it('should reflect changes after enabling capabilities', () => {
      enableCapability('reflection');
      enableCapability('selfHealing');
      
      const summary = getCapabilityStatusSummary();
      
      expect(summary.reflection).toBe(true);
      expect(summary.selfHealing).toBe(true);
      expect(summary.experience).toBe(false);
    });
  });

  describe('Type definitions', () => {
    it('should have correct RiskLevel type values', () => {
      const levels: RiskLevel[] = ['L1', 'L2', 'L3', 'L4'];
      expect(levels).toHaveLength(4);
    });

    it('should have correct AutoHealingLevel type values', () => {
      const levels: AutoHealingLevel[] = ['disabled', 'notify', 'low_risk', 'full'];
      expect(levels).toHaveLength(4);
    });
  });

  describe('Independent capability control', () => {
    /**
     * Validates: Requirements 10.2.1 - 所有新能力支持独立开关
     */
    it('should allow each capability to be enabled/disabled independently', () => {
      // Enable only reflection
      enableCapability('reflection');
      expect(isCapabilityEnabled('reflection')).toBe(true);
      expect(isCapabilityEnabled('experience')).toBe(false);
      expect(isCapabilityEnabled('selfHealing')).toBe(false);

      // Enable selfHealing without affecting reflection
      enableCapability('selfHealing');
      expect(isCapabilityEnabled('reflection')).toBe(true);
      expect(isCapabilityEnabled('selfHealing')).toBe(true);
      expect(isCapabilityEnabled('experience')).toBe(false);

      // Disable reflection without affecting selfHealing
      disableCapability('reflection');
      expect(isCapabilityEnabled('reflection')).toBe(false);
      expect(isCapabilityEnabled('selfHealing')).toBe(true);
    });
  });

  describe('File-based configuration', () => {
    const testConfigDir = path.join(process.cwd(), 'backend', 'data', 'ai-ops', 'test-config');
    const testConfigPath = path.join(testConfigDir, 'test-evolution-config.json');

    beforeEach(() => {
      resetEvolutionConfig();
      shutdownEvolutionConfig();
      // Clean up test directory
      if (fs.existsSync(testConfigDir)) {
        fs.rmSync(testConfigDir, { recursive: true });
      }
    });

    afterEach(() => {
      shutdownEvolutionConfig();
      // Clean up test directory
      if (fs.existsSync(testConfigDir)) {
        fs.rmSync(testConfigDir, { recursive: true });
      }
    });

    describe('loadConfigFromFile', () => {
      it('should return false when config file does not exist', () => {
        const result = loadConfigFromFile('/non/existent/path.json');
        expect(result).toBe(false);
      });

      it('should load config from JSON file', () => {
        // Create test config file
        fs.mkdirSync(testConfigDir, { recursive: true });
        const testConfig = {
          reflection: {
            enabled: true,
            maxRetries: 5,
            timeoutMs: 10000,
          },
        };
        fs.writeFileSync(testConfigPath, JSON.stringify(testConfig), 'utf-8');

        const result = loadConfigFromFile(testConfigPath);
        expect(result).toBe(true);

        const config = getEvolutionConfig();
        expect(config.reflection.enabled).toBe(true);
        expect(config.reflection.maxRetries).toBe(5);
        expect(config.reflection.timeoutMs).toBe(10000);
      });

      it('should ignore unknown capability keys from config file', () => {
        fs.mkdirSync(testConfigDir, { recursive: true });
        const testConfig = {
          reflection: {
            enabled: true,
            maxRetries: 4,
            timeoutMs: 9000,
          },
          loopDetection: {
            enabled: true,
          },
        };
        fs.writeFileSync(testConfigPath, JSON.stringify(testConfig), 'utf-8');

        const result = loadConfigFromFile(testConfigPath);
        expect(result).toBe(true);

        const config = getEvolutionConfig() as unknown as Record<string, unknown>;
        expect(config.reflection).toEqual(expect.objectContaining({ enabled: true, maxRetries: 4, timeoutMs: 9000 }));
        expect(config.loopDetection).toBeUndefined();
      });
      it('should reject invalid config file', () => {
        fs.mkdirSync(testConfigDir, { recursive: true });
        const invalidConfig = {
          reflection: {
            enabled: true,
            maxRetries: -1, // Invalid
            timeoutMs: 5000,
          },
        };
        fs.writeFileSync(testConfigPath, JSON.stringify(invalidConfig), 'utf-8');

        const result = loadConfigFromFile(testConfigPath);
        expect(result).toBe(false);
      });

      it('should handle malformed JSON gracefully', () => {
        fs.mkdirSync(testConfigDir, { recursive: true });
        fs.writeFileSync(testConfigPath, 'not valid json', 'utf-8');

        const result = loadConfigFromFile(testConfigPath);
        expect(result).toBe(false);
      });
    });

    describe('saveConfigToFile', () => {
      it('should save current config to JSON file', () => {
        enableCapability('reflection');
        updateCapabilityConfig('reflection', { maxRetries: 10 });

        const result = saveConfigToFile(testConfigPath);
        expect(result).toBe(true);

        // Verify file content
        const fileContent = fs.readFileSync(testConfigPath, 'utf-8');
        const savedConfig = JSON.parse(fileContent);
        expect(savedConfig.reflection.enabled).toBe(true);
        expect(savedConfig.reflection.maxRetries).toBe(10);
      });

      it('should create directory if it does not exist', () => {
        const nestedPath = path.join(testConfigDir, 'nested', 'config.json');
        
        const result = saveConfigToFile(nestedPath);
        expect(result).toBe(true);
        expect(fs.existsSync(nestedPath)).toBe(true);
      });
    });

    describe('addConfigChangeListener', () => {
      it('should notify listeners when config changes via loadConfigFromFile', () => {
        const listener = jest.fn();
        const unsubscribe = addConfigChangeListener(listener);

        // Create and load config file
        fs.mkdirSync(testConfigDir, { recursive: true });
        const testConfig = {
          reflection: {
            enabled: true,
            maxRetries: 3,
            timeoutMs: 5000,
          },
        };
        fs.writeFileSync(testConfigPath, JSON.stringify(testConfig), 'utf-8');
        loadConfigFromFile(testConfigPath);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({
            reflection: expect.objectContaining({ enabled: true }),
          }),
          expect.objectContaining({
            reflection: expect.objectContaining({ enabled: false }),
          })
        );

        unsubscribe();
      });

      it('should allow unsubscribing from config changes', () => {
        const listener = jest.fn();
        const unsubscribe = addConfigChangeListener(listener);
        unsubscribe();

        // Create and load config file
        fs.mkdirSync(testConfigDir, { recursive: true });
        const testConfig = { reflection: { enabled: true, maxRetries: 2, timeoutMs: 5000 } };
        fs.writeFileSync(testConfigPath, JSON.stringify(testConfig), 'utf-8');
        loadConfigFromFile(testConfigPath);

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe('initializeEvolutionConfig', () => {
      it('should initialize with default options', () => {
        const result = initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });

        expect(result).toBe(true);
        expect(isEvolutionConfigInitialized()).toBe(true);
      });

      it('should load config from file during initialization', () => {
        // Create config file first
        fs.mkdirSync(testConfigDir, { recursive: true });
        const testConfig = {
          reflection: {
            enabled: true,
            maxRetries: 7,
            timeoutMs: 5000,
          },
        };
        fs.writeFileSync(testConfigPath, JSON.stringify(testConfig), 'utf-8');

        initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });

        const config = getEvolutionConfig();
        expect(config.reflection.enabled).toBe(true);
        expect(config.reflection.maxRetries).toBe(7);
      });

      it('should not reinitialize if already initialized', () => {
        initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });

        enableCapability('reflection');

        // Try to reinitialize
        initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });

        // Config should still have reflection enabled
        expect(isCapabilityEnabled('reflection')).toBe(true);
      });
    });

    describe('shutdownEvolutionConfig', () => {
      it('should reset initialization state', () => {
        initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });
        expect(isEvolutionConfigInitialized()).toBe(true);

        shutdownEvolutionConfig();
        expect(isEvolutionConfigInitialized()).toBe(false);
      });

      it('should allow reinitialization after shutdown', () => {
        initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });
        shutdownEvolutionConfig();

        // Create config file
        fs.mkdirSync(testConfigDir, { recursive: true });
        const testConfig = {
          experience: {
            enabled: true,
            minScoreForRetrieval: 0.8,
            maxFewShotExamples: 3,
            autoApprove: true,
          },
        };
        fs.writeFileSync(testConfigPath, JSON.stringify(testConfig), 'utf-8');

        initializeEvolutionConfig({
          configFilePath: testConfigPath,
          enableFileWatcher: false,
          loadFromEnv: false,
        });

        const config = getEvolutionConfig();
        expect(config.experience.enabled).toBe(true);
        expect(config.experience.maxFewShotExamples).toBe(3);
      });
    });

    describe('getConfigFilePath', () => {
      it('should return the default config file path', () => {
        const configPath = getConfigFilePath();
        expect(configPath).toContain('evolution-config.json');
        expect(configPath).toContain('ai-ops');
      });
    });

    describe('File watcher', () => {
      it('should start and stop file watcher without errors', () => {
        fs.mkdirSync(testConfigDir, { recursive: true });
        
        expect(() => startConfigFileWatcher(testConfigPath)).not.toThrow();
        expect(() => stopConfigFileWatcher()).not.toThrow();
      });
    });
  });

  /**
   * Validates: Requirements 10.2.3 - 配置变更无需重启服务
   */
  describe('Hot reload capability', () => {
    const testConfigDir = path.join(process.cwd(), 'backend', 'data', 'ai-ops', 'hot-reload-test');
    const testConfigPath = path.join(testConfigDir, 'hot-reload-config.json');

    beforeEach(() => {
      resetEvolutionConfig();
      shutdownEvolutionConfig();
      if (fs.existsSync(testConfigDir)) {
        fs.rmSync(testConfigDir, { recursive: true });
      }
    });

    afterEach(() => {
      shutdownEvolutionConfig();
      if (fs.existsSync(testConfigDir)) {
        fs.rmSync(testConfigDir, { recursive: true });
      }
    });

    it('should support runtime config updates without restart', () => {
      // Initial config
      const initialConfig = getEvolutionConfig();
      expect(initialConfig.reflection.enabled).toBe(false);

      // Update config at runtime
      updateEvolutionConfig({
        reflection: {
          enabled: true,
          maxRetries: 5,
          timeoutMs: 8000,
        },
      });

      // Verify changes took effect immediately
      const updatedConfig = getEvolutionConfig();
      expect(updatedConfig.reflection.enabled).toBe(true);
      expect(updatedConfig.reflection.maxRetries).toBe(5);
      expect(updatedConfig.reflection.timeoutMs).toBe(8000);
    });

    it('should support loading new config from file at runtime', () => {
      // Create initial config
      fs.mkdirSync(testConfigDir, { recursive: true });
      const config1 = {
        selfHealing: {
          enabled: false,
          autoHealingLevel: 'notify',
          faultDetectionIntervalSeconds: 30,
          rootCauseAnalysisTimeoutSeconds: 60,
        },
      };
      fs.writeFileSync(testConfigPath, JSON.stringify(config1), 'utf-8');
      loadConfigFromFile(testConfigPath);

      expect(getEvolutionConfig().selfHealing.enabled).toBe(false);

      // Update config file and reload
      const config2 = {
        selfHealing: {
          enabled: true,
          autoHealingLevel: 'low_risk',
          faultDetectionIntervalSeconds: 15,
          rootCauseAnalysisTimeoutSeconds: 45,
        },
      };
      fs.writeFileSync(testConfigPath, JSON.stringify(config2), 'utf-8');
      loadConfigFromFile(testConfigPath);

      // Verify new config is loaded
      const newConfig = getEvolutionConfig();
      expect(newConfig.selfHealing.enabled).toBe(true);
      expect(newConfig.selfHealing.autoHealingLevel).toBe('low_risk');
      expect(newConfig.selfHealing.faultDetectionIntervalSeconds).toBe(15);
    });
  });
});
