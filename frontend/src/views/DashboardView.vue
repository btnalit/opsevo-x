<template>
  <div class="dashboard-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>系统资源监控</span>
          <div class="header-actions">
            <el-tag v-if="autoRefresh" type="success" size="small">
              自动刷新中
            </el-tag>
            <el-button
              :icon="Refresh"
              :loading="loading"
              @click="loadResource"
            >
              刷新
            </el-button>
          </div>
        </div>
      </template>

      <!-- No Device Selected -->
      <el-empty
        v-if="!deviceStore.currentDeviceId"
        description="请先选择设备"
      >
        <el-button type="primary" @click="$router.push('/devices')">前往设备管理</el-button>
      </el-empty>

      <!-- Loading State -->
      <el-skeleton v-else-if="loading && !resource" :rows="5" animated />

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
          <el-button type="primary" size="small" @click="loadResource">
            重新加载
          </el-button>
        </template>
      </el-alert>

      <!-- Resource Display -->
      <div v-else-if="resource" class="resource-container" v-loading="loading">
        <!-- Static Info Row -->
        <el-row :gutter="20" class="info-row">
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">CPU 型号</div>
              <div class="info-value">{{ resource.cpu || '-' }}</div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">CPU 核心数</div>
              <div class="info-value">{{ resource['cpu-count'] || '-' }} 核</div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">CPU 频率</div>
              <div class="info-value">{{ resource['cpu-frequency'] || '-' }} MHz</div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">架构</div>
              <div class="info-value">{{ resource['architecture-name'] || '-' }}</div>
            </div>
          </el-col>
        </el-row>

        <el-row :gutter="20" class="info-row">
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">主板名称</div>
              <el-tooltip :content="resource['board-name'] || '-'" placement="top" :disabled="!resource['board-name']">
                <div class="info-value">{{ resource['board-name'] || '-' }}</div>
              </el-tooltip>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">RouterOS 版本</div>
              <div class="info-value">{{ resource.version || '-' }}</div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">系统启动时间</div>
              <div class="info-value">{{ calculateBootTime(resource.uptime) }}</div>
            </div>
          </el-col>
          <el-col :xs="24" :sm="12" :md="8" :lg="6">
            <div class="info-card">
              <div class="info-label">运行时间</div>
              <div class="info-value uptime">{{ formatUptime(resource.uptime) }}</div>
            </div>
          </el-col>
        </el-row>

        <el-divider />

        <!-- Dynamic Resource Row -->
        <el-row :gutter="20" class="resource-row">
          <!-- CPU Load -->
          <el-col :xs="24" :sm="12" :md="8">
            <div class="resource-card">
              <div class="resource-header">
                <el-icon :size="24" color="#409eff"><i-ep-cpu /></el-icon>
                <span class="resource-title">CPU 负载</span>
              </div>
              <div class="resource-progress">
                <el-progress
                  type="dashboard"
                  :percentage="cpuLoad"
                  :color="getProgressColor(cpuLoad)"
                  :width="120"
                >
                  <template #default="{ percentage }">
                    <span class="percentage-value">{{ percentage }}%</span>
                  </template>
                </el-progress>
              </div>
              <div class="resource-detail">
                {{ resource['cpu-count'] || '-' }} 核 @ {{ resource['cpu-frequency'] || '-' }} MHz
              </div>
            </div>
          </el-col>

          <!-- Memory Usage -->
          <el-col :xs="24" :sm="12" :md="8">
            <div class="resource-card">
              <div class="resource-header">
                <el-icon :size="24" color="#67c23a"><i-ep-coin /></el-icon>
                <span class="resource-title">内存使用</span>
              </div>
              <div class="resource-progress">
                <el-progress
                  type="dashboard"
                  :percentage="memoryPercent"
                  :color="getProgressColor(memoryPercent)"
                  :width="120"
                >
                  <template #default="{ percentage }">
                    <span class="percentage-value">{{ percentage }}%</span>
                  </template>
                </el-progress>
              </div>
              <div class="resource-detail">
                {{ formatBytes(memoryUsed) }} / {{ formatBytes(memoryTotal) }}
              </div>
            </div>
          </el-col>

          <!-- Disk Usage -->
          <el-col :xs="24" :sm="12" :md="8">
            <div class="resource-card">
              <div class="resource-header">
                <el-icon :size="24" color="#e6a23c"><i-ep-files /></el-icon>
                <span class="resource-title">磁盘使用</span>
              </div>
              <div class="resource-progress">
                <el-progress
                  type="dashboard"
                  :percentage="diskPercent"
                  :color="getProgressColor(diskPercent)"
                  :width="120"
                >
                  <template #default="{ percentage }">
                    <span class="percentage-value">{{ percentage }}%</span>
                  </template>
                </el-progress>
              </div>
              <div class="resource-detail">
                {{ formatBytes(diskUsed) }} / {{ formatBytes(diskTotal) }}
              </div>
            </div>
          </el-col>
        </el-row>
      </div>
    </el-card>
  </div>
