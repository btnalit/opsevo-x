<template>
  <transition name="air-lock-fade">
    <div v-if="isVisible && pendingIntent" class="intent-air-lock glass-panel custom-glass">
      <div class="lock-header">
        <div class="lock-brand">
          <el-icon class="alert-icon"><i-ep-warning-filled /></el-icon>
          <span>AIR-LOCK INTERCEPT</span>
          <span v-if="pendingCount > 1" class="queue-badge">+{{ pendingCount - 1 }} queued</span>
        </div>
        <div class="lock-level">{{ pendingIntent.riskLevel }}</div>
      </div>

      <div class="lock-body">
        <div class="info-row">
          <span class="label">INTENT:</span>
          <span class="value action-name">{{ pendingIntent.action }}</span>
        </div>
        <div class="info-row">
          <span class="label">PARAMS:</span>
          <span class="value">{{ JSON.stringify(pendingIntent.params, null, 2) }}</span>
        </div>
        <div class="info-row vertical">
          <span class="label">JUSTIFICATION:</span>
          <div class="reasoning-box">
            This action was flagged as {{ pendingIntent.riskLevel }} risk by the System Cortex validation layer.
            It requires explicit commander authorization before proceeding.
          </div>
        </div>
      </div>

      <div class="lock-actions">
        <!-- Physical-style buttons -->
        <button class="action-btn reject" :disabled="loading" @click="handleReject">
          <span v-if="!loading" class="btn-text">REJECT</span>
          <span v-else class="btn-text">PROCESSING...</span>
        </button>
        <button class="action-btn grant" :disabled="loading" @click="handleGrant">
          <span v-if="!loading" class="btn-text">GRANT EXECUTION</span>
          <span v-else class="btn-text">PROCESSING...</span>
        </button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import api from '@/api'
import { ElMessage } from 'element-plus'

interface PendingIntent {
  id: string
  action: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any
  riskLevel: string
  timestamp: number
}

const isVisible = ref(false)
const pendingIntent = ref<PendingIntent | null>(null)
const pendingCount = ref(0)
const loading = ref(false)
let pollTimer: number | null = null

const fetchPending = async () => {
  if (loading.value) return
  try {
    const res = await api.get('/ai-ops/intents/pending')
    if (res.data.success && res.data.data && res.data.data.length > 0) {
      // FIFO: 后端按时间降序排列，取最后一条即最早等待的意图（先到先审批）
      pendingIntent.value = res.data.data[res.data.data.length - 1]
      pendingCount.value = res.data.data.length
      isVisible.value = true
    } else {
      isVisible.value = false
      pendingIntent.value = null
      pendingCount.value = 0
    }
  } catch (error) {
    console.warn('Failed to fetch pending intents', error)
  }
}

onMounted(() => {
  // FIX: 轮询频率从 8 秒缩短到 3 秒，提高高危操作审批响应速度
  pollTimer = window.setInterval(fetchPending, 3000)
  fetchPending()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

const handleGrant = async () => {
  if (!pendingIntent.value) return
  loading.value = true
  try {
    const res = await api.post(`/ai-ops/intents/grant/${pendingIntent.value.id}`)
    if (res.data.success) {
      ElMessage.success(`Intent ${pendingIntent.value.action} executed successfully.`)
    } else {
      ElMessage.error(`Execution failed: ${res.data.error}`)
    }
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    loading.value = false
    fetchPending() // Refresh queue
  }
}

const handleReject = async () => {
  if (!pendingIntent.value) return
  loading.value = true
  try {
    await api.post(`/ai-ops/intents/reject/${pendingIntent.value.id}`)
    ElMessage.info(`Intent ${pendingIntent.value.action} rejected.`)
  } catch (error: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any
    ElMessage.error(err.response?.data?.error || err.message)
  } finally {
    loading.value = false
    fetchPending()
  }
}
</script>

<style scoped>
.intent-air-lock {
  border-radius: 12px;
  overflow: hidden;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8) !important;
  border: 1px solid rgba(245, 108, 108, 0.5) !important;
  background: var(--el-bg-color-overlay) !important;
  animation: lock-pulse 2s infinite;
}

@keyframes lock-pulse {
  0% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.4); }
  70% { box-shadow: 0 0 0 15px rgba(245, 108, 108, 0); }
  100% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0); }
}

.lock-header {
  height: 48px;
  background-color: rgba(245, 108, 108, 0.15);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 20px;
  border-bottom: 1px solid rgba(245, 108, 108, 0.3);
}

.lock-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #f56c6c;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 1px;
}

.alert-icon {
  font-size: 20px;
}

.queue-badge {
  font-size: 11px;
  color: #e6a23c;
  background-color: rgba(230, 162, 60, 0.15);
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.lock-level {
  background-color: #f56c6c;
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 1px;
}

.lock-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.info-row.vertical {
  flex-direction: column;
  gap: 8px;
}

.label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 600;
  width: 100px;
  flex-shrink: 0;
  padding-top: 2px;
}

.value {
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 600;
}

.action-name {
  color: #e6a23c;
  padding: 2px 6px;
  background-color: rgba(230, 162, 60, 0.1);
  border: 1px solid rgba(230, 162, 60, 0.3);
  border-radius: 4px;
}

.reasoning-box {
  background-color: var(--el-fill-color-darker);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 12px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.5;
  width: 100%;
  box-sizing: border-box;
}

.lock-actions {
  display: flex;
  padding: 16px 20px 20px;
  gap: 16px;
}

.action-btn {
  flex: 1;
  height: 48px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 1px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 6px rgba(0,0,0,0.3);
}

.action-btn:active {
  transform: translateY(2px);
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
}

.action-btn.reject {
  background-color: var(--el-fill-color-darker);
  color: var(--el-text-color-primary);
  border: 1px solid var(--el-border-color);
}

.action-btn.reject:hover {
  background-color: var(--el-fill-color-light);
  border-color: var(--el-text-color-regular);
}

.action-btn.grant {
  background-color: #f56c6c;
  color: #fff;
  border: 1px solid #c82333;
  /* 增加物理按键的高光质感 */
  background-image: linear-gradient(to bottom, #f88, #f56c6c);
}

.action-btn.grant:hover {
  background-image: linear-gradient(to bottom, #ff9999, #f78989);
  box-shadow: 0 6px 12px rgba(245, 108, 108, 0.4);
}

/* 进出场动画 */
.air-lock-fade-enter-active,
.air-lock-fade-leave-active {
  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
}

.air-lock-fade-enter-from,
.air-lock-fade-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}
</style>
