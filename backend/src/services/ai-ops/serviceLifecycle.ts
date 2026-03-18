/**
 * ServiceLifecycle - AI-Ops 服务生命周期管理器
 * 
 * 统一管理所有 AI-Ops 服务的定时器和资源清理
 * 解决服务不会自动中断导致 CPU 飙升的问题
 * 
 * Requirements: 5.1-5.6
 * - 5.1: 按正确顺序停止服务：数据采集 → 处理 → 持久化
 * - 5.2: 支持优雅降级模式
 * - 5.3: 等待当前处理完成或超时后强制终止
 * - 5.4: 提供服务健康状态检查接口
 * - 5.5: 自动尝试重启异常服务
 * - 5.6: 记录服务状态变化日志
 */

import { logger } from '../../utils/logger';

// ==================== 类型定义 ====================

/**
 * 服务状态
 */
export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'degraded' | 'error';

/**
 * 服务健康检查结果
 */
export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  lastCheck: number;
  consecutiveFailures: number;
}

/**
 * 服务生命周期配置
 */
export interface ServiceLifecycleConfig {
  shutdownTimeoutMs: number;       // 关闭超时，默认 30000
  healthCheckIntervalMs: number;   // 健康检查间隔，默认 30000
  maxRestartAttempts: number;      // 最大重启次数，默认 3
  restartDelayMs: number;          // 重启延迟，默认 5000
  enableAutoRestart: boolean;      // 启用自动重启，默认 true
  flushTimeoutMs: number;          // 刷新超时，默认 5000
  stopTimeoutMs: number;           // 单服务停止超时，默认 5000
}

/**
 * 可管理的服务接口
 */
export interface IManagedService {
  getName?(): string;
  getState?(): ServiceState;
  start?(): Promise<void>;
  stop?(): void | Promise<void>;
  stopCleanupTimer?(): void;
  stopNotificationStatusCleanup?(): void;
  flush?(): Promise<void>;
  healthCheck?(): Promise<HealthCheckResult>;
  supportsDegradedMode?(): boolean;
  getDependencies?(): string[];
}

/**
 * 服务元数据
 */
interface ServiceMetadata {
  name: string;
  service: unknown;
  state: ServiceState;
  category: 'collection' | 'processing' | 'persistence' | 'other';
  healthResult?: HealthCheckResult;
  restartAttempts: number;
  lastStateChange: number;
  startedAt?: number;
  stoppedAt?: number;
}

/**
 * 服务状态变化事件
 */
interface ServiceStateChangeEvent {
  serviceName: string;
  previousState: ServiceState;
  newState: ServiceState;
  timestamp: number;
  reason?: string;
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: ServiceLifecycleConfig = {
  shutdownTimeoutMs: 30000,
  healthCheckIntervalMs: 30000,
  maxRestartAttempts: 3,
  restartDelayMs: 5000,
  enableAutoRestart: true,
  flushTimeoutMs: 5000,
  stopTimeoutMs: 5000,
};

// ==================== 服务分类 ====================

/**
 * 服务分类映射
 * 用于确定关闭顺序：collection → processing → persistence → other
 */
const SERVICE_CATEGORIES: Record<string, 'collection' | 'processing' | 'persistence' | 'other'> = {
  // 数据采集服务（第一批停止）
  metricsCollector: 'collection',
  syslogReceiver: 'collection',
  'topology-discovery': 'collection',

  // 处理服务（第二批停止）
  alertPipeline: 'processing',
  batchProcessor: 'processing',
  alertPreprocessor: 'processing',
  noiseFilter: 'processing',
  decisionEngine: 'processing',
  rootCauseAnalyzer: 'processing',
  remediationAdvisor: 'processing',
  proactiveInspector: 'processing',  // 主动巡检器
  anomalyPredictor: 'processing',    // 异常预测器

  // 调度服务（第三批停止）
  scheduler: 'processing',

  // 持久化/缓存服务（第四批停止）
  alertEngine: 'persistence',
  analysisCache: 'persistence',
  fingerprintCache: 'persistence',
  auditLogger: 'persistence',
  ragEngine: 'persistence',
  knowledgeBase: 'persistence',
};

/**
 * 服务生命周期管理器
 */
class ServiceLifecycleManager {
  private services: Map<string, ServiceMetadata> = new Map();
  private isShuttingDown = false;
  private config: ServiceLifecycleConfig = { ...DEFAULT_CONFIG };
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private stateChangeListeners: Array<(event: ServiceStateChangeEvent) => void> = [];
  private dependencies: Map<string, string[]> = new Map();

