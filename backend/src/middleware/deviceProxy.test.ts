/**
 * 设备代理中间件单元测试
 *
 * 测试 deviceMiddleware 核心功能：
 * - 缺少 deviceId：返回 400
 * - 缺少 tenantId（未认证）：返回 401
 * - 设备不属于当前租户：返回 403
 * - 设备连接成功：注入 req.deviceId，调用 next()
 * - 设备未连接时自动尝试连接（DevicePool 回退）
 * - DevicePool 连接失败：返回 502
 * - DevicePool FORBIDDEN 错误：返回 403
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { Request, Response, NextFunction } from 'express';
import { createDeviceMiddleware } from './deviceProxy';
import { DeviceManager } from '../services/device/deviceManager';
import { DevicePool, DevicePoolError } from '../services/device/devicePool';
import type { DataStore } from '../services/dataStore';
import { createMockPgDataStore } from '../test/helpers/mockPgDataStore';
import { deviceDriverManager } from '../services/device/deviceDriverManager';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_TENANT_ID = 'tenant-001';
const TEST_DEVICE_ID = 'device-001';
const OTHER_TENANT_ID = 'tenant-002';

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
 * Create a mock DeviceDriver for testing
 */
function createMockDeviceDriver(): any {
  return {
    execute: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([]),
    isConnected: jest.fn().mockReturnValue(true),
  };
}

// Mock deviceDriverManager
jest.mock('../services/device/deviceDriverManager', () => ({
  deviceDriverManager: {
    getDriver: jest.fn(),
  },
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('deviceMiddleware', () => {
  let dataStore: DataStore;
  let deviceManager: DeviceManager;
  let mockDevicePool: DevicePool;
  let middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  let mockDriver: any;

  beforeEach(async () => {
    dataStore = createMockPgDataStore();
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

    // Create a mock DeviceDriver
    mockDriver = createMockDeviceDriver();

    // Mock deviceDriverManager.getDriver to return the mock driver
    (deviceDriverManager.getDriver as jest.Mock).mockReturnValue(mockDriver);

    // Create a mock DevicePool (used as fallback when driver not found)
    mockDevicePool = {
      getConnection: jest.fn().mockResolvedValue({}),
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
    it('should inject deviceId and deviceDriver and call next()', async () => {
      // We need to get the actual device ID from the database
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(req.deviceId).toBe(deviceId);
      expect(req.deviceDriver).toBe(mockDriver);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
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

  describe('DevicePool fallback errors', () => {
    it('should still call next() when driver not found and DevicePool fallback fails silently', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      // Simulate no driver available, forcing DevicePool fallback
      (deviceDriverManager.getDriver as jest.Mock).mockReturnValue(null);
      (mockDevicePool.getConnection as jest.Mock).mockRejectedValue(
        new DevicePoolError('设备不可达', 'CONNECTION_FAILED'),
      );

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      // DevicePool fallback error is caught silently, middleware still calls next()
      expect(req.deviceId).toBe(deviceId);
      expect(req.deviceDriver).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should return 403 when DevicePool returns FORBIDDEN error from outer catch', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      // Mock deviceManager.getDevice to throw DevicePoolError
      jest.spyOn(deviceManager, 'getDevice').mockRejectedValue(
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

      // Mock deviceManager.getDevice to throw unexpected error
      jest.spyOn(deviceManager, 'getDevice').mockRejectedValue(
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
    it('should use DeviceDriverManager first, skip DevicePool when driver exists', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      // DeviceDriverManager found a driver, DevicePool should NOT be called
      expect(deviceDriverManager.getDriver).toHaveBeenCalledWith(deviceId);
      expect(mockDevicePool.getConnection).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should fall back to DevicePool when driver not found', async () => {
      const devices = await deviceManager.getDevices(TEST_TENANT_ID);
      const deviceId = devices[0].id;

      // First call returns null (no driver), second call after pool connection returns driver
      (deviceDriverManager.getDriver as jest.Mock)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(mockDriver);

      const req = createMockRequest({ deviceId }, TEST_TENANT_ID);
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      // DevicePool should be called as fallback
      expect(mockDevicePool.getConnection).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        deviceId,
      );
      expect(req.deviceDriver).toBe(mockDriver);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
