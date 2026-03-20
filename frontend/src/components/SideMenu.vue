<template>
  <el-menu
    :default-active="activeMenu"
    class="side-menu"
    :collapse="collapsed"
    :router="true"
    background-color="var(--el-menu-bg-color)"
    text-color="var(--el-text-color-regular)"
    active-text-color="var(--el-color-primary)"
  >
    <div class="menu-header">
      <el-icon :size="24" color="var(--el-color-primary)">
        <i-ep-cpu />
      </el-icon>
      <span v-if="!collapsed" class="menu-title">OPSEVO</span>
    </div>

    <el-sub-menu index="device-mgmt">
      <template #title>
        <el-icon><i-ep-monitor /></el-icon>
        <span>设备管理</span>
      </template>
      <el-menu-item index="/devices">设备列表</el-menu-item>
      <el-menu-item index="/devices/drivers">驱动管理</el-menu-item>
      <el-menu-item index="/devices/profiles">Profile 管理</el-menu-item>
    </el-sub-menu>

    <template v-if="shouldShowMenus">
      <el-menu-item index="/ai-ops">
        <el-icon><i-ep-odometer /></el-icon>
        <template #title>运维仪表盘</template>
      </el-menu-item>
      
      <el-menu-item index="/ai-ops/cockpit">
        <el-icon><i-ep-view /></el-icon>
        <template #title>全息思维座舱</template>
      </el-menu-item>

      <el-sub-menu index="ai-ops">
        <template #title>
          <el-icon><i-ep-data-analysis /></el-icon>
          <span>智能运维</span>
        </template>
        <el-sub-menu index="ai-agent">
          <template #title>AI Agent</template>
          <el-menu-item index="/ai/unified">统一 AI Agent</el-menu-item>
          <el-menu-item index="/ai/config">服务配置</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-alerts">
          <template #title>告警管理</template>
          <el-menu-item index="/ai-ops/alerts">告警事件</el-menu-item>
          <el-menu-item index="/ai-ops/alerts/rules">告警规则</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-filters">
          <template #title>过滤管理</template>
          <el-menu-item index="/ai-ops/maintenance">维护窗口</el-menu-item>
          <el-menu-item index="/ai-ops/known-issues">已知问题</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-scheduler">
          <template #title>定时任务</template>
          <el-menu-item index="/ai-ops/scheduler">任务管理</el-menu-item>
          <el-menu-item index="/ai-ops/reports">健康报告</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-config">
          <template #title>配置管理</template>
          <el-menu-item index="/ai-ops/snapshots">配置快照</el-menu-item>
          <el-menu-item index="/ai-ops/changes">配置变更</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-fault">
          <template #title>故障自愈</template>
          <el-menu-item index="/ai-ops/patterns">故障模式</el-menu-item>
          <el-menu-item index="/ai-ops/decisions">决策规则</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-rag">
          <template #title>RAG 知识库</template>
          <el-menu-item index="/ai-ops/knowledge">知识库管理</el-menu-item>
          <el-menu-item index="/ai-ops/skills">Skill 管理</el-menu-item>
          <el-menu-item index="/ai-ops/templates">Prompt 模板</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-perception">
          <template #title>感知源管理</template>
          <el-menu-item index="/ai-ops/syslog">Syslog 管理</el-menu-item>
          <el-menu-item index="/ai-ops/snmp-trap">SNMP Trap</el-menu-item>
          <el-menu-item index="/ai-ops/perception">感知源总览</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-evolution">
          <template #title>智能进化</template>
          <el-menu-item index="/ai-ops/evolution">进化配置</el-menu-item>
          <el-menu-item index="/ai-ops/health">健康监控</el-menu-item>
          <el-menu-item index="/ai-ops/anomaly">异常预测</el-menu-item>
        </el-sub-menu>
        <el-sub-menu index="ai-ops-system">
          <template #title>系统设置</template>
          <el-menu-item index="/ai-ops/channels">通知渠道</el-menu-item>
          <el-menu-item index="/ai-ops/audit">审计日志</el-menu-item>
        </el-sub-menu>
      </el-sub-menu>

      <el-menu-item index="/about">
        <el-icon><i-ep-info-filled /></el-icon>
        <template #title>关于 OPSEVO</template>
      </el-menu-item>
    </template>
  </el-menu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

defineProps<{
  collapsed?: boolean
}>()

const route = useRoute()

const activeMenu = computed(() => route.path)
const shouldShowMenus = computed(() => {
  // Always show menus — AI-ops/cockpit are global and don't require a device
  // Only hide when explicitly on the device list page for a cleaner focus
  if (route.path === '/devices') return false
  return true
})
</script>

<style scoped>
.side-menu {
  height: 100%;
  border-right: none;
}

.side-menu:not(.el-menu--collapse) {
  width: 220px;
}

.menu-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.menu-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}

:deep(.el-menu-item),
:deep(.el-sub-menu__title) {
  height: 50px;
  line-height: 50px;
}

:deep(.el-menu-item.is-active) {
  background-color: var(--el-fill-color) !important;
}

:deep(.el-menu-item:hover),
:deep(.el-sub-menu__title:hover) {
  background-color: var(--el-fill-color-light) !important;
}

/* Fix menu item group title color in dark background */
:deep(.el-menu-item-group__title) {
  color: var(--el-text-color-secondary) !important;
  font-size: 13px;
  font-weight: 500;
  padding-left: 20px !important;
  padding-top: 8px;
  padding-bottom: 4px;
}

:deep(.el-menu-item-group .el-menu-item) {
  padding-left: 45px !important;
}
</style>
