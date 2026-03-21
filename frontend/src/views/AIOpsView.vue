<template>
  <div class="ai-ops-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>智能运维仪表盘</span>
          </div>
          <div class="header-actions">
            <DeviceSelector />
            <el-tag v-if="autoRefresh" type="success" size="small" style="white-space: nowrap">
              <el-icon class="is-loading"><i-ep-loading /></el-icon>
              自动刷新中
            </el-tag>
            <el-switch
              v-model="autoRefresh"
              active-text="自动刷新"
              inactive-text=""
              size="small"
            />
            <el-button :icon="Refresh" :loading="loading" @click="loadDashboardData">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && !dashboardData" :rows="10" animated />

    <!-- Error State -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button type="primary" size="small" @click="loadDashboardData">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Dashboard Content -->
    <div v-else class="dashboard-content">
      <!-- Critical Alert Banner -->
      <el-alert
        v-if="dashboardData?.alerts?.critical && dashboardData.alerts.critical > 0"
        type="error"
        :closable="false"
        class="critical-alert-banner"
      >
        <template #title>
          <div class="alert-banner-content">
            <el-icon><i-ep-warning-filled /></el-icon>
            <span>有 {{ dashboardData?.alerts?.critical || 0 }} 个严重告警需要处理</span>
            <el-button type="danger" size="small" text @click="goToAlerts">
              查看详情 →
            </el-button>
          </div>
        </template>
      </el-alert>

      <!-- No Metrics Warning -->
      <el-alert
        v-if="!hasMetricsData"
        type="warning"
        :closable="false"
        class="no-metrics-warning"
      >
        <template #title>
          <div class="alert-banner-content">
            <span>暂无指标数据，请确保已连接路由器并启用指标采集</span>
            <el-button type="primary" size="small" text @click="goToMetricsConfig">
              配置指标采集 →
            </el-button>
          </div>
        </template>
      </el-alert>

      <!-- System Info Cards -->
      <el-row :gutter="20" class="info-row">
        <el-col :xs="24" :sm="12" :md="8" :lg="4">
          <div class="info-card">
            <div class="info-label">CPU 型号</div>
            <div class="info-value">{{ systemInfo?.cpu || '-' }}</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12" :md="8" :lg="4">
          <div class="info-card">
            <div class="info-label">CPU 核心数</div>
            <div class="info-value">{{ systemInfo?.['cpu-count'] || '-' }} 核</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12" :md="8" :lg="4">
          <div class="info-card">
            <div class="info-label">CPU 频率</div>
            <div class="info-value">{{ systemInfo?.['cpu-frequency'] || '-' }} MHz</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12" :md="8" :lg="4">
          <div class="info-card">
            <div class="info-label">架构</div>
            <div class="info-value">{{ systemInfo?.['architecture-name'] || '-' }}</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12" :md="8" :lg="4">
          <div class="info-card">
            <div class="info-label">RouterOS 版本</div>
            <div class="info-value">{{ systemInfo?.version || '-' }}</div>
          </div>
        </el-col>
        <el-col :xs="24" :sm="12" :md="8" :lg="4">
          <div class="info-card">
            <div class="info-label">运行时间</div>
            <div class="info-value uptime">{{ formatUptime(systemInfo?.uptime) }}</div>
          </div>
        </el-col>
      </el-row>

      <!-- System Resource Cards -->
      <el-row :gutter="20" class="resource-row">
        <!-- CPU Card -->
        <el-col :xs="24" :sm="12" :md="8">
          <el-card class="resource-card glass-panel" shadow="hover">
            <div class="resource-header">
              <el-icon :size="24" color="var(--el-color-primary)"><i-ep-cpu /></el-icon>
              <span class="resource-title">CPU 使用率</span>
            </div>
            <div class="resource-progress">
              <el-progress
                type="dashboard"
                :percentage="cpuUsage"
                :color="getProgressColor(cpuUsage)"
                :width="120"
              >
                <template #default="{ percentage }">
                  <span class="percentage-value">{{ hasMetricsData ? percentage + '%' : '--' }}</span>
                </template>
              </el-progress>
            </div>
            <div class="resource-status">
              <el-tag :type="hasMetricsData ? getStatusType(cpuUsage) : 'info'" size="small">
                {{ hasMetricsData ? getStatusText(cpuUsage) : '无数据' }}
              </el-tag>
            </div>
          </el-card>
        </el-col>

        <!-- Memory Card -->
        <el-col :xs="24" :sm="12" :md="8">
          <el-card class="resource-card glass-panel" shadow="hover">
            <div class="resource-header">
              <el-icon :size="24" color="var(--el-color-success)"><i-ep-coin /></el-icon>
              <span class="resource-title">内存使用率</span>
            </div>
            <div class="resource-progress">
              <el-progress
                type="dashboard"
                :percentage="memoryUsage"
                :color="getProgressColor(memoryUsage)"
                :width="120"
              >
                <template #default="{ percentage }">
                  <span class="percentage-value">{{ hasMetricsData ? percentage + '%' : '--' }}</span>
                </template>
              </el-progress>
            </div>
            <div class="resource-detail">
              {{ hasMetricsData ? formatBytes(memoryUsed) + ' / ' + formatBytes(memoryTotal) : '无数据' }}
            </div>
          </el-card>
        </el-col>

        <!-- Disk Card -->
        <el-col :xs="24" :sm="12" :md="8">
          <el-card class="resource-card glass-panel" shadow="hover">
            <div class="resource-header">
              <el-icon :size="24" color="var(--el-color-warning)"><i-ep-files /></el-icon>
              <span class="resource-title">磁盘使用率</span>
            </div>
            <div class="resource-progress">
              <el-progress
                type="dashboard"
                :percentage="diskUsage"
                :color="getProgressColor(diskUsage)"
                :width="120"
              >
                <template #default="{ percentage }">
                  <span class="percentage-value">{{ hasMetricsData ? percentage + '%' : '--' }}</span>
                </template>
              </el-progress>
            </div>
            <div class="resource-detail">
              {{ hasMetricsData ? formatBytes(diskUsed) + ' / ' + formatBytes(diskTotal) : '无数据' }}
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!-- Perception & EventBus Stats -->
      <el-row :gutter="20" class="resource-row">
        <el-col :xs="24" :sm="8">
          <el-card shadow="hover" class="resource-card glass-panel">
            <div class="resource-header">
              <el-icon :size="24" color="var(--el-color-primary)"><i-ep-monitor /></el-icon>
              <span class="resource-title">活跃感知源</span>
            </div>
            <div class="perception-stat-value">{{ perceptionStats.activeSources }}</div>
          </el-card>
        </el-col>
        <el-col :xs="24" :sm="8">
          <el-card shadow="hover" class="resource-card glass-panel">
            <div class="resource-header">
              <el-icon :size="24" color="var(--el-color-warning)"><i-ep-message-box /></el-icon>
              <span class="resource-title">EventBus 事件发布总数</span>
            </div>
            <div class="perception-stat-value">{{ perceptionStats.totalPublishedCount }}</div>
          </el-card>
        </el-col>
        <el-col :xs="24" :sm="8">
          <el-card shadow="hover" class="resource-card glass-panel">
            <div class="resource-header">
              <el-icon :size="24" color="var(--el-color-success)"><i-ep-finished /></el-icon>
              <span class="resource-title">已处理事件总数</span>
            </div>
            <div class="perception-stat-value">{{ perceptionStats.totalEvents }}</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- Interface Traffic Chart -->
      <el-card class="chart-card glass-panel" shadow="hover">
        <template #header>
          <div class="card-header">
            <div class="header-left">
              <el-icon :size="20" color="var(--el-color-primary)"><i-ep-connection /></el-icon>
              <span>接口流量监控</span>
              <el-tag 
                v-if="trafficStatus" 
                :type="trafficStatus.isRouterConnected ? 'success' : 'danger'" 
                size="small"
                style="margin-left: 8px"
              >
                {{ trafficStatus.isRouterConnected ? '采集中' : '未连接' }}
              </el-tag>
            </div>
            <el-select
              v-if="interfaces.length > 0"
              v-model="selectedInterface"
              placeholder="选择接口"
              size="small"
              style="width: 150px"
              @change="updateTrafficChart"
            >
              <el-option
                v-for="iface in interfaces"
                :key="iface.name"
                :label="iface.name"
                :value="iface.name"
              >
                <span>{{ iface.name }}</span>
                <el-tag
                  :type="iface.status === 'up' ? 'success' : 'danger'"
                  size="small"
                  style="margin-left: 8px"
                >
                  {{ iface.status }}
                </el-tag>
              </el-option>
            </el-select>
            <el-tag v-else type="info" size="small">无接口数据</el-tag>
          </div>
        </template>
        <div class="chart-container">
          <v-chart
            v-if="trafficChartOption && interfaces.length > 0"
            :option="trafficChartOption"
            :autoresize="true"
            style="height: 300px"
          />
          <div v-else-if="interfaces.length > 0 && !trafficHistory.length" class="chart-loading">
            <el-icon class="is-loading" :size="24"><i-ep-loading /></el-icon>
            <span>{{ getTrafficLoadingMessage() }}</span>
          </div>
          <el-empty v-else description="暂无接口数据，请确保已连接路由器并启用指标采集" />
        </div>
      </el-card>

      <!-- Bottom Row: Alerts, Remediations, Scheduler -->
      <el-row :gutter="20" class="bottom-row">
        <!-- Recent Alerts -->
        <el-col :xs="24" :md="12" :lg="8">
          <el-card class="list-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <div class="header-left">
                  <el-icon :size="20" color="var(--el-color-danger)"><i-ep-bell /></el-icon>
                  <span>最近告警</span>
                  <el-badge
                    v-if="dashboardData?.alerts?.active && dashboardData.alerts.active > 0"
                    :value="dashboardData?.alerts?.active || 0"
                    type="danger"
                  />
                </div>
                <el-button type="primary" text size="small" @click="goToAlerts">
                  查看全部
                </el-button>
              </div>
            </template>
            <div class="list-content">
              <el-empty
                v-if="!dashboardData?.alerts?.list?.length"
                description="暂无告警"
                :image-size="60"
              />
              <div v-else class="alert-list">
                <div
                  v-for="alert in dashboardData?.alerts?.list?.slice(0, 5)"
                  :key="alert.id"
                  class="alert-item"
                  @click="viewAlertDetail(alert)"
                >
                  <div class="alert-icon">
                    <el-icon :color="getSeverityColor(alert.severity)">
                      <i-ep-warning-filled />
                    </el-icon>
                  </div>
                  <div class="alert-info">
                    <div class="alert-name">{{ alert.ruleName }}</div>
                    <div class="alert-meta">
                      <el-tag :type="getSeverityType(alert.severity)" size="small">
                        {{ getSeverityText(alert.severity) }}
                      </el-tag>
                      <span class="alert-time">{{ formatTime(alert.triggeredAt) }}</span>
                    </div>
                  </div>
                  <el-tag :type="alert.status === 'active' ? 'danger' : 'success'" size="small">
                    {{ alert.status === 'active' ? '活跃' : '已恢复' }}
                  </el-tag>
                </div>
              </div>
            </div>
          </el-card>
        </el-col>

        <!-- Recent Remediations -->
        <el-col :xs="24" :md="12" :lg="8">
          <el-card class="list-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <div class="header-left">
                  <el-icon :size="20" color="var(--el-color-success)"><i-ep-first-aid-kit /></el-icon>
                  <span>最近修复</span>
                </div>
                <el-button type="primary" text size="small" @click="goToRemediations">
                  查看全部
                </el-button>
              </div>
            </template>
            <div class="list-content">
              <el-empty
                v-if="!dashboardData?.remediations?.list?.length"
                description="暂无修复记录"
                :image-size="60"
              />
              <div v-else class="remediation-list">
                <div
                  v-for="remediation in dashboardData?.remediations?.list?.slice(0, 5)"
                  :key="remediation.id"
                  class="remediation-item"
                >
                  <div class="remediation-icon">
                    <el-icon :color="getRemediationStatusColor(remediation.status)">
                      <component :is="getRemediationStatusIcon(remediation.status)" />
                    </el-icon>
                  </div>
                  <div class="remediation-info">
                    <div class="remediation-name">{{ remediation.patternName }}</div>
                    <div class="remediation-time">{{ formatTime(remediation.startedAt) }}</div>
                  </div>
                  <el-tag :type="getRemediationStatusType(remediation.status)" size="small">
                    {{ getRemediationStatusText(remediation.status) }}
                  </el-tag>
                </div>
              </div>
            </div>
          </el-card>
        </el-col>

        <!-- Scheduled Tasks -->
        <el-col :xs="24" :md="12" :lg="8">
          <el-card class="list-card" shadow="hover">
            <template #header>
              <div class="card-header">
                <div class="header-left">
                  <el-icon :size="20" color="var(--el-text-color-secondary)"><i-ep-clock /></el-icon>
                  <span>计划任务</span>
                </div>
                <el-button type="primary" text size="small" @click="goToScheduler">
                  管理任务
                </el-button>
              </div>
            </template>
            <div class="list-content">
              <div class="scheduler-summary">
                <div class="summary-item">
                  <span class="summary-label">总任务数</span>
                  <span class="summary-value">{{ dashboardData?.scheduler?.total || 0 }}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-label">已启用</span>
                  <span class="summary-value success">{{ dashboardData?.scheduler?.enabled || 0 }}</span>
                </div>
              </div>
              <el-divider />
              <div class="next-tasks">
                <div class="next-tasks-title">下次执行任务</div>
                <el-empty
                  v-if="!nextTasks.length"
                  description="暂无计划任务"
                  :image-size="60"
                />
                <div v-else class="task-list">
                  <div
                    v-for="task in nextTasks"
                    :key="task.id"
                    class="task-item"
                  >
                    <div class="task-info">
                      <div class="task-name">{{ task.name }}</div>
                      <div class="task-type">
                        <el-tag size="small" type="info">{{ getTaskTypeText(task.type) }}</el-tag>
                      </div>
                    </div>
                    <div class="task-next-run">
                      <el-icon><i-ep-clock /></el-icon>
                      <span>{{ formatNextRun(task.nextRunAt) }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Refresh, MoreFilled, Loading, CircleCheckFilled, CircleCloseFilled, RefreshLeft } from '@element-plus/icons-vue'

