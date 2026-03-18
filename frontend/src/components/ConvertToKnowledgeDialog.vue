<template>
  <el-dialog
    v-model="visible"
    title="转换为知识条目"
    width="600px"
    :close-on-click-modal="false"
    @close="handleClose"
  >
    <el-form
      ref="formRef"
      :model="formData"
      :rules="formRules"
      label-width="80px"
      label-position="top"
    >
      <!-- Question Preview -->
      <div class="preview-section">
        <div class="preview-label">
          <el-icon><i-ep-user /></el-icon>
          <span>原始问题</span>
        </div>
        <div class="preview-content question">
          {{ props.qaPair?.question.content }}
        </div>
      </div>

      <!-- Answer Preview -->
      <div class="preview-section">
        <div class="preview-label">
          <el-icon><i-ep-monitor /></el-icon>
          <span>AI 回答</span>
        </div>
        <div class="preview-content answer">
          {{ truncateContent(props.qaPair?.answer.content || '', 300) }}
        </div>
      </div>

      <el-divider />

      <!-- Title -->
      <el-form-item label="标题" prop="title">
        <el-input
          v-model="formData.title"
          placeholder="知识条目标题"
          maxlength="100"
          show-word-limit
        />
        <div class="form-hint">自动从问题生成，可自行修改</div>
      </el-form-item>

      <!-- Content -->
      <el-form-item label="内容" prop="content">
        <el-input
          v-model="formData.content"
          type="textarea"
          :rows="6"
          placeholder="知识条目内容"
          maxlength="5000"
          show-word-limit
        />
        <div class="form-hint">自动组合问答内容，可自行编辑</div>
      </el-form-item>

      <!-- Category -->
      <el-form-item label="分类" prop="category">
        <el-select
          v-model="formData.category"
          placeholder="选择分类"
          style="width: 100%"
        >
          <el-option label="对话记录" value="conversation" />
          <el-option label="配置示例" value="config" />
          <el-option label="故障排查" value="troubleshooting" />
          <el-option label="最佳实践" value="best-practice" />
          <el-option label="常见问题" value="faq" />
          <el-option label="其他" value="other" />
        </el-select>
      </el-form-item>

      <!-- Tags -->
      <el-form-item label="标签">
        <div class="tags-container">
          <el-tag
            v-for="tag in formData.tags"
            :key="tag"
            closable
            type="info"
            @close="handleRemoveTag(tag)"
            class="tag-item"
          >
            {{ tag }}
          </el-tag>
          <el-input
            v-if="tagInputVisible"
            ref="tagInputRef"
            v-model="tagInputValue"
            size="small"
            style="width: 100px"
            @keyup.enter="handleAddTag"
            @blur="handleAddTag"
          />
          <el-button
            v-else
            size="small"
            @click="showTagInput"
          >
            + 添加标签
          </el-button>
        </div>
        <!-- Tag Suggestions -->
        <div v-if="suggestedTags.length > 0" class="tag-suggestions">
          <span class="suggestion-label">建议标签：</span>
          <el-tag
            v-for="tag in suggestedTags"
            :key="tag"
            type="warning"
            effect="plain"
            size="small"
            class="suggestion-tag"
            @click="handleAddSuggestedTag(tag)"
          >
            + {{ tag }}
          </el-tag>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleClose">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          @click="handleSubmit"
        >
          转换为知识
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { unifiedAgentApi, type CollectedQAPair, type ConvertToKnowledgeRequest } from '@/api/ai'

// ==================== Props ====================

interface Props {
  modelValue: boolean
  qaPair: CollectedQAPair | null
}

const props = defineProps<Props>()

// ==================== Emits ====================

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'converted', entryId: string): void
}>()

// ==================== State ====================

const formRef = ref<FormInstance>()
const submitting = ref(false)
const tagInputVisible = ref(false)
const tagInputValue = ref('')
const tagInputRef = ref<HTMLInputElement>()
const suggestedTags = ref<string[]>([])

const formData = ref({
  title: '',
  content: '',
  category: 'conversation',
  tags: [] as string[]
})

// ==================== Computed ====================

const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

// ==================== Form Rules ====================

