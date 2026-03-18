/**
 * DevicePool Unit Tests
 *
 * Tests for connection pooling, reuse, idle cleanup,
 * release, disconnectAll, and error handling.
 *
 * DeviceClient is mocked since we cannot connect to real devices in tests.
 *
 * Requirements: 5.4, 5.5, 5.7
 */

import type { DataStore } from '../dataStore';
import { createMockPgDataStore } from '../../test/helpers/mockPgDataStore';
import { DeviceManager, Device } from './deviceManager';
import { DevicePool, DevicePoolError, PooledConnection, DeviceClient } from './devicePool';

// ─── Mock DeviceClient factory ───────────────────────────────────────────────

function createMockDeviceClient(): DeviceClient {
  let connected = false;
  return {
    connect: jest.fn().mockImplementation(async () => {
      connected = true;
      return true;
    }),
    disconnect: jest.fn().mockImplementation(async () => {
      connected = false;
    }),
    isConnected: jest.fn().mockImplementation(() => connected),
    print: jest.fn().mockResolvedValue([]),
    getConfig: jest.fn().mockReturnValue(null),
  };
}

// Mock deviceDriverManager to return mock clients
const mockDeviceDriverManager = {
  getDriver: jest.fn().mockImplementation(() => createMockDeviceClient()),
};
jest.mock('./deviceDriverManager', () => ({
  deviceDriverManager: mockDeviceDriverManager,
}));

// ─── Test Setup ──────────────────────────────────────────────────────────────

let dataStore: DataStore;
let deviceManager: DeviceManager;
let devicePool: DevicePool;
const TEST_TENANT_ID = 'tenant-pool-001';
const TEST_TENANT_ID_2 = 'tenant-pool-002';
const ENCRYPTION_KEY = 'test-pool-encryption-key-2024';

let testDevice: Device;

beforeEach(async () => {
  jest.clearAllMocks();

  dataStore = createMockPgDataStore();

  // Create test users
  await dataStore.execute(
    "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
    [TEST_TENANT_ID, 'pooluser1', 'pool1@example.com', 'hash1'],
  );
  await dataStore.execute(
    "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
    [TEST_TENANT_ID_2, 'pooluser2', 'pool2@example.com', 'hash2'],
  );

  deviceManager = new DeviceManager(dataStore, { encryptionKey: ENCRYPTION_KEY });

  // Create a test device
  testDevice = await deviceManager.createDevice(TEST_TENANT_ID, {
    name: 'Pool Test Router',
    host: '192.168.1.1',
    port: 8728,
    username: 'admin',
    password: 'secret123',
    use_tls: false,
  });

  // Use short timeouts for testing
  devicePool = new DevicePool(deviceManager, {
    idleTimeout: 1000,       // 1 second
    cleanupInterval: 60000,  // 1 minute (we'll trigger cleanup manually)
  });

  // Manually set status to 'error' (not offline) so getConnection will proceed
  await dataStore.execute(
    "UPDATE devices SET status = $1 WHERE id = $2",
    ['error', testDevice.id],
  );
});

afterEach(async () => {
  await devicePool.destroy();
  await dataStore.close();
});

// ─── getConnection Tests ─────────────────────────────────────────────────────

