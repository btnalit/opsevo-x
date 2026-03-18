/**
 * AI Provider Adapters Unit Tests
 * 
 * 测试所有 AI 提供商适配器的基本功能
 */

import { AIProvider, DEFAULT_ENDPOINTS, DEFAULT_MODELS } from '../../../types/ai';
import { AdapterFactory } from './adapterFactory';
import { BaseAdapter, AIAdapterError } from './baseAdapter';
import { OpenAIAdapter } from './openaiAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { DeepSeekAdapter } from './deepseekAdapter';
import { QwenAdapter } from './qwenAdapter';
import { ZhipuAdapter } from './zhipuAdapter';
import { CustomAdapter } from './customAdapter';

describe('AdapterFactory', () => {
  const testConfig = {
    apiKey: 'test-api-key',
    endpoint: 'https://test.example.com'
  };

  describe('createAdapter', () => {
    it('should create OpenAI adapter', () => {
      const adapter = AdapterFactory.createAdapter(AIProvider.OPENAI, testConfig);
      expect(adapter).toBeInstanceOf(OpenAIAdapter);
    });

    it('should create Gemini adapter', () => {
      const adapter = AdapterFactory.createAdapter(AIProvider.GEMINI, testConfig);
      expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    it('should create DeepSeek adapter', () => {
      const adapter = AdapterFactory.createAdapter(AIProvider.DEEPSEEK, testConfig);
      expect(adapter).toBeInstanceOf(DeepSeekAdapter);
    });

    it('should create Qwen adapter', () => {
      const adapter = AdapterFactory.createAdapter(AIProvider.QWEN, testConfig);
      expect(adapter).toBeInstanceOf(QwenAdapter);
    });

    it('should create Zhipu adapter', () => {
      const adapter = AdapterFactory.createAdapter(AIProvider.ZHIPU, testConfig);
      expect(adapter).toBeInstanceOf(ZhipuAdapter);
    });

    it('should create Custom adapter', () => {
      const adapter = AdapterFactory.createAdapter(AIProvider.CUSTOM, testConfig);
      expect(adapter).toBeInstanceOf(CustomAdapter);
    });

    it('should throw error for unsupported provider', () => {
      expect(() => {
        AdapterFactory.createAdapter('unsupported' as AIProvider, testConfig);
      }).toThrow('Unsupported AI provider');
    });
  });

  describe('getSupportedProviders', () => {
    it('should return all supported providers', () => {
      const providers = AdapterFactory.getSupportedProviders();
      expect(providers).toContain(AIProvider.OPENAI);
      expect(providers).toContain(AIProvider.GEMINI);
      expect(providers).toContain(AIProvider.DEEPSEEK);
      expect(providers).toContain(AIProvider.QWEN);
      expect(providers).toContain(AIProvider.ZHIPU);
      expect(providers).toContain(AIProvider.CUSTOM);
      expect(providers).toHaveLength(7);
    });
  });

  describe('isProviderSupported', () => {
    it('should return true for supported providers', () => {
      expect(AdapterFactory.isProviderSupported(AIProvider.OPENAI)).toBe(true);
      expect(AdapterFactory.isProviderSupported(AIProvider.GEMINI)).toBe(true);
      expect(AdapterFactory.isProviderSupported(AIProvider.DEEPSEEK)).toBe(true);
      expect(AdapterFactory.isProviderSupported(AIProvider.QWEN)).toBe(true);
      expect(AdapterFactory.isProviderSupported(AIProvider.ZHIPU)).toBe(true);
      expect(AdapterFactory.isProviderSupported(AIProvider.CUSTOM)).toBe(true);
    });

    it('should return false for unsupported providers', () => {
      expect(AdapterFactory.isProviderSupported('unsupported' as AIProvider)).toBe(false);
    });
  });
});

describe('OpenAIAdapter', () => {
  const adapter = new OpenAIAdapter({
    apiKey: 'test-key'
  });

  it('should use default endpoint when not provided', () => {
    expect((adapter as any).endpoint).toBe(DEFAULT_ENDPOINTS[AIProvider.OPENAI]);
  });

  it('should use custom endpoint when provided', () => {
    const customAdapter = new OpenAIAdapter({
      apiKey: 'test-key',
      endpoint: 'https://custom.openai.com/v1'
    });
    expect((customAdapter as any).endpoint).toBe('https://custom.openai.com/v1');
  });

  it('should return default models when listModels fails', async () => {
    // Mock fetch to simulate failure
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const models = await adapter.listModels();
    expect(models).toEqual(DEFAULT_MODELS[AIProvider.OPENAI]);

    global.fetch = originalFetch;
  });
});

describe('GeminiAdapter', () => {
  const adapter = new GeminiAdapter({
    apiKey: 'test-key'
  });

  it('should use default endpoint when not provided', () => {
    expect((adapter as any).endpoint).toBe(DEFAULT_ENDPOINTS[AIProvider.GEMINI]);
  });

  it('should use custom endpoint when provided', () => {
    const customAdapter = new GeminiAdapter({
      apiKey: 'test-key',
      endpoint: 'https://custom.gemini.com/v1'
    });
    expect((customAdapter as any).endpoint).toBe('https://custom.gemini.com/v1');
  });

  it('should return default models when listModels fails', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const models = await adapter.listModels();
    expect(models).toEqual(DEFAULT_MODELS[AIProvider.GEMINI]);

    global.fetch = originalFetch;
  });
});

describe('DeepSeekAdapter', () => {
  const adapter = new DeepSeekAdapter({
    apiKey: 'test-key'
  });

  it('should use default endpoint when not provided', () => {
    expect((adapter as any).endpoint).toBe(DEFAULT_ENDPOINTS[AIProvider.DEEPSEEK]);
  });

  it('should use custom endpoint when provided', () => {
    const customAdapter = new DeepSeekAdapter({
      apiKey: 'test-key',
      endpoint: 'https://custom.deepseek.com/v1'
    });
    expect((customAdapter as any).endpoint).toBe('https://custom.deepseek.com/v1');
  });

  it('should return default models when listModels fails', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const models = await adapter.listModels();
    expect(models).toEqual(DEFAULT_MODELS[AIProvider.DEEPSEEK]);

    global.fetch = originalFetch;
  });
});

