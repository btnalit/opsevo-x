<template>
  <div class="cognitive-cockpit">
    <!-- 版块四：生命体征 (Vital Signs) -->
    <div class="vital-signs-bar">
      <VitalSigns />
      <div class="vital-divider-mcp"></div>
      <!-- Brain Loop 状态指示器 -->
      <el-tooltip :content="`Brain Loop: ${brainState} | 队列: ${brainQueueDepth}`" placement="bottom">
        <el-tag :type="brainStateType" size="small" effect="dark" style="margin-right: 8px; cursor: default;">
          🧠 {{ brainStateLabel }}
        </el-tag>
      </el-tooltip>
      <el-button size="small" type="primary" plain @click="showMcpPanel = true">
        MCP
      </el-button>
    </div>

    <div class="cockpit-main">
      <!-- 版块二：全息拓扑 (God's Eye Topology) -->
      <div class="topology-panel">
        <GodsEyeTopology />
      </div>

      <!-- 版块一：中央皮层 (Stream of Consciousness) -->
      <div class="consciousness-panel">
        <StreamOfConsciousness />
      </div>
    </div>

    <!-- 版块三：Intent 气闸 (The Air-Lock) -->
    <IntentAirLock class="air-lock-overlay" />

    <!-- MCP 管理面板 -->
    <McpManagementPanel v-model:visible="showMcpPanel" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, onActivated, onDeactivated, ref, computed } from 'vue'
import VitalSigns from '@/components/cockpit/VitalSigns.vue'
import StreamOfConsciousness from '@/components/cockpit/StreamOfConsciousness.vue'
import GodsEyeTopology from '@/components/cockpit/GodsEyeTopology.vue'
import IntentAirLock from '@/components/cockpit/IntentAirLock.vue'
import McpManagementPanel from '@/components/cockpit/McpManagementPanel.vue'
import { useTopologySSE } from '@/composables/useTopologySSE'
import { useHealthData } from '@/composables/useHealthData'
import { brainApi } from '@/api/aiops-enhanced'

defineOptions({
  name: 'CognitiveCockpitView'
})

// MCP 管理面板
const showMcpPanel = ref(false)

// Brain Loop 状态
const brainState = ref('unknown')
const brainQueueDepth = ref(0)
const brainStateLabel = computed(() => {
  const labels: Record<string, string> = { running: '运行中', cooldown: '冷却中', backpressure: '背压', stopped: '已停止', unknown: '未知' }
  return labels[brainState.value] || brainState.value
})
const brainStateType = computed(() => {
  const types: Record<string, string> = { running: 'success', cooldown: 'warning', backpressure: 'danger', stopped: 'info' }
  return (types[brainState.value] || 'info') as 'success' | 'warning' | 'danger' | 'info'
})
let brainTimer: ReturnType<typeof setInterval> | null = null
const loadBrainStatus = async () => {
  try {
    const res = await brainApi.getStatus()
    if (res.data.success && res.data.data) {
      brainState.value = res.data.data.state
      brainQueueDepth.value = res.data.data.queueDepth
    }
  } catch (error) {
    // 认证失败时停止轮询，避免请求风暴
    const msg = error instanceof Error ? error.message : ''
    if (msg.includes('认证已过期') || msg.includes('刷新令牌失败')) {
      if (brainTimer) { clearInterval(brainTimer); brainTimer = null }
    }
  }
}

// 共享 composable 实例
const sse = useTopologySSE()
const health = useHealthData()

// ==================== 生命周期管理 ====================

onMounted(() => {
  // 启动健康数据轮询（SSE 连接由子组件 subscribe 时自动创建）
  health.start()
  loadBrainStatus()
  brainTimer = setInterval(loadBrainStatus, 15000)
})

onUnmounted(() => {
  // 关闭所有 SSE 连接并清理订阅者
  sse.close()
  // 停止健康数据轮询
  health.stop()
  if (brainTimer) { clearInterval(brainTimer); brainTimer = null }
})

onDeactivated(() => {
  // keep-alive 停用：断开 SSE 连接，停止健康轮询，停止 brainTimer
  sse.deactivate()
  health.stop()
  if (brainTimer) { clearInterval(brainTimer); brainTimer = null }
})

onActivated(() => {
  // keep-alive 激活：恢复 SSE 连接，重启健康轮询，重启 brainTimer
  sse.activate()
  health.start()
  loadBrainStatus()
  if (!brainTimer) { brainTimer = setInterval(loadBrainStatus, 15000) }
})
</script>

<style scoped>
.cognitive-cockpit {
  /* 使用主题变量体系 */
  background-color: var(--el-bg-color-page);
  color: var(--el-text-color-primary);
  /* 自适应父容器 el-main 的高度，不再硬编码 calc(100vh - Xpx) */
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  /* 基础赛博防区布局边界 */
  padding: 16px;
  gap: 16px;
}

.vital-signs-bar {
  height: 64px;
  flex-shrink: 0;
  background-color: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow-light);
  display: flex;
  align-items: center;
  padding: 0 24px;
}

.cockpit-main {
  flex-grow: 1;
  display: flex;
  gap: 16px;
  min-height: 0; /* flex core */
}

.topology-panel {
  flex: 0 0 35%; /* 左侧 35% 空间 */
  background-color: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow-light);
  overflow: hidden;
  position: relative;
}

.consciousness-panel {
  flex: 1; /* 右侧剩余 65% 空间 */
  background-color: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow-light);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.air-lock-overlay {
  position: absolute;
  bottom: 24px;
  right: 24px;
  width: 450px;
  z-index: 100;
}

.vital-divider-mcp {
  width: 1px;
  height: 32px;
  background-color: var(--el-border-color-lighter);
  margin: 0 16px;
  flex-shrink: 0;
}
</style>
