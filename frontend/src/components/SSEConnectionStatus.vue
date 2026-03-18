<template>
  <div class="sse-connection-status" :class="statusClass">
    <el-tooltip :content="tooltipContent" placement="bottom">
      <div class="status-indicator">
        <span class="status-dot" :class="dotClass"></span>
        <span v-if="showText" class="status-text">{{ statusText }}</span>
      </div>
    </el-tooltip>

    <!-- 重连进度提示 -->
    <el-popover
      v-if="isReconnecting"
      :visible="showReconnectPopover"
      placement="bottom"
      :width="280"
      trigger="hover"
    >
      <template #reference>
        <el-icon class="reconnect-icon" :class="{ spinning: isReconnecting }">
          <i-ep-refresh />
        </el-icon>
      </template>
      <div class="reconnect-info">
        <p class="reconnect-title">正在尝试重新连接...</p>
        <el-progress
          :percentage="reconnectProgress"
          :stroke-width="6"
          :show-text="false"
          status="warning"
        />
        <p class="reconnect-detail">
          尝试次数: {{ reconnectAttempts }} / {{ maxReconnectAttempts }}
        </p>
      </div>
    </el-popover>

    <!-- 错误状态操作 -->
    <el-button
      v-if="hasError && showRetryButton"
      type="primary"
      size="small"
      link
      @click="handleRetry"
    >
      重试连接
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SSEConnectionState } from '@/utils/sseConnectionManager'
import { getConnectionStateText, getConnectionStateType } from '@/utils/useSSEConnection'

/**
 * SSE 连接状态指示组件
 * Requirements: 7.3
 */

interface Props {
  /** 连接状态 */
  state: SSEConnectionState
  /** 重连尝试次数 */
  reconnectAttempts?: number
  /** 最大重连次数 */
  maxReconnectAttempts?: number
  /** 最后错误信息 */
  lastError?: Error | null
  /** 是否显示文本 */
  showText?: boolean
  /** 是否显示重试按钮 */
  showRetryButton?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,
  lastError: null,
  showText: true,
  showRetryButton: true
})

const emit = defineEmits<{
  (e: 'retry'): void
}>()

// 计算属性
const isConnected = computed(() => props.state === 'connected')
const isReconnecting = computed(() => props.state === 'reconnecting')
const hasError = computed(() => props.state === 'error')

const statusText = computed(() => getConnectionStateText(props.state))
// statusType is available for future use if needed
const _statusType = computed(() => getConnectionStateType(props.state))
void _statusType.value // Correctly access .value to suppress unused warning

const statusClass = computed(() => ({
  'is-connected': isConnected.value,
  'is-reconnecting': isReconnecting.value,
  'is-error': hasError.value,
  'is-disconnected': props.state === 'disconnected'
}))

const dotClass = computed(() => ({
  'dot-success': isConnected.value,
  'dot-warning': isReconnecting.value || props.state === 'connecting',
  'dot-danger': hasError.value,
  'dot-info': props.state === 'disconnected'
}))

const tooltipContent = computed(() => {
  if (hasError.value && props.lastError) {
    return `连接错误: ${props.lastError.message}`
  }
  if (isReconnecting.value) {
    return `正在重连 (${props.reconnectAttempts}/${props.maxReconnectAttempts})`
  }
  return statusText.value
})

const reconnectProgress = computed(() => {
  if (props.maxReconnectAttempts === 0) return 0
  return Math.round((props.reconnectAttempts / props.maxReconnectAttempts) * 100)
})

const showReconnectPopover = ref(false)

// 监听重连状态
watch(isReconnecting, (value) => {
  showReconnectPopover.value = value
})

// 处理重试
const handleRetry = () => {
  emit('retry')
}
</script>

<style scoped>
.sse-connection-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition: background-color 0.3s ease;
}

.dot-success {
  background-color: var(--el-color-success);
  box-shadow: 0 0 6px var(--el-color-success);
}

.dot-warning {
  background-color: var(--el-color-warning);
  animation: pulse 1.5s ease-in-out infinite;
}

.dot-danger {
  background-color: var(--el-color-danger);
}

.dot-info {
  background-color: var(--el-color-info);
}

.status-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.reconnect-icon {
  font-size: 14px;
  color: var(--el-color-warning);
}

.reconnect-icon.spinning {
  animation: spin 1s linear infinite;
}

.reconnect-info {
  text-align: center;
}

.reconnect-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.reconnect-detail {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