  /**
   * 配置生命周期管理器
   */
  configure(config: Partial<ServiceLifecycleConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('ServiceLifecycle configured:', this.config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): ServiceLifecycleConfig {
    return { ...this.config };
  }

  /**
   * 注册服务
   */
  register(name: string, service: object): void {
    const category = SERVICE_CATEGORIES[name] || 'other';
    const metadata: ServiceMetadata = {
      name,
      service,
      state: 'running',
      category,
      restartAttempts: 0,
      lastStateChange: Date.now(),
      startedAt: Date.now(),
    };

    this.services.set(name, metadata);
    const deps = (service as IManagedService).getDependencies?.() || [];
    this.dependencies.set(name, deps);
    logger.debug(`Service registered for lifecycle management: ${name} (category: ${category}, deps: ${deps.join(',')})`);
  }

  /**
   * 取消注册服务
   */
  unregister(name: string): void {
    this.services.delete(name);
    logger.debug(`Service unregistered from lifecycle management: ${name}`);
  }

  /**
   * 检查是否正在关闭
   */
  isInShutdown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * 获取服务状态
   */
  getServiceState(name: string): ServiceState | undefined {
    return this.services.get(name)?.state;
  }

  /**
   * 更新服务状态
   */
  private updateServiceState(name: string, newState: ServiceState, reason?: string): void {
    const metadata = this.services.get(name);
    if (!metadata) return;

    const previousState = metadata.state;
    if (previousState === newState) return;

    metadata.state = newState;
    metadata.lastStateChange = Date.now();

    if (newState === 'running') {
      metadata.startedAt = Date.now();
      metadata.restartAttempts = 0;
    } else if (newState === 'stopped') {
      metadata.stoppedAt = Date.now();
    }

    // 记录状态变化日志 (Requirements: 5.6)
    logger.info(`Service state change: ${name} ${previousState} → ${newState}${reason ? ` (${reason})` : ''}`);

    // 通知监听器
    const event: ServiceStateChangeEvent = {
      serviceName: name,
      previousState,
      newState,
      timestamp: Date.now(),
      reason,
    };
    this.stateChangeListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        logger.error('State change listener error:', error);
      }
    });
  }

  /**
   * 添加状态变化监听器
   */
  onStateChange(listener: (event: ServiceStateChangeEvent) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      const index = this.stateChangeListeners.indexOf(listener);
      if (index >= 0) {
        this.stateChangeListeners.splice(index, 1);
      }
    };
  }

  /**
   * 检查服务是否支持降级模式 (Requirements: 5.2)
   */
  supportsDegradedMode(name: string): boolean {
    const metadata = this.services.get(name);
    if (!metadata) return false;

    const service = metadata.service as IManagedService;
    if (typeof service.supportsDegradedMode === 'function') {
      return service.supportsDegradedMode();
    }

    // 默认：持久化服务支持降级，采集和处理服务不支持
    return metadata.category === 'persistence';
  }

  /**
   * 执行服务健康检查 (Requirements: 5.4)
   */
  async healthCheck(name: string): Promise<HealthCheckResult> {
    const metadata = this.services.get(name);
    if (!metadata) {
      return {
        healthy: false,
        message: 'Service not found',
        lastCheck: Date.now(),
        consecutiveFailures: 0,
      };
    }

    const service = metadata.service as IManagedService;

    try {
      if (typeof service.healthCheck === 'function') {
        const result = await service.healthCheck();
        metadata.healthResult = result;
        return result;
      }

      // 默认健康检查：检查服务状态
      const healthy = metadata.state === 'running' || metadata.state === 'degraded';
      const result: HealthCheckResult = {
        healthy,
        message: healthy ? 'Service is running' : `Service is ${metadata.state}`,
        lastCheck: Date.now(),
        consecutiveFailures: healthy ? 0 : (metadata.healthResult?.consecutiveFailures || 0) + 1,
      };
      metadata.healthResult = result;
      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        message: error instanceof Error ? error.message : 'Health check failed',
        lastCheck: Date.now(),
        consecutiveFailures: (metadata.healthResult?.consecutiveFailures || 0) + 1,
      };
      metadata.healthResult = result;
      return result;
    }
  }

  /**
   * 执行所有服务的健康检查
   */
  async healthCheckAll(): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>();

    for (const [name] of this.services) {
      const result = await this.healthCheck(name);
      results.set(name, result);
    }

    return results;
  }

  /**
   * 获取所有服务的健康状态摘要
   */
  getHealthSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    services: Array<{ name: string; state: ServiceState; healthy: boolean; lastCheck?: number }>;
  } {
    const services: Array<{ name: string; state: ServiceState; healthy: boolean; lastCheck?: number }> = [];
    let healthy = 0;
    let unhealthy = 0;

    for (const [name, metadata] of this.services) {
      const isHealthy = metadata.state === 'running' || metadata.state === 'degraded';
      if (isHealthy) {
        healthy++;
      } else {
        unhealthy++;
      }
      services.push({
        name,
        state: metadata.state,
        healthy: isHealthy,
        lastCheck: metadata.healthResult?.lastCheck,
      });
    }

    return {
      total: this.services.size,
      healthy,
      unhealthy,
      services,
    };
  }

  /**
   * 启动健康检查定时器
   */
  startHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      if (this.isShuttingDown) return;

      for (const [name, metadata] of this.services) {
        if (metadata.state === 'stopped' || metadata.state === 'stopping') continue;

        const result = await this.healthCheck(name);

        // 检测服务异常并尝试重启 (Requirements: 5.5)
        if (!result.healthy && this.config.enableAutoRestart) {
          await this.tryRestartService(name);
        }
      }
    }, this.config.healthCheckIntervalMs);

    logger.debug(`Health check timer started (interval: ${this.config.healthCheckIntervalMs}ms)`);
  }

  /**
   * 停止健康检查定时器
   */
  stopHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      logger.debug('Health check timer stopped');
    }
  }

  /**
   * 尝试重启服务 (Requirements: 5.5)
   */
  async tryRestartService(name: string): Promise<boolean> {
    const metadata = this.services.get(name);
    if (!metadata) return false;

    if (metadata.restartAttempts >= this.config.maxRestartAttempts) {
      logger.error(`Service ${name} exceeded max restart attempts (${this.config.maxRestartAttempts})`);
      this.updateServiceState(name, 'error', 'Max restart attempts exceeded');
      return false;
    }

    metadata.restartAttempts++;
    logger.info(`Attempting to restart service ${name} (attempt ${metadata.restartAttempts}/${this.config.maxRestartAttempts})`);

    const service = metadata.service as IManagedService;

    try {
      // 先停止服务
      this.updateServiceState(name, 'stopping', 'Restart initiated');
      await this.stopSingleService(name, metadata.service, []);

      // 等待重启延迟
      await new Promise(resolve => setTimeout(resolve, this.config.restartDelayMs));

      // 尝试启动服务
      this.updateServiceState(name, 'starting', 'Restart');
      if (typeof service.start === 'function') {
        await service.start();
      }

      this.updateServiceState(name, 'running', 'Restart successful');
      logger.info(`Service ${name} restarted successfully`);
      return true;
    } catch (error) {
      logger.error(`Failed to restart service ${name}:`, error);
      this.updateServiceState(name, 'error', error instanceof Error ? error.message : 'Restart failed');
      return false;
    }
  }

  /**
   * 优雅关闭所有服务 (Requirements: 5.1, 5.3)
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    this.stopHealthCheckTimer();
    logger.info('Starting graceful shutdown of AI-Ops services...');

    const startTime = Date.now();
    const errors: Array<{ name: string; error: string }> = [];

    // 创建超时 Promise
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Shutdown timeout after ${this.config.shutdownTimeoutMs}ms`));
      }, this.config.shutdownTimeoutMs);
    });

    // 关闭所有服务
    const shutdownPromise = this.shutdownAllServices(errors);

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
    } catch (error) {
      logger.error('Shutdown error:', error);
    }

    const duration = Date.now() - startTime;

    if (errors.length > 0) {
      logger.warn(`Shutdown completed with ${errors.length} errors in ${duration}ms:`, errors);
    } else {
      logger.info(`Shutdown completed successfully in ${duration}ms`);
    }

    this.isShuttingDown = false;
  }

  /**
   * 关闭所有服务的内部实现 (Requirements: 5.1)
   * 按正确顺序停止服务：数据采集 → 处理 → 持久化 → 其他
   */
  private async shutdownAllServices(errors: Array<{ name: string; error: string }>): Promise<void> {
    // 1. 构建依赖图进行拓扑排序
    const shutdownOrder = this.getShutdownOrder();
    logger.info(`Calculated shutdown order: ${shutdownOrder.join(' → ')}`);

    for (const name of shutdownOrder) {
      const metadata = this.services.get(name);
      if (metadata) {
        this.updateServiceState(name, 'stopping', 'Shutdown');
        await this.stopSingleService(name, metadata.service, errors);
        this.updateServiceState(name, 'stopped', 'Shutdown complete');
      }
    }
  }

  /**
   * 基于依赖关系计算关闭顺序（拓扑排序）
   * 被依赖的服务应该最后关闭
   */
  private getShutdownOrder(): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>(); // 用于检测循环依赖

    const visit = (name: string) => {
      // 依赖的服务可能未在该管理器注册（例如外部模块），直接跳过
      if (!this.services.has(name)) return;
      if (visited.has(name)) return;

      if (visiting.has(name)) {
        logger.error(`[ServiceLifecycle] Circular dependency detected: ${name}`);
        return;
      }

      visiting.add(name);

      // 获取当前服务依赖的所有服务
      const deps = this.dependencies.get(name) || [];
      for (const depName of deps) {
        visit(depName);
      }

      visiting.delete(name);
      visited.add(name);
      // 后置遍历：被依赖的服务先入栈，构成启动顺序 [B, A] (其中 A 依赖 B)
      order.push(name);
    };

    for (const name of this.services.keys()) {
      visit(name);
    }

    // 关闭顺序应该是启动顺序的反转 [A, B] (先关闭顶层，再关闭底层)
    return order.reverse();
  }

  /**
   * 停止单个服务 (Requirements: 5.3)
   * 等待当前处理完成（带超时）
   */
  private async stopSingleService(
    name: string,
    service: unknown,
    errors: Array<{ name: string; error: string }>
  ): Promise<void> {
    try {
      logger.debug(`Stopping service: ${name}`);

      // 类型安全的方法调用辅助函数
      const hasMethod = (obj: unknown, method: string): obj is Record<string, (...args: unknown[]) => unknown> => {
        return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)[method] === 'function';
      };

      // 先刷新数据（如果支持）(Requirements: 5.3)
      if (hasMethod(service, 'flush')) {
        try {
          await Promise.race([
            service.flush(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Flush timeout')), this.config.flushTimeoutMs)),
          ]);
          logger.debug(`Service ${name} flushed successfully`);
        } catch (flushError) {
          logger.warn(`Flush failed for ${name}:`, flushError);
        }
      }

      // 停止清理定时器
      if (hasMethod(service, 'stopCleanupTimer')) {
        service.stopCleanupTimer();
      }
      if (hasMethod(service, 'stopNotificationStatusCleanup')) {
        service.stopNotificationStatusCleanup();
      }

      // 停止服务（带超时）(Requirements: 5.3)
      if (hasMethod(service, 'stop')) {
        const result = service.stop();
        if (result instanceof Promise) {
          await Promise.race([
            result,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Stop timeout')), this.config.stopTimeoutMs)),
          ]);
        }
      }

      logger.debug(`Service stopped: ${name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push({ name, error: errorMessage });
      logger.error(`Failed to stop service ${name}:`, error);
    }
  }

  /**
   * 设置关闭超时时间
   */
  setShutdownTimeout(ms: number): void {
    this.config.shutdownTimeoutMs = ms;
  }

  /**
   * 获取已注册的服务列表
   */
  getRegisteredServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * 获取服务详细信息
   */
  getServiceInfo(name: string): ServiceMetadata | undefined {
    return this.services.get(name);
  }

  /**
   * 获取所有服务的详细信息
   */
  getAllServicesInfo(): ServiceMetadata[] {
    return Array.from(this.services.values());
  }
}

// 导出单例实例
export const serviceLifecycle = new ServiceLifecycleManager();



/**
 * 初始化服务生命周期管理
 * 在应用启动时调用
 */
export async function initializeServiceLifecycle(): Promise<void> {
  // 动态导入服务以避免循环依赖
  const { metricsCollector } = await import('./metricsCollector');
  const { alertEngine } = await import('./alertEngine');
  const { alertPipeline } = await import('./alertPipeline');
  const { scheduler } = await import('./scheduler');
  const { batchProcessor } = await import('./batchProcessor');
  const { fingerprintCache } = await import('./fingerprintCache');
  const { analysisCache } = await import('./analysisCache');
  const { noiseFilter } = await import('./noiseFilter');
  const { alertPreprocessor } = await import('./alertPreprocessor');
  const { auditLogger } = await import('./auditLogger');
  const { syslogReceiver } = await import('./syslogReceiver');
  const { decisionEngine } = await import('./decisionEngine');
  const { rootCauseAnalyzer } = await import('./rootCauseAnalyzer');
  const { remediationAdvisor } = await import('./remediationAdvisor');
  const { anomalyPredictor } = await import('./anomalyPredictor');

  // 注册所有服务
  serviceLifecycle.register('metricsCollector', metricsCollector);
  serviceLifecycle.register('alertEngine', alertEngine);
  serviceLifecycle.register('alertPipeline', alertPipeline);
  serviceLifecycle.register('scheduler', scheduler);
  serviceLifecycle.register('batchProcessor', batchProcessor);
  serviceLifecycle.register('fingerprintCache', fingerprintCache);
  serviceLifecycle.register('analysisCache', analysisCache);
  serviceLifecycle.register('noiseFilter', noiseFilter);
  serviceLifecycle.register('alertPreprocessor', alertPreprocessor);
  serviceLifecycle.register('auditLogger', auditLogger);
  serviceLifecycle.register('syslogReceiver', syslogReceiver);
  serviceLifecycle.register('decisionEngine', decisionEngine);
  serviceLifecycle.register('rootCauseAnalyzer', rootCauseAnalyzer);
  serviceLifecycle.register('remediationAdvisor', remediationAdvisor);
  serviceLifecycle.register('anomalyPredictor', anomalyPredictor);

  // 注册健康监控服务
  try {
    const { healthMonitor } = await import('./healthMonitor');
    serviceLifecycle.register('healthMonitor', healthMonitor);
  } catch {
    logger.debug('HealthMonitor not available for lifecycle management');
  }

  // 注册主动巡检器并根据配置启动
  try {
    const { proactiveInspector } = await import('./proactiveInspector');
    const { getEvolutionConfig, addConfigChangeListener } = await import('./evolutionConfig');

    serviceLifecycle.register('proactiveInspector', proactiveInspector);

    // 根据进化配置启动巡检器
    const config = getEvolutionConfig();
    if (config.proactiveOps?.enabled) {
      // 更新巡检间隔配置（将小时转换为毫秒）
      if (config.proactiveOps.inspectionIntervalHours) {
        proactiveInspector.updateConfig({
          defaultInterval: config.proactiveOps.inspectionIntervalHours * 60 * 60 * 1000,
        });
      }
      proactiveInspector.start();
      logger.info('ProactiveInspector started with evolution config', {
        intervalHours: config.proactiveOps.inspectionIntervalHours,
      });
    }

    // 监听配置变更，动态调整巡检器
    addConfigChangeListener((newConfig) => {
      if (newConfig.proactiveOps?.enabled) {
        const intervalMs = (newConfig.proactiveOps.inspectionIntervalHours || 1) * 60 * 60 * 1000;
        proactiveInspector.updateConfig({
          defaultInterval: intervalMs,
        });
        proactiveInspector.start();
        logger.info('ProactiveInspector restarted due to config change');
      } else {
        proactiveInspector.stop();
        logger.info('ProactiveInspector stopped due to config change');
      }
    });
  } catch (error) {
    logger.debug('ProactiveInspector not available for lifecycle management', { error });
  }

  // 尝试注册 RAG 引擎（可能未初始化）
  try {
    const { ragEngine } = await import('./rag/ragEngine');
    serviceLifecycle.register('ragEngine', ragEngine);
  } catch {
    logger.debug('RAGEngine not available for lifecycle management');
  }

  // 尝试注册知识库（可能未初始化）
  try {
    const { knowledgeBase } = await import('./rag/knowledgeBase');
    serviceLifecycle.register('knowledgeBase', knowledgeBase);
  } catch {
    logger.debug('KnowledgeBase not available for lifecycle management');
  }

  // 注册拓扑发现服务
  try {
    const { topologyDiscoveryService } = await import('./topology');
    serviceLifecycle.register('topology-discovery', topologyDiscoveryService);
  } catch {
    logger.debug('TopologyDiscoveryService not available for lifecycle management');
  }

  logger.info(`Service lifecycle initialized with ${serviceLifecycle.getRegisteredServices().length} services`);

  // 启动健康检查定时器
  serviceLifecycle.startHealthCheckTimer();

  // 注册进程退出处理
  setupProcessExitHandlers();
}

/**
 * 设置进程退出处理器
 */
function setupProcessExitHandlers(): void {
  let isExiting = false;

  const handleExit = async (signal: string) => {
    if (isExiting) {
      logger.warn(`Received ${signal} during shutdown, forcing exit...`);
      process.exit(1);
    }

    isExiting = true;
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
      await serviceLifecycle.shutdown();
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Graceful shutdown failed:', error);
      process.exit(1);
    }
  };

  // 处理各种退出信号
  process.on('SIGTERM', () => handleExit('SIGTERM'));
  process.on('SIGINT', () => handleExit('SIGINT'));
  process.on('SIGHUP', () => handleExit('SIGHUP'));

  // 处理未捕获的异常
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    handleExit('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    handleExit('unhandledRejection');
  });

  logger.debug('Process exit handlers registered');
}
