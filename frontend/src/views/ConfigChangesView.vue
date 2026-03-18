<template>
  <div class="config-changes-view">
    <!-- Header -->
    <el-card class="header-card">
      <div class="card-header">
        <div class="header-left">
          <span>配置变更审计</span>
        </div>
        <div class="header-actions">
          <el-button :icon="Refresh" :loading="loading" @click="loadTimeline">
            刷新
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && timeline.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="loadTimeline">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <el-row :gutter="20" v-else>
      <!-- Timeline Column -->
      <el-col :xs="24" :md="10" :lg="8">
        <el-card shadow="hover" class="timeline-card">
          <template #header>
            <div class="card-header">
              <div class="header-left">
                <span>变更时间线</span>
              </div>
            </div>
          </template>

          <el-empty v-if="timeline.length === 0" description="暂无配置变更记录" />

          <el-timeline v-else>
            <el-timeline-item
              v-for="(snapshot, index) in timeline"
              :key="snapshot.id"
              :timestamp="formatTime(snapshot.timestamp)"
              :type="getTimelineItemType(snapshot, index)"
              :hollow="selectedSnapshotA?.id !== snapshot.id && selectedSnapshotB?.id !== snapshot.id"
              placement="top"
            >
              <div
                class="timeline-content"
                :class="{
                  'selected-a': selectedSnapshotA?.id === snapshot.id,
                  'selected-b': selectedSnapshotB?.id === snapshot.id
                }"
                @click="handleTimelineClick(snapshot, index)"
              >
                <div class="snapshot-info">
                  <el-tag :type="getTriggerType(snapshot.trigger)" size="small">
                    {{ getTriggerText(snapshot.trigger) }}
                  </el-tag>
                  <span class="snapshot-size">{{ formatBytes(snapshot.size) }}</span>
                </div>
                <div class="snapshot-actions">
                  <el-button
                    size="small"
                    :type="selectedSnapshotA?.id === snapshot.id ? 'primary' : 'default'"
                    @click.stop="selectSnapshotA(snapshot)"
                  >
                    A
                  </el-button>
                  <el-button
                    size="small"
                    :type="selectedSnapshotB?.id === snapshot.id ? 'success' : 'default'"
                    @click.stop="selectSnapshotB(snapshot)"
                  >
                    B
                  </el-button>
                </div>
              </div>
            </el-timeline-item>
          </el-timeline>

          <div class="compare-actions" v-if="timeline.length >= 2">
            <el-button
              type="primary"
              :disabled="!canCompare"
              :loading="comparing"
              @click="compareSnapshots"
            >
              <el-icon><i-ep-switch /></el-icon>
              对比选中快照
            </el-button>
            <el-button @click="clearSelection">清除选择</el-button>
          </div>
        </el-card>
      </el-col>

      <!-- Diff Result Column -->
      <el-col :xs="24" :md="14" :lg="16">
        <el-card shadow="hover" class="diff-card">
          <template #header>
            <div class="card-header">
              <div class="header-left">
                <span>差异详情</span>
              </div>
              <div v-if="diffResult" class="diff-summary">
                <el-tag type="success" size="small">+{{ diffResult.additions.length }} 新增</el-tag>
                <el-tag type="warning" size="small">~{{ diffResult.modifications.length }} 修改</el-tag>
                <el-tag type="danger" size="small">-{{ diffResult.deletions.length }} 删除</el-tag>
              </div>
            </div>
          </template>

          <!-- No diff selected -->
          <el-empty v-if="!diffResult && !comparing" description="选择两个快照进行对比">
            <template #image>
              <el-icon :size="60" color="#c0c4cc"><i-ep-switch /></el-icon>
            </template>
          </el-empty>

          <!-- Loading diff -->
          <el-skeleton v-else-if="comparing" :rows="10" animated />

          <!-- Diff result -->
          <div v-else-if="diffResult" class="diff-content">
            <!-- AI Analysis -->
            <div v-if="diffResult.aiAnalysis" class="ai-analysis-section">
              <div class="section-header">
                <span>AI 分析</span>
                <el-tag
                  :type="getRiskLevelType(diffResult.aiAnalysis.riskLevel)"
                  size="small"
                >
                  {{ getRiskLevelText(diffResult.aiAnalysis.riskLevel) }}
                </el-tag>
              </div>
              <div class="ai-summary">
                {{ diffResult.aiAnalysis.summary }}
              </div>
              <div v-if="diffResult.aiAnalysis.recommendations.length > 0" class="ai-recommendations">
                <div class="recommendations-title">建议：</div>
                <ul>
                  <li v-for="(rec, idx) in diffResult.aiAnalysis.recommendations" :key="idx">
                    {{ rec }}
                  </li>
                </ul>
              </div>
            </div>

            <!-- Additions -->
            <el-collapse v-model="activeCollapse">
              <el-collapse-item
                v-if="diffResult.additions.length > 0"
                name="additions"
              >
                <template #title>
                  <div class="collapse-title">
                    <el-icon color="#67c23a"><i-ep-plus /></el-icon>
                    <span>新增配置 ({{ diffResult.additions.length }})</span>
                  </div>
                </template>
                <div class="diff-items">
                  <div
                    v-for="(item, idx) in diffResult.additions"
                    :key="idx"
                    class="diff-item addition"
                  >
                    <code>+ {{ item }}</code>
                  </div>
                </div>
              </el-collapse-item>

              <!-- Modifications -->
              <el-collapse-item
                v-if="diffResult.modifications.length > 0"
                name="modifications"
              >
                <template #title>
                  <div class="collapse-title">
                    <el-icon color="#e6a23c"><i-ep-edit /></el-icon>
                    <span>修改配置 ({{ diffResult.modifications.length }})</span>
                  </div>
                </template>
                <div class="diff-items">
                  <div
                    v-for="(mod, idx) in diffResult.modifications"
                    :key="idx"
                    class="diff-item modification"
                  >
                    <div class="mod-path">{{ mod.path }}</div>
                    <div class="mod-values">
                      <div class="old-value">
                        <span class="label">旧值:</span>
                        <code>{{ mod.oldValue }}</code>
                      </div>
                      <div class="new-value">
                        <span class="label">新值:</span>
                        <code>{{ mod.newValue }}</code>
                      </div>
                    </div>
                  </div>
                </div>
              </el-collapse-item>

              <!-- Deletions -->
              <el-collapse-item
                v-if="diffResult.deletions.length > 0"
                name="deletions"
              >
                <template #title>
                  <div class="collapse-title">
                    <el-icon color="#f56c6c"><i-ep-minus /></el-icon>
                    <span>删除配置 ({{ diffResult.deletions.length }})</span>
                  </div>
                </template>
                <div class="diff-items">
                  <div
                    v-for="(item, idx) in diffResult.deletions"
                    :key="idx"
                    class="diff-item deletion"
                  >
                    <code>- {{ item }}</code>
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>

            <!-- No changes -->
            <el-empty
              v-if="diffResult.additions.length === 0 && diffResult.modifications.length === 0 && diffResult.deletions.length === 0"
              description="两个快照之间没有差异"
            >
              <template #image>
                <el-icon :size="60" color="#67c23a"><i-ep-circle-check-filled /></el-icon>
              </template>
            </el-empty>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'

