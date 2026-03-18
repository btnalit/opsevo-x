/**
 * Evolution Store - 智能进化系统状态管理
 * 
 * 使用 Pinia 管理进化配置和健康状态的缓存
 * Requirements: evolution-frontend 10.1-10.4
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  evolutionConfigApi,
  healthApi,
  type AIEvolutionConfig,
  type HealthStatus
} from '@/api/evolution'

const CACHE_TTL = 30 * 1000 // 30 秒缓存有效期

export const useEvolutionStore = defineStore('evolution', () => {
  // ==================== 状态 ====================

  // 进化配置状态
  const config = ref<AIEvolutionConfig | null>(null)
  const configLastFetch = ref<number>(0)
  const configLoading = ref(false)
  const configError = ref<string>('')

  // 健康状态
  const healthStatus = ref<HealthStatus | null>(null)
  const healthLastFetch = ref<number>(0)
  const healthLoading = ref(false)
  const healthError = ref<string>('')

  // ==================== 计算属性 ====================

  const isConfigStale = computed(() =>
    Date.now() - configLastFetch.value > CACHE_TTL
  )

  const isHealthStale = computed(() =>
    Date.now() - healthLastFetch.value > CACHE_TTL
  )

  // ==================== 方法 ====================

  /**
   * 获取进化配置
   * @param force 是否强制刷新
   */
  async function fetchConfig(force = false): Promise<AIEvolutionConfig | null> {
    if (!force && !isConfigStale.value && config.value) {
      return config.value
    }

    configLoading.value = true
    configError.value = ''

    try {
      const MAX_RETRIES = 2
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await evolutionConfigApi.getConfig()
          if (response.data.success && response.data.data) {
            config.value = response.data.data
            configLastFetch.value = Date.now()
            lastError = null
            break
          }

          throw new Error(response.data.error || '获取配置失败')
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('未知错误')
          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
          }
        }
      }

      if (lastError) {
        configError.value = lastError.message
        throw lastError
      }

      return config.value
    } finally {
      configLoading.value = false
    }
  }

  /**
   * 获取健康状态
   * @param force 是否强制刷新
   * @param deviceId 设备 ID
   */
  async function fetchHealthStatus(force = false, deviceId?: string): Promise<HealthStatus | null> {
    if (!force && !isHealthStale.value && healthStatus.value) {
      return healthStatus.value
    }

    healthLoading.value = true
    healthError.value = ''

    try {
      const response = await healthApi.getCurrent(deviceId)
      if (response.data.success && response.data.data) {
        healthStatus.value = response.data.data
        healthLastFetch.value = Date.now()
      } else {
        throw new Error(response.data.error || '获取健康状态失败')
      }
    } catch (error) {
      healthError.value = error instanceof Error ? error.message : '未知错误'
      throw error
    } finally {
      healthLoading.value = false
    }

    return healthStatus.value
  }

  /**
   * 使配置缓存失效
   */
  function invalidateConfig(): void {
    configLastFetch.value = 0
  }

  /**
   * 使健康状态缓存失效
   */
  function invalidateHealth(): void {
    healthLastFetch.value = 0
  }

  /**
   * 重置所有状态
   */
  function reset(): void {
    config.value = null
    configLastFetch.value = 0
    configLoading.value = false
    configError.value = ''
    healthStatus.value = null
    healthLastFetch.value = 0
    healthLoading.value = false
    healthError.value = ''
  }

  return {
    // 状态
    config,
    configLoading,
    configError,
    healthStatus,
    healthLoading,
    healthError,
    // 计算属性
    isConfigStale,
    isHealthStale,
    // 方法
    fetchConfig,
    fetchHealthStatus,
    invalidateConfig,
    invalidateHealth,
    reset,
  }
})
