/**
 * DeviceManager Unit Tests
 *
 * Tests for device CRUD operations, password encryption,
 * status management, and tag/group filtering.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.6
 */

import type { DataStore } from '../dataStore';
import { createMockPgDataStore } from '../../test/helpers/mockPgDataStore';
import { DeviceManager, DeviceManagerError, CreateDeviceInput, Device } from './deviceManager';

// ─── Test Setup ──────────────────────────────────────────────────────────────

let dataStore: DataStore;
let deviceManager: DeviceManager;
const TEST_TENANT_ID = 'tenant-test-001';
const TEST_TENANT_ID_2 = 'tenant-test-002';
const ENCRYPTION_KEY = 'test-encryption-key-2024';

beforeEach(async () => {
  dataStore = createMockPgDataStore();

  // Create test users (required by foreign key constraint)
  await dataStore.execute(
    "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
    [TEST_TENANT_ID, 'testuser1', 'test1@example.com', 'hash1'],
  );
  await dataStore.execute(
    "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
    [TEST_TENANT_ID_2, 'testuser2', 'test2@example.com', 'hash2'],
  );

  deviceManager = new DeviceManager(dataStore, { encryptionKey: ENCRYPTION_KEY });
});

afterEach(async () => {
  await dataStore.close();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function createTestInput(overrides: Partial<CreateDeviceInput> = {}): CreateDeviceInput {
  return {
    name: 'Test Router',
    host: '192.168.1.1',
    port: 8728,
    username: 'admin',
    password: 'secret123',
    use_tls: false,
    group_name: 'office',
    tags: ['router', 'main'],
    ...overrides,
  };
}

// ─── createDevice Tests ──────────────────────────────────────────────────────

describe('DeviceManager.createDevice', () => {
  it('should create a device with all fields', async () => {
    const input = createTestInput();
    const device = await deviceManager.createDevice(TEST_TENANT_ID, input);

    expect(device.id).toBeDefined();
    expect(device.tenant_id).toBe(TEST_TENANT_ID);
    expect(device.name).toBe('Test Router');
    expect(device.host).toBe('192.168.1.1');
    expect(device.port).toBe(8728);
    expect(device.username).toBe('admin');
    expect(device.use_tls).toBe(false);
    expect(device.group_name).toBe('office');
    expect(device.tags).toEqual(['router', 'main']);
    expect(device.status).toBe('offline');
    expect(device.created_at).toBeDefined();
    expect(device.updated_at).toBeDefined();
  });

  it('should encrypt the password', async () => {
    const input = createTestInput({ password: 'my-secret-password' });
    const device = await deviceManager.createDevice(TEST_TENANT_ID, input);

    // Password should be encrypted, not plain text
    expect(device.password_encrypted).not.toBe('my-secret-password');
    expect(device.password_encrypted.length).toBeGreaterThan(0);

    // Should be decryptable
    const decrypted = deviceManager.decryptPassword(device.password_encrypted);
    expect(decrypted).toBe('my-secret-password');
  });

  it('should use default port when not specified', async () => {
    const input = createTestInput({ port: undefined });
    const device = await deviceManager.createDevice(TEST_TENANT_ID, input);

    expect(device.port).toBe(8728);
  });

  it('should use empty tags when not specified', async () => {
    const input = createTestInput({ tags: undefined });
    const device = await deviceManager.createDevice(TEST_TENANT_ID, input);

    expect(device.tags).toEqual([]);
  });

  it('should set use_tls to true when specified', async () => {
    const input = createTestInput({ use_tls: true });
    const device = await deviceManager.createDevice(TEST_TENANT_ID, input);

    expect(device.use_tls).toBe(true);
  });

  it('should throw on empty name', async () => {
    const input = createTestInput({ name: '' });
    await expect(deviceManager.createDevice(TEST_TENANT_ID, input))
      .rejects.toThrow(DeviceManagerError);
  });

  it('should throw on empty host', async () => {
    const input = createTestInput({ host: '' });
    await expect(deviceManager.createDevice(TEST_TENANT_ID, input))
      .rejects.toThrow(DeviceManagerError);
  });

  it('should throw on empty username', async () => {
    const input = createTestInput({ username: '' });
    await expect(deviceManager.createDevice(TEST_TENANT_ID, input))
      .rejects.toThrow(DeviceManagerError);
  });

  it('should throw on empty password', async () => {
    const input = createTestInput({ password: '' });
    await expect(deviceManager.createDevice(TEST_TENANT_ID, input))
      .rejects.toThrow(DeviceManagerError);
  });

  it('should throw on invalid port', async () => {
    await expect(deviceManager.createDevice(TEST_TENANT_ID, createTestInput({ port: 0 })))
      .rejects.toThrow(DeviceManagerError);
    await expect(deviceManager.createDevice(TEST_TENANT_ID, createTestInput({ port: 70000 })))
      .rejects.toThrow(DeviceManagerError);
  });
});

// ─── getDevice Tests ─────────────────────────────────────────────────────────

describe('DeviceManager.getDevice', () => {
  it('should return a device by id and tenant', async () => {
    const created = await deviceManager.createDevice(TEST_TENANT_ID, createTestInput());
    const device = await deviceManager.getDevice(TEST_TENANT_ID, created.id);

    expect(device).not.toBeNull();
    expect(device!.id).toBe(created.id);
    expect(device!.name).toBe('Test Router');
  });

  it('should return null for non-existent device', async () => {
    const device = await deviceManager.getDevice(TEST_TENANT_ID, 'non-existent-id');
    expect(device).toBeNull();
  });

  it('should not return device belonging to another tenant', async () => {
    const created = await deviceManager.createDevice(TEST_TENANT_ID, createTestInput());
    const device = await deviceManager.getDevice(TEST_TENANT_ID_2, created.id);

    expect(device).toBeNull();
  });
});

// ─── getDevices Tests ────────────────────────────────────────────────────────

describe('DeviceManager.getDevices', () => {
  beforeEach(async () => {
    // Create multiple devices for filtering tests
    await deviceManager.createDevice(TEST_TENANT_ID, createTestInput({
      name: 'Router A', group_name: 'office', tags: ['router', 'main'],
    }));
    await deviceManager.createDevice(TEST_TENANT_ID, createTestInput({
      name: 'Router B', group_name: 'datacenter', tags: ['router', 'backup'],
    }));
    await deviceManager.createDevice(TEST_TENANT_ID, createTestInput({
      name: 'Switch C', group_name: 'office', tags: ['switch'],
    }));
    // Device for another tenant
    await deviceManager.createDevice(TEST_TENANT_ID_2, createTestInput({
      name: 'Other Router',
    }));
  });

  it('should return all devices for a tenant', async () => {
    const devices = await deviceManager.getDevices(TEST_TENANT_ID);
    expect(devices).toHaveLength(3);
  });

  it('should not return devices from other tenants', async () => {
    const devices = await deviceManager.getDevices(TEST_TENANT_ID_2);
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe('Other Router');
  });

  it('should filter by group_name', async () => {
    const devices = await deviceManager.getDevices(TEST_TENANT_ID, { group_name: 'office' });
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.group_name === 'office')).toBe(true);
  });

  it('should filter by status', async () => {
    const devices = await deviceManager.getDevices(TEST_TENANT_ID, { status: 'online' });
    expect(devices).toHaveLength(0); // All devices start as 'offline'
  });

  it('should return empty array for tenant with no devices', async () => {
    const newTenantId = 'tenant-empty';
    await dataStore.execute(
      "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)",
      [newTenantId, 'emptyuser', 'empty@example.com', 'hash'],
    );
    const devices = await deviceManager.getDevices(newTenantId);
    expect(devices).toEqual([]);
  });
});

