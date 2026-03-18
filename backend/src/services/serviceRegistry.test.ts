/**
 * ServiceRegistry 单元测试
 */

import {
  ServiceRegistry,
  ServiceConfig,
  CircularDependencyError,
  DependencyNotFoundError,
  ServiceNotReadyError,
} from './serviceRegistry';

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
  });

  describe('register', () => {
    it('should register a service', () => {
      const config: ServiceConfig = {
        name: 'testService',
        dependencies: [],
        factory: async () => ({ value: 'test' }),
      };

      registry.register(config);
      expect(registry.has('testService')).toBe(true);
    });

    it('should allow registering multiple services', () => {
      registry.register({
        name: 'service1',
        dependencies: [],
        factory: async () => ({}),
      });
      registry.register({
        name: 'service2',
        dependencies: ['service1'],
        factory: async () => ({}),
      });

      expect(registry.has('service1')).toBe(true);
      expect(registry.has('service2')).toBe(true);
    });
  });

  describe('initializeAll', () => {
    it('should initialize services in topological order', async () => {
      const initOrder: string[] = [];

      registry.register({
        name: 'base',
        dependencies: [],
        factory: async () => {
          initOrder.push('base');
          return { name: 'base' };
        },
      });

      registry.register({
        name: 'dependent',
        dependencies: ['base'],
        factory: async () => {
          initOrder.push('dependent');
          return { name: 'dependent' };
        },
      });

      await registry.initializeAll();

      expect(initOrder).toEqual(['base', 'dependent']);
      expect(registry.getStatus('base')).toBe('ready');
      expect(registry.getStatus('dependent')).toBe('ready');
    });


    it('should detect circular dependencies', async () => {
      registry.register({
        name: 'A',
        dependencies: ['B'],
        factory: async () => ({}),
      });
      registry.register({
        name: 'B',
        dependencies: ['C'],
        factory: async () => ({}),
      });
      registry.register({
        name: 'C',
        dependencies: ['A'],
        factory: async () => ({}),
      });

      await expect(registry.initializeAll()).rejects.toThrow(CircularDependencyError);
    });

    it('should detect missing dependencies', async () => {
      registry.register({
        name: 'service',
        dependencies: ['nonexistent'],
        factory: async () => ({}),
      });

      await expect(registry.initializeAll()).rejects.toThrow(DependencyNotFoundError);
    });

    it('should propagate initialization failures', async () => {
      registry.register({
        name: 'failing',
        dependencies: [],
        factory: async () => {
          throw new Error('Init failed');
        },
      });

      registry.register({
        name: 'dependent',
        dependencies: ['failing'],
        factory: async () => ({}),
      });

      await registry.initializeAll();

      expect(registry.getStatus('failing')).toBe('failed');
      expect(registry.getStatus('dependent')).toBe('failed');
    });
  });

  describe('get', () => {
    it('should return initialized service instance', async () => {
      const instance = { value: 42 };
      registry.register({
        name: 'myService',
        dependencies: [],
        factory: async () => instance,
      });

      await registry.initializeAll();

      expect(registry.get('myService')).toBe(instance);
    });

    it('should throw ServiceNotReadyError for uninitialized service', () => {
      registry.register({
        name: 'myService',
        dependencies: [],
        factory: async () => ({}),
      });

      expect(() => registry.get('myService')).toThrow(ServiceNotReadyError);
    });

    it('should throw error for unregistered service', () => {
      expect(() => registry.get('unknown')).toThrow('服务 "unknown" 未注册');
    });
  });


  describe('registerMock', () => {
    it('should return mock instance instead of real service', async () => {
      const realInstance = { type: 'real' };
      const mockInstance = { type: 'mock' };

      registry.register({
        name: 'myService',
        dependencies: [],
        factory: async () => realInstance,
      });

      registry.registerMock('myService', mockInstance);
      await registry.initializeAll();

      expect(registry.get('myService')).toBe(mockInstance);
    });

    it('should allow mock without registering real service', () => {
      const mockInstance = { type: 'mock' };
      registry.registerMock('mockOnly', mockInstance);

      expect(registry.get('mockOnly')).toBe(mockInstance);
      expect(registry.getStatus('mockOnly')).toBe('ready');
    });
  });

  describe('reset', () => {
    it('should clear all services and mocks', async () => {
      registry.register({
        name: 'service',
        dependencies: [],
        factory: async () => ({}),
      });
      registry.registerMock('mock', {});

      await registry.initializeAll();

      registry.reset();

      expect(registry.has('service')).toBe(false);
      expect(registry.has('mock')).toBe(false);
      expect(registry.isInitialized()).toBe(false);
    });
  });

  describe('getAllStatus', () => {
    it('should return status of all services', async () => {
      registry.register({
        name: 'service1',
        dependencies: [],
        factory: async () => ({}),
      });
      registry.register({
        name: 'service2',
        dependencies: [],
        factory: async () => ({}),
      });

      await registry.initializeAll();

      const status = registry.getAllStatus();
      expect(status.get('service1')).toBe('ready');
      expect(status.get('service2')).toBe('ready');
    });
  });

  describe('complex dependency graph', () => {
    it('should handle diamond dependency pattern', async () => {
      const initOrder: string[] = [];

      // Diamond pattern: A -> B, A -> C, B -> D, C -> D
      registry.register({
        name: 'D',
        dependencies: [],
        factory: async () => {
          initOrder.push('D');
          return {};
        },
      });
      registry.register({
        name: 'B',
        dependencies: ['D'],
        factory: async () => {
          initOrder.push('B');
          return {};
        },
      });
      registry.register({
        name: 'C',
        dependencies: ['D'],
        factory: async () => {
          initOrder.push('C');
          return {};
        },
      });
      registry.register({
        name: 'A',
        dependencies: ['B', 'C'],
        factory: async () => {
          initOrder.push('A');
          return {};
        },
      });

      await registry.initializeAll();

      // D must be first, A must be last
      expect(initOrder[0]).toBe('D');
      expect(initOrder[initOrder.length - 1]).toBe('A');
      // B and C must come before A
      expect(initOrder.indexOf('B')).toBeLessThan(initOrder.indexOf('A'));
      expect(initOrder.indexOf('C')).toBeLessThan(initOrder.indexOf('A'));
    });
  });
});
