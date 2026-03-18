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
}

export const driverApi = {
  list: () =>
    api.get<{ success: boolean; data?: Driver[]; error?: string }>('/drivers'),

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
