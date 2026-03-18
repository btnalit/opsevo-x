<template>
  <div class="gods-eye-topology">
    <div class="panel-header">
      <el-icon class="header-icon"><i-ep-share /></el-icon>
      <span class="header-title">GOD'S EYE TOPOLOGY</span>
      <el-button
        v-if="showEndpoints"
        size="small"
        text
        class="endpoint-toggle"
        @click="showEndpoints = false"
      >
        HIDE ENDPOINTS
      </el-button>
      <el-button
        v-else
        size="small"
        text
        class="endpoint-toggle"
        @click="showEndpoints = true"
      >
        SHOW ENDPOINTS
      </el-button>
      <div class="status-badge" :class="statusClass">
        {{ statusText }}
      </div>
    </div>
    <div ref="containerRef" class="chart-container" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { Graph } from '@antv/g6'
import { registerNeonNode } from './topology/registerNeonNode'
import {
  useTopologySSE,
  type TopologyDiff,
  type TopologyNode,
  type TopologyEdge,
} from '@/composables/useTopologySSE'
import { DiffBatchProcessor, type MergedDiff } from '@/utils/diffBatchProcessor'
import { FocusAnimator, type G6GraphLike } from '@/utils/focusAnimator'
import {
  toG6Node,
  toG6Edge,
  formatNodeTooltip,
  formatEdgeTooltip,
  getEdgeColor,
} from './topology/topoDataTransform'
import api from '@/api'

// ==================== 注册自定义节点 ====================
registerNeonNode()

// ==================== Props & Emits ====================
// Preserve existing interface (none defined in original, but keep extensible)

// ==================== 响应式状态 ====================
const containerRef = ref<HTMLElement | null>(null)
const showEndpoints = ref(true)
const discoveryStatus = ref<'live' | 'stale' | 'offline'>('offline')
const isMounted = ref(false)
const isFetching = ref(false)

const statusClass = computed(() => {
  if (discoveryStatus.value === 'live') return 'active'
  return 'stale'
})

const statusText = computed(() => {
  if (discoveryStatus.value === 'live') return 'LIVE DISCOVERY'
  return 'STALE'
})

// ==================== G6 Graph 实例 ====================
let graph: Graph | null = null

// 内部拓扑数据存储（用于 endpoint 切换时重建）
const topoNodesMap = new Map<string, TopologyNode>()
const topoEdgesMap = new Map<string, TopologyEdge>()

// ==================== SSE & Batch Processor ====================
const { subscribe, status: sseStatus } = useTopologySSE()
let unsubscribeSSE: (() => void) | null = null

// ==================== 辅助函数 ====================

/** Filter out ARP/DHCP invalid endpoints */
function isInvalidEndpoint(node: TopologyNode): boolean {
  if (node.stabilityTier !== 'endpoint' && node.deviceType !== 'endpoint') return false
  const hasValidIp = node.ipAddresses?.some(
    (ip) => ip && ip.trim() && ip !== '0.0.0.0',
  )
  const hasValidMac =
    node.macAddress &&
    node.macAddress.trim() &&
    node.macAddress !== '00:00:00:00:00:00'
  if (!hasValidIp && !hasValidMac) return true
  if (!hasValidIp) return true
  return false
}

/** Check if a node is a valid topology node (state + validity check, ignoring endpoint toggle) */
function isValidNode(node: TopologyNode): boolean {
  if (node.state !== 'confirmed' && node.state !== 'pending') return false
  if (isInvalidEndpoint(node)) return false
  return true
}

/** Check if a node is an endpoint type */
function isEndpointNode(node: TopologyNode): boolean {
  return node.stabilityTier === 'endpoint'
}

// ==================== G6 Graph 创建 ====================

