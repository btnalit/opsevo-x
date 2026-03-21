<template>
  <div class="snapshots-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>配置快照管理</span>
          </div>
          <div class="header-actions">
            <el-button 
              v-if="selectedSnapshots.length === 2" 
              type="warning" 
              :icon="Switch" 
              @click="compareSelectedSnapshots"
            >
              对比
            </el-button>
            <el-button type="primary" :icon="Plus" :loading="creating" @click="createSnapshot">
              创建快照
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadSnapshots">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && snapshots.length === 0" :rows="5" animated />

    <!-- Error State -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button type="primary" size="small" @click="loadSnapshots">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-card v-else-if="snapshots.length === 0" shadow="hover">
      <el-empty description="暂无配置快照">
        <el-button type="primary" @click="createSnapshot">创建第一个快照</el-button>
      </el-empty>
    </el-card>

    <!-- Snapshots Table -->
    <el-card v-else shadow="hover">
      <el-table
        v-loading="loading"
        :data="snapshots"
        stripe
        style="width: 100%"
        @row-click="handleRowClick"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="55" />
        <el-table-column label="所属设备" width="140">
          <template #default="{ row }">
            <span v-if="getDeviceName(row.device_id)" class="device-name-tag">{{ getDeviceName(row.device_id) }}</span>
            <span v-else class="no-data">-</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">
            <div class="time-cell">
              <el-icon><i-ep-clock /></el-icon>
              <span>{{ formatTime(row.timestamp) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="trigger" label="触发方式" width="120">
          <template #default="{ row }">
            <el-tag :type="getTriggerType(row.trigger)" size="small">
              {{ getTriggerText(row.trigger) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="文件大小" width="120">
          <template #default="{ row }">
            {{ formatBytes(row.size) }}
          </template>
        </el-table-column>
        <el-table-column prop="checksum" label="校验值" min-width="200">
          <template #default="{ row }">
            <el-tooltip :content="row.checksum" placement="top">
              <code class="checksum-code">{{ truncateChecksum(row.checksum) }}</code>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="设备信息" min-width="180">
          <template #default="{ row }">
            <div v-if="row.metadata">
              <span v-if="row.metadata.routerModel">{{ row.metadata.routerModel }}</span>
              <span v-if="row.metadata.routerVersion" class="version-text">
                v{{ row.metadata.routerVersion }}
              </span>
            </div>
            <span v-else class="no-data">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click.stop="downloadSnapshot(row)">
              <el-icon><i-ep-download /></el-icon>
              下载
            </el-button>
            <el-button size="small" type="warning" link @click.stop="showRestoreConfirm(row)">
              <el-icon><i-ep-refresh-right /></el-icon>
              恢复
            </el-button>
            <el-popconfirm
              title="确定要删除此快照吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="deleteSnapshot(row)"
            >
              <template #reference>
                <el-button size="small" type="danger" link @click.stop>
                  <el-icon><i-ep-delete /></el-icon>
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>

      <!-- Pagination info -->
      <div class="table-footer">
        <span class="snapshot-count">共 {{ snapshots.length }} 个快照（最多保留 30 个）</span>
        <span v-if="selectedSnapshots.length > 0" class="selection-hint">
          已选择 {{ selectedSnapshots.length }} 个快照
          <span v-if="selectedSnapshots.length === 2">，可以进行对比</span>
          <span v-else-if="selectedSnapshots.length === 1">，再选择一个进行对比</span>
          <span v-else>，最多选择 2 个进行对比</span>
        </span>
      </div>
    </el-card>

    <!-- Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="快照详情"
      width="600px"
      destroy-on-close
    >
      <el-descriptions :column="2" border v-if="selectedSnapshot">
        <el-descriptions-item label="快照 ID" :span="2">
          <code>{{ selectedSnapshot.id }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="创建时间" :span="2">
          {{ formatTime(selectedSnapshot.timestamp) }}
        </el-descriptions-item>
        <el-descriptions-item label="触发方式">
          <el-tag :type="getTriggerType(selectedSnapshot.trigger)" size="small">
            {{ getTriggerText(selectedSnapshot.trigger) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="文件大小">
          {{ formatBytes(selectedSnapshot.size) }}
        </el-descriptions-item>
        <el-descriptions-item label="校验和 (SHA256)" :span="2">
          <code class="checksum-full">{{ selectedSnapshot.checksum }}</code>
        </el-descriptions-item>
        <el-descriptions-item label="设备型号" v-if="selectedSnapshot.metadata?.routerModel">
          {{ selectedSnapshot.metadata.routerModel }}
        </el-descriptions-item>
        <el-descriptions-item label="系统版本" v-if="selectedSnapshot.metadata?.routerVersion">
          {{ selectedSnapshot.metadata.routerVersion }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="downloadSnapshot(selectedSnapshot!)">
          <el-icon><i-ep-download /></el-icon>
          下载
        </el-button>
        <el-button type="warning" @click="showRestoreConfirm(selectedSnapshot!)">
          <el-icon><i-ep-refresh-right /></el-icon>
          恢复配置
        </el-button>
      </template>
    </el-dialog>

    <!-- Restore Confirmation Dialog -->
    <el-dialog
      v-model="restoreDialogVisible"
      title="确认恢复配置"
      width="500px"
      destroy-on-close
    >
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        class="restore-warning"
      >
        <template #title>
          <span class="warning-title">危险操作警告</span>
        </template>
        <template #default>
          <p>恢复配置将会覆盖当前设备的所有配置，此操作不可撤销！</p>
          <p>请确保您了解以下风险：</p>
          <ul>
            <li>当前配置将被完全替换</li>
            <li>可能导致网络连接中断</li>
            <li>建议在恢复前先创建当前配置的快照</li>
          </ul>
        </template>
      </el-alert>

      <div class="restore-info" v-if="snapshotToRestore">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="快照时间">
            {{ formatTime(snapshotToRestore.timestamp) }}
          </el-descriptions-item>
          <el-descriptions-item label="触发方式">
            {{ getTriggerText(snapshotToRestore.trigger) }}
          </el-descriptions-item>
          <el-descriptions-item label="文件大小">
            {{ formatBytes(snapshotToRestore.size) }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="confirm-input">
        <p>请输入 <code>RESTORE</code> 以确认恢复操作：</p>
        <el-input
          v-model="restoreConfirmText"
          placeholder="输入 RESTORE 确认"
          @keyup.enter="confirmRestore"
        />
      </div>

      <template #footer>
        <el-button @click="cancelRestore">取消</el-button>
        <el-button
          type="danger"
          :loading="restoring"
          :disabled="restoreConfirmText !== 'RESTORE'"
          @click="confirmRestore"
        >
          确认恢复
        </el-button>
      </template>
    </el-dialog>

    <!-- Compare Dialog -->
    <el-dialog
      v-model="compareDialogVisible"
      title="快照对比结果"
      width="800px"
      destroy-on-close
    >
      <div v-if="snapshotDiff" class="diff-content">
        <!-- AI Analysis -->
        <div v-if="snapshotDiff.aiAnalysis" class="ai-analysis-section">
          <el-alert
            :type="getRiskAlertType(snapshotDiff.aiAnalysis.riskLevel)"
            :closable="false"
            show-icon
          >
            <template #title>
              <span class="risk-title">风险级别: {{ getRiskText(snapshotDiff.aiAnalysis.riskLevel) }}</span>
            </template>
            <template #default>
              <p>{{ snapshotDiff.aiAnalysis.summary }}</p>
              <div v-if="snapshotDiff.aiAnalysis.recommendations.length > 0" class="recommendations">
                <strong>建议:</strong>
                <ul>
                  <li v-for="(rec, index) in snapshotDiff.aiAnalysis.recommendations" :key="index">
                    {{ rec }}
                  </li>
                </ul>
              </div>
            </template>
          </el-alert>
        </div>

        <!-- Diff Statistics -->
        <el-row :gutter="20" class="diff-stats">
          <el-col :span="8">
            <el-statistic title="新增配置" :value="snapshotDiff.additions.length">
              <template #suffix>
                <el-tag type="success" size="small">+</el-tag>
              </template>
            </el-statistic>
          </el-col>
          <el-col :span="8">
            <el-statistic title="修改配置" :value="snapshotDiff.modifications.length">
              <template #suffix>
                <el-tag type="warning" size="small">~</el-tag>
              </template>
            </el-statistic>
          </el-col>
          <el-col :span="8">
            <el-statistic title="删除配置" :value="snapshotDiff.deletions.length">
              <template #suffix>
                <el-tag type="danger" size="small">-</el-tag>
              </template>
            </el-statistic>
          </el-col>
        </el-row>

        <!-- Additions -->
        <div v-if="snapshotDiff.additions.length > 0" class="diff-section">
          <h4 class="diff-section-title">
            <el-tag type="success" size="small">+</el-tag>
            新增配置 ({{ snapshotDiff.additions.length }})
          </h4>
          <pre class="diff-code additions">{{ snapshotDiff.additions.join('\n') }}</pre>
        </div>

        <!-- Modifications -->
        <div v-if="snapshotDiff.modifications.length > 0" class="diff-section">
          <h4 class="diff-section-title">
            <el-tag type="warning" size="small">~</el-tag>
            修改配置 ({{ snapshotDiff.modifications.length }})
          </h4>
          <div v-for="(mod, index) in snapshotDiff.modifications" :key="index" class="modification-item">
            <div class="mod-path">{{ mod.path }}</div>
            <div class="mod-old">- {{ mod.oldValue }}</div>
            <div class="mod-new">+ {{ mod.newValue }}</div>
          </div>
        </div>

        <!-- Deletions -->
        <div v-if="snapshotDiff.deletions.length > 0" class="diff-section">
          <h4 class="diff-section-title">
            <el-tag type="danger" size="small">-</el-tag>
            删除配置 ({{ snapshotDiff.deletions.length }})
          </h4>
          <pre class="diff-code deletions">{{ snapshotDiff.deletions.join('\n') }}</pre>
        </div>

        <!-- No Changes -->
        <el-empty 
          v-if="snapshotDiff.additions.length === 0 && snapshotDiff.modifications.length === 0 && snapshotDiff.deletions.length === 0"
          description="两个快照配置完全相同"
        />
      </div>

      <template #footer>
        <el-button @click="compareDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Switch, Plus, Refresh } from '@element-plus/icons-vue'

import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  snapshotsApi,
  type ConfigSnapshot,
  type SnapshotTrigger,
  type SnapshotDiff
} from '@/api/ai-ops'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'

// State
const deviceStore = useDeviceStore()
const { currentDeviceId, devices } = storeToRefs(deviceStore)

// 设备名称映射
const getDeviceName = (deviceId?: string) => {
  if (!deviceId) return ''
  return devices.value.find(d => d.id === deviceId)?.name || ''
}
const loading = ref(false)
const creating = ref(false)
const restoring = ref(false)
const comparing = ref(false)
const error = ref('')
const snapshots = ref<ConfigSnapshot[]>([])
const selectedSnapshots = ref<ConfigSnapshot[]>([])
const detailVisible = ref(false)
const restoreDialogVisible = ref(false)
const compareDialogVisible = ref(false)
const selectedSnapshot = ref<ConfigSnapshot | null>(null)
const snapshotToRestore = ref<ConfigSnapshot | null>(null)
const restoreConfirmText = ref('')
const snapshotDiff = ref<SnapshotDiff | null>(null)

// Load data on mount
onMounted(() => {
  loadSnapshots()
})

// Watch device changes
import { watch } from 'vue'
watch(currentDeviceId, () => {
  loadSnapshots()
})

// Load snapshots
const loadSnapshots = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await snapshotsApi.getAll(undefined, currentDeviceId.value)
    if (response.data.success && response.data.data) {
      snapshots.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取快照列表失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取快照列表失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Create snapshot
const createSnapshot = async () => {
  creating.value = true

  try {
    const response = await snapshotsApi.create(currentDeviceId.value)
    if (response.data.success && response.data.data) {
      ElMessage.success('快照创建成功')
      await loadSnapshots()
    } else {
      throw new Error(response.data.error || '创建快照失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建快照失败'
    ElMessage.error(message)
  } finally {
    creating.value = false
  }
}

// Download snapshot
const downloadSnapshot = async (snapshot: ConfigSnapshot) => {
  try {
    ElMessage.info('正在下载快照...')
    const blob = await snapshotsApi.download(snapshot.id)
    
    // Create download link
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `config-${formatFileName(snapshot.timestamp)}.rsc`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
    
    ElMessage.success('快照下载成功')
    detailVisible.value = false
  } catch (err) {
    const message = err instanceof Error ? err.message : '下载快照失败'
    ElMessage.error(message)
  }
}

// Show restore confirmation dialog
const showRestoreConfirm = (snapshot: ConfigSnapshot) => {
  snapshotToRestore.value = snapshot
  restoreConfirmText.value = ''
  restoreDialogVisible.value = true
  detailVisible.value = false
}

// Cancel restore
const cancelRestore = () => {
  restoreDialogVisible.value = false
  snapshotToRestore.value = null
  restoreConfirmText.value = ''
}

// Confirm restore
const confirmRestore = async () => {
  if (!snapshotToRestore.value || restoreConfirmText.value !== 'RESTORE') {
    return
  }

  restoring.value = true

  try {
    const response = await snapshotsApi.restore(snapshotToRestore.value.id)
    if (response.data.success && response.data.data) {
      if (response.data.data.success) {
        ElMessage.success('配置恢复成功')
      } else {
        ElMessage.warning(response.data.data.message || '配置恢复完成，但可能存在问题')
      }
    } else {
      throw new Error(response.data.error || '恢复配置失败')
    }
    restoreDialogVisible.value = false
    snapshotToRestore.value = null
    restoreConfirmText.value = ''
  } catch (err) {
    const message = err instanceof Error ? err.message : '恢复配置失败'
    ElMessage.error(message)
  } finally {
    restoring.value = false
  }
}

// Delete snapshot
const deleteSnapshot = async (snapshot: ConfigSnapshot) => {
  try {
    await snapshotsApi.delete(snapshot.id)
    ElMessage.success('快照已删除')
    await loadSnapshots()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除快照失败'
    ElMessage.error(message)
  }
}

// Handle row click
const handleRowClick = (row: ConfigSnapshot) => {
  selectedSnapshot.value = row
  detailVisible.value = true
}

// Handle selection change
const handleSelectionChange = (selection: ConfigSnapshot[]) => {
  selectedSnapshots.value = selection
}

// Compare selected snapshots
const compareSelectedSnapshots = async () => {
  if (selectedSnapshots.value.length !== 2) {
    ElMessage.warning('请选择两个快照进行对比')
    return
  }

  comparing.value = true
  try {
    // Sort by timestamp to ensure older snapshot is first
    const sorted = [...selectedSnapshots.value].sort((a, b) => a.timestamp - b.timestamp)
    const response = await snapshotsApi.compare(sorted[0].id, sorted[1].id)
    if (response.data.success && response.data.data) {
      snapshotDiff.value = response.data.data
      compareDialogVisible.value = true
    } else {
      throw new Error(response.data.error || '对比快照失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '对比快照失败'
    ElMessage.error(message)
  } finally {
    comparing.value = false
  }
}

// Utility functions
const getTriggerType = (trigger: SnapshotTrigger): 'success' | 'primary' | 'warning' => {
  const types: Record<SnapshotTrigger, 'success' | 'primary' | 'warning'> = {
    manual: 'primary',
    auto: 'success',
    'pre-remediation': 'warning'
  }
  return types[trigger] || 'primary'
}

const getTriggerText = (trigger: SnapshotTrigger): string => {
  const texts: Record<SnapshotTrigger, string> = {
    manual: '手动创建',
    auto: '自动备份',
    'pre-remediation': '修复前备份'
  }
  return texts[trigger] || trigger
}

const formatTime = (timestamp: number): string => {
  if (!timestamp || timestamp <= 0) {
    return '未知'
  }
  try {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) {
      return '未知'
    }
    return date.toLocaleString('zh-CN')
  } catch {
    return '未知'
  }
}

const formatFileName = (timestamp: number): string => {
  if (!timestamp || timestamp <= 0) {
    return 'unknown'
  }
  const date = new Date(timestamp)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const truncateChecksum = (checksum: string): string => {
  if (checksum.length <= 16) return checksum
  return `${checksum.slice(0, 8)}...${checksum.slice(-8)}`
}

const getRiskAlertType = (riskLevel: string): 'success' | 'warning' | 'error' => {
  const types: Record<string, 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error'
  }
  return types[riskLevel] || 'warning'
}

const getRiskText = (riskLevel: string): string => {
  const texts: Record<string, string> = {
    low: '低风险',
    medium: '中等风险',
    high: '高风险'
  }
  return texts[riskLevel] || riskLevel
}
</script>

<style scoped>
.snapshots-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

.header-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Table */
.time-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.checksum-code {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  padding: 2px 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  color: var(--el-text-color-regular);
}

.checksum-full {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 11px;
  word-break: break-all;
  color: var(--el-text-color-regular);
}

.version-text {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.no-data {
  color: var(--el-text-color-secondary);
}

.table-footer {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.snapshot-count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.selection-hint {
  font-size: 13px;
  color: var(--el-color-primary);
}

/* Diff Dialog Styles */
.diff-content {
  max-height: 60vh;
  overflow-y: auto;
}

.ai-analysis-section {
  margin-bottom: 20px;
}

.risk-title {
  font-weight: 600;
}

.recommendations {
  margin-top: 8px;
}

.recommendations ul {
  margin: 4px 0 0 0;
  padding-left: 20px;
}

.diff-stats {
  margin-bottom: 20px;
  text-align: center;
}

.diff-section {
  margin-bottom: 16px;
}

.diff-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.diff-code {
  margin: 0;
  padding: 12px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.diff-code.additions {
  background: var(--el-color-success-light-9);
  border: 1px solid var(--el-color-success-light-7);
  color: var(--el-color-success);
}

.diff-code.deletions {
  background: var(--el-color-danger-light-9);
  border: 1px solid var(--el-color-danger-light-7);
  color: var(--el-color-danger);
}

.modification-item {
  margin-bottom: 12px;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
}

.mod-path {
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.mod-old {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  padding: 2px 4px;
  border-radius: 2px;
  margin-bottom: 2px;
}

.mod-new {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
  padding: 2px 4px;
  border-radius: 2px;
}

/* Restore Dialog */
.restore-warning {
  margin-bottom: 20px;
}

.warning-title {
  font-weight: 600;
}

.restore-warning ul {
  margin: 8px 0 0 0;
  padding-left: 20px;
}

.restore-warning li {
  margin: 4px 0;
}

.restore-info {
  margin-bottom: 20px;
}

.confirm-input {
  margin-top: 20px;
}

.confirm-input p {
  margin-bottom: 8px;
  color: var(--el-text-color-regular);
}

.confirm-input code {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  padding: 2px 6px;
  background: var(--el-color-danger);
  color: var(--el-color-white);
  border-radius: 4px;
}

/* Responsive */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    gap: 12px;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
