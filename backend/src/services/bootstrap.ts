/**
 * Bootstrap 服务初始化入口
 * 按依赖顺序注册所有服务到 ServiceRegistry
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 * - 11.1: 将服务分为核心服务和延迟加载服务
 * - 11.2: 核心服务优先初始化，延迟加载服务在首次使用时按需初始化
 * - 11.3: 启动完成后输出启动耗时和已加载服务列表的日志
 * - 11.4: 保持现有的优雅关闭机制，确保所有已初始化的服务正确清理资源
 *
 * 服务依赖层级（2 层架构）：
 *
 * 核心层（Core Layer）：启动时立即初始化
 *   - ConfigService：配置服务
 *   - DeviceClient：设备客户端（依赖 ConfigService）
 *   - EvolutionConfig：智能进化配置服务
 *   注：DataStore、AuthService、DeviceManager、DevicePool 在 index.ts 的 registerAuthRoutes() 中初始化
 *
 * 业务层（Business Layer）：延迟初始化，首次访问时按需加载
 *   - FingerprintCache、AdapterPool、AuditLogger、NotificationService
 *   - VectorDatabase (VectorStoreClient)、EmbeddingService
 *   - MetricsCollector、AlertEngine、KnowledgeBase、Scheduler
 *   - AIAnalyzer、RAGEngine、DecisionEngine、RootCauseAnalyzer、RemediationAdvisor
 *   - AlertPipeline、UnifiedAgentService、HealthReportService
 *   - SyslogReceiver、ConfigSnapshotService、FaultHealer、BatchProcessor
 *   - AnalysisCache、NoiseFilter、AlertPreprocessor、FeedbackService
 *   - HealthMonitor、MastraAgent
 */

import { serviceRegistry, ServiceConfig } from './serviceRegistry';
import { logger } from '../utils/logger';

// ==================== 服务名称常量 ====================

export const SERVICE_NAMES = {
  // ---- 核心层服务（启动时立即初始化） ----
  CONFIG_SERVICE: 'configService',
  EVOLUTION_CONFIG: 'evolutionConfig',

  // ---- 核心基础设施（在 index.ts registerAuthRoutes 中初始化） ----
  DATA_STORE: 'dataStore',
  PG_DATA_STORE: 'pgDataStore',
  AUTH_SERVICE: 'authService',
  DEVICE_MANAGER: 'deviceManager',
  DEVICE_POOL: 'devicePool',

  // ---- 业务层服务（延迟初始化，首次访问时加载） ----
  FINGERPRINT_CACHE: 'fingerprintCache',
  ADAPTER_POOL: 'adapterPool',
  AUDIT_LOGGER: 'auditLogger',
  NOTIFICATION_SERVICE: 'notificationService',
  VECTOR_DATABASE: 'vectorDatabase',
  EMBEDDING_SERVICE: 'embeddingService',
  METRICS_COLLECTOR: 'metricsCollector',
  ALERT_ENGINE: 'alertEngine',
  KNOWLEDGE_BASE: 'knowledgeBase',
  SCHEDULER: 'scheduler',
  AI_ANALYZER: 'aiAnalyzer',
  RAG_ENGINE: 'ragEngine',
  DECISION_ENGINE: 'decisionEngine',
  ROOT_CAUSE_ANALYZER: 'rootCauseAnalyzer',
  REMEDIATION_ADVISOR: 'remediationAdvisor',
  ALERT_PIPELINE: 'alertPipeline',
  UNIFIED_AGENT_SERVICE: 'unifiedAgentService',
  HEALTH_REPORT_SERVICE: 'healthReportService',
  SYSLOG_RECEIVER: 'syslogReceiver',
  SYSLOG_MANAGER: 'syslogManager',
  CONFIG_SNAPSHOT_SERVICE: 'configSnapshotService',
  FAULT_HEALER: 'faultHealer',
  BATCH_PROCESSOR: 'batchProcessor',
  ANALYSIS_CACHE: 'analysisCache',
  NOISE_FILTER: 'noiseFilter',
  ALERT_PREPROCESSOR: 'alertPreprocessor',
  FEEDBACK_SERVICE: 'feedbackService',
  MASTRA_AGENT: 'mastraAgent',
  HEALTH_MONITOR: 'healthMonitor',
  BRAIN_LOOP_ENGINE: 'brainLoopEngine',
  SNMP_TRAP_RECEIVER: 'snmpTrapReceiver',
} as const;

// ==================== 服务注册函数 ====================

/**
 * 注册核心层服务
 * 这些服务在启动时立即初始化，是系统运行的基础
 * Requirements: 11.1 - 核心服务优先初始化
 */