function createGraph(): Graph | null {
  if (!containerRef.value) return null

  const g = new Graph({
    container: containerRef.value,
    autoFit: 'view',
    devicePixelRatio: window.devicePixelRatio || 2,
    layout: {
      type: 'force',
      preventOverlap: true,
      nodeSize: 80,
      nodeSpacing: 30,
      linkDistance: 200,
      nodeStrength: -1200,
      collideStrength: 1.0,
      edgeStrength: 0.1,
      alphaDecay: 0.01,
    },
    behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
    node: {
      type: 'neon-device',
      style: (data: Record<string, unknown>) => {
        const d = data.data as Record<string, unknown> | undefined
        return {
          deviceType: d?.deviceType ?? 'router',
          nodeState: d?.state ?? 'confirmed',
          size: 48,
          labelText: d?.hostname as string ?? '',
          labelFill: '#ffffff',
          labelFontSize: 12,
          labelFontWeight: 'bold',
          labelFontFamily: 'monospace',
          labelPlacement: 'bottom',
          labelOffsetY: 6,
          labelStroke: '#0d1117',
          labelLineWidth: 3,
          labelLineJoin: 'round',
        }
      },
    },
    edge: {
      style: (data: Record<string, unknown>) => {
        const d = data.data as Record<string, unknown> | undefined
        const confidence = (d?.confidence as number) ?? 0.5
        const state = (d?.state as string) ?? 'pending'
        const isDashed = state === 'pending' || confidence < 0.6
        return {
          lineDash: isDashed ? [4, 4] : undefined,
          lineWidth: isDashed ? 1.5 : Math.max(1.8, 1 + confidence * 1.2),
          stroke: getEdgeColor(state, confidence),
          opacity: state === 'pending' ? 0.3 : Math.max(0.4, confidence * 0.7),
          shadowBlur: isDashed ? 0 : 6,
          shadowColor: getEdgeColor(state, confidence),
        }
      },
    },
    plugins: [
      {
        type: 'tooltip',
        key: 'node-tooltip',
        trigger: 'hover',
        getContent: (_event: unknown, items: Array<Record<string, unknown>>) => {
          if (!items?.length) return ''
          const item = items[0]
          const d = item.data as Record<string, unknown> | undefined
          if (!d) return ''
          // Node tooltip
          if (d.hostname !== undefined) {
            return formatNodeTooltip(d as unknown as TopologyNode)
          }
          // Edge tooltip
          if (d.localInterface !== undefined) {
            return formatEdgeTooltip(d as unknown as TopologyEdge)
          }
          return ''
        },
        style: {
          '.tooltip': {
            background: 'rgba(30, 37, 48, 0.9)',
            border: '1px solid #526175',
            color: '#f0f6fc',
            fontFamily: 'monospace',
            borderRadius: '4px',
          },
        },
      },
    ],
  })

  return g
}

// ==================== 数据加载与渲染 ====================

/** 将内部 Map 数据渲染到 G6 Graph（包含所有有效节点，通过 visibility API 控制 endpoint 显隐） */
function renderFullGraph(): void {
  if (!graph) return

  const g6Nodes: ReturnType<typeof toG6Node>[] = []
  const g6Edges: ReturnType<typeof toG6Edge>[] = []
  const validNodeIds = new Set<string>()

  // Include all valid nodes (including endpoints) in the graph data
  for (const node of topoNodesMap.values()) {
    if (!isValidNode(node)) continue
    validNodeIds.add(node.id)
    g6Nodes.push(toG6Node(node))
  }

  for (const edge of topoEdgesMap.values()) {
    if (edge.state !== 'confirmed' && edge.state !== 'pending') continue
    if (!validNodeIds.has(edge.sourceId) || !validNodeIds.has(edge.targetId)) continue
    g6Edges.push(toG6Edge(edge))
  }

  graph.setData({ nodes: g6Nodes, edges: g6Edges })
  void graph.render().then(() => {
    // Guard against component unmount during async render
    if (!isMounted.value || !graph) return
    // After render, hide endpoint nodes if showEndpoints is false
    if (!showEndpoints.value) {
      toggleEndpointVisibility(false)
    }
  })
}

