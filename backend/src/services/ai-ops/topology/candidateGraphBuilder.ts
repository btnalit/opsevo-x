/**
 * 候选图构建器
 *
 * RawDiscoveryData[] → TopologyGraph 转换
 * MAC 归一化 → 节点/边提取 → 去重 → 交叉验证 → 置信度计算
 *
 * Property 4: 基于 MAC 的设备身份去重
 * Property 21: 终端设备识别
 * Requirements: 3.1-3.4, 15.1-15.6
 */

import {
  RawDiscoveryData, TopologyGraph, TopologyNode, TopologyEdge,
  TopologyDiscoveryConfig, DiscoverySource, DeviceType,
  createEmptyGraph,
} from './types';
import { normalizeMac } from './macNormalizer';
import { generateEdgeId, calculateEdgeConfidence } from './edgeUtils';
import { logger } from '../../../utils/logger';

/**
 * 从原始采集数据构建候选拓扑图
 */
export function buildCandidateGraph(
  rawDataList: RawDiscoveryData[],
  existingGraph: TopologyGraph,
  config: TopologyDiscoveryConfig,
): TopologyGraph {
  const graph = createEmptyGraph();
  const now = Date.now();

  // 已知基础设施设备的 MAC 集合（用于终端设备识别）
  const infraMacs = new Set<string>();
  const infraDeviceIds = new Set<string>();
  // FIX: 全量 MAC → deviceId 映射（包含所有接口 MAC，解决 VXLAN 等二层隧道接口 MAC 匹配问题）
  const macToDeviceId = new Map<string, string>();
  const conflictedMacs = new Set<string>(); // MAC 冲突黑名单（VRRP/HSRP 等共享 MAC 场景）
  // deviceId → identity 映射（用于从邻居数据补充 hostname）
  const deviceIdentityMap = new Map<string, string>();
  const deviceAddressMap = new Map<string, Set<string>>();

  // 第一遍：为每个采集设备创建基础设施节点
  for (const raw of rawDataList) {
    infraDeviceIds.add(raw.deviceId);

    // 从接口数据获取设备 MAC
    const deviceMacs: string[] = [];
    for (const iface of raw.interfaces) {
      if (iface.macAddress) {
        const mac = normalizeMac(iface.macAddress);
        deviceMacs.push(mac);
        infraMacs.add(mac);
        // FIX: MAC 冲突检测 — VRRP/HSRP 虚拟 MAC 等场景下多设备可能共享同一 MAC
        if (conflictedMacs.has(mac)) {
          continue; // 已标记为冲突的 MAC 不再参与映射
        }
        if (macToDeviceId.has(mac) && macToDeviceId.get(mac) !== raw.deviceId) {
          logger.warn(`[topology] MAC conflict: ${mac} claimed by ${macToDeviceId.get(mac)} and ${raw.deviceId}, excluding from lookup`);
          macToDeviceId.delete(mac);
          conflictedMacs.add(mac); // 拉黑，防止后续设备重新写入
        } else {
          macToDeviceId.set(mac, raw.deviceId);
        }
      }
    }

    // 创建或更新基础设施节点
    const existingNode = existingGraph.nodes.get(raw.deviceId);
    const node: TopologyNode = {
      id: raw.deviceId,
      deviceId: raw.deviceId,
      hostname: pickReadableName(raw.deviceName, existingNode?.hostname, raw.deviceId),
      ipAddresses: dedupeStrings(raw.managementAddress, existingNode?.ipAddresses || []),
      macAddress: deviceMacs[0] || '',
      deviceType: 'router' as DeviceType,
      stabilityTier: 'infrastructure',
      state: existingNode?.state || 'pending',
      confirmCount: existingNode?.confirmCount || 0,
      missCount: 0,
      discoveredAt: existingNode?.discoveredAt || now,
      lastSeenAt: now,
      sources: [],
    };

    graph.nodes.set(node.id, node);
  }

  // 第二遍：从邻居数据构建边，并收集 identity 信息补充 hostname
  for (const raw of rawDataList) {
    // 处理邻居数据
    for (const neighbor of raw.neighbors) {
      if (!neighbor.macAddress || !neighbor.interface) continue;

      const mac = normalizeMac(neighbor.macAddress);
      // FIX: 通过全量 MAC 映射查找目标设备（覆盖所有接口 MAC，包括 VXLAN 等隧道接口）
      let targetId = macToDeviceId.get(mac) || findDeviceByIdentity(rawDataList, graph, neighbor.identity, mac, neighbor.address, macToDeviceId);

      // FIX: 如果通过 identity 找到了目标设备，记录 identity 用于补充 hostname
      if (targetId && neighbor.identity) {
        deviceIdentityMap.set(targetId, neighbor.identity);
      }
      if (targetId && neighbor.address) {
        const addresses = deviceAddressMap.get(targetId) || new Set<string>();
        addresses.add(neighbor.address);
        deviceAddressMap.set(targetId, addresses);
      }

      if (!targetId && infraMacs.has(mac)) continue; // MAC 属于基础设施但未找到设备，跳过

      if (!targetId) {
        // 未知设备，可能是未注册的基础设施设备
        targetId = `mac-${mac}`;
        if (!graph.nodes.has(targetId)) {
          graph.nodes.set(targetId, {
            id: targetId,
            hostname: neighbor.identity || mac,
            ipAddresses: neighbor.address ? [neighbor.address] : [],
            macAddress: mac,
            deviceType: guessDeviceType(neighbor.platform),
            stabilityTier: 'infrastructure',
            state: 'pending', confirmCount: 0, missCount: 0,
            discoveredAt: now, lastSeenAt: now,
            sources: ['ip-neighbor'],
          });
        }
      }

      // 创建边（过滤 disabled 接口）
      const localIface = raw.interfaces.find(i => i.name === neighbor.interface);
      if (localIface?.disabled) continue;

      // FIX: 边 ID 只用设备对，不含接口名 — 确保双向邻居发现（A→B 和 B→A）合并为同一条边
      // localInterface 仍传入 addOrUpdateEdge 存储在边对象中，仅不参与去重
      const edgeId = generateEdgeId(raw.deviceId, targetId, '', '');
      addOrUpdateEdge(graph, edgeId, raw.deviceId, targetId, neighbor.interface, '', 'ip-neighbor', config, localIface?.running ?? true);
    }

    // 处理 ARP 数据 - 终端设备发现
    if (config.endpointDiscoveryEnabled) {
      for (const arp of raw.arpEntries) {
        if (!arp.macAddress) continue;
        const mac = normalizeMac(arp.macAddress);

        // 如果 MAC 属于已知基础设施设备，创建边
        if (infraMacs.has(mac)) {
          const targetId = macToDeviceId.get(mac);
          if (targetId && targetId !== raw.deviceId) {
            const edgeId = generateEdgeId(raw.deviceId, targetId, '', '');
            addOrUpdateEdge(graph, edgeId, raw.deviceId, targetId, arp.interface, '', 'arp', config, true);
          }
          continue;
        }

        // 终端设备
        const endpointId = `endpoint-${mac}`;
        if (!graph.nodes.has(endpointId)) {
          // 查找 DHCP 租约获取主机名
          const lease = raw.dhcpLeases.find(l => normalizeMac(l.macAddress) === mac);
          const displayName = lease?.hostName || mac;

          graph.nodes.set(endpointId, {
            id: endpointId,
            hostname: displayName,
            ipAddresses: arp.address ? [arp.address] : [],
            macAddress: mac,
            deviceType: 'endpoint',
            stabilityTier: 'endpoint',
            state: 'pending', confirmCount: 0, missCount: 0,
            discoveredAt: now, lastSeenAt: now,
            sources: ['arp'],
            connectedTo: raw.deviceId,
            endpointInfo: {
              displayName,
              dhcpHostname: lease?.hostName || undefined,
              clientId: lease?.clientId || undefined,
            },
          });
        } else {
          // 更新已有终端设备的 IP（全量替换，避免旧 IP 累积）
          const existing = graph.nodes.get(endpointId)!;
          existing.ipAddresses = arp.address ? [arp.address] : [];
        }

        // 终端设备到基础设施设备的边
        const edgeId = generateEdgeId(raw.deviceId, endpointId, '', '');
        addOrUpdateEdge(graph, edgeId, raw.deviceId, endpointId, arp.interface, '', 'arp', config, true);
      }
    }
  }

  // FIX: 第三遍：从邻居数据补充基础设施节点的 hostname
  for (const [deviceId, identity] of deviceIdentityMap) {
    const node = graph.nodes.get(deviceId);
    if (node && !isReadableName(node.hostname, node.id)) {
      node.hostname = identity;
    }
  }

  for (const [deviceId, addresses] of deviceAddressMap) {
    const node = graph.nodes.get(deviceId);
    if (!node) continue;
    node.ipAddresses = dedupeStrings(node.ipAddresses, Array.from(addresses));
  }

  return graph;
}

