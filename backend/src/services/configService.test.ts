/**
 * ConfigService Unit Tests
 * 测试 ConfigService 的密码解密功能（Requirements: 3.1, 3.2）
 */

import { ConfigService } from './configService';
import { logger } from '../utils/logger';

// Mock logger to suppress output and verify log calls
jest.mock('../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock fs/promises to prevent file system access
jest.mock('fs/promises');

/** Helper: create a minimal mock DataStore */
function createMockDataStore(rows: any[] = []) {
  return {
    query: jest.fn().mockReturnValue(rows),
    run: jest.fn(),
    transaction: jest.fn(),
    initialize: jest.fn(),
    close: jest.fn(),
  } as any;
}

/** Sample device row from the devices table */
const SAMPLE_DEVICE_ROW = {
  id: 'device-1',
  host: '192.168.1.1',
  port: 8729,
  username: 'admin',
  password_encrypted: 'AES_ENCRYPTED_DATA_HERE',
  use_tls: 1,
};

describe('ConfigService - setDecryptFunction and password decryption', () => {
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService();
    jest.clearAllMocks();
  });

  describe('setDecryptFunction()', () => {
    it('should accept and store a decrypt function', () => {
      const decryptFn = jest.fn((cipher: string) => 'decrypted');
      configService.setDecryptFunction(decryptFn);
      expect(logger.info).toHaveBeenCalledWith(
        'ConfigService: Decrypt function configured for password decryption'
      );
    });
  });

  describe('loadConfig() with DataStore and decryptFn', () => {
    it('should decrypt password_encrypted and return plaintext password in config', async () => {
      const mockDataStore = createMockDataStore([SAMPLE_DEVICE_ROW]);
      const decryptFn = jest.fn((cipher: string) => 'my-secret-password');

      configService.setDataStore(mockDataStore);
      configService.setDecryptFunction(decryptFn);

      const config = await configService.loadConfig();

      expect(config).not.toBeNull();
      expect(config!.host).toBe('192.168.1.1');
      expect(config!.port).toBe(8729);
      expect(config!.username).toBe('admin');
      expect(config!.password).toBe('my-secret-password');
      expect(config!.useTLS).toBe(true);
      expect(decryptFn).toHaveBeenCalledWith('AES_ENCRYPTED_DATA_HERE');
    });

    it('should return null and log error when decryption throws', async () => {
      const mockDataStore = createMockDataStore([SAMPLE_DEVICE_ROW]);
      const decryptFn = jest.fn(() => {
        throw new Error('Decryption failed: invalid key');
      });

      configService.setDataStore(mockDataStore);
      configService.setDecryptFunction(decryptFn);

      const config = await configService.loadConfig();

      expect(config).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'ConfigService: Failed to decrypt device password:',
        expect.any(Error)
      );
    });

    it('should return null and log warning when no decrypt function is set', async () => {
      const mockDataStore = createMockDataStore([SAMPLE_DEVICE_ROW]);
      configService.setDataStore(mockDataStore);
      // Do NOT call setDecryptFunction

      const config = await configService.loadConfig();

      expect(config).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'ConfigService: No decrypt function set, cannot load config from DataStore'
      );
    });

    it('should return null when no devices exist in DataStore', async () => {
      const mockDataStore = createMockDataStore([]); // empty result
      const decryptFn = jest.fn((cipher: string) => 'decrypted');

      configService.setDataStore(mockDataStore);
      configService.setDecryptFunction(decryptFn);

      const config = await configService.loadConfig();

      expect(config).toBeNull();
      expect(decryptFn).not.toHaveBeenCalled();
    });

    it('should handle use_tls = 0 correctly', async () => {
      const row = { ...SAMPLE_DEVICE_ROW, use_tls: 0 };
      const mockDataStore = createMockDataStore([row]);
      const decryptFn = jest.fn(() => 'password');

      configService.setDataStore(mockDataStore);
      configService.setDecryptFunction(decryptFn);

      const config = await configService.loadConfig();

      expect(config).not.toBeNull();
      expect(config!.useTLS).toBe(false);
    });

    it('should return null and log error when DataStore query throws', async () => {
      const mockDataStore = createMockDataStore();
      mockDataStore.query.mockImplementation(() => {
        throw new Error('Database error');
      });
      const decryptFn = jest.fn(() => 'password');

      configService.setDataStore(mockDataStore);
      configService.setDecryptFunction(decryptFn);

      const config = await configService.loadConfig();

      expect(config).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        'ConfigService: Failed to load config from DataStore:',
        expect.any(Error)
      );
    });
  });
});
