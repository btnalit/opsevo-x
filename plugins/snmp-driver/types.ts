/**
 * SNMP Driver 类型定义
 *
 * Requirements: A9.37
 */

/** SNMP 版本 */
export type SnmpVersion = '2c' | '3';

/** SNMP v3 安全级别 */
export type SecurityLevel = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';

/** SNMP v3 认证协议 */
export type AuthProtocol = 'MD5' | 'SHA';

/** SNMP v3 加密协议 */
export type PrivProtocol = 'DES' | 'AES';

/** SNMP 连接配置 */
export interface SnmpConnectionConfig {
  version: SnmpVersion;
  /** v2c community string */
  community?: string;
  /** v3 用户名 */
  username?: string;
  /** v3 安全级别 */
  securityLevel?: SecurityLevel;
  /** v3 认证协议 */
  authProtocol?: AuthProtocol;
  /** v3 认证密钥 */
  authKey?: string;
  /** v3 加密协议 */
  privProtocol?: PrivProtocol;
  /** v3 加密密钥 */
  privKey?: string;
}

/** OID 映射条目 */
export interface OidMapping {
  oid: string;
  name: string;
  type: 'gauge' | 'counter' | 'string' | 'timeticks';
  description?: string;
}

/** 内置 MIB OID 常量 */
export const BUILTIN_OIDS = {
  // SNMPv2-MIB
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',

  // IF-MIB
  ifNumber: '1.3.6.1.2.1.2.1.0',
  ifTable: '1.3.6.1.2.1.2.2',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',

  // HOST-RESOURCES-MIB
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageUsed: '1.3.6.1.2.1.25.2.3.1.6',
  hrStorageSize: '1.3.6.1.2.1.25.2.3.1.5',
  hrSystemUptime: '1.3.6.1.2.1.25.1.1.0',
} as const;
