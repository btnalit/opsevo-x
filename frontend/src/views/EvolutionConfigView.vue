<template>
  <div class="evolution-config-view">
    <div class="page-header">
      <h2>智能进化配置</h2>
      <p class="description">管理 AI-OPS 智能进化系统的各项能力配置</p>
    </div>

    <!-- 加载状态 -->
    <el-skeleton v-if="loading && !config" :rows="5" animated />

    <!-- 错误状态 -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button size="small" @click="loadConfig">重试</el-button>
      </template>
    </el-alert>

    <!-- AI Insights Dashboard (Requirements: 5.4 工具信誉与反思经验的高级图表) -->
    <div v-if="config" class="insights-grid">
      <!-- Tool Success Rates -->
      <el-card class="insight-card" shadow="hover">
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon color="#67c23a"><i-ep-pie-chart /></el-icon>
              <span>AI 工具偏好与胜率榜</span>
            </div>
          </div>
        </template>
        <div class="tool-stats-container">
          <div v-for="tool in toolStats" :key="tool.toolName" class="tool-stat-item">
            <div class="tool-stat-header">
              <span class="tool-name">{{ tool.toolName }}</span>
              <span class="tool-win-rate">{{ (tool.successRate * 100).toFixed(0) }}% 胜率 ({{ tool.useCount }}次)</span>
            </div>
            <el-progress
              :percentage="tool.successRate * 100"
              :color="getToolWinRateColor(tool.successRate * 100)"
              :stroke-width="8"
            />
          </div>
          <div v-if="toolStats.length === 0" class="empty-hint">暂无工具调用数据</div>
        </div>
      </el-card>

      <!-- Recent AI Reflections -->
      <el-card class="insight-card" shadow="hover">
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon color="#e6a23c"><i-ep-chat-dot-round /></el-icon>
              <span>最新系统反思经验流</span>
            </div>
          </div>
        </template>
        <div class="reflections-container">
          <el-timeline v-if="reflections.length > 0">
            <el-timeline-item
              v-for="(reflection, index) in reflections"
              :key="index"
              :type="reflection.type"
              :color="reflection.color"
              :timestamp="reflection.time"
              placement="top"
            >
              <el-card shadow="never" class="reflection-timeline-card">
                <div class="reflection-header">
                  <h4>{{ reflection.title }}</h4>
                  <div class="reflection-meta-tags">
                    <el-tag v-if="reflection.intent" size="small" type="info" class="meta-tag">{{ reflection.intent }}</el-tag>
                    <el-tag v-if="reflection.confidence" size="small" :type="reflection.confidence > 0.7 ? 'success' : 'warning'" class="meta-tag">
                      置信度: {{ (reflection.confidence * 100).toFixed(0) }}%
                    </el-tag>
                  </div>
                </div>
                <div v-if="reflection.originalMessage" class="reflection-origin">
                  <el-icon><i-ep-chat-line-round /></el-icon>
                  <span class="origin-text">{{ reflection.originalMessage }}</span>
                </div>
                <p class="reflection-content">{{ reflection.content }}</p>
              </el-card>
            </el-timeline-item>
          </el-timeline>
          <div v-else class="empty-hint">暂无反思数据</div>
        </div>
      </el-card>
    </div>

    <!-- 配置卡片网格 -->
    <div v-if="config" class="section-title-wrap">
      <h3>功能模块开关</h3>
    </div>
    <div v-if="config" class="capability-grid">
      <el-card
        v-for="meta in CAPABILITY_METADATA"
        :key="meta.key"
        class="capability-card"
        :class="{ expanded: expandedCapability === meta.key }"
        shadow="hover"
      >
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon :size="20">
                <component :is="getIconComponent(meta.icon)" />
              </el-icon>
              <span>{{ meta.name }}</span>
            </div>
            <el-switch
              v-model="config[meta.key].enabled"
              :loading="switchLoading[meta.key]"
              @change="(val: string | number | boolean) => handleToggle(meta.key, Boolean(val))"
            />
          </div>
        </template>
        
        <p class="card-description">{{ meta.description }}</p>
        
        <div class="card-actions">
          <el-button
            type="primary"
            link
            @click="toggleExpand(meta.key)"
          >
            {{ expandedCapability === meta.key ? '收起配置' : '展开配置' }}
            <el-icon class="expand-icon" :class="{ rotated: expandedCapability === meta.key }">
              <i-ep-arrow-down />
            </el-icon>
          </el-button>
        </div>

        <!-- 展开的配置面板 -->
        <el-collapse-transition>
          <div v-if="expandedCapability === meta.key" class="config-panel">
            <el-form
              :model="config[meta.key]"
              label-width="180px"
              size="small"
            >
              <template v-for="(value, key) in config[meta.key]" :key="key">
                <el-form-item
                  v-if="key !== 'enabled'"
                  :label="getParamLabel(meta.key, key as string)"
                >
                  <!-- 布尔值 -->
                  <el-switch
                    v-if="typeof value === 'boolean'"
                    :model-value="(config[meta.key] as Record<string, unknown>)[key as string] as boolean"
                    @update:model-value="(val: string | number | boolean) => { if (config) (config[meta.key] as Record<string, unknown>)[key as string] = val }"
                  />
                  <!-- 数字 -->
                  <el-input-number
                    v-else-if="typeof value === 'number'"
                    :model-value="(config[meta.key] as Record<string, unknown>)[key as string] as number"
                    @update:model-value="(val: number | undefined) => { if (config) (config[meta.key] as Record<string, unknown>)[key as string] = val }"
                    :min="0"
                    :step="getParamStep(key as string)"
                  />
                  <!-- 下拉选择 -->
                  <el-select
                    v-else-if="isSelectParam(key as string)"
                    :model-value="(config[meta.key] as Record<string, unknown>)[key as string] as string"
                    @update:model-value="(val: string) => { if (config) (config[meta.key] as Record<string, unknown>)[key as string] = val }"
                  >
                    <el-option
                      v-for="opt in getSelectOptions(key as string)"
                      :key="opt.value"
                      :label="opt.label"
                      :value="opt.value"
                    />
                  </el-select>
                  <!-- 字符串 -->
                  <el-input
                    v-else
                    :model-value="(config[meta.key] as Record<string, unknown>)[key as string] as string"
                    @update:model-value="(val: string) => { if (config) (config[meta.key] as Record<string, unknown>)[key as string] = val }"
                  />
                </el-form-item>
              </template>
              
              <el-form-item>
                <el-button
                  type="primary"
                  :loading="saving"
                  @click="saveConfig(meta.key)"
                >
                  保存配置
                </el-button>
              </el-form-item>
            </el-form>
          </div>
        </el-collapse-transition>
      </el-card>
    </div>

    <!-- 学习历史时间线 -->
    <div v-if="config" class="section-title-wrap" style="margin-top: 24px;">
      <h3>学习历史</h3>
    </div>
    <el-card v-if="config" shadow="hover">
      <el-timeline v-if="learningHistory.length > 0">
        <el-timeline-item
          v-for="item in learningHistory"
          :key="item.id"
          :timestamp="new Date(item.timestamp).toLocaleString('zh-CN')"
          placement="top"
          :type="item.type === 'success' ? 'success' : item.type === 'pattern' ? 'warning' : 'primary'"
        >
          <div>
            <el-tag size="small" style="margin-right: 8px;">{{ item.type }}</el-tag>
            {{ item.description }}
          </div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else description="暂无学习历史" :image-size="60" />
    </el-card>

    <!-- 知识库统计 -->
    <div v-if="config" class="section-title-wrap" style="margin-top: 24px;">
      <h3>知识库统计</h3>
    </div>
    <el-row v-if="config" :gutter="16">
      <el-col :span="8">
        <el-card shadow="hover">
          <div style="text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: var(--el-color-primary);">{{ knowledgeStats.totalEntries }}</div>
            <div style="color: var(--el-text-color-secondary); margin-top: 4px;">知识条目总数</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <div style="text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: var(--el-color-success);">{{ Object.keys(knowledgeStats.categories).length }}</div>
            <div style="color: var(--el-text-color-secondary); margin-top: 4px;">知识类别数</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <div style="text-align: center;">
            <div style="font-size: 28px; font-weight: bold; color: var(--el-color-warning);">{{ knowledgeStats.avgScore.toFixed(1) }}</div>
            <div style="color: var(--el-text-color-secondary); margin-top: 4px;">平均评分</div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { Refresh, Collection, Edit, Tools, Monitor, Aim, FirstAidKit, TrendCharts, Connection, Cpu } from '@element-plus/icons-vue'

