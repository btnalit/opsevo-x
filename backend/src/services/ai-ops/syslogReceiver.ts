/**
 * SyslogReceiver - Syslog 接收服务
 * 负责监听 UDP 端口接收 RouterOS 设备推送的 Syslog 日志
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7
 * - 1.1: 绑定 UDP 端口监听传入消息
 * - 1.2: 解析 Syslog 消息，提取 facility、severity、timestamp 和消息内容
 * - 1.3: 正确识别 RouterOS 特定格式，包括 topic 和消息体
 * - 1.4: 将有效的 Syslog 消息转换为内部事件格式
 * - 1.5: 处理格式错误的消息，记录错误并继续处理后续消息
 * - 1.7: 支持通过配置设置监听端口
 */

import dgram from 'dgram';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  SyslogMessage,
  SyslogReceiverConfig,
  SyslogEvent,
  AlertSeverity,
  ISyslogReceiver,
} from '../../types/ai-ops';
import { DeviceManager } from '../device/deviceManager';
import { logger } from '../../utils/logger';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops', 'enhancement', 'syslog');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// 移除 EVENTS_DIR - Syslog 事件现在通过 AlertEngine 统一存储
// Requirements: syslog-alert-integration 1.1, 6.1

/**
 * Syslog Facility 名称映射
 */
const FACILITY_NAMES: Record<number, string> = {
  0: 'kern',
  1: 'user',
  2: 'mail',
  3: 'daemon',
  4: 'auth',
  5: 'syslog',
  6: 'lpr',
  7: 'news',
  8: 'uucp',
  9: 'cron',
  10: 'authpriv',
  11: 'ftp',
  12: 'ntp',
  13: 'security',
  14: 'console',
  15: 'solaris-cron',
  16: 'local0',
  17: 'local1',
  18: 'local2',
  19: 'local3',
  20: 'local4',
  21: 'local5',
  22: 'local6',
  23: 'local7',
};

/**
 * Syslog Severity 到 AlertSeverity 的映射
 * Syslog severity: 0=Emergency, 1=Alert, 2=Critical, 3=Error, 4=Warning, 5=Notice, 6=Info, 7=Debug
 */
function mapSyslogSeverityToAlertSeverity(syslogSeverity: number): AlertSeverity {
  switch (syslogSeverity) {
    case 0: // Emergency
      return 'emergency';
    case 1: // Alert
    case 2: // Critical
      return 'critical';
    case 3: // Error
    case 4: // Warning
      return 'warning';
    case 5: // Notice
    case 6: // Informational
    case 7: // Debug
    default:
      return 'info';
  }
}

/**
 * 从消息内容中检测严重级别
 * 用于增强 syslog severity 的判断，特别是当消息内容包含明确的错误关键字时
 */
function detectSeverityFromMessage(message: string, baseSeverity: AlertSeverity): AlertSeverity {
  const lowerMessage = message.toLowerCase();

  // 紧急/严重错误关键字
  if (/\b(emergency|fatal|panic|crash)\b/.test(lowerMessage)) {
    return 'emergency';
  }

  // 严重错误关键字
  if (/\b(critical|severe|failure|failed|down)\b/.test(lowerMessage)) {
    return 'critical';
  }

  // 错误关键字 - 提升到 warning 或保持 critical
  if (/\b(error|err|exception|timeout|refused|denied|rejected)\b/.test(lowerMessage)) {
    // 如果基础严重级别已经是 critical 或 emergency，保持不变
    if (baseSeverity === 'critical' || baseSeverity === 'emergency') {
      return baseSeverity;
    }
    return 'warning';
  }

  // 警告关键字
  if (/\b(warning|warn|alert|caution)\b/.test(lowerMessage)) {
    if (baseSeverity === 'info') {
      return 'warning';
    }
  }

  return baseSeverity;
}

// getDateString 函数已移除 - 不再需要独立存储
// Requirements: syslog-alert-integration 6.1

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SyslogReceiverConfig = {
  port: 514,
  enabled: false,
};

/**
 * Syslog 处理统计信息
 */
export interface SyslogStats {
  /** 接收到的消息总数 */
  received: number;
  /** 解析成功的消息数 */
  parsed: number;
  /** 解析失败的消息数 */
  parseFailed: number;
  /** 入队成功的消息数 */
  enqueued: number;
  /** 入队失败的消息数（背压/队列满等） */
  enqueueFailed: number;
  /** 处理器错误数 */
  handlerErrors: number;
  /** 最后一条消息的时间戳 */
  lastMessageAt: number | null;
  /** 最后一条错误的时间戳 */
  lastErrorAt: number | null;
  /** 启动时间 */
  startedAt: number | null;
  /** 运行时长（毫秒） */
  uptimeMs: number;
}

