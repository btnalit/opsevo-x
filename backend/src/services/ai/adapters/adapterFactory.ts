/**
 * AI 提供商适配器工厂
 * 
 * 根据提供商类型创建对应的适配器实例
 */

import { AIProvider, IAIProviderAdapter } from '../../../types/ai';
import { AdapterConfig } from './baseAdapter';
import { OpenAIAdapter } from './openaiAdapter';
import { GeminiAdapter } from './geminiAdapter';
import { ClaudeAdapter } from './claudeAdapter';
import { DeepSeekAdapter } from './deepseekAdapter';
import { QwenAdapter } from './qwenAdapter';
import { ZhipuAdapter } from './zhipuAdapter';
import { CustomAdapter } from './customAdapter';

/**
 * 适配器工厂类
 */
export class AdapterFactory {
  /**
   * 创建适配器实例
   * @param provider AI 提供商类型
   * @param config 适配器配置
   * @returns 适配器实例
   */
  static createAdapter(
    provider: AIProvider,
    config: AdapterConfig
  ): IAIProviderAdapter {
    switch (provider) {
      case AIProvider.OPENAI:
        return new OpenAIAdapter(config);
      case AIProvider.GEMINI:
        return new GeminiAdapter(config);
      case AIProvider.CLAUDE:
        return new ClaudeAdapter(config);
      case AIProvider.DEEPSEEK:
        return new DeepSeekAdapter(config);
      case AIProvider.QWEN:
        return new QwenAdapter(config);
      case AIProvider.ZHIPU:
        return new ZhipuAdapter(config);
      case AIProvider.CUSTOM:
        return new CustomAdapter(config);
      default:
        throw new Error(`Unsupported AI provider: ${provider}`);
    }
  }

  /**
   * 获取支持的提供商列表
   */
  static getSupportedProviders(): AIProvider[] {
    return [
      AIProvider.OPENAI,
      AIProvider.GEMINI,
      AIProvider.CLAUDE,
      AIProvider.DEEPSEEK,
      AIProvider.QWEN,
      AIProvider.ZHIPU,
      AIProvider.CUSTOM
    ];
  }

  /**
   * 检查提供商是否支持
   */
  static isProviderSupported(provider: AIProvider): boolean {
    return this.getSupportedProviders().includes(provider);
  }
}

