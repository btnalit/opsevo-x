import api from './index'
import type { DeviceConnectionConfig } from '@/stores/connection'

export type { DeviceConnectionConfig }

/** @deprecated Use DeviceConnectionConfig instead */
export type RouterOSConfig = DeviceConnectionConfig

export const connectionApi = {
    getStatus: () => api.get('/connection/status'),
    connect: (config: DeviceConnectionConfig) => api.post('/connection/connect', config),
    disconnect: () => api.post('/connection/disconnect'),
    getConfig: () => api.get('/connection/config'),
    saveConfig: (config: DeviceConnectionConfig) => api.post('/connection/config', config)
}