import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, markRaw, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent
} from 'echarts/components'
import type { EChartsOption } from 'echarts'
import {
  dashboardApi,
  schedulerApi,
  metricsApi,
  type DashboardData,
  type AlertEvent,
  type AlertSeverity,
  type RemediationStatus,
  type ScheduledTask,
  type InterfaceMetrics,
  type TrafficRatePoint,
  type TrafficCollectionStatus
} from '@/api/ai-ops'
import { dashboardApi as systemDashboardApi } from '@/api/system'
import { useDeviceStore } from '@/stores/device'
import { perceptionApi } from '@/api/perception'
import { deviceApi } from '@/api/device'
import { ElNotification } from 'element-plus'
import DeviceSelector from '@/components/DeviceSelector.vue'

defineOptions({
  name: 'AIOpsView'
})

// System Resource interface
interface SystemResource {
  cpu: string
  'cpu-count': string
  'cpu-frequency': string
  'architecture-name': string
  version: string
  uptime: string
}

// Register ECharts components
use([
  CanvasRenderer,
  LineChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent
])

const router = useRouter()
const deviceStore = useDeviceStore()

// State
const loading = ref(false)
const error = ref('')
const dashboardData = ref<DashboardData | null>(null)
const autoRefresh = ref(true)
const selectedInterface = ref('')
const scheduledTasks = ref<ScheduledTask[]>([])
const trafficData = ref<Record<string, TrafficRatePoint[]>>({})
const trafficStatus = ref<TrafficCollectionStatus | null>(null)
const systemInfo = ref<SystemResource | null>(null)
const perceptionStats = ref({ activeSources: 0, totalPublishedCount: 0, totalEvents: 0 })
let refreshTimer: ReturnType<typeof setInterval> | null = null