// ==================== 辅助函数 ====================

function findDeviceByIdentity(
  rawDataList: RawDiscoveryData[],
  graph: TopologyGraph,
  identity: string,
  neighborMac?: string,
  neighborAddress?: string,
  macToDeviceId?: Map<string, string>,
): string | undefined {
  if (!identity) return undefined;
  const lowerIdentity = identity.toLowerCase();
  // 匹配 identity 与已知设备的 deviceId
  for (const raw of rawDataList) {
    if (raw.deviceId.toLowerCase() === lowerIdentity && graph.nodes.has(raw.deviceId)) {
      return raw.deviceId;
    }
  }
  // 匹配已有图中节点的 hostname，增加 MAC/IP 验证
  for (const [id, node] of graph.nodes) {
    if (node.hostname && node.hostname.toLowerCase() === lowerIdentity) {
      // hostname 匹配后验证 MAC 或 IP
      if (neighborMac && node.macAddress) {
        if (node.macAddress === neighborMac) return id;
        // FIX: 主 MAC 不匹配时，检查邻居 MAC 是否属于同一设备的其他接口
        if (macToDeviceId && macToDeviceId.get(neighborMac) === id) return id;
        // MAC 确实不属于该设备 → 拒绝
        return undefined;
      }
      if (neighborAddress && node.ipAddresses.length > 0) {
        if (node.ipAddresses.includes(neighborAddress)) return id;
        // IP 不匹配 → 明确拒绝
        return undefined;
      }
      // 无 MAC/IP 可验证时，回退到仅 hostname 匹配
      return id;
    }
  }
  return undefined;
}


