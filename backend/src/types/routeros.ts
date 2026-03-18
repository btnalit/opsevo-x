/**
 * RouterOS 数据类型定义
 * 定义与 RouterOS API 交互所需的所有接口类型
 */

// ==================== 连接配置 ====================

/**
 * RouterOS 连接配置
 */
export interface RouterOSConfig {
  host: string;        // RouterOS 地址
  port: number;        // API 端口，默认 443
  username: string;    // 用户名
  password: string;    // 密码
  useTLS: boolean;     // 是否使用 HTTPS
}

// ==================== Interface 模块 ====================

/**
 * 网络接口数据模型
 */
export interface NetworkInterface {
  '.id': string;           // RouterOS 内部 ID
  name: string;            // 接口名称
  type: string;            // 接口类型 (ether, vlan, bridge, etc.)
  'mac-address': string;   // MAC 地址
  mtu: number;             // MTU 值
  disabled: boolean;       // 是否禁用
  running: boolean;        // 是否运行中
  comment?: string;        // 备注
}

/**
 * VETH 虚拟以太网接口数据模型
 */
export interface VethInterface {
  '.id': string;           // RouterOS 内部 ID
  name: string;            // 接口名称
  'mac-address'?: string;  // MAC 地址
  address?: string;        // IP 地址 (CIDR 格式)
  gateway?: string;        // IPv4 网关
  gateway6?: string;       // IPv6 网关
  mtu?: number;            // MTU 值
  disabled: boolean;       // 是否禁用
  running: boolean;        // 是否运行中
  comment?: string;        // 备注
}

// ==================== IP 模块 ====================

/**
 * IP 地址数据模型
 */
export interface IpAddress {
  '.id': string;           // RouterOS 内部 ID
  address: string;         // IP 地址 (CIDR 格式)
  network: string;         // 网络地址
  interface: string;       // 绑定接口
  disabled: boolean;       // 是否禁用
  comment?: string;        // 备注
}


/**
 * 路由数据模型
 */
export interface Route {
  '.id': string;           // RouterOS 内部 ID
  'dst-address': string;   // 目标地址
  gateway: string;         // 网关
  'gateway-status'?: string; // 网关状态
  distance: number;        // 路由距离
  scope: number;           // 作用域
  disabled: boolean;       // 是否禁用
  active: boolean;         // 是否激活
  dynamic: boolean;        // 是否动态路由
  comment?: string;        // 备注
}

// ==================== System 模块 ====================

/**
 * 计划任务数据模型
 */
export interface Scheduler {
  '.id': string;           // RouterOS 内部 ID
  name: string;            // 任务名称
  'start-date'?: string;   // 开始日期
  'start-time': string;    // 开始时间
  interval: string;        // 执行间隔
  'on-event': string;      // 关联脚本名称
  disabled: boolean;       // 是否禁用
  'run-count': number;     // 运行次数
  'next-run'?: string;     // 下次运行时间
  comment?: string;        // 备注
}

/**
 * 脚本数据模型
 */
export interface Script {
  '.id': string;           // RouterOS 内部 ID
  name: string;            // 脚本名称
  source: string;          // 脚本内容
  owner: string;           // 所有者
  policy: string[];        // 权限策略
  'run-count': number;     // 运行次数
  'last-started'?: string; // 最后运行时间
  comment?: string;        // 备注
}

// ==================== API 响应类型 ====================

/**
 * API 成功响应
 */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/**
 * API 错误响应
 */
export interface ApiErrorResponse {
  success: false;
  error: string;
  detail?: string;
}

/**
 * API 响应联合类型
 */
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * 连接状态
 */
export interface ConnectionStatus {
  connected: boolean;
  host?: string;
  lastConnected?: string;
  error?: string;
  config?: Omit<RouterOSConfig, 'password'>;
}

/**
 * RouterOS API 错误
 */
export interface RouterOSError {
  error: number;
  message: string;
  detail?: string;
}
