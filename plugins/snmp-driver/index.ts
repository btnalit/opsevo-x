/**
 * SNMP Driver Plugin — 入口
 *
 * 实现 DeviceDriver 接口，通过 SNMP v2c/v3 管理网络设备。
 *
 * Requirements: A9.37, A9.38, A9.39, A9.40, A9.41, A9.42, A9.43
 */

import type {
  DeviceDriver,
  DeviceDriverFactory,
  DeviceConnectionConfig,
  DeviceExecutionResult,
  DeviceMetrics,
  CapabilityManifest,
  HealthCheckResult,
  InterfaceMetrics,
} from '../../backend/src/types/device-driver';
import { DeviceError } from '../../backend/src/types/device-driver';
import type { SnmpConnectionConfig } from './types';
import { BUILTIN_OIDS } from './types';

export class SnmpDriver implements DeviceDriver {
  readonly driverType = 'snmp' as const;

  private config: DeviceConnectionConfig | null = null;
  private snmpConfig: SnmpConnectionConfig | null = null;
  private session: any = null;

  async connect(config: DeviceConnectionConfig): Promise<void> {
    this.config = config;
    this.snmpConfig = (config.driverOptions?.snmp as SnmpConnectionConfig) ?? {
      version: '2c',
      community: 'public',
    };
    // Session will be created lazily on first use
    // SNMP is connectionless (UDP), so "connect" just stores config
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      try { this.session.close?.(); } catch {}
      this.session = null;
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await this.get(BUILTIN_OIDS.sysName);
      return {
        healthy: result != null,
        latencyMs: Date.now() - start,
        details: { sysName: result },
      };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start, message: 'SNMP health check failed' };
    }
  }

  async query(actionType: string, params?: Record<string, unknown>): Promise<unknown> {
    const oid = params?.oid as string ?? (BUILTIN_OIDS as any)[actionType] ?? actionType;
    if (actionType === 'getBulk' || actionType === 'walk') {
      return this.walk(oid);
    }
    return this.get(oid);
  }

  async execute(actionType: string, payload?: Record<string, unknown>): Promise<DeviceExecutionResult> {
    try {
      if (actionType === 'set') {
        const oid = payload?.oid as string;
        const value = payload?.value;
        const type = payload?.type as number ?? 4; // OctetString
        if (!oid) return { success: false, error: 'OID required for set' };
        await this.set(oid, value, type);
        return { success: true };
      }
      const data = await this.query(actionType, payload);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async configure(actionType: string, config: Record<string, unknown>): Promise<DeviceExecutionResult> {
    return this.execute('set', config);
  }

  async monitor(targets: string[]): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    for (const target of targets) {
      try {
        results[target] = await this.get((BUILTIN_OIDS as any)[target] ?? target);
      } catch {
        results[target] = null;
      }
    }
    return results;
  }

  async collectMetrics(): Promise<DeviceMetrics> {
    const deviceId = this.config?.driverOptions?.deviceId as string ?? 'unknown';
    const metrics: DeviceMetrics = { deviceId, timestamp: Date.now() };

    try {
      const uptime = await this.get(BUILTIN_OIDS.sysUpTime);
      if (uptime != null) metrics.uptime = Math.floor(Number(uptime) / 100);
    } catch {}

    try {
      const cpuData = await this.walk(BUILTIN_OIDS.hrProcessorLoad);
      if (Array.isArray(cpuData) && cpuData.length > 0) {
        const total = cpuData.reduce((sum: number, v: any) => sum + (Number(v.value) || 0), 0);
        metrics.cpuUsage = Math.round(total / cpuData.length);
      }
    } catch {}

    try {
      const ifData = await this.walk(BUILTIN_OIDS.ifTable);
      if (Array.isArray(ifData)) {
        metrics.interfaces = this.parseInterfaceTable(ifData);
      }
    } catch {}

    return metrics;
  }

  async collectData(dataType: string): Promise<unknown> {
    const oidMap: Record<string, string> = {
      interfaces: BUILTIN_OIDS.ifTable,
      system: BUILTIN_OIDS.sysDescr,
    };
    const oid = oidMap[dataType];
    if (!oid) throw new DeviceError(`Unknown data type '${dataType}'`, 'DATA_TYPE_NOT_FOUND');
    return this.walk(oid);
  }

  getCapabilityManifest(): CapabilityManifest {
    return {
      driverType: 'snmp',
      vendor: 'generic',
      commands: [
        { actionType: 'get', description: 'SNMP GET', readOnly: true, riskLevel: 'low' },
        { actionType: 'getBulk', description: 'SNMP GetBulk/Walk', readOnly: true, riskLevel: 'low' },
        { actionType: 'set', description: 'SNMP SET', readOnly: false, riskLevel: 'high' },
      ],
      metricsCapabilities: ['cpuUsage', 'uptime', 'interfaces'],
      dataCapabilities: ['interfaces', 'system'],
    };
  }

  // ─── Private SNMP operations ─────────────────────────────────────────────

  private async get(oid: string): Promise<unknown> {
    const session = await this.getSession();
    return new Promise((resolve, reject) => {
      session.get([oid], (error: Error | null, varbinds: any[]) => {
        if (error) return reject(error);
        if (!varbinds || varbinds.length === 0) return resolve(null);
        const vb = varbinds[0];
        if (vb.type === 128 || vb.type === 129) return resolve(null); // noSuchObject/noSuchInstance
        resolve(vb.value);
      });
    });
  }

  private async walk(oid: string): Promise<Array<{ oid: string; value: unknown }>> {
    const session = await this.getSession();
    const results: Array<{ oid: string; value: unknown }> = [];

    return new Promise((resolve, reject) => {
      const maxRepetitions = 20;
      const feedCb = (varbinds: any[]) => {
        for (const vb of varbinds) {
          if (vb.type !== 128 && vb.type !== 129) {
            results.push({ oid: vb.oid, value: vb.value });
          }
        }
      };

      session.subtree(oid, maxRepetitions, feedCb, (error: Error | null) => {
        if (error) return reject(error);
        resolve(results);
      });
    });
  }

  private async set(oid: string, value: unknown, type: number): Promise<void> {
    const session = await this.getSession();
    return new Promise((resolve, reject) => {
      session.set([{ oid, type, value }], (error: Error | null) => {
        if (error) return reject(error);
        resolve();
      });
    });
  }

  private async getSession(): Promise<any> {
    if (this.session) return this.session;
    if (!this.config || !this.snmpConfig) {
      throw new DeviceError('SNMP not configured', 'NOT_CONFIGURED');
    }

    // Dynamic import to avoid hard dependency
    const snmp = await import('net-snmp');

    if (this.snmpConfig.version === '3') {
      const user = {
        name: this.snmpConfig.username ?? '',
        level: snmp.SecurityLevel[this.snmpConfig.securityLevel ?? 'noAuthNoPriv'],
        authProtocol: this.snmpConfig.authProtocol === 'SHA' ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
        authKey: this.snmpConfig.authKey ?? '',
        privProtocol: this.snmpConfig.privProtocol === 'AES' ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
        privKey: this.snmpConfig.privKey ?? '',
      };
      this.session = snmp.createV3Session(this.config.host, user, {
        port: this.config.port || 161,
        timeout: this.config.timeout ?? 5000,
      });
    } else {
      this.session = snmp.createSession(this.config.host, this.snmpConfig.community ?? 'public', {
        port: this.config.port || 161,
        timeout: this.config.timeout ?? 5000,
        version: snmp.Version2c,
      });
    }

    return this.session;
  }

  private parseInterfaceTable(data: Array<{ oid: string; value: unknown }>): InterfaceMetrics[] {
    const ifMap = new Map<string, Partial<InterfaceMetrics>>();

    for (const { oid, value } of data) {
      const parts = oid.split('.');
      const ifIndex = parts[parts.length - 1];
      const columnOid = parts.slice(0, -1).join('.');

      if (!ifMap.has(ifIndex)) ifMap.set(ifIndex, {});
      const iface = ifMap.get(ifIndex)!;

      if (columnOid.endsWith('.2.2.1.2')) iface.name = String(value);
      if (columnOid.endsWith('.2.2.1.8')) iface.status = Number(value) === 1 ? 'up' : 'down';
      if (columnOid.endsWith('.2.2.1.10')) iface.rxBytes = Number(value);
      if (columnOid.endsWith('.2.2.1.16')) iface.txBytes = Number(value);
      if (columnOid.endsWith('.2.2.1.14')) iface.rxErrors = Number(value);
      if (columnOid.endsWith('.2.2.1.20')) iface.txErrors = Number(value);
      if (columnOid.endsWith('.2.2.1.5')) iface.speed = Number(value);
    }

    return Array.from(ifMap.values())
      .filter(i => i.name)
      .map(i => ({
        name: i.name!,
        status: i.status ?? 'unknown',
        rxBytes: i.rxBytes,
        txBytes: i.txBytes,
        rxErrors: i.rxErrors,
        txErrors: i.txErrors,
        speed: i.speed,
      }));
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class SnmpDriverFactory implements DeviceDriverFactory {
  readonly driverType = 'snmp' as const;

  async create(): Promise<DeviceDriver> {
    return new SnmpDriver();
  }
}
