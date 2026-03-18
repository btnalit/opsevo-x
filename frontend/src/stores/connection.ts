import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface SnmpAuthConfig {
  version: 'v1' | 'v2c' | 'v3'
  community?: string
  securityLevel?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv'
  authProtocol?: 'MD5' | 'SHA'
  authPassword?: string
  privProtocol?: 'DES' | 'AES'
  privPassword?: string
}

export interface DeviceConnectionConfig {
  deviceId?: string
  name?: string
  host: string
  port: number
  /** Connection driver type. Defaults to 'api' for backward compatibility. */
  driverType?: 'api' | 'ssh' | 'snmp'
  username?: string
  password?: string
  useTLS?: boolean
  profileId?: string
  sshKeyPath?: string
  snmpConfig?: SnmpAuthConfig
}

export const useConnectionStore = defineStore('connection', () => {
  const isConnected = ref(false)
  const config = ref<DeviceConnectionConfig | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  function setConnected(connected: boolean) {
    isConnected.value = connected
  }

  function setConfig(newConfig: DeviceConnectionConfig | null) {
    config.value = newConfig
  }

  function setLoading(isLoading: boolean) {
    loading.value = isLoading
  }

  function setError(errorMessage: string | null) {
    error.value = errorMessage
  }

  return {
    isConnected,
    config,
    loading,
    error,
    setConnected,
    setConfig,
    setLoading,
    setError
  }
})
