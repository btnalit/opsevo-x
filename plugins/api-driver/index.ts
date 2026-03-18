/**
 * API Driver Plugin — 入口
 *
 * 实现 DeviceDriver 接口，通过 API Profile 配置驱动 HTTP API 设备。
 *
 * Requirements: A2.5, A2.10
 */

import type {
  DeviceDriver,
  DeviceDriverFactory,
  DeviceConnectionConfig,
  DeviceExecutionResult,
  DeviceMetrics,
  CapabilityManifest,
  HealthCheckResult,
  CommandPattern,
} from '../../backend/src/types/device-driver';
import { DeviceError } from '../../backend/src/types/device-driver';
import type { ApiProfile, ApiEndpoint } from './types';
import { ApiHttpClient } from './httpClient';
import { ApiProfileLoader, apiProfileLoader } from './apiProfileLoader';
import { transformResponse } from './responseTransformer';

// ─── ApiDriver ───────────────────────────────────────────────────────────────

export class ApiDriver implements DeviceDriver {
  readonly driverType = 'api' as const;

  private httpClient: ApiHttpClient | null = null;
  private profile: ApiProfile | null = null;
  private config: DeviceConnectionConfig | null = null;
  private profileLoader: ApiProfileLoader;

  constructor(profileLoader?: ApiProfileLoader) {
    this.profileLoader = profileLoader ?? apiProfileLoader;
  }

  async connect(config: DeviceConnectionConfig): Promise<void> {
    this.config = config;
    const profileId = config.driverOptions?.profileId as string;
    if (!profileId) {
      throw new DeviceError('API Driver requires driverOptions.profileId', 'MISSING_PROFILE');
    }

    this.profile = await this.profileLoader.getProfile(profileId);
    if (!this.profile) {
      throw new DeviceError(`API Profile '${profileId}' not found`, 'PROFILE_NOT_FOUND');
    }

    const baseURL = this.profile.baseUrl
      .replace('{{host}}', config.host)
      .replace('{{port}}', String(config.port));

    this.httpClient = new ApiHttpClient({
      baseURL,
      timeout: this.profile.timeout ?? config.timeout ?? 30000,
      retries: this.profile.retries ?? 2,
      tls: this.profile.tls,
    });

    // Handle authentication
    if (this.profile.auth.type === 'basic' && config.username && config.password) {
      const token = Buffer.from(`${config.username}:${config.password}`).toString('base64');
      this.httpClient.setHeader('Authorization', `Basic ${token}`);
    } else if (this.profile.auth.type === 'bearer' && config.driverOptions?.token) {
      this.httpClient.setHeader('Authorization', `Bearer ${config.driverOptions.token}`);
    } else if (this.profile.auth.type === 'api-key' && config.driverOptions?.apiKey) {
      const headerName = this.profile.auth.headerName ?? 'X-API-Key';
      this.httpClient.setHeader(headerName, config.driverOptions.apiKey as string);
    }
  }

  async disconnect(): Promise<void> {
    this.httpClient = null;
    this.profile = null;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.httpClient) {
      return { healthy: false, latencyMs: 0, message: 'Not connected' };
    }
    const start = Date.now();
    try {
      await this.httpClient.request({ method: 'GET', url: '/' });
      return { healthy: true, latencyMs: Date.now() - start };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start, message: 'Health check failed' };
    }
  }

  async query(actionType: string, params?: Record<string, unknown>): Promise<unknown> {
    const endpoint = this.findEndpoint(actionType);
    if (!endpoint) {
      throw new DeviceError(`No endpoint for action '${actionType}'`, 'ACTION_NOT_FOUND');
    }

    const url = this.buildUrl(endpoint.path, params);
    const resp = await this.httpClient!.request({ method: endpoint.method, url });
    return transformResponse(resp.data, endpoint.responseTransform);
  }

  async execute(actionType: string, payload?: Record<string, unknown>): Promise<DeviceExecutionResult> {
    const endpoint = this.findEndpoint(actionType);
    if (!endpoint) {
      return { success: false, error: `No endpoint for action '${actionType}'` };
    }

    try {
      const url = this.buildUrl(endpoint.path, payload);
      const body = endpoint.bodyTemplate
        ? this.mergeTemplate(endpoint.bodyTemplate, payload)
        : payload;

      const resp = await this.httpClient!.request({
        method: endpoint.method,
        url,
        body: ['POST', 'PUT', 'PATCH'].includes(endpoint.method) ? body : undefined,
      });

      const data = transformResponse(resp.data, endpoint.responseTransform);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
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
    const metrics: DeviceMetrics = {
      deviceId: this.config?.driverOptions?.deviceId as string ?? 'unknown',
      timestamp: Date.now(),
    };

    if (this.profile?.metricsEndpoints) {
      for (const [key, actionType] of Object.entries(this.profile.metricsEndpoints)) {
        try {
          const data = await this.query(actionType);
          (metrics as any)[key] = data;
        } catch {
          // skip failed metrics
        }
      }
    }

    return metrics;
  }

  async collectData(dataType: string): Promise<unknown> {
    const actionType = this.profile?.dataEndpoints?.[dataType];
    if (!actionType) {
      throw new DeviceError(`No data endpoint for type '${dataType}'`, 'DATA_TYPE_NOT_FOUND');
    }
    return this.query(actionType);
  }

  getCapabilityManifest(): CapabilityManifest {
    const commands: CommandPattern[] = (this.profile?.endpoints ?? []).map(ep => ({
      actionType: ep.actionType,
      description: ep.description,
      readOnly: ep.readOnly,
      riskLevel: ep.riskLevel,
      outputFormat: ep.outputFormat,
    }));

    return {
      driverType: 'api',
      vendor: this.profile?.vendor ?? 'unknown',
      model: this.profile?.model,
      commands,
      metricsCapabilities: Object.keys(this.profile?.metricsEndpoints ?? {}),
      dataCapabilities: Object.keys(this.profile?.dataEndpoints ?? {}),
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private findEndpoint(actionType: string): ApiEndpoint | undefined {
    return this.profile?.endpoints.find(ep => ep.actionType === actionType);
  }

  private buildUrl(pathTemplate: string, params?: Record<string, unknown>): string {
    if (!params) return pathTemplate;
    let url = pathTemplate;
    for (const [key, value] of Object.entries(params)) {
      url = url.replace(`:${key}`, encodeURIComponent(String(value)));
    }
    return url;
  }

  private mergeTemplate(template: Record<string, unknown>, data?: Record<string, unknown>): Record<string, unknown> {
    if (!data) return { ...template };
    return { ...template, ...data };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export class ApiDriverFactory implements DeviceDriverFactory {
  readonly driverType = 'api' as const;

  async create(): Promise<DeviceDriver> {
    return new ApiDriver();
  }
}

export { ApiProfileLoader, apiProfileLoader } from './apiProfileLoader';
export type { ApiProfile, ApiEndpoint, ApiAuthConfig } from './types';