export class SyslogReceiver implements ISyslogReceiver {
  private config: SyslogReceiverConfig = { ...DEFAULT_CONFIG };
  private socket: dgram.Socket | null = null;
  private running = false;
  private messageHandlers: Array<(event: SyslogEvent) => void> = [];
  private initialized = false;
  private deviceManager: DeviceManager | null = null;

  // 统计信息
  private stats: SyslogStats = {
    received: 0,
    parsed: 0,
    parseFailed: 0,
    enqueued: 0,
    enqueueFailed: 0,
    handlerErrors: 0,
    lastMessageAt: null,
    lastErrorAt: null,
    startedAt: null,
    uptimeMs: 0,
  };

  /**
   * 确保数据目录存在
   * Requirements: syslog-alert-integration 6.1 - 不再创建独立的事件目录
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      // 移除 EVENTS_DIR 创建 - Syslog 事件现在通过 AlertEngine 统一存储
    } catch (error) {
      logger.error('Failed to create syslog directories:', error);
    }
  }

  /**
   * 初始化服务
   */
  async initialize(deviceManager?: DeviceManager): Promise<void> {
    if (this.initialized) return;

    if (deviceManager) {
      this.deviceManager = deviceManager;
    }

    await this.ensureDataDir();
    await this.loadConfig();
    this.initialized = true;
    logger.info('SyslogReceiver initialized');
  }

