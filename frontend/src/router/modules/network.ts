import { RouteRecordRaw } from 'vue-router'

// All RouterOS-specific network config views have been removed.
// Wildcard redirects send legacy bookmarks to /ai-ops.
export const networkRoutes: RouteRecordRaw[] = [
    {
        path: 'interfaces/:pathMatch(.*)*',
        redirect: '/ai-ops'
    },
    {
        path: 'ip/:pathMatch(.*)*',
        redirect: '/ai-ops'
    },
    {
        path: 'ipv6/:pathMatch(.*)*',
        redirect: '/ai-ops'
    },
    {
        path: 'firewall/:pathMatch(.*)*',
        redirect: '/ai-ops'
    }
]