// Computed
const hasMetricsData = computed(() => {
  return dashboardData.value?.metrics !== null && dashboardData.value?.metrics !== undefined
})

const cpuUsage = computed(() => {
  return dashboardData.value?.metrics?.system?.cpu?.usage || 0
})

const memoryUsage = computed(() => {
  return dashboardData.value?.metrics?.system?.memory?.usage || 0
})

const memoryUsed = computed(() => {
  return dashboardData.value?.metrics?.system?.memory?.used || 0
})

const memoryTotal = computed(() => {
  return dashboardData.value?.metrics?.system?.memory?.total || 0
})

const diskUsage = computed(() => {
  return dashboardData.value?.metrics?.system?.disk?.usage || 0
})

const diskUsed = computed(() => {
  return dashboardData.value?.metrics?.system?.disk?.used || 0
})

const diskTotal = computed(() => {
  return dashboardData.value?.metrics?.system?.disk?.total || 0
})

const interfaces = computed<InterfaceMetrics[]>(() => {
  return dashboardData.value?.metrics?.interfaces || []
})

const nextTasks = computed(() => {
  return scheduledTasks.value
    .filter(t => t.enabled && t.nextRunAt)
    .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))
    .slice(0, 3)
})

// Get current interface's traffic history from backend
const trafficHistory = computed(() => {
  return trafficData.value[selectedInterface.value] || []
})