</template>


<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { dashboardApi } from '@/api/system'
import { useDeviceStore } from '@/stores/device'

// System Resource interface
interface SystemResource {
  '.id'?: string
  'cpu': string
  'cpu-count': string
  'cpu-frequency': string
  'cpu-load': string
  'architecture-name': string
  'board-name': string
  'version': string
  'build-time': string
  'uptime': string
  'total-memory': string
  'free-memory': string
  'total-hdd-space': string
  'free-hdd-space': string
}

// State
const loading = ref(false)
const error = ref('')
const resource = ref<SystemResource | null>(null)
const autoRefresh = ref(true)
let refreshTimer: ReturnType<typeof setInterval> | null = null

// Computed values
const cpuLoad = computed(() => {
  if (!resource.value) return 0
  return parseInt(resource.value['cpu-load']) || 0
})

const memoryTotal = computed(() => {
  if (!resource.value) return 0
  return parseInt(resource.value['total-memory']) || 0
})

const memoryFree = computed(() => {
  if (!resource.value) return 0
  return parseInt(resource.value['free-memory']) || 0
})

const memoryUsed = computed(() => {
  return memoryTotal.value - memoryFree.value
})

const memoryPercent = computed(() => {
  if (memoryTotal.value === 0) return 0
  return Math.round((memoryUsed.value / memoryTotal.value) * 100)
})

const diskTotal = computed(() => {
  if (!resource.value) return 0
  return parseInt(resource.value['total-hdd-space']) || 0
})

const diskFree = computed(() => {
  if (!resource.value) return 0
  return parseInt(resource.value['free-hdd-space']) || 0
})

const diskUsed = computed(() => {
  return diskTotal.value - diskFree.value
})

const diskPercent = computed(() => {
  if (diskTotal.value === 0) return 0
  return Math.round((diskUsed.value / diskTotal.value) * 100)
})

// Load resource data
const loadResource = async () => {
  const currentId = deviceStore.currentDeviceId
  if (!currentId) return
  loading.value = true
  error.value = ''

  try {
    const response = await dashboardApi.getResource()
    // 如果等待期间设备已切换，丢弃该响应
    if (currentId !== deviceStore.currentDeviceId) return
    const result = response.data
    if (result.success && result.data) {
      resource.value = result.data
    } else {
      throw new Error(result.error || '获取资源信息失败')
    }
  } catch (err: unknown) {
    if (currentId !== deviceStore.currentDeviceId) return
    const message = err instanceof Error ? err.message : '获取系统资源信息失败'
    error.value = message
    if (!resource.value) {
      ElMessage.error(message)
    }
  } finally {
    if (currentId === deviceStore.currentDeviceId) {
      loading.value = false
    }
  }
}

