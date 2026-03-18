<template>
  <div class="device-detail-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <span>设备详情 — {{ device?.name || '加载中...' }}</span>
          <el-button size="small" @click="router.push('/devices')">返回列表</el-button>
        </div>
      </template>
    </el-card>

    <el-card v-loading="loading" shadow="hover">
      <el-tabs v-model="activeTab">
        <!-- 基本信息 -->
        <el-tab-pane label="基本信息" name="info">
          <el-descriptions v-if="device" :column="2" border>
            <el-descriptions-item label="设备名称">{{ device.name }}</el-descriptions-item>
            <el-descriptions-item label="地址">{{ device.host }}:{{ device.port }}</el-descriptions-item>
            <el-descriptions-item label="驱动类型">
              <el-tag size="small">{{ device.driver_type || 'api' }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="statusTagType(device.status)" size="small" effect="dark">
                {{ statusLabel(device.status) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="分组">{{ device.group_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="最后在线">{{ device.last_seen || '-' }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">{{ device.created_at }}</el-descriptions-item>
            <el-descriptions-item label="更新时间">{{ device.updated_at }}</el-descriptions-item>
          </el-descriptions>
          <el-empty v-else description="设备未找到" />
        </el-tab-pane>

        <!-- 实时指标 -->
        <el-tab-pane label="实时指标" name="metrics">
          <div v-if="metrics">
            <el-row :gutter="16">
              <el-col :span="8">
                <el-statistic title="CPU 使用率" :value="metrics.cpu ?? 0" suffix="%" />
              </el-col>
              <el-col :span="8">
                <el-statistic title="内存使用率" :value="metrics.memory ?? 0" suffix="%" />
              </el-col>
              <el-col :span="8">
                <el-statistic title="运行时间" :value="metrics.uptime ?? 0" suffix="s" />
              </el-col>
            </el-row>
            <el-table v-if="metrics.interfaces?.length" :data="metrics.interfaces" stripe style="margin-top: 16px">
              <el-table-column prop="name" label="接口" />
              <el-table-column prop="status" label="状态" />
              <el-table-column prop="rxBytes" label="接收字节" />
              <el-table-column prop="txBytes" label="发送字节" />
            </el-table>
          </div>
          <el-empty v-else description="暂无指标数据" />
        </el-tab-pane>

        <!-- 告警历史 -->
        <el-tab-pane label="告警历史" name="alerts">
          <el-empty description="告警历史开发中" />
        </el-tab-pane>

        <!-- 连接状态 -->
        <el-tab-pane label="连接状态" name="connection">
          <div v-if="health">
            <el-descriptions :column="2" border>
              <el-descriptions-item label="健康状态">
                <el-tag :type="health.status === 'healthy' ? 'success' : 'danger'" size="small">
                  {{ health.status }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="延迟">{{ health.latency ?? '-' }} ms</el-descriptions-item>
              <el-descriptions-item label="最后检查">{{ health.lastCheck || '-' }}</el-descriptions-item>
            </el-descriptions>
          </div>
          <el-empty v-else description="暂无健康数据" />
          <el-button style="margin-top: 12px" type="primary" size="small" @click="fetchHealth">刷新</el-button>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { deviceApi, type Device, type DeviceMetrics, type HealthCheckResult } from '@/api/device'

defineOptions({ name: 'DeviceDetailView' })

const route = useRoute()
const router = useRouter()

const device = ref<Device>()
const metrics = ref<DeviceMetrics>()
const health = ref<HealthCheckResult>()
const loading = ref(false)
const activeTab = ref('info')

function statusTagType(s: Device['status']) {
  return s === 'online' ? 'success' : s === 'error' ? 'danger' : s === 'connecting' ? 'primary' : 'info'
}
function statusLabel(s: Device['status']) {
  return { online: '在线', offline: '离线', connecting: '连接中', error: '错误' }[s] || s
}

async function fetchDevice() {
  loading.value = true
  try {
    const res = await deviceApi.get(route.params.id as string)
    if (res.data.success && res.data.data) device.value = res.data.data
  } finally { loading.value = false }
}

async function fetchMetrics() {
  try {
    const res = await deviceApi.getMetrics(route.params.id as string)
    if (res.data.success && res.data.data) metrics.value = res.data.data
  } catch { /* ignore */ }
}

async function fetchHealth() {
  try {
    const res = await deviceApi.getHealth(route.params.id as string)
    if (res.data.success && res.data.data) health.value = res.data.data
  } catch { /* ignore */ }
}

onMounted(async () => {
  await fetchDevice()
  fetchMetrics()
  fetchHealth()
})
</script>

<style scoped>
.device-detail-view { height: 100%; padding: 20px; background: var(--el-bg-color-page); overflow-y: auto; }
.header-card { margin-bottom: 20px; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
</style>
