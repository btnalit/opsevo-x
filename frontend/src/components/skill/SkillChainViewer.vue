<template>
  <div class="skill-chain-viewer">
    <!-- Header -->
    <div class="chain-header">
      <div class="header-left">
        <el-icon :size="20" color="#409eff"><i-ep-connection /></el-icon>
        <span class="header-title">Skill 链式调用</span>
        <el-tag v-if="chainStats.activeChains > 0" type="success" size="small">
          {{ chainStats.activeChains }} 活跃链
        </el-tag>
      </div>
      <div class="header-actions">
        <el-button size="small" :icon="Refresh" :loading="loading" @click="loadChainStats">
          刷新
        </el-button>
        <el-button size="small" :icon="Setting" @click="showConfigDialog = true">
          配置
        </el-button>
      </div>
    </div>

    <!-- Stats Overview -->
    <el-row :gutter="12" class="chain-stats">
      <el-col :span="6">
        <div class="stat-item">
          <div class="stat-value">{{ chainStats.activeChains }}</div>
          <div class="stat-label">活跃链</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-item">
          <div class="stat-value">{{ chainStats.totalSteps }}</div>
          <div class="stat-label">总步骤</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-item">
          <div class="stat-value">{{ chainStats.avgDepth.toFixed(1) }}</div>
          <div class="stat-label">平均深度</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-item">
          <div class="stat-value">{{ chainConfig.maxChainDepth }}</div>
          <div class="stat-label">最大深度</div>
        </div>
      </el-col>
    </el-row>

    <!-- Session Chain History -->
    <div v-if="sessionId" class="chain-history-section">
      <div class="section-header">
        <span>会话链历史</span>
        <el-tag size="small">{{ sessionId }}</el-tag>
      </div>
      
      <div v-if="chainHistory.length === 0" class="empty-state">
        <el-empty description="暂无链式调用历史" :image-size="80" />
      </div>
      
      <div v-else class="chain-timeline">
        <el-timeline>
          <el-timeline-item
            v-for="step in chainHistory"
            :key="step.stepId"
            :timestamp="formatTime(step.enteredAt)"
            :type="getStepType(step.status)"
            :hollow="step.status === 'active'"
            placement="top"
          >
            <el-card shadow="hover" class="step-card">
              <div class="step-header">
                <div class="step-skill">
                  <el-icon><i-ep-magic-stick /></el-icon>
                  <span class="skill-name">{{ step.skillName }}</span>
                  <el-tag v-if="step.autoSwitched" type="info" size="small">自动</el-tag>
                  <el-tag v-else type="warning" size="small">手动</el-tag>
                </div>
                <el-tag :type="getStatusTagType(step.status)" size="small">
                  {{ getStatusText(step.status) }}
                </el-tag>
              </div>
              <div class="step-reason">
                <el-icon><i-ep-info-filled /></el-icon>
                {{ step.triggerReason }}
              </div>
              <div v-if="step.resultSummary" class="step-result">
                <el-icon><i-ep-document /></el-icon>
                {{ step.resultSummary }}
              </div>
              <div class="step-duration" v-if="step.exitedAt">
                <el-icon><i-ep-timer /></el-icon>
                耗时: {{ calculateDuration(step.enteredAt, step.exitedAt) }}
              </div>
            </el-card>
          </el-timeline-item>
        </el-timeline>
      </div>
    </div>

    <!-- Chain Config Dialog -->
    <el-dialog
      v-model="showConfigDialog"
      title="链式调用配置"
      width="500px"
    >
      <el-form :model="editConfig" label-width="120px">
        <el-form-item label="启用链式调用">
          <el-switch v-model="editConfig.enabled" />
        </el-form-item>
        <el-form-item label="最大链深度">
          <el-input-number
            v-model="editConfig.maxChainDepth"
            :min="1"
            :max="20"
          />
        </el-form-item>
        <el-form-item label="链超时时间">
          <el-input-number
            v-model="editConfig.chainTimeoutMs"
            :min="60000"
            :max="3600000"
            :step="60000"
          />
          <span class="unit-label">毫秒</span>
        </el-form-item>
        <el-form-item label="需要确认切换">
          <el-switch v-model="editConfig.requireConfirmation" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showConfigDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveConfig">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Refresh, Setting } from '@element-plus/icons-vue'

