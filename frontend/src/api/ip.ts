import api from './index'

export const ipApi = {
    // IP Addresses
    getAddresses: () => api.get('/ip/addresses'),
    addAddress: (data: object) => api.post('/ip/addresses', data),
    updateAddress: (id: string, data: object) => api.patch(`/ip/addresses/${id}`, data),
    deleteAddress: (id: string) => api.delete(`/ip/addresses/${id}`),
    // Routes
    getRoutes: () => api.get('/ip/routes'),
    addRoute: (data: object) => api.post('/ip/routes', data),
    updateRoute: (id: string, data: object) => api.patch(`/ip/routes/${id}`, data),
    deleteRoute: (id: string) => api.delete(`/ip/routes/${id}`),
    // IP Pools
    getPools: () => api.get('/ip/pools'),
    addPool: (data: object) => api.post('/ip/pools', data),
    updatePool: (id: string, data: object) => api.patch(`/ip/pools/${id}`, data),
    deletePool: (id: string) => api.delete(`/ip/pools/${id}`),
    // DHCP Client
    getDhcpClients: () => api.get('/ip/dhcp-client'),
    addDhcpClient: (data: object) => api.post('/ip/dhcp-client', data),
    updateDhcpClient: (id: string, data: object) => api.patch(`/ip/dhcp-client/${id}`, data),
    deleteDhcpClient: (id: string) => api.delete(`/ip/dhcp-client/${id}`),
    enableDhcpClient: (id: string) => api.post(`/ip/dhcp-client/${id}/enable`),
    disableDhcpClient: (id: string) => api.post(`/ip/dhcp-client/${id}/disable`),
    // DHCP Server
    getDhcpServers: () => api.get('/ip/dhcp-server'),
    addDhcpServer: (data: object) => api.post('/ip/dhcp-server', data),
    updateDhcpServer: (id: string, data: object) => api.patch(`/ip/dhcp-server/${id}`, data),
    deleteDhcpServer: (id: string) => api.delete(`/ip/dhcp-server/${id}`),
    enableDhcpServer: (id: string) => api.post(`/ip/dhcp-server/${id}/enable`),
    disableDhcpServer: (id: string) => api.post(`/ip/dhcp-server/${id}/disable`),
    // DHCP Networks
    getDhcpNetworks: () => api.get('/ip/dhcp-server/networks'),
    addDhcpNetwork: (data: object) => api.post('/ip/dhcp-server/networks', data),
    updateDhcpNetwork: (id: string, data: object) => api.patch(`/ip/dhcp-server/networks/${id}`, data),
    deleteDhcpNetwork: (id: string) => api.delete(`/ip/dhcp-server/networks/${id}`),
    // DHCP Leases
    getDhcpLeases: () => api.get('/ip/dhcp-server/leases'),
    addDhcpLease: (data: object) => api.post('/ip/dhcp-server/leases', data),
    updateDhcpLease: (id: string, data: object) => api.patch(`/ip/dhcp-server/leases/${id}`, data),
    deleteDhcpLease: (id: string) => api.delete(`/ip/dhcp-server/leases/${id}`),
    makeDhcpLeaseStatic: (id: string) => api.post(`/ip/dhcp-server/leases/${id}/make-static`),
    // Socks
    getSocks: () => api.get('/ip/socks'),
    addSocks: (data: object) => api.post('/ip/socks', data),
    updateSocks: (id: string, data: object) => api.patch(`/ip/socks/${id}`, data),
    deleteSocks: (id: string) => api.delete(`/ip/socks/${id}`),
    enableSocks: (id: string) => api.post(`/ip/socks/${id}/enable`),
    disableSocks: (id: string) => api.post(`/ip/socks/${id}/disable`),
    // ARP
    getArp: () => api.get('/ip/arp'),
    addArp: (data: object) => api.post('/ip/arp', data),
    deleteArp: (id: string) => api.delete(`/ip/arp/${id}`)
}
