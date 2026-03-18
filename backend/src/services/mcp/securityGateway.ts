/**
 * SecurityGateway - MCP Server 安全网关（Express 中间件）
 *
 * 负责认证（API Key）、授权（角色权限矩阵）、限流（滑动窗口）
 * 所有认证/授权/限流结果记录到 AuditLogger
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import { Request, Response, NextFunction } from 'express';
import { ApiKeyManager, SecurityContext } from './apiKeyManager';
import { auditLogger } from '../ai-ops/auditLogger';
import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

/** 角色权限等级 */
const ROLE_LEVEL: Record<string, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

/** 工具类别对应的最低角色 */
export const TOOL_MIN_ROLE: Record<string, 'viewer' | 'operator' | 'admin'> = {
  // 数据查询工具
  'metrics.getLatest': 'viewer',
  'metrics.getHistory': 'viewer',
  'alert.getHistory': 'viewer',
  'topology.getSnapshot': 'viewer',
  // 高层意图工具
  'network.diagnose': 'operator',
  'alert.analyze': 'operator',
  'topology.query': 'operator',
  // 低层操作工具
  'device.executeCommand': 'admin',
  'device.getConfig': 'admin',
};

/** 滑动窗口限流条目 */
interface RateLimitEntry {
  windowStart: number;
  requestCount: number;
}

/** SecurityGateway 配置 */
export interface SecurityGatewayConfig {
  perTenantRateLimit: number; // 每分钟每租户请求上限
}

// 扩展 Express Request 类型
declare global {
  namespace Express {
    interface Request {
      mcpContext?: SecurityContext;
    }
  }
}

// ─── SecurityGateway ─────────────────────────────────────────────────────────

/**
 * 创建 SecurityGateway Express 中间件
 */
export function createSecurityGateway(
  apiKeyManager: ApiKeyManager,
  config: SecurityGatewayConfig = { perTenantRateLimit: 60 }
): (req: Request, res: Response, next: NextFunction) => void {
  const rateLimitMap = new Map<string, RateLimitEntry>();
  const WINDOW_MS = 60_000; // 1 分钟滑动窗口

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientId = req.headers['user-agent'] || req.headers['x-client-id'] as string || 'unknown';

    // 1. 提取 API Key
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      await logAuditRejection('auth_failed', 'Missing or invalid Authorization header', clientId);
      res.status(401).json({ error: 'Authentication required. Provide Authorization: Bearer <api-key>' });
      return;
    }

    const rawKey = authHeader.substring(7); // 去掉 "Bearer "

    // 2. 验证 API Key
    const securityContext = await apiKeyManager.validateKey(rawKey);
    if (!securityContext) {
      await logAuditRejection('auth_failed', 'Invalid or revoked API Key', clientId);
      res.status(401).json({ error: 'Invalid or revoked API Key' });
      return;
    }

    securityContext.clientId = clientId;

    // 3. 租户限流（滑动窗口）
    const now = Date.now();
    let entry = rateLimitMap.get(securityContext.tenantId);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      // 窗口过期或不存在，重置
      entry = { windowStart: now, requestCount: 0 };
      rateLimitMap.set(securityContext.tenantId, entry);
    }

    entry.requestCount++;

    if (entry.requestCount > config.perTenantRateLimit) {
      await logAuditRejection(
        'rate_limited',
        `Tenant ${securityContext.tenantId} exceeded rate limit (${config.perTenantRateLimit}/min)`,
        clientId,
        securityContext
      );
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    // 4. 注入 SecurityContext
    req.mcpContext = securityContext;

    // 5. 记录认证成功
    auditLogger.log({
      action: 'mcp_auth_success' as any,
      actor: 'system',
      source: 'mcp_server',
      details: {
        tenantId: securityContext.tenantId,
        role: securityContext.role,
        clientId,
        apiKeyId: securityContext.apiKeyId,
      },
    }).catch(() => { /* non-critical */ });

    next();
  };
}

/**
 * 检查角色权限：请求者角色是否满足工具要求的最低角色
 */
export function checkRolePermission(
  requestRole: string,
  minRole: string
): boolean {
  const requestLevel = ROLE_LEVEL[requestRole] ?? -1;
  const requiredLevel = ROLE_LEVEL[minRole] ?? 999;
  return requestLevel >= requiredLevel;
}

/**
 * 获取工具的最低角色要求
 */
export function getToolMinRole(toolName: string): 'viewer' | 'operator' | 'admin' {
  return TOOL_MIN_ROLE[toolName] || 'admin'; // 默认要求 admin
}

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

async function logAuditRejection(
  reason: string,
  message: string,
  clientId: string,
  securityContext?: SecurityContext
): Promise<void> {
  logger.warn(`[SecurityGateway] Rejected: ${reason} — ${message}`);
  auditLogger.log({
    action: 'mcp_auth_rejected' as any,
    actor: 'system',
    source: 'mcp_server',
    details: {
      reason,
      message,
      clientId,
      tenantId: securityContext?.tenantId,
      role: securityContext?.role,
    },
  }).catch(() => { /* non-critical */ });
}
