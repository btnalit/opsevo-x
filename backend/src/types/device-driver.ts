/**
 * DeviceDriver 统一接口与类型系统
 *
 * 所有设备驱动（API Driver、SSH Driver、SNMP Driver）实现此接口，
 * 上层模块通过 DeviceManager 统一分发，不直接依赖具体驱动实现。
 *
 * Requirements: A1.1, A1.2, A1.4
 */

// ─── Driver Types ────────────────────────────────────────────────────────────

/** 支持的驱动类型 */
export type DriverType = 'api' | 'ssh' | 'snmp';

/** 设备连接配置 */
export interface DeviceConnectionConfig {
  /** 驱动类型 */
  driverType: DriverType;
  /** 主机地址 */
  host: string;
  /** 端口 */
  port: number;
  /** 用户名 */
  username?: string;
  /** 密码（明文，运行时使用） */
  password?: string;
  /** 是否使用 TLS/SSL */
  useTLS?: boolean;
  /** 连接超时 (ms) */
  timeout?: number;
  /** 驱动特定配置 */
  driverOptions?: Record<string, unknown>;
}

// ─── Capability Manifest ─────────────────────────────────────────────────────

/** 命令模式定义 */
export interface CommandPattern {
  /** 操作类型标识 */
  actionType: string;
  /** 操作描述 */
  description: string;
  /** 输入参数 Schema */
  inputSchema?: Record<string, unknown>;
  /** 输出格式描述 */
  outputFormat?: string;
  /** 是否为只读操作 */
  readOnly: boolean;
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

/** 设备能力清单 */
export interface CapabilityManifest {
  /** 驱动类型 */
  driverType: DriverType;
  /** 设备厂商 */
  vendor: string;
  /** 设备型号/系列 */
  model?: string;
  /** 固件/OS 版本 */
  firmwareVersion?: string;
  /** 支持的操作列表 */
  commands: CommandPattern[];
  /** 支持的指标采集类型 */
  metricsCapabilities: string[];
  /** 支持的数据采集类型 */
  dataCapabilities: string[];
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

// ─── Device Metrics ──────────────────────────────────────────────────────────

/** 标准化设备指标 */
export interface DeviceMetrics {
  /** 设备 ID */
  deviceId: string;
  /** 采集时间戳 */
  timestamp: number;
  /** CPU 使用率 (0-100) */
  cpuUsage?: number;
  /** 内存使用率 (0-100) */
  memoryUsage?: number;
  /** 磁盘使用率 (0-100) */
  diskUsage?: number;
  /** 系统运行时间 (秒) */
  uptime?: number;
  /** 网络接口指标 */
  interfaces?: InterfaceMetrics[];
  /** 额外指标 */
  extra?: Record<string, unknown>;
}

/** 网络接口指标 */
export interface InterfaceMetrics {
  name: string;
  status: 'up' | 'down' | 'unknown';
  rxBytes?: number;
  txBytes?: number;
  rxPackets?: number;
  txPackets?: number;
  rxErrors?: number;
  txErrors?: number;
  speed?: number;
}

// ─── Health Check ────────────────────────────────────────────────────────────

/** 健康检查结果 */
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs: number;
  message?: string;
  details?: Record<string, unknown>;
}

// ─── Device Error ────────────────────────────────────────────────────────────

/** 设备操作错误 */
export class DeviceError extends Error {
  public readonly code: string;
  public readonly deviceId?: string;
  public readonly driverType?: DriverType;
  public readonly recoverable: boolean;

  constructor(
    message: string,
    code: string,
    options?: { deviceId?: string; driverType?: DriverType; recoverable?: boolean },
  ) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    this.deviceId = options?.deviceId;
    this.driverType = options?.driverType;
    this.recoverable = options?.recoverable ?? false;
  }
}

// ─── Execution Result ────────────────────────────────────────────────────────

/** 设备操作执行结果 */
export interface DeviceExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** 输出是否被截断（超过大小限制） */
  truncated?: boolean;
  /** 执行耗时 (ms) */
  durationMs?: number;
}

// ─── DeviceDriver Interface ──────────────────────────────────────────────────

/**
 * DeviceDriver 统一接口
 *
 * 所有设备驱动必须实现此接口。上层模块通过 DeviceManager
 * 获取 DeviceDriver 实例，不直接依赖具体驱动。
 *
 * Requirements: A1.1, A1.2
 */
export interface DeviceDriver {
  /** 驱动类型标识 */
  readonly driverType: DriverType;

  /** 建立设备连接 */
  connect(config: DeviceConnectionConfig): Promise<void>;

  /** 断开设备连接 */
  disconnect(): Promise<void>;

  /** 健康检查 */
  healthCheck(): Promise<HealthCheckResult>;

  /** 查询设备数据（只读） */
  query(actionType: string, params?: Record<string, unknown>): Promise<unknown>;

  /** 执行设备操作（可能有副作用） */
  execute(actionType: string, payload?: Record<string, unknown>): Promise<DeviceExecutionResult>;

  /** 配置设备 */
  configure(actionType: string, config: Record<string, unknown>): Promise<DeviceExecutionResult>;

  /** 监控设备（返回实时数据流或快照） */
  monitor(targets: string[]): Promise<Record<string, unknown>>;

  /** 采集标准化指标 */
  collectMetrics(): Promise<DeviceMetrics>;

  /** 采集指定类型的数据 */
  collectData(dataType: string): Promise<unknown>;

  /** 获取设备能力清单 */
  getCapabilityManifest(): CapabilityManifest;
}

// ─── Driver Factory ──────────────────────────────────────────────────────────

/**
 * 驱动工厂接口
 * 用于 DeviceManager 注册和创建驱动实例
 */
export interface DeviceDriverFactory {
  /** 此工厂支持的驱动类型 */
  readonly driverType: DriverType;

  /** 创建驱动实例 */
  create(config: DeviceConnectionConfig): Promise<DeviceDriver>;
}