/** Toggle visibility of endpoint nodes and their associated edges using G6 visibility API */
function toggleEndpointVisibility(visible: boolean): void {
  if (!graph) return

  const endpointNodeIds: string[] = []

  // Collect endpoint node IDs
  for (const node of topoNodesMap.values()) {
    if (isEndpointNode(node) && isValidNode(node)) {
      endpointNodeIds.push(node.id)
    }
  }

  if (endpointNodeIds.length === 0) return

  // Collect associated edge IDs
  const endpointIdSet = new Set(endpointNodeIds)
  const edgeIds: string[] = []
  for (const edge of topoEdgesMap.values()) {
    if (endpointIdSet.has(edge.sourceId) || endpointIdSet.has(edge.targetId)) {
      edgeIds.push(edge.id)
    }
  }

  const allIds = [...endpointNodeIds, ...edgeIds]

  try {
    if (visible) {
      void graph.showElement(allIds)
    } else {
      void graph.hideElement(allIds)
    }
  } catch (err) {
    console.warn('[GodsEyeTopology] Failed to toggle endpoint visibility:', err)
  }
}

/** 从 REST API 加载初始拓扑数据 */
async function fetchTopology(): Promise<void> {
  if (isFetching.value) return
  isFetching.value = true
  try {
    const res = await api.get('/topology')
    if (!res.data?.success) {
      await fetchDevicesFallback()
      return
    }

    const data = res.data.data
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
      topoNodesMap.clear()
      topoEdgesMap.clear()
      await fetchDevicesFallback()
      return
    }

    topoNodesMap.clear()
    topoEdgesMap.clear()
    for (const n of data.nodes || []) topoNodesMap.set(n.id, n)
    for (const e of data.edges || []) topoEdgesMap.set(e.id, e)

    renderFullGraph()
    discoveryStatus.value = 'live'
  } catch {
    await fetchDevicesFallback()
  } finally {
    isFetching.value = false
  }
}

/** 设备列表回退模式 */
async function fetchDevicesFallback(): Promise<void> {
  topoNodesMap.clear()
  topoEdgesMap.clear()

  try {
    const res = await api.get('/devices')
    if (!res.data || !Array.isArray(res.data.data)) {
      renderFullGraph()
      discoveryStatus.value = 'offline'
      return
    }

    const devices = res.data.data
    for (const [index, d] of devices.entries()) {
      const node: TopologyNode = {
        id: d.id || d.deviceId || `${d.name || 'fallback-device'}-${index}`,
        hostname: d.name || d.hostname || d.id,
        ipAddresses: [d.host || ''],
        macAddress: '',
        deviceType: (d.type || d.deviceType || 'router').toLowerCase(),
        stabilityTier: 'infrastructure',
        state: 'confirmed',
        sources: [],
      }
      topoNodesMap.set(node.id, node)
    }

    renderFullGraph()
    discoveryStatus.value = 'stale'
  } catch {
    renderFullGraph()
    discoveryStatus.value = 'offline'
  }
}

// ==================== 增量更新（DiffBatchProcessor flush 回调） ====================

