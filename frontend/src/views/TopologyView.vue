<template>
  <div class="topology-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>网络拓扑</span>
            <span class="header-description">可视化网络拓扑与设备关系</span>
          </div>
          <div class="header-actions">
            <el-select v-model="layoutType" placeholder="布局" style="width:120px" @change="applyLayout">
              <el-option label="力导向" value="force" />
              <el-option label="层次" value="hierarchical" />
              <el-option label="环形" value="circular" />
            </el-select>
            <el-button @click="refreshTopology" :loading="loading">
              <el-icon><i-ep-refresh /></el-icon>
              刷新
            </el-button>
            <el-button @click="activeTab = activeTab === 'graph' ? 'history' : 'graph'">
              {{ activeTab === 'graph' ? '变更历史' : '拓扑图' }}
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <div v-if="activeTab === 'graph'" class="topology-container">
      <el-skeleton v-if="loading && !nodes.length" :rows="10" animated />
      <el-empty v-else-if="!nodes.length" description="暂无拓扑数据" />
      <div v-else class="topology-canvas" ref="canvasRef">
        <!-- SVG 拓扑图 -->
        <svg :width="canvasWidth" :height="canvasHeight" class="topology-svg">
          <!-- 边 -->
          <line v-for="edge in edges" :key="edge.id"
            :x1="getNodePos(edge.sourceId).x" :y1="getNodePos(edge.sourceId).y"
            :x2="getNodePos(edge.targetId).x" :y2="getNodePos(edge.targetId).y"
            :stroke="getEdgeColor(edge.type)" stroke-width="2" stroke-opacity="0.6" />
          <!-- 节点 -->
          <g v-for="node in nodes" :key="node.id"
            :transform="`translate(${node.x || 0}, ${node.y || 0})`"
            class="topology-node" @click="selectNode(node)">
            <circle :r="getNodeRadius(node.type)" :fill="getNodeColor(node.type)"
              :stroke="selectedNode?.id === node.id ? '#409eff' : '#fff'" stroke-width="2" />
            <text dy="24" text-anchor="middle" font-size="11" fill="var(--el-text-color-primary)">
              {{ node.label || node.id }}
            </text>
          </g>
        </svg>
      </div>

      <!-- 节点详情面板 -->
      <el-drawer v-model="nodeDrawerVisible" :title="selectedNode?.label || '节点详情'" size="400px" direction="rtl">
        <el-descriptions v-if="selectedNode" :column="1" border>
          <el-descriptions-item label="ID">{{ selectedNode.id }}</el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag>{{ selectedNode.type }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="selectedNode.properties?.status === 'up' ? 'success' : 'danger'">
              {{ selectedNode.properties?.status || 'unknown' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-for="(val, key) in (selectedNode.properties || {})" :key="key" :label="String(key)">
            {{ val }}
          </el-descriptions-item>
        </el-descriptions>
        <h4 style="margin-top:16px">关联边</h4>
        <el-table :data="getNodeEdges(selectedNode?.id)" size="small">
          <el-table-column prop="type" label="类型" width="120" />
          <el-table-column label="目标">
            <template #default="{ row }">
              {{ row.sourceId === selectedNode?.id ? row.targetId : row.sourceId }}
            </template>
          </el-table-column>
        </el-table>
      </el-drawer>
    </div>

    <!-- 变更历史 Tab -->
    <div v-else class="history-container">
      <el-skeleton v-if="historyLoading" :rows="5" animated />
      <el-empty v-else-if="!changeHistory.length" description="暂无变更记录" />
      <el-timeline v-else>
        <el-timeline-item v-for="change in changeHistory" :key="change.id"
          :timestamp="formatTime(change.timestamp)" placement="top"
          :type="change.changeType === 'added' ? 'success' : change.changeType === 'removed' ? 'danger' : 'warning'">
          <el-card shadow="hover">
            <div class="change-item">
              <el-tag :type="change.changeType === 'added' ? 'success' : change.changeType === 'removed' ? 'danger' : 'warning'" size="small">
                {{ change.changeType === 'added' ? '新增' : change.changeType === 'removed' ? '移除' : '变更' }}
              </el-tag>
              <span style="margin-left:8px">{{ change.description }}</span>
            </div>
          </el-card>
        </el-timeline-item>
      </el-timeline>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/index'

interface TopoNode {
  id: string; type: string; label?: string; properties?: Record<string, any>
  x?: number; y?: number
}
interface TopoEdge {
  id: string; sourceId: string; targetId: string; type: string; properties?: Record<string, any>
}
interface ChangeRecord {
  id: string; timestamp: string; changeType: 'added' | 'removed' | 'modified'; description: string
}

const loading = ref(false)
const historyLoading = ref(false)
const activeTab = ref('graph')
const layoutType = ref('force')
const nodes = ref<TopoNode[]>([])
const edges = ref<TopoEdge[]>([])
const changeHistory = ref<ChangeRecord[]>([])
const selectedNode = ref<TopoNode | null>(null)
const nodeDrawerVisible = ref(false)
const canvasRef = ref<HTMLElement>()
const canvasWidth = ref(1200)
const canvasHeight = ref(700)

const NODE_COLORS: Record<string, string> = {
  device: '#409eff', interface: '#67c23a', service: '#e6a23c', alert: '#f56c6c', fault_pattern: '#909399'
}
const EDGE_COLORS: Record<string, string> = {
  connected_to: '#409eff', depends_on: '#e6a23c', triggers: '#f56c6c', related_to: '#909399'
}

function getNodeColor(type: string) { return NODE_COLORS[type] || '#409eff' }
function getNodeRadius(type: string) { return type === 'device' ? 18 : 12 }
function getEdgeColor(type: string) { return EDGE_COLORS[type] || '#c0c4cc' }
function getNodePos(nodeId: string) {
  const n = nodes.value.find(n => n.id === nodeId)
  return { x: n?.x || 0, y: n?.y || 0 }
}
function getNodeEdges(nodeId?: string) {
  if (!nodeId) return []
  return edges.value.filter(e => e.sourceId === nodeId || e.targetId === nodeId)
}

function selectNode(node: TopoNode) {
  selectedNode.value = node
  nodeDrawerVisible.value = true
}

function applyLayout() {
  const cx = canvasWidth.value / 2, cy = canvasHeight.value / 2
  const count = nodes.value.length
  if (layoutType.value === 'circular') {
    nodes.value.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / count
      n.x = cx + Math.cos(angle) * 250
      n.y = cy + Math.sin(angle) * 250
    })
  } else if (layoutType.value === 'hierarchical') {
    const byType: Record<string, TopoNode[]> = {}
    nodes.value.forEach(n => { (byType[n.type] = byType[n.type] || []).push(n) })
    let row = 0
    Object.values(byType).forEach(group => {
      group.forEach((n, i) => { n.x = 100 + i * 120; n.y = 80 + row * 120 })
      row++
    })
  } else {
    // Simple force-directed approximation
    nodes.value.forEach((n, i) => {
      n.x = cx + (Math.random() - 0.5) * 500
      n.y = cy + (Math.random() - 0.5) * 400
    })
    // Basic repulsion iterations
    for (let iter = 0; iter < 50; iter++) {
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = (nodes.value[j].x! - nodes.value[i].x!) || 1
          const dy = (nodes.value[j].y! - nodes.value[i].y!) || 1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          if (dist < 80) {
            const force = (80 - dist) / dist * 0.5
            nodes.value[j].x! += dx * force
            nodes.value[j].y! += dy * force
            nodes.value[i].x! -= dx * force
            nodes.value[i].y! -= dy * force
          }
        }
      }
    }
  }
}

