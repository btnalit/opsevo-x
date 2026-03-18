/**
 * Event Routes — Webhook 事件接收端点
 *
 * POST /api/v1/events/webhook — 接收外部系统推送的事件，解析为 PerceptionEvent 注入 EventBus (D1.6)
 * GET  /api/v1/events/status  — 查询 EventBus 状态（队列深度、活跃感知源）
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import {
  globalEventBus,
  EventValidationError,
  type EventType,
  type Priority,
} from '../services/eventBus';

const router = Router();

/**
 * POST /api/v1/events/webhook
 *
 * 接收外部系统推送的事件，解析请求体为 PerceptionEvent 注入 EventBus。
 * 满足 D1.6: 外部系统通过此端点推送事件。
 * 满足 D1.7: 不合规事件返回 HTTP 400。
 *
 * 请求体格式：
 * {
 *   type?: EventType,       // 默认 'webhook'
 *   priority?: Priority,    // 默认 'medium'
 *   source: string,         // 必填：事件来源标识
 *   deviceId?: string,      // 可选：关联设备 ID
 *   payload: object,        // 必填：事件负载
 *   schemaVersion?: string  // 默认 '1.0.0'
 * }
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    if (!body || typeof body !== 'object') {
      res.status(400).json({
        error: 'Request body must be a JSON object',
      });
      return;
    }

    // 构建事件，提供合理默认值
    const event = {
      type: (body.type || 'webhook') as EventType,
      priority: (body.priority || 'medium') as Priority,
      source: body.source || '',
      deviceId: body.deviceId,
      payload: body.payload,
      schemaVersion: body.schemaVersion || '1.0.0',
    };

    // 发布到 EventBus（内部会做 Schema 校验，不合规抛 EventValidationError）
    const published = await globalEventBus.publish(event);

    logger.info('[Webhook] Event received and published', {
      eventId: published.id,
      type: published.type,
      source: published.source,
    });

    res.status(201).json({
      success: true,
      eventId: published.id,
      timestamp: published.timestamp,
    });
  } catch (error) {
    if (error instanceof EventValidationError) {
      // D1.7: 不合规事件返回 HTTP 400
      res.status(400).json({
        error: 'Event validation failed',
        details: error.message,
      });
      return;
    }

    logger.error('[Webhook] Failed to process event', { error });
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/v1/events/status
 *
 * 查询 EventBus 运行状态
 */
router.get('/status', (_req: Request, res: Response) => {
  const activeSources = globalEventBus.getActiveSources();
  const sourceList = Array.from(activeSources.entries()).map(([name, meta]) => ({
    name,
    eventTypes: meta.eventTypes,
    schemaVersion: meta.schemaVersion,
  }));

  res.json({
    queueDepth: globalEventBus.getQueueDepth(),
    activeSources: sourceList,
  });
});

export default router;
