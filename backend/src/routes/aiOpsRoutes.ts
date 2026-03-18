/**
 * AI-Ops Routes
 * 定义 AI-Ops 智能运维相关的路由
 *
 * 路由分组：
 * - /api/ai-ops/metrics - 指标采集管理
 * - /api/ai-ops/alerts/rules - 告警规则管理
 * - /api/ai-ops/alerts/events - 告警事件管理
 * - /api/ai-ops/scheduler - 调度器任务管理
 * - /api/ai-ops/snapshots - 配置快照管理
 * - /api/ai-ops/reports - 健康报告管理
 * - /api/ai-ops/patterns - 故障模式管理
 * - /api/ai-ops/remediations - 修复记录管理
 * - /api/ai-ops/channels - 通知渠道管理
 * - /api/ai-ops/audit - 审计日志查询
 * - /api/ai-ops/dashboard - 运维仪表盘
 * - /api/ai-ops/syslog - Syslog 管理 (Enhancement)
 * - /api/ai-ops/filters - 过滤器管理 (Enhancement)
 * - /api/ai-ops/analysis - 根因分析 (Enhancement)
 * - /api/ai-ops/remediation - 修复方案 (Enhancement)
 * - /api/ai-ops/decisions - 决策引擎 (Enhancement)
 * - /api/ai-ops/feedback - 用户反馈 (Enhancement)
 * - /api/ai-ops/cache - 缓存管理 (Enhancement)
 *
 * Requirements: 1.1-10.6
 */

import { Router } from 'express';
import {
  // 指标相关
  getLatestMetrics,
  getMetricsHistory,
  getTrafficHistory,
  getTrafficInterfaces,
  getTrafficCollectionStatus,
  getMetricsConfig,
  updateMetricsConfig,
  collectMetricsNow,
  getParallelExecutionMetrics,
  // 速率计算配置相关 (Requirements: 6.5)
  getRateCalculationConfig,
  updateRateCalculationConfig,
  getRateStatistics,
  getTrafficHistoryWithStatus,
  // 告警规则相关
  getAlertRules,
  getAlertRuleById,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  enableAlertRule,
  disableAlertRule,
  // 告警事件相关
  getAlertEvents,
  getActiveAlerts,
  getUnifiedEvents,
  getActiveUnifiedEvents,
  getAlertEventById,
  resolveAlertEvent,
  deleteAlertEvent,
  batchDeleteAlertEvents,
  // 调度器相关
  getSchedulerTasks,
  getSchedulerTaskById,
  createSchedulerTask,
  updateSchedulerTask,
  deleteSchedulerTask,
  runSchedulerTaskNow,
  getSchedulerExecutions,
  // 配置快照相关
  getSnapshots,
  getSnapshotById,
  createSnapshot,
  deleteSnapshot,
  downloadSnapshot,
  restoreSnapshot,
  compareSnapshots,
  getLatestDiff,
  getChangeTimeline,
  // 健康报告相关
  getReports,
  getReportById,
  generateReport,
  exportReport,
  deleteReport,
  // 故障模式相关
  getFaultPatterns,
  getFaultPatternById,
  createFaultPattern,
  updateFaultPattern,
  deleteFaultPattern,
  enableAutoHeal,
  disableAutoHeal,
  getRemediations,
  getRemediationById,
  executeFaultRemediation,
  // 通知渠道相关
  getNotificationChannels,
  getNotificationChannelById,
  createNotificationChannel,
  updateNotificationChannel,
  deleteNotificationChannel,
  testNotificationChannel,
  getPendingNotifications,
  getNotificationHistory,
  // 审计日志
  getAuditLogs,
  // 仪表盘
  getDashboardData,
  // AI-Ops Enhancement: Syslog 相关
  getSyslogConfig,
  updateSyslogConfig,
  getSyslogStatus,
  getSyslogEvents,
  getSyslogStats,
  resetSyslogStats,
  // AI-Ops Enhancement: 过滤器相关
  getMaintenanceWindows,
  createMaintenanceWindow,
  updateMaintenanceWindow,
  deleteMaintenanceWindow,
  getKnownIssues,
  createKnownIssue,
  updateKnownIssue,
  deleteKnownIssue,
  // AI-Ops Enhancement: 分析相关
  getAlertAnalysis,
  refreshAlertAnalysis,
  getAlertTimeline,
  getRelatedAlerts,
  // AI-Ops Enhancement: 修复方案相关
  getRemediationPlan,
  generateRemediationPlan,
  executeRemediationPlan,
  executeRemediationRollback,
  // AI-Ops Enhancement: 决策相关
  getDecisionRules,
  getDecisionRuleById,
  createDecisionRule,
  updateDecisionRule,
  deleteDecisionRule,
  getDecisionHistory,
  // AI-Ops Enhancement: 反馈相关
  submitFeedback,
  getFeedbackStats,
  getRulesNeedingReview,
  // AI-Ops Enhancement: 缓存管理相关
  getFingerprintCacheStats,
  clearFingerprintCache,
  getAnalysisCacheStats,
  clearAnalysisCache,
  // Pipeline 状态监控
  getPipelineStatus,
  getPipelineConcurrencyStatus,
  // 事件缓存统计
  getEventsCacheStats,
  // 服务健康检查
  getServicesHealth,
  getServiceHealth,
  getLifecycleConfig,
  // Critic/Reflector 模块 (Requirements: critic-reflector 16.1-21.5)
  getIterationState,
  listIterations,
  abortIteration,
  getEvaluationReport,
  queryLearning,
  streamIterationEvents,
  streamLearningEvents,
  getCriticStats,
  getReflectorStats,
  getIterationStats,
  getCriticReflectorConfig,
  updateCriticReflectorConfig,
  // 智能进化配置 (Requirements: evolution-frontend)
  getEvolutionConfig,
  updateEvolutionConfig,
  getEvolutionStatus,
  enableEvolutionCapability,
  disableEvolutionCapability,
  getToolStats,
  getHealthCurrent,
  getHealthTrend,
  getAnomalyPredictions,
} from '../controllers/aiOpsController';