import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue'
import { ElMessage } from 'element-plus'
import { useEvolutionStore } from '@/stores/evolution'
import { 
  evolutionConfigApi, 
  CAPABILITY_METADATA,
  type AIEvolutionConfig 
} from '@/api/evolution'
import { useSSEConnection } from '@/utils/useSSEConnection'
import { useAuthStore } from '@/stores/auth'
import { evolutionEnhancedApi } from '@/api/aiops-enhanced'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

// keep-alive 需要组件名匹配
defineOptions({
  name: 'EvolutionConfigView'
})

// 状态
const evolutionStore = useEvolutionStore()
const config = ref<AIEvolutionConfig | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const expandedCapability = ref<keyof AIEvolutionConfig | null>(null)
const switchLoading = ref<Record<string, boolean>>({})

// 学习历史 & 知识库统计
const learningHistory = ref<Array<{ id: string; type: string; description: string; timestamp: number }>>([])
const knowledgeStats = ref<{ totalEntries: number; categories: Record<string, number>; avgScore: number }>({ totalEntries: 0, categories: {}, avgScore: 0 })

// ==================== AI Insights Dashboard ====================
// In a real scenario, this would be fetched from Critic/Feedback APIs

const toolStats = ref<any[]>([])
const reflections = ref<any[]>([])
const pollingTimer = ref<number | null>(null)

