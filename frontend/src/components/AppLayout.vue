<template>
  <el-container class="app-layout">
    <el-aside :width="menuCollapsed ? '64px' : '220px'" class="app-aside">
      <SideMenu :collapsed="menuCollapsed" />
    </el-aside>

    <el-container class="main-container">
      <el-header class="app-header">
        <div class="header-left">
          <el-button
            :icon="menuCollapsed ? Expand : Fold"
            circle
            @click="toggleMenu"
          />
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-for="item in breadcrumbs" :key="item.path">
              {{ item.title }}
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <DeviceSelector v-if="authStore.isAuthenticated" />
          <ConnectionStatus />
          <el-button
            v-if="authStore.isAuthenticated"
            type="danger"
            text
            @click="handleLogout"
          >
            <el-icon><SwitchButton /></el-icon>
            退出
          </el-button>
        </div>
      </el-header>

      <!-- System Degradation Warning Banner -->
      <transition name="el-zoom-in-top">
        <el-alert
          v-if="degradationLevel === 'moderate' || degradationLevel === 'severe'"
          :title="degradationBannerTitle"
          :type="degradationLevel === 'severe' ? 'error' : 'warning'"
          show-icon
          :closable="false"
          class="degradation-banner"
        >
          <template #default>
            <div class="degradation-desc">
              系统当前负载过高，已自动开启降级保护机制。AI 的深度反思推理与拓扑学习功能暂受限制，当前以最快响应模式运行。
              <span v-if="degradationReason" class="degradation-reason">(原因: {{ degradationReason }})</span>
            </div>
          </template>
        </el-alert>
      </transition>

      <el-main class="app-main">
        <router-view v-slot="{ Component }">
          <transition name="fade">
            <Suspense>
              <template #default>
                <!-- Keep state for common management views to prevent flashes on menu switch -->
                <keep-alive :include="['UnifiedAIView', 'AIOpsView', 'KnowledgeBaseView', 'AlertEventsView', 'CognitiveCockpitView', 'EvolutionConfigView']">
                  <component :is="Component" :key="deviceStore.currentDeviceId + route.path" />
                </keep-alive>
              </template>
              <template #fallback>
                <div class="loading-container">
                  <el-skeleton :rows="5" animated />
                </div>
              </template>
            </Suspense>
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { Fold, Expand, SwitchButton } from '@element-plus/icons-vue'
import SideMenu from './SideMenu.vue'
import ConnectionStatus from './ConnectionStatus.vue'
import DeviceSelector from './DeviceSelector.vue'
import { connectionApi } from '@/api/connection'
import { deviceApi } from '@/api/device'
import { aiOpsApi } from '@/api/ai-ops'
import { useConnectionStore } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import { useDeviceStore } from '@/stores/device'

const menuCollapsed = ref(false)
const route = useRoute()
const connectionStore = useConnectionStore()
const authStore = useAuthStore()
const deviceStore = useDeviceStore()

let statusCheckInterval: ReturnType<typeof setInterval> | null = null

const toggleMenu = () => {
  menuCollapsed.value = !menuCollapsed.value
}

const handleLogout = () => {
  authStore.logout()
}

const checkConnectionStatus = async () => {
  if (deviceStore.currentDeviceId) {
    // 多设备模式：检查当前选中设备的状态
    try {
      const response = await deviceApi.get(deviceStore.currentDeviceId)
      const result = response.data
      if (result.success && result.data) {
        const isConnected = result.data.status === 'online'
        connectionStore.setConnected(isConnected)
        if (isConnected) {
          connectionStore.setConfig({
            host: result.data.host,
            port: result.data.port,
            username: result.data.username,
            password: '',
            useTLS: result.data.use_tls === 1,
          })
          // Sync device info to store to ensure currentDevice is valid
          deviceStore.setDevice(result.data)
        }
      } else {
        connectionStore.setConnected(false)
      }
    } catch {
      // Don't set disconnected on network errors - might be temporary
    }
  } else {
    // 回退到单设备模式
    try {
      const response = await connectionApi.getStatus()
      const result = response.data
      if (result.success && result.data) {
        connectionStore.setConnected(result.data.connected)
        if (result.data.connected && result.data.config) {
          connectionStore.setConfig(result.data.config)
        }
      } else {
        connectionStore.setConnected(false)
      }
    } catch {
      // Don't set disconnected on network errors - might be temporary
    }
  }
}

// 智能进化状态检查 (用于全局降级提示)
const degradationLevel = ref<'none' | 'moderate' | 'severe'>('none')
const degradationReason = ref('')

const degradationBannerTitle = computed(() => {
  if (degradationLevel.value === 'severe') return '⚠️ 系统极度压力降级'
  if (degradationLevel.value === 'moderate') return '⚠️ 系统轻度性能降级'
  return ''
})

const checkEvolutionStatus = async () => {
  try {
    const response = await aiOpsApi.evolution.getStatus()
    if (response.data.success && response.data.data) {
      const { systemLoad } = response.data.data
      if (systemLoad) {
        degradationLevel.value = systemLoad.currentDegradationLevel || 'none'
        degradationReason.value = systemLoad.primaryBottleneck || ''
      }
    }
  } catch (error) {
    // 忽略此类后台轮询错误
  }
}

// 设备切换时立即刷新状态
watch(() => deviceStore.currentDeviceId, () => {
  checkConnectionStatus()
})

onMounted(() => {
  // Initial check
  checkConnectionStatus()
  checkEvolutionStatus()
  // Check every 30 seconds
  statusCheckInterval = setInterval(() => {
    checkConnectionStatus()
    checkEvolutionStatus()
  }, 30000)
})

onUnmounted(() => {
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval)
    statusCheckInterval = null
  }
})

interface BreadcrumbItem {
  path: string
  title: string
}

const routeTitles: Record<string, string> = {
  '/system/scheduler': '计划任务'
}

const breadcrumbs = computed<BreadcrumbItem[]>(() => {
  const path = route.path
  const title = routeTitles[path]
  if (title) {
    return [{ path, title }]
  }
  return []
})
</script>

<style scoped>
.app-layout {
  height: 100vh;
  overflow: hidden;
}

.app-aside {
  background-color: var(--ai-sidebar-bg);
  transition: width 0.3s ease;
  overflow-x: hidden;
  overflow-y: auto;
  position: relative;
  z-index: 20;
}

/* 自定义侧边栏滚动条样式 */
.app-aside::-webkit-scrollbar {
  width: 6px;
}

.app-aside::-webkit-scrollbar-track {
  background: var(--ai-sidebar-bg);
}

.app-aside::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.app-aside::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}

.main-container {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background-color: var(--el-bg-color-overlay);
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-main {
  flex: 1;
  overflow: auto;
  background-color: var(--el-bg-color);
  padding: 20px;
  /* 确保子组件 height: 100% 能正确引用内容区域 */
  min-height: 0;
}

/* Transition animations - only animate enter, skip leave to prevent white flash */
.fade-enter-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from {
  opacity: 0;
}

/* Leave transition is instant to avoid white flash on dark theme */
.fade-leave-active {
  display: none;
}

.loading-container {
  padding: 20px;
  background: var(--el-bg-color-overlay);
  border-radius: 8px;
}

.degradation-banner {
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-top: none;
  z-index: 9;
}

.degradation-desc {
  font-size: 13px;
  margin-top: 4px;
}

.degradation-reason {
  font-weight: bold;
  margin-left: 8px;
}
</style>
