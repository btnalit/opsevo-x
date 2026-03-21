/**
 * Auth-aware EventSource wrapper
 *
 * Wraps native EventSource with:
 * - Automatic token refresh on suspected 401
 * - Proactive reconnect on global token:refreshed event
 * - Heartbeat timeout detection (backend sends heartbeat every 30s)
 * - Auth-related reconnects don't consume maxReconnectAttempts
 */

import { useAuthStore } from '@/stores/auth'
import { onTokenRefreshed } from '@/stores/auth'
import { isRefreshBroken } from '@/api/index'

export interface AuthEventSourceOptions {
  /** Max reconnect attempts for NON-auth errors (network etc.) */
  maxReconnectAttempts?: number
  /** Max auth retry attempts (401 heuristic) */
  maxAuthRetries?: number
  /** Heartbeat timeout in ms. Default 65000 (backend sends every 30s, allow margin) */
  heartbeatTimeoutMs?: number
  /** Called when connection is established */
  onOpen?: () => void
  /** Called on unrecoverable error */
  onError?: (event: Event) => void
  /** Called when auth refresh fails and user should re-login */
  onAuthFailed?: () => void
}

export interface AuthEventSourceHandle {
  /** The underlying EventSource (may change on reconnect) */
  getSource: () => EventSource | null
  /** Add event listener that survives reconnects */
  addEventListener: (type: string, handler: (event: MessageEvent) => void) => void
  /** Set onmessage handler that survives reconnects */
  setOnMessage: (handler: (event: MessageEvent) => void) => void
  /** Close the connection permanently */
  close: () => void
}

/**
 * Build SSE URL with current auth token as query param
 * (EventSource doesn't support custom headers)
 */
function buildSseUrl(basePath: string): string {
  const authStore = useAuthStore()
  const token = authStore.token
  const separator = basePath.includes('?') ? '&' : '?'
  return token ? `${basePath}${separator}token=${encodeURIComponent(token)}` : basePath
}

/**
 * Create an auth-aware EventSource that automatically refreshes token on 401
 * and reconnects proactively when the global token refresh event fires.
 */