// Traffic Chart Option
const trafficChartOption = computed<EChartsOption | null>(() => {
  const history = trafficHistory.value
  if (!history.length) return null

  return {
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const data = params as Array<{ seriesName: string; value: number; axisValue: string }>
        if (!data.length) return ''
        let result = `${data[0].axisValue}<br/>`
        data.forEach(item => {
          result += `${item.seriesName}: ${formatBytesRate(item.value)}<br/>`
        })
        return result
      }
    },
    legend: {
      data: ['接收', '发送'],
      bottom: 0,
      textStyle: { color: '#8b9eb0' }
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '15%',
      top: '10%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(240, 246, 252, 0.1)' } },
      axisLabel: { color: '#8b9eb0' },
      data: history.map(d => new Date(d.timestamp).toLocaleTimeString('zh-CN', { hour12: false }))
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisLabel: { 
        color: '#8b9eb0',
        formatter: (value: number) => formatBytesRate(value)
      },
      splitLine: { lineStyle: { color: 'rgba(240, 246, 252, 0.05)' } }
    },
    series: [
      {
        name: '接收',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: {
          opacity: 0.3,
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(16, 185, 129, 0.4)' },
              { offset: 1, color: 'rgba(16, 185, 129, 0)' }
            ]
          }
        },
        lineStyle: {
          color: '#10b981',
          width: 2
        },
        itemStyle: {
          color: '#10b981'
        },
        data: history.map(d => d.rxRate)
      },
      {
        name: '发送',
        type: 'line',
        smooth: true,
        showSymbol: false,
        areaStyle: {
          opacity: 0.2,
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(0, 242, 255, 0.3)' },
              { offset: 1, color: 'rgba(0, 242, 255, 0)' }
            ]
          }
        },
        lineStyle: {
          color: '#00f2ff',
          width: 2
        },
        itemStyle: {
          color: '#00f2ff'
        },
        data: history.map(d => d.txRate)
      }
    ]
  }
})

