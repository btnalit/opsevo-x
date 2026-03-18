/**
 * SnmpTrapReceiver 单元测试
 *
 * Tests: BER encoding/decoding, SNMP message parsing, OID mapping,
 * v2c/v3 authentication, Trap→PerceptionEvent conversion, Inform response,
 * CRUD operations, and EventBus integration.
 */

import {
  SnmpTrapReceiver,
  BerDecoder,
  BER_TAG,
  parseSnmpMessage,
  type ParsedTrap,
  type TrapOidMapping,
  type SnmpV3Credential,
} from './snmpTrapReceiver';
import { EventBus, type PerceptionEvent } from '../eventBus';
import type { DataStore, DataStoreTransaction } from '../dataStore';
import type { Pool } from 'pg';

// ─── Mock DataStore ───

function createMockDataStore(): DataStore {
  return {
    query: jest.fn().mockResolvedValue([]),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
    transaction: jest.fn(async <T>(fn: (tx: DataStoreTransaction) => Promise<T>): Promise<T> => {
      const tx: DataStoreTransaction = {
        query: jest.fn().mockResolvedValue([]),
        queryOne: jest.fn().mockResolvedValue(null),
        execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
      };
      return fn(tx);
    }),
    getPool: jest.fn().mockReturnValue({} as Pool),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── SNMP Trap Buffer Builders ───

/** Encode an OID string into BER OID bytes */
function encodeOidValue(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2) return Buffer.alloc(0);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    const val = parts[i];
    if (val < 128) {
      bytes.push(val);
    } else {
      const encoded: number[] = [];
      let v = val;
      encoded.unshift(v & 0x7f);
      v >>= 7;
      while (v > 0) { encoded.unshift((v & 0x7f) | 0x80); v >>= 7; }
      bytes.push(...encoded);
    }
  }
  return Buffer.from(bytes);
}

function berTlv(tag: number, value: Buffer): Buffer {
  return BerDecoder.encodeTlv(tag, value);
}

function berInteger(val: number): Buffer {
  return BerDecoder.encodeInteger(val);
}

function berOctetString(str: string): Buffer {
  return berTlv(BER_TAG.OCTET_STRING, Buffer.from(str, 'utf-8'));
}

function berOid(oid: string): Buffer {
  return berTlv(BER_TAG.OID, encodeOidValue(oid));
}

function berNull(): Buffer {
  return berTlv(BER_TAG.NULL, Buffer.alloc(0));
}

function berSequence(...items: Buffer[]): Buffer {
  return berTlv(BER_TAG.SEQUENCE, Buffer.concat(items));
}

function berTimeTicks(val: number): Buffer {
  const bytes: number[] = [];
  let v = val;
  if (v === 0) { bytes.push(0); }
  else { while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; } }
  return berTlv(BER_TAG.TIMETICKS, Buffer.from(bytes));
}

/** Build a varbind: SEQUENCE { OID, value } */
function varbind(oid: string, valueTlv: Buffer): Buffer {
  return berSequence(berOid(oid), valueTlv);
}

/** Build a complete SNMPv2c Trap message */
function buildV2cTrapMessage(
  community: string,
  trapOid: string,
  sysUpTime: number = 12345,
  extraVarbinds: Buffer[] = [],
): Buffer {
  const varbinds = berSequence(
    varbind('1.3.6.1.2.1.1.3.0', berTimeTicks(sysUpTime)),
    varbind('1.3.6.1.6.3.1.1.4.1.0', berOid(trapOid)),
    ...extraVarbinds,
  );
  const pdu = berTlv(BER_TAG.TRAP_V2, Buffer.concat([
    berInteger(42),  // request-id
    berInteger(0),   // error-status
    berInteger(0),   // error-index
    varbinds,
  ]));
  return berSequence(berInteger(1), berOctetString(community), pdu);
}

/** Build a complete SNMPv2c Inform message */
function buildV2cInformMessage(
  community: string,
  trapOid: string,
  requestId: number = 99,
): Buffer {
  const varbinds = berSequence(
    varbind('1.3.6.1.2.1.1.3.0', berTimeTicks(5000)),
    varbind('1.3.6.1.6.3.1.1.4.1.0', berOid(trapOid)),
  );
  const pdu = berTlv(BER_TAG.INFORM_REQUEST, Buffer.concat([
    berInteger(requestId),
    berInteger(0),
    berInteger(0),
    varbinds,
  ]));
  return berSequence(berInteger(1), berOctetString(community), pdu);
}

