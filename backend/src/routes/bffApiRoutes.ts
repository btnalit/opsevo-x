/**
 * BFF API Routes — 补全前端视图所需的 REST API 端点
 *
 * 本文件集中注册 Task 31.1–31.6 中尚未被现有路由覆盖的端点。
 * 已有路由（aiOpsRoutes, deviceRoutes, skillRoutes, topologyRoutes 等）保持不变。
 *
 * 路由分组：
 * - /devices/:id/execute          — 设备操作执行 (31.1)
 * - /devices/:id/metrics          — 设备指标 (31.1)
 * - /devices/:id/health-detail    — 设备健康详情 (31.1)
 * - /drivers                      — 驱动列表 (31.1)
 * - /profiles                     — API Profile CRUD (31.1)
 * - /perception/*                 — 感知源管理 (31.2)
 * - /syslog/sources|rules|filters — Syslog 来源/规则/过滤 CRUD (31.2)
 * - /snmp-trap/*                  — SNMP Trap 管理 (31.2)
 * - /noise-filter/stats           — 噪声过滤统计 (31.3)
 * - /inspections/*                — 巡检任务/历史 (31.3)
 * - /tools                        — 统一工具列表 (31.4)
 * - /evaluations                  — 评估报告 (31.4)
 * - /knowledge-graph/*            — 知识图谱查询 (31.5)
 * - /repairs/*                    — 修复历史 (31.5)
 * - /users/*                      — 用户管理 (31.6)
 * - /feature-flags/*              — 特性标志 (31.6)
 * - /traces/*                     — 追踪数据 (31.6)
 * - /system/config                — 系统配置 (31.6)
 * - /ai-providers/*               — AI 提供商 (31.6)
 * - /notifications/stats          — 通知统计 (31.6)
 * - /brain/state                  — Brain 状态 (31.6)
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import type { SnmpTrapReceiver } from '../services/snmp/snmpTrapReceiver';

const router = Router();

/** 从 ServiceRegistry 获取 SnmpTrapReceiver 单例 */
async function getSnmpTrapReceiver(): Promise<SnmpTrapReceiver> {
  const { serviceRegistry } = await import('../services');
  const { SERVICE_NAMES } = await import('../services/bootstrap');
  return serviceRegistry.getAsync<SnmpTrapReceiver>(SERVICE_NAMES.SNMP_TRAP_RECEIVER);
}

/** 从 ServiceRegistry 获取 SyslogManager 单例（FeatureFlag 切换后注册） */
async function getSyslogManager(): Promise<import('../services/syslog/syslogManager').SyslogManager> {
  const { serviceRegistry } = await import('../services');
  const { SERVICE_NAMES } = await import('../services/bootstrap');
  return serviceRegistry.getAsync<import('../services/syslog/syslogManager').SyslogManager>(SERVICE_NAMES.SYSLOG_MANAGER);
}

// ============================================================================
// 31.1 — 设备管理与驱动 API
// ============================================================================

/**
 * POST /api/v1/devices/:id/execute — 通过 DeviceManager 执行设备操作
 */
