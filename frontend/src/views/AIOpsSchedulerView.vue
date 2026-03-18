<template>
  <div class="ai-ops-scheduler-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>定时任务管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              新建任务
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadTasks">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && tasks.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="loadTasks">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Tasks Table -->
    <el-card v-else shadow="hover" class="tasks-card">
      <el-table
        v-loading="loading"
        :data="tasks"
        stripe
        style="width: 100%"
        @row-click="handleRowClick"
      >
        <el-table-column prop="name" label="任务名称" min-width="150" show-overflow-tooltip />
        <el-table-column label="所属设备" width="140">
          <template #default="{ row }">
            <span v-if="getDeviceName(row.deviceId || row.device_id)" class="device-name-tag">{{ getDeviceName(row.deviceId || row.device_id) }}</span>
            <span v-else class="no-data">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="type" label="任务类型" width="120">
          <template #default="{ row }">
            <el-tag :type="getTaskTypeTagType(row.type)" size="small">
              {{ getTaskTypeText(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="cron" label="Cron 表达式" width="150">
          <template #default="{ row }">
            <el-tooltip :content="getCronDescription(row.cron)" placement="top">
              <code class="cron-code">{{ row.cron }}</code>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上次执行" width="160">
          <template #default="{ row }">
            {{ row.lastRunAt ? formatTime(row.lastRunAt) : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="下次执行" width="160">
          <template #default="{ row }">
            <span v-if="row.enabled && row.nextRunAt" class="next-run-time">
              {{ formatNextRun(row.nextRunAt) }}
            </span>
            <span v-else class="no-schedule">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="success" link @click.stop="runTask(row)">
              <el-icon><i-ep-video-play /></el-icon>
              执行
            </el-button>
            <el-button size="small" type="primary" link @click.stop="editTask(row)">
              编辑
            </el-button>
            <el-button
              size="small"
              :type="row.enabled ? 'warning' : 'success'"
              link
              @click.stop="toggleTask(row)"
            >
              {{ row.enabled ? '禁用' : '启用' }}
            </el-button>
            <el-popconfirm
              title="确定要删除此任务吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="deleteTask(row)"
            >
              <template #reference>
                <el-button size="small" type="danger" link @click.stop>
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Execution History -->
    <el-card shadow="hover" class="history-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <el-icon :size="20" color="#909399"><i-ep-list /></el-icon>
            <span>执行历史</span>
          </div>
          <el-button text size="small" @click="loadExecutions">
            <el-icon><i-ep-refresh /></el-icon>
            刷新
          </el-button>
        </div>
      </template>
      <el-table
        v-loading="executionsLoading"
        :data="executions"
        stripe
        style="width: 100%"
        max-height="400"
      >
        <el-table-column prop="taskName" label="任务名称" min-width="150" show-overflow-tooltip />
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="getTaskTypeTagType(row.type)" size="small">
              {{ getTaskTypeText(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getExecutionStatusType(row.status)" size="small">
              {{ getExecutionStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.startedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="100">
          <template #default="{ row }">
            {{ row.completedAt ? formatDuration(row.completedAt - row.startedAt) : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="结果" min-width="200">
          <template #default="{ row }">
            <span v-if="row.error" class="error-text">{{ row.error }}</span>
            <template v-else-if="row.result">
              <el-button
                v-if="row.type === 'inspection' && isInspectionResult(row.result)"
                type="primary"
                link
                size="small"
                @click="showExecutionDetail(row)"
              >
                <el-icon><i-ep-view /></el-icon>
                查看详情
              </el-button>
              <span v-else class="result-text">{{ formatResult(row.result) }}</span>
            </template>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Create/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑定时任务' : '新建定时任务'"
      width="600px"
      destroy-on-close
      @close="resetForm"
    >
      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-width="100px"
        label-position="right"
      >
        <el-form-item label="任务名称" prop="name">
          <el-input v-model="formData.name" placeholder="请输入任务名称" />
        </el-form-item>

        <el-form-item label="任务类型" prop="type">
          <el-select v-model="formData.type" placeholder="选择任务类型" style="width: 100%">
            <el-option
              v-for="item in taskTypeOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            >
              <span>{{ item.label }}</span>
              <span class="option-desc">{{ item.description }}</span>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="Cron 表达式" prop="cron">
          <el-input v-model="formData.cron" placeholder="如: 0 0 * * * (每天0点)">
            <template #append>
              <el-dropdown trigger="click" @command="handleCronPreset">
                <el-button>
                  常用
                  <el-icon class="el-icon--right"><i-ep-arrow-down /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item
                      v-for="preset in cronPresets"
                      :key="preset.value"
                      :command="preset.value"
                    >
                      {{ preset.label }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </el-input>
          <div class="cron-hint" v-if="formData.cron">
            {{ getCronDescription(formData.cron) }}
          </div>
        </el-form-item>

        <el-form-item label="启用状态">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ isEditing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="任务详情"
      width="600px"
      destroy-on-close
    >
      <el-descriptions :column="2" border v-if="selectedTask">
        <el-descriptions-item label="任务名称" :span="2">{{ selectedTask.name }}</el-descriptions-item>
        <el-descriptions-item label="任务类型">
          <el-tag :type="getTaskTypeTagType(selectedTask.type)" size="small">
            {{ getTaskTypeText(selectedTask.type) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="selectedTask.enabled ? 'success' : 'info'" size="small">
            {{ selectedTask.enabled ? '启用' : '禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="Cron 表达式" :span="2">
          <code class="cron-code">{{ selectedTask.cron }}</code>
          <span class="cron-desc">{{ getCronDescription(selectedTask.cron) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="上次执行">
          {{ selectedTask.lastRunAt ? formatTime(selectedTask.lastRunAt) : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="下次执行">
          {{ selectedTask.nextRunAt ? formatTime(selectedTask.nextRunAt) : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="创建时间" :span="2">
          {{ formatTime(selectedTask.createdAt) }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="success" @click="runTask(selectedTask!)">
          <el-icon><i-ep-video-play /></el-icon>
          立即执行
        </el-button>
        <el-button type="primary" @click="editTask(selectedTask!)">编辑</el-button>
      </template>
    </el-dialog>

    <!-- Execution Detail Dialog (Inspection Result) -->
    <el-dialog
      v-model="executionDetailVisible"
      title="巡检报告详情"
      width="800px"
      destroy-on-close
    >
      <template v-if="selectedExecution && selectedInspectionResult">
        <!-- Summary -->
        <el-card shadow="never" class="inspection-summary-card">
          <div class="inspection-summary">
            <div class="summary-item">
              <span class="summary-label">巡检时间</span>
              <span class="summary-value">{{ formatTime(selectedInspectionResult.timestamp) }}</span>
            </div>
            <div class="summary-item">
              <span class="summary-label">整体状态</span>
              <el-tag :type="getOverallStatusType(selectedInspectionResult.summary.overallStatus)" size="large">
                {{ getOverallStatusText(selectedInspectionResult.summary.overallStatus) }}
              </el-tag>
            </div>
            <div class="summary-item">
              <span class="summary-label">发现问题</span>
              <span class="summary-value" :class="{ 'has-issues': selectedInspectionResult.summary.issueCount > 0 }">
                {{ selectedInspectionResult.summary.issueCount }} 个
              </span>
            </div>
          </div>
        </el-card>

        <!-- System Health -->
        <el-card shadow="never" class="inspection-section-card">
          <template #header>
            <span class="section-title">系统健康状态</span>
          </template>
          <el-row :gutter="20">
            <el-col :span="6">
              <div class="metric-item">
                <span class="metric-label">CPU</span>
                <el-progress
                  type="dashboard"
                  :percentage="selectedInspectionResult.systemHealth.cpu"
                  :color="getProgressColor(selectedInspectionResult.systemHealth.cpu)"
                  :width="80"
                />
              </div>
            </el-col>
            <el-col :span="6">
              <div class="metric-item">
                <span class="metric-label">内存</span>
                <el-progress
                  type="dashboard"
                  :percentage="selectedInspectionResult.systemHealth.memory"
                  :color="getProgressColor(selectedInspectionResult.systemHealth.memory)"
                  :width="80"
                />
              </div>
            </el-col>
            <el-col :span="6">
              <div class="metric-item">
                <span class="metric-label">磁盘</span>
                <el-progress
                  type="dashboard"
                  :percentage="selectedInspectionResult.systemHealth.disk"
                  :color="getProgressColor(selectedInspectionResult.systemHealth.disk)"
                  :width="80"
                />
              </div>
            </el-col>
            <el-col :span="6">
              <div class="metric-item">
                <span class="metric-label">运行时间</span>
                <span class="uptime-value">{{ formatUptime(selectedInspectionResult.systemHealth.uptime) }}</span>
              </div>
            </el-col>
          </el-row>
        </el-card>

        <!-- Interfaces -->
        <el-card shadow="never" class="inspection-section-card">
          <template #header>
            <span class="section-title">
              接口状态
              <el-tag type="success" size="small" style="margin-left: 8px;">
                {{ selectedInspectionResult.summary.upInterfaces }} 在线
              </el-tag>
              <el-tag v-if="selectedInspectionResult.summary.downInterfaces > 0" type="danger" size="small" style="margin-left: 4px;">
                {{ selectedInspectionResult.summary.downInterfaces }} 离线
              </el-tag>
            </span>
          </template>
          <el-table :data="selectedInspectionResult.interfaces" stripe max-height="200">
            <el-table-column prop="name" label="接口名称" min-width="120" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'up' ? 'success' : 'danger'" size="small">
                  {{ row.status === 'up' ? '在线' : '离线' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="接收流量" width="120">
              <template #default="{ row }">
                {{ formatBytes(row.rxBytes) }}
              </template>
            </el-table-column>
            <el-table-column label="发送流量" width="120">
              <template #default="{ row }">
                {{ formatBytes(row.txBytes) }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- Issues -->
        <el-card v-if="selectedInspectionResult.issues.length > 0" shadow="never" class="inspection-section-card">
          <template #header>
            <span class="section-title">发现的问题</span>
          </template>
          <el-table :data="selectedInspectionResult.issues" stripe>
            <el-table-column label="严重级别" width="100">
              <template #default="{ row }">
                <el-tag :type="getSeverityTagType(row.severity)" size="small">
                  {{ getSeverityText(row.severity) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="message" label="问题描述" min-width="200" show-overflow-tooltip />
            <el-table-column label="指标" width="120">
              <template #default="{ row }">
                {{ row.metric || '-' }}
              </template>
            </el-table-column>
            <el-table-column label="当前值" width="100">
              <template #default="{ row }">
                {{ row.value !== undefined ? row.value : '-' }}
              </template>
            </el-table-column>
            <el-table-column label="阈值" width="100">
              <template #default="{ row }">
                {{ row.threshold !== undefined ? row.threshold : '-' }}
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- Report Link -->
        <div v-if="selectedInspectionResult.reportId" class="report-link">
          <el-button type="primary" link @click="goToReport(selectedInspectionResult.reportId)">
            <el-icon><i-ep-document /></el-icon>
            查看完整健康报告
          </el-button>
        </div>
      </template>
      <template #footer>
        <el-button @click="executionDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh } from '@element-plus/icons-vue'

import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  schedulerApi,
  type ScheduledTask,
  type TaskExecution,
  type CreateScheduledTaskInput,
  type ScheduledTaskType,
  type TaskExecutionStatus,
  type AlertSeverity
} from '@/api/ai-ops'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'

// Router
const router = useRouter()

// Device store
const deviceStore = useDeviceStore()
const { currentDeviceId, devices } = storeToRefs(deviceStore)

// 设备名称映射
const getDeviceName = (deviceId?: string | null) => {
  if (!deviceId) return ''
  return devices.value.find(d => d.id === deviceId)?.name || ''
}

// Inspection Result Type
interface InspectionResult {
  timestamp: number
  systemHealth: {
    cpu: number
    memory: number
    disk: number
    uptime: number
  }
  interfaces: Array<{
    name: string
    status: 'up' | 'down'
    rxBytes: number
    txBytes: number
  }>
  issues: Array<{
    severity: AlertSeverity
    message: string
    metric?: string
    value?: number
    threshold?: number
  }>
  summary: {
    totalInterfaces: number
    upInterfaces: number
    downInterfaces: number
    issueCount: number
    overallStatus: 'healthy' | 'warning' | 'critical'
  }
  reportId?: string
}

// State
const loading = ref(false)
const executionsLoading = ref(false)
const error = ref('')
const tasks = ref<ScheduledTask[]>([])
const executions = ref<TaskExecution[]>([])
const dialogVisible = ref(false)
const detailVisible = ref(false)
const executionDetailVisible = ref(false)
const isEditing = ref(false)
const submitting = ref(false)
const selectedTask = ref<ScheduledTask | null>(null)
const selectedExecution = ref<TaskExecution | null>(null)
const selectedInspectionResult = ref<InspectionResult | null>(null)
const editingTaskId = ref<string | null>(null)
const formRef = ref<FormInstance>()

// Form data
const getDefaultFormData = (): CreateScheduledTaskInput => ({
  name: '',
  type: 'inspection',
  cron: '0 0 * * *',
  enabled: true
})

const formData = reactive<CreateScheduledTaskInput>(getDefaultFormData())

// Form validation rules
const formRules: FormRules = {
  name: [
    { required: true, message: '请输入任务名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  type: [{ required: true, message: '请选择任务类型', trigger: 'change' }],
  cron: [
    { required: true, message: '请输入 Cron 表达式', trigger: 'blur' },
    { pattern: /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/, message: '请输入有效的 Cron 表达式', trigger: 'blur' }
  ]
}

// Task type options
const taskTypeOptions = [
  { value: 'inspection', label: '巡检任务', description: '生成系统健康报告' },
  { value: 'backup', label: '备份任务', description: '创建配置快照' },
  { value: 'custom', label: '自定义任务', description: '执行自定义操作' }
]

// Cron presets
const cronPresets = [
  { value: '0 * * * *', label: '每小时' },
  { value: '0 0 * * *', label: '每天 0:00' },
  { value: '0 8 * * *', label: '每天 8:00' },
  { value: '0 0 * * 0', label: '每周日 0:00' },
  { value: '0 0 * * 1', label: '每周一 0:00' },
  { value: '0 0 1 * *', label: '每月 1 日 0:00' },
  { value: '*/5 * * * *', label: '每 5 分钟' },
  { value: '*/30 * * * *', label: '每 30 分钟' }
]

// Load data on mount
onMounted(() => {
  loadTasks()
  loadExecutions()
})

// Watch device changes
import { watch } from 'vue'
watch(currentDeviceId, () => {
  loadTasks()
  // loadExecutions() // Optional: if executions should also be filtered by device, but API doesn't seem to support deviceId for executions yet in my previous view of ai-ops.ts?
  // Let's check api/ai-ops.ts: getExecutions: (taskId?: string, limit?: number)
  // It doesn't take deviceId. But tasks do. So filtering tasks is enough for now.
})

// Load tasks
const loadTasks = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await schedulerApi.getTasks(currentDeviceId.value)
    if (response.data.success && response.data.data) {
      tasks.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取任务列表失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取任务列表失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Load executions
const loadExecutions = async () => {
  executionsLoading.value = true

  try {
    const response = await schedulerApi.getExecutions(undefined, 20)
    if (response.data.success && response.data.data) {
      executions.value = response.data.data
    }
  } catch (err) {
    console.error('Failed to load executions:', err)
  } finally {
    executionsLoading.value = false
  }
}

// Show create dialog
const showCreateDialog = () => {
  isEditing.value = false
  editingTaskId.value = null
  Object.assign(formData, getDefaultFormData())
  dialogVisible.value = true
}

// Edit task
const editTask = (task: ScheduledTask) => {
  isEditing.value = true
  editingTaskId.value = task.id
  Object.assign(formData, {
    name: task.name,
    type: task.type,
    cron: task.cron,
    enabled: task.enabled,
    config: task.config
  })
  detailVisible.value = false
  dialogVisible.value = true
}

// Toggle task enabled/disabled
const toggleTask = async (task: ScheduledTask) => {
  try {
    await schedulerApi.updateTask(task.id, { enabled: !task.enabled })
    ElMessage.success(task.enabled ? '任务已禁用' : '任务已启用')
    await loadTasks()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  }
}

// Delete task
const deleteTask = async (task: ScheduledTask) => {
  try {
    await schedulerApi.deleteTask(task.id)
    ElMessage.success('任务已删除')
    await loadTasks()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败'
    ElMessage.error(message)
  }
}

// Run task now
const runTask = async (task: ScheduledTask) => {
  try {
    ElMessage.info(`正在执行任务: ${task.name}`)
    const response = await schedulerApi.runTaskNow(task.id, currentDeviceId.value)
    if (response.data.success && response.data.data) {
      const execution = response.data.data
      if (execution.status === 'success') {
        ElMessage.success(`任务 ${task.name} 执行成功`)
      } else if (execution.status === 'failed') {
        ElMessage.error(`任务 ${task.name} 执行失败: ${execution.error}`)
      }
      await loadExecutions()
      await loadTasks()
    }
    detailVisible.value = false
  } catch (err) {
    const message = err instanceof Error ? err.message : '执行失败'
    ElMessage.error(message)
  }
}

// Submit form
const submitForm = async () => {
  if (!formRef.value) return

  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true

  try {
    if (isEditing.value && editingTaskId.value) {
      await schedulerApi.updateTask(editingTaskId.value, formData)
      ElMessage.success('任务已更新')
    } else {
      await schedulerApi.createTask({ ...formData, deviceId: currentDeviceId.value })
      ElMessage.success('任务已创建')
    }

    dialogVisible.value = false
    await loadTasks()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

// Reset form
const resetForm = () => {
  formRef.value?.resetFields()
  Object.assign(formData, getDefaultFormData())
}

// Handle row click
const handleRowClick = (row: ScheduledTask) => {
  selectedTask.value = row
  detailVisible.value = true
}

// Handle cron preset selection
const handleCronPreset = (value: string) => {
  formData.cron = value
}

// Utility functions
const getTaskTypeText = (type: ScheduledTaskType | string): string => {
  const texts: Record<string, string> = {
    inspection: '巡检',
    backup: '备份',
    custom: '自定义'
  }
  return texts[type] || type
}

const getTaskTypeTagType = (type: ScheduledTaskType | string): 'primary' | 'success' | 'info' => {
  const types: Record<string, 'primary' | 'success' | 'info'> = {
    inspection: 'primary',
    backup: 'success',
    custom: 'info'
  }
  return types[type] || 'info'
}

const getExecutionStatusType = (status: TaskExecutionStatus): 'primary' | 'success' | 'danger' => {
  const types: Record<TaskExecutionStatus, 'primary' | 'success' | 'danger'> = {
    running: 'primary',
    success: 'success',
    failed: 'danger'
  }
  return types[status]
}

const getExecutionStatusText = (status: TaskExecutionStatus): string => {
  const texts: Record<TaskExecutionStatus, string> = {
    running: '执行中',
    success: '成功',
    failed: '失败'
  }
  return texts[status]
}

const getCronDescription = (cron: string): string => {
  // Simple cron description parser
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return '无效的 Cron 表达式'

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  // Common patterns
  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return '每分钟执行'
  }
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return '每小时整点执行'
  }
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return '每天 0:00 执行'
  }
  if (minute === '0' && hour === '8' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return '每天 8:00 执行'
  }
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '0') {
    return '每周日 0:00 执行'
  }
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1') {
    return '每周一 0:00 执行'
  }
  if (minute === '0' && hour === '0' && dayOfMonth === '1' && month === '*' && dayOfWeek === '*') {
    return '每月 1 日 0:00 执行'
  }
  if (minute.startsWith('*/')) {
    const interval = minute.slice(2)
    return `每 ${interval} 分钟执行`
  }
  if (hour.startsWith('*/')) {
    const interval = hour.slice(2)
    return `每 ${interval} 小时执行`
  }

  // Generic description
  let desc = ''
  if (minute !== '*') desc += `分钟: ${minute} `
  if (hour !== '*') desc += `小时: ${hour} `
  if (dayOfMonth !== '*') desc += `日: ${dayOfMonth} `
  if (month !== '*') desc += `月: ${month} `
  if (dayOfWeek !== '*') desc += `周: ${dayOfWeek}`
  return desc.trim() || '自定义调度'
}

const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const formatNextRun = (timestamp: number): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const diff = date.getTime() - now.getTime()

  if (diff < 0) return '已过期'
  if (diff < 60000) return '即将执行'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟后`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时后`
  return `${Math.floor(diff / 86400000)} 天后`
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

const formatResult = (result: unknown): string => {
  if (typeof result === 'string') return result
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>
    if ('message' in obj) return String(obj.message)
    // For inspection results, show summary
    if ('summary' in obj && typeof obj.summary === 'object' && obj.summary !== null) {
      const summary = obj.summary as Record<string, unknown>
      if ('overallStatus' in summary) {
        const statusText: Record<string, string> = {
          healthy: '健康',
          warning: '警告',
          critical: '严重'
        }
        return `状态: ${statusText[String(summary.overallStatus)] || summary.overallStatus}, 问题: ${summary.issueCount || 0} 个`
      }
    }
    return JSON.stringify(result)
  }
  return String(result)
}

// Check if result is an inspection result
const isInspectionResult = (result: unknown): result is InspectionResult => {
  if (typeof result !== 'object' || result === null) return false
  const obj = result as Record<string, unknown>
  return 'timestamp' in obj && 'systemHealth' in obj && 'interfaces' in obj && 'issues' in obj && 'summary' in obj
}

// Show execution detail dialog
const showExecutionDetail = (execution: TaskExecution) => {
  selectedExecution.value = execution
  if (execution.result && isInspectionResult(execution.result)) {
    selectedInspectionResult.value = execution.result
    executionDetailVisible.value = true
  }
}

// Get overall status tag type
const getOverallStatusType = (status: string): 'success' | 'warning' | 'danger' => {
  const types: Record<string, 'success' | 'warning' | 'danger'> = {
    healthy: 'success',
    warning: 'warning',
    critical: 'danger'
  }
  return types[status] || 'info'
}

// Get overall status text
const getOverallStatusText = (status: string): string => {
  const texts: Record<string, string> = {
    healthy: '健康',
    warning: '警告',
    critical: '严重'
  }
  return texts[status] || status
}

// Get progress color based on percentage
const getProgressColor = (percentage: number): string => {
  if (percentage >= 90) return '#f56c6c'
  if (percentage >= 80) return '#e6a23c'
  return '#67c23a'
}

// Format uptime
const formatUptime = (seconds: number): string => {
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return `${days} 天 ${hours} 小时`
}

// Format bytes
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// Get severity tag type
const getSeverityTagType = (severity: AlertSeverity): 'info' | 'warning' | 'danger' => {
  const types: Record<AlertSeverity, 'info' | 'warning' | 'danger'> = {
    info: 'info',
    warning: 'warning',
    critical: 'danger',
    emergency: 'danger'
  }
  return types[severity] || 'info'
}

// Get severity text
const getSeverityText = (severity: AlertSeverity): string => {
  const texts: Record<AlertSeverity, string> = {
    info: '信息',
    warning: '警告',
    critical: '严重',
    emergency: '紧急'
  }
  return texts[severity] || severity
}

// Go to health report
const goToReport = (reportId: string) => {
  executionDetailVisible.value = false
  router.push(`/ai-ops/reports?id=${reportId}`)
}
</script>


<style scoped>
.ai-ops-scheduler-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

/* Header */
.header-card {
  margin-bottom: 20px;
}

.header-card :deep(.el-card__header) {
  padding: 16px 20px;
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

/* No changes needed here, just ensuring standard format */

/* Cards */
.tasks-card {
  margin-bottom: 20px;
}

.history-card {
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

/* Table */
.cron-code {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  padding: 2px 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  color: var(--el-text-color-regular);
}

.next-run-time {
  color: var(--el-color-success);
  font-weight: 500;
}

.no-schedule {
  color: var(--el-text-color-secondary);
}

.error-text {
  color: var(--el-color-danger);
}

/* Form */
.cron-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.option-desc {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* Detail Dialog */
.cron-desc {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* Inspection Detail Dialog */
.inspection-summary-card {
  margin-bottom: 16px;
}

.inspection-summary {
  display: flex;
  justify-content: space-around;
  align-items: center;
}

.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.summary-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.summary-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.summary-value.has-issues {
  color: var(--el-color-danger);
}

.inspection-section-card {
  margin-bottom: 16px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.metric-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.metric-label {
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.uptime-value {
  font-size: 16px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  margin-top: 20px;
}

.report-link {
  margin-top: 16px;
  text-align: center;
}

.result-text {
  color: var(--el-text-color-regular);
}

/* Responsive */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    gap: 12px;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