function applyMergedDiff(merged: MergedDiff): void {
  if (!graph) return

  // 更新内部数据存储
  for (const [id, node] of merged.nodesAdded) {
    topoNodesMap.set(id, node)
  }
  for (const id of merged.nodesRemoved) {
    topoNodesMap.delete(id)
  }
  for (const [id, changes] of merged.nodesUpdated) {
    const existing = topoNodesMap.get(id)
    if (existing) {
      const updated = { ...existing } as Record<string, unknown>
      for (const [key, value] of Object.entries(changes)) {
        updated[key] = value
      }
      topoNodesMap.set(id, updated as unknown as TopologyNode)
    }
  }
  for (const [id, edge] of merged.edgesAdded) {
    topoEdgesMap.set(id, edge)
  }
  for (const id of merged.edgesRemoved) {
    topoEdgesMap.delete(id)
  }
  for (const [id, changes] of merged.edgesUpdated) {
    const existing = topoEdgesMap.get(id)
    if (existing) {
      const updated = { ...existing } as Record<string, unknown>
      for (const [key, value] of Object.entries(changes)) {
        updated[key] = value
      }
      topoEdgesMap.set(id, updated as unknown as TopologyEdge)
    }
  }

  // 使用 G6 增量 API 更新图
  try {
    // --- 添加节点 ---
    const nodesToAdd: ReturnType<typeof toG6Node>[] = []
    const newEndpointIds: string[] = []
    for (const [id] of merged.nodesAdded) {
      const node = topoNodesMap.get(id)
      if (node && isValidNode(node)) {
        const g6Node = toG6Node(node)
        // If endpoints are hidden, mark new endpoint nodes as invisible at add time
        // to avoid flash-of-visible-content race condition
        if (isEndpointNode(node) && !showEndpoints.value) {
          ;(g6Node as Record<string, unknown>).style = {
            ...g6Node.style,
            visibility: 'hidden',
          }
        }
        nodesToAdd.push(g6Node)
        if (isEndpointNode(node)) newEndpointIds.push(id)
      }
    }
    if (nodesToAdd.length > 0) {
      graph.addData({ nodes: nodesToAdd })
    }

    // --- 删除节点 ---
    const nodeIdsToRemove = [...merged.nodesRemoved]
    if (nodeIdsToRemove.length > 0) {
      graph.removeData({ nodes: nodeIdsToRemove })
    }

    // --- 更新节点 ---
    const nodesToUpdate: ReturnType<typeof toG6Node>[] = []
    for (const [id] of merged.nodesUpdated) {
      const node = topoNodesMap.get(id)
      if (node && isValidNode(node)) {
        nodesToUpdate.push(toG6Node(node))
      }
    }
    if (nodesToUpdate.length > 0) {
      graph.updateData({ nodes: nodesToUpdate })
    }

    // --- 添加边 ---
    const validNodeIds = new Set<string>()
    for (const node of topoNodesMap.values()) {
      if (isValidNode(node)) validNodeIds.add(node.id)
    }

    const edgesToAdd: ReturnType<typeof toG6Edge>[] = []
    const newEndpointEdgeIds: string[] = []
    const endpointIdSet = new Set<string>()
    for (const node of topoNodesMap.values()) {
      if (isEndpointNode(node)) endpointIdSet.add(node.id)
    }

    for (const [id] of merged.edgesAdded) {
      const edge = topoEdgesMap.get(id)
      if (
        edge &&
        (edge.state === 'confirmed' || edge.state === 'pending') &&
        validNodeIds.has(edge.sourceId) &&
        validNodeIds.has(edge.targetId)
      ) {
        const g6Edge = toG6Edge(edge)
        // If endpoints are hidden, mark endpoint-related edges as invisible at add time
        if (!showEndpoints.value && (endpointIdSet.has(edge.sourceId) || endpointIdSet.has(edge.targetId))) {
          ;(g6Edge as Record<string, unknown>).style = {
            ...g6Edge.style,
            visibility: 'hidden',
          }
        }
        edgesToAdd.push(g6Edge)
        if (endpointIdSet.has(edge.sourceId) || endpointIdSet.has(edge.targetId)) {
          newEndpointEdgeIds.push(id)
        }
      }
    }
    if (edgesToAdd.length > 0) {
      graph.addData({ edges: edgesToAdd })
    }

    // --- 删除边 ---
    const edgeIdsToRemove = [...merged.edgesRemoved]
    if (edgeIdsToRemove.length > 0) {
      graph.removeData({ edges: edgeIdsToRemove })
    }

    // --- 更新边 ---
    const edgesToUpdate: ReturnType<typeof toG6Edge>[] = []
    for (const [id] of merged.edgesUpdated) {
      const edge = topoEdgesMap.get(id)
      if (edge && validNodeIds.has(edge.sourceId) && validNodeIds.has(edge.targetId)) {
        edgesToUpdate.push(toG6Edge(edge))
      }
    }
    if (edgesToUpdate.length > 0) {
      graph.updateData({ edges: edgesToUpdate })
    }

    void graph.draw()
  } catch (err) {
    console.warn('[GodsEyeTopology] Incremental update failed, falling back to full render:', err)
    renderFullGraph()
  }
}

