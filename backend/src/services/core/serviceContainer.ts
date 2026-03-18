/**
 * ServiceContainer - 服务依赖注入容器
 * 
 * 提供简化的依赖注入接口，支持单例和工厂模式注册。
 * 实现依赖图构建和循环检测。
 * 
 * Requirements: 1.1, 1.4, 1.5
 */

import { logger } from '../../utils/logger';

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
 * 服务未找到错误
 */
export class ServiceNotFoundError extends Error {
  public readonly serviceName: string;

  constructor(serviceName: string) {
    super(`服务 "${serviceName}" 未注册，请先注册该服务`);
    this.name = 'ServiceNotFoundError';
    this.serviceName = serviceName;
  }
}

/**
 * 服务初始化错误
 */
export class ServiceInitializationError extends Error {
  public readonly serviceName: string;
  public readonly cause: Error;

  constructor(serviceName: string, cause: Error) {
    super(`服务 "${serviceName}" 初始化失败: ${cause.message}`);
    this.name = 'ServiceInitializationError';
    this.serviceName = serviceName;
    this.cause = cause;
  }
}

/**
 * 服务注册类型
 */
type RegistrationType = 'singleton' | 'factory';

/**
 * 服务注册信息
 */
interface ServiceRegistration<T = unknown> {
  token: string;
  type: RegistrationType;
  factory: () => T;
  instance: T | null;
  dependencies: string[];
  initialized: boolean;
}

/**
 * 依赖图节点
 */
interface DependencyNode {
  token: string;
  dependencies: string[];
}

/**
 * 服务容器接口
 */
export interface IServiceContainer {
  /**
   * 注册服务工厂（每次 resolve 创建新实例）
   */
  register<T>(token: string, factory: () => T, dependencies?: string[]): void;

  /**
   * 注册单例服务（只创建一次实例）
   */
  registerSingleton<T>(token: string, factory: () => T, dependencies?: string[]): void;

  /**
   * 解析服务实例
   */
  resolve<T>(token: string): T;

  /**
   * 尝试解析服务实例（不抛出异常）
   */
  tryResolve<T>(token: string): T | null;

  /**
   * 检查服务是否已注册
   */
  has(token: string): boolean;

  /**
   * 获取依赖图
   */
  getDependencyGraph(): Map<string, string[]>;

  /**
   * 验证依赖图（检测循环依赖）
   */
  validateDependencies(): void;

  /**
   * 获取服务初始化顺序（拓扑排序）
   */
  getInitializationOrder(): string[];

  /**
   * 重置容器（清除所有注册）
   */
  reset(): void;
}

/**
 * 服务依赖注入容器实现
 */
export class ServiceContainer implements IServiceContainer {
  private registrations: Map<string, ServiceRegistration> = new Map();
  private resolving: Set<string> = new Set(); // 用于检测解析时的循环依赖

  /**
   * 注册服务工厂（每次 resolve 创建新实例）
   */
  register<T>(token: string, factory: () => T, dependencies: string[] = []): void {
    if (this.registrations.has(token)) {
      logger.warn(`服务 "${token}" 已注册，将被覆盖`);
    }

    this.registrations.set(token, {
      token,
      type: 'factory',
      factory,
      instance: null,
      dependencies,
      initialized: false,
    });

    logger.debug(`服务 "${token}" 已注册 (factory 模式)`);
  }

  /**
   * 注册单例服务（只创建一次实例）
   */
  registerSingleton<T>(token: string, factory: () => T, dependencies: string[] = []): void {
    if (this.registrations.has(token)) {
      logger.warn(`服务 "${token}" 已注册，将被覆盖`);
    }

    this.registrations.set(token, {
      token,
      type: 'singleton',
      factory,
      instance: null,
      dependencies,
      initialized: false,
    });

    logger.debug(`服务 "${token}" 已注册 (singleton 模式)`);
  }

  /**
   * 注册已存在的实例（用于测试或外部创建的实例）
   */
  registerInstance<T>(token: string, instance: T): void {
    this.registrations.set(token, {
      token,
      type: 'singleton',
      factory: () => instance,
      instance,
      dependencies: [],
      initialized: true,
    });

    logger.debug(`服务 "${token}" 实例已注册`);
  }

