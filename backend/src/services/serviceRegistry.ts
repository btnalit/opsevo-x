/**
 * ServiceRegistry - 服务注册表
 * 
 * 统一管理服务实例、依赖关系和初始化顺序。
 * 支持依赖注入、循环依赖检测、拓扑排序初始化。
 * 
 * 需求: 1.1, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3
 */

import { logger } from '../utils/logger';

/**
 * 服务状态
 */
export type ServiceStatus = 'pending' | 'initializing' | 'ready' | 'failed';

/**
 * 服务配置
 */
export interface ServiceConfig<T = unknown> {
  /** 服务名称 */
  name: string;
  /** 依赖的服务名称列表 */
  dependencies: string[];
  /** 服务工厂函数 */
  factory: () => Promise<T>;
  /** 是否为单例，默认 true */
  singleton?: boolean;
  /** 是否延迟初始化，默认 false。延迟服务在 initializeAll() 时跳过，首次 get() 时初始化 */
  lazy?: boolean;
}

/**
 * 服务注册信息
 */
interface ServiceRegistration<T = unknown> {
  name: string;
  dependencies: string[];
  factory: () => Promise<T>;
  singleton: boolean;
  lazy: boolean;
  status: ServiceStatus;
  instance: T | null;
  initializeTime: number | null;
  error: Error | null;
  initializationPromise: Promise<void> | null;
}

/**
 * 循环依赖错误
 */
export class CircularDependencyError extends Error {
  public readonly cycle: string[];

  constructor(cycle: string[]) {
    const cycleStr = cycle.join(' -> ');
    super(`检测到循环依赖: ${cycleStr}`);
    this.name = 'CircularDependencyError';
    this.cycle = cycle;
  }
}

/**
 * 依赖未找到错误
 */
export class DependencyNotFoundError extends Error {
  public readonly serviceName: string;
  public readonly missingDependency: string;

  constructor(serviceName: string, missingDependency: string) {
    super(`服务 "${serviceName}" 的依赖 "${missingDependency}" 未注册`);
    this.name = 'DependencyNotFoundError';
    this.serviceName = serviceName;
    this.missingDependency = missingDependency;
  }
}

/**
 * 服务未就绪错误
 */
export class ServiceNotReadyError extends Error {
  public readonly serviceName: string;
  public readonly status: ServiceStatus;

  constructor(serviceName: string, status: ServiceStatus) {
    super(`服务 "${serviceName}" 未就绪，当前状态: ${status}`);
    this.name = 'ServiceNotReadyError';
    this.serviceName = serviceName;
    this.status = status;
  }
}

/**
 * 服务注册表接口
 */
export interface IServiceRegistry {
  register<T>(config: ServiceConfig<T>): void;
  get<T>(name: string): T;
  getAsync<T>(name: string): Promise<T>;
  initializeAll(): Promise<void>;
  getStatus(name: string): ServiceStatus;
  getAllStatus(): Map<string, ServiceStatus>;
  reset(): void;
  registerMock<T>(name: string, instance: T): void;
}


/**
 * 服务注册表实现
 */
export class ServiceRegistry implements IServiceRegistry {
  private services: Map<string, ServiceRegistration> = new Map();
  private mocks: Map<string, unknown> = new Map();
  private initialized = false;

  /**
   * 注册服务
   * @throws CircularDependencyError 当检测到循环依赖时
   * @throws DependencyNotFoundError 当依赖服务不存在时（延迟检查，在 initializeAll 时）
   */
  register<T>(config: ServiceConfig<T>): void {
    const { name, dependencies, factory, singleton = true, lazy = false } = config;

    if (this.services.has(name)) {
      logger.warn(`服务 "${name}" 已注册，将被覆盖`);
    }

    const registration: ServiceRegistration<T> = {
      name,
      dependencies,
      factory,
      singleton,
      lazy,
      status: 'pending',
      instance: null,
      initializeTime: null,
      error: null,
      initializationPromise: null,
    };

    this.services.set(name, registration);
    logger.debug(`服务 "${name}" 已注册，依赖: [${dependencies.join(', ')}]${lazy ? ' (lazy)' : ''}`);
  }