// FIX: 简单的模块级缓存，避免每次进入页面都重新请求 insights
let insightsCache: { toolStats: any[]; reflections: any[]; fetchedAt: number } | null = null
const INSIGHTS_CACHE_TTL = 30 * 1000 // 30 秒

// SSE 实时连接 - 监听新学习条目
const { connect: connectSSE, disconnect: disconnectSSE, onMessage } = useSSEConnection({
  config: {
    enableAutoReconnect: true,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 3000,
  }
})

// FIX: 防抖定时器，避免 SSE 事件密集触发时产生大量并发 API 请求导致页面卡死
let insightsDebounceTimer: ReturnType<typeof setTimeout> | null = null

const loadInsights = async () => {
  // FIX: 如果缓存有效，先用缓存数据渲染
  if (insightsCache && Date.now() - insightsCache.fetchedAt < INSIGHTS_CACHE_TTL) {
    toolStats.value = insightsCache.toolStats
    reflections.value = insightsCache.reflections
    return
  }

  // 并行请求且互不阻塞，一个失败不影响另一个
  const [statsResult, learningResult] = await Promise.allSettled([
    evolutionConfigApi.getToolStats(5),
    evolutionConfigApi.queryLearning({ limit: 5 }),
  ])

  // 认证失败时停止轮询，避免请求风暴
  for (const r of [statsResult, learningResult]) {
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : ''
      if (msg.includes('认证已过期') || msg.includes('刷新令牌失败')) {
        stopPolling()
        return
      }
    }
  }

  if (statsResult.status === 'fulfilled' && statsResult.value.data?.success && statsResult.value.data.data) {
    toolStats.value = statsResult.value.data.data
  }

  if (learningResult.status === 'fulfilled' && learningResult.value.data?.success && learningResult.value.data.data) {
    const newData = learningResult.value.data.data as any[]
    // FIX: 只有返回非空数组时才更新，防止后端缓存清理导致反思记录"闪消"
    // 空数组在 JS 中是 truthy，之前的条件判断无法拦截，导致 reflections 被清空
    if (newData.length > 0) {
      reflections.value = newData.map((item: any) => formatReflectionItem(item))
    }
  }


  // 更新缓存
  insightsCache = {
    toolStats: toolStats.value,
    reflections: reflections.value,
    fetchedAt: Date.now(),
  }
}