/** Build a simplified SNMPv3 Trap message */
function buildV3TrapMessage(securityName: string, trapOid: string): Buffer {
  // msgGlobalData: SEQUENCE { msgID, msgMaxSize, msgFlags, msgSecurityModel }
  const globalData = berSequence(
    berInteger(1001),       // msgID
    berInteger(65535),      // msgMaxSize
    berOctetString('\x04'), // msgFlags (reportable)
    berInteger(3),          // msgSecurityModel = USM
  );

  // msgSecurityParameters: OCTET STRING wrapping SEQUENCE
  const secParams = berSequence(
    berOctetString('engine123'),  // authoritative engine ID
    berInteger(0),                // engine boots
    berInteger(0),                // engine time
    berOctetString(securityName), // user name
    berOctetString(''),           // auth params
    berOctetString(''),           // priv params
  );
  const secParamsWrapped = berTlv(BER_TAG.OCTET_STRING, secParams);

  // ScopedPDU: SEQUENCE { contextEngineID, contextName, PDU }
  const varbinds = berSequence(
    varbind('1.3.6.1.2.1.1.3.0', berTimeTicks(9999)),
    varbind('1.3.6.1.6.3.1.1.4.1.0', berOid(trapOid)),
  );
  const pdu = berTlv(BER_TAG.TRAP_V2, Buffer.concat([
    berInteger(77),  // request-id
    berInteger(0),
    berInteger(0),
    varbinds,
  ]));
  const scopedPdu = berSequence(
    berOctetString('engine123'),
    berOctetString(''),
    pdu,
  );

  return berSequence(berInteger(3), globalData, secParamsWrapped, scopedPdu);
}

// ─── Tests ───