  /**
   * 获取服务实例
   * 对于延迟初始化的服务，首次调用时会自动初始化
   * @throws ServiceNotReadyError 当服务未就绪且非延迟服务时
   */
  get<T>(name: string): T {
    // 优先返回 mock 实例
    if (this.mocks.has(name)) {
      return this.mocks.get(name) as T;
    }

    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`服务 "${name}" 未注册`);
    }

    // 延迟初始化：如果服务标记为 lazy 且尚未初始化，则同步触发初始化
    // 注意：这里不能用 await，所以延迟服务的初始化会在后台进行
    // 调用者需要处理服务可能尚未就绪的情况
    if (registration.lazy && registration.status === 'pending') {
      // 启动异步初始化，但不等待完成
      this.initializeLazyService(name).catch(err => {
        logger.error(`延迟服务 "${name}" 初始化失败:`, err);
      });
      // 由于是异步的，第一次调用可能还没准备好
      // 但大多数情况下，调用者会通过 getAsync 或重试获取
      throw new ServiceNotReadyError(name, registration.status);
    }

    // 如果正在初始化，同步调用也只能抛出未就绪
    if (registration.status === 'initializing') {
      throw new ServiceNotReadyError(name, registration.status);
    }

    if (registration.status !== 'ready') {
      throw new ServiceNotReadyError(name, registration.status);
    }

    return registration.instance as T;
  }

  /**
   * 异步获取服务实例（支持延迟初始化）
   * 对于延迟初始化的服务，会等待初始化完成后返回
   */
  async getAsync<T>(name: string): Promise<T> {
    // 优先返回 mock 实例
    if (this.mocks.has(name)) {
      return this.mocks.get(name) as T;
    }

    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`服务 "${name}" 未注册`);
    }

    // 延迟初始化：如果服务标记为 lazy 且尚未初始化（或正在初始化），则触发初始化并等待完成
    if (registration.lazy && (registration.status === 'pending' || registration.status === 'initializing')) {
      await this.initializeLazyService(name);
    }

    if (registration.status !== 'ready') {
      throw new ServiceNotReadyError(name, registration.status);
    }

    return registration.instance as T;
  }

  /**
   * 初始化延迟服务及其依赖
   */
  private async initializeLazyService(name: string): Promise<void> {
    const registration = this.services.get(name);
    // 如果没有注册，或者已经就绪，直接返回
    if (!registration || registration.status === 'ready') {
      return;
    }

    // 如果正在初始化，且有 promise，则等待它完成
    if (registration.status === 'initializing' && registration.initializationPromise) {
      await registration.initializationPromise;
      return;
    }

    // 先初始化依赖
    for (const dep of registration.dependencies) {
      const depReg = this.services.get(dep);
      if (depReg && depReg.lazy && (depReg.status === 'pending' || depReg.status === 'initializing')) {
        await this.initializeLazyService(dep);
      }
    }

    // 初始化自身
    await this.initializeService(name);
  }

  /**
   * 尝试获取服务实例（不抛出异常）
   * 对于延迟服务，如果尚未初始化则返回 null（不触发初始化）
   */
  tryGet<T>(name: string): T | null {
    // 优先返回 mock 实例
    if (this.mocks.has(name)) {
      return this.mocks.get(name) as T;
    }

    const registration = this.services.get(name);
    if (!registration || registration.status !== 'ready') {
      return null;
    }

    return registration.instance as T;
  }

  /**
   * 获取服务状态
   */
  getStatus(name: string): ServiceStatus {
    // mock 服务始终为 ready
    if (this.mocks.has(name)) {
      return 'ready';
    }

    const registration = this.services.get(name);
    if (!registration) {
      throw new Error(`服务 "${name}" 未注册`);
    }

    return registration.status;
  }

  /**
   * 获取所有服务状态
   */
  getAllStatus(): Map<string, ServiceStatus> {
    const statusMap = new Map<string, ServiceStatus>();

    // 添加 mock 服务状态
    for (const name of this.mocks.keys()) {
      statusMap.set(name, 'ready');
    }

    // 添加真实服务状态
    for (const [name, registration] of this.services) {
      if (!this.mocks.has(name)) {
        statusMap.set(name, registration.status);
      }
    }

    return statusMap;
  }


  /**
   * 初始化所有服务
   * 按拓扑排序顺序初始化，确保依赖服务先于被依赖服务初始化
   * @throws CircularDependencyError 当检测到循环依赖时
   * @throws DependencyNotFoundError 当依赖服务不存在时
   */
  async initializeAll(): Promise<void> {
    if (this.initialized) {
      logger.warn('ServiceRegistry 已初始化，跳过重复初始化');
      return;
    }

    logger.info('开始初始化所有服务...');

    // 验证依赖关系
    this.validateDependencies();

    // 检测循环依赖
    this.detectCircularDependencies();

    // 获取拓扑排序顺序
    const sortedServices = this.topologicalSort();

    // 分离核心服务和延迟服务
    const coreServices = sortedServices.filter(name => {
      const reg = this.services.get(name);
      return reg && !reg.lazy;
    });
    const lazyServices = sortedServices.filter(name => {
      const reg = this.services.get(name);
      return reg && reg.lazy;
    });

    logger.info(`核心服务初始化顺序: [${coreServices.join(', ')}]`);
    if (lazyServices.length > 0) {
      logger.info(`延迟加载服务 (${lazyServices.length}): [${lazyServices.join(', ')}]`);
    }

    // 按顺序初始化核心服务（跳过延迟服务）
    for (const serviceName of coreServices) {
      // 跳过已有 mock 的服务
      if (this.mocks.has(serviceName)) {
        logger.debug(`服务 "${serviceName}" 使用 mock 实例，跳过初始化`);
        continue;
      }

      await this.initializeService(serviceName);
    }

    this.initialized = true;
    logger.info('核心服务初始化完成');
  }

  /**
   * 验证依赖关系
   * @throws DependencyNotFoundError 当依赖服务不存在时
   */
  private validateDependencies(): void {
    for (const [name, registration] of this.services) {
      for (const dep of registration.dependencies) {
        // 依赖可以是已注册的服务或 mock 服务
        if (!this.services.has(dep) && !this.mocks.has(dep)) {
          throw new DependencyNotFoundError(name, dep);
        }
      }
    }
  }

  /**
   * 检测循环依赖
   * 使用 DFS 检测图中的环
   * @throws CircularDependencyError 当检测到循环依赖时
   */
  private detectCircularDependencies(): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (serviceName: string): void => {
      if (recursionStack.has(serviceName)) {
        // 找到循环，构建循环路径
        const cycleStart = path.indexOf(serviceName);
        const cycle = [...path.slice(cycleStart), serviceName];
        logger.warn(`检测到循环依赖: ${cycle.join(' -> ')}`);
        throw new CircularDependencyError(cycle);
      }

      if (visited.has(serviceName)) {
        return;
      }

      visited.add(serviceName);
      recursionStack.add(serviceName);
      path.push(serviceName);

      const registration = this.services.get(serviceName);
      if (registration) {
        for (const dep of registration.dependencies) {
          // 只检查已注册的服务，mock 服务不参与循环检测
          if (this.services.has(dep) && !this.mocks.has(dep)) {
            dfs(dep);
          }
        }
      }

      path.pop();
      recursionStack.delete(serviceName);
    };

    for (const serviceName of this.services.keys()) {
      if (!visited.has(serviceName) && !this.mocks.has(serviceName)) {
        dfs(serviceName);
      }
    }
  }


  /**
   * 拓扑排序
   * 返回服务初始化顺序，确保依赖服务先于被依赖服务
   */
  private topologicalSort(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();

    const visit = (serviceName: string): void => {
      if (visited.has(serviceName) || this.mocks.has(serviceName)) {
        return;
      }

      if (temp.has(serviceName)) {
        // 这里不应该发生，因为已经检测过循环依赖
        return;
      }

      temp.add(serviceName);

      const registration = this.services.get(serviceName);
      if (registration) {
        for (const dep of registration.dependencies) {
          if (this.services.has(dep) && !this.mocks.has(dep)) {
            visit(dep);
          }
        }
      }

      temp.delete(serviceName);
      visited.add(serviceName);
      result.push(serviceName);
    };

    for (const serviceName of this.services.keys()) {
      if (!visited.has(serviceName) && !this.mocks.has(serviceName)) {
        visit(serviceName);
      }
    }

    return result;
  }

  /**
   * 初始化单个服务
   */
  private async initializeService(serviceName: string): Promise<void> {
    const registration = this.services.get(serviceName);
    if (!registration) {
      return;
    }

    // 如果已经在初始化，等待它完成
    if (registration.status === 'initializing' && registration.initializationPromise) {
      await registration.initializationPromise;
      return;
    }

    // 如果已经就绪，直接返回
    if (registration.status === 'ready') {
      return;
    }

    // 检查依赖服务是否都已就绪
    for (const dep of registration.dependencies) {
      const depStatus = this.getStatus(dep);
      if (depStatus === 'failed') {
        registration.status = 'failed';
        registration.error = new Error(`依赖服务 "${dep}" 初始化失败`);
        logger.error(`服务 "${serviceName}" 初始化失败: 依赖服务 "${dep}" 初始化失败`);
        return;
      }
    }

    registration.status = 'initializing';
    logger.debug(`正在初始化服务 "${serviceName}"...`);

    const startTime = Date.now();

    // 创建初始化 Promise
    const initPromise = (async () => {
      try {
        const instance = await registration.factory();
        registration.instance = instance;
        registration.status = 'ready';
        registration.initializeTime = Date.now() - startTime;
        logger.info(`服务 "${serviceName}" 初始化完成 (${registration.initializeTime}ms)`);
      } catch (error) {
        registration.status = 'failed';
        registration.error = error instanceof Error ? error : new Error(String(error));
        logger.error(`服务 "${serviceName}" 初始化失败: ${registration.error.message}`);
        throw error;
      } finally {
        registration.initializationPromise = null;
      }
    })();

    registration.initializationPromise = initPromise;

    try {
      await initPromise;
    } catch {
      // 错误已经记录在 registration.error 中
    }
  }

  /**
   * 注册 mock 服务（用于测试）
   * Mock 服务会覆盖真实服务实例
   */
  registerMock<T>(name: string, instance: T): void {
    this.mocks.set(name, instance);
    logger.debug(`Mock 服务 "${name}" 已注册`);
  }

  /**
   * 移除 mock 服务
   */
  removeMock(name: string): void {
    this.mocks.delete(name);
    logger.debug(`Mock 服务 "${name}" 已移除`);
  }

  /**
   * 重置服务注册表（用于测试）
   * 清除所有服务注册和 mock
   */
  reset(): void {
    this.services.clear();
    this.mocks.clear();
    this.initialized = false;
    logger.debug('ServiceRegistry 已重置');
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 获取服务初始化时间
   */
  getInitializeTime(name: string): number | null {
    const registration = this.services.get(name);
    return registration?.initializeTime ?? null;
  }

  /**
   * 获取服务错误信息
   */
  getError(name: string): Error | null {
    const registration = this.services.get(name);
    return registration?.error ?? null;
  }

  /**
   * 检查服务是否已注册
   */
  has(name: string): boolean {
    return this.services.has(name) || this.mocks.has(name);
  }

  /**
   * 获取所有已注册的服务名称
   */
  getServiceNames(): string[] {
    const names = new Set<string>();
    for (const name of this.services.keys()) {
      names.add(name);
    }
    for (const name of this.mocks.keys()) {
      names.add(name);
    }
    return Array.from(names);
  }
}

/**
 * 全局服务注册表实例
 */
export const serviceRegistry = new ServiceRegistry();
