/**
 * OpenAI (ChatGPT) 适配器
 * 
 * 实现与 OpenAI API 的通信，支持流式和非流式响应
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
 * OpenAI API 消息格式
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * OpenAI API 请求格式
 */
interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/**
 * OpenAI API 响应格式
 */
interface OpenAIResponse {
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
 * OpenAI 流式响应块格式
 */
interface OpenAIStreamChunk {
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
 * OpenAI 适配器实现
 */
export class OpenAIAdapter extends BaseAdapter {
  protected provider = AIProvider.OPENAI;

  constructor(config: AdapterConfig) {
    super(config);
    if (!this.endpoint) {
      this.endpoint = DEFAULT_ENDPOINTS[AIProvider.OPENAI];
    }
  }

  /**
   * 转换消息格式
   */
  private convertMessages(messages: ChatMessage[]): OpenAIMessage[] {
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
    
    const body: OpenAIRequest = {
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

    const data = await response.json() as OpenAIResponse;
    
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
    
    const body: OpenAIRequest = {
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
            const chunk: OpenAIStreamChunk = JSON.parse(json);
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
    const url = `${this.endpoint}/models`;
    
    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
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
    const url = `${this.endpoint}/models`;
    
    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      if (!response.ok) {
        return DEFAULT_MODELS[AIProvider.OPENAI];
      }

      const data = await response.json() as { data?: { id: string }[] };
      const chatModels = data.data
        ?.filter((model: { id: string }) => 
          model.id.includes('gpt') && !model.id.includes('instruct')
        )
        .map((model: { id: string }) => model.id) || [];

      return chatModels.length > 0 ? chatModels : DEFAULT_MODELS[AIProvider.OPENAI];
    } catch {
      return DEFAULT_MODELS[AIProvider.OPENAI];
    }
  }
}