const formRules: FormRules = {
  title: [
    { required: true, message: '请输入标题', trigger: 'blur' },
    { min: 2, max: 100, message: '标题长度应在 2-100 个字符之间', trigger: 'blur' }
  ],
  content: [
    { required: true, message: '请输入内容', trigger: 'blur' },
    { min: 10, message: '内容至少需要 10 个字符', trigger: 'blur' }
  ],
  category: [
    { required: true, message: '请选择分类', trigger: 'change' }
  ]
}

// ==================== Watch ====================

watch(() => props.qaPair, async (newVal) => {
  if (newVal) {
    // Auto-generate title from question (first 50 chars)
    const question = newVal.question.content.trim().replace(/\n/g, ' ')
    formData.value.title = question.length > 50 ? question.substring(0, 50) + '...' : question
    
    // Auto-generate content combining Q&A
    formData.value.content = buildKnowledgeContent(newVal.question.content, newVal.answer.content)
    
    // Reset other fields
    formData.value.category = 'conversation'
    formData.value.tags = ['from_conversation']
    
    // Get tag suggestions
    await loadTagSuggestions(newVal.question.content + ' ' + newVal.answer.content)
  }
}, { immediate: true })

// ==================== Methods ====================

const truncateContent = (content: string, maxLength: number): string => {
  if (content.length <= maxLength) return content
  return content.substring(0, maxLength) + '...'
}

const buildKnowledgeContent = (question: string, answer: string): string => {
  return `## 问题\n\n${question}\n\n## 解答\n\n${answer}`
}

const loadTagSuggestions = async (content: string) => {
  try {
    const response = await unifiedAgentApi.suggestTags(content)
    if (response.data.success && response.data.data) {
      // Filter out tags that are already added
      suggestedTags.value = response.data.data.filter(
        tag => !formData.value.tags.includes(tag)
      ).slice(0, 8)
    }
  } catch (err) {
    console.error('获取标签建议失败:', err)
  }
}

const showTagInput = () => {
  tagInputVisible.value = true
  nextTick(() => {
    tagInputRef.value?.focus()
  })
}

const handleAddTag = () => {
  const tag = tagInputValue.value.trim()
  if (tag && !formData.value.tags.includes(tag)) {
    formData.value.tags.push(tag)
    // Remove from suggestions if present
    suggestedTags.value = suggestedTags.value.filter(t => t !== tag)
  }
  tagInputVisible.value = false
  tagInputValue.value = ''
}

const handleRemoveTag = (tag: string) => {
  formData.value.tags = formData.value.tags.filter(t => t !== tag)
}

const handleAddSuggestedTag = (tag: string) => {
  if (!formData.value.tags.includes(tag)) {
    formData.value.tags.push(tag)
    suggestedTags.value = suggestedTags.value.filter(t => t !== tag)
  }
}

const handleClose = () => {
  visible.value = false
  formRef.value?.resetFields()
  suggestedTags.value = []
}

const handleSubmit = async () => {
  if (!props.qaPair) return
  
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  
  submitting.value = true
  
  try {
    const request: ConvertToKnowledgeRequest = {
      sessionId: props.qaPair.sessionId,
      questionMessageId: props.qaPair.question.messageId,
      answerMessageId: props.qaPair.answer.messageId,
      title: formData.value.title,
      content: formData.value.content,
      category: formData.value.category,
      tags: formData.value.tags
    }
    
    const response = await unifiedAgentApi.convertToKnowledge(request)
    
    if (response.data.success && response.data.data) {
      ElMessage.success('已成功转换为知识条目')
      emit('converted', response.data.data.id)
      handleClose()
    } else {
      ElMessage.error(response.data.error || '转换失败')
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '转换失败'
    ElMessage.error(errorMsg)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.preview-section {
  margin-bottom: 16px;
}

.preview-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #606266;
  margin-bottom: 8px;
}

.preview-content {
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
  max-height: 120px;
  overflow-y: auto;
}

.preview-content.question {
  background: #ecf5ff;
  border-left: 3px solid #409eff;
  color: #303133;
}

.preview-content.answer {
  background: #f0f9eb;
  border-left: 3px solid #67c23a;
  color: #303133;
}

.form-hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.tags-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.tag-item {
  margin: 0;
}

.tag-suggestions {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.suggestion-label {
  font-size: 12px;
  color: #909399;
}

.suggestion-tag {
  cursor: pointer;
  transition: all 0.2s;
}

.suggestion-tag:hover {
  background: #e6a23c;
  color: #fff;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
