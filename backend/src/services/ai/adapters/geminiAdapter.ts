/**
 * Google Gemini 适配器
 * 
 * 实现与 Google Gemini API 的通信，支持流式和非流式响应。
 * 兼容 Gemini 2.5+/3.x 思考模型（Thinking Model），自动过滤思考部分。
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
 * Gemini API 内容部分格式
 * 
 * Gemini 2.5+/3.x 思考模型会在 parts 中包含 thought 标记：
 * - thought: true  → 内部推理过程（不应展示给用户）
 * - thought: false/undefined → 实际回复内容
 */
interface GeminiPart {
  text: string;
  /** 标记此 part 是否为思考/推理内容（Gemini 2.5+/3.x 思考模型） */
  thought?: boolean;
}

/**
 * Gemini API 内容格式
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Gemini API 请求格式
 */
interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: GeminiPart[];
  };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    /** Gemini 2.5 系列思考预算（token 数），设为 0 可禁用思考 */
    thinkingConfig?: {
      thinkingBudget?: number;
    };
  };
}

/**
 * Gemini API 响应格式
 */
interface GeminiResponse {
  candidates: {
    content: {
      parts: GeminiPart[];
      role: string;
    };
    finishReason: string;
  }[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

/**
 * Gemini 适配器实现
 * 
 * 支持 Gemini 2.5+/3.x 思考模型：
 * - 自动过滤响应中的 thought parts
 * - 仅提取实际回复内容
 */
export class GeminiAdapter extends BaseAdapter {
  protected provider = AIProvider.GEMINI;

  constructor(config: AdapterConfig) {
    super(config);
    if (!this.endpoint) {
      this.endpoint = DEFAULT_ENDPOINTS[AIProvider.GEMINI];
    }
  }

  /**
   * 转换消息格式为 Gemini 格式
   */
  private convertMessages(messages: ChatMessage[]): {
    contents: GeminiContent[];
    systemInstruction?: { parts: GeminiPart[] };
  } {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: GeminiPart[] } | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = {
          parts: [{ text: msg.content }]
        };
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    return { contents, systemInstruction };
  }

  /**
   * 从 parts 中提取实际回复内容（过滤思考部分）
   * 
   * Gemini 2.5+/3.x 思考模型的 parts 可能包含：
   * - { text: "推理过程...", thought: true }  ← 过滤掉
   * - { text: "实际回复...", thought: false }  ← 保留
   * - { text: "实际回复..." }                 ← 保留（无 thought 字段）
   */
  private extractResponseText(parts: GeminiPart[]): string {
    if (!parts || parts.length === 0) return '';

    // 过滤掉 thought: true 的 parts，仅保留实际回复
    const responseParts = parts.filter(p => !p.thought);

    // 如果过滤后没有内容（极端情况），回退到使用所有 parts
    if (responseParts.length === 0) {
      return parts.map(p => p.text).join('');
    }

    return responseParts.map(p => p.text).join('');
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.endpoint}/models/${request.model}:generateContent?key=${this.apiKey}`;

    const { contents, systemInstruction } = this.convertMessages(request.messages);

    const body: GeminiRequest = {
      contents,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens
      }
    };

    // 只有当有系统指令时才添加
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    console.log(`[Gemini] Request URL: ${url}`);
    console.log(`[Gemini] Request model: ${request.model}`);

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error(`[Gemini] Error response:`, JSON.stringify(errorBody));
      this.handleHttpError(response.status, errorBody);
    }

    const data = await response.json() as GeminiResponse;

    // 使用 extractResponseText 过滤思考部分
    const content = this.extractResponseText(
      data.candidates?.[0]?.content?.parts || []
    );

    return {
      content,
      finishReason: data.candidates?.[0]?.finishReason || 'STOP',
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount
      } : undefined
    };
  }

  /**
   * 发送聊天请求（流式）
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    const url = `${this.endpoint}/models/${request.model}:streamGenerateContent?key=${this.apiKey}&alt=sse`;

    const { contents, systemInstruction } = this.convertMessages(request.messages);

    const body: GeminiRequest = {
      contents,
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens
      }
    };

    // 只有当有系统指令时才添加
    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    console.log(`[Gemini Stream] Request URL: ${url}`);
    console.log(`[Gemini Stream] Request model: ${request.model}`);

    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error(`[Gemini Stream] Error response:`, JSON.stringify(errorBody));
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
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          try {
            const json = trimmed.slice(6);
            const chunk: GeminiResponse = JSON.parse(json);
            // 使用 extractResponseText 过滤思考部分
            const text = this.extractResponseText(
              chunk.candidates?.[0]?.content?.parts || []
            );
            if (text) {
              yield text;
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
    const url = `${this.endpoint}/models?key=${apiKey}`;

    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET'
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
    const url = `${this.endpoint}/models?key=${this.apiKey}`;

    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET'
      });

      if (!response.ok) {
        return DEFAULT_MODELS[AIProvider.GEMINI];
      }

      const data = await response.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const models = data.models
        ?.filter((model: { name: string; supportedGenerationMethods?: string[] }) =>
          model.supportedGenerationMethods?.includes('generateContent')
        )
        .map((model: { name: string }) => model.name.replace('models/', '')) || [];

      return models.length > 0 ? models : DEFAULT_MODELS[AIProvider.GEMINI];
    } catch {
      return DEFAULT_MODELS[AIProvider.GEMINI];
    }
  }
}
