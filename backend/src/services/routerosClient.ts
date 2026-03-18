/**
 * RouterOS API Client
 * 使用 node-routeros 库通过 RouterOS API 协议通信
 * 端口 8728 (普通) / 8729 (SSL)
 */

import { RouterOSAPI, RosException } from 'node-routeros';
import { Mutex } from 'async-mutex';
import { RouterOSConfig } from '../types';
import { logger } from '../utils/logger';

export class RouterOSClient {
  private api: RouterOSAPI | null = null;
  private config: RouterOSConfig | null = null;
  private connected: boolean = false;

  // 连接操作锁 - 保护 connect/disconnect 操作
  private connectionMutex = new Mutex();
  // API 操作锁 - 保护 print/add/set/remove 等操作
  private operationMutex = new Mutex();

  /**
   * 建立与 RouterOS 的连接
   * @param config 连接配置
   * @returns 连接是否成功
   */
  async connect(config: RouterOSConfig): Promise<boolean> {
    // 使用连接锁保护，防止并发连接
    return await this.connectionMutex.runExclusive(async () => {
      try {
        // 如果已经连接到相同的设备，直接返回成功
        if (this.api && this.connected && this.config) {
          if (this.config.host === config.host &&
            this.config.port === config.port &&
            this.config.username === config.username) {
            // 验证连接是否仍然有效
            try {
              if (this.api.connected) {
                logger.info('Already connected to the same device, reusing connection');
                return true;
              }
            } catch {
              // 连接可能已断开，继续重新连接
            }
          }
        }

        // 如果已有连接，先断开
        if (this.api) {
          try {
            this.api.close();
          } catch {
            // 忽略
          }
          this.api = null;
        }

        // 创建 RouterOS API 客户端
        this.api = new RouterOSAPI({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          tls: config.useTLS ? {
            rejectUnauthorized: false,
          } : undefined,
          keepalive: true,
        });

        // 监听连接关闭事件
        this.api.on('close', () => {
          logger.warn('RouterOS connection closed');
          this.connected = false;
        });

        this.api.on('error', (err) => {
          logger.error('RouterOS connection error:', err);
          this.connected = false;
        });

        // 建立连接 - 增加超时保护 (Requirements: 2.3)
        const CONNECT_TIMEOUT = 10000; // 10 秒超时
        await Promise.race([
          this.api.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), CONNECT_TIMEOUT)
          )
        ]);

        // 测试连接 - 获取系统资源信息
        const result = await this.api.write('/system/resource/print');
        logger.info('Connection test successful, resources:', result?.length || 0);

        this.config = config;
        this.connected = true;
        logger.info(`Connected to RouterOS at ${config.host}:${config.port}`);
        return true;
      } catch (error) {
        this.connected = false;
        if (this.api) {
          try {
            this.api.close();
          } catch {
            // 忽略关闭错误
          }
        }
        this.api = null;
        this.config = null;

        const errorMessage = this.parseError(error);
        logger.error(`Failed to connect to RouterOS: ${errorMessage}`);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * 断开与 RouterOS 的连接
   */
  async disconnect(): Promise<void> {
    // 使用连接锁保护，防止并发断开
    await this.connectionMutex.runExclusive(async () => {
      if (this.api) {
        try {
          this.api.close();
        } catch {
          // 忽略关闭错误
        }
      }
      this.api = null;
      this.config = null;
      this.connected = false;
      logger.info('Disconnected from RouterOS');
    });
  }

  /**
   * 检查是否已连接
   * @returns 连接状态
   */
  isConnected(): boolean {
    if (!this.api || !this.connected) {
      return false;
    }
    // 检查 api 的 connected 属性（如果存在）
    try {
      return this.api.connected === true;
    } catch {
      return this.connected;
    }
  }

  /**
   * 获取当前连接配置
   * @returns 连接配置（不含密码）
   */
  getConfig(): Omit<RouterOSConfig, 'password'> | null {
    if (!this.config) return null;
    const { password, ...safeConfig } = this.config;
    return safeConfig;
  }

  /**
   * 执行 print 命令获取资源列表
   * @param path API 路径，如 /interface
   * @param query 可选的查询参数
   * @param options 可选的高级选项
   * @returns 响应数据数组
   */
  async print<T>(path: string, query?: Record<string, string>, options?: {
    /** 指定返回的字段列表，如 ['name', 'address', 'interface'] */
    proplist?: string[];
    /** 限制返回的记录数量 */
    limit?: number;
    /** 分页偏移量 */
    offset?: number;
  }): Promise<T[]> {
    // 读操作不使用独占锁：node-routeros 底层使用 tag-based 多路复用，
    // 支持并发读取。独占锁会导致多个 device_query 串行化，
    // 与 ConcurrencyLimiter 的 queueTimeout 叠加造成超时。
    // 写操作（add/set/remove/execute）仍保留独占锁以保证安全。
    this.ensureConnected();
    try {
      const command = `${path}/print`;
      const params: string[] = [];

      // 添加 .proplist 参数（指定返回字段）
      if (options?.proplist && options.proplist.length > 0) {
        params.push(`=.proplist=${options.proplist.join(',')}`);
      }

      if (query) {
        Object.entries(query).forEach(([key, value]) => {
          params.push(`?${key}=${value}`);
        });
      }

      logger.info(`Executing command: ${command}, params: ${JSON.stringify(params)}`);
      let response = await this.api!.write(command, params);

      // 详细记录响应信息用于调试
      logger.info(`Response raw: ${JSON.stringify(response)}`);
      logger.info(`Response type: ${typeof response}, isArray: ${Array.isArray(response)}`);

      // node-routeros 返回的是数组
      if (!response) {
        logger.warn('Response is null/undefined, returning empty array');
        return [];
      }

      // 确保返回数组
      let result: T[];
      if (Array.isArray(response)) {
        result = response as T[];
      } else if (typeof response === 'object') {
        // 如果是单个对象，包装成数组
        logger.warn('Response is object, wrapping in array');
        result = [response as T];
      } else {
        logger.warn(`Unexpected response type: ${typeof response}, returning empty array`);
        return [];
      }

      // 应用分页（RouterOS API 不直接支持 limit/offset，需要在客户端实现）
      if (options?.offset !== undefined && options.offset > 0) {
        result = result.slice(options.offset);
      }
      if (options?.limit !== undefined && options.limit > 0) {
        result = result.slice(0, options.limit);
      }

      logger.info(`Returning ${result.length} items (after pagination: offset=${options?.offset || 0}, limit=${options?.limit || 'unlimited'})`);
      return result;
    } catch (error: unknown) {
      // 处理 RouterOS 返回 !empty 的情况（表示没有数据）
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error as { errno?: string };
      if (errorMessage.includes('!empty') ||
        errorMessage.includes('UNKNOWNREPLY') ||
        errorObj?.errno === 'UNKNOWNREPLY') {
        logger.info('RouterOS returned empty result, returning empty array');
        return [];
      }

      const errMsg = this.parseError(error);
      logger.error(`Print command failed: ${errMsg}`);

      // 如果是连接断开，更新状态
      if (errMsg.includes('连接') || errMsg.includes('connect') || errMsg.includes('closed') || errMsg.includes('socket')) {
        this.connected = false;
      }
      throw new Error(errMsg);
    }
  }

  /**
   * 获取单个资源
   * @param path API 路径
   * @param id 资源 ID
   * @returns 响应数据
   */
  async getById<T>(path: string, id: string): Promise<T | null> {
    // 使用操作锁保护，防止并发 API 调用
    return await this.operationMutex.runExclusive(async () => {
      return this._getByIdInternal<T>(path, id);
    });
  }

  /**
   * 内部获取单个资源方法（不加锁，供其他已加锁方法调用）
   * @param path API 路径
   * @param id 资源 ID
   * @returns 响应数据
   */
  private async _getByIdInternal<T>(path: string, id: string): Promise<T | null> {
    this.ensureConnected();
    try {
      const command = `${path}/print`;
      // RouterOS API 查询语法：?.id=*1
      const response = await this.api!.write(command, [`?.id=${id}`]);

      if (!response) return null;
      if (Array.isArray(response) && response.length > 0) {
        return response[0] as T;
      }
      return null;
    } catch (error: unknown) {
      // 处理 RouterOS 返回 !empty 的情况（表示没有数据）
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error as { errno?: string };
      if (errorMessage.includes('!empty') ||
        errorMessage.includes('UNKNOWNREPLY') ||
        errorObj?.errno === 'UNKNOWNREPLY') {
        return null;
      }
      throw new Error(this.parseError(error));
    }
  }

  /**
   * 添加新资源
   * @param path API 路径
   * @param data 资源数据
   * @returns 新资源
   */
  async add<T>(path: string, data: Record<string, unknown>): Promise<T> {
    // 使用操作锁保护，防止并发 API 调用
    return await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        const command = `${path}/add`;
        const params = this.objectToParams(data);
        logger.info(`Add command: ${command}, params: ${JSON.stringify(params)}`);
        const response = await this.api!.write(command, params);
        logger.info(`Add response: ${JSON.stringify(response)}`);

        // 返回新创建的资源
        if (response && Array.isArray(response) && response.length > 0 && response[0].ret) {
          const newId = response[0].ret;
          const created = await this._getByIdInternal<T>(path, newId);
          if (created) return created;
        }

        // 如果没有返回 ID，尝试返回响应
        if (response && Array.isArray(response) && response.length > 0) {
          return response[0] as T;
        }

        return {} as T;
      } catch (error) {
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 更新资源
   * @param path API 路径
   * @param id 资源 ID
   * @param data 更新数据
   * @returns 更新后的资源
   */
  async set<T>(path: string, id: string, data: Record<string, unknown>): Promise<T> {
    // 使用操作锁保护，防止并发 API 调用
    return await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        const command = `${path}/set`;
        const params = [`=.id=${id}`, ...this.objectToParams(data)];
        await this.api!.write(command, params);

        // 返回更新后的资源
        const updated = await this._getByIdInternal<T>(path, id);
        if (!updated) {
          throw new Error('资源不存在或已被删除');
        }
        return updated;
      } catch (error) {
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 删除资源
   * @param path API 路径
   * @param id 资源 ID
   */
  async remove(path: string, id: string): Promise<void> {
    // 使用操作锁保护，防止并发 API 调用
    await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        const command = `${path}/remove`;
        await this.api!.write(command, [`=.id=${id}`]);
      } catch (error) {
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 启用资源
   * @param path API 路径
   * @param id 资源 ID
   */
  async enable(path: string, id: string): Promise<void> {
    // 使用操作锁保护，防止并发 API 调用
    await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        const command = `${path}/enable`;
        await this.api!.write(command, [`=.id=${id}`]);
      } catch (error) {
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 禁用资源
   * @param path API 路径
   * @param id 资源 ID
   */
  async disable(path: string, id: string): Promise<void> {
    // 使用操作锁保护，防止并发 API 调用
    await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        const command = `${path}/disable`;
        await this.api!.write(command, [`=.id=${id}`]);
      } catch (error) {
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 运行脚本
   * @param id 脚本 ID
   */
  async runScript(id: string): Promise<void> {
    // 使用操作锁保护，防止并发 API 调用
    await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        await this.api!.write('/system/script/run', [`=.id=${id}`]);
      } catch (error) {
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 执行自定义命令
   * @param command 完整的命令路径，如 /container/start
   * @param params 命令参数
   */
  async execute(command: string, params: string[] = []): Promise<void> {
    // 使用操作锁保护，防止并发 API 调用
    await this.operationMutex.runExclusive(async () => {
      this.ensureConnected();
      try {
        logger.info(`Executing command: ${command}, params: ${JSON.stringify(params)}`);
        await this.api!.write(command, params);
      } catch (error: unknown) {
        // 处理 RouterOS 返回 !empty 的情况（某些命令成功执行但无返回）
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorObj = error as { errno?: string };
        if (errorMessage.includes('!empty') ||
          errorMessage.includes('UNKNOWNREPLY') ||
          errorObj?.errno === 'UNKNOWNREPLY') {
          logger.info('Command executed successfully (empty response)');
          return;
        }
        throw new Error(this.parseError(error));
      }
    });
  }

  /**
   * 执行原始命令并返回结果
   * 直接透传命令到 RouterOS，返回原始响应或错误
   * @param command API 格式的命令路径，如 /ip/address/print
   * @param params 命令参数数组
   * @returns 命令执行结果
   */
  async executeRaw(command: string, params: string[] = []): Promise<unknown> {
    this.ensureConnected();
    try {
      logger.info(`Executing raw command: ${command}, params: ${JSON.stringify(params)}`);
      const response = await this.api!.write(command, params);
      logger.info(`Raw command response: ${JSON.stringify(response)}`);
      return response;
    } catch (error: any) {
      // 处理 RouterOS 返回 !empty 的情况（某些命令成功执行但无返回）
      const errorMessage = error?.message || String(error);
      if (errorMessage.includes('!empty') ||
        errorMessage.includes('UNKNOWNREPLY') ||
        error?.errno === 'UNKNOWNREPLY') {
        logger.info('Raw command executed successfully (empty response)');
        return [];
      }
      // 直接抛出原始错误信息，不做翻译
      throw error;
    }
  }

  /**
   * 确保已连接
   */
  private ensureConnected(): void {
    if (!this.api || !this.connected) {
      this.connected = false;
      throw new Error('Not connected to RouterOS');
    }
    // 额外检查 api.connected
    try {
      if (this.api.connected === false) {
        this.connected = false;
        throw new Error('Not connected to RouterOS');
      }
    } catch {
      // 忽略属性访问错误
    }
  }

  /**
   * 自动重连：如果连接已断开但仍持有配置，尝试重新建立连接。
   * 用于全局单例在连接因 idle/TCP reset 断开后自愈。
   * @returns 重连是否成功（已连接时直接返回 true）
   */
  async ensureConnectedOrReconnect(): Promise<boolean> {
    // 快速路径：已连接
    if (this.isConnected()) return true;

    // 无配置 → 从未连接过，无法自愈
    if (!this.config) {
      logger.warn('[RouterOSClient] Cannot auto-reconnect: no previous config stored.');
      return false;
    }

    logger.info(`[RouterOSClient] Connection lost, attempting auto-reconnect to ${this.config.host}:${this.config.port}...`);
    try {
      // connect() 内部有 connectionMutex 保护，并发安全
      await this.connect(this.config);
      logger.info('[RouterOSClient] Auto-reconnect successful.');
      return true;
    } catch (err) {
      logger.error(`[RouterOSClient] Auto-reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 将对象转换为 API 参数格式
   * 注意：空字符串会被正确传递给 RouterOS 以清除字段值
   */
  private objectToParams(data: Record<string, unknown>): string[] {
    const params: string[] = [];
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        // 保持原始 key 格式（RouterOS 使用 kebab-case）
        // 空字符串也需要传递，用于清除字段值（如 comment）
        params.push(`=${key}=${String(value)}`);
      }
    });
    return params;
  }

  /**
   * 解析错误信息
   * @param error 错误对象
   * @returns 错误消息
   */
  private parseError(error: unknown): string {
    if (error instanceof RosException) {
      const message = error.message.toLowerCase();

      if (message.includes('cannot log in') || message.includes('invalid user')) {
        return '用户名或密码错误';
      }
      if (message.includes('no such command') || message.includes('no such item')) {
        return '命令不存在或资源未找到';
      }

      return error.message;
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('econnrefused')) {
        return '无法连接到 RouterOS，请检查网络和端口';
      }
      if (message.includes('etimedout') || message.includes('timeout')) {
        return '连接超时，请检查地址和端口';
      }
      if (message.includes('enotfound')) {
        return '无法解析主机地址';
      }
      if (message.includes('cannot log in') || message.includes('invalid user') || message.includes('login failure')) {
        return '用户名或密码错误';
      }
      if (message.includes('handshake') || message.includes('ssl') || message.includes('tls') || message.includes('eproto')) {
        return 'TLS 握手失败，请检查 SSL 配置';
      }
      if (message.includes('not connected') || message.includes('socket') || message.includes('closed')) {
        return '连接已断开，请重新连接';
      }

      return error.message;
    }

    return '未知错误';
  }
}

// 导出单例实例
export const routerosClient = new RouterOSClient();
