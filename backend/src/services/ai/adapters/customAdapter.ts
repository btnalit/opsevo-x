/**
 * 自定义供应商适配器
 * 
 * 使用 OpenAI 兼容 API 格式，支持用户接入任意第三方或私有部署的大语言模型。
 * 大部分 LLM 服务（如 Ollama、vLLM、LiteLLM、OneAPI 等）都提供 OpenAI 兼容接口。
 */

import {
    ChatRequest,
    ChatResponse,
    ChatMessage,
    AIProvider,
    AIErrorCode
} from '../../../types/ai';
import { BaseAdapter, AdapterConfig, AIAdapterError } from './baseAdapter';

/**
 * OpenAI 兼容 API 消息格式
 */
interface OpenAICompatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * OpenAI 兼容 API 请求格式
 */
interface OpenAICompatRequest {
    model: string;
    messages: OpenAICompatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
}

/**
 * OpenAI 兼容 API 响应格式
 */
interface OpenAICompatResponse {
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
 * OpenAI 兼容流式响应块格式
 */
interface OpenAICompatStreamChunk {
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
 * 自定义供应商适配器
 * 复用 OpenAI 兼容 API 格式
 */
export class CustomAdapter extends BaseAdapter {
    protected provider = AIProvider.CUSTOM;

    constructor(config: AdapterConfig) {
        super(config);
        if (!this.endpoint) {
            throw new AIAdapterError(
                this.createError(
                    AIErrorCode.UNKNOWN_ERROR,
                    '自定义供应商必须提供 API 端点地址'
                )
            );
        }
    }

    /**
     * 获取默认端点 URL
     */
    protected getDefaultEndpoint(): string {
        return '';
    }

    /**
     * 转换消息格式
     */
    private convertMessages(messages: ChatMessage[]): OpenAICompatMessage[] {
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

        const body: OpenAICompatRequest = {
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

        const data = await response.json() as OpenAICompatResponse;

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

        const body: OpenAICompatRequest = {
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
                        const chunk: OpenAICompatStreamChunk = JSON.parse(json);
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
        // 尝试调用 /models 端点验证连接
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
            // 如果 /models 端点不存在，尝试简单的 chat 请求验证
            try {
                const chatUrl = `${this.endpoint}/chat/completions`;
                const response = await this.fetchWithTimeout(chatUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: 'test',
                        messages: [{ role: 'user', content: 'hi' }],
                        max_tokens: 1
                    })
                });
                // 即使返回 404（模型不存在），只要不是 401 就说明 key 有效
                return response.status !== 401;
            } catch {
                return false;
            }
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
                return [];
            }

            const data = await response.json() as { data?: { id: string }[] };
            return data.data?.map((model: { id: string }) => model.id) || [];
        } catch {
            return [];
        }
    }
}
