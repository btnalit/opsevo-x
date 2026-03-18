import { RouteRecordRaw } from 'vue-router'

export const deviceRoutes: RouteRecordRaw[] = [
  {
    path: 'devices',
    name: 'DeviceList',
    component: () => import('@/views/devices/GenericDeviceView.vue'),
    meta: { title: '设备管理', noDeviceRequired: true }
  },
  {
    path: 'devices/add',
    name: 'DeviceAdd',
    redirect: '/devices',
    meta: { noDeviceRequired: true }
  },
  {
    path: 'devices/drivers',
    name: 'DeviceDrivers',
    component: () => import('@/views/devices/DeviceDriverView.vue'),
    meta: { title: '驱动管理', noDeviceRequired: true }
  },
  {
    path: 'devices/profiles',
    name: 'ApiProfiles',
    component: () => import('@/views/devices/ApiProfileManager.vue'),
    meta: { title: 'API Profile 管理', noDeviceRequired: true }
  },
  {
    path: 'devices/:id',
    name: 'DeviceDetail',
    component: () => import('@/views/devices/DeviceDetailView.vue'),
    meta: { title: '设备详情', noDeviceRequired: true }
  },
  {
    path: 'devices/:id/health',
    name: 'DeviceHealth',
    component: () => import('@/views/devices/DeviceHealthDetail.vue'),
    meta: { title: '健康监控详情', noDeviceRequired: true }
  },
]