describe('DevicePool.getConnection', () => {
  it('should create a new connection for a device', async () => {
    const client = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    expect(client).toBeDefined();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith({
      host: '192.168.1.1',
      port: 8728,
      username: 'admin',
      password: 'secret123',
      useTLS: false,
    });
  });

  it('should reuse existing connection for same deviceId', async () => {
    const client1 = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    const client2 = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Should return the same instance
    expect(client1).toBe(client2);
    // connect should only be called once
    expect(client1.connect).toHaveBeenCalledTimes(1);
  });

  it('should update device status to online on successful connection', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    const device = await deviceManager.getDevice(TEST_TENANT_ID, testDevice.id);
    expect(device!.status).toBe('online');
  });

  it('should throw NOT_FOUND for non-existent device', async () => {
    await expect(
      devicePool.getConnection(TEST_TENANT_ID, 'non-existent-id'),
    ).rejects.toThrow(DevicePoolError);

    await expect(
      devicePool.getConnection(TEST_TENANT_ID, 'non-existent-id'),
    ).rejects.toThrow(/不存在/);
  });

  it('should throw FORBIDDEN when tenant does not own the connection', async () => {
    // First, create connection as tenant 1
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Then try to access as tenant 2
    await expect(
      devicePool.getConnection(TEST_TENANT_ID_2, testDevice.id),
    ).rejects.toThrow(DevicePoolError);

    await expect(
      devicePool.getConnection(TEST_TENANT_ID_2, testDevice.id),
    ).rejects.toThrow(/无权/);
  });

  it('should reconnect when existing connection is disconnected', async () => {
    const client1 = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Simulate disconnection
    (client1.isConnected as jest.Mock).mockReturnValue(false);

    const client2 = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id, { force: true });

    // Should be a new client instance (since mock creates new instances)
    expect(client2).toBeDefined();
    expect(mockDeviceDriverManager.getDriver).toHaveBeenCalledTimes(2);
  });

  it('should update device status to error on connection failure', async () => {
    // Make the next getDriver return a client whose connect fails
    mockDeviceDriverManager.getDriver.mockImplementationOnce(() => {
      return {
        connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
        disconnect: jest.fn(),
        isConnected: jest.fn().mockReturnValue(false),
        print: jest.fn().mockResolvedValue([]),
        getConfig: jest.fn().mockReturnValue(null),
      };
    });

    await expect(
      devicePool.getConnection(TEST_TENANT_ID, testDevice.id),
    ).rejects.toThrow(DevicePoolError);

    const device = await deviceManager.getDevice(TEST_TENANT_ID, testDevice.id);
    expect(device!.status).toBe('error');
    expect(device!.error_message).toContain('Connection refused');
  });

  it('should handle multiple devices independently', async () => {
    // Create a second device
    const device2 = await deviceManager.createDevice(TEST_TENANT_ID, {
      name: 'Second Router',
      host: '192.168.1.2',
      port: 8728,
      username: 'admin',
      password: 'pass456',
    });

    const client1 = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    const client2 = await devicePool.getConnection(TEST_TENANT_ID, device2.id, { force: true });

    expect(client1).not.toBe(client2);
    expect(mockDeviceDriverManager.getDriver).toHaveBeenCalledTimes(2);
  });
});

// ─── releaseConnection Tests ─────────────────────────────────────────────────

describe('DevicePool.releaseConnection', () => {
  it('should release an existing connection', async () => {
    const client = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    await devicePool.releaseConnection(testDevice.id);

    expect(client.disconnect).toHaveBeenCalledTimes(1);

    const stats = devicePool.getPoolStats();
    expect(stats.total).toBe(0);
  });

  it('should update device status to offline after release', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    await devicePool.releaseConnection(testDevice.id);

    const device = await deviceManager.getDevice(TEST_TENANT_ID, testDevice.id);
    expect(device!.status).toBe('offline');
  });

  it('should not throw when releasing non-existent connection', async () => {
    await expect(
      devicePool.releaseConnection('non-existent-id'),
    ).resolves.not.toThrow();
  });

  it('should allow reconnection after release', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    await devicePool.releaseConnection(testDevice.id);

    const client = await devicePool.getConnection(TEST_TENANT_ID, testDevice.id, { force: true });
    expect(client).toBeDefined();
    expect(mockDeviceDriverManager.getDriver).toHaveBeenCalledTimes(2);
  });
});

// ─── disconnectAll Tests ─────────────────────────────────────────────────────

describe('DevicePool.disconnectAll', () => {
  it('should disconnect all connections', async () => {
    const device2 = await deviceManager.createDevice(TEST_TENANT_ID, {
      name: 'Second Router',
      host: '192.168.1.2',
      port: 8728,
      username: 'admin',
      password: 'pass456',
    });

    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    await devicePool.getConnection(TEST_TENANT_ID, device2.id, { force: true });

    expect(devicePool.getPoolStats().total).toBe(2);

    await devicePool.disconnectAll();

    expect(devicePool.getPoolStats().total).toBe(0);
  });

  it('should disconnect only connections for specified tenant', async () => {
    // Create device for tenant 2
    const device2 = await deviceManager.createDevice(TEST_TENANT_ID_2, {
      name: 'Tenant2 Router',
      host: '10.0.0.1',
      port: 8728,
      username: 'admin',
      password: 'pass789',
    });

    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    await devicePool.getConnection(TEST_TENANT_ID_2, device2.id, { force: true });

    expect(devicePool.getPoolStats().total).toBe(2);

    await devicePool.disconnectAll(TEST_TENANT_ID);

    expect(devicePool.getPoolStats().total).toBe(1);

    // Tenant 2's connection should still exist
    const connections = devicePool.getConnectionsMap();
    expect(connections.has(device2.id)).toBe(true);
    expect(connections.has(testDevice.id)).toBe(false);
  });

  it('should handle empty pool gracefully', async () => {
    await expect(devicePool.disconnectAll()).resolves.not.toThrow();
  });
});

