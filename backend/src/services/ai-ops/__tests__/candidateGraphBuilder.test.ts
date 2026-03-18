import { buildCandidateGraph } from '../topology/candidateGraphBuilder';
import { createEmptyGraph, DEFAULT_TOPOLOGY_CONFIG, RawDiscoveryData } from '../topology/types';

describe('buildCandidateGraph', () => {
  it('uses managed device metadata for infrastructure node labels and management IPs', () => {
    const deviceId = 'c9d5dbda-d39e-4a60-87c4-2cd79f9425ff';
    const existingGraph = createEmptyGraph();
    existingGraph.nodes.set(deviceId, {
      id: deviceId,
      deviceId,
      hostname: deviceId,
      ipAddresses: [],
      macAddress: '60:be:b4:24:1f:8b',
      deviceType: 'router',
      stabilityTier: 'infrastructure',
      state: 'confirmed',
      confirmCount: 3,
      missCount: 0,
      discoveredAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 1_000,
      sources: [],
    });

    const rawData: RawDiscoveryData[] = [{
      deviceId,
      tenantId: 'tenant-1',
      deviceName: 'SE106 Pro',
      managementAddress: '192.168.50.1',
      timestamp: Date.now(),
      neighbors: [],
      arpEntries: [],
      interfaces: [{
        name: 'ether1',
        type: 'ether',
        macAddress: '60:be:b4:24:1f:8b',
        running: true,
        disabled: false,
        discoverySource: 'interface-status',
      }],
      routes: [],
      dhcpLeases: [],
      errors: [],
    }];

    const graph = buildCandidateGraph(rawData, existingGraph, DEFAULT_TOPOLOGY_CONFIG);
    const node = graph.nodes.get(deviceId);

    expect(node).toBeDefined();
    expect(node?.hostname).toBe('SE106 Pro');
    expect(node?.ipAddresses).toContain('192.168.50.1');
  });

  it('backfills infrastructure hostname and address from neighbor discovery when inventory metadata is absent', () => {
    const rawData: RawDiscoveryData[] = [
      {
        deviceId: 'dev-a',
        tenantId: 'tenant-1',
        deviceName: 'core-a',
        managementAddress: '192.168.10.1',
        timestamp: Date.now(),
        neighbors: [{
          interface: 'ether1',
          address: '10.0.0.2',
          macAddress: 'aa:bb:cc:dd:ee:02',
          identity: 'RB5009-B',
          platform: 'MikroTik',
          board: 'RB5009',
          discoverySource: 'ip-neighbor',
        }],
        arpEntries: [],
        interfaces: [{
          name: 'ether1',
          type: 'ether',
          macAddress: 'aa:bb:cc:dd:ee:01',
          running: true,
          disabled: false,
          discoverySource: 'interface-status',
        }],
        routes: [],
        dhcpLeases: [],
        errors: [],
      },
      {
        deviceId: 'dev-b',
        tenantId: 'tenant-1',
        deviceName: '',
        managementAddress: '',
        timestamp: Date.now(),
        neighbors: [],
        arpEntries: [],
        interfaces: [{
          name: 'ether2',
          type: 'ether',
          macAddress: 'aa:bb:cc:dd:ee:02',
          running: true,
          disabled: false,
          discoverySource: 'interface-status',
        }],
        routes: [],
        dhcpLeases: [],
        errors: [],
      },
    ];

    const graph = buildCandidateGraph(rawData, createEmptyGraph(), DEFAULT_TOPOLOGY_CONFIG);
    const node = graph.nodes.get('dev-b');

    expect(node).toBeDefined();
    expect(node?.hostname).toBe('RB5009-B');
    expect(node?.ipAddresses).toContain('10.0.0.2');
  });
});
