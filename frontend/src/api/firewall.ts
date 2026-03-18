import api from './index'

export const firewallApi = {
    // Filter Rules (只读)
    getFilters: () => api.get('/firewall/filter'),
    getFilterById: (id: string) => api.get(`/firewall/filter/${id}`),
    // NAT Rules (完整 CRUD)
    getNats: () => api.get('/firewall/nat'),
    getNatById: (id: string) => api.get(`/firewall/nat/${id}`),
    createNat: (data: object) => api.post('/firewall/nat', data),
    updateNat: (id: string, data: object) => api.patch(`/firewall/nat/${id}`, data),
    deleteNat: (id: string) => api.delete(`/firewall/nat/${id}`),
    enableNat: (id: string) => api.post(`/firewall/nat/${id}/enable`),
    disableNat: (id: string) => api.post(`/firewall/nat/${id}/disable`),
    // Mangle Rules (只读)
    getMangles: () => api.get('/firewall/mangle'),
    getMangleById: (id: string) => api.get(`/firewall/mangle/${id}`),
    // Address List (完整 CRUD)
    getAddressList: () => api.get('/firewall/address-list'),
    createAddressEntry: (data: object) => api.post('/firewall/address-list', data),
    updateAddressEntry: (id: string, data: object) => api.patch(`/firewall/address-list/${id}`, data),
    deleteAddressEntry: (id: string) => api.delete(`/firewall/address-list/${id}`)
}
