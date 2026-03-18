/**
 * 智谱 AI (Zhipu/GLM) 适配器
 * 
 * 实现与智谱 AI API 的通信，支持流式和非流式响应
 * 智谱 AI API 兼容 OpenAI API 格式
 */

import {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  AIProvider,
  DEFAULT_ENDPOINTS,
  DEFAULT_MODELS,
  AIErrorCode
} from '../../../types/ai';
import { BaseAdapter, AdapterConfig, AIAdapterError } from './baseAdapter';

/**
 * 智谱 API 消息格式（兼容 OpenAI）
 */
interface ZhipuMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 智谱 API 请求格式
 */
interface ZhipuRequest {
  model: string;
  messages: ZhipuMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/**
 * 智谱 API 响应格式
 */
interface ZhipuResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 智谱流式响应块格式
 */
interface ZhipuStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }[];
}

/**
 * 智谱 AI 适配器实现
 */
export class ZhipuAdapter extends BaseAdapter {
  protected provider = AIProvider.ZHIPU;

  constructor(config: AdapterConfig) {
    super(config);
    if (!this.endpoint) {
      this.endpoint = DEFAULT_ENDPOINTS[AIProvider.ZHIPU];
    }
  }

  /**
   * 转换消息格式
   */
  private convertMessages(messages: ChatMessage[]): ZhipuMessage[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.endpoint}/chat/completions`;
    
    const body: ZhipuRequest = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      stream: false,
      temperature: request.temperature,
      max_tokens: request.maxTokens
    };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      this.handleHttpError(response.status, errorBody);
    }

    const data = await response.json() as ZhipuResponse;
    
    return {
      content: data.choices[0]?.message?.content || '',
      finishReason: data.choices[0]?.finish_reason || 'stop',
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * 发送聊天请求（流式）
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    const url = `${this.endpoint}/chat/completions`;
    
    const body: ZhipuRequest = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxTokens
    };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      this.handleHttpError(response.status, errorBody);
    }

    if (!response.body) {
      throw new AIAdapterError(
        this.createError(AIErrorCode.UNKNOWN_ERROR, 'Response body is null')
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = trimmed.slice(6);
            const chunk: ZhipuStreamChunk = JSON.parse(json);
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            // 忽略解析错误，继续处理下一行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 验证 API Key
   */
  async validateApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey || apiKey.length < 10) {
      return false;
    }
    
    try {
      // 发送一个简单的请求来验证 API Key
      const url = `${this.endpoint}/chat/completions`;
      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'glm-4-flash',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1
        })
      });
      
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 获取可用模型列表
   */
  async listModels(): Promise<string[]> {
    // 智谱 API 没有列出模型的端点，返回默认列表
    return DEFAULT_MODELS[AIProvider.ZHIPU];
  }
}
