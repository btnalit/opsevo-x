<template>
  <div class="system-config-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>系统配置</span>
            <span class="header-description">管理系统参数、环境变量与变更历史</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" @click="saveAllConfigs" :loading="saving">保存配置</el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- 参数配置 -->
      <el-tab-pane label="参数配置" name="params">
        <el-skeleton v-if="loading" :rows="5" animated />
        <el-empty v-else-if="!configItems.length" description="暂无配置项" />
        <el-table v-else :data="configItems" stripe>
          <el-table-column prop="key" label="配置项" min-width="200">
            <template #default="{ row }">
              <span class="config-key">{{ row.key }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="value" label="值" min-width="250">
            <template #default="{ row }">
              <el-input v-if="editingKey === row.key" v-model="row.value" size="small" @blur="editingKey = ''" @keyup.enter="editingKey = ''" />
              <span v-else class="config-value" @dblclick="editingKey = row.key">
                {{ row.sensitive ? maskValue(row.value) : row.value }}
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
          <el-table-column prop="source" label="来源" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.source === 'env' ? 'warning' : 'info'">{{ row.source || 'db' }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 环境变量 -->
      <el-tab-pane label="环境变量" name="env">
        <el-alert type="info" :closable="false" show-icon style="margin-bottom:16px">
          环境变量为只读，敏感值已脱敏显示。修改请更新 .env 文件或 Docker 配置。
        </el-alert>
        <el-table :data="envVars" stripe>
          <el-table-column prop="key" label="变量名" min-width="250">
            <template #default="{ row }">
              <code>{{ row.key }}</code>
            </template>
          </el-table-column>
          <el-table-column prop="value" label="值" min-width="300">
            <template #default="{ row }">
              <span class="env-value">{{ row.sensitive ? maskValue(row.value) : row.value }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 变更历史 -->
      <el-tab-pane label="变更历史" name="history">
        <el-skeleton v-if="historyLoading" :rows="5" animated />
        <el-empty v-else-if="!changeHistory.length" description="暂无变更记录" />
        <el-timeline v-else>
          <el-timeline-item v-for="change in changeHistory" :key="change.id" :timestamp="formatTime(change.timestamp)" placement="top">
            <el-card shadow="hover">
              <div class="change-detail">
                <el-tag size="small">{{ change.key }}</el-tag>
                <span class="change-actor">{{ change.actor || 'system' }}</span>
              </div>
              <div class="change-values">
                <span class="old-value">{{ change.oldValue }}</span>
                <el-icon><i-ep-right /></el-icon>
                <span class="new-value">{{ change.newValue }}</span>
              </div>
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

interface ConfigItem { key: string; value: string; description?: string; source?: string; sensitive?: boolean }
interface EnvVar { key: string; value: string; sensitive?: boolean }
interface ChangeRecord { id: string; key: string; oldValue: string; newValue: string; actor?: string; timestamp: string }

const activeTab = ref('params')
const loading = ref(false)
const saving = ref(false)
const historyLoading = ref(false)
const editingKey = ref('')
const configItems = ref<ConfigItem[]>([])
const envVars = ref<EnvVar[]>([])
const changeHistory = ref<ChangeRecord[]>([])

function formatTime(ts: string | number) { return ts ? new Date(ts).toLocaleString() : '-' }
function maskValue(val: string) {
  if (!val || val.length < 4) return '****'
  return val.substring(0, 2) + '****' + val.substring(val.length - 2)
}

async function loadConfigs() {
  loading.value = true
  try {
    const res = await api.get('/ai-ops/system/config')
    configItems.value = res.data.data?.configs || []
    envVars.value = res.data.data?.envVars || []
  } catch { ElMessage.error('加载配置失败') }
  finally { loading.value = false }
}

async function loadHistory() {
  historyLoading.value = true
  try {
    const res = await api.get('/ai-ops/system/config/history', { params: { limit: 50 } })
    changeHistory.value = res.data.data || []
  } catch { changeHistory.value = [] }
  finally { historyLoading.value = false }
}

async function saveAllConfigs() {
  saving.value = true
  try {
    const payload = configItems.value.filter(c => c.source !== 'env').reduce((acc, c) => ({ ...acc, [c.key]: c.value }), {})
    await api.put('/ai-ops/system/config', payload)
    ElMessage.success('配置已保存')
    loadHistory()
  } catch { ElMessage.error('保存失败') }
  finally { saving.value = false }
}

onMounted(() => { loadConfigs(); loadHistory() })
</script>

<style scoped>
.system-config-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.config-key { font-family: monospace; font-weight: 500; }
.config-value { cursor: pointer; }
.config-value:hover { color: var(--el-color-primary); }
.env-value { font-family: monospace; color: var(--el-text-color-secondary); }
.change-detail { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.change-actor { font-size: 12px; color: var(--el-text-color-secondary); }
.change-values { display: flex; align-items: center; gap: 8px; font-family: monospace; font-size: 13px; }
.old-value { color: var(--el-color-danger); text-decoration: line-through; }
.new-value { color: var(--el-color-success); }
</style>
