<template>
  <div class="knowledge-feedback">
    <!-- Compact Mode -->
    <div v-if="mode === 'compact'" class="compact-feedback">
      <span class="feedback-label">{{ label }}</span>
      <el-rate
        v-model="localScore"
        :disabled="submitted || disabled"
        :colors="rateColors"
        show-text
        :texts="rateTexts"
        @change="handleScoreChange"
      />
      <el-button
        v-if="!submitted && localScore > 0"
        type="primary"
        size="small"
        :loading="submitting"
        @click="submitFeedback"
      >
        提交
      </el-button>
      <el-tag v-if="submitted" type="success" size="small">
        <el-icon><i-ep-circle-check-filled /></el-icon>
        已提交
      </el-tag>
    </div>

    <!-- Card Mode -->
    <el-card v-else-if="mode === 'card'" class="card-feedback" shadow="hover">
      <div class="card-header">
        <el-icon :size="20" color="#e6a23c"><i-ep-star /></el-icon>
        <span class="card-title">{{ title || '反馈评价' }}</span>
      </div>
      <div class="card-body">
        <p class="feedback-description">{{ description || '请为此内容评分，帮助我们改进知识库质量。' }}</p>
        <div class="rating-section">
          <el-rate
            v-model="localScore"
            :disabled="submitted || disabled"
            :colors="rateColors"
            show-text
            :texts="rateTexts"
            size="large"
          />
        </div>
        <el-input
          v-if="showComment"
          v-model="localComment"
          type="textarea"
          :rows="3"
          :placeholder="commentPlaceholder"
          :disabled="submitted || disabled"
          class="comment-input"
        />
      </div>
      <div class="card-footer">
        <el-button
          v-if="!submitted"
          type="primary"
          :loading="submitting"
          :disabled="localScore === 0"
          @click="submitFeedback"
        >
          <el-icon><i-ep-promotion /></el-icon>
          提交反馈
        </el-button>
        <div v-else class="submitted-message">
          <el-icon color="#67c23a"><i-ep-circle-check-filled /></el-icon>
          <span>感谢您的反馈！</span>
        </div>
      </div>
    </el-card>

    <!-- Inline Mode -->
    <div v-else class="inline-feedback">
      <div class="inline-header">
        <span class="inline-label">{{ label }}</span>
        <el-tooltip v-if="tooltip" :content="tooltip" placement="top">
          <el-icon class="help-icon"><i-ep-question-filled /></el-icon>
        </el-tooltip>
      </div>
      <div class="inline-body">
        <el-rate
          v-model="localScore"
          :disabled="submitted || disabled"
          :colors="rateColors"
          show-text
          :texts="rateTexts"
        />
      </div>
      <div v-if="showComment && localScore > 0" class="inline-comment">
        <el-input
          v-model="localComment"
          type="textarea"
          :rows="2"
          :placeholder="commentPlaceholder"
          :disabled="submitted || disabled"
        />
      </div>
      <div class="inline-footer">
        <el-button
          v-if="!submitted && localScore > 0"
          type="primary"
          size="small"
          :loading="submitting"
          @click="submitFeedback"
        >
          提交
        </el-button>
        <span v-if="submitted" class="submitted-text">
          <el-icon color="#67c23a"><i-ep-circle-check-filled /></el-icon>
          已提交
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { knowledgeApi } from '@/api/rag'

// Props
interface Props {
  entryId: string
  mode?: 'compact' | 'card' | 'inline'
  label?: string
  title?: string
  description?: string
  tooltip?: string
  showComment?: boolean
  commentPlaceholder?: string
  initialScore?: number
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'inline',
  label: '评分',
  showComment: false,
  commentPlaceholder: '可选：添加更多反馈意见...',
  initialScore: 0,
  disabled: false
})

// Emits
const emit = defineEmits<{
  (e: 'submit', score: number, comment?: string): void
  (e: 'change', score: number): void
}>()

// State
const localScore = ref(props.initialScore)
const localComment = ref('')
const submitting = ref(false)
const submitted = ref(false)

// Rate configuration
const rateColors = ['#f56c6c', '#e6a23c', '#67c23a']
const rateTexts = ['很差', '较差', '一般', '较好', '很好']

// Watch initial score changes
watch(() => props.initialScore, (newVal) => {
  localScore.value = newVal
})

// Handle score change
const handleScoreChange = (value: number) => {
  emit('change', value)
}

// Submit feedback
const submitFeedback = async () => {
  if (localScore.value === 0) {
    ElMessage.warning('请先选择评分')
    return
  }

  submitting.value = true

  try {
    const response = await knowledgeApi.submitFeedback(props.entryId, localScore.value)
    if (response.data.success) {
      submitted.value = true
      emit('submit', localScore.value, localComment.value || undefined)
      ElMessage.success('反馈提交成功')
    } else {
      throw new Error(response.data.error || '提交失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '提交失败'
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.knowledge-feedback {
  width: 100%;
}

/* Compact Mode */
.compact-feedback {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.feedback-label {
  font-size: 14px;
  color: #606266;
}

/* Card Mode */
.card-feedback {
  max-width: 400px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.card-body {
  margin-bottom: 16px;
}

.feedback-description {
  font-size: 14px;
  color: #909399;
  margin-bottom: 16px;
}

.rating-section {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}

.comment-input {
  margin-top: 12px;
}

.card-footer {
  display: flex;
  justify-content: center;
}

.submitted-message {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #67c23a;
  font-size: 14px;
}

/* Inline Mode */
.inline-feedback {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.inline-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.inline-label {
  font-size: 14px;
  color: #606266;
}

.help-icon {
  color: #909399;
  cursor: help;
}

.inline-body {
  display: flex;
  align-items: center;
}

.inline-comment {
  margin-top: 8px;
}

.inline-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.submitted-text {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #67c23a;
}

/* Responsive */
@media (max-width: 768px) {
  .compact-feedback {
    flex-direction: column;
    align-items: flex-start;
  }

  .card-feedback {
    max-width: 100%;
  }
}
</style>