// 格式化反思条目（复用于 API 加载和 SSE 推送）
const formatReflectionItem = (item: any) => ({
  ...item,
  type: item.type === 'experience' ? 'success' : 'warning',
  time: dayjs(item.timestamp).fromNow(),
  content: item.content?.substring(0, 150) + (item.content?.length > 150 ? '...' : '')
})

// 初始化 SSE 连接，监听实时学习事件
const initSSE = () => {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || ''
  const authStore = useAuthStore()
  
  const headers: Record<string, string> = {}
  if (authStore.token) {
    headers['Authorization'] = `Bearer ${authStore.token}`
  }

  connectSSE(`${baseUrl}/api/ai-ops/learning/stream`, { headers })

  // 监听 learning:new 事件，实时更新反思列表
  // FIX: 使用防抖避免短时间内多个事件触发大量并发 API 请求
  onMessage((message: any) => {
    if (message.type === 'learning:new' || message.event === 'learning:new') {
      if (insightsDebounceTimer) clearTimeout(insightsDebounceTimer)
      insightsDebounceTimer = setTimeout(() => {
        loadInsights().catch(() => { /* silent */ })
      }, 2000)
    }
  })
}

const startPolling = () => {
  // SSE 作为主要实时通道，轮询作为兜底（间隔拉长到 30 秒）
  pollingTimer.value = window.setInterval(() => {
    loadInsights().catch(() => { /* 轮询失败静默处理，避免未捕获的 Promise rejection 导致页面崩溃 */ })
  }, 30000)
}

const stopPolling = () => {
  if (pollingTimer.value) {
    clearInterval(pollingTimer.value)
    pollingTimer.value = null
  }
}

const getToolWinRateColor = (rate: number) => {
  if (rate >= 90) return '#67c23a'
  if (rate >= 75) return '#409eff'
  if (rate >= 60) return '#e6a23c'
  return '#f56c6c'
}
// ==============================================================================

// 图标映射
const iconComponents: Record<string, unknown> = {
  Refresh,
  Collection,
  Edit,
  Tools,
  Monitor,
  Aim,
  FirstAidKit,
  TrendCharts,
  Connection,
  Cpu,
  'i-ep-refresh': Refresh,
  'i-ep-collection': Collection,
  'i-ep-edit': Edit,
  'i-ep-tools': Tools,
  'i-ep-monitor': Monitor,
  'i-ep-aim': Aim,
  'i-ep-first-aid-kit': FirstAidKit,
  'i-ep-trend-charts': TrendCharts,
  'i-ep-connection': Connection,
  'i-ep-cpu': Cpu
}

function getIconComponent(iconName: string) {
  return iconComponents[iconName] || Monitor
}

// 参数标签映射
const paramLabels: Record<string, string> = {
  maxRetries: '最大重试次数',
  timeoutMs: '超时时间 (ms)',
  minScoreForRetrieval: '最小检索分数',
  maxFewShotExamples: '最大示例数',
  autoApprove: '自动批准',
  qualityThreshold: '质量阈值',
  maxAdditionalSteps: '最大额外步骤',
  metricsRetentionDays: '指标保留天数',
  priorityOptimizationEnabled: '优先级优化',
  healthCheckIntervalSeconds: '健康检查间隔 (秒)',
  predictionTimeWindowMinutes: '预测时间窗口 (分钟)',
  predictionConfidenceThreshold: '预测置信度阈值',
  inspectionIntervalHours: '巡检间隔 (小时)',
  contextAwareChatEnabled: '上下文感知对话',
  confidenceThreshold: '置信度阈值',
  confirmationTimeoutMinutes: '确认超时 (分钟)',
  riskLevelForConfirmation: '需确认的风险等级',
  autoHealingLevel: '自动修复级别',
  faultDetectionIntervalSeconds: '故障检测间隔 (秒)',
  rootCauseAnalysisTimeoutSeconds: '根因分析超时 (秒)',
  patternLearningEnabled: '模式学习',
  patternLearningDelayDays: '模式学习延迟 (天)',
  bestPracticeThreshold: '最佳实践阈值',
  strategyEvaluationIntervalDays: '策略评估间隔 (天)',
  knowledgeGraphUpdateIntervalHours: '知识图谱更新间隔 (小时)',
  traceRetentionDays: '追踪保留天数',
  longTaskThresholdMinutes: '长任务阈值 (分钟)',
  heartbeatIntervalSeconds: '心跳间隔 (秒)',
  enableOpenTelemetryExport: 'OpenTelemetry 导出',
  tickIntervalMinutes: 'Brain tick interval (min)',
  dailyTokenBudget: 'Daily token budget',
  autoApproveHighRisk: 'Auto-approve high risk',
}