// Format bytes to human readable
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// Format uptime from RouterOS format (1w6d7h24m25s) to readable format
const formatUptime = (uptime: string): string => {
  if (!uptime) return '-'
  
  // Parse RouterOS uptime format: 1w6d7h24m25s
  const weeks = uptime.match(/(\d+)w/)
  const days = uptime.match(/(\d+)d/)
  const hours = uptime.match(/(\d+)h/)
  const minutes = uptime.match(/(\d+)m/)
  
  // Calculate total days (including weeks)
  let totalDays = 0
  if (weeks) totalDays += parseInt(weeks[1]) * 7
  if (days) totalDays += parseInt(days[1])
  
  const hoursVal = hours ? parseInt(hours[1]) : 0
  const minutesVal = minutes ? parseInt(minutes[1]) : 0
  
  const parts: string[] = []
  
  if (totalDays > 0) parts.push(`${totalDays} 天`)
  if (hoursVal > 0 || totalDays > 0) parts.push(`${hoursVal} 小时`)
  parts.push(`${minutesVal} 分钟`)
  
  return parts.join(' ')
}

// Calculate system boot time from uptime
const calculateBootTime = (uptime: string): string => {
  if (!uptime) return '-'
  
  // Parse RouterOS uptime format: 1w6d7h24m25s
  const weeks = uptime.match(/(\d+)w/)
  const days = uptime.match(/(\d+)d/)
  const hours = uptime.match(/(\d+)h/)
  const minutes = uptime.match(/(\d+)m/)
  const seconds = uptime.match(/(\d+)s/)
  
  // Calculate total milliseconds
  let totalMs = 0
  if (weeks) totalMs += parseInt(weeks[1]) * 7 * 24 * 60 * 60 * 1000
  if (days) totalMs += parseInt(days[1]) * 24 * 60 * 60 * 1000
  if (hours) totalMs += parseInt(hours[1]) * 60 * 60 * 1000
  if (minutes) totalMs += parseInt(minutes[1]) * 60 * 1000
  if (seconds) totalMs += parseInt(seconds[1]) * 1000
  
  // Calculate boot time
  const bootTime = new Date(Date.now() - totalMs)
  
  // Format as YYYY-MM-DD HH:mm:ss
  const year = bootTime.getFullYear()
  const month = String(bootTime.getMonth() + 1).padStart(2, '0')
  const day = String(bootTime.getDate()).padStart(2, '0')
  const hour = String(bootTime.getHours()).padStart(2, '0')
  const minute = String(bootTime.getMinutes()).padStart(2, '0')
  const second = String(bootTime.getSeconds()).padStart(2, '0')
  
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

// Get progress bar color based on percentage
const getProgressColor = (percentage: number): string => {
  if (percentage < 60) return 'var(--el-color-success)'
  if (percentage < 80) return 'var(--el-color-warning)'
  return 'var(--el-color-danger)'
}

// Start auto refresh
const startAutoRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
  refreshTimer = setInterval(() => {
    if (autoRefresh.value) {
      loadResource()
    }
  }, 5000) // 5 seconds
}

// Stop auto refresh
const stopAutoRefresh = () => {
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
      resource.value = null
      error.value = ''
      
      // 仅在有设备时重新加载并启动定时器
      if (newDeviceId) {
        loadResource()
        startAutoRefresh()
      } else {
        stopAutoRefresh()
      }
    }
  }
)

// Lifecycle hooks
onMounted(() => {
  if (deviceStore.currentDeviceId) {
    loadResource()
    startAutoRefresh()
  }
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.dashboard-view {
  height: 100%;
  padding: 20px;
  background: var(--el-bg-color-page);
  overflow-y: auto;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.resource-container {
  padding: 10px 0;
}

.info-row {
  margin-bottom: 16px;
}

.info-card {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 12px;
  transition: all 0.3s ease;
  border-left: 4px solid var(--el-color-primary);
  min-height: 90px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.info-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.info-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 10px;
  font-weight: 500;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.info-label::before {
  content: '';
  width: 6px;
  height: 6px;
  background: var(--el-color-primary);
  border-radius: 50%;
  flex-shrink: 0;
}

.info-value {
  font-size: 18px;
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

.resource-row {
  margin-top: 20px;
}

.resource-card {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 16px;
  padding: 28px;
  text-align: center;
  margin-bottom: 16px;
  transition: all 0.3s ease;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.resource-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.resource-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 20px;
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
  font-size: 26px;
  font-weight: 700;
}

.resource-detail {
  font-size: 14px;
  color: var(--el-text-color-regular);
  font-weight: 500;
}
</style>