  /**
   * 加载配置
   */
  private async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.config = { ...DEFAULT_CONFIG };
        await this.saveConfig();
      } else {
        logger.error('Failed to load syslog config:', error);
        this.config = { ...DEFAULT_CONFIG };
      }
    }
  }

  /**
   * 保存配置
   */
  private async saveConfig(): Promise<void> {
    await this.ensureDataDir();
    await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * 解析 RFC 3164 格式的 Syslog 消息
   * 格式: <PRI>TIMESTAMP HOSTNAME MESSAGE
   * 例如: <134>Jan 15 10:30:00 router1 system,info,account user admin logged in
   */
  private parseRFC3164(raw: string): SyslogMessage | null {
    // 匹配 PRI 部分 <数字>
    const priMatch = raw.match(/^<(\d{1,3})>/);
    if (!priMatch) {
      return null;
    }

    const pri = parseInt(priMatch[1], 10);
    const facility = Math.floor(pri / 8);
    const severity = pri % 8;

    // 剩余部分
    const remaining = raw.substring(priMatch[0].length);

    // 尝试解析时间戳 (RFC 3164 格式: MMM DD HH:MM:SS 或 MMM  D HH:MM:SS)
    const timestampMatch = remaining.match(
      /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+/i
    );

    let timestamp: Date;
    let afterTimestamp: string;

    if (timestampMatch) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthIndex = monthNames.findIndex(
        (m) => m.toLowerCase() === timestampMatch[1].toLowerCase()
      );
      const day = parseInt(timestampMatch[2], 10);
      const hour = parseInt(timestampMatch[3], 10);
      const minute = parseInt(timestampMatch[4], 10);
      const second = parseInt(timestampMatch[5], 10);

      const now = new Date();
      timestamp = new Date(now.getFullYear(), monthIndex >= 0 ? monthIndex : 0, day, hour, minute, second);

      // 如果解析出的日期在未来，可能是去年的日志
      if (timestamp > now) {
        timestamp.setFullYear(now.getFullYear() - 1);
      }

      afterTimestamp = remaining.substring(timestampMatch[0].length);
    } else {
      // 没有时间戳，使用当前时间
      timestamp = new Date();
      afterTimestamp = remaining;
    }

    // 解析 hostname 和消息
    const parts = afterTimestamp.split(/\s+/, 2);
    const hostname = parts[0] || 'unknown';
    const messageStart = afterTimestamp.indexOf(parts[1] || '');
    const fullMessage = messageStart >= 0 ? afterTimestamp.substring(messageStart) : afterTimestamp;

    // 解析 RouterOS 特定格式的 topic
    const { topic, message } = this.parseRouterOSMessage(fullMessage);

    return {
      facility,
      severity,
      timestamp,
      hostname,
      topic,
      message,
      raw,
    };
  }

  /**
   * 解析 RFC 5424 格式的 Syslog 消息
   * 格式: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
   * 例如: <134>1 2026-01-15T10:30:00.000Z router1 routeros - - - system,info user admin logged in
   */
  private parseRFC5424(raw: string): SyslogMessage | null {
    // 匹配 PRI 和 VERSION
    const headerMatch = raw.match(/^<(\d{1,3})>(\d+)\s+/);
    if (!headerMatch) {
      return null;
    }

    const pri = parseInt(headerMatch[1], 10);
    const facility = Math.floor(pri / 8);
    const severity = pri % 8;

    const remaining = raw.substring(headerMatch[0].length);

    // 解析 ISO 8601 时间戳
    const timestampMatch = remaining.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+/
    );

    let timestamp: Date;
    let afterTimestamp: string;

    if (timestampMatch) {
      timestamp = new Date(timestampMatch[1]);
      if (isNaN(timestamp.getTime())) {
        timestamp = new Date();
      }
      afterTimestamp = remaining.substring(timestampMatch[0].length);
    } else if (remaining.startsWith('-')) {
      // NILVALUE for timestamp
      timestamp = new Date();
      afterTimestamp = remaining.substring(2); // Skip "- "
    } else {
      timestamp = new Date();
      afterTimestamp = remaining;
    }

    // 解析 HOSTNAME APP-NAME PROCID MSGID
    const headerParts = afterTimestamp.split(/\s+/, 4);
    const hostname = headerParts[0] !== '-' ? headerParts[0] : 'unknown';

    // 找到消息部分（跳过 STRUCTURED-DATA）
    let messageStart = 0;
    for (let i = 0; i < 4 && messageStart < afterTimestamp.length; i++) {
      const spaceIndex = afterTimestamp.indexOf(' ', messageStart);
      if (spaceIndex === -1) break;
      messageStart = spaceIndex + 1;
    }

    // 跳过 STRUCTURED-DATA
    let fullMessage = afterTimestamp.substring(messageStart);
    if (fullMessage.startsWith('-')) {
      fullMessage = fullMessage.substring(2); // Skip "- "
    } else if (fullMessage.startsWith('[')) {
      // 跳过结构化数据
      const sdEnd = fullMessage.lastIndexOf(']');
      if (sdEnd !== -1) {
        fullMessage = fullMessage.substring(sdEnd + 1).trim();
      }
    }

    // 解析 RouterOS 特定格式的 topic
    const { topic, message } = this.parseRouterOSMessage(fullMessage);

    return {
      facility,
      severity,
      timestamp,
      hostname,
      topic,
      message,
      raw,
    };
  }

  /**
   * 解析 RouterOS 特定格式的消息
   * 支持多种格式:
   * 1. default 格式 (带冒号): topic1,topic2: message
   *    例如: system,info: user admin logged in
   * 2. BSD syslog 格式 (不带冒号): topic1,topic2 message
   *    例如: system,info user admin logged in
   * 3. 应用程序格式: app-name: message
   *    例如: app-cloudflared: download/extract error
   */
  private parseRouterOSMessage(fullMessage: string): { topic: string; message: string } {
    // 常见 RouterOS topics
    const routerOSTopics = [
      'system', 'info', 'warning', 'error', 'critical', 'debug',
      'firewall', 'dhcp', 'wireless', 'interface', 'ppp', 'l2tp',
      'pptp', 'sstp', 'ovpn', 'ipsec', 'ospf', 'bgp', 'rip',
      'account', 'hotspot', 'radius', 'snmp', 'ntp', 'dns',
      'web-proxy', 'script', 'scheduler', 'backup', 'certificate',
      'caps', 'capsman', 'lte', 'gps', 'ups', 'health', 'calc',
      'async', 'bfd', 'bridge', 'e-mail', 'event', 'igmp-proxy',
      'isdn', 'iscsi', 'kidcontrol', 'ldp', 'manager', 'mme',
      'mpls', 'pim', 'queue', 'raw', 'read', 'route', 'rsvp',
      'sertcp', 'smb', 'ssh', 'state', 'store', 'telephony',
      'tftp', 'timer', 'tr069-client', 'upnp', 'vrrp', 'watchdog',
      'write', 'gsm', 'lora', 'container', 'dot1x', 'eoip',
      'gre', 'ipip', 'l2mtu', 'mac-server', 'mac-winbox', 'mlag',
      'netwatch', 'poe', 'profiler', 'romon', 'rose-storage',
      'sms', 'sntp', 'ssh-server', 'swos', 'trafficgen', 'user',
      'vlan', 'wifiwave2', 'zerotier', 'pppoe', 'doh', 'app'
    ];

    // 格式 1: default 格式 (带冒号) - topic1,topic2: message
    const topicWithColonMatch = fullMessage.match(/^([a-z,\-]+):\s*(.*)$/i);
    if (topicWithColonMatch) {
      const potentialTopic = topicWithColonMatch[1];
      const topics = potentialTopic.toLowerCase().split(',');
      const isRouterOSTopic = topics.some((t) => routerOSTopics.includes(t));

      if (isRouterOSTopic) {
        return {
          topic: potentialTopic.toLowerCase(),
          message: topicWithColonMatch[2],
        };
      }
    }

    // 格式 2: BSD syslog 格式 (不带冒号) - topic1,topic2 message
    const topicWithSpaceMatch = fullMessage.match(/^([a-z,\-]+)\s+(.*)$/i);
    if (topicWithSpaceMatch) {
      const potentialTopic = topicWithSpaceMatch[1];
      const topics = potentialTopic.toLowerCase().split(',');
      const isRouterOSTopic = topics.some((t) => routerOSTopics.includes(t));

      if (isRouterOSTopic) {
        return {
          topic: potentialTopic.toLowerCase(),
          message: topicWithSpaceMatch[2],
        };
      }
    }

    // 格式 3: 应用程序格式 - app-name: message (如 app-cloudflared: error message)
    // 注意：正则中 - 放在字符类最后避免被解释为范围
    const appMatch = fullMessage.match(/^(app-[a-z0-9-]+):\s*(.*)$/i);
    if (appMatch) {
      // 从消息内容中检测 topic（基于 error:, warning:, info: 模式）
      const topic = this.detectTopicFromMessage(fullMessage);
      return {
        topic: topic || 'container',
        message: fullMessage,
      };
    }

    // 格式 4: 通用应用程序格式 - name: message
    const genericAppMatch = fullMessage.match(/^([a-z][a-z0-9\-_]*):\s*(.+)$/i);
    if (genericAppMatch) {
      // 从消息内容中检测 topic（基于 error:, warning:, info: 模式）
      const topic = this.detectTopicFromMessage(fullMessage);
      return {
        topic: topic || 'system',
        message: fullMessage,
      };
    }

    // 如果不是 RouterOS 格式，尝试从消息中检测 topic
    const topic = this.detectTopicFromMessage(fullMessage);
    return {
      topic: topic || 'unknown',
      message: fullMessage,
    };
  }

  /**
   * 从消息内容中检测 topic
   * 检测 error:, warning:, info: 模式
   * 例如: "app-cloudflared: download/extract error: check registry failed" -> "error"
   */
  private detectTopicFromMessage(message: string): string | null {
    // 检测 error: 模式
    if (/\berror:/i.test(message)) {
      return 'error';
    }
    // 检测 warning: 模式
    if (/\bwarning:/i.test(message)) {
      return 'warning';
    }
    // 检测 info: 模式
    if (/\binfo:/i.test(message)) {
      return 'info';
    }
    return null;
  }

  /**
   * 解析 Syslog 消息（自动检测格式）
   */
  parseSyslogMessage(raw: string): SyslogMessage | null {
    const trimmed = raw.trim();

    if (!trimmed.startsWith('<')) {
      logger.debug('Invalid syslog message: does not start with PRI');
      return null;
    }

    // 尝试 RFC 5424 格式（有版本号）
    if (/^<\d{1,3}>\d+\s/.test(trimmed)) {
      const result = this.parseRFC5424(trimmed);
      if (result) return result;
    }

    // 尝试 RFC 3164 格式
    return this.parseRFC3164(trimmed);
  }

  /**
   * 将 SyslogMessage 转换为 SyslogEvent
   */
  convertToSyslogEvent(
    syslogMessage: SyslogMessage,
    deviceContext?: { tenantId?: string; deviceId?: string }
  ): SyslogEvent {
    // 先根据 syslog severity 获取基础严重级别
    const baseSeverity = mapSyslogSeverityToAlertSeverity(syslogMessage.severity);

    // 然后根据消息内容增强严重级别判断
    const alertSeverity = detectSeverityFromMessage(syslogMessage.message, baseSeverity);

    // 根据 topic 确定 category
    // topic 可能是: error, warning, info, container, system, firewall 等
    // 如果 topic 是 error/warning/info，直接用作 category
    let category = syslogMessage.topic;

    // 如果 topic 包含逗号（如 system,info），取第一个非 severity 的部分
    if (syslogMessage.topic.includes(',')) {
      const topics = syslogMessage.topic.split(',');
      for (const topic of topics) {
        if (!['info', 'warning', 'error', 'critical', 'debug'].includes(topic)) {
          category = topic;
          break;
        }
      }
    }

    // 如果 category 仍然是 unknown，尝试从消息内容推断
    if (category === 'unknown') {
      // 检查是否是应用程序相关
      if (/^app-/i.test(syslogMessage.message) || /container|docker/i.test(syslogMessage.message)) {
        category = 'container';
      } else if (/interface|link|ethernet/i.test(syslogMessage.message)) {
        category = 'interface';
      } else if (/firewall|filter|nat/i.test(syslogMessage.message)) {
        category = 'firewall';
      } else if (/dhcp/i.test(syslogMessage.message)) {
        category = 'dhcp';
      } else if (/dns/i.test(syslogMessage.message)) {
        category = 'dns';
      } else if (/vpn|ipsec|l2tp|pptp|ovpn/i.test(syslogMessage.message)) {
        category = 'vpn';
      } else if (/wireless|wifi|wlan/i.test(syslogMessage.message)) {
        category = 'wireless';
      } else {
        category = 'system';
      }
    }

    return {
      id: uuidv4(),
      tenantId: deviceContext?.tenantId,
      deviceId: deviceContext?.deviceId,
      source: 'syslog',
      timestamp: syslogMessage.timestamp.getTime(),
      severity: alertSeverity,
      category,
      message: syslogMessage.message,
      rawData: syslogMessage,
      metadata: {
        hostname: syslogMessage.hostname,
        facility: syslogMessage.facility,
        syslogSeverity: syslogMessage.severity,
      },
    };
  }

  // saveEvent 方法已移除 - Syslog 事件现在通过 AlertEngine.processSyslogEvent() 统一存储
  // Requirements: syslog-alert-integration 1.1, 6.1

  /**
   * 处理接收到的 UDP 消息
   * Requirements: syslog-alert-integration 1.1 - 不再独立保存事件，由 AlertEngine 统一处理
   */
  private async handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const raw = msg.toString('utf-8');

    // 更新统计：接收计数
    this.stats.received++;
    this.stats.lastMessageAt = Date.now();

    logger.debug(`Received syslog message from ${rinfo.address}:${rinfo.port}: ${raw.substring(0, 100)}...`);

    try {
      const syslogMessage = this.parseSyslogMessage(raw);

      if (!syslogMessage) {
        // 更新统计：解析失败
        this.stats.parseFailed++;
        this.stats.lastErrorAt = Date.now();
        logger.warn(`Failed to parse syslog message from ${rinfo.address}: ${raw.substring(0, 100)}...`);
        return;
      }

      // 更新统计：解析成功
      this.stats.parsed++;

      // 尝试根据 IP 查找设备上下文
      let deviceContext: { tenantId?: string; deviceId?: string } | undefined;
      if (this.deviceManager) {
        try {
          const device = await this.deviceManager.getDeviceByHost(rinfo.address);
          if (device) {
            deviceContext = {
              tenantId: device.tenant_id,
              deviceId: device.id,
            };
            logger.debug(`Mapped syslog from ${rinfo.address} to device ${device.name} (${device.id})`);
          }
        } catch (error) {
          logger.warn(`Failed to lookup device for IP ${rinfo.address}:`, error);
        }
      }

      const event = this.convertToSyslogEvent(syslogMessage, deviceContext);

      // 移除独立保存 - 事件现在通过 AlertEngine.processSyslogEvent() 统一存储
      // Requirements: syslog-alert-integration 1.1, 6.1

      // 通知所有处理器（AlertEngine 会处理存储和后续流程）
      for (const handler of this.messageHandlers) {
        try {
          handler(event);
          // 更新统计：入队成功（handler 内部会调用 processSyslogEvent）
          this.stats.enqueued++;
        } catch (error) {
          // 更新统计：处理器错误
          this.stats.handlerErrors++;
          this.stats.lastErrorAt = Date.now();
          logger.error('Syslog message handler error:', error);
        }
      }
    } catch (error) {
      // 更新统计：处理错误
      this.stats.handlerErrors++;
      this.stats.lastErrorAt = Date.now();
      // 记录错误但继续处理后续消息 (Requirement 1.5)
      logger.error(`Error processing syslog message from ${rinfo.address}:`, error);
    }
  }

  /**
   * 启动 Syslog 接收服务
   */
  start(): void {
    if (this.running) {
      logger.warn('SyslogReceiver is already running');
      return;
    }

    if (!this.config.enabled) {
      logger.info('SyslogReceiver is disabled in config');
      return;
    }

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo);
    });

    this.socket.on('error', (error) => {
      logger.error('SyslogReceiver socket error:', error);
      this.stop();
    });

    this.socket.on('listening', () => {
      const address = this.socket?.address();
      logger.info(`SyslogReceiver listening on ${address?.address}:${address?.port}`);
    });

    try {
      this.socket.bind(this.config.port);
      this.running = true;
      // 记录启动时间
      this.stats.startedAt = Date.now();
    } catch (error) {
      logger.error(`Failed to bind SyslogReceiver to port ${this.config.port}:`, error);
      this.socket = null;
      throw error;
    }
  }

  /**
   * 停止 Syslog 接收服务
   */
  stop(): void {
    if (!this.running || !this.socket) {
      return;
    }

    try {
      this.socket.close();
    } catch (error) {
      logger.error('Error closing SyslogReceiver socket:', error);
    }

    this.socket = null;
    this.running = false;
    // 清除启动时间
    this.stats.startedAt = null;
    logger.info('SyslogReceiver stopped');
  }

  /**
   * 检查服务是否正在运行
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 注册消息处理回调
   */
  onMessage(handler: (event: SyslogEvent) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * 移除消息处理回调
   */
  offMessage(handler: (event: SyslogEvent) => void): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index !== -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): SyslogReceiverConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  async updateConfig(updates: Partial<SyslogReceiverConfig>): Promise<void> {
    const wasRunning = this.running;
    const oldPort = this.config.port;

    // 更新配置
    this.config = { ...this.config, ...updates };
    await this.saveConfig();

    // 如果端口改变或启用状态改变，需要重启服务
    if (wasRunning && (updates.port !== undefined && updates.port !== oldPort)) {
      this.stop();
      if (this.config.enabled) {
        this.start();
      }
    } else if (updates.enabled !== undefined) {
      if (updates.enabled && !wasRunning) {
        this.start();
      } else if (!updates.enabled && wasRunning) {
        this.stop();
      }
    }

    logger.info('SyslogReceiver config updated:', this.config);
  }

  // getEvents 方法已移除 - Syslog 事件现在通过统一的告警事件 API 获取
  // Requirements: syslog-alert-integration 6.2, 7.3
  // 请使用 /api/ai-ops/alerts/events?source=syslog 获取 Syslog 事件

  // getDateRange 辅助方法已移除 - 仅被 getEvents 使用
  // Requirements: syslog-alert-integration 6.2

  /**
   * 获取服务状态（包含统计信息）
   */
  getStatus(): {
    running: boolean;
    port: number;
    enabled: boolean;
    handlersCount: number;
    stats: SyslogStats;
  } {
    // 计算运行时长
    const uptimeMs = this.stats.startedAt ? Date.now() - this.stats.startedAt : 0;

    return {
      running: this.running,
      port: this.config.port,
      enabled: this.config.enabled,
      handlersCount: this.messageHandlers.length,
      stats: {
        ...this.stats,
        uptimeMs,
      },
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): SyslogStats {
    const uptimeMs = this.stats.startedAt ? Date.now() - this.stats.startedAt : 0;
    return {
      ...this.stats,
      uptimeMs,
    };
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      received: 0,
      parsed: 0,
      parseFailed: 0,
      enqueued: 0,
      enqueueFailed: 0,
      handlerErrors: 0,
      lastMessageAt: null,
      lastErrorAt: null,
      startedAt: this.running ? Date.now() : null,
      uptimeMs: 0,
    };
    logger.info('SyslogReceiver stats reset');
  }

  /**
   * 记录入队失败（由外部调用，如 AlertEngine）
   */
  recordEnqueueFailed(): void {
    this.stats.enqueueFailed++;
    this.stats.lastErrorAt = Date.now();
  }
}

// 导出单例实例
export const syslogReceiver = new SyslogReceiver();
