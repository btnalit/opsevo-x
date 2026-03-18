/**
 * EmbeddingService 文本嵌入服务
 * 支持多种 AI 服务商的文本嵌入能力，复用现有 AI Agent 适配器配置
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12
 * - 2.1: 将输入文本转换为固定维度向量
 * - 2.2: 支持所有现有 AI Agent 提供商
 * - 2.3: OpenAI 使用 text-embedding-3-small 模型
 * - 2.4: Gemini 使用 text-embedding-004 模型
 * - 2.5: DeepSeek 使用兼容的嵌入端点
 * - 2.6: Qwen 使用 text-embedding-v3 模型
 * - 2.7: Zhipu 使用 embedding-3 模型
 * - 2.8: 复用现有 AI Agent 适配器配置进行认证
 * - 2.9: 嵌入失败时使用指数退避重试最多 3 次
 * - 2.10: 缓存相同文本输入的嵌入结果
 * - 2.11: 批量嵌入时在支持的情况下使用单个 API 调用
 * - 2.12: 归一化输出向量为单位长度
 */


import { apiConfigService } from '../../ai/apiConfigService';
import { cryptoService } from '../../ai/cryptoService';
import { logger } from '../../../utils/logger';

// ==================== 类型定义 ====================

export type EmbeddingProvider = 'openai' | 'gemini' | 'deepseek' | 'qwen' | 'zhipu';

/**
 * 嵌入服务配置
 */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  cacheEnabled?: boolean;
  cacheTtlMs?: number;
}

/**
 * 嵌入结果
 */
export interface EmbeddingResult {
  text: string;
  vector: number[];
  model: string;
  dimensions: number;
  cached: boolean;
}

/**
 * 缓存条目
 */
interface CacheEntry {
  vector: number[];
  model: string;
  dimensions: number;
  createdAt: number;
  ttl: number;
}

// 各服务商默认嵌入模型
export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  openai: 'text-embedding-3-small',
  gemini: 'gemini-embedding-2-preview',
  deepseek: 'deepseek-embedding',
  qwen: 'text-embedding-v3',
  zhipu: 'embedding-3',
};

// 各服务商向量维度
export const EMBEDDING_DIMENSIONS: Record<EmbeddingProvider, number> = {
  openai: 1536,
  gemini: 3072,
  deepseek: 1024,
  qwen: 1024,
  zhipu: 2048,
};

// 各服务商嵌入 API 端点
const EMBEDDING_ENDPOINTS: Record<EmbeddingProvider, string> = {
  openai: 'https://api.openai.com/v1/embeddings',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  deepseek: 'https://api.deepseek.com/v1/embeddings', // DeepSeek 可能不支持，会回退到其他提供商
  qwen: 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
};

// 支持嵌入的提供商列表（按优先级排序，Gemini 免费额度充足优先）
const EMBEDDING_SUPPORTED_PROVIDERS: EmbeddingProvider[] = ['gemini', 'openai', 'qwen', 'zhipu'];

// 默认配置
const DEFAULT_CONFIG: EmbeddingConfig = {
  provider: 'openai',
  batchSize: 100,
  cacheEnabled: true,
  cacheTtlMs: 24 * 60 * 60 * 1000, // 24 小时
};

/**
 * EmbeddingService 文本嵌入服务类
 */
export class EmbeddingService {
  private config: EmbeddingConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private apiKey: string | null = null;
  private endpoint: string | null = null;
  private initialized: boolean = false;

  // 缓存统计
  private cacheHits: number = 0;
  private cacheMisses: number = 0;

  constructor(config?: Partial<EmbeddingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('EmbeddingService created', { provider: this.config.provider });
  }

  /**
   * 刷新并加载最新配置
   * 解决新增 LLM 配置后因为单例缓存导致 "无配置和认证令牌" 报错的问题
   */
  private async refreshConfig(): Promise<void> {
    try {
      // 动态读取最新配置
      const allConfigs = await apiConfigService.getAll();
      let newApiKey: string | null = null;
      let newProvider: EmbeddingProvider | null = null;
      let newEndpoint: string | null = null;

      // 优先查找支持嵌入的提供商
      for (const preferredProvider of EMBEDDING_SUPPORTED_PROVIDERS) {
        const config = allConfigs.find(c => c.provider === preferredProvider);
        if (config) {
          newProvider = preferredProvider;
          newApiKey = cryptoService.decrypt(config.apiKey);
          newEndpoint = EMBEDDING_ENDPOINTS[preferredProvider];
          break;
        }
      }

      // 如果没有找到优先提供商，尝试使用任何可用的配置
      if (!newApiKey) {
        for (const config of allConfigs) {
          const fallbackProvider = config.provider as unknown as EmbeddingProvider;
          if (EMBEDDING_ENDPOINTS[fallbackProvider]) {
            newProvider = fallbackProvider;
            newApiKey = cryptoService.decrypt(config.apiKey);
            newEndpoint = EMBEDDING_ENDPOINTS[fallbackProvider];
            break;
          }
        }
      }

      // 如果找到了有效的配置，更新内存中的认证状态
      if (newApiKey && newProvider) {
        this.apiKey = newApiKey;
        this.endpoint = newEndpoint;

        // 当提供商发生改变时，重置默认模型和维度
        if (this.config.provider !== newProvider) {
          this.config.provider = newProvider;
          this.config.model = DEFAULT_EMBEDDING_MODELS[newProvider];
          this.config.dimensions = EMBEDDING_DIMENSIONS[newProvider];
        }
      }
    } catch (error) {
      logger.warn('Failed to refresh EmbeddingService config dynamically', { error });
    }
  }

