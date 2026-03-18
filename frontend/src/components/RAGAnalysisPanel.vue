<template>
  <div class="rag-analysis-panel">
    <!-- Panel Header -->
    <div class="panel-header">
      <div class="header-title">
        <el-icon :size="20" class="header-main-icon"><i-ep-data-analysis /></el-icon>
        <span>RAG 智能分析</span>
      </div>
      <div class="header-actions">
        <el-button
          v-if="!loading && !ragContext"
          type="primary"
          size="small"
          @click="$emit('analyze')"
        >
          <el-icon><i-ep-magic-stick /></el-icon>
          生成分析
        </el-button>
        <el-button
          v-if="ragContext"
          size="small"
          text
          @click="$emit('refresh')"
        >
          <el-icon><i-ep-refresh /></el-icon>
          重新分析
        </el-button>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="loading-container">
      <el-skeleton :rows="4" animated />
    </div>

    <!-- No Data State -->
    <el-empty
      v-else-if="!ragContext && !historicalReferences?.length && !analysisResult"
      description="暂无 RAG 分析数据"
      :image-size="80"
    >
      <el-button type="primary" size="small" @click="$emit('analyze')">
        生成 RAG 分析
      </el-button>
    </el-empty>

    <!-- Analysis Content -->
    <div v-else class="analysis-content">
      <!-- Historical Reference Status Banner -->
      <div v-if="referenceStatus" class="reference-status-banner" :class="getReferenceStatusClass(referenceStatus)">
        <el-icon v-if="referenceStatus === 'found'" color="#67c23a"><i-ep-circle-check-filled /></el-icon>
        <el-icon v-else-if="referenceStatus === 'type_mismatch'" color="#e6a23c"><i-ep-warning-filled /></el-icon>
        <el-icon v-else color="#909399"><i-ep-info-filled /></el-icon>
        <span class="status-text">{{ getReferenceStatusText(referenceStatus) }}</span>
      </div>

      <!-- AI Analysis Result - LLM 深度分析结果 -->
      <div v-if="analysisResult" class="ai-analysis-section">
        <div class="section-title">
          <el-icon><i-ep-magic-stick /></el-icon>
          <span>AI 智能分析</span>
          <el-tag v-if="analysisResult.confidence" size="small" :type="getConfidenceTagType(analysisResult.confidence)">
            置信度: {{ (analysisResult.confidence * 100).toFixed(0) }}%
          </el-tag>
        </div>
        
        <!-- Summary -->
        <div v-if="analysisResult.summary" class="analysis-summary">
          <div class="summary-label">分析摘要</div>
          <div class="summary-content">{{ analysisResult.summary }}</div>
        </div>
        
        <!-- Details -->
        <div v-if="analysisResult.details" class="analysis-details">
          <div class="details-label">详细分析</div>
          <div class="details-content">{{ analysisResult.details }}</div>
        </div>
        
        <!-- Recommendations -->
        <div v-if="analysisResult.recommendations?.length" class="analysis-recommendations">
          <div class="recommendations-label">处理建议</div>
          <ul class="recommendations-list">
            <li v-for="(rec, index) in analysisResult.recommendations" :key="index">
              {{ rec }}
            </li>
          </ul>
        </div>
        
        <!-- Risk Level -->
        <div v-if="analysisResult.riskLevel" class="analysis-risk">
          <span class="risk-label">风险等级:</span>
          <el-tag :type="getRiskTagType(analysisResult.riskLevel)" size="small">
            {{ getRiskText(analysisResult.riskLevel) }}
          </el-tag>
        </div>
      </div>

      <!-- Alert Classification Info -->
      <div v-if="classification" class="classification-section">
        <div class="section-title">
          <el-icon><i-ep-collection /></el-icon>
          <span>告警分类</span>
        </div>
        <div class="classification-info">
          <div class="classification-item">
            <span class="classification-label">指标类型</span>
            <el-tag size="small" type="info">{{ classification.metricType }}</el-tag>
          </div>
          <div class="classification-item">
            <span class="classification-label">告警类别</span>
            <el-tag size="small" :type="getCategoryTagType(classification.category)">
              {{ getCategoryText(classification.category) }}
            </el-tag>
          </div>
          <div class="classification-item">
            <span class="classification-label">分类置信度</span>
            <el-progress
              :percentage="Math.round(classification.confidence * 100)"
              :stroke-width="8"
              :color="getConfidenceColor(classification.confidence)"
              style="width: 80px"
            />
            <span class="confidence-text">{{ (classification.confidence * 100).toFixed(0) }}%</span>
          </div>
          <div v-if="classification.keywords?.length" class="classification-item keywords">
            <span class="classification-label">关键词</span>
            <div class="keywords-list">
              <el-tag v-for="keyword in classification.keywords.slice(0, 5)" :key="keyword" size="small" effect="plain">
                {{ keyword }}
              </el-tag>
            </div>
          </div>
        </div>
      </div>

      <!-- Retrieval Stats -->
      <div v-if="ragContext" class="retrieval-stats">
        <div class="stat-item">
          <span class="stat-label">检索耗时</span>
          <span class="stat-value">{{ ragContext.retrievalTime }}ms</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">候选文档</span>
          <span class="stat-value">{{ ragContext.candidatesConsidered }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">匹配结果</span>
          <span class="stat-value">{{ ragContext.retrievedDocuments?.length || 0 }}</span>
        </div>
        <div v-if="hasHistoricalReference !== undefined" class="stat-item">
          <span class="stat-label">历史参考</span>
          <span class="stat-value" :class="{ 'has-reference': hasHistoricalReference, 'no-reference': !hasHistoricalReference }">
            {{ hasHistoricalReference ? '有' : '无' }}
          </span>
        </div>
      </div>

      <!-- Historical References -->
      <div v-if="historicalReferences?.length" class="references-section">
        <div class="section-title">
          <el-icon><i-ep-document /></el-icon>
          <span>历史参考 ({{ historicalReferences.length }})</span>
          <el-tag v-if="referenceStatus === 'type_mismatch'" type="warning" size="small" class="type-mismatch-tag">
            跨类型
          </el-tag>
        </div>
        <div class="references-list">
          <div
            v-for="(ref, index) in historicalReferences"
            :key="(ref as any).alertId || (ref as any).planId || index"
            class="reference-item"
            @click="handleReferenceClick(ref)"
          >
            <div class="reference-header">
              <div class="reference-index">#{{ index + 1 }}</div>
              <div class="reference-score">
                <el-progress
                  :percentage="Math.round(ref.similarity * 100)"
                  :stroke-width="6"
                  :color="getScoreColor(ref.similarity)"
                  style="width: 60px"
                />
                <span class="score-text">{{ (ref.similarity * 100).toFixed(1) }}%</span>
              </div>
            </div>
            <div class="reference-body">
              <div v-if="(ref as any).resolution" class="reference-resolution">
                <el-icon color="#67c23a"><i-ep-circle-check-filled /></el-icon>
                <span>{{ truncateText((ref as any).resolution, 100) }}</span>
              </div>
              <div v-if="(ref as any).outcome" class="reference-outcome">
                <el-tag :type="getOutcomeType((ref as any).outcome)" size="small">
                  {{ getOutcomeText((ref as any).outcome) }}
                </el-tag>
              </div>
              <div v-if="(ref as any).successRate !== undefined" class="reference-success-rate">
                <span class="rate-label">成功率:</span>
                <el-progress
                  :percentage="Math.round((ref as any).successRate * 100)"
                  :stroke-width="8"
                  :color="getSuccessRateColor((ref as any).successRate)"
                  style="width: 80px"
                />
                <span class="rate-text">{{ ((ref as any).successRate * 100).toFixed(0) }}%</span>
              </div>
            </div>
            <div class="reference-footer">
              <el-tooltip content="在新窗口中查看此历史告警的详情" placement="top">
                <el-button type="primary" size="small" text @click.stop="viewReferenceDetail(ref)">
                  <el-icon><i-ep-link /></el-icon>
                  查看详情
                </el-button>
              </el-tooltip>
            </div>
          </div>
        </div>
      </div>

      <!-- No Historical Reference Notice -->
      <div v-else-if="referenceStatus === 'not_found'" class="no-reference-notice">
        <el-icon :size="32" color="#909399"><i-ep-info-filled /></el-icon>
        <div class="notice-content">
          <div class="notice-title">首次遇到此类告警，无历史参考</div>
          <div class="notice-tips">
            <p>建议：</p>
            <ul>
              <li>仔细分析当前告警的根本原因</li>
              <li>记录处理过程以便后续参考</li>
              <li>解决后将案例录入知识库</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Citations -->
      <div v-if="citations?.length" class="citations-section">
        <div class="section-title">
          <el-icon><i-ep-link /></el-icon>
          <span>知识引用 ({{ citations.length }})</span>
        </div>
        <div class="citations-list">
          <div
            v-for="citation in citations"
            :key="citation.entryId"
            class="citation-item"
            @click="viewKnowledgeEntry(citation.entryId)"
          >
            <div class="citation-header">
              <span class="citation-title">{{ citation.title }}</span>
              <el-tag type="info" size="small">
                {{ (citation.relevance * 100).toFixed(0) }}% 相关
              </el-tag>
            </div>
            <div class="citation-excerpt">
              {{ truncateText(citation.excerpt, 150) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Retrieved Documents -->
      <div v-if="ragContext?.retrievedDocuments?.length" class="documents-section">
        <el-collapse>
          <el-collapse-item>
            <template #title>
              <div class="collapse-title">
                <el-icon><i-ep-folder /></el-icon>
                <span>检索文档详情 ({{ ragContext.retrievedDocuments.length }})</span>
              </div>
            </template>
            <div class="documents-list">
              <div
                v-for="(doc, index) in ragContext.retrievedDocuments"
                :key="doc.entry?.id || index"
                class="document-item"
              >
                <div class="document-header">
                  <span class="document-title">{{ doc.entry?.title || '未知文档' }}</span>
                  <el-tag size="small">{{ (doc.score * 100).toFixed(1) }}%</el-tag>
                </div>
                <div class="document-content">
                  {{ truncateText(doc.entry?.content || '', 200) }}
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>

      <!-- Feedback Section -->
      <div class="feedback-section">
        <el-divider />
        <div class="feedback-content">
          <span class="feedback-label">这些历史参考对您有帮助吗？</span>
          <div class="feedback-buttons">
            <el-button
              :type="feedbackValue === 'helpful' ? 'success' : 'default'"
              size="small"
              :disabled="feedbackSubmitted"
              @click="submitFeedback('helpful')"
            >
              <el-icon><i-ep-circle-check-filled /></el-icon>
              有帮助
            </el-button>
            <el-button
              :type="feedbackValue === 'not_helpful' ? 'danger' : 'default'"
              size="small"
              :disabled="feedbackSubmitted"
              @click="submitFeedback('not_helpful')"
            >
              <el-icon><i-ep-circle-close-filled /></el-icon>
              没帮助
            </el-button>
          </div>
        </div>
        <el-input
          v-if="feedbackSubmitted"
          v-model="feedbackComment"
          type="textarea"
          :rows="2"
          placeholder="可选：添加更多反馈意见..."
          class="feedback-comment"
          @blur="submitFeedbackComment"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { RAGContext, RAGCitation, HistoricalAlertReference, HistoricalPlanReference, ReferenceStatus, AlertClassification, AlertCategory } from '@/api/rag'

// Props
interface Props {
  loading?: boolean
  ragContext?: RAGContext | null
  historicalReferences?: (HistoricalAlertReference | HistoricalPlanReference)[]
  citations?: RAGCitation[]
  /** 是否有历史参考 - Requirement 5.1 */
  hasHistoricalReference?: boolean
  /** 参考状态 - Requirement 5.2 */
  referenceStatus?: ReferenceStatus
  /** 告警分类结果 - Requirements 1.1-1.3 */
  classification?: AlertClassification | null
  /** AI 深度分析结果 */
  analysisResult?: {
    summary?: string
    details?: string
    recommendations?: string[]
    riskLevel?: string
    confidence?: number
  } | null
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  ragContext: null,
  historicalReferences: () => [],
  citations: () => [],
  hasHistoricalReference: undefined,
  referenceStatus: undefined,
  classification: null,
  analysisResult: null
})

// Emits
const emit = defineEmits<{
  (e: 'analyze'): void
  (e: 'refresh'): void
  (e: 'viewReference', ref: HistoricalAlertReference | HistoricalPlanReference): void
  (e: 'viewKnowledge', entryId: string): void
  (e: 'feedback', value: 'helpful' | 'not_helpful', comment?: string): void
}>()

// Feedback state
const feedbackValue = ref<'helpful' | 'not_helpful' | null>(null)
const feedbackSubmitted = ref(false)
const feedbackComment = ref('')

// Handle reference click
const handleReferenceClick = (ref: HistoricalAlertReference | HistoricalPlanReference) => {
  emit('viewReference', ref)
}

// View reference detail
const viewReferenceDetail = (ref: HistoricalAlertReference | HistoricalPlanReference) => {
  emit('viewReference', ref)
}

// View knowledge entry
const viewKnowledgeEntry = (entryId: string) => {
  emit('viewKnowledge', entryId)
}

// Submit feedback
const submitFeedback = (value: 'helpful' | 'not_helpful') => {
  feedbackValue.value = value
  feedbackSubmitted.value = true
  emit('feedback', value)
  ElMessage.success('感谢您的反馈！')
}

// Submit feedback comment
const submitFeedbackComment = () => {
  if (feedbackComment.value.trim() && feedbackValue.value) {
    emit('feedback', feedbackValue.value, feedbackComment.value)
  }
}

// Utility functions
const truncateText = (text: string, maxLength: number): string => {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...'
}

const getScoreColor = (score: number): string => {
  if (score >= 0.8) return '#67c23a'
  if (score >= 0.5) return '#e6a23c'
  return '#f56c6c'
}

const getSuccessRateColor = (rate: number): string => {
  if (rate >= 0.8) return '#67c23a'
  if (rate >= 0.5) return '#e6a23c'
  return '#f56c6c'
}

const getOutcomeType = (outcome: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  const typeMap: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    success: 'success',
    partial: 'warning',
    failed: 'danger'
  }
  return typeMap[outcome] || 'info'
}

const getOutcomeText = (outcome: string): string => {
  const textMap: Record<string, string> = {
    success: '成功',
    partial: '部分成功',
    failed: '失败'
  }
  return textMap[outcome] || outcome
}

// Reference status helper functions - Requirements 5.1, 5.2, 5.3, 5.4
const getReferenceStatusClass = (status: ReferenceStatus): string => {
  const classMap: Record<ReferenceStatus, string> = {
    found: 'status-found',
    not_found: 'status-not-found',
    type_mismatch: 'status-type-mismatch'
  }
  return classMap[status] || ''
}

const getReferenceStatusText = (status: ReferenceStatus): string => {
  const textMap: Record<ReferenceStatus, string> = {
    found: '找到相同类型的历史参考',
    not_found: '首次遇到此类告警，无历史参考',
    type_mismatch: '未找到相同类型的历史参考，已参考其他类型案例'
  }
  return textMap[status] || ''
}

// Classification helper functions - Requirements 1.1-1.3
const getCategoryTagType = (category: AlertCategory): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  const typeMap: Record<AlertCategory, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    interface: 'primary',
    traffic: 'success',
    resource: 'warning',
    security: 'danger',
    other: 'info'
  }
  return typeMap[category] || 'info'
}

