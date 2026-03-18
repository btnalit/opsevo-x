/**
 * RouterOS 数据解析器
 *
 * 将 RouterOS API 原始响应转换为标准化格式。
 *
 * Requirements: A3.12, A3.13
 */

import type { DeviceMetrics, InterfaceMetrics } from '../../../../backend/src/types/device-driver';
import type { RouterOSResource, RouterOSInterface } from './types';

/**
 * 解析 RouterOS uptime 字符串为秒数
 * 格式: "1w2d3h4m5s" 或 "3h4m5s"
 */
export function parseUptime(uptime: string): number {
  let seconds = 0;
  const weeks = uptime.match(/(\d+)w/);
  const days = uptime.match(/(\d+)d/);
  const hours = uptime.match(/(\d+)h/);
  const minutes = uptime.match(/(\d+)m/);
  const secs = uptime.match(/(\d+)s/);

  if (weeks) seconds += parseInt(weeks[1]) * 7 * 24 * 3600;
  if (days) seconds += parseInt(days[1]) * 24 * 3600;
  if (hours) seconds += parseInt(hours[1]) * 3600;
  if (minutes) seconds += parseInt(minutes[1]) * 60;
  if (secs) seconds += parseInt(secs[1]);

  return seconds;
}

/**
 * 将 RouterOS 系统资源转换为标准化 DeviceMetrics
 */
export function resourceToMetrics(
  deviceId: string,
  resource: RouterOSResource,
  interfaces?: RouterOSInterface[],
): DeviceMetrics {
  const totalMem = parseInt(resource['total-memory']) || 1;
  const freeMem = parseInt(resource['free-memory']) || 0;
  const totalHdd = parseInt(resource['total-hdd-space']) || 1;
  const freeHdd = parseInt(resource['free-hdd-space']) || 0;

  const metrics: DeviceMetrics = {
    deviceId,
    timestamp: Date.now(),
    cpuUsage: parseInt(resource['cpu-load']) || 0,
    memoryUsage: Math.round(((totalMem - freeMem) / totalMem) * 100),
    diskUsage: Math.round(((totalHdd - freeHdd) / totalHdd) * 100),
    uptime: parseUptime(resource.uptime),
  };

  if (interfaces) {
    metrics.interfaces = interfaces.map(iface => parseInterface(iface));
  }

  return metrics;
}

/**
 * 将 RouterOS 接口转换为标准化 InterfaceMetrics
 */
export function parseInterface(iface: RouterOSInterface): InterfaceMetrics {
  return {
    name: iface.name,
    status: iface.running === 'true' ? 'up' : 'down',
    rxBytes: parseInt(iface['rx-byte']) || 0,
    txBytes: parseInt(iface['tx-byte']) || 0,
    rxPackets: parseInt(iface['rx-packet']) || 0,
    txPackets: parseInt(iface['tx-packet']) || 0,
    rxErrors: parseInt(iface['rx-error']) || 0,
    txErrors: parseInt(iface['tx-error']) || 0,
  };
}
