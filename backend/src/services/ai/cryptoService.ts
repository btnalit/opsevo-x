/**
 * CryptoService - API Key 加密解密服务
 *
 * 使用 AES-256 加密算法对 API Keys 进行加密存储
 * 实现 ICryptoService 接口
 *
 * Requirements: 1.3, 6.1
 */

import CryptoJS from 'crypto-js';
import { ICryptoService } from '../../types/ai';

/**
 * 加密服务配置
 */
interface CryptoConfig {
  /** 加密密钥（应从环境变量获取） */
  secretKey: string;
}

/**
 * 默认加密密钥（生产环境应使用环境变量覆盖）
 */
const DEFAULT_SECRET_KEY =
  process.env.AI_CRYPTO_SECRET_KEY || 'routeros-web-manager-ai-agent-secret-key-2024';

/**
 * CryptoService 实现类
 *
 * 提供 AES-256 加密解密功能，用于安全存储 API Keys
 */
export class CryptoService implements ICryptoService {
  private readonly secretKey: string;

  /**
   * 创建 CryptoService 实例
   * @param config 加密配置（可选）
   */
  constructor(config?: Partial<CryptoConfig>) {
    this.secretKey = config?.secretKey || DEFAULT_SECRET_KEY;
  }

  /**
   * 加密明文字符串
   *
   * 使用 AES-256 加密算法，返回 Base64 编码的密文
   *
   * @param plainText 要加密的明文
   * @returns 加密后的密文（Base64 编码）
   * @throws Error 如果明文为空
   */
  encrypt(plainText: string): string {
    if (!plainText) {
      throw new Error('Cannot encrypt empty string');
    }

    const encrypted = CryptoJS.AES.encrypt(plainText, this.secretKey);
    return encrypted.toString();
  }

  /**
   * 解密密文字符串
   *
   * 解密 AES-256 加密的 Base64 编码密文
   *
   * @param cipherText 要解密的密文（Base64 编码）
   * @returns 解密后的明文
   * @throws Error 如果密文为空或解密失败
   */
  decrypt(cipherText: string): string {
    if (!cipherText) {
      throw new Error('Cannot decrypt empty string');
    }

    const decrypted = CryptoJS.AES.decrypt(cipherText, this.secretKey);
    const plainText = decrypted.toString(CryptoJS.enc.Utf8);

    if (!plainText) {
      throw new Error('Decryption failed: invalid ciphertext or wrong key');
    }

    return plainText;
  }
}

/**
 * 默认 CryptoService 单例实例
 */
export const cryptoService = new CryptoService();

export default cryptoService;
