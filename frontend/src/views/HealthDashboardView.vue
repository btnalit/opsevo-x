<template>
  <div class="health-dashboard-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>健康监控</span>
            <span class="header-description">实时查看系统健康状态和趋势</span>
            <el-tag
              v-if="deviceStore.deviceSummary"
              type="info"
              size="small"
              style="margin-left: 12px"
            >
              监控 {{ deviceStore.deviceSummary.total }} 台设备，{{ deviceStore.deviceSummary.online }} 台在线
            </el-tag>
          </div>
        </div>
      </template>
    </el-card>

    <!-- 加载状态 -->
    <el-skeleton v-if="loading && !healthStatus" :rows="5" animated />

    <!-- 错误状态 -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button size="small" @click="loadData">重试</el-button>
      </template>
    </el-alert>

    <template v-else-if="healthStatus">
      <!-- 健康分数卡片 -->
      <el-row :gutter="20" class="score-row">
        <el-col :span="8">
          <el-card class="score-card">
            <div class="score-display">
              <div 
                class="score-number"
                :style="{ color: getHealthColor(healthStatus.score) }"
              >
                {{ healthStatus.score }}
              </div>
              <div class="score-label">健康分数</div>
              <el-tag 
                :type="getTagType(healthStatus.score)"
                size="large"
              >
                {{ getHealthLabel(healthStatus.score) }}
              </el-tag>
            </div>
          </el-card>
        </el-col>
        
        <!-- 维度分数 -->
        <el-col :span="16">
          <el-card class="dimensions-card">
            <template #header>
              <span>各维度分数</span>
            </template>
            <el-row :gutter="16">
              <el-col :span="6" v-for="(value, key) in healthStatus.dimensions" :key="key">
                <div class="dimension-item">
                  <el-progress
                    type="dashboard"
                    :percentage="value"
                    :color="getHealthColor(value)"
                    :width="80"
                  />
                  <div class="dimension-label">{{ getDimensionLabel(key) }}</div>
                </div>
              </el-col>
            </el-row>
          </el-card>
        </el-col>
      </el-row>

      <!-- 趋势图表 -->
      <el-card class="trend-card">
        <template #header>
          <div class="trend-header">
            <span>健康趋势</span>
            <el-radio-group v-model="selectedRange" size="small" @change="loadTrend">
              <el-radio-button 
                v-for="opt in TIME_RANGE_OPTIONS" 
                :key="opt.value" 
                :value="opt.value"
              >
                {{ opt.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <div class="chart-container">
          <el-empty 
            v-if="!trendData || trendData.length === 0" 
            description="暂无趋势数据"
            :image-size="100"
          />
          <v-chart v-else :option="chartOption" autoresize />
        </div>
      </el-card>

      <!-- 问题列表 -->
      <el-card class="issues-card">
        <template #header>
          <span>当前问题</span>
        </template>
        <el-empty v-if="!healthStatus.issues?.length" description="暂无问题" />
        <el-table v-else :data="healthStatus.issues" stripe>
          <el-table-column prop="severity" label="严重程度" width="100">
            <template #default="{ row }">
              <el-tag :type="getSeverityType(row.severity)" size="small">
                {{ getSeverityLabel(row.severity) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="问题描述" />
          <el-table-column prop="suggestion" label="建议" />
        </el-table>
      </el-card>

      <!-- 服务健康总览 -->
      <el-card class="issues-card" style="margin-top: 20px;">
        <template #header><span>服务健康总览</span></template>
        <el-table v-if="serviceHealthList.length > 0" :data="serviceHealthList" stripe size="small">
          <el-table-column prop="name" label="服务名称" />
          <el-table-column prop="status" label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'healthy' ? 'success' : row.status === 'degraded' ? 'warning' : 'danger'" size="small">
                {{ row.status === 'healthy' ? '健康' : row.status === 'degraded' ? '降级' : '异常' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="latency" label="延迟" width="100">
            <template #default="{ row }">{{ row.latency ? row.latency + 'ms' : '-' }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无服务数据" :image-size="40" />
      </el-card>

      <!-- Brain Loop 指标 -->
      <el-row :gutter="20" style="margin-top: 20px;">
        <el-col :span="8">
          <el-card shadow="hover">
            <div style="text-align: center;">
              <div style="font-size: 28px; font-weight: bold; color: var(--el-color-primary);">{{ brainMetrics.tickCount }}</div>
              <div style="color: var(--el-text-color-secondary); margin-top: 4px;">Tick 总数</div>
            </div>
          </el-card>
        </el-col>
        <el-col :span="8">
          <el-card shadow="hover">
            <div style="text-align: center;">
              <div style="font-size: 28px; font-weight: bold; color: var(--el-color-success);">{{ brainMetrics.avgTickDuration }}ms</div>
              <div style="color: var(--el-text-color-secondary); margin-top: 4px;">平均 Tick 耗时</div>
            </div>
          </el-card>
        </el-col>
        <el-col :span="8">
          <el-card shadow="hover">
            <div style="text-align: center;">
              <div style="font-size: 28px; font-weight: bold; color: var(--el-color-warning);">{{ brainMetrics.queueDepth }}</div>
              <div style="color: var(--el-text-color-secondary); margin-top: 4px;">队列深度</div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 降级状态 -->
      <el-card v-if="degradationList.length > 0" class="issues-card" style="margin-top: 20px;">
        <template #header><span>降级状态</span></template>
        <el-table :data="degradationList" stripe size="small">
          <el-table-column prop="service" label="服务" />
          <el-table-column prop="level" label="降级级别" width="100">
            <template #default="{ row }">
              <el-tag :type="row.level === 'partial' ? 'warning' : 'danger'" size="small">{{ row.level }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="reason" label="原因" />
          <el-table-column prop="since" label="开始时间" width="160" />
        </el-table>
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'
import { useEvolutionStore } from '@/stores/evolution'
import { useDeviceStore } from '@/stores/device'
import { 
  healthApi,
  getHealthColor,
  getHealthLabel,
  TIME_RANGE_OPTIONS,
  type HealthStatus,
  type HealthTrendPoint
} from '@/api/evolution'
import { serviceHealthApi, brainApi } from '@/api/aiops-enhanced'

// 注册 ECharts 组件
use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent])

// 状态
const evolutionStore = useEvolutionStore()
const healthStatus = ref<HealthStatus | null>(null)
const trendData = ref<HealthTrendPoint[]>([])
const loading = ref(false)
const isLoadingData = ref(false) // 防止请求积压
const error = ref('')
const selectedRange = ref<'1h' | '6h' | '24h' | '7d'>('1h')
let refreshTimer: number | null = null

// 服务健康 & Brain Loop 指标 & 降级状态
const serviceHealthList = ref<Array<{ name: string; status: string; latency?: number }>>([])
const brainMetrics = ref({ tickCount: 0, avgTickDuration: 0, queueDepth: 0 })
const degradationList = ref<Array<{ service: string; level: string; reason: string; since: string }>>([])

// 图表配置
const chartOption = computed(() => ({
  tooltip: {
    trigger: 'axis',
    formatter: (params: { value: [string, number] }[]) => {
      const point = params[0]
      const time = new Date(point.value[0]).toLocaleString()
      return `${time}<br/>健康分数: ${point.value[1]}`
    }
  },
  grid: {
    left: '3%',
    right: '4%',
    bottom: '3%',
    containLabel: true
  },
  xAxis: {
    type: 'time',
    axisLabel: {
      color: '#8b9eb0',
      formatter: (value: number) => {
        const date = new Date(value)
        return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
      }
    },
    axisLine: { lineStyle: { color: 'rgba(240, 246, 252, 0.1)' } }
  },
  yAxis: {
    type: 'value',
    min: 0,
    max: 100,
    axisLabel: { color: '#8b9eb0' },
    splitLine: { lineStyle: { color: 'rgba(240, 246, 252, 0.05)' } }
  },
  series: [{
    name: '健康分数',
    type: 'line',
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    data: trendData.value.map(p => [p.timestamp, p.score]),
    areaStyle: {
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(64, 158, 255, 0.3)' },
          { offset: 1, color: 'rgba(64, 158, 255, 0)' }
        ]
      }
    },
    lineStyle: {
      width: 3,
      color: '#409eff'
    },
    itemStyle: {
      color: '#409eff',
      borderWidth: 2,
      borderColor: '#fff'
    }
  }]
}))

// 维度标签
const dimensionLabels: Record<string, string> = {
  system: '系统',
  network: '网络',
  performance: '性能',
  reliability: '可靠性'
}

function getDimensionLabel(key: string): string {
  return dimensionLabels[key] || key
}

// 标签类型
function getTagType(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 80) return 'success'
  if (score >= 60) return 'warning'
  return 'danger'
}

// 严重程度
function getSeverityType(severity: string): 'info' | 'warning' | 'danger' {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function getSeverityLabel(severity: string): string {
  const labels: Record<string, string> = {
    info: '信息',
    warning: '警告',
    critical: '严重'
  }
  return labels[severity] || severity
}

// 加载数据
async function loadData() {
  // 防止请求积压：如果上一次请求还在进行中，跳过本次请求
  if (isLoadingData.value) {
    return
  }
  
  isLoadingData.value = true
  loading.value = true
  error.value = ''
  
  try {
    await evolutionStore.fetchHealthStatus(true, deviceStore.currentDeviceId)
    healthStatus.value = evolutionStore.healthStatus
    await loadTrend()

    // 加载增强数据（非关键，独立 try-catch）
    try {
      const [shRes, bmRes, dgRes] = await Promise.all([
        serviceHealthApi.getServiceHealth(),
        brainApi.getMetrics(),
        serviceHealthApi.getDegradationStatus(),
      ])
      if (shRes.data.success && shRes.data.data) serviceHealthList.value = shRes.data.data
      if (bmRes.data.success && bmRes.data.data) brainMetrics.value = bmRes.data.data
      if (dgRes.data.success && dgRes.data.data) degradationList.value = dgRes.data.data
    } catch { /* non-critical */ }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载数据失败'
  } finally {
    loading.value = false
    isLoadingData.value = false
  }
}

// 加载趋势数据
async function loadTrend() {
  try {
    const response = await healthApi.getTrend(selectedRange.value, deviceStore.currentDeviceId)
    if (response.data.success && response.data.data) {
      trendData.value = response.data.data
    }
  } catch (e) {
    console.error('Failed to load trend:', e)
  }
}

// 自动刷新
function startAutoRefresh() {
  refreshTimer = window.setInterval(() => {
    loadData()
  }, 30000) // 30 秒刷新
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

// Device store
const deviceStore = useDeviceStore()

// 监听设备切换，清除缓存并重新加载数据
watch(
  () => deviceStore.currentDeviceId,
  (newDeviceId, oldDeviceId) => {
    if (newDeviceId !== oldDeviceId) {
      // 清除现有数据
      healthStatus.value = null
      trendData.value = []
      error.value = ''
      
      // 重新加载新设备的数据
      loadData()
    }
  }
)

onMounted(() => {
  deviceStore.fetchDeviceSummary()
  loadData()
  startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.health-dashboard-view {
  padding: 20px;
  background: var(--el-bg-color-page);
  min-height: 100%;
}

.header-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-description {
  margin-left: 12px;
  font-size: 14px;
  font-weight: normal;
  color: var(--el-text-color-secondary);
}

.score-row {
  margin-bottom: 20px;
}

.score-card {
  height: 200px;
}

.score-display {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.score-number {
  font-size: 64px;
  font-weight: 700;
  line-height: 1;
  margin-bottom: 8px;
}

.score-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}

.dimensions-card {
  height: 200px;
}

.dimension-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.dimension-label {
  margin-top: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.trend-card {
  margin-bottom: 20px;
}

.trend-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chart-container {
  height: 300px;
}

.issues-card {
  margin-bottom: 20px;
}
</style>