function guessDeviceType(platform: string): DeviceType {
  if (!platform) return 'router';
  const p = platform.toLowerCase();
  if (p.includes('switch') || p.includes('crs')) return 'switch';
  if (p.includes('firewall')) return 'firewall';
  return 'router';
}

function dedupeStrings(...values: Array<string | string[] | undefined>): string[] {
  const result = new Set<string>();
  for (const value of values) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const normalized = item?.trim();
      if (normalized) result.add(normalized);
    }
  }
  return Array.from(result);
}

function isReadableName(name: string | undefined, nodeId: string): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  if (trimmed === nodeId) return false;
  if (trimmed.startsWith('mac-')) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return false;
  return true;
}

function pickReadableName(primary: string | undefined, fallback: string | undefined, nodeId: string): string {
  if (isReadableName(primary, nodeId)) return primary!.trim();
  if (isReadableName(fallback, nodeId)) return fallback!.trim();
  return '';
}

function addOrUpdateEdge(
  graph: TopologyGraph,
  edgeId: string,
  sourceId: string,
  targetId: string,
  localInterface: string,
  remoteInterface: string,
  source: DiscoverySource,
  config: TopologyDiscoveryConfig,
  localRunning: boolean,
): void {
  const existing = graph.edges.get(edgeId);
  if (existing) {
    // 合并来源
    if (!existing.sources.includes(source)) {
      existing.sources = [...existing.sources, source];
    }
    // 重新计算置信度
    existing.confidence = calculateEdgeConfidence(existing.sources, config.edgeConfidenceWeights, []);
    existing.lastSeenAt = Date.now();
    existing.localInterfaceRunning = existing.localInterfaceRunning && localRunning;
  } else {
    const now = Date.now();
    graph.edges.set(edgeId, {
      id: edgeId,
      sourceId, targetId,
      localInterface, remoteInterface,
      confidence: calculateEdgeConfidence([source], config.edgeConfidenceWeights, []),
      sources: [source],
      state: 'pending',
      confirmCount: 0, missCount: 0,
      discoveredAt: now, lastSeenAt: now,
      localInterfaceRunning: localRunning,
      remoteInterfaceRunning: true,
    });
  }
}
