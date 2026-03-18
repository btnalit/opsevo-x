/**
 * SnmpTrapReceiver — SNMP Trap/Inform 接收、解析、OID 映射与 EventBus 集成
 *
 * 功能：
 * - Trap/Inform 接收（UDP 端口 162）                     (D3.15)
 * - Trap PDU 解析（轻量 ASN.1/BER 解码）                 (D3.16)
 * - 内置 OID 映射 + 自定义 OID 映射配置                   (D3.17)
 * - Trap → PerceptionEvent 转换                          (D3.18)
 * - Inform 确认响应机制                                   (D3.19)
 * - OID 映射和 v3 认证配置持久化到 PostgreSQL              (D3.20)
 * - v2c community string 认证 / v3 USM 认证
 */

import dgram from 'dgram';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import type { DataStore } from '../dataStore';
import { EventBus, type PerceptionEvent, type Priority } from '../eventBus';

// ─── ASN.1/BER Tag Constants ───

export const BER_TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  GET_RESPONSE: 0xa2,
  TRAP_V1: 0xa4,
  GET_BULK_REQUEST: 0xa5,
  INFORM_REQUEST: 0xa6,
  TRAP_V2: 0xa7,
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  OPAQUE: 0x44,
  COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
} as const;

// ─── Built-in OID Mappings (D3.17) ───

const BUILTIN_OID_MAPPINGS: Array<{
  oid: string; eventType: string; severity: Priority; description: string;
}> = [
  { oid: '1.3.6.1.6.3.1.1.5.1', eventType: 'coldStart', severity: 'medium', description: 'Device cold start (reboot)' },
  { oid: '1.3.6.1.6.3.1.1.5.2', eventType: 'warmStart', severity: 'low', description: 'Device warm start' },
  { oid: '1.3.6.1.6.3.1.1.5.3', eventType: 'linkDown', severity: 'high', description: 'Network interface link down' },
  { oid: '1.3.6.1.6.3.1.1.5.4', eventType: 'linkUp', severity: 'medium', description: 'Network interface link up' },
  { oid: '1.3.6.1.6.3.1.1.5.5', eventType: 'authenticationFailure', severity: 'high', description: 'SNMP authentication failure' },
];

// ─── Types ───

export interface SnmpTrapReceiverConfig {
  port: number;
  enabled: boolean;
  communityStrings: string[];
}

export interface TrapOidMapping {
  id: string;
  oid: string;
  eventType: string;
  severity: Priority;
  description: string | null;
  isBuiltin: boolean;
}

export interface SnmpV3Credential {
  id: string;
  name: string;
  username: string;
  securityLevel: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  authProtocol: string | null;
  authKeyEncrypted: string | null;
  privProtocol: string | null;
  privKeyEncrypted: string | null;
}

export interface VariableBinding {
  oid: string;
  type: string;
  value: unknown;
}

export interface ParsedTrap {
  version: 'v1' | 'v2c' | 'v3';
  community?: string;
  sourceIp: string;
  requestId: number;
  trapOid: string;
  sysUpTime: number;
  variableBindings: VariableBinding[];
  isInform: boolean;
  msgId?: number;
  securityModel?: number;
  securityName?: string;
  engineId?: string;
}

/** Decoded ASN.1/BER TLV */
export interface BerTlv {
  tag: number;
  length: number;
  value: Buffer;
  totalLength: number;
}

// ─── ASN.1/BER Decoder ───

export class BerDecoder {
  static decodeTlv(buf: Buffer, offset: number): BerTlv {
    if (offset >= buf.length) {
      throw new Error(`BER decode: offset ${offset} beyond buffer length ${buf.length}`);
    }
    const tag = buf[offset];
    let pos = offset + 1;
    if (pos >= buf.length) throw new Error('BER decode: unexpected end reading length');
    let length: number;
    const firstLenByte = buf[pos];
    pos++;
    if (firstLenByte < 0x80) {
      length = firstLenByte;
    } else if (firstLenByte === 0x80) {
      throw new Error('BER decode: indefinite length not supported');
    } else {
      const numLenBytes = firstLenByte & 0x7f;
      if (numLenBytes > 4) throw new Error(`BER decode: length field too large (${numLenBytes} bytes)`);
      if (pos + numLenBytes > buf.length) throw new Error('BER decode: unexpected end reading length bytes');
      length = 0;
      for (let i = 0; i < numLenBytes; i++) {
        length = (length << 8) | buf[pos + i];
      }
      pos += numLenBytes;
    }
    if (pos + length > buf.length) {
      throw new Error(`BER decode: value extends beyond buffer`);
    }
    const value = buf.subarray(pos, pos + length);
    return { tag, length, value, totalLength: pos - offset + length };
  }

