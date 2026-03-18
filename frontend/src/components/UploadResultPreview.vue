<template>
  <el-dialog
    v-model="visible"
    title="上传结果预览"
    width="900px"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <!-- 结果摘要 -->
    <div class="result-summary">
      <el-row :gutter="16">
        <el-col :span="8">
          <div class="summary-item success">
            <el-icon :size="24"><i-ep-success-filled /></el-icon>
            <div class="summary-info">
              <span class="summary-value">{{ successCount }}</span>
              <span class="summary-label">成功</span>
            </div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="summary-item warning">
            <el-icon :size="24"><i-ep-warning-filled /></el-icon>
            <div class="summary-info">
              <span class="summary-value">{{ warningCount }}</span>
              <span class="summary-label">有警告</span>
            </div>
          </div>
        </el-col>
        <el-col :span="8">
          <div class="summary-item error">
            <el-icon :size="24"><i-ep-circle-close-filled /></el-icon>
            <div class="summary-info">
              <span class="summary-value">{{ failedCount }}</span>
              <span class="summary-label">失败</span>
            </div>
          </div>
        </el-col>
      </el-row>
    </div>

    <!-- 结果列表 -->
    <el-tabs v-model="activeTab" class="result-tabs">
      <el-tab-pane label="所有结果" name="all">
        <div class="entries-list">
          <el-collapse v-model="expandedFiles">
            <el-collapse-item
              v-for="(result, index) in results"
              :key="index"
              :name="index"
            >
              <template #title>
                <div class="file-header">
                  <el-icon :class="getStatusClass(result)">
                    <SuccessFilled v-if="result.success && !result.warnings?.length" />
                    <WarningFilled v-else-if="result.success && result.warnings?.length" />
                    <CircleCloseFilled v-else />
                  </el-icon>
                  <span class="file-name">{{ result.filename }}</span>
                  <el-tag
                    :type="result.success ? 'success' : 'danger'"
                    size="small"
                  >
                    {{ result.success ? `${result.entries.length} 个条目` : '失败' }}
                  </el-tag>
                </div>
              </template>

              <!-- 错误信息 -->
              <el-alert
                v-if="result.error"
                :title="result.error"
                type="error"
                :closable="false"
                show-icon
                class="result-alert"
              />

              <!-- 警告信息 -->
              <el-alert
                v-if="result.warnings?.length"
                type="warning"
                :closable="false"
                show-icon
                class="result-alert"
              >
                <template #title>
                  <div class="warnings-list">
                    <div v-for="(warning, wIndex) in result.warnings" :key="wIndex">
                      {{ warning }}
                    </div>
                  </div>
                </template>
              </el-alert>

              <!-- 知识条目列表 -->
              <div v-if="result.entries.length > 0" class="entries-container">
                <div
                  v-for="entry in result.entries"
                  :key="entry.id"
                  class="entry-card"
                >
                  <div class="entry-header">
                    <div class="entry-title-row">
                      <el-tag type="info" size="small">{{ getTypeText(entry.type) }}</el-tag>
                      <span class="entry-title">{{ entry.title }}</span>
                    </div>
                    <el-button
                      type="primary"
                      text
                      size="small"
                      @click="editEntry(entry)"
                    >
                      编辑
                    </el-button>
                  </div>
                  <div class="entry-content">
                    {{ truncateContent(entry.content) }}
                  </div>
                  <div class="entry-meta">
                    <span>分类: {{ entry.metadata?.category || '-' }}</span>
                    <span>标签: {{ entry.metadata?.tags?.join(', ') || '-' }}</span>
                  </div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-tab-pane>

      <el-tab-pane v-if="successCount > 0" label="成功" name="success">
        <div class="entries-list">
          <div
            v-for="entry in allSuccessEntries"
            :key="entry.id"
            class="entry-card"
          >
            <div class="entry-header">
              <div class="entry-title-row">
                <el-tag type="info" size="small">{{ getTypeText(entry.type) }}</el-tag>
                <span class="entry-title">{{ entry.title }}</span>
              </div>
              <el-button
                type="primary"
                text
                size="small"
                @click="editEntry(entry)"
              >
                编辑
              </el-button>
            </div>
            <div class="entry-content">
              {{ truncateContent(entry.content) }}
            </div>
            <div class="entry-meta">
              <span>分类: {{ entry.metadata?.category || '-' }}</span>
              <span>标签: {{ entry.metadata?.tags?.join(', ') || '-' }}</span>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane v-if="failedCount > 0" label="失败" name="failed">
        <div class="failed-list">
          <el-alert
            v-for="(result, index) in failedResults"
            :key="index"
            :title="result.filename"
            :description="result.error"
            type="error"
            :closable="false"
            show-icon
            class="failed-alert"
          />
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button @click="handleCancel">关闭</el-button>
      <el-button type="primary" @click="handleConfirm">
        确认完成
      </el-button>
    </template>

    <!-- 编辑对话框 -->
    <el-dialog
      v-model="editDialogVisible"
      title="编辑知识条目"
      width="700px"
      append-to-body
      destroy-on-close
    >
      <el-form
        v-if="editingEntry"
        ref="editFormRef"
        :model="editForm"
        :rules="editRules"
        label-width="80px"
      >
        <el-form-item label="标题" prop="title">
          <el-input v-model="editForm.title" placeholder="输入标题" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input
            v-model="editForm.content"
            type="textarea"
            :rows="10"
            placeholder="输入内容"
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="editForm.category" placeholder="输入分类" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select
            v-model="editForm.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入标签"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEntry">
          保存
        </el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { knowledgeApi, type KnowledgeEntry, type ProcessedFileResult } from '@/api/rag'