// Methods
let currentRequestId = 0

const loadDashboardData = async () => {
  const requestId = ++currentRequestId
  loading.value = true
  error.value = ''

  const deviceId = deviceStore.currentDeviceId || undefined

  try {
    const [dashboardResponse, tasksResponse, trafficResponse, trafficStatusResponse, systemResponse] = await Promise.all([
      dashboardApi.getData(deviceId),
      schedulerApi.getTasks(),
      metricsApi.getDeviceTrafficHistory(deviceId), // 获取当前设备的流量历史
      metricsApi.getTrafficCollectionStatus(deviceId), // 获取流量采集状态
      deviceStore.currentDeviceId
        ? systemDashboardApi.getResource()
        : Promise.resolve({ data: { success: true, data: { cpu: 0, memory: 0, disk: 0, network: [] } } }) // 无设备时用默认空数据占位
    ])

    if (dashboardResponse.data.success && dashboardResponse.data.data) {
      // 竞态防护：如果请求期间设备已切换，丢弃过期结果
      if (requestId !== currentRequestId) return

      dashboardData.value = dashboardResponse.data.data

      // Auto-select first interface if not selected
      if (!selectedInterface.value && interfaces.value.length > 0) {
        selectedInterface.value = interfaces.value[0].name
      }
    } else {
      throw new Error(dashboardResponse.data.error || '获取仪表盘数据失败')
    }

    if (tasksResponse.data.success && tasksResponse.data.data) {
      scheduledTasks.value = tasksResponse.data.data
    }

    // 更新流量数据
    if (trafficResponse.data.success && trafficResponse.data.data) {
      trafficData.value = trafficResponse.data.data as Record<string, TrafficRatePoint[]>
    }

    // 更新流量采集状态
    if (trafficStatusResponse.data.success && trafficStatusResponse.data.data) {
      trafficStatus.value = trafficStatusResponse.data.data
    }

    // 更新系统信息
    if (systemResponse.data.success && systemResponse.data.data) {
      systemInfo.value = systemResponse.data.data
    }

    // 加载感知源统计（独立 try-catch，不影响主数据）
    try {
      const [sourcesRes, statsRes] = await Promise.all([
        perceptionApi.getSources(),
        perceptionApi.getStats(),
      ])
      if (sourcesRes.data.success && sourcesRes.data.data) {
        perceptionStats.value.activeSources = sourcesRes.data.data.filter(s => s.status === 'active').length
      }
      if (statsRes.data.success && statsRes.data.data) {
        perceptionStats.value.totalPublishedCount = statsRes.data.data.totalPublishedCount
        perceptionStats.value.totalEvents = statsRes.data.data.totalEvents
      }
    } catch { /* perception stats are non-critical */ }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取数据失败'
    error.value = message
    if (!dashboardData.value) {
      ElMessage.error(message)
    }
    // 认证失败时停止轮询，避免请求风暴
    if (message.includes('认证已过期') || message.includes('刷新令牌失败')) {
      stopAutoRefresh()
    }
  } finally {
    loading.value = false
  }
}