  static decodeChildren(buf: Buffer): BerTlv[] {
    const children: BerTlv[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const tlv = BerDecoder.decodeTlv(buf, offset);
      children.push(tlv);
      offset += tlv.totalLength;
    }
    return children;
  }

  static decodeInteger(buf: Buffer): number {
    if (buf.length === 0) return 0;
    let val = buf[0] & 0x80 ? -1 : 0;
    for (let i = 0; i < buf.length; i++) {
      val = (val << 8) | buf[i];
    }
    return val;
  }

  static decodeOid(buf: Buffer): string {
    if (buf.length === 0) return '';
    const components: number[] = [];
    components.push(Math.floor(buf[0] / 40));
    components.push(buf[0] % 40);
    let current = 0;
    for (let i = 1; i < buf.length; i++) {
      current = (current << 7) | (buf[i] & 0x7f);
      if ((buf[i] & 0x80) === 0) {
        components.push(current);
        current = 0;
      }
    }
    return components.join('.');
  }

  static decodeOctetString(buf: Buffer): string {
    return buf.toString('utf-8');
  }

  static decodeTimeTicks(buf: Buffer): number {
    let val = 0;
    for (let i = 0; i < buf.length; i++) {
      val = (val * 256) + buf[i];
    }
    return val;
  }

  static decodeIpAddress(buf: Buffer): string {
    if (buf.length !== 4) return buf.toString('hex');
    return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
  }

  static decodeUnsigned32(buf: Buffer): number {
    let val = 0;
    for (let i = 0; i < buf.length; i++) {
      val = (val * 256) + buf[i];
    }
    return val;
  }

  static decodeVarbindValue(tag: number, buf: Buffer): { type: string; value: unknown } {
    switch (tag) {
      case BER_TAG.INTEGER:
        return { type: 'INTEGER', value: BerDecoder.decodeInteger(buf) };
      case BER_TAG.OCTET_STRING:
        return { type: 'OCTET_STRING', value: BerDecoder.decodeOctetString(buf) };
      case BER_TAG.OID:
        return { type: 'OID', value: BerDecoder.decodeOid(buf) };
      case BER_TAG.NULL:
        return { type: 'NULL', value: null };
      case BER_TAG.IP_ADDRESS:
        return { type: 'IpAddress', value: BerDecoder.decodeIpAddress(buf) };
      case BER_TAG.COUNTER32:
        return { type: 'Counter32', value: BerDecoder.decodeUnsigned32(buf) };
      case BER_TAG.GAUGE32:
        return { type: 'Gauge32', value: BerDecoder.decodeUnsigned32(buf) };
      case BER_TAG.TIMETICKS:
        return { type: 'TimeTicks', value: BerDecoder.decodeTimeTicks(buf) };
      case BER_TAG.COUNTER64: {
        let val = 0n;
        for (let i = 0; i < buf.length; i++) val = (val << 8n) | BigInt(buf[i]);
        return { type: 'Counter64', value: Number(val) };
      }
      case BER_TAG.OPAQUE:
        return { type: 'Opaque', value: buf.toString('hex') };
      case BER_TAG.NO_SUCH_OBJECT:
        return { type: 'noSuchObject', value: null };
      case BER_TAG.NO_SUCH_INSTANCE:
        return { type: 'noSuchInstance', value: null };
      case BER_TAG.END_OF_MIB_VIEW:
        return { type: 'endOfMibView', value: null };
      default:
        return { type: `unknown(0x${tag.toString(16)})`, value: buf.toString('hex') };
    }
  }

  // ─── Encoding helpers (for Inform responses) ───