const getCategoryText = (category: AlertCategory): string => {
  const textMap: Record<AlertCategory, string> = {
    interface: '接口',
    traffic: '流量',
    resource: '资源',
    security: '安全',
    other: '其他'
  }
  return textMap[category] || category
}

const getConfidenceColor = (confidence: number): string => {
  if (confidence >= 0.8) return '#67c23a'
  if (confidence >= 0.6) return '#409eff'
  if (confidence >= 0.4) return '#e6a23c'
  return '#f56c6c'
}

// AI Analysis helper functions
const getConfidenceTagType = (confidence: number): 'success' | 'primary' | 'warning' | 'danger' => {
  if (confidence >= 0.8) return 'success'
  if (confidence >= 0.6) return 'primary'
  if (confidence >= 0.4) return 'warning'
  return 'danger'
}

const getRiskTagType = (risk: string): 'success' | 'warning' | 'danger' | 'info' => {
  const typeMap: Record<string, 'success' | 'warning' | 'danger' | 'info'> = {
    low: 'success',
    medium: 'warning',
    high: 'danger'
  }
  return typeMap[risk] || 'info'
}

const getRiskText = (risk: string): string => {
  const textMap: Record<string, string> = {
    low: '低风险',
    medium: '中风险',
    high: '高风险'
  }
  return textMap[risk] || risk
}
</script>