function formatTime(ts: string | number) {
  return new Date(ts).toLocaleString()
}

async function refreshTopology() {
  loading.value = true
  try {
    const [nodesRes, edgesRes] = await Promise.all([
      api.get('/ai-ops/knowledge-graph/nodes', { params: { limit: 200 } }),
      api.get('/ai-ops/knowledge-graph/edges', { params: { limit: 500 } }),
    ])
    nodes.value = nodesRes.data.data || []
    edges.value = edgesRes.data.data || []
    applyLayout()
  } catch {
    ElMessage.error('加载拓扑数据失败')
  } finally {
    loading.value = false
  }
}

async function loadChangeHistory() {
  historyLoading.value = true
  try {
    const res = await api.get('/ai-ops/topology/changes', { params: { limit: 50 } })
    changeHistory.value = res.data.data || []
  } catch {
    changeHistory.value = []
  } finally {
    historyLoading.value = false
  }
}

onMounted(() => {
  refreshTopology()
  loadChangeHistory()
})
</script>

<style scoped>
.topology-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-left { display: flex; align-items: center; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.topology-container { margin-top: 16px; }
.topology-canvas { background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color-lighter); border-radius: 8px; overflow: auto; }
.topology-svg { display: block; }
.topology-node { cursor: pointer; }
.topology-node:hover circle { filter: brightness(1.2); }
.history-container { margin-top: 16px; }
.change-item { display: flex; align-items: center; }
</style>