  static encodeLength(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    const bytes: number[] = [];
    let l = length;
    while (l > 0) { bytes.unshift(l & 0xff); l >>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  }

  static encodeTlv(tag: number, value: Buffer): Buffer {
    const lenBuf = BerDecoder.encodeLength(value.length);
    return Buffer.concat([Buffer.from([tag]), lenBuf, value]);
  }

  static encodeInteger(val: number): Buffer {
    const bytes: number[] = [];
    if (val === 0) {
      bytes.push(0);
    } else {
      let v = val;
      while (v !== 0 && v !== -1) { bytes.unshift(v & 0xff); v >>= 8; }
      if (val > 0 && (bytes[0] & 0x80) !== 0) bytes.unshift(0);
      else if (val < 0 && (bytes[0] & 0x80) === 0) bytes.unshift(0xff);
    }
    return BerDecoder.encodeTlv(BER_TAG.INTEGER, Buffer.from(bytes));
  }

  static encodeInformResponse(version: number, community: string, requestId: number, varbinds: Buffer): Buffer {
    const reqIdBuf = BerDecoder.encodeInteger(requestId);
    const errorStatusBuf = BerDecoder.encodeInteger(0);
    const errorIndexBuf = BerDecoder.encodeInteger(0);
    const pduContent = Buffer.concat([reqIdBuf, errorStatusBuf, errorIndexBuf, varbinds]);
    const pduBuf = BerDecoder.encodeTlv(BER_TAG.GET_RESPONSE, pduContent);
    const communityBuf = BerDecoder.encodeTlv(BER_TAG.OCTET_STRING, Buffer.from(community, 'utf-8'));
    const versionBuf = BerDecoder.encodeInteger(version);
    const msgContent = Buffer.concat([versionBuf, communityBuf, pduBuf]);
    return BerDecoder.encodeTlv(BER_TAG.SEQUENCE, msgContent);
  }
}

// ─── SNMP Message Parser ───

export function parseSnmpMessage(buf: Buffer, sourceIp: string): ParsedTrap | null {
  try {
    const outer = BerDecoder.decodeTlv(buf, 0);
    if (outer.tag !== BER_TAG.SEQUENCE) return null;
    const children = BerDecoder.decodeChildren(outer.value);
    if (children.length < 3) return null;
    const versionNum = BerDecoder.decodeInteger(children[0].value);
    if (versionNum === 1) return parseV2cMessage(children, sourceIp);
    if (versionNum === 3) return parseV3Message(children, sourceIp);
    return null;
  } catch (err) {
    logger.debug(`[SnmpTrapReceiver] Failed to parse SNMP message: ${(err as Error).message}`);
    return null;
  }
}

function parseV2cMessage(children: BerTlv[], sourceIp: string): ParsedTrap | null {
  if (children.length < 3) return null;
  const community = BerDecoder.decodeOctetString(children[1].value);
  const pduTag = children[2].tag;
  const isInform = pduTag === BER_TAG.INFORM_REQUEST;
  const isTrap = pduTag === BER_TAG.TRAP_V2;
  if (!isInform && !isTrap) return null;

  const pduChildren = BerDecoder.decodeChildren(children[2].value);
  if (pduChildren.length < 4) return null;
  const requestId = BerDecoder.decodeInteger(pduChildren[0].value);

  const varbindList = BerDecoder.decodeChildren(pduChildren[3].value);
  const variableBindings: VariableBinding[] = [];
  let trapOid = '';
  let sysUpTime = 0;

  for (const vb of varbindList) {
    const vbChildren = BerDecoder.decodeChildren(vb.value);
    if (vbChildren.length < 2) continue;
    const oid = BerDecoder.decodeOid(vbChildren[0].value);
    const { type, value } = BerDecoder.decodeVarbindValue(vbChildren[1].tag, vbChildren[1].value);
    if (oid === '1.3.6.1.2.1.1.3.0') sysUpTime = typeof value === 'number' ? value : 0;
    else if (oid === '1.3.6.1.6.3.1.1.4.1.0') trapOid = typeof value === 'string' ? value : String(value);
    variableBindings.push({ oid, type, value });
  }

  return { version: 'v2c', community, sourceIp, requestId, trapOid, sysUpTime, variableBindings, isInform };
}

function parseV3Message(children: BerTlv[], sourceIp: string): ParsedTrap | null {
  if (children.length < 3) return null;
  const globalData = BerDecoder.decodeChildren(children[1].value);
  if (globalData.length < 4) return null;
  const msgId = BerDecoder.decodeInteger(globalData[0].value);
  const securityModel = BerDecoder.decodeInteger(globalData[3].value);

  let securityName = '';
  let engineId = '';
  try {
    const secParamsOuter = children[2];
    const secSeq = BerDecoder.decodeTlv(secParamsOuter.value, 0);
    const secFields = BerDecoder.decodeChildren(secSeq.value);
    if (secFields.length >= 2) engineId = secFields[0].value.toString('hex');
    if (secFields.length >= 4) securityName = BerDecoder.decodeOctetString(secFields[3].value);
  } catch { /* security params parsing failed */ }

  if (children.length < 4) return null;

  let trapOid = '';
  let sysUpTime = 0;
  let requestId = 0;
  let isInform = false;
  const variableBindings: VariableBinding[] = [];

  try {
    const msgData = children[3];
    const scopedPdu = BerDecoder.decodeChildren(msgData.value);
    if (scopedPdu.length >= 3) {
      const pduTag = scopedPdu[2].tag;
      isInform = pduTag === BER_TAG.INFORM_REQUEST;
      if (pduTag === BER_TAG.TRAP_V2 || pduTag === BER_TAG.INFORM_REQUEST) {
        const pduChildren = BerDecoder.decodeChildren(scopedPdu[2].value);
        if (pduChildren.length >= 4) {
          requestId = BerDecoder.decodeInteger(pduChildren[0].value);
          const varbindList = BerDecoder.decodeChildren(pduChildren[3].value);
          for (const vb of varbindList) {
            const vbChildren = BerDecoder.decodeChildren(vb.value);
            if (vbChildren.length < 2) continue;
            const oid = BerDecoder.decodeOid(vbChildren[0].value);
            const { type, value } = BerDecoder.decodeVarbindValue(vbChildren[1].tag, vbChildren[1].value);
            if (oid === '1.3.6.1.2.1.1.3.0') sysUpTime = typeof value === 'number' ? value : 0;
            else if (oid === '1.3.6.1.6.3.1.1.4.1.0') trapOid = typeof value === 'string' ? value : String(value);
            variableBindings.push({ oid, type, value });
          }
        }
      }
    }
  } catch {
    logger.debug('[SnmpTrapReceiver] Could not parse v3 PDU data (possibly encrypted)');
  }

  return {
    version: 'v3', sourceIp, requestId, trapOid, sysUpTime,
    variableBindings, isInform, msgId, securityModel, securityName, engineId,
  };
}

// ─── SnmpTrapReceiver ───

export class SnmpTrapReceiver {
  private udpServer: dgram.Socket | null = null;
  private running = false;
  private oidMappings: TrapOidMapping[] = [];
  private v3Credentials: SnmpV3Credential[] = [];
  private trapStats: Map<string, { trapCount: number; lastSeenAt: number }> = new Map();