function registerCoreServices(): void {
  // ConfigService - 配置服务
  serviceRegistry.register({
    name: SERVICE_NAMES.CONFIG_SERVICE,
    dependencies: [],
    factory: async () => {
      const { configService } = await import('./configService');
      return configService;
    },
  });

  // EvolutionConfig - 智能进化配置服务
  serviceRegistry.register({
    name: SERVICE_NAMES.EVOLUTION_CONFIG,
    dependencies: [],
    factory: async () => {
      const { initializeEvolutionConfig, addConfigChangeListener, getEvolutionConfig } = await import('./ai-ops/evolutionConfig');
      initializeEvolutionConfig();


      // 注册配置变更监听器，实现配置热更新
      addConfigChangeListener(async (newConfig, oldConfig) => {
        logger.info('Evolution config changed, applying updates...');

        // 处理主动运维配置变更
        if (newConfig.proactiveOps.enabled !== oldConfig.proactiveOps.enabled) {
          try {
            const { healthMonitor } = await import('./ai-ops/healthMonitor');
            if (newConfig.proactiveOps.enabled) {
              logger.info('Enabling proactive ops - starting health monitor auto-collect');
              healthMonitor.startAutoCollect();
            } else {
              logger.info('Disabling proactive ops - stopping health monitor auto-collect');
              healthMonitor.stopAutoCollect();
            }
          } catch (error) {
            logger.warn('Failed to update health monitor:', error);
          }
        }

        // 处理自愈配置变更 (Requirements: 4.5)
        try {
          const shEnabledChanged = newConfig.selfHealing.enabled !== oldConfig.selfHealing.enabled;
          const shIntervalChanged = newConfig.selfHealing.faultDetectionIntervalSeconds !== oldConfig.selfHealing.faultDetectionIntervalSeconds;

          if (shEnabledChanged || shIntervalChanged) {
            const { faultHealer } = await import('./ai-ops/faultHealer');
            if (newConfig.selfHealing.enabled) {
              faultHealer.startPeriodicDetection(newConfig.selfHealing.faultDetectionIntervalSeconds);
              logger.info(
                `Self-healing enabled - periodic detection started ` +
                `(interval: ${newConfig.selfHealing.faultDetectionIntervalSeconds}s, ` +
                `autoHealingLevel: ${newConfig.selfHealing.autoHealingLevel})`
              );
            } else {
              faultHealer.stopPeriodicDetection();
              logger.info('Self-healing disabled - periodic detection stopped');
            }
          }
        } catch (error) {
          logger.warn('Failed to update self-healing config:', error);
        }

        // 处理追踪配置变更
        if (newConfig.tracing.enabled !== oldConfig.tracing.enabled) {
          try {
            const { tracingService } = await import('./ai-ops/tracingService');
            tracingService.updateConfig({ enabled: newConfig.tracing.enabled });
            logger.info(`Tracing service ${newConfig.tracing.enabled ? 'enabled' : 'disabled'}`);
          } catch (error) {
            logger.warn('Failed to update tracing service:', error);
          }
        }

        // 处理反思配置变更
        if (newConfig.reflection.enabled !== oldConfig.reflection.enabled) {
          logger.info(`Reflection capability ${newConfig.reflection.enabled ? 'enabled' : 'disabled'}`);
        }

        // 处理经验管理配置变更
        if (newConfig.experience.enabled !== oldConfig.experience.enabled) {
          logger.info(
            `Experience management ${newConfig.experience.enabled ? 'enabled' : 'disabled'} ` +
            `(minScoreForRetrieval=${newConfig.experience.minScoreForRetrieval}, ` +
            `maxFewShotExamples=${newConfig.experience.maxFewShotExamples}, ` +
            `autoApprove=${newConfig.experience.autoApprove})`
          );
        } else if (newConfig.experience.enabled) {
          const paramChanges: string[] = [];
          if (newConfig.experience.minScoreForRetrieval !== oldConfig.experience.minScoreForRetrieval) {
            paramChanges.push(`minScoreForRetrieval: ${oldConfig.experience.minScoreForRetrieval} → ${newConfig.experience.minScoreForRetrieval}`);
          }
          if (newConfig.experience.maxFewShotExamples !== oldConfig.experience.maxFewShotExamples) {
            paramChanges.push(`maxFewShotExamples: ${oldConfig.experience.maxFewShotExamples} → ${newConfig.experience.maxFewShotExamples}`);
          }
          if (newConfig.experience.autoApprove !== oldConfig.experience.autoApprove) {
            paramChanges.push(`autoApprove: ${oldConfig.experience.autoApprove} → ${newConfig.experience.autoApprove}`);
          }
          if (paramChanges.length > 0) {
            logger.info(`Experience management config updated: ${paramChanges.join(', ')}`);
          }
        }

        // 处理工具反馈配置变更 (Requirements: 2.5)
        try {
          if (newConfig.toolFeedback.enabled !== oldConfig.toolFeedback.enabled) {
            const { toolFeedbackCollector } = await import('./ai-ops/toolFeedbackCollector');
            if (newConfig.toolFeedback.enabled) {
              toolFeedbackCollector.startCleanupTimer(newConfig.toolFeedback.metricsRetentionDays);
              logger.info(`Tool feedback enabled (retention: ${newConfig.toolFeedback.metricsRetentionDays} days)`);
            } else {
              toolFeedbackCollector.stopCleanupTimer();
              logger.info('Tool feedback disabled - cleanup timer stopped');
            }
          } else if (newConfig.toolFeedback.enabled &&
            newConfig.toolFeedback.metricsRetentionDays !== oldConfig.toolFeedback.metricsRetentionDays) {
            const { toolFeedbackCollector } = await import('./ai-ops/toolFeedbackCollector');
            toolFeedbackCollector.startCleanupTimer(newConfig.toolFeedback.metricsRetentionDays);
            logger.info(`Tool feedback retention updated: ${oldConfig.toolFeedback.metricsRetentionDays} → ${newConfig.toolFeedback.metricsRetentionDays} days`);
          }
        } catch (error) {
          logger.warn('Failed to update tool feedback collector:', error);
        }

        // 处理计划修订配置变更 (Requirements: 3.4)
        try {
          const prChanged = newConfig.planRevision.enabled !== oldConfig.planRevision.enabled ||
            newConfig.planRevision.qualityThreshold !== oldConfig.planRevision.qualityThreshold ||
            newConfig.planRevision.maxAdditionalSteps !== oldConfig.planRevision.maxAdditionalSteps;

          if (prChanged) {
            const { executionPlanner } = await import('./ai-ops/rag/executionPlanner');
            executionPlanner.updateRevisionTriggerConfig({
              qualityScoreThreshold: newConfig.planRevision.qualityThreshold,
              maxRevisions: newConfig.planRevision.maxAdditionalSteps,
            });

            const changes: string[] = [];
            if (newConfig.planRevision.enabled !== oldConfig.planRevision.enabled) {
              changes.push(`enabled: ${newConfig.planRevision.enabled}`);
            }
            if (newConfig.planRevision.qualityThreshold !== oldConfig.planRevision.qualityThreshold) {
              changes.push(`qualityThreshold: ${newConfig.planRevision.qualityThreshold} → ${oldConfig.planRevision.qualityThreshold}`);
            }
            if (newConfig.planRevision.maxAdditionalSteps !== oldConfig.planRevision.maxAdditionalSteps) {
              changes.push(`maxAdditionalSteps: ${newConfig.planRevision.maxAdditionalSteps} → ${oldConfig.planRevision.maxAdditionalSteps}`);
            }
            logger.info(`Plan revision config updated: ${changes.join(', ')}`);
          }
        } catch (error) {
          logger.warn('Failed to update plan revision config:', error);
        }

        // 处理持续学习配置变更 (Requirements: 5.7)
        try {
          const clEnabledChanged = newConfig.continuousLearning.enabled !== oldConfig.continuousLearning.enabled;

          if (clEnabledChanged) {
            const { continuousLearner } = await import('./ai-ops/continuousLearner');
            if (newConfig.continuousLearning.enabled) {
              continuousLearner.start(newConfig.continuousLearning);
              logger.info('Continuous learning enabled - all timers started');
            } else {
              continuousLearner.stop();
              logger.info('Continuous learning disabled - all timers stopped');
            }
          } else if (newConfig.continuousLearning.enabled) {
            const { continuousLearner } = await import('./ai-ops/continuousLearner');
            continuousLearner.updateConfig(newConfig.continuousLearning);
            logger.info('Continuous learning config updated');
          }
        } catch (error) {
          logger.warn('Failed to update continuous learning config:', error);
        }

        // 处理意图驱动配置变更 (Requirements: 6.5)
        try {
          const idChanged = newConfig.intentDriven.enabled !== oldConfig.intentDriven.enabled ||
            newConfig.intentDriven.confidenceThreshold !== oldConfig.intentDriven.confidenceThreshold ||
            newConfig.intentDriven.riskLevelForConfirmation !== oldConfig.intentDriven.riskLevelForConfirmation;

          if (idChanged) {
            const { intentParser } = await import('./ai-ops/intentParser');
            intentParser.updateConfig({
              enabled: newConfig.intentDriven.enabled,
              minConfidenceThreshold: newConfig.intentDriven.confidenceThreshold,
            });

            const changes: string[] = [];
            if (newConfig.intentDriven.enabled !== oldConfig.intentDriven.enabled) {
              changes.push(`enabled: ${newConfig.intentDriven.enabled}`);
            }
            if (newConfig.intentDriven.confidenceThreshold !== oldConfig.intentDriven.confidenceThreshold) {
              changes.push(`confidenceThreshold: ${newConfig.intentDriven.confidenceThreshold} → ${oldConfig.intentDriven.confidenceThreshold}`);
            }
            if (newConfig.intentDriven.riskLevelForConfirmation !== oldConfig.intentDriven.riskLevelForConfirmation) {
              changes.push(`riskLevelForConfirmation: ${oldConfig.intentDriven.riskLevelForConfirmation} → ${newConfig.intentDriven.riskLevelForConfirmation}`);
            }
            logger.info(`Intent-driven config updated: ${changes.join(', ')}`);
          }
        } catch (error) {
          logger.warn('Failed to update intent-driven config:', error);
        }

        logger.info('EvolutionConfig updates applied');
      });

      logger.info('EvolutionConfig initialized with change listeners');
      return { initialized: true };
    },
  });

  // DataStore - 数据存储服务（PostgreSQL）
  // Requirements: C1.2 - 移除 SQLite 回退，PgDataStore 为唯一数据存储
  serviceRegistry.register({
    name: SERVICE_NAMES.DATA_STORE,
    dependencies: [],
    factory: async () => {
      const { PgDataStore } = await import('./pgDataStore');
      const pgDataStore = new PgDataStore();
      const healthy = await pgDataStore.healthCheck();
      if (!healthy) {
        logger.error('PgDataStore health check failed — PostgreSQL is required');
      }
      logger.info('DATA_STORE using PgDataStore (PostgreSQL)');
      return pgDataStore;
    },
  });

  // PgDataStore - PostgreSQL 数据存储服务
  serviceRegistry.register({
    name: SERVICE_NAMES.PG_DATA_STORE,
    dependencies: [],
    factory: async () => {
      const { PgDataStore } = await import('./pgDataStore');
      const pgDataStore = new PgDataStore();
      const healthy = await pgDataStore.healthCheck();
      if (!healthy) {
        logger.warn('PgDataStore health check failed, PostgreSQL may be unavailable');
      }

      // 运行 PostgreSQL Schema 迁移
      try {
        const { runPgMigrations } = await import('../migrations/pg/pgMigrationRunner');
        const migrationResult = await runPgMigrations(pgDataStore);
        logger.info('PostgreSQL migrations completed', migrationResult);
      } catch (error) {
        logger.error('PostgreSQL migration failed:', error);
      }

      // 注入到 DegradationManager 并恢复持久化状态
      const { degradationManager } = await import('./ai-ops/degradationManager');
      degradationManager.setPgDataStore(pgDataStore);
      await degradationManager.restoreFromPostgres();

      // 注入到 TracingService
      const { tracingService } = await import('./ai-ops/tracingService');
      tracingService.setPgDataStore(pgDataStore);

      // 注入到 AuditLogger
      const { auditLogger } = await import('./ai-ops/auditLogger');
      auditLogger.setPgDataStore(pgDataStore);

      // 注入到 ConfigService
      const { configService } = await import('./configService');
      configService.setPgDataStore(pgDataStore);

      // Python Core 健康检查（不可达时降级 AI 增强功能）(PC.3)
      try {
        const { VectorStoreClient } = await import('./ai-ops/rag/vectorStoreClient');
        const { DegradationReason } = await import('./ai-ops/degradationManager');
        const vectorClient = new VectorStoreClient();
        const pythonCoreHealthy = await vectorClient.healthCheck();
        if (!pythonCoreHealthy) {
          logger.warn('Python Core health check failed, degrading AI capabilities');
          degradationManager.degrade('vectorOperations', DegradationReason.DEPENDENCY, 'Python Core unreachable');
          degradationManager.degrade('experience', DegradationReason.DEPENDENCY, 'Python Core unreachable');
          degradationManager.degrade('continuousLearning', DegradationReason.DEPENDENCY, 'Python Core unreachable');
        } else {
          logger.info('Python Core health check passed');
        }

        // 启动周期性 Python Core 健康监测（每 30 秒检查一次）(PC.3)
        const PYTHON_CORE_HEALTH_INTERVAL = 30_000;
        const pythonCoreHealthTimer = setInterval(async () => {
          try {
            const healthy = await vectorClient.healthCheck();
            if (healthy && !degradationManager.isAvailable('vectorOperations')) {
              // Python Core 恢复 → 恢复所有相关能力
              logger.info('Python Core recovered, restoring AI capabilities');
              degradationManager.recover('vectorOperations');
              degradationManager.recover('experience');
              degradationManager.recover('continuousLearning');
            } else if (!healthy && degradationManager.isAvailable('vectorOperations')) {
              // Python Core 不可达 → 降级所有相关能力
              logger.warn('Python Core health check failed, degrading AI capabilities');
              degradationManager.degrade('vectorOperations', DegradationReason.DEPENDENCY, 'Python Core unreachable');
              degradationManager.degrade('experience', DegradationReason.DEPENDENCY, 'Python Core unreachable');
              degradationManager.degrade('continuousLearning', DegradationReason.DEPENDENCY, 'Python Core unreachable');
            }
          } catch (err) {
            logger.debug('Python Core periodic health check error:', err);
          }
        }, PYTHON_CORE_HEALTH_INTERVAL);

        // 确保定时器不阻止进程退出
        if (pythonCoreHealthTimer.unref) {
          pythonCoreHealthTimer.unref();
        }
      } catch (error) {
        logger.warn('Python Core health check failed:', error);
      }

      logger.info('PgDataStore initialized successfully');
      return pgDataStore;
    },
  });

  // AuthService - 认证服务
  serviceRegistry.register({
    name: SERVICE_NAMES.AUTH_SERVICE,
    dependencies: [SERVICE_NAMES.DATA_STORE, SERVICE_NAMES.PG_DATA_STORE],
    factory: async () => {
      const { AuthService } = await import('./auth/authService');
      const dataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.DATA_STORE);
      const authService = new AuthService(dataStore);

      // 注入 PgDataStore
      try {
        const pgDataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
        authService.setPgDataStore(pgDataStore);
      } catch {
        logger.debug('PgDataStore not available for AuthService');
      }

      return authService;
    },
  });

  // DeviceManager - 设备管理服务
  serviceRegistry.register({
    name: SERVICE_NAMES.DEVICE_MANAGER,
    dependencies: [SERVICE_NAMES.DATA_STORE],
    factory: async () => {
      const { DeviceManager } = await import('./device/deviceManager');
      const dataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.DATA_STORE);
      // ConfigService needs DataStore to be set
      const { configService } = await import('./configService');
      configService.setDataStore(dataStore);

      const deviceManager = new DeviceManager(dataStore);

      // Update configService with decryption function
      configService.setDecryptFunction((text) => deviceManager.decryptPassword(text));

      return deviceManager;
    },
  });

  // DevicePool - 设备连接池服务
  serviceRegistry.register({
    name: SERVICE_NAMES.DEVICE_POOL,
    dependencies: [SERVICE_NAMES.DEVICE_MANAGER],
    factory: async () => {
      const { DevicePool } = await import('./device/devicePool');
      const deviceManager = await serviceRegistry.getAsync<any>(SERVICE_NAMES.DEVICE_MANAGER);
      return new DevicePool(deviceManager);
    },
  });

  logger.debug('Core layer services registered');
}

