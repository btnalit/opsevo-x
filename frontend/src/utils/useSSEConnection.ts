/**
 * SSE 连接 Vue Composable
 * 提供响应式的 SSE 连接状态管理
 *
 * Requirements: 7.1, 7.2, 7.3, 7.5, 7.6
 */

import { ref, computed, onUnmounted, type Ref } from 'vue'
import {
  SSEConnectionManager,
  type SSEConnectionConfig,
  type SSEConnectionState,
  type SSEMessage,
} from './sseConnectionManager'

/**
 * SSE 连接 Composable 选项
 */
export interface UseSSEConnectionOptions {
  /** 连接配置 */
  config?: Partial<SSEConnectionConfig>
  /** 是否自动连接 */
  autoConnect?: boolean
  /** 连接 URL */
  url?: string
  /** 请求选项 */
  requestOptions?: RequestInit
}

/**
 * SSE 连接 Composable 返回值
 */
export interface UseSSEConnectionReturn {
  /** 当前连接状态 */
  state: Ref<SSEConnectionState>
  /** 是否已连接 */
  isConnected: Ref<boolean>
  /** 是否正在重连 */
  isReconnecting: Ref<boolean>
  /** 是否有错误 */
  hasError: Ref<boolean>
  /** 重连尝试次数 */
  reconnectAttempts: Ref<number>
  /** 最大重连次数 */
  maxReconnectAttempts: Ref<number>
  /** 最后消息时间 */
  lastMessageTime: Ref<number | null>
  /** 最后错误 */
  lastError: Ref<Error | null>
  /** 连接到指定 URL */
  connect: (url: string, options?: RequestInit) => void
  /** 断开连接 */
  disconnect: () => void
  /** 更新配置 */
  updateConfig: (config: Partial<SSEConnectionConfig>) => void
  /** 注册消息处理器 */
  onMessage: <T = unknown>(handler: (message: SSEMessage<T>) => void) => () => void
  /** 获取连接管理器实例 */
  getManager: () => SSEConnectionManager
}

/**
 * SSE 连接 Composable
 * 提供响应式的 SSE 连接状态管理
 *
 * @example
 * ```vue
 * <script setup>
 * import { useSSEConnection } from '@/utils/useSSEConnection'
 *
 * const {
 *   state,
 *   isConnected,
 *   isReconnecting,
 *   reconnectAttempts,
 *   connect,
 *   disconnect,
 *   onMessage
 * } = useSSEConnection({
 *   config: { maxReconnectAttempts: 10 }
 * })
 *
 * // 连接到 SSE 端点
 * connect('/api/events')
 *
 * // 监听消息
 * onMessage((message) => {
 *   console.log('Received:', message)
 * })
 * </script>
 * ```
 */
export function useSSEConnection(options: UseSSEConnectionOptions = {}): UseSSEConnectionReturn {
  const {
    config = {},
    autoConnect = false,
    url,
    requestOptions
  } = options

  // 创建连接管理器
  const manager = new SSEConnectionManager(config)

  // 响应式状态
  const state = ref<SSEConnectionState>('disconnected')
  const reconnectAttempts = ref(0)
  const lastMessageTime = ref<number | null>(null)
  const lastError = ref<Error | null>(null)

  // 计算属性
  const isConnected = computed(() => state.value === 'connected')
  const isReconnecting = computed(() => state.value === 'reconnecting')
  const hasError = computed(() => state.value === 'error')
  const maxReconnectAttempts = computed(() => manager.getConfig().maxReconnectAttempts)

  // 注册状态变化回调
  manager.onStateChange((newState) => {
    state.value = newState
    reconnectAttempts.value = manager.getReconnectAttempts()
  })

  // 注册错误回调
  manager.onError((error) => {
    lastError.value = error
  })

  // 注册重连回调
  manager.onReconnect((attempt) => {
    reconnectAttempts.value = attempt
  })

  // 注册消息回调以更新最后消息时间
  manager.onMessage(() => {
    lastMessageTime.value = manager.getLastMessageTime()
  })

  // 连接方法
  const connect = (connectUrl: string, connectOptions?: RequestInit) => {
    lastError.value = null
    manager.connect(connectUrl, connectOptions)
  }

  // 断开连接方法
  const disconnect = () => {
    manager.disconnect()
  }

  // 更新配置方法
  const updateConfig = (newConfig: Partial<SSEConnectionConfig>) => {
    manager.updateConfig(newConfig)
  }

  // 消息处理器注册
  const onMessage = <T = unknown>(handler: (message: SSEMessage<T>) => void): (() => void) => {
    return manager.onMessage(handler)
  }

  // 获取管理器实例
  const getManager = () => manager

  // 自动连接
  if (autoConnect && url) {
    connect(url, requestOptions)
  }

  // 组件卸载时清理
  onUnmounted(() => {
    manager.destroy()
  })

  return {
    state,
    isConnected,
    isReconnecting,
    hasError,
    reconnectAttempts,
    maxReconnectAttempts,
    lastMessageTime,
    lastError,
    connect,
    disconnect,
    updateConfig,
    onMessage,
    getManager
  }
}

/**
 * 获取连接状态的显示文本
 */
export function getConnectionStateText(state: SSEConnectionState): string {
  const stateTexts: Record<SSEConnectionState, string> = {
    connecting: '连接中...',
    connected: '已连接',
    reconnecting: '重连中...',
    disconnected: '已断开',
    error: '连接错误'
  }
  return stateTexts[state] || '未知状态'
}

/**
 * 获取连接状态的颜色类型（用于 Element Plus）
 */
export function getConnectionStateType(state: SSEConnectionState): 'success' | 'warning' | 'danger' | 'info' {
  const stateTypes: Record<SSEConnectionState, 'success' | 'warning' | 'danger' | 'info'> = {
    connecting: 'warning',
    connected: 'success',
    reconnecting: 'warning',
    disconnected: 'info',
    error: 'danger'
  }
  return stateTypes[state] || 'info'
}

export default useSSEConnection