  /**
   * 初始化服务（从现有 AI Agent 配置加载）
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      // 即便已初始化，我们仍进行一次轻量的配置刷新
      await this.refreshConfig();
      logger.debug('EmbeddingService config refreshed during initialize call');
      return;
    }

    try {
      await this.refreshConfig();

      // Subscribe to configuration changes dynamically
      apiConfigService.on('configUpdated', () => {
        this.refreshConfig().catch(e => {
          logger.error('Failed to handle configUpdated event in EmbeddingService', { error: e });
        });
      });

      if (!this.apiKey) {
        logger.warn(`No API config found for embedding, embedding will fail until configured`);
      }

      // 设置默认模型和维度 (确保始终有后备值)
      if (!this.config.model) {
        this.config.model = DEFAULT_EMBEDDING_MODELS[this.config.provider];
      }
      if (!this.config.dimensions) {
        this.config.dimensions = EMBEDDING_DIMENSIONS[this.config.provider];
      }

      this.initialized = true;
      logger.info('EmbeddingService initialized', {
        provider: this.config.provider,
        model: this.config.model,
        dimensions: this.config.dimensions,
      });
    } catch (error) {
      logger.error('Failed to initialize EmbeddingService', { error });
      throw error;
    }
  }

  /**
   * 设置 API Key（用于测试或手动配置）
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.initialized = true;
  }

  /**
   * 设置端点（用于测试或手动配置）
   */
  setEndpoint(endpoint: string): void {
    this.endpoint = endpoint;
  }

  /**
   * 单文本嵌入
   */
  async embed(text: string): Promise<EmbeddingResult> {
    // 检查缓存
    if (this.config.cacheEnabled) {
      const cached = this.getFromCache(text);
      if (cached) {
        this.cacheHits++;
        return {
          text,
          vector: cached.vector,
          model: cached.model,
          dimensions: cached.dimensions,
          cached: true,
        };
      }
      this.cacheMisses++;
    }

    // 调用 API 获取嵌入
    const vector = await this.callEmbeddingAPI([text]);
    const normalizedVector = this.normalizeVector(vector[0]);

    // 缓存结果
    if (this.config.cacheEnabled) {
      this.setCache(text, normalizedVector);
    }

    return {
      text,
      vector: normalizedVector,
      model: this.config.model!,
      dimensions: normalizedVector.length,
      cached: false,
    };
  }