import { ref, reactive, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api'

// Props
const props = defineProps<{
  sessionId?: string
}>()

// State
const loading = ref(false)
const saving = ref(false)
const showConfigDialog = ref(false)

const chainStats = reactive({
  activeChains: 0,
  totalSteps: 0,
  avgDepth: 0,
})

const chainConfig = reactive({
  enabled: true,
  maxChainDepth: 5,
  chainTimeoutMs: 300000,
  requireConfirmation: false,
})

const editConfig = reactive({
  enabled: true,
  maxChainDepth: 5,
  chainTimeoutMs: 300000,
  requireConfirmation: false,
})

const chainHistory = ref<ChainStep[]>([])

// Types
interface ChainStep {
  stepId: string
  skillName: string
  enteredAt: string
  exitedAt?: string
  status: 'active' | 'completed' | 'failed' | 'skipped'
  triggerReason: string
  autoSwitched: boolean
  resultSummary?: string
}

// Methods
async function loadChainStats() {
  loading.value = true
  try {
    const response = await api.get('/skills/chain/stats')
    if (response.data.success) {
      Object.assign(chainStats, response.data.data.stats)
      Object.assign(chainConfig, response.data.data.config)
      Object.assign(editConfig, response.data.data.config)
    }
  } catch (error) {
    console.error('Failed to load chain stats:', error)
  } finally {
    loading.value = false
  }
}

async function loadChainHistory() {
  if (!props.sessionId) return
  
  try {
    const response = await api.get(`/skills/chain/${props.sessionId}/history`)
    if (response.data.success) {
      chainHistory.value = response.data.data.history
    }
  } catch (error) {
    console.error('Failed to load chain history:', error)
  }
}

async function saveConfig() {
  saving.value = true
  try {
    const response = await api.put('/skills/chain/config', editConfig)
    if (response.data.success) {
      Object.assign(chainConfig, response.data.data)
      ElMessage.success('配置已保存')
      showConfigDialog.value = false
    }
  } catch (error) {
    ElMessage.error('保存配置失败')
    console.error('Failed to save config:', error)
  } finally {
    saving.value = false
  }
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function calculateDuration(start: string, end: string): string {
  const duration = new Date(end).getTime() - new Date(start).getTime()
  if (duration < 1000) return `${duration}ms`
  if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`
  return `${(duration / 60000).toFixed(1)}min`
}

function getStepType(status: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'active': return 'primary'
    case 'completed': return 'success'
    case 'failed': return 'danger'
    case 'skipped': return 'info'
    default: return 'info'
  }
}

function getStatusTagType(status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  switch (status) {
    case 'active': return 'warning'
    case 'completed': return 'success'
    case 'failed': return 'danger'
    case 'skipped': return 'info'
    default: return 'info'
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case 'active': return '执行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'skipped': return '跳过'
    default: return status
  }
}

// Watchers
watch(() => props.sessionId, () => {
  loadChainHistory()
})

// Lifecycle
onMounted(() => {
  loadChainStats()
  if (props.sessionId) {
    loadChainHistory()
  }
})
</script>


<style scoped>
.skill-chain-viewer {
  padding: 16px;
}

.chain-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.chain-stats {
  margin-bottom: 20px;
}

.stat-item {
  text-align: center;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 8px;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: #409eff;
}

.stat-label {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}

.chain-history-section {
  margin-top: 20px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-weight: 600;
  color: #303133;
}

.empty-state {
  padding: 40px 0;
}

.chain-timeline {
  padding: 0 20px;
}

.step-card {
  margin-bottom: 8px;
}

.step-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.step-skill {
  display: flex;
  align-items: center;
  gap: 6px;
}

.skill-name {
  font-weight: 600;
  color: #303133;
}

.step-reason,
.step-result,
.step-duration {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #606266;
  margin-top: 6px;
}

.step-result {
  color: #67c23a;
}

.step-duration {
  color: #909399;
}

.unit-label {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}
</style>