const router = Router();


// ==================== 指标管理 ====================

// GET /api/ai-ops/metrics/latest - 获取最新指标
router.get('/metrics/latest', getLatestMetrics);

// GET /api/ai-ops/metrics/history - 获取历史指标
router.get('/metrics/history', getMetricsHistory);

// GET /api/ai-ops/metrics/traffic - 获取流量历史
router.get('/metrics/traffic', getTrafficHistory);

// GET /api/ai-ops/metrics/traffic/interfaces - 获取可用流量接口列表
router.get('/metrics/traffic/interfaces', getTrafficInterfaces);

// GET /api/ai-ops/metrics/traffic/status - 获取流量采集状态
router.get('/metrics/traffic/status', getTrafficCollectionStatus);

// GET /api/ai-ops/metrics/config - 获取采集配置
router.get('/metrics/config', getMetricsConfig);

// PUT /api/ai-ops/metrics/config - 更新采集配置
router.put('/metrics/config', updateMetricsConfig);

// GET /api/ai-ops/metrics/rate-config - 获取速率计算配置 (Requirements: 6.5)
router.get('/metrics/rate-config', getRateCalculationConfig);

// PUT /api/ai-ops/metrics/rate-config - 更新速率计算配置 (Requirements: 6.5)
router.put('/metrics/rate-config', updateRateCalculationConfig);

// GET /api/ai-ops/metrics/rate-statistics/:interfaceName/:direction - 获取速率统计 (Requirements: 6.4)
router.get('/metrics/rate-statistics/:interfaceName/:direction', getRateStatistics);

// GET /api/ai-ops/metrics/traffic-with-status - 获取流量历史（带状态）(Requirements: 6.2)
router.get('/metrics/traffic-with-status', getTrafficHistoryWithStatus);

// POST /api/ai-ops/metrics/collect - 立即采集指标
router.post('/metrics/collect', collectMetricsNow);

