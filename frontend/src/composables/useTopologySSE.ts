/**
 * useTopologySSE — 共享 SSE 管理器 composable（单例）
 *
 * 维护到 /api/topology/stream 的单一 AuthEventSource 连接，
 * 支持多订阅者通过 subscribe/unsubscribe 模式共享事件分发。
 * 订阅者归零时自动关闭连接，新订阅者加入时自动创建连接。
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { ref, type Ref } from 'vue'
import api from '@/api'
import { createAuthEventSource, type AuthEventSourceHandle } from '@/utils/authEventSource'
import { useDeviceStore } from '@/stores/device'

// ==================== 类型定义 ====================

/** 拓扑节点（前端精简版，与后端 TopologyNode 对齐） */
export interface TopologyNode {
  id: string
  hostname: string
  ipAddresses: string[]
  macAddress: string
  deviceType: string
  stabilityTier: string
  state: string
  confirmCount?: number
  missCount?: number
  discoveredAt?: number
  lastSeenAt?: number
  sources?: string[]
  connectedTo?: string
  confidence?: number
  endpointInfo?: { displayName: string; dhcpHostname?: string; clientId?: string }
}

/** 拓扑边（前端精简版，与后端 TopologyEdge 对齐） */
export interface TopologyEdge {
  id: string
  sourceId: string
  targetId: string
  localInterface: string
  remoteInterface: string
  confidence: number
  sources: string[]
  state: string
  confirmCount?: number
  missCount?: number
  discoveredAt?: number
  lastSeenAt?: number
}

/** 拓扑差分数据 */
export interface TopologyDiff {
  id: string
  timestamp: number
  nodesAdded: TopologyNode[]
  nodesRemoved: TopologyNode[]
  edgesAdded: TopologyEdge[]
  edgesRemoved: TopologyEdge[]
  edgesUpdated: { edgeId: string; changes: Record<string, { old: unknown; new: unknown }> }[]
  nodesUpdated: { nodeId: string; changes: Record<string, { old: unknown; new: unknown }> }[]
}

// ==================== 管理器接口 ====================

export interface TopologySSEManager {
  /** 订阅拓扑更新事件，返回取消订阅函数 */
  subscribe(callback: (diff: TopologyDiff) => void): () => void
  /** 当前连接状态 */
  status: Ref<'connecting' | 'connected' | 'disconnected'>
  /** 手动关闭所有连接并清理 */
  close(): void
  /** 手动重连 */
  reconnect(): void
  /** keep-alive 停用：断开 SSE 连接 */
  deactivate(): void
  /** keep-alive 激活：重新建立连接并恢复订阅 */
  activate(): void
}

// ==================== 单例状态（模块级） ====================

type SubscriberCallback = (diff: TopologyDiff) => void

let sseHandle: AuthEventSourceHandle | null = null
const subscribers = new Set<SubscriberCallback>()
const status = ref<'connecting' | 'connected' | 'disconnected'>('disconnected')
let isDeactivated = false

// ==================== 内部函数 ====================

function getSSEUrl(): string {
  const baseUrl = api.defaults.baseURL || ''
  const deviceStore = useDeviceStore()
  const deviceId = deviceStore.currentDeviceId
  if (deviceId) {
    return `${baseUrl}/devices/${deviceId}/topology/stream`
  }
  return `${baseUrl}/topology/stream`
}

/** 将 SSE 事件分发给所有订阅者 */
function dispatchToSubscribers(diff: TopologyDiff): void {
  for (const callback of subscribers) {
    try {
      callback(diff)
    } catch (err) {
      console.warn('[useTopologySSE] Subscriber callback error:', err)
    }
  }
}

/** 创建 SSE 连接 */
function createConnection(): void {
  if (sseHandle) return // 已有连接
  if (isDeactivated) return // keep-alive 停用状态

  status.value = 'connecting'

  sseHandle = createAuthEventSource(getSSEUrl(), {
    onOpen: () => {
      status.value = 'connected'
    },
    onError: () => {
      status.value = 'disconnected'
    },
    onAuthFailed: () => {
      status.value = 'disconnected'
    },
  })

  sseHandle.addEventListener('topology-update', (event: MessageEvent) => {
    try {
      const changeEvent = JSON.parse(event.data)
      if (changeEvent?.diff) {
        dispatchToSubscribers(changeEvent.diff as TopologyDiff)
      }
    } catch (err) {
      console.warn('[useTopologySSE] Failed to parse topology-update event:', err)
    }
  })
}

/** 关闭 SSE 连接 */
function closeConnection(): void {
  if (sseHandle) {
    sseHandle.close()
    sseHandle = null
  }
  status.value = 'disconnected'
}

// ==================== 公开 API ====================

/**
 * 获取共享 SSE 管理器实例（单例）。
 *
 * 首次有订阅者时自动创建连接，所有订阅者取消后自动关闭。
 * 多次调用返回同一管理器实例。
 */
export function useTopologySSE(): TopologySSEManager {
  return manager
}

const manager: TopologySSEManager = {
  subscribe(callback: SubscriberCallback): () => void {
    subscribers.add(callback)

    // 首个订阅者 → 创建连接
    if (subscribers.size === 1 && !sseHandle) {
      createConnection()
    }

    // 返回取消订阅函数
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      subscribers.delete(callback)

      // 订阅者归零 → 自动关闭连接
      if (subscribers.size === 0) {
        closeConnection()
      }
    }
  },

  status,

  close(): void {
    closeConnection()
    subscribers.clear()
  },

  reconnect(): void {
    closeConnection()
    if (subscribers.size > 0) {
      createConnection()
    }
  },

  deactivate(): void {
    isDeactivated = true
    closeConnection()
  },

  activate(): void {
    isDeactivated = false
    if (subscribers.size > 0) {
      createConnection()
    }
  },
}

/**
 * 重置单例状态（仅用于测试）
 * @internal
 */
export function _resetTopologySSE(): void {
  closeConnection()
  subscribers.clear()
  isDeactivated = false
  status.value = 'disconnected'
}
