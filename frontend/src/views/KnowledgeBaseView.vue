<template>
  <div class="knowledge-base-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>知识库管理</span>
            <el-badge v-if="stats?.totalEntries" :value="stats.totalEntries" type="primary" style="margin-left: 8px" />
          </div>
          <div class="header-actions">
            <el-button type="success" :icon="Upload" @click="showUploadDialog">
              上传文件
            </el-button>
            <el-button type="primary" :icon="Plus" @click="showAddDialog">
              添加知识
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadData">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Stats Cards -->
    <el-row :gutter="16" class="stats-cards">
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-primary);">
              <el-icon :size="24"><i-ep-document /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ stats?.totalEntries || 0 }}</div>
              <div class="stat-label">知识条目</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-success);">
              <el-icon :size="24"><i-ep-trend-charts /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ stats?.recentAdditions || 0 }}</div>
              <div class="stat-label">近期新增</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-warning);">
              <el-icon :size="24"><i-ep-star /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ formatScore(stats?.averageFeedbackScore) }}</div>
              <div class="stat-label">平均评分</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-danger);">
              <el-icon :size="24"><i-ep-warning /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ stats?.staleEntries || 0 }}</div>
              <div class="stat-label">过期条目</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Search and Filter -->
    <el-card class="search-card" shadow="hover">
      <el-form :inline="true" class="search-form">
        <el-form-item>
          <el-input
            v-model="searchQuery"
            placeholder="语义搜索知识库..."
            :prefix-icon="Search"
            clearable
            style="width: 300px"
            @keyup.enter="handleSearch"
          />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="typeFilter" placeholder="全部" clearable style="width: 140px" @change="loadEntries">
            <el-option label="告警" value="alert" />
            <el-option label="修复方案" value="remediation" />
            <el-option label="配置" value="config" />
            <el-option label="故障模式" value="pattern" />
            <el-option label="手动添加" value="manual" />
            <el-option label="反思记录" value="learning" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="categoryFilter" placeholder="全部" clearable style="width: 140px" @change="loadEntries">
            <el-option v-for="cat in categories" :key="cat" :label="cat" :value="cat" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" :loading="searching" @click="handleSearch">
            搜索
          </el-button>
          <el-button :icon="RefreshRight" @click="resetFilters">
            重置
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- Main Content -->
    <el-card class="main-card" shadow="hover">
      <!-- Tabs -->
      <el-tabs v-model="activeTab">
        <el-tab-pane label="知识列表" name="list">
          <!-- Feedback Analysis Tab is added below -->
          <!-- Loading State -->
          <el-skeleton v-if="loading && entries.length === 0" :rows="5" animated />

          <!-- Error State -->
          <el-alert
            v-else-if="error"
            :title="error"
            type="error"
            show-icon
            closable
            @close="error = ''"
          />

          <!-- Empty State -->
          <el-empty v-else-if="displayEntries.length === 0" description="暂无知识条目">
            <el-button type="primary" @click="showAddDialog">添加知识</el-button>
          </el-empty>

          <!-- Entries Table -->
          <el-table
            v-else
            v-loading="loading"
            :data="displayEntries"
            stripe
            style="width: 100%"
            @row-click="showEntryDetail"
          >
            <el-table-column prop="type" label="类型" width="100">
              <template #default="{ row }">
                <el-tag :type="getTypeTagType(row.type)" size="small">
                  {{ getTypeText(row.type) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
            <el-table-column prop="metadata.category" label="分类" width="120" />
            <el-table-column label="评分" width="100" align="center">
              <template #default="{ row }">
                <div class="score-cell">
                  <el-icon color="#e6a23c"><i-ep-star /></el-icon>
                  <span>{{ formatScore(row.metadata?.feedbackScore) }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="使用次数" width="100" align="center">
              <template #default="{ row }">
                {{ row.metadata?.usageCount || 0 }}
              </template>
            </el-table-column>
            <el-table-column prop="metadata.timestamp" label="创建时间" width="180">
              <template #default="{ row }">
                {{ formatDateTime(row.metadata?.timestamp) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" text @click.stop="showEntryDetail(row)">
                  详情
                </el-button>
                <el-button type="danger" size="small" text @click.stop="confirmDelete(row)">
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <!-- Pagination -->
          <div class="pagination-container">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[10, 20, 50, 100]"
              :total="totalEntries"
              layout="total, sizes, prev, pager, next"
              background
              @size-change="loadEntries"
              @current-change="loadEntries"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="搜索结果" name="search" v-if="searchResults.length > 0">
          <div class="search-results">
            <div class="search-info">
              找到 {{ searchResults.length }} 条相关结果
            </div>
            <el-card
              v-for="result in searchResults"
              :key="result.entry.id"
              class="result-card"
              shadow="hover"
              @click="showEntryDetail(result.entry)"
            >
              <div class="result-header">
                <div class="result-title">
                  <el-tag :type="getTypeTagType(result.entry.type)" size="small">
                    {{ getTypeText(result.entry.type) }}
                  </el-tag>
                  <span class="title-text">{{ result.entry.title }}</span>
                </div>
                <div class="result-score">
                  <el-progress
                    :percentage="Math.round(result.score * 100)"
                    :stroke-width="8"
                    :color="getScoreColor(result.score)"
                    style="width: 80px"
                  />
                  <span class="score-text">{{ (result.score * 100).toFixed(1) }}%</span>
                </div>
              </div>
              <div class="result-content">
                {{ truncateContent(result.entry.content) }}
              </div>
              <div class="result-meta">
                <span>分类: {{ result.entry.metadata?.category }}</span>
                <span>使用: {{ result.entry.metadata?.usageCount || 0 }} 次</span>
                <span>{{ formatDateTime(result.entry.metadata?.timestamp) }}</span>
              </div>
            </el-card>
          </div>
        </el-tab-pane>

        <el-tab-pane label="类型分布" name="distribution">
          <div class="distribution-content">
            <el-row :gutter="20">
              <el-col :span="12">
                <div class="distribution-section">
                  <h4>按类型分布</h4>
                  <div class="distribution-list">
                    <div v-for="(count, type) in stats?.byType" :key="type" class="distribution-item">
                      <div class="item-label">
                        <el-tag :type="getTypeTagType(type as string)" size="small">
                          {{ getTypeText(type as string) }}
                        </el-tag>
                      </div>
                      <div class="item-bar">
                        <el-progress
                          :percentage="getPercentage(count, stats?.totalEntries)"
                          :stroke-width="12"
                          :show-text="false"
                        />
                      </div>
                      <div class="item-count">{{ count }}</div>
                    </div>
                  </div>
                </div>
              </el-col>
              <el-col :span="12">
                <div class="distribution-section">
                  <h4>按分类分布</h4>
                  <div class="distribution-list">
                    <div v-for="(count, category) in stats?.byCategory" :key="category" class="distribution-item">
                      <div class="item-label category-label">{{ category }}</div>
                      <div class="item-bar">
                        <el-progress
                          :percentage="getPercentage(count, stats?.totalEntries)"
                          :stroke-width="12"
                          :show-text="false"
                          color="#67c23a"
                        />
                      </div>
                      <div class="item-count">{{ count }}</div>
                    </div>
                  </div>
                </div>
              </el-col>
            </el-row>
          </div>
        </el-tab-pane>

        <!-- Feedback Analysis Tab -->
        <el-tab-pane label="反馈分析" name="feedback">
          <FeedbackAnalysis
            @view-entry="showEntryDetail"
            @refresh="loadData"
          />
        </el-tab-pane>

        <!-- 知识图谱 Tab -->
        <el-tab-pane label="知识图谱" name="graph">
          <div style="margin-bottom: 16px;">
            <el-row :gutter="16">
              <el-col :span="8">
                <el-card shadow="hover">
                  <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: var(--el-color-primary);">{{ graphStats.totalNodes }}</div>
                    <div style="color: var(--el-text-color-secondary);">节点总数</div>
                  </div>
                </el-card>
              </el-col>
              <el-col :span="8">
                <el-card shadow="hover">
                  <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: var(--el-color-success);">{{ graphStats.totalEdges }}</div>
                    <div style="color: var(--el-text-color-secondary);">关系总数</div>
                  </div>
                </el-card>
              </el-col>
              <el-col :span="8">
                <el-card shadow="hover">
                  <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; color: var(--el-color-warning);">{{ Object.keys(graphStats.categories).length }}</div>
                    <div style="color: var(--el-text-color-secondary);">类别数</div>
                  </div>
                </el-card>
              </el-col>
            </el-row>
          </div>
          <el-empty description="知识图谱可视化开发中" :image-size="120" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Add/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingEntry ? '编辑知识条目' : '添加知识条目'"
      width="700px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="formData" :rules="formRules" label-width="100px">
        <el-form-item label="类型" prop="type">
          <el-select v-model="formData.type" placeholder="选择类型" style="width: 100%">
            <el-option label="告警" value="alert" />
            <el-option label="修复方案" value="remediation" />
            <el-option label="配置" value="config" />
            <el-option label="故障模式" value="pattern" />
            <el-option label="手动添加" value="manual" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题" prop="title">
          <el-input v-model="formData.title" placeholder="输入知识标题" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input
            v-model="formData.content"
            type="textarea"
            :rows="8"
            placeholder="输入知识内容"
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="formData.category" placeholder="输入分类" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select
            v-model="formData.tags"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入标签"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEntry">
          {{ editingEntry ? '保存' : '添加' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="知识条目详情"
      width="800px"
      destroy-on-close
    >
      <template v-if="selectedEntry">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="ID">{{ selectedEntry.id }}</el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag :type="getTypeTagType(selectedEntry.type)" size="small">
              {{ getTypeText(selectedEntry.type) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="标题" :span="2">{{ selectedEntry.title }}</el-descriptions-item>
          <el-descriptions-item v-if="selectedEntry.type === 'learning' || (selectedEntry as any).intent" label="意图">
            <el-tag size="small">{{ (selectedEntry as any).intent || selectedEntry.metadata?.originalData?.intent }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="(selectedEntry as any).confidence" label="置信度">
            <el-progress :percentage="Math.round((selectedEntry as any).confidence * 100)" :color="getScoreColor((selectedEntry as any).confidence)" />
          </el-descriptions-item>
          <el-descriptions-item v-if="(selectedEntry as any).originalMessage" label="原始消息" :span="2">
            <span class="original-message-text">{{ (selectedEntry as any).originalMessage }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="分类">{{ selectedEntry.metadata?.category }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ selectedEntry.metadata?.source }}</el-descriptions-item>
          <el-descriptions-item label="使用次数">{{ selectedEntry.metadata?.usageCount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="反馈评分">
            <div class="score-cell">
              <el-icon color="#e6a23c"><i-ep-star /></el-icon>
              <span>{{ formatScore(selectedEntry.metadata?.feedbackScore) }}</span>
              <span class="feedback-count">({{ selectedEntry.metadata?.feedbackCount || 0 }} 次反馈)</span>
            </div>
          </el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatDateTime(selectedEntry.metadata?.timestamp) }}</el-descriptions-item>
          <el-descriptions-item label="最后使用">{{ selectedEntry.metadata?.lastUsed ? formatDateTime(selectedEntry.metadata.lastUsed) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="标签" :span="2">
            <el-tag v-for="tag in selectedEntry.metadata?.tags" :key="tag" size="small" class="tag-item">
              {{ tag }}
            </el-tag>
            <span v-if="!selectedEntry.metadata?.tags?.length">-</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">内容</el-divider>
        <div class="content-box">
          <pre>{{ selectedEntry.content }}</pre>
        </div>

        <!-- Feedback Section -->
        <el-divider content-position="left">反馈评价</el-divider>
        <div class="feedback-section">
          <span class="feedback-label">为此知识条目评分：</span>
          <el-rate
            v-model="feedbackScore"
            :colors="['#f56c6c', '#e6a23c', '#67c23a']"
            show-text
            :texts="['很差', '较差', '一般', '较好', '很好']"
          />
          <el-button
            type="primary"
            size="small"
            :loading="submittingFeedback"
            :disabled="feedbackScore === 0"
            @click="submitFeedback"
          >
            提交反馈
          </el-button>
        </div>
      </template>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editEntry(selectedEntry!)">编辑</el-button>
        <el-button type="danger" @click="confirmDelete(selectedEntry!)">删除</el-button>
      </template>
    </el-dialog>

    <!-- Upload Dialog -->
    <el-dialog
      v-model="uploadDialogVisible"
      title="上传文件到知识库"
      width="700px"
      destroy-on-close
    >
      <FileUploader
        :multiple="true"
        :max-files="10"
        @success="handleUploadSuccess"
        @error="handleUploadError"
        @preview="handleUploadPreview"
      />
    </el-dialog>

    <!-- Upload Result Preview -->
    <UploadResultPreview
      v-model="previewDialogVisible"
      :results="uploadResults"
      @confirm="handlePreviewConfirm"
      @entry-updated="handleEntryUpdated"
    />
  </div>
</template>

<script setup lang="ts">
import { Upload, Plus, Refresh, Search, RefreshRight } from '@element-plus/icons-vue'

import { ref, computed, onMounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  knowledgeApi,
  type KnowledgeEntry,
  type KnowledgeEntryType,
  type KnowledgeStats,
  type KnowledgeSearchResult,
  type CreateKnowledgeEntryInput,
  type ProcessedFileResult
} from '@/api/rag'
import FeedbackAnalysis from '@/components/FeedbackAnalysis.vue'
import FileUploader from '@/components/FileUploader.vue'
import UploadResultPreview from '@/components/UploadResultPreview.vue'
import { knowledgeEnhancedApi } from '@/api/aiops-enhanced'

// Route
const route = useRoute()
const router = useRouter()

// State
const loading = ref(false)
const searching = ref(false)
const saving = ref(false)
const error = ref('')
const entries = ref<KnowledgeEntry[]>([])
const searchResults = ref<KnowledgeSearchResult[]>([])
const stats = ref<KnowledgeStats | null>(null)
const activeTab = ref('list')
const graphStats = ref<{ totalNodes: number; totalEdges: number; categories: Record<string, number> }>({ totalNodes: 0, totalEdges: 0, categories: {} })

// Watch route query for tab parameter
watch(
  () => route.query.tab,
  (newTab) => {
    if (newTab && typeof newTab === 'string' && ['list', 'search', 'distribution', 'feedback'].includes(newTab)) {
      activeTab.value = newTab
    }
  },
  { immediate: true }
)

// Update URL when tab changes
watch(activeTab, (newTab) => {
  const currentTab = route.query.tab
  if (newTab !== currentTab) {
    router.replace({
      path: route.path,
      query: newTab === 'list' ? {} : { tab: newTab }
    })
  }
})

// Filters
const searchQuery = ref('')
const typeFilter = ref<KnowledgeEntryType | ''>('')
const categoryFilter = ref('')

// Pagination
const currentPage = ref(1)
const pageSize = ref(20)
const totalEntries = ref(0)

// Dialog state
const dialogVisible = ref(false)
const detailVisible = ref(false)
const editingEntry = ref<KnowledgeEntry | null>(null)
const selectedEntry = ref<KnowledgeEntry | null>(null)
const formRef = ref<FormInstance>()

// Upload state
const uploadDialogVisible = ref(false)
const previewDialogVisible = ref(false)
const uploadResults = ref<ProcessedFileResult[]>([])

// Form data
const formData = reactive({
  type: 'manual' as KnowledgeEntryType,
  title: '',
  content: '',
  category: 'general',
  tags: [] as string[]
})

// Form rules
const formRules: FormRules = {
  type: [{ required: true, message: '请选择类型', trigger: 'change' }],
  title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
  content: [{ required: true, message: '请输入内容', trigger: 'blur' }]
}

// Feedback
const feedbackScore = ref(0)
const submittingFeedback = ref(false)

// Computed
const categories = computed(() => {
  if (!stats.value?.byCategory) return []
  return Object.keys(stats.value.byCategory)
})

const displayEntries = computed(() => {
  return entries.value
})

// Load data on mount
onMounted(() => {
  loadData()
})

// Load all data
const loadData = async () => {
  await Promise.all([loadStats(), loadEntries()])
  // Load graph stats (non-critical)
  try {
    const res = await knowledgeEnhancedApi.getGraphStats()
    if (res.data.success && res.data.data) graphStats.value = res.data.data
  } catch { /* non-critical */ }
}

// Load stats
const loadStats = async () => {
  try {
    const response = await knowledgeApi.getStats()
    if (response.data.success && response.data.data) {
      stats.value = response.data.data
    }
  } catch (err) {
    console.error('Failed to load stats:', err)
  }
}

// Load entries
const loadEntries = async () => {
  loading.value = true
  error.value = ''

  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      pageSize: pageSize.value
    }
    if (typeFilter.value) params.type = typeFilter.value
    if (categoryFilter.value) params.category = categoryFilter.value

    const response = await knowledgeApi.getAll(params as Parameters<typeof knowledgeApi.getAll>[0])
    if (response.data.success && response.data.data) {
      entries.value = response.data.data
      totalEntries.value = response.data.total || response.data.data.length
    } else {
      throw new Error(response.data.error || '获取知识条目失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取知识条目失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Handle search
const handleSearch = async () => {
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    activeTab.value = 'list'
    return
  }

  searching.value = true

  try {
    const response = await knowledgeApi.search({
      query: searchQuery.value,
      type: typeFilter.value || undefined,
      category: categoryFilter.value || undefined,
      limit: 20,
      minScore: 0.3
    })

    if (response.data.success && response.data.data) {
      searchResults.value = response.data.data
      activeTab.value = 'search'
    } else {
      throw new Error(response.data.error || '搜索失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '搜索失败'
    ElMessage.error(message)
  } finally {
    searching.value = false
  }
}

// Reset filters
const resetFilters = () => {
  searchQuery.value = ''
  typeFilter.value = ''
  categoryFilter.value = ''
  searchResults.value = []
  activeTab.value = 'list'
  loadEntries()
}

// Show add dialog
const showAddDialog = () => {
  editingEntry.value = null
  formData.type = 'manual'
  formData.title = ''
  formData.content = ''
  formData.category = 'general'
  formData.tags = []
  dialogVisible.value = true
}

// Edit entry
const editEntry = (entry: KnowledgeEntry) => {
  editingEntry.value = entry
  formData.type = entry.type
  formData.title = entry.title
  formData.content = entry.content
  formData.category = entry.metadata?.category || 'general'
  formData.tags = entry.metadata?.tags || []
  detailVisible.value = false
  dialogVisible.value = true
}

// Save entry
const saveEntry = async () => {
  if (!formRef.value) return

  try {
    await formRef.value.validate()
  } catch {
    return
  }

  saving.value = true

  try {
    if (editingEntry.value) {
      // Update
      const response = await knowledgeApi.update(editingEntry.value.id, {
        type: formData.type,
        title: formData.title,
        content: formData.content,
        metadata: {
          ...editingEntry.value.metadata,
          category: formData.category,
          tags: formData.tags
        }
      })

      if (response.data.success) {
        ElMessage.success('更新成功')
        dialogVisible.value = false
        loadData()
      } else {
        throw new Error(response.data.error || '更新失败')
      }
    } else {
      // Create
      const input: CreateKnowledgeEntryInput = {
        type: formData.type,
        title: formData.title,
        content: formData.content,
        metadata: {
          category: formData.category,
          tags: formData.tags
        }
      }

      const response = await knowledgeApi.create(input)

      if (response.data.success) {
        ElMessage.success('添加成功')
        dialogVisible.value = false
        loadData()
      } else {
        throw new Error(response.data.error || '添加失败')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

// Show entry detail
const showEntryDetail = (entry: KnowledgeEntry) => {
  selectedEntry.value = entry
  feedbackScore.value = 0
  detailVisible.value = true
}

// Confirm delete
const confirmDelete = async (entry: KnowledgeEntry) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除知识条目 "${entry.title}" 吗？`,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await knowledgeApi.delete(entry.id)
    if (response.data.success) {
      ElMessage.success('删除成功')
      detailVisible.value = false
      loadData()
    } else {
      throw new Error(response.data.error || '删除失败')
    }
  } catch (err) {
    if (err !== 'cancel') {
      const message = err instanceof Error ? err.message : '删除失败'
      ElMessage.error(message)
    }
  }
}

// Submit feedback
const submitFeedback = async () => {
  if (!selectedEntry.value || feedbackScore.value === 0) return

  submittingFeedback.value = true

  try {
    const response = await knowledgeApi.submitFeedback(selectedEntry.value.id, feedbackScore.value)
    if (response.data.success) {
      ElMessage.success('反馈提交成功')
      feedbackScore.value = 0
      // Reload to get updated score
      loadData()
    } else {
      throw new Error(response.data.error || '反馈提交失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '反馈提交失败'
    ElMessage.error(message)
  } finally {
    submittingFeedback.value = false
  }
}

// Utility functions
const formatDateTime = (timestamp?: number): string => {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString('zh-CN')
}

const formatScore = (score?: number): string => {
  if (score === undefined || score === null) return '-'
  return score.toFixed(1)
}

const getTypeText = (type: string): string => {
  const typeMap: Record<string, string> = {
    alert: '告警',
    remediation: '修复方案',
    config: '配置',
    pattern: '故障模式',
    manual: '手动添加',
    learning: '反思记录'
  }
  return typeMap[type] || type
}

const getTypeTagType = (type: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  const typeMap: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    alert: 'danger',
    remediation: 'success',
    config: 'info',
    pattern: 'warning',
    manual: 'primary',
    learning: 'info'
  }
  return typeMap[type] || 'primary'
}

const getScoreColor = (score: number): string => {
  if (score >= 0.8) return '#67c23a'
  if (score >= 0.5) return '#e6a23c'
  return '#f56c6c'
}

const getPercentage = (count: number, total?: number): number => {
  if (!total || total === 0) return 0
  return Math.round((count / total) * 100)
}

const truncateContent = (content: string, maxLength = 200): string => {
  if (content.length <= maxLength) return content
  return content.substring(0, maxLength) + '...'
}

// Upload functions
const showUploadDialog = () => {
  uploadDialogVisible.value = true
}

const handleUploadSuccess = (_results: ProcessedFileResult[]) => {
  uploadDialogVisible.value = false
  loadData() // Refresh the list
}

const handleUploadError = (error: string) => {
  console.error('Upload error:', error)
}

const handleUploadPreview = (results: ProcessedFileResult[]) => {
  uploadResults.value = results
  uploadDialogVisible.value = false
  previewDialogVisible.value = true
}

const handlePreviewConfirm = () => {
  previewDialogVisible.value = false
  loadData() // Refresh the list
}

const handleEntryUpdated = (_entry: KnowledgeEntry) => {
  // Entry was updated in preview, refresh if needed
  loadData()
}
</script>


<style scoped>
.knowledge-base-view {
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

/* Stats Cards */
.stats-cards {
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
  color: var(--el-color-white);
}

.stat-info {
  flex: 1;
}

.stat-card {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
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

/* Search Card */
.search-card {
  margin-bottom: 20px;
}

.search-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Main Card */
.main-card {
  min-height: 400px;
}

/* Score Cell */
.score-cell {
  display: flex;
  align-items: center;
  gap: 4px;
}

.feedback-count {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-left: 4px;
}

/* Pagination */
.pagination-container {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* Search Results */
.search-results {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.search-info {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  margin-bottom: 8px;
}

.result-card {
  cursor: pointer;
  transition: all 0.3s;
}

.result-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.result-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.result-score {
  display: flex;
  align-items: center;
  gap: 8px;
}

.score-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.result-content {
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 12px;
}

.result-meta {
  display: flex;
  gap: 16px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

/* Distribution */
.distribution-content {
  padding: 16px 0;
}

.distribution-section h4 {
  margin-bottom: 16px;
  color: var(--el-text-color-primary);
}

.distribution-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.distribution-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.item-label {
  width: 100px;
  flex-shrink: 0;
}

.category-label {
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.item-bar {
  flex: 1;
}

.item-count {
  width: 40px;
  text-align: right;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* Content Box */
.content-box {
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 16px;
  max-height: 300px;
  overflow-y: auto;
}

.content-box pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

/* Tag Item */
.tag-item {
  margin-right: 8px;
  margin-bottom: 4px;
}

/* Feedback Section */
.feedback-section {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}

.feedback-label {
  color: var(--el-text-color-regular);
  font-size: 14px;
}

/* Responsive */
@media (max-width: 768px) {
  .header-actions {
    flex-direction: column;
    width: 100%;
    justify-content: flex-end;
  }

  .search-form {
    flex-direction: column;
  }

  .result-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .result-meta {
    flex-wrap: wrap;
  }

  .feedback-section {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