// ==================== DiffBatchProcessor 实例 ====================
const batchProcessor = new DiffBatchProcessor(applyMergedDiff)

// ==================== FocusAnimator 实例 ====================
let focusAnimator: FocusAnimator | null = null

// ==================== 生命周期 ====================

let refreshTimer: number | undefined

onMounted(async () => {
  isMounted.value = true

  // 创建 G6 Graph 实例
  graph = createGraph()

  // 创建 FocusAnimator 实例
  if (graph) {
    focusAnimator = new FocusAnimator(graph as unknown as G6GraphLike, 6000, 40)
    focusAnimator.setBatchProcessor(batchProcessor)
  }

  // 从 REST API 加载初始拓扑数据（直接渲染，不经防抖）
  await fetchTopology()

  // 启动焦点动画
  focusAnimator?.start()

  // SSE 连接状态同步
  watch(sseStatus, (val) => {
    if (val === 'connected') discoveryStatus.value = 'live'
    else if (val === 'disconnected') discoveryStatus.value = 'stale'
  })

  // 订阅 SSE 事件，通过 DiffBatchProcessor 处理
  unsubscribeSSE = subscribe((diff: TopologyDiff) => {
    batchProcessor.push(diff)
    discoveryStatus.value = 'live'
  })

  // 非 live 状态下定期全量刷新
  refreshTimer = window.setInterval(() => {
    if (discoveryStatus.value !== 'live') {
      fetchTopology()
    }
  }, 30000)

  // endpoint 显示/隐藏切换时使用 G6 可见性 API
  watch(showEndpoints, (newVal) => {
    if (topoNodesMap.size > 0) toggleEndpointVisibility(newVal)
  })
})

onUnmounted(() => {
  isMounted.value = false

  // 取消 SSE 订阅
  if (unsubscribeSSE) {
    unsubscribeSSE()
    unsubscribeSSE = null
  }

  // 停止焦点动画（跳过 restoreAllNodes，因为 graph 即将销毁）
  if (focusAnimator) {
    focusAnimator.stop(true)
    focusAnimator = null
  }

  // 销毁 DiffBatchProcessor
  batchProcessor.destroy()

  // 清除定时器
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }

  // 销毁 G6 Graph 实例
  if (graph) {
    graph.destroy()
    graph = null
  }
})
</script>

<style scoped>
.gods-eye-topology {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-header {
  height: 36px;
  background-color: var(--el-fill-color-darker);
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
  flex-shrink: 0;
}

.header-icon {
  color: var(--el-color-primary);
  margin-right: 8px;
  font-size: 16px;
}

.header-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: var(--el-text-color-regular);
  font-weight: 500;
  letter-spacing: 1px;
  flex: 1;
}

.endpoint-toggle {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  margin-right: 8px;
}

.status-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: bold;
}

.status-badge.active {
  background-color: rgba(103, 194, 58, 0.2);
  color: #67c23a;
  border: 1px solid #67c23a;
}

.status-badge.stale {
  background-color: rgba(245, 108, 108, 0.2);
  color: #f56c6c;
  border: 1px solid #f56c6c;
}

.chart-container {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background-image:
    linear-gradient(var(--el-border-color-extra-light) 1px, transparent 1px),
    linear-gradient(90deg, var(--el-border-color-extra-light) 1px, transparent 1px);
  background-size: 40px 40px;
  background-position: center center;
}
</style>
