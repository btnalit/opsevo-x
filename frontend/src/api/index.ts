import axios from 'axios'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import { useDeviceStore } from '@/stores/device'

const api = axios.create({
  baseURL: '/api',
})

// Flag to prevent multiple simultaneous token refresh attempts
let isRefreshing = false
let failedQueue: Array<{
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}> = []

function processQueue(error: Error | null, token: string | null = null) {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error)
    } else {
      prom.resolve(token)
    }
  })
  failedQueue = []
}

/**
 * Paths that should be rewritten to include device ID prefix.
 * These are device-scoped API paths.
 */
const DEVICE_SCOPED_PREFIXES = [
  '/interfaces',
  '/ip',
  '/ipv6',
  '/system',
  '/dashboard',
  '/firewall',
  '/container',
  '/ai',
  '/monitoring',
]

/**
 * Paths that should NOT be rewritten even if they match a prefix.
 * These are platform-level paths that don't target a specific device.
 */
const NON_DEVICE_PREFIXES = [
  '/auth',
  '/connection',
  '/devices',
  '/drivers',
  '/profiles',
  '/ai-ops',
  '/ai/configs',
  '/ai/providers',
  '/prompt-templates',
  '/skills',
  '/monitoring/overview',
  '/topology',
]

/**
 * Check if a URL path needs device context (device ID prefix).
 */
function needsDeviceContext(url: string | undefined): boolean {
  if (!url) return false

  // Strip the baseURL /api prefix if present for matching
  const path = url.startsWith('/api') ? url.substring(4) : url

  // Check non-device paths first (higher priority)
  for (const prefix of NON_DEVICE_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')) {
      return false
    }
  }

  // Check if it matches a device-scoped prefix
  for (const prefix of DEVICE_SCOPED_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')) {
      return true
    }
  }

  return false
}

// Request interceptor - attach JWT token and rewrite device-scoped URLs
api.interceptors.request.use(
  (config) => {
    try {
      const authStore = useAuthStore()
      if (authStore.token) {
        config.headers.Authorization = `Bearer ${authStore.token}`
      }
    } catch {
      // Store might not be initialized yet, ignore
    }

    // Rewrite device-scoped URLs: /xxx → /devices/:deviceId/xxx
    try {
      const deviceStore = useDeviceStore()
      if (deviceStore.currentDeviceId && needsDeviceContext(config.url)) {
        config.url = `/devices/${deviceStore.currentDeviceId}${config.url}`
      }
    } catch {
      // Store might not be initialized yet, ignore
    }

    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor - update connection status and handle 401
api.interceptors.response.use(
  (response) => {
    // If API call succeeds and returns data, connection is working
    // Only update for non-connection endpoints to avoid circular updates
    const url = response.config.url || ''
    if (!url.includes('/connection/') && !url.includes('/auth/')) {
      try {
        const connectionStore = useConnectionStore()
        // If we get a successful response from device-related endpoints, we're connected
        if (response.data?.success !== false) {
          connectionStore.setConnected(true)
        }
      } catch {
        // Store might not be initialized yet, ignore
      }
    }
    return response
  },
  async (error) => {
    const originalRequest = error.config

    // Handle 401 Unauthorized - attempt token refresh
    if (error.response?.status === 401 && !originalRequest._retry) {
      // Don't try to refresh for auth endpoints themselves
      const url = originalRequest.url || ''
      if (url.includes('/auth/')) {
        return Promise.reject(error)
      }

      if (isRefreshing) {
        // Queue this request while refresh is in progress
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject })
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`
          return api(originalRequest)
        }).catch((err) => {
          return Promise.reject(err)
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        const authStore = useAuthStore()
        const success = await authStore.refreshAccessToken()
        if (success) {
          const newToken = authStore.token
          processQueue(null, newToken)
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          return api(originalRequest)
        } else {
          processQueue(new Error('刷新令牌失败'), null)
          authStore.logout()
          return Promise.reject(new Error('认证已过期，请重新登录'))
        }
      } catch (refreshError) {
        processQueue(new Error('刷新令牌失败'), null)
        try {
          const authStore = useAuthStore()
          authStore.logout()
        } catch {
          // ignore
        }
        return Promise.reject(new Error('认证已过期，请重新登录'))
      } finally {
        isRefreshing = false
      }
    }

    // Check if error indicates connection issue
    const message = error.response?.data?.error || error.message || 'Request failed'
    const lowerMessage = message.toLowerCase()

    // If error indicates connection is lost, update store
    if (lowerMessage.includes('not connected') ||
      lowerMessage.includes('连接已断开') ||
      lowerMessage.includes('connection') && lowerMessage.includes('closed')) {
      try {
        const connectionStore = useConnectionStore()
        connectionStore.setConnected(false)
      } catch {
        // Store might not be initialized yet, ignore
      }
    }

    return Promise.reject(new Error(message))
  }
)

export default api


