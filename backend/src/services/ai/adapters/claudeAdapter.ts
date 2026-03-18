/**
 * Anthropic Claude 适配器
 * 
 * 实现与 Anthropic Messages API 的通信，支持流式和非流式响应。
 * 兼容 Claude 3.x/4.x 系列，包括支持扩展思考（Extended Thinking）的模型。
 * 
 * Claude API 使用 Messages API (非 OpenAI 兼容)：
 * - 端点: POST /v1/messages
 * - 认证: x-api-key 头
 * - 系统提示: 顶层 system 字段（非 messages 数组内）
 * - 思考内容: type: "thinking" 内容块（独立于 type: "text"）
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
 * Claude API 消息格式
 */
interface ClaudeMessage {
    role: 'user' | 'assistant';
    content: string;
}

/**
 * Claude API 请求格式
 */
interface ClaudeRequest {
    model: string;
    messages: ClaudeMessage[];
    system?: string;
    max_tokens: number;
    temperature?: number;
    stream?: boolean;
}

/**
 * Claude API 响应内容块
 * 
 * Claude 响应中的 content 是一个数组，包含不同类型的内容块：
 * - type: "text"      → 实际回复内容
 * - type: "thinking"  → 扩展思考内容（仅在支持思考的模型中出现）
 */
interface ClaudeContentBlock {
    type: 'text' | 'thinking';
    text?: string;
    thinking?: string;
}

/**
 * Claude API 非流式响应格式
 */
interface ClaudeResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ClaudeContentBlock[];
    model: string;
    stop_reason: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}

/**
 * Claude 流式事件格式
 */
interface ClaudeStreamEvent {
    type: string;
    index?: number;
    content_block?: ClaudeContentBlock;
    delta?: {
        type: string;
        text?: string;
    };
    message?: ClaudeResponse;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}

/**
 * Claude 适配器实现
 * 
 * 支持：
 * - Claude 3.x Haiku/Sonnet/Opus 系列
 * - Claude 4 系列
 * - 扩展思考模型：自动过滤 thinking 内容块
 */
export class ClaudeAdapter extends BaseAdapter {
    protected provider = AIProvider.CLAUDE;

    constructor(config: AdapterConfig) {
        super(config);
        if (!this.endpoint) {
            this.endpoint = DEFAULT_ENDPOINTS[AIProvider.CLAUDE];
        }
    }

    /**
     * 转换消息格式为 Claude 格式
     * 
     * Claude 的 system prompt 不在 messages 数组中，而是作为顶层 system 字段
     */
    private convertMessages(messages: ChatMessage[]): {
        messages: ClaudeMessage[];
        system?: string;
    } {
        const claudeMessages: ClaudeMessage[] = [];
        let system: string | undefined;

        for (const msg of messages) {
            if (msg.role === 'system') {
                system = msg.content;
            } else {
                claudeMessages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: msg.content
                });
            }
        }

        return { messages: claudeMessages, system };
    }

    /**
     * 从 Claude 响应内容块中提取实际回复文本（过滤思考内容）
     */
    private extractResponseText(content: ClaudeContentBlock[]): string {
        if (!content || content.length === 0) return '';

        // 仅保留 type: "text" 的内容块，过滤 type: "thinking"
        const textBlocks = content.filter(block => block.type === 'text');

        // 如果没有 text 块（极端情况），尝试从所有块提取
        if (textBlocks.length === 0) {
            return content.map(block => block.text || block.thinking || '').join('');
        }

        return textBlocks.map(block => block.text || '').join('');
    }

    /**
     * 发送聊天请求（非流式）
     */
    async chat(request: ChatRequest): Promise<ChatResponse> {
        const url = `${this.endpoint}/messages`;

        const { messages, system } = this.convertMessages(request.messages);

        const body: ClaudeRequest = {
            model: request.model,
            messages,
            max_tokens: request.maxTokens || 4096,
            temperature: request.temperature,
            stream: false
        };

        // 只有当有系统指令时才添加
        if (system) {
            body.system = system;
        }

        console.log(`[Claude] Request URL: ${url}`);
        console.log(`[Claude] Request model: ${request.model}`);

        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            console.error(`[Claude] Error response:`, JSON.stringify(errorBody));
            this.handleHttpError(response.status, errorBody);
        }

        const data = await response.json() as ClaudeResponse;

        // 使用 extractResponseText 过滤思考内容块
        const content = this.extractResponseText(data.content);

        return {
            content,
            finishReason: data.stop_reason || 'end_turn',
            usage: data.usage ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens: data.usage.input_tokens + data.usage.output_tokens
            } : undefined
        };
    }

    /**
     * 发送聊天请求（流式）
     * 
     * Claude 流式响应使用 SSE 格式，事件类型包括：
     * - message_start: 消息开始
     * - content_block_start: 内容块开始（可能是 text 或 thinking 类型）
     * - content_block_delta: 内容块增量（实际内容在 delta.text 中）
     * - content_block_stop: 内容块结束
     * - message_delta: 消息级别的增量
     * - message_stop: 消息结束
     */
    async *chatStream(request: ChatRequest): AsyncGenerator<string> {
        const url = `${this.endpoint}/messages`;

        const { messages, system } = this.convertMessages(request.messages);

        const body: ClaudeRequest = {
            model: request.model,
            messages,
            max_tokens: request.maxTokens || 4096,
            temperature: request.temperature,
            stream: true
        };

        if (system) {
            body.system = system;
        }

        console.log(`[Claude Stream] Request URL: ${url}`);
        console.log(`[Claude Stream] Request model: ${request.model}`);

        const response = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            console.error(`[Claude Stream] Error response:`, JSON.stringify(errorBody));
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
        // 跟踪当前内容块是否为思考类型
        let currentBlockIsThinking = false;

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
                        const event: ClaudeStreamEvent = JSON.parse(json);

                        switch (event.type) {
                            case 'content_block_start':
                                // 检查新内容块是否为思考类型
                                currentBlockIsThinking = event.content_block?.type === 'thinking';
                                break;

                            case 'content_block_delta':
                                // 仅 yield 非思考内容
                                if (!currentBlockIsThinking && event.delta?.text) {
                                    yield event.delta.text;
                                }
                                break;

                            case 'content_block_stop':
                                currentBlockIsThinking = false;
                                break;
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
     * 
     * Claude API 没有专门的验证端点，使用发送简单请求的方式验证
     */
    async validateApiKey(apiKey: string): Promise<boolean> {
        const url = `${this.endpoint}/messages`;

        try {
            const response = await this.fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 1
                })
            });
            // 200 表示 key 有效；400 也可能表示 key 有效但请求格式问题
            return response.ok || response.status === 400;
        } catch {
            return false;
        }
    }

    /**
     * 获取可用模型列表
     * 
     * Claude API 目前没有列出模型的端点，返回默认模型列表
     */
    async listModels(): Promise<string[]> {
        return DEFAULT_MODELS[AIProvider.CLAUDE];
    }
}