export function createAuthEventSource(
  basePath: string,
  options: AuthEventSourceOptions = {}
): AuthEventSourceHandle {
  const {
    maxReconnectAttempts = 5,
    maxAuthRetries = 2,
    heartbeatTimeoutMs = 65000,
    onOpen,
    onError,
    onAuthFailed,
  } = options

  let source: EventSource | null = null
  let closed = false
  let authRetries = 0
  let reconnectAttempts = 0
  let openedAt = 0
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let currentHeartbeatTimeoutMs = heartbeatTimeoutMs
  let heartbeatReconnectAttempts = 0
  const maxHeartbeatReconnects = 3

  // Store listeners so they survive reconnects
  const eventListeners: Array<{ type: string; handler: (event: MessageEvent) => void }> = []
  let onMessageHandler: ((event: MessageEvent) => void) | null = null

  function attachListeners(es: EventSource) {
    for (const { type, handler } of eventListeners) {
      es.addEventListener(type, (ev: Event) => {
        resetHeartbeatTimeout()
        handler(ev as MessageEvent)
      })
    }
    if (onMessageHandler) {
      es.onmessage = (ev: MessageEvent) => {
        resetHeartbeatTimeout()
        onMessageHandler!(ev)
      }
    }
  }

  // ---- Heartbeat timeout ----
  function resetHeartbeatTimeout() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    if (closed) return
    heartbeatTimer = setTimeout(() => {
      if (closed) return

      // Check readyState before deciding action (Requirement 7.1)
      if (source && source.readyState === EventSource.OPEN) {
        // Connection is still open — likely UI busy or backend delayed.
        // Double the timeout and continue waiting (Requirement 7.2)
        currentHeartbeatTimeoutMs = currentHeartbeatTimeoutMs * 2
        console.warn(
          `[authEventSource] Heartbeat timeout on ${basePath}, but readyState is OPEN. ` +
          `Extending timeout to ${currentHeartbeatTimeoutMs}ms`
        )
        resetHeartbeatTimeout()
      } else {
        // Connection is NOT open — execute exponential backoff reconnect (Requirement 7.3, 7.4)
        if (heartbeatReconnectAttempts >= maxHeartbeatReconnects) {
          console.warn(
            `[authEventSource] Heartbeat reconnect limit reached (${maxHeartbeatReconnects}) on ${basePath}. Giving up.`
          )
          source?.close()
          source = null
          onError?.(new Event('error'))
          return
        }
        console.warn(
          `[authEventSource] Heartbeat timeout on ${basePath}, readyState is not OPEN. ` +
          `Reconnecting with backoff (attempt ${heartbeatReconnectAttempts + 1}/${maxHeartbeatReconnects})...`
        )
        heartbeatReconnectAttempts++
        const delay = Math.min(1000 * Math.pow(2, heartbeatReconnectAttempts - 1), 30000)
        source?.close()
        source = null
        stopHeartbeat()
        setTimeout(() => connect(), delay)
      }
    }, currentHeartbeatTimeoutMs)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  // ---- Reconnect with fresh token (used by heartbeat timeout & token refresh event) ----
  function reconnectWithFreshToken() {
    if (closed) return
    source?.close()
    source = null
    stopHeartbeat()
    // This is NOT a network error — don't consume reconnectAttempts
    connect()
  }

  function connect() {
    if (closed) return

    const url = buildSseUrl(basePath)
    source = new EventSource(url)
    openedAt = Date.now()

    attachListeners(source)

    // Set up onmessage wrapper for heartbeat reset (if no named listeners handle it)
    if (!onMessageHandler) {
      source.onmessage = () => {
        resetHeartbeatTimeout()
      }
    }

    source.onopen = () => {
      openedAt = Date.now()
      authRetries = 0
      reconnectAttempts = 0
      // Reset heartbeat timeout to default on successful (re)connect (Requirement 7.5)
      currentHeartbeatTimeoutMs = heartbeatTimeoutMs
      heartbeatReconnectAttempts = 0
      resetHeartbeatTimeout()
      onOpen?.()
    }

    source.onerror = async () => {
      if (closed) return
      stopHeartbeat()

      const timeSinceOpen = Date.now() - openedAt
      // If error happens within 3s of opening, likely a 401
      const likelyAuthError = timeSinceOpen < 3000

      if (likelyAuthError && authRetries < maxAuthRetries) {
        // 熔断检查：refresh 已失败过则不再尝试
        if (isRefreshBroken()) {
          source?.close()
          source = null
          onAuthFailed?.()
          return
        }
        authRetries++
        source?.close()
        source = null

        try {
          const authStore = useAuthStore()
          const refreshed = await authStore.refreshAccessToken()
          if (refreshed) {
            // Auth retry — does NOT consume reconnectAttempts
            setTimeout(() => connect(), 500)
            return
          }
        } catch {
          // Token refresh failed
        }

        onAuthFailed?.()
        return
      }

      // Normal SSE error (network issue etc.)
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++
        source?.close()
        source = null
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000)
        setTimeout(() => connect(), delay)
      } else {
        // Exhausted reconnect attempts
        source?.close()
        source = null
        onError?.(new Event('error'))
      }
    }

    resetHeartbeatTimeout()
  }

  // ---- Listen to global token refresh event ----
  const unsubTokenRefresh = onTokenRefreshed((_newToken: string) => {
    if (closed) return
    // 随机延迟 0-2 秒，错开多个 SSE 同时重连，避免瞬间请求风暴
    const jitter = Math.random() * 2000
    setTimeout(() => reconnectWithFreshToken(), jitter)
  })

  connect()

  return {
    getSource: () => source,
    addEventListener: (type, handler) => {
      eventListeners.push({ type, handler })
      if (source) {
        source.addEventListener(type, (ev: Event) => {
          resetHeartbeatTimeout()
          handler(ev as MessageEvent)
        })
      }
    },
    setOnMessage: (handler) => {
      onMessageHandler = handler
      if (source) {
        source.onmessage = (ev: MessageEvent) => {
          resetHeartbeatTimeout()
          handler(ev)
        }
      }
    },
    close: () => {
      closed = true
      stopHeartbeat()
      unsubTokenRefresh()
      source?.close()
      source = null
    },
  }
}
