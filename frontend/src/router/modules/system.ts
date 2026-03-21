import { RouteRecordRaw } from 'vue-router'

export const systemRoutes: RouteRecordRaw[] = [
    {
        path: 'system/scheduler',
        name: 'Scheduler',
        component: () => import('@/views/SchedulerView.vue'),
        meta: { title: '计划任务', noDeviceRequired: true }
    },
    {
        path: 'system/users',
        name: 'UserManagement',
        component: () => import('@/views/UserManagementView.vue'),
        meta: { title: '用户管理', noDeviceRequired: true }
    },
    {
        path: 'system/config',
        name: 'SystemConfig',
        component: () => import('@/views/SystemConfigView.vue'),
        meta: { title: '系统配置', noDeviceRequired: true }
    },
    {
        path: 'system/feature-flags',
        name: 'FeatureFlags',
        component: () => import('@/views/FeatureFlagView.vue'),
        meta: { title: '特性标志', noDeviceRequired: true }
    },
    {
        path: 'system/traces',
        name: 'Tracing',
        component: () => import('@/views/TracingView.vue'),
        meta: { title: '分布式追踪', noDeviceRequired: true }
    },
    // Removed: ScriptView, PowerManagementView, ContainerView, ContainerMountsView, ContainerEnvsView
    // Wildcard redirects for legacy bookmarks
    {
        path: 'system/scripts/:pathMatch(.*)*',
        redirect: '/ai-ops'
    },
    {
        path: 'system/power/:pathMatch(.*)*',
        redirect: '/ai-ops'
    },
    {
        path: 'container/:pathMatch(.*)*',
        redirect: '/ai-ops'
    }
]
