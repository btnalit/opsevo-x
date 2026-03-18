/**
 * AI 提供商基础适配器
 * 
 * 提供所有 AI 提供商适配器的基类实现，包含通用功能：
 * - HTTP 请求处理
 * - 错误处理
 * - 流式响应解析
 */

import {
  IAIProviderAdapter,
  ChatRequest,
  ChatResponse,
  AIProvider,
  AIErrorCode,
  AIErrorResponse,
  DEFAULT_ENDPOINTS
} from '../../../types/ai';

/**
 * 适配器配置选项
 */
export interface AdapterConfig {
  apiKey: string;
  endpoint?: string;
  timeout?: number;
}

/**
 * 基础适配器抽象类
 */
export abstract class BaseAdapter implements IAIProviderAdapter {
  protected apiKey: string;
  protected endpoint: string;
  protected timeout: number;
  protected abstract provider: AIProvider;

  constructor(config: AdapterConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint || this.getDefaultEndpoint();
    this.timeout = config.timeout || 60000; // 默认 60 秒超时
  }

  /**
   * 获取默认端点 URL
   */
  protected getDefaultEndpoint(): string {
    return DEFAULT_ENDPOINTS[this.provider] || '';
  }

  /**
   * 发送聊天请求（非流式）- 子类必须实现
   */
  abstract chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * 发送聊天请求（流式）- 子类必须实现
   */
  abstract chatStream(request: ChatRequest): AsyncGenerator<string>;

  /**
   * 验证 API Key - 子类必须实现
   */
  abstract validateApiKey(apiKey: string): Promise<boolean>;

  /**
   * 获取可用模型列表 - 子类必须实现
   */
  abstract listModels(): Promise<string[]>;

  /**
   * 创建 AI 错误响应
   */
  protected createError(
    code: AIErrorCode,
    message: string,
    details?: unknown,
    retryable = false,
    retryAfter?: number
  ): AIErrorResponse {
    return {
      code,
      message,
      details,
      retryable,
      retryAfter
    };
  }

  /**
   * 处理 HTTP 错误响应
   */
  protected handleHttpError(status: number, body: unknown): never {
    let errorCode: AIErrorCode;
    let message: string;
    let retryable = false;
    let retryAfter: number | undefined;

    switch (status) {
      case 401:
        errorCode = AIErrorCode.INVALID_API_KEY;
        message = 'Invalid API key';
        break;
      case 429:
        errorCode = AIErrorCode.RATE_LIMITED;
        message = 'Rate limit exceeded';
        retryable = true;
        retryAfter = 60;
        break;
      case 402:
      case 403:
        errorCode = AIErrorCode.QUOTA_EXCEEDED;
        message = 'Quota exceeded or permission denied';
        break;
      case 404:
        errorCode = AIErrorCode.MODEL_UNAVAILABLE;
        message = 'Model not found or unavailable';
        break;
      case 408:
      case 504:
        errorCode = AIErrorCode.NETWORK_TIMEOUT;
        message = 'Request timeout';
        retryable = true;
        break;
      default:
        errorCode = AIErrorCode.UNKNOWN_ERROR;
        message = `HTTP error ${status}`;
    }

    const error = this.createError(errorCode, message, body, retryable, retryAfter);
    throw new AIAdapterError(error);
  }

  /**
   * 发送 HTTP 请求
   */
  protected async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AIAdapterError(
          this.createError(
            AIErrorCode.NETWORK_TIMEOUT,
            'Request timeout',
            undefined,
            true
          )
        );
      }
      throw new AIAdapterError(
        this.createError(
          AIErrorCode.UNKNOWN_ERROR,
          error instanceof Error ? error.message : 'Unknown error',
          error
        )
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * AI 适配器错误类
 */
export class AIAdapterError extends Error {
  public readonly errorResponse: AIErrorResponse;

  constructor(errorResponse: AIErrorResponse) {
    super(errorResponse.message);
    this.name = 'AIAdapterError';
    this.errorResponse = errorResponse;
  }
}