// GET /api/ai-ops/metrics/parallel-execution - 获取并行执行指标 (Requirements: 7.4, 7.5)
router.get('/metrics/parallel-execution', getParallelExecutionMetrics);


// ==================== 告警规则管理 ====================

// GET /api/ai-ops/alerts/rules - 获取告警规则列表
router.get('/alerts/rules', getAlertRules);

// GET /api/ai-ops/alerts/rules/:id - 获取单个告警规则
router.get('/alerts/rules/:id', getAlertRuleById);

// POST /api/ai-ops/alerts/rules - 创建告警规则
router.post('/alerts/rules', createAlertRule);

// PUT /api/ai-ops/alerts/rules/:id - 更新告警规则
router.put('/alerts/rules/:id', updateAlertRule);

// DELETE /api/ai-ops/alerts/rules/:id - 删除告警规则
router.delete('/alerts/rules/:id', deleteAlertRule);

// POST /api/ai-ops/alerts/rules/:id/enable - 启用告警规则
router.post('/alerts/rules/:id/enable', enableAlertRule);

// POST /api/ai-ops/alerts/rules/:id/disable - 禁用告警规则
router.post('/alerts/rules/:id/disable', disableAlertRule);


// ==================== 告警事件管理 ====================

// GET /api/ai-ops/alerts/events/active - 获取活跃告警（放在 :id 路由之前）
router.get('/alerts/events/active', getActiveAlerts);

// GET /api/ai-ops/alerts/events/unified/active - 获取活跃的合并事件（AlertEvent + SyslogEvent）
router.get('/alerts/events/unified/active', getActiveUnifiedEvents);

// GET /api/ai-ops/alerts/events/unified - 获取合并事件（AlertEvent + SyslogEvent）
router.get('/alerts/events/unified', getUnifiedEvents);

// POST /api/ai-ops/alerts/events/batch-delete - 批量删除告警事件（放在 :id 路由之前）
router.post('/alerts/events/batch-delete', batchDeleteAlertEvents);

// GET /api/ai-ops/alerts/events - 获取告警事件列表
router.get('/alerts/events', getAlertEvents);

// GET /api/ai-ops/alerts/events/:id - 获取单个告警事件
router.get('/alerts/events/:id', getAlertEventById);

// POST /api/ai-ops/alerts/events/:id/resolve - 解决告警
router.post('/alerts/events/:id/resolve', resolveAlertEvent);

// DELETE /api/ai-ops/alerts/events/:id - 删除告警事件
router.delete('/alerts/events/:id', deleteAlertEvent);


// ==================== 调度器任务管理 ====================

// GET /api/ai-ops/scheduler/executions - 获取执行历史（放在 tasks/:id 之前）
router.get('/scheduler/executions', getSchedulerExecutions);

// GET /api/ai-ops/scheduler/tasks - 获取任务列表
router.get('/scheduler/tasks', getSchedulerTasks);

// GET /api/ai-ops/scheduler/tasks/:id - 获取单个任务
router.get('/scheduler/tasks/:id', getSchedulerTaskById);

// POST /api/ai-ops/scheduler/tasks - 创建任务
router.post('/scheduler/tasks', createSchedulerTask);

// PUT /api/ai-ops/scheduler/tasks/:id - 更新任务
router.put('/scheduler/tasks/:id', updateSchedulerTask);

// DELETE /api/ai-ops/scheduler/tasks/:id - 删除任务
router.delete('/scheduler/tasks/:id', deleteSchedulerTask);

// POST /api/ai-ops/scheduler/tasks/:id/run - 立即执行任务
router.post('/scheduler/tasks/:id/run', runSchedulerTaskNow);


// ==================== 配置快照管理 ====================

// GET /api/ai-ops/snapshots/diff/latest - 获取最新差异（放在 :id 路由之前）
router.get('/snapshots/diff/latest', getLatestDiff);

// GET /api/ai-ops/snapshots/diff - 对比快照
router.get('/snapshots/diff', compareSnapshots);

