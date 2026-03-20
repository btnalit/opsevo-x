<template>
  <el-select
    v-model="selectedDeviceId"
    placeholder="全部设备"
    clearable
    size="small"
    style="width: 200px"
    @change="onDeviceChange"
  >
    <el-option value="" label="全部设备">
      <span>🌐 全部设备</span>
      <el-tag v-if="deviceStore.deviceSummary" size="small" type="info" style="margin-left: 8px">
        {{ deviceStore.deviceSummary.total }}
      </el-tag>
    </el-option>
    <el-option
      v-for="device in deviceStore.devices"
      :key="device.id"
      :value="device.id"
      :label="device.name"
    >
      <span class="device-option">
        <span
          class="status-dot"
          :style="{ background: device.status === 'online' ? '#67c23a' : '#f56c6c' }"
        />
        {{ device.name }}
        <el-tag size="small" :type="device.status === 'online' ? 'success' : 'danger'">
          {{ device.status === 'online' ? '在线' : '离线' }}
        </el-tag>
      </span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useDeviceStore } from '@/stores/device'

const deviceStore = useDeviceStore()
const selectedDeviceId = ref(deviceStore.currentDeviceId || '')

// 同步 store → 本地
watch(() => deviceStore.currentDeviceId, (val) => {
  selectedDeviceId.value = val || ''
})

function onDeviceChange(val: string) {
  deviceStore.selectDevice(val || '')
}

onMounted(() => {
  if (!deviceStore.devices.length) {
    deviceStore.fetchDevices()
  }
})
</script>

<style scoped>
.device-option {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
</style>
