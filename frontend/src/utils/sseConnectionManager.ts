/**
 * SSE 连接管理器
 * 实现 SSE 连接的心跳检测、自动重连、状态管理和数据同步
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { onTokenRefreshed } from '@/stores/auth'
import { isRefreshBroken } from '@/api/index'

// ==================== 类型定义 ====================

/**
 * SSE 连接配置
 * Requirements: 7.5
 */
export interface SSEConnectionConfig {
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatIntervalMs: number
  /** 重连延迟（毫秒），默认 1000 */
  reconnectDelayMs: number
  /** 最大重连次数，默认 5 */
  maxReconnectAttempts: number
  /** 退避乘数，默认 2 */
  reconnectBackoffMultiplier: number
  /** 心跳超时（毫秒），默认 heartbeatIntervalMs * 2 */
  heartbeatTimeoutMs?: number
  /** 是否启用自动重连，默认 true */
  enableAutoReconnect?: boolean
}

/**
 * SSE 连接状态
 * Requirements: 7.3
 */
export type SSEConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

/**
 * SSE 消息类型
 */
export interface SSEMessage<T = unknown> {
  type: string
  data: T
  timestamp: number
  id?: string
}

/**
 * 状态变化回调
 */
export type StateChangeCallback = (state: SSEConnectionState, previousState: SSEConnectionState) => void

/**
 * 消息回调
 */
export type MessageCallback<T = unknown> = (data: T) => void

/**
 * 错误回调
 */
export type ErrorCallback = (error: Error) => void

/**
 * 重连回调
 */
export type ReconnectCallback = (attempt: number, maxAttempts: number) => void

/**
 * SSE 连接管理器接口
 * Requirements: 7.1, 7.2, 7.3
 */
export interface ISSEConnectionManager {
  connect(url: string, options?: RequestInit): void
  disconnect(): void
  getState(): SSEConnectionState
  getConfig(): SSEConnectionConfig
  updateConfig(config: Partial<SSEConnectionConfig>): void
  onStateChange(callback: StateChangeCallback): () => void
  onMessage<T = unknown>(callback: MessageCallback<T>): () => void
  onError(callback: ErrorCallback): () => void
  onReconnect(callback: ReconnectCallback): () => void
  getLastMessageTime(): number | null
  getReconnectAttempts(): number
  isConnected(): boolean
}

// ==================== 默认配置 ====================

/**
 * 默认 SSE 连接配置
 * Requirements: 7.5
 */
export const DEFAULT_SSE_CONFIG: SSEConnectionConfig = {
  heartbeatIntervalMs: 30000,
  reconnectDelayMs: 1000,
  maxReconnectAttempts: 5,
  reconnectBackoffMultiplier: 2,
  enableAutoReconnect: true
}

// ==================== SSE 连接管理器实现 ====================

