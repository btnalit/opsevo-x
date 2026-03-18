<template>
  <div class="connection-status" :class="statusClass">
    <el-icon :size="16">
      <component :is="statusIcon" />
    </el-icon>
    <span class="status-text">{{ statusText }}</span>
    <el-button
      v-if="!connectionStore.isConnected"
      type="primary"
      size="small"
      link
      @click="handleReconnect"
    >
      重新连接
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { Connection, Warning } from '@element-plus/icons-vue'

import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useConnectionStore } from '@/stores/connection'

const connectionStore = useConnectionStore()
const router = useRouter()

const statusClass = computed(() => ({
  connected: connectionStore.isConnected,
  disconnected: !connectionStore.isConnected
}))

const statusIcon = computed(() => 
  connectionStore.isConnected ? Connection : Warning
)

const statusText = computed(() =>
  connectionStore.isConnected ? '已连接' : '未连接'
)

const handleReconnect = () => {
  router.push('/connection')
}
</script>

<style scoped>
.connection-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
}

.connection-status.connected {
  color: #67c23a;
  background-color: rgba(103, 194, 58, 0.1);
}

.connection-status.disconnected {
  color: #e6a23c;
  background-color: rgba(230, 162, 60, 0.1);
}

.status-text {
  margin-right: 8px;
}
</style>
