/**
 * 拓扑发现 REST API 路由
 *
 * Requirements: 9.1-9.5
 */

import { Router, Request, Response } from 'express';
import { topologyDiscoveryService } from '../services/ai-ops/topology';
import { serializeGraph } from '../services/ai-ops/topology/graphSerializer';

const router = Router();

/**
 * GET /api/topology - 获取当前完整拓扑图
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const graph = topologyDiscoveryService.getTopologyGraph();
    const serialized = serializeGraph(graph);
    res.json({
      success: true,
      data: serialized,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/topology/diff - 获取最近 N 条差分历史
 */
router.get('/diff', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const diffs = topologyDiscoveryService.getDiffHistory(limit);
    res.json({ success: true, data: diffs });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/topology/discover - 手动触发完整发现
 */
router.post('/discover', async (_req: Request, res: Response) => {
  try {
    await topologyDiscoveryService.triggerFullDiscovery();
    res.json({ success: true, message: 'Discovery triggered' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/topology/stats - 获取发现统计信息
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = topologyDiscoveryService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/topology/config - 获取当前配置
 */
router.get('/config', (_req: Request, res: Response) => {
  try {
    const config = topologyDiscoveryService.getConfig();
    res.json({ success: true, data: config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/topology/config - 更新配置
 */
router.put('/config', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (body && typeof body === 'object') {
      const numericFields = [
        'fastPollIntervalMs', 'mediumPollIntervalMs', 'slowPollIntervalMs',
        'dampeningTimerMs', 'slidingWindowSize', 'staleExpiryMs',
        'infraConfirmCount', 'infraStaleThresholdCount',
        'endpointConfirmCount', 'endpointStaleThresholdCount',
        'criticalEdgeLossThreshold', 'maxConcurrentDeviceQueries',
      ];
      for (const field of numericFields) {
        if (field in body && (typeof body[field] !== 'number' || body[field] <= 0)) {
          res.status(400).json({ success: false, error: `${field} must be a positive number` });
          return;
        }
      }
      // 校验轮询间隔递增关系
      const fast = body.fastPollIntervalMs ?? topologyDiscoveryService.getConfig().fastPollIntervalMs;
      const medium = body.mediumPollIntervalMs ?? topologyDiscoveryService.getConfig().mediumPollIntervalMs;
      const slow = body.slowPollIntervalMs ?? topologyDiscoveryService.getConfig().slowPollIntervalMs;
      if (fast > medium || medium > slow) {
        res.status(400).json({ success: false, error: 'Poll intervals must satisfy: fast ≤ medium ≤ slow' });
        return;
      }
    }
    await topologyDiscoveryService.updateConfig(body);
    res.json({ success: true, data: topologyDiscoveryService.getConfig() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/topology/stream - SSE 事件流
 */
router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // FIX: 使用数据事件格式心跳，确保前端 EventSource 能检测到
  // SSE 注释格式（:heartbeat）会被浏览器 EventSource 静默丢弃
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }
  }, 30000);

  const onUpdate = (event: unknown) => {
    res.write(`event: topology-update\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const onStats = (stats: unknown) => {
    res.write(`event: topology-stats\ndata: ${JSON.stringify(stats)}\n\n`);
  };

  topologyDiscoveryService.events.on('topology-update', onUpdate);
  topologyDiscoveryService.events.on('topology-stats', onStats);

  req.on('close', () => {
    clearInterval(heartbeat);
    topologyDiscoveryService.events.off('topology-update', onUpdate);
    topologyDiscoveryService.events.off('topology-stats', onStats);
  });
});

export default router;