  private config: SnmpTrapReceiverConfig = {
    port: 162,
    enabled: true,
    communityStrings: ['public'],
  };

  constructor(
    private readonly dataStore: DataStore,
    private readonly eventBus: EventBus,
  ) {}

  // ─── Lifecycle ───

  async start(config?: Partial<SnmpTrapReceiverConfig>): Promise<void> {
    if (this.running) { logger.warn('[SnmpTrapReceiver] Already running'); return; }
    if (config) this.config = { ...this.config, ...config };
    if (!this.config.enabled) { logger.info('[SnmpTrapReceiver] Disabled by config'); return; }

    await this.loadOidMappings();
    await this.loadV3Credentials();

    this.eventBus.registerSource({
      name: 'snmp-trap-receiver',
      eventTypes: ['snmp_trap'],
      schemaVersion: '1.0.0',
    });

    await this.startUdp();
    this.running = true;
    logger.info(`[SnmpTrapReceiver] Started — UDP :${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    if (this.udpServer) { try { this.udpServer.close(); } catch { /* ignore */ } this.udpServer = null; }
    this.running = false;
    logger.info('[SnmpTrapReceiver] Stopped');
  }

  isRunning(): boolean { return this.running; }

  private startUdp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpServer = dgram.createSocket('udp4');
      this.udpServer.on('message', (msg, rinfo) => {
        this.handleRawTrap(msg, rinfo.address, rinfo.port).catch((err) => {
          logger.error('[SnmpTrapReceiver] Trap handling error:', err);
        });
      });
      this.udpServer.on('error', (err) => { logger.error('[SnmpTrapReceiver] UDP error:', err); });
      this.udpServer.bind(this.config.port, () => {
        logger.info(`[SnmpTrapReceiver] UDP listening on :${this.config.port}`);
        resolve();
      });
      this.udpServer.once('error', reject);
    });
  }

  // ─── Core trap pipeline ───

  async handleRawTrap(raw: Buffer, sourceIp: string, sourcePort: number): Promise<void> {
    const parsed = parseSnmpMessage(raw, sourceIp);
    if (!parsed) {
      logger.debug(`[SnmpTrapReceiver] Failed to parse trap from ${sourceIp}:${sourcePort}`);
      return;
    }
    if (!this.authenticate(parsed)) {
      logger.warn(`[SnmpTrapReceiver] Auth failed for ${parsed.version} trap from ${sourceIp}`);
      return;
    }
    this.updateTrapStats(sourceIp);
    const event = this.toPerceptionEvent(parsed);
    await this.eventBus.publish(event);
    if (parsed.isInform) this.sendInformResponse(parsed, sourceIp, sourcePort, raw);
  }

  // ─── Authentication ───

  authenticate(parsed: ParsedTrap): boolean {
    if (parsed.version === 'v2c') return this.authenticateV2c(parsed);
    if (parsed.version === 'v3') return this.authenticateV3(parsed);
    return false;
  }

  private authenticateV2c(parsed: ParsedTrap): boolean {
    if (!parsed.community) return false;
    return this.config.communityStrings.includes(parsed.community);
  }

  private authenticateV3(parsed: ParsedTrap): boolean {
    if (!parsed.securityName) return false;
    return this.v3Credentials.some((cred) => cred.username === parsed.securityName);
  }

  // ─── OID Mapping (D3.17) ───

  mapOid(oid: string): { eventType: string; severity: Priority } {
    const custom = this.oidMappings.find((m) => m.oid === oid && !m.isBuiltin);
    if (custom) return { eventType: custom.eventType, severity: custom.severity };
    const builtin = this.oidMappings.find((m) => m.oid === oid && m.isBuiltin);
    if (builtin) return { eventType: builtin.eventType, severity: builtin.severity };
    return { eventType: 'unknown', severity: 'medium' };
  }

  // ─── Conversion (D3.18) ───

  private toPerceptionEvent(parsed: ParsedTrap): Omit<PerceptionEvent, 'id' | 'timestamp'> {
    const { eventType, severity } = this.mapOid(parsed.trapOid);
    return {
      type: 'snmp_trap',
      priority: severity,
      source: `snmp-trap:${parsed.sourceIp}`,
      payload: {
        trapOid: parsed.trapOid,
        eventType,
        version: parsed.version,
        sysUpTime: parsed.sysUpTime,
        variableBindings: parsed.variableBindings,
        sourceIp: parsed.sourceIp,
        isInform: parsed.isInform,
        community: parsed.version === 'v2c' ? parsed.community : undefined,
        securityName: parsed.version === 'v3' ? parsed.securityName : undefined,
      },
      schemaVersion: '1.0.0',
    };
  }

  // ─── Inform Response (D3.19) ───

  private sendInformResponse(parsed: ParsedTrap, sourceIp: string, sourcePort: number, rawMessage: Buffer): void {
    if (!this.udpServer) return;
    try {
      if (parsed.version === 'v2c') {
        const varbindsBuf = this.extractVarbindsBuffer(rawMessage);
        const responseBuf = BerDecoder.encodeInformResponse(
          1, parsed.community ?? 'public', parsed.requestId, varbindsBuf,
        );
        this.udpServer.send(responseBuf, sourcePort, sourceIp, (err) => {
          if (err) logger.error(`[SnmpTrapReceiver] Failed to send Inform response to ${sourceIp}:${sourcePort}:`, err);
          else logger.debug(`[SnmpTrapReceiver] Sent Inform response to ${sourceIp}:${sourcePort}`);
        });
      } else if (parsed.version === 'v3') {
        logger.debug(`[SnmpTrapReceiver] v3 Inform response not fully implemented for ${sourceIp}:${sourcePort}`);
      }
    } catch (err) {
      logger.error('[SnmpTrapReceiver] Error building Inform response:', err);
    }
  }

  private extractVarbindsBuffer(rawMessage: Buffer): Buffer {
    try {
      const outer = BerDecoder.decodeTlv(rawMessage, 0);
      const children = BerDecoder.decodeChildren(outer.value);
      if (children.length < 3) return BerDecoder.encodeTlv(BER_TAG.SEQUENCE, Buffer.alloc(0));
      const pduChildren = BerDecoder.decodeChildren(children[2].value);
      if (pduChildren.length >= 4) return BerDecoder.encodeTlv(BER_TAG.SEQUENCE, pduChildren[3].value);
    } catch { /* fall through */ }
    return BerDecoder.encodeTlv(BER_TAG.SEQUENCE, Buffer.alloc(0));
  }

  // ─── Trap Stats ───

  private updateTrapStats(sourceIp: string): void {
    const now = Date.now();
    const stats = this.trapStats.get(sourceIp);
    if (stats) { stats.trapCount++; stats.lastSeenAt = now; }
    else this.trapStats.set(sourceIp, { trapCount: 1, lastSeenAt: now });
  }

  getTrapStats(): Map<string, { trapCount: number; lastSeenAt: number }> {
    return new Map(this.trapStats);
  }

  // ─── PostgreSQL Persistence (D3.20) ───

  async loadOidMappings(): Promise<void> {
    try {
      for (const builtin of BUILTIN_OID_MAPPINGS) {
        const existing = await this.dataStore.queryOne<{ id: string }>(
          `SELECT id FROM snmp_trap_oid_mappings WHERE oid = $1`, [builtin.oid],
        );
        if (!existing) {
          await this.dataStore.execute(
            `INSERT INTO snmp_trap_oid_mappings (oid, event_type, severity, description, is_builtin) VALUES ($1, $2, $3, $4, true)`,
            [builtin.oid, builtin.eventType, builtin.severity, builtin.description],
          );
        }
      }
      const rows = await this.dataStore.query<{
        id: string; oid: string; event_type: string; severity: string;
        description: string | null; is_builtin: boolean;
      }>(`SELECT id, oid, event_type, severity, description, is_builtin FROM snmp_trap_oid_mappings ORDER BY is_builtin ASC, oid ASC`);
      this.oidMappings = rows.map((r) => ({
        id: r.id, oid: r.oid, eventType: r.event_type, severity: r.severity as Priority,
        description: r.description, isBuiltin: r.is_builtin,
      }));
      logger.info(`[SnmpTrapReceiver] Loaded ${this.oidMappings.length} OID mappings`);
    } catch (err) {
      logger.error('[SnmpTrapReceiver] Failed to load OID mappings:', err);
      this.oidMappings = BUILTIN_OID_MAPPINGS.map((b) => ({
        id: uuidv4(), oid: b.oid, eventType: b.eventType, severity: b.severity,
        description: b.description, isBuiltin: true,
      }));
    }
  }

  async loadV3Credentials(): Promise<void> {
    try {
      const rows = await this.dataStore.query<{
        id: string; name: string; username: string; security_level: string;
        auth_protocol: string | null; auth_key_encrypted: string | null;
        priv_protocol: string | null; priv_key_encrypted: string | null;
      }>(`SELECT id, name, username, security_level, auth_protocol, auth_key_encrypted, priv_protocol, priv_key_encrypted FROM snmp_v3_credentials`);
      this.v3Credentials = rows.map((r) => ({
        id: r.id, name: r.name, username: r.username,
        securityLevel: r.security_level as SnmpV3Credential['securityLevel'],
        authProtocol: r.auth_protocol, authKeyEncrypted: r.auth_key_encrypted,
        privProtocol: r.priv_protocol, privKeyEncrypted: r.priv_key_encrypted,
      }));
      logger.info(`[SnmpTrapReceiver] Loaded ${this.v3Credentials.length} v3 credentials`);
    } catch (err) {
      logger.error('[SnmpTrapReceiver] Failed to load v3 credentials:', err);
      this.v3Credentials = [];
    }
  }

  // ─── CRUD: OID Mappings ───

  async addOidMapping(mapping: Omit<TrapOidMapping, 'id'>): Promise<TrapOidMapping> {
    const id = uuidv4();
    await this.dataStore.execute(
      `INSERT INTO snmp_trap_oid_mappings (id, oid, event_type, severity, description, is_builtin) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, mapping.oid, mapping.eventType, mapping.severity, mapping.description, mapping.isBuiltin],
    );
    const newMapping: TrapOidMapping = { ...mapping, id };
    this.oidMappings.push(newMapping);
    return newMapping;
  }

