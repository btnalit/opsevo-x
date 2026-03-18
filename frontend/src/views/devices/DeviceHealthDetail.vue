<template>
  <div class="device-health-detail">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <span>健康监控详情 — {{ device?.name || '加载中...' }}</span>
          <el-button size="small" @click="router.push(`/devices/${deviceId}`)">返回设备</el-button>
        </div>
      </template>
    </el-card>

    <!-- 时序图表占位 -->
    <el-card shadow="hover" style="margin-bottom: 20px">
      <template #header>
        <span style="font-weight: 600">指标趋势</span>
      </template>
      <el-empty description="图表开发中" :image-size="120" />
    </el-card>

    <!-- 健康报告历史 -->
    <el-card v-loading="loading" shadow="hover">
      <template #header>
        <div class="card-header">
          <span style="font-weight: 600">健康报告历史</span>
          <el-button size="small" type="primary" @click="fetchHealth">刷新</el-button>
        </div>
      </template>
      <div v-if="health">
        <el-descriptions :column="2" border style="margin-bottom: 16px">
          <el-descriptions-item label="当前状态">
            <el-tag :type="health.status === 'healthy' ? 'success' : health.status === 'degraded' ? 'warning' : 'danger'" size="small">
              {{ healthStatusLabel(health.status) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="延迟">{{ health.latency ?? '-' }} ms</el-descriptions-item>
          <el-descriptions-item label="最后检查">{{ health.lastCheck || '-' }}</el-descriptions-item>
        </el-descriptions>
      </div>
      <el-empty v-else description="暂无健康报告" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { deviceApi, type Device, type HealthCheckResult } from '@/api/device'

defineOptions({ name: 'DeviceHealthDetail' })

const route = useRoute()
const router = useRouter()
const deviceId = route.params.id as string

const device = ref<Device>()
const health = ref<HealthCheckResult>()
const loading = ref(false)

function healthStatusLabel(s: string) {
  return { healthy: '健康', degraded: '降级', unhealthy: '异常', unknown: '未知' }[s] || s
}

async function fetchDevice() {
  try {
    const res = await deviceApi.get(deviceId)
    if (res.data.success && res.data.data) device.value = res.data.data
  } catch { /* ignore */ }
}

async function fetchHealth() {
  loading.value = true
  try {
    const res = await deviceApi.getHealth(deviceId)
    if (res.data.success && res.data.data) health.value = res.data.data
  } catch { /* ignore */ }
  finally { loading.value = false }
}

onMounted(() => {
  fetchDevice()
  fetchHealth()
})
</script>

<style scoped>
.device-health-detail { height: 100%; padding: 20px; background: var(--el-bg-color-page); overflow-y: auto; }
.header-card { margin-bottom: 20px; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
</style>
