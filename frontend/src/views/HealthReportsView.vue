<template>
  <div class="health-reports-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>健康报告</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showGenerateDialog">
              生成报告
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadReports">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && reports.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="loadReports">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-card v-else-if="reports.length === 0" shadow="hover">
      <el-empty description="暂无健康报告">
        <el-button type="primary" @click="showGenerateDialog">生成第一份报告</el-button>
      </el-empty>
    </el-card>

    <!-- Reports Table -->
    <el-card v-else shadow="hover">
      <el-table
        v-loading="loading"
        :data="reports"
        stripe
        style="width: 100%"
        @row-click="handleRowClick"
      >
        <el-table-column label="生成时间" width="180">
          <template #default="{ row }">
            <div class="time-cell">
              <el-icon><i-ep-clock /></el-icon>
              <span>{{ formatTime(row.generatedAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所属设备" width="140">
          <template #default="{ row }">
            <span v-if="getDeviceName(row.deviceId || row.device_id)" class="device-name-tag">{{ getDeviceName(row.deviceId || row.device_id) }}</span>
            <span v-else class="no-data">-</span>
          </template>
        </el-table-column>
        <el-table-column label="报告周期" min-width="200">
          <template #default="{ row }">
            {{ formatPeriod(row.period) }}
          </template>
        </el-table-column>
        <el-table-column label="健康状态" width="120">
          <template #default="{ row }">
            <el-tag 
              :type="getHealthType(row.summary.overallHealth)" 
              size="small"
              style="display: inline-flex; align-items: center; white-space: nowrap"
            >
              <el-icon class="health-icon">
                <component :is="getHealthIcon(row.summary.overallHealth)" />
              </el-icon>
              {{ getHealthText(row.summary.overallHealth) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="健康评分" width="120">
          <template #default="{ row }">
            <el-progress
              :percentage="row.summary.score"
              :color="getScoreColor(row.summary.score)"
              :stroke-width="8"
              :show-text="true"
            />
          </template>
        </el-table-column>
        <el-table-column label="告警数" width="100">
          <template #default="{ row }">
            <el-badge :value="row.alerts.total" :type="row.alerts.total > 0 ? 'danger' : 'info'" />
          </template>
        </el-table-column>
        <el-table-column label="配置变更" width="100">
          <template #default="{ row }">
            <span>{{ row.configChanges }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click.stop="viewReport(row)">
              <el-icon><i-ep-view /></el-icon>
              查看
            </el-button>
            <el-dropdown @command="(cmd: string) => handleExport(row, cmd)" @click.stop>
              <el-button size="small" type="success" link>
                <el-icon><i-ep-download /></el-icon>
                导出
                <el-icon class="el-icon--right"><i-ep-arrow-down /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="markdown">Markdown</el-dropdown-item>
                  <el-dropdown-item command="pdf">PDF</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-popconfirm
              title="确定要删除此报告吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="deleteReport(row)"
            >
              <template #reference>
                <el-button size="small" type="danger" link @click.stop>
                  <el-icon><i-ep-delete /></el-icon>
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Generate Report Dialog -->
    <el-dialog
      v-model="generateDialogVisible"
      title="生成健康报告"
      width="500px"
      destroy-on-close
    >
      <el-form :model="generateForm" label-width="100px">
        <el-form-item label="报告周期">
          <el-radio-group v-model="generateForm.periodType" @change="handlePeriodTypeChange">
            <el-radio value="day">最近 24 小时</el-radio>
            <el-radio value="week">最近 7 天</el-radio>
            <el-radio value="custom">自定义</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="generateForm.periodType === 'custom'" label="时间范围">
          <el-date-picker
            v-model="generateForm.dateRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            :shortcuts="dateShortcuts"
          />
        </el-form-item>
        <el-form-item label="通知渠道">
          <el-select
            v-model="generateForm.channelIds"
            multiple
            placeholder="选择通知渠道（可选）"
            style="width: 100%"
          >
            <el-option
              v-for="channel in notificationChannels"
              :key="channel.id"
              :label="channel.name"
              :value="channel.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="generateDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="generating" @click="generateReport">
          生成报告
        </el-button>
      </template>
    </el-dialog>

    <!-- Report Detail Dialog -->
    <el-dialog
      v-model="detailDialogVisible"
      title="健康报告详情"
      width="900px"
      destroy-on-close
      class="report-detail-dialog"
    >
      <div v-if="selectedReport" class="report-detail">
        <!-- Summary Section -->
        <div class="detail-section">
          <div class="section-header">
            <el-icon><i-ep-data-analysis /></el-icon>
            <span>报告概览</span>
          </div>
          <el-row :gutter="20">
            <el-col :span="8">
              <div class="summary-card">
                <div class="summary-label">健康状态</div>
                <el-tag :type="getHealthType(selectedReport.summary.overallHealth)" size="large">
                  <el-icon class="health-icon">
                    <component :is="getHealthIcon(selectedReport.summary.overallHealth)" />
                  </el-icon>
                  {{ getHealthText(selectedReport.summary.overallHealth) }}
                </el-tag>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="summary-card">
                <div class="summary-label">健康评分</div>
                <el-progress
                  type="circle"
                  :percentage="selectedReport.summary.score"
                  :color="getScoreColor(selectedReport.summary.score)"
                  :width="80"
                />
              </div>
            </el-col>
            <el-col :span="8">
              <div class="summary-card">
                <div class="summary-label">报告周期</div>
                <div class="period-text">{{ formatPeriod(selectedReport.period) }}</div>
              </div>
            </el-col>
          </el-row>
        </div>

        <!-- Metrics Section -->
        <div class="detail-section">
          <div class="section-header">
            <el-icon><i-ep-cpu /></el-icon>
            <span>资源使用统计</span>
          </div>
          <el-row :gutter="20">
            <el-col :span="8">
              <el-card shadow="never" class="metric-card">
                <div class="metric-title">CPU 使用率</div>
                <div class="metric-values">
                  <div class="metric-item">
                    <span class="metric-label">平均</span>
                    <span class="metric-value">{{ selectedReport.metrics.cpu.avg.toFixed(1) }}%</span>
                  </div>
                  <div class="metric-item">
                    <span class="metric-label">最高</span>
                    <span class="metric-value danger">{{ selectedReport.metrics.cpu.max.toFixed(1) }}%</span>
                  </div>
                  <div class="metric-item">
                    <span class="metric-label">最低</span>
                    <span class="metric-value success">{{ selectedReport.metrics.cpu.min.toFixed(1) }}%</span>
                  </div>
                </div>
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card shadow="never" class="metric-card">
                <div class="metric-title">内存使用率</div>
                <div class="metric-values">
                  <div class="metric-item">
                    <span class="metric-label">平均</span>
                    <span class="metric-value">{{ selectedReport.metrics.memory.avg.toFixed(1) }}%</span>
                  </div>
                  <div class="metric-item">
                    <span class="metric-label">最高</span>
                    <span class="metric-value danger">{{ selectedReport.metrics.memory.max.toFixed(1) }}%</span>
                  </div>
                  <div class="metric-item">
                    <span class="metric-label">最低</span>
                    <span class="metric-value success">{{ selectedReport.metrics.memory.min.toFixed(1) }}%</span>
                  </div>
                </div>
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card shadow="never" class="metric-card">
                <div class="metric-title">磁盘使用率</div>
                <div class="metric-values">
                  <div class="metric-item">
                    <span class="metric-label">平均</span>
                    <span class="metric-value">{{ selectedReport.metrics.disk.avg.toFixed(1) }}%</span>
                  </div>
                  <div class="metric-item">
                    <span class="metric-label">最高</span>
                    <span class="metric-value danger">{{ selectedReport.metrics.disk.max.toFixed(1) }}%</span>
                  </div>
                  <div class="metric-item">
                    <span class="metric-label">最低</span>
                    <span class="metric-value success">{{ selectedReport.metrics.disk.min.toFixed(1) }}%</span>
                  </div>
                </div>
              </el-card>
            </el-col>
          </el-row>
        </div>

        <!-- Interfaces Section -->
        <div class="detail-section" v-if="selectedReport.interfaces.length > 0">
          <div class="section-header">
            <el-icon><i-ep-connection /></el-icon>
            <span>接口流量统计</span>
          </div>
          <el-table :data="selectedReport.interfaces" size="small" stripe>
            <el-table-column prop="name" label="接口名称" width="150" />
            <el-table-column label="平均接收速率">
              <template #default="{ row }">
                {{ formatBytesRate(row.avgRxRate) }}
              </template>
            </el-table-column>
            <el-table-column label="平均发送速率">
              <template #default="{ row }">
                {{ formatBytesRate(row.avgTxRate) }}
              </template>
            </el-table-column>
            <el-table-column label="停机时间">
              <template #default="{ row }">
                {{ formatDuration(row.downtime) }}
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- Alerts Section -->
        <div class="detail-section">
          <div class="section-header">
            <el-icon><i-ep-bell /></el-icon>
            <span>告警事件汇总</span>
          </div>
          <el-row :gutter="20">
            <el-col :span="12">
              <div class="alert-summary">
                <div class="alert-total">
                  <span class="total-label">告警总数</span>
                  <span class="total-value">{{ selectedReport.alerts.total }}</span>
                </div>
                <div class="alert-by-severity">
                  <el-tag type="info" size="small">信息: {{ selectedReport.alerts.bySeverity.info || 0 }}</el-tag>
                  <el-tag type="warning" size="small">警告: {{ selectedReport.alerts.bySeverity.warning || 0 }}</el-tag>
                  <el-tag type="danger" size="small">严重: {{ selectedReport.alerts.bySeverity.critical || 0 }}</el-tag>
                  <el-tag type="danger" size="small">紧急: {{ selectedReport.alerts.bySeverity.emergency || 0 }}</el-tag>
                </div>
              </div>
            </el-col>
            <el-col :span="12">
              <div class="top-rules" v-if="selectedReport.alerts.topRules.length > 0">
                <div class="top-rules-title">触发最多的规则</div>
                <div v-for="rule in selectedReport.alerts.topRules" :key="rule.ruleName" class="top-rule-item">
                  <span class="rule-name">{{ rule.ruleName }}</span>
                  <el-tag size="small">{{ rule.count }} 次</el-tag>
                </div>
              </div>
              <el-empty v-else description="无告警记录" :image-size="40" />
            </el-col>
          </el-row>
        </div>

        <!-- AI Analysis Section -->
        <div class="detail-section">
          <div class="section-header">
            <el-icon><i-ep-magic-stick /></el-icon>
            <span>AI 分析与建议</span>
          </div>
          <el-row :gutter="20">
            <el-col :span="8">
              <el-card shadow="never" class="ai-card">
                <template #header>
                  <div class="ai-card-header">
                    <el-icon color="#f56c6c"><i-ep-warning-filled /></el-icon>
                    <span>风险提示</span>
                  </div>
                </template>
                <ul v-if="selectedReport.aiAnalysis.risks.length > 0" class="ai-list">
                  <li v-for="(risk, index) in selectedReport.aiAnalysis.risks" :key="index">
                    {{ risk }}
                  </li>
                </ul>
                <el-empty v-else description="无风险提示" :image-size="40" />
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card shadow="never" class="ai-card">
                <template #header>
                  <div class="ai-card-header">
                    <el-icon color="#67c23a"><i-ep-circle-check-filled /></el-icon>
                    <span>优化建议</span>
                  </div>
                </template>
                <ul v-if="selectedReport.aiAnalysis.recommendations.length > 0" class="ai-list">
                  <li v-for="(rec, index) in selectedReport.aiAnalysis.recommendations" :key="index">
                    {{ rec }}
                  </li>
                </ul>
                <el-empty v-else description="无优化建议" :image-size="40" />
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card shadow="never" class="ai-card">
                <template #header>
                  <div class="ai-card-header">
                    <el-icon color="#409eff"><i-ep-trend-charts /></el-icon>
                    <span>趋势分析</span>
                  </div>
                </template>
                <ul v-if="selectedReport.aiAnalysis.trends.length > 0" class="ai-list">
                  <li v-for="(trend, index) in selectedReport.aiAnalysis.trends" :key="index">
                    {{ trend }}
                  </li>
                </ul>
                <el-empty v-else description="无趋势分析" :image-size="40" />
              </el-card>
            </el-col>
          </el-row>
        </div>
      </div>

      <template #footer>
        <el-button @click="detailDialogVisible = false">关闭</el-button>
        <el-dropdown split-button type="primary" @click="handleExport(selectedReport!, 'markdown')" @command="(cmd: string) => handleExport(selectedReport!, cmd)">
          导出 Markdown
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="markdown">Markdown</el-dropdown-item>
              <el-dropdown-item command="pdf">PDF</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </el-dialog>
  </div>
</template>


<script setup lang="ts">
import { Plus, Refresh, SuccessFilled, WarningFilled, CircleCloseFilled } from '@element-plus/icons-vue'

import { ref, onMounted, markRaw, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  reportsApi,
  notificationChannelsApi,
  type HealthReport,
  type HealthStatus,
  type NotificationChannel
} from '@/api/ai-ops'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'

// State
const loading = ref(false)
const generating = ref(false)
const error = ref('')
const reports = ref<HealthReport[]>([])
const notificationChannels = ref<NotificationChannel[]>([])
const generateDialogVisible = ref(false)
const detailDialogVisible = ref(false)
const selectedReport = ref<HealthReport | null>(null)

// Generate form
const generateForm = ref({
  periodType: 'day' as 'day' | 'week' | 'custom',
  dateRange: null as [Date, Date] | null,
  channelIds: [] as string[]
})

// Device store
const deviceStore = useDeviceStore()
const { currentDeviceId, devices } = storeToRefs(deviceStore)

// 设备名称映射
const getDeviceName = (deviceId?: string | null) => {
  if (!deviceId) return ''
  return devices.value.find(d => d.id === deviceId)?.name || ''
}

// Date shortcuts for date picker
const dateShortcuts = [
  {
    text: '最近 24 小时',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setTime(start.getTime() - 24 * 60 * 60 * 1000)
      return [start, end]
    }
  },
  {
    text: '最近 7 天',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setTime(start.getTime() - 7 * 24 * 60 * 60 * 1000)
      return [start, end]
    }
  },
  {
    text: '最近 30 天',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setTime(start.getTime() - 30 * 24 * 60 * 60 * 1000)
      return [start, end]
    }
  }
]

// Load data on mount
onMounted(() => {
  loadReports()
  loadNotificationChannels()
})

// Watch device change
watch(currentDeviceId, () => {
  loadReports()
})

// Load reports
const loadReports = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await reportsApi.getAll(undefined, currentDeviceId.value)
    if (response.data.success && response.data.data) {
      reports.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取报告列表失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取报告列表失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Load notification channels
const loadNotificationChannels = async () => {
  try {
    const response = await notificationChannelsApi.getAll()
    if (response.data.success && response.data.data) {
      notificationChannels.value = response.data.data
    }
  } catch (err) {
    console.error('Failed to load notification channels:', err)
  }
}

// Show generate dialog
const showGenerateDialog = () => {
  generateForm.value = {
    periodType: 'day',
    dateRange: null,
    channelIds: []
  }
  generateDialogVisible.value = true
}

// Handle period type change
const handlePeriodTypeChange = () => {
  if (generateForm.value.periodType !== 'custom') {
    generateForm.value.dateRange = null
  }
}

// Generate report
const generateReport = async () => {
  let from: number
  let to: number

  const now = Date.now()

  if (generateForm.value.periodType === 'day') {
    from = now - 24 * 60 * 60 * 1000
    to = now
  } else if (generateForm.value.periodType === 'week') {
    from = now - 7 * 24 * 60 * 60 * 1000
    to = now
  } else if (generateForm.value.periodType === 'custom' && generateForm.value.dateRange) {
    from = generateForm.value.dateRange[0].getTime()
    to = generateForm.value.dateRange[1].getTime()
  } else {
    ElMessage.warning('请选择时间范围')
    return
  }

  generating.value = true

  try {
    const response = await reportsApi.generate(
      from,
      to,
      generateForm.value.channelIds,
      currentDeviceId.value
    )
    if (response.data.success && response.data.data) {
      ElMessage.success('报告生成成功')
      generateDialogVisible.value = false
      await loadReports()
      // Show the newly generated report
      selectedReport.value = response.data.data
      detailDialogVisible.value = true
    } else {
      throw new Error(response.data.error || '生成报告失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '生成报告失败'
    ElMessage.error(message)
  } finally {
    generating.value = false
  }
}

// View report detail
const viewReport = (report: HealthReport) => {
  selectedReport.value = report
  detailDialogVisible.value = true
}

// Handle row click
const handleRowClick = (row: HealthReport) => {
  viewReport(row)
}

// Handle export
const handleExport = async (report: HealthReport, format: string) => {
  try {
    ElMessage.info(`正在导出 ${format.toUpperCase()} 格式...`)
    
    let blob: Blob
    let filename: string
    
    if (format === 'markdown') {
      blob = await reportsApi.exportMarkdown(report.id)
      filename = `health-report-${formatFileName(report.generatedAt)}.md`
    } else {
      blob = await reportsApi.exportPdf(report.id)
      filename = `health-report-${formatFileName(report.generatedAt)}.pdf`
    }
    
    // Create download link
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
    
    ElMessage.success('导出成功')
  } catch (err) {
    const message = err instanceof Error ? err.message : '导出失败'
    ElMessage.error(message)
  }
}

// Delete report
const deleteReport = async (report: HealthReport) => {
  try {
    await reportsApi.delete(report.id)
    ElMessage.success('报告已删除')
    await loadReports()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除报告失败'
    ElMessage.error(message)
  }
}

// Utility functions
const formatTime = (timestamp: number): string => {
  if (!timestamp || timestamp <= 0) {
    return '未知'
  }
  try {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) {
      return '未知'
    }
    return date.toLocaleString('zh-CN')
  } catch {
    return '未知'
  }
}

const formatFileName = (timestamp: number): string => {
  const date = new Date(timestamp)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
}

const formatPeriod = (period: { from: number; to: number }): string => {
  const from = new Date(period.from).toLocaleString('zh-CN')
  const to = new Date(period.to).toLocaleString('zh-CN')
  return `${from} ~ ${to}`
}

const formatBytesRate = (bytes: number): string => {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B/s'
  const k = 1024
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  if (i < 0 || i >= sizes.length) return '0 B/s'
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatDuration = (ms: number): string => {
  if (ms === 0) return '无停机'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  
  if (hours > 0) {
    return `${hours}小时${minutes % 60}分钟`
  } else if (minutes > 0) {
    return `${minutes}分钟`
  } else {
    return `${seconds}秒`
  }
}

const getHealthType = (health: HealthStatus): 'success' | 'warning' | 'danger' => {
  const types: Record<HealthStatus, 'success' | 'warning' | 'danger'> = {
    healthy: 'success',
    warning: 'warning',
    critical: 'danger'
  }
  return types[health]
}

const getHealthText = (health: HealthStatus): string => {
  const texts: Record<HealthStatus, string> = {
    healthy: '健康',
    warning: '警告',
    critical: '严重'
  }
  return texts[health]
}

const getHealthIcon = (health: HealthStatus) => {
  const icons: Record<HealthStatus, unknown> = {
    healthy: markRaw(SuccessFilled),
    warning: markRaw(WarningFilled),
    critical: markRaw(CircleCloseFilled)
  }
  return icons[health]
}

const getScoreColor = (score: number): string => {
  if (score >= 80) return '#67c23a'
  if (score >= 60) return '#e6a23c'
  return '#f56c6c'
}
</script>


<style scoped>
.health-reports-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

/* Header */
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
  gap: 12px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Table */
.time-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.health-icon {
  display: inline-flex;
  vertical-align: middle;
  margin-right: 4px;
}

/* Report Detail Dialog */
.report-detail-dialog :deep(.el-dialog__body) {
  max-height: 70vh;
  overflow-y: auto;
}

.report-detail {
  padding: 0 10px;
}

.detail-section {
  margin-bottom: 24px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

/* Summary Cards */
.summary-card {
  text-align: center;
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

.summary-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-bottom: 12px;
}

.period-text {
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

/* Metric Cards */
.metric-card {
  background: var(--el-fill-color-light);
}

.metric-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 12px;
  text-align: center;
}

.metric-values {
  display: flex;
  justify-content: space-around;
}

.metric-item {
  text-align: center;
}

.metric-label {
  display: block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.metric-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.metric-value.danger {
  color: var(--el-color-danger);
}

.metric-value.success {
  color: var(--el-color-success);
}

/* Alert Summary */
.alert-summary {
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

.alert-total {
  text-align: center;
  margin-bottom: 16px;
}

.total-label {
  display: block;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.total-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}

.alert-by-severity {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

/* Top Rules */
.top-rules {
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
}

.top-rules-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  margin-bottom: 12px;
}

.top-rule-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.top-rule-item:last-child {
  border-bottom: none;
}

.rule-name {
  font-size: 13px;
  color: var(--el-text-color-primary);
}

/* AI Cards */
.ai-card {
  height: 100%;
}

.ai-card :deep(.el-card__header) {
  padding: 12px 16px;
  background: var(--el-fill-color-light);
}

.ai-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}

.ai-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.8;
}

.ai-list li {
  margin-bottom: 4px;
}

/* Responsive */
@media (max-width: 768px) {
  .header-card :deep(.el-card__header) {
    flex-direction: column;
    gap: 12px;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .report-detail-dialog :deep(.el-dialog) {
    width: 95% !important;
  }
}
</style>