// ─── updateDevice Tests ──────────────────────────────────────────────────────

describe('DeviceManager.updateDevice', () => {
  let createdDevice: Device;

  beforeEach(async () => {
    createdDevice = await deviceManager.createDevice(TEST_TENANT_ID, createTestInput());
  });

  it('should update device name', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {
      name: 'Updated Router',
    });
    expect(updated.name).toBe('Updated Router');
    expect(updated.host).toBe(createdDevice.host); // Other fields unchanged
  });

  it('should update device host and port', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {
      host: '10.0.0.1',
      port: 8729,
    });
    expect(updated.host).toBe('10.0.0.1');
    expect(updated.port).toBe(8729);
  });

  it('should update password with encryption', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {
      password: 'new-password',
    });
    expect(updated.password_encrypted).not.toBe('new-password');
    expect(deviceManager.decryptPassword(updated.password_encrypted)).toBe('new-password');
  });

  it('should update tags', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {
      tags: ['new-tag', 'updated'],
    });
    expect(updated.tags).toEqual(['new-tag', 'updated']);
  });

  it('should update use_tls', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {
      use_tls: true,
    });
    expect(updated.use_tls).toBe(true);
  });

  it('should update group_name', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {
      group_name: 'new-group',
    });
    expect(updated.group_name).toBe('new-group');
  });

  it('should return existing device when no updates provided', async () => {
    const updated = await deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, {});
    expect(updated.id).toBe(createdDevice.id);
  });

  it('should throw NOT_FOUND for non-existent device', async () => {
    await expect(
      deviceManager.updateDevice(TEST_TENANT_ID, 'non-existent', { name: 'X' }),
    ).rejects.toThrow(DeviceManagerError);
  });

  it('should throw NOT_FOUND when updating device of another tenant', async () => {
    await expect(
      deviceManager.updateDevice(TEST_TENANT_ID_2, createdDevice.id, { name: 'X' }),
    ).rejects.toThrow(DeviceManagerError);
  });

  it('should throw on empty name update', async () => {
    await expect(
      deviceManager.updateDevice(TEST_TENANT_ID, createdDevice.id, { name: '' }),
    ).rejects.toThrow(DeviceManagerError);
  });
});

