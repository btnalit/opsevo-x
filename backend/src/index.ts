import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { logger } from './utils/logger';
import { systemRoutes, dashboardRoutes, aiRoutes, aiOpsRoutes, ragRoutes, unifiedAgentRoutes, fileUploadRoutes, promptTemplateRoutes, skillRoutes, topologyRoutes } from './routes';
import { createAuthRoutes } from './routes/authRoutes';
import { createDeviceRoutes } from './routes/deviceRoutes';
import { createMonitoringRoutes } from './routes/monitoringRoutes';
import { AuthService } from './services/auth/authService';
import { createAuthMiddleware } from './middleware/auth';
import { createDeviceMiddleware } from './middleware/deviceProxy';
import { DeviceManager } from './services/device/deviceManager';
import { DevicePool } from './services/device/devicePool';
import type { DataStore } from './services/dataStore';
import { chatSessionService } from './services/ai/chatSessionService';
import { apiConfigService } from './services/ai/apiConfigService';
import { promptTemplateService } from './services/ai/promptTemplateService';
import { configService } from './services/configService';
import { initializeServices, serviceRegistry } from './services';
import { SERVICE_NAMES } from './services/bootstrap';
import {
  metricsCollector,
  healthMonitor,
  scheduler,
  healthReportService,
  initializeInspectionHandler,
  initializeAlertPipeline,
  syslogReceiver,
  auditLogger,
  alertEngine,
  alertPipeline,
  alertPreprocessor,
  noiseFilter,
  analysisCache,
  fingerprintCache,
  rootCauseAnalyzer,
  remediationAdvisor,
  decisionEngine,
  criticService,
  reflectorService,
  tracingService,
  proactiveInspector,
  anomalyPredictor,
  knowledgeGraphBuilder,
  eventProcessingTracker,
  shutdownEvolutionConfig,
  getEvolutionConfig,
  notificationService,
  configSnapshotService,
  initializeSnapshotHandler,
  faultHealer,
  faultPatternLibrary,
  feedbackService,
  patternLearner,
  continuousLearner,
  degradationManager,
  initLearningOrchestrator,
} from './services/ai-ops';
import { ragEngine, fastPathMetrics } from './services/ai-ops/rag';
import { scriptSynthesizer } from './services/ai-ops/scriptSynthesizer';
import { topologyDiscoveryService } from './services/ai-ops/topology';
import { autonomousBrainService } from './services/ai-ops/brain/autonomousBrainService';
import { skillManager } from './services/ai-ops/skill';
import { initializeSkillSystem } from './services/ai-ops/skill/bootstrapSkillSystem';
import { unifiedAgentService } from './services/ai/unifiedAgentService';
import { contextBuilderService } from './services/ai/contextBuilderService';
import { initializeStateMachineOrchestrator } from './stateMachineBootstrap';

// DeviceDriverManager 单例
import { deviceDriverManager } from './services/device/deviceDriverManager';

// MCP 双向集成
import { ApiKeyManager } from './services/mcp/apiKeyManager';
import { McpServerHandler } from './services/mcp/mcpServerHandler';
import { ToolRegistry } from './services/mcp/toolRegistry';
import { McpClientManager } from './services/mcp/mcpClientManager';
import { createMcpRoutes } from './routes/mcpRoutes';
import { getConfigFilePath, addConfigChangeListener as addEvolutionConfigChangeListener } from './services/ai-ops/evolutionConfig';

// EventBus 桥接与 Webhook 路由
import { globalEventBus } from './services/eventBus';
import { HealthMonitorBridge } from './services/bridges/healthMonitorBridge';
import { AlertEngineBridge } from './services/bridges/alertEngineBridge';
import eventRoutes from './routes/eventRoutes';
import knowledgeRoutes from './routes/knowledgeRoutes';
import bffApiRoutes from './routes/bffApiRoutes';
import { setKnowledgePromptVectorClient } from './controllers/knowledgePromptController';

// Load environment variables
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3099;
const isProduction = process.env.NODE_ENV === 'production';

// MCP 服务实例（在 registerAuthRoutes 中初始化，shutdown 中清理）
let mcpClientManager: McpClientManager | null = null;

