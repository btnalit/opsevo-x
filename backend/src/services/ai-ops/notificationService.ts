/**
 * NotificationService 通知服务
 * 负责多渠道通知发送和管理
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 * - 8.1: 支持创建、编辑、删除和测试通知渠道
 * - 8.2: 支持 Web 推送通知类型
 * - 8.3: 支持 Webhook 通知类型（可配置 URL、Headers、Body 模板）
 * - 8.4: 支持 SMTP 邮件通知类型
 * - 8.5: 支持测试发送功能
 * - 8.6: 支持为不同告警级别配置不同的通知渠道
 * - 8.7: 通知发送失败时记录失败日志并支持重试
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import {
  NotificationChannel,
  CreateNotificationChannelInput,
  UpdateNotificationChannelInput,
  Notification,
  INotificationService,
  WebhookConfig,
  EmailConfig,
  ChannelType,
  AlertSeverity,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import type { DataStore } from '../dataStore';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const NOTIFICATIONS_DIR = path.join(DATA_DIR, 'notifications');

// 重试配置 — 总耗时需远小于 pipeline 的 30s 执行超时
const RETRY_DELAYS = [500, 2000, 5000]; // 0.5s, 2s, 5s (worst-case total ≈ 7.5s)
/** 最大重试次数（不含首次尝试），总尝试次数 = MAX_RETRY_ATTEMPTS + 1 */
const MAX_RETRY_ATTEMPTS = 3;

// Webhook / Email 单次请求超时（毫秒）
const SEND_TIMEOUT_MS = 10000; // 10s

// 时区配置（默认北京时间 UTC+8）
const DEFAULT_TIMEZONE_OFFSET = 8;

/**
 * 格式化时间戳为指定时区时间
 * @param timestamp 时间戳（毫秒）
 * @param timezoneOffset 时区偏移量（小时），默认为 8（北京时间）
 * @returns 格式化后的时间字符串 "YYYY-MM-DD HH:mm:ss"
 */