/**
 * 注册业务层服务
 * 这些服务使用延迟初始化，在首次访问时按需加载
 * Requirements: 11.1, 11.2 - 延迟加载服务在首次使用时按需初始化
 */
function registerBusinessServices(): void {
  // ---- 基础业务服务（无依赖或少依赖） ----

  // FingerprintCache - 指纹缓存服务
  serviceRegistry.register({
    name: SERVICE_NAMES.FINGERPRINT_CACHE,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { fingerprintCache } = await import('./ai-ops/fingerprintCache');
      return fingerprintCache;
    },
  });

  // AdapterPool - AI 适配器缓存池
  serviceRegistry.register({
    name: SERVICE_NAMES.ADAPTER_POOL,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { getAdapterPool } = await import('./ai/adapterPool');
      return getAdapterPool();
    },
  });

  // AuditLogger - 审计日志服务
  serviceRegistry.register({
    name: SERVICE_NAMES.AUDIT_LOGGER,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { auditLogger } = await import('./ai-ops/auditLogger');
      await auditLogger.initialize();
      return auditLogger;
    },
  });

  // NotificationService - 通知服务
  serviceRegistry.register({
    name: SERVICE_NAMES.NOTIFICATION_SERVICE,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { notificationService } = await import('./ai-ops/notificationService');
      return notificationService;
    },
  });

  // VectorDatabase - 向量数据库服务（Python Core）
  // Requirements: C1.2 - 移除 SQLiteVectorStore 回退，VectorStoreClient 为唯一向量存储
  serviceRegistry.register({
    name: SERVICE_NAMES.VECTOR_DATABASE,
    dependencies: [],
    lazy: true,
    factory: async () => {
      try {
        const { VectorStoreClient } = await import('./ai-ops/rag/vectorStoreClient');
        const vectorClient = new VectorStoreClient();
        const healthy = await vectorClient.healthCheck();
        if (healthy) {
          logger.info('VECTOR_DATABASE using VectorStoreClient (Python Core)');
          return vectorClient;
        }
        logger.warn('VectorStoreClient health check failed, Python Core may be unavailable');
        return vectorClient; // 返回实例，由降级管理器处理不可用状态
      } catch (error) {
        logger.error('VectorStoreClient initialization failed:', error);
        // 返回一个空壳实例，避免服务注册失败
        const { VectorStoreClient } = await import('./ai-ops/rag/vectorStoreClient');
        return new VectorStoreClient();
      }
    },
  });

  // EmbeddingService - 文本嵌入服务
  serviceRegistry.register({
    name: SERVICE_NAMES.EMBEDDING_SERVICE,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { embeddingService } = await import('./ai-ops/rag/embeddingService');
      try {
        await embeddingService.initialize();
        logger.info('EmbeddingService initialized successfully');
      } catch (error) {
        logger.warn('EmbeddingService initialization skipped:', (error as Error).message);
      }
      return embeddingService;
    },
  });

  // ---- 核心业务服务（依赖基础业务服务） ----

  // MetricsCollector - 指标采集服务
  serviceRegistry.register({
    name: SERVICE_NAMES.METRICS_COLLECTOR,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { metricsCollector } = await import('./ai-ops/metricsCollector');
      return metricsCollector;
    },
  });

  // AlertEngine - 告警引擎
  serviceRegistry.register({
    name: SERVICE_NAMES.ALERT_ENGINE,
    dependencies: [
      SERVICE_NAMES.FINGERPRINT_CACHE,
      SERVICE_NAMES.NOTIFICATION_SERVICE,
      SERVICE_NAMES.AUDIT_LOGGER,
    ],
    lazy: true,
    factory: async () => {
      const { alertEngine } = await import('./ai-ops/alertEngine');
      await alertEngine.initialize();
      return alertEngine;
    },
  });

  // KnowledgeBase - 知识库服务
  serviceRegistry.register({
    name: SERVICE_NAMES.KNOWLEDGE_BASE,
    dependencies: [
      SERVICE_NAMES.VECTOR_DATABASE,
      SERVICE_NAMES.EMBEDDING_SERVICE,
    ],
    lazy: true,
    factory: async () => {
      const { knowledgeBase } = await import('./ai-ops/rag/knowledgeBase');
      await knowledgeBase.initialize();
      return knowledgeBase;
    },
  });

  // Scheduler - 调度器服务
  serviceRegistry.register({
    name: SERVICE_NAMES.SCHEDULER,
    dependencies: [SERVICE_NAMES.AUDIT_LOGGER],
    lazy: true,
    factory: async () => {
      const { scheduler } = await import('./ai-ops/scheduler');
      return scheduler;
    },
  });

  // SyslogReceiver - Syslog 接收服务
  serviceRegistry.register({
    name: SERVICE_NAMES.SYSLOG_RECEIVER,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { syslogReceiver } = await import('./ai-ops/syslogReceiver');
      await syslogReceiver.initialize();
      return syslogReceiver;
    },
  });

  // SnmpTrapReceiver - SNMP Trap 接收服务
  serviceRegistry.register({
    name: SERVICE_NAMES.SNMP_TRAP_RECEIVER,
    dependencies: [SERVICE_NAMES.PG_DATA_STORE],
    lazy: true,
    factory: async () => {
      const { SnmpTrapReceiver } = await import('./snmp/snmpTrapReceiver');
      const { globalEventBus } = await import('./eventBus');
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      return new SnmpTrapReceiver(pgDs, globalEventBus);
    },
  });

  // ConfigSnapshotService - 配置快照服务
  serviceRegistry.register({
    name: SERVICE_NAMES.CONFIG_SNAPSHOT_SERVICE,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { configSnapshotService } = await import('./ai-ops/configSnapshotService');
      return configSnapshotService;
    },
  });

  // BatchProcessor - 批处理服务
  serviceRegistry.register({
    name: SERVICE_NAMES.BATCH_PROCESSOR,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { batchProcessor } = await import('./ai-ops/batchProcessor');
      return batchProcessor;
    },
  });

  // AnalysisCache - 分析缓存服务
  serviceRegistry.register({
    name: SERVICE_NAMES.ANALYSIS_CACHE,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { analysisCache } = await import('./ai-ops/analysisCache');
      return analysisCache;
    },
  });

  // NoiseFilter - 噪声过滤服务
  serviceRegistry.register({
    name: SERVICE_NAMES.NOISE_FILTER,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { noiseFilter } = await import('./ai-ops/noiseFilter');
      return noiseFilter;
    },
  });

  // AlertPreprocessor - 告警预处理服务
  serviceRegistry.register({
    name: SERVICE_NAMES.ALERT_PREPROCESSOR,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { alertPreprocessor } = await import('./ai-ops/alertPreprocessor');
      return alertPreprocessor;
    },
  });

  // HealthMonitor - 健康监控服务
  serviceRegistry.register({
    name: SERVICE_NAMES.HEALTH_MONITOR,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { healthMonitor } = await import('./ai-ops/healthMonitor');
      await healthMonitor.initialize();
      logger.info('HealthMonitor initialized with auto-collect');
      return healthMonitor;
    },
  });

  // ---- 增强业务服务（依赖核心业务服务） ----

  // AIAnalyzer - AI 分析服务
  serviceRegistry.register({
    name: SERVICE_NAMES.AI_ANALYZER,
    dependencies: [SERVICE_NAMES.ADAPTER_POOL],
    lazy: true,
    factory: async () => {
      const { aiAnalyzer } = await import('./ai-ops/aiAnalyzer');
      return aiAnalyzer;
    },
  });

  // RAGEngine - RAG 引擎服务
  serviceRegistry.register({
    name: SERVICE_NAMES.RAG_ENGINE,
    dependencies: [
      SERVICE_NAMES.KNOWLEDGE_BASE,
      SERVICE_NAMES.AI_ANALYZER,
    ],
    lazy: true,
    factory: async () => {
      const { ragEngine } = await import('./ai-ops/rag/ragEngine');
      await ragEngine.initialize();
      return ragEngine;
    },
  });

  // DecisionEngine - 决策引擎
  serviceRegistry.register({
    name: SERVICE_NAMES.DECISION_ENGINE,
    dependencies: [
      SERVICE_NAMES.NOTIFICATION_SERVICE,
      SERVICE_NAMES.AUDIT_LOGGER,
    ],
    lazy: true,
    factory: async () => {
      const { decisionEngine } = await import('./ai-ops/decisionEngine');
      return decisionEngine;
    },
  });

  // RootCauseAnalyzer - 根因分析服务
  serviceRegistry.register({
    name: SERVICE_NAMES.ROOT_CAUSE_ANALYZER,
    dependencies: [SERVICE_NAMES.AI_ANALYZER],
    lazy: true,
    factory: async () => {
      const { rootCauseAnalyzer } = await import('./ai-ops/rootCauseAnalyzer');
      return rootCauseAnalyzer;
    },
  });

  // RemediationAdvisor - 修复方案服务
  serviceRegistry.register({
    name: SERVICE_NAMES.REMEDIATION_ADVISOR,
    dependencies: [SERVICE_NAMES.AI_ANALYZER],
    lazy: true,
    factory: async () => {
      const { remediationAdvisor } = await import('./ai-ops/remediationAdvisor');
      return remediationAdvisor;
    },
  });

  // FaultHealer - 故障自愈服务
  serviceRegistry.register({
    name: SERVICE_NAMES.FAULT_HEALER,
    dependencies: [],
    lazy: true,
    factory: async () => {
      const { faultHealer } = await import('./ai-ops/faultHealer');
      return faultHealer;
    },
  });

  // FeedbackService - 反馈服务
  serviceRegistry.register({
    name: SERVICE_NAMES.FEEDBACK_SERVICE,
    dependencies: [SERVICE_NAMES.KNOWLEDGE_BASE],
    lazy: true,
    factory: async () => {
      const { feedbackService } = await import('./ai-ops/feedbackService');
      return feedbackService;
    },
  });

  // MastraAgent - Mastra Agent 服务
  serviceRegistry.register({
    name: SERVICE_NAMES.MASTRA_AGENT,
    dependencies: [SERVICE_NAMES.KNOWLEDGE_BASE],
    lazy: true,
    factory: async () => {
      const { mastraAgent } = await import('./ai-ops/rag/mastraAgent');
      return mastraAgent;
    },
  });

  // ---- 编排服务（依赖增强业务服务） ----

  // AlertPipeline - 告警处理流水线
  serviceRegistry.register({
    name: SERVICE_NAMES.ALERT_PIPELINE,
    dependencies: [
      SERVICE_NAMES.FINGERPRINT_CACHE,
      SERVICE_NAMES.DECISION_ENGINE,
      SERVICE_NAMES.ROOT_CAUSE_ANALYZER,
      SERVICE_NAMES.ALERT_PREPROCESSOR,
      SERVICE_NAMES.NOISE_FILTER,
    ],
    lazy: true,
    factory: async () => {
      const { alertPipeline } = await import('./ai-ops/alertPipeline');
      // G1.4: 注入 PgDataStore 启用 PostgreSQL 指纹缓存持久化
      try {
        const pgDataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
        alertPipeline.setPgDataStore(pgDataStore);
      } catch {
        logger.warn('PgDataStore not available for AlertPipeline, using in-memory fingerprint cache');
      }
      // G3.10, H3.11: 注入 EventBus 用于决策执行失败事件发布
      try {
        const { globalEventBus } = await import('./eventBus');
        alertPipeline.setEventBus(globalEventBus);
      } catch {
        logger.warn('EventBus not available for AlertPipeline decision execution dispatcher');
      }
      return alertPipeline;
    },
  });

  // UnifiedAgentService - 统一 AI Agent 服务
  serviceRegistry.register({
    name: SERVICE_NAMES.UNIFIED_AGENT_SERVICE,
    dependencies: [SERVICE_NAMES.RAG_ENGINE],
    lazy: true,
    factory: async () => {
      const { unifiedAgentService } = await import('./ai/unifiedAgentService');
      return unifiedAgentService;
    },
  });

  // HealthReportService - 健康报告服务
  serviceRegistry.register({
    name: SERVICE_NAMES.HEALTH_REPORT_SERVICE,
    dependencies: [
      SERVICE_NAMES.METRICS_COLLECTOR,
      SERVICE_NAMES.ALERT_ENGINE,
      SERVICE_NAMES.SCHEDULER,
    ],
    lazy: true,
    factory: async () => {
      const { healthReportService } = await import('./ai-ops/healthReportService');
      await healthReportService.initialize();
      return healthReportService;
    },
  });

  // SyslogManager - Syslog 接收与解析管理服务
  // FeatureFlag: use_syslog_manager 控制是否启动
  serviceRegistry.register({
    name: SERVICE_NAMES.SYSLOG_MANAGER,
    dependencies: [SERVICE_NAMES.PG_DATA_STORE],
    lazy: true,
    factory: async () => {
      const { SyslogManager } = await import('./syslog/syslogManager');
      const { globalEventBus } = await import('./eventBus');
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      const manager = new SyslogManager(pgDs, globalEventBus);

      const { FeatureFlagManager } = await import('./ai-ops/stateMachine/featureFlagManager');
      const ffm = new FeatureFlagManager();
      if (ffm.isControlPointEnabled('use_syslog_manager')) {
        await manager.start();
        logger.info('SyslogManager started (use_syslog_manager enabled)');
      } else {
        logger.info('SyslogManager created but not started (use_syslog_manager disabled)');
      }

      return manager;
    },
  });

  // BrainLoopEngine - 事件驱动大脑长循环引擎
  // FeatureFlag: use_brain_loop_engine 控制是否启用（替代 AutonomousBrainService）
  serviceRegistry.register({
    name: SERVICE_NAMES.BRAIN_LOOP_ENGINE,
    dependencies: [SERVICE_NAMES.PG_DATA_STORE],
    lazy: true,
    factory: async () => {
      const { BrainLoopEngine } = await import('./ai-ops/brain/brainLoopEngine');
      const pgDataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      const engine = new BrainLoopEngine(pgDataStore);
      return engine;
    },
  });

  logger.debug('Business layer services registered (lazy initialization)');
}

