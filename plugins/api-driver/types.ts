/**
 * API Driver 类型定义
 *
 * Requirements: A2.5, A2.6
 */

/** API Profile 端点定义 */
export interface ApiEndpoint {
  /** 操作类型标识（对应 CommandPattern.actionType） */
  actionType: string;
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL 路径模板（支持 :param 占位符） */
  path: string;
  /** 描述 */
  description: string;
  /** 是否只读 */
  readOnly: boolean;
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** 请求体模板 */
  bodyTemplate?: Record<string, unknown>;
  /** 响应转换 JMESPath 表达式 */
  responseTransform?: string;
  /** 输出格式 */
  outputFormat?: string;
}

/** API Profile 认证配置 */
export interface ApiAuthConfig {
  type: 'basic' | 'bearer' | 'api-key' | 'custom';
  /** 认证头名称（api-key 模式） */
  headerName?: string;
  /** 登录端点（custom 模式） */
  loginEndpoint?: string;
  /** 登录请求体模板 */
  loginBody?: Record<string, unknown>;
  /** Token 提取路径 */
  tokenPath?: string;
}

/** API Profile 完整定义 */
export interface ApiProfile {
  /** Profile 唯一标识 */
  profileId: string;
  /** 显示名称 */
  displayName: string;
  /** 厂商 */
  vendor: string;
  /** 设备型号 */
  model?: string;
  /** 基础 URL 模板 */
  baseUrl: string;
  /** 认证配置 */
  auth: ApiAuthConfig;
  /** 端点列表 */
  endpoints: ApiEndpoint[];
  /** 指标采集端点映射 */
  metricsEndpoints?: Record<string, string>;
  /** 数据采集端点映射 */
  dataEndpoints?: Record<string, string>;
  /** TLS 配置 */
  tls?: { rejectUnauthorized?: boolean; ca?: string };
  /** 默认超时 (ms) */
  timeout?: number;
  /** 重试次数 */
  retries?: number;
}

/** HTTP 请求配置 */
export interface HttpRequestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

/** HTTP 响应 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}
