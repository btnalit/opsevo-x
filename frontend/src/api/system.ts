import api from './index'

export const systemApi = {
    // Scheduler
    getSchedulers: () => api.get('/system/scheduler'),
    addScheduler: (data: object) => api.post('/system/scheduler', data),
    updateScheduler: (id: string, data: object) => api.patch(`/system/scheduler/${id}`, data),
    deleteScheduler: (id: string) => api.delete(`/system/scheduler/${id}`),
    enableScheduler: (id: string) => api.post(`/system/scheduler/${id}/enable`),
    disableScheduler: (id: string) => api.post(`/system/scheduler/${id}/disable`),
    // Scripts
    getScripts: () => api.get('/system/scripts'),
    addScript: (data: object) => api.post('/system/scripts', data),
    updateScript: (id: string, data: object) => api.patch(`/system/scripts/${id}`, data),
    deleteScript: (id: string) => api.delete(`/system/scripts/${id}`),
    runScript: (id: string) => api.post(`/system/scripts/${id}/run`),
    // Power Management
    reboot: () => api.post('/system/reboot'),
    shutdown: () => api.post('/system/shutdown')
}

export const dashboardApi = {
    getResource: () => api.get('/dashboard/resource')
}
