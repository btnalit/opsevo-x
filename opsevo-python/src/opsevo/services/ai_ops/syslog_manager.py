"""
SyslogManager — 可配置 Syslog 接收、解析、来源管理与 EventBus 集成

功能：
- UDP/TCP 双协议监听（可配置端口）
- 多格式自动识别（RFC 3164、RFC 5424）
- 可配置解析规则引擎（正则/Grok）
- 来源管理（IP → deviceId 映射、未知来源告警、来源统计）
- Syslog → PerceptionEvent 转换（severity → priority）
- 消息过滤规则（来源 IP/facility/severity/关键词）
- 解析规则、来源映射、过滤规则持久化到 PostgreSQL

Requirements: 15.3, 15.4, 1.6
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog

from opsevo.data.datastore import DataStore
from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority

logger = structlog.get_logger(__name__)

# ─── Severity → Priority 映射 ───

SEVERITY_TO_PRIORITY: dict[int, Priority] = {
    0: Priority.CRITICAL,  # Emergency
    1: Priority.CRITICAL,  # Alert
    2: Priority.HIGH,      # Critical
    3: Priority.HIGH,      # Error
    4: Priority.MEDIUM,    # Warning
    5: Priority.LOW,       # Notice
    6: Priority.LOW,       # Info
    7: Priority.INFO,      # Debug
}

FACILITY_NAMES: dict[int, str] = {
    0: "kern", 1: "user", 2: "mail", 3: "daemon", 4: "auth",
    5: "syslog", 6: "lpr", 7: "news", 8: "uucp", 9: "cron",
    10: "authpriv", 11: "ftp", 12: "ntp", 13: "security",
    14: "console", 15: "solaris-cron",
    16: "local0", 17: "local1", 18: "local2", 19: "local3",
    20: "local4", 21: "local5", 22: "local6", 23: "local7",
}


# ─── Grok-like pattern expansion ───

GROK_PATTERNS: dict[str, str] = {
    "%{IP}": r"(?P<ip>\d{1,3}(?:\.\d{1,3}){3})",
    "%{WORD}": r"(?P<word>\S+)",
    "%{INT}": r"(?P<int>\d+)",
    "%{GREEDYDATA}": r"(?P<greedydata>.*)",
    "%{HOSTNAME}": r"(?P<hostname>[a-zA-Z0-9._-]+)",
    "%{SYSLOGPRI}": r"(?:<(?P<pri>\d{1,3})>)",
}


def expand_grok_pattern(pattern: str) -> str:
    """Expand Grok-like tokens into Python regex with named groups."""
    expanded = pattern
    # Named captures: %{PATTERN:fieldName}
    def _named_replace(m: re.Match) -> str:
        pat_name = m.group(1)
        field_name = m.group(2)
        base = GROK_PATTERNS.get(f"%{{{pat_name}}}")
        if not base:
            return f"(?P<{field_name}>\\S+)"
        # Replace default group name with user-specified field name
        return re.sub(r"\(\?P<\w+>", f"(?P<{field_name}>", base, count=1)

    expanded = re.sub(r"%\{(\w+):(\w+)\}", _named_replace, expanded)
    # Expand unnamed grok tokens
    for token, regex in GROK_PATTERNS.items():
        expanded = expanded.replace(token, regex)
    return expanded


# ─── CIDR helpers ───

def _ip_to_number(ip: str) -> int:
    """Parse an IPv4 address into a 32-bit integer. Returns -1 on failure."""
    parts = ip.split(".")
    if len(parts) != 4:
        return -1
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return -1
    if any(n < 0 or n > 255 for n in nums):
        return -1
    return (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]


def _match_cidr(ip: str, cidr: str) -> int:
    """Check if *ip* falls within *cidr*. Returns prefix length or -1."""
    parts = cidr.split("/")
    if len(parts) != 2:
        return -1
    network = parts[0]
    try:
        prefix = int(parts[1])
    except ValueError:
        return -1
    if prefix < 0 or prefix > 32:
        return -1
    ip_num = _ip_to_number(ip)
    net_num = _ip_to_number(network)
    if ip_num == -1 or net_num == -1:
        return -1
    mask = (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF if prefix > 0 else 0
    return prefix if (ip_num & mask) == (net_num & mask) else -1


# ─── Data classes ───

@dataclass
class SyslogManagerConfig:
    udp_port: int = 514
    tcp_port: int = 514
    enabled: bool = True


@dataclass
class ParsedSyslog:
    facility: int
    facility_name: str
    severity: int
    timestamp: float  # epoch seconds
    hostname: str
    app_name: str
    proc_id: str
    msg_id: str
    structured_data: str
    message: str
    format: str  # 'rfc3164' | 'rfc5424' | 'custom'
    raw: str
    extracted_fields: dict[str, str] = field(default_factory=dict)


@dataclass
class ParseRule:
    id: str
    name: str
    pattern: str
    pattern_type: str  # 'regex' | 'grok'
    extract_fields: list[str]
    priority: int
    enabled: bool


@dataclass
class SourceMapping:
    id: str
    source_ip: str
    source_cidr: str | None
    device_id: str | None
    description: str | None
    last_seen_at: float | None
    message_rate: float


@dataclass
class FilterRule:
    id: str
    name: str
    source_ip: str | None
    facility: int | None
    severity_min: int | None
    severity_max: int | None
    keyword: str | None
    action: str  # 'drop' | 'allow'
    enabled: bool


# ─── Source stats (in-memory) ───

@dataclass
class _SourceStats:
    message_count: int = 0
    last_seen_at: float = 0.0
    recent_timestamps: list[float] = field(default_factory=list)


# ─── TCP protocol handler ───

class _TcpSyslogHandler:
    """Handle a single TCP client connection, splitting on newlines."""

    def __init__(self, on_message, remote_ip: str) -> None:
        self._on_message = on_message
        self._remote_ip = remote_ip
        self._buffer = ""

    def data_received(self, data: bytes) -> None:
        self._buffer += data.decode("utf-8", errors="replace")
        lines = self._buffer.split("\n")
        self._buffer = lines.pop()
        for line in lines:
            trimmed = line.strip()
            if trimmed:
                asyncio.create_task(self._on_message(trimmed, self._remote_ip))


class _TcpServerProtocol(asyncio.Protocol):
    """asyncio TCP protocol factory for syslog connections."""

    def __init__(self, on_message) -> None:
        self._on_message = on_message
        self._handler: _TcpSyslogHandler | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        peername = transport.get_extra_info("peername")
        remote_ip = peername[0] if peername else "unknown"
        # Strip IPv6-mapped prefix
        if remote_ip.startswith("::ffff:"):
            remote_ip = remote_ip[7:]
        self._handler = _TcpSyslogHandler(self._on_message, remote_ip)

    def data_received(self, data: bytes) -> None:
        if self._handler:
            self._handler.data_received(data)

    def connection_lost(self, exc: Exception | None) -> None:
        pass


# ─── UDP protocol handler ───

class _UdpSyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, on_message) -> None:
        self._on_message = on_message

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        text = data.decode("utf-8", errors="replace").strip()
        if text:
            asyncio.create_task(self._on_message(text, addr[0]))

    def error_received(self, exc: Exception) -> None:
        logger.warn("SyslogManager UDP error", error=str(exc))


# ─── SyslogManager ───

class SyslogManager:
    """Configurable Syslog receiver with parsing, source management, and EventBus integration."""

    def __init__(self, data_store: DataStore, event_bus: EventBus) -> None:
        self._data_store = data_store
        self._event_bus = event_bus
        self._running = False

        self._parse_rules: list[ParseRule] = []
        self._source_mappings: list[SourceMapping] = []
        self._filter_rules: list[FilterRule] = []

        self._source_stats: dict[str, _SourceStats] = {}
        self._stats_cleanup_task: asyncio.Task | None = None

        self._config = SyslogManagerConfig()
        self._udp_transport: asyncio.DatagramTransport | None = None
        self._tcp_server: asyncio.Server | None = None

    # ─── Lifecycle ───

    async def start(self, config: SyslogManagerConfig | None = None) -> None:
        if self._running:
            logger.warn("SyslogManager already running")
            return
        if config:
            self._config = config
        if not self._config.enabled:
            logger.info("SyslogManager disabled by config")
            return

        # Load persisted rules from PostgreSQL
        await self.load_parse_rules()
        await self.load_source_mappings()
        await self.load_filter_rules()

        # Register as perception source
        self._event_bus.register_source(
            "syslog-manager",
            {"event_types": ["syslog"], "schema_version": "1.0.0"},
        )

        # Start listeners
        await self._start_udp()
        await self._start_tcp()
        self._start_stats_cleanup()

        self._running = True
        logger.info(
            "SyslogManager started",
            udp_port=self._config.udp_port,
            tcp_port=self._config.tcp_port,
        )

    async def stop(self) -> None:
        if not self._running:
            return
        if self._stats_cleanup_task and not self._stats_cleanup_task.done():
            self._stats_cleanup_task.cancel()
            self._stats_cleanup_task = None
        if self._udp_transport:
            self._udp_transport.close()
            self._udp_transport = None
        if self._tcp_server:
            self._tcp_server.close()
            await self._tcp_server.wait_closed()
            self._tcp_server = None
        self._running = False
        logger.info("SyslogManager stopped")

    @property
    def is_running(self) -> bool:
        return self._running

    # ─── UDP listener ───

    async def _start_udp(self) -> None:
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: _UdpSyslogProtocol(self._handle_raw_message),
            local_addr=("0.0.0.0", self._config.udp_port),
        )
        self._udp_transport = transport

    # ─── TCP listener ───

    async def _start_tcp(self) -> None:
        loop = asyncio.get_running_loop()
        self._tcp_server = await loop.create_server(
            lambda: _TcpServerProtocol(self._handle_raw_message),
            "0.0.0.0",
            self._config.tcp_port,
        )


    # ─── Core message pipeline ───

    async def _handle_raw_message(self, raw: str, source_ip: str) -> None:
        """Central entry: parse → filter → resolve source → convert → publish."""
        # 1. Parse
        parsed = self.parse(raw, source_ip)
        if not parsed:
            logger.debug("SyslogManager parse failed", source_ip=source_ip, raw=raw[:120])
            return

        # 2. Filter
        if self._should_filter(parsed, source_ip):
            return

        # 3. Resolve source
        device_id, known = self.resolve_source(source_ip)

        # Update in-memory stats
        self._update_source_stats(source_ip)

        # Unknown source → publish internal alert
        if not known:
            try:
                alert_event = PerceptionEvent(
                    type=EventType.INTERNAL,
                    priority=Priority.LOW,
                    source="syslog-manager",
                    payload={
                        "alert": "unknown_syslog_source",
                        "source_ip": source_ip,
                        "message": parsed.message[:200],
                    },
                    schema_version="1.0.0",
                )
                await self._event_bus.publish(alert_event)
            except Exception as exc:
                logger.error("Failed to publish unknown-source alert", error=str(exc))

        # 4. Convert to PerceptionEvent
        event = self._to_perception_event(parsed, source_ip, device_id)

        # 5. Publish
        await self._event_bus.publish(event)

    # ─── Parsing ───

    def parse(self, raw: str, source_ip: str) -> ParsedSyslog | None:
        """Parse a raw syslog string. Auto-detects RFC 5424 vs 3164."""
        trimmed = raw.strip()
        if not trimmed.startswith("<"):
            return None

        fmt = self._detect_format(trimmed)
        parsed: ParsedSyslog | None = None

        if fmt == "rfc5424":
            parsed = self._parse_rfc5424(trimmed)
        if not parsed:
            parsed = self._parse_rfc3164(trimmed)
        if not parsed:
            return None

        # Apply custom parse rules
        self._apply_parse_rules(parsed)
        return parsed

    def _detect_format(self, raw: str) -> str:
        if re.match(r"^<\d{1,3}>\d+\s", raw):
            return "rfc5424"
        if re.match(r"^<\d{1,3}>", raw):
            return "rfc3164"
        return "custom"

    def _parse_rfc3164(self, raw: str) -> ParsedSyslog | None:
        """Parse RFC 3164 (BSD Syslog): <PRI>TIMESTAMP HOSTNAME MESSAGE."""
        m = re.match(r"^<(\d{1,3})>", raw)
        if not m:
            return None
        pri = int(m.group(1))
        facility = pri >> 3
        severity = pri & 0x07
        remaining = raw[m.end():]

        # Timestamp: "MMM DD HH:MM:SS" or "MMM  D HH:MM:SS"
        ts_match = re.match(
            r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+",
            remaining,
            re.IGNORECASE,
        )
        if ts_match:
            # We store as epoch float; approximate using current year
            import datetime as _dt
            months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
            mi = months.index(ts_match.group(1).lower()) if ts_match.group(1).lower() in months else 0
            now = _dt.datetime.now()
            ts_dt = _dt.datetime(
                now.year, mi + 1, int(ts_match.group(2)),
                int(ts_match.group(3)), int(ts_match.group(4)), int(ts_match.group(5)),
            )
            if ts_dt > now:
                ts_dt = ts_dt.replace(year=now.year - 1)
            timestamp = ts_dt.timestamp()
            after_ts = remaining[ts_match.end():]
        else:
            timestamp = time.time()
            after_ts = remaining

        # HOSTNAME + MESSAGE
        space_idx = after_ts.find(" ")
        hostname = after_ts[:space_idx] if space_idx > 0 else after_ts
        message = after_ts[space_idx + 1:] if space_idx > 0 else ""

        return ParsedSyslog(
            facility=facility,
            facility_name=FACILITY_NAMES.get(facility, f"facility{facility}"),
            severity=severity,
            timestamp=timestamp,
            hostname=hostname,
            app_name="-",
            proc_id="-",
            msg_id="-",
            structured_data="-",
            message=message,
            format="rfc3164",
            raw=raw,
        )

    def _parse_rfc5424(self, raw: str) -> ParsedSyslog | None:
        """Parse RFC 5424: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD MSG."""
        m = re.match(r"^<(\d{1,3})>(\d+)\s+", raw)
        if not m:
            return None
        pri = int(m.group(1))
        facility = pri >> 3
        severity = pri & 0x07
        remaining = raw[m.end():]

        parts = self._split_rfc5424_header(remaining)
        if not parts:
            return None

        if parts["timestamp"] == "-":
            timestamp = time.time()
        else:
            import datetime as _dt
            try:
                ts_dt = _dt.datetime.fromisoformat(parts["timestamp"].replace("Z", "+00:00"))
                timestamp = ts_dt.timestamp()
            except (ValueError, OSError):
                timestamp = time.time()

        return ParsedSyslog(
            facility=facility,
            facility_name=FACILITY_NAMES.get(facility, f"facility{facility}"),
            severity=severity,
            timestamp=timestamp,
            hostname=parts["hostname"] if parts["hostname"] != "-" else "unknown",
            app_name=parts["app_name"],
            proc_id=parts["proc_id"],
            msg_id=parts["msg_id"],
            structured_data=parts["sd"],
            message=parts["msg"],
            format="rfc5424",
            raw=raw,
        )

    def _split_rfc5424_header(self, s: str) -> dict[str, str] | None:
        """Split RFC 5424 header into constituent parts."""
        tokens: list[str] = []
        pos = 0
        for _ in range(5):
            space_idx = s.find(" ", pos)
            if space_idx == -1:
                return None
            tokens.append(s[pos:space_idx])
            pos = space_idx + 1

        # Structured data
        rest = s[pos:]
        sd = "-"
        msg_start = pos

        if rest.startswith("-"):
            sd = "-"
            msg_start = pos + 1
            if msg_start < len(s) and s[msg_start] == " ":
                msg_start += 1
        elif rest.startswith("["):
            depth = 0
            sd_end = 0
            for i, ch in enumerate(rest):
                if ch == "[":
                    depth += 1
                elif ch == "]":
                    depth -= 1
                    if depth == 0:
                        sd_end = i + 1
            sd = rest[:sd_end]
            msg_start = pos + sd_end
            if msg_start < len(s) and s[msg_start] == " ":
                msg_start += 1

        return {
            "timestamp": tokens[0],
            "hostname": tokens[1],
            "app_name": tokens[2],
            "proc_id": tokens[3],
            "msg_id": tokens[4],
            "sd": sd,
            "msg": s[msg_start:],
        }


    def _apply_parse_rules(self, parsed: ParsedSyslog) -> None:
        """Apply custom parse rules (regex/grok) for field extraction."""
        enabled = sorted(
            (r for r in self._parse_rules if r.enabled),
            key=lambda r: r.priority,
        )
        for rule in enabled:
            try:
                regex_str = rule.pattern
                if rule.pattern_type == "grok":
                    regex_str = expand_grok_pattern(rule.pattern)
                m = re.search(regex_str, parsed.message)
                if m and m.groupdict():
                    for key, value in m.groupdict().items():
                        if value is not None:
                            parsed.extracted_fields[key] = value
                    return  # First matching rule wins
            except re.error as exc:
                logger.warn("Parse rule regex error", rule=rule.name, error=str(exc))

    # ─── Source management ───

    def resolve_source(self, source_ip: str) -> tuple[str | None, bool]:
        """Resolve source IP to (device_id, known). Exact IP > CIDR longest prefix."""
        # 1. Exact IP match
        for m in self._source_mappings:
            if m.source_ip == source_ip and not m.source_cidr:
                return m.device_id, True

        # 2. CIDR match — longest prefix wins
        best_mapping: SourceMapping | None = None
        best_prefix = -1
        for m in self._source_mappings:
            if not m.source_cidr:
                continue
            prefix = _match_cidr(source_ip, m.source_cidr)
            if prefix > best_prefix:
                best_prefix = prefix
                best_mapping = m

        if best_mapping:
            return best_mapping.device_id, True
        return None, False

    # ─── Conversion ───

    def _to_perception_event(
        self, parsed: ParsedSyslog, source_ip: str, device_id: str | None = None,
    ) -> PerceptionEvent:
        priority = SEVERITY_TO_PRIORITY.get(parsed.severity, Priority.LOW)
        return PerceptionEvent(
            type=EventType.SYSLOG,
            priority=priority,
            source=f"syslog:{source_ip}",
            payload={
                "facility": parsed.facility,
                "facility_name": parsed.facility_name,
                "severity": parsed.severity,
                "hostname": parsed.hostname,
                "app_name": parsed.app_name,
                "proc_id": parsed.proc_id,
                "msg_id": parsed.msg_id,
                "structured_data": parsed.structured_data,
                "message": parsed.message,
                "format": parsed.format,
                "extracted_fields": parsed.extracted_fields,
                "source_ip": source_ip,
                "device_id": device_id,
            },
            schema_version="1.0.0",
        )

    # ─── Filtering ───

    def _should_filter(self, parsed: ParsedSyslog, source_ip: str) -> bool:
        enabled = [f for f in self._filter_rules if f.enabled]
        if not enabled:
            return False
        for rule in enabled:
            if self._matches_filter(rule, parsed, source_ip):
                return rule.action == "drop"
        return False

    def _matches_filter(self, rule: FilterRule, parsed: ParsedSyslog, source_ip: str) -> bool:
        """All non-null conditions must match (AND logic)."""
        if rule.source_ip is not None and rule.source_ip != source_ip:
            return False
        if rule.facility is not None and rule.facility != parsed.facility:
            return False
        if rule.severity_min is not None and parsed.severity < rule.severity_min:
            return False
        if rule.severity_max is not None and parsed.severity > rule.severity_max:
            return False
        if rule.keyword is not None and rule.keyword.lower() not in parsed.message.lower():
            return False
        return True

    # ─── Source stats ───

    def _update_source_stats(self, source_ip: str) -> None:
        now = time.time()
        stats = self._source_stats.get(source_ip)
        if not stats:
            stats = _SourceStats()
            self._source_stats[source_ip] = stats
        stats.message_count += 1
        stats.last_seen_at = now
        stats.recent_timestamps.append(now)
        cutoff = now - 60.0
        stats.recent_timestamps = [t for t in stats.recent_timestamps if t >= cutoff]

    def _start_stats_cleanup(self) -> None:
        async def _cleanup_loop() -> None:
            max_age = 24 * 3600.0
            while True:
                await asyncio.sleep(3600)  # every hour
                now = time.time()
                stale = [ip for ip, s in self._source_stats.items() if now - s.last_seen_at > max_age]
                for ip in stale:
                    del self._source_stats[ip]

        self._stats_cleanup_task = asyncio.create_task(_cleanup_loop())

    def get_source_stats(self) -> dict[str, dict[str, Any]]:
        now = time.time()
        cutoff = now - 60.0
        result: dict[str, dict[str, Any]] = {}
        for ip, stats in self._source_stats.items():
            recent = [t for t in stats.recent_timestamps if t >= cutoff]
            result[ip] = {
                "message_count": stats.message_count,
                "last_seen_at": stats.last_seen_at,
                "message_rate": len(recent),  # messages per minute
            }
        return result


    # ─── PostgreSQL persistence ───

    async def load_parse_rules(self) -> None:
        try:
            rows = await self._data_store.query(
                "SELECT id, name, pattern, pattern_type, extract_fields, priority, enabled "
                "FROM syslog_parse_rules WHERE pattern_type != 'filter' ORDER BY priority ASC"
            )
            self._parse_rules = [
                ParseRule(
                    id=r["id"],
                    name=r["name"],
                    pattern=r["pattern"],
                    pattern_type=r["pattern_type"],
                    extract_fields=r["extract_fields"] if isinstance(r["extract_fields"], list) else [],
                    priority=r["priority"],
                    enabled=r["enabled"],
                )
                for r in rows
            ]
            logger.info("Loaded parse rules", count=len(self._parse_rules))
        except Exception as exc:
            logger.error("Failed to load parse rules", error=str(exc))
            self._parse_rules = []

    async def load_source_mappings(self) -> None:
        try:
            rows = await self._data_store.query(
                "SELECT id, source_ip, source_cidr, device_id, description, last_seen_at, message_rate "
                "FROM syslog_source_mappings"
            )
            self._source_mappings = [
                SourceMapping(
                    id=r["id"],
                    source_ip=r["source_ip"],
                    source_cidr=r.get("source_cidr"),
                    device_id=r.get("device_id"),
                    description=r.get("description"),
                    last_seen_at=float(r["last_seen_at"]) if r.get("last_seen_at") else None,
                    message_rate=float(r.get("message_rate", 0)),
                )
                for r in rows
            ]
            logger.info("Loaded source mappings", count=len(self._source_mappings))
        except Exception as exc:
            logger.error("Failed to load source mappings", error=str(exc))
            self._source_mappings = []

    async def load_filter_rules(self) -> None:
        try:
            rows = await self._data_store.query(
                "SELECT id, name, pattern, pattern_type, extract_fields, priority, enabled "
                "FROM syslog_parse_rules WHERE pattern_type = 'filter' ORDER BY priority ASC"
            )
            self._filter_rules = []
            for r in rows:
                fields = r["extract_fields"] if isinstance(r["extract_fields"], dict) else {}
                self._filter_rules.append(FilterRule(
                    id=r["id"],
                    name=r["name"],
                    source_ip=fields.get("source_ip"),
                    facility=int(fields["facility"]) if fields.get("facility") is not None else None,
                    severity_min=int(fields["severity_min"]) if fields.get("severity_min") is not None else None,
                    severity_max=int(fields["severity_max"]) if fields.get("severity_max") is not None else None,
                    keyword=fields.get("keyword"),
                    action=fields.get("action", "drop"),
                    enabled=r["enabled"],
                ))
            logger.info("Loaded filter rules", count=len(self._filter_rules))
        except Exception as exc:
            logger.error("Failed to load filter rules", error=str(exc))
            self._filter_rules = []

    # ─── CRUD helpers ───

    async def add_parse_rule(self, name: str, pattern: str, pattern_type: str,
                             extract_fields: list[str], priority: int, enabled: bool = True) -> ParseRule:
        rule_id = str(uuid.uuid4())
        import json
        await self._data_store.execute(
            "INSERT INTO syslog_parse_rules (id, name, pattern, pattern_type, extract_fields, priority, enabled) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
            (rule_id, name, pattern, pattern_type, json.dumps(extract_fields), priority, enabled),
        )
        rule = ParseRule(id=rule_id, name=name, pattern=pattern, pattern_type=pattern_type,
                         extract_fields=extract_fields, priority=priority, enabled=enabled)
        self._parse_rules.append(rule)
        self._parse_rules.sort(key=lambda r: r.priority)
        return rule

    async def remove_parse_rule(self, rule_id: str) -> bool:
        count = await self._data_store.execute(
            "DELETE FROM syslog_parse_rules WHERE id = $1", (rule_id,)
        )
        if count > 0:
            self._parse_rules = [r for r in self._parse_rules if r.id != rule_id]
            return True
        return False

    async def add_source_mapping(self, source_ip: str, source_cidr: str | None = None,
                                 device_id: str | None = None, description: str | None = None) -> SourceMapping:
        mapping_id = str(uuid.uuid4())
        await self._data_store.execute(
            "INSERT INTO syslog_source_mappings (id, source_ip, source_cidr, device_id, description, message_rate) "
            "VALUES ($1, $2, $3, $4, $5, $6)",
            (mapping_id, source_ip, source_cidr, device_id, description, 0),
        )
        mapping = SourceMapping(id=mapping_id, source_ip=source_ip, source_cidr=source_cidr,
                                device_id=device_id, description=description, last_seen_at=None, message_rate=0)
        self._source_mappings.append(mapping)
        return mapping

    async def remove_source_mapping(self, mapping_id: str) -> bool:
        count = await self._data_store.execute(
            "DELETE FROM syslog_source_mappings WHERE id = $1", (mapping_id,)
        )
        if count > 0:
            self._source_mappings = [m for m in self._source_mappings if m.id != mapping_id]
            return True
        return False

    async def add_filter_rule(self, name: str, source_ip: str | None = None,
                              facility: int | None = None, severity_min: int | None = None,
                              severity_max: int | None = None, keyword: str | None = None,
                              action: str = "drop", enabled: bool = True) -> FilterRule:
        rule_id = str(uuid.uuid4())
        import json
        fields = {
            "source_ip": source_ip, "facility": facility,
            "severity_min": severity_min, "severity_max": severity_max,
            "keyword": keyword, "action": action,
        }
        await self._data_store.execute(
            "INSERT INTO syslog_parse_rules (id, name, pattern, pattern_type, extract_fields, priority, enabled) "
            "VALUES ($1, $2, $3, 'filter', $4, $5, $6)",
            (rule_id, name, "", json.dumps(fields), 0, enabled),
        )
        rule = FilterRule(id=rule_id, name=name, source_ip=source_ip, facility=facility,
                          severity_min=severity_min, severity_max=severity_max,
                          keyword=keyword, action=action, enabled=enabled)
        self._filter_rules.append(rule)
        return rule

    async def remove_filter_rule(self, rule_id: str) -> bool:
        count = await self._data_store.execute(
            "DELETE FROM syslog_parse_rules WHERE id = $1 AND pattern_type = 'filter'", (rule_id,)
        )
        if count > 0:
            self._filter_rules = [r for r in self._filter_rules if r.id != rule_id]
            return True
        return False

    async def reload_rules(self) -> None:
        await self.load_parse_rules()
        await self.load_source_mappings()
        await self.load_filter_rules()

    # ─── Accessors ───

    def get_parse_rules(self) -> list[ParseRule]:
        return list(self._parse_rules)

    def get_source_mappings(self) -> list[SourceMapping]:
        return list(self._source_mappings)

    def get_filter_rules(self) -> list[FilterRule]:
        return list(self._filter_rules)

    def get_config(self) -> SyslogManagerConfig:
        return SyslogManagerConfig(
            udp_port=self._config.udp_port,
            tcp_port=self._config.tcp_port,
            enabled=self._config.enabled,
        )
