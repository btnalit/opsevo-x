/**
 * Task 33.2 — DeviceManager 分发链验证
 *
 * 验证:
 * - API 请求 → Controller → DeviceManager → DataStore
 * - CRUD 操作完整性 (create / get / update / delete)
 * - 输入校验 (name, host, username, password, port)
 * - 跨租户隔离
 *
 * Requirements: A1.3, A10.44-48
 */

import { DeviceManager } from '../../../device/deviceManager';

// ─── Mock DataStore (better-sqlite3 style: synchronous run/query) ───

function makeMockDataStore() {
  const devices: any[] = [];

  const store = {
    run: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('INSERT INTO devices')) {
        const row = {
          id: params?.[0],
          tenant_id: params?.[1],
          name: params?.[2],
          host: params?.[3],
          port: params?.[4],
          username: params?.[5],
          password_encrypted: params?.[6],
          use_tls: params?.[7],
          group_name: params?.[8],
          tags: params?.[9],
          status: 'offline',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_seen: null,
          error_message: null,
        };
        devices.push(row);
        return { changes: 1, lastInsertRowid: devices.length };
      }
      if (sql.includes('UPDATE devices SET')) {
        return { changes: 1, lastInsertRowid: 0 };
      }
      if (sql.includes('DELETE')) {
        const idParam = params?.[0];
        const idx = devices.findIndex((d) => d.id === idParam);
        if (idx >= 0) devices.splice(idx, 1);
        return { changes: 1, lastInsertRowid: 0 };
      }
      return { changes: 0, lastInsertRowid: 0 };
    }),

    query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('SELECT * FROM devices WHERE id = ? AND tenant_id = ?')) {
        const id = params?.[0];
        const tenantId = params?.[1];
        return devices.filter((d) => d.id === id && d.tenant_id === tenantId);
      }
      if (sql.includes('SELECT * FROM devices WHERE id = ? LIMIT 1')) {
        const id = params?.[0];
        return devices.filter((d) => d.id === id).slice(0, 1);
      }
      if (sql.includes('SELECT * FROM devices') && sql.includes('tenant_id = ?')) {
        const tenantId = params?.[0];
        return devices.filter((d) => d.tenant_id === tenantId);
      }
      if (sql.includes('SELECT * FROM devices') && !sql.includes('WHERE')) {
        return [...devices];
      }
      if (sql.includes('SELECT 1') && sql.includes('FROM devices LIMIT 1')) {
        return devices.length > 0 ? [{ found: 1 }] : [];
      }
      return [];
    }),

    transaction: jest.fn().mockImplementation((fn: () => any) => fn()),
  };

  return { store, devices };
}

// ─── Tests ───

