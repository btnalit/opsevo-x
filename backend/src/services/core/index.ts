/**
 * Core Services Module
 * 
 * 提供核心基础设施服务，包括依赖注入容器、LRU 缓存、数据存储等。
 */

export {
  ServiceContainer,
  serviceContainer,
  IServiceContainer,
  CircularDependencyError,
  ServiceNotFoundError,
  ServiceInitializationError,
} from './serviceContainer';

export {
  LRUCache,
  createLRUCache,
  IEnhancedCache,
  LRUCacheConfig,
  CacheStats,
} from './lruCache';

export {
  DataStore,
  DataStoreError,
  type MigrationDefinition,
  type DataStoreOptions,
} from './dataStore';
