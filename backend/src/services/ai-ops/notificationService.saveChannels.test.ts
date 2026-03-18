/**
 * NotificationService.saveChannels() Unit Tests
 * 测试 saveChannels() 的 upsert 策略（Requirements: 5.1, 5.2）
 *
 * Verifies:
 * - Uses INSERT OR REPLACE instead of DELETE all + re-INSERT
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

/** Helper: create a mock DataStore that tracks SQL operations */
function createMockDataStore(existingChannelIds: string[] = []) {
  const runCalls: { sql: string; params?: unknown[] }[] = [];
  const transactionFn = jest.fn((fn: () => void) => fn());

  return {
    query: jest.fn().mockReturnValue(existingChannelIds.map(id => ({ id }))),
    run: jest.fn((sql: string, params?: unknown[]) => {
      runCalls.push({ sql, params });
    }),
    transaction: transactionFn,
    initialize: jest.fn(),
    close: jest.fn(),
    _runCalls: runCalls,
    _transactionFn: transactionFn,
  } as any;
}

/** Helper: create a minimal notification channel */
function makeChannel(id: string, name: string = `Channel ${id}`) {
  return {
    id,
    name,
    type: 'webhook' as const,
    config: { url: `https://example.com/${id}` },
    enabled: true,
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

describe('NotificationService.saveChannels() - upsert strategy', () => {
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
    jest.clearAllMocks();
  });

  it('should use INSERT OR REPLACE instead of DELETE all', async () => {
    const mockDataStore = createMockDataStore([]);
    service.setDataStore(mockDataStore);

    // Add a channel via createChannel
    const channel = await service.createChannel({
      name: 'Test Webhook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      enabled: true,
    });

    // Verify no "DELETE FROM notification_channels" without WHERE clause was issued
    const deleteAllCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels') && !c.sql.includes('WHERE')
    );
    expect(deleteAllCalls).toHaveLength(0);

    // Verify INSERT OR REPLACE was used
    const upsertCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('INSERT OR REPLACE')
    );
    expect(upsertCalls.length).toBeGreaterThan(0);
  });

  it('should delete only channels that no longer exist in memory', async () => {
    // Set up: DB has channels A, B, C loaded initially
    const fullRows = [
      { id: 'chan-a', tenant_id: 'default', name: 'A', type: 'webhook', config: '{"url":"https://a.com"}', enabled: 1, created_at: '2024-01-01T00:00:00.000Z' },
      { id: 'chan-b', tenant_id: 'default', name: 'B', type: 'webhook', config: '{"url":"https://b.com"}', enabled: 1, created_at: '2024-01-01T00:00:00.000Z' },
      { id: 'chan-c', tenant_id: 'default', name: 'C', type: 'webhook', config: '{"url":"https://c.com"}', enabled: 1, created_at: '2024-01-01T00:00:00.000Z' },
    ];
    const mockDataStore = createMockDataStore([]);
    // loadChannels() uses SELECT * - return full rows
    // saveChannels() uses SELECT id - return id-only rows
    mockDataStore.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM')) {
        return [{ id: 'chan-a' }, { id: 'chan-b' }, { id: 'chan-c' }];
      }
      return fullRows; // SELECT * for loadChannels
    });
    service.setDataStore(mockDataStore);

    // Initialize loads A, B, C into memory
    await service.initialize();
    mockDataStore._runCalls.length = 0; // Clear calls from init

    // Delete channel C via public API
    await service.deleteChannel('chan-c');

    // saveChannels should delete chan-c (no longer in memory) but keep chan-a and chan-b
    const deleteCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels WHERE id = ?')
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].params![0]).toBe('chan-c');

    // chan-a and chan-b should be upserted
    const upsertCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('INSERT OR REPLACE')
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
    // Start with empty DB
    const mockDataStore = createMockDataStore([]);
    service.setDataStore(mockDataStore);

    // Create two channels
    const ch1 = await service.createChannel({
      name: 'Channel 1',
      type: 'webhook',
      config: { url: 'https://1.com' },
      enabled: true,
    });

    // Now update the mock to return the first channel's ID as existing
    mockDataStore.query.mockReturnValue([{ id: ch1.id }]);
    mockDataStore._runCalls.length = 0; // Clear previous calls

    const ch2 = await service.createChannel({
      name: 'Channel 2',
      type: 'webhook',
      config: { url: 'https://2.com' },
      enabled: true,
    });

    // ch1 exists in both DB and memory, so it should NOT be deleted
    const deleteCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels WHERE id = ?')
    );
    expect(deleteCalls).toHaveLength(0);

    // Both channels should be upserted
    const upsertCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('INSERT OR REPLACE')
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
    mockDataStore.query.mockReturnValue([{ id: ch1.id }, { id: ch2.id }]);
    mockDataStore._runCalls.length = 0;

    // Delete ch2
    await service.deleteChannel(ch2.id);

    // Only ch2 should be deleted from DB
    const deleteCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('DELETE FROM notification_channels WHERE id = ?')
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].params![0]).toBe(ch2.id);

    // ch1 should still be upserted
    const upsertCalls = mockDataStore._runCalls.filter(
      (c: any) => c.sql.includes('INSERT OR REPLACE')
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
    mockDataStore.transaction.mockImplementation(() => {
      throw new Error('Transaction failed');
    });
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
      'Failed to save channels to DataStore, falling back to JSON:',
      expect.any(Error)
    );
    expect(fsMock.writeFile).toHaveBeenCalled();
  });
});
