/**
 * SyslogManager — 可配置 Syslog 接收、解析、来源管理与 EventBus 集成
 *
 * 功能：
 * - UDP/TCP 双协议监听（可配置端口）                    (D2.8)
 * - 多格式自动识别（RFC 3164、RFC 5424）                (D2.9)
 * - 可配置解析规则引擎（正则/Grok）                     (D2.10)
 * - 来源管理（IP → deviceId 映射、未知来源告警、来源统计）(D2.11)
 *   匹配优先级：精确 source_ip > source_cidr（最长前缀优先）
 * - Syslog → PerceptionEvent 转换（severity → priority） (D2.12)
 * - 消息过滤规则（来源 IP/facility/severity/关键词）      (D2.13)
 * - 解析规则、来源映射、过滤规则持久化到 PostgreSQL       (D2.14)
 */

import dgram from 'dgram';
import net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger';
import type { DataStore } from '../dataStore';
import {
  EventBus,
  type PerceptionEvent,
  type Priority,
} from '../eventBus';

// ─── Severity → Priority 映射 (per task spec) ───

const SEVERITY_TO_PRIORITY: Record<number, Priority> = {
  0: 'critical', // Emergency
  1: 'critical', // Alert
  2: 'high',     // Critical
  3: 'high',     // Error
  4: 'medium',   // Warning
  5: 'low',      // Notice
  6: 'low',      // Info
  7: 'info',     // Debug
};

// ─── Facility 名称 ───

const FACILITY_NAMES: Record<number, string> = {
  0: 'kern', 1: 'user', 2: 'mail', 3: 'daemon', 4: 'auth',
  5: 'syslog', 6: 'lpr', 7: 'news', 8: 'uucp', 9: 'cron',
  10: 'authpriv', 11: 'ftp', 12: 'ntp', 13: 'security',
  14: 'console', 15: 'solaris-cron',
  16: 'local0', 17: 'local1', 18: 'local2', 19: 'local3',
  20: 'local4', 21: 'local5', 22: 'local6', 23: 'local7',
};

// ─── Types ───

export interface SyslogManagerConfig {
  udpPort: number;
  tcpPort: number;
  enabled: boolean;
}

export interface ParsedSyslog {
  facility: number;
  facilityName: string;
  severity: number;
  timestamp: Date;
  hostname: string;
  appName: string;
  procId: string;
  msgId: string;
  structuredData: string;
  message: string;
  format: 'rfc3164' | 'rfc5424' | 'custom';
  raw: string;
  /** Fields extracted by custom parse rules */
  extractedFields: Record<string, string>;
}

export interface ParseRule {
  id: string;
  name: string;
  pattern: string;
  patternType: 'regex' | 'grok';
  extractFields: string[];
  priority: number;
  enabled: boolean;
}

export interface SourceMapping {
  id: string;
  sourceIp: string;
  sourceCidr: string | null;
  deviceId: string | null;
  description: string | null;
  lastSeenAt: Date | null;
  messageRate: number;
}

export interface FilterRule {
  id: string;
  name: string;
  sourceIp: string | null;
  facility: number | null;
  severityMin: number | null;
  severityMax: number | null;
  keyword: string | null;
  action: 'drop' | 'allow';
  enabled: boolean;
}

/** Per-source statistics kept in memory */
interface SourceStats {
  messageCount: number;
  lastSeenAt: number;
  /** Messages in the last 60 s window */
  recentTimestamps: number[];
}

// ─── Grok-like pattern expansion ───

const GROK_PATTERNS: Record<string, string> = {
  '%{IP}': '(?<ip>\\d{1,3}(?:\\.\\d{1,3}){3})',
  '%{WORD}': '(?<word>\\S+)',
  '%{INT}': '(?<int>\\d+)',
  '%{GREEDYDATA}': '(?<greedydata>.*)',
  '%{HOSTNAME}': '(?<hostname>[a-zA-Z0-9._-]+)',
  '%{SYSLOGPRI}': '(?:<(?<pri>\\d{1,3})>)',
};