describe('QwenAdapter', () => {
  const adapter = new QwenAdapter({
    apiKey: 'test-key'
  });

  it('should use default endpoint when not provided', () => {
    expect((adapter as any).endpoint).toBe(DEFAULT_ENDPOINTS[AIProvider.QWEN]);
  });

  it('should use custom endpoint when provided', () => {
    const customAdapter = new QwenAdapter({
      apiKey: 'test-key',
      endpoint: 'https://custom.qwen.com/v1'
    });
    expect((customAdapter as any).endpoint).toBe('https://custom.qwen.com/v1');
  });

  it('should return default models', async () => {
    const models = await adapter.listModels();
    expect(models).toEqual(DEFAULT_MODELS[AIProvider.QWEN]);
  });
});

describe('ZhipuAdapter', () => {
  const adapter = new ZhipuAdapter({
    apiKey: 'test-key'
  });

  it('should use default endpoint when not provided', () => {
    expect((adapter as any).endpoint).toBe(DEFAULT_ENDPOINTS[AIProvider.ZHIPU]);
  });

  it('should use custom endpoint when provided', () => {
    const customAdapter = new ZhipuAdapter({
      apiKey: 'test-key',
      endpoint: 'https://custom.zhipu.com/v4'
    });
    expect((customAdapter as any).endpoint).toBe('https://custom.zhipu.com/v4');
  });

  it('should return default models', async () => {
    const models = await adapter.listModels();
    expect(models).toEqual(DEFAULT_MODELS[AIProvider.ZHIPU]);
  });
});

describe('CustomAdapter', () => {
  it('should throw error when no endpoint provided', () => {
    expect(() => {
      new CustomAdapter({ apiKey: 'test-key' });
    }).toThrow('自定义供应商必须提供 API 端点地址');
  });

  it('should use provided endpoint', () => {
    const adapter = new CustomAdapter({
      apiKey: 'test-key',
      endpoint: 'https://my-llm.example.com/v1'
    });
    expect((adapter as any).endpoint).toBe('https://my-llm.example.com/v1');
  });

  it('should return empty models when listModels fails', async () => {
    const adapter = new CustomAdapter({
      apiKey: 'test-key',
      endpoint: 'https://my-llm.example.com/v1'
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const models = await adapter.listModels();
    expect(models).toEqual([]);

    global.fetch = originalFetch;
  });
});

describe('AIAdapterError', () => {
  it('should create error with correct properties', () => {
    const errorResponse = {
      code: 'TEST_ERROR',
      message: 'Test error message',
      details: { foo: 'bar' },
      retryable: true,
      retryAfter: 60
    };

    const error = new AIAdapterError(errorResponse);

    expect(error.message).toBe('Test error message');
    expect(error.name).toBe('AIAdapterError');
    expect(error.errorResponse).toEqual(errorResponse);
  });
});
