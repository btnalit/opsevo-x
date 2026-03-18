<template>
  <div class="feedback-analysis">
    <!-- Overview Cards -->
    <el-row :gutter="16" class="overview-cards">
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: #409eff;">
              <el-icon :size="24"><i-ep-document /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ overviewStats.totalRules }}</div>
              <div class="stat-label">规则总数</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: #67c23a;">
              <el-icon :size="24"><i-ep-circle-check-filled /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ overviewStats.totalUseful }}</div>
              <div class="stat-label">有用反馈</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: #f56c6c;">
              <el-icon :size="24"><i-ep-circle-close-filled /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ overviewStats.totalNotUseful }}</div>
              <div class="stat-label">无用反馈</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: #e6a23c;">
              <el-icon :size="24"><i-ep-warning /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ rulesNeedingReview.length }}</div>
              <div class="stat-label">需审查规则</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Tabs -->
    <el-tabs v-model="activeTab" class="main-tabs">
      <!-- All Rules Stats Tab -->
      <el-tab-pane label="规则误报率排行" name="ranking">
        <!-- Loading State -->
        <el-skeleton v-if="loading && allStats.length === 0" :rows="5" animated />

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
            <el-button type="primary" size="small" @click="loadStats">
              重新加载
            </el-button>
          </template>
        </el-alert>

        <!-- Empty State -->
        <el-empty v-else-if="allStats.length === 0" description="暂无反馈统计数据" />

        <!-- Stats Table -->
        <div v-else>
          <el-table
            v-loading="loading"
            :data="sortedStats"
            stripe
            style="width: 100%"
            :default-sort="{ prop: 'falsePositiveRate', order: 'descending' }"
            @sort-change="handleSortChange"
          >
            <el-table-column prop="ruleId" label="规则 ID" width="200" show-overflow-tooltip />
            <el-table-column prop="totalAlerts" label="告警总数" width="100" sortable="custom" align="center" />
            <el-table-column prop="usefulCount" label="有用" width="80" align="center">
              <template #default="{ row }">
                <span class="useful-count">{{ row.usefulCount }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="notUsefulCount" label="无用" width="80" align="center">
              <template #default="{ row }">
                <span class="not-useful-count">{{ row.notUsefulCount }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="falsePositiveRate" label="误报率" width="180" sortable="custom">
              <template #default="{ row }">
                <div class="rate-cell">
                  <el-progress
                    :percentage="Math.round(row.falsePositiveRate * 100)"
                    :color="getFalsePositiveColor(row.falsePositiveRate)"
                    :stroke-width="10"
                    style="width: 100px"
                  />
                  <span class="rate-text" :style="{ color: getFalsePositiveColor(row.falsePositiveRate) }">
                    {{ formatPercent(row.falsePositiveRate) }}
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.falsePositiveRate >= reviewThreshold" type="danger" size="small">
                  需审查
                </el-tag>
                <el-tag v-else-if="row.falsePositiveRate >= 0.15" type="warning" size="small">
                  关注
                </el-tag>
                <el-tag v-else type="success" size="small">
                  正常
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" text @click="showSuggestions(row)">
                  <el-icon><i-ep-link /></el-icon>
                  关联建议
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <!-- Pagination -->
          <div class="pagination-container">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[10, 20, 50]"
              :total="allStats.length"
              layout="total, sizes, prev, pager, next"
              background
            />
          </div>
        </div>
      </el-tab-pane>

      <!-- Knowledge Feedback Tab -->
      <el-tab-pane label="知识条目评分" name="knowledge">
        <!-- Loading State -->
        <el-skeleton v-if="knowledgeLoading && knowledgeFeedback.length === 0" :rows="5" animated />

        <!-- Empty State -->
        <el-empty v-else-if="knowledgeFeedback.length === 0" description="暂无知识条目反馈数据" />

        <!-- Knowledge Feedback Table -->
        <el-table
          v-else
          v-loading="knowledgeLoading"
          :data="knowledgeFeedback"
          stripe
          style="width: 100%"
        >
          <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
          <el-table-column prop="type" label="类型" width="100">
            <template #default="{ row }">
              <el-tag :type="getTypeTagType(row.type)" size="small">
                {{ getTypeText(row.type) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="评分" width="120" align="center">
            <template #default="{ row }">
              <div class="score-cell">
                <el-icon color="#e6a23c"><i-ep-star /></el-icon>
                <span>{{ formatScore(row.feedbackScore) }}</span>
                <span class="feedback-count">({{ row.feedbackCount }})</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="usageCount" label="使用次数" width="100" align="center" />
          <el-table-column label="关联规则" width="100" align="center">
            <template #default="{ row }">
              <el-badge :value="row.linkedRules?.length || 0" :type="row.linkedRules?.length ? 'primary' : 'info'" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" size="small" text @click="viewKnowledgeEntry(row)">
                详情
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- Rules Needing Review Tab -->
      <el-tab-pane name="review">
        <template #label>
          <span>
            需审查规则
            <el-badge v-if="rulesNeedingReview.length > 0" :value="rulesNeedingReview.length" type="danger" class="tab-badge" />
          </span>
        </template>

        <!-- Threshold Setting -->
        <el-card class="threshold-card" shadow="hover">
          <div class="threshold-setting">
            <span class="threshold-label">误报率阈值：</span>
            <el-slider
              v-model="reviewThresholdPercent"
              :min="10"
              :max="80"
              :step="5"
              :format-tooltip="(val: number) => `${val}%`"
              style="width: 200px"
              @change="loadRulesNeedingReview"
            />
            <span class="threshold-value">{{ reviewThresholdPercent }}%</span>
            <el-tooltip content="误报率超过此阈值的规则将被标记为需要审查" placement="top">
              <el-icon class="help-icon"><i-ep-question-filled /></el-icon>
            </el-tooltip>
          </div>
        </el-card>

        <!-- Loading State -->
        <el-skeleton v-if="reviewLoading && rulesNeedingReview.length === 0" :rows="3" animated />

        <!-- Empty State -->
        <el-empty v-else-if="rulesNeedingReview.length === 0" description="暂无需要审查的规则">
          <template #description>
            <p>所有规则的误报率都在 {{ reviewThresholdPercent }}% 以下</p>
          </template>
        </el-empty>

        <!-- Review List -->
        <div v-else class="review-list">
          <el-card
            v-for="rule in rulesNeedingReview"
            :key="rule.ruleId"
            class="review-card"
            shadow="hover"
          >
            <div class="review-header">
              <div class="review-title">
                <el-icon color="#f56c6c"><i-ep-warning /></el-icon>
                <span class="rule-id">{{ rule.ruleId }}</span>
              </div>
              <el-tag type="danger" size="small">
                误报率 {{ formatPercent(rule.falsePositiveRate) }}
              </el-tag>
            </div>
            <div class="review-body">
              <div class="review-stats">
                <div class="stat-item">
                  <span class="stat-label">告警总数</span>
                  <span class="stat-value">{{ rule.totalAlerts }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">有用反馈</span>
                  <span class="stat-value useful">{{ rule.usefulCount }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">无用反馈</span>
                  <span class="stat-value not-useful">{{ rule.notUsefulCount }}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">最后更新</span>
                  <span class="stat-value">{{ formatDateTime(rule.lastUpdated) }}</span>
                </div>
              </div>
              <el-progress
                :percentage="Math.round(rule.falsePositiveRate * 100)"
                :color="getFalsePositiveColor(rule.falsePositiveRate)"
                :stroke-width="12"
                class="review-progress"
              />
            </div>
            <div class="review-actions">
              <el-button type="primary" size="small" @click="showSuggestions(rule)">
                <el-icon><i-ep-link /></el-icon>
                关联建议
              </el-button>
              <el-button size="small" @click="showConvertDialog(rule)">
                <el-icon><i-ep-document-add /></el-icon>
                转换为知识
              </el-button>
            </div>
          </el-card>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Association Suggestions Dialog -->
    <el-dialog
      v-model="suggestionsDialogVisible"
      title="知识关联建议"
      width="700px"
      destroy-on-close
    >
      <div v-if="selectedRule" class="suggestions-content">
        <div class="rule-info">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="规则 ID">{{ selectedRule.ruleId }}</el-descriptions-item>
            <el-descriptions-item label="误报率">
              <span :style="{ color: getFalsePositiveColor(selectedRule.falsePositiveRate) }">
                {{ formatPercent(selectedRule.falsePositiveRate) }}
              </span>
            </el-descriptions-item>
            <el-descriptions-item label="告警总数">{{ selectedRule.totalAlerts }}</el-descriptions-item>
            <el-descriptions-item label="无用反馈">{{ selectedRule.notUsefulCount }}</el-descriptions-item>
          </el-descriptions>
        </div>

        <el-divider content-position="left">推荐关联的知识条目</el-divider>

        <el-skeleton v-if="suggestionsLoading" :rows="3" animated />

        <el-empty v-else-if="suggestions.length === 0" description="暂无推荐的知识条目" />

        <div v-else class="suggestions-list">
          <el-card
            v-for="suggestion in suggestions"
            :key="suggestion.entry.id"
            class="suggestion-card"
            shadow="hover"
          >
            <div class="suggestion-header">
              <div class="suggestion-title">
                <el-tag :type="getTypeTagType(suggestion.entry.type)" size="small">
                  {{ getTypeText(suggestion.entry.type) }}
                </el-tag>
                <span class="title-text">{{ suggestion.entry.title }}</span>
              </div>
              <div class="suggestion-score">
                <el-progress
                  :percentage="Math.round(suggestion.score * 100)"
                  :stroke-width="8"
                  :color="getScoreColor(suggestion.score)"
                  style="width: 60px"
                />
                <span class="score-text">{{ (suggestion.score * 100).toFixed(0) }}%</span>
              </div>
            </div>
            <div class="suggestion-content">
              {{ truncateContent(suggestion.entry.content) }}
            </div>
            <div class="suggestion-actions">
              <el-button type="primary" size="small" @click="linkKnowledge(suggestion.entry.id)">
                <el-icon><i-ep-link /></el-icon>
                关联
              </el-button>
            </div>
          </el-card>
        </div>
      </div>
      <template #footer>
        <el-button @click="suggestionsDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- Convert to Knowledge Dialog -->
    <el-dialog
      v-model="convertDialogVisible"
      title="转换为知识条目"
      width="600px"
      destroy-on-close
    >
      <el-form ref="convertFormRef" :model="convertForm" :rules="convertFormRules" label-width="100px">
        <el-form-item label="标题" prop="title">
          <el-input v-model="convertForm.title" placeholder="输入知识标题" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input
            v-model="convertForm.content"
            type="textarea"
            :rows="6"
            placeholder="输入知识内容"
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="convertForm.category" placeholder="输入分类" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select
            v-model="convertForm.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入标签"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="关联规则">
          <el-switch v-model="convertForm.linkToRule" />
          <span class="link-hint">自动关联到当前规则</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="convertDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="converting" @click="convertToKnowledge">
          转换
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { feedbackApi, type FeedbackStats } from '@/api/ai-ops'
import { knowledgeApi, type KnowledgeEntry, type KnowledgeSearchResult, type KnowledgeEntryType } from '@/api/rag'

// Emits
const emit = defineEmits<{
  (e: 'view-entry', entry: KnowledgeEntry): void
  (e: 'refresh'): void
}>()

// State
const loading = ref(false)
const reviewLoading = ref(false)
const knowledgeLoading = ref(false)
const suggestionsLoading = ref(false)
const converting = ref(false)
const error = ref('')
const allStats = ref<FeedbackStats[]>([])
const rulesNeedingReview = ref<FeedbackStats[]>([])
const knowledgeFeedback = ref<Array<KnowledgeEntry & { linkedRules?: string[] }>>([])
const activeTab = ref('ranking')
const reviewThresholdPercent = ref(30)

// Pagination
const currentPage = ref(1)
const pageSize = ref(10)

// Sort state
const sortProp = ref('falsePositiveRate')
const sortOrder = ref<'ascending' | 'descending'>('descending')

// Dialog state
const suggestionsDialogVisible = ref(false)
const convertDialogVisible = ref(false)
const selectedRule = ref<FeedbackStats | null>(null)
const suggestions = ref<KnowledgeSearchResult[]>([])

// Convert form
const convertFormRef = ref<FormInstance>()
const convertForm = reactive({
  title: '',
  content: '',
  category: 'feedback',
  tags: [] as string[],
  linkToRule: true
})

const convertFormRules: FormRules = {
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入内容', trigger: 'blur' }]
}

// Computed
const reviewThreshold = computed(() => reviewThresholdPercent.value / 100)

const overviewStats = computed(() => {
  const totalRules = allStats.value.length
  const totalUseful = allStats.value.reduce((sum, s) => sum + s.usefulCount, 0)
  const totalNotUseful = allStats.value.reduce((sum, s) => sum + s.notUsefulCount, 0)
  return { totalRules, totalUseful, totalNotUseful }
})

const sortedStats = computed(() => {
  const sorted = [...allStats.value].sort((a, b) => {
    const aVal = a[sortProp.value as keyof FeedbackStats] as number
    const bVal = b[sortProp.value as keyof FeedbackStats] as number
    if (sortOrder.value === 'ascending') {
      return aVal - bVal
    }
    return bVal - aVal
  })
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return sorted.slice(start, end)
})

// Load data on mount
onMounted(() => {
  loadStats()
  loadKnowledgeFeedback()
})

// Load all stats
const loadStats = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await feedbackApi.getStats()
    if (response.data.success && response.data.data) {
      allStats.value = Array.isArray(response.data.data) ? response.data.data : [response.data.data]
    } else {
      throw new Error(response.data.error || '获取反馈统计失败')
    }
    await loadRulesNeedingReview()
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取反馈统计失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Load rules needing review
const loadRulesNeedingReview = async () => {
  reviewLoading.value = true

  try {
    const response = await feedbackApi.getRulesNeedingReview(reviewThreshold.value)
    if (response.data.success && response.data.data) {
      rulesNeedingReview.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取需审查规则失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取需审查规则失败'
    ElMessage.error(message)
  } finally {
    reviewLoading.value = false
  }
}

// Load knowledge feedback
const loadKnowledgeFeedback = async () => {
  knowledgeLoading.value = true

  try {
    const response = await knowledgeApi.getAll({ limit: 100 })
    if (response.data.success && response.data.data) {
      // Filter entries with feedback and sort by feedback score
      knowledgeFeedback.value = response.data.data
        .filter(entry => entry.metadata?.feedbackCount > 0)
        .sort((a, b) => (b.metadata?.feedbackScore || 0) - (a.metadata?.feedbackScore || 0))
        .map(entry => ({
          ...entry,
          linkedRules: entry.metadata?.linkedRuleIds || []
        }))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取知识条目反馈失败'
    ElMessage.error(message)
  } finally {
    knowledgeLoading.value = false
  }
}

// Handle sort change
const handleSortChange = ({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) => {
  sortProp.value = prop || 'falsePositiveRate'
  sortOrder.value = order || 'descending'
}

// Show suggestions dialog
const showSuggestions = async (rule: FeedbackStats) => {
  selectedRule.value = rule
  suggestionsDialogVisible.value = true
  suggestionsLoading.value = true
  suggestions.value = []

  try {
    // Search for related knowledge entries based on rule ID
    const response = await knowledgeApi.search({
      query: rule.ruleId,
      limit: 5,
      minScore: 0.3
    })
    if (response.data.success && response.data.data) {
      suggestions.value = response.data.data
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取关联建议失败'
    ElMessage.error(message)
  } finally {
    suggestionsLoading.value = false
  }
}

// Link knowledge entry to rule
const linkKnowledge = async (entryId: string) => {
  if (!selectedRule.value) return

  try {
    // Update knowledge entry with linked rule
    const entry = suggestions.value.find(s => s.entry.id === entryId)?.entry
    if (entry) {
      const linkedRuleIds = entry.metadata?.linkedRuleIds || []
      if (!linkedRuleIds.includes(selectedRule.value.ruleId)) {
        linkedRuleIds.push(selectedRule.value.ruleId)
        await knowledgeApi.update(entryId, {
          metadata: {
            ...entry.metadata,
            linkedRuleIds
          }
        })
        ElMessage.success('关联成功')
        // Remove from suggestions
        suggestions.value = suggestions.value.filter(s => s.entry.id !== entryId)
        emit('refresh')
      } else {
        ElMessage.warning('已经关联过此规则')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '关联失败'
    ElMessage.error(message)
  }
}

// Show convert dialog
const showConvertDialog = (rule: FeedbackStats) => {
  selectedRule.value = rule
  convertForm.title = `告警规则反馈: ${rule.ruleId}`
  convertForm.content = `## 规则信息\n\n- 规则 ID: ${rule.ruleId}\n- 告警总数: ${rule.totalAlerts}\n- 有用反馈: ${rule.usefulCount}\n- 无用反馈: ${rule.notUsefulCount}\n- 误报率: ${formatPercent(rule.falsePositiveRate)}\n\n## 分析\n\n请在此处添加分析内容...`
  convertForm.category = 'feedback'
  convertForm.tags = ['from_feedback', rule.ruleId]
  convertForm.linkToRule = true
  convertDialogVisible.value = true
}

// Convert to knowledge
const convertToKnowledge = async () => {
  if (!convertFormRef.value || !selectedRule.value) return

  try {
    await convertFormRef.value.validate()
  } catch {
    return
  }

  converting.value = true

  try {
    const linkedRuleIds = convertForm.linkToRule ? [selectedRule.value.ruleId] : []
    
    const response = await knowledgeApi.create({
      type: 'manual' as KnowledgeEntryType,
      title: convertForm.title,
      content: convertForm.content,
      metadata: {
        category: convertForm.category,
        tags: convertForm.tags,
        linkedRuleIds,
        createdFromFeedback: true
      }
    })

    if (response.data.success) {
      ElMessage.success('转换成功')
      convertDialogVisible.value = false
      emit('refresh')
      loadKnowledgeFeedback()
    } else {
      throw new Error(response.data.error || '转换失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '转换失败'
    ElMessage.error(message)
  } finally {
    converting.value = false
  }
}

// View knowledge entry
const viewKnowledgeEntry = (entry: KnowledgeEntry) => {
  emit('view-entry', entry)
}

// Utility functions
const formatDateTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const formatPercent = (rate: number): string => {
  return `${(rate * 100).toFixed(1)}%`
}

const formatScore = (score?: number): string => {
  if (score === undefined || score === null) return '-'
  return score.toFixed(1)
}

const getFalsePositiveColor = (rate: number): string => {
  if (rate >= 0.3) return '#f56c6c'
  if (rate >= 0.15) return '#e6a23c'
  return '#67c23a'
}

const getScoreColor = (score: number): string => {
  if (score >= 0.8) return '#67c23a'
  if (score >= 0.5) return '#e6a23c'
  return '#f56c6c'
}

const getTypeText = (type: string): string => {
  const typeMap: Record<string, string> = {
    alert: '告警',
    remediation: '修复方案',
    config: '配置',
    pattern: '故障模式',
    manual: '手动添加'
  }
  return typeMap[type] || type
}

const getTypeTagType = (type: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  const typeMap: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    alert: 'danger',
    remediation: 'success',
    config: 'info',
    pattern: 'warning',
    manual: 'primary'
  }
  return typeMap[type] || 'primary'
}

const truncateContent = (content: string, maxLength = 150): string => {
  if (content.length <= maxLength) return content
  return content.substring(0, maxLength) + '...'
}

// Expose refresh method
defineExpose({
  refresh: () => {
    loadStats()
    loadKnowledgeFeedback()
  }
})
</script>

<style scoped>
.feedback-analysis {
  padding: 0;
}

/* Overview Cards */
.overview-cards {
  margin-bottom: 20px;
}

.stat-card {
  margin-bottom: 16px;
}

.stat-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.stat-info {
  flex: 1;
}

.stat-info .stat-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  line-height: 1.2;
}

.stat-info .stat-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}

/* Tabs */
.main-tabs {
  background: var(--el-bg-color-overlay);
  border-radius: 8px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
}

.tab-badge {
  margin-left: 6px;
}

/* Table */
.rate-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rate-text {
  font-weight: 600;
  min-width: 50px;
}

.useful-count {
  color: #67c23a;
  font-weight: 600;
}

.not-useful-count {
  color: #f56c6c;
  font-weight: 600;
}

/* Score Cell */
.score-cell {
  display: flex;
  align-items: center;
  gap: 4px;
}

.feedback-count {
  color: #909399;
  font-size: 12px;
}

/* Pagination */
.pagination-container {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* Threshold Card */
.threshold-card {
  margin-bottom: 16px;
}

.threshold-setting {
  display: flex;
  align-items: center;
  gap: 16px;
}

.threshold-label {
  font-size: 14px;
  color: #606266;
}

.threshold-value {
  font-size: 14px;
  font-weight: 600;
  color: #409eff;
  min-width: 40px;
}

.help-icon {
  color: #909399;
  cursor: help;
}

/* Review List */
.review-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.review-card {
  border-left: 4px solid #f56c6c;
}

.review-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.review-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rule-id {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.review-body {
  margin-bottom: 16px;
}

.review-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin-bottom: 12px;
}

.review-stats .stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.review-stats .stat-label {
  font-size: 12px;
  color: #909399;
}

.review-stats .stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.review-stats .stat-value.useful {
  color: #67c23a;
}

.review-stats .stat-value.not-useful {
  color: #f56c6c;
}

.review-progress {
  margin-top: 8px;
}

.review-actions {
  display: flex;
  gap: 8px;
}

/* Suggestions Dialog */
.suggestions-content {
  max-height: 500px;
  overflow-y: auto;
}

.rule-info {
  margin-bottom: 16px;
}

.suggestions-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.suggestion-card {
  cursor: default;
}

.suggestion-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.suggestion-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.suggestion-score {
  display: flex;
  align-items: center;
  gap: 8px;
}

.score-text {
  font-size: 12px;
  font-weight: 600;
  color: #409eff;
}

.suggestion-content {
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 8px;
}

.suggestion-actions {
  display: flex;
  justify-content: flex-end;
}

/* Convert Dialog */
.link-hint {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}

/* Responsive */
@media (max-width: 768px) {
  .threshold-setting {
    flex-wrap: wrap;
  }

  .review-stats {
    gap: 16px;
  }

  .suggestion-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}
</style>
