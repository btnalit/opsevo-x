/**
 * Qwen (阿里云通义千问) 适配器
 * 
 * 实现与阿里云 DashScope API 的通信，支持流式和非流式响应
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
 * Qwen API 消息格式
 */
interface QwenMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Qwen API 请求格式
 */
interface QwenRequest {
  model: string;
  input: {
    messages: QwenMessage[];
  };
  parameters?: {
    temperature?: number;
    max_tokens?: number;
    result_format?: 'text' | 'message';
    incremental_output?: boolean;
  };
}

/**
 * Qwen API 响应格式
 */
interface QwenResponse {
  output: {
    text?: string;
    choices?: {
      message: {
        role: string;
        content: string;
      };
      finish_reason: string;
    }[];
    finish_reason?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  request_id: string;
}

/**
 * Qwen 流式响应格式
 */
interface QwenStreamResponse {
  output: {
    text?: string;
    choices?: {
      message: {
        role: string;
        content: string;
      };
      finish_reason: string;
    }[];
    finish_reason?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  request_id: string;
}

/**
 * Qwen 适配器实现
 */
export class QwenAdapter extends BaseAdapter {
  protected provider = AIProvider.QWEN;

  constructor(config: AdapterConfig) {
    super(config);
    if (!this.endpoint) {
      this.endpoint = DEFAULT_ENDPOINTS[AIProvider.QWEN];
    }
  }

  /**
   * 转换消息格式
   */
  private convertMessages(messages: ChatMessage[]): QwenMessage[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.endpoint}/services/aigc/text-generation/generation`;
    
    const body: QwenRequest = {
      model: request.model,
      input: {
        messages: this.convertMessages(request.messages)
      },
      parameters: {
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        result_format: 'message'
      }
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

    const data = await response.json() as QwenResponse;
    
    // 支持两种响应格式
    const content = data.output.choices?.[0]?.message?.content || data.output.text || '';
    const finishReason = data.output.choices?.[0]?.finish_reason || data.output.finish_reason || 'stop';

    return {
      content,
      finishReason,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }

  /**
   * 发送聊天请求（流式）
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    const url = `${this.endpoint}/services/aigc/text-generation/generation`;
    
    const body: QwenRequest = {
      model: request.model,
      input: {
        messages: this.convertMessages(request.messages)
      },
      parameters: {
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        result_format: 'message',
        incremental_output: true
      }
    };

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'X-DashScope-SSE': 'enable'
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
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          try {
            const json = trimmed.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            
            const chunk: QwenStreamResponse = JSON.parse(json);
            const content = chunk.output.choices?.[0]?.message?.content || chunk.output.text;
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
    // Qwen 没有专门的验证端点，使用简单请求测试
    const url = `${this.endpoint}/services/aigc/text-generation/generation`;
    
    const body: QwenRequest = {
      model: 'qwen-turbo',
      input: {
        messages: [{ role: 'user', content: 'hi' }]
      },
      parameters: {
        max_tokens: 1
      }
    };

    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
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
    // Qwen API 没有列出模型的端点，返回默认列表
    return DEFAULT_MODELS[AIProvider.QWEN];
  }
}
