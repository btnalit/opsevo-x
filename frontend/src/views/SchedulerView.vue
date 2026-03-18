<template>
  <div class="scheduler-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>计划任务管理</span>
          <div class="header-actions">
            <el-button
              type="primary"
              :icon="Plus"
              @click="handleAdd"
            >
              添加
            </el-button>
            <el-button
              :icon="Refresh"
              :loading="loading"
              @click="loadSchedulers"
            >
              刷新
            </el-button>
          </div>
        </div>
      </template>

      <!-- Loading State -->
      <el-skeleton v-if="loading && schedulers.length === 0" :rows="5" animated />

      <!-- Error State -->
      <el-alert
        v-else-if="error"
        :title="error"
        type="error"
        show-icon
        closable
        @close="error = ''"
      />

      <!-- Scheduler Table -->
      <el-table
        v-else
        v-loading="loading"
        :data="schedulers"
        stripe
        style="width: 100%"
      >
        <el-table-column prop="name" label="任务名称" min-width="150" sortable />
        <el-table-column prop="interval" label="执行间隔" min-width="120" />
        <el-table-column label="下次运行" min-width="180">
          <template #default="{ row }">
            {{ formatNextRun(row) }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.disabled ? 'danger' : 'success'" size="small">
              {{ row.disabled ? '已禁用' : '已启用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="on-event" label="关联脚本" min-width="150" show-overflow-tooltip />
        <el-table-column prop="run-count" label="运行次数" width="100" />
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button-group>
              <el-button
                size="small"
                :type="row.disabled ? 'success' : 'warning'"
                :loading="row._toggling"
                @click="handleToggleStatus(row)"
              >
                {{ row.disabled ? '启用' : '禁用' }}
              </el-button>
              <el-button
                size="small"
                type="primary"
                @click="handleEdit(row)"
              >
                编辑
              </el-button>
              <el-button
                size="small"
                type="danger"
                @click="handleDelete(row)"
              >
                删除
              </el-button>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Add/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑计划任务' : '添加计划任务'"
      width="550px"
      destroy-on-close
      @closed="resetForm"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="formRules"
        label-width="100px"
        :disabled="saving"
      >
        <el-form-item label="任务名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="请输入任务名称"
          />
        </el-form-item>
        <el-form-item label="开始日期" prop="start-date">
          <el-date-picker
            v-model="form['start-date']"
            type="date"
            placeholder="选择开始日期"
            format="YYYY-MM-DD"
            value-format="MMM/DD/YYYY"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="开始时间" prop="start-time">
          <el-time-picker
            v-model="form['start-time']"
            placeholder="选择开始时间"
            format="HH:mm:ss"
            value-format="HH:mm:ss"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="执行间隔" prop="interval">
          <el-input
            v-model="form.interval"
            placeholder="如: 1d, 1h30m, 00:30:00"
          >
            <template #append>
              <el-tooltip content="格式: 1d(天), 1h(时), 30m(分), 30s(秒) 或 HH:MM:SS" placement="top">
                <el-icon><i-ep-question-filled /></el-icon>
              </el-tooltip>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="关联脚本" prop="on-event">
          <el-input
            v-model="form['on-event']"
            placeholder="请输入要执行的脚本名称"
          />
        </el-form-item>
        <el-form-item label="状态" prop="disabled">
          <el-switch
            v-model="form.disabled"
            active-text="禁用"
            inactive-text="启用"
          />
        </el-form-item>
        <el-form-item label="备注" prop="comment">
          <el-input
            v-model="form.comment"
            type="textarea"
            :rows="3"
            placeholder="请输入备注信息"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">
          {{ isEditing ? '保存' : '添加' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh } from '@element-plus/icons-vue'

import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { systemApi } from '@/api/system'

// Scheduler type definition
interface Scheduler {
  '.id': string
  name: string
  'start-date'?: string
  'start-time': string
  interval: string
  'on-event': string
  disabled: boolean
  'run-count': number
  'next-run'?: string
  comment?: string
  _toggling?: boolean
}

// State
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const schedulers = ref<Scheduler[]>([])

// Dialog state
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref('')
const formRef = ref<FormInstance>()

// Form data
const form = reactive({
  name: '',
  'start-date': '',
  'start-time': '',
  interval: '',
  'on-event': '',
  disabled: false,
  comment: ''
})

// Interval format validator
const validateInterval = (_rule: unknown, value: string, callback: (error?: Error) => void) => {
  if (!value) {
    callback(new Error('请输入执行间隔'))
    return
  }
  // RouterOS interval formats: 1d, 1h30m, 00:30:00, etc.
  const intervalRegex = /^(\d+[wdhms])+$|^(\d{1,2}:){1,2}\d{1,2}$/
  if (!intervalRegex.test(value)) {
    callback(new Error('格式无效，如: 1d, 1h30m, 00:30:00'))
    return
  }
  callback()
}

// Form validation rules
const formRules: FormRules = {
  name: [
    { required: true, message: '请输入任务名称', trigger: 'blur' }
  ],
  interval: [
    { required: true, message: '请输入执行间隔', trigger: 'blur' },
    { validator: validateInterval, trigger: 'blur' }
  ],
  'on-event': [
    { required: true, message: '请输入关联脚本名称', trigger: 'blur' }
  ]
}

// Load schedulers on mount
onMounted(() => {
  loadSchedulers()
})

// Format next run time
const formatNextRun = (row: Scheduler) => {
  if (row['next-run']) {
    return row['next-run']
  }
  if (row['start-date'] && row['start-time']) {
    return `${row['start-date']} ${row['start-time']}`
  }
  return row['start-time'] || '-'
}

// 将字符串布尔值转换为真正的布尔值
const toBool = (val: unknown): boolean => {
  if (typeof val === 'boolean') return val
  if (typeof val === 'string') return val.toLowerCase() === 'true'
  return Boolean(val)
}

// Load all schedulers
const loadSchedulers = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await systemApi.getSchedulers()
    // 后端返回格式: { success: true, data: [...] }
    // axios 响应格式: response.data = { success, data }
    const result = response.data
    if (result.success && Array.isArray(result.data)) {
      schedulers.value = result.data.map((s: Scheduler) => ({
        ...s,
        // RouterOS API 返回的布尔值可能是字符串 "true"/"false"
        disabled: toBool(s.disabled),
        _toggling: false
      }))
    } else {
      schedulers.value = []
      if (!result.success && result.error) {
        throw new Error(result.error)
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '加载计划任务列表失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Handle add button click
const handleAdd = () => {
  isEditing.value = false
  editingId.value = ''
  dialogVisible.value = true
}

// Handle edit button click
const handleEdit = (row: Scheduler) => {
  isEditing.value = true
  editingId.value = row['.id']
  form.name = row.name
  form['start-date'] = row['start-date'] || ''
  form['start-time'] = row['start-time'] || ''
  form.interval = row.interval
  form['on-event'] = row['on-event']
  form.disabled = row.disabled
  form.comment = row.comment || ''
  dialogVisible.value = true
}

// Handle toggle enable/disable
const handleToggleStatus = async (row: Scheduler) => {
  row._toggling = true

  try {
    if (row.disabled) {
      await systemApi.enableScheduler(row['.id'])
      ElMessage.success(`计划任务 ${row.name} 已启用`)
    } else {
      await systemApi.disableScheduler(row['.id'])
      ElMessage.success(`计划任务 ${row.name} 已禁用`)
    }
    await loadSchedulers()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    row._toggling = false
  }
}

// Handle delete button click
const handleDelete = async (row: Scheduler) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除计划任务 "${row.name}" 吗？`,
      '删除确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    loading.value = true
    await systemApi.deleteScheduler(row['.id'])
    ElMessage.success('计划任务已删除')
    await loadSchedulers()
  } catch (err: unknown) {
    if (err !== 'cancel') {
      const message = err instanceof Error ? err.message : '删除失败'
      ElMessage.error(message)
    }
  } finally {
    loading.value = false
  }
}

// Reset form
const resetForm = () => {
  form.name = ''
  form['start-date'] = ''
  form['start-time'] = ''
  form.interval = ''
  form['on-event'] = ''
  form.disabled = false
  form.comment = ''
  formRef.value?.resetFields()
}

// Handle save (add or update)
const handleSave = async () => {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  saving.value = true

  try {
    const data: Record<string, unknown> = {
      name: form.name,
      interval: form.interval,
      'on-event': form['on-event'],
      disabled: form.disabled
    }

    if (form['start-date']) {
      data['start-date'] = form['start-date']
    }
    if (form['start-time']) {
      data['start-time'] = form['start-time']
    }
    // 始终发送 comment 字段，空字符串用于清除备注
    data.comment = form.comment

    if (isEditing.value) {
      await systemApi.updateScheduler(editingId.value, data)
      ElMessage.success('计划任务已更新')
    } else {
      await systemApi.addScheduler(data)
      ElMessage.success('计划任务已添加')
    }

    dialogVisible.value = false
    await loadSchedulers()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.scheduler-view {
  height: 100%;
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
  gap: 8px;
}
</style>
