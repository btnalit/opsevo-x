/**
 * useHealthData — 共享健康数据源 composable（单例）
 *
 * 维护到 /api/ai-ops/health/current 的单一 15 秒轮询定时器，
 * 提供响应式 data ref 和 onChange 订阅接口。
 * VitalSigns 直接读取 data ref，StreamOfConsciousness 通过 onChange 订阅变化。
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { ref, type Ref } from 'vue'
import api from '@/api'

// ==================== 类型定义 ====================

export interface HealthData {
  score: number
  level: string
  dimensions: { system: number; network: number; performance: number; reliability: number }
  issues: unknown[]
}

export interface HealthDataSource {
  /** 当前健康数据（响应式） */
  data: Ref<HealthData | null>
  /** 订阅数据变化事件，返回取消订阅函数 */
  onChange(callback: (data: HealthData) => void): () => void
  /** 停止轮询 */
  stop(): void
  /** 启动轮询 */
  start(): void
}

// ==================== 常量 ====================

const POLL_INTERVAL_MS = 15_000
const MAX_CONSECUTIVE_FAILURES = 3

// ==================== 单例状态（模块级） ====================

type ChangeCallback = (data: HealthData) => void

const data = ref<HealthData | null>(null)
const changeSubscribers = new Set<ChangeCallback>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0
let activeConsumers = 0
let isFetchingHealth = false

// ==================== 内部函数 ====================

/** 通知所有 onChange 订阅者 */
function notifySubscribers(healthData: HealthData): void {
  for (const callback of changeSubscribers) {
    try {
      callback(healthData)
    } catch (err) {
      console.warn('[useHealthData] Subscriber callback error:', err)
    }
  }
}

/** 从后端获取健康数据 */
async function fetchHealth(): Promise<void> {
  if (isFetchingHealth) return
  isFetchingHealth = true
  try {
    const res = await api.get('/ai-ops/health/current')
    if (res.data.success && res.data.data) {
      const d = res.data.data
      const healthData: HealthData = {
        score: d.score ?? 0,
        level: d.level ?? 'unknown',
        dimensions: {
          system: d.dimensions?.system ?? 0,
          network: d.dimensions?.network ?? 0,
          performance: d.dimensions?.performance ?? 0,
          reliability: d.dimensions?.reliability ?? 0,
        },
        issues: Array.isArray(d.issues) ? d.issues : [],
      }
      data.value = healthData
      consecutiveFailures = 0
      notifySubscribers(healthData)
    } else {
      consecutiveFailures++
    }
  } catch (error) {
    consecutiveFailures++
    console.warn('[useHealthData] Failed to fetch health data:', error)
  } finally {
    isFetchingHealth = false
  }

  // 连续失败超过阈值，降级为 unknown 状态
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const fallback: HealthData = {
      score: 0,
      level: 'unknown',
      dimensions: { system: 0, network: 0, performance: 0, reliability: 0 },
      issues: [],
    }
    data.value = fallback
    notifySubscribers(fallback)
  }
}

/** 启动轮询定时器 */
function startPolling(): void {
  activeConsumers++
  if (activeConsumers > 1) return // 已有轮询在运行

  consecutiveFailures = 0

  // 立即获取一次
  fetchHealth()

  pollTimer = setInterval(fetchHealth, POLL_INTERVAL_MS)
}

/** 停止轮询定时器 */
function stopPolling(): void {
  if (activeConsumers <= 0) return // 防止计数器变为负数

  activeConsumers--
  if (activeConsumers > 0) return // 仍有消费者，不停止

  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// ==================== 公开 API ====================

const source: HealthDataSource = {
  data,

  onChange(callback: ChangeCallback): () => void {
    changeSubscribers.add(callback)

    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      changeSubscribers.delete(callback)
    }
  },

  start(): void {
    startPolling()
  },

  stop(): void {
    stopPolling()
  },
}

/**
 * 获取共享健康数据源实例（单例）。
 *
 * 调用 start() 启动轮询，stop() 停止轮询。
 * VitalSigns 直接读取 data ref，StreamOfConsciousness 通过 onChange 订阅变化。
 */
export function useHealthData(): HealthDataSource {
  return source
}

/**
 * 重置单例状态（仅用于测试）
 * @internal
 */
export function _resetHealthData(): void {
  // 直接清除定时器，绕过引用计数逻辑，确保测试环境完全重置
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  data.value = null
  changeSubscribers.clear()
  consecutiveFailures = 0
  activeConsumers = 0
  isFetchingHealth = false
}