// GET /api/ai-ops/snapshots/timeline - 获取变更时间线
router.get('/snapshots/timeline', getChangeTimeline);

// GET /api/ai-ops/snapshots - 获取快照列表
router.get('/snapshots', getSnapshots);

// GET /api/ai-ops/snapshots/:id - 获取单个快照
router.get('/snapshots/:id', getSnapshotById);

// POST /api/ai-ops/snapshots - 创建快照
router.post('/snapshots', createSnapshot);

// DELETE /api/ai-ops/snapshots/:id - 删除快照
router.delete('/snapshots/:id', deleteSnapshot);

// GET /api/ai-ops/snapshots/:id/download - 下载快照
router.get('/snapshots/:id/download', downloadSnapshot);

// POST /api/ai-ops/snapshots/:id/restore - 恢复快照
router.post('/snapshots/:id/restore', restoreSnapshot);


// ==================== 健康报告管理 ====================

// POST /api/ai-ops/reports/generate - 生成报告（放在 :id 路由之前）
router.post('/reports/generate', generateReport);

// GET /api/ai-ops/reports - 获取报告列表
router.get('/reports', getReports);

// GET /api/ai-ops/reports/:id - 获取单个报告
router.get('/reports/:id', getReportById);

// GET /api/ai-ops/reports/:id/export - 导出报告
router.get('/reports/:id/export', exportReport);

// DELETE /api/ai-ops/reports/:id - 删除报告
router.delete('/reports/:id', deleteReport);


// ==================== 故障模式管理 ====================

// GET /api/ai-ops/patterns - 获取故障模式列表
router.get('/patterns', getFaultPatterns);

// GET /api/ai-ops/patterns/:id - 获取单个故障模式
router.get('/patterns/:id', getFaultPatternById);

// POST /api/ai-ops/patterns - 创建故障模式
router.post('/patterns', createFaultPattern);

// PUT /api/ai-ops/patterns/:id - 更新故障模式
router.put('/patterns/:id', updateFaultPattern);

// DELETE /api/ai-ops/patterns/:id - 删除故障模式
router.delete('/patterns/:id', deleteFaultPattern);

// POST /api/ai-ops/patterns/:id/enable-auto-heal - 启用自动修复
router.post('/patterns/:id/enable-auto-heal', enableAutoHeal);

// POST /api/ai-ops/patterns/:id/disable-auto-heal - 禁用自动修复
router.post('/patterns/:id/disable-auto-heal', disableAutoHeal);

// POST /api/ai-ops/patterns/:id/execute - 手动执行修复
router.post('/patterns/:id/execute', executeFaultRemediation);


// ==================== 修复记录管理 ====================

// GET /api/ai-ops/remediations - 获取修复历史
router.get('/remediations', getRemediations);

// GET /api/ai-ops/remediations/:id - 获取单个修复记录
router.get('/remediations/:id', getRemediationById);


// ==================== 通知渠道管理 ====================

// GET /api/ai-ops/notifications/history - 获取通知历史（放在 channels 路由之前）
router.get('/notifications/history', getNotificationHistory);

// GET /api/ai-ops/channels - 获取渠道列表
router.get('/channels', getNotificationChannels);

// GET /api/ai-ops/channels/:id - 获取单个渠道
router.get('/channels/:id', getNotificationChannelById);

// POST /api/ai-ops/channels - 创建渠道
router.post('/channels', createNotificationChannel);

// PUT /api/ai-ops/channels/:id - 更新渠道
router.put('/channels/:id', updateNotificationChannel);

// DELETE /api/ai-ops/channels/:id - 删除渠道
router.delete('/channels/:id', deleteNotificationChannel);

// POST /api/ai-ops/channels/:id/test - 测试渠道
router.post('/channels/:id/test', testNotificationChannel);

// GET /api/ai-ops/channels/:id/pending - 获取待推送通知
router.get('/channels/:id/pending', getPendingNotifications);


