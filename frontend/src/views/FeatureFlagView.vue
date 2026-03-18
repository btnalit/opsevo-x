<template>
  <div class="feature-flag-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>特性标志管理</span>
            <span class="header-description">运行时切换功能模块，支持渐进式迁移</span>
          </div>
          <div class="header-actions">
            <el-button @click="loadFlags" :loading="loading">
              <el-icon><i-ep-refresh /></el-icon>
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <el-tab-pane label="标志列表" name="flags">
        <el-skeleton v-if="loading" :rows="5" animated />
        <el-empty v-else-if="!flags.length" description="暂无特性标志" />
        <el-table v-else :data="flags" stripe>
          <el-table-column prop="name" label="标志名称" min-width="220">
            <template #default="{ row }">
              <code class="flag-name">{{ row.name }}</code>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="250" show-overflow-tooltip />
          <el-table-column prop="enabled" label="状态" width="120">
            <template #default="{ row }">
              <el-switch v-model="row.enabled" :loading="row._toggling" @change="toggleFlag(row)" />
            </template>
          </el-table-column>
          <el-table-column prop="dependencies" label="依赖" width="200">
            <template #default="{ row }">
              <el-tag v-for="dep in (row.dependencies || [])" :key="dep" size="small" style="margin:2px"
                :type="isFlagEnabled(dep) ? 'success' : 'danger'">{{ dep }}</el-tag>
              <span v-if="!row.dependencies?.length" class="text-muted">无</span>
            </template>
          </el-table-column>
          <el-table-column prop="updatedAt" label="更新时间" width="180">
            <template #default="{ row }">{{ row.updatedAt ? formatTime(row.updatedAt) : '-' }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="变更历史" name="history">
        <el-skeleton v-if="historyLoading" :rows="5" animated />
        <el-empty v-else-if="!changeHistory.length" description="暂无变更记录" />
        <el-timeline v-else>
          <el-timeline-item v-for="change in changeHistory" :key="change.id"
            :timestamp="formatTime(change.timestamp)" placement="top"
            :type="change.newValue ? 'success' : 'danger'">
            <el-card shadow="hover">
              <code>{{ change.flagName }}</code>
              <el-tag :type="change.newValue ? 'success' : 'danger'" size="small" style="margin-left:8px">
                {{ change.newValue ? 'ON' : 'OFF' }}
              </el-tag>
              <span class="change-actor">by {{ change.actor || 'system' }}</span>
            </el-card>
          </el-timeline-item>
        </el-timeline>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/index'

interface FeatureFlag {
  name: string; description?: string; enabled: boolean
  dependencies?: string[]; updatedAt?: string; _toggling?: boolean
}
interface FlagChange {
  id: string; flagName: string; newValue: boolean; actor?: string; timestamp: string
}

const activeTab = ref('flags')
const loading = ref(false)
const historyLoading = ref(false)
const flags = ref<FeatureFlag[]>([])
const changeHistory = ref<FlagChange[]>([])

function formatTime(ts: string | number) { return ts ? new Date(ts).toLocaleString() : '-' }
function isFlagEnabled(name: string) { return flags.value.find(f => f.name === name)?.enabled || false }

async function loadFlags() {
  loading.value = true
  try {
    const res = await api.get('/ai-ops/feature-flags')
    flags.value = (res.data.data || []).map((f: FeatureFlag) => ({ ...f, _toggling: false }))
  } catch { ElMessage.error('加载特性标志失败') }
  finally { loading.value = false }
}

async function loadHistory() {
  historyLoading.value = true
  try {
    const res = await api.get('/ai-ops/feature-flags/history', { params: { limit: 50 } })
    changeHistory.value = res.data.data || []
  } catch { changeHistory.value = [] }
  finally { historyLoading.value = false }
}

async function toggleFlag(flag: FeatureFlag) {
  // Check dependencies
  if (flag.enabled && flag.dependencies?.length) {
    const unmet = flag.dependencies.filter(d => !isFlagEnabled(d))
    if (unmet.length) {
      ElMessage.warning(`依赖未满足: ${unmet.join(', ')} 需要先启用`)
      flag.enabled = false
      return
    }
  }
  flag._toggling = true
  try {
    await api.put(`/ai-ops/feature-flags/${flag.name}`, { enabled: flag.enabled })
    ElMessage.success(`${flag.name} 已${flag.enabled ? '启用' : '禁用'}`)
    loadHistory()
  } catch {
    flag.enabled = !flag.enabled
    ElMessage.error('切换失败')
  } finally { flag._toggling = false }
}

onMounted(() => { loadFlags(); loadHistory() })
</script>

<style scoped>
.feature-flag-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.flag-name { font-size: 13px; background: var(--el-fill-color-light); padding: 2px 6px; border-radius: 3px; }
.text-muted { color: var(--el-text-color-placeholder); }
.change-actor { margin-left: 12px; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