<style scoped>
.rag-analysis-panel {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 16px;
}

/* Panel Header */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

/* Loading */
.loading-container {
  padding: 16px 0;
}

/* Analysis Content */
.analysis-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Reference Status Banner - Requirements 5.1, 5.2, 5.3, 5.4 */
.reference-status-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 4px;
  font-size: 13px;
}

.reference-status-banner.status-found {
  background: rgba(103, 194, 58, 0.1);
  border: 1px solid rgba(103, 194, 58, 0.2);
  color: #67c23a;
}

.reference-status-banner.status-not-found {
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-secondary);
}

.reference-status-banner.status-type-mismatch {
  background: rgba(230, 162, 60, 0.1);
  border: 1px solid rgba(230, 162, 60, 0.2);
  color: #e6a23c;
}

.status-text {
  font-weight: 500;
}

/* Classification Section - Requirements 1.1-1.3 */
.classification-section {
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  border: 1px solid var(--el-border-color-lighter);
}

/* AI Analysis Section - LLM 深度分析结果 */
.ai-analysis-section {
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  border-left: 4px solid var(--el-color-primary);
}

.analysis-summary {
  margin-bottom: 16px;
}

.summary-label,
.details-label,
.recommendations-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}

.summary-content {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  line-height: 1.6;
}

