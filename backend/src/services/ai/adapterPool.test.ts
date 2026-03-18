/**
 * AdapterPool 单元测试
 *
 * 测试适配器池的核心功能：
 * - 缓存命中和未命中
 * - LRU 淘汰策略
 * - 缓存失效
 * - 统计信息
 */

import { AdapterPool, AdapterKey, resetAdapterPool } from './adapterPool';
import { AIProvider } from '../../types/ai';

describe('AdapterPool', () => {
  let pool: AdapterPool;

  beforeEach(() => {
    resetAdapterPool();
    pool = new AdapterPool({ maxSize: 3, ttlMs: 60000 });
  });

  afterEach(() => {
    pool.clear();
  });

  describe('getAdapter', () => {
    it('should create a new adapter on cache miss', () => {
      const key: AdapterKey = { provider: AIProvider.OPENAI };
      const adapter = pool.getAdapter(key, 'test-api-key');

      expect(adapter).toBeDefined();
      expect(pool.getStats().size).toBe(1);
      expect(pool.getStats().misses).toBe(1);
      expect(pool.getStats().hits).toBe(0);
    });

    it('should return cached adapter on cache hit', () => {
      const key: AdapterKey = { provider: AIProvider.OPENAI };
      const adapter1 = pool.getAdapter(key, 'test-api-key');
      const adapter2 = pool.getAdapter(key, 'test-api-key');

      expect(adapter1).toBe(adapter2);
      expect(pool.getStats().size).toBe(1);
      expect(pool.getStats().hits).toBe(1);
      expect(pool.getStats().misses).toBe(1);
    });

    it('should create different adapters for different providers', () => {
      const key1: AdapterKey = { provider: AIProvider.OPENAI };
      const key2: AdapterKey = { provider: AIProvider.GEMINI };

      const adapter1 = pool.getAdapter(key1, 'test-api-key');
      const adapter2 = pool.getAdapter(key2, 'test-api-key');

      expect(adapter1).not.toBe(adapter2);
      expect(pool.getStats().size).toBe(2);
    });

    it('should create different adapters for different API keys', () => {
      const key: AdapterKey = { provider: AIProvider.OPENAI };

      const adapter1 = pool.getAdapter(key, 'api-key-1');
      const adapter2 = pool.getAdapter(key, 'api-key-2');

      expect(adapter1).not.toBe(adapter2);
      expect(pool.getStats().size).toBe(2);
    });

    it('should create different adapters for different endpoints', () => {
      const key1: AdapterKey = { provider: AIProvider.OPENAI, endpoint: 'https://api1.example.com' };
      const key2: AdapterKey = { provider: AIProvider.OPENAI, endpoint: 'https://api2.example.com' };

      const adapter1 = pool.getAdapter(key1, 'test-api-key');
      const adapter2 = pool.getAdapter(key2, 'test-api-key');

      expect(adapter1).not.toBe(adapter2);
      expect(pool.getStats().size).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used adapter when cache is full', async () => {
      // Fill the cache (maxSize = 3) with same API key
      const apiKey = 'shared-api-key';
      
      // Add adapters with small delays to ensure different timestamps
      pool.getAdapter({ provider: AIProvider.OPENAI }, apiKey);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      pool.getAdapter({ provider: AIProvider.GEMINI }, apiKey);
      await new Promise(resolve => setTimeout(resolve, 10));
      
      pool.getAdapter({ provider: AIProvider.DEEPSEEK }, apiKey);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(pool.getStats().size).toBe(3);

      // Access the first adapter to make it recently used
      pool.getAdapter({ provider: AIProvider.OPENAI }, apiKey);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Add a new adapter, should evict GEMINI (least recently used)
      pool.getAdapter({ provider: AIProvider.QWEN }, apiKey);

      expect(pool.getStats().size).toBe(3);

      // GEMINI should be evicted, so getting it again should be a miss
      pool.resetStats();
      pool.getAdapter({ provider: AIProvider.GEMINI }, apiKey);
      expect(pool.getStats().misses).toBe(1);
    });
  });

  describe('invalidate', () => {
    it('should invalidate cache for specific provider', () => {
      const key1: AdapterKey = { provider: AIProvider.OPENAI };
      const key2: AdapterKey = { provider: AIProvider.GEMINI };

      pool.getAdapter(key1, 'test-api-key');
      pool.getAdapter(key2, 'test-api-key');

      expect(pool.getStats().size).toBe(2);

      pool.invalidate(key1);

      expect(pool.getStats().size).toBe(1);

      // Getting OpenAI adapter again should be a miss
      pool.resetStats();
      pool.getAdapter(key1, 'test-api-key');
      expect(pool.getStats().misses).toBe(1);
    });

    it('should invalidate cache for specific endpoint', () => {
      const key1: AdapterKey = { provider: AIProvider.OPENAI, endpoint: 'https://api1.example.com' };
      const key2: AdapterKey = { provider: AIProvider.OPENAI, endpoint: 'https://api2.example.com' };

      pool.getAdapter(key1, 'test-api-key');
      pool.getAdapter(key2, 'test-api-key');

      expect(pool.getStats().size).toBe(2);

      pool.invalidate(key1);

      expect(pool.getStats().size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all cached adapters', () => {
      pool.getAdapter({ provider: AIProvider.OPENAI }, 'key1');
      pool.getAdapter({ provider: AIProvider.GEMINI }, 'key2');

      expect(pool.getStats().size).toBe(2);

      pool.clear();

      expect(pool.getStats().size).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const key: AdapterKey = { provider: AIProvider.OPENAI };

      // First call - miss
      pool.getAdapter(key, 'test-api-key');
      // Second call - hit
      pool.getAdapter(key, 'test-api-key');
      // Third call - hit
      pool.getAdapter(key, 'test-api-key');

      const stats = pool.getStats();
      expect(stats.size).toBe(1);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('should return 0 hit rate when no requests', () => {
      const stats = pool.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('TTL expiration', () => {
    it('should expire cached adapters after TTL', async () => {
      // Create pool with very short TTL
      const shortTtlPool = new AdapterPool({ maxSize: 10, ttlMs: 50 });
      const key: AdapterKey = { provider: AIProvider.OPENAI };

      shortTtlPool.getAdapter(key, 'test-api-key');
      expect(shortTtlPool.getStats().size).toBe(1);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      // Getting adapter again should be a miss (expired)
      shortTtlPool.resetStats();
      shortTtlPool.getAdapter(key, 'test-api-key');
      expect(shortTtlPool.getStats().misses).toBe(1);

      shortTtlPool.clear();
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired entries', async () => {
      const shortTtlPool = new AdapterPool({ maxSize: 10, ttlMs: 50 });

      shortTtlPool.getAdapter({ provider: AIProvider.OPENAI }, 'key1');
      shortTtlPool.getAdapter({ provider: AIProvider.GEMINI }, 'key2');

      expect(shortTtlPool.getStats().size).toBe(2);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      const cleaned = shortTtlPool.cleanupExpired();
      expect(cleaned).toBe(2);
      expect(shortTtlPool.getStats().size).toBe(0);

      shortTtlPool.clear();
    });
  });

  describe('getConfig', () => {
    it('should return current configuration', () => {
      const config = pool.getConfig();
      expect(config.maxSize).toBe(3);
      expect(config.ttlMs).toBe(60000);
    });
  });
});
