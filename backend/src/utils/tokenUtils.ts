/**
 * TokenUtils - Token 估算工具
 *
 * 提供文本 Token 数量估算功能。
 *
 * Requirement 6.2: 提取 estimateTokens 为公共工具函数
 */

/**
 * 估算文本的 Token 数
 *
 * 简单估算规则：
 * - 中文字符约 1 字符 = 1 token
 * - 英文单词约 1 token（平均 4 字符）
 * - 标点符号约 1 token
 *
 * @param text 要估算的文本
 * @returns 估算的 Token 数
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  let tokens = 0;

  // 匹配中文字符
  const chinesePattern = /[\u4e00-\u9fa5]/g;
  const chineseChars = text.match(chinesePattern) || [];
  tokens += chineseChars.length;

  // 移除中文后计算英文单词
  const withoutChinese = text.replace(chinesePattern, ' ');
  const words = withoutChinese.split(/\s+/).filter((w) => w.length > 0);
  tokens += words.length;

  return tokens;
}

/**
 * 估算消息内容的 Token 数
 *
 * @param content 消息内容
 * @returns 估算的 Token 数
 */
export function estimateMessageTokens(content: string): number {
  // 消息还包含一些元数据开销，约 4 tokens
  return estimateTokens(content) + 4;
}

/**
 * 估算消息列表的总 Token 数
 *
 * @param messages 消息列表（每个消息需要有 content 属性）
 * @returns 估算的总 Token 数
 */
export function estimateMessagesTokens(
  messages: Array<{ content: string }>
): number {
  return messages.reduce((total, msg) => {
    return total + estimateMessageTokens(msg.content);
  }, 0);
}

/**
 * 截断文本到指定的 Token 数
 *
 * @param text 原始文本
 * @param maxTokens 最大 Token 数
 * @returns 截断后的文本
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) {
    return '';
  }

  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) {
    return text;
  }

  let tokens = 0;
  let endIndex = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // 中文字符
    if (/[\u4e00-\u9fa5]/.test(char)) {
      tokens++;
    } else if (/\s/.test(char)) {
      // 空格不计入 token
    } else {
      // 英文字符，每 4 个约 1 token
      if (i % 4 === 0) {
        tokens++;
      }
    }

    if (tokens >= maxTokens) {
      endIndex = i;
      break;
    }
    endIndex = i;
  }

  return text.substring(0, endIndex + 1) + '...';
}

export default {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  truncateToTokens,
};
