/**
 * topoDataTransform — 后端 TopologyNode/Edge → G6 NodeData/EdgeData 转换
 *
 * 包含节点样式计算（deviceType→颜色、state→透明度/发光）
 * 包含边样式计算（state/confidence→虚实线/颜色/透明度）
 * 包含节点/边 tooltip 格式化函数
 *
 * Requirements: 1.2, 1.11, 1.12, 2.3, 2.4, 2.5, 2.6, 9.1, 9.2, 9.3, 9.4
 */

import type { TopologyNode, TopologyEdge } from '@/composables/useTopologySSE'

// ==================== G6 数据类型 ====================

/** G6 节点数据 */
export interface G6NodeData {
  id: string
  data: {
    hostname: string
    ipAddresses: string[]
    macAddress: string
    deviceType: string
    state: string
    stabilityTier: string
    endpointInfo?: { displayName: string; dhcpHostname?: string; clientId?: string }
  }
  style: {
    opacity: number
    shadowBlur: number
    shadowColor: string | undefined
  }
  [key: string]: unknown
}

/** G6 边数据 */
export interface G6EdgeData {
  id: string
  source: string
  target: string
  data: {
    localInterface: string
    remoteInterface: string
    confidence: number
    sources: string[]
    state: string
  }
  style: {
    lineDash: number[] | undefined
    opacity: number
    lineWidth: number
    stroke: string
    shadowBlur: number
    shadowColor: string
  }
  [key: string]: unknown
}

// ==================== 设备图标 ====================

import { NEON_DEVICE_ICONS, type NeonDeviceIcon } from './neonDeviceIcons'

const DEFAULT_ICON: NeonDeviceIcon = { svg: '', glowColor: '#67c23a' }

function getDeviceIcon(deviceType: string): NeonDeviceIcon {
  return NEON_DEVICE_ICONS[deviceType as keyof typeof NEON_DEVICE_ICONS] || DEFAULT_ICON
}

// ==================== 边颜色函数 ====================

/**
 * 根据边的状态和置信度返回描边颜色。
 * - pending → 浅蓝色
 * - confirmed + confidence ≥ 0.6 → 绿色
 * - confirmed + confidence < 0.6 → 橙色
 */
export function getEdgeColor(state: string, confidence: number): string {
  if (state === 'pending') return '#00a8ff' // Neon blue
  if (confidence >= 0.6) return '#39ff14' // Fluorescent green
  return '#ffb84d' // Neon orange
}

// ==================== 数据转换函数 ====================

/** 后端 TopologyNode → G6 NodeData */
export function toG6Node(node: TopologyNode): G6NodeData {
  const icon = getDeviceIcon(node.deviceType)
  const isPending = node.state === 'pending'

  return {
    id: node.id,
    data: {
      hostname: node.hostname,
      ipAddresses: node.ipAddresses,
      macAddress: node.macAddress,
      deviceType: node.deviceType,
      state: node.state,
      stabilityTier: node.stabilityTier,
      endpointInfo: node.endpointInfo,
    },
    style: {
      opacity: isPending ? 0.45 : 1.0,
      shadowBlur: isPending ? 0 : 10,
      shadowColor: isPending ? undefined : icon.glowColor,
    },
  }
}

/** 后端 TopologyEdge → G6 EdgeData */
export function toG6Edge(edge: TopologyEdge): G6EdgeData {
  const isDashed = edge.state === 'pending' || edge.confidence < 0.6

  return {
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    data: {
      localInterface: edge.localInterface,
      remoteInterface: edge.remoteInterface,
      confidence: edge.confidence,
      sources: edge.sources,
      state: edge.state,
    },
    style: {
      lineDash: isDashed ? [4, 4] : undefined,
      opacity: edge.state === 'pending' ? 0.3 : Math.max(0.4, edge.confidence * 0.7),
      lineWidth: isDashed ? 1.5 : Math.max(1.8, 1 + edge.confidence * 1.2),
      stroke: getEdgeColor(edge.state, edge.confidence),
      shadowBlur: isDashed ? 0 : 6,
      shadowColor: getEdgeColor(edge.state, edge.confidence),
    },
  }
}

// ==================== HTML 转义（防 XSS） ====================

function escapeHTML(str: string | undefined | null): string {
  if (!str) return '-'
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ==================== Tooltip 格式化函数 ====================

/**
 * 生成节点 tooltip 的 HTML 字符串。
 * 包含：设备名称、IP 地址、MAC 地址、设备类型、状态。
 *
 * 接受 TopologyNode 或 G6NodeData.data 形状的对象。
 *
 * Requirements: 1.11
 */
export function formatNodeTooltip(
  node: Pick<TopologyNode, 'hostname' | 'ipAddresses' | 'macAddress' | 'deviceType' | 'state'> & {
    endpointInfo?: { displayName: string }
  },
): string {
  const name = escapeHTML(node.endpointInfo?.displayName || node.hostname)
  const ips = node.ipAddresses?.length ? escapeHTML(node.ipAddresses.join(', ')) : '-'
  const mac = escapeHTML(node.macAddress)
  const type = escapeHTML(node.deviceType)
  const state = escapeHTML(node.state)

  return [
    `<div style="padding:4px 8px;font-size:12px;line-height:1.6">`,
    `<div><b>${name}</b></div>`,
    `<div>IP: ${ips}</div>`,
    `<div>MAC: ${mac}</div>`,
    `<div>类型: ${type}</div>`,
    `<div>状态: ${state}</div>`,
    `</div>`,
  ].join('')
}

/**
 * 生成边 tooltip 的 HTML 字符串。
 * 包含：本地接口、远程接口、置信度百分比、数据来源列表。
 *
 * 接受 TopologyEdge 或 G6EdgeData.data 形状的对象。
 *
 * Requirements: 1.12
 */
export function formatEdgeTooltip(
  edge: Pick<TopologyEdge, 'localInterface' | 'remoteInterface' | 'confidence' | 'sources'>,
): string {
  const local = escapeHTML(edge.localInterface)
  const remote = escapeHTML(edge.remoteInterface)
  const confidence = `${Math.round((edge.confidence ?? 0) * 100)}%`
  const sources = edge.sources?.length ? escapeHTML(edge.sources.join(', ')) : '-'

  return [
    `<div style="padding:4px 8px;font-size:12px;line-height:1.6">`,
    `<div>本地接口: ${local}</div>`,
    `<div>远程接口: ${remote}</div>`,
    `<div>置信度: ${confidence}</div>`,
    `<div>数据来源: ${sources}</div>`,
    `</div>`,
  ].join('')
}
