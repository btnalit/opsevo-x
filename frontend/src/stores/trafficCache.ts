import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface TrafficDataPoint {
  time: string
  rx: number
  tx: number
}

export interface InterfaceBytesSnapshot {
  rx: number
  tx: number
  timestamp: number
}

// Cache configuration
const MAX_HISTORY_POINTS = 120 // Maximum data points per interface (1 hour = 120 × 30s)
const MAX_INTERFACES = 20 // Maximum interfaces to cache
const CACHE_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes cache expiry
const MAX_TIME_DIFF_SECONDS = 90 // Maximum time diff for rate calculation

export const useTrafficCacheStore = defineStore('trafficCache', () => {
  // Traffic history for each interface (keyed by interface name)
  const trafficHistoryMap = ref<Map<string, TrafficDataPoint[]>>(new Map())
  
  // Previous bytes snapshot for rate calculation (keyed by interface name)
  const previousBytesMap = ref<Map<string, InterfaceBytesSnapshot>>(new Map())
  
  // Last update timestamp
  const lastUpdateTime = ref<number>(0)

  // Get traffic history for a specific interface
  const getTrafficHistory = (interfaceName: string): TrafficDataPoint[] => {
    return trafficHistoryMap.value.get(interfaceName) || []
  }

  // Check if cache is valid (not expired)
  const isCacheValid = computed(() => {
    if (lastUpdateTime.value === 0) return false
    return Date.now() - lastUpdateTime.value < CACHE_EXPIRY_MS
  })

  // Check if we have any cached data
  const hasCachedData = computed(() => {
    return trafficHistoryMap.value.size > 0
  })

  // Update traffic data for all interfaces
  function updateAllInterfacesTraffic(interfaces: Array<{ name: string; rxBytes: number; txBytes: number }>) {
    const now = Date.now()
    const timeStr = new Date(now).toLocaleTimeString('zh-CN', { hour12: false })

    // Limit number of cached interfaces
    if (trafficHistoryMap.value.size > MAX_INTERFACES) {
      // Remove oldest interfaces (those not in current list)
      const currentNames = new Set(interfaces.map(i => i.name))
      for (const [name] of trafficHistoryMap.value) {
        if (!currentNames.has(name)) {
          trafficHistoryMap.value.delete(name)
          previousBytesMap.value.delete(name)
        }
      }
    }

    // Process each interface
    for (const iface of interfaces) {
      const ifaceName = iface.name
      const prevBytes = previousBytesMap.value.get(ifaceName)

      // Get or create history array for this interface
      let history = trafficHistoryMap.value.get(ifaceName)
      if (!history) {
        history = []
        trafficHistoryMap.value.set(ifaceName, history)
      }

      // Calculate rate (bytes per second) from difference
      if (prevBytes) {
        const timeDiff = (now - prevBytes.timestamp) / 1000 // seconds
        if (timeDiff > 0 && timeDiff < MAX_TIME_DIFF_SECONDS) {
          // Check for counter reset (new value smaller than previous)
          const rxDiff = iface.rxBytes - prevBytes.rx
          const txDiff = iface.txBytes - prevBytes.tx
          
          let rxRate = 0
          let txRate = 0
          
          if (rxDiff >= 0 && txDiff >= 0) {
            // Normal case: calculate rate
            rxRate = rxDiff / timeDiff
            txRate = txDiff / timeDiff
          } else {
            // Counter reset detected: use previous value if available
            const lastPoint = history.length > 0 ? history[history.length - 1] : null
            if (lastPoint) {
              rxRate = lastPoint.rx
              txRate = lastPoint.tx
            }
          }

          history.push({
            time: timeStr,
            rx: rxRate,
            tx: txRate
          })

          // Keep only last N data points (cache size control)
          while (history.length > MAX_HISTORY_POINTS) {
            history.shift()
          }
        }
      }

      // Store current bytes for next calculation
      previousBytesMap.value.set(ifaceName, {
        rx: iface.rxBytes,
        tx: iface.txBytes,
        timestamp: now
      })
    }

    // Update last update time
    lastUpdateTime.value = now

    // Trigger reactivity
    trafficHistoryMap.value = new Map(trafficHistoryMap.value)
  }

  // Clear cache for a specific interface
  function clearInterfaceCache(interfaceName: string) {
    trafficHistoryMap.value.delete(interfaceName)
    previousBytesMap.value.delete(interfaceName)
    trafficHistoryMap.value = new Map(trafficHistoryMap.value)
  }

  // Clear all cache
  function clearAllCache() {
    trafficHistoryMap.value.clear()
    previousBytesMap.value.clear()
    lastUpdateTime.value = 0
  }

  // Get cache statistics
  const cacheStats = computed(() => ({
    interfaceCount: trafficHistoryMap.value.size,
    totalDataPoints: Array.from(trafficHistoryMap.value.values()).reduce((sum, arr) => sum + arr.length, 0),
    lastUpdate: lastUpdateTime.value,
    isValid: isCacheValid.value
  }))

  return {
    trafficHistoryMap,
    previousBytesMap,
    lastUpdateTime,
    isCacheValid,
    hasCachedData,
    cacheStats,
    getTrafficHistory,
    updateAllInterfacesTraffic,
    clearInterfaceCache,
    clearAllCache
  }
})
