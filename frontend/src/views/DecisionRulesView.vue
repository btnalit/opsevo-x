<template>
  <div class="decision-rules-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>决策规则管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              新建决策规则
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadRules">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Tabs for Rules and History -->
    <el-tabs v-model="activeTab" class="main-tabs">
      <!-- Rules Tab -->
      <el-tab-pane label="决策规则" name="rules">
        <!-- Loading State -->
        <el-skeleton v-if="loading && rules.length === 0" :rows="5" animated />

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
            <el-button type="primary" size="small" @click="loadRules">
              重新加载
            </el-button>
          </template>
        </el-alert>

        <!-- Empty State -->
        <el-empty
          v-else-if="rules.length === 0"
          description="暂无决策规则"
        >
          <el-button type="primary" @click="showCreateDialog">创建决策规则</el-button>
        </el-empty>

        <!-- Rules Table -->
        <el-card v-else shadow="hover">
          <el-table
            v-loading="loading"
            :data="paginatedRules"
            stripe
            style="width: 100%"
            @row-click="handleRowClick"
          >
            <el-table-column prop="priority" label="优先级" width="80" sortable>
              <template #default="{ row, $index }">
                <div class="priority-cell">
                  <span class="priority-value">{{ row.priority }}</span>
                  <div class="priority-actions">
                    <el-button
                      v-if="$index > 0"
                      size="small"
                      :icon="ArrowUp"
                      circle
                      @click.stop="movePriority(row, 'up')"
                    />
                    <el-button
                      v-if="$index < paginatedRules.length - 1"
                      size="small"
                      :icon="ArrowDown"
                      circle
                      @click.stop="movePriority(row, 'down')"
                    />
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="规则名称" min-width="150" show-overflow-tooltip />
            <el-table-column label="条件" min-width="200">
              <template #default="{ row }">
                <div class="conditions-list">
                  <el-tag
                    v-for="(cond, index) in row.conditions.slice(0, 2)"
                    :key="index"
                    size="small"
                    type="info"
                    class="condition-tag"
                  >
                    {{ formatCondition(cond) }}
                  </el-tag>
                  <el-tag
                    v-if="row.conditions.length > 2"
                    size="small"
                    type="info"
                  >
                    +{{ row.conditions.length - 2 }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="决策动作" width="140">
              <template #default="{ row }">
                <el-tag :type="getActionType(row.action)" size="small">
                  {{ getActionText(row.action) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-switch
                  v-model="row.enabled"
                  @click.stop
                  @change="(val: any) => toggleEnabled(row, !!val)"
                />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click.stop="editRule(row)">
                  编辑
                </el-button>
                <el-popconfirm
                  title="确定要删除此决策规则吗？"
                  confirm-button-text="确定"
                  cancel-button-text="取消"
                  @confirm="deleteRule(row)"
                >
                  <template #reference>
                    <el-button size="small" type="danger" link @click.stop>
                      删除
                    </el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>

          <!-- Pagination -->
          <div class="pagination-container">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[10, 20, 50]"
              :total="rules.length"
              layout="total, sizes, prev, pager, next"
              background
            />
          </div>
        </el-card>
      </el-tab-pane>

      <!-- History Tab -->
      <el-tab-pane label="决策历史" name="history">
        <!-- History Filter -->
        <el-card class="filter-card" shadow="hover">
          <el-form :inline="true" class="filter-form">
            <el-form-item label="告警 ID">
              <el-input
                v-model="historyAlertId"
                placeholder="输入告警 ID 筛选"
                clearable
                style="width: 200px"
                @clear="loadHistory"
                @keyup.enter="loadHistory"
              />
            </el-form-item>
            <el-form-item label="数量限制">
              <el-select v-model="historyLimit" style="width: 100px" @change="loadHistory">
                <el-option :value="20" label="20 条" />
                <el-option :value="50" label="50 条" />
                <el-option :value="100" label="100 条" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="historyLoading" @click="loadHistory">
                查询
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <!-- History Loading -->
        <el-skeleton v-if="historyLoading && history.length === 0" :rows="5" animated />

        <!-- History Empty -->
        <el-empty v-else-if="history.length === 0" description="暂无决策历史" />

        <!-- History Table -->
        <el-card v-else shadow="hover">
          <el-table
            v-loading="historyLoading"
            :data="history"
            stripe
            style="width: 100%"
            @row-click="showHistoryDetail"
          >
            <el-table-column prop="timestamp" label="时间" width="180">
              <template #default="{ row }">
                {{ formatDateTime(row.timestamp) }}
              </template>
            </el-table-column>
            <el-table-column prop="alertId" label="告警 ID" width="200" show-overflow-tooltip />
            <el-table-column label="决策动作" width="140">
              <template #default="{ row }">
                <el-tag :type="getActionType(row.action)" size="small">
                  {{ getActionText(row.action) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="matchedRule" label="匹配规则" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.matchedRule || '-' }}
              </template>
            </el-table-column>
            <el-table-column label="执行状态" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.executed" :type="row.executionResult?.success ? 'success' : 'danger'" size="small">
                  {{ row.executionResult?.success ? '成功' : '失败' }}
                </el-tag>
                <el-tag v-else type="info" size="small">未执行</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reasoning" label="决策理由" min-width="200" show-overflow-tooltip />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- Create/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑决策规则' : '新建决策规则'"
      width="700px"
      destroy-on-close
      @close="resetForm"
    >
      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-width="100px"
        label-position="right"
      >
        <el-form-item label="规则名称" prop="name">
          <el-input v-model="formData.name" placeholder="请输入规则名称" />
        </el-form-item>

        <el-form-item label="优先级" prop="priority">
          <el-input-number
            v-model="formData.priority"
            :min="1"
            :max="999"
            placeholder="数字越小优先级越高"
          />
          <span class="form-item-tip inline">数字越小优先级越高</span>
        </el-form-item>

        <el-form-item label="决策动作" prop="action">
          <el-radio-group v-model="formData.action">
            <el-radio-button value="auto_execute">
              <el-icon><i-ep-video-play /></el-icon>
              自动执行
            </el-radio-button>
            <el-radio-button value="notify_and_wait">
              <el-icon><i-ep-bell /></el-icon>
              通知等待
            </el-radio-button>
            <el-radio-button value="escalate">
              <el-icon><i-ep-top /></el-icon>
              升级处理
            </el-radio-button>
            <el-radio-button value="silence">
              <el-icon><i-ep-mute-notification /></el-icon>
              静默
            </el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-divider content-position="left">决策条件</el-divider>

        <div class="conditions-editor">
          <div
            v-for="(condition, index) in formData.conditions"
            :key="index"
            class="condition-row"
          >
            <el-select
              v-model="condition.factor"
              placeholder="选择因子"
              style="width: 160px"
            >
              <el-option value="severity" label="严重级别" />
              <el-option value="time_of_day" label="时间段" />
              <el-option value="historical_success_rate" label="历史成功率" />
              <el-option value="affected_scope" label="影响范围" />
            </el-select>
            <el-select
              v-model="condition.operator"
              placeholder="运算符"
              style="width: 100px"
            >
              <el-option value="gt" label=">" />
              <el-option value="lt" label="<" />
              <el-option value="eq" label="=" />
              <el-option value="gte" label=">=" />
              <el-option value="lte" label="<=" />
            </el-select>
            <el-input-number
              v-model="condition.value"
              :min="0"
              :max="100"
              placeholder="值"
              style="width: 120px"
            />
            <el-button
              type="danger"
              :icon="Delete"
              circle
              @click="removeCondition(index)"
            />
          </div>
          <el-button type="primary" text :icon="Plus" @click="addCondition">
            添加条件
          </el-button>
        </div>

        <div class="form-item-tip">
          <p>因子说明：</p>
          <ul>
            <li><strong>严重级别</strong>：1=info, 2=warning, 3=critical, 4=emergency</li>
            <li><strong>时间段</strong>：0-23 表示小时（如 9 表示上午 9 点）</li>
            <li><strong>历史成功率</strong>：0-100 表示百分比</li>
            <li><strong>影响范围</strong>：1=local, 2=partial, 3=widespread</li>
          </ul>
        </div>

        <el-form-item label="启用规则">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ isEditing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Rule Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="决策规则详情"
      width="600px"
      destroy-on-close
    >
      <el-descriptions :column="1" border v-if="selectedRule">
        <el-descriptions-item label="规则名称">{{ selectedRule.name }}</el-descriptions-item>
        <el-descriptions-item label="优先级">{{ selectedRule.priority }}</el-descriptions-item>
        <el-descriptions-item label="决策动作">
          <el-tag :type="getActionType(selectedRule.action)" size="small">
            {{ getActionText(selectedRule.action) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="selectedRule.enabled ? 'success' : 'info'" size="small">
            {{ selectedRule.enabled ? '已启用' : '已禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="决策条件">
          <div class="conditions-detail">
            <el-tag
              v-for="(cond, index) in selectedRule.conditions"
              :key="index"
              size="small"
              type="info"
              class="condition-tag"
            >
              {{ formatCondition(cond) }}
            </el-tag>
            <span v-if="selectedRule.conditions.length === 0" class="text-muted">无条件</span>
          </div>
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedRule.createdAt" label="创建时间">
          {{ formatDateTime(selectedRule.createdAt) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedRule.updatedAt" label="更新时间">
          {{ formatDateTime(selectedRule.updatedAt) }}
        </el-descriptions-item>
      </el-descriptions>

      <!-- 权重调整 -->
      <div v-if="selectedRule" style="margin-top: 16px;">
        <h4 style="margin-bottom: 12px; color: var(--el-text-color-regular);">权重调整</h4>
        <div style="padding: 0 8px;">
          <div v-for="(wKey, idx) in weightKeys" :key="idx" style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-size: 13px;">{{ weightLabels[wKey] || wKey }}</span>
              <span style="font-size: 13px; color: var(--el-text-color-secondary);">{{ ruleWeights[wKey] }}</span>
            </div>
            <el-slider v-model="ruleWeights[wKey]" :min="0" :max="1" :step="0.1" />
          </div>
          <el-button type="primary" size="small" :loading="savingWeights" @click="saveWeights" style="margin-top: 8px;">
            保存权重
          </el-button>
        </div>
      </div>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editRule(selectedRule!)">编辑</el-button>
      </template>
    </el-dialog>

    <!-- History Detail Dialog -->
    <el-dialog
      v-model="historyDetailVisible"
      title="决策详情"
      width="650px"
      destroy-on-close
    >
      <el-descriptions :column="1" border v-if="selectedHistory">
        <el-descriptions-item label="决策 ID">{{ selectedHistory.id }}</el-descriptions-item>
        <el-descriptions-item label="告警 ID">{{ selectedHistory.alertId }}</el-descriptions-item>
        <el-descriptions-item label="时间">{{ formatDateTime(selectedHistory.timestamp) }}</el-descriptions-item>
        <el-descriptions-item label="决策动作">
          <el-tag :type="getActionType(selectedHistory.action)" size="small">
            {{ getActionText(selectedHistory.action) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="匹配规则">
          {{ selectedHistory.matchedRule || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="决策理由">
          {{ selectedHistory.reasoning }}
        </el-descriptions-item>
        <el-descriptions-item label="决策因子">
          <div class="factors-detail">
            <div v-for="factor in selectedHistory.factors" :key="factor.name" class="factor-item">
              <span class="factor-name">{{ getFactorName(factor.name) }}</span>
              <el-progress
                :percentage="Math.round(factor.score * 100)"
                :stroke-width="8"
                style="width: 100px"
              />
              <span class="factor-weight">权重: {{ factor.weight }}</span>
            </div>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="执行状态">
          <el-tag v-if="selectedHistory.executed" :type="selectedHistory.executionResult?.success ? 'success' : 'danger'" size="small">
            {{ selectedHistory.executionResult?.success ? '执行成功' : '执行失败' }}
          </el-tag>
          <el-tag v-else type="info" size="small">未执行</el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="selectedHistory.executionResult" label="执行详情">
          {{ selectedHistory.executionResult.details }}
        </el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="historyDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh, ArrowUp, ArrowDown, Delete } from '@element-plus/icons-vue'

import { ref, computed, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  decisionsApi,
  type DecisionRule,
  type CreateDecisionRuleInput,
  type DecisionType,
  type DecisionCondition,
  type Decision
} from '@/api/ai-ops'
import { decisionApi } from '@/api/aiops-enhanced'

// State
const loading = ref(false)
const error = ref('')
const rules = ref<DecisionRule[]>([])
const dialogVisible = ref(false)
const detailVisible = ref(false)
const isEditing = ref(false)
const submitting = ref(false)
const selectedRule = ref<DecisionRule | null>(null)
const editingRuleId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const activeTab = ref('rules')

// Weight adjustment
const savingWeights = ref(false)
const weightKeys = ['severity_weight', 'history_weight', 'confidence_weight'] as const
const weightLabels: Record<string, string> = { severity_weight: '严重度权重', history_weight: '历史权重', confidence_weight: '置信度权重' }
const ruleWeights = reactive<Record<string, number>>({ severity_weight: 0.5, history_weight: 0.3, confidence_weight: 0.2 })
const saveWeights = async () => {
  if (!selectedRule.value) return
  savingWeights.value = true
  try {
    await decisionApi.adjustWeights(selectedRule.value.id, { ...ruleWeights })
    ElMessage.success('权重已保存')
  } catch { ElMessage.error('保存失败') }
  finally { savingWeights.value = false }
}
// History state
const historyLoading = ref(false)
const history = ref<Decision[]>([])
const historyAlertId = ref('')
const historyLimit = ref(50)
const historyDetailVisible = ref(false)
const selectedHistory = ref<Decision | null>(null)

// Pagination
const currentPage = ref(1)
const pageSize = ref(10)

// Computed - paginated and sorted rules
const paginatedRules = computed(() => {
  const sorted = [...rules.value].sort((a, b) => a.priority - b.priority)
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return sorted.slice(start, end)
})

// Form data
const getDefaultFormData = (): CreateDecisionRuleInput => ({
  name: '',
  priority: 10,
  conditions: [],
  action: 'notify_and_wait',
  enabled: true
})

const formData = reactive<CreateDecisionRuleInput>(getDefaultFormData())

// Form validation rules
const formRules: FormRules = {
  name: [
    { required: true, message: '请输入规则名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  priority: [{ required: true, message: '请输入优先级', trigger: 'blur' }],
  action: [{ required: true, message: '请选择决策动作', trigger: 'change' }]
}

// Load data on mount
onMounted(() => {
  loadRules()
})

// Load decision rules
const loadRules = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await decisionsApi.getRules()
    if (response.data.success && response.data.data) {
      rules.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取决策规则失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取决策规则失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Load decision history
const loadHistory = async () => {
  historyLoading.value = true

  try {
    const options: { alertId?: string; limit?: number } = { limit: historyLimit.value }
    if (historyAlertId.value) {
      options.alertId = historyAlertId.value
    }
    const response = await decisionsApi.getHistory(options)
    if (response.data.success && response.data.data) {
      history.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取决策历史失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取决策历史失败'
    ElMessage.error(message)
  } finally {
    historyLoading.value = false
  }
}

// Show create dialog
const showCreateDialog = () => {
  isEditing.value = false
  editingRuleId.value = null
  Object.assign(formData, getDefaultFormData())
  dialogVisible.value = true
}

// Edit rule
const editRule = (rule: DecisionRule) => {
  isEditing.value = true
  editingRuleId.value = rule.id
  Object.assign(formData, {
    name: rule.name,
    priority: rule.priority,
    conditions: rule.conditions.map(c => ({ ...c })),
    action: rule.action,
    enabled: rule.enabled
  })
  detailVisible.value = false
  dialogVisible.value = true
}

// Delete rule
const deleteRule = async (rule: DecisionRule) => {
  try {
    await decisionsApi.deleteRule(rule.id)
    ElMessage.success('决策规则已删除')
    await loadRules()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败'
    ElMessage.error(message)
  }
}

// Toggle enabled
const toggleEnabled = async (rule: DecisionRule, enabled: boolean) => {
  try {
    await decisionsApi.updateRule(rule.id, { enabled })
    ElMessage.success(enabled ? '规则已启用' : '规则已禁用')
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
    // Revert the change
    rule.enabled = !enabled
  }
}

// Move priority
const movePriority = async (rule: DecisionRule, direction: 'up' | 'down') => {
  const sorted = [...rules.value].sort((a, b) => a.priority - b.priority)
  const index = sorted.findIndex(r => r.id === rule.id)
  if (index === -1) return

  const targetIndex = direction === 'up' ? index - 1 : index + 1
  if (targetIndex < 0 || targetIndex >= sorted.length) return

  const targetRule = sorted[targetIndex]
  const tempPriority = rule.priority

  try {
    // Swap priorities
    await decisionsApi.updateRule(rule.id, { priority: targetRule.priority })
    await decisionsApi.updateRule(targetRule.id, { priority: tempPriority })
    ElMessage.success('优先级已调整')
    await loadRules()
  } catch (err) {
    const message = err instanceof Error ? err.message : '调整优先级失败'
    ElMessage.error(message)
  }
}

// Add condition
const addCondition = () => {
  formData.conditions.push({
    factor: 'severity',
    operator: 'gte',
    value: 3
  })
}

// Remove condition
const removeCondition = (index: number) => {
  formData.conditions.splice(index, 1)
}

// Submit form
const submitForm = async () => {
  if (!formRef.value) return

  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true

  try {
    const data: CreateDecisionRuleInput = {
      name: formData.name,
      priority: formData.priority,
      conditions: formData.conditions,
      action: formData.action,
      enabled: formData.enabled
    }

    if (isEditing.value && editingRuleId.value) {
      await decisionsApi.updateRule(editingRuleId.value, data)
      ElMessage.success('决策规则已更新')
    } else {
      await decisionsApi.createRule(data)
      ElMessage.success('决策规则已创建')
    }

    dialogVisible.value = false
    await loadRules()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

// Reset form
const resetForm = () => {
  formRef.value?.resetFields()
  Object.assign(formData, getDefaultFormData())
}

// Handle row click
const handleRowClick = (row: DecisionRule) => {
  selectedRule.value = row
  detailVisible.value = true
}

// Show history detail
const showHistoryDetail = (row: Decision) => {
  selectedHistory.value = row
  historyDetailVisible.value = true
}

// Utility functions
const formatDateTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const formatCondition = (cond: DecisionCondition): string => {
  const factorNames: Record<string, string> = {
    severity: '严重级别',
    time_of_day: '时间段',
    historical_success_rate: '历史成功率',
    affected_scope: '影响范围'
  }
  const operatorSymbols: Record<string, string> = {
    gt: '>',
    lt: '<',
    eq: '=',
    gte: '>=',
    lte: '<='
  }
  return `${factorNames[cond.factor] || cond.factor} ${operatorSymbols[cond.operator] || cond.operator} ${cond.value}`
}

const getActionType = (action: DecisionType): 'success' | 'warning' | 'danger' | 'info' => {
  const types: Record<DecisionType, 'success' | 'warning' | 'danger' | 'info'> = {
    auto_execute: 'success',
    notify_and_wait: 'warning',
    escalate: 'danger',
    silence: 'info',
    auto_remediate: 'success',
    observe: 'info'
  }
  return types[action] || 'info'
}

const getActionText = (action: DecisionType): string => {
  const texts: Record<DecisionType, string> = {
    auto_execute: '自动执行',
    notify_and_wait: '通知等待',
    escalate: '升级处理',
    silence: '静默',
    auto_remediate: '自动修复',
    observe: '观察'
  }
  return texts[action] || action
}

const getFactorName = (factor: string): string => {
  const names: Record<string, string> = {
    severity: '严重级别',
    time_of_day: '时间段',
    historical_success_rate: '历史成功率',
    affected_scope: '影响范围'
  }
  return names[factor] || factor
}
</script>


<style scoped>
.decision-rules-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

/* Header */
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

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Tabs */
.main-tabs {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--el-box-shadow-light);
}

/* Filter Card */
.filter-card {
  margin-bottom: 16px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Table */
.priority-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.priority-value {
  font-weight: 600;
  min-width: 24px;
}

.priority-actions {
  display: flex;
  gap: 4px;
}

.priority-actions .el-button {
  padding: 4px;
  width: 24px;
  height: 24px;
}

.conditions-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.condition-tag {
  margin: 0;
}

.text-muted {
  color: var(--el-text-color-secondary);
}

/* Pagination */
.pagination-container {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* Form */
.form-item-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 8px;
  line-height: 1.6;
}

.form-item-tip.inline {
  margin-top: 0;
  margin-left: 12px;
}

.form-item-tip ul {
  margin: 4px 0 0 16px;
  padding: 0;
}

.form-item-tip li {
  margin: 2px 0;
}

/* Conditions Editor */
.conditions-editor {
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  margin-bottom: 16px;
}

.condition-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.condition-row:last-of-type {
  margin-bottom: 12px;
}

/* Detail */
.conditions-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* History */
.factors-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.factor-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.factor-name {
  min-width: 80px;
  font-size: 13px;
}

.factor-weight {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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

  .condition-row {
    flex-wrap: wrap;
  }
}
</style>
