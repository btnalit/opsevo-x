<template>
  <div class="tracing-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>分布式追踪</span>
            <span class="header-description">查看 Trace 执行链路、Span 瀑布图与慢 Trace 排行</span>
          </div>
          <div class="header-actions">
            <el-button @click="loadTraces" :loading="loading">
              <el-icon><i-ep-refresh /></el-icon>
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- Trace 列表 -->
      <el-tab-pane label="Trace 列表" name="list">
        <div class="tab-toolbar">
          <el-input v-model="searchQuery" placeholder="搜索 Trace ID 或名称..." clearable style="width:250px" @keyup.enter="loadTraces" />
          <el-select v-model="statusFilter" placeholder="状态" clearable style="width:120px" @change="loadTraces">
            <el-option label="成功" value="completed" />
            <el-option label="失败" value="failed" />
            <el-option label="进行中" value="running" />
          </el-select>
          <el-button type="primary" @click="loadTraces">搜索</el-button>
        </div>
        <el-skeleton v-if="loading" :rows="5" animated />
        <el-empty v-else-if="!traces.length" description="暂无 Trace 数据" />
        <el-table v-else :data="traces" stripe @row-click="showTraceDetail">
          <el-table-column prop="traceId" label="Trace ID" width="200">
            <template #default="{ row }">
              <code class="trace-id">{{ row.traceId?.substring(0, 12) }}...</code>
            </template>
          </el-table-column>
          <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
          <el-table-column prop="status" label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'completed' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'" size="small">
                {{ row.status === 'completed' ? '成功' : row.status === 'failed' ? '失败' : '进行中' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="spanCount" label="Span 数" width="100" />
          <el-table-column prop="duration" label="耗时" width="120">
            <template #default="{ row }">
              <span :class="{ 'slow-trace': row.duration > 5000 }">{{ formatDuration(row.duration) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="startTime" label="开始时间" width="180">
            <template #default="{ row }">{{ formatTime(row.startTime) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 慢 Trace 排行 -->
      <el-tab-pane label="慢 Trace 排行" name="slow">
        <el-skeleton v-if="slowLoading" :rows="5" animated />
        <el-empty v-else-if="!slowTraces.length" description="暂无慢 Trace" />
        <el-table v-else :data="slowTraces" stripe @row-click="showTraceDetail">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
          <el-table-column prop="duration" label="耗时" width="120">
            <template #default="{ row }">
              <span class="slow-trace">{{ formatDuration(row.duration) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="spanCount" label="Span 数" width="100" />
          <el-table-column prop="startTime" label="时间" width="180">
            <template #default="{ row }">{{ formatTime(row.startTime) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- Trace 详情 + Span 瀑布图 -->
    <el-drawer v-model="detailVisible" :title="`Trace: ${selectedTrace?.name || ''}`" size="700px" direction="rtl">
      <template v-if="selectedTrace">
        <el-descriptions :column="2" border style="margin-bottom:20px">
          <el-descriptions-item label="Trace ID"><code>{{ selectedTrace.traceId }}</code></el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="selectedTrace.status === 'completed' ? 'success' : 'danger'" size="small">{{ selectedTrace.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="总耗时">{{ formatDuration(selectedTrace.duration) }}</el-descriptions-item>
          <el-descriptions-item label="Span 数">{{ selectedTrace.spans?.length || 0 }}</el-descriptions-item>
        </el-descriptions>

        <h4>Span 瀑布图</h4>
        <div class="waterfall-container">
          <div v-for="span in sortedSpans" :key="span.spanId" class="waterfall-row">
            <div class="span-label" :style="{ paddingLeft: (span.depth || 0) * 20 + 'px' }">
              <el-icon v-if="span.status === 'error'" color="#f56c6c"><i-ep-warning /></el-icon>
              {{ span.name }}
            </div>
            <div class="span-bar-container">
              <div class="span-bar" :style="getSpanBarStyle(span)"
                :class="{ 'span-error': span.status === 'error' }">
                <span class="span-duration">{{ formatDuration(span.duration) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Span 标签和日志 -->
        <div v-if="selectedSpan" style="margin-top:16px">
          <h4>Span 详情: {{ selectedSpan.name }}</h4>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item v-for="(val, key) in (selectedSpan.tags || {})" :key="key" :label="String(key)">
              {{ val }}
            </el-descriptions-item>
          </el-descriptions>
          <div v-if="selectedSpan.logs?.length" style="margin-top:8px">
            <h5>日志</h5>
            <el-timeline>
              <el-timeline-item v-for="(log, i) in selectedSpan.logs" :key="i" :timestamp="formatTime(log.timestamp)" size="small">
                {{ log.message }}
              </el-timeline-item>
            </el-timeline>
          </div>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/index'

interface Span {
  spanId: string; name: string; parentSpanId?: string; status?: string
  startTime: number; duration: number; depth?: number
  tags?: Record<string, any>; logs?: Array<{ timestamp: number; message: string }>
}
interface Trace {
  traceId: string; name: string; status: string; duration: number
  spanCount: number; startTime: number; spans?: Span[]
}

const activeTab = ref('list')
const loading = ref(false)
const slowLoading = ref(false)
const detailVisible = ref(false)
const searchQuery = ref('')
const statusFilter = ref('')
const traces = ref<Trace[]>([])
const slowTraces = ref<Trace[]>([])
const selectedTrace = ref<Trace | null>(null)
const selectedSpan = ref<Span | null>(null)

const sortedSpans = computed(() => {
  if (!selectedTrace.value?.spans) return []
  const spans = [...selectedTrace.value.spans]
  // Build depth from parent relationships
  const depthMap = new Map<string, number>()
  spans.forEach(s => {
    if (!s.parentSpanId) { s.depth = 0; depthMap.set(s.spanId, 0) }
  })
  // Multi-pass to resolve depths
  for (let i = 0; i < 5; i++) {
    spans.forEach(s => {
      if (s.depth === undefined && s.parentSpanId && depthMap.has(s.parentSpanId)) {
        s.depth = (depthMap.get(s.parentSpanId) || 0) + 1
        depthMap.set(s.spanId, s.depth)
      }
    })
  }
  spans.forEach(s => { if (s.depth === undefined) s.depth = 0 })
  return spans.sort((a, b) => a.startTime - b.startTime)
})

function formatTime(ts: number | string) { return ts ? new Date(ts).toLocaleString() : '-' }
function formatDuration(ms: number) {
  if (!ms) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function getSpanBarStyle(span: Span) {
  if (!selectedTrace.value) return {}
  const totalDuration = selectedTrace.value.duration || 1
  const traceStart = selectedTrace.value.startTime
  const left = ((span.startTime - traceStart) / totalDuration) * 100
  const width = Math.max((span.duration / totalDuration) * 100, 1)
  return { left: `${Math.max(0, left)}%`, width: `${Math.min(width, 100)}%` }
}

async function loadTraces() {
  loading.value = true
  try {
    const res = await api.get('/ai-ops/traces', {
      params: { search: searchQuery.value || undefined, status: statusFilter.value || undefined, limit: 50 }
    })
    traces.value = res.data.data || []
  } catch { ElMessage.error('加载 Trace 失败') }
  finally { loading.value = false }
}

async function loadSlowTraces() {
  slowLoading.value = true
  try {
    const res = await api.get('/ai-ops/traces/slow', { params: { limit: 20 } })
    slowTraces.value = res.data.data || []
  } catch { slowTraces.value = [] }
  finally { slowLoading.value = false }
}

async function showTraceDetail(trace: Trace) {
  try {
    const res = await api.get(`/ai-ops/traces/${trace.traceId}`)
    selectedTrace.value = res.data.data || trace
    selectedSpan.value = null
    detailVisible.value = true
  } catch {
    selectedTrace.value = trace
    detailVisible.value = true
  }
}

onMounted(() => { loadTraces(); loadSlowTraces() })
</script>

<style scoped>
.tracing-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.tab-toolbar { display: flex; gap: 12px; margin-bottom: 16px; }
.trace-id { font-size: 12px; background: var(--el-fill-color-light); padding: 2px 6px; border-radius: 3px; }
.slow-trace { color: var(--el-color-danger); font-weight: 600; }
.waterfall-container { margin-top: 12px; }
.waterfall-row { display: flex; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--el-border-color-extra-light); }
.span-label { width: 200px; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; display: flex; align-items: center; gap: 4px; }
.span-bar-container { flex: 1; position: relative; height: 20px; background: var(--el-fill-color-lighter); border-radius: 2px; }
.span-bar { position: absolute; height: 100%; background: var(--el-color-primary-light-3); border-radius: 2px; min-width: 2px; display: flex; align-items: center; padding: 0 4px; }
.span-bar.span-error { background: var(--el-color-danger-light-3); }
.span-duration { font-size: 11px; white-space: nowrap; color: var(--el-text-color-primary); }
</style>
