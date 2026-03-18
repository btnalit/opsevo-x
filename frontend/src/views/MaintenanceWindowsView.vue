<template>
  <div class="maintenance-windows-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>维护窗口管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              新建维护窗口
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadWindows">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && windows.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="loadWindows">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-empty
      v-else-if="windows.length === 0"
      description="暂无维护窗口"
    >
      <el-button type="primary" @click="showCreateDialog">创建维护窗口</el-button>
    </el-empty>

    <!-- Windows Table -->
    <el-card v-else shadow="hover">
      <el-table
        v-loading="loading"
        :data="paginatedWindows"
        stripe
        style="width: 100%"
        @row-click="handleRowClick"
      >
        <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip />
        <el-table-column label="所属设备" width="140">
          <template #default="{ row }">
            <span v-if="getDeviceName(row.deviceId || row.device_id)" class="device-name-tag">{{ getDeviceName(row.deviceId || row.device_id) }}</span>
            <span v-else class="no-data">-</span>
          </template>
        </el-table-column>
        <el-table-column label="时间范围" min-width="200">
          <template #default="{ row }">
            <div class="time-range">
              <span>{{ formatDateTime(row.startTime) }}</span>
              <span class="time-separator">至</span>
              <span>{{ formatDateTime(row.endTime) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row)" size="small">
              {{ getStatusText(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="周期性" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.recurring" type="info" size="small">
              {{ getRecurringText(row.recurring) }}
            </el-tag>
            <span v-else class="text-muted">一次性</span>
          </template>
        </el-table-column>
        <el-table-column label="受影响资源" min-width="180">
          <template #default="{ row }">
            <div class="resources-list">
              <el-tag
                v-for="(resource, index) in row.resources.slice(0, 3)"
                :key="index"
                size="small"
                type="info"
                class="resource-tag"
              >
                {{ resource }}
              </el-tag>
              <el-tag
                v-if="row.resources.length > 3"
                size="small"
                type="info"
              >
                +{{ row.resources.length - 3 }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click.stop="editWindow(row)">
              编辑
            </el-button>
            <el-popconfirm
              title="确定要删除此维护窗口吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="deleteWindow(row)"
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

      <!-- Pagination -->
      <div class="pagination-container">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="windows.length"
          layout="total, sizes, prev, pager, next"
          background
        />
      </div>
    </el-card>

    <!-- Create/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑维护窗口' : '新建维护窗口'"
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
        <el-form-item label="名称" prop="name">
          <el-input v-model="formData.name" placeholder="请输入维护窗口名称" />
        </el-form-item>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="开始时间" prop="startTime">
              <el-date-picker
                v-model="formData.startTime"
                type="datetime"
                placeholder="选择开始时间"
                style="width: 100%"
                :shortcuts="dateShortcuts"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="结束时间" prop="endTime">
              <el-date-picker
                v-model="formData.endTime"
                type="datetime"
                placeholder="选择结束时间"
                style="width: 100%"
                :shortcuts="dateShortcuts"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="受影响资源" prop="resources">
          <el-select
            v-model="formData.resources"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入或选择受影响的资源（接口名、IP 等）"
            style="width: 100%"
          >
            <el-option
              v-for="item in resourceOptions"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
          <div class="form-item-tip">
            可输入接口名称（如 ether1）、IP 地址或其他资源标识
          </div>
        </el-form-item>

        <el-divider content-position="left">周期性配置（可选）</el-divider>

        <el-form-item label="启用周期">
          <el-switch v-model="enableRecurring" />
        </el-form-item>

        <template v-if="enableRecurring">
          <el-form-item label="周期类型" prop="recurring.type">
            <el-radio-group v-model="formData.recurring!.type">
              <el-radio-button value="daily">每天</el-radio-button>
              <el-radio-button value="weekly">每周</el-radio-button>
              <el-radio-button value="monthly">每月</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item
            v-if="formData.recurring?.type === 'weekly'"
            label="星期"
            prop="recurring.dayOfWeek"
          >
            <el-checkbox-group v-model="formData.recurring!.dayOfWeek!">
              <el-checkbox-button
                v-for="(day, index) in weekDays"
                :key="index"
                :value="index"
              >
                {{ day }}
              </el-checkbox-button>
            </el-checkbox-group>
          </el-form-item>

          <el-form-item
            v-if="formData.recurring?.type === 'monthly'"
            label="日期"
            prop="recurring.dayOfMonth"
          >
            <el-select
              v-model="formData.recurring!.dayOfMonth"
              multiple
              placeholder="选择每月的日期"
              style="width: 100%"
            >
              <el-option
                v-for="day in 31"
                :key="day"
                :label="`${day} 日`"
                :value="day"
              />
            </el-select>
          </el-form-item>
        </template>
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
      title="维护窗口详情"
      width="550px"
      destroy-on-close
    >
      <el-descriptions :column="1" border v-if="selectedWindow">
        <el-descriptions-item label="名称">{{ selectedWindow.name }}</el-descriptions-item>
        <el-descriptions-item label="开始时间">{{ formatDateTime(selectedWindow.startTime) }}</el-descriptions-item>
        <el-descriptions-item label="结束时间">{{ formatDateTime(selectedWindow.endTime) }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="getStatusType(selectedWindow)" size="small">
            {{ getStatusText(selectedWindow) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="周期性">
          <template v-if="selectedWindow.recurring">
            <el-tag type="info" size="small">{{ getRecurringText(selectedWindow.recurring) }}</el-tag>
            <div v-if="selectedWindow.recurring.dayOfWeek?.length" class="detail-sub">
              星期：{{ selectedWindow.recurring.dayOfWeek.map(d => weekDays[d]).join('、') }}
            </div>
            <div v-if="selectedWindow.recurring.dayOfMonth?.length" class="detail-sub">
              日期：{{ selectedWindow.recurring.dayOfMonth.map(d => `${d}日`).join('、') }}
            </div>
          </template>
          <span v-else class="text-muted">一次性</span>
        </el-descriptions-item>
        <el-descriptions-item label="受影响资源">
          <div class="resources-detail">
            <el-tag
              v-for="(resource, index) in selectedWindow.resources"
              :key="index"
              size="small"
              type="info"
              class="resource-tag"
            >
              {{ resource }}
            </el-tag>
          </div>
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedWindow.createdAt" label="创建时间">
          {{ formatDateTime(selectedWindow.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedWindow.updatedAt" label="更新时间">
          {{ formatDateTime(selectedWindow.updatedAt) }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editWindow(selectedWindow!)">编辑</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh } from '@element-plus/icons-vue'

import { ref, computed, reactive, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  filtersApi,
  type MaintenanceWindow,
  type CreateMaintenanceWindowInput,
  type RecurringSchedule
} from '@/api/ai-ops'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'

// State
const deviceStore = useDeviceStore()
const { currentDeviceId, devices } = storeToRefs(deviceStore)

// 设备名称映射
const getDeviceName = (deviceId?: string | null) => {
  if (!deviceId) return ''
  return devices.value.find(d => d.id === deviceId)?.name || ''
}
const loading = ref(false)
const error = ref('')
const windows = ref<MaintenanceWindow[]>([])
const dialogVisible = ref(false)
const detailVisible = ref(false)
const isEditing = ref(false)
const submitting = ref(false)
const selectedWindow = ref<MaintenanceWindow | null>(null)
const editingWindowId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const enableRecurring = ref(false)

// Pagination
const currentPage = ref(1)
const pageSize = ref(10)

// Computed - paginated windows
const paginatedWindows = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return windows.value.slice(start, end)
})

// Week days
const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// Resource options (common interface names)
const resourceOptions = [
  'ether1', 'ether2', 'ether3', 'ether4', 'ether5',
  'bridge1', 'lan', 'wan', 'pppoe-out1', 'wlan1', 'wlan2'
]

// Date shortcuts
const dateShortcuts = [
  {
    text: '今天',
    value: new Date()
  },
  {
    text: '明天',
    value: () => {
      const date = new Date()
      date.setDate(date.getDate() + 1)
      return date
    }
  },
  {
    text: '一周后',
    value: () => {
      const date = new Date()
      date.setDate(date.getDate() + 7)
      return date
    }
  }
]

// Form data
const getDefaultFormData = () => ({
  name: '',
  startTime: null as Date | null,
  endTime: null as Date | null,
  resources: [] as string[],
  recurring: {
    type: 'daily' as const,
    dayOfWeek: [] as number[],
    dayOfMonth: [] as number[]
  } as RecurringSchedule | undefined
})

const formData = reactive(getDefaultFormData())

// Form validation rules
const formRules: FormRules = {
  name: [
    { required: true, message: '请输入维护窗口名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  startTime: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  endTime: [
    { required: true, message: '请选择结束时间', trigger: 'change' },
    {
      validator: (_rule, value, callback) => {
        if (value && formData.startTime && new Date(value).getTime() <= new Date(formData.startTime).getTime()) {
          callback(new Error('结束时间必须晚于开始时间'))
        } else {
          callback()
        }
      },
      trigger: 'change'
    }
  ],
  resources: [{ required: true, message: '请输入受影响的资源', trigger: 'change', type: 'array', min: 1 }]
}

// Watch enableRecurring to reset recurring data
watch(enableRecurring, (val) => {
  if (!val) {
    formData.recurring = undefined
  } else {
    formData.recurring = {
      type: 'daily',
      dayOfWeek: [],
      dayOfMonth: []
    }
  }
})

// Watch device changes
watch(currentDeviceId, () => {
  loadWindows()
})

// Load data on mount
onMounted(() => {
  loadWindows()
})

// Load maintenance windows
const loadWindows = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await filtersApi.getMaintenanceWindows(currentDeviceId.value)
    if (response.data.success && response.data.data) {
      windows.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取维护窗口失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取维护窗口失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Show create dialog
const showCreateDialog = () => {
  isEditing.value = false
  editingWindowId.value = null
  enableRecurring.value = false
  Object.assign(formData, getDefaultFormData())
  dialogVisible.value = true
}

// Edit window
const editWindow = (window: MaintenanceWindow) => {
  isEditing.value = true
  editingWindowId.value = window.id
  enableRecurring.value = !!window.recurring
  formData.name = window.name
  formData.startTime = new Date(window.startTime)
  formData.endTime = new Date(window.endTime)
  formData.resources = [...window.resources]
  formData.recurring = window.recurring ? {
    type: window.recurring.type,
    dayOfWeek: window.recurring.dayOfWeek ? [...window.recurring.dayOfWeek] : [],
    dayOfMonth: window.recurring.dayOfMonth ? [...window.recurring.dayOfMonth] : []
  } : undefined
  detailVisible.value = false
  dialogVisible.value = true
}

// Delete window
const deleteWindow = async (window: MaintenanceWindow) => {
  try {
    await filtersApi.deleteMaintenanceWindow(window.id)
    ElMessage.success('维护窗口已删除')
    await loadWindows()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败'
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
    const data: CreateMaintenanceWindowInput = {
      name: formData.name,
      startTime: new Date(formData.startTime!).getTime(),
      endTime: new Date(formData.endTime!).getTime(),
      resources: formData.resources,
      recurring: enableRecurring.value ? formData.recurring : undefined
    }

    if (isEditing.value && editingWindowId.value) {
      await filtersApi.updateMaintenanceWindow(editingWindowId.value, data)
      ElMessage.success('维护窗口已更新')
    } else {
      await filtersApi.createMaintenanceWindow({ ...data, deviceId: currentDeviceId.value })
      ElMessage.success('维护窗口已创建')
    }

    dialogVisible.value = false
    await loadWindows()
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
  formData.name = ''
  formData.startTime = null
  formData.endTime = null
  formData.resources = []
  formData.recurring = undefined
  enableRecurring.value = false
}

// Handle row click
const handleRowClick = (row: MaintenanceWindow) => {
  selectedWindow.value = row
  detailVisible.value = true
}

// Utility functions
const formatDateTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const getStatusType = (window: MaintenanceWindow): 'success' | 'info' | 'warning' => {
  const now = Date.now()
  if (now >= window.startTime && now <= window.endTime) {
    return 'success'
  } else if (now < window.startTime) {
    return 'warning'
  }
  return 'info'
}

const getStatusText = (window: MaintenanceWindow): string => {
  const now = Date.now()
  if (now >= window.startTime && now <= window.endTime) {
    return '进行中'
  } else if (now < window.startTime) {
    return '待开始'
  }
  return '已结束'
}

const getRecurringText = (recurring: RecurringSchedule): string => {
  const texts: Record<string, string> = {
    daily: '每天',
    weekly: '每周',
    monthly: '每月'
  }
  return texts[recurring.type] || recurring.type
}
</script>

<style scoped>
.maintenance-windows-view {
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

/* Table */
.time-range {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.time-separator {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.resources-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.resource-tag {
  margin: 0;
}

.text-muted {
  color: var(--el-text-color-secondary);
}

/* Pagination */
.pagination-container {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* Form */
.form-item-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
  line-height: 1.4;
}

/* Detail */
.detail-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.resources-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
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
