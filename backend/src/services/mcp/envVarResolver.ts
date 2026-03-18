/**
 * EnvVarResolver - 环境变量解析器
 *
 * 递归扫描配置对象中所有 $ENV_VAR_NAME 格式的字符串值，
 * 替换为对应的环境变量。未定义的变量替换为空字符串并记录警告。
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

import { logger } from '../../utils/logger';

export class EnvVarResolver {
  /**
   * 递归解析对象中所有 $ENV_VAR 引用
   */
  static resolve<T>(config: T): T {
    if (config === null || config === undefined) return config;

    if (typeof config === 'string') {
      return EnvVarResolver.resolveValue(config) as unknown as T;
    }

    if (Array.isArray(config)) {
      return config.map(item => EnvVarResolver.resolve(item)) as unknown as T;
    }

    if (typeof config === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        result[key] = EnvVarResolver.resolve(value);
      }
      return result as T;
    }

    // 非字符串、非对象、非数组的原始类型直接返回
    return config;
  }

  /**
   * 解析单个字符串值
   * 匹配模式：以 $ 开头的完整字符串（如 "$API_KEY"）
   */
  static resolveValue(value: string): string {
    if (!EnvVarResolver.isEnvVarReference(value)) {
      return value;
    }

    const varName = value.substring(1); // 去掉 $ 前缀
    const envValue = process.env[varName];

    if (envValue === undefined) {
      logger.warn(`[EnvVarResolver] Environment variable not defined: ${varName}. Replacing with empty string.`);
      return '';
    }

    return envValue;
  }

  /**
   * 检查字符串是否为环境变量引用
   * 格式：以 $ 开头，后跟字母/下划线，仅包含字母、数字、下划线
   */
  static isEnvVarReference(value: string): boolean {
    return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  }
}
