/**
 * Context Builder Service
 * 构建 RouterOS 上下文信息，注入到 AI 对话中
 * 
 * 功能：
 * - 生成系统提示词
 * - 获取 RouterOS 连接状态和系统信息
 * - 获取指定配置段
 * - 脱敏处理敏感信息
 */

import { routerosClient, RouterOSClient } from '../routerosClient';
import {
  IContextBuilder,
  RouterOSContext,
  RouterOSConnectionContext,
  RouterOSSystemInfo,
  DeviceContext,
  DeviceConnectionContext,
  DeviceSystemInfo,
  SelectedConfig,
  ROUTEROS_SYSTEM_PROMPT
} from '../../types/ai';
import { logger } from '../../utils/logger';
import type { DeviceManager } from '../device/deviceManager';

/**
 * 敏感字段列表 - 这些字段的值将被脱敏处理
 */
const SENSITIVE_FIELDS = [
  'password',
  'secret',
  'key',
  'api-key',
  'apikey',
  'api_key',
  'private-key',
  'privatekey',
  'private_key',
  'psk',
  'pre-shared-key',
  'passphrase',
  'auth-key',
  'authentication-key',
  'certificate-key',
  'wpa-pre-shared-key',
  'wpa2-pre-shared-key',
  'radius-secret',
  'shared-secret',
  'l2tp-secret',
  'pptp-secret',
  'ipsec-secret',
  'token',
  'access-token',
  'refresh-token',
  'bearer',
  'credential',
  'credentials'
];

/**
 * 敏感字段正则模式 - 用于匹配包含敏感关键词的字段名
 */
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /key$/i,
  /^key/i,
  /token/i,
  /credential/i,
  /psk/i,
  /passphrase/i
];

/**
 * 脱敏后的占位符
 */
const SANITIZED_PLACEHOLDER = '***REDACTED***';

/**
 * RouterOS 配置路径映射
 */
const CONFIG_PATHS: Record<string, string> = {
  'interface': '/interface',
  'ip-address': '/ip/address',
  'ip-route': '/ip/route',
  'ip-firewall-filter': '/ip/firewall/filter',
  'ip-firewall-nat': '/ip/firewall/nat',
  'ip-firewall-mangle': '/ip/firewall/mangle',
  'ip-firewall-address-list': '/ip/firewall/address-list',
  'ip-dhcp-server': '/ip/dhcp-server',
  'ip-dhcp-client': '/ip/dhcp-client',
  'ip-pool': '/ip/pool',
  'ipv6-address': '/ipv6/address',
  'ipv6-route': '/ipv6/route',
  'ipv6-firewall-filter': '/ipv6/firewall/filter',
  'ipv6-nd': '/ipv6/nd',
  'ipv6-dhcp-client': '/ipv6/dhcp-client',
  'system-identity': '/system/identity',
  'system-resource': '/system/resource',
  'system-routerboard': '/system/routerboard',
  'system-script': '/system/script',
  'system-scheduler': '/system/scheduler',
  'wireless': '/interface/wireless',
  'bridge': '/interface/bridge',
  'vlan': '/interface/vlan',
  'ppp-secret': '/ppp/secret',
  'user': '/user',
  'queue': '/queue/simple',
  'dns': '/ip/dns',
  'snmp': '/snmp',
  'radius': '/radius'
};

/**
 * 系统资源接口
 */

/**
 * 泛化设备系统提示词模板（设备无关）
 * Requirements: J3.8 - 从 DeviceContext 构建系统 Prompt，不再硬编码 RouterOS 特定内容
 */
const GENERIC_DEVICE_SYSTEM_PROMPT = `你是智能运维助手，专注于网络设备和系统的智能运维管理。你的职责是：

1. 帮助用户理解和配置受管设备
2. 生成准确、安全的设备配置脚本
3. 解释网络概念和设备特定功能
4. 提供最佳实践建议

重要规则：
- 所有设备命令必须使用代码块格式
- 在执行危险操作前提醒用户备份配置
- 不要假设用户的网络拓扑，需要时请询问
- 优先使用安全的配置方式
- 解释每个命令的作用

【严格禁止】：
- 绝对不要假装已经执行了命令
- 绝对不要编造或虚构任何配置数据、IP地址、接口名称等信息
- 绝对不要生成假的命令输出结果
- 如果用户想查看配置，只提供命令，让用户点击"执行"按钮来获取真实数据
- 你无法直接访问或执行设备命令，只能生成命令供用户执行

正确的回复方式：
- 当用户想查看配置时，说"您可以执行以下命令查看"，然后提供命令
- 不要在命令后面添加假的输出结果
- 等用户执行命令后，根据真实输出来回答问题

当前连接状态：
{connectionContext}
`;