// ─── getPoolStats Tests ──────────────────────────────────────────────────────

describe('DevicePool.getPoolStats', () => {
  it('should return zeros for empty pool', () => {
    const stats = devicePool.getPoolStats();
    expect(stats).toEqual({ total: 0, connected: 0, idle: 0 });
  });

  it('should count connected connections', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    const stats = devicePool.getPoolStats();
    expect(stats.total).toBe(1);
    expect(stats.connected).toBe(1);
    expect(stats.idle).toBe(0); // Just created, not idle yet
  });

  it('should count idle connections', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Manually set lastUsed to past to simulate idle
    const conn = devicePool.getConnectionsMap().get(testDevice.id)!;
    conn.lastUsed = Date.now() - 2000; // 2 seconds ago (idleTimeout is 1s, threshold is 80% = 800ms)

    const stats = devicePool.getPoolStats();
    expect(stats.total).toBe(1);
    expect(stats.connected).toBe(1);
    expect(stats.idle).toBe(1);
  });

  it('should reflect pool state after release', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    expect(devicePool.getPoolStats().total).toBe(1);

    await devicePool.releaseConnection(testDevice.id);
    expect(devicePool.getPoolStats().total).toBe(0);
  });
});

// ─── Idle Cleanup Tests ──────────────────────────────────────────────────────

describe('DevicePool idle cleanup', () => {
  it('should clean up idle connections when cleanup runs', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Simulate idle by setting lastUsed to past
    const conn = devicePool.getConnectionsMap().get(testDevice.id)!;
    conn.lastUsed = Date.now() - 2000; // Exceeds 1s idleTimeout

    // Manually trigger cleanup (private method, access via any)
    await (devicePool as any).cleanupIdleConnections();

    expect(devicePool.getPoolStats().total).toBe(0);
  });

  it('should not clean up recently used connections', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // lastUsed is current, should not be cleaned
    await (devicePool as any).cleanupIdleConnections();

    expect(devicePool.getPoolStats().total).toBe(1);
  });

  it('should only clean up idle connections, keeping active ones', async () => {
    const device2 = await deviceManager.createDevice(TEST_TENANT_ID, {
      name: 'Active Router',
      host: '192.168.1.3',
      port: 8728,
      username: 'admin',
      password: 'pass111',
    });

    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);
    await devicePool.getConnection(TEST_TENANT_ID, device2.id, { force: true });

    // Make only the first device idle
    const conn1 = devicePool.getConnectionsMap().get(testDevice.id)!;
    conn1.lastUsed = Date.now() - 2000;

    await (devicePool as any).cleanupIdleConnections();

    expect(devicePool.getPoolStats().total).toBe(1);
    expect(devicePool.getConnectionsMap().has(device2.id)).toBe(true);
    expect(devicePool.getConnectionsMap().has(testDevice.id)).toBe(false);
  });

  it('should update device status to offline when cleaning idle connection', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    const conn = devicePool.getConnectionsMap().get(testDevice.id)!;
    conn.lastUsed = Date.now() - 2000;

    await (devicePool as any).cleanupIdleConnections();

    const device = await deviceManager.getDevice(TEST_TENANT_ID, testDevice.id);
    expect(device!.status).toBe('offline');
  });
});

// ─── destroy Tests ───────────────────────────────────────────────────────────

describe('DevicePool.destroy', () => {
  it('should disconnect all and stop cleanup timer', async () => {
    await devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    await devicePool.destroy();

    expect(devicePool.getPoolStats().total).toBe(0);
  });
});

// ─── EventEmitter-based waitForConnection Tests ──────────────────────────────