function getParamLabel(_capability: string, param: string): string {
  return paramLabels[param] || param
}

function getParamStep(param: string): number {
  if (param.includes('Threshold') || param.includes('Score')) return 0.1
  return 1
}

// 下拉选择参数
const selectParams = ['autoHealingLevel', 'riskLevelForConfirmation']

function isSelectParam(param: string): boolean {
  return selectParams.includes(param)
}

function getSelectOptions(param: string): { label: string; value: string }[] {
  if (param === 'autoHealingLevel') {
    return [
      { label: '禁用', value: 'disabled' },
      { label: '仅通知', value: 'notify' },
      { label: '低风险自动修复', value: 'low_risk' },
      { label: '全自动修复', value: 'full' }
    ]
  }
  if (param === 'riskLevelForConfirmation') {
    return [
      { label: 'L1 - 低风险', value: 'L1' },
      { label: 'L2 - 中风险', value: 'L2' },
      { label: 'L3 - 高风险', value: 'L3' },
      { label: 'L4 - 极高风险', value: 'L4' }
    ]
  }
  return []
}

// 加载配置
async function loadConfig() {
  error.value = ''
  
  // FIX: 优先使用 store 缓存，避免每次进入页面都重新加载
  // 如果 store 已有数据，先用缓存渲染，再后台静默刷新
  if (evolutionStore.config && !evolutionStore.isConfigStale) {
    config.value = { ...evolutionStore.config }
    // 后台静默刷新（不显示 loading）
    evolutionStore.fetchConfig(false).then(() => {
      if (evolutionStore.config) {
        config.value = { ...evolutionStore.config }
      }
    }).catch(() => { /* 静默失败，保持缓存数据 */ })
    return
  }

  loading.value = true
  try {
    await evolutionStore.fetchConfig(false)
    config.value = evolutionStore.config ? { ...evolutionStore.config } : null
    // FIX: 配置加载成功后，确保 SSE 和轮询已启动（用于重试场景）
    if (config.value && !pollingTimer.value) {
      loadInsights().catch(() => { /* silent */ })
      try { initSSE() } catch { /* silent */ }
      startPolling()
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载配置失败'
  } finally {
    loading.value = false
  }
}

// 加载学习历史和知识库统计
async function loadEvolutionEnhanced() {
  try {
    const [lhRes, ksRes] = await Promise.all([
      evolutionEnhancedApi.getLearningHistory(),
      evolutionEnhancedApi.getKnowledgeStats(),
    ])
    if (lhRes.data.success && lhRes.data.data) learningHistory.value = lhRes.data.data
    if (ksRes.data.success && ksRes.data.data) knowledgeStats.value = ksRes.data.data
  } catch { /* non-critical */ }
}

// 切换能力开关
async function handleToggle(capability: keyof AIEvolutionConfig, enabled: boolean) {
  switchLoading.value[capability] = true
  
  try {
    if (enabled) {
      await evolutionConfigApi.enableCapability(capability)
    } else {
      await evolutionConfigApi.disableCapability(capability)
    }
    evolutionStore.invalidateConfig()
    ElMessage.success(`${enabled ? '启用' : '禁用'}成功`)
  } catch (e) {
    // 恢复原状态
    if (config.value) {
      config.value[capability].enabled = !enabled
    }
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    switchLoading.value[capability] = false
  }
}

// 展开/收起配置
function toggleExpand(capability: keyof AIEvolutionConfig) {
  expandedCapability.value = expandedCapability.value === capability ? null : capability
}

// 保存配置
async function saveConfig(capability: keyof AIEvolutionConfig) {
  if (!config.value) return
  
  saving.value = true
  
  try {
    await evolutionConfigApi.updateConfig({
      [capability]: config.value[capability]
    })
    evolutionStore.invalidateConfig()
    ElMessage.success('配置已保存')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  // Load config first (most important), then non-blocking tasks
  await loadConfig()
  // FIX: 只有配置加载成功后才启动 SSE 和轮询
  // 配置失败时继续运行 SSE/轮询会产生大量无用请求，加重系统负担导致页面卡死
  if (config.value) {
    loadInsights().catch(() => { /* silent */ })
    try { initSSE() } catch { /* SSE failure should not crash the page */ }
    startPolling()
    loadEvolutionEnhanced()
  }
})

onUnmounted(() => {
  stopPolling()
  disconnectSSE()
  if (insightsDebounceTimer) {
    clearTimeout(insightsDebounceTimer)
    insightsDebounceTimer = null
  }
})

// keep-alive 支持：切走时断开 SSE 和轮询，切回来时重连
onActivated(() => {
  if (config.value) {
    loadInsights().catch(() => { /* silent */ })
    try { initSSE() } catch { /* SSE failure should not crash the page */ }
    startPolling()
  }
})

onDeactivated(() => {
  stopPolling()
  disconnectSSE()
  if (insightsDebounceTimer) {
    clearTimeout(insightsDebounceTimer)
    insightsDebounceTimer = null
  }
})
</script>

<style scoped>
.evolution-config-view {
  padding: 20px;
  background: var(--el-bg-color-page);
  min-height: 100%;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h2 {
  margin: 0 0 8px 0;
  font-size: 24px;
  font-weight: 600;
}

.page-header .description {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 16px;
}

.capability-card {
  transition: all 0.3s;
}

.capability-card.expanded {
  grid-column: span 2;
}

@media (max-width: 768px) {
  .capability-card.expanded {
    grid-column: span 1;
  }
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.card-description {
  color: var(--el-text-color-regular);
  font-size: 13px;
  margin: 0 0 12px 0;
  line-height: 1.5;
}

.card-actions {
  display: flex;
  justify-content: flex-end;
}

.expand-icon {
  transition: transform 0.3s;
  margin-left: 4px;
}

.expand-icon.rotated {
  transform: rotate(180deg);
}

.config-panel {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

:deep(.el-form-item) {
  margin-bottom: 12px;
}

:deep(.el-input-number) {
  width: 180px;
}

:deep(.el-select) {
  width: 180px;
}

/* AI Insights Dashboard Styles */
.insights-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 20px;
  margin-bottom: 24px;
}

.section-title-wrap {
  margin: 32px 0 16px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding-bottom: 8px;
}

.section-title-wrap h3 {
  margin: 0;
  font-size: 18px;
  color: var(--el-text-color-primary);
}

.tool-stats-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.tool-stat-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-stat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
}

.tool-name {
  font-family: monospace;
  background-color: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--el-text-color-secondary);
}

.tool-win-rate {
  color: var(--el-text-color-regular);
  font-weight: 500;
}

.reflections-container {
  padding: 4px 8px 0 0;
  max-height: 300px;
  overflow-y: auto;
}

.reflection-timeline-card {
  margin-bottom: 0;
}

.reflection-timeline-card h4 {
  margin: 0;
  font-size: 14px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reflection-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  gap: 12px;
}

.reflection-meta-tags {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.reflection-origin {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 4px 8px;
  background-color: var(--el-fill-color-lighter);
  border-radius: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.origin-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reflection-content {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

.reflection-timeline-card p {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

.empty-hint {
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  padding: 20px 0;
}
</style>
