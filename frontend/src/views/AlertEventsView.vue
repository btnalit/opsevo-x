<template>
  <div class="alert-events-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>告警事件</span>
            <el-badge v-if="activeCount > 0" :value="activeCount" type="danger" style="margin-left: 8px" />
          </div>
          <div class="header-actions">
            <el-radio-group v-model="viewMode" size="small">
              <el-radio-button value="active">活跃告警</el-radio-button>
              <el-radio-button value="history">历史记录</el-radio-button>
            </el-radio-group>
            <el-button :icon="Refresh" :loading="loading" @click="loadEvents">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Time Range Filter (for history mode) -->
    <el-card v-if="viewMode === 'history'" class="filter-card" shadow="hover">
      <el-form :inline="true" class="filter-form">
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="dateRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            :shortcuts="dateShortcuts"
            value-format="x"
            @change="loadEvents"
          />
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="sourceFilter" placeholder="全部" style="width: 120px" @change="loadEvents">
            <el-option label="全部" value="all" />
            <el-option label="指标告警" value="metrics" />
            <el-option label="Syslog" value="syslog" />
          </el-select>
        </el-form-item>
        <el-form-item label="严重级别">
          <el-select v-model="severityFilter" placeholder="全部" clearable style="width: 120px" @change="filterEvents">
            <el-option label="信息" value="info" />
            <el-option label="警告" value="warning" />
            <el-option label="严重" value="critical" />
            <el-option label="紧急" value="emergency" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="statusFilter" placeholder="全部" clearable style="width: 120px" @change="filterEvents">
            <el-option label="活跃" value="active" />
            <el-option label="已恢复" value="resolved" />
          </el-select>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- Batch Actions Bar (Active Mode) -->
    <el-card v-if="viewMode === 'active' && activeEvents.length > 0" class="batch-actions-card" shadow="hover">
      <div class="batch-actions">
        <div class="select-actions">
          <el-checkbox
            v-model="selectAll"
            :indeterminate="isIndeterminate"
            @change="(val: any) => handleSelectAllChange(!!val)"
          >
            全选活跃告警
          </el-checkbox>
          <span class="selected-count" v-if="selectedEvents.length > 0">
            已选择 {{ selectedEvents.length }} 项
          </span>
        </div>
        <div class="action-buttons">
          <el-button
            type="success"
            :disabled="selectedEvents.length === 0"
            :loading="batchResolving"
            @click="batchResolveEvents"
          >
            <el-icon><i-ep-circle-check-filled /></el-icon>
            批量解决 ({{ selectedEvents.length }})
          </el-button>
          <el-button
            v-if="selectedEvents.length > 0"
            @click="clearSelection"
          >
            清除选择
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- Batch Actions Bar (History Mode - Requirements: 4.6) -->
    <el-card v-if="viewMode === 'history' && filteredEvents.length > 0" class="batch-actions-card" shadow="hover">
      <div class="batch-actions">
        <div class="select-actions">
          <el-checkbox
            :model-value="resolvedEventsSelection.allSelected"
            :indeterminate="resolvedEventsSelection.indeterminate"
            @change="(val: any) => handleSelectAllResolvedChange(!!val)"
          >
            全选已解决告警
          </el-checkbox>
          <span class="selected-count" v-if="resolvedEventsSelection.selectedCount > 0">
            已选择 {{ resolvedEventsSelection.selectedCount }} 项
          </span>
        </div>
        <div class="action-buttons">
          <el-button
            type="danger"
            :disabled="resolvedEventsSelection.selectedCount === 0"
            :loading="batchDeleting"
            @click="batchDeleteEvents"
          >
            <el-icon><i-ep-delete /></el-icon>
            批量删除 ({{ resolvedEventsSelection.selectedCount }})
          </el-button>
          <el-button
            v-if="resolvedEventsSelection.selectedCount > 0"
            @click="clearSelection"
          >
            清除选择
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && events.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="loadEvents">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-card v-else-if="filteredEvents.length === 0" shadow="hover">
      <el-empty :description="viewMode === 'active' ? '暂无活跃告警' : '暂无告警记录'" />
    </el-card>

    <!-- Events List -->
    <div v-else class="events-list">
      <el-card
        v-for="event in filteredEvents"
        :key="event.id"
        class="event-card"
        :class="{ 
          'event-active': event.status === 'active',
          'event-selected': isSelected(event.id),
          'event-syslog': event.type === 'syslog'
        }"
        shadow="hover"
        @click="showEventDetail(event)"
      >
        <div class="event-header">
          <div class="event-severity">
            <el-checkbox
              v-if="event.status === 'active' || (viewMode === 'history' && event.status === 'resolved')"
              :model-value="isSelected(event.id)"
              @click.stop
              @change="(val: any) => toggleSelection(event.id, !!val)"
            />
            <el-icon :color="getSeverityColor(event.severity)" :size="24">
              <i-ep-warning-filled />
            </el-icon>
            <el-tag :type="getSeverityType(event.severity)" size="small">
              {{ getSeverityText(event.severity) }}
            </el-tag>
            <!-- 预测拦截标签 (Preemptive Healing Badge) -->
            <el-tooltip content="由 AI 预测主动拦截的异常" placement="top">
              <el-tag v-if="event.id.startsWith('preempt_') || event.ruleName?.startsWith('preempt_')" type="warning" size="small" effect="dark" class="preemptive-tag">
                🔮 预测拦截
              </el-tag>
            </el-tooltip>
            <!-- 事件类型标签 -->
            <el-tag :type="event.type === 'syslog' ? 'info' : 'primary'" size="small" class="event-type-tag">
              {{ event.type === 'syslog' ? 'Syslog' : '告警' }}
            </el-tag>
          </div>
          <div class="event-status">
            <el-tag v-if="event.deviceName || getDeviceName(event.deviceId)" type="primary" size="small" effect="plain" class="device-tag">
              {{ event.deviceName || getDeviceName(event.deviceId) }}
            </el-tag>
            <el-tag :type="event.status === 'active' ? 'danger' : 'success'" size="small">
              {{ event.status === 'active' ? '活跃' : '已恢复' }}
            </el-tag>
          </div>
        </div>

        <div class="event-body">
          <!-- Alert 事件显示规则名称 -->
          <div v-if="event.type === 'alert'" class="event-title">{{ event.ruleName }}</div>
          <!-- Syslog 事件显示分类 -->
          <div v-else class="event-title">
            <span class="syslog-category">{{ event.category || 'system' }}</span>
            <span v-if="event.metadata?.hostname" class="syslog-hostname">@ {{ event.metadata.hostname }}</span>
          </div>
          <div class="event-message">{{ event.message }}</div>
          <!-- Alert 事件显示指标信息 -->
          <div v-if="event.type === 'alert' && event.metric" class="event-metrics">
            <span class="metric-item">
              <el-icon><i-ep-odometer /></el-icon>
              {{ getMetricText(event.metric) }}: {{ event.currentValue }}{{ getMetricUnit(event.metric) }}
            </span>
            <span class="metric-item">
              <el-icon><i-ep-aim /></el-icon>
              阈值: {{ event.threshold }}{{ getMetricUnit(event.metric) }}
            </span>
          </div>
          <!-- Syslog 事件显示元数据 -->
          <div v-if="event.type === 'syslog' && event.metadata" class="event-metadata">
            <span class="metadata-item">
              <el-icon><i-ep-info-filled /></el-icon>
              Facility: {{ event.metadata.facility }}
            </span>
            <span class="metadata-item">
              Severity: {{ event.metadata.syslogSeverity }}
            </span>
          </div>
        </div>

        <div class="event-footer">
          <div class="event-time">
            <el-icon><i-ep-clock /></el-icon>
            <span>{{ event.type === 'syslog' ? '接收时间' : '触发时间' }}: {{ formatTime(event.timestamp) }}</span>
            <span v-if="event.resolvedAt" class="resolved-time">
              | 恢复时间: {{ formatTime(event.resolvedAt) }}
            </span>
          </div>
          <div class="event-actions">
            <el-button
              v-if="event.status === 'active'"
              type="success"
              size="small"
              @click.stop="resolveEvent(event)"
            >
              手动解决
            </el-button>
            <el-button
              v-if="event.status === 'resolved'"
              type="danger"
              size="small"
              @click.stop="deleteEvent(event)"
            >
              <el-icon><i-ep-delete /></el-icon>
              删除
            </el-button>
            <el-button type="primary" size="small" text @click.stop="showEventDetail(event)">
              查看详情
            </el-button>
          </div>
        </div>

        <!-- Auto Response Result (only for alert events) -->
        <div v-if="event.type === 'alert' && event.autoResponseResult" class="auto-response-result">
          <el-divider />
          <div class="response-header">
            <el-icon :color="event.autoResponseResult.success ? '#67c23a' : '#f56c6c'">
              <component :is="event.autoResponseResult.success ? CircleCheckFilled : CircleCloseFilled" />
            </el-icon>
            <span>自动响应: {{ event.autoResponseResult.success ? '执行成功' : '执行失败' }}</span>
          </div>
          <div v-if="event.autoResponseResult.output" class="response-output">
            {{ event.autoResponseResult.output }}
          </div>
          <div v-if="event.autoResponseResult.error" class="response-error">
            {{ event.autoResponseResult.error }}
          </div>
        </div>
      </el-card>
    </div>

    <!-- Pagination (Requirements: 4.1, 4.2, 4.3, 4.4) -->
    <div v-if="viewMode === 'history' && totalEvents > 0" class="pagination-container">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="totalEvents"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="handleSizeChange"
        @current-change="handlePageChange"
      />
    </div>

    <!-- Event Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      :title="selectedEvent?.type === 'syslog' ? 'Syslog 事件详情' : '告警事件详情'"
      width="900px"
      destroy-on-close
      @open="loadEventAnalysis"
    >
      <template v-if="selectedEvent">
        <!-- Basic Info for Alert Events -->
        <el-descriptions v-if="selectedEvent.type === 'alert'" :column="2" border>
          <el-descriptions-item label="规则名称" :span="2">{{ selectedEvent.ruleName }}</el-descriptions-item>
          <el-descriptions-item label="严重级别">
            <el-tag :type="getSeverityType(selectedEvent.severity)" size="small">
              {{ getSeverityText(selectedEvent.severity) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="selectedEvent.status === 'active' ? 'danger' : 'success'" size="small">
              {{ selectedEvent.status === 'active' ? '活跃' : '已恢复' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="指标类型">{{ selectedEvent.metric ? getMetricText(selectedEvent.metric) : '-' }}</el-descriptions-item>
          <el-descriptions-item label="当前值">{{ selectedEvent.currentValue }}{{ selectedEvent.metric ? getMetricUnit(selectedEvent.metric) : '' }}</el-descriptions-item>
          <el-descriptions-item label="阈值">{{ selectedEvent.threshold }}{{ selectedEvent.metric ? getMetricUnit(selectedEvent.metric) : '' }}</el-descriptions-item>
          <el-descriptions-item label="规则 ID">{{ selectedEvent.ruleId }}</el-descriptions-item>
          <el-descriptions-item label="触发时间">{{ formatTime(selectedEvent.timestamp) }}</el-descriptions-item>
          <el-descriptions-item label="恢复时间">{{ selectedEvent.resolvedAt ? formatTime(selectedEvent.resolvedAt) : '-' }}</el-descriptions-item>
          
          <!-- System Association Info -->
          <el-descriptions-item label="通知渠道">
            <span v-if="selectedEvent.notifyChannels?.length">
              {{ getChannelNames(selectedEvent.notifyChannels) }}
            </span>
            <span v-else>-</span>
          </el-descriptions-item>
          <el-descriptions-item label="自动响应配置">
            <template v-if="selectedEvent.autoResponseConfig">
              <el-tag :type="selectedEvent.autoResponseConfig.enabled ? 'success' : 'info'" size="small">
                {{ selectedEvent.autoResponseConfig.enabled ? '已启用' : '未启用' }}
              </el-tag>
              <el-tooltip :content="selectedEvent.autoResponseConfig.script" placement="top" v-if="selectedEvent.autoResponseConfig.script">
                <el-icon class="ml-1" style="vertical-align: middle; cursor: help"><i-ep-info-filled /></el-icon>
              </el-tooltip>
            </template>
            <span v-else>-</span>
          </el-descriptions-item>

          <el-descriptions-item label="告警消息" :span="2">{{ selectedEvent.message }}</el-descriptions-item>
        </el-descriptions>

        <!-- Basic Info for Syslog Events -->
        <el-descriptions v-else :column="2" border>
          <el-descriptions-item label="事件类型" :span="2">
            <el-tag type="info" size="small">Syslog</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="分类">{{ selectedEvent.category || 'system' }}</el-descriptions-item>
          <el-descriptions-item label="严重级别">
            <el-tag :type="getSeverityType(selectedEvent.severity)" size="small">
              {{ getSeverityText(selectedEvent.severity) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="主机名">{{ selectedEvent.metadata?.hostname || '-' }}</el-descriptions-item>
          <el-descriptions-item label="Facility">{{ selectedEvent.metadata?.facility ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="Syslog Severity">{{ selectedEvent.metadata?.syslogSeverity ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="接收时间">{{ formatTime(selectedEvent.timestamp) }}</el-descriptions-item>
          <el-descriptions-item label="消息内容" :span="2">{{ selectedEvent.message }}</el-descriptions-item>
          <el-descriptions-item v-if="selectedEvent.rawData" label="原始数据" :span="2">
            <pre class="raw-data-pre">{{ JSON.stringify(selectedEvent.rawData, null, 2) }}</pre>
          </el-descriptions-item>
        </el-descriptions>

        <!-- Tabs for Analysis, Timeline, Remediation (for alert and syslog events) -->
        <el-tabs v-model="activeTab" class="detail-tabs">
          <!-- RAG Enhanced Analysis Tab (for both alert and syslog events) -->
          <el-tab-pane label="RAG 智能分析" name="rag">
            <RAGAnalysisPanel
              :loading="ragLoading"
              :rag-context="ragContext"
              :historical-references="ragHistoricalReferences"
              :citations="ragCitations"
              :has-historical-reference="ragHasHistoricalReference"
              :reference-status="ragReferenceStatus"
              :classification="ragClassification"
              :analysis-result="ragAnalysisResult"
              @analyze="loadRAGAnalysis"
              @refresh="() => loadRAGAnalysis(true)"
              @view-reference="viewRAGReference"
              @view-knowledge="viewKnowledgeEntry"
              @feedback="handleRAGFeedback"
            />
            
            <!-- 深入分析按钮 -->
            <div class="deep-analysis-section">
              <el-divider />
              <div class="deep-analysis-hint">
                <el-icon><i-ep-magic-stick /></el-icon>
                <span>需要更深入的分析？使用 AI Agent 进行多步推理分析</span>
              </div>
              <el-button type="primary" @click="goToDeepAnalysis">
                <el-icon><i-ep-chat-dot-round /></el-icon>
                深入分析
              </el-button>
            </div>
          </el-tab-pane>

          <!-- Event Timeline Tab (for both alert and syslog events) -->
          <el-tab-pane label="事件时间线" name="timeline">
            <div v-if="timelineLoading || analysisLoading" class="loading-container">
              <el-skeleton :rows="4" animated />
            </div>
            <div v-else-if="timelineError" class="timeline-error">
              <el-alert
                :title="timelineError"
                type="error"
                show-icon
                :closable="false"
              >
                <template #default>
                  <el-button type="primary" size="small" @click="loadTimelineData">
                    重新加载
                  </el-button>
                </template>
              </el-alert>
            </div>
            <div v-else-if="eventTimeline && eventTimeline.events.length > 0" class="timeline-content">
              <el-timeline>
                <el-timeline-item
                  v-for="item in eventTimeline.events"
                  :key="item.eventId"
                  :timestamp="formatTime(item.timestamp)"
                  :type="getTimelineItemType(item.type)"
                  :hollow="item.type === 'symptom'"
                  placement="top"
                >
                  <div class="timeline-item-content">
                    <el-tag :type="getTimelineTagType(item.type)" size="small">
                      {{ getTimelineTypeText(item.type) }}
                    </el-tag>
                    <span class="timeline-description">{{ item.description }}</span>
                  </div>
                </el-timeline-item>
              </el-timeline>
            </div>
            <el-empty v-else description="暂无时间线数据">
              <el-button type="primary" size="small" @click="loadTimelineData">
                加载时间线
              </el-button>
            </el-empty>
          </el-tab-pane>

          <!-- Related Events Tab (for both alert and syslog events) -->
          <el-tab-pane label="关联事件" name="related">
            <div v-if="relatedLoading" class="loading-container">
              <el-skeleton :rows="3" animated />
            </div>
            <div v-else-if="relatedAlerts.length > 0" class="related-content">
              <el-table :data="relatedAlerts" size="small" stripe @row-click="switchToAlert">
                <el-table-column prop="ruleName" label="规则名称" />
                <el-table-column prop="severity" label="严重级别" width="100">
                  <template #default="{ row }">
                    <el-tag :type="getSeverityType(row.severity)" size="small">
                      {{ getSeverityText(row.severity) }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="status" label="状态" width="80">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'active' ? 'danger' : 'success'" size="small">
                      {{ row.status === 'active' ? '活跃' : '已恢复' }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="triggeredAt" label="触发时间" width="180">
                  <template #default="{ row }">{{ formatTime(row.triggeredAt) }}</template>
                </el-table-column>
              </el-table>
            </div>
            <el-empty v-else description="暂无关联告警" />
          </el-tab-pane>

          <!-- Remediation Plan Tab (for both alert and syslog events) -->
          <el-tab-pane label="修复方案" name="remediation">
            <div v-if="remediationLoading || generatingPlan" class="loading-container">
              <el-skeleton :rows="4" animated />
              <div v-if="generatingPlan" class="generating-hint">
                <el-icon class="is-loading"><i-ep-loading /></el-icon>
                <span>正在生成修复方案...</span>
              </div>
            </div>
            <div v-else-if="remediationError && !ragAnalysisResult" class="remediation-error">
              <el-alert
                :title="remediationError"
                type="error"
                show-icon
                :closable="false"
              >
                <template #default>
                  <el-button type="primary" size="small" @click="loadRemediationPlan">
                    重新加载
                  </el-button>
                </template>
              </el-alert>
            </div>
            <div v-else-if="ragAnalysisResult || ragExecutableSteps.length > 0 || remediationPlan" class="remediation-content">
              <!-- AI Analysis Recommendations Section -->
              <div v-if="ragAnalysisResult" class="ai-recommendations-section">
                <div class="section-title">
                  <el-icon><i-ep-magic-stick /></el-icon>
                  AI 智能分析建议
                  <el-tag v-if="ragAnalysisResult.confidence" size="small" type="primary" class="confidence-tag">
                    置信度: {{ (ragAnalysisResult.confidence * 100).toFixed(0) }}%
                  </el-tag>
                </div>
                
                <!-- Analysis Summary -->
                <div v-if="ragAnalysisResult.summary" class="analysis-summary-card">
                  <div class="summary-header">
                    <el-icon color="#409eff"><i-ep-info-filled /></el-icon>
                    <span>分析摘要</span>
                  </div>
                  <div class="summary-text">{{ ragAnalysisResult.summary }}</div>
                </div>
                
                <!-- Detailed Analysis -->
                <div v-if="ragAnalysisResult.details" class="analysis-details-card">
                  <div class="details-header">
                    <el-icon color="#67c23a"><i-ep-document /></el-icon>
                    <span>详细分析</span>
                  </div>
                  <div class="details-text">{{ ragAnalysisResult.details }}</div>
                </div>
                
                <!-- Recommendations List -->
                <div v-if="ragAnalysisResult.recommendations?.length" class="recommendations-card">
                  <div class="recommendations-header">
                    <el-icon color="#e6a23c"><i-ep-list /></el-icon>
                    <span>处理建议</span>
                  </div>
                  <div class="recommendations-list">
                    <div 
                      v-for="(rec, index) in ragAnalysisResult.recommendations" 
                      :key="index"
                      class="recommendation-item"
                    >
                      <div class="rec-number">{{ index + 1 }}</div>
                      <div class="rec-content">{{ rec }}</div>
                    </div>
                  </div>
                </div>
                
                <!-- Risk Level -->
                <div v-if="ragAnalysisResult.riskLevel" class="risk-indicator">
                  <span class="risk-label">风险等级:</span>
                  <el-tag :type="getRiskType(ragAnalysisResult.riskLevel as any)" size="default">
                    {{ getRiskText(ragAnalysisResult.riskLevel as any) }}
                  </el-tag>
                </div>
              </div>

              <!-- LLM Generated Executable Steps Section -->
              <div v-if="ragExecutableSteps.length > 0" class="llm-executable-steps-section">
                <el-divider content-position="left">
                  <el-icon><i-ep-operation /></el-icon>
                  AI 生成的可执行修复步骤
                </el-divider>
                
                <el-steps direction="vertical" class="remediation-steps">
                  <el-step
                    v-for="step in ragExecutableSteps"
                    :key="step.order"
                    :title="`步骤 ${step.order}: ${step.description}`"
                    status="wait"
                  >
                    <template #description>
                      <div class="step-detail">
                        <div class="step-command">
                          <span class="command-label">命令:</span>
                          <el-tag type="info" class="command-tag">{{ step.command }}</el-tag>
                          <el-button 
                            type="primary" 
                            size="small" 
                            link 
                            @click="copyCommand(step.command)"
                          >
                            <el-icon><i-ep-copy-document /></el-icon>
                            复制
                          </el-button>
                        </div>
                        <div class="step-meta">
                          <el-tag :type="getRiskType(step.riskLevel)" size="small">
                            风险: {{ getRiskText(step.riskLevel) }}
                          </el-tag>
                          <el-tag v-if="step.autoExecutable" type="success" size="small">
                            <el-icon><i-ep-check /></el-icon> 可自动执行
                          </el-tag>
                          <el-tag v-else type="warning" size="small">
                            <el-icon><i-ep-user /></el-icon> 需手动确认
                          </el-tag>
                          <span class="step-duration">预估: {{ formatDuration(step.estimatedDuration) }}</span>
                        </div>
                      </div>
                    </template>
                  </el-step>
                </el-steps>
                
                <div class="llm-steps-note">
                  <el-alert type="info" :closable="false" show-icon>
                    <template #title>
                      以上步骤由 AI 根据告警分析自动生成，请在执行前仔细确认命令的正确性和安全性。
                    </template>
                  </el-alert>
                </div>
              </div>

              <!-- Divider between AI analysis and legacy remediation plan -->
              <el-divider v-if="ragAnalysisResult && remediationPlan && remediationPlan.steps?.length > 0" content-position="left">
                <el-icon><i-ep-operation /></el-icon>
                历史修复方案
              </el-divider>

              <!-- Executable Plan Section (only show if we have a real plan with steps) -->
              <div v-if="remediationPlan && remediationPlan.steps?.length > 0">
                <!-- Plan Overview -->
                <div class="plan-overview">
                  <el-descriptions :column="3" border size="small">
                    <el-descriptions-item label="整体风险">
                      <el-tag :type="getRiskType(remediationPlan.overallRisk)">
                        {{ getRiskText(remediationPlan.overallRisk) }}
                      </el-tag>
                    </el-descriptions-item>
                    <el-descriptions-item label="预估时间">
                      {{ formatDuration(remediationPlan.estimatedDuration) }}
                    </el-descriptions-item>
                    <el-descriptions-item label="状态">
                      <el-tag :type="getPlanStatusType(remediationPlan.status)">
                        {{ getPlanStatusText(remediationPlan.status) }}
                      </el-tag>
                    </el-descriptions-item>
                  </el-descriptions>
                </div>

              <!-- Remediation Steps -->
              <div class="section-title">
                <el-icon><i-ep-list /></el-icon>
                修复步骤
              </div>
              <el-steps :active="currentExecutingStep" direction="vertical" class="remediation-steps">
                <el-step
                  v-for="step in remediationPlan.steps"
                  :key="step.order"
                  :title="`步骤 ${step.order}: ${step.description}`"
                  :status="getStepStatus(step.order)"
                >
                  <template #description>
                    <div class="step-detail">
                      <div class="step-command">
                        <span class="command-label">命令:</span>
                        <el-tag type="info" class="command-tag">{{ step.command }}</el-tag>
                      </div>
                      <div class="step-meta">
                        <el-tag :type="getRiskType(step.riskLevel)" size="small">
                          风险: {{ getRiskText(step.riskLevel) }}
                        </el-tag>
                        <el-tag v-if="step.autoExecutable" type="success" size="small">
                          <el-icon><i-ep-check /></el-icon> 可自动执行
                        </el-tag>
                        <el-tag v-else type="warning" size="small">
                          <el-icon><i-ep-user /></el-icon> 需手动确认
                        </el-tag>
                        <span class="step-duration">预估: {{ formatDuration(step.estimatedDuration) }}</span>
                      </div>
                      <!-- Execution Result -->
                      <div v-if="getStepResult(step.order)" class="step-result">
                        <el-alert
                          :type="getStepResult(step.order)?.success ? 'success' : 'error'"
                          :title="getStepResult(step.order)?.success ? '执行成功' : '执行失败'"
                          :closable="false"
                          show-icon
                        >
                          <template v-if="getStepResult(step.order)?.output">
                            <pre class="result-output">{{ getStepResult(step.order)?.output }}</pre>
                          </template>
                          <template v-if="getStepResult(step.order)?.error">
                            <pre class="result-error">{{ getStepResult(step.order)?.error }}</pre>
                          </template>
                        </el-alert>
                      </div>
                    </div>
                  </template>
                </el-step>
              </el-steps>

              <!-- Action Buttons -->
              <div class="remediation-actions">
                <el-button
                  v-if="remediationPlan.status === 'pending'"
                  type="primary"
                  :loading="executing"
                  @click="executeRemediation"
                >
                  <el-icon><i-ep-video-play /></el-icon>
                  一键执行自动步骤
                </el-button>
                <el-button
                  v-if="remediationPlan.status === 'completed' || remediationPlan.status === 'failed'"
                  type="warning"
                  :loading="rollingBack"
                  @click="executeRollback"
                >
                  <el-icon><i-ep-refresh-left /></el-icon>
                  执行回滚
                </el-button>
              </div>

              <!-- Rollback Steps -->
              <div v-if="remediationPlan.rollback.length > 0" class="rollback-section">
                <el-collapse>
                  <el-collapse-item title="回滚步骤" name="rollback">
                    <div v-for="step in remediationPlan.rollback" :key="step.order" class="rollback-step">
                      <span class="rollback-order">{{ step.order }}.</span>
                      <span class="rollback-desc">{{ step.description }}</span>
                      <el-tag type="info" size="small">{{ step.command }}</el-tag>
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </div>
              </div>
            </div>
            <el-empty v-else description="暂无修复方案">
              <el-button type="primary" :loading="generatingPlan" @click="generateRemediationPlan">
                生成修复方案
              </el-button>
            </el-empty>
          </el-tab-pane>

          <!-- 决策记录 Tab -->
          <el-tab-pane label="决策记录" name="decisions">
            <div v-if="decisionRecords.length > 0">
              <el-table :data="decisionRecords" size="small" stripe>
                <el-table-column prop="ruleName" label="决策规则" min-width="140" />
                <el-table-column prop="action" label="执行动作" min-width="160" />
                <el-table-column prop="result" label="结果" width="100">
                  <template #default="{ row }">
                    <el-tag :type="row.result === 'success' ? 'success' : 'danger'" size="small">
                      {{ row.result === 'success' ? '成功' : '失败' }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="timestamp" label="时间" width="160">
                  <template #default="{ row }">{{ formatTime(row.timestamp) }}</template>
                </el-table-column>
              </el-table>
            </div>
            <el-empty v-else description="暂无决策记录" />
          </el-tab-pane>

          <!-- 事件状态流转 Tab -->
          <el-tab-pane label="状态流转" name="statusFlow">
            <div class="status-flow-container">
              <el-steps :active="getStatusFlowStep(selectedEvent)" finish-status="success" align-center>
                <el-step title="创建" description="事件触发" />
                <el-step title="确认" description="系统确认" />
                <el-step title="处理中" description="执行修复" />
                <el-step title="已解决" description="问题修复" />
              </el-steps>
            </div>
          </el-tab-pane>
        </el-tabs>

        <!-- User Feedback Section (for both alert and syslog events) -->
        <div class="feedback-section">
          <el-divider content-position="left">
            <el-icon><i-ep-chat-line-square /></el-icon>
            反馈评价
          </el-divider>
          <div class="feedback-content">
            <span class="feedback-label">此告警分析对您有帮助吗？</span>
            <div class="feedback-buttons">
              <el-button
                :type="feedbackSubmitted === 'useful' ? 'success' : 'default'"
                :disabled="feedbackSubmitted !== null"
                @click="submitFeedback(true)"
              >
                <el-icon><i-ep-circle-check-filled /></el-icon>
                有用
              </el-button>
              <el-button
                :type="feedbackSubmitted === 'not_useful' ? 'danger' : 'default'"
                :disabled="feedbackSubmitted !== null"
                @click="submitFeedback(false)"
              >
                <el-icon><i-ep-circle-close-filled /></el-icon>
                无用
              </el-button>
            </div>
            <el-input
              v-if="feedbackSubmitted"
              v-model="feedbackComment"
              type="textarea"
              :rows="2"
              placeholder="可选：添加更多反馈意见..."
              class="feedback-comment"
              @blur="updateFeedbackComment"
            />
          </div>
        </div>

        <!-- Legacy AI Analysis Section (for backward compatibility, only for alert events) -->
        <div v-if="selectedEvent.type === 'alert' && selectedEvent.aiAnalysis && !rootCauseAnalysis" class="ai-analysis-section">
          <el-divider content-position="left">
            <el-icon><i-ep-magic-stick /></el-icon>
            AI 分析
          </el-divider>
          <div class="ai-analysis-content">
            <el-icon color="#409eff" :size="20"><i-ep-chat-dot-round /></el-icon>
            <div class="analysis-text">{{ selectedEvent.aiAnalysis }}</div>
          </div>
        </div>

        <!-- Auto Response Section (only for alert events) -->
        <div v-if="selectedEvent.type === 'alert' && selectedEvent.autoResponseResult" class="auto-response-section">
          <el-divider content-position="left">
            <el-icon><i-ep-operation /></el-icon>
            自动响应结果
          </el-divider>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="执行状态">
              <el-tag :type="selectedEvent.autoResponseResult.success ? 'success' : 'danger'" size="small">
                {{ selectedEvent.autoResponseResult.success ? '成功' : '失败' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item v-if="selectedEvent.autoResponseResult.output" label="输出">
              <pre class="response-pre">{{ selectedEvent.autoResponseResult.output }}</pre>
            </el-descriptions-item>
            <el-descriptions-item v-if="selectedEvent.autoResponseResult.error" label="错误">
              <pre class="response-pre error">{{ selectedEvent.autoResponseResult.error }}</pre>
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button
          v-if="selectedEvent?.status === 'active'"
          type="success"
          @click="resolveEvent(selectedEvent!)"
        >
          手动解决
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Refresh, CircleCheckFilled, CircleCloseFilled } from '@element-plus/icons-vue'

import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  alertEventsApi,
  analysisApi,
  remediationPlansApi,
  feedbackApi,
  notificationChannelsApi, // Import notificationChannelsApi
  type AlertEvent,
  type AlertSeverity,
  type MetricType,
  type RootCauseAnalysis,
  type EventTimeline,
  type RemediationPlan,
  type ExecutionResult,
  type RiskLevel,
  type RemediationPlanStatus,
  type TimelineEventType,
  type UnifiedEvent,
  type PaginatedUnifiedEvents,
  type NotificationChannel // Import type
} from '@/api/ai-ops'
import { analyzeApi, type RAGContext, type HistoricalAlertReference, type HistoricalPlanReference, type RAGCitation, type ReferenceStatus, type AlertClassification, type ExecutableStep } from '@/api/rag'
import RAGAnalysisPanel from '@/components/RAGAnalysisPanel.vue'
import { useDeviceStore } from '@/stores/device'
import { storeToRefs } from 'pinia'
import { decisionApi } from '@/api/aiops-enhanced'

const route = useRoute()
const router = useRouter()
const deviceStore = useDeviceStore()
const { currentDeviceId, devices } = storeToRefs(deviceStore)

// 设备名称映射
const getDeviceName = (deviceId?: string) => {
  if (!deviceId) return ''
  return devices.value.find(d => d.id === deviceId)?.name || ''
}

// State
const loading = ref(false)
const error = ref('')
const events = ref<UnifiedEvent[]>([])
const viewMode = ref<'active' | 'history'>('active')
const detailVisible = ref(false)
const selectedEvent = ref<UnifiedEvent | null>(null)
const activeTab = ref('rag')
const decisionRecords = ref<Array<{ id: string; ruleId: string; ruleName: string; action: string; result: string; timestamp: number }>>([])

// Selection state
const selectedIds = ref<Set<string>>(new Set())
const batchResolving = ref(false)
const batchDeleting = ref(false)

// Pagination state (Requirements: 4.1, 4.2, 4.3, 4.4)
const currentPage = ref(1)
const pageSize = ref(20)
const totalEvents = ref(0)

// Filters
const dateRange = ref<[number, number] | null>(null)
const sourceFilter = ref<'all' | 'metrics' | 'syslog'>('all')
const severityFilter = ref<AlertSeverity | ''>('')
const statusFilter = ref<'active' | 'resolved' | ''>('')

// Analysis state
const analysisLoading = ref(false)
const rootCauseAnalysis = ref<RootCauseAnalysis | null>(null)
const eventTimeline = ref<EventTimeline | null>(null)
// Timeline error state - Requirements 4.4, 4.5
const timelineError = ref<string | null>(null)
const timelineLoading = ref(false)

// Related alerts state
const relatedLoading = ref(false)
const relatedAlerts = ref<AlertEvent[]>([])

// Remediation state
const remediationLoading = ref(false)
const remediationPlan = ref<RemediationPlan | null>(null)
const executionResults = ref<ExecutionResult[]>([])
const executing = ref(false)
const rollingBack = ref(false)
const generatingPlan = ref(false)
const currentExecutingStep = ref(-1)
// Remediation error state - Requirements 5.3, 5.4
const remediationError = ref<string | null>(null)

// Feedback state
const feedbackSubmitted = ref<'useful' | 'not_useful' | null>(null)
const feedbackComment = ref('')

// RAG Analysis state
const ragLoading = ref(false)
const ragContext = ref<RAGContext | null>(null)
const ragHistoricalReferences = ref<HistoricalAlertReference[]>([])
const ragCitations = ref<RAGCitation[]>([])
// New RAG state fields - Requirements 5.1, 5.2, 5.5
const ragHasHistoricalReference = ref<boolean | undefined>(undefined)
const ragReferenceStatus = ref<ReferenceStatus | undefined>(undefined)
const ragClassification = ref<AlertClassification | null>(null)

// Notification Channels State
const notificationChannels = ref<NotificationChannel[]>([])
const channelsLoading = ref(false)

const loadNotificationChannels = async () => {
  try {
    channelsLoading.value = true
    const res = await notificationChannelsApi.getAll()
    if (res.data.success && res.data.data) {
      notificationChannels.value = res.data.data
    }
  } catch (error) {
    console.error('Failed to load notification channels:', error)
  } finally {
    channelsLoading.value = false
  }
}

const getChannelNames = (channelIds?: string[]) => {
  if (!channelIds || channelIds.length === 0) return '-'
  
  if (notificationChannels.value.length === 0) {
     if (channelsLoading.value) return '加载中...'
     // Fallback to IDs if channels failed to load or are empty
     return channelIds.join(', ')
  }

  return channelIds.map(id => {
    const channel = notificationChannels.value.find(c => c.id === id)
    return channel ? channel.name : id
  }).join(', ')
}

// RAG AI analysis result - LLM 深度分析结果
const ragAnalysisResult = ref<{
  summary?: string
  details?: string
  recommendations?: string[]
  riskLevel?: string
  confidence?: number
} | null>(null)
// RAG executable steps - LLM 生成的可执行修复步骤
const ragExecutableSteps = ref<ExecutableStep[]>([])
// Frontend cache tracking - Requirements 3.1, 3.2
const lastLoadedAlertId = ref<string | null>(null)

// Date shortcuts
const dateShortcuts = [
  {
    text: '最近1小时',
    value: () => {
      const end = Date.now()
      const start = end - 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近24小时',
    value: () => {
      const end = Date.now()
      const start = end - 24 * 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近7天',
    value: () => {
      const end = Date.now()
      const start = end - 7 * 24 * 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近30天',
    value: () => {
      const end = Date.now()
      const start = end - 30 * 24 * 3600 * 1000
      return [start, end]
    }
  }
]

// Computed
const activeCount = computed(() => {
  return events.value.filter(e => e.status === 'active').length
})

const activeEvents = computed(() => {
  return events.value.filter(e => e.status === 'active')
})

const selectedEvents = computed(() => {
  return activeEvents.value.filter(e => selectedIds.value.has(e.id))
})

const selectAll = computed({
  get: () => {
    return activeEvents.value.length > 0 && selectedIds.value.size === activeEvents.value.length
  },
  set: () => {}
})

const isIndeterminate = computed(() => {
  return selectedIds.value.size > 0 && selectedIds.value.size < activeEvents.value.length
})

const filteredEvents = computed(() => {
  let result = events.value

  // 活跃模式下，首先过滤出活跃事件（包括 alert 和 syslog 类型）
  // 并且在本地进行严重级别和状态过滤，因为历史模式已经由后端处理过滤
  if (viewMode.value === 'active') {
    result = result.filter(e => e.status === 'active')
    
    if (severityFilter.value) {
      result = result.filter(e => e.severity === severityFilter.value)
    }

    if (statusFilter.value) {
      result = result.filter(e => e.status === statusFilter.value)
    }
    
    return result.sort((a, b) => b.timestamp - a.timestamp)
  }

  // 历史模式下，后端已经在此前处理了过滤、排序和分页，直接返回
  return result
})

// Computed property for resolved events selection state (History Mode)
const resolvedEventsSelection = computed(() => {
  const resolvedEvents = filteredEvents.value.filter(e => e.status === 'resolved')
  const selectedResolvedCount = resolvedEvents.filter(e => selectedIds.value.has(e.id)).length
  const totalResolvedCount = resolvedEvents.length
  
  return {
    allSelected: totalResolvedCount > 0 && selectedResolvedCount === totalResolvedCount,
    indeterminate: selectedResolvedCount > 0 && selectedResolvedCount < totalResolvedCount,
    selectedCount: selectedResolvedCount
  }
})

// Selection methods
const isSelected = (id: string): boolean => {
  return selectedIds.value.has(id)
}

const toggleSelection = (id: string, selected: boolean) => {
  if (selected) {
    selectedIds.value.add(id)
  } else {
    selectedIds.value.delete(id)
  }
  selectedIds.value = new Set(selectedIds.value)
}

const handleSelectAllChange = (val: boolean) => {
  if (val) {
    activeEvents.value.forEach(e => selectedIds.value.add(e.id))
  } else {
    selectedIds.value.clear()
  }
  selectedIds.value = new Set(selectedIds.value)
}

// Handle select all resolved events in history mode (Requirements: 4.6)
const handleSelectAllResolvedChange = (val: boolean) => {
  const resolvedEvents = filteredEvents.value.filter(e => e.status === 'resolved')
  if (val) {
    resolvedEvents.forEach(e => selectedIds.value.add(e.id))
  } else {
    resolvedEvents.forEach(e => selectedIds.value.delete(e.id))
  }
  selectedIds.value = new Set(selectedIds.value)
}

const clearSelection = () => {
  selectedIds.value.clear()
  selectedIds.value = new Set(selectedIds.value)
}

// Batch resolve
const batchResolveEvents = async () => {
  if (selectedEvents.value.length === 0) return

  try {
    await ElMessageBox.confirm(
      `确定要批量解决选中的 ${selectedEvents.value.length} 个告警吗？`,
      '批量解决告警',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    batchResolving.value = true
    let successCount = 0
    let failCount = 0

    for (const event of selectedEvents.value) {
      try {
        await alertEventsApi.resolve(event.id)
        successCount++
      } catch {
        failCount++
      }
    }

    if (failCount === 0) {
      ElMessage.success(`成功解决 ${successCount} 个告警`)
    } else {
      ElMessage.warning(`成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    clearSelection()
    await loadEvents()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('批量操作失败')
    }
  } finally {
    batchResolving.value = false
  }
}

// Watch view mode changes
watch(viewMode, () => {
  clearSelection()
  loadEvents()
})

// Watch device changes
watch(currentDeviceId, () => {
  clearSelection()
  loadEvents()
})

// Watch filter changes for remote pagination
watch([severityFilter, statusFilter], () => {
  if (viewMode.value !== 'active') {
    currentPage.value = 1
    loadEvents()
  }
})

// Watch activeTab changes to auto-load RAG analysis and timeline
// Simplified logic - Requirements 3.2, 3.4
// Since showEventDetail already auto-loads, this watch only handles
// cases where user switches back to RAG tab after viewing other tabs
watch(activeTab, (newTab) => {
  if (newTab === 'rag' && selectedEvent.value) {
    // loadRAGAnalysis has built-in cache check, will skip if already loaded
    loadRAGAnalysis()
  }
  // 时间线 Tab 延迟加载 - 仅在用户切换到时间线 Tab 且数据未加载时才加载
  if (newTab === 'timeline' && selectedEvent.value && !eventTimeline.value) {
    loadTimelineData()
  }
})

// Load events on mount
onMounted(() => {
  const eventId = route.query.id as string
  if (eventId) {
    loadEventById(eventId)
  }

  const end = Date.now()
  const start = end - 24 * 3600 * 1000
  dateRange.value = [start, end]

  loadEvents()
  loadNotificationChannels()
})

// Load events
const loadEvents = async () => {
  loading.value = true
  error.value = ''

  try {
    // Determine includeSyslog based on sourceFilter
    const includeSyslog = sourceFilter.value === 'all' || sourceFilter.value === 'syslog'
    const source = sourceFilter.value === 'all' ? undefined : sourceFilter.value
    
    if (viewMode.value === 'active') {
      // 使用新的合并事件 API
      const response = await alertEventsApi.getActiveUnified(includeSyslog, source, currentDeviceId.value)
      if (response.data.success && response.data.data) {
        events.value = response.data.data
        totalEvents.value = response.data.data.length
      } else {
        throw new Error(response.data.error || '获取告警事件失败')
      }
    } else {
      // History mode with pagination (Requirements: 4.1, 4.2, 4.3)
      const [from, to] = dateRange.value || [Date.now() - 24 * 3600 * 1000, Date.now()]
      // 使用新的合并事件 API，并带上前端选择的过滤器
      const severity = severityFilter.value || undefined
      const status = statusFilter.value || undefined
      const response = await alertEventsApi.getUnified(from, to, currentPage.value, pageSize.value, includeSyslog, source, currentDeviceId.value, severity, status)
      
      if (response.data.success && response.data.data) {
        const data = response.data.data as PaginatedUnifiedEvents
        events.value = data.items
        totalEvents.value = data.total
      } else {
        throw new Error(response.data.error || '获取告警事件失败')
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取告警事件失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Handle page change (Requirements: 4.4)
const handlePageChange = (page: number) => {
  currentPage.value = page
  loadEvents()
}

// Handle page size change (Requirements: 4.2)
const handleSizeChange = (size: number) => {
  pageSize.value = size
  currentPage.value = 1
  loadEvents()
}

// Load single event by ID
const loadEventById = async (id: string) => {
  try {
    const response = await alertEventsApi.getById(id)
    if (response.data.success && response.data.data) {
      // Convert AlertEvent to UnifiedEvent
      const alertEvent = response.data.data
      const unifiedEvent: UnifiedEvent = {
        id: alertEvent.id,
        type: 'alert',
        severity: alertEvent.severity,
        message: alertEvent.message,
        timestamp: alertEvent.triggeredAt,
        status: alertEvent.status,
        ruleName: alertEvent.ruleName,
        ruleId: alertEvent.ruleId,
        metric: alertEvent.metric,
        metricLabel: alertEvent.metricLabel,
        currentValue: alertEvent.currentValue,
        threshold: alertEvent.threshold,
        resolvedAt: alertEvent.resolvedAt,
        aiAnalysis: alertEvent.aiAnalysis,
        autoResponseResult: alertEvent.autoResponseResult,
      }
      // Use showEventDetail to properly initialize all states and auto-load analysis
      showEventDetail(unifiedEvent)
    }
  } catch (err) {
    console.error('Failed to load event:', err)
  }
}

// Filter events
const filterEvents = () => {
  // Filtering is done in computed property
}

// Show event detail
const showEventDetail = (event: UnifiedEvent) => {
  selectedEvent.value = event
  detailVisible.value = true
  // Reset states
  activeTab.value = 'rag'
  rootCauseAnalysis.value = null
  eventTimeline.value = null
  // Reset timeline error state - Requirements 4.4, 4.5
  timelineError.value = null
  timelineLoading.value = false
  relatedAlerts.value = []
  remediationPlan.value = null
  executionResults.value = []
  // Reset remediation error state - Requirements 5.3, 5.4
  remediationError.value = null
  feedbackSubmitted.value = null
  feedbackComment.value = ''
  // Reset RAG states
  ragContext.value = null
  ragHistoricalReferences.value = []
  ragCitations.value = []
  // Reset new RAG state fields
  ragHasHistoricalReference.value = undefined
  ragReferenceStatus.value = undefined
  ragClassification.value = null
  ragAnalysisResult.value = null
  // Reset last loaded alert ID to force reload for new event
  lastLoadedAlertId.value = null
  
  // Only load analysis for alert events
  if (event.type === 'alert') {
    // Auto-trigger RAG analysis loading - Requirements 2.3, 3.5
    loadRAGAnalysis()
    
    // Auto-trigger remediation plan loading - Requirements 5.1
    loadRemediationPlan()
  } else if (event.type === 'syslog') {
    // Auto-trigger RAG analysis loading for syslog events - Requirements 7.1, 7.2
    loadRAGAnalysis()
  }
}

// Load event analysis data
const loadEventAnalysis = async () => {
  if (!selectedEvent.value) return

  // Load root cause analysis
  analysisLoading.value = true
  try {
    const response = await analysisApi.getAnalysis(selectedEvent.value.id)
    if (response.data.success && response.data.data) {
      rootCauseAnalysis.value = response.data.data
      eventTimeline.value = response.data.data.timeline
    }
  } catch (err) {
    console.error('Failed to load analysis:', err)
  } finally {
    analysisLoading.value = false
  }

  // Load related alerts
  relatedLoading.value = true
  try {
    const response = await analysisApi.getRelatedAlerts(selectedEvent.value.id)
    if (response.data.success && response.data.data) {
      relatedAlerts.value = response.data.data.filter(a => a.id !== selectedEvent.value?.id)
    }
  } catch (err) {
    console.error('Failed to load related alerts:', err)
  } finally {
    relatedLoading.value = false
  }

  // Load remediation plan
  remediationLoading.value = true
  try {
    const response = await remediationPlansApi.getPlan(selectedEvent.value.id)
    if (response.data.success && response.data.data) {
      remediationPlan.value = response.data.data
    }
  } catch (err) {
    console.error('Failed to load remediation plan:', err)
  } finally {
    remediationLoading.value = false
  }

  // Load decision records for this event
  try {
    const res = await decisionApi.getHistory()
    if (res.data.success && res.data.data) {
      decisionRecords.value = res.data.data.filter(d => d.ruleId === selectedEvent.value?.ruleId).slice(0, 10)
    }
  } catch { /* non-critical */ }
}

// Load RAG enhanced analysis
const loadRAGAnalysis = async (forceRefresh = false) => {
  if (!selectedEvent.value) return

  // Frontend cache check - Requirements 3.1, 3.2
  // Skip loading if same alert and data already exists (unless force refresh)
  if (!forceRefresh && 
      lastLoadedAlertId.value === selectedEvent.value.id && 
      ragContext.value !== null) {
    return
  }

  ragLoading.value = true
  ragContext.value = null
  ragHistoricalReferences.value = []
  ragCitations.value = []
  // Reset new RAG state fields
  ragHasHistoricalReference.value = undefined
  ragReferenceStatus.value = undefined
  ragClassification.value = null
  ragAnalysisResult.value = null
  ragExecutableSteps.value = []

  try {
    const response = await analyzeApi.analyzeAlert(
      selectedEvent.value.id,
      selectedEvent.value,
      undefined
    )
    if (response.data.success && response.data.data) {
      ragContext.value = response.data.data.ragContext
      ragHistoricalReferences.value = response.data.data.historicalReferences || []
      // Extract new fields - Requirements 5.1, 5.2, 5.5
      ragHasHistoricalReference.value = response.data.data.hasHistoricalReference
      ragReferenceStatus.value = response.data.data.referenceStatus
      ragClassification.value = response.data.data.classification || null
      // Extract AI analysis result - LLM 深度分析结果
      ragAnalysisResult.value = response.data.data.analysis as typeof ragAnalysisResult.value
      // Extract executable steps - LLM 生成的可执行修复步骤
      ragExecutableSteps.value = response.data.data.executableSteps || []
      // Update last loaded alert ID - Requirements 3.1
      lastLoadedAlertId.value = selectedEvent.value.id
    }
  } catch (err) {
    console.error('Failed to load RAG analysis:', err)
    ElMessage.error('RAG 分析加载失败')
  } finally {
    ragLoading.value = false
  }
  
  // 时间线数据延迟加载 - 移至 activeTab watcher 中按需加载
  // 原: loadTimelineData() - 移除以优化性能
}

// Load timeline data - Requirements 4.1, 4.2, 4.4, 4.5
const loadTimelineData = async () => {
  if (!selectedEvent.value) return
  
  timelineLoading.value = true
  timelineError.value = null
  
  try {
    const response = await analysisApi.getAnalysis(selectedEvent.value.id)
    if (response.data.success && response.data.data) {
      rootCauseAnalysis.value = response.data.data
      eventTimeline.value = response.data.data.timeline
    }
  } catch (err) {
    console.error('Failed to load timeline data:', err)
    timelineError.value = '时间线数据加载失败'
  } finally {
    timelineLoading.value = false
    analysisLoading.value = false
  }
}

// Handle RAG feedback
const handleRAGFeedback = (value: 'helpful' | 'not_helpful', comment?: string) => {
  console.log('RAG feedback:', value, comment)
  // Feedback is handled by the panel component
}

// 跳转到 AI Agent 页面进行深入分析
const goToDeepAnalysis = () => {
  if (!selectedEvent.value) return
  
  // 构建告警信息作为初始消息
  const alertInfo = `请深入分析以下告警事件：

告警信息：
- 告警 ID: ${selectedEvent.value.id}
- 规则名称: ${selectedEvent.value.ruleName}
- 严重级别: ${selectedEvent.value.severity}
- 指标: ${selectedEvent.value.metric}
- 当前值: ${selectedEvent.value.currentValue}
- 阈值: ${selectedEvent.value.threshold}
- 消息: ${selectedEvent.value.message}
- 状态: ${selectedEvent.value.status}
- 触发时间: ${new Date(selectedEvent.value.timestamp).toLocaleString()}

请执行以下分析：
1. 获取当前系统状态（CPU、内存、磁盘、接口等）
2. 查询相关配置信息
3. 搜索类似告警的历史处理经验
4. 分析告警原因并提供详细的处理建议`

  // 使用 URL 参数传递初始消息，跳转到 AI Agent 页面
  const encodedMessage = encodeURIComponent(alertInfo)
  router.push({
    path: '/ai/unified',
    query: {
      mode: 'knowledge-enhanced',
      message: encodedMessage,
      alertId: selectedEvent.value.id
    }
  })
}

// View RAG reference
const viewRAGReference = (ref: HistoricalAlertReference | HistoricalPlanReference) => {
  if ('alertId' in ref && ref.alertId) {
    // Open in new dialog or show inline instead of replacing current event
    ElMessageBox.confirm(
      `是否查看历史告警详情？\n\n告警 ID: ${ref.alertId}`,
      '查看历史参考',
      {
        confirmButtonText: '在新窗口打开',
        cancelButtonText: '取消',
        type: 'info'
      }
    ).then(() => {
      // Open in new tab/window
      window.open(`/ai-ops/alerts?id=${ref.alertId}`, '_blank')
    }).catch(() => {
      // User cancelled
    })
  } else if ('planId' in ref && ref.planId) {
    // Handle plan reference - could navigate to remediation view
    ElMessage.info(`修复方案 ID: ${ref.planId}`)
  }
}

// View knowledge entry
const viewKnowledgeEntry = (entryId: string) => {
  // Navigate to knowledge base view with the entry ID
  window.open(`/ai-ops/knowledge?id=${entryId}`, '_blank')
}

// Generate remediation plan
const generateRemediationPlan = async () => {
  if (!selectedEvent.value) return

  generatingPlan.value = true
  remediationError.value = null
  try {
    const response = await remediationPlansApi.generatePlan(selectedEvent.value.id)
    if (response.data.success && response.data.data) {
      remediationPlan.value = response.data.data
      ElMessage.success('修复方案已生成')
    }
  } catch (err) {
    remediationError.value = '生成修复方案失败'
    ElMessage.error('生成修复方案失败')
  } finally {
    generatingPlan.value = false
  }
}

// Load remediation plan - Requirements 5.1, 5.2, 5.5
// First tries to get existing plan, then auto-generates if none exists
const loadRemediationPlan = async () => {
  if (!selectedEvent.value) return
  
  // Skip if already have a plan for this alert - Requirements 5.5
  if (remediationPlan.value) return
  
  remediationLoading.value = true
  remediationError.value = null
  
  try {
    // First try to get existing plan - Requirements 5.1
    const response = await remediationPlansApi.getPlan(selectedEvent.value.id)
    if (response.data.success && response.data.data) {
      remediationPlan.value = response.data.data
    } else {
      // No existing plan, auto-generate - Requirements 5.2
      await generateRemediationPlan()
    }
  } catch (err) {
    // Get failed, try to generate - Requirements 5.2
    try {
      await generateRemediationPlan()
    } catch (genErr) {
      remediationError.value = '加载或生成修复方案失败'
      console.error('Failed to load or generate remediation plan:', genErr)
    }
  } finally {
    remediationLoading.value = false
  }
}

// Execute remediation
const executeRemediation = async () => {
  if (!remediationPlan.value) return

  try {
    await ElMessageBox.confirm(
      '确定要执行修复方案吗？将自动执行所有可自动执行的步骤。',
      '执行修复',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    executing.value = true
    currentExecutingStep.value = 0

    const response = await remediationPlansApi.executePlan(remediationPlan.value.id)
    if (response.data.success && response.data.data) {
      executionResults.value = response.data.data
      // Reload plan to get updated status
      const planResponse = await remediationPlansApi.getPlan(selectedEvent.value!.id)
      if (planResponse.data.success && planResponse.data.data) {
        remediationPlan.value = planResponse.data.data
      }
      ElMessage.success('修复执行完成')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('执行修复失败')
    }
  } finally {
    executing.value = false
    currentExecutingStep.value = -1
  }
}

// Execute rollback
const executeRollback = async () => {
  if (!remediationPlan.value) return

  try {
    await ElMessageBox.confirm(
      '确定要执行回滚吗？这将撤销之前的修复操作。',
      '执行回滚',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    rollingBack.value = true
    const response = await remediationPlansApi.executeRollback(remediationPlan.value.id)
    if (response.data.success) {
      // Reload plan
      const planResponse = await remediationPlansApi.getPlan(selectedEvent.value!.id)
      if (planResponse.data.success && planResponse.data.data) {
        remediationPlan.value = planResponse.data.data
      }
      ElMessage.success('回滚执行完成')
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('执行回滚失败')
    }
  } finally {
    rollingBack.value = false
  }
}

// Get step execution result
const getStepResult = (stepOrder: number): ExecutionResult | undefined => {
  return executionResults.value.find(r => r.stepOrder === stepOrder)
}

// Get step status for el-steps
const getStepStatus = (stepOrder: number): 'wait' | 'process' | 'finish' | 'error' | 'success' => {
  const result = getStepResult(stepOrder)
  if (result) {
    return result.success ? 'success' : 'error'
  }
  if (currentExecutingStep.value === stepOrder - 1) {
    return 'process'
  }
  return 'wait'
}

// Switch to another alert
const switchToAlert = (row: AlertEvent) => {
  // Convert AlertEvent to UnifiedEvent
  const unifiedEvent: UnifiedEvent = {
    id: row.id,
    type: 'alert',
    severity: row.severity,
    message: row.message,
    timestamp: row.triggeredAt,
    status: row.status,
    ruleName: row.ruleName,
    ruleId: row.ruleId,
    metric: row.metric,
    metricLabel: row.metricLabel,
    currentValue: row.currentValue,
    threshold: row.threshold,
    resolvedAt: row.resolvedAt,
    aiAnalysis: row.aiAnalysis,
    autoResponseResult: row.autoResponseResult,
  }
  selectedEvent.value = unifiedEvent
  loadEventAnalysis()
}

// Submit feedback
const submitFeedback = async (useful: boolean) => {
  if (!selectedEvent.value) return

  try {
    await feedbackApi.submit({
      alertId: selectedEvent.value.id,
      useful,
      comment: feedbackComment.value || undefined
    })
    feedbackSubmitted.value = useful ? 'useful' : 'not_useful'
    ElMessage.success('感谢您的反馈')
  } catch (err) {
    ElMessage.error('提交反馈失败')
  }
}

// Update feedback comment
const updateFeedbackComment = async () => {
  // Comment is included in the initial feedback submission
  // This is just for UI purposes
}

// Resolve event
const resolveEvent = async (event: UnifiedEvent) => {
  // 支持解决所有类型的活跃事件（alert 和 syslog）
  // 后端 alertEngine.resolveAlert() 已支持解决 Syslog 事件

  try {
    await ElMessageBox.confirm(
      '确定要手动解决此告警吗？这将标记告警为已恢复状态。',
      '确认操作',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await alertEventsApi.resolve(event.id)
    ElMessage.success('告警已解决')
    detailVisible.value = false
    await loadEvents()
  } catch (err) {
    if (err !== 'cancel') {
      const message = err instanceof Error ? err.message : '操作失败'
      ElMessage.error(message)
    }
  }
}

// Delete event (Requirements: 4.5, 4.7, 4.8)
const deleteEvent = async (event: UnifiedEvent) => {
  // 支持删除所有类型的已解决事件（alert 和 syslog）
  // 后端 alertEngine.deleteAlertEvent() 已支持删除 Syslog 事件

  if (event.status === 'active') {
    ElMessage.warning('活跃事件不能删除，请先解决')
    return
  }

  // 适配 Syslog 事件（Syslog 没有 ruleName）
  const eventName = event.type === 'syslog' 
    ? (event.category || 'Syslog 事件')
    : event.ruleName

  try {
    await ElMessageBox.confirm(
      `确定要删除事件 "${eventName}" 吗？此操作不可恢复。`,
      '确认删除',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await alertEventsApi.delete(event.id)
    ElMessage.success('事件已删除')
    detailVisible.value = false
    await loadEvents()
  } catch (err) {
    if (err !== 'cancel') {
      const message = err instanceof Error ? err.message : '删除失败'
      ElMessage.error(message)
    }
  }
}

// Batch delete events (Requirements: 4.6, 4.7, 4.8)
const batchDeleteEvents = async () => {
  // Get selected resolved events from filteredEvents using selectedIds
  const resolvedSelected = filteredEvents.value.filter(
    e => selectedIds.value.has(e.id) && e.status === 'resolved'
  )
  
  if (resolvedSelected.length === 0) {
    ElMessage.warning('请选择已解决的告警事件进行删除')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${resolvedSelected.length} 个已解决告警吗？此操作不可恢复。`,
      '批量删除告警',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    batchDeleting.value = true
    const ids = resolvedSelected.map(e => e.id)
    const response = await alertEventsApi.batchDelete(ids)

    if (response.data.success && response.data.data) {
      const { deleted, failed } = response.data.data
      if (failed === 0) {
        ElMessage.success(`成功删除 ${deleted} 个告警事件`)
      } else {
        ElMessage.warning(`成功 ${deleted} 个，失败 ${failed} 个`)
      }
    }

    clearSelection()
    await loadEvents()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('批量删除失败')
    }
  } finally {
    batchDeleting.value = false
  }
}

// Utility functions
const getMetricText = (metric: MetricType): string => {
  const texts: Record<MetricType, string> = {
    cpu: 'CPU 使用率',
    memory: '内存使用率',
    disk: '磁盘使用率',
    interface_status: '接口状态',
    interface_traffic: '接口流量',
    syslog: 'Syslog 事件'
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

const getSeverityColor = (severity: AlertSeverity): string => {
  const colors: Record<AlertSeverity, string> = {
    info: '#909399',
    warning: '#e6a23c',
    critical: '#f56c6c',
    emergency: '#f56c6c'
  }
  return colors[severity]
}

const getSeverityType = (severity: AlertSeverity): 'info' | 'warning' | 'danger' => {
  const types: Record<AlertSeverity, 'info' | 'warning' | 'danger'> = {
    info: 'info',
    warning: 'warning',
    critical: 'danger',
    emergency: 'danger'
  }
  return types[severity]
}

const getSeverityText = (severity: AlertSeverity): string => {
  const texts: Record<AlertSeverity, string> = {
    info: '信息',
    warning: '警告',
    critical: '严重',
    emergency: '紧急'
  }
  return texts[severity]
}

const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${Math.round(ms / 1000)}秒`
  if (ms < 3600000) return `${Math.round(ms / 60000)}分钟`
  return `${Math.round(ms / 3600000)}小时`
}

// Copy command to clipboard
const copyCommand = async (command: string) => {
  try {
    await navigator.clipboard.writeText(command)
    ElMessage.success('命令已复制到剪贴板')
  } catch (err) {
    console.error('Failed to copy command:', err)
    ElMessage.error('复制失败')
  }
}

const getStatusFlowStep = (event: typeof selectedEvent.value): number => {
  if (!event) return 0
  if (event.status === 'resolved') return 4
  if (event.autoResponseResult) return 2
  return 1
}

const getTimelineItemType = (type: TimelineEventType): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  const types: Record<TimelineEventType, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    trigger: 'danger',
    symptom: 'warning',
    cause: 'primary',
    effect: 'info'
  }
  return types[type]
}

const getTimelineTagType = (type: TimelineEventType): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  return getTimelineItemType(type)
}

const getTimelineTypeText = (type: TimelineEventType): string => {
  const texts: Record<TimelineEventType, string> = {
    trigger: '触发',
    symptom: '症状',
    cause: '原因',
    effect: '影响'
  }
  return texts[type]
}

const getRiskType = (risk: RiskLevel): 'success' | 'warning' | 'danger' => {
  const types: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
    low: 'success',
    medium: 'warning',
    high: 'danger'
  }
  return types[risk]
}

const getRiskText = (risk: RiskLevel): string => {
  const texts: Record<RiskLevel, string> = {
    low: '低',
    medium: '中',
    high: '高'
  }
  return texts[risk]
}

const getPlanStatusType = (status: RemediationPlanStatus): 'info' | 'warning' | 'success' | 'danger' => {
  const types: Record<RemediationPlanStatus, 'info' | 'warning' | 'success' | 'danger'> = {
    pending: 'info',
    in_progress: 'warning',
    completed: 'success',
    failed: 'danger',
    rolled_back: 'warning'
  }
  return types[status]
}

const getPlanStatusText = (status: RemediationPlanStatus): string => {
  const texts: Record<RemediationPlanStatus, string> = {
    pending: '待执行',
    in_progress: '执行中',
    completed: '已完成',
    failed: '失败',
    rolled_back: '已回滚'
  }
  return texts[status]
}
</script>

<style scoped>
.alert-events-view {
  padding: 20px;
  background: var(--el-bg-color-page);
  min-height: 100%;
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
  gap: 12px;
}

.filter-card {
  margin-bottom: 20px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.batch-actions-card {
  margin-bottom: 20px;
  background: var(--el-bg-color-overlay);
}

.batch-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.select-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.selected-count {
  color: var(--el-color-success);
  font-weight: 600;
}

.action-buttons {
  display: flex;
  gap: 8px;
}

.events-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.event-card {
  cursor: pointer;
  transition: all 0.3s ease;
}

.event-card:hover {
  transform: translateY(-2px);
}

.event-active {
  border-left: 4px solid var(--el-color-danger);
}

.event-selected {
  background: var(--el-fill-color-light);
  border-color: var(--el-color-primary);
}

.event-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.event-severity {
  display: flex;
  align-items: center;
  gap: 8px;
}

.event-body {
  margin-bottom: 12px;
}

.event-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 8px;
}

.event-message {
  color: var(--el-text-color-regular);
  margin-bottom: 8px;
}

.event-metrics {
  display: flex;
  gap: 24px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.metric-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.event-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.event-time {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.resolved-time {
  color: var(--el-color-success);
}

.event-actions {
  display: flex;
  gap: 8px;
}

.auto-response-result {
  margin-top: 12px;
}

.response-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  margin-bottom: 8px;
}

.response-output {
  background: var(--el-bg-color-page);
  padding: 8px 12px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.response-error {
  background: var(--el-color-danger-light-9);
  padding: 8px 12px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 13px;
  color: var(--el-color-danger);
}

/* Detail Dialog Styles */
.detail-tabs {
  margin-top: 20px;
}

.status-flow-container {
  padding: 24px 16px;
}

.loading-container {
  padding: 20px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin: 16px 0 12px;
}

/* Analysis Tab Styles */
.analysis-content {
  padding: 10px 0;
}

.root-cause-item {
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
}

.cause-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.cause-index {
  font-weight: 600;
  color: var(--el-color-primary);
}

.confidence-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.cause-description {
  color: var(--el-text-color-regular);
  line-height: 1.6;
  margin-bottom: 8px;
}

.cause-evidence {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.evidence-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.evidence-tag {
  margin: 2px;
}

.impact-section {
  margin-top: 16px;
}

.resource-tag {
  margin: 2px;
}

.similar-section {
  margin-top: 16px;
}

/* Timeline Tab Styles */
.timeline-content {
  padding: 20px 0;
}

.timeline-error {
  padding: 20px;
}

.generating-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.remediation-error {
  padding: 20px;
}

.timeline-item-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-description {
  color: var(--el-text-color-regular);
}

/* Related Tab Styles */
.related-content {
  padding: 10px 0;
}

/* Remediation Tab Styles */
.remediation-content {
  padding: 10px 0;
}

.plan-overview {
  margin-bottom: 20px;
}

.remediation-steps {
  margin: 16px 0;
}

.step-detail {
  padding: 8px 0;
}

.step-command {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.command-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.command-tag {
  font-family: monospace;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.step-duration {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.step-result {
  margin-top: 8px;
}

.result-output,
.result-error {
  margin: 0;
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.remediation-actions {
  display: flex;
  gap: 12px;
  margin: 20px 0;
}

.rollback-section {
  margin-top: 16px;
}

.rollback-step {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.rollback-step:last-child {
  border-bottom: none;
}

.rollback-order {
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.rollback-desc {
  flex: 1;
  color: var(--el-text-color-regular);
}

/* Feedback Section Styles */
.feedback-section {
  margin-top: 20px;
}

.feedback-content {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.feedback-label {
  color: var(--el-text-color-regular);
}

.feedback-buttons {
  display: flex;
  gap: 8px;
}

.feedback-comment {
  width: 100%;
  margin-top: 12px;
}

/* Legacy AI Analysis Styles */
.ai-analysis-section {
  margin-top: 20px;
}

.ai-analysis-content {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: var(--el-color-primary-light-9);
  border-radius: 8px;
}

.analysis-text {
  flex: 1;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.auto-response-section {
  margin-top: 20px;
}

.response-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: monospace;
  font-size: 13px;
}

.response-pre.error {
  color: var(--el-color-danger);
}

/* Pagination */
.pagination-container {
  display: flex;
  justify-content: flex-end;
  margin-top: 20px;
  padding: 16px 0;
}

/* AI Recommendations Section in Remediation Tab */
.ai-recommendations-section {
  padding: 20px;
  background: var(--el-bg-color-page);
  border-radius: 12px;
  border-left: 4px solid var(--el-color-primary);
  margin-bottom: 20px;
}

.ai-recommendations-section .section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 16px;
}

.confidence-tag {
  margin-left: auto;
}

.analysis-summary-card,
.analysis-details-card,
.recommendations-card {
  background: var(--el-bg-color-overlay);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  border: 1px solid var(--el-border-color-lighter);
}

.summary-header,
.details-header,
.recommendations-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.summary-text {
  font-size: 15px;
  line-height: 1.8;
  color: var(--el-text-color-primary);
}

.details-text {
  font-size: 14px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
}

.recommendations-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.recommendation-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  background: var(--el-bg-color-page);
  border-radius: 6px;
  transition: all 0.3s;
}

.recommendation-item:hover {
  background: var(--el-color-primary-light-9);
  transform: translateX(4px);
}

.rec-number {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-color-primary);
  color: var(--el-color-white);
  border-radius: 50%;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}

.rec-content {
  flex: 1;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.risk-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px dashed var(--el-border-color);
}

.risk-indicator .risk-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

/* Generating Hint */
.generating-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 16px;
  color: var(--el-color-primary);
  font-size: 14px;
}

/* Remediation Error */
.remediation-error {
  padding: 16px 0;
}

/* LLM Executable Steps Section */
.llm-executable-steps-section {
  margin-top: 20px;
}

.llm-executable-steps-section .step-detail {
  padding: 12px 0;
}

.llm-executable-steps-section .step-command {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.llm-executable-steps-section .command-label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.llm-executable-steps-section .command-tag {
  font-family: 'Consolas', 'Monaco', monospace;
  max-width: 100%;
  word-break: break-all;
}

.llm-executable-steps-section .step-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.llm-executable-steps-section .step-duration {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.llm-steps-note {
  margin-top: 16px;
}

/* 深入分析按钮样式 */
.deep-analysis-section {
  margin-top: 20px;
  text-align: center;
}

.deep-analysis-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--el-text-color-regular);
  font-size: 14px;
}

.deep-analysis-hint .el-icon {
  color: var(--el-color-primary);
}

/* Syslog Event Styles */
.event-syslog {
  border-left: 3px solid var(--el-text-color-secondary);
}

.event-type-tag {
  margin-left: 8px;
}

.syslog-category {
  font-weight: 600;
  color: var(--el-text-color-regular);
  text-transform: uppercase;
}

.syslog-hostname {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-left: 8px;
}

.event-metadata {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.metadata-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.raw-data-pre {
  background: var(--el-bg-color-page);
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