import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  snapshotsApi,
  type ConfigSnapshot,
  type SnapshotDiff,
  type SnapshotTrigger,
  type RiskLevel
} from '@/api/ai-ops'

// State
const loading = ref(false)
const comparing = ref(false)
const error = ref('')
const timeline = ref<ConfigSnapshot[]>([])
const selectedSnapshotA = ref<ConfigSnapshot | null>(null)
const selectedSnapshotB = ref<ConfigSnapshot | null>(null)
const diffResult = ref<SnapshotDiff | null>(null)
const activeCollapse = ref(['additions', 'modifications', 'deletions'])

// Computed
const canCompare = computed(() => {
  return selectedSnapshotA.value && selectedSnapshotB.value &&
    selectedSnapshotA.value.id !== selectedSnapshotB.value.id
})

// Load data on mount
onMounted(() => {
  loadTimeline()
})

// Load timeline
const loadTimeline = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await snapshotsApi.getTimeline(50)
    console.log('Timeline API response:', response.data)
    
    if (response.data.success && response.data.data) {
      // 后端返回的是 { snapshot, diff, dangerousChanges }[] 格式
      // 提取 snapshot 数组，确保 snapshot 存在
      const rawData = response.data.data
      console.log('Raw timeline data:', rawData)
      
      timeline.value = rawData
        .filter(item => item && item.snapshot)
        .map(item => {
          const snapshot = item.snapshot
          console.log('Snapshot:', snapshot, 'timestamp:', snapshot?.timestamp)
          return snapshot
        })
      
      console.log('Processed timeline:', timeline.value)
      
      // Auto-select latest two snapshots if available
      if (timeline.value.length >= 2 && !selectedSnapshotA.value && !selectedSnapshotB.value) {
        selectedSnapshotA.value = timeline.value[1]
        selectedSnapshotB.value = timeline.value[0]
      }
    } else {
      throw new Error(response.data.error || '获取变更时间线失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取变更时间线失败'
    error.value = message
    ElMessage.error(message)
    console.error('Failed to load timeline:', err)
  } finally {
    loading.value = false
  }
}

// Select snapshot A (older)
const selectSnapshotA = (snapshot: ConfigSnapshot) => {
  if (selectedSnapshotB.value?.id === snapshot.id) {
    selectedSnapshotB.value = null
  }
  selectedSnapshotA.value = snapshot
}

// Select snapshot B (newer)
const selectSnapshotB = (snapshot: ConfigSnapshot) => {
  if (selectedSnapshotA.value?.id === snapshot.id) {
    selectedSnapshotA.value = null
  }
  selectedSnapshotB.value = snapshot
}

