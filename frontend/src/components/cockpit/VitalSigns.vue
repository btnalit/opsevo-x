<template>
  <div class="vital-signs">
    <div class="vital-item status-indicator">
      <span class="pulse-dot" :class="stateClass"></span>
      <div class="vital-info">
        <div class="vital-label">STATE</div>
        <div class="vital-value" :class="stateTextClass">{{ currentStateText }}</div>
      </div>
    </div>

    <div class="vital-divider"></div>

    <div class="vital-item">
      <el-icon class="vital-icon text-blue"><i-ep-odometer /></el-icon>
      <div class="vital-info">
        <div class="vital-label">HEALTH SCORE</div>
        <div class="vital-value">{{ healthScore }} <span class="vital-unit">/ 100</span></div>
      </div>
    </div>

    <div class="vital-divider"></div>

    <div class="vital-item">
      <el-icon class="vital-icon" :class="stabilityColorClass"><i-ep-aim /></el-icon>
      <div class="vital-info">
        <div class="vital-label">STABILITY</div>
        <div class="vital-value" :class="stabilityColorClass">{{ stability }}%</div>
      </div>
    </div>

    <div class="vital-divider"></div>

    <div class="vital-item">
      <el-icon class="vital-icon text-purple"><i-ep-collection /></el-icon>
      <div class="vital-info">
        <div class="vital-label">DIMENSIONS</div>
        <div class="vital-value">
          <span class="vital-unit">S:{{ dimensions.system }} N:{{ dimensions.network }} P:{{ dimensions.performance }}</span>
        </div>
        <div class="vital-progress-bar">
          <div class="vital-progress-fill bg-purple" :style="{ width: dimensionBalance + '%' }"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useHealthData } from '@/composables/useHealthData'

// --- 通过共享 composable 获取健康数据（Requirements 8.2） ---
const { data: healthData } = useHealthData()

const healthScore = computed(() => healthData.value?.score ?? 0)
const healthLevel = computed(() => healthData.value?.level ?? 'unknown')
const dimensions = computed(() => healthData.value?.dimensions ?? { system: 0, network: 0, performance: 0, reliability: 0 })

// 稳定度基于健康评分和维度均衡度（维度方差越大越不稳定）
const stability = computed(() => {
  if (!healthData.value) return 0
  const dimValues = Object.values(dimensions.value) as number[]
  const avg = dimValues.reduce((a, b) => a + b, 0) / dimValues.length
  const variance = dimValues.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / dimValues.length
  return Math.round(Math.max(0, Math.min(99, healthData.value.score - Math.sqrt(variance) * 0.5)))
})

// 维度均衡度（用于 DIMENSIONS 进度条，方差越小越均衡）
const dimensionBalance = computed(() => {
  const dimValues = Object.values(dimensions.value) as number[]
  if (dimValues.every(v => v === 0)) return 0
  const avg = dimValues.reduce((a, b) => a + b, 0) / dimValues.length
  const variance = dimValues.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / dimValues.length
  // 方差 0 → 100%，方差越大越低
  return Math.round(Math.max(10, 100 - Math.sqrt(variance) * 2))
})

const currentStateText = computed(() => {
  switch (healthLevel.value) {
    case 'healthy': return 'HEALTHY'
    case 'warning': return 'WARNING'
    case 'critical': return 'CRITICAL'
    default: return 'LOADING...'
  }
})

const stateClass = computed(() => {
  switch (healthLevel.value) {
    case 'healthy': return 'bg-green pulse-slow'
    case 'warning': return 'bg-yellow pulse-medium'
    case 'critical': return 'bg-red pulse-fast'
    default: return 'bg-blue pulse-slow'
  }
})

const stateTextClass = computed(() => {
  switch (healthLevel.value) {
    case 'healthy': return 'text-green'
    case 'warning': return 'text-yellow'
    case 'critical': return 'text-red'
    default: return 'text-blue'
  }
})

const stabilityColorClass = computed(() => {
  if (stability.value >= 90) return 'text-green'
  if (stability.value >= 70) return 'text-yellow'
  return 'text-red'
})
</script>

<style scoped>
.vital-signs {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 100%;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  flex-wrap: wrap;
  gap: 8px 0;
}

.vital-divider {
  width: 1px;
  height: 32px;
  background-color: var(--el-border-color-lighter);
  margin: 0 32px;
}

.vital-item {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 160px;
}

.vital-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.vital-label {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  letter-spacing: 1px;
  margin-bottom: 4px;
}

.vital-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.vital-unit {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
}

.vital-icon {
  font-size: 24px;
}

.vital-progress-bar {
  width: 120px;
  height: 4px;
  background-color: var(--el-fill-color-darker);
  border-radius: 2px;
  margin-top: 6px;
  overflow: hidden;
}

.vital-progress-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.pulse-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: 0 0 10px currentColor;
}

.pulse-slow { animation: pulse 3s infinite ease-in-out; }
.pulse-medium { animation: pulse 1.5s infinite ease-in-out; }
.pulse-fast { animation: pulse 0.8s infinite ease-in-out; }

@keyframes pulse {
  0% { transform: scale(0.95); opacity: 0.7; }
  50% { transform: scale(1.05); opacity: 1; }
  100% { transform: scale(0.95); opacity: 0.7; }
}

.bg-blue { background-color: #409eff; color: #409eff; }
.bg-yellow { background-color: #e6a23c; color: #e6a23c; }
.bg-green { background-color: #67c23a; color: #67c23a; }
.bg-purple { background-color: #b37feb; color: #b37feb; }
.bg-red { background-color: #f56c6c; color: #f56c6c; }

.text-blue { color: #409eff; }
.text-yellow { color: #e6a23c; }
.text-green { color: #67c23a; }
.text-purple { color: #b37feb; }
.text-red { color: #f56c6c; }
</style>
