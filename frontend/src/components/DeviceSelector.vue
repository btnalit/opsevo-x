<template>
  <el-dropdown trigger="click" @command="handleCommand" class="device-selector">
    <span class="selector-trigger">
      <el-icon class="device-icon"><i-ep-monitor /></el-icon>
      <template v-if="deviceStore.currentDevice">
        <span class="device-name">{{ deviceStore.currentDevice.name }}</span>
        <span
          class="status-dot"
          :class="'status-' + deviceStore.currentDevice.status"
        />
      </template>
      <span v-else class="device-placeholder">请选择设备</span>
      <el-icon class="arrow-icon"><i-ep-arrow-down /></el-icon>
    </span>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-if="deviceStore.devices.length === 0"
          disabled
        >
          暂无设备
        </el-dropdown-item>
        <el-dropdown-item
          v-for="device in deviceStore.devices"
          :key="device.id"
          :command="device.id"
          :class="{ 'is-active': device.id === deviceStore.currentDeviceId }"
        >
          <div class="dropdown-device-item">
            <span class="dropdown-device-name">{{ device.name }}</span>
            <span
              class="status-dot"
              :class="'status-' + device.status"
            />
          </div>
        </el-dropdown-item>
        <el-dropdown-item divided command="__manage__">
          <el-icon><i-ep-setting /></el-icon>
          管理设备
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '@/stores/device'

const router = useRouter()
const deviceStore = useDeviceStore()

onMounted(async () => {
  // 先从缓存加载用于即时显示
  deviceStore.loadFromStorage()
  // 始终从 API 刷新设备列表
  await deviceStore.fetchDevices()
})

function handleCommand(command: string) {
  if (command === '__manage__') {
    router.push('/devices')
    return
  }
  deviceStore.selectDevice(command)
  const device = deviceStore.currentDevice
  if (device) {
    ElMessage.success(`已切换到设备 "${device.name}"`)
  }
}
</script>

<style scoped>
.device-selector {
  cursor: pointer;
}

.selector-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  color: #606266;
  cursor: pointer;
  transition: background-color 0.2s;
}

.selector-trigger:hover {
  background-color: #f5f7fa;
}

.device-icon {
  font-size: 16px;
  color: #909399;
}

.device-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-placeholder {
  color: #c0c4cc;
}

.arrow-icon {
  font-size: 12px;
  color: #909399;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-online {
  background-color: #67c23a;
}

.status-offline {
  background-color: #c0c4cc;
}

.status-connecting {
  background-color: #409eff;
  animation: pulse 1.5s infinite;
}

.status-error {
  background-color: #f56c6c;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.dropdown-device-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 140px;
}

.dropdown-device-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.is-active) {
  color: var(--el-color-primary);
  font-weight: 500;
}
</style>