function expandGrokPattern(pattern: string): string {
  let expanded = pattern;
  // Support named captures: %{PATTERN:fieldName}
  expanded = expanded.replace(/%\{(\w+):(\w+)\}/g, (_match, patName, fieldName) => {
    const base = GROK_PATTERNS[`%{${patName}}`];
    if (!base) return `(?<${fieldName}>\\S+)`;
    // Replace the default group name with the user-specified field name
    return base.replace(/\(\?<\w+>/, `(?<${fieldName}>`);
  });
  // Expand unnamed grok tokens
  for (const [token, regex] of Object.entries(GROK_PATTERNS)) {
    expanded = expanded.split(token).join(regex);
  }
  return expanded;
}

// ─── CIDR helpers ───

/**
 * Parse an IPv4 address into a 32-bit number.
 */
function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Check if `ip` falls within `cidr` (e.g. "192.168.1.0/24").
 * Returns the prefix length if it matches, or -1 if not.
 */
function matchCidr(ip: string, cidr: string): number {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return -1;

  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(network);
  if (ipNum === -1 || netNum === -1) return -1;

  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (netNum & mask) ? prefix : -1;
}

// ─── SyslogManager ───

export class SyslogManager {
  private udpServer: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
  private running = false;

  private parseRules: ParseRule[] = [];
  private sourceMappings: SourceMapping[] = [];
  private filterRules: FilterRule[] = [];

  /** In-memory per-source stats */
  private sourceStats: Map<string, SourceStats> = new Map();
  private statsCleanupTimer: NodeJS.Timeout | null = null;

  private config: SyslogManagerConfig = {
    udpPort: 514,
    tcpPort: 514,
    enabled: true,
  };

  constructor(
    private readonly dataStore: DataStore,
    private readonly eventBus: EventBus,
  ) {}

  // ─── Lifecycle ───

  /**
   * Start the Syslog Manager: load rules from PostgreSQL, register as
   * perception source, and begin listening on UDP + TCP.
   */
  async start(config?: Partial<SyslogManagerConfig>): Promise<void> {
    if (this.running) {
      logger.warn('[SyslogManager] Already running');
      return;
    }

    if (config) {
      this.config = { ...this.config, ...config };
    }

    if (!this.config.enabled) {
      logger.info('[SyslogManager] Disabled by config');
      return;
    }

    // Load persisted rules from PostgreSQL (D2.14)
    await this.loadParseRules();
    await this.loadSourceMappings();
    await this.loadFilterRules();

    // Register as perception source on EventBus (D1.2)
    this.eventBus.registerSource({
      name: 'syslog-manager',
      eventTypes: ['syslog'],
      schemaVersion: '1.0.0',
    });

    // Start listeners
    await this.startUdp();
    await this.startTcp();
    this.startStatsCleanup();

    this.running = true;
    logger.info(
      `[SyslogManager] Started — UDP :${this.config.udpPort}, TCP :${this.config.tcpPort}`,
    );
  }

  /**
   * Gracefully stop both listeners.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.statsCleanupTimer) {
      clearInterval(this.statsCleanupTimer);
      this.statsCleanupTimer = null;
    }

    if (this.udpServer) {
      try { this.udpServer.close(); } catch { /* ignore */ }
      this.udpServer = null;
    }

    if (this.tcpServer) {
      try { this.tcpServer.close(); } catch { /* ignore */ }
      this.tcpServer = null;
    }

    this.running = false;
    logger.info('[SyslogManager] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── UDP listener ───

  private startUdp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpServer = dgram.createSocket('udp4');

      this.udpServer.on('message', (msg, rinfo) => {
        this.handleRawMessage(msg.toString('utf-8'), rinfo.address).catch((err) => {
          logger.error('[SyslogManager] UDP message handling error:', err);
        });
      });

      this.udpServer.on('error', (err) => {
        logger.error('[SyslogManager] UDP server error:', err);
      });

      this.udpServer.bind(this.config.udpPort, () => {
        logger.info(`[SyslogManager] UDP listening on :${this.config.udpPort}`);
        resolve();
      });

      this.udpServer.once('error', reject);
    });
  }

  // ─── TCP listener ───

  private startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        const remoteIp = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          // Syslog over TCP: messages delimited by newline
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            this.handleRawMessage(trimmed, remoteIp).catch((err) => {
              logger.error('[SyslogManager] TCP message handling error:', err);
            });
          }
        });

        socket.on('error', (err) => {
          logger.debug(`[SyslogManager] TCP client error from ${remoteIp}: ${err.message}`);
        });
      });

      this.tcpServer.on('error', (err) => {
        logger.error('[SyslogManager] TCP server error:', err);
      });

      this.tcpServer.listen(this.config.tcpPort, () => {
        logger.info(`[SyslogManager] TCP listening on :${this.config.tcpPort}`);
        resolve();
      });

      this.tcpServer.once('error', reject);
    });
  }

  // ─── Core message pipeline ───

  /**
   * Central entry point for every raw syslog message (UDP or TCP).
   *
   * Pipeline: parse → filter → resolve source → convert → publish
   */
  async handleRawMessage(raw: string, sourceIp: string): Promise<void> {
    // 1. Parse
    const parsed = this.parse(raw, sourceIp);
    if (!parsed) {
      logger.debug(`[SyslogManager] Failed to parse message from ${sourceIp}: ${raw.substring(0, 120)}`);
      return;
    }

    // 2. Filter (D2.13)
    if (this.shouldFilter(parsed, sourceIp)) {
      return;
    }

    // 3. Resolve source (D2.11)
    const { deviceId, known } = this.resolveSource(sourceIp);

    // Update in-memory stats
    this.updateSourceStats(sourceIp);

    // Unknown source → publish an internal alert event
    if (!known) {
      this.eventBus.publish({
        type: 'internal',
        priority: 'low',
        source: 'syslog-manager',
        timestamp: Date.now(),
        payload: {
          alert: 'unknown_syslog_source',
          sourceIp,
          message: parsed.message.substring(0, 200),
        },
        schemaVersion: '1.0.0',
      }).catch((err) => {
        logger.error('[SyslogManager] Failed to publish unknown-source alert:', err);
      });
    }

    // 4. Convert to PerceptionEvent (D2.12)
    const event = this.toPerceptionEvent(parsed, sourceIp, deviceId);

    // 5. Publish to EventBus
    await this.eventBus.publish(event);
  }

  // ─── Parsing ───

  /**
   * Parse a raw syslog string. Auto-detects RFC 5424 vs 3164, then
   * applies custom parse rules (regex / grok) for field extraction. (D2.9, D2.10)
   */
  parse(raw: string, sourceIp: string): ParsedSyslog | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('<')) return null;

    const format = this.detectFormat(trimmed);
    let parsed: ParsedSyslog | null = null;

    if (format === 'rfc5424') {
      parsed = this.parseRFC5424(trimmed);
    }
    if (!parsed) {
      parsed = this.parseRFC3164(trimmed);
    }
    if (!parsed) return null;

    // Apply custom parse rules (D2.10)
    this.applyParseRules(parsed);

    return parsed;
  }

  /**
   * Detect whether the message is RFC 5424 (has version digit after PRI)
   * or RFC 3164 / custom.
   */
  private detectFormat(raw: string): 'rfc3164' | 'rfc5424' | 'custom' {
    // RFC 5424: <PRI>VERSION SP ...  where VERSION is a non-zero digit
    if (/^<\d{1,3}>\d+\s/.test(raw)) return 'rfc5424';
    if (/^<\d{1,3}>/.test(raw)) return 'rfc3164';
    return 'custom';
  }

  /**
   * Parse RFC 3164 (BSD Syslog).
   * Format: <PRI>TIMESTAMP HOSTNAME MESSAGE
   */
  private parseRFC3164(raw: string): ParsedSyslog | null {
    const priMatch = raw.match(/^<(\d{1,3})>/);
    if (!priMatch) return null;

    const pri = parseInt(priMatch[1], 10);
    const facility = Math.floor(pri / 8);
    const severity = pri % 8;
    const remaining = raw.substring(priMatch[0].length);

    // Timestamp: "MMM DD HH:MM:SS" or "MMM  D HH:MM:SS"
    const tsMatch = remaining.match(
      /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+/i,
    );

    let timestamp: Date;
    let afterTs: string;

    if (tsMatch) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const mi = months.findIndex((m) => m.toLowerCase() === tsMatch[1].toLowerCase());
      const now = new Date();
      timestamp = new Date(
        now.getFullYear(),
        mi >= 0 ? mi : 0,
        parseInt(tsMatch[2], 10),
        parseInt(tsMatch[3], 10),
        parseInt(tsMatch[4], 10),
        parseInt(tsMatch[5], 10),
      );
      if (timestamp > now) timestamp.setFullYear(now.getFullYear() - 1);
      afterTs = remaining.substring(tsMatch[0].length);
    } else {
      timestamp = new Date();
      afterTs = remaining;
    }

    // HOSTNAME + MESSAGE
    const spaceIdx = afterTs.indexOf(' ');
    const hostname = spaceIdx > 0 ? afterTs.substring(0, spaceIdx) : afterTs;
    const message = spaceIdx > 0 ? afterTs.substring(spaceIdx + 1) : '';

    return {
      facility,
      facilityName: FACILITY_NAMES[facility] ?? `facility${facility}`,
      severity,
      timestamp,
      hostname,
      appName: '-',
      procId: '-',
      msgId: '-',
      structuredData: '-',
      message,
      format: 'rfc3164',
      raw,
      extractedFields: {},
    };
  }

  /**
   * Parse RFC 5424 (Structured Syslog).
   * Format: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP SD MSG
   */
  private parseRFC5424(raw: string): ParsedSyslog | null {
    const headerMatch = raw.match(/^<(\d{1,3})>(\d+)\s+/);
    if (!headerMatch) return null;

    const pri = parseInt(headerMatch[1], 10);
    const facility = Math.floor(pri / 8);
    const severity = pri % 8;
    const remaining = raw.substring(headerMatch[0].length);

    // Split the 6 header fields: TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD
    // We parse them one by one to handle NILVALUE "-"
    const parts = this.splitRFC5424Header(remaining);
    if (!parts) return null;

    let timestamp: Date;
    if (parts.timestamp === '-') {
      timestamp = new Date();
    } else {
      timestamp = new Date(parts.timestamp);
      if (isNaN(timestamp.getTime())) timestamp = new Date();
    }

    return {
      facility,
      facilityName: FACILITY_NAMES[facility] ?? `facility${facility}`,
      severity,
      timestamp,
      hostname: parts.hostname !== '-' ? parts.hostname : 'unknown',
      appName: parts.appName,
      procId: parts.procId,
      msgId: parts.msgId,
      structuredData: parts.sd,
      message: parts.msg,
      format: 'rfc5424',
      raw,
      extractedFields: {},
    };
  }

  /**
   * Split the RFC 5424 header into its constituent parts.
   */
  private splitRFC5424Header(s: string): {
    timestamp: string; hostname: string; appName: string;
    procId: string; msgId: string; sd: string; msg: string;
  } | null {
    const tokens: string[] = [];
    let pos = 0;

    // Extract 5 space-delimited tokens: TIMESTAMP HOSTNAME APP-NAME PROCID MSGID
    for (let i = 0; i < 5; i++) {
      const spaceIdx = s.indexOf(' ', pos);
      if (spaceIdx === -1) return null;
      tokens.push(s.substring(pos, spaceIdx));
      pos = spaceIdx + 1;
    }

    // Structured data: either "-" or "[...]" (possibly multiple)
    let sd = '-';
    let msgStart = pos;
    const rest = s.substring(pos);

    if (rest.startsWith('-')) {
      sd = '-';
      msgStart = pos + 1;
      if (s[msgStart] === ' ') msgStart++;
    } else if (rest.startsWith('[')) {
      // Find the end of all SD elements
      let depth = 0;
      let sdEnd = 0;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '[') depth++;
        else if (rest[i] === ']') {
          depth--;
          if (depth === 0) { sdEnd = i + 1; }
        }
      }
      sd = rest.substring(0, sdEnd);
      msgStart = pos + sdEnd;
      if (s[msgStart] === ' ') msgStart++;
    }

    const msg = s.substring(msgStart);

    return {
      timestamp: tokens[0],
      hostname: tokens[1],
      appName: tokens[2],
      procId: tokens[3],
      msgId: tokens[4],
      sd,
      msg,
    };
  }

  /**
   * Apply custom parse rules (regex / grok) to extract additional fields. (D2.10)
   */
  private applyParseRules(parsed: ParsedSyslog): void {
    // Rules are sorted by priority (lower number = higher priority)
    const enabledRules = this.parseRules
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const rule of enabledRules) {
      try {
        let regexStr = rule.pattern;
        if (rule.patternType === 'grok') {
          regexStr = expandGrokPattern(rule.pattern);
        }
        const regex = new RegExp(regexStr);
        const match = regex.exec(parsed.message);
        if (match?.groups) {
          for (const [key, value] of Object.entries(match.groups)) {
            if (value !== undefined) {
              parsed.extractedFields[key] = value;
            }
          }
          // First matching rule wins
          return;
        }
      } catch (err) {
        logger.warn(`[SyslogManager] Parse rule "${rule.name}" regex error:`, err);
      }
    }
  }

  // ─── Source management (D2.11) ───

  /**
   * Resolve a source IP to a deviceId.
   *
   * Priority:
   *  1. Exact source_ip match
   *  2. source_cidr match — longest prefix wins
   */
  resolveSource(sourceIp: string): { deviceId: string | undefined; known: boolean } {
    // 1. Exact IP match
    const exact = this.sourceMappings.find(
      (m) => m.sourceIp === sourceIp && !m.sourceCidr,
    );
    if (exact) {
      return { deviceId: exact.deviceId ?? undefined, known: true };
    }

    // 2. CIDR match — longest prefix
    let bestMatch: SourceMapping | null = null;
    let bestPrefix = -1;

    for (const mapping of this.sourceMappings) {
      if (!mapping.sourceCidr) continue;
      const prefix = matchCidr(sourceIp, mapping.sourceCidr);
      if (prefix > bestPrefix) {
        bestPrefix = prefix;
        bestMatch = mapping;
      }
    }

    if (bestMatch) {
      return { deviceId: bestMatch.deviceId ?? undefined, known: true };
    }

    return { deviceId: undefined, known: false };
  }

  // ─── Conversion (D2.12) ───

  /**
   * Convert a parsed syslog message into a PerceptionEvent.
   */
  private toPerceptionEvent(
    parsed: ParsedSyslog,
    sourceIp: string,
    deviceId?: string,
  ): Omit<PerceptionEvent, 'id' | 'timestamp'> {
    const priority = SEVERITY_TO_PRIORITY[parsed.severity] ?? 'low';

    return {
      type: 'syslog',
      priority,
      source: `syslog:${sourceIp}`,
      deviceId,
      payload: {
        facility: parsed.facility,
        facilityName: parsed.facilityName,
        severity: parsed.severity,
        hostname: parsed.hostname,
        appName: parsed.appName,
        procId: parsed.procId,
        msgId: parsed.msgId,
        structuredData: parsed.structuredData,
        message: parsed.message,
        format: parsed.format,
        extractedFields: parsed.extractedFields,
        sourceIp,
      },
      schemaVersion: '1.0.0',
    };
  }

  // ─── Filtering (D2.13) ───

  /**
   * Determine whether a parsed message should be filtered (dropped).
   */
  private shouldFilter(parsed: ParsedSyslog, sourceIp: string): boolean {
    const enabledFilters = this.filterRules.filter((f) => f.enabled);
    if (enabledFilters.length === 0) return false;

    for (const rule of enabledFilters) {
      const matches = this.matchesFilter(rule, parsed, sourceIp);
      if (matches) {
        return rule.action === 'drop';
      }
    }
    return false;
  }

  private matchesFilter(rule: FilterRule, parsed: ParsedSyslog, sourceIp: string): boolean {
    // All non-null conditions must match (AND logic)
    if (rule.sourceIp !== null && rule.sourceIp !== sourceIp) return false;
    if (rule.facility !== null && rule.facility !== parsed.facility) return false;
    if (rule.severityMin !== null && parsed.severity < rule.severityMin) return false;
    if (rule.severityMax !== null && parsed.severity > rule.severityMax) return false;
    if (rule.keyword !== null && !parsed.message.toLowerCase().includes(rule.keyword.toLowerCase())) return false;
    return true;
  }

  // ─── Source stats ───

  private updateSourceStats(sourceIp: string): void {
    const now = Date.now();
    let stats = this.sourceStats.get(sourceIp);
    if (!stats) {
      stats = { messageCount: 0, lastSeenAt: now, recentTimestamps: [] };
      this.sourceStats.set(sourceIp, stats);
    }
    stats.messageCount++;
    stats.lastSeenAt = now;
    // Keep only timestamps within the last 60 s for rate calculation
    stats.recentTimestamps.push(now);
    const cutoff = now - 60_000;
    stats.recentTimestamps = stats.recentTimestamps.filter((t) => t >= cutoff);
  }

  /**
   * Start periodic cleanup of stale sourceStats entries (lastSeenAt > 24h).
   * Runs every hour; timer is unref'd so it won't prevent process exit.
   */
  private startStatsCleanup(): void {
    const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
    const MAX_AGE = 24 * 60 * 60 * 1000;     // 24 hours
    this.statsCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, stats] of this.sourceStats) {
        if (now - stats.lastSeenAt > MAX_AGE) {
          this.sourceStats.delete(ip);
        }
      }
    }, CLEANUP_INTERVAL);
    this.statsCleanupTimer.unref();
  }

  /**
   * Get per-source statistics.
   */
  getSourceStats(): Map<string, { messageCount: number; lastSeenAt: number; messageRate: number }> {
    const result = new Map<string, { messageCount: number; lastSeenAt: number; messageRate: number }>();
    const now = Date.now();
    for (const [ip, stats] of this.sourceStats) {
      const cutoff = now - 60_000;
      const recent = stats.recentTimestamps.filter((t) => t >= cutoff);
      result.set(ip, {
        messageCount: stats.messageCount,
        lastSeenAt: stats.lastSeenAt,
        messageRate: recent.length, // messages per minute
      });
    }
    return result;
  }

  // ─── PostgreSQL persistence (D2.14) ───

  /**
   * Load parse rules from `syslog_parse_rules` table.
   */
  async loadParseRules(): Promise<void> {
    try {
      const rows = await this.dataStore.query<{
        id: string; name: string; pattern: string;
        pattern_type: string; extract_fields: string[];
        priority: number; enabled: boolean;
      }>(
        `SELECT id, name, pattern, pattern_type, extract_fields, priority, enabled
         FROM syslog_parse_rules ORDER BY priority ASC`,
      );
      this.parseRules = rows.map((r) => ({
        id: r.id,
        name: r.name,
        pattern: r.pattern,
        patternType: r.pattern_type as 'regex' | 'grok',
        extractFields: Array.isArray(r.extract_fields) ? r.extract_fields : [],
        priority: r.priority,
        enabled: r.enabled,
      }));
      logger.info(`[SyslogManager] Loaded ${this.parseRules.length} parse rules`);
    } catch (err) {
      logger.error('[SyslogManager] Failed to load parse rules:', err);
      this.parseRules = [];
    }
  }

  /**
   * Load source mappings from `syslog_source_mappings` table.
   */
  async loadSourceMappings(): Promise<void> {
    try {
      const rows = await this.dataStore.query<{
        id: string; source_ip: string; source_cidr: string | null;
        device_id: string | null; description: string | null;
        last_seen_at: string | null; message_rate: number;
      }>(
        `SELECT id, source_ip, source_cidr, device_id, description, last_seen_at, message_rate
         FROM syslog_source_mappings`,
      );
      this.sourceMappings = rows.map((r) => ({
        id: r.id,
        sourceIp: r.source_ip,
        sourceCidr: r.source_cidr,
        deviceId: r.device_id,
        description: r.description,
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : null,
        messageRate: r.message_rate ?? 0,
      }));
      logger.info(`[SyslogManager] Loaded ${this.sourceMappings.length} source mappings`);
    } catch (err) {
      logger.error('[SyslogManager] Failed to load source mappings:', err);
      this.sourceMappings = [];
    }
  }

  /**
   * Load filter rules from a `syslog_filter_rules` config stored in
   * the `syslog_parse_rules` table with pattern_type = 'filter'.
   *
   * Since there is no dedicated filter_rules table, we store filter rules
   * as JSON in the parse_rules table with a special pattern_type, or
   * alternatively in a JSONB config. For simplicity and to avoid schema
   * changes, we store them as parse rules with pattern_type='filter'
   * and the filter config in extract_fields as JSON.
   */
  async loadFilterRules(): Promise<void> {
    try {
      const rows = await this.dataStore.query<{
        id: string; name: string; pattern: string;
        pattern_type: string; extract_fields: Record<string, unknown>;
        priority: number; enabled: boolean;
      }>(
        `SELECT id, name, pattern, pattern_type, extract_fields, priority, enabled
         FROM syslog_parse_rules WHERE pattern_type = 'filter' ORDER BY priority ASC`,
      );
      this.filterRules = rows.map((r) => {
        const fields = r.extract_fields as Record<string, unknown>;
        return {
          id: r.id,
          name: r.name,
          sourceIp: (fields.source_ip as string) ?? null,
          facility: fields.facility != null ? Number(fields.facility) : null,
          severityMin: fields.severity_min != null ? Number(fields.severity_min) : null,
          severityMax: fields.severity_max != null ? Number(fields.severity_max) : null,
          keyword: (fields.keyword as string) ?? null,
          action: ((fields.action as string) ?? 'drop') as 'drop' | 'allow',
          enabled: r.enabled,
        };
      });
      logger.info(`[SyslogManager] Loaded ${this.filterRules.length} filter rules`);
    } catch (err) {
      logger.error('[SyslogManager] Failed to load filter rules:', err);
      this.filterRules = [];
    }
  }

  // ─── CRUD helpers for runtime updates (D2.14) ───

  async addParseRule(rule: Omit<ParseRule, 'id'>): Promise<ParseRule> {
    const id = uuidv4();
    await this.dataStore.execute(
      `INSERT INTO syslog_parse_rules (id, name, pattern, pattern_type, extract_fields, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, rule.name, rule.pattern, rule.patternType, JSON.stringify(rule.extractFields), rule.priority, rule.enabled],
    );
    const newRule: ParseRule = { ...rule, id };
    this.parseRules.push(newRule);
    this.parseRules.sort((a, b) => a.priority - b.priority);
    return newRule;
  }

  async removeParseRule(id: string): Promise<boolean> {
    const { rowCount } = await this.dataStore.execute(
      `DELETE FROM syslog_parse_rules WHERE id = $1`,
      [id],
    );
    if (rowCount > 0) {
      this.parseRules = this.parseRules.filter((r) => r.id !== id);
      return true;
    }
    return false;
  }

  async addSourceMapping(mapping: Omit<SourceMapping, 'id'>): Promise<SourceMapping> {
    const id = uuidv4();
    await this.dataStore.execute(
      `INSERT INTO syslog_source_mappings (id, source_ip, source_cidr, device_id, description, message_rate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, mapping.sourceIp, mapping.sourceCidr, mapping.deviceId, mapping.description, mapping.messageRate],
    );
    const newMapping: SourceMapping = { ...mapping, id };
    this.sourceMappings.push(newMapping);
    return newMapping;
  }

  async removeSourceMapping(id: string): Promise<boolean> {
    const { rowCount } = await this.dataStore.execute(
      `DELETE FROM syslog_source_mappings WHERE id = $1`,
      [id],
    );
    if (rowCount > 0) {
      this.sourceMappings = this.sourceMappings.filter((m) => m.id !== id);
      return true;
    }
    return false;
  }

  async addFilterRule(rule: Omit<FilterRule, 'id'>): Promise<FilterRule> {
    const id = uuidv4();
    const fields = {
      source_ip: rule.sourceIp,
      facility: rule.facility,
      severity_min: rule.severityMin,
      severity_max: rule.severityMax,
      keyword: rule.keyword,
      action: rule.action,
    };
    await this.dataStore.execute(
      `INSERT INTO syslog_parse_rules (id, name, pattern, pattern_type, extract_fields, priority, enabled)
       VALUES ($1, $2, $3, 'filter', $4, $5, $6)`,
      [id, rule.name, '', JSON.stringify(fields), 0, rule.enabled],
    );
    const newRule: FilterRule = { ...rule, id };
    this.filterRules.push(newRule);
    return newRule;
  }

  async removeFilterRule(id: string): Promise<boolean> {
    const { rowCount } = await this.dataStore.execute(
      `DELETE FROM syslog_parse_rules WHERE id = $1 AND pattern_type = 'filter'`,
      [id],
    );
    if (rowCount > 0) {
      this.filterRules = this.filterRules.filter((r) => r.id !== id);
      return true;
    }
    return false;
  }

  /**
   * Reload all rules from PostgreSQL (useful after external DB changes).
   */
  async reloadRules(): Promise<void> {
    await this.loadParseRules();
    await this.loadSourceMappings();
    await this.loadFilterRules();
  }

  // ─── Accessors (for testing / management UI) ───

  getParseRules(): ParseRule[] {
    return [...this.parseRules];
  }

  getSourceMappings(): SourceMapping[] {
    return [...this.sourceMappings];
  }

  getFilterRules(): FilterRule[] {
    return [...this.filterRules];
  }

  getConfig(): SyslogManagerConfig {
    return { ...this.config };
  }
}