/**
 * SSE 连接管理器
 * 实现心跳检测、自动重连、状态管理
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
export class SSEConnectionManager implements ISSEConnectionManager {
  private config: SSEConnectionConfig
  private state: SSEConnectionState = 'disconnected'
  private url: string | null = null
  private requestOptions: RequestInit | null = null
  private abortController: AbortController | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  // 回调管理
  private stateChangeCallbacks: Set<StateChangeCallback> = new Set()
  private messageCallbacks: Set<MessageCallback> = new Set()
  private errorCallbacks: Set<ErrorCallback> = new Set()
  private reconnectCallbacks: Set<ReconnectCallback> = new Set()

  // 心跳和重连状态
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private lastMessageTime: number | null = null
  private lastEventId: string | null = null

  // 网络状态监听
  private networkOnlineHandler: (() => void) | null = null
  private networkOfflineHandler: (() => void) | null = null

  // Token 刷新事件取消订阅函数
  private unsubTokenRefresh: (() => void) | null = null

  constructor(config: Partial<SSEConnectionConfig> = {}) {
    this.config = { ...DEFAULT_SSE_CONFIG, ...config }
    if (!this.config.heartbeatTimeoutMs) {
      this.config.heartbeatTimeoutMs = this.config.heartbeatIntervalMs * 2
    }
    this.setupNetworkListeners()
    this.setupTokenRefreshListener()
  }

  /**
   * 设置网络状态监听器
   * Requirements: 7.6
   */
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return

    this.networkOnlineHandler = () => {
      if (this.state === 'disconnected' || this.state === 'error') {
        this.handleNetworkRecovery()
      }
    }

    this.networkOfflineHandler = () => {
      if (this.state === 'connected' || this.state === 'connecting') {
        this.handleNetworkLoss()
      }
    }

    window.addEventListener('online', this.networkOnlineHandler)
    window.addEventListener('offline', this.networkOfflineHandler)
  }

  /**
   * 监听全局 token 刷新事件
   * token 刷新后用新 token 重建连接，不消耗 reconnectAttempts
   */
  private setupTokenRefreshListener(): void {
    this.unsubTokenRefresh = onTokenRefreshed((newToken: string) => {
      if (!this.url || this.state === 'disconnected') return

      // 更新 requestOptions 中的 Authorization 头
      if (this.requestOptions) {
        const headers = (this.requestOptions.headers || {}) as Record<string, string>
        headers['Authorization'] = `Bearer ${newToken}`
        this.requestOptions = { ...this.requestOptions, headers }
      }

      // 如果当前已连接或正在重连，用新 token 重建连接
      if (this.state === 'connected' || this.state === 'reconnecting' || this.state === 'error') {
        this.cleanup()
        this.reconnectAttempts = 0 // Auth recovery — reset counter
        this.doConnect()
      }
    })
  }

  /**
   * 移除网络状态监听器
   */
  private removeNetworkListeners(): void {
    if (typeof window === 'undefined') return

    if (this.networkOnlineHandler) {
      window.removeEventListener('online', this.networkOnlineHandler)
    }
    if (this.networkOfflineHandler) {
      window.removeEventListener('offline', this.networkOfflineHandler)
    }
  }

  /**
   * 处理网络恢复
   * Requirements: 7.6
   */
  private handleNetworkRecovery(): void {
    if (this.url && this.config.enableAutoReconnect) {
      // 重置重连计数，因为这是网络恢复
      this.reconnectAttempts = 0
      this.scheduleReconnect()
    }
  }

  /**
   * 处理网络断开
   */
  private handleNetworkLoss(): void {
    this.setState('disconnected')
    this.cleanup()
  }

  /**
   * 连接到 SSE 端点
   * Requirements: 7.1
   */
  connect(url: string, options?: RequestInit): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      this.disconnect()
    }

    this.url = url
    this.requestOptions = options || null
    this.reconnectAttempts = 0
    this.doConnect()
  }

  /**
   * 执行实际连接
   */
  private async doConnect(): Promise<void> {
    if (!this.url) return

    this.setState('connecting')
    this.abortController = new AbortController()

    try {
      const headers: HeadersInit = {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...(this.requestOptions?.headers || {})
      }

      // 如果有上次的事件 ID，添加到请求头以支持数据同步
      if (this.lastEventId) {
        ;(headers as Record<string, string>)['Last-Event-ID'] = this.lastEventId
      }

      const response = await fetch(this.url, {
        ...this.requestOptions,
        headers,
        signal: this.abortController.signal
      })

      if (!response.ok) {
        // Handle 401 specifically - attempt token refresh
        if (response.status === 401) {
          // 熔断检查：refresh 已失败过则不再尝试
          if (isRefreshBroken()) {
            this.setState('error')
            this.errorCallbacks.forEach(cb => {
              try { cb(new Error('认证已过期，请重新登录')) } catch {}
            })
            return
          }
          try {
            const { useAuthStore } = await import('@/stores/auth')
            const authStore = useAuthStore()
            const refreshed = await authStore.refreshAccessToken()
            if (refreshed && this.reconnectAttempts < 2) {
              // 刷新 token 后更新 requestOptions 中的 Authorization 头
              if (this.requestOptions) {
                const newToken = authStore.token
                if (newToken) {
                  const headers = (this.requestOptions.headers || {}) as Record<string, string>
                  headers['Authorization'] = `Bearer ${newToken}`
                  this.requestOptions = { ...this.requestOptions, headers }
                }
              }
              this.reconnectAttempts++
              setTimeout(() => this.doConnect(), 300)
              return
            }
          } catch {
            // Token refresh failed
          }
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      if (!response.body) {
        throw new Error('Response body is null')
      }

      this.reader = response.body.getReader()
      this.setState('connected')
      this.reconnectAttempts = 0
      this.startHeartbeat()
      this.processStream()
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return // 正常取消，不处理
      }
      this.handleConnectionError(error as Error)
    }
  }

  /**
   * 处理 SSE 流
   */
  private async processStream(): Promise<void> {
    if (!this.reader) return

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await this.reader.read()
        if (done) {
          // 流正常结束，尝试重连
          this.handleStreamEnd()
          break
        }

        buffer += decoder.decode(value, { stream: true })
        this.processBuffer(buffer)
        buffer = this.getUnprocessedBuffer(buffer)
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        this.handleConnectionError(error as Error)
      }
    }
  }

  /**
   * 处理缓冲区中的 SSE 消息
   */
  private processBuffer(buffer: string): void {
    const lines = buffer.split('\n')

    let eventType = 'message'
    let eventData = ''
    let eventId: string | undefined

    for (const line of lines) {
      if (line === '') {
        // 空行表示事件结束
        if (eventData) {
          this.handleMessage(eventType, eventData, eventId)
          eventType = 'message'
          eventData = ''
          eventId = undefined
        }
        continue
      }

      if (line.startsWith(':')) {
        // 心跳注释
        this.resetHeartbeatTimeout()
        continue
      }

      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        eventData = eventData ? eventData + '\n' + data : data
      } else if (line.startsWith('id:')) {
        eventId = line.slice(3).trim()
        this.lastEventId = eventId
      }
    }
  }

  /**
   * 获取未处理的缓冲区内容
   */
  private getUnprocessedBuffer(buffer: string): string {
    const lastNewline = buffer.lastIndexOf('\n\n')
    if (lastNewline === -1) {
      return buffer
    }
    return buffer.slice(lastNewline + 2)
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(type: string, data: string, id?: string): void {
    this.lastMessageTime = Date.now()
    this.resetHeartbeatTimeout()

    try {
      const parsedData = JSON.parse(data)
      const message: SSEMessage = {
        type,
        data: parsedData,
        timestamp: this.lastMessageTime,
        id
      }

      this.messageCallbacks.forEach(callback => {
        try {
          callback(message)
        } catch (e) {
          console.error('SSE message callback error:', e)
        }
      })
    } catch {
      // 如果不是 JSON，直接传递原始数据
      const message: SSEMessage<string> = {
        type,
        data,
        timestamp: this.lastMessageTime,
        id
      }

      this.messageCallbacks.forEach(callback => {
        try {
          callback(message)
        } catch (e) {
          console.error('SSE message callback error:', e)
        }
      })
    }
  }

  /**
   * 处理流结束
   */
  private handleStreamEnd(): void {
    if (this.state === 'connected' && this.config.enableAutoReconnect) {
      this.scheduleReconnect()
    }
  }

  /**
   * 处理连接错误
   */
  private handleConnectionError(error: Error): void {
    this.errorCallbacks.forEach(callback => {
      try {
        callback(error)
      } catch (e) {
        console.error('SSE error callback error:', e)
      }
    })

    if (this.config.enableAutoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect()
    } else {
      this.setState('error')
    }
  }

  /**
   * 启动心跳检测
   * Requirements: 7.1
   */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.resetHeartbeatTimeout()
  }

  /**
   * 停止心跳检测
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }
  }

  /**
   * 重置心跳超时
   */
  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
    }

    this.heartbeatTimeoutTimer = setTimeout(() => {
      this.handleHeartbeatTimeout()
    }, this.config.heartbeatTimeoutMs || this.config.heartbeatIntervalMs * 2)
  }

  /**
   * 处理心跳超时
   * Requirements: 7.1
   */
  private handleHeartbeatTimeout(): void {
    if (this.state === 'connected') {
      // 心跳超时，触发重连
      this.cleanup()
      if (this.config.enableAutoReconnect) {
        this.scheduleReconnect()
      } else {
        this.setState('error')
      }
    }
  }

  /**
   * 调度重连
   * Requirements: 7.2, 7.4
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.setState('error')
      return
    }

    this.setState('reconnecting')
    this.reconnectAttempts++

    // 通知重连回调
    this.reconnectCallbacks.forEach(callback => {
      try {
        callback(this.reconnectAttempts, this.config.maxReconnectAttempts)
      } catch (e) {
        console.error('SSE reconnect callback error:', e)
      }
    })

    // 计算指数退避延迟
    const delay = this.config.reconnectDelayMs *
      Math.pow(this.config.reconnectBackoffMultiplier, this.reconnectAttempts - 1)

    this.reconnectTimer = setTimeout(() => {
      this.doConnect()
    }, delay)
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.cleanup()
    this.setState('disconnected')
    this.url = null
    this.requestOptions = null
    this.lastEventId = null
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.stopHeartbeat()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    if (this.reader) {
      try {
        this.reader.cancel().catch(() => {
          // 忽略取消错误（abort 后 stream 可能已处于 errored 状态）
        })
      } catch {
        // 忽略同步取消错误
      }
      this.reader = null
    }
  }

  /**
   * 设置状态
   * Requirements: 7.3
   */
  private setState(newState: SSEConnectionState): void {
    if (this.state === newState) return

    const previousState = this.state
    this.state = newState

    this.stateChangeCallbacks.forEach(callback => {
      try {
        callback(newState, previousState)
      } catch (e) {
        console.error('SSE state change callback error:', e)
      }
    })
  }

  /**
   * 获取当前状态
   */
  getState(): SSEConnectionState {
    return this.state
  }

  /**
   * 获取配置
   * Requirements: 7.5
   */
  getConfig(): SSEConnectionConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   * Requirements: 7.5
   */
  updateConfig(config: Partial<SSEConnectionConfig>): void {
    this.config = { ...this.config, ...config }
    if (config.heartbeatIntervalMs && !config.heartbeatTimeoutMs) {
      this.config.heartbeatTimeoutMs = config.heartbeatIntervalMs * 2
    }
  }

  /**
   * 注册状态变化回调
   * Requirements: 7.3
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeCallbacks.add(callback)
    return () => {
      this.stateChangeCallbacks.delete(callback)
    }
  }

  /**
   * 注册消息回调
   */
  onMessage<T = unknown>(callback: MessageCallback<T>): () => void {
    this.messageCallbacks.add(callback as MessageCallback)
    return () => {
      this.messageCallbacks.delete(callback as MessageCallback)
    }
  }

  /**
   * 注册错误回调
   */
  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.add(callback)
    return () => {
      this.errorCallbacks.delete(callback)
    }
  }

  /**
   * 注册重连回调
   * Requirements: 7.2
   */
  onReconnect(callback: ReconnectCallback): () => void {
    this.reconnectCallbacks.add(callback)
    return () => {
      this.reconnectCallbacks.delete(callback)
    }
  }

  /**
   * 获取最后消息时间
   */
  getLastMessageTime(): number | null {
    return this.lastMessageTime
  }

  /**
   * 获取重连尝试次数
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.state === 'connected'
  }

  /**
   * 销毁管理器
   */
  destroy(): void {
    this.disconnect()
    this.removeNetworkListeners()
    if (this.unsubTokenRefresh) {
      this.unsubTokenRefresh()
      this.unsubTokenRefresh = null
    }
    this.stateChangeCallbacks.clear()
    this.messageCallbacks.clear()
    this.errorCallbacks.clear()
    this.reconnectCallbacks.clear()
  }
}

// ==================== 工厂函数 ====================

/**
 * 创建 SSE 连接管理器实例
 */
export function createSSEConnectionManager(
  config?: Partial<SSEConnectionConfig>
): ISSEConnectionManager {
  return new SSEConnectionManager(config)
}

// ==================== 导出默认实例 ====================

export default SSEConnectionManager
