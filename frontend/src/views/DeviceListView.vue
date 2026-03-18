<template>
  <div class="device-list-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>设备管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="goToAdd">
              添加设备
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-card shadow="hover">

      <el-table
        v-loading="deviceStore.loading"
        :data="deviceStore.devices"
        stripe
        style="width: 100%"
      >
        <el-table-column prop="name" label="设备名称" min-width="140" />
        <el-table-column label="地址" min-width="160">
          <template #default="{ row }">
            {{ row.host }}:{{ row.port }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small" effect="dark">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="标签" min-width="160">
          <template #default="{ row }">
            <el-tag
              v-for="tag in parseTags(row.tags)"
              :key="tag"
              size="small"
              class="tag-item"
            >
              {{ tag }}
            </el-tag>
            <span v-if="parseTags(row.tags).length === 0" class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="group_name" label="分组" width="120">
          <template #default="{ row }">
            {{ row.group_name || '-' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status !== 'online'"
              type="success"
              size="small"
              link
              :loading="row.status === 'connecting'"
              @click="handleConnect(row)"
            >
              连接
            </el-button>
            <el-button
              v-if="row.status === 'online'"
              type="warning"
              size="small"
              link
              @click="handleDisconnect(row)"
            >
              断开
            </el-button>
            <el-button
              type="primary"
              size="small"
              link
              @click="handleSelect(row)"
            >
              选择
            </el-button>
            <el-popconfirm
              title="确定要删除该设备吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="handleDelete(row)"
            >
              <template #reference>
                <el-button type="danger" size="small" link>
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'

import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '@/stores/device'
import type { Device } from '@/api/device'

defineOptions({ name: 'DeviceListView' })

const router = useRouter()
const deviceStore = useDeviceStore()

onMounted(() => {
  // deviceStore.selectDevice('') // Don't clear state here, handle visibility in SideMenu
  deviceStore.fetchDevices()
})

function goToAdd() {
  router.push('/devices/add')
}

function statusTagType(status: Device['status']): 'primary' | 'success' | 'info' | 'warning' | 'danger' {
  switch (status) {
    case 'online': return 'success'
    case 'offline': return 'info'
    case 'connecting': return 'primary'
    case 'error': return 'danger'
    default: return 'info'
  }
}

function statusLabel(status: Device['status']): string {
  switch (status) {
    case 'online': return '在线'
    case 'offline': return '离线'
    case 'connecting': return '连接中'
    case 'error': return '错误'
    default: return status
  }
}

function parseTags(tags: string): string[] {
  if (!tags) return []
  try {
    const parsed = JSON.parse(tags)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function handleConnect(device: Device) {
  try {
    await deviceStore.connectDevice(device.id)
    ElMessage.success(`设备 "${device.name}" 连接成功`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '连接失败'
    ElMessage.error(message)
  }
}

async function handleDisconnect(device: Device) {
  try {
    await deviceStore.disconnectDevice(device.id)
    ElMessage.success(`设备 "${device.name}" 已断开连接`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '断开连接失败'
    ElMessage.error(message)
  }
}

function handleSelect(device: Device) {
  deviceStore.selectDevice(device.id)
  localStorage.setItem('current_device_id', device.id) // Force sync
  ElMessage.success(`已选择设备 "${device.name}"`)
  router.push('/ai-ops')
}

async function handleDelete(device: Device) {
  try {
    await deviceStore.removeDevice(device.id)
    ElMessage.success(`设备 "${device.name}" 已删除`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '删除失败'
    ElMessage.error(message)
  }
}
</script>

<style scoped>
.device-list-view {
  height: 100%;
  padding: 20px;
  background: var(--el-bg-color-page);
  overflow-y: auto;
}

.header-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tag-item {
  margin-right: 4px;
  margin-bottom: 2px;
}

.text-muted {
  color: var(--el-text-color-secondary);
}
</style>
