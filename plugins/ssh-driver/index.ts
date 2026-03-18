/**
 * SSH Driver Plugin — 入口
 *
 * 实现 DeviceDriver 接口，通过 SSH 连接管理 Linux/Unix 设备。
 *
 * Requirements: A8.30, A8.31, A8.32, A8.33, A8.34, A8.35, A8.36
 */

import type {
  DeviceDriver,
  DeviceDriverFactory,
  DeviceConnectionConfig,
  DeviceExecutionResult,
  DeviceMetrics,
  CapabilityManifest,
  HealthCheckResult,
} from '../../backend/src/types/device-driver';
import { DeviceError } from '../../backend/src/types/device-driver';
import { SshConnectionPool } from './connectionPool';
import { CommandExecutor } from './commandExecutor';
import { SshMetricsCollector } from './metricsCollector';
import { FileTransfer } from './fileTransfer';

export class SshDriver implements DeviceDriver {
  readonly driverType = 'ssh' as const;

  private pool: SshConnectionPool;
  private executor: CommandExecutor;
  private metricsCollector: SshMetricsCollector;
  private fileTransfer: FileTransfer;
  private config: DeviceConnectionConfig | null = null;
  private connected = false;

  constructor() {
    this.pool = new SshConnectionPool();
    this.executor = new CommandExecutor();
    this.metricsCollector = new SshMetricsCollector(this.executor);
    this.fileTransfer = new FileTransfer();
  }

  async connect(config: DeviceConnectionConfig): Promise<void> {
    this.config = config;

    this.pool.setConnectionFactory(async () => {
      // Dynamic import ssh2 to avoid hard dependency
      const { Client } = await import('ssh2');
      return new Promise<any>((resolve, reject) => {
        const client = new Client();
        client.on('ready', () => resolve(client));
        client.on('error', reject);
        client.connect({
          host: config.host,
          port: config.port || 22,
          username: config.username,
          password: config.password,
          readyTimeout: config.timeout ?? 10000,
        });
      });
    });

    this.pool.startCleanup();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.pool.closeAll();
    this.connected = false;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.connected) {
      return { healthy: false, latencyMs: 0, message: 'Not connected' };
    }
    const start = Date.now();
    try {
      const client = await this.pool.acquire();
      const result = await this.executor.execute(client, 'echo ok', { timeout: 5000 });
      this.pool.release(client);
      return {
        healthy: result.exitCode === 0,
        latencyMs: Date.now() - start,
      };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start, message: 'Health check failed' };
    }
  }

  async query(actionType: string, params?: Record<string, unknown>): Promise<unknown> {
    const command = params?.command as string ?? actionType;
    const client = await this.pool.acquire();
    try {
      const result = await this.executor.execute(client, command);
      if (result.truncated) {
        // WARN: truncated output, callers must check truncated flag
      }
      return result;
    } finally {
      this.pool.release(client);
    }
  }

  async execute(actionType: string, payload?: Record<string, unknown>): Promise<DeviceExecutionResult> {
    const command = payload?.command as string ?? actionType;
    const client = await this.pool.acquire();
    try {
      const result = await this.executor.execute(client, command, {
        timeout: payload?.timeout as number,
        maxOutputSize: payload?.maxOutputSize as number,
      });
      return {
        success: result.exitCode === 0,
        data: result,
        truncated: result.truncated,
        error: result.exitCode !== 0 ? result.stderr : undefined,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    } finally {
      this.pool.release(client);
    }
  }

  async configure(actionType: string, config: Record<string, unknown>): Promise<DeviceExecutionResult> {
    return this.execute(actionType, config);
  }

  async monitor(targets: string[]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    for (const target of targets) {
      try {
        results[target] = await this.query(target);
      } catch {
        results[target] = null;
      }
    }
    return results;
  }

  async collectMetrics(): Promise<DeviceMetrics> {
    const deviceId = this.config?.driverOptions?.deviceId as string ?? 'unknown';
    const client = await this.pool.acquire();
    try {
      return await this.metricsCollector.collect(client, deviceId);
    } finally {
      this.pool.release(client);
    }
  }

  async collectData(dataType: string): Promise<unknown> {
    const commandMap: Record<string, string> = {
      topology: 'ip neighbor show',
      routes: 'ip route show',
      interfaces: 'ip -s link',
      processes: 'ps aux',
      logs: 'journalctl -n 100 --no-pager',
    };
    const command = commandMap[dataType];
    if (!command) {
      throw new DeviceError(`Unknown data type '${dataType}'`, 'DATA_TYPE_NOT_FOUND');
    }
    return this.query(command);
  }

  getCapabilityManifest(): CapabilityManifest {
    return {
      driverType: 'ssh',
      vendor: 'generic',
      commands: [
        { actionType: 'exec', description: 'Execute arbitrary command', readOnly: false, riskLevel: 'medium' },
        { actionType: 'query', description: 'Execute read-only command', readOnly: true, riskLevel: 'low' },
        { actionType: 'upload', description: 'Upload file via SFTP', readOnly: false, riskLevel: 'medium' },
        { actionType: 'download', description: 'Download file via SFTP', readOnly: true, riskLevel: 'low' },
      ],
      metricsCapabilities: ['cpuUsage', 'memoryUsage', 'diskUsage', 'uptime', 'interfaces'],
      dataCapabilities: ['topology', 'routes', 'interfaces', 'processes', 'logs'],
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class SshDriverFactory implements DeviceDriverFactory {
  readonly driverType = 'ssh' as const;

  async create(): Promise<DeviceDriver> {
    return new SshDriver();
  }
}

export { SshConnectionPool } from './connectionPool';
export { CommandExecutor } from './commandExecutor';
export { SshMetricsCollector } from './metricsCollector';
export { FileTransfer } from './fileTransfer';