.analysis-details {
  margin-bottom: 16px;
}

.details-content {
  font-size: 14px;
  color: var(--el-text-color-regular);
  line-height: 1.8;
  white-space: pre-wrap;
}

.analysis-recommendations {
  margin-bottom: 16px;
}

.recommendations-list {
  margin: 0;
  padding-left: 20px;
}

.recommendations-list li {
  font-size: 14px;
  color: var(--el-text-color-regular);
  line-height: 1.8;
  margin-bottom: 4px;
}

.analysis-risk {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.risk-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.classification-info {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 8px;
}

.classification-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.classification-item.keywords {
  flex-basis: 100%;
}

.classification-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.keywords-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.confidence-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-left: 4px;
}

/* Retrieval Stats */
.retrieval-stats {
  display: flex;
  gap: 24px;
  padding: 12px 16px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  border: 1px solid var(--el-border-color-lighter);
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stat-value.has-reference {
  color: #67c23a;
}

.stat-value.no-reference {
  color: var(--el-text-color-secondary);
}

/* Section Title */
.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 12px;
}

.type-mismatch-tag {
  margin-left: 8px;
}

/* References Section */
.references-section {
  padding: 12px 0;
}

.references-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.reference-item {
  padding: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
  border: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  transition: all 0.3s;
}