  async updateOidMapping(id: string, updates: Partial<Pick<TrapOidMapping, 'eventType' | 'severity' | 'description'>>): Promise<boolean> {
    const existing = this.oidMappings.find((m) => m.id === id);
    if (!existing) return false;
    const newEventType = updates.eventType ?? existing.eventType;
    const newSeverity = updates.severity ?? existing.severity;
    const newDescription = updates.description !== undefined ? updates.description : existing.description;
    const { rowCount } = await this.dataStore.execute(
      `UPDATE snmp_trap_oid_mappings SET event_type = $1, severity = $2, description = $3, updated_at = NOW() WHERE id = $4`,
      [newEventType, newSeverity, newDescription, id],
    );
    if (rowCount > 0) {
      existing.eventType = newEventType;
      existing.severity = newSeverity;
      existing.description = newDescription;
      return true;
    }
    return false;
  }

  async removeOidMapping(id: string): Promise<boolean> {
    const mapping = this.oidMappings.find((m) => m.id === id);
    if (mapping?.isBuiltin) {
      logger.warn(`[SnmpTrapReceiver] Cannot remove built-in OID mapping: ${mapping.oid}`);
      return false;
    }
    const { rowCount } = await this.dataStore.execute(
      `DELETE FROM snmp_trap_oid_mappings WHERE id = $1 AND is_builtin = false`, [id],
    );
    if (rowCount > 0) { this.oidMappings = this.oidMappings.filter((m) => m.id !== id); return true; }
    return false;
  }

