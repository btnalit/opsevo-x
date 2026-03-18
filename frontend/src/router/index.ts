import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'

import { networkRoutes } from './modules/network'
import { systemRoutes } from './modules/system'
import { aiRoutes } from './modules/ai'
import { deviceRoutes } from './modules/device'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录', public: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { title: '注册', public: true }
  },
  {
    path: '/',
    component: AppLayout,
    redirect: '/devices',
    children: [
      ...deviceRoutes,
      {
        path: 'dashboard',
        redirect: '/ai-ops'
      },
      {
        path: 'about',
        name: 'About',
        component: () => import('@/views/AboutView.vue'),
        meta: { title: '关于 OPSEVO', noDeviceRequired: true }
      },
      ...networkRoutes,
      ...systemRoutes,
      ...aiRoutes
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/login'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// Navigation guard - redirect to login if not authenticated, redirect to /devices if no device selected
router.beforeEach((to, _from, next) => {
  // Allow public routes (login, register) without auth
  if (to.meta.public) {
    next()
    return
  }

  // Check authentication from localStorage (store may not be initialized yet)
  const token = localStorage.getItem('auth_token')
  if (!token) {
    next('/login')
    return
  }

  // Routes that don't require a selected device (device management pages)
  if (to.meta.noDeviceRequired) {
    next()
    return
  }

  // Check if a device is selected for routes that require it
  // Relaxed check: Allow navigation to /ai-ops even if check fails temporarily
  // This prevents the "loop" issue where user selects device but router kicks them back
  if (to.path === '/ai-ops' || to.path === '/ai-ops/') {
    next()
    return
  }

  const currentDeviceId = localStorage.getItem('current_device_id')
  if (!currentDeviceId) {
    next('/devices')
    return
  }

  next()
})

// Global error handler for navigation failures
router.onError((error) => {
  console.error('Router error:', error)
  // If it's a chunk loading error, try to reload the page
  if (error.message.includes('Failed to fetch dynamically imported module') ||
    error.message.includes('Loading chunk')) {
    window.location.reload()
  }
})

export default router