.reference-item:hover {
  border-color: var(--el-color-primary);
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.15);
}

.reference-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.reference-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.reference-score {
  display: flex;
  align-items: center;
  gap: 8px;
}

.score-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.reference-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reference-resolution {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

.reference-outcome {
  margin-top: 4px;
}

.reference-success-rate {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.rate-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.rate-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.reference-footer {
  margin-top: 8px;
  text-align: right;
}

/* No Reference Notice - Requirements 5.3, 5.4 */
.no-reference-notice {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 20px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  border: 1px dashed var(--el-border-color);
}

.notice-content {
  flex: 1;
}

.notice-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  margin-bottom: 12px;
}

.notice-tips {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.notice-tips p {
  margin: 0 0 8px 0;
}

.notice-tips ul {
  margin: 0;
  padding-left: 20px;
}

.notice-tips li {
  margin-bottom: 4px;
}

/* Citations Section */
.citations-section {
  padding: 12px 0;
}

.citations-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.citation-item {
  padding: 10px 12px;
  background: rgba(103, 194, 58, 0.1);
  border-radius: 4px;
  border-left: 3px solid #67c23a;
  cursor: pointer;
  transition: all 0.3s;
}

.citation-item:hover {
  background: rgba(103, 194, 58, 0.15);
}

.citation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.citation-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.citation-excerpt {
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
}

/* Documents Section */
.documents-section {
  padding: 12px 0;
}

.collapse-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.documents-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.document-item {
  padding: 10px 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 4px;
}

.document-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.document-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.document-content {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

/* Feedback Section */
.feedback-section {
  margin-top: 8px;
}

.feedback-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.feedback-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.feedback-buttons {
  display: flex;
  gap: 8px;
}

.feedback-comment {
  margin-top: 12px;
}

/* Responsive */
@media (max-width: 768px) {
  .retrieval-stats {
    flex-wrap: wrap;
    gap: 16px;
  }

  .reference-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .feedback-content {
    flex-direction: column;
    align-items: flex-start;
  }

  .classification-info {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
