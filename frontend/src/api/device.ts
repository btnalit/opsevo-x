/**
 * Device API - 设备管理相关 API 调用
 * Requirements: 7.3, 7.4, 7.5, A10.44-48
 */

import api from './index'

// ==================== 类型定义 ====================

export interface Device {
  id: string
  tenant_id: string
  name: string
  host: string
  port: number
  username: string
  use_tls: number
  status: 'online' | 'offline' | 'connecting' | 'error'
  tags: string
  group_name: string | null
  driver_type?: 'api' | 'ssh' | 'snmp'
  profile_id?: string
  last_seen: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface CreateDeviceRequest {
  name: string
  host: string
  port?: number
  username: string
  password: string
  useTLS?: boolean
  tags?: string[]
  groupName?: string
  driverType?: 'api' | 'ssh' | 'snmp'
  profileId?: string
}

export interface UpdateDeviceRequest {
  name?: string
  host?: string
  port?: number
  username?: string
  password?: string
  useTLS?: boolean
  tags?: string[]
  groupName?: string
  driverType?: 'api' | 'ssh' | 'snmp'
  profileId?: string
}

export interface DeviceListResponse {
  success: boolean
  data?: Device[]
  error?: string
}

export interface DeviceResponse {
  success: boolean
  data?: Device
  error?: string
}

// ==================== 新增类型 ====================

export interface DeviceSummary {
  total: number
  online: number
  offline: number
  connecting: number
  avg_health_score: number
}

export interface OrchestratorStatus {
  running: boolean
  uptime_s: number
  last_health_cycle: string | null
  last_metrics_cycle: string | null
  registry_size: number
}

export interface DeviceMetrics {
  cpu?: number
  memory?: number
  uptime?: number
  interfaces?: Array<{
    name: string
    status: string
    rxBytes: number
    txBytes: number
    rxErrors: number
    txErrors: number
  }>
  timestamp?: string
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  latency?: number
  lastCheck?: string
  details?: Record<string, unknown>
}

export interface Driver {
  type: string
  name: string
  version: string
  status: 'active' | 'inactive' | 'error'
  capabilities?: string[]
}

export interface CapabilityManifest {
  operations: string[]
  supportedMetrics: string[]
  commandPatterns?: Array<{ name: string; description: string }>
}

export interface DriverProfile {
  name: string
  driver_type: 'api' | 'ssh' | 'snmp'
  vendor: string
  model: string
  label: string
}

export interface ApiProfile {
  id: string
  name: string
  targetSystem: string
  version: string
  endpoints?: Record<string, unknown>
  auth?: Record<string, unknown>
  created_at?: string
  updated_at?: string
}

// ==================== API 调用 ====================

export const deviceApi = {
  list: () =>
    api.get<DeviceListResponse>('/devices'),

  create: (data: CreateDeviceRequest) =>
    api.post<DeviceResponse>('/devices', data),

  get: (id: string) =>
    api.get<DeviceResponse>(`/devices/${id}`),

  update: (id: string, data: UpdateDeviceRequest) =>
    api.put<DeviceResponse>(`/devices/${id}`, data),

  delete: (id: string) =>
    api.delete<{ success: boolean; error?: string }>(`/devices/${id}`),

  connect: (id: string) =>
    api.post<DeviceResponse>(`/devices/${id}/connect`),

  disconnect: (id: string) =>
    api.post<DeviceResponse>(`/devices/${id}/disconnect`),

  getMetrics: (id: string) =>
    api.get<{ success: boolean; data?: DeviceMetrics; error?: string }>(`/devices/${id}/metrics`),

  getHealth: (id: string) =>
    api.get<{ success: boolean; data?: HealthCheckResult; error?: string }>(`/devices/${id}/health`),

  testConnection: (id: string) =>
    api.post<{ success: boolean; data?: { latency: number }; error?: string }>(`/devices/${id}/test-connection`),

  execute: (id: string, payload: Record<string, unknown>) =>
    api.post<{ success: boolean; data?: unknown; error?: string }>(`/devices/${id}/execute`, payload),

  /** 获取设备聚合摘要（来自 DeviceOrchestrator） */
  getSummary: () =>
    api.get<{ success: boolean; data?: DeviceSummary; error?: string }>('/devices/summary'),

  /** 获取编排器运行状态 */
  getOrchestratorStatus: () =>
    api.get<{ success: boolean; data?: OrchestratorStatus; error?: string }>('/devices/orchestrator/status'),

  /** SSE 设备生命周期事件流 */
  streamDeviceEvents: (
    onMessage: (event: { type: string; device_id?: string; [key: string]: unknown }) => void,
    onError?: (error: unknown) => void,
  ): AbortController => {
    const controller = new AbortController()
    const baseURL = api.defaults.baseURL || ''
    const url = `${baseURL}/devices/events/stream`

    const token = localStorage.getItem('auth_token')
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    fetch(url, {
      signal: controller.signal,
      credentials: 'include',
      headers,
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          onError?.(new Error(`SSE connect failed: ${response.status}`))
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (data.type !== 'ping' && data.type !== 'connected') {
                  onMessage(data)
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') onError?.(err)
      })

    return controller
  },
}

export const driverApi = {
  list: () =>
    api.get<{ success: boolean; data?: Driver[]; error?: string }>('/drivers'),

  listProfiles: () =>
    api.get<{ success: boolean; data?: DriverProfile[]; error?: string }>('/drivers/profiles'),

  getManifest: (type: string) =>
    api.get<{ success: boolean; data?: CapabilityManifest; error?: string }>(`/drivers/${type}/manifest`),
}

export const profileApi = {
  list: () =>
    api.get<{ success: boolean; data?: ApiProfile[]; error?: string }>('/profiles'),

  create: (data: Partial<ApiProfile>) =>
    api.post<{ success: boolean; data?: ApiProfile; error?: string }>('/profiles', data),

  get: (id: string) =>
    api.get<{ success: boolean; data?: ApiProfile; error?: string }>(`/profiles/${id}`),

  update: (id: string, data: Partial<ApiProfile>) =>
    api.put<{ success: boolean; data?: ApiProfile; error?: string }>(`/profiles/${id}`, data),

  delete: (id: string) =>
    api.delete<{ success: boolean; error?: string }>(`/profiles/${id}`),

  import: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post<{ success: boolean; data?: ApiProfile; error?: string }>('/profiles/import', formData)
  },

  export: (id: string) =>
    api.get<Blob>(`/profiles/${id}/export`, { responseType: 'blob' }),
}