// EventBus 桥接实例（在 registerCallbacksAndHandlers 中初始化）
let healthMonitorBridge: HealthMonitorBridge | null = null;
let alertEngineBridge: AlertEngineBridge | null = null;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// 设置 API 路由响应字符集为 UTF-8（仅对 /api 路由生效，不影响静态文件）
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// 请求超时保护，避免 API 长时间挂起导致前端一直等待
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (req.path.includes('/stream') || req.path.includes('/thinking')) {
    return next();
  }

  const longRunningPaths = [
    '/ai/unified/scripts/execute',
    '/ai/scripts/execute',
    '/ai/unified/chat',
    '/ai/chat',
  ];
  const isLongRunning = longRunningPaths.some(p => req.path.includes(p));
  const timeoutMs = isLongRunning ? 120000 : 25000;

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      logger.warn(`Request timeout: ${req.method} ${req.path} (${Math.round(timeoutMs / 1000)}s)`);
      res.status(504).json({ success: false, error: '请求处理超时，请稍后重试' });
    }
  }, timeoutMs);

  res.on('finish', () => clearTimeout(timeout));
  res.on('close', () => clearTimeout(timeout));
  next();
});

// Health check endpoint with service status
app.get('/api/health', (_req: Request, res: Response) => {
  const allStatus = serviceRegistry.getAllStatus();
  const readyCount = Array.from(allStatus.values()).filter(s => s === 'ready').length;
  const totalCount = allStatus.size;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      ready: readyCount,
      total: totalCount,
    },
  });
});

// API Routes - Non-device-scoped routes (auth routes are registered asynchronously in startApplication)
// These routes stay at their current paths (not device-scoped)
// Note: ai-ops, prompt-templates, skills routes are now registered in registerAuthRoutes with auth middleware


// Device-scoped routes are registered in registerAuthRoutes() after auth/device middleware are created
// Routes moved: /api/system, /api/dashboard
// AI routes moved: /api/ai, /api/ai/unified → /api/devices/:deviceId/ai, /api/devices/:deviceId/ai/unified
// New path format: /api/devices/:deviceId/{system,dashboard,ai,ai/unified}


// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: err.message || 'Internal Server Error'
  });
});

// Static files and 404 handler are registered in startApplication() after async routes

// HTTP Server instance
let server: ReturnType<typeof app.listen>;

/**
 * 启动应用程序
 * Requirements: 11.1, 11.2, 11.3, 11.4
 * - 11.1: 核心服务优先初始化
 * - 11.2: 延迟加载服务在首次使用时按需初始化
 * - 11.3: 启动完成后输出启动耗时和已加载服务列表
 * - 11.4: 保持优雅关闭机制
 */