// Props
interface Props {
  modelValue: boolean
  results: ProcessedFileResult[]
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'entry-updated', entry: KnowledgeEntry): void
}>()

// State
const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const activeTab = ref('all')
const expandedFiles = ref<number[]>([0])
const editDialogVisible = ref(false)
const editingEntry = ref<KnowledgeEntry | null>(null)
const editFormRef = ref<FormInstance>()
const saving = ref(false)

const editForm = reactive({
  title: '',
  content: '',
  category: '',
  tags: [] as string[]
})

const editRules: FormRules = {
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入内容', trigger: 'blur' }]
}

// Computed
const successCount = computed(() => {
  return props.results.filter(r => r.success).length
})

const warningCount = computed(() => {
  return props.results.filter(r => r.success && r.warnings?.length).length
})

const failedCount = computed(() => {
  return props.results.filter(r => !r.success).length
})

const allSuccessEntries = computed(() => {
  return props.results
    .filter(r => r.success)
    .flatMap(r => r.entries)
})

const failedResults = computed(() => {
  return props.results.filter(r => !r.success)
})

// Methods
const getStatusClass = (result: ProcessedFileResult): string => {
  if (!result.success) return 'status-error'
  if (result.warnings?.length) return 'status-warning'
  return 'status-success'
}

const getTypeText = (type: string): string => {
  const typeMap: Record<string, string> = {
    alert: '告警',
    remediation: '修复方案',
    config: '配置',
    pattern: '故障模式',
    manual: '手动添加'
  }
  return typeMap[type] || type
}

const truncateContent = (content: string, maxLength = 200): string => {
  if (content.length <= maxLength) return content
  return content.substring(0, maxLength) + '...'
}

const editEntry = (entry: KnowledgeEntry) => {
  editingEntry.value = entry
  editForm.title = entry.title
  editForm.content = entry.content
  editForm.category = entry.metadata?.category || ''
  editForm.tags = entry.metadata?.tags || []
  editDialogVisible.value = true
}

const saveEntry = async () => {
  if (!editFormRef.value || !editingEntry.value) return

  try {
    await editFormRef.value.validate()
  } catch {
    return
  }

  saving.value = true

  try {
    const response = await knowledgeApi.update(editingEntry.value.id, {
      title: editForm.title,
      content: editForm.content,
      metadata: {
        ...editingEntry.value.metadata,
        category: editForm.category,
        tags: editForm.tags
      }
    })

    if (response.data.success && response.data.data) {
      ElMessage.success('保存成功')
      editDialogVisible.value = false

      // 更新本地数据
      const updatedEntry = response.data.data
      emit('entry-updated', updatedEntry)

      // 更新 results 中的条目
      for (const result of props.results) {
        const index = result.entries.findIndex(e => e.id === updatedEntry.id)
        if (index >= 0) {
          result.entries[index] = updatedEntry
          break
        }
      }
    } else {
      throw new Error(response.data.error || '保存失败')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败'
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

const handleConfirm = () => {
  emit('confirm')
  visible.value = false
}

const handleCancel = () => {
  emit('cancel')
  visible.value = false
}

// Watch for results changes to expand first item
watch(() => props.results, () => {
  if (props.results.length > 0) {
    expandedFiles.value = [0]
  }
}, { immediate: true })
</script>


<style scoped>
/* 结果摘要 */
.result-summary {
  margin-bottom: 20px;
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: 8px;
  background: #f5f7fa;
}

.summary-item.success {
  background: #f0f9eb;
  color: #67c23a;
}

.summary-item.warning {
  background: #fdf6ec;
  color: #e6a23c;
}

.summary-item.error {
  background: #fef0f0;
  color: #f56c6c;
}

.summary-info {
  display: flex;
  flex-direction: column;
}

.summary-value {
  font-size: 24px;
  font-weight: 600;
  line-height: 1.2;
}

.summary-label {
  font-size: 12px;
  opacity: 0.8;
}

/* 结果标签页 */
.result-tabs {
  margin-top: 16px;
}

/* 文件头部 */
.file-header {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.file-header .el-icon {
  font-size: 18px;
}

.file-header .status-success {
  color: #67c23a;
}

.file-header .status-warning {
  color: #e6a23c;
}

.file-header .status-error {
  color: #f56c6c;
}

.file-name {
  flex: 1;
  font-weight: 500;
  color: #303133;
}

/* 警告列表 */
.warnings-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.result-alert {
  margin-bottom: 12px;
}

/* 条目容器 */
.entries-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 条目卡片 */
.entry-card {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 16px;
  background: #fff;
  transition: box-shadow 0.2s;
}

.entry-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.entry-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.entry-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.entry-title {
  font-size: 15px;
  font-weight: 500;
  color: #303133;
}

.entry-content {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.entry-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #909399;
}

/* 失败列表 */
.failed-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.failed-alert {
  margin: 0;
}

/* 条目列表 */
.entries-list {
  max-height: 400px;
  overflow-y: auto;
}
</style>