/**
 * 设备上下文信息（多设备支持）
 * Requirements: 8.2 - 在对话上下文中包含当前设备的基本信息
 */
export interface DeviceContextInfo {
  /** 设备名称 */
  name: string;
  /** 设备 IP 地址 */
  host: string;
  /** 设备型号（可选，从 RouterOS 获取） */
  model?: string;
  /** 设备 ID */
  deviceId?: string;
}

interface SystemResource {
  '.id'?: string;
  'cpu'?: string;
  'cpu-count'?: string;
  'cpu-frequency'?: string;
  'cpu-load'?: string;
  'architecture-name'?: string;
  'board-name'?: string;
  'version'?: string;
  'build-time'?: string;
  'uptime'?: string;
  'total-memory'?: string;
  'free-memory'?: string;
  'total-hdd-space'?: string;
  'free-hdd-space'?: string;
}

/**
 * 系统身份接口
 */
interface SystemIdentity {
  name?: string;
}

export class ContextBuilderService implements IContextBuilder {
  // 泛化设备支持：DeviceManager 引用
  // Requirements: J3.9 - 通过 DeviceManager 获取设备信息
  private deviceManager: DeviceManager | null = null;

  /**
   * 注入 DeviceManager（用于泛化设备上下文获取）
   * Requirements: J3.9
   */
  setDeviceManager(dm: DeviceManager): void {
    this.deviceManager = dm;
    logger.debug('DeviceManager injected into ContextBuilderService');
  }

  /**
   * 构建系统提示词
   * 将 RouterOS 连接上下文注入到系统提示词模板中
   */
  buildSystemPrompt(): string {
    return ROUTEROS_SYSTEM_PROMPT;
  }

  /**
   * 构建带有上下文的系统提示词
   * @param context RouterOS 上下文信息
   */
  buildSystemPromptWithContext(context: RouterOSContext): string {
    const contextStr = this.formatContextForPrompt(context);
    return ROUTEROS_SYSTEM_PROMPT.replace('{connectionContext}', contextStr);
  }