// ==================== 审计日志 ====================

// GET /api/ai-ops/audit - 查询审计日志
router.get('/audit', getAuditLogs);


// ==================== 运维仪表盘 ====================

// GET /api/ai-ops/dashboard - 获取仪表盘数据
router.get('/dashboard', getDashboardData);


// ==================== AI-Ops Enhancement: Syslog 管理 ====================
// Requirements: 1.1, 1.7

// GET /api/ai-ops/syslog/config - 获取 Syslog 配置
router.get('/syslog/config', getSyslogConfig);

// PUT /api/ai-ops/syslog/config - 更新 Syslog 配置
router.put('/syslog/config', updateSyslogConfig);

// GET /api/ai-ops/syslog/status - 获取 Syslog 服务状态
router.get('/syslog/status', getSyslogStatus);

// GET /api/ai-ops/syslog/events - 获取 Syslog 事件历史
router.get('/syslog/events', getSyslogEvents);

// GET /api/ai-ops/syslog/stats - 获取 Syslog 统计信息
router.get('/syslog/stats', getSyslogStats);

// POST /api/ai-ops/syslog/stats/reset - 重置 Syslog 统计信息
router.post('/syslog/stats/reset', resetSyslogStats);


// ==================== AI-Ops Enhancement: 过滤器管理 ====================
// Requirements: 5.7, 5.8

// GET /api/ai-ops/filters/maintenance - 获取维护窗口列表
router.get('/filters/maintenance', getMaintenanceWindows);

// POST /api/ai-ops/filters/maintenance - 创建维护窗口
router.post('/filters/maintenance', createMaintenanceWindow);

// PUT /api/ai-ops/filters/maintenance/:id - 更新维护窗口
router.put('/filters/maintenance/:id', updateMaintenanceWindow);

// DELETE /api/ai-ops/filters/maintenance/:id - 删除维护窗口
router.delete('/filters/maintenance/:id', deleteMaintenanceWindow);

// GET /api/ai-ops/filters/known-issues - 获取已知问题列表
router.get('/filters/known-issues', getKnownIssues);

// POST /api/ai-ops/filters/known-issues - 创建已知问题
router.post('/filters/known-issues', createKnownIssue);

// PUT /api/ai-ops/filters/known-issues/:id - 更新已知问题
router.put('/filters/known-issues/:id', updateKnownIssue);

// DELETE /api/ai-ops/filters/known-issues/:id - 删除已知问题
router.delete('/filters/known-issues/:id', deleteKnownIssue);


// ==================== AI-Ops Enhancement: 根因分析 ====================
// Requirements: 6.1, 6.2, 6.4

// GET /api/ai-ops/analysis/:alertId - 获取告警的根因分析
router.get('/analysis/:alertId', getAlertAnalysis);

// POST /api/ai-ops/analysis/:alertId/refresh - 重新分析告警
router.post('/analysis/:alertId/refresh', refreshAlertAnalysis);

// GET /api/ai-ops/analysis/:alertId/timeline - 获取事件时间线
router.get('/analysis/:alertId/timeline', getAlertTimeline);

// GET /api/ai-ops/analysis/:alertId/related - 获取关联告警
router.get('/analysis/:alertId/related', getRelatedAlerts);


// ==================== AI-Ops Enhancement: 修复方案 ====================
// Requirements: 7.1, 7.4

// GET /api/ai-ops/remediation/:alertId - 获取修复方案
router.get('/remediation/:alertId', getRemediationPlan);

// POST /api/ai-ops/remediation/:alertId - 生成修复方案
router.post('/remediation/:alertId', generateRemediationPlan);

// POST /api/ai-ops/remediation/:planId/execute - 执行修复方案
router.post('/remediation/:planId/execute', executeRemediationPlan);

// POST /api/ai-ops/remediation/:planId/rollback - 执行回滚
router.post('/remediation/:planId/rollback', executeRemediationRollback);


// ==================== AI-Ops Enhancement: 决策引擎 ====================
// Requirements: 8.8

