/**
 * AIOps Enhanced API - 增强视图所需的额外 API 调用
 * Requirements: B.2, E6.17-21, F5.24-25, G6.19-23, H5.19-20, I7.25
 */

import api from './index'

// ==================== Brain Loop API ====================

export const brainApi = {
  getStatus: () =>
    api.get<{ success: boolean; data?: { state: string; tickCount: number; avgTickDuration: number; queueDepth: number; lastTickAt?: string }; error?: string }>('/ai-ops/brain/status'),

  getRecentEvents: (limit = 20) =>
    api.get<{ success: boolean; data?: Array<{ id: string; type: string; priority: string; source: string; timestamp: number; summary?: string }>; error?: string }>(`/ai-ops/brain/events?limit=${limit}`),

  getMetrics: () =>
    api.get<{ success: boolean; data?: { tickCount: number; avgTickDuration: number; queueDepth: number; uptime: number }; error?: string }>('/ai-ops/brain/metrics'),
}

// ==================== Decision API ====================

export const decisionApi = {
  getHistory: (ruleId?: string) =>
    api.get<{ success: boolean; data?: Array<{ id: string; ruleId: string; ruleName: string; action: string; result: string; timestamp: number }>; error?: string }>(`/ai-ops/decisions/history${ruleId ? `?ruleId=${ruleId}` : ''}`),

  adjustWeights: (ruleId: string, weights: Record<string, number>) =>
    api.put<{ success: boolean; error?: string }>(`/ai-ops/decisions/rules/${ruleId}/weights`, weights),
}

// ==================== Service Health API ====================

export const serviceHealthApi = {
  getServiceHealth: () =>
    api.get<{ success: boolean; data?: Array<{ name: string; status: string; latency?: number; lastCheck?: string }>; error?: string }>('/ai-ops/health/services'),

  getDegradationStatus: () =>
    api.get<{ success: boolean; data?: Array<{ service: string; level: string; reason: string; since: string }>; error?: string }>('/ai-ops/health/degradation'),
}


// ==================== Knowledge API ====================

export const knowledgeEnhancedApi = {
  semanticSearch: (query: string) =>
    api.post<{ success: boolean; data?: Array<{ id: string; text: string; score: number; metadata: Record<string, unknown> }>; error?: string }>('/ai-ops/knowledge/semantic-search', { query }),

  getGraphNodes: (type?: string) =>
    api.get<{ success: boolean; data?: Array<{ id: string; label: string; type: string; connections: number }>; error?: string }>(`/ai-ops/knowledge-graph/nodes${type ? `?type=${type}` : ''}`),

  getGraphStats: () =>
    api.get<{ success: boolean; data?: { totalNodes: number; totalEdges: number; categories: Record<string, number> }; error?: string }>('/ai-ops/knowledge/stats'),
}

// ==================== Skill Enhanced API ====================

export const skillEnhancedApi = {
  listCapsules: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; name: string; version: string; runtime: string; status: string; capabilities: string[] }>; error?: string }>('/ai-ops/skills/capsules'),

  listMcpTools: () =>
    api.get<{ success: boolean; data?: Array<{ name: string; description: string; server: string; inputSchema?: Record<string, unknown> }>; error?: string }>('/ai-ops/mcp/tools'),

  getExecutionHistory: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; skillName: string; intent: string; result: string; duration: number; timestamp: number }>; error?: string }>('/ai-ops/skills/history'),

  listApiKeys: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; name: string; role: string; createdAt: string; lastUsedAt?: string; status: string }>; error?: string }>('/ai-ops/api-keys'),

  createApiKey: (data: { name: string; role: string }) =>
    api.post<{ success: boolean; data?: { id: string; key: string; name: string }; error?: string }>('/ai-ops/api-keys', data),

  deleteApiKey: (id: string) =>
    api.delete<{ success: boolean; error?: string }>(`/ai-ops/api-keys/${id}`),
}

// ==================== Evolution Enhanced API ====================

export const evolutionEnhancedApi = {
  getLearningHistory: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; type: string; description: string; timestamp: number; result?: string }>; error?: string }>('/ai-ops/evolution/learning-history'),

  getKnowledgeStats: () =>
    api.get<{ success: boolean; data?: { totalEntries: number; categories: Record<string, number>; avgScore: number }; error?: string }>('/ai-ops/evolution/knowledge-stats'),
}

// ==================== Fault Patterns Enhanced API ====================

export const faultEnhancedApi = {
  getPendingPatterns: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; name: string; description: string; detectedAt: string; confidence: number }>; error?: string }>('/ai-ops/fault-patterns/pending'),

  getMatchingCases: (patternId: string) =>
    api.get<{ success: boolean; data?: Array<{ id: string; eventId: string; matchedAt: string; similarity: number }>; error?: string }>(`/ai-ops/fault-patterns/${patternId}/cases`),

  getRepairHistory: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; patternName: string; action: string; result: string; timestamp: number }>; error?: string }>('/ai-ops/repairs/history'),
}

// ==================== Inspection API ====================

export const inspectionApi = {
  listTasks: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; name: string; schedule: string; enabled: boolean; lastRun?: string }>; error?: string }>('/ai-ops/inspections/tasks'),

  createTask: (data: { name: string; schedule: string; targets: string[] }) =>
    api.post<{ success: boolean; data?: { id: string }; error?: string }>('/ai-ops/inspections/tasks', data),

  getHistory: () =>
    api.get<{ success: boolean; data?: Array<{ id: string; taskName: string; status: string; startedAt: string; completedAt?: string; findings: number }>; error?: string }>('/ai-ops/inspections/history'),
}

// ==================== Notification Enhanced API ====================

export const notificationEnhancedApi = {
  testChannel: (id: string) =>
    api.post<{ success: boolean; data?: { sent: boolean; message?: string }; error?: string }>(`/ai-ops/notifications/channels/${id}/test`, {}),

  getHistory: (params?: { channelId?: string; limit?: number }) =>
    api.get<{ success: boolean; data?: Array<{ id: string; channelName: string; type: string; status: string; sentAt: string; subject?: string }>; error?: string }>('/ai-ops/notifications/history', { params }),
}