const updateTrafficChart = () => {
  // When switching interfaces, the computed property will automatically get the correct data
}

// 获取流量加载状态消息
const getTrafficLoadingMessage = (): string => {
  if (!trafficStatus.value) {
    return '正在采集流量数据...'
  }
  
  if (!trafficStatus.value.isRouterConnected) {
    return '路由器未连接，无法采集流量数据'
  }
  
  if (!trafficStatus.value.isRunning) {
    return '流量采集服务未启动'
  }
  
  if (trafficStatus.value.consecutiveErrors > 0) {
    return `采集出错 (${trafficStatus.value.consecutiveErrors} 次)，正在重试...`
  }
  
  return '正在采集流量数据...'
}

// Utility functions
const formatBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  if (i < 0 || i >= sizes.length) return '0 B'
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatBytesRate = (bytes: number): string => {
  return formatBytes(bytes) + '/s'
}

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

const formatNextRun = (timestamp?: number): string => {
  if (!timestamp) return '未设置'
  const date = new Date(timestamp)
  const now = new Date()
  const diff = date.getTime() - now.getTime()

  if (diff < 0) return '已过期'
  if (diff < 60000) return '即将执行'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟后`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时后`
  return `${Math.floor(diff / 86400000)} 天后`
}

// Format uptime from RouterOS format (1w6d7h24m25s) to readable format
const formatUptime = (uptime?: string): string => {
  if (!uptime) return '-'
  
  const weeks = uptime.match(/(\d+)w/)
  const days = uptime.match(/(\d+)d/)
  const hours = uptime.match(/(\d+)h/)
  const minutes = uptime.match(/(\d+)m/)
  
  let totalDays = 0
  if (weeks) totalDays += parseInt(weeks[1]) * 7
  if (days) totalDays += parseInt(days[1])
  
  const hoursVal = hours ? parseInt(hours[1]) : 0
  const minutesVal = minutes ? parseInt(minutes[1]) : 0
  
  const parts: string[] = []
  if (totalDays > 0) parts.push(`${totalDays}天`)
  if (hoursVal > 0 || totalDays > 0) parts.push(`${hoursVal}时`)
  parts.push(`${minutesVal}分`)
  
  return parts.join('')
}

const getProgressColor = (percentage: number): string => {
  if (percentage < 60) return 'var(--el-color-success)'
  if (percentage < 80) return 'var(--el-color-warning)'
  return 'var(--el-color-danger)'
}

const getStatusType = (percentage: number): 'success' | 'warning' | 'danger' => {
  if (percentage < 60) return 'success'
  if (percentage < 80) return 'warning'
  return 'danger'
}

const getStatusText = (percentage: number): string => {
  if (percentage < 60) return '正常'
  if (percentage < 80) return '警告'
  return '严重'
}

const getSeverityColor = (severity: AlertSeverity): string => {
  const colors: Record<AlertSeverity, string> = {
    info: 'var(--el-text-color-secondary)',
    warning: 'var(--el-color-warning)',
    critical: 'var(--el-color-danger)',
    emergency: 'var(--el-color-danger)'
  }
  return colors[severity]
}