async function startApplication(): Promise<void> {
  const startTime = Date.now();

  try {
    logger.info('Starting application (2-layer architecture)...');

    // 阶段 1：初始化核心服务（业务层服务延迟加载）
    // Requirements: 11.1, 11.2 - 核心服务优先初始化，业务层延迟加载
    logger.info('Phase 1: Initializing core services...');
    await initializeServices();

    // 阶段 2：注册认证路由和设备管理（DataStore、AuthService、DeviceManager、DevicePool）
    // Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 5.1, 5.3, 6.1, 6.5
    logger.info('Phase 2: Registering auth, device, and API routes...');
    await registerAuthRoutes();

    // 阶段 2.5：注册 404 处理程序（必须在所有路由注册完成后）
    // 这确保了异步注册的路由（如 /api/auth）能够正确被匹配
    logger.info('Phase 2.5: Registering 404 handler...');
    if (isProduction) {
      const publicPath = path.join(__dirname, '..', 'public');
      app.use(express.static(publicPath));

      // Handle SPA routing - serve index.html for all non-API routes
      app.get('*', (req: Request, res: Response) => {
        // Skip API routes
        if (req.path.startsWith('/api/')) {
          res.status(404).json({ error: 'Not Found' });
          return;
        }
        res.sendFile(path.join(publicPath, 'index.html'));
      });
    } else {
      // 404 handler for development
      app.use((_req: Request, res: Response) => {
        res.status(404).json({ error: 'Not Found' });
      });
    }

    // 阶段 3：注册回调、启动后台服务、启动 HTTP 服务器
    logger.info('Phase 3: Starting background services and HTTP server...');
    await registerCallbacksAndHandlers();
    await startServices();

    server = app.listen(PORT, () => {
      const totalTime = Date.now() - startTime;
      logger.info(`Server is running on port ${PORT}`);
      // Requirements: 11.3 - 输出启动耗时
      logger.info(`Application started successfully in ${totalTime}ms`);
    });

  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

/**
 * 注册回调和处理器
 * 在服务初始化完成后注册各种回调
 */
async function registerCallbacksAndHandlers(): Promise<void> {
  // 注册告警评估回调到指标采集器
  metricsCollector.registerAlertEvaluationCallback(async (metrics) => {
    try {
      const triggeredAlerts = await alertEngine.evaluate(metrics);
      if (triggeredAlerts.length > 0) {
        logger.info(`Periodic alert evaluation triggered ${triggeredAlerts.length} alerts`);
      }
    } catch (error) {
      logger.error('Periodic alert evaluation failed:', error);
    }
  });
  logger.info('Alert evaluation callback registered');

  // 注册健康报告生成任务处理器
  scheduler.registerHandler('health-report', async (task) => {
    const config = task.config || {};
    const { from, to, channelIds } = config as { from?: number; to?: number; channelIds?: string[] };
    const now = Date.now();
    const reportFrom = from || now - 24 * 60 * 60 * 1000;
    const reportTo = to || now;

    if (channelIds && channelIds.length > 0) {
      return await healthReportService.generateAndSendReport(reportFrom, reportTo, channelIds, task.deviceId);
    } else {
      return await healthReportService.generateReport(reportFrom, reportTo, task.deviceId);
    }
  });
  logger.info('Health report handler registered');

  // 注册巡检任务处理器
  initializeInspectionHandler();
  // 注册快照任务处理器
  initializeSnapshotHandler();
  logger.info('Inspection and Snapshot handlers registered');

  // 初始化告警处理流水线
  initializeAlertPipeline();
  logger.info('Alert pipeline initialized');

  // 初始化 EventBus 桥接 (D1.5)
  // HealthMonitor → EventBus 桥接（内部指标采集器）
  healthMonitorBridge = new HealthMonitorBridge(globalEventBus, healthMonitor);
  healthMonitorBridge.start();
  logger.info('HealthMonitor → EventBus bridge started');

  // AlertEngine → EventBus 桥接
  alertEngineBridge = new AlertEngineBridge(globalEventBus, alertEngine);
  alertEngineBridge.start();
  logger.info('AlertEngine → EventBus bridge started');

  // 初始化状态机编排器并注入到服务单例
  await initializeStateMachineOrchestrator();
}

/**
 * 注册认证路由、设备管理路由和设备感知路由
 * 初始化 DataStore、AuthService、DeviceManager、DevicePool，注册相关路由
 * 创建设备感知路由组，将现有路由挂载到 /api/devices/:deviceId/ 前缀下
 * Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 5.1, 5.3, 6.1, 6.5
 */
async function registerAuthRoutes(): Promise<void> {
  try {
    // Phase 2: Retrieve initialized Core Services from Registry
    // These were initialized in initializeServices() -> registerCoreServices()
    const dataStore = await serviceRegistry.getAsync<DataStore>(SERVICE_NAMES.DATA_STORE);
    logger.info('DataStore retrieved from registry');

    const deviceManager = await serviceRegistry.getAsync<DeviceManager>(SERVICE_NAMES.DEVICE_MANAGER);
    const devicePool = await serviceRegistry.getAsync<DevicePool>(SERVICE_NAMES.DEVICE_POOL);
    const authService = await serviceRegistry.getAsync<AuthService>(SERVICE_NAMES.AUTH_SERVICE);

    // 注册设备驱动工厂（BUG-3 修复：工厂未注册导致 DeviceDriverManager 无法创建驱动实例）
    // 使用 require() 避免 TypeScript rootDir 限制（plugins 目录在 backend/src 之外）
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ApiDriverFactory } = require('../../plugins/api-driver') as { ApiDriverFactory: new () => import('./types/device-driver').DeviceDriverFactory };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SshDriverFactory } = require('../../plugins/ssh-driver') as { SshDriverFactory: new () => import('./types/device-driver').DeviceDriverFactory };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SnmpDriverFactory } = require('../../plugins/snmp-driver') as { SnmpDriverFactory: new () => import('./types/device-driver').DeviceDriverFactory };
      deviceDriverManager.registerDriverFactory(new ApiDriverFactory());
      deviceDriverManager.registerDriverFactory(new SshDriverFactory());
      deviceDriverManager.registerDriverFactory(new SnmpDriverFactory());
      logger.info(`DeviceDriverManager: ${deviceDriverManager.getRegisteredDriverTypes().length} driver factories registered`);
    } catch (err) {
      logger.warn('Failed to register device driver factories (plugins may not be available):', err);
    }

    // Initialize Middleware
    const authMiddleware = createAuthMiddleware(authService);
    const deviceMiddleware = createDeviceMiddleware(deviceManager, devicePool);

    // --- Manual Service Initialization for Persistence & startup ---

    // 1. UnifiedAgentService
    // Import needed at top of file: import { unifiedAgentService } from './services/ai/unifiedAgentService';
    await unifiedAgentService.initialize();
    unifiedAgentService.setDeviceManager(deviceManager);
    logger.info('UnifiedAgentService initialized');

    // 1.1 ContextBuilderService: 注入 DeviceManager（泛化设备上下文）
    // Requirements: J3.9
    contextBuilderService.setDeviceManager(deviceManager);
    logger.info('ContextBuilderService DeviceManager injected');

    // 2. SkillManager
    await skillManager.initialize();
    logger.info('SkillManager initialized');

    // 3. Trigger Critical Services
    // IMPORTANT: Inject dependencies (DataStore, DevicePool) BEFORE triggering initialization via registry

    // AlertEngine
    alertEngine.setDeviceManager(deviceManager);
    await serviceRegistry.getAsync<any>('alertEngine'); // Triggers factory -> initialize()

    // NotificationService
    notificationService.setDataStore(dataStore);
    await serviceRegistry.getAsync<any>('notificationService');

    // NotificationService: wire PgDataStore for PostgreSQL migration (J7.18-J7.21)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      notificationService.setPgDataStore(pgDs);
      logger.info('[NotificationService] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for NotificationService, using JSON file fallback');
    }

    // ConfigSnapshotService
    configSnapshotService.setDataStore(dataStore);
    configSnapshotService.setDevicePool(devicePool);
    await serviceRegistry.getAsync<any>('configSnapshotService');

    // Scheduler
    scheduler.setDataStore(dataStore);
    await serviceRegistry.getAsync<any>('scheduler');

    // AuditLogger
    auditLogger.setDataStore(dataStore);
    await serviceRegistry.getAsync<any>('auditLogger');

    // RAGEngine
    await serviceRegistry.getAsync<any>('ragEngine');

    // 4. SyslogReceiver
    await syslogReceiver.initialize(deviceManager);
    logger.info('SyslogReceiver initialized');

    // 5. Other Services
    // ChatSessionService: wire PgDataStore for PostgreSQL migration (J1.1, J1.2, J1.3)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      chatSessionService.initializeDataStore(pgDs);
    } catch {
      logger.warn('PgDataStore not available for ChatSessionService, using JSON file storage');
    }

    // APIConfigService: wire PgDataStore for PostgreSQL migration (J6.15, J6.16, J6.17)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      apiConfigService.setDataStore(pgDs);
      logger.info('[APIConfigService] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for APIConfigService, using JSON file storage');
    }

    promptTemplateService.setDataStore(dataStore);

    metricsCollector.setDevicePool(devicePool);
    metricsCollector.setDataStore(dataStore);

    alertPreprocessor.setDevicePool(devicePool);

    healthMonitor.setDevicePool(devicePool);
    healthMonitor.setDataStore(dataStore);
    await healthMonitor.initialize();

    // ProactiveInspector: wire DeviceManager, EventBus, DataStore (G5.15)
    proactiveInspector.setDeviceManager(deviceManager);
    proactiveInspector.setEventBus(globalEventBus);

    // FaultHealer: wire DeviceManager, EventBus, RemediationAdvisor, ScriptSynthesizer (H3.11)
    faultHealer.setDeviceManager(deviceManager);
    faultHealer.setEventBus(globalEventBus);
    faultHealer.setRemediationAdvisor(remediationAdvisor);
    faultHealer.setScriptSynthesizer(scriptSynthesizer);
    faultHealer.setFaultPatternLibrary(faultPatternLibrary);

    // FaultPatternLibrary: wire PgDataStore (H4.15, H4.16)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      faultPatternLibrary.setDataStore(pgDs);
    } catch {
      logger.warn('PgDataStore not available for FaultPatternLibrary, using file storage');
    }

    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      proactiveInspector.setDataStore(pgDs);
    } catch {
      logger.warn('PgDataStore not available for ProactiveInspector, reports will use file storage');
    }

    // AnomalyPredictor: wire EventBus, DataStore (G5.16)
    anomalyPredictor.setEventBus(globalEventBus);
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      anomalyPredictor.setDataStore(pgDs);
    } catch {
      logger.warn('PgDataStore not available for AnomalyPredictor, using in-memory data only');
    }

    // KnowledgeGraphBuilder: wire PgDataStore (H1.1)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      knowledgeGraphBuilder.setDataStore(pgDs);
    } catch {
      logger.warn('PgDataStore not available for KnowledgeGraphBuilder, using in-memory storage');
    }

    // AlertEngine: wire PgDataStore for PostgreSQL migration (C3.12)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      alertEngine.setPgDataStore(pgDs);
      logger.info('[AlertEngine] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for AlertEngine, using JSON file fallback');
    }

    // DecisionEngine: wire PgDataStore for PostgreSQL migration (C3.12)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      decisionEngine.setDataStore(pgDs);
      logger.info('[DecisionEngine] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for DecisionEngine, using file fallback');
    }

    // FeedbackService: wire PgDataStore for PostgreSQL migration (C3.12)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      feedbackService.setDataStore(pgDs);
      logger.info('[FeedbackService] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for FeedbackService, using file fallback');
    }

    // PatternLearner: wire PgDataStore for PostgreSQL migration (C3.12)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      patternLearner.setDataStore(pgDs);
      logger.info('[PatternLearner] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for PatternLearner, using file fallback');
    }

    // CriticService: wire PgDataStore for PostgreSQL migration (C3.12)
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      criticService.setDataStore(pgDs);
      logger.info('[CriticService] PgDataStore injected for PostgreSQL storage');
    } catch {
      logger.warn('PgDataStore not available for CriticService, using file fallback');
    }

    // LearningOrchestrator: wire deps (F2.8, F2.9, F3.12, F3.11)
    initLearningOrchestrator({
      critic: criticService,
      reflector: reflectorService,
      patternLearner: patternLearner,
      feedbackService: feedbackService,
    });
    logger.info('LearningOrchestrator initialized');

    // 6. TopologyDiscoveryService
    topologyDiscoveryService.setDeviceProvider(async () => {
      const tenants = await dataStore.query<{ id: string }>('SELECT id FROM users');

      const deviceGroups = await Promise.all(tenants.map(async ({ id: tenantId }) => {
        try {
          return await deviceManager.getDevices(tenantId);
        } catch (error) {
          logger.warn(`Failed to load devices for topology discovery tenant ${tenantId}:`, error);
          return [];
        }
      }));

      return deviceGroups
        .flat()
        // 过滤掉 migration 创建的占位设备（id='default'，密码未加密，无法连接）
        .filter(d => d.id !== 'default')
        .map(d => ({
          id: d.id,
          tenantId: d.tenant_id,
          name: d.name,
          host: d.host,
        }));
    });
    topologyDiscoveryService.setConnectionProvider(async (tenantId, deviceId) => {
      return await devicePool.getConnection(tenantId, deviceId);
    });

    // TopologyDiscoveryService: wire DeviceManager, EventBus, KnowledgeGraphBuilder (H2.6, H2.9, H2.10)
    topologyDiscoveryService.setDeviceManager(deviceManager);
    topologyDiscoveryService.setEventBus(globalEventBus);
    topologyDiscoveryService.setKnowledgeGraphBuilder(knowledgeGraphBuilder);

    await topologyDiscoveryService.initialize();
    logger.info('TopologyDiscoveryService initialized');

    // Task 5.2: Wire topology change events to AutonomousBrainService
    topologyDiscoveryService.setTopologyChangeHandler((event) => {
      if (event.severity === 'critical') {
        autonomousBrainService.triggerTick('critical_alert', {
          source: 'topology',
          summary: event.diffSummary,
          severity: event.severity,
        }).catch(err => logger.warn('[topology] Failed to trigger brain tick:', err));
      }
    });

    // ── MCP 双向集成初始化 ──────────────────────────────────────────────────

    // Phase E Task 8.1: MCP Server 完整链路
    const apiKeyManager = new ApiKeyManager();

    // 注入 PgDataStore 到 ApiKeyManager（E5.15: API Key 持久化迁移到 PostgreSQL）
    try {
      const pgDataStore = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      apiKeyManager.setDataStore(pgDataStore);
    } catch {
      logger.warn('PgDataStore not available for ApiKeyManager, API key operations will fail');
    }

    const mcpServerHandler = new McpServerHandler();

    // Phase E Task 8.2: MCP Client 完整链路
    const configFilePath = getConfigFilePath();
    const toolRegistry = new ToolRegistry(configFilePath);

    // 注册现有 9 个 brainTools 到 ToolRegistry
    // 延迟 require 避免循环依赖（brainTools → alertPipeline → autonomousBrainService）
    setImmediate(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { brainTools } = require('./services/ai-ops/brain/brainTools') as { brainTools: any[] };
        if (Array.isArray(brainTools)) {
          toolRegistry.registerLocalTools(brainTools);
          logger.info(`[MCP] Registered ${brainTools.length} local brainTools to ToolRegistry`);
        }
      } catch (err) {
        logger.warn(`[MCP] Failed to register brainTools to ToolRegistry: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // 初始化 McpClientManager（从 EvolutionConfig 读取配置）
    const mcpClientConfig = getEvolutionConfig().mcpClient;
    const localMcpClientManager = new McpClientManager(toolRegistry, configFilePath);
    mcpClientManager = localMcpClientManager;

    if (mcpClientConfig?.enabled && mcpClientConfig.servers?.length > 0) {
      localMcpClientManager.initialize(mcpClientConfig.servers as any[]).catch(err => {
        logger.error(`[MCP] McpClientManager initialization failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // 注册 EvolutionConfig 变更监听器：mcpClient 配置变更时触发热更新
    addEvolutionConfigChangeListener((newConfig, oldConfig) => {
      const newMcpClient = newConfig.mcpClient;
      const oldMcpClient = oldConfig.mcpClient;
      // 简单比较：序列化后不同则触发更新
      if (JSON.stringify(newMcpClient) !== JSON.stringify(oldMcpClient)) {
        if (newMcpClient?.enabled && newMcpClient.servers?.length > 0) {
          localMcpClientManager.onConfigChange(newMcpClient.servers as any[]).catch(err => {
            logger.error(`[MCP] McpClientManager config change failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    });

    logger.info('[MCP] MCP dual integration initialized (Server + Client)');

    // ── Skill 系统初始化（L3 封装，Requirements: E7.17–E7.22）──────────────

    // 获取 FeatureFlagManager
    const { FeatureFlagManager } = await import('./services/ai-ops/stateMachine/featureFlagManager');
    const skillFeatureFlags = new FeatureFlagManager();

    // VectorStoreClient
    const { VectorStoreClient } = await import('./services/ai-ops/rag/vectorStoreClient');
    const vectorStoreClient = new VectorStoreClient();

    // 单一入口调用：所有 Skill 内部逻辑封装在 L3
    const { skillFactory } = await initializeSkillSystem({
      vectorClient: vectorStoreClient,
      eventBus: globalEventBus,
      deviceManager,
      mcpToolRegistry: toolRegistry,
      featureFlags: skillFeatureFlags,
    });

    // 注入 SkillFactory 到 Brain 和 Agent (E7.21, E7.22)
    autonomousBrainService.setSkillFactory(skillFactory);
    unifiedAgentService.setSkillFactory(skillFactory);
    logger.info('[Skill] Skill system initialized and injected into Brain/Agent');

    // ── Prompt 知识库种子数据向量化（Requirements: F1.1, F1.2）─────────────
    try {
      const { seedPromptKnowledge } = await import('./services/ai-ops/prompt/promptKnowledgeSeeder');
      const seedStats = await seedPromptKnowledge(vectorStoreClient);
      logger.info(`[PromptKnowledge] Seed complete: ${seedStats.loaded} loaded, ${seedStats.skipped} skipped, ${seedStats.failed} failed`);
    } catch (err) {
      logger.warn('[PromptKnowledge] Prompt knowledge seeding failed (non-fatal, will retry on next restart)', err);
    }

    // 注入 VectorStoreClient 到 Knowledge Prompt 控制器 (F1.6)
    setKnowledgePromptVectorClient(vectorStoreClient);

    // 注入 VectorStoreClient 到 PromptTemplateService，启用写入时同步向量化 (F1.7)
    promptTemplateService.setVectorClient(vectorStoreClient);

    // 注入 VectorStoreClient 到 KnowledgeBase，HybridSearchEngine 向量检索通过 Python Core (J5.12, J5.13, J5.14)
    try {
      const { knowledgeBase } = await import('./services/ai-ops/rag/knowledgeBase');
      knowledgeBase.setVectorClient(vectorStoreClient);
      logger.info('[RAG] VectorStoreClient injected into KnowledgeBase for Python Core vector search');
    } catch (err) {
      logger.warn('[RAG] Failed to inject VectorStoreClient into KnowledgeBase (non-fatal)', err);
    }

    // 注入 VectorStoreClient 到 ConversationCollector (J4.11)
    try {
      const { conversationCollector } = await import('./services/ai/conversationCollector');
      conversationCollector.setVectorClient(vectorStoreClient);
      logger.info('[ConversationCollector] VectorStoreClient injected for prompt_knowledge sync');
    } catch (err) {
      logger.warn('[ConversationCollector] Failed to inject VectorStoreClient (non-fatal)', err);
    }

    // ── 路由注册 ──────────────────────────────────────────────────────────────

    // Auth Routes
    app.use('/api/auth', createAuthRoutes(authService));

    // MCP Routes (Server 端点 + API Key 管理 + Client 管理)
    const mcpRouter = createMcpRoutes(apiKeyManager, mcpServerHandler, localMcpClientManager);
    app.use(mcpRouter);
    logger.info('MCP routes registered: /mcp, /api/mcp/keys, /api/mcp/server/status, /api/mcp/client/*');

    // EventBus Webhook Routes (D1.6)
    // 注册 webhook 感知源
    globalEventBus.registerSource({
      name: 'webhook-receiver',
      eventTypes: ['webhook', 'alert', 'metric', 'syslog', 'snmp_trap', 'internal'],
      schemaVersion: '1.0.0',
    });
    app.use('/api/v1/events', eventRoutes);
    logger.info('EventBus webhook routes registered: /api/v1/events/webhook, /api/v1/events/status');

    // Knowledge Routes (F1.6 - 自定义 Prompt 上传)
    app.use('/api/v1/knowledge', knowledgeRoutes);
    logger.info('Knowledge routes registered: /api/v1/knowledge/prompts');

    // BFF API Routes (Task 31 - 补全前端视图所需的 REST API 端点)
    app.use('/api/v1', authMiddleware, bffApiRoutes);
    logger.info('BFF API routes registered: /api/v1/* (auth protected)');

    // Device Routes
    const deviceRouter = createDeviceRoutes(deviceManager, devicePool, authMiddleware);
    app.use('/api/devices', deviceRouter);

    // Monitoring Routes
    const monitoringRouter = createMonitoringRoutes(deviceManager, devicePool, dataStore, authMiddleware);
    app.use('/api/monitoring', monitoringRouter);

    // Device Scoped Routes
    const deviceScopedRouter = express.Router({ mergeParams: true });
    deviceScopedRouter.use(authMiddleware);
    deviceScopedRouter.use(deviceMiddleware);

    deviceScopedRouter.use('/system', systemRoutes);
    deviceScopedRouter.use('/dashboard', dashboardRoutes);


    // AI 路由挂载到设备感知路由组
    // Requirements: 8.4 - AI 对话服务按设备隔离
    deviceScopedRouter.use('/ai', aiRoutes);
    deviceScopedRouter.use('/ai/unified', unifiedAgentRoutes);

    // 设备级监控路由挂载到设备感知路由组
    // Requirements: 9.4 - 设备级监控数据通过设备作用域路由访问
    deviceScopedRouter.use('/monitoring', aiOpsRoutes);

    // 注册设备感知路由组到 /api/devices/:deviceId
    app.use('/api/devices/:deviceId', deviceScopedRouter);
    logger.info('Device-scoped routes registered: /api/devices/:deviceId/{system,dashboard,ai,ai/unified,monitoring}');

    // 注册受保护的全局路由 (Moved from top-level to here to apply authMiddleware)
    // Requirements: 2.2 - 所有管理 API 必须经过认证
    const protectedGlobalRouter = express.Router();
    protectedGlobalRouter.use(authMiddleware);

    protectedGlobalRouter.use('/ai-ops/rag/knowledge/upload', fileUploadRoutes);
    protectedGlobalRouter.use('/ai-ops/rag', ragRoutes);
    protectedGlobalRouter.use('/ai-ops', aiOpsRoutes);
    protectedGlobalRouter.use('/topology', topologyRoutes);
    protectedGlobalRouter.use('/prompt-templates', promptTemplateRoutes);
    protectedGlobalRouter.use('/skills', skillRoutes);

    app.use('/api', protectedGlobalRouter);
    logger.info('Protected global routes registered: /api/{ai-ops, prompt-templates, skills}');
  } catch (error) {
    logger.error('Failed to register auth and device routes:', error);
    throw error;
  }
}

/**
 * 启动服务
 * 启动需要运行的后台服务
 */
async function startServices(): Promise<void> {
  // 启动指标采集器
  metricsCollector.start();
  logger.info('MetricsCollector started');

  // 启动调度器
  scheduler.start();
  logger.info('Scheduler started');

  // 如果 Syslog 接收服务已启用，则启动它
  if (syslogReceiver.getConfig().enabled) {
    syslogReceiver.start();
    logger.info('SyslogReceiver started');
  }

  // 启动拓扑发现服务
  await topologyDiscoveryService.start();
  logger.info('TopologyDiscoveryService started');

  // 启动自主大脑服务（如果配置启用）
  await autonomousBrainService.start();
  logger.info('AutonomousBrainService started');
}

// 优雅停止处理
// Requirements: 11.4 - 保持现有的优雅关闭机制，确保所有已初始化的服务正确清理资源
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  // 防止重复调用
  if (isShuttingDown) {
    logger.info(`Shutdown already in progress, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  logger.info(`Received ${signal}, starting graceful shutdown...`);

  // 设置强制退出定时器，使用 unref() 确保不会阻止进程退出
  const forceExitTimer = setTimeout(() => {
    logger.warn('Graceful shutdown timeout, forcing exit');
    process.exit(1);
  }, 15000); // 增加到 15 秒以确保所有服务有足够时间清理
  forceExitTimer.unref(); // 关键：允许进程在定时器触发前退出

  try {
    // 阶段 1：停止接收新请求的服务
    logger.info('Phase 1: Stopping services that accept new requests...');
    scheduler.stop();
    syslogReceiver.stop();
    proactiveInspector.stop();
    await topologyDiscoveryService.stop();

    // 阶段 2：停止后台处理服务
    logger.info('Phase 2: Stopping background processing services...');
    autonomousBrainService.stop();
    metricsCollector.stop();
    auditLogger.stop();

    // 阶段 2.5：停止 MCP Client 连接
    if (mcpClientManager) {
      logger.info('Phase 2.5: Shutting down MCP Client connections...');
      await mcpClientManager.shutdown();
    }

    // 阶段 2.6：停止 EventBus 桥接
    if (healthMonitorBridge) {
      healthMonitorBridge.stop();
    }
    if (alertEngineBridge) {
      alertEngineBridge.stop();
    }

    // 阶段 3：刷新并停止告警处理流水线
    logger.info('Phase 3: Flushing and stopping alert pipeline...');
    await alertPipeline.stop();
    await alertEngine.flush();

    // 阶段 4：停止所有带定时器的服务
    logger.info('Phase 4: Stopping services with timers...');

    // 停止清理定时器
    noiseFilter.stopCleanupTimer();
    analysisCache.stopCleanupTimer();
    alertPreprocessor.stopCleanupTimer();
    fingerprintCache.stopCleanupTimer();
    eventProcessingTracker.stop();

    // 停止缓存清理定时器
    rootCauseAnalyzer.stopCleanupTimer();
    remediationAdvisor.stopCleanupTimer();
    decisionEngine.stopCleanupTimer();
    criticService.stopCleanupTimer();
    reflectorService.stopCleanupTimer();

    // 停止追踪服务
    await tracingService.shutdown();

    // 停止知识图谱构建器
    await knowledgeGraphBuilder.shutdown();

    // 停止 RAG 引擎
    ragEngine.stopCleanupTimer();

    // 停止 Skill 相关服务
    // skillManager.shutdown() 会处理 metrics.flush()
    await skillManager.shutdown();
    await fastPathMetrics.destroy();

    // 停止带定时器的 AI-Ops 服务 (Issue 2: 之前遗漏的服务)
    faultHealer.shutdown();
    anomalyPredictor.shutdown();
    healthMonitor.shutdown();
    continuousLearner.shutdown();
    degradationManager.shutdown();

    // 阶段 5：关闭进化配置文件监听
    logger.info('Phase 5: Shutting down evolution config...');
    shutdownEvolutionConfig();

    // 阶段 6：关闭基础设施连接
    logger.info('Phase 6: Closing infrastructure connections...');

    // 停止 SNMP Trap 接收器 (UDP server)
    try {
      const snmpReceiver = serviceRegistry.tryGet<any>(SERVICE_NAMES.SNMP_TRAP_RECEIVER);
      if (snmpReceiver) { await snmpReceiver.stop(); }
    } catch { /* not initialized */ }

    // 关闭设备驱动管理器（断开所有 DeviceDriver 连接）
    try {
      await deviceDriverManager.shutdown();
    } catch { /* not initialized */ }

    // 关闭设备连接池
    try {
      const devicePool = serviceRegistry.tryGet<DevicePool>(SERVICE_NAMES.DEVICE_POOL);
      if (devicePool) { await devicePool.destroy(); }
    } catch { /* not initialized */ }

    // 关闭数据库连接
    try {
      const dataStore = serviceRegistry.tryGet<DataStore>(SERVICE_NAMES.DATA_STORE);
      if (dataStore) { await dataStore.close(); }
    } catch { /* not initialized */ }

    // 关闭 PostgreSQL 连接池
    try {
      const pgDataStore = serviceRegistry.tryGet<any>(SERVICE_NAMES.PG_DATA_STORE);
      if (pgDataStore) { await pgDataStore.close(); }
    } catch { /* not initialized */ }

    logger.info('All AI-Ops services stopped successfully');
  } catch (error) {
    logger.error('Error stopping AI-Ops services:', error);
  }

  // 关闭 HTTP 服务器
  if (server) {
    server.close((err) => {
      if (err) {
        logger.error('Error during server close:', err);
        process.exit(1);
      }

      logger.info('Server closed successfully');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

// 监听终止信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 启动应用程序
startApplication();

export default app;
