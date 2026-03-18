/**
 * NotificationService.saveChannels() Unit Tests
 * 测试 saveChannels() 的 upsert 策略（Requirements: 5.1, 5.2）
 *
 * Verifies:
 * - Uses INSERT ... ON CONFLICT (PG upsert) instead of DELETE all + re-INSERT
 * - Only deletes channels that no longer exist in memory
 * - Preserves existing channels that are still present
 * - Wraps operations in a transaction
 */

import { NotificationService } from './notificationService';
import { logger } from '../../utils/logger';

// Mock logger
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock fs/promises
jest.mock('fs/promises');

// Mock nodemailer
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: jest.fn(),
  }),
}));

/** Helper: create a mock PG DataStore that tracks SQL operations */
function createMockDataStore(existingChannelIds: string[] = []) {
  const executeCalls: { sql: string; params?: unknown[] }[] = [];
  const transactionFn = jest.fn(async (fn: (tx: any) => Promise<void>) => {
    const tx = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT id FROM')) {
          return existingChannelIds.map(id => ({ id }));
        }
        return [];
      },
      queryOne: async () => null,
      execute: async (sql: string, params?: unknown[]) => {
        executeCalls.push({ sql, params });
        return { rowCount: 1 };
      },
    };
    await fn(tx);
  });

  return {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM')) {
        return existingChannelIds.map(id => ({ id }));
      }
      // SELECT * for loadChannels — return full rows
      return existingChannelIds.map(id => ({
        id,
        tenant_id: 'default',
        name: `Channel ${id}`,
        type: 'webhook',
        config: JSON.stringify({ url: `https://example.com/${id}` }),
        severity_filter: JSON.stringify(['critical', 'high', 'medium', 'low']),
        enabled: true,
        created_at: '2024-01-01T00:00:00.000Z',
      }));
    }),
    queryOne: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
    transaction: transactionFn,
    getPool: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
    _executeCalls: executeCalls,
    _transactionFn: transactionFn,
  } as any;
}

