<template>
  <div class="input-area">
    <el-input
      id="chat-input"
      name="chat-input"
      :model-value="modelValue"
      @update:model-value="$emit('update:modelValue', $event)"
      type="textarea"
      :rows="3"
      :placeholder="placeholder"
      :disabled="disabled"
      @keydown="handleKeydown"
      resize="none"
    />
    <div class="input-actions">
      <span class="input-hint">
        <template v-if="!hasConfig">请先选择 AI 配置</template>
        <template v-else>Enter 发送 | Shift+Enter 换行</template>
      </span>
      <div class="action-buttons">
        <el-button
          v-if="isLoading"
          type="danger"
          :icon="Close"
          @click="$emit('stop-generation')"
        >
          停止生成
        </el-button>
        <el-button
          v-else
          type="primary"
          :icon="Promotion"
          :disabled="!modelValue.trim() || !hasConfig"
          @click="$emit('send')"
        >
          发送
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Close, Promotion } from '@element-plus/icons-vue'

const props = defineProps<{
  modelValue: string
  placeholder: string
  disabled: boolean
  hasConfig: boolean
  isLoading: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'send'): void
  (e: 'stop-generation'): void
}>()

const handleKeydown = (event: Event | KeyboardEvent) => {
  const keyEvent = event as KeyboardEvent
  if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
    event.preventDefault()
    emit('send')
  }
}
</script>

<style scoped>
.input-area {
  padding: 16px 20px;
  background: var(--el-bg-color-overlay);
  border-top: 1px solid var(--el-border-color-lighter);
}

:deep(.el-textarea__inner) {
  border-radius: 8px;
  font-size: 14px;
  padding: 12px;
  transition: all 0.3s ease;
}

.input-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
}

.input-hint {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.action-buttons {
  display: flex;
  gap: 12px;
}
</style>