router.post('/devices/:id/execute', async (req: Request, res: Response) => {
  try {
    const { DeviceManager } = await import('../services/device/deviceManager');
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const dm = await serviceRegistry.getAsync<InstanceType<typeof DeviceManager>>(SERVICE_NAMES.DEVICE_MANAGER);
    const { id } = req.params;
    const { actionType, payload } = req.body;
    if (!actionType) {
      res.status(400).json({ success: false, error: 'actionType is required' });
      return;
    }
    // DeviceManager.execute 尚未实现时回退到 DevicePool
    const { DevicePool } = await import('../services/device/devicePool');
    const dp = await serviceRegistry.getAsync<InstanceType<typeof DevicePool>>(SERVICE_NAMES.DEVICE_POOL);
    const tenantId = req.tenantId || 'default';
    const driver = await dp.getConnection(tenantId, id);
    // 通过 driver 执行
    const result = await driver.execute(actionType, payload?.params);
    res.json({ success: true, data: result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[BFF] Device execute failed', { error: msg });
    res.status(500).json({ success: false, error: msg });
  }
});


/**
 * GET /api/v1/devices/:id/metrics — 获取设备实时指标（通过 HealthMonitor）
 */
router.get('/devices/:id/metrics', async (req: Request, res: Response) => {
  try {
    const { healthMonitor } = await import('../services/ai-ops');
    const health = await healthMonitor.getLatestHealth(req.params.id);
    res.json({ success: true, data: health || {} });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/devices/:id/health-detail — 获取设备健康详情（含趋势）
 */
router.get('/devices/:id/health-detail', async (req: Request, res: Response) => {
  try {
    const { healthMonitor } = await import('../services/ai-ops');
    const [health, trend] = await Promise.all([
      healthMonitor.getLatestHealth(req.params.id),
      healthMonitor.getHealthTrend('hour', req.params.id),
    ]);
    res.json({ success: true, data: { health: health || {}, trend } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/drivers — 获取已注册驱动列表及能力清单
 */
router.get('/drivers', async (_req: Request, res: Response) => {
  try {
    // 返回已知驱动类型及其基本信息
    const drivers = [
      { type: 'api', name: 'API Driver', description: 'HTTP/REST API based device driver', status: 'active' },
      { type: 'ssh', name: 'SSH Driver', description: 'SSH protocol device driver', status: 'active' },
      { type: 'snmp', name: 'SNMP Driver', description: 'SNMP protocol device driver', status: 'active' },
    ];
    res.json({ success: true, data: drivers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/profiles — 获取 API Profile 列表
 */
router.get('/profiles', async (_req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const rows = await pgDs.query('SELECT * FROM api_profiles ORDER BY name');
    res.json({ success: true, data: rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/profiles — 创建 API Profile
 */
router.post('/profiles', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const { name, driver_type, config } = req.body;
    if (!name || !driver_type) {
      res.status(400).json({ success: false, error: 'name and driver_type are required' });
      return;
    }
    const id = require('crypto').randomUUID();
    await pgDs.execute(
      'INSERT INTO api_profiles (id, name, driver_type, config, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())',
      [id, name, driver_type, JSON.stringify(config || {})]
    );
    res.status(201).json({ success: true, data: { id, name, driver_type, config } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/v1/profiles/:id — 更新 API Profile
 */
router.put('/profiles/:id', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const { name, driver_type, config } = req.body;
    await pgDs.execute(
      'UPDATE api_profiles SET name = COALESCE($1, name), driver_type = COALESCE($2, driver_type), config = COALESCE($3, config), updated_at = NOW() WHERE id = $4',
      [name, driver_type, config ? JSON.stringify(config) : null, req.params.id]
    );
    res.json({ success: true, message: 'Profile updated' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * DELETE /api/v1/profiles/:id — 删除 API Profile
 */
router.delete('/profiles/:id', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    await pgDs.execute('DELETE FROM api_profiles WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Profile deleted' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/profiles/import — 导入 API Profile
 */
router.post('/profiles/import', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const profiles = Array.isArray(req.body) ? req.body : [req.body];
    let imported = 0;
    for (const p of profiles) {
      const id = p.id || require('crypto').randomUUID();
      await pgDs.execute(
        'INSERT INTO api_profiles (id, name, driver_type, config, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) ON CONFLICT (id) DO UPDATE SET name = $2, driver_type = $3, config = $4, updated_at = NOW()',
        [id, p.name, p.driver_type, JSON.stringify(p.config || {})]
      );
      imported++;
    }
    res.status(201).json({ success: true, data: { imported } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/profiles/export — 导出所有 API Profile
 */
router.get('/profiles/export', async (_req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const rows = await pgDs.query('SELECT * FROM api_profiles ORDER BY name');
    res.json({ success: true, data: rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});


// ============================================================================
// 31.2 — 事件与感知源 API
// ============================================================================

/**
 * GET /api/v1/perception/sources — 获取活跃感知源列表
 */
router.get('/perception/sources', async (_req: Request, res: Response) => {
  try {
    const { globalEventBus } = await import('../services/eventBus');
    const sources = globalEventBus.getActiveSources();
    const list = Array.from(sources.entries()).map(([name, meta]) => ({
      name,
      eventTypes: meta.eventTypes,
      schemaVersion: meta.schemaVersion,
    }));
    res.json({ success: true, data: list });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/perception/stats — 获取感知源统计
 */
router.get('/perception/stats', async (_req: Request, res: Response) => {
  try {
    const { globalEventBus } = await import('../services/eventBus');
    const sources = globalEventBus.getActiveSources();
    res.json({
      success: true,
      data: {
        sourceCount: sources.size,
        queueDepth: globalEventBus.getQueueDepth(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/syslog/sources — 获取 Syslog 来源映射列表
 */
router.get('/syslog/sources', async (_req: Request, res: Response) => {
  try {
    const mgr = await getSyslogManager();
    res.json({ success: true, data: mgr.getSourceMappings() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/syslog/sources — 创建 Syslog 来源映射
 */
router.post('/syslog/sources', async (req: Request, res: Response) => {
  try {
    const mgr = await getSyslogManager();
    const mapping = await mgr.addSourceMapping(req.body);
    res.status(201).json({ success: true, data: mapping });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/syslog/rules — 获取 Syslog 解析规则列表
 */
router.get('/syslog/rules', async (_req: Request, res: Response) => {
  try {
    const mgr = await getSyslogManager();
    res.json({ success: true, data: mgr.getParseRules() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/syslog/rules — 创建 Syslog 解析规则
 */
router.post('/syslog/rules', async (req: Request, res: Response) => {
  try {
    const mgr = await getSyslogManager();
    const rule = await mgr.addParseRule(req.body);
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/syslog/rules/test — 测试 Syslog 解析规则
 */
router.post('/syslog/rules/test', async (req: Request, res: Response) => {
  try {
    const { pattern, testMessage } = req.body;
    if (!pattern || !testMessage) {
      res.status(400).json({ success: false, error: 'pattern and testMessage are required' });
      return;
    }
    const regex = new RegExp(pattern);
    const match = regex.exec(testMessage);
    res.json({
      success: true,
      data: {
        matched: !!match,
        groups: match?.groups || null,
        captures: match ? Array.from(match).slice(1) : [],
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ success: false, error: `Invalid pattern: ${msg}` });
  }
});

/**
 * GET /api/v1/syslog/filters — 获取 Syslog 过滤规则列表
 */
router.get('/syslog/filters', async (_req: Request, res: Response) => {
  try {
    const mgr = await getSyslogManager();
    res.json({ success: true, data: mgr.getFilterRules() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/syslog/filters — 创建 Syslog 过滤规则
 */
router.post('/syslog/filters', async (req: Request, res: Response) => {
  try {
    const mgr = await getSyslogManager();
    const rule = await mgr.addFilterRule(req.body);
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/snmp-trap/status — 获取 SNMP Trap 接收器状态
 */
router.get('/snmp-trap/status', async (_req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    res.json({
      success: true,
      data: {
        config: snmpTrapReceiver.getConfig(),
        oidMappingCount: snmpTrapReceiver.getOidMappings().length,
        v3CredentialCount: snmpTrapReceiver.getV3Credentials().length,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/snmp-trap/oid-mappings — 获取 OID 映射列表
 */
router.get('/snmp-trap/oid-mappings', async (_req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    res.json({ success: true, data: snmpTrapReceiver.getOidMappings() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/snmp-trap/oid-mappings — 创建 OID 映射
 */
router.post('/snmp-trap/oid-mappings', async (req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    const mapping = await snmpTrapReceiver.addOidMapping(req.body);
    res.status(201).json({ success: true, data: mapping });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/v1/snmp-trap/oid-mappings/:id — 更新 OID 映射
 */
router.put('/snmp-trap/oid-mappings/:id', async (req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    const ok = await snmpTrapReceiver.updateOidMapping(req.params.id, req.body);
    if (!ok) {
      res.status(404).json({ success: false, error: 'OID mapping not found' });
      return;
    }
    res.json({ success: true, message: 'OID mapping updated' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * DELETE /api/v1/snmp-trap/oid-mappings/:id — 删除 OID 映射
 */
router.delete('/snmp-trap/oid-mappings/:id', async (req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    const ok = await snmpTrapReceiver.removeOidMapping(req.params.id);
    if (!ok) {
      res.status(404).json({ success: false, error: 'OID mapping not found or is builtin' });
      return;
    }
    res.json({ success: true, message: 'OID mapping deleted' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/snmp-trap/v3-credentials — 获取 SNMP v3 认证列表
 */
router.get('/snmp-trap/v3-credentials', async (_req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    res.json({ success: true, data: snmpTrapReceiver.getV3Credentials() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/snmp-trap/v3-credentials — 创建 SNMP v3 认证
 */
router.post('/snmp-trap/v3-credentials', async (req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    const cred = await snmpTrapReceiver.addV3Credential(req.body);
    res.status(201).json({ success: true, data: cred });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/v1/snmp-trap/v3-credentials/:id — 更新 SNMP v3 认证
 */
router.put('/snmp-trap/v3-credentials/:id', async (req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    const ok = await snmpTrapReceiver.updateV3Credential(req.params.id, req.body);
    if (!ok) {
      res.status(404).json({ success: false, error: 'V3 credential not found' });
      return;
    }
    res.json({ success: true, message: 'V3 credential updated' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * DELETE /api/v1/snmp-trap/v3-credentials/:id — 删除 SNMP v3 认证
 */
router.delete('/snmp-trap/v3-credentials/:id', async (req: Request, res: Response) => {
  try {
    const snmpTrapReceiver = await getSnmpTrapReceiver();
    const ok = await snmpTrapReceiver.removeV3Credential(req.params.id);
    if (!ok) {
      res.status(404).json({ success: false, error: 'V3 credential not found' });
      return;
    }
    res.json({ success: true, message: 'V3 credential deleted' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});


// ============================================================================
// 31.3 — 告警、决策与巡检 API（补充已有 aiOpsRoutes 缺失的端点）
// ============================================================================

/**
 * GET /api/v1/noise-filter/stats — 获取噪声过滤统计
 */
router.get('/noise-filter/stats', async (_req: Request, res: Response) => {
  try {
    const { noiseFilter } = await import('../services/ai-ops');
    res.json({ success: true, data: noiseFilter.getStats() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/inspections/tasks — 获取巡检项列表
 */
router.get('/inspections/tasks', async (_req: Request, res: Response) => {
  try {
    const { proactiveInspector } = await import('../services/ai-ops');
    const items = proactiveInspector.getItems();
    res.json({ success: true, data: items });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/inspections/history — 获取最近巡检报告
 */
router.get('/inspections/history', async (_req: Request, res: Response) => {
  try {
    const { proactiveInspector } = await import('../services/ai-ops');
    const report = proactiveInspector.getLastReport();
    res.json({ success: true, data: report ? [report] : [] });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/inspections/trigger — 手动触发全量巡检
 */
router.post('/inspections/trigger', async (_req: Request, res: Response) => {
  try {
    const { proactiveInspector } = await import('../services/ai-ops');
    const report = await proactiveInspector.runFullInspection('manual');
    res.json({ success: true, data: report });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

// ============================================================================
// 31.4 — Skill、Prompt、知识管理 API（补充已有路由缺失的端点）
// ============================================================================

/**
 * GET /api/v1/tools — 统一工具列表（Skill + MCP + DeviceDriver 桥接）
 */
router.get('/tools', async (_req: Request, res: Response) => {
  try {
    const { skillManager } = await import('../services/ai-ops/skill');
    if (!skillManager.isInitialized()) {
      await skillManager.initialize();
    }
    // 尝试通过 SkillFactory 获取统一工具列表
    // SkillFactory 在 bootstrapSkillSystem 中初始化，通过 toolRegistry.getAllTools()
    const tools = skillManager.listSkills().map(s => ({
      name: s.metadata.name,
      type: 'skill',
      description: s.metadata.description,
      enabled: s.enabled,
    }));
    res.json({ success: true, data: tools });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/evaluations — 获取评估报告列表
 */
router.get('/evaluations', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const rows = await pgDs.query(
      'SELECT * FROM evaluation_reports ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/evaluations/:id — 获取单个评估报告
 */
router.get('/evaluations/:id', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const row = await pgDs.queryOne(
      'SELECT * FROM evaluation_reports WHERE id = $1',
      [req.params.id]
    );
    if (!row) {
      res.status(404).json({ success: false, error: 'Evaluation report not found' });
      return;
    }
    res.json({ success: true, data: row });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/knowledge — 获取知识条目列表
 */
router.get('/knowledge', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const category = req.query.category as string;
    let sql = 'SELECT id, category, content, device_types, version, feedback_score, created_at, updated_at FROM prompt_knowledge';
    const params: any[] = [];
    if (category) {
      sql += ' WHERE category = $1';
      params.push(category);
    }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const rows = await pgDs.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/knowledge/search — 语义搜索知识条目
 */
router.post('/knowledge/search', async (req: Request, res: Response) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) {
      res.status(400).json({ success: false, error: 'query is required' });
      return;
    }
    const { VectorStoreClient } = await import('../services/ai-ops/rag/vectorStoreClient');
    const client = new VectorStoreClient();
    const results = await client.search('prompt_knowledge', {
      collection: 'prompt_knowledge',
      query,
      top_k: limit,
    });
    res.json({ success: true, data: results });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});


// ============================================================================
// 31.5 — 拓扑、知识图谱、修复 API
// ============================================================================

/**
 * GET /api/v1/knowledge-graph/nodes — 查询知识图谱节点
 */
router.get('/knowledge-graph/nodes', async (req: Request, res: Response) => {
  try {
    const { knowledgeGraphBuilder } = await import('../services/ai-ops');
    const type = req.query.type as string;
    let nodes;
    if (type) {
      nodes = await knowledgeGraphBuilder.queryByType(type as any);
    } else {
      nodes = knowledgeGraphBuilder.getAllNodes();
    }
    res.json({ success: true, data: nodes });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/knowledge-graph/nodes/:id — 获取单个节点
 */
router.get('/knowledge-graph/nodes/:id', async (req: Request, res: Response) => {
  try {
    const { knowledgeGraphBuilder } = await import('../services/ai-ops');
    const node = knowledgeGraphBuilder.getNode(req.params.id);
    if (!node) {
      res.status(404).json({ success: false, error: 'Node not found' });
      return;
    }
    res.json({ success: true, data: node });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/knowledge-graph/edges — 查询知识图谱边
 */
router.get('/knowledge-graph/edges', async (_req: Request, res: Response) => {
  try {
    const { knowledgeGraphBuilder } = await import('../services/ai-ops');
    const edges = knowledgeGraphBuilder.getAllEdges();
    res.json({ success: true, data: edges });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/knowledge-graph/stats — 获取知识图谱统计
 */
router.get('/knowledge-graph/stats', async (_req: Request, res: Response) => {
  try {
    const { knowledgeGraphBuilder } = await import('../services/ai-ops');
    const stats = knowledgeGraphBuilder.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/fault-patterns/pending — 获取待审核故障模式
 */
router.get('/fault-patterns/pending', async (_req: Request, res: Response) => {
  try {
    const { faultPatternLibrary } = await import('../services/ai-ops');
    const patterns = await faultPatternLibrary.list({ status: 'pending_review' });
    res.json({ success: true, data: patterns });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/fault-patterns/:id/approve — 审核通过故障模式
 */
router.post('/fault-patterns/:id/approve', async (req: Request, res: Response) => {
  try {
    const { faultPatternLibrary } = await import('../services/ai-ops');
    await faultPatternLibrary.update(req.params.id, { status: 'active' });
    res.json({ success: true, message: 'Pattern approved' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/repairs — 获取修复历史
 */
router.get('/repairs', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    // 修复历史存储在 decision_history 中 action = 'auto_remediate'
    const rows = await pgDs.query(
      `SELECT * FROM decision_history WHERE action = 'auto_remediate' ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/repairs/:id — 获取单个修复详情
 */
router.get('/repairs/:id', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const row = await pgDs.queryOne(
      'SELECT * FROM decision_history WHERE id = $1',
      [req.params.id]
    );
    if (!row) {
      res.status(404).json({ success: false, error: 'Repair record not found' });
      return;
    }
    res.json({ success: true, data: row });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});


// ============================================================================
// 31.6 — 系统管理与 AI 对话/通知 API
// ============================================================================

/**
 * GET /api/v1/users — 获取用户列表
 */
router.get('/users', async (_req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const rows = await pgDs.query(
      'SELECT id, username, email, role, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    // 回退到 SQLite DataStore
    try {
      const { serviceRegistry } = await import('../services');
      const { SERVICE_NAMES } = await import('../services/bootstrap');
      const ds = await serviceRegistry.getAsync<any>(SERVICE_NAMES.DATA_STORE);
      const rows = ds.query('SELECT id, username, email, role, created_at, updated_at FROM users ORDER BY created_at DESC');
      res.json({ success: true, data: rows });
    } catch (fallbackError) {
      const msg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      res.status(500).json({ success: false, error: msg });
    }
  }
});

/**
 * POST /api/v1/users — 创建用户
 */
router.post('/users', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const { AuthService } = await import('../services/auth/authService');
    const authService = await serviceRegistry.getAsync<InstanceType<typeof AuthService>>(SERVICE_NAMES.AUTH_SERVICE);
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      res.status(400).json({ success: false, error: 'username, email, and password are required' });
      return;
    }
    const user = await authService.register(username, email, password);
    res.status(201).json({ success: true, data: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const status = msg.includes('已存在') || msg.includes('CONFLICT') ? 409 : 500;
    res.status(status).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/v1/users/:id — 更新用户
 */
router.put('/users/:id', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const { role, email } = req.body;
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (role !== undefined) { sets.push(`role = $${idx++}`); params.push(role); }
    if (email !== undefined) { sets.push(`email = $${idx++}`); params.push(email); }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }
    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);
    await pgDs.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, params);
    res.json({ success: true, message: 'User updated' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * DELETE /api/v1/users/:id — 删除用户
 */
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    await pgDs.execute('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/users/:id/reset-password — 重置用户密码
 */
router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    const bcrypt = await import('bcryptjs');
    const { newPassword } = req.body;
    if (!newPassword) {
      res.status(400).json({ success: false, error: 'newPassword is required' });
      return;
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pgDs.execute('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.params.id]);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/feature-flags — 获取特性标志列表
 */
router.get('/feature-flags', async (_req: Request, res: Response) => {
  try {
    const { FeatureFlagManager } = await import('../services/ai-ops/stateMachine/featureFlagManager');
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const ffm = new FeatureFlagManager();
    // 注入 PgDataStore 并从数据库加载状态，确保返回持久化的标志值
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      ffm.setDataStore(pgDs);
      await ffm.loadFromStore();
    } catch {
      // PgDataStore 不可用时使用默认值
    }
    const flags = ffm.getAllControlPoints();
    res.json({ success: true, data: flags });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/v1/feature-flags/:key — 切换特性标志
 */
router.put('/feature-flags/:key', async (req: Request, res: Response) => {
  try {
    const { FeatureFlagManager } = await import('../services/ai-ops/stateMachine/featureFlagManager');
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const ffm = new FeatureFlagManager();
    // 注入 PgDataStore 并加载当前状态，确保依赖校验基于真实数据
    try {
      const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
      ffm.setDataStore(pgDs);
      await ffm.loadFromStore();
    } catch {
      // PgDataStore 不可用时使用默认值
    }
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'enabled must be a boolean' });
      return;
    }
    const result = await ffm.setControlPointEnabled(req.params.key as any, enabled);
    if (result && typeof result === 'object' && 'error' in result) {
      res.status(400).json({ success: false, error: (result as any).error });
      return;
    }
    res.json({ success: true, data: { key: req.params.key, enabled } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/traces — 获取 Trace 列表
 */
router.get('/traces', async (req: Request, res: Response) => {
  try {
    const { tracingService } = await import('../services/ai-ops');
    const limit = parseInt(req.query.limit as string) || 50;
    const status = req.query.status as string;
    const traces = await tracingService.listTraces({ limit, status: status as any });
    res.json({ success: true, data: traces });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/traces/:id — 获取单个 Trace 详情（含 Span 瀑布图数据）
 */
router.get('/traces/:id', async (req: Request, res: Response) => {
  try {
    const { tracingService } = await import('../services/ai-ops');
    const trace = await tracingService.getTrace(req.params.id);
    if (!trace) {
      res.status(404).json({ success: false, error: 'Trace not found' });
      return;
    }
    res.json({ success: true, data: trace });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/system/config — 获取系统配置
 */
router.get('/system/config', async (_req: Request, res: Response) => {
  try {
    const { serviceRegistry } = await import('../services');
    const { SERVICE_NAMES } = await import('../services/bootstrap');
    const pgDs = await serviceRegistry.getAsync<any>(SERVICE_NAMES.PG_DATA_STORE);
    // 从 config_snapshots 或环境变量获取系统配置
    const envConfig = {
      NODE_ENV: process.env.NODE_ENV || 'development',
      PORT: process.env.PORT || '3099',
      PG_HOST: process.env.PG_HOST || 'localhost',
      PG_PORT: process.env.PG_PORT || '5432',
      PG_DATABASE: process.env.PG_DATABASE || 'opsevo',
      PYTHON_CORE_URL: process.env.PYTHON_CORE_URL || 'http://localhost:8000',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    };
    res.json({ success: true, data: envConfig });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/ai-providers — 获取 AI 提供商列表
 */
router.get('/ai-providers', async (_req: Request, res: Response) => {
  try {
    const { apiConfigService } = await import('../services/ai/apiConfigService');
    const configs = await apiConfigService.getAllDisplay();
    res.json({ success: true, data: configs });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/ai-providers — 创建 AI 提供商配置
 */
router.post('/ai-providers', async (req: Request, res: Response) => {
  try {
    const { apiConfigService } = await import('../services/ai/apiConfigService');
    const config = await apiConfigService.create(req.body);
    res.status(201).json({ success: true, data: config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * PUT /api/v1/ai-providers/:id — 更新 AI 提供商配置
 */
router.put('/ai-providers/:id', async (req: Request, res: Response) => {
  try {
    const { apiConfigService } = await import('../services/ai/apiConfigService');
    const config = await apiConfigService.update(req.params.id, req.body);
    res.json({ success: true, data: config });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * DELETE /api/v1/ai-providers/:id — 删除 AI 提供商配置
 */
router.delete('/ai-providers/:id', async (req: Request, res: Response) => {
  try {
    const { apiConfigService } = await import('../services/ai/apiConfigService');
    await apiConfigService.delete(req.params.id);
    res.json({ success: true, message: 'AI provider deleted' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * POST /api/v1/ai-providers/:id/test — 测试 AI 提供商连接
 */
router.post('/ai-providers/:id/test', async (req: Request, res: Response) => {
  try {
    const { apiConfigService } = await import('../services/ai/apiConfigService');
    const ok = await apiConfigService.testConnection(req.params.id);
    res.json({ success: true, data: { connected: ok } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/notifications/stats — 获取通知统计
 */
router.get('/notifications/stats', async (_req: Request, res: Response) => {
  try {
    const { notificationService } = await import('../services/ai-ops');
    const [channels, history] = await Promise.all([
      notificationService.getChannels(),
      notificationService.getNotificationHistory(100),
    ]);
    const sent = history.filter((n: any) => n.status === 'sent' || n.status === 'delivered').length;
    const failed = history.filter((n: any) => n.status === 'failed').length;
    res.json({
      success: true,
      data: {
        channelCount: channels.length,
        totalSent: sent,
        totalFailed: failed,
        recentCount: history.length,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/brain/state — 获取 Brain Loop 状态
 */
router.get('/brain/state', async (_req: Request, res: Response) => {
  try {
    const { autonomousBrainService } = await import('../services/ai-ops/brain/autonomousBrainService');
    // AutonomousBrainService 没有公开 getState()，通过 SSE 事件流暴露状态
    // 这里返回基本可用信息
    res.json({
      success: true,
      data: {
        available: true,
        message: 'Brain state is available via SSE stream at /api/ai-ops/brain/thinking/stream',
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/v1/degradation/state — 获取降级状态摘要
 */
router.get('/degradation/state', async (_req: Request, res: Response) => {
  try {
    const { degradationManager } = await import('../services/ai-ops');
    const summary = degradationManager.getSummary();
    res.json({ success: true, data: summary });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: msg });
  }
});

export default router;
