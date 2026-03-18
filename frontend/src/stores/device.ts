/**
 * Device Store - 设备状态管理
 *
 * 使用 Pinia 管理设备列表、当前选中设备等状态
 * currentDeviceId 持久化到 localStorage
 * Requirements: 7.3, 7.4, 7.5
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { deviceApi, type Device, type CreateDeviceRequest } from '@/api/device'
import { useConnectionStore } from './connection'

const CURRENT_DEVICE_KEY = 'current_device_id'

export const useDeviceStore = defineStore('device', () => {
  // ==================== 状态 ====================
  const devices = ref<Device[]>([])
  const currentDeviceId = ref<string>('')
  const loading = ref(false)

  // Initialize from storage immediately
  loadFromStorage()

  // ==================== 计算属性 ====================

  /** 当前选中的设备 */
  const currentDevice = computed<Device | undefined>(() => {
    if (!currentDeviceId.value) return undefined
    return devices.value.find((d) => d.id === currentDeviceId.value)
  })

  /** 在线设备列表 */
  const onlineDevices = computed<Device[]>(() => {
    return devices.value.filter((d) => d.status === 'online')
  })

  /** 是否已选择设备 */
  const hasSelectedDevice = computed<boolean>(() => {
    return !!currentDeviceId.value && !!currentDevice.value
  })

  // ==================== 方法 ====================

  /**
   * 从 localStorage 加载 currentDeviceId
   */
  function loadFromStorage(): void {
    const savedId = localStorage.getItem(CURRENT_DEVICE_KEY)
    if (savedId) {
      currentDeviceId.value = savedId
    }
  }

  /**
   * Manually set/update a single device in the list
   * Useful when AppLayout fetches device info independently
   */
  function setDevice(device: Device): void {
    const idx = devices.value.findIndex(d => d.id === device.id)
    if (idx !== -1) {
      devices.value[idx] = { ...devices.value[idx], ...device }
    } else {
      devices.value.push(device)
    }
  }

  /**
   * 获取设备列表
   */
  async function fetchDevices(): Promise<void> {
    loading.value = true
    try {
      const response = await deviceApi.list()
      if (response.data.success && response.data.data) {
        devices.value = response.data.data
        // Don't auto-clear device ID here. 
        // usage: checkConnectionStatus determines if device is valid.
        // if (currentDeviceId.value && !devices.value.find((d) => d.id === currentDeviceId.value)) {
        //   currentDeviceId.value = ''
        //   localStorage.removeItem(CURRENT_DEVICE_KEY)
        // }
      }
    } finally {
      loading.value = false
    }
  }

  /**
   * 选择设备
   */
  function selectDevice(id: string): void {
    currentDeviceId.value = id
    if (id) {
      localStorage.setItem(CURRENT_DEVICE_KEY, id)
      // 同步更新连接状态
      const device = devices.value.find(d => d.id === id)
      const connectionStore = useConnectionStore()
      if (device) {
        connectionStore.setConnected(device.status === 'online')
        connectionStore.setConfig({
          host: device.host,
          port: device.port,
          username: device.username,
          password: '',
          useTLS: device.use_tls === 1
        })
      } else {
        connectionStore.setConnected(false)
      }
    } else {
      localStorage.removeItem(CURRENT_DEVICE_KEY)
      const connectionStore = useConnectionStore()
      connectionStore.setConnected(false)
    }
  }

  /**
   * 添加设备
   */
  async function addDevice(data: CreateDeviceRequest): Promise<Device | undefined> {
    const response = await deviceApi.create(data)
    if (response.data.success && response.data.data) {
      devices.value.push(response.data.data)
      return response.data.data
    }
    throw new Error(response.data.error || '添加设备失败')
  }

  /**
   * 删除设备
   */
  async function removeDevice(id: string): Promise<void> {
    const response = await deviceApi.delete(id)
    if (response.data.success) {
      devices.value = devices.value.filter((d) => d.id !== id)
      // 如果删除的是当前选中的设备，清除选择
      if (currentDeviceId.value === id) {
        selectDevice('')
      }
    } else {
      throw new Error(response.data.error || '删除设备失败')
    }
  }

  /**
   * 连接设备
   */
  async function connectDevice(id: string): Promise<void> {
    // 先更新本地状态为 connecting
    const device = devices.value.find((d) => d.id === id)
    if (device) {
      device.status = 'connecting'
    }
    try {
      const response = await deviceApi.connect(id)
      if (response.data.success && response.data.data) {
        // 更新设备状态
        const idx = devices.value.findIndex((d) => d.id === id)
        if (idx !== -1) {
          // 强制设置为 online，确保 UI 更新
          devices.value[idx] = { ...response.data.data, status: 'online' }
          // 如果是当前选中设备，同步全局连接状态
          if (currentDeviceId.value === id) {
            const connectionStore = useConnectionStore()
            connectionStore.setConnected(true)
          }
        }
      } else {
        // 如果失败，恢复为 offline（或者保持原状态，这里假设连接失败就是 offline）
        if (device) device.status = 'offline'
        throw new Error(response.data.error || '连接设备失败')
      }
    } catch (err) {
      if (device) device.status = 'offline'
      // 连接失败，刷新设备列表获取最新状态
      await fetchDevices()
      throw err
    }
  }

  /**
   * 断开设备连接
   */
  async function disconnectDevice(id: string): Promise<void> {
    // 立即更新本地状态为 offline，优化 UI 响应速度
    const device = devices.value.find((d) => d.id === id)
    if (device) {
      device.status = 'offline'
    }

    // 如果是当前选中设备，立即断开全局连接状态
    if (currentDeviceId.value === id) {
      const connectionStore = useConnectionStore()
      connectionStore.setConnected(false)
    }

    try {
      const response = await deviceApi.disconnect(id)
      if (response.data.success && response.data.data) {
        const idx = devices.value.findIndex((d) => d.id === id)
        if (idx !== -1) {
          // 确保状态为 offline
          devices.value[idx] = { ...response.data.data, status: 'offline' }
        }
      } else {
        throw new Error(response.data.error || '断开连接失败')
      }
    } catch (err) {
      // 即使后端报错，前端也保持 offline 状态，因为用户意图是断开
      throw err
    }
  }

  return {
    // 状态
    devices,
    currentDeviceId,
    loading,
    // 计算属性
    currentDevice,
    onlineDevices,
    hasSelectedDevice,
    // 方法
    loadFromStorage,
    fetchDevices,
    selectDevice,
    addDevice,
    removeDevice,
    connectDevice,
    disconnectDevice,
    setDevice,
  }
})
