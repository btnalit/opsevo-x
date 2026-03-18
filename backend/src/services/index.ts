/**
 * 服务导出
 */
export { ConfigService, configService } from './configService';
export {
  ServiceRegistry,
  serviceRegistry,
  ServiceConfig,
  ServiceStatus,
  IServiceRegistry,
  CircularDependencyError,
  DependencyNotFoundError,
  ServiceNotReadyError,
} from './serviceRegistry';

// Core services - 核心基础设施服务
export {
  ServiceContainer,
  serviceContainer,
  IServiceContainer,
  CircularDependencyError as ContainerCircularDependencyError,
  ServiceNotFoundError,
  ServiceInitializationError,
} from './core';

// Bootstrap - 服务初始化入口
export {
  SERVICE_NAMES,
  registerAllServices,
  initializeServices,
  getService,
  getServiceAsync,
  isServiceReady,
  getAllServiceStatus,
  resetServices,
} from './bootstrap';
