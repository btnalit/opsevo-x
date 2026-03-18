import api from './index'

export const ipv6Api = {
    // IPv6 Addresses
    getAddresses: () => api.get('/ipv6/addresses'),
    getAddressById: (id: string) => api.get(`/ipv6/addresses/${id}`),
    addAddress: (data: object) => api.post('/ipv6/addresses', data),
    updateAddress: (id: string, data: object) => api.patch(`/ipv6/addresses/${id}`, data),
    deleteAddress: (id: string) => api.delete(`/ipv6/addresses/${id}`),

    // DHCPv6 Client
    getDhcpClients: () => api.get('/ipv6/dhcp-client'),
    getDhcpClientById: (id: string) => api.get(`/ipv6/dhcp-client/${id}`),
    addDhcpClient: (data: object) => api.post('/ipv6/dhcp-client', data),
    updateDhcpClient: (id: string, data: object) => api.patch(`/ipv6/dhcp-client/${id}`, data),
    deleteDhcpClient: (id: string) => api.delete(`/ipv6/dhcp-client/${id}`),
    releaseDhcpClient: (id: string) => api.post(`/ipv6/dhcp-client/${id}/release`),
    renewDhcpClient: (id: string) => api.post(`/ipv6/dhcp-client/${id}/renew`),

    // ND (Neighbor Discovery)
    getNd: () => api.get('/ipv6/nd'),
    getNdById: (id: string) => api.get(`/ipv6/nd/${id}`),
    addNd: (data: object) => api.post('/ipv6/nd', data),
    updateNd: (id: string, data: object) => api.patch(`/ipv6/nd/${id}`, data),
    deleteNd: (id: string) => api.delete(`/ipv6/nd/${id}`),

    // Neighbors (read-only)
    getNeighbors: () => api.get('/ipv6/neighbors'),

    // IPv6 Routes
    getRoutes: () => api.get('/ipv6/routes'),
    getRouteById: (id: string) => api.get(`/ipv6/routes/${id}`),
    addRoute: (data: object) => api.post('/ipv6/routes', data),
    updateRoute: (id: string, data: object) => api.patch(`/ipv6/routes/${id}`, data),
    deleteRoute: (id: string) => api.delete(`/ipv6/routes/${id}`),

    // IPv6 Firewall Filter
    getFirewallFilters: () => api.get('/ipv6/firewall/filter'),
    getFirewallFilterById: (id: string) => api.get(`/ipv6/firewall/filter/${id}`),
    createFirewallFilter: (data: object) => api.post('/ipv6/firewall/filter', data),
    updateFirewallFilter: (id: string, data: object) => api.patch(`/ipv6/firewall/filter/${id}`, data),
    deleteFirewallFilter: (id: string) => api.delete(`/ipv6/firewall/filter/${id}`),
    enableFirewallFilter: (id: string) => api.post(`/ipv6/firewall/filter/${id}/enable`),
    disableFirewallFilter: (id: string) => api.post(`/ipv6/firewall/filter/${id}/disable`)
}
