/**
 * SshMetricsCollector — SSH 指标采集器
 *
 * 通过 /proc/stat, /proc/meminfo, ip -s link 采集标准化 DeviceMetrics。
 *
 * Requirements: A8.34
 */

import type { DeviceMetrics, InterfaceMetrics } from '../../backend/src/types/device-driver';
import { CommandExecutor } from './commandExecutor';

export class SshMetricsCollector {
  private executor: CommandExecutor;

  constructor(executor: CommandExecutor) {
    this.executor = executor;
  }

  async collect(client: any, deviceId: string): Promise<DeviceMetrics> {
    const metrics: DeviceMetrics = { deviceId, timestamp: Date.now() };

    // CPU usage from /proc/stat
    try {
      const result = await this.executor.execute(client, 'cat /proc/stat | head -1');
      if (result.exitCode === 0) {
        metrics.cpuUsage = this.parseCpuUsage(result.stdout);
      }
    } catch {}

    // Memory from /proc/meminfo
    try {
      const result = await this.executor.execute(client, 'cat /proc/meminfo');
      if (result.exitCode === 0) {
        const mem = this.parseMemInfo(result.stdout);
        metrics.memoryUsage = mem.usagePercent;
      }
    } catch {}

    // Uptime
    try {
      const result = await this.executor.execute(client, 'cat /proc/uptime');
      if (result.exitCode === 0) {
        metrics.uptime = Math.floor(parseFloat(result.stdout.split(' ')[0]) || 0);
      }
    } catch {}

    // Disk usage
    try {
      const result = await this.executor.execute(client, "df / --output=pcent | tail -1");
      if (result.exitCode === 0) {
        metrics.diskUsage = parseInt(result.stdout.trim().replace('%', '')) || 0;
      }
    } catch {}

    // Network interfaces
    try {
      const result = await this.executor.execute(client, 'ip -s link');
      if (result.exitCode === 0) {
        metrics.interfaces = this.parseIpLink(result.stdout);
      }
    } catch {}

    return metrics;
  }

  private parseCpuUsage(line: string): number {
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4) return 0;
    const idle = parts[3];
    const total = parts.reduce((a, b) => a + b, 0);
    return total > 0 ? Math.round(((total - idle) / total) * 100) : 0;
  }

  private parseMemInfo(text: string): { usagePercent: number } {
    const lines = text.split('\n');
    let total = 0, available = 0;
    for (const line of lines) {
      if (line.startsWith('MemTotal:')) total = parseInt(line.split(/\s+/)[1]) || 0;
      if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]) || 0;
    }
    return { usagePercent: total > 0 ? Math.round(((total - available) / total) * 100) : 0 };
  }

  private parseIpLink(text: string): InterfaceMetrics[] {
    const interfaces: InterfaceMetrics[] = [];
    const blocks = text.split(/^\d+:/m).filter(Boolean);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const nameMatch = lines[0]?.match(/^\s*(\S+)/);
      if (!nameMatch) continue;

      const name = nameMatch[1].replace(/:$/, '');
      const status = block.includes('state UP') ? 'up' as const : 'down' as const;

      let rxBytes = 0, txBytes = 0, rxPackets = 0, txPackets = 0, rxErrors = 0, txErrors = 0;

      // Parse RX/TX lines
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('RX:') && lines[i + 1]) {
          const vals = lines[i + 1].trim().split(/\s+/).map(Number);
          rxBytes = vals[0] || 0; rxPackets = vals[1] || 0; rxErrors = vals[2] || 0;
        }
        if (lines[i].includes('TX:') && lines[i + 1]) {
          const vals = lines[i + 1].trim().split(/\s+/).map(Number);
          txBytes = vals[0] || 0; txPackets = vals[1] || 0; txErrors = vals[2] || 0;
        }
      }

      interfaces.push({ name, status, rxBytes, txBytes, rxPackets, txPackets, rxErrors, txErrors });
    }

    return interfaces;
  }
}
