import api from './index'

export const containerApi = {
    // Containers
    getAll: () => api.get('/container'),
    getById: (id: string) => api.get(`/container/${id}`),
    create: (data: object) => api.post('/container', data),
    update: (id: string, data: object) => api.patch(`/container/${id}`, data),
    start: (id: string) => api.post(`/container/${id}/start`),
    stop: (id: string) => api.post(`/container/${id}/stop`),
    // Mounts
    getMounts: () => api.get('/container/mounts'),
    updateMount: (id: string, data: object) => api.patch(`/container/mounts/${id}`, data),
    deleteMount: (id: string) => api.delete(`/container/mounts/${id}`),
    // Envs
    getEnvs: () => api.get('/container/envs'),
    updateEnv: (id: string, data: object) => api.patch(`/container/envs/${id}`, data),
    deleteEnv: (id: string) => api.delete(`/container/envs/${id}`)
}
