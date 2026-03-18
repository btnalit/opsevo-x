/**
 * 设备代理中间件单元测试
 *
 * 测试 deviceMiddleware 核心功能：
 * - 缺少 deviceId：返回 400
 * - 缺少 tenantId（未认证）：返回 401
 * - 设备不属于当前租户：返回 403
 * - 设备连接成功：注入 req.routerosClient 和 req.deviceId，调用 next()
 * - 设备未连接时自动尝试连接
 * - DevicePool 连接失败：返回 502
 * - DevicePool FORBIDDEN 错误：返回 403
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { Request, Response, NextFunction } from 'express';
import { createDeviceMiddleware } from './deviceProxy';
import { DeviceManager } from '../services/device/deviceManager';
import { DevicePool, DevicePoolError } from '../services/device/devicePool';
import { DataStore } from '../services/core/dataStore';
import { RouterOSClient } from '../services/routerosClient';
import * as path from 'path';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'tenant-001';
const TEST_DEVICE_ID = 'device-001';
const OTHER_TENANT_ID = 'tenant-002';

async function createTestDataStore(): Promise<DataStore> {
  const store = new DataStore({
    inMemory: true,
    migrationsPath: path.join(__dirname, '__no_migrations__'),
  });
  await store.initialize();

  // Create the devices table for DeviceManager
  store.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 8728,
      username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      use_tls INTEGER DEFAULT 0,
      group_name TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'offline',
      last_seen TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  return store;
}

function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

function createMockRequest(
  params: Record<string, string> = {},
  tenantId?: string,
): Request {
  const req: Partial<Request> = {
    params: params as any,
    tenantId,
  };
  return req as Request;
}

/**
 * Create a mock RouterOSClient for testing
 */
function createMockRouterOSClient(): RouterOSClient {
  const client = {
    isConnected: jest.fn().mockReturnValue(true),
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(undefined),
    print: jest.fn().mockResolvedValue([]),
  } as unknown as RouterOSClient;
  return client;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('deviceMiddleware', () => {
  let dataStore: DataStore;
  let deviceManager: DeviceManager;
  let mockDevicePool: DevicePool;
  let middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  let mockClient: RouterOSClient;

  beforeEach(async () => {
    dataStore = await createTestDataStore();
    deviceManager = new DeviceManager(dataStore);

    // Create a test device
    await deviceManager.createDevice(TEST_TENANT_ID, {
      name: 'Test Router',
      host: '192.168.1.1',
      port: 8728,
      username: 'admin',
      password: 'password123',
      use_tls: false,
    });

    // Create a mock DevicePool
    mockClient = createMockRouterOSClient();
    mockDevicePool = {
      getConnection: jest.fn().mockResolvedValue(mockClient),
      releaseConnection: jest.fn().mockResolvedValue(undefined),
      disconnectAll: jest.fn().mockResolvedValue(undefined),
      getPoolStats: jest.fn().mockReturnValue({ total: 1, connected: 1, idle: 0 }),
      destroy: jest.fn().mockResolvedValue(undefined),
      getConnectionsMap: jest.fn().mockReturnValue(new Map()),
    } as unknown as DevicePool;

    middleware = createDeviceMiddleware(deviceManager, mockDevicePool);
  });

  afterEach(async () => {
    if (dataStore) {
      await dataStore.close();
    }
  });

  // ─── Missing deviceId ───────────────────────────────────────────────────

  describe('missing deviceId', () => {
    it('should return 400 when deviceId is not in params', async () => {
      const req = createMockRequest({}, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '缺少设备 ID' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Missing tenantId (unauthenticated) ─────────────────────────────────

  describe('missing tenantId', () => {
    it('should return 401 when tenantId is not injected', async () => {
      const req = createMockRequest({ deviceId: TEST_DEVICE_ID });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '未提供认证信息' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Device not belonging to tenant ─────────────────────────────────────

  describe('device not belonging to tenant', () => {
    it('should return 403 when device does not belong to the tenant', async () => {
      const req = createMockRequest(
        { deviceId: TEST_DEVICE_ID },
        OTHER_TENANT_ID,
      );
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '无权访问该设备' }),
      );
      expect(next).not.toHaveBeenCalled();
      expect(mockDevicePool.getConnection).not.toHaveBeenCalled();
    });

    it('should return 403 when device does not exist', async () => {
      const req = createMockRequest(
        { deviceId: 'nonexistent-device' },
        TEST_TENANT_ID,
      );
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '无权访问该设备' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Successful connection ──────────────────────────────────────────────

  describe('successful connection', () => {
    it('should inject routerosClient and deviceId and call next()', async () => {
      // We need to get the actual device ID from the database
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(req.routerosClient).toBe(mockClient);
      expect(req.deviceId).toBe(deviceId);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(mockDevicePool.getConnection).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        deviceId,
      );
    });

    it('should not send any response on success', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  // ─── DevicePool errors ──────────────────────────────────────────────────

  describe('DevicePool errors', () => {
    it('should return 502 when DevicePool connection fails', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      (mockDevicePool.getConnection as jest.Mock).mockRejectedValue(
        new DevicePoolError('设备不可达', 'CONNECTION_FAILED'),
      );

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('设备连接失败'),
          code: 'CONNECTION_FAILED',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when DevicePool returns FORBIDDEN error', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      (mockDevicePool.getConnection as jest.Mock).mockRejectedValue(
        new DevicePoolError('无权访问该设备连接', 'FORBIDDEN'),
      );

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: '无权访问该设备',
          code: 'FORBIDDEN',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 500 for unexpected errors', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      (mockDevicePool.getConnection as jest.Mock).mockRejectedValue(
        new Error('Unexpected internal error'),
      );

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: '内部服务器错误' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ─── Auto-connect behavior ──────────────────────────────────────────────

  describe('auto-connect behavior', () => {
    it('should pass tenantId and deviceId to DevicePool.getConnection for auto-connect', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      // DevicePool.getConnection handles auto-connect internally
      expect(mockDevicePool.getConnection).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        deviceId,
      );
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