  /**
   * 批量嵌入
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const results: EmbeddingResult[] = [];
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    // 检查缓存
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (this.config.cacheEnabled) {
        const cached = this.getFromCache(text);
        if (cached) {
          this.cacheHits++;
          results[i] = {
            text,
            vector: cached.vector,
            model: cached.model,
            dimensions: cached.dimensions,
            cached: true,
          };
          continue;
        }
        this.cacheMisses++;
      }
      uncachedTexts.push(text);
      uncachedIndices.push(i);
    }

    // 批量调用 API 获取未缓存的嵌入
    if (uncachedTexts.length > 0) {
      const batchSize = this.config.batchSize || 100;

      for (let i = 0; i < uncachedTexts.length; i += batchSize) {
        const batch = uncachedTexts.slice(i, i + batchSize);
        const batchIndices = uncachedIndices.slice(i, i + batchSize);

        const vectors = await this.callEmbeddingAPI(batch);

        for (let j = 0; j < vectors.length; j++) {
          const normalizedVector = this.normalizeVector(vectors[j]);
          const originalIndex = batchIndices[j];
          const text = batch[j];

          // 缓存结果
          if (this.config.cacheEnabled) {
            this.setCache(text, normalizedVector);
          }

          results[originalIndex] = {
            text,
            vector: normalizedVector,
            model: this.config.model!,
            dimensions: normalizedVector.length,
            cached: false,
          };
        }
      }
    }

    return results;
  }

  /**
   * 调用嵌入 API（带重试）
   */
  private async callEmbeddingAPI(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('API key not configured. Please add an AI provider setting first.');
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.doEmbeddingRequest(texts);
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Embedding API call failed (attempt ${attempt + 1}/${maxRetries})`, {
          error: lastError.message,
        });

        if (attempt < maxRetries - 1) {
          // 指数退避
          const delay = Math.pow(2, attempt) * 1000;
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Embedding API call failed after retries');
  }

  /**
   * 执行嵌入请求
   */
  private async doEmbeddingRequest(texts: string[]): Promise<number[][]> {
    const endpoint = this.endpoint || EMBEDDING_ENDPOINTS[this.config.provider];
    const model = this.config.model || DEFAULT_EMBEDDING_MODELS[this.config.provider];

    switch (this.config.provider) {
      case 'openai':
      case 'deepseek':
        return this.callOpenAICompatibleAPI(endpoint, model, texts);
      case 'gemini':
        return this.callGeminiAPI(endpoint, model, texts);
      case 'qwen':
        return this.callQwenAPI(endpoint, model, texts);
      case 'zhipu':
        return this.callZhipuAPI(endpoint, model, texts);
      default:
        throw new Error(`Unsupported embedding provider: ${this.config.provider}`);
    }
  }

  /**
   * 调用 OpenAI 兼容 API（OpenAI, DeepSeek）
   */
  private async callOpenAICompatibleAPI(
    endpoint: string,
    model: string,
    texts: string[]
  ): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // 按 index 排序确保顺序正确
      const sorted = data.data.sort((a, b) => a.index - b.index);
      return sorted.map(item => item.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 调用 Gemini API
   */
  private async callGeminiAPI(
    endpoint: string,
    model: string,
    texts: string[]
  ): Promise<number[][]> {
    const results: number[][] = [];

    // Gemini 不支持批量嵌入，需要逐个调用
    for (const text of texts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const url = `${endpoint}/${model}:embedContent?key=${this.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: {
              parts: [{ text }],
            },
            outputDimensionality: this.config.dimensions || EMBEDDING_DIMENSIONS['gemini'],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Gemini API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
          embedding: { values: number[] };
        };

        results.push(data.embedding.values);
      } finally {
        clearTimeout(timeout);
      }
    }

    return results;
  }

  /**
   * 调用 Qwen API
   */
  private async callQwenAPI(
    endpoint: string,
    model: string,
    texts: string[]
  ): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: {
            texts,
          },
          parameters: {
            text_type: 'document',
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Qwen API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as {
        output: {
          embeddings: Array<{ embedding: number[] }>;
        };
      };

      return data.output.embeddings.map(item => item.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 调用 Zhipu API
   */
  private async callZhipuAPI(
    endpoint: string,
    model: string,
    texts: string[]
  ): Promise<number[][]> {
    const results: number[][] = [];

    // Zhipu 不支持批量嵌入，需要逐个调用
    for (const text of texts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: text,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Zhipu API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
          data: Array<{ embedding: number[] }>;
        };

        results.push(data.data[0].embedding);
      } finally {
        clearTimeout(timeout);
      }
    }

    return results;
  }

  /**
   * 向量归一化（L2 范数）
   */
  private normalizeVector(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) return vector;
    return vector.map(val => val / norm);
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(text: string): string {
    // 使用简单的哈希函数生成缓存键
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `${this.config.provider}:${this.config.model}:${hash}`;
  }

  /**
   * 从缓存获取
   */
  private getFromCache(text: string): CacheEntry | null {
    const key = this.getCacheKey(text);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // 检查是否过期
    if (Date.now() > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  /**
   * 设置缓存
   */
  private setCache(text: string, vector: number[]): void {
    const key = this.getCacheKey(text);
    const ttl = Date.now() + (this.config.cacheTtlMs || DEFAULT_CONFIG.cacheTtlMs!);

    this.cache.set(key, {
      vector,
      model: this.config.model!,
      dimensions: vector.length,
      createdAt: Date.now(),
      ttl,
    });
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    logger.info('EmbeddingService cache cleared');
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      size: this.cache.size,
      hitRate: total > 0 ? this.cacheHits / total : 0,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  async updateConfig(config: Partial<EmbeddingConfig>): Promise<void> {
    const providerChanged = config.provider && config.provider !== this.config.provider;

    this.config = { ...this.config, ...config };

    // 如果提供商改变，需要重新初始化
    if (providerChanged) {
      this.initialized = false;
      this.apiKey = null;
      this.endpoint = null;
      await this.initialize();
    }

    // 更新默认模型和维度
    if (!this.config.model) {
      this.config.model = DEFAULT_EMBEDDING_MODELS[this.config.provider];
    }
    if (!this.config.dimensions) {
      this.config.dimensions = EMBEDDING_DIMENSIONS[this.config.provider];
    }

    logger.info('EmbeddingService config updated', { config: this.config });
  }

  /**
   * 获取当前向量维度
   */
  getDimensions(): number {
    return this.config.dimensions || EMBEDDING_DIMENSIONS[this.config.provider];
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 睡眠辅助函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 导出单例实例
export const embeddingService = new EmbeddingService();