  /**
   * 解析服务实例
   * @throws ServiceNotFoundError 当服务未注册时
   * @throws CircularDependencyError 当检测到循环依赖时
   */
  resolve<T>(token: string): T {
    const registration = this.registrations.get(token);
    if (!registration) {
      throw new ServiceNotFoundError(token);
    }

    // 检测解析时的循环依赖
    if (this.resolving.has(token)) {
      const cycle = [...this.resolving, token];
      throw new CircularDependencyError(cycle);
    }

    // 单例模式：返回已存在的实例
    if (registration.type === 'singleton' && registration.initialized) {
      return registration.instance as T;
    }

    // 标记正在解析
    this.resolving.add(token);

    try {
      // 先解析依赖
      for (const dep of registration.dependencies) {
        this.resolve(dep);
      }

      // 创建实例
      const instance = registration.factory();

      // 单例模式：缓存实例
      if (registration.type === 'singleton') {
        registration.instance = instance;
        registration.initialized = true;
      }

      return instance as T;
    } catch (error) {
      if (error instanceof CircularDependencyError || error instanceof ServiceNotFoundError) {
        throw error;
      }
      throw new ServiceInitializationError(
        token,
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * 尝试解析服务实例（不抛出异常）
   */
  tryResolve<T>(token: string): T | null {
    try {
      return this.resolve<T>(token);
    } catch {
      return null;
    }
  }

  /**
   * 检查服务是否已注册
   */
  has(token: string): boolean {
    return this.registrations.has(token);
  }

  /**
   * 获取依赖图
   */
  getDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const [token, registration] of this.registrations) {
      graph.set(token, [...registration.dependencies]);
    }
    return graph;
  }

  /**
   * 验证依赖图（检测循环依赖）
   * @throws CircularDependencyError 当检测到循环依赖时
   * @throws ServiceNotFoundError 当依赖的服务未注册时
   */
  validateDependencies(): void {
    // 验证所有依赖都已注册
    for (const [token, registration] of this.registrations) {
      for (const dep of registration.dependencies) {
        if (!this.registrations.has(dep)) {
          throw new ServiceNotFoundError(dep);
        }
      }
    }

    // 检测循环依赖
    this.detectCircularDependencies();
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

    const dfs = (token: string): void => {
      if (recursionStack.has(token)) {
        // 找到循环，构建循环路径
        const cycleStart = path.indexOf(token);
        const cycle = [...path.slice(cycleStart), token];
        throw new CircularDependencyError(cycle);
      }

      if (visited.has(token)) {
        return;
      }

      visited.add(token);
      recursionStack.add(token);
      path.push(token);

      const registration = this.registrations.get(token);
      if (registration) {
        for (const dep of registration.dependencies) {
          dfs(dep);
        }
      }

      path.pop();
      recursionStack.delete(token);
    };

    for (const token of this.registrations.keys()) {
      if (!visited.has(token)) {
        dfs(token);
      }
    }
  }

  /**
   * 获取服务初始化顺序（拓扑排序）
   * 返回服务初始化顺序，确保依赖服务先于被依赖服务
   */
  getInitializationOrder(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();

    const visit = (token: string): void => {
      if (visited.has(token)) {
        return;
      }

      if (temp.has(token)) {
        // 这里不应该发生，因为已经检测过循环依赖
        return;
      }

      temp.add(token);

      const registration = this.registrations.get(token);
      if (registration) {
        for (const dep of registration.dependencies) {
          visit(dep);
        }
      }

      temp.delete(token);
      visited.add(token);
      result.push(token);
    };

    for (const token of this.registrations.keys()) {
      if (!visited.has(token)) {
        visit(token);
      }
    }

    return result;
  }

  /**
   * 重置容器（清除所有注册）
   */
  reset(): void {
    this.registrations.clear();
    this.resolving.clear();
    logger.debug('ServiceContainer 已重置');
  }

  /**
   * 获取所有已注册的服务 token
   */
  getRegisteredTokens(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * 获取服务的依赖列表
   */
  getDependencies(token: string): string[] {
    const registration = this.registrations.get(token);
    return registration ? [...registration.dependencies] : [];
  }

  /**
   * 检查服务是否已初始化（仅对单例有效）
   */
  isInitialized(token: string): boolean {
    const registration = this.registrations.get(token);
    return registration?.initialized ?? false;
  }
}

/**
 * 全局服务容器实例
 */
export const serviceContainer = new ServiceContainer();
