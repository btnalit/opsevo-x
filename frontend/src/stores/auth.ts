/**
 * Auth Store - 认证状态管理
 * 
 * 使用 Pinia 管理用户认证状态（token、refreshToken、user）
 * 持久化到 localStorage
 *
 * 主动续期：在 access token 过期前自动刷新，确保长连接（SSE）不会因 token 过期而断开。
 * 全局事件：token 刷新后广播 'auth:token-refreshed' 事件，SSE 连接可监听此事件用新 token 重连。
 * 并发去重：多个模块同时触发 refreshAccessToken() 时，只执行一次实际刷新请求。
 *
 * Requirements: 7.7
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi, type AuthUser } from '@/api/auth'
import { resetRefreshState } from '@/api/index'
import router from '@/router'

const TOKEN_KEY = 'auth_token'
const REFRESH_TOKEN_KEY = 'auth_refresh_token'
const USER_KEY = 'auth_user'

// ==================== 全局 Token 事件总线 ====================
// SSE 连接层监听此事件，在 token 刷新后用新 token 重建连接

type TokenEventHandler = (newToken: string) => void
const tokenRefreshedHandlers = new Set<TokenEventHandler>()

/** 注册 token 刷新事件监听器，返回取消注册函数 */
export function onTokenRefreshed(handler: TokenEventHandler): () => void {
  tokenRefreshedHandlers.add(handler)
  return () => { tokenRefreshedHandlers.delete(handler) }
}

/** 广播 token 已刷新事件 */
function emitTokenRefreshed(newToken: string): void {
  tokenRefreshedHandlers.forEach(handler => {
    try { handler(newToken) } catch (e) { console.error('[auth] token-refreshed handler error:', e) }
  })
}

// ==================== JWT 解析工具 ====================

/** 从 JWT 中提取 exp（秒级时间戳），解析失败返回 null */
function getTokenExp(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

// ==================== 并发刷新去重 ====================
// 多个 SSE 连接 + axios 拦截器可能同时触发 refresh，只执行一次

let refreshPromise: Promise<boolean> | null = null

export const useAuthStore = defineStore('auth', () => {
  // ==================== 状态 ====================
  const token = ref<string>('')
  const refreshToken = ref<string>('')
  const user = ref<AuthUser | null>(null)
  const loading = ref(false)

  // 主动续期定时器
  let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null

  // ==================== 计算属性 ====================
  const isAuthenticated = computed(() => !!token.value)
  const currentUser = computed(() => user.value)
  const tenantId = computed(() => user.value?.tenantId || '')

  // ==================== 方法 ====================

  /**
   * 从 localStorage 加载认证状态
   */
  function loadFromStorage(): void {
    const savedToken = localStorage.getItem(TOKEN_KEY)
    const savedRefreshToken = localStorage.getItem(REFRESH_TOKEN_KEY)
    const savedUser = localStorage.getItem(USER_KEY)

    if (savedToken) {
      token.value = savedToken
    }
    if (savedRefreshToken) {
      refreshToken.value = savedRefreshToken
    }
    if (savedUser) {
      try {
        user.value = JSON.parse(savedUser)
      } catch {
        user.value = null
      }
    }

    // 加载后立即调度主动续期
    scheduleProactiveRefresh()
  }

  /**
   * 保存认证状态到 localStorage
   */
  function saveToStorage(): void {
    if (token.value) {
      localStorage.setItem(TOKEN_KEY, token.value)
    } else {
      localStorage.removeItem(TOKEN_KEY)
    }
    if (refreshToken.value) {
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken.value)
    } else {
      localStorage.removeItem(REFRESH_TOKEN_KEY)
    }
    if (user.value) {
      localStorage.setItem(USER_KEY, JSON.stringify(user.value))
    } else {
      localStorage.removeItem(USER_KEY)
    }
  }

  /**
   * 调度主动续期定时器
   * 在 access token 过期前 2 分钟自动刷新，确保 SSE 长连接不会因 token 过期而断开。
   * 如果无法解析 exp，回退到 12 分钟后刷新（access token 默认 15 分钟）。
   */
  function scheduleProactiveRefresh(): void {
    if (proactiveRefreshTimer) {
      clearTimeout(proactiveRefreshTimer)
      proactiveRefreshTimer = null
    }

    if (!token.value || !refreshToken.value) return

    const exp = getTokenExp(token.value)
    let delayMs: number

    if (exp) {
      // 在过期前 2 分钟刷新
      const msUntilExpiry = exp * 1000 - Date.now()
      delayMs = Math.max(msUntilExpiry - 2 * 60 * 1000, 5000) // 至少 5 秒后
    } else {
      // 无法解析 exp，回退到 12 分钟
      delayMs = 12 * 60 * 1000
    }

    proactiveRefreshTimer = setTimeout(async () => {
      if (!token.value || !refreshToken.value) return
      const success = await refreshAccessToken()
      if (!success) {
        // 主动续期失败，不立即登出——等下一次 API 请求的 401 拦截器处理
        console.warn('[auth] Proactive token refresh failed')
      }
    }, delayMs)
  }

  /**
   * 用户登录
   */
  async function login(username: string, password: string): Promise<void> {
    loading.value = true
    try {
      const response = await authApi.login({ username, password })
      if (response.data.success && response.data.data) {
        token.value = response.data.data.token
        refreshToken.value = response.data.data.refreshToken
        user.value = response.data.data.user
        saveToStorage()
        scheduleProactiveRefresh()
        resetRefreshState()
      } else {
        throw new Error(response.data.error || '登录失败')
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * 用户注册
   */
  async function register(username: string, email: string, password: string, invitationCode: string): Promise<void> {
    loading.value = true
    try {
      const response = await authApi.register({ username, email, password, invitationCode })
      // 兼容两种响应格式：
      // 1. 标准格式: { success: true, data: { ... } }
      // 2. 旧格式 (Stale Backend): { user: { ... } }
      // @ts-ignore - 临时忽略类型检查以支持旧格式
      const isLegacySuccess = response.data && response.data.user;

      if (!response.data.success && !isLegacySuccess) {
        throw new Error(response.data.error || '注册失败')
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * 刷新访问令牌（带并发去重）
   * 多个模块同时调用时只执行一次实际请求，其余等待同一个 Promise。
   * 刷新成功后广播 'auth:token-refreshed' 事件。
   * @returns 是否刷新成功
   */
  async function refreshAccessToken(): Promise<boolean> {
    if (!refreshToken.value) {
      return false
    }

    // 并发去重：如果已有刷新请求在进行中，等待它的结果
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = doRefresh()
    try {
      return await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  /** 实际执行刷新请求 */
  async function doRefresh(): Promise<boolean> {
    try {
      const response = await authApi.refresh(refreshToken.value)
      if (response.data.success && response.data.data) {
        token.value = response.data.data.token
        refreshToken.value = response.data.data.refreshToken
        saveToStorage()
        scheduleProactiveRefresh()
        // 广播给所有 SSE 连接
        emitTokenRefreshed(token.value)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * 用户登出
   */
  function logout(): void {
    if (proactiveRefreshTimer) {
      clearTimeout(proactiveRefreshTimer)
      proactiveRefreshTimer = null
    }
    token.value = ''
    refreshToken.value = ''
    user.value = null
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    router.push('/login')
  }

  return {
    // 状态
    token,
    refreshToken,
    user,
    loading,
    // 计算属性
    isAuthenticated,
    currentUser,
    tenantId,
    // 方法
    loadFromStorage,
    login,
    register,
    refreshAccessToken,
    logout,
  }
})