// GET /api/ai-ops/decisions/history - 获取决策历史（放在 rules/:id 之前）
router.get('/decisions/history', getDecisionHistory);

// GET /api/ai-ops/decisions/rules - 获取决策规则列表
router.get('/decisions/rules', getDecisionRules);

// GET /api/ai-ops/decisions/rules/:id - 获取单个决策规则
router.get('/decisions/rules/:id', getDecisionRuleById);

// POST /api/ai-ops/decisions/rules - 创建决策规则
router.post('/decisions/rules', createDecisionRule);

// PUT /api/ai-ops/decisions/rules/:id - 更新决策规则
router.put('/decisions/rules/:id', updateDecisionRule);

// DELETE /api/ai-ops/decisions/rules/:id - 删除决策规则
router.delete('/decisions/rules/:id', deleteDecisionRule);


// ==================== AI-Ops Enhancement: 用户反馈 ====================
// Requirements: 10.1, 10.4, 10.5, 10.6

// GET /api/ai-ops/feedback/stats - 获取反馈统计（放在其他路由之前）
router.get('/feedback/stats', getFeedbackStats);

// GET /api/ai-ops/feedback/review - 获取需要审查的规则
router.get('/feedback/review', getRulesNeedingReview);

// POST /api/ai-ops/feedback - 提交反馈
router.post('/feedback', submitFeedback);


// ==================== AI-Ops Enhancement: 缓存管理 ====================
// Requirements: 2.5, 3.5, 3.6

// GET /api/ai-ops/cache/fingerprint/stats - 获取指纹缓存统计
router.get('/cache/fingerprint/stats', getFingerprintCacheStats);

// POST /api/ai-ops/cache/fingerprint/clear - 清空指纹缓存
router.post('/cache/fingerprint/clear', clearFingerprintCache);

// GET /api/ai-ops/cache/analysis/stats - 获取分析缓存统计
router.get('/cache/analysis/stats', getAnalysisCacheStats);

// POST /api/ai-ops/cache/analysis/clear - 清空分析缓存
router.post('/cache/analysis/clear', clearAnalysisCache);

// GET /api/ai-ops/cache/events/stats - 获取事件缓存统计 (Requirements: 3.6)
router.get('/cache/events/stats', getEventsCacheStats);


// ==================== Pipeline 状态监控 ====================
// Requirements: 2.5 - 提供 Pipeline 并发状态监控接口

// GET /api/ai-ops/pipeline/status - 获取 Pipeline 状态
router.get('/pipeline/status', getPipelineStatus);

// GET /api/ai-ops/pipeline/concurrency - 获取 Pipeline 详细并发状态
router.get('/pipeline/concurrency', getPipelineConcurrencyStatus);


// ==================== 服务健康检查 ====================
// Requirements: 5.4 - 提供服务健康状态检查接口

// GET /api/ai-ops/health - 获取所有服务的健康状态
router.get('/health', getServicesHealth);

// 注意：/health/current 和 /health/trend 路由必须在 /health/:serviceName 之前定义
// 否则 "current" 和 "trend" 会被当作 serviceName 参数
// 这些路由在下方"健康监控"部分定义

// GET /api/ai-ops/health/:serviceName - 获取单个服务的健康状态
// 移到健康监控路由之后，避免路由冲突

// GET /api/ai-ops/lifecycle/config - 获取服务生命周期配置
router.get('/lifecycle/config', getLifecycleConfig);


// ==================== Critic/Reflector 模块 ====================
// Requirements: critic-reflector 16.1-21.5

// GET /api/ai-ops/iterations/active - 获取活跃迭代列表（放在 :id 路由之前）
router.get('/iterations/active', listIterations);

// GET /api/ai-ops/iterations/:id - 获取迭代状态
router.get('/iterations/:id', getIterationState);

// GET /api/ai-ops/iterations/:id/stream - SSE 实时推送迭代事件
router.get('/iterations/:id/stream', streamIterationEvents);