// Handle timeline item click
const handleTimelineClick = (snapshot: ConfigSnapshot, _index: number) => {
  if (!selectedSnapshotA.value) {
    selectedSnapshotA.value = snapshot
  } else if (!selectedSnapshotB.value && selectedSnapshotA.value.id !== snapshot.id) {
    selectedSnapshotB.value = snapshot
  } else if (selectedSnapshotA.value.id === snapshot.id) {
    selectedSnapshotA.value = null
  } else if (selectedSnapshotB.value?.id === snapshot.id) {
    selectedSnapshotB.value = null
  } else {
    // Replace the older selection
    selectedSnapshotA.value = selectedSnapshotB.value
    selectedSnapshotB.value = snapshot
  }
}

// Clear selection
const clearSelection = () => {
  selectedSnapshotA.value = null
  selectedSnapshotB.value = null
  diffResult.value = null
}

// Compare snapshots
const compareSnapshots = async () => {
  if (!canCompare.value) return

  comparing.value = true
  diffResult.value = null

  try {
    // Ensure A is older than B
    let idA = selectedSnapshotA.value!.id
    let idB = selectedSnapshotB.value!.id
    
    if (selectedSnapshotA.value!.timestamp > selectedSnapshotB.value!.timestamp) {
      [idA, idB] = [idB, idA]
    }

    const response = await snapshotsApi.compare(idA, idB)
    if (response.data.success && response.data.data) {
      diffResult.value = response.data.data
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
    manual: '手动',
    auto: '自动',
    'pre-remediation': '修复前'
  }
  return texts[trigger] || trigger
}

const getTimelineItemType = (snapshot: ConfigSnapshot, index: number): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  if (selectedSnapshotA.value?.id === snapshot.id) return 'primary'
  if (selectedSnapshotB.value?.id === snapshot.id) return 'success'
  if (index === 0) return 'success'
  return 'info'
}

const getRiskLevelType = (level: RiskLevel): 'success' | 'warning' | 'danger' => {
  const types: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
    low: 'success',
    medium: 'warning',
    high: 'danger'
  }
  return types[level] || 'warning'
}

const getRiskLevelText = (level: RiskLevel): string => {
  const texts: Record<RiskLevel, string> = {
    low: '低风险',
    medium: '中风险',
    high: '高风险'
  }
  return texts[level] || level
}

const formatTime = (timestamp: number): string => {
  if (!timestamp || !isFinite(timestamp) || timestamp <= 0) {
    return '未知时间'
  }
  const date = new Date(timestamp)
  if (isNaN(date.getTime())) {
    return '无效时间'
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  if (i < 0 || i >= sizes.length) return '0 B'
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
</script>

<style scoped>
.config-changes-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

.header-card {
  margin-bottom: 20px;
}


.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Card Header */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-header .header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.diff-summary {
  display: flex;
  gap: 8px;
}

/* Timeline Card */
.timeline-card {
  min-height: 500px;
}

.timeline-card :deep(.el-card__body) {
  max-height: 600px;
  overflow-y: auto;
}

.timeline-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.timeline-content:hover {
  background: var(--el-fill-color);
}

.timeline-content.selected-a {
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary);
}

.timeline-content.selected-b {
  background: var(--el-color-success-light-9);
  border: 1px solid var(--el-color-success);
}

.snapshot-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.snapshot-size {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.snapshot-actions {
  display: flex;
  gap: 4px;
}

.compare-actions {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  display: flex;
  gap: 8px;
}

/* Diff Card */
.diff-card {
  min-height: 500px;
}

.diff-content {
  min-height: 400px;
}

/* AI Analysis Section */
.ai-analysis-section {
  margin-bottom: 20px;
  padding: 16px;
  background: var(--el-color-primary-light-9);
  border-radius: 8px;
  border: 1px solid var(--el-color-primary-light-8);
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.ai-summary {
  font-size: 14px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  margin-bottom: 12px;
}

.ai-recommendations {
  margin-top: 12px;
}

.recommendations-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}

.ai-recommendations ul {
  margin: 0;
  padding-left: 20px;
}

.ai-recommendations li {
  font-size: 13px;
  color: var(--el-text-color-regular);
  margin: 4px 0;
}

/* Collapse */
.collapse-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}

.diff-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diff-item {
  padding: 8px 12px;
  border-radius: 4px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
  overflow-x: auto;
}

.diff-item.addition {
  background: var(--el-color-success-light-9);
  border-left: 3px solid var(--el-color-success);
  color: var(--el-color-success);
}

.diff-item.deletion {
  background: var(--el-color-danger-light-9);
  border-left: 3px solid var(--el-color-danger);
  color: var(--el-color-danger);
}

.diff-item.modification {
  background: var(--el-color-warning-light-9);
  border-left: 3px solid var(--el-color-warning);
}

.mod-path {
  font-weight: 600;
  color: var(--el-color-warning);
  margin-bottom: 8px;
}

.mod-values {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.old-value,
.new-value {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.old-value .label,
.new-value .label {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  width: 40px;
}

.old-value code {
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  padding: 2px 6px;
  border-radius: 3px;
}

.new-value code {
  color: var(--el-color-success);
  background: var(--el-color-success-light-9);
  padding: 2px 6px;
  border-radius: 3px;
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

  .timeline-content {
    flex-direction: column;
    gap: 8px;
  }

  .snapshot-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
