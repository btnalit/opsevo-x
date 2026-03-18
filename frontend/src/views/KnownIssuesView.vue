<template>
  <div class="known-issues-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>已知问题管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              新建已知问题
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadIssues">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && issues.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="loadIssues">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-empty
      v-else-if="issues.length === 0"
      description="暂无已知问题"
    >
      <el-button type="primary" @click="showCreateDialog">创建已知问题</el-button>
    </el-empty>

    <!-- Issues Table -->
    <el-card v-else shadow="hover">
      <el-table
        v-loading="loading"
        :data="paginatedIssues"
        stripe
        style="width: 100%"
        @row-click="handleRowClick"
      >
        <el-table-column prop="pattern" label="匹配模式" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <code class="pattern-code">{{ row.pattern }}</code>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row)" size="small">
              {{ getStatusText(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="过期时间" width="160">
          <template #default="{ row }">
            <span v-if="row.expiresAt">{{ formatDateTime(row.expiresAt) }}</span>
            <span v-else class="text-muted">永不过期</span>
          </template>
        </el-table-column>
        <el-table-column label="自动解决" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.autoResolve ? 'success' : 'info'" size="small">
              {{ row.autoResolve ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click.stop="editIssue(row)">
              编辑
            </el-button>
            <el-popconfirm
              title="确定要删除此已知问题吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="deleteIssue(row)"
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
          :total="issues.length"
          layout="total, sizes, prev, pager, next"
          background
        />
      </div>
    </el-card>

    <!-- Create/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑已知问题' : '新建已知问题'"
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
        <el-form-item label="匹配模式" prop="pattern">
          <el-input
            v-model="formData.pattern"
            placeholder="输入正则表达式或关键字"
          >
            <template #prepend>
              <el-icon><i-ep-search /></el-icon>
            </template>
          </el-input>
          <div class="form-item-tip">
            支持正则表达式，如：<code>interface.*down</code>、<code>CPU.*high</code>
          </div>
        </el-form-item>

        <el-form-item label="描述" prop="description">
          <el-input
            v-model="formData.description"
            type="textarea"
            :rows="3"
            placeholder="描述此已知问题的原因和处理方式"
          />
        </el-form-item>

        <el-form-item label="过期时间">
          <el-switch v-model="enableExpiration" />
          <span class="switch-label">{{ enableExpiration ? '设置过期时间' : '永不过期' }}</span>
        </el-form-item>

        <el-form-item v-if="enableExpiration" label="过期日期" prop="expiresAt">
          <el-date-picker
            v-model="formData.expiresAt"
            type="datetime"
            placeholder="选择过期时间"
            style="width: 100%"
            :shortcuts="expirationShortcuts"
          />
          <div class="form-item-tip">
            过期后此已知问题将不再生效，相关告警将正常触发
          </div>
        </el-form-item>

        <el-form-item label="自动解决">
          <el-switch v-model="formData.autoResolve" />
          <span class="switch-label">{{ formData.autoResolve ? '匹配的告警将自动标记为已解决' : '仅过滤，不自动解决' }}</span>
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
      title="已知问题详情"
      width="550px"
      destroy-on-close
    >
      <el-descriptions :column="1" border v-if="selectedIssue">
        <el-descriptions-item label="匹配模式">
          <code class="pattern-code">{{ selectedIssue.pattern }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="描述">{{ selectedIssue.description }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="getStatusType(selectedIssue)" size="small">
            {{ getStatusText(selectedIssue) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="过期时间">
          <span v-if="selectedIssue.expiresAt">{{ formatDateTime(selectedIssue.expiresAt) }}</span>
          <span v-else class="text-muted">永不过期</span>
        </el-descriptions-item>
        <el-descriptions-item label="自动解决">
          <el-tag :type="selectedIssue.autoResolve ? 'success' : 'info'" size="small">
            {{ selectedIssue.autoResolve ? '是' : '否' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedIssue.createdAt" label="创建时间">
          {{ formatDateTime(selectedIssue.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedIssue.updatedAt" label="更新时间">
          {{ formatDateTime(selectedIssue.updatedAt) }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editIssue(selectedIssue!)">编辑</el-button>
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
  type KnownIssue,
  type CreateKnownIssueInput
} from '@/api/ai-ops'

// State
const loading = ref(false)
const error = ref('')
const issues = ref<KnownIssue[]>([])
const dialogVisible = ref(false)
const detailVisible = ref(false)
const isEditing = ref(false)
const submitting = ref(false)
const selectedIssue = ref<KnownIssue | null>(null)
const editingIssueId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const enableExpiration = ref(false)

// Pagination
const currentPage = ref(1)
const pageSize = ref(10)

// Computed - paginated issues
const paginatedIssues = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return issues.value.slice(start, end)
})

// Expiration shortcuts
const expirationShortcuts = [
  {
    text: '1 小时后',
    value: () => {
      const date = new Date()
      date.setHours(date.getHours() + 1)
      return date
    }
  },
  {
    text: '1 天后',
    value: () => {
      const date = new Date()
      date.setDate(date.getDate() + 1)
      return date
    }
  },
  {
    text: '1 周后',
    value: () => {
      const date = new Date()
      date.setDate(date.getDate() + 7)
      return date
    }
  },
  {
    text: '1 个月后',
    value: () => {
      const date = new Date()
      date.setMonth(date.getMonth() + 1)
      return date
    }
  }
]

// Form data
const getDefaultFormData = () => ({
  pattern: '',
  description: '',
  expiresAt: null as Date | null,
  autoResolve: false
})

const formData = reactive(getDefaultFormData())

// Form validation rules
const formRules: FormRules = {
  pattern: [
    { required: true, message: '请输入匹配模式', trigger: 'blur' },
    { min: 2, max: 200, message: '长度在 2 到 200 个字符', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        try {
          new RegExp(value)
          callback()
        } catch {
          callback(new Error('无效的正则表达式'))
        }
      },
      trigger: 'blur'
    }
  ],
  description: [
    { required: true, message: '请输入描述', trigger: 'blur' },
    { min: 2, max: 500, message: '长度在 2 到 500 个字符', trigger: 'blur' }
  ]
}

// Watch enableExpiration to reset expiresAt
watch(enableExpiration, (val) => {
  if (!val) {
    formData.expiresAt = null
  }
})

// Load data on mount
onMounted(() => {
  loadIssues()
})

// Load known issues
const loadIssues = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await filtersApi.getKnownIssues()
    if (response.data.success && response.data.data) {
      issues.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取已知问题失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取已知问题失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Show create dialog
const showCreateDialog = () => {
  isEditing.value = false
  editingIssueId.value = null
  enableExpiration.value = false
  Object.assign(formData, getDefaultFormData())
  dialogVisible.value = true
}

// Edit issue
const editIssue = (issue: KnownIssue) => {
  isEditing.value = true
  editingIssueId.value = issue.id
  enableExpiration.value = !!issue.expiresAt
  formData.pattern = issue.pattern
  formData.description = issue.description
  formData.expiresAt = issue.expiresAt ? new Date(issue.expiresAt) : null
  formData.autoResolve = issue.autoResolve
  detailVisible.value = false
  dialogVisible.value = true
}

// Delete issue
const deleteIssue = async (issue: KnownIssue) => {
  try {
    await filtersApi.deleteKnownIssue(issue.id)
    ElMessage.success('已知问题已删除')
    await loadIssues()
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
    const data: CreateKnownIssueInput = {
      pattern: formData.pattern,
      description: formData.description,
      expiresAt: enableExpiration.value && formData.expiresAt
        ? new Date(formData.expiresAt).getTime()
        : undefined,
      autoResolve: formData.autoResolve
    }

    if (isEditing.value && editingIssueId.value) {
      await filtersApi.updateKnownIssue(editingIssueId.value, data)
      ElMessage.success('已知问题已更新')
    } else {
      await filtersApi.createKnownIssue(data)
      ElMessage.success('已知问题已创建')
    }

    dialogVisible.value = false
    await loadIssues()
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
  formData.pattern = ''
  formData.description = ''
  formData.expiresAt = null
  formData.autoResolve = false
  enableExpiration.value = false
}

// Handle row click
const handleRowClick = (row: KnownIssue) => {
  selectedIssue.value = row
  detailVisible.value = true
}

// Utility functions
const formatDateTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const getStatusType = (issue: KnownIssue): 'success' | 'info' | 'danger' => {
  if (!issue.expiresAt) {
    return 'success'
  }
  const now = Date.now()
  if (now > issue.expiresAt) {
    return 'danger'
  }
  return 'success'
}

const getStatusText = (issue: KnownIssue): string => {
  if (!issue.expiresAt) {
    return '生效中'
  }
  const now = Date.now()
  if (now > issue.expiresAt) {
    return '已过期'
  }
  return '生效中'
}
</script>

<style scoped>
.known-issues-view {
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
.pattern-code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  padding: 2px 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  color: var(--el-color-warning);
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

.form-item-tip code {
  font-family: 'Consolas', 'Monaco', monospace;
  padding: 1px 4px;
  background: var(--el-fill-color-light);
  border-radius: 3px;
  color: var(--el-color-warning);
}

.switch-label {
  margin-left: 8px;
  font-size: 13px;
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
