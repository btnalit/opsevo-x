/**
 * Perception API - 感知源管理相关 API 调用
 * Requirements: D5.31-34
 */

import api from './index'

// ==================== 类型定义 ====================

export interface SyslogStatus {
  running: boolean
  udpPort: number
  tcpPort: number
  messageCount: number
}

export interface SyslogSource {
  id: string
  source_ip: string
  source_cidr?: string
  device_id?: string
  description?: string
  created_at: string
}

export interface SyslogParseRule {
  id: string
  name: string
  pattern: string
  type: 'regex' | 'grok'
  priority: number
  enabled: boolean
}

export interface SyslogFilter {
  id: string
  name: string
  source_ip?: string
  facility?: string
  severity?: number
  keyword?: string
  action: 'accept' | 'drop'
}

export interface SnmpTrapStatus {
  running: boolean
  port: number
  trapCount: number
}

export interface OidMapping {
  id: string
  oid: string
  name: string
  event_type: string
  priority: string
  description?: string
}

export interface SnmpV3Credential {
  id: string
  security_name: string
  auth_protocol: string
  priv_protocol: string
  device_id?: string
}

export interface PerceptionSource {
  name: string
  type: string
  status: 'active' | 'inactive'
  eventCount: number
  lastEvent?: string
}

export interface PerceptionStats {
  totalEvents: number
  eventsByType: Record<string, number>
  queueDepth: number
}

// ==================== API 调用 ====================

export const syslogApi = {
  getStatus: () =>
    api.get<{ success: boolean; data?: SyslogStatus; error?: string }>('/ai-ops/syslog/status'),

  listSources: () =>
    api.get<{ success: boolean; data?: SyslogSource[]; error?: string }>('/ai-ops/syslog/sources'),

  createSource: (data: Partial<SyslogSource>) =>
    api.post<{ success: boolean; data?: SyslogSource; error?: string }>('/ai-ops/syslog/sources', data),

  updateSource: (id: string, data: Partial<SyslogSource>) =>
    api.put<{ success: boolean; data?: SyslogSource; error?: string }>(`/ai-ops/syslog/sources/${id}`, data),

  deleteSource: (id: string) =>
    api.delete<{ success: boolean; error?: string }>(`/ai-ops/syslog/sources/${id}`),

  listRules: () =>
    api.get<{ success: boolean; data?: SyslogParseRule[]; error?: string }>('/ai-ops/syslog/rules'),

  createRule: (data: Partial<SyslogParseRule>) =>
    api.post<{ success: boolean; data?: SyslogParseRule; error?: string }>('/ai-ops/syslog/rules', data),

  updateRule: (id: string, data: Partial<SyslogParseRule>) =>
    api.put<{ success: boolean; data?: SyslogParseRule; error?: string }>(`/ai-ops/syslog/rules/${id}`, data),

  deleteRule: (id: string) =>
    api.delete<{ success: boolean; error?: string }>(`/ai-ops/syslog/rules/${id}`),

  testRule: (id: string, message: string) =>
    api.post<{ success: boolean; data?: { matched: boolean; result?: Record<string, string> }; error?: string }>(
      `/ai-ops/syslog/rules/${id}/test`, { message }
    ),

  listFilters: () =>
    api.get<{ success: boolean; data?: SyslogFilter[]; error?: string }>('/ai-ops/syslog/filters'),

  createFilter: (data: Partial<SyslogFilter>) =>
    api.post<{ success: boolean; data?: SyslogFilter; error?: string }>('/ai-ops/syslog/filters', data),
}

export const snmpTrapApi = {
  getStatus: () =>
    api.get<{ success: boolean; data?: SnmpTrapStatus; error?: string }>('/ai-ops/snmp-trap/status'),

  listOidMappings: () =>
    api.get<{ success: boolean; data?: OidMapping[]; error?: string }>('/ai-ops/snmp-trap/oid-mappings'),

  createOidMapping: (data: Partial<OidMapping>) =>
    api.post<{ success: boolean; data?: OidMapping; error?: string }>('/ai-ops/snmp-trap/oid-mappings', data),

  updateOidMapping: (id: string, data: Partial<OidMapping>) =>
    api.put<{ success: boolean; data?: OidMapping; error?: string }>(`/ai-ops/snmp-trap/oid-mappings/${id}`, data),

  deleteOidMapping: (id: string) =>
    api.delete<{ success: boolean; error?: string }>(`/ai-ops/snmp-trap/oid-mappings/${id}`),

  listV3Credentials: () =>
    api.get<{ success: boolean; data?: SnmpV3Credential[]; error?: string }>('/ai-ops/snmp-trap/v3-credentials'),

  createV3Credential: (data: Partial<SnmpV3Credential>) =>
    api.post<{ success: boolean; data?: SnmpV3Credential; error?: string }>('/ai-ops/snmp-trap/v3-credentials', data),
}

export const perceptionApi = {
  getSources: () =>
    api.get<{ success: boolean; data?: PerceptionSource[]; error?: string }>('/ai-ops/perception/sources'),

  getStats: () =>
    api.get<{ success: boolean; data?: PerceptionStats; error?: string }>('/ai-ops/perception/stats'),
}