// POST /api/ai-ops/iterations/:id/abort - 中止迭代
router.post('/iterations/:id/abort', abortIteration);

// GET /api/ai-ops/evaluations/:planId - 获取评估报告
router.get('/evaluations/:planId', getEvaluationReport);

// GET /api/ai-ops/learning/stream - SSE 实时推送学习事件
router.get('/learning/stream', streamLearningEvents);

// GET /api/ai-ops/learning - 查询学习条目
router.get('/learning', queryLearning);

// GET /api/ai-ops/stats/critic - Critic 统计
router.get('/stats/critic', getCriticStats);

// GET /api/ai-ops/stats/reflector - Reflector 统计
router.get('/stats/reflector', getReflectorStats);

// GET /api/ai-ops/stats/iterations - 迭代统计
router.get('/stats/iterations', getIterationStats);

// GET /api/ai-ops/critic/config - 获取 Critic/Reflector 功能配置
router.get('/critic/config', getCriticReflectorConfig);

// POST /api/ai-ops/critic/config - 更新 Critic/Reflector 功能配置
router.post('/critic/config', updateCriticReflectorConfig);


// ==================== 智能进化配置管理 ====================
// Requirements: evolution-frontend 1.1-1.8, 6.1-6.9

// GET /api/ai-ops/evolution/config - 获取进化配置
router.get('/evolution/config', getEvolutionConfig);

// PUT /api/ai-ops/evolution/config - 更新进化配置
router.put('/evolution/config', updateEvolutionConfig);

// GET /api/ai-ops/evolution/status - 获取能力状态摘要
router.get('/evolution/status', getEvolutionStatus);

// POST /api/ai-ops/evolution/capability/:name/enable - 启用能力
router.post('/evolution/capability/:name/enable', enableEvolutionCapability);

// POST /api/ai-ops/evolution/capability/:name/disable - 禁用能力
router.post('/evolution/capability/:name/disable', disableEvolutionCapability);

// GET /api/ai-ops/evolution/tool-stats - 获取工具统计
router.get('/evolution/tool-stats', getToolStats);


// ==================== 健康监控 ====================
// Requirements: evolution-frontend 2.1-2.8

// GET /api/ai-ops/health/current - 获取当前健康状态
// 注意：必须在 /health/:serviceName 之前定义
router.get('/health/current', getHealthCurrent);

// GET /api/ai-ops/health/trend - 获取健康趋势
// 注意：必须在 /health/:serviceName 之前定义
router.get('/health/trend', getHealthTrend);

// GET /api/ai-ops/health/:serviceName - 获取单个服务的健康状态
// Requirements: 5.4 - 提供服务健康状态检查接口
// 注意：参数化路由必须放在具体路由之后
router.get('/health/:serviceName', getServiceHealth);


// ==================== 异常预测 ====================
// Requirements: evolution-frontend 3.1-3.6

// GET /api/ai-ops/anomaly/predictions - 获取异常预测列表
router.get('/anomaly/predictions', getAnomalyPredictions);


// ==================== 自主意图 ====================
// Requirements: evolution-frontend - Autonomous Intent Generation

// GET /api/ai-ops/intents/stream - SSE 自主意图事件流
import { streamAutonomousIntents, getPendingIntentsHandler, grantIntentHandler, rejectIntentHandler, streamBrainThinking } from '../controllers/aiOpsController';
router.get('/intents/stream', streamAutonomousIntents);

// GET /api/ai-ops/brain/thinking/stream - SSE 大脑思考过程事件流
router.get('/brain/thinking/stream', streamBrainThinking);

// GET /api/ai-ops/intents/pending - 获取当前等待审批的高危意图列表
router.get('/intents/pending', getPendingIntentsHandler);

// POST /api/ai-ops/intents/grant/:id - 同意执行高危意图
router.post('/intents/grant/:id', grantIntentHandler);

// POST /api/ai-ops/intents/reject/:id - 驳回高危意图
router.post('/intents/reject/:id', rejectIntentHandler);

export default router;