const getSeverityType = (severity: AlertSeverity): 'info' | 'warning' | 'danger' => {
  const types: Record<AlertSeverity, 'info' | 'warning' | 'danger'> = {
    info: 'info',
    warning: 'warning',
    critical: 'danger',
    emergency: 'danger'
  }
  return types[severity]
}

const getSeverityText = (severity: AlertSeverity): string => {
  const texts: Record<AlertSeverity, string> = {
    info: '信息',
    warning: '警告',
    critical: '严重',
    emergency: '紧急'
  }
  return texts[severity]
}

const getRemediationStatusColor = (status: RemediationStatus): string => {
  const colors: Record<RemediationStatus, string> = {
    pending: '#909399',
    executing: '#409eff',
    success: '#67c23a',
    failed: '#f56c6c',
    skipped: '#909399',
    rolled_back: '#e6a23c'
  }
  return colors[status]
}

const getRemediationStatusType = (status: RemediationStatus): 'info' | 'primary' | 'success' | 'danger' | 'warning' => {
  const types: Record<RemediationStatus, 'info' | 'primary' | 'success' | 'danger' | 'warning'> = {
    pending: 'info',
    executing: 'primary',
    success: 'success',
    failed: 'danger',
    skipped: 'warning',
    rolled_back: 'warning'
  }
  return types[status]
}

const getRemediationStatusText = (status: RemediationStatus): string => {
  const texts: Record<RemediationStatus, string> = {
    pending: '等待中',
    executing: '执行中',
    success: '成功',
    failed: '失败',
    skipped: '已跳过',
    rolled_back: '已回滚'
  }
  return texts[status]
}

const getRemediationStatusIcon = (status: RemediationStatus) => {
  const icons: Record<RemediationStatus, unknown> = {
    pending: markRaw(MoreFilled),
    executing: markRaw(Loading),
    success: markRaw(CircleCheckFilled),
    failed: markRaw(CircleCloseFilled),
    skipped: markRaw(MoreFilled),
    rolled_back: markRaw(RefreshLeft)
  }
  return icons[status]
}

const getTaskTypeText = (type: string): string => {
  const texts: Record<string, string> = {
    inspection: '巡检',
    backup: '备份',
    custom: '自定义'
  }
  return texts[type] || type
}

// Navigation
const goToAlerts = () => {
  router.push('/ai-ops/alerts')
}

const goToMetricsConfig = () => {
  // Navigate to connection page where metrics config can be managed
  router.push('/connection')
}

const goToRemediations = () => {
  router.push('/ai-ops/patterns')
}

const goToScheduler = () => {
  router.push('/ai-ops/scheduler')
}

const viewAlertDetail = (alert: AlertEvent) => {
  router.push(`/ai-ops/alerts?id=${alert.id}`)
}

// Auto refresh
const startAutoRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
  refreshTimer = setInterval(() => {
    if (autoRefresh.value) {
      loadDashboardData()
    }
  }, 30000) // 30 seconds - longer interval for more stable data
}

const stopAutoRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

// 监听设备切换，清除缓存并重新加载数据
watch(
  () => deviceStore.currentDeviceId,
  (newDeviceId, oldDeviceId) => {
    if (newDeviceId !== oldDeviceId) {
      // 清除现有数据
      dashboardData.value = null
      trafficData.value = {}
      selectedInterface.value = ''
      trafficStatus.value = null
      systemInfo.value = null
      error.value = ''
      
      // 重新加载新设备的数据
      loadDashboardData()
    }
  }
)

// SSE device event stream
let deviceEventController: AbortController | null = null

// Lifecycle
onMounted(() => {
  loadDashboardData()
  startAutoRefresh()

  // Start SSE device event stream
  deviceEventController = deviceApi.streamDeviceEvents(
    (event) => {
      deviceStore.handleDeviceEvent(event)
      if (event.type === 'device_offline') {
        ElNotification.warning({
          title: '设备离线',
          message: `${event.device_name || event.device_id} 已离线`,
          duration: 5000,
        })
      } else if (event.type === 'device_online') {
        ElNotification.success({
          title: '设备上线',
          message: `${event.device_name || event.device_id} 已上线`,
          duration: 3000,
        })
      }
    },
    (err) => console.error('Device event stream error:', err),
  )
})

