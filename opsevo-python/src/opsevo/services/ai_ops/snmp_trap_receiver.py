"""
SnmpTrapReceiver — SNMP Trap/Inform 接收、BER 解码、OID 映射与 EventBus 集成

功能：
- Trap/Inform 接收（asyncio UDP 端口 162）
- Trap PDU 解析（轻量 ASN.1/BER 解码）
- 内置 OID 映射 + 自定义 OID 映射配置
- Trap → PerceptionEvent 转换
- Inform 确认响应
- OID 映射和 v3 认证配置持久化到 PostgreSQL

Requirements: 15.5
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog

from opsevo.data.datastore import DataStore
from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority

logger = structlog.get_logger(__name__)

# ─── ASN.1/BER Tag Constants ───

BER_INTEGER = 0x02
BER_OCTET_STRING = 0x04
BER_NULL = 0x05
BER_OID = 0x06
BER_SEQUENCE = 0x30
BER_GET_RESPONSE = 0xA2
BER_INFORM_REQUEST = 0xA6
BER_TRAP_V2 = 0xA7
BER_IP_ADDRESS = 0x40
BER_COUNTER32 = 0x41
BER_GAUGE32 = 0x42
BER_TIMETICKS = 0x43
BER_OPAQUE = 0x44
BER_COUNTER64 = 0x46
BER_NO_SUCH_OBJECT = 0x80
BER_NO_SUCH_INSTANCE = 0x81
BER_END_OF_MIB_VIEW = 0x82


# ─── Built-in OID Mappings ───

BUILTIN_OID_MAPPINGS: list[dict[str, Any]] = [
    {"oid": "1.3.6.1.6.3.1.1.5.1", "event_type": "coldStart", "severity": "medium", "description": "Device cold start (reboot)"},
    {"oid": "1.3.6.1.6.3.1.1.5.2", "event_type": "warmStart", "severity": "low", "description": "Device warm start"},
    {"oid": "1.3.6.1.6.3.1.1.5.3", "event_type": "linkDown", "severity": "high", "description": "Network interface link down"},
    {"oid": "1.3.6.1.6.3.1.1.5.4", "event_type": "linkUp", "severity": "medium", "description": "Network interface link up"},
    {"oid": "1.3.6.1.6.3.1.1.5.5", "event_type": "authenticationFailure", "severity": "high", "description": "SNMP authentication failure"},
]


# ─── Data classes ───

@dataclass
class SnmpTrapReceiverConfig:
    port: int = 162
    enabled: bool = True
    community_strings: list[str] = field(default_factory=lambda: ["public"])


@dataclass
class TrapOidMapping:
    id: str
    oid: str
    event_type: str
    severity: str  # Priority value
    description: str | None
    is_builtin: bool


@dataclass
class SnmpV3Credential:
    id: str
    name: str
    username: str
    security_level: str  # 'noAuthNoPriv' | 'authNoPriv' | 'authPriv'
    auth_protocol: str | None
    auth_key_encrypted: str | None
    priv_protocol: str | None
    priv_key_encrypted: str | None


@dataclass
class VariableBinding:
    oid: str
    type: str
    value: Any


@dataclass
class ParsedTrap:
    version: str  # 'v1' | 'v2c' | 'v3'
    source_ip: str
    request_id: int
    trap_oid: str
    sys_up_time: int
    variable_bindings: list[VariableBinding]
    is_inform: bool
    community: str | None = None
    msg_id: int | None = None
    security_model: int | None = None
    security_name: str | None = None
    engine_id: str | None = None


@dataclass
class BerTlv:
    tag: int
    length: int
    value: bytes
    total_length: int


# ─── ASN.1/BER Decoder ───

class BerDecoder:
    """Lightweight ASN.1/BER decoder for SNMP trap parsing."""

    @staticmethod
    def decode_tlv(buf: bytes, offset: int) -> BerTlv:
        if offset >= len(buf):
            raise ValueError(f"BER decode: offset {offset} beyond buffer length {len(buf)}")
        tag = buf[offset]
        pos = offset + 1
        if pos >= len(buf):
            raise ValueError("BER decode: unexpected end reading length")
        first_len = buf[pos]
        pos += 1
        if first_len < 0x80:
            length = first_len
        elif first_len == 0x80:
            raise ValueError("BER decode: indefinite length not supported")
        else:
            num_len_bytes = first_len & 0x7F
            if num_len_bytes > 4:
                raise ValueError(f"BER decode: length field too large ({num_len_bytes} bytes)")
            if pos + num_len_bytes > len(buf):
                raise ValueError("BER decode: unexpected end reading length bytes")
            length = 0
            for i in range(num_len_bytes):
                length = (length << 8) | buf[pos + i]
            pos += num_len_bytes
        if pos + length > len(buf):
            raise ValueError("BER decode: value extends beyond buffer")
        value = buf[pos:pos + length]
        return BerTlv(tag=tag, length=length, value=value, total_length=pos - offset + length)

    @staticmethod
    def decode_children(buf: bytes) -> list[BerTlv]:
        children: list[BerTlv] = []
        offset = 0
        while offset < len(buf):
            tlv = BerDecoder.decode_tlv(buf, offset)
            children.append(tlv)
            offset += tlv.total_length
        return children

    @staticmethod
    def decode_integer(buf: bytes) -> int:
        if not buf:
            return 0
        val = -1 if buf[0] & 0x80 else 0
        for b in buf:
            val = (val << 8) | b
        return val

    @staticmethod
    def decode_oid(buf: bytes) -> str:
        if not buf:
            return ""
        components = [buf[0] // 40, buf[0] % 40]
        current = 0
        for i in range(1, len(buf)):
            current = (current << 7) | (buf[i] & 0x7F)
            if (buf[i] & 0x80) == 0:
                components.append(current)
                current = 0
        return ".".join(str(c) for c in components)

    @staticmethod
    def decode_octet_string(buf: bytes) -> str:
        return buf.decode("utf-8", errors="replace")

    @staticmethod
    def decode_timeticks(buf: bytes) -> int:
        val = 0
        for b in buf:
            val = val * 256 + b
        return val

    @staticmethod
    def decode_ip_address(buf: bytes) -> str:
        if len(buf) != 4:
            return buf.hex()
        return f"{buf[0]}.{buf[1]}.{buf[2]}.{buf[3]}"

    @staticmethod
    def decode_unsigned32(buf: bytes) -> int:
        val = 0
        for b in buf:
            val = val * 256 + b
        return val

    @staticmethod
    def decode_varbind_value(tag: int, buf: bytes) -> dict[str, Any]:
        if tag == BER_INTEGER:
            return {"type": "INTEGER", "value": BerDecoder.decode_integer(buf)}
        if tag == BER_OCTET_STRING:
            return {"type": "OCTET_STRING", "value": BerDecoder.decode_octet_string(buf)}
        if tag == BER_OID:
            return {"type": "OID", "value": BerDecoder.decode_oid(buf)}
        if tag == BER_NULL:
            return {"type": "NULL", "value": None}
        if tag == BER_IP_ADDRESS:
            return {"type": "IpAddress", "value": BerDecoder.decode_ip_address(buf)}
        if tag == BER_COUNTER32:
            return {"type": "Counter32", "value": BerDecoder.decode_unsigned32(buf)}
        if tag == BER_GAUGE32:
            return {"type": "Gauge32", "value": BerDecoder.decode_unsigned32(buf)}
        if tag == BER_TIMETICKS:
            return {"type": "TimeTicks", "value": BerDecoder.decode_timeticks(buf)}
        if tag == BER_COUNTER64:
            val = 0
            for b in buf:
                val = (val << 8) | b
            return {"type": "Counter64", "value": val}
        if tag == BER_OPAQUE:
            return {"type": "Opaque", "value": buf.hex()}
        if tag == BER_NO_SUCH_OBJECT:
            return {"type": "noSuchObject", "value": None}
        if tag == BER_NO_SUCH_INSTANCE:
            return {"type": "noSuchInstance", "value": None}
        if tag == BER_END_OF_MIB_VIEW:
            return {"type": "endOfMibView", "value": None}
        return {"type": f"unknown(0x{tag:02x})", "value": buf.hex()}

    # ─── Encoding helpers (for Inform responses) ───

    @staticmethod
    def encode_length(length: int) -> bytes:
        if length < 0x80:
            return bytes([length])
        b: list[int] = []
        l = length
        while l > 0:
            b.insert(0, l & 0xFF)
            l >>= 8
        return bytes([0x80 | len(b)] + b)

    @staticmethod
    def encode_tlv(tag: int, value: bytes) -> bytes:
        return bytes([tag]) + BerDecoder.encode_length(len(value)) + value

    @staticmethod
    def encode_integer(val: int) -> bytes:
        if val == 0:
            b = [0]
        else:
            b: list[int] = []
            v = val
            while v != 0 and v != -1:
                b.insert(0, v & 0xFF)
                v >>= 8
            if val > 0 and (b[0] & 0x80):
                b.insert(0, 0)
            elif val < 0 and not (b[0] & 0x80):
                b.insert(0, 0xFF)
        return BerDecoder.encode_tlv(BER_INTEGER, bytes(b))

    @staticmethod
    def encode_inform_response(version: int, community: str, request_id: int, varbinds: bytes) -> bytes:
        req_id_buf = BerDecoder.encode_integer(request_id)
        error_status = BerDecoder.encode_integer(0)
        error_index = BerDecoder.encode_integer(0)
        pdu_content = req_id_buf + error_status + error_index + varbinds
        pdu_buf = BerDecoder.encode_tlv(BER_GET_RESPONSE, pdu_content)
        community_buf = BerDecoder.encode_tlv(BER_OCTET_STRING, community.encode("utf-8"))
        version_buf = BerDecoder.encode_integer(version)
        msg_content = version_buf + community_buf + pdu_buf
        return BerDecoder.encode_tlv(BER_SEQUENCE, msg_content)


# ─── SNMP Message Parser ───

def parse_snmp_message(buf: bytes, source_ip: str) -> ParsedTrap | None:
    """Parse a raw SNMP message buffer into a ParsedTrap."""
    try:
        outer = BerDecoder.decode_tlv(buf, 0)
        if outer.tag != BER_SEQUENCE:
            return None
        children = BerDecoder.decode_children(outer.value)
        if len(children) < 3:
            return None
        version_num = BerDecoder.decode_integer(children[0].value)
        if version_num == 1:
            return _parse_v2c_message(children, source_ip)
        if version_num == 3:
            return _parse_v3_message(children, source_ip)
        return None
    except Exception as exc:
        logger.debug("Failed to parse SNMP message", error=str(exc))
        return None


def _parse_v2c_message(children: list[BerTlv], source_ip: str) -> ParsedTrap | None:
    if len(children) < 3:
        return None
    community = BerDecoder.decode_octet_string(children[1].value)
    pdu_tag = children[2].tag
    is_inform = pdu_tag == BER_INFORM_REQUEST
    is_trap = pdu_tag == BER_TRAP_V2
    if not is_inform and not is_trap:
        return None

    pdu_children = BerDecoder.decode_children(children[2].value)
    if len(pdu_children) < 4:
        return None
    request_id = BerDecoder.decode_integer(pdu_children[0].value)

    varbind_list = BerDecoder.decode_children(pdu_children[3].value)
    variable_bindings: list[VariableBinding] = []
    trap_oid = ""
    sys_up_time = 0

    for vb in varbind_list:
        vb_children = BerDecoder.decode_children(vb.value)
        if len(vb_children) < 2:
            continue
        oid = BerDecoder.decode_oid(vb_children[0].value)
        decoded = BerDecoder.decode_varbind_value(vb_children[1].tag, vb_children[1].value)
        if oid == "1.3.6.1.2.1.1.3.0":
            sys_up_time = decoded["value"] if isinstance(decoded["value"], int) else 0
        elif oid == "1.3.6.1.6.3.1.1.4.1.0":
            trap_oid = str(decoded["value"]) if decoded["value"] is not None else ""
        variable_bindings.append(VariableBinding(oid=oid, type=decoded["type"], value=decoded["value"]))

    return ParsedTrap(
        version="v2c", community=community, source_ip=source_ip,
        request_id=request_id, trap_oid=trap_oid, sys_up_time=sys_up_time,
        variable_bindings=variable_bindings, is_inform=is_inform,
    )


def _parse_v3_message(children: list[BerTlv], source_ip: str) -> ParsedTrap | None:
    if len(children) < 3:
        return None
    global_data = BerDecoder.decode_children(children[1].value)
    if len(global_data) < 4:
        return None
    msg_id = BerDecoder.decode_integer(global_data[0].value)
    security_model = BerDecoder.decode_integer(global_data[3].value)

    security_name = ""
    engine_id = ""
    try:
        sec_params_outer = children[2]
        sec_seq = BerDecoder.decode_tlv(sec_params_outer.value, 0)
        sec_fields = BerDecoder.decode_children(sec_seq.value)
        if len(sec_fields) >= 2:
            engine_id = sec_fields[0].value.hex()
        if len(sec_fields) >= 4:
            security_name = BerDecoder.decode_octet_string(sec_fields[3].value)
    except Exception:
        pass

    if len(children) < 4:
        return None

    trap_oid = ""
    sys_up_time = 0
    request_id = 0
    is_inform = False
    variable_bindings: list[VariableBinding] = []

    try:
        msg_data = children[3]
        scoped_pdu = BerDecoder.decode_children(msg_data.value)
        if len(scoped_pdu) >= 3:
            pdu_tag = scoped_pdu[2].tag
            is_inform = pdu_tag == BER_INFORM_REQUEST
            if pdu_tag in (BER_TRAP_V2, BER_INFORM_REQUEST):
                pdu_children = BerDecoder.decode_children(scoped_pdu[2].value)
                if len(pdu_children) >= 4:
                    request_id = BerDecoder.decode_integer(pdu_children[0].value)
                    varbind_list = BerDecoder.decode_children(pdu_children[3].value)
                    for vb in varbind_list:
                        vb_children = BerDecoder.decode_children(vb.value)
                        if len(vb_children) < 2:
                            continue
                        oid = BerDecoder.decode_oid(vb_children[0].value)
                        decoded = BerDecoder.decode_varbind_value(vb_children[1].tag, vb_children[1].value)
                        if oid == "1.3.6.1.2.1.1.3.0":
                            sys_up_time = decoded["value"] if isinstance(decoded["value"], int) else 0
                        elif oid == "1.3.6.1.6.3.1.1.4.1.0":
                            trap_oid = str(decoded["value"]) if decoded["value"] is not None else ""
                        variable_bindings.append(VariableBinding(oid=oid, type=decoded["type"], value=decoded["value"]))
    except Exception:
        logger.debug("Could not parse v3 PDU data (possibly encrypted)")

    return ParsedTrap(
        version="v3", source_ip=source_ip, request_id=request_id,
        trap_oid=trap_oid, sys_up_time=sys_up_time,
        variable_bindings=variable_bindings, is_inform=is_inform,
        msg_id=msg_id, security_model=security_model,
        security_name=security_name, engine_id=engine_id,
    )


# ─── UDP Protocol ───

class _TrapUdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, on_trap) -> None:
        self._on_trap = on_trap
        self._transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        self._transport = transport  # type: ignore[assignment]

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        asyncio.create_task(self._on_trap(data, addr[0], addr[1]))

    def error_received(self, exc: Exception) -> None:
        logger.warn("SnmpTrapReceiver UDP error", error=str(exc))


# ─── SnmpTrapReceiver ───

class SnmpTrapReceiver:
    """SNMP Trap/Inform receiver with BER decoding, OID mapping, and EventBus integration."""

    def __init__(self, data_store: DataStore, event_bus: EventBus) -> None:
        self._data_store = data_store
        self._event_bus = event_bus
        self._running = False

        self._oid_mappings: list[TrapOidMapping] = []
        self._v3_credentials: list[SnmpV3Credential] = []
        self._trap_stats: dict[str, dict[str, Any]] = {}
        self._stats_cleanup_task: asyncio.Task | None = None

        self._config = SnmpTrapReceiverConfig()
        self._udp_transport: asyncio.DatagramTransport | None = None
        self._udp_protocol: _TrapUdpProtocol | None = None

    # ─── Lifecycle ───

    async def start(self, config: SnmpTrapReceiverConfig | None = None) -> None:
        if self._running:
            logger.warn("SnmpTrapReceiver already running")
            return
        if config:
            self._config = config
        if not self._config.enabled:
            logger.info("SnmpTrapReceiver disabled by config")
            return

        await self.load_oid_mappings()
        await self.load_v3_credentials()

        self._event_bus.register_source(
            "snmp-trap-receiver",
            {"event_types": ["snmp_trap"], "schema_version": "1.0.0"},
        )

        await self._start_udp()
        self._start_stats_cleanup()
        self._running = True
        logger.info("SnmpTrapReceiver started", port=self._config.port)

    async def stop(self) -> None:
        if not self._running:
            return
        if self._stats_cleanup_task and not self._stats_cleanup_task.done():
            self._stats_cleanup_task.cancel()
            self._stats_cleanup_task = None
        if self._udp_transport:
            self._udp_transport.close()
            self._udp_transport = None
        self._running = False
        logger.info("SnmpTrapReceiver stopped")

    @property
    def is_running(self) -> bool:
        return self._running

    async def _start_udp(self) -> None:
        loop = asyncio.get_running_loop()
        self._udp_protocol = _TrapUdpProtocol(self._handle_raw_trap)
        transport, _ = await loop.create_datagram_endpoint(
            lambda: self._udp_protocol,
            local_addr=("0.0.0.0", self._config.port),
        )
        self._udp_transport = transport

    # ─── Core trap pipeline ───

    async def _handle_raw_trap(self, raw: bytes, source_ip: str, source_port: int) -> None:
        parsed = parse_snmp_message(raw, source_ip)
        if not parsed:
            logger.debug("Failed to parse trap", source_ip=source_ip)
            return
        if not self._authenticate(parsed):
            logger.warn("Auth failed for trap", version=parsed.version, source_ip=source_ip)
            return
        self._update_trap_stats(source_ip)
        event = self._to_perception_event(parsed)
        await self._event_bus.publish(event)
        if parsed.is_inform:
            self._send_inform_response(parsed, source_ip, source_port, raw)

    # ─── Authentication ───

    def _authenticate(self, parsed: ParsedTrap) -> bool:
        if parsed.version == "v2c":
            return parsed.community in self._config.community_strings if parsed.community else False
        if parsed.version == "v3":
            if not parsed.security_name:
                return False
            return any(c.username == parsed.security_name for c in self._v3_credentials)
        return False

    # ─── OID Mapping ───

    def map_oid(self, oid: str) -> dict[str, str]:
        """Map trap OID to event_type and severity. Custom mappings take priority."""
        custom = next((m for m in self._oid_mappings if m.oid == oid and not m.is_builtin), None)
        if custom:
            return {"event_type": custom.event_type, "severity": custom.severity}
        builtin = next((m for m in self._oid_mappings if m.oid == oid and m.is_builtin), None)
        if builtin:
            return {"event_type": builtin.event_type, "severity": builtin.severity}
        return {"event_type": "unknown", "severity": "medium"}

    # ─── Conversion ───

    def _to_perception_event(self, parsed: ParsedTrap) -> PerceptionEvent:
        mapped = self.map_oid(parsed.trap_oid)
        severity_map = {
            "critical": Priority.CRITICAL, "high": Priority.HIGH,
            "medium": Priority.MEDIUM, "low": Priority.LOW, "info": Priority.INFO,
        }
        priority = severity_map.get(mapped["severity"], Priority.MEDIUM)
        return PerceptionEvent(
            type=EventType.SNMP_TRAP,
            priority=priority,
            source=f"snmp-trap:{parsed.source_ip}",
            payload={
                "trap_oid": parsed.trap_oid,
                "event_type": mapped["event_type"],
                "version": parsed.version,
                "sys_up_time": parsed.sys_up_time,
                "variable_bindings": [
                    {"oid": vb.oid, "type": vb.type, "value": vb.value}
                    for vb in parsed.variable_bindings
                ],
                "source_ip": parsed.source_ip,
                "is_inform": parsed.is_inform,
                "community": parsed.community if parsed.version == "v2c" else None,
                "security_name": parsed.security_name if parsed.version == "v3" else None,
            },
            schema_version="1.0.0",
        )

    # ─── Inform Response ───

    def _send_inform_response(self, parsed: ParsedTrap, source_ip: str, source_port: int, raw: bytes) -> None:
        if not self._udp_transport:
            return
        try:
            if parsed.version == "v2c":
                varbinds_buf = self._extract_varbinds_buffer(raw)
                response = BerDecoder.encode_inform_response(
                    1, parsed.community or "public", parsed.request_id, varbinds_buf,
                )
                self._udp_transport.sendto(response, (source_ip, source_port))
                logger.debug("Sent Inform response", target=f"{source_ip}:{source_port}")
            else:
                logger.debug("v3 Inform response not fully implemented")
        except Exception as exc:
            logger.error("Error building Inform response", error=str(exc))

    def _extract_varbinds_buffer(self, raw: bytes) -> bytes:
        try:
            outer = BerDecoder.decode_tlv(raw, 0)
            children = BerDecoder.decode_children(outer.value)
            if len(children) < 3:
                return BerDecoder.encode_tlv(BER_SEQUENCE, b"")
            pdu_children = BerDecoder.decode_children(children[2].value)
            if len(pdu_children) >= 4:
                return BerDecoder.encode_tlv(BER_SEQUENCE, pdu_children[3].value)
        except Exception:
            pass
        return BerDecoder.encode_tlv(BER_SEQUENCE, b"")


    # ─── Trap Stats ───

    def _update_trap_stats(self, source_ip: str) -> None:
        now = time.time()
        stats = self._trap_stats.get(source_ip)
        if stats:
            stats["trap_count"] += 1
            stats["last_seen_at"] = now
        else:
            self._trap_stats[source_ip] = {"trap_count": 1, "last_seen_at": now}

    def _start_stats_cleanup(self) -> None:
        async def _cleanup_loop() -> None:
            max_age = 24 * 3600.0
            while True:
                await asyncio.sleep(3600)
                now = time.time()
                stale = [ip for ip, s in self._trap_stats.items() if now - s["last_seen_at"] > max_age]
                for ip in stale:
                    del self._trap_stats[ip]

        self._stats_cleanup_task = asyncio.create_task(_cleanup_loop())

    def get_trap_stats(self) -> dict[str, dict[str, Any]]:
        return {ip: dict(s) for ip, s in self._trap_stats.items()}

    # ─── PostgreSQL Persistence ───

    async def load_oid_mappings(self) -> None:
        try:
            # Ensure built-in mappings exist
            for builtin in BUILTIN_OID_MAPPINGS:
                existing = await self._data_store.query_one(
                    "SELECT id FROM snmp_trap_oid_mappings WHERE oid = $1", (builtin["oid"],)
                )
                if not existing:
                    await self._data_store.execute(
                        "INSERT INTO snmp_trap_oid_mappings (oid, event_type, severity, description, is_builtin) "
                        "VALUES ($1, $2, $3, $4, true)",
                        (builtin["oid"], builtin["event_type"], builtin["severity"], builtin["description"]),
                    )
            rows = await self._data_store.query(
                "SELECT id, oid, event_type, severity, description, is_builtin "
                "FROM snmp_trap_oid_mappings ORDER BY is_builtin ASC, oid ASC"
            )
            self._oid_mappings = [
                TrapOidMapping(
                    id=r["id"], oid=r["oid"], event_type=r["event_type"],
                    severity=r["severity"], description=r.get("description"),
                    is_builtin=r["is_builtin"],
                )
                for r in rows
            ]
            logger.info("Loaded OID mappings", count=len(self._oid_mappings))
        except Exception as exc:
            logger.error("Failed to load OID mappings", error=str(exc))
            self._oid_mappings = [
                TrapOidMapping(
                    id=str(uuid.uuid4()), oid=b["oid"], event_type=b["event_type"],
                    severity=b["severity"], description=b["description"], is_builtin=True,
                )
                for b in BUILTIN_OID_MAPPINGS
            ]

    async def load_v3_credentials(self) -> None:
        try:
            rows = await self._data_store.query(
                "SELECT id, name, username, security_level, auth_protocol, "
                "auth_key_encrypted, priv_protocol, priv_key_encrypted FROM snmp_v3_credentials"
            )
            self._v3_credentials = [
                SnmpV3Credential(
                    id=r["id"], name=r["name"], username=r["username"],
                    security_level=r["security_level"],
                    auth_protocol=r.get("auth_protocol"),
                    auth_key_encrypted=r.get("auth_key_encrypted"),
                    priv_protocol=r.get("priv_protocol"),
                    priv_key_encrypted=r.get("priv_key_encrypted"),
                )
                for r in rows
            ]
            logger.info("Loaded v3 credentials", count=len(self._v3_credentials))
        except Exception as exc:
            logger.error("Failed to load v3 credentials", error=str(exc))
            self._v3_credentials = []

    # ─── CRUD: OID Mappings ───

    async def add_oid_mapping(self, oid: str, event_type: str, severity: str,
                              description: str | None = None) -> TrapOidMapping:
        mapping_id = str(uuid.uuid4())
        await self._data_store.execute(
            "INSERT INTO snmp_trap_oid_mappings (id, oid, event_type, severity, description, is_builtin) "
            "VALUES ($1, $2, $3, $4, $5, false)",
            (mapping_id, oid, event_type, severity, description),
        )
        mapping = TrapOidMapping(id=mapping_id, oid=oid, event_type=event_type,
                                 severity=severity, description=description, is_builtin=False)
        self._oid_mappings.append(mapping)
        return mapping

    async def update_oid_mapping(self, mapping_id: str, event_type: str | None = None,
                                 severity: str | None = None, description: str | None = None) -> bool:
        existing = next((m for m in self._oid_mappings if m.id == mapping_id), None)
        if not existing:
            return False
        new_et = event_type or existing.event_type
        new_sev = severity or existing.severity
        new_desc = description if description is not None else existing.description
        count = await self._data_store.execute(
            "UPDATE snmp_trap_oid_mappings SET event_type = $1, severity = $2, description = $3 WHERE id = $4",
            (new_et, new_sev, new_desc, mapping_id),
        )
        if count > 0:
            existing.event_type = new_et
            existing.severity = new_sev
            existing.description = new_desc
            return True
        return False

    async def remove_oid_mapping(self, mapping_id: str) -> bool:
        mapping = next((m for m in self._oid_mappings if m.id == mapping_id), None)
        if mapping and mapping.is_builtin:
            logger.warn("Cannot remove built-in OID mapping", oid=mapping.oid)
            return False
        count = await self._data_store.execute(
            "DELETE FROM snmp_trap_oid_mappings WHERE id = $1 AND is_builtin = false", (mapping_id,)
        )
        if count > 0:
            self._oid_mappings = [m for m in self._oid_mappings if m.id != mapping_id]
            return True
        return False

    # ─── CRUD: V3 Credentials ───

    async def add_v3_credential(self, name: str, username: str, security_level: str,
                                auth_protocol: str | None = None, auth_key_encrypted: str | None = None,
                                priv_protocol: str | None = None, priv_key_encrypted: str | None = None) -> SnmpV3Credential:
        cred_id = str(uuid.uuid4())
        await self._data_store.execute(
            "INSERT INTO snmp_v3_credentials (id, name, username, security_level, "
            "auth_protocol, auth_key_encrypted, priv_protocol, priv_key_encrypted) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            (cred_id, name, username, security_level, auth_protocol, auth_key_encrypted, priv_protocol, priv_key_encrypted),
        )
        cred = SnmpV3Credential(id=cred_id, name=name, username=username, security_level=security_level,
                                auth_protocol=auth_protocol, auth_key_encrypted=auth_key_encrypted,
                                priv_protocol=priv_protocol, priv_key_encrypted=priv_key_encrypted)
        self._v3_credentials.append(cred)
        return cred

    async def remove_v3_credential(self, cred_id: str) -> bool:
        count = await self._data_store.execute(
            "DELETE FROM snmp_v3_credentials WHERE id = $1", (cred_id,)
        )
        if count > 0:
            self._v3_credentials = [c for c in self._v3_credentials if c.id != cred_id]
            return True
        return False

    # ─── Reload & Accessors ───

    async def reload_config(self) -> None:
        await self.load_oid_mappings()
        await self.load_v3_credentials()

    def get_oid_mappings(self) -> list[TrapOidMapping]:
        return list(self._oid_mappings)

    def get_v3_credentials(self) -> list[SnmpV3Credential]:
        return list(self._v3_credentials)

    def get_config(self) -> SnmpTrapReceiverConfig:
        return SnmpTrapReceiverConfig(
            port=self._config.port,
            enabled=self._config.enabled,
            community_strings=list(self._config.community_strings),
        )