  // ─── CRUD: V3 Credentials ───

  async addV3Credential(credential: Omit<SnmpV3Credential, 'id'>): Promise<SnmpV3Credential> {
    const id = uuidv4();
    await this.dataStore.execute(
      `INSERT INTO snmp_v3_credentials (id, name, username, security_level, auth_protocol, auth_key_encrypted, priv_protocol, priv_key_encrypted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, credential.name, credential.username, credential.securityLevel, credential.authProtocol, credential.authKeyEncrypted, credential.privProtocol, credential.privKeyEncrypted],
    );
    const newCred: SnmpV3Credential = { ...credential, id };
    this.v3Credentials.push(newCred);
    return newCred;
  }

  async updateV3Credential(id: string, updates: Partial<Omit<SnmpV3Credential, 'id'>>): Promise<boolean> {
    const existing = this.v3Credentials.find((c) => c.id === id);
    if (!existing) return false;
    const updated = { ...existing, ...updates };
    const { rowCount } = await this.dataStore.execute(
      `UPDATE snmp_v3_credentials SET name = $1, username = $2, security_level = $3, auth_protocol = $4, auth_key_encrypted = $5, priv_protocol = $6, priv_key_encrypted = $7, updated_at = NOW() WHERE id = $8`,
      [updated.name, updated.username, updated.securityLevel, updated.authProtocol, updated.authKeyEncrypted, updated.privProtocol, updated.privKeyEncrypted, id],
    );
    if (rowCount > 0) { Object.assign(existing, updates); return true; }
    return false;
  }

  async removeV3Credential(id: string): Promise<boolean> {
    const { rowCount } = await this.dataStore.execute(`DELETE FROM snmp_v3_credentials WHERE id = $1`, [id]);
    if (rowCount > 0) { this.v3Credentials = this.v3Credentials.filter((c) => c.id !== id); return true; }
    return false;
  }

  // ─── Reload & Accessors ───

  async reloadConfig(): Promise<void> {
    await this.loadOidMappings();
    await this.loadV3Credentials();
  }

  getOidMappings(): TrapOidMapping[] { return [...this.oidMappings]; }
  getV3Credentials(): SnmpV3Credential[] { return [...this.v3Credentials]; }
  getConfig(): SnmpTrapReceiverConfig { return { ...this.config }; }
}
