import api from './index'

// Interface API
export const interfaceApi = {
    getAll: () => api.get('/interfaces'),
    getById: (id: string) => api.get(`/interfaces/${id}`),
    update: (id: string, data: object) => api.patch(`/interfaces/${id}`, data),
    enable: (id: string) => api.post(`/interfaces/${id}/enable`),
    disable: (id: string) => api.post(`/interfaces/${id}/disable`),
    // L2TP Client
    getL2tpClients: () => api.get('/interfaces/l2tp-client'),
    createL2tpClient: (data: object) => api.post('/interfaces/l2tp-client', data),
    updateL2tpClient: (id: string, data: object) => api.patch(`/interfaces/l2tp-client/${id}`, data),
    deleteL2tpClient: (id: string) => api.delete(`/interfaces/l2tp-client/${id}`),
    // PPPoE Client
    getPppoeClients: () => api.get('/interfaces/pppoe-client'),
    createPppoeClient: (data: object) => api.post('/interfaces/pppoe-client', data),
    updatePppoeClient: (id: string, data: object) => api.patch(`/interfaces/pppoe-client/${id}`, data),
    deletePppoeClient: (id: string) => api.delete(`/interfaces/pppoe-client/${id}`)
}

// VETH Interface API
export const vethApi = {
    getAll: () => api.get('/interfaces/veth'),
    getById: (id: string) => api.get(`/interfaces/veth/${id}`),
    create: (data: object) => api.post('/interfaces/veth', data),
    update: (id: string, data: object) => api.patch(`/interfaces/veth/${id}`, data),
    delete: (id: string) => api.delete(`/interfaces/veth/${id}`)
}