// ==================== 公共 API ====================

/**
 * 注册所有服务到 ServiceRegistry
 * 按 2 层架构注册：核心层 + 业务层
 * Requirements: 11.1 - 将服务分为核心服务和延迟加载服务
 */
export function registerAllServices(): void {
  logger.info('Registering all services (2-layer architecture)...');

  registerCoreServices();
  registerBusinessServices();

  const serviceNames = serviceRegistry.getServiceNames();
  logger.info(`All services registered. Total: ${serviceNames.length} services`);
}

/**
 * 初始化所有服务
 * 核心层服务立即初始化，业务层服务延迟初始化（首次访问时加载）
 *
 * Requirements: 11.1, 11.2, 11.3
 * - 11.1: 核心服务优先初始化
 * - 11.2: 延迟加载服务在首次使用时按需初始化
 * - 11.3: 启动完成后输出启动耗时和已加载服务列表
 *
 * @returns Promise<void> 核心服务初始化完成后 resolve
 * @throws Error 如果核心服务初始化失败
 */
export async function initializeServices(): Promise<void> {
  const startTime = Date.now();

  logger.info('Starting service initialization (2-layer architecture)...');

  // 注册所有服务
  registerAllServices();

  // 初始化核心服务（业务层服务会被跳过，延迟到首次访问时初始化）
  await serviceRegistry.initializeAll();

  // 初始化服务生命周期管理
  try {
    const { initializeServiceLifecycle } = await import('./ai-ops/serviceLifecycle');
    await initializeServiceLifecycle();
    logger.info('Service lifecycle management initialized');
  } catch (error) {
    logger.warn('Failed to initialize service lifecycle management:', error);
  }

  const duration = Date.now() - startTime;

  // Requirements: 11.3 - 输出启动耗时和已加载服务列表
  const allStatus = serviceRegistry.getAllStatus();
  const readyServices: string[] = [];
  const lazyServices: string[] = [];
  const failedServices: string[] = [];

  for (const [name, status] of allStatus.entries()) {
    if (status === 'ready') {
      readyServices.push(name);
    } else if (status === 'pending') {
      lazyServices.push(name);
    } else if (status === 'failed') {
      failedServices.push(name);
    }
  }

  logger.info(`=== Service Startup Summary ===`);
  logger.info(`Startup time: ${duration}ms`);
  logger.info(`Core services initialized: ${readyServices.length} [${readyServices.join(', ')}]`);
  logger.info(`Business services (lazy): ${lazyServices.length} [${lazyServices.join(', ')}]`);

  if (failedServices.length > 0) {
    logger.warn(`Failed services: ${failedServices.length} [${failedServices.join(', ')}]`);
  }

  logger.info(`===============================`);
}

/**
 * 获取服务实例
 * 类型安全的服务获取方法
 *
 * @param name 服务名称
 * @returns 服务实例
 */
export function getService<T>(name: string): T {
  return serviceRegistry.get<T>(name);
}

/**
 * 异步获取服务实例（支持延迟初始化的服务）
 * 对于延迟初始化的服务，会等待初始化完成后返回
 *
 * @param name 服务名称
 * @returns Promise<服务实例>
 */
export async function getServiceAsync<T>(name: string): Promise<T> {
  return serviceRegistry.getAsync<T>(name);
}

/**
 * 检查服务是否就绪
 *
 * @param name 服务名称
 * @returns 服务是否就绪
 */
export function isServiceReady(name: string): boolean {
  try {
    return serviceRegistry.getStatus(name) === 'ready';
  } catch {
    return false;
  }
}

/**
 * 获取所有服务状态
 *
 * @returns 服务名称到状态的映射
 */
export function getAllServiceStatus(): Map<string, string> {
  return serviceRegistry.getAllStatus();
}

/**
 * 重置服务注册表（用于测试）
 */
export function resetServices(): void {
  serviceRegistry.reset();
  logger.debug('ServiceRegistry reset');
}