describe('DevicePool EventEmitter-based waitForConnection', () => {
  it('should resolve immediately when connection succeeds via event notification', async () => {
    // Use a slow connect to simulate a concurrent waiter scenario
    let resolveConnect: () => void;
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });

    mockDeviceDriverManager.getDriver.mockImplementationOnce(() => {
      let connected = false;
      return {
        connect: jest.fn().mockImplementation(async () => {
          await connectPromise;
          connected = true;
          return true;
        }),
        disconnect: jest.fn(),
        isConnected: jest.fn().mockImplementation(() => connected),
        print: jest.fn().mockResolvedValue([]),
        getConfig: jest.fn().mockReturnValue(null),
      };
    });

    // Start connection (will be pending)
    const connectionPromise = devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Wait for the connection entry to be created
    await new Promise((r) => setTimeout(r, 50));

    // Verify the connection is in 'connecting' state
    const conn = devicePool.getConnectionsMap().get(testDevice.id);
    expect(conn).toBeDefined();
    expect(conn!.status).toBe('connecting');

    // Now a second caller tries to get the same connection (will call waitForConnection internally)
    const secondCallerPromise = devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Resolve the original connection - this should emit the event and notify the waiter
    resolveConnect!();

    // Both should resolve successfully
    const client1 = await connectionPromise;
    const client2 = await secondCallerPromise;

    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
    // The second caller should get the same client (reused connection)
    expect(client1).toBe(client2);
  });

  it('should resolve waitForConnection on timeout when connection takes too long', async () => {
    // Create a connection that never completes
    mockDeviceDriverManager.getDriver.mockImplementationOnce(() => {
      return {
        connect: jest.fn().mockImplementation(() => new Promise(() => { })), // never resolves
        disconnect: jest.fn(),
        isConnected: jest.fn().mockReturnValue(false),
        print: jest.fn().mockResolvedValue([]),
        getConfig: jest.fn().mockReturnValue(null),
      };
    });

    // Manually set up a 'connecting' entry to test waitForConnection directly
    const client = createMockDeviceClient();
    const pooledConn: PooledConnection = {
      client,
      deviceId: testDevice.id,
      tenantId: TEST_TENANT_ID,
      lastUsed: Date.now(),
      status: 'connecting',
    };
    devicePool.getConnectionsMap().set(testDevice.id, pooledConn);

    // Call waitForConnection with a short timeout
    const startTime = Date.now();
    await (devicePool as any).waitForConnection(testDevice.id, 200);
    const elapsed = Date.now() - startTime;

    // Should have waited approximately 200ms (timeout)
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
  });

  it('should resolve immediately if connection is not in connecting state', async () => {
    // No connection entry exists - should resolve immediately
    const startTime = Date.now();
    await (devicePool as any).waitForConnection('non-existent-device', 5000);
    const elapsed = Date.now() - startTime;

    // Should resolve almost immediately (not wait for timeout)
    expect(elapsed).toBeLessThan(100);
  });

  it('should notify waiter immediately when connection fails', async () => {
    // Create a connection that will fail after a delay
    let rejectConnect: (err: Error) => void;
    const connectPromise = new Promise<void>((_, reject) => {
      rejectConnect = reject;
    });

    mockDeviceDriverManager.getDriver.mockImplementationOnce(() => {
      return {
        connect: jest.fn().mockImplementation(async () => {
          await connectPromise;
        }),
        disconnect: jest.fn(),
        isConnected: jest.fn().mockReturnValue(false),
        print: jest.fn().mockResolvedValue([]),
        getConfig: jest.fn().mockReturnValue(null),
      };
    });

    // Start connection (will be pending)
    const connectionPromise = devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Wait for the connection entry to be created
    await new Promise((r) => setTimeout(r, 50));

    // A second caller tries to get the same connection
    const secondCallerPromise = devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Fail the connection - this should emit the event and notify the waiter
    rejectConnect!(new Error('Connection refused'));

    // First caller should throw
    await expect(connectionPromise).rejects.toThrow(/连接失败/);

    // Second caller should also handle the failure (clean up and create new)
    // Since the mock is exhausted, it will use the default mock which succeeds
    const client2 = await secondCallerPromise;
    expect(client2).toBeDefined();
  });
});

// ─── Connection Status Tracking Tests ────────────────────────────────────────

describe('DevicePool connection status tracking', () => {
  it('should set status to connecting during connection attempt', async () => {
    // Use a slow connect to observe the connecting state
    let resolveConnect: () => void;
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });

    mockDeviceDriverManager.getDriver.mockImplementationOnce(() => {
      let connected = false;
      return {
        connect: jest.fn().mockImplementation(async () => {
          await connectPromise;
          connected = true;
          return true;
        }),
        disconnect: jest.fn(),
        isConnected: jest.fn().mockImplementation(() => connected),
        print: jest.fn().mockResolvedValue([]),
        getConfig: jest.fn().mockReturnValue(null),
      };
    });

    const connectionPromise = devicePool.getConnection(TEST_TENANT_ID, testDevice.id);

    // Check that device status was set to connecting
    // (We need a small delay for the async operation to start)
    await new Promise((r) => setTimeout(r, 50));
    const device = await deviceManager.getDevice(TEST_TENANT_ID, testDevice.id);
    expect(device!.status).toBe('connecting');

    // Resolve the connection
    resolveConnect!();
    await connectionPromise;

    // Now should be online
    const deviceAfter = await deviceManager.getDevice(TEST_TENANT_ID, testDevice.id);
    expect(deviceAfter!.status).toBe('online');
  });
});