describe('NotificationService.saveChannels() - upsert strategy', () => {
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
    jest.clearAllMocks();
  });

  it('should use ON CONFLICT (PG upsert) instead of DELETE all', async () => {
    const mockDataStore = createMockDataStore([]);
    service.setDataStore(mockDataStore);

    // Add a channel via createChannel
    const channel = await service.createChannel({
      name: 'Test Webhook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      enabled: true,
    });

    // transaction should have been called
    expect(mockDataStore._transactionFn).toHaveBeenCalled();

    // Verify no "DELETE FROM notification_channels" without WHERE clause was issued
    const deleteAllCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels') && !c.sql.includes('WHERE')
    );
    expect(deleteAllCalls).toHaveLength(0);

    // Verify ON CONFLICT (PG upsert) was used
    const upsertCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('ON CONFLICT')
    );
    expect(upsertCalls.length).toBeGreaterThan(0);
  });

  it('should delete only channels that no longer exist in memory', async () => {
    const mockDataStore = createMockDataStore(['chan-a', 'chan-b', 'chan-c']);
    service.setDataStore(mockDataStore);

    // Initialize loads A, B, C into memory
    await service.initialize();
    mockDataStore._executeCalls.length = 0; // Clear calls from init

    // Delete channel C via public API
    await service.deleteChannel('chan-c');

    // saveChannels should delete chan-c (no longer in memory) but keep chan-a and chan-b
    const deleteCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels WHERE id')
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].params![0]).toBe('chan-c');

    // chan-a and chan-b should be upserted
    const upsertCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('ON CONFLICT')
    );
    expect(upsertCalls).toHaveLength(2);
    const upsertedIds = upsertCalls.map((c: any) => c.params![0]);
    expect(upsertedIds).toContain('chan-a');
    expect(upsertedIds).toContain('chan-b');
  });

  it('should wrap all operations in a transaction', async () => {
    const mockDataStore = createMockDataStore([]);
    service.setDataStore(mockDataStore);

    await service.createChannel({
      name: 'Test',
      type: 'webhook',
      config: { url: 'https://example.com' },
      enabled: true,
    });

    // transaction() should have been called
    expect(mockDataStore._transactionFn).toHaveBeenCalled();
  });

  it('should not delete channels that still exist in memory', async () => {
    const mockDataStore = createMockDataStore([]);
    service.setDataStore(mockDataStore);

    // Create first channel
    const ch1 = await service.createChannel({
      name: 'Channel 1',
      type: 'webhook',
      config: { url: 'https://1.com' },
      enabled: true,
    });

    // Update mock to return the first channel's ID as existing in DB
    mockDataStore._transactionFn.mockImplementation(async (fn: any) => {
      const tx = {
        query: async (sql: string) => {
          if (sql.includes('SELECT id FROM')) return [{ id: ch1.id }];
          return [];
        },
        queryOne: async () => null,
        execute: async (sql: string, params?: unknown[]) => {
          mockDataStore._executeCalls.push({ sql, params });
          return { rowCount: 1 };
        },
      };
      await fn(tx);
    });
    mockDataStore._executeCalls.length = 0;

    const ch2 = await service.createChannel({
      name: 'Channel 2',
      type: 'webhook',
      config: { url: 'https://2.com' },
      enabled: true,
    });

    // ch1 exists in both DB and memory, so it should NOT be deleted
    const deleteCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels WHERE id')
    );
    expect(deleteCalls).toHaveLength(0);

    // Both channels should be upserted
    const upsertCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('ON CONFLICT')
    );
    expect(upsertCalls).toHaveLength(2);
  });

  it('should handle deleteChannel by removing only the target channel', async () => {
    const mockDataStore = createMockDataStore([]);
    service.setDataStore(mockDataStore);

    // Create two channels
    const ch1 = await service.createChannel({
      name: 'Keep Me',
      type: 'webhook',
      config: { url: 'https://keep.com' },
      enabled: true,
    });
    const ch2 = await service.createChannel({
      name: 'Delete Me',
      type: 'webhook',
      config: { url: 'https://delete.com' },
      enabled: true,
    });

    // Update mock to return both channel IDs as existing
    mockDataStore._transactionFn.mockImplementation(async (fn: any) => {
      const tx = {
        query: async (sql: string) => {
          if (sql.includes('SELECT id FROM')) return [{ id: ch1.id }, { id: ch2.id }];
          return [];
        },
        queryOne: async () => null,
        execute: async (sql: string, params?: unknown[]) => {
          mockDataStore._executeCalls.push({ sql, params });
          return { rowCount: 1 };
        },
      };
      await fn(tx);
    });
    mockDataStore._executeCalls.length = 0;

    // Delete ch2
    await service.deleteChannel(ch2.id);

    // Only ch2 should be deleted from DB
    const deleteCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels WHERE id')
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].params![0]).toBe(ch2.id);

    // ch1 should still be upserted
    const upsertCalls = mockDataStore._executeCalls.filter(
      (c: any) => c.sql.includes('ON CONFLICT')
    );
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].params![0]).toBe(ch1.id);
  });

  it('should fall back to JSON file when DataStore is not available', async () => {
    // No DataStore set - should use JSON fallback
    const fsMock = require('fs/promises');
    fsMock.mkdir = jest.fn().mockResolvedValue(undefined);
    fsMock.writeFile = jest.fn().mockResolvedValue(undefined);
    fsMock.readFile = jest.fn().mockResolvedValue('[]');
    fsMock.access = jest.fn().mockResolvedValue(undefined);

    const channel = await service.createChannel({
      name: 'JSON Channel',
      type: 'webhook',
      config: { url: 'https://json.com' },
      enabled: true,
    });

    // Should have written to JSON file
    expect(fsMock.writeFile).toHaveBeenCalled();
  });

  it('should log error and fall back to JSON when DataStore transaction fails', async () => {
    const mockDataStore = createMockDataStore([]);
    mockDataStore.transaction.mockRejectedValue(new Error('Transaction failed'));
    service.setDataStore(mockDataStore);

    const fsMock = require('fs/promises');
    fsMock.mkdir = jest.fn().mockResolvedValue(undefined);
    fsMock.writeFile = jest.fn().mockResolvedValue(undefined);
    fsMock.readFile = jest.fn().mockResolvedValue('[]');
    fsMock.access = jest.fn().mockResolvedValue(undefined);

    await service.createChannel({
      name: 'Fallback Channel',
      type: 'webhook',
      config: { url: 'https://fallback.com' },
      enabled: true,
    });

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to save channels to PostgreSQL, falling back:',
      expect.any(Error)
    );
    expect(fsMock.writeFile).toHaveBeenCalled();
  });
});