// ─── deleteDevice Tests ──────────────────────────────────────────────────────

describe('DeviceManager.deleteDevice', () => {
  it('should delete an existing device', async () => {
    const created = await deviceManager.createDevice(TEST_TENANT_ID, createTestInput());
    await deviceManager.deleteDevice(TEST_TENANT_ID, created.id);

    const device = await deviceManager.getDevice(TEST_TENANT_ID, created.id);
    expect(device).toBeNull();
  });

  it('should throw NOT_FOUND for non-existent device', async () => {
    await expect(
      deviceManager.deleteDevice(TEST_TENANT_ID, 'non-existent'),
    ).rejects.toThrow(DeviceManagerError);
  });

  it('should throw NOT_FOUND when deleting device of another tenant', async () => {
    const created = await deviceManager.createDevice(TEST_TENANT_ID, createTestInput());
    await expect(
      deviceManager.deleteDevice(TEST_TENANT_ID_2, created.id),
    ).rejects.toThrow(DeviceManagerError);
  });
});

// ─── updateStatus Tests ──────────────────────────────────────────────────────

describe('DeviceManager.updateStatus', () => {
  let createdDevice: Device;

  beforeEach(async () => {
    createdDevice = await deviceManager.createDevice(TEST_TENANT_ID, createTestInput());
  });

  it('should update status to online', async () => {
    await deviceManager.updateStatus(createdDevice.id, 'online');
    const device = await deviceManager.getDevice(TEST_TENANT_ID, createdDevice.id);

    expect(device!.status).toBe('online');
    expect(device!.last_seen).toBeDefined();
    expect(device!.error_message).toBeUndefined();
  });

  it('should update status to error with message', async () => {
    await deviceManager.updateStatus(createdDevice.id, 'error', 'Connection refused');
    const device = await deviceManager.getDevice(TEST_TENANT_ID, createdDevice.id);

    expect(device!.status).toBe('error');
    expect(device!.error_message).toBe('Connection refused');
  });

  it('should clear error_message when status changes to non-error', async () => {
    // First set error
    await deviceManager.updateStatus(createdDevice.id, 'error', 'Some error');
    // Then set online
    await deviceManager.updateStatus(createdDevice.id, 'online');
    const device = await deviceManager.getDevice(TEST_TENANT_ID, createdDevice.id);

    expect(device!.status).toBe('online');
    expect(device!.error_message).toBeUndefined();
  });

  it('should update status to connecting', async () => {
    await deviceManager.updateStatus(createdDevice.id, 'connecting');
    const device = await deviceManager.getDevice(TEST_TENANT_ID, createdDevice.id);

    expect(device!.status).toBe('connecting');
  });

  it('should update status to offline', async () => {
    await deviceManager.updateStatus(createdDevice.id, 'offline');
    const device = await deviceManager.getDevice(TEST_TENANT_ID, createdDevice.id);

    expect(device!.status).toBe('offline');
  });

  it('should throw on invalid status', async () => {
    await expect(
      deviceManager.updateStatus(createdDevice.id, 'invalid' as any),
    ).rejects.toThrow(DeviceManagerError);
  });

  it('should throw NOT_FOUND for non-existent device', async () => {
    await expect(
      deviceManager.updateStatus('non-existent-id', 'online'),
    ).rejects.toThrow(DeviceManagerError);
  });
});

// ─── Password Encryption Tests ───────────────────────────────────────────────

describe('DeviceManager password encryption', () => {
  it('should encrypt and decrypt password correctly', () => {
    const password = 'my-secret-password';
    const encrypted = deviceManager.encryptPassword(password);

    expect(encrypted).not.toBe(password);
    expect(deviceManager.decryptPassword(encrypted)).toBe(password);
  });

  it('should produce different ciphertext for same password', () => {
    const password = 'same-password';
    const encrypted1 = deviceManager.encryptPassword(password);
    const encrypted2 = deviceManager.encryptPassword(password);

    // AES with random IV produces different ciphertext each time
    expect(encrypted1).not.toBe(encrypted2);

    // But both should decrypt to the same value
    expect(deviceManager.decryptPassword(encrypted1)).toBe(password);
    expect(deviceManager.decryptPassword(encrypted2)).toBe(password);
  });

  it('should throw on empty password encryption', () => {
    expect(() => deviceManager.encryptPassword('')).toThrow(DeviceManagerError);
  });

  it('should throw on empty ciphertext decryption', () => {
    expect(() => deviceManager.decryptPassword('')).toThrow(DeviceManagerError);
  });

  it('should fail to decrypt with wrong key', () => {
    const otherManager = new DeviceManager(dataStore, { encryptionKey: 'wrong-key' });
    const encrypted = deviceManager.encryptPassword('test-password');

    expect(() => otherManager.decryptPassword(encrypted)).toThrow(DeviceManagerError);
  });
});