onUnmounted(() => {
  stopAutoRefresh()
  deviceEventController?.abort()
  deviceEventController = null
})

onDeactivated(() => {
  // keep-alive 停用：停止轮询和 SSE，释放浏览器连接池
  stopAutoRefresh()
  deviceEventController?.abort()
  deviceEventController = null
})

onActivated(() => {
  // keep-alive 激活：恢复轮询和 SSE
  loadDashboardData()
  startAutoRefresh()
  deviceEventController = deviceApi.streamDeviceEvents(
    (event) => {
      deviceStore.handleDeviceEvent(event)
      if (event.type === 'device_offline') {
        ElNotification.warning({
          title: '设备离线',
          message: `${event.device_name || event.device_id} 已离线`,
          duration: 5000,
        })
      } else if (event.type === 'device_online') {
        ElNotification.success({
          title: '设备上线',
          message: `${event.device_name || event.device_id} 已上线`,
          duration: 3000,
        })
      }
    },
    (err) => console.error('Device event stream error:', err),
  )
})
</script>


<style scoped>
.ai-ops-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* Critical Alert Banner */
.critical-alert-banner {
  margin-bottom: 20px;
}

/* No Metrics Warning */
.no-metrics-warning {
  margin-bottom: 20px;
}

.alert-banner-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Resource Cards */
.resource-row {
  margin-bottom: 20px;
}

.perception-stat-value {
  font-size: 28px;
  font-weight: 700;
  text-align: center;
  padding: 12px 0;
  color: var(--el-text-color-primary);
}

/* System Info Cards */
.info-row {
  margin-bottom: 20px;
}

.info-card {
  background: var(--el-bg-color-overlay);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 12px;
  transition: all 0.3s ease;
  border: 1px solid var(--el-border-color-lighter);
  border-left: 4px solid var(--el-color-primary);
  min-height: 80px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.info-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.info-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.info-label::before {
  content: '';
  width: 5px;
  height: 5px;
  background: var(--el-color-primary);
  border-radius: 50%;
  flex-shrink: 0;
}

.info-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-value.uptime {
  color: var(--el-color-primary);
  background: linear-gradient(90deg, var(--el-color-primary), var(--el-color-success));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.resource-card {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  text-align: center;
  min-height: 220px;
  transition: all 0.3s ease;
}

.resource-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.resource-card :deep(.el-card__body) {
  padding: 20px;
}

.resource-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 16px;
}

.resource-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.resource-progress {
  display: flex;
  justify-content: center;
  margin-bottom: 12px;
}

.percentage-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.resource-detail {
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.resource-status {
  margin-top: 8px;
}

/* Chart Card */
.chart-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header .header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.chart-container {
  min-height: 300px;
}

.chart-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  gap: 12px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

/* List Cards */
.bottom-row {
  margin-bottom: 20px;
}

.list-card {
  min-height: 350px;
}

.list-card :deep(.el-card__body) {
  padding: 16px;
}

.list-content {
  min-height: 250px;
}

/* Alert List */
.alert-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.alert-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.alert-item:hover {
  background: var(--el-bg-color-overlay);
  transform: translateX(4px);
}

.alert-icon {
  flex-shrink: 0;
}

.alert-info {
  flex: 1;
  min-width: 0;
}

.alert-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alert-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.alert-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* Remediation List */
.remediation-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.remediation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.remediation-icon {
  flex-shrink: 0;
}

.remediation-info {
  flex: 1;
  min-width: 0;
}

.remediation-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remediation-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}

/* Scheduler Summary */
.scheduler-summary {
  display: flex;
  justify-content: space-around;
  padding: 12px 0;
}

.summary-item {
  text-align: center;
}

.summary-label {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.summary-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.summary-value.success {
  color: var(--el-color-success);
}

/* Next Tasks */
.next-tasks {
  padding-top: 8px;
}

.next-tasks-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  margin-bottom: 12px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.task-info {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-type {
  margin-top: 4px;
}

.task-next-run {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

/* Responsive */
@media (max-width: 768px) {
  .header-actions {
    flex-direction: column;
    width: 100%;
    justify-content: flex-end;
  }

  .resource-card {
    margin-bottom: 12px;
  }
}
</style>