  /**
   * 格式化上下文信息为提示词字符串
   */
  private formatContextForPrompt(context: RouterOSContext): string {
    const lines: string[] = [];

    // 连接状态
    if (context.connectionStatus.connected) {
      lines.push(`- 已连接到: ${context.connectionStatus.host}`);
      if (context.connectionStatus.version) {
        lines.push(`- RouterOS 版本: ${context.connectionStatus.version}`);
      }
    } else {
      lines.push('- 未连接到 RouterOS 设备');
    }

    // 系统信息
    if (context.systemInfo) {
      lines.push(`- 设备名称: ${context.systemInfo.identity}`);
      lines.push(`- 设备型号: ${context.systemInfo.boardName}`);
      lines.push(`- 运行时间: ${context.systemInfo.uptime}`);
    }

    // 选中的配置
    if (context.selectedConfigs && context.selectedConfigs.length > 0) {
      lines.push('\n当前选中的配置:');
      for (const config of context.selectedConfigs) {
        lines.push(`\n[${config.type}]`);
        lines.push('```json');
        lines.push(JSON.stringify(config.data, null, 2));
        lines.push('```');
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取 RouterOS 连接上下文
   * 包括连接状态、系统信息等
   */
  async getConnectionContext(): Promise<RouterOSContext> {
    const connectionStatus = this.getConnectionStatus();
    
    // 如果未连接，直接返回基本状态
    if (!connectionStatus.connected) {
      return {
        connectionStatus
      };
    }

    // 获取系统信息
    let systemInfo: RouterOSSystemInfo | undefined;
    try {
      systemInfo = await this.getSystemInfo();
    } catch (error) {
      logger.warn('Failed to get system info for context:', error);
    }

    return {
      connectionStatus: {
        ...connectionStatus,
        version: systemInfo?.version
      },
      systemInfo
    };
  }

  /**
   * 获取连接状态
   */
  private getConnectionStatus(): RouterOSConnectionContext {
    const connected = routerosClient.isConnected();
    const config = routerosClient.getConfig();

    return {
      connected,
      host: config?.host || ''
    };
  }

  /**
   * 获取系统信息
   */
  private async getSystemInfo(): Promise<RouterOSSystemInfo | undefined> {
    try {
      // 获取系统资源
      const resources = await routerosClient.print<SystemResource>('/system/resource');
      const resource = resources?.[0];

      // 获取系统身份
      const identities = await routerosClient.print<SystemIdentity>('/system/identity');
      const identity = identities?.[0];

      if (!resource) {
        return undefined;
      }

      return {
        identity: identity?.name || 'Unknown',
        boardName: resource['board-name'] || 'Unknown',
        version: resource['version'] || 'Unknown',
        uptime: resource['uptime'] || 'Unknown'
      };
    } catch (error) {
      logger.error('Failed to get system info:', error);
      return undefined;
    }
  }

  /**
   * 获取指定 RouterOS 客户端的连接上下文（多设备支持）
   * Requirements: 8.1, 8.2 - 使用指定设备的连接获取上下文
   * @param client 指定的 RouterOS 客户端实例
   */
  async getConnectionContextForClient(client: RouterOSClient): Promise<RouterOSContext> {
    const connected = client.isConnected();
    const config = client.getConfig();
    const connectionStatus: RouterOSConnectionContext = {
      connected,
      host: config?.host || ''
    };

    // 如果未连接，直接返回基本状态
    if (!connected) {
      return { connectionStatus };
    }

    // 获取系统信息
    let systemInfo: RouterOSSystemInfo | undefined;
    try {
      systemInfo = await this.getSystemInfoForClient(client);
    } catch (error) {
      logger.warn('Failed to get system info for device-specific context:', error);
    }

    return {
      connectionStatus: {
        ...connectionStatus,
        version: systemInfo?.version
      },
      systemInfo
    };
  }

  /**
   * 获取指定 RouterOS 客户端的系统信息（多设备支持）
   * @param client 指定的 RouterOS 客户端实例
   */
  private async getSystemInfoForClient(client: RouterOSClient): Promise<RouterOSSystemInfo | undefined> {
    try {
      const resources = await client.print<SystemResource>('/system/resource');
      const resource = resources?.[0];

      const identities = await client.print<SystemIdentity>('/system/identity');
      const identity = identities?.[0];

      if (!resource) {
        return undefined;
      }

      return {
        identity: identity?.name || 'Unknown',
        boardName: resource['board-name'] || 'Unknown',
        version: resource['version'] || 'Unknown',
        uptime: resource['uptime'] || 'Unknown'
      };
    } catch (error) {
      logger.error('Failed to get system info for client:', error);
      return undefined;
    }
  }

  /**
   * 构建带有设备信息的系统提示词（多设备支持）
   * Requirements: 8.2 - 在对话上下文中包含当前设备的基本信息
   * @param context RouterOS 上下文信息
   * @param deviceInfo 设备基本信息（名称、IP、型号等）
   */
  buildSystemPromptWithDeviceContext(context: RouterOSContext, deviceInfo?: DeviceContextInfo): string {
    let contextStr = this.formatContextForPrompt(context);
    
    // 注入设备基本信息
    if (deviceInfo) {
      const deviceLines: string[] = [
        '\n当前操作设备信息:',
        `- 设备名称: ${deviceInfo.name}`,
        `- 设备 IP: ${deviceInfo.host}`,
      ];
      if (deviceInfo.model) {
        deviceLines.push(`- 设备型号: ${deviceInfo.model}`);
      }
      if (deviceInfo.deviceId) {
        deviceLines.push(`- 设备 ID: ${deviceInfo.deviceId}`);
      }
      contextStr += '\n' + deviceLines.join('\n');
    }
    
    return ROUTEROS_SYSTEM_PROMPT.replace('{connectionContext}', contextStr);
  }

  /**
   * 获取泛化设备连接上下文（通过 DeviceManager）
   * Requirements: J3.9 - 通过 DeviceManager 获取 CapabilityManifest 和 DeviceMetrics
   * @param deviceId 设备 ID
   */
  async getConnectionContextForDevice(deviceId: string): Promise<DeviceContext> {
    if (!this.deviceManager) {
      logger.warn('DeviceManager not set, returning disconnected DeviceContext');
      return {
        connectionStatus: { connected: false, host: '', deviceId },
      };
    }

    try {
      const device = await this.deviceManager.findDeviceByIdAcrossTenants(deviceId);
      if (!device) {
        logger.warn(`Device not found for context: ${deviceId}`);
        return {
          connectionStatus: { connected: false, host: '', deviceId },
        };
      }

      const connectionStatus: DeviceConnectionContext = {
        connected: device.status === 'online',
        host: device.host,
        deviceId: device.id,
      };

      // 构建基础系统信息
      let systemInfo: DeviceSystemInfo | undefined;
      if (device.status === 'online') {
        systemInfo = {
          identity: device.name,
          version: 'N/A',
          uptime: 'N/A',
        };
      }

      return {
        connectionStatus,
        systemInfo,
      };
    } catch (error) {
      logger.warn(`Failed to get device context for ${deviceId}:`, error);
      return {
        connectionStatus: { connected: false, host: '', deviceId },
      };
    }
  }

  /**
   * 构建泛化设备系统提示词（设备无关）
   * Requirements: J3.8 - 从 DeviceContext 构建系统 Prompt，不再硬编码 RouterOS 特定内容
   * @param context 泛化设备上下文
   */
  buildSystemPromptFromDeviceContext(context: DeviceContext): string {
    const contextStr = this.formatDeviceContextForPrompt(context);
    return GENERIC_DEVICE_SYSTEM_PROMPT.replace('{connectionContext}', contextStr);
  }

  /**
   * 格式化泛化设备上下文为提示词字符串
   */
  private formatDeviceContextForPrompt(context: DeviceContext): string {
    const lines: string[] = [];

    // 连接状态
    if (context.connectionStatus.connected) {
      lines.push(`- 已连接到: ${context.connectionStatus.host}`);
      if (context.connectionStatus.driverType) {
        lines.push(`- 驱动类型: ${context.connectionStatus.driverType}`);
      }
      if (context.connectionStatus.version) {
        lines.push(`- 系统版本: ${context.connectionStatus.version}`);
      }
      if (context.connectionStatus.deviceId) {
        lines.push(`- 设备 ID: ${context.connectionStatus.deviceId}`);
      }
    } else {
      lines.push('- 未连接到设备');
      if (context.connectionStatus.deviceId) {
        lines.push(`- 设备 ID: ${context.connectionStatus.deviceId}`);
      }
    }

    // 系统信息
    if (context.systemInfo) {
      lines.push(`- 设备名称: ${context.systemInfo.identity}`);
      if (context.systemInfo.vendor) {
        lines.push(`- 厂商: ${context.systemInfo.vendor}`);
      }
      if (context.systemInfo.model) {
        lines.push(`- 设备型号: ${context.systemInfo.model}`);
      }
      lines.push(`- 系统版本: ${context.systemInfo.version}`);
      lines.push(`- 运行时间: ${context.systemInfo.uptime}`);
    }

    // 能力清单
    if (context.capabilities) {
      const caps = context.capabilities;
      if (caps.vendor) {
        lines.push(`- 厂商: ${caps.vendor}`);
      }
      if (caps.model) {
        lines.push(`- 型号: ${caps.model}`);
      }
      if (caps.metricsCapabilities && caps.metricsCapabilities.length > 0) {
        lines.push(`- 支持的指标采集: ${caps.metricsCapabilities.join(', ')}`);
      }
      if (caps.commands && caps.commands.length > 0) {
        const commandNames = caps.commands.map(c => c.actionType).filter(Boolean);
        if (commandNames.length > 0) {
          lines.push(`- 支持的命令: ${commandNames.slice(0, 10).join(', ')}${commandNames.length > 10 ? '...' : ''}`);
        }
      }
    }

    // 选中的配置
    if (context.selectedConfigs && context.selectedConfigs.length > 0) {
      lines.push('\n当前选中的配置:');
      for (const config of context.selectedConfigs) {
        lines.push(`\n[${config.type}]`);
        lines.push('```json');
        lines.push(JSON.stringify(config.data, null, 2));
        lines.push('```');
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取指定配置段
   * @param section 配置段名称，如 'interface', 'ip-address' 等
   */
  async getConfigSection(section: string): Promise<unknown> {
    const path = CONFIG_PATHS[section];
    
    if (!path) {
      throw new Error(`Unknown config section: ${section}`);
    }

    if (!routerosClient.isConnected()) {
      throw new Error('Not connected to RouterOS');
    }

    try {
      const data = await routerosClient.print(path);
      // 对获取的配置进行脱敏处理
      return this.sanitizeConfig(data);
    } catch (error) {
      logger.error(`Failed to get config section ${section}:`, error);
      throw error;
    }
  }

  /**
   * 获取多个配置段
   * @param sections 配置段名称数组
   */
  async getMultipleConfigSections(sections: string[]): Promise<SelectedConfig[]> {
    const results: SelectedConfig[] = [];

    for (const section of sections) {
      try {
        const data = await this.getConfigSection(section);
        results.push({
          type: section,
          data
        });
      } catch (error) {
        logger.warn(`Failed to get config section ${section}:`, error);
        // 继续获取其他配置段
      }
    }

    return results;
  }

  /**
   * 脱敏处理配置数据
   * 移除或掩码敏感信息（密码、密钥、令牌等）
   * @param config 原始配置数据
   */
  sanitizeConfig(config: unknown): unknown {
    if (config === null || config === undefined) {
      return config;
    }

    // 处理数组
    if (Array.isArray(config)) {
      return config.map(item => this.sanitizeConfig(item));
    }

    // 处理对象
    if (typeof config === 'object') {
      const sanitized: Record<string, unknown> = {};
      
      for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        if (this.isSensitiveField(key)) {
          // 敏感字段使用占位符替换
          sanitized[key] = SANITIZED_PLACEHOLDER;
        } else if (typeof value === 'object' && value !== null) {
          // 递归处理嵌套对象
          sanitized[key] = this.sanitizeConfig(value);
        } else if (typeof value === 'string' && this.containsSensitivePattern(value)) {
          // 检查值是否包含敏感模式（如内嵌的密码字符串）
          sanitized[key] = this.sanitizeString(value);
        } else {
          sanitized[key] = value;
        }
      }
      
      return sanitized;
    }

    // 处理字符串 - 检查是否包含敏感模式
    if (typeof config === 'string') {
      return this.sanitizeString(config);
    }

    // 其他类型直接返回
    return config;
  }

  /**
   * 检查字段名是否为敏感字段
   */
  private isSensitiveField(fieldName: string): boolean {
    const lowerFieldName = fieldName.toLowerCase();
    
    // 精确匹配
    if (SENSITIVE_FIELDS.includes(lowerFieldName)) {
      return true;
    }

    // 模式匹配
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(fieldName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 检查字符串值是否包含敏感模式
   * 用于检测内嵌的敏感信息
   */
  private containsSensitivePattern(value: string): boolean {
    // 检查是否包含类似 password=xxx 或 key=xxx 的模式
    const inlinePatterns = [
      /password\s*[=:]\s*\S+/i,
      /secret\s*[=:]\s*\S+/i,
      /key\s*[=:]\s*\S+/i,
      /token\s*[=:]\s*\S+/i,
      /credential\s*[=:]\s*\S+/i
    ];

    for (const pattern of inlinePatterns) {
      if (pattern.test(value)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 脱敏字符串中的敏感信息
   */
  private sanitizeString(value: string): string {
    let sanitized = value;

    // 替换内嵌的敏感信息
    const replacements = [
      { pattern: /(password\s*[=:]\s*)\S+/gi, replacement: `$1${SANITIZED_PLACEHOLDER}` },
      { pattern: /(secret\s*[=:]\s*)\S+/gi, replacement: `$1${SANITIZED_PLACEHOLDER}` },
      { pattern: /(key\s*[=:]\s*)\S+/gi, replacement: `$1${SANITIZED_PLACEHOLDER}` },
      { pattern: /(token\s*[=:]\s*)\S+/gi, replacement: `$1${SANITIZED_PLACEHOLDER}` },
      { pattern: /(credential\s*[=:]\s*)\S+/gi, replacement: `$1${SANITIZED_PLACEHOLDER}` },
      { pattern: /(psk\s*[=:]\s*)\S+/gi, replacement: `$1${SANITIZED_PLACEHOLDER}` }
    ];

    for (const { pattern, replacement } of replacements) {
      sanitized = sanitized.replace(pattern, replacement);
    }

    return sanitized;
  }

  /**
   * 获取可用的配置段列表
   */
  getAvailableConfigSections(): string[] {
    return Object.keys(CONFIG_PATHS);
  }
}

// 导出单例实例
export const contextBuilderService = new ContextBuilderService();