describe('Task 33.2 — DeviceManager 分发链验证', () => {
  const TENANT = 'tenant-001';

  const validInput = {
    name: 'router-core-1',
    host: '192.168.1.1',
    port: 8728,
    username: 'admin',
    password: 'secret123',
    use_tls: false,
    group_name: 'core-routers',
    tags: ['core', 'production'],
  };

  describe('createDevice → DataStore.run(INSERT) → getDevice(SELECT)', () => {
    it('应成功创建设备并返回完整 Device 对象', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const device = await dm.createDevice(TENANT, validInput);

      expect(device).toBeDefined();
      expect(device.name).toBe('router-core-1');
      expect(device.host).toBe('192.168.1.1');
      expect(device.port).toBe(8728);
      expect(device.tenant_id).toBe(TENANT);
      expect(device.status).toBe('offline');
      expect(device.tags).toEqual(['core', 'production']);
      // password should be encrypted, not plaintext
      expect(device.password_encrypted).not.toBe('secret123');
      expect(device.password_encrypted.length).toBeGreaterThan(0);
    });

    it('run() 应被调用一次 (INSERT)', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await dm.createDevice(TENANT, validInput);

      const insertCalls = store.run.mock.calls.filter((c: any[]) =>
        c[0].includes('INSERT INTO devices'),
      );
      expect(insertCalls).toHaveLength(1);
    });

    it('query() 应被调用以读回新设备', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await dm.createDevice(TENANT, validInput);

      const selectCalls = store.query.mock.calls.filter((c: any[]) =>
        c[0].includes('SELECT'),
      );
      expect(selectCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('默认端口应为 8728', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const input = { ...validInput, port: undefined };
      const device = await dm.createDevice(TENANT, input);

      expect(device.port).toBe(8728);
    });
  });

  describe('getDevices — 租户隔离', () => {
    it('应只返回指定租户的设备', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await dm.createDevice('tenant-A', { ...validInput, name: 'dev-A' });
      await dm.createDevice('tenant-B', { ...validInput, name: 'dev-B', host: '10.0.0.2' });

      const devicesA = await dm.getDevices('tenant-A');
      expect(devicesA.every((d) => d.tenant_id === 'tenant-A')).toBe(true);
    });

    it('跨租户查询无 allowCrossTenant 应抛出 FORBIDDEN', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await expect(dm.getDevices('*')).rejects.toThrow('跨租户查询被拒绝');
    });

    it('跨租户查询有 allowCrossTenant 应成功', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await dm.createDevice('tenant-A', { ...validInput, name: 'dev-A' });
      const all = await dm.getDevices('*', undefined, { allowCrossTenant: true });
      expect(Array.isArray(all)).toBe(true);
    });
  });

  describe('updateDevice → DataStore.run(UPDATE)', () => {
    it('应更新设备名称', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const created = await dm.createDevice(TENANT, validInput);
      const updated = await dm.updateDevice(TENANT, created.id, { name: 'router-renamed' });

      expect(updated).toBeDefined();
      // run should have been called for UPDATE
      const updateCalls = store.run.mock.calls.filter((c: any[]) =>
        c[0].includes('UPDATE devices SET'),
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('更新不存在的设备应抛出 NOT_FOUND', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await expect(
        dm.updateDevice(TENANT, 'nonexistent-id', { name: 'x' }),
      ).rejects.toThrow('设备不存在');
    });
  });

  describe('deleteDevice → transaction + 级联删除', () => {
    it('应在事务中执行级联删除', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const created = await dm.createDevice(TENANT, validInput);
      await dm.deleteDevice(TENANT, created.id);

      expect(store.transaction).toHaveBeenCalled();
      // Should have multiple DELETE calls (cascade + device itself)
      const deleteCalls = store.run.mock.calls.filter((c: any[]) =>
        c[0].includes('DELETE'),
      );
      expect(deleteCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('输入校验', () => {
    it.each([
      [{ ...validInput, name: '' }, '设备名称不能为空'],
      [{ ...validInput, host: '' }, '设备主机地址不能为空'],
      [{ ...validInput, username: '' }, '设备用户名不能为空'],
      [{ ...validInput, password: '' }, '设备密码不能为空'],
      [{ ...validInput, port: 0 }, '端口号必须在 1-65535 之间'],
      [{ ...validInput, port: 70000 }, '端口号必须在 1-65535 之间'],
    ])('无效输入应抛出 INVALID_INPUT: %s', async (input, expectedMsg) => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await expect(dm.createDevice(TENANT, input as any)).rejects.toThrow(expectedMsg);
    });
  });

  describe('updateStatus', () => {
    it('应更新设备状态为 online', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await dm.createDevice(TENANT, validInput);
      // updateStatus uses run() with UPDATE
      await dm.updateStatus(store.run.mock.calls[0][1][0], 'online');

      const statusUpdateCalls = store.run.mock.calls.filter(
        (c: any[]) => c[0].includes('UPDATE devices SET') && c[0].includes('status'),
      );
      expect(statusUpdateCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('无效状态应抛出 INVALID_STATUS', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await expect(dm.updateStatus('dev-1', 'invalid-status' as any)).rejects.toThrow(
        '无效的设备状态',
      );
    });
  });

  describe('密码加密', () => {
    it('encryptPassword / decryptPassword 应可逆', () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const encrypted = dm.encryptPassword('my-secret');
      const decrypted = dm.decryptPassword(encrypted);
      expect(decrypted).toBe('my-secret');
    });

    it('空密码应抛出错误', () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      expect(() => dm.encryptPassword('')).toThrow('密码不能为空');
    });
  });

  describe('findDeviceByIdAcrossTenants', () => {
    it('应跨租户查找设备', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const created = await dm.createDevice(TENANT, validInput);
      const found = await dm.findDeviceByIdAcrossTenants(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('不存在的设备应返回 null', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const found = await dm.findDeviceByIdAcrossTenants('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('hasAvailableDevices', () => {
    it('无设备时应返回 false', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      const has = await dm.hasAvailableDevices();
      expect(has).toBe(false);
    });

    it('有设备时应返回 true', async () => {
      const { store } = makeMockDataStore();
      const dm = new DeviceManager(store as any);

      await dm.createDevice(TENANT, validInput);
      const has = await dm.hasAvailableDevices();
      expect(has).toBe(true);
    });
  });
});
