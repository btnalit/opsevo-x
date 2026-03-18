import { RouteRecordRaw } from 'vue-router'

export const aiRoutes: RouteRecordRaw[] = [
    {
        path: 'ai/chat',
        redirect: '/ai/unified'
    },
    {
        path: 'ai/config',
        name: 'AIConfig',
        component: () => import('@/views/AIConfigView.vue'),
        meta: { title: 'AI 服务配置' }
    },
    {
        path: 'ai/unified',
        name: 'UnifiedAI',
        component: () => import('@/views/UnifiedAIView.vue'),
        meta: { title: '统一 AI Agent', description: '整合标准对话和知识增强模式的统一 AI 助手' }
    },
    {
        path: 'ai-ops',
        name: 'AIOps',
        component: () => import('@/views/AIOpsView.vue'),
        meta: { title: '智能运维仪表盘' }
    },
    {
        path: 'ai-ops/cockpit',
        name: 'CognitiveCockpit',
        component: () => import('@/views/CognitiveCockpitView.vue'),
        meta: { title: '全息思维座舱 (Cognitive Cockpit)' }
    },
    {
        path: 'ai-ops/alerts',
        name: 'AlertEvents',
        component: () => import('@/views/AlertEventsView.vue'),
        meta: { title: '告警事件' }
    },
    {
        path: 'ai-ops/alerts/rules',
        name: 'AlertRules',
        component: () => import('@/views/AlertRulesView.vue'),
        meta: { title: '告警规则' }
    },
    {
        path: 'ai-ops/scheduler',
        name: 'AIOpsScheduler',
        component: () => import('@/views/AIOpsSchedulerView.vue'),
        meta: { title: '定时任务' }
    },
    {
        path: 'ai-ops/snapshots',
        name: 'Snapshots',
        component: () => import('@/views/SnapshotsView.vue'),
        meta: { title: '配置快照' }
    },
    {
        path: 'ai-ops/changes',
        name: 'ConfigChanges',
        component: () => import('@/views/ConfigChangesView.vue'),
        meta: { title: '配置变更' }
    },
    {
        path: 'ai-ops/reports',
        name: 'HealthReports',
        component: () => import('@/views/HealthReportsView.vue'),
        meta: { title: '健康报告' }
    },
    {
        path: 'ai-ops/patterns',
        name: 'FaultPatterns',
        component: () => import('@/views/FaultPatternsView.vue'),
        meta: { title: '故障自愈' }
    },
    {
        path: 'ai-ops/channels',
        name: 'NotificationChannels',
        component: () => import('@/views/NotificationChannelsView.vue'),
        meta: { title: '通知渠道' }
    },
    {
        path: 'ai-ops/audit',
        name: 'AuditLog',
        component: () => import('@/views/AuditLogView.vue'),
        meta: { title: '审计日志' }
    },
    {
        path: 'ai-ops/feedback',
        name: 'FeedbackStats',
        redirect: '/ai-ops/knowledge?tab=feedback',
        meta: { title: '反馈统计', deprecated: true }
    },
    {
        path: 'ai-ops/maintenance',
        name: 'MaintenanceWindows',
        component: () => import('@/views/MaintenanceWindowsView.vue'),
        meta: { title: '维护窗口' }
    },
    {
        path: 'ai-ops/known-issues',
        name: 'KnownIssues',
        component: () => import('@/views/KnownIssuesView.vue'),
        meta: { title: '已知问题' }
    },
    {
        path: 'ai-ops/decisions',
        name: 'DecisionRules',
        component: () => import('@/views/DecisionRulesView.vue'),
        meta: { title: '决策规则' }
    },
    {
        path: 'ai-ops/syslog',
        name: 'SyslogManager',
        component: () => import('@/views/perception/SyslogManagerView.vue'),
        meta: { title: 'Syslog 管理' }
    },
    {
        path: 'ai-ops/snmp-trap',
        name: 'SNMPTrap',
        component: () => import('@/views/perception/SNMPTrapView.vue'),
        meta: { title: 'SNMP Trap' }
    },
    {
        path: 'ai-ops/perception',
        name: 'PerceptionDashboard',
        component: () => import('@/views/perception/PerceptionDashboard.vue'),
        meta: { title: '感知源总览' }
    },
    {
        path: 'ai-ops/knowledge',
        name: 'KnowledgeBase',
        component: () => import('@/views/KnowledgeBaseView.vue'),
        meta: { title: '知识库管理' }
    },
    {
        path: 'ai-ops/skills',
        name: 'SkillManagement',
        component: () => import('@/views/SkillManagementView.vue'),
        meta: { title: 'Skill 管理' }
    },
    {
        path: 'ai-ops/evolution',
        name: 'EvolutionConfig',
        component: () => import('@/views/EvolutionConfigView.vue'),
        meta: { title: '智能进化配置' }
    },
    {
        path: 'ai-ops/health',
        name: 'HealthDashboard',
        component: () => import('@/views/HealthDashboardView.vue'),
        meta: { title: '健康监控' }
    },
    {
        path: 'ai-ops/anomaly',
        name: 'AnomalyPrediction',
        component: () => import('@/views/AnomalyPredictionView.vue'),
        meta: { title: '异常预测' }
    },
    {
        path: 'ai-ops/inspection',
        redirect: '/ai-ops/reports'
    },
    {
        path: 'ai-ops/templates',
        name: 'PromptTemplate',
        component: () => import('@/views/PromptTemplateView.vue'),
        meta: { title: 'Prompt 模板' }
    },
    {
        path: 'ai-ops/prompts',
        name: 'PromptManagement',
        component: () => import('@/views/PromptManagementView.vue'),
        meta: { title: 'Prompt 知识管理' }
    },
    {
        path: 'ai-ops/topology',
        name: 'Topology',
        component: () => import('@/views/TopologyView.vue'),
        meta: { title: '网络拓扑' }
    },
    {
        path: 'ai-ops/providers',
        name: 'AiProviders',
        component: () => import('@/views/AiProviderView.vue'),
        meta: { title: 'AI 提供商管理' }
    },
    {
        path: 'ai-ops/notification-history',
        name: 'NotificationHistory',
        component: () => import('@/views/NotificationHistoryView.vue'),
        meta: { title: '通知历史' }
    },
    {
        path: 'ai-ops/favorites',
        name: 'FavoriteMessages',
        component: () => import('@/views/FavoriteMessages.vue'),
        meta: { title: '收藏消息' }
    },
    {
        path: 'ai-ops/agent',
        redirect: '/ai/unified'
    }
]
