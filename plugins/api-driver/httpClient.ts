/**
 * ApiHttpClient — HTTP 客户端封装
 *
 * 支持超时、重试、TLS、日志。
 *
 * Requirements: A2.8
 */

import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import type { HttpRequestConfig, HttpResponse } from './types';

export class ApiHttpClient {
  private client: AxiosInstance;
  private retries: number;

  constructor(options: {
    baseURL: string;
    timeout?: number;
    retries?: number;
    tls?: { rejectUnauthorized?: boolean };
    headers?: Record<string, string>;
  }) {
    const https = options.tls?.rejectUnauthorized === false
      ? require('https')
      : undefined;

    this.retries = options.retries ?? 2;
    this.client = axios.create({
      baseURL: options.baseURL,
      timeout: options.timeout ?? 30000,
      headers: options.headers,
      ...(https ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}),
    });
  }

  setHeader(name: string, value: string): void {
    this.client.defaults.headers.common[name] = value;
  }

  async request(config: HttpRequestConfig): Promise<HttpResponse> {
    const axiosConfig: AxiosRequestConfig = {
      method: config.method as any,
      url: config.url,
      headers: config.headers,
      data: config.body,
      timeout: config.timeout,
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const resp = await this.client.request(axiosConfig);
        return {
          status: resp.status,
          headers: resp.headers as Record<string, string>,
          data: resp.data,
        };
      } catch (err: any) {
        lastError = err;
        if (attempt < this.retries && this.isRetryable(err)) {
          await this.delay(Math.pow(2, attempt) * 500);
          continue;
        }
        break;
      }
    }
    throw lastError;
  }

  private isRetryable(err: any): boolean {
    if (!err.response) return true; // network error
    const status = err.response?.status;
    return status === 429 || status >= 500;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
