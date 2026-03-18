<template>
  <div class="fault-patterns-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>故障自愈管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              新建模式
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadPatterns">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Tabs -->
    <el-tabs v-model="activeTab" class="main-tabs">
      <!-- Fault Patterns Tab -->
      <el-tab-pane label="故障模式" name="patterns">
        <!-- Loading State -->
        <el-skeleton v-if="loading && patterns.length === 0" :rows="5" animated />

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
            <el-button type="primary" size="small" @click="loadPatterns">
              重新加载
            </el-button>
          </template>
        </el-alert>

        <!-- Empty State -->
        <el-card v-else-if="patterns.length === 0" shadow="hover">
          <el-empty description="暂无故障模式">
            <el-button type="primary" @click="showCreateDialog">创建第一个模式</el-button>
          </el-empty>
        </el-card>

        <!-- Patterns Table -->
        <el-card v-else shadow="hover">
          <el-table
            v-loading="loading"
            :data="patterns"
            stripe
            style="width: 100%"
            @row-click="handleRowClick"
          >
            <el-table-column prop="name" label="模式名称" min-width="150" show-overflow-tooltip />
            <el-table-column label="所属设备" width="140">
              <template #default="{ row }">
                <span v-if="getDeviceName(row.deviceId || row.device_id)" class="device-name-tag">{{ getDeviceName(row.deviceId || row.device_id) }}</span>
                <span v-else class="no-data">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
            <el-table-column label="条件数" width="80" align="center">
              <template #default="{ row }">
                {{ row.conditions?.length || 0 }}
              </template>
            </el-table-column>
            <el-table-column label="类型" width="100">
              <template #default="{ row }">
                <el-tag :type="row.builtin ? 'warning' : 'primary'" size="small">
                  {{ row.builtin ? '内置' : '自定义' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="80" align="center">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
                  {{ row.enabled ? '启用' : '禁用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="自动修复" width="100" align="center">
              <template #default="{ row }">
                <el-switch
                  :model-value="row.autoHeal"
                  :loading="togglingAutoHeal === row.id"
                  @change="(val: string | number | boolean) => toggleAutoHeal(row, Boolean(val))"
                  @click.stop
                />
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="160">
              <template #default="{ row }">
                {{ formatTime(row.updatedAt) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click.stop="editPattern(row)">
                  编辑
                </el-button>
                <el-button
                  size="small"
                  :type="row.enabled ? 'warning' : 'success'"
                  link
                  @click.stop="toggleEnabled(row)"
                >
                  {{ row.enabled ? '禁用' : '启用' }}
                </el-button>
                <el-popconfirm
                  v-if="!row.builtin"
                  title="确定要删除此模式吗？"
                  confirm-button-text="确定"
                  cancel-button-text="取消"
                  @confirm="deletePattern(row)"
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
        </el-card>
      </el-tab-pane>

      <!-- Remediation History Tab -->
      <el-tab-pane label="修复历史" name="history">
        <el-card shadow="hover">
          <template #header>
            <div class="card-header">
              <span>修复执行记录</span>
              <el-button :icon="Refresh" :loading="loadingHistory" @click="loadRemediationHistory">
                刷新
              </el-button>
            </div>
          </template>

          <el-skeleton v-if="loadingHistory && remediations.length === 0" :rows="5" animated />

          <el-empty v-else-if="remediations.length === 0" description="暂无修复记录" />

          <el-table v-else :data="remediations" stripe style="width: 100%">
            <el-table-column label="执行时间" width="160">
              <template #default="{ row }">
                {{ formatTime(row.startedAt) }}
              </template>
            </el-table-column>
            <el-table-column prop="patternName" label="故障模式" min-width="150" show-overflow-tooltip />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getRemediationStatusType(row.status)" size="small">
                  {{ getRemediationStatusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="AI 确认" width="120">
              <template #default="{ row }">
                <template v-if="row.aiConfirmation">
                  <el-tag :type="row.aiConfirmation.confirmed ? 'success' : 'warning'" size="small">
                    {{ row.aiConfirmation.confirmed ? '已确认' : '未确认' }}
                  </el-tag>
                  <span class="confidence-text">{{ (row.aiConfirmation.confidence * 100).toFixed(0) }}%</span>
                </template>
                <span v-else class="no-data">-</span>
              </template>
            </el-table-column>
            <el-table-column label="验证结果" width="100">
              <template #default="{ row }">
                <template v-if="row.verificationResult">
                  <el-tag :type="row.verificationResult.passed ? 'success' : 'danger'" size="small">
                    {{ row.verificationResult.passed ? '通过' : '失败' }}
                  </el-tag>
                </template>
                <span v-else class="no-data">-</span>
              </template>
            </el-table-column>
            <el-table-column label="耗时" width="100">
              <template #default="{ row }">
                {{ row.completedAt ? formatDuration(row.completedAt - row.startedAt) : '-' }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" link @click="viewRemediationDetail(row)">
                  详情
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- 待审核模式 Tab -->
      <el-tab-pane label="待审核模式" name="pending">
        <el-table v-if="pendingPatterns.length > 0" :data="pendingPatterns" stripe size="small">
          <el-table-column prop="name" label="模式名称" min-width="150" />
          <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
          <el-table-column prop="confidence" label="置信度" width="100">
            <template #default="{ row }">{{ (row.confidence * 100).toFixed(0) }}%</template>
          </el-table-column>
          <el-table-column prop="detectedAt" label="发现时间" width="160" />
        </el-table>
        <el-empty v-else description="暂无待审核模式" />
      </el-tab-pane>

      <!-- 匹配案例 Tab -->
      <el-tab-pane label="匹配案例" name="cases">
        <el-empty description="请从故障模式列表中选择一个模式查看匹配案例" :image-size="80" />
      </el-tab-pane>

      <!-- 修复历史 Tab -->
      <el-tab-pane label="修复历史" name="repairHistory">
        <el-table v-if="repairHistoryList.length > 0" :data="repairHistoryList" stripe size="small">
          <el-table-column prop="patternName" label="故障模式" min-width="140" />
          <el-table-column prop="action" label="修复动作" min-width="200" show-overflow-tooltip />
          <el-table-column prop="result" label="结果" width="80">
            <template #default="{ row }">
              <el-tag :type="row.result === 'success' ? 'success' : 'danger'" size="small">{{ row.result === 'success' ? '成功' : '失败' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="timestamp" label="时间" width="160">
            <template #default="{ row }">{{ new Date(row.timestamp).toLocaleString('zh-CN') }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无修复历史" />
      </el-tab-pane>
    </el-tabs>

    <!-- Create/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑故障模式' : '新建故障模式'"
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
        <el-form-item label="模式名称" prop="name">
          <el-input v-model="formData.name" placeholder="请输入模式名称" />
        </el-form-item>

        <el-form-item label="描述" prop="description">
          <el-input
            v-model="formData.description"
            type="textarea"
            :rows="2"
            placeholder="请输入模式描述"
          />
        </el-form-item>

        <el-divider content-position="left">触发条件</el-divider>

        <div class="conditions-section">
          <div
            v-for="(condition, index) in formData.conditions"
            :key="index"
            class="condition-item"
          >
            <el-row :gutter="12">
              <el-col :span="6">
                <el-form-item
                  :prop="`conditions.${index}.metric`"
                  :rules="[{ required: true, message: '请选择指标', trigger: 'change' }]"
                  label-width="0"
                >
                  <el-select v-model="condition.metric" placeholder="指标" style="width: 100%">
                    <el-option
                      v-for="item in metricOptions"
                      :key="item.value"
                      :label="item.label"
                      :value="item.value"
                    />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="5">
                <el-form-item
                  v-if="needsMetricLabel(condition.metric)"
                  :prop="`conditions.${index}.metricLabel`"
                  label-width="0"
                >
                  <el-input v-model="condition.metricLabel" placeholder="接口名" />
                </el-form-item>
              </el-col>
              <el-col :span="5">
                <el-form-item
                  :prop="`conditions.${index}.operator`"
                  :rules="[{ required: true, message: '请选择运算符', trigger: 'change' }]"
                  label-width="0"
                >
                  <el-select v-model="condition.operator" placeholder="运算符" style="width: 100%">
                    <el-option
                      v-for="item in operatorOptions"
                      :key="item.value"
                      :label="item.label"
                      :value="item.value"
                    />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="5">
                <el-form-item
                  :prop="`conditions.${index}.threshold`"
                  :rules="[{ required: true, message: '请输入阈值', trigger: 'blur' }]"
                  label-width="0"
                >
                  <el-input-number
                    v-model="condition.threshold"
                    :min="0"
                    :precision="2"
                    placeholder="阈值"
                    style="width: 100%"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="3">
                <el-button
                  type="danger"
                  :icon="Delete"
                  circle
                  @click="removeCondition(index)"
                  :disabled="formData.conditions.length <= 1"
                />
              </el-col>
            </el-row>
          </div>
          <el-button type="primary" :icon="Plus" plain @click="addCondition">
            添加条件
          </el-button>
        </div>

        <el-divider content-position="left">修复脚本</el-divider>

        <el-form-item label="修复脚本" prop="remediationScript">
          <el-input
            v-model="formData.remediationScript"
            type="textarea"
            :rows="5"
            placeholder="输入 RouterOS 修复脚本"
          />
        </el-form-item>

        <el-form-item label="验证脚本">
          <el-input
            v-model="formData.verificationScript"
            type="textarea"
            :rows="3"
            placeholder="输入验证脚本（可选）"
          />
        </el-form-item>

        <el-divider content-position="left">设置</el-divider>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="启用状态">
              <el-switch v-model="formData.enabled" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="自动修复">
              <el-switch v-model="formData.autoHeal" />
              <el-tooltip content="启用后，匹配到故障时将自动执行修复脚本" placement="top">
                <el-icon class="help-icon"><i-ep-question-filled /></el-icon>
              </el-tooltip>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ isEditing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="故障模式详情"
      width="650px"
      destroy-on-close
    >
      <el-descriptions :column="2" border v-if="selectedPattern">
        <el-descriptions-item label="模式名称" :span="2">{{ selectedPattern.name }}</el-descriptions-item>
        <el-descriptions-item label="描述" :span="2">{{ selectedPattern.description || '-' }}</el-descriptions-item>
        <el-descriptions-item label="类型">
          <el-tag :type="selectedPattern.builtin ? 'warning' : 'primary'" size="small">
            {{ selectedPattern.builtin ? '内置' : '自定义' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="selectedPattern.enabled ? 'success' : 'info'" size="small">
            {{ selectedPattern.enabled ? '启用' : '禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="自动修复">
          <el-tag :type="selectedPattern.autoHeal ? 'success' : 'info'" size="small">
            {{ selectedPattern.autoHeal ? '启用' : '禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="条件数">{{ selectedPattern.conditions?.length || 0 }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatTime(selectedPattern.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="更新时间">{{ formatTime(selectedPattern.updatedAt) }}</el-descriptions-item>
      </el-descriptions>

      <el-divider content-position="left">触发条件</el-divider>
      <el-table :data="selectedPattern?.conditions || []" size="small" border>
        <el-table-column prop="metric" label="指标">
          <template #default="{ row }">
            {{ getMetricText(row.metric) }}
            <span v-if="row.metricLabel" class="metric-label">({{ row.metricLabel }})</span>
          </template>
        </el-table-column>
        <el-table-column label="条件" width="150">
          <template #default="{ row }">
            {{ getOperatorText(row.operator) }} {{ row.threshold }}{{ getMetricUnit(row.metric) }}
          </template>
        </el-table-column>
      </el-table>

      <el-divider content-position="left">修复脚本</el-divider>
      <el-input
        :model-value="selectedPattern?.remediationScript"
        type="textarea"
        :rows="4"
        readonly
      />

      <template v-if="selectedPattern?.verificationScript">
        <el-divider content-position="left">验证脚本</el-divider>
        <el-input
          :model-value="selectedPattern.verificationScript"
          type="textarea"
          :rows="3"
          readonly
        />
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editPattern(selectedPattern!)">编辑</el-button>
      </template>
    </el-dialog>

    <!-- Remediation Detail Dialog -->
    <el-dialog
      v-model="remediationDetailVisible"
      title="修复执行详情"
      width="650px"
      destroy-on-close
    >
      <el-descriptions :column="2" border v-if="selectedRemediation">
        <el-descriptions-item label="故障模式" :span="2">{{ selectedRemediation.patternName }}</el-descriptions-item>
        <el-descriptions-item label="执行状态">
          <el-tag :type="getRemediationStatusType(selectedRemediation.status)" size="small">
            {{ getRemediationStatusText(selectedRemediation.status) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="关联告警">{{ selectedRemediation.alertEventId }}</el-descriptions-item>
        <el-descriptions-item label="开始时间">{{ formatTime(selectedRemediation.startedAt) }}</el-descriptions-item>
        <el-descriptions-item label="完成时间">
          {{ selectedRemediation.completedAt ? formatTime(selectedRemediation.completedAt) : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="前置快照" v-if="selectedRemediation.preSnapshotId">
          <el-link type="primary" @click="viewSnapshot(selectedRemediation.preSnapshotId)">
            {{ selectedRemediation.preSnapshotId }}
          </el-link>
        </el-descriptions-item>
      </el-descriptions>

      <template v-if="selectedRemediation?.aiConfirmation">
        <el-divider content-position="left">AI 诊断确认</el-divider>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="确认结果">
            <el-tag :type="selectedRemediation.aiConfirmation.confirmed ? 'success' : 'warning'" size="small">
              {{ selectedRemediation.aiConfirmation.confirmed ? '已确认' : '未确认' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="置信度">
            {{ (selectedRemediation.aiConfirmation.confidence * 100).toFixed(0) }}%
          </el-descriptions-item>
          <el-descriptions-item label="分析理由" :span="2">
            {{ selectedRemediation.aiConfirmation.reasoning }}
          </el-descriptions-item>
        </el-descriptions>
      </template>

      <template v-if="selectedRemediation?.executionResult">
        <el-divider content-position="left">执行结果</el-divider>
        <el-input
          :model-value="selectedRemediation.executionResult.output"
          type="textarea"
          :rows="3"
          readonly
        />
        <el-alert
          v-if="selectedRemediation.executionResult.error"
          :title="selectedRemediation.executionResult.error"
          type="error"
          :closable="false"
          style="margin-top: 12px"
        />
      </template>

      <template v-if="selectedRemediation?.verificationResult">
        <el-divider content-position="left">验证结果</el-divider>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="验证状态">
            <el-tag :type="selectedRemediation.verificationResult.passed ? 'success' : 'danger'" size="small">
              {{ selectedRemediation.verificationResult.passed ? '通过' : '失败' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="验证消息">
            {{ selectedRemediation.verificationResult.message }}
          </el-descriptions-item>
        </el-descriptions>
      </template>

      <template #footer>
        <el-button @click="remediationDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>


<script setup lang="ts">
import { Plus, Refresh, Delete } from '@element-plus/icons-vue'

import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  faultPatternsApi,
  remediationsApi,
  type FaultPattern,
  type CreateFaultPatternInput,
  type RemediationExecution,
  type RemediationStatus,
  type MetricType,
  type AlertOperator
} from '@/api/ai-ops'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'
import { faultEnhancedApi } from '@/api/aiops-enhanced'

const router = useRouter()
const deviceStore = useDeviceStore()
const { currentDeviceId, devices } = storeToRefs(deviceStore)

// 设备名称映射
const getDeviceName = (deviceId?: string | null) => {
  if (!deviceId) return ''
  return devices.value.find(d => d.id === deviceId)?.name || ''
}

// State
const loading = ref(false)
const loadingHistory = ref(false)
const error = ref('')
const patterns = ref<FaultPattern[]>([])
const remediations = ref<RemediationExecution[]>([])
const activeTab = ref('patterns')
const pendingPatterns = ref<Array<{ id: string; name: string; description: string; detectedAt: string; confidence: number }>>([])
const repairHistoryList = ref<Array<{ id: string; patternName: string; action: string; result: string; timestamp: number }>>([])
const dialogVisible = ref(false)
const detailVisible = ref(false)
const remediationDetailVisible = ref(false)
const isEditing = ref(false)
const submitting = ref(false)
const togglingAutoHeal = ref<string | null>(null)
const selectedPattern = ref<FaultPattern | null>(null)
const selectedRemediation = ref<RemediationExecution | null>(null)
const editingPatternId = ref<string | null>(null)
const formRef = ref<FormInstance>()

// Form data
const getDefaultFormData = (): CreateFaultPatternInput => ({
  name: '',
  description: '',
  enabled: true,
  autoHeal: false,
  conditions: [{ metric: 'cpu', operator: 'gt', threshold: 90 }],
  remediationScript: '',
  verificationScript: ''
})

const formData = reactive<CreateFaultPatternInput>(getDefaultFormData())

// Form validation rules
const formRules: FormRules = {
  name: [
    { required: true, message: '请输入模式名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  description: [
    { max: 200, message: '描述不能超过 200 个字符', trigger: 'blur' }
  ],
  remediationScript: [
    { required: true, message: '请输入修复脚本', trigger: 'blur' }
  ]
}

// Options
const metricOptions = [
  { value: 'cpu', label: 'CPU 使用率' },
  { value: 'memory', label: '内存使用率' },
  { value: 'disk', label: '磁盘使用率' },
  { value: 'interface_status', label: '接口状态' },
  { value: 'interface_traffic', label: '接口流量' }
]

const operatorOptions = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'eq', label: '=' },
  { value: 'ne', label: '!=' }
]

// Load data on mount
onMounted(() => {
  loadPatterns()
  loadRemediationHistory()
  // Load enhanced data
  faultEnhancedApi.getPendingPatterns().then(res => {
    if (res.data.success && res.data.data) pendingPatterns.value = res.data.data
  }).catch(() => {})
  faultEnhancedApi.getRepairHistory().then(res => {
    if (res.data.success && res.data.data) repairHistoryList.value = res.data.data
  }).catch(() => {})
})

// Watch device changes
import { watch } from 'vue'
watch(currentDeviceId, () => {
  loadPatterns()
  loadRemediationHistory()
})

// Load fault patterns
const loadPatterns = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await faultPatternsApi.getAll(currentDeviceId.value)
    if (response.data.success && response.data.data) {
      patterns.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取故障模式失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取故障模式失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Load remediation history
const loadRemediationHistory = async () => {
  loadingHistory.value = true

  try {
    const response = await remediationsApi.getAll(50, currentDeviceId.value)
    if (response.data.success && response.data.data) {
      remediations.value = response.data.data
    }
  } catch (err) {
    console.error('Failed to load remediation history:', err)
  } finally {
    loadingHistory.value = false
  }
}

// Show create dialog
const showCreateDialog = () => {
  isEditing.value = false
  editingPatternId.value = null
  Object.assign(formData, getDefaultFormData())
  dialogVisible.value = true
}

// Edit pattern
const editPattern = (pattern: FaultPattern) => {
  isEditing.value = true
  editingPatternId.value = pattern.id
  Object.assign(formData, {
    name: pattern.name,
    description: pattern.description,
    enabled: pattern.enabled,
    autoHeal: pattern.autoHeal,
    conditions: pattern.conditions.map(c => ({ ...c })),
    remediationScript: pattern.remediationScript,
    verificationScript: pattern.verificationScript || ''
  })
  detailVisible.value = false
  dialogVisible.value = true
}

// Toggle pattern enabled/disabled
const toggleEnabled = async (pattern: FaultPattern) => {
  try {
    await faultPatternsApi.update(pattern.id, { enabled: !pattern.enabled })
    ElMessage.success(pattern.enabled ? '模式已禁用' : '模式已启用')
    await loadPatterns()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  }
}

// Toggle auto heal
const toggleAutoHeal = async (pattern: FaultPattern, value: boolean) => {
  togglingAutoHeal.value = pattern.id

  try {
    if (value) {
      await faultPatternsApi.enableAutoHeal(pattern.id)
      ElMessage.success('自动修复已启用')
    } else {
      await faultPatternsApi.disableAutoHeal(pattern.id)
      ElMessage.success('自动修复已禁用')
    }
    await loadPatterns()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    togglingAutoHeal.value = null
  }
}

// Delete pattern
const deletePattern = async (pattern: FaultPattern) => {
  try {
    await faultPatternsApi.delete(pattern.id)
    ElMessage.success('模式已删除')
    await loadPatterns()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败'
    ElMessage.error(message)
  }
}

// Add condition
const addCondition = () => {
  formData.conditions.push({ metric: 'cpu', operator: 'gt', threshold: 90 })
}

// Remove condition
const removeCondition = (index: number) => {
  if (formData.conditions.length > 1) {
    formData.conditions.splice(index, 1)
  }
}

// Check if metric needs label
const needsMetricLabel = (metric: MetricType): boolean => {
  return metric === 'interface_status' || metric === 'interface_traffic'
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
    const data: CreateFaultPatternInput = {
      ...formData,
      conditions: formData.conditions.map(c => ({
        ...c,
        metricLabel: needsMetricLabel(c.metric) ? c.metricLabel : undefined
      }))
    }

    if (isEditing.value && editingPatternId.value) {
      await faultPatternsApi.update(editingPatternId.value, data)
      ElMessage.success('模式已更新')
    } else {
      await faultPatternsApi.create({ ...data, deviceId: currentDeviceId.value })
      ElMessage.success('模式已创建')
    }

    dialogVisible.value = false
    await loadPatterns()
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
const handleRowClick = (row: FaultPattern) => {
  selectedPattern.value = row
  detailVisible.value = true
}

// View remediation detail
const viewRemediationDetail = (remediation: RemediationExecution) => {
  selectedRemediation.value = remediation
  remediationDetailVisible.value = true
}

// View snapshot
const viewSnapshot = (snapshotId: string) => {
  router.push(`/ai-ops/snapshots?id=${snapshotId}`)
}

// Utility functions
const getMetricText = (metric: MetricType): string => {
  const texts: Record<MetricType, string> = {
    cpu: 'CPU',
    memory: '内存',
    disk: '磁盘',
    interface_status: '接口状态',
    interface_traffic: '接口流量',
    syslog: 'Syslog'
  }
  return texts[metric] || metric
}

const getMetricUnit = (metric: MetricType): string => {
  if (metric === 'cpu' || metric === 'memory' || metric === 'disk') {
    return '%'
  }
  if (metric === 'interface_traffic') {
    return ' B/s'
  }
  return ''
}

const getOperatorText = (operator: AlertOperator): string => {
  const texts: Record<AlertOperator, string> = {
    gt: '>',
    lt: '<',
    eq: '=',
    ne: '≠',
    gte: '≥',
    lte: '≤'
  }
  return texts[operator] || operator
}

const getRemediationStatusType = (status: RemediationStatus): 'info' | 'primary' | 'success' | 'danger' | 'warning' => {
  const types: Record<RemediationStatus, 'info' | 'primary' | 'success' | 'danger' | 'warning'> = {
    pending: 'info',
    executing: 'primary',
    success: 'success',
    failed: 'danger',
    skipped: 'warning',
    rolled_back: 'warning'
  }
  return types[status]
}

const getRemediationStatusText = (status: RemediationStatus): string => {
  const texts: Record<RemediationStatus, string> = {
    pending: '等待中',
    executing: '执行中',
    success: '成功',
    failed: '失败',
    skipped: '已跳过',
    rolled_back: '已回滚'
  }
  return texts[status]
}

const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
</script>


<style scoped>
.fault-patterns-view {
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

/* Tabs */
.main-tabs {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 16px;
  box-shadow: var(--el-box-shadow-light);
}

.main-tabs :deep(.el-tabs__content) {
  padding-top: 16px;
}

/* Card Header */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Table */
.metric-label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.confidence-text {
  margin-left: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.no-data {
  color: var(--el-text-color-secondary);
}

/* Conditions Section */
.conditions-section {
  margin-bottom: 20px;
}

.condition-item {
  margin-bottom: 12px;
  padding: 16px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.condition-item :deep(.el-form-item) {
  margin-bottom: 0;
}

/* Help Icon */
.help-icon {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  cursor: help;
}

/* Responsive */
@media (max-width: 768px) {
  .header-actions {
    flex-direction: column;
    width: 100%;
    justify-content: flex-end;
  }

  .condition-item :deep(.el-col) {
    margin-bottom: 8px;
  }
}
</style>