describe('SnmpTrapReceiver', () => {
  let receiver: SnmpTrapReceiver;
  let eventBus: EventBus;
  let dataStore: DataStore;

  beforeEach(() => {
    eventBus = new EventBus();
    dataStore = createMockDataStore();
    receiver = new SnmpTrapReceiver(dataStore, eventBus);
  });

  afterEach(async () => {
    await receiver.stop();
    eventBus.reset();
  });

  // ─── BER Decoder ───

  describe('BerDecoder', () => {
    it('should decode an INTEGER', () => {
      const buf = Buffer.from([0x00, 0x2a]); // 42
      expect(BerDecoder.decodeInteger(buf)).toBe(42);
    });

    it('should decode a negative INTEGER', () => {
      const buf = Buffer.from([0xff]); // -1
      expect(BerDecoder.decodeInteger(buf)).toBe(-1);
    });

    it('should decode zero INTEGER', () => {
      expect(BerDecoder.decodeInteger(Buffer.from([0x00]))).toBe(0);
      expect(BerDecoder.decodeInteger(Buffer.alloc(0))).toBe(0);
    });

    it('should decode an OID', () => {
      // 1.3.6.1.2.1.1.3.0
      const buf = Buffer.from([0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x03, 0x00]);
      expect(BerDecoder.decodeOid(buf)).toBe('1.3.6.1.2.1.1.3.0');
    });

    it('should decode an OID with large sub-identifiers', () => {
      // 1.3.6.1.6.3.1.1.5.1 (coldStart)
      const oidBuf = encodeOidValue('1.3.6.1.6.3.1.1.5.1');
      expect(BerDecoder.decodeOid(oidBuf)).toBe('1.3.6.1.6.3.1.1.5.1');
    });

    it('should decode an OCTET STRING', () => {
      const buf = Buffer.from('public', 'utf-8');
      expect(BerDecoder.decodeOctetString(buf)).toBe('public');
    });

    it('should decode TimeTicks', () => {
      const buf = Buffer.from([0x00, 0x30, 0x39]); // 12345
      expect(BerDecoder.decodeTimeTicks(buf)).toBe(12345);
    });

    it('should decode IP address', () => {
      const buf = Buffer.from([192, 168, 1, 1]);
      expect(BerDecoder.decodeIpAddress(buf)).toBe('192.168.1.1');
    });

    it('should decode a TLV', () => {
      const encoded = berInteger(42);
      const tlv = BerDecoder.decodeTlv(encoded, 0);
      expect(tlv.tag).toBe(BER_TAG.INTEGER);
      expect(BerDecoder.decodeInteger(tlv.value)).toBe(42);
    });

    it('should decode children of a SEQUENCE', () => {
      const seq = berSequence(berInteger(1), berInteger(2), berInteger(3));
      const outer = BerDecoder.decodeTlv(seq, 0);
      const children = BerDecoder.decodeChildren(outer.value);
      expect(children).toHaveLength(3);
      expect(BerDecoder.decodeInteger(children[0].value)).toBe(1);
      expect(BerDecoder.decodeInteger(children[2].value)).toBe(3);
    });

    it('should decode varbind values for various types', () => {
      expect(BerDecoder.decodeVarbindValue(BER_TAG.NULL, Buffer.alloc(0))).toEqual({ type: 'NULL', value: null });
      expect(BerDecoder.decodeVarbindValue(BER_TAG.NO_SUCH_OBJECT, Buffer.alloc(0))).toEqual({ type: 'noSuchObject', value: null });
      expect(BerDecoder.decodeVarbindValue(BER_TAG.COUNTER32, Buffer.from([0x00, 0x01]))).toEqual({ type: 'Counter32', value: 1 });
      expect(BerDecoder.decodeVarbindValue(BER_TAG.GAUGE32, Buffer.from([0x64]))).toEqual({ type: 'Gauge32', value: 100 });
    });

    it('should throw on invalid BER data', () => {
      expect(() => BerDecoder.decodeTlv(Buffer.alloc(0), 0)).toThrow();
      expect(() => BerDecoder.decodeTlv(Buffer.from([0x02]), 0)).toThrow();
    });

    it('should encode and decode an Inform response', () => {
      const varbinds = berSequence(varbind('1.3.6.1.2.1.1.3.0', berTimeTicks(100)));
      const response = BerDecoder.encodeInformResponse(1, 'public', 42, varbinds);
      const outer = BerDecoder.decodeTlv(response, 0);
      expect(outer.tag).toBe(BER_TAG.SEQUENCE);
      const children = BerDecoder.decodeChildren(outer.value);
      expect(children).toHaveLength(3);
      // Version
      expect(BerDecoder.decodeInteger(children[0].value)).toBe(1);
      // Community
      expect(BerDecoder.decodeOctetString(children[1].value)).toBe('public');
      // GetResponse PDU
      expect(children[2].tag).toBe(BER_TAG.GET_RESPONSE);
    });

    it('should handle long-form BER lengths', () => {
      // Create a value > 127 bytes to trigger long-form length encoding
      const bigValue = Buffer.alloc(200, 0x41);
      const encoded = BerDecoder.encodeTlv(BER_TAG.OCTET_STRING, bigValue);
      const decoded = BerDecoder.decodeTlv(encoded, 0);
      expect(decoded.tag).toBe(BER_TAG.OCTET_STRING);
      expect(decoded.value.length).toBe(200);
    });
  });

  // ─── SNMP Message Parsing ───

  describe('parseSnmpMessage', () => {
    it('should parse a v2c trap message', () => {
      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.3', 12345);
      const parsed = parseSnmpMessage(buf, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe('v2c');
      expect(parsed!.community).toBe('public');
      expect(parsed!.sourceIp).toBe('10.0.0.1');
      expect(parsed!.trapOid).toBe('1.3.6.1.6.3.1.1.5.3');
      expect(parsed!.sysUpTime).toBe(12345);
      expect(parsed!.isInform).toBe(false);
      expect(parsed!.variableBindings.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse a v2c inform message', () => {
      const buf = buildV2cInformMessage('public', '1.3.6.1.6.3.1.1.5.1', 99);
      const parsed = parseSnmpMessage(buf, '10.0.0.2');

      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe('v2c');
      expect(parsed!.isInform).toBe(true);
      expect(parsed!.requestId).toBe(99);
      expect(parsed!.trapOid).toBe('1.3.6.1.6.3.1.1.5.1');
    });

    it('should parse a v3 trap message', () => {
      const buf = buildV3TrapMessage('snmpuser', '1.3.6.1.6.3.1.1.5.2');
      const parsed = parseSnmpMessage(buf, '10.0.0.3');

      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe('v3');
      expect(parsed!.securityName).toBe('snmpuser');
      expect(parsed!.trapOid).toBe('1.3.6.1.6.3.1.1.5.2');
      expect(parsed!.msgId).toBe(1001);
      expect(parsed!.securityModel).toBe(3);
    });

    it('should return null for invalid data', () => {
      expect(parseSnmpMessage(Buffer.from([0x00, 0x01]), '10.0.0.1')).toBeNull();
      expect(parseSnmpMessage(Buffer.alloc(0), '10.0.0.1')).toBeNull();
    });

    it('should return null for v1 traps (unsupported)', () => {
      // version = 0 (v1)
      const buf = berSequence(berInteger(0), berOctetString('public'), berTlv(BER_TAG.TRAP_V1, Buffer.alloc(10)));
      expect(parseSnmpMessage(buf, '10.0.0.1')).toBeNull();
    });

    it('should parse trap with extra variable bindings', () => {
      const extra = varbind('1.3.6.1.2.1.2.2.1.1.1', berInteger(1));
      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.3', 100, [extra]);
      const parsed = parseSnmpMessage(buf, '10.0.0.1');

      expect(parsed).not.toBeNull();
      expect(parsed!.variableBindings.length).toBe(3);
      const ifIndex = parsed!.variableBindings.find((vb) => vb.oid === '1.3.6.1.2.1.2.2.1.1.1');
      expect(ifIndex).toBeDefined();
      expect(ifIndex!.value).toBe(1);
    });
  });

  // ─── Authentication ───

  describe('authentication', () => {
    beforeEach(async () => {
      // Mock DB to return empty (no existing built-in mappings)
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
    });

    it('should accept v2c trap with valid community string', async () => {
      await receiver.start({ port: 0, communityStrings: ['public', 'private'] });
      const parsed: ParsedTrap = {
        version: 'v2c', community: 'public', sourceIp: '10.0.0.1',
        requestId: 1, trapOid: '1.3.6.1.6.3.1.1.5.1', sysUpTime: 0,
        variableBindings: [], isInform: false,
      };
      expect(receiver.authenticate(parsed)).toBe(true);
    });

    it('should reject v2c trap with invalid community string', async () => {
      await receiver.start({ port: 0, communityStrings: ['secret'] });
      const parsed: ParsedTrap = {
        version: 'v2c', community: 'public', sourceIp: '10.0.0.1',
        requestId: 1, trapOid: '1.3.6.1.6.3.1.1.5.1', sysUpTime: 0,
        variableBindings: [], isInform: false,
      };
      expect(receiver.authenticate(parsed)).toBe(false);
    });

    it('should reject v2c trap with empty community', async () => {
      await receiver.start({ port: 0 });
      const parsed: ParsedTrap = {
        version: 'v2c', community: undefined, sourceIp: '10.0.0.1',
        requestId: 1, trapOid: '', sysUpTime: 0,
        variableBindings: [], isInform: false,
      };
      expect(receiver.authenticate(parsed)).toBe(false);
    });

    it('should accept v3 trap with known security name', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      await receiver.start({ port: 0 });
      await receiver.addV3Credential({
        name: 'test-user', username: 'snmpuser', securityLevel: 'authNoPriv',
        authProtocol: 'SHA', authKeyEncrypted: 'key', privProtocol: null, privKeyEncrypted: null,
      });
      const parsed: ParsedTrap = {
        version: 'v3', sourceIp: '10.0.0.1', requestId: 1,
        trapOid: '1.3.6.1.6.3.1.1.5.1', sysUpTime: 0,
        variableBindings: [], isInform: false, securityName: 'snmpuser',
      };
      expect(receiver.authenticate(parsed)).toBe(true);
    });

    it('should reject v3 trap with unknown security name', async () => {
      await receiver.start({ port: 0 });
      const parsed: ParsedTrap = {
        version: 'v3', sourceIp: '10.0.0.1', requestId: 1,
        trapOid: '', sysUpTime: 0, variableBindings: [], isInform: false,
        securityName: 'unknown-user',
      };
      expect(receiver.authenticate(parsed)).toBe(false);
    });

    it('should reject unsupported version', () => {
      const parsed: ParsedTrap = {
        version: 'v1', sourceIp: '10.0.0.1', requestId: 1,
        trapOid: '', sysUpTime: 0, variableBindings: [], isInform: false,
      };
      expect(receiver.authenticate(parsed)).toBe(false);
    });
  });

  // ─── OID Mapping ───

  describe('OID mapping', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([
        { id: 'b1', oid: '1.3.6.1.6.3.1.1.5.1', event_type: 'coldStart', severity: 'medium', description: 'Device cold start (reboot)', is_builtin: true },
        { id: 'b2', oid: '1.3.6.1.6.3.1.1.5.2', event_type: 'warmStart', severity: 'low', description: 'Device warm start', is_builtin: true },
        { id: 'b3', oid: '1.3.6.1.6.3.1.1.5.3', event_type: 'linkDown', severity: 'high', description: 'Network interface link down', is_builtin: true },
        { id: 'b4', oid: '1.3.6.1.6.3.1.1.5.4', event_type: 'linkUp', severity: 'medium', description: 'Network interface link up', is_builtin: true },
        { id: 'b5', oid: '1.3.6.1.6.3.1.1.5.5', event_type: 'authenticationFailure', severity: 'high', description: 'SNMP authentication failure', is_builtin: true },
      ]);
      await receiver.start({ port: 0 });
    });

    it('should map built-in coldStart OID to medium priority', () => {
      const result = receiver.mapOid('1.3.6.1.6.3.1.1.5.1');
      expect(result.eventType).toBe('coldStart');
      expect(result.severity).toBe('medium');
    });

    it('should map built-in warmStart OID to low priority', () => {
      const result = receiver.mapOid('1.3.6.1.6.3.1.1.5.2');
      expect(result.eventType).toBe('warmStart');
      expect(result.severity).toBe('low');
    });

    it('should map built-in linkDown OID to high priority', () => {
      const result = receiver.mapOid('1.3.6.1.6.3.1.1.5.3');
      expect(result.eventType).toBe('linkDown');
      expect(result.severity).toBe('high');
    });

    it('should map built-in linkUp OID to medium priority', () => {
      const result = receiver.mapOid('1.3.6.1.6.3.1.1.5.4');
      expect(result.eventType).toBe('linkUp');
      expect(result.severity).toBe('medium');
    });

    it('should map built-in authenticationFailure OID to high priority', () => {
      const result = receiver.mapOid('1.3.6.1.6.3.1.1.5.5');
      expect(result.eventType).toBe('authenticationFailure');
      expect(result.severity).toBe('high');
    });

    it('should return unknown/medium for unmapped OIDs', () => {
      const result = receiver.mapOid('1.3.6.1.4.1.9999.1.2.3');
      expect(result.eventType).toBe('unknown');
      expect(result.severity).toBe('medium');
    });

    it('should prefer custom mapping over built-in for same OID', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      await receiver.addOidMapping({
        oid: '1.3.6.1.6.3.1.1.5.1', eventType: 'customColdStart', severity: 'critical',
        description: 'Custom override', isBuiltin: false,
      });
      const result = receiver.mapOid('1.3.6.1.6.3.1.1.5.1');
      expect(result.eventType).toBe('customColdStart');
      expect(result.severity).toBe('critical');
    });

    it('should map custom OIDs correctly', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      await receiver.addOidMapping({
        oid: '1.3.6.1.4.1.9999.1.0.1', eventType: 'vendorAlert', severity: 'high',
        description: 'Vendor specific alert', isBuiltin: false,
      });
      const result = receiver.mapOid('1.3.6.1.4.1.9999.1.0.1');
      expect(result.eventType).toBe('vendorAlert');
      expect(result.severity).toBe('high');
    });
  });

  // ─── PerceptionEvent Conversion ───

  describe('PerceptionEvent conversion', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([
        { id: 'b3', oid: '1.3.6.1.6.3.1.1.5.3', event_type: 'linkDown', severity: 'high', description: 'Link down', is_builtin: true },
      ]);
      await receiver.start({ port: 0, communityStrings: ['public'] });
    });

    it('should convert a linkDown trap to a PerceptionEvent with correct fields', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.3', 5000);
      await receiver.handleRawTrap(buf, '192.168.1.1', 50000);

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.type).toBe('snmp_trap');
      expect(event.priority).toBe('high');
      expect(event.source).toBe('snmp-trap:192.168.1.1');
      expect(event.payload.trapOid).toBe('1.3.6.1.6.3.1.1.5.3');
      expect(event.payload.eventType).toBe('linkDown');
      expect(event.payload.version).toBe('v2c');
      expect(event.payload.sysUpTime).toBe(5000);
      expect(event.payload.sourceIp).toBe('192.168.1.1');
      expect(event.payload.isInform).toBe(false);
      expect(event.schemaVersion).toBe('1.0.0');
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
    });

    it('should set priority to medium for unknown trap OIDs', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const buf = buildV2cTrapMessage('public', '1.3.6.1.4.1.9999.0.1', 100);
      await receiver.handleRawTrap(buf, '10.0.0.5', 50000);

      expect(events).toHaveLength(1);
      expect(events[0].priority).toBe('medium');
      expect(events[0].payload.eventType).toBe('unknown');
    });

    it('should include community string in v2c event payload', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.3', 100);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);

      expect(events[0].payload.community).toBe('public');
      expect(events[0].payload.securityName).toBeUndefined();
    });

    it('should include variable bindings in event payload', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const extra = varbind('1.3.6.1.2.1.2.2.1.1.1', berInteger(3));
      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.3', 100, [extra]);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);

      const vbs = events[0].payload.variableBindings as Array<{ oid: string; value: unknown }>;
      expect(vbs.length).toBeGreaterThanOrEqual(3);
      const ifIndex = vbs.find((vb) => vb.oid === '1.3.6.1.2.1.2.2.1.1.1');
      expect(ifIndex).toBeDefined();
      expect(ifIndex!.value).toBe(3);
    });
  });

  // ─── CRUD: OID Mappings ───

  describe('CRUD OID mappings', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
      await receiver.start({ port: 0 });
    });

    it('should add a custom OID mapping', async () => {
      const mapping = await receiver.addOidMapping({
        oid: '1.3.6.1.4.1.1234.1.0.1', eventType: 'customTrap', severity: 'high',
        description: 'Custom vendor trap', isBuiltin: false,
      });
      expect(mapping.id).toBeDefined();
      expect(mapping.oid).toBe('1.3.6.1.4.1.1234.1.0.1');
      expect(mapping.eventType).toBe('customTrap');

      const mappings = receiver.getOidMappings();
      expect(mappings.some((m) => m.oid === '1.3.6.1.4.1.1234.1.0.1')).toBe(true);
    });

    it('should update an existing OID mapping', async () => {
      const mapping = await receiver.addOidMapping({
        oid: '1.3.6.1.4.1.5555.1', eventType: 'original', severity: 'low',
        description: 'Original', isBuiltin: false,
      });
      const updated = await receiver.updateOidMapping(mapping.id, {
        eventType: 'updated', severity: 'critical', description: 'Updated desc',
      });
      expect(updated).toBe(true);

      const mappings = receiver.getOidMappings();
      const found = mappings.find((m) => m.id === mapping.id);
      expect(found?.eventType).toBe('updated');
      expect(found?.severity).toBe('critical');
      expect(found?.description).toBe('Updated desc');
    });

    it('should return false when updating non-existent mapping', async () => {
      const result = await receiver.updateOidMapping('non-existent-id', { eventType: 'test' });
      expect(result).toBe(false);
    });

    it('should remove a custom OID mapping', async () => {
      const mapping = await receiver.addOidMapping({
        oid: '1.3.6.1.4.1.7777.1', eventType: 'toRemove', severity: 'low',
        description: null, isBuiltin: false,
      });
      const removed = await receiver.removeOidMapping(mapping.id);
      expect(removed).toBe(true);

      const mappings = receiver.getOidMappings();
      expect(mappings.some((m) => m.id === mapping.id)).toBe(false);
    });

    it('should not remove built-in OID mappings', async () => {
      const mapping = await receiver.addOidMapping({
        oid: '1.3.6.1.6.3.1.1.5.99', eventType: 'builtinTest', severity: 'medium',
        description: 'Built-in test', isBuiltin: true,
      });
      const removed = await receiver.removeOidMapping(mapping.id);
      expect(removed).toBe(false);

      const mappings = receiver.getOidMappings();
      expect(mappings.some((m) => m.id === mapping.id)).toBe(true);
    });

    it('should return false when removing non-existent mapping', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 0 });
      const result = await receiver.removeOidMapping('non-existent-id');
      expect(result).toBe(false);
    });
  });

  // ─── CRUD: V3 Credentials ───

  describe('CRUD v3 credentials', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
      await receiver.start({ port: 0 });
    });

    it('should add a v3 credential', async () => {
      const cred = await receiver.addV3Credential({
        name: 'router-v3', username: 'admin', securityLevel: 'authPriv',
        authProtocol: 'SHA', authKeyEncrypted: 'enc-auth-key',
        privProtocol: 'AES', privKeyEncrypted: 'enc-priv-key',
      });
      expect(cred.id).toBeDefined();
      expect(cred.username).toBe('admin');
      expect(cred.securityLevel).toBe('authPriv');

      const creds = receiver.getV3Credentials();
      expect(creds.some((c) => c.username === 'admin')).toBe(true);
    });

    it('should update a v3 credential', async () => {
      const cred = await receiver.addV3Credential({
        name: 'test-cred', username: 'user1', securityLevel: 'authNoPriv',
        authProtocol: 'MD5', authKeyEncrypted: 'key1',
        privProtocol: null, privKeyEncrypted: null,
      });
      const updated = await receiver.updateV3Credential(cred.id, {
        username: 'user1-updated', authProtocol: 'SHA',
      });
      expect(updated).toBe(true);

      const creds = receiver.getV3Credentials();
      const found = creds.find((c) => c.id === cred.id);
      expect(found?.username).toBe('user1-updated');
      expect(found?.authProtocol).toBe('SHA');
    });

    it('should return false when updating non-existent credential', async () => {
      const result = await receiver.updateV3Credential('non-existent', { name: 'test' });
      expect(result).toBe(false);
    });

    it('should remove a v3 credential', async () => {
      const cred = await receiver.addV3Credential({
        name: 'to-remove', username: 'removeMe', securityLevel: 'noAuthNoPriv',
        authProtocol: null, authKeyEncrypted: null,
        privProtocol: null, privKeyEncrypted: null,
      });
      const removed = await receiver.removeV3Credential(cred.id);
      expect(removed).toBe(true);

      const creds = receiver.getV3Credentials();
      expect(creds.some((c) => c.id === cred.id)).toBe(false);
    });

    it('should return false when removing non-existent credential', async () => {
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 0 });
      const result = await receiver.removeV3Credential('non-existent');
      expect(result).toBe(false);
    });
  });

  // ─── EventBus Integration ───

  describe('EventBus integration', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([
        { id: 'b1', oid: '1.3.6.1.6.3.1.1.5.1', event_type: 'coldStart', severity: 'medium', description: 'Cold start', is_builtin: true },
      ]);
      await receiver.start({ port: 0, communityStrings: ['public'] });
    });

    it('should register as perception source with snmp_trap event type', () => {
      const sources = eventBus.getActiveSources();
      const snmpSource = sources.get('snmp-trap-receiver');
      expect(snmpSource).toBeDefined();
      expect(snmpSource!.eventTypes).toContain('snmp_trap');
      expect(snmpSource!.schemaVersion).toBe('1.0.0');
    });

    it('should publish events to EventBus on valid trap', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.1', 1000);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('snmp_trap');
    });

    it('should not publish events for unauthenticated traps', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const buf = buildV2cTrapMessage('wrong-community', '1.3.6.1.6.3.1.1.5.1', 1000);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);

      expect(events).toHaveLength(0);
    });

    it('should not publish events for unparseable messages', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      await receiver.handleRawTrap(Buffer.from([0x00, 0x01, 0x02]), '10.0.0.1', 50000);

      expect(events).toHaveLength(0);
    });

    it('should deliver events to multiple subscribers', async () => {
      const events1: PerceptionEvent[] = [];
      const events2: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'sub1', onEvent: async (e) => { events1.push(e); } });
      eventBus.subscribe('snmp_trap', { id: 'sub2', onEvent: async (e) => { events2.push(e); } });

      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.1', 100);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });
  });

  // ─── Inform Response ───

  describe('Inform response', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
      await receiver.start({ port: 0, communityStrings: ['public'] });
    });

    it('should publish event and flag isInform for Inform messages', async () => {
      const events: PerceptionEvent[] = [];
      eventBus.subscribe('snmp_trap', { id: 'test-sub', onEvent: async (e) => { events.push(e); } });

      const buf = buildV2cInformMessage('public', '1.3.6.1.6.3.1.1.5.1', 42);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);

      expect(events).toHaveLength(1);
      expect(events[0].payload.isInform).toBe(true);
      expect(events[0].payload.trapOid).toBe('1.3.6.1.6.3.1.1.5.1');
    });
  });

  // ─── Trap Stats ───

  describe('trap stats', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
      await receiver.start({ port: 0, communityStrings: ['public'] });
    });

    it('should track trap statistics per source IP', async () => {
      const buf = buildV2cTrapMessage('public', '1.3.6.1.6.3.1.1.5.3', 100);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);
      await receiver.handleRawTrap(buf, '10.0.0.1', 50000);
      await receiver.handleRawTrap(buf, '10.0.0.2', 50001);

      const stats = receiver.getTrapStats();
      expect(stats.get('10.0.0.1')?.trapCount).toBe(2);
      expect(stats.get('10.0.0.2')?.trapCount).toBe(1);
      expect(stats.get('10.0.0.1')?.lastSeenAt).toBeDefined();
    });

    it('should return empty stats initially', () => {
      const stats = receiver.getTrapStats();
      expect(stats.size).toBe(0);
    });
  });

  // ─── Lifecycle ───

  describe('lifecycle', () => {
    beforeEach(() => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
    });

    it('should report running state correctly', async () => {
      expect(receiver.isRunning()).toBe(false);
      await receiver.start({ port: 0 });
      expect(receiver.isRunning()).toBe(true);
      await receiver.stop();
      expect(receiver.isRunning()).toBe(false);
    });

    it('should not start twice', async () => {
      await receiver.start({ port: 0 });
      await receiver.start({ port: 0 }); // should warn but not throw
      expect(receiver.isRunning()).toBe(true);
    });

    it('should not start when disabled', async () => {
      await receiver.start({ port: 0, enabled: false });
      expect(receiver.isRunning()).toBe(false);
    });

    it('should return config', async () => {
      await receiver.start({ port: 0, communityStrings: ['test'] });
      const config = receiver.getConfig();
      expect(config.port).toBe(0);
      expect(config.communityStrings).toContain('test');
    });
  });

  // ─── Reload Config ───

  describe('reloadConfig', () => {
    beforeEach(async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null);
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);
      await receiver.start({ port: 0 });
    });

    it('should reload OID mappings and v3 credentials from database', async () => {
      // Initially empty
      expect(receiver.getOidMappings()).toHaveLength(0);
      expect(receiver.getV3Credentials()).toHaveLength(0);

      // Mock DB to return data on reload
      (dataStore.query as jest.Mock)
        .mockResolvedValueOnce([
          { id: 'r1', oid: '1.3.6.1.6.3.1.1.5.3', event_type: 'linkDown', severity: 'high', description: 'Link down', is_builtin: true },
        ])
        .mockResolvedValueOnce([
          { id: 'c1', name: 'user1', username: 'admin', security_level: 'authNoPriv', auth_protocol: 'SHA', auth_key_encrypted: 'key', priv_protocol: null, priv_key_encrypted: null },
        ]);

      await receiver.reloadConfig();

      expect(receiver.getOidMappings()).toHaveLength(1);
      expect(receiver.getV3Credentials()).toHaveLength(1);
      expect(receiver.getV3Credentials()[0].username).toBe('admin');
    });
  });

  // ─── PostgreSQL Persistence ───

  describe('PostgreSQL persistence', () => {
    it('should seed built-in OID mappings on start when not in DB', async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue(null); // no existing
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);

      await receiver.start({ port: 0 });

      // Should have called execute for each of the 5 built-in OIDs
      const insertCalls = (dataStore.execute as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO snmp_trap_oid_mappings'),
      );
      expect(insertCalls.length).toBe(5);
    });

    it('should not re-insert built-in OID mappings if already in DB', async () => {
      (dataStore.queryOne as jest.Mock).mockResolvedValue({ id: 'existing' }); // already exists
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
      (dataStore.query as jest.Mock).mockResolvedValue([]);

      await receiver.start({ port: 0 });

      const insertCalls = (dataStore.execute as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO snmp_trap_oid_mappings'),
      );
      expect(insertCalls.length).toBe(0);
    });

    it('should fall back to in-memory built-in mappings on DB error', async () => {
      (dataStore.queryOne as jest.Mock).mockRejectedValue(new Error('DB error'));
      (dataStore.query as jest.Mock).mockRejectedValue(new Error('DB error'));
      (dataStore.execute as jest.Mock).mockResolvedValue({ rowCount: 1 });

      await receiver.start({ port: 0 });

      // Should have fallback built-in mappings
      const mappings = receiver.getOidMappings();
      expect(mappings.length).toBe(5);
      expect(mappings.every((m) => m.isBuiltin)).toBe(true);
    });
  });
});
