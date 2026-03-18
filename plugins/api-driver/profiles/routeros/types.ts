/**
 * RouterOS 特定类型定义
 *
 * 从核心类型系统迁移到 Profile 目录，保持 RouterOS 特定逻辑隔离。
 *
 * Requirements: A3.11
 */

/** RouterOS 系统资源信息 */
export interface RouterOSResource {
  uptime: string;
  'cpu-load': string;
  'free-memory': string;
  'total-memory': string;
  'free-hdd-space': string;
  'total-hdd-space': string;
  'architecture-name': string;
  'board-name': string;
  version: string;
}

/** RouterOS 接口信息 */
export interface RouterOSInterface {
  '.id': string;
  name: string;
  type: string;
  'default-name'?: string;
  mtu: string;
  'actual-mtu': string;
  running: string;
  disabled: string;
  'rx-byte': string;
  'tx-byte': string;
  'rx-packet': string;
  'tx-packet': string;
  'rx-error': string;
  'tx-error': string;
  'link-downs'?: string;
}

/** RouterOS 系统身份 */
export interface RouterOSIdentity {
  name: string;
}

/** RouterOS 路由板信息 */
export interface RouterOSRouterboard {
  'routerboard': string;
  model: string;
  'serial-number': string;
  'firmware-type': string;
  'current-firmware': string;
  'upgrade-firmware': string;
}
