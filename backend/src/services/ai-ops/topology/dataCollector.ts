/**
 * 数据采集器
 *
 * 通过 DevicePool 和标准化数据客户端采集多协议数据
 * Property 15: 数据源故障隔离
 * Requirements: 1.1-1.9
 */

import { logger } from '../../../utils/logger';
import type { DeviceDriver } from '../../../types/device-driver';

/**
 * 拓扑数据采集客户端接口
 *
 * 解耦设备客户端硬依赖：上层模块通过此接口与设备通信，
 * 设备驱动隐式满足此接口（duck typing），无需显式 implements。
 */
export interface TopologyDataClient {
  print<T>(path: string, query?: Record<string, string>, options?: { proplist?: string[] }): Promise<T[]>;
}
import {
  DiscoverySource, RawDiscoveryData, RawNeighborEntry, RawArpEntry,
  RawInterfaceEntry, RawRouteEntry, RawDhcpLeaseEntry, ManagedTopologyDevice,
} from './types';
import { normalizeMac } from './macNormalizer';
import { Semaphore } from './semaphore';

/**
 * 对单台设备执行多协议数据采集
 * 单个协议查询失败不影响其他协议
 */
export async function collectDeviceData(
  client: TopologyDataClient,
  deviceId: string,
  tenantId: string,
  sources: DiscoverySource[],
  includeEndpoints: boolean,
  deviceContext?: Pick<ManagedTopologyDevice, 'name' | 'host'>,
): Promise<RawDiscoveryData> {
  const result: RawDiscoveryData = {
    deviceId,
    tenantId,
    deviceName: deviceContext?.name || '',
    managementAddress: deviceContext?.host || '',
    timestamp: Date.now(),
    neighbors: [], arpEntries: [], interfaces: [], routes: [], dhcpLeases: [],
    errors: [],
  };

  // /ip/neighbor（含 LLDP/CDP）
  if (sources.includes('ip-neighbor')) {
    try {
      const raw = await client.print<Record<string, string>>('/ip/neighbor', undefined, {
        proplist: ['interface', 'address', 'mac-address', 'identity', 'platform', 'board'],
      });
      result.neighbors = (raw || []).map(r => ({
        interface: r.interface || '',
        address: r.address || '',
        macAddress: normalizeMac(r['mac-address'] || ''),
        identity: r.identity || '',
        platform: r.platform || '',
        board: r.board || '',
        discoverySource: 'ip-neighbor' as const,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[topology] /ip/neighbor failed for ${deviceId}: ${msg}`);
      result.errors.push({ source: 'ip-neighbor', error: msg });
    }
  }

  // /ip/arp
  if (sources.includes('arp')) {
    try {
      const raw = await client.print<Record<string, string>>('/ip/arp', undefined, {
        proplist: ['address', 'mac-address', 'interface', 'dynamic'],
      });
      result.arpEntries = (raw || []).map(r => ({
        address: r.address || '',
        macAddress: normalizeMac(r['mac-address'] || ''),
        interface: r.interface || '',
        dynamic: r.dynamic === 'true',
        discoverySource: 'arp' as const,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[topology] /ip/arp failed for ${deviceId}: ${msg}`);
      result.errors.push({ source: 'arp', error: msg });
    }
  }

  // /interface
  if (sources.includes('interface-status')) {
    try {
      const raw = await client.print<Record<string, string>>('/interface', undefined, {
        proplist: ['name', 'type', 'mac-address', 'running', 'disabled'],
      });
      result.interfaces = (raw || []).map(r => ({
        name: r.name || '',
        type: r.type || '',
        macAddress: normalizeMac(r['mac-address'] || ''),
        running: r.running === 'true',
        disabled: r.disabled === 'true',
        discoverySource: 'interface-status' as const,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[topology] /interface failed for ${deviceId}: ${msg}`);
      result.errors.push({ source: 'interface-status', error: msg });
    }
  }

  // /ip/route
  if (sources.includes('routing-table')) {
    try {
      const raw = await client.print<Record<string, string>>('/ip/route', undefined, {
        proplist: ['dst-address', 'gateway', 'distance', 'active'],
      });
      result.routes = (raw || []).map(r => ({
        dstAddress: r['dst-address'] || '',
        gateway: r.gateway || '',
        distance: parseInt(r.distance || '0', 10),
        active: r.active === 'true',
        discoverySource: 'routing-table' as const,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[topology] /ip/route failed for ${deviceId}: ${msg}`);
      result.errors.push({ source: 'routing-table', error: msg });
    }
  }

  // /ip/dhcp-server/lease（仅在启用终端设备发现时）
  if (includeEndpoints) {
    try {
      const raw = await client.print<Record<string, string>>('/ip/dhcp-server/lease', undefined, {
        proplist: ['address', 'mac-address', 'host-name', 'client-id', 'status'],
      });
      result.dhcpLeases = (raw || []).map(r => ({
        address: r.address || '',
        macAddress: normalizeMac(r['mac-address'] || ''),
        hostName: r['host-name'] || '',
        clientId: r['client-id'] || '',
        status: r.status || '',
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[topology] /ip/dhcp-server/lease failed for ${deviceId}: ${msg}`);
      // DHCP 查询失败不记入 errors（非核心数据源）
    }
  }

  return result;
}

/**
 * 批量采集所有设备数据（含并发控制）
 * 离线设备自动跳过，不视为拓扑变更
 */
export async function collectAllDevicesData(
  devices: ManagedTopologyDevice[],
  getConnection: (tenantId: string, deviceId: string) => Promise<TopologyDataClient>,
  sources: DiscoverySource[],
  includeEndpoints: boolean,
  maxConcurrent: number,
): Promise<{ data: RawDiscoveryData[]; skippedDeviceIds: string[]; errorCount: number }> {
  const semaphore = new Semaphore(maxConcurrent);
  const results: RawDiscoveryData[] = [];
  const skippedDeviceIds: string[] = [];
  let errorCount = 0;

  const tasks = devices.map(async (device) => {
    await semaphore.acquire();
    try {
      const client = await getConnection(device.tenantId, device.id);
      const data = await collectDeviceData(
        client,
        device.id,
        device.tenantId,
        sources,
        includeEndpoints,
        { name: device.name, host: device.host },
      );
      results.push(data);
      if (data.errors.length > 0) errorCount += data.errors.length;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // DEVICE_OFFLINE: 跳过，不视为拓扑变更
      const isOffline = (error instanceof Error && 'code' in error && (error as { code: string }).code === 'DEVICE_OFFLINE')
        || msg.includes('DEVICE_OFFLINE') || msg.includes('已离线');
      if (isOffline) {
        skippedDeviceIds.push(device.id);
        logger.debug(`[topology] Skipping offline device: ${device.id}`);
      } else {
        errorCount++;
        logger.warn(`[topology] Failed to collect data from ${device.id}: ${msg}`);
      }
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(tasks);
  return { data: results, skippedDeviceIds, errorCount };
}


/**
 * 通过 DeviceDriver 标准化接口采集拓扑数据（泛化路径）
 * Requirements: A4.18
 */
export async function collectDeviceDataFromDriver(
  driver: DeviceDriver,
  deviceId: string,
  tenantId: string,
  deviceContext?: Pick<ManagedTopologyDevice, 'name' | 'host'>,
): Promise<RawDiscoveryData> {
  const result: RawDiscoveryData = {
    deviceId,
    tenantId,
    deviceName: deviceContext?.name || '',
    managementAddress: deviceContext?.host || '',
    timestamp: Date.now(),
    neighbors: [], arpEntries: [], interfaces: [], routes: [], dhcpLeases: [],
    errors: [],
  };

  try {
    const topologyData = await driver.collectData('topology') as any;
    if (Array.isArray(topologyData)) {
      result.interfaces = topologyData.map((r: any) => ({
        name: r.name || '',
        type: r.type || '',
        macAddress: normalizeMac(r.macAddress || r['mac-address'] || ''),
        running: r.running === true || r.running === 'true',
        disabled: r.disabled === true || r.disabled === 'true',
        discoverySource: 'interface-status' as const,
      }));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push({ source: 'interface-status', error: msg });
  }

  try {
    const routeData = await driver.collectData('routes') as any;
    if (Array.isArray(routeData)) {
      result.routes = routeData.map((r: any) => ({
        dstAddress: r.dstAddress || r['dst-address'] || '',
        gateway: r.gateway || '',
        distance: parseInt(r.distance || '0', 10),
        active: r.active === true || r.active === 'true',
        discoverySource: 'routing-table' as const,
      }));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push({ source: 'routing-table', error: msg });
  }

  return result;
}