export function formatBeijingTime(
  timestamp: number,
  timezoneOffset: number = DEFAULT_TIMEZONE_OFFSET
): string {
  const date = new Date(timestamp);
  // 转换为指定时区时间
  const offsetMs = timezoneOffset * 60 * 60 * 1000;
  const targetTime = new Date(date.getTime() + offsetMs);

  const year = targetTime.getUTCFullYear();
  const month = String(targetTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(targetTime.getUTCDate()).padStart(2, '0');
  const hours = String(targetTime.getUTCHours()).padStart(2, '0');
  const minutes = String(targetTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(targetTime.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Web Push 订阅存储（内存中，实际应用中应持久化）
const webPushSubscriptions: Map<string, unknown[]> = new Map();

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取通知历史文件路径
 */
function getNotificationFilePath(dateStr: string): string {
  return path.join(NOTIFICATIONS_DIR, `${dateStr}.json`);
}

/**
 * 替换模板变量
 * 支持 {{variable}} 格式的变量替换
 * {{timestamp}} 变量会自动转换为北京时间格式 "YYYY-MM-DD HH:mm:ss"
 */
function replaceTemplateVariables(
  template: string,
  data: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    // 特殊处理 timestamp 变量，使用北京时间格式
    if (key === 'timestamp') {
      return formatBeijingTime(Date.now());
    }
    const value = data[key];
    if (value === undefined) return match;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

export class NotificationService implements INotificationService {
  private channels: NotificationChannel[] = [];
  private initialized = false;

  // ==================== DataStore 集成 ====================
  // Requirements: 2.1, 2.2 - 使用 DataStore (PostgreSQL) 替代 JSON 文件存储，注入 tenant_id
  private dataStore: DataStore | null = null;


  /**
   * 设置 DataStore 实例
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('NotificationService: DataStore backend configured, using PostgreSQL for notification channels storage');
  }

  /**
   * 设置 PgDataStore 实例（PostgreSQL）
   * 当 PgDataStore 可用时，优先使用 PostgreSQL 存储渠道和通知历史
   * Requirements: J7.18, J7.19, J7.20, J7.21
   */
  setPgDataStore(ds: DataStore): void {
    this.dataStore = ds;
    logger.info('NotificationService: PgDataStore backend configured, using PostgreSQL for channels and notification history');
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.access(DATA_DIR);
    } catch {
      await fs.mkdir(DATA_DIR, { recursive: true });
    }
    try {
      await fs.access(NOTIFICATIONS_DIR);
    } catch {
      await fs.mkdir(NOTIFICATIONS_DIR, { recursive: true });
    }
  }

  /**
   * 初始化服务，加载渠道配置
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureDataDir();
    await this.loadChannels();
    this.initialized = true;
    logger.info('NotificationService initialized');
  }

  /**
   * 加载渠道配置
   * Requirements: 2.1 - 当 DataStore 可用时从 notification_channels 表读取
   * Requirements: J7.18 - 当 PgDataStore 可用时优先从 PostgreSQL 读取
   */
  private async loadChannels(): Promise<void> {
    // 当 PgDataStore 可用时，优先从 PostgreSQL 读取
    if (this.dataStore) {
      try {
        const rows = await this.dataStore.query<{
          id: string;
          name: string;
          type: string;
          config: Record<string, unknown>;
          severity_filter: string[];
          enabled: boolean;
          created_at: Date | string;
        }>('SELECT id, name, type, config, severity_filter, enabled, created_at FROM notification_channels');

        this.channels = rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type as ChannelType,
          config: row.config, // JSONB auto-parsed by pg driver
          severityFilter: row.severity_filter as AlertSeverity[], // JSONB auto-parsed
          enabled: row.enabled,
          createdAt: new Date(row.created_at).getTime(),
        }));

        logger.info(`Loaded ${this.channels.length} notification channels from PostgreSQL`);
        return;
      } catch (error) {
        logger.error('Failed to load notification channels from PostgreSQL, falling back:', error);
      }
    }

    // Fallback: 从 JSON 文件读取
    try {
      const data = await fs.readFile(CHANNELS_FILE, 'utf-8');
      this.channels = JSON.parse(data) as NotificationChannel[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.channels = [];
        await this.saveChannels();
      } else {
        logger.error('Failed to load notification channels:', error);
        this.channels = [];
      }
    }
  }

  /**
   * 保存渠道配置
   * Requirements: 2.1 - 当 DataStore 可用时写入 notification_channels 表
   * Requirements: J7.18 - 当 PgDataStore 可用时优先写入 PostgreSQL
   */
  private async saveChannels(): Promise<void> {
    // 当 PgDataStore 可用时，优先写入 PostgreSQL（使用 upsert 策略）
    if (this.dataStore) {
      try {
        await this.dataStore.transaction(async (tx) => {
          // 获取当前数据库中的渠道 ID 列表
          const existingRows = await tx.query<{ id: string }>('SELECT id FROM notification_channels');
          const existingIds = new Set(existingRows.map(r => r.id));
          const currentIds = new Set(this.channels.map(c => c.id));

          // 删除不再存在的渠道
          for (const id of existingIds) {
            if (!currentIds.has(id)) {
              await tx.execute('DELETE FROM notification_channels WHERE id = $1', [id]);
            }
          }

          // Upsert 当前渠道
          for (const channel of this.channels) {
            const createdAt = new Date(channel.createdAt).toISOString();
            const severityFilter = channel.severityFilter || ['critical', 'high', 'medium', 'low'];

            await tx.execute(
              `INSERT INTO notification_channels (id, name, type, config, severity_filter, enabled, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name,
                 type = EXCLUDED.type,
                 config = EXCLUDED.config,
                 severity_filter = EXCLUDED.severity_filter,
                 enabled = EXCLUDED.enabled,
                 updated_at = NOW()`,
              [
                channel.id,
                channel.name,
                channel.type,
                JSON.stringify(channel.config),
                JSON.stringify(severityFilter),
                channel.enabled,
                createdAt,
              ]
            );
          }
        });
        return;
      } catch (error) {
        logger.error('Failed to save channels to PostgreSQL, falling back:', error);
      }
    }

    // Fallback: 写入 JSON 文件
    await this.ensureDataDir();
    await fs.writeFile(CHANNELS_FILE, JSON.stringify(this.channels, null, 2), 'utf-8');
  }

  /**
   * 读取指定日期的通知历史
   */
  private async readNotificationHistory(dateStr: string): Promise<Notification[]> {
    const filePath = getNotificationFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as Notification[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read notification history ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * 写入通知历史
   */
  private async writeNotificationHistory(
    dateStr: string,
    notifications: Notification[]
  ): Promise<void> {
    await this.ensureDataDir();
    const filePath = getNotificationFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(notifications, null, 2), 'utf-8');
  }

  /**
   * 保存单个通知记录
   * Requirements: J7.20 - 当 PgDataStore 可用时写入 notifications 表
   */
  private async saveNotification(notification: Notification): Promise<void> {
    // PG path: INSERT or UPDATE into notifications table
    if (this.dataStore) {
      try {
        const sentAt = notification.sentAt ? new Date(notification.sentAt).toISOString() : null;
        const severity = notification.data?.severity as string || notification.type || null;

        await this.dataStore.execute(
          `INSERT INTO notifications (id, channel_id, title, content, severity, status, retry_count, error_message, sent_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             retry_count = EXCLUDED.retry_count,
             error_message = EXCLUDED.error_message,
             sent_at = EXCLUDED.sent_at`,
          [
            notification.id,
            notification.channelId,
            notification.title,
            notification.body,
            severity,
            notification.status,
            notification.retryCount,
            notification.error || null,
            sentAt,
          ]
        );
        return;
      } catch (error) {
        logger.error('Failed to save notification to PostgreSQL, falling back to JSON:', error);
      }
    }

    // Fallback: JSON file path
    const dateStr = getDateString(Date.now());
    const notifications = await this.readNotificationHistory(dateStr);

    // 查找是否已存在该通知（用于更新状态）
    const existingIndex = notifications.findIndex((n) => n.id === notification.id);
    if (existingIndex >= 0) {
      notifications[existingIndex] = notification;
    } else {
      notifications.push(notification);
    }

    await this.writeNotificationHistory(dateStr, notifications);
  }


  // ==================== 渠道管理 ====================

  /**
   * 创建通知渠道
   * Requirements: 2.2 - 支持 tenant_id 关联
   */
  async createChannel(
    input: CreateNotificationChannelInput & { tenant_id?: string }
  ): Promise<NotificationChannel> {
    await this.initialize();

    const { tenant_id, ...channelInput } = input;
    const channel: NotificationChannel & { tenant_id?: string } = {
      id: uuidv4(),
      createdAt: Date.now(),
      ...channelInput,
      tenant_id,
    };

    this.channels.push(channel);
    await this.saveChannels();

    logger.info(`Created notification channel: ${channel.name} (${channel.type})`);
    return channel;
  }

  /**
   * 更新通知渠道
   */
  async updateChannel(
    id: string,
    updates: UpdateNotificationChannelInput
  ): Promise<NotificationChannel> {
    await this.initialize();

    const index = this.channels.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Notification channel not found: ${id}`);
    }

    const channel = this.channels[index];
    const updatedChannel: NotificationChannel = {
      ...channel,
      ...updates,
    };

    this.channels[index] = updatedChannel;
    await this.saveChannels();

    logger.info(`Updated notification channel: ${updatedChannel.name}`);
    return updatedChannel;
  }

  /**
   * 删除通知渠道
   */
  async deleteChannel(id: string): Promise<void> {
    await this.initialize();

    const index = this.channels.findIndex((c) => c.id === id);
    if (index === -1) {
      throw new Error(`Notification channel not found: ${id}`);
    }

    const channel = this.channels[index];
    this.channels.splice(index, 1);
    await this.saveChannels();

    logger.info(`Deleted notification channel: ${channel.name}`);
  }

  /**
   * 获取所有通知渠道
   */
  async getChannels(): Promise<NotificationChannel[]> {
    await this.initialize();
    return [...this.channels];
  }

  /**
   * 根据 ID 获取通知渠道
   */
  async getChannelById(id: string): Promise<NotificationChannel | null> {
    await this.initialize();
    return this.channels.find((c) => c.id === id) || null;
  }

  /**
   * 测试通知渠道
   */
  async testChannel(id: string): Promise<{ success: boolean; message: string }> {
    await this.initialize();

    const channel = await this.getChannelById(id);
    if (!channel) {
      return { success: false, message: `Channel not found: ${id}` };
    }

    const testNotification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'> = {
      type: 'alert',
      title: '⚠️ 警告 - 测试告警规则',
      body: '设备: TestRouter (192.168.1.1)\n告警: 这是一条测试通知，用于验证通知渠道配置是否正常。',
      data: {
        test: true,
        eventId: 'test-event-001',
        ruleId: 'test-rule-001',
        severity: 'warning',
        metric: 'cpu',
        currentValue: 85,
        threshold: 80,
        deviceName: 'TestRouter',
        deviceIp: '192.168.1.1',
      },
    };

    try {
      await this.sendToChannel(channel, testNotification);
      return { success: true, message: 'Test notification sent successfully' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Failed to send test notification: ${errorMessage}` };
    }
  }


  // ==================== 通知发送 ====================

  /**
   * 发送通知到多个渠道
   */
  async send(
    channelIds: string[],
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>,
    severity?: string
  ): Promise<{ success: boolean; failedChannels: string[]; skippedChannels: string[] }> {
    await this.initialize();

    const failedChannels: string[] = [];
    const skippedChannels: string[] = [];

    const sendPromises = channelIds.map(async (channelId) => {
      const channel = await this.getChannelById(channelId);
      if (!channel) {
        logger.warn(`Notification channel not found: ${channelId}`);
        failedChannels.push(channelId);
        return;
      }

      if (!channel.enabled) {
        logger.debug(`Notification channel disabled: ${channel.name}`);
        return;
      }

      // severityFilter 过滤：如果通道配置了 severityFilter 且传入了 severity，
      // 检查该 severity 是否在通道的接收列表中
      if (severity && channel.severityFilter && channel.severityFilter.length > 0) {
        if (!channel.severityFilter.includes(severity as any)) {
          logger.debug(`Notification channel ${channel.name} skipped: severity "${severity}" not in filter [${channel.severityFilter.join(', ')}]`);
          skippedChannels.push(channelId);
          return;
        }
      }

      // 创建通知记录
      const notificationRecord: Notification = {
        id: uuidv4(),
        channelId,
        ...notification,
        status: 'pending',
        retryCount: 0,
      };

      try {
        await this.sendWithRetry(channel, notificationRecord);
        // sendWithRetry 内部会将 status 设为 'failed' 如果全部重试失败
        if (notificationRecord.status === 'failed') {
          failedChannels.push(channelId);
        }
      } catch (err) {
        failedChannels.push(channelId);
      }
    });

    await Promise.allSettled(sendPromises);

    return {
      success: failedChannels.length === 0,
      failedChannels,
      skippedChannels,
    };
  }

  /**
   * 带重试机制的发送
   */
  private async sendWithRetry(
    channel: NotificationChannel,
    notification: Notification
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        if (attempt > 0) {
          // 等待重试延迟
          const delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
          await new Promise((resolve) => setTimeout(resolve, delay));
          notification.retryCount = attempt;
        }

        await this.sendToChannel(channel, notification);

        // 发送成功
        notification.status = 'sent';
        notification.sentAt = Date.now();
        await this.saveNotification(notification);

        logger.info(
          `Notification sent successfully: ${notification.type} via ${channel.name}` +
          (attempt > 0 ? ` (retry ${attempt})` : '')
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `Failed to send notification via ${channel.name} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS + 1}): ${lastError.message}`
        );
      }
    }

    // 所有重试都失败
    notification.status = 'failed';
    notification.error = lastError?.message || 'Unknown error';
    notification.retryCount = MAX_RETRY_ATTEMPTS;
    await this.saveNotification(notification);

    logger.error(
      `Notification failed after ${MAX_RETRY_ATTEMPTS + 1} attempts: ${notification.type} via ${channel.name}`
    );
  }


  /**
   * 发送到指定渠道
   */
  private async sendToChannel(
    channel: NotificationChannel,
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>
  ): Promise<void> {
    switch (channel.type) {
      case 'web_push':
        await this.sendWebPush(channel, notification);
        break;
      case 'webhook':
        await this.sendWebhook(channel, notification);
        break;
      case 'email':
        await this.sendEmail(channel, notification);
        break;
      default:
        throw new Error(`Unsupported channel type: ${(channel as NotificationChannel).type}`);
    }
  }

  /**
   * 发送 Web Push 通知
   * 注意：实际的 Web Push 需要浏览器订阅，这里提供基础实现
   */
  private async sendWebPush(
    channel: NotificationChannel,
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>
  ): Promise<void> {
    // Web Push 通知存储到内存中，由前端轮询获取
    // 实际生产环境应使用 web-push 库和 VAPID 密钥
    const subscriptions = webPushSubscriptions.get(channel.id) || [];

    if (subscriptions.length === 0) {
      // 没有订阅者时，将通知存储到待发送队列
      logger.debug(`No Web Push subscriptions for channel: ${channel.name}`);
    }

    // 存储待推送的通知（供前端轮询）
    const pendingKey = `pending_${channel.id}`;
    const pendingNotifications = webPushSubscriptions.get(pendingKey) || [];

    // FIX: 队列溢出保护 — 如果待消费通知堆积过多，说明前端可能未在轮询
    const WEB_PUSH_QUEUE_LIMIT = 200;
    if (pendingNotifications.length >= WEB_PUSH_QUEUE_LIMIT) {
      logger.warn(
        `Web Push queue overflow for channel ${channel.name}: ${pendingNotifications.length} pending notifications. ` +
        `Frontend may not be polling. Dropping oldest entries.`
      );
      // 丢弃最旧的 10% 腾出空间
      const dropCount = Math.max(1, Math.floor(WEB_PUSH_QUEUE_LIMIT * 0.1));
      pendingNotifications.splice(0, dropCount);
    }

    pendingNotifications.push({
      ...notification,
      timestamp: Date.now(),
    });
    webPushSubscriptions.set(pendingKey, pendingNotifications);

    logger.debug(`Web Push notification queued for channel: ${channel.name} (queue size: ${pendingNotifications.length})`);
  }

  /**
   * 获取待推送的 Web Push 通知（供前端轮询）
   */
  async getPendingWebPushNotifications(channelId: string): Promise<unknown[]> {
    const key = `pending_${channelId}`;
    const notifications = webPushSubscriptions.get(key) || [];
    // 清空已获取的通知
    webPushSubscriptions.set(key, []);
    return notifications;
  }


  /**
   * 发送 Webhook 通知
   */
  private async sendWebhook(
    channel: NotificationChannel,
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>
  ): Promise<void> {
    const config = channel.config as WebhookConfig;

    if (!config.url) {
      throw new Error('Webhook URL is required');
    }

    // 准备请求体
    let body: string;
    if (config.bodyTemplate) {
      // 使用模板替换变量
      const templateData: Record<string, unknown> = {
        title: notification.title,
        body: notification.body,
        type: notification.type,
        timestamp: Date.now(),
        ...notification.data,
      };
      body = replaceTemplateVariables(config.bodyTemplate, templateData);
    } else {
      // 默认 JSON 格式
      body = JSON.stringify({
        title: notification.title,
        body: notification.body,
        type: notification.type,
        timestamp: Date.now(),
        data: notification.data,
      });
    }

    // 准备请求头
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...config.headers,
    };

    // 发送请求（带超时，防止目标不可达时 fetch 无限挂起）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    let response: globalThis.Response;
    try {
      response = await fetch(config.url, {
        method: config.method || 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeout);
      if ((fetchError as Error).name === 'AbortError') {
        throw new Error(`Webhook request timed out after ${SEND_TIMEOUT_MS}ms: ${config.url}`);
      }
      throw fetchError;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const responseText = await response.text().catch(() => 'Unable to read response');
      throw new Error(
        `Webhook request failed: ${response.status} ${response.statusText} - ${responseText}`
      );
    }

    logger.debug(`Webhook notification sent to: ${config.url}`);
  }


  /**
   * 发送邮件通知
   */
  private async sendEmail(
    channel: NotificationChannel,
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>
  ): Promise<void> {
    const config = channel.config as EmailConfig;

    if (!config.smtp || !config.from || !config.to || config.to.length === 0) {
      throw new Error('Email configuration is incomplete');
    }

    // 创建邮件传输器
    // 端口 465 使用直接 SSL，端口 587/25 使用 STARTTLS
    const isSecurePort = config.smtp.port === 465;
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: isSecurePort, // 只有 465 端口使用直接 SSL
      auth: config.smtp.auth,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      // 对于非 465 端口，如果用户开启了 SSL/TLS，则使用 STARTTLS
      ...((!isSecurePort && config.smtp.secure) ? {
        requireTLS: true,
        tls: {
          rejectUnauthorized: false // 允许自签名证书
        }
      } : {})
    });

    // 构建邮件内容
    const mailOptions = {
      from: config.from,
      to: config.to.join(', '),
      subject: notification.title,
      text: notification.body,
      html: this.buildEmailHtml(notification),
    };

    // 发送邮件
    const info = await transporter.sendMail(mailOptions);

    logger.debug(`Email notification sent: ${info.messageId}`);
  }

  /**
   * 构建邮件 HTML 内容
   */
  private buildEmailHtml(
    notification: Omit<Notification, 'id' | 'channelId' | 'status' | 'retryCount'>
  ): string {
    const typeColors: Record<string, string> = {
      alert: '#dc3545',
      recovery: '#28a745',
      report: '#17a2b8',
      remediation: '#ffc107',
    };

    const color = typeColors[notification.type] || '#6c757d';
    const typeLabel = notification.type.charAt(0).toUpperCase() + notification.type.slice(1);

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: ${color}; color: white; padding: 15px; border-radius: 5px 5px 0 0; }
    .content { background-color: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none; border-radius: 0 0 5px 5px; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 12px; background-color: ${color}; color: white; }
    .footer { margin-top: 20px; font-size: 12px; color: #6c757d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">${notification.title}</h2>
      <span class="badge">${typeLabel}</span>
    </div>
    <div class="content">
      <p>${notification.body.replace(/\n/g, '<br>')}</p>
      ${notification.data ? `<pre style="background: #e9ecef; padding: 10px; border-radius: 3px; overflow-x: auto;">${JSON.stringify(notification.data, null, 2)}</pre>` : ''}
    </div>
    <div class="footer">
      <p>This notification was sent by AI-Ops at ${new Date().toISOString()}</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }


  // ==================== 通知历史 ====================

  /**
   * 获取通知历史
   * Requirements: J7.20 - 当 PgDataStore 可用时从 notifications 表查询
   */
  async getNotificationHistory(limit?: number): Promise<Notification[]> {
    // PG path: query notifications table
    if (this.dataStore) {
      try {
        const targetLimit = limit || 100;
        const rows = await this.dataStore.query<{
          id: string;
          channel_id: string;
          title: string;
          content: string;
          severity: string | null;
          status: string;
          retry_count: number;
          error_message: string | null;
          sent_at: Date | string | null;
          created_at: Date | string;
        }>(
          'SELECT id, channel_id, title, content, severity, status, retry_count, error_message, sent_at, created_at FROM notifications ORDER BY created_at DESC LIMIT $1',
          [targetLimit]
        );

        return rows.map((row) => ({
          id: row.id,
          channelId: row.channel_id,
          title: row.title,
          body: row.content,
          type: (row.severity || 'alert') as Notification['type'],
          status: row.status as Notification['status'],
          retryCount: row.retry_count,
          error: row.error_message || undefined,
          sentAt: row.sent_at ? new Date(row.sent_at).getTime() : undefined,
        }));
      } catch (error) {
        logger.error('Failed to get notification history from PostgreSQL, falling back to JSON:', error);
      }
    }

    // Fallback: JSON file path
    await this.ensureDataDir();

    // 列出所有通知历史文件
    let files: string[];
    try {
      files = await fs.readdir(NOTIFICATIONS_DIR);
      files = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort()
        .reverse(); // 最新的在前
    } catch {
      return [];
    }

    // 收集通知记录
    let allNotifications: Notification[] = [];
    const targetLimit = limit || 100;

    for (const dateStr of files) {
      if (allNotifications.length >= targetLimit) break;

      const notifications = await this.readNotificationHistory(dateStr);
      allNotifications = allNotifications.concat(notifications);
    }

    // 按时间降序排序
    allNotifications.sort((a, b) => {
      const timeA = a.sentAt || 0;
      const timeB = b.sentAt || 0;
      return timeB - timeA;
    });

    // 应用限制
    if (limit && limit > 0) {
      allNotifications = allNotifications.slice(0, limit);
    }

    return allNotifications;
  }

  /**
   * 清理过期的通知历史
   * Requirements: J7.21 - 当 PgDataStore 可用时从 notifications 表清理
   */
  async cleanupHistory(retentionDays: number = 30): Promise<number> {
    // PG path: DELETE from notifications table
    if (this.dataStore) {
      try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const result = await this.dataStore.execute(
          'DELETE FROM notifications WHERE created_at < $1',
          [cutoffDate.toISOString()]
        );
        const deleted = result.rowCount;
        if (deleted > 0) {
          logger.info(`Cleaned up ${deleted} expired notifications from PostgreSQL (retention: ${retentionDays} days)`);
        }
        return deleted;
      } catch (error) {
        logger.error('Failed to cleanup notification history from PostgreSQL, falling back to JSON:', error);
      }
    }

    // Fallback: JSON file path
    await this.ensureDataDir();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);
    const cutoffDateStr = getDateString(cutoffDate.getTime());

    let files: string[];
    try {
      files = await fs.readdir(NOTIFICATIONS_DIR);
      files = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch {
      return 0;
    }

    let deletedCount = 0;

    for (const dateStr of files) {
      if (dateStr < cutoffDateStr) {
        const filePath = getNotificationFilePath(dateStr);
        try {
          const notifications = await this.readNotificationHistory(dateStr);
          deletedCount += notifications.length;
          await fs.unlink(filePath);
          logger.info(`Deleted expired notification history: ${dateStr} (${notifications.length} records)`);
        } catch (error) {
          logger.error(`Failed to delete notification history ${dateStr}:`, error);
        }
      }
    }

    return deletedCount;
  }
}

// 导出单例实例
export const notificationService = new NotificationService();
