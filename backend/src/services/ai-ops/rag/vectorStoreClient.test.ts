/**
 * Tests for VectorStoreClient — HTTP client to Python Core.
 *
 * Validates degradation-aware behavior (PC.3):
 * - When Python Core is available: normal operation
 * - When Python Core fails: graceful degradation (empty results, not throws)
 * - When vectorOperations is already degraded: short-circuit without HTTP call
 * - healthCheck always makes the actual HTTP call (never short-circuits)
 */

import axios from 'axios';
import { VectorStoreClient } from './vectorStoreClient';
import { degradationManager } from '../degradationManager';

// Mock axios.create to return a mock instance
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock degradationManager singleton
jest.mock('../degradationManager', () => {
  const mockManager = {
    isAvailable: jest.fn().mockReturnValue(true),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  };
  return { degradationManager: mockManager };
});

const mockDegradation = degradationManager as jest.Mocked<typeof degradationManager>;

describe('VectorStoreClient', () => {
  let client: VectorStoreClient;
  let mockAxiosInstance: {
    post: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
    };
    mockedAxios.create.mockReturnValue(mockAxiosInstance as any);
    mockedAxios.isAxiosError.mockImplementation(
      (err: any) => err?.isAxiosError === true,
    );
    // Default: vectorOperations is available
    (mockDegradation.isAvailable as jest.Mock).mockReturnValue(true);
    client = new VectorStoreClient('http://python-core:8001', 'test-key');
  });

  // ── Constructor ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates axios instance with correct config', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://python-core:8001',
          headers: expect.objectContaining({
            'X-Internal-API-Key': 'test-key',
          }),
        }),
      );
    });
  });

  // ── Upsert ──────────────────────────────────────────────────────

  describe('upsert', () => {
    it('sends documents to Python Core and returns IDs', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 'id-1' } });
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 'id-2' } });

      const ids = await client.upsert('prompt_knowledge', [
        { content: 'hello', metadata: { category: 'test' } },
        { content: 'world', embedding: [0.1, 0.2] },
      ]);

      expect(ids).toEqual(['id-1', 'id-2']);
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/api/v1/vectors/upsert',
        expect.objectContaining({
          collection: 'prompt_knowledge',
          content: 'hello',
          metadata: { category: 'test' },
        }),
      );
      expect(mockDegradation.recordSuccess).toHaveBeenCalledWith('vectorOperations');
    });

    it('returns empty array and records failure on error (graceful degradation)', async () => {
      const axiosErr = {
        isAxiosError: true,
        response: { status: 500, data: { detail: 'DB down' } },
        message: 'Request failed',
      };
      mockAxiosInstance.post.mockRejectedValueOnce(axiosErr);

      const ids = await client.upsert('prompt_knowledge', [{ content: 'fail' }]);

      expect(ids).toEqual([]);
      expect(mockDegradation.recordFailure).toHaveBeenCalledWith(
        'vectorOperations',
        expect.stringContaining('Python Core API error (500)'),
      );
    });

    it('short-circuits when vectorOperations is degraded', async () => {
      (mockDegradation.isAvailable as jest.Mock).mockReturnValue(false);

      const ids = await client.upsert('prompt_knowledge', [{ content: 'test' }]);

      expect(ids).toEqual([]);
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });
  });

  // ── Search ──────────────────────────────────────────────────────

  describe('search', () => {
    it('returns search results from Python Core', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          results: [
            { id: 'r1', text: 'result 1', score: 0.95, metadata: {} },
            { id: 'r2', text: 'result 2', score: 0.80, metadata: { k: 'v' } },
          ],
        },
      });

      const results = await client.search('prompt_knowledge', {
        collection: 'prompt_knowledge',
        query: 'network troubleshooting',
        top_k: 3,
      });

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('r1');
      expect(results[0].score).toBe(0.95);
      expect(mockDegradation.recordSuccess).toHaveBeenCalledWith('vectorOperations');
    });

    it('returns empty array when no results', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { results: [] } });

      const results = await client.search('tool_vectors', {
        collection: 'tool_vectors',
        query_embedding: [0.1, 0.2, 0.3],
      });

      expect(results).toEqual([]);
    });

    it('returns empty array and records failure on error (graceful degradation)', async () => {
      const axiosErr = {
        isAxiosError: true,
        response: { status: 503, data: { detail: 'Service unavailable' } },
        message: 'Request failed',
      };
      mockAxiosInstance.post.mockRejectedValueOnce(axiosErr);

      const results = await client.search('prompt_knowledge', {
        collection: 'prompt_knowledge',
        query: 'test',
      });

      expect(results).toEqual([]);
      expect(mockDegradation.recordFailure).toHaveBeenCalledWith(
        'vectorOperations',
        expect.stringContaining('Python Core API error (503)'),
      );
    });

    it('short-circuits when vectorOperations is degraded', async () => {
      (mockDegradation.isAvailable as jest.Mock).mockReturnValue(false);

      const results = await client.search('prompt_knowledge', {
        collection: 'prompt_knowledge',
        query: 'test',
      });

      expect(results).toEqual([]);
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });
  });

  // ── Delete ──────────────────────────────────────────────────────

  describe('delete', () => {
    it('returns true on successful deletion', async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({ status: 204 });

      const result = await client.delete('prompt_knowledge', 'doc-123');

      expect(result).toBe(true);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        '/api/v1/vectors/prompt_knowledge/doc-123',
      );
      expect(mockDegradation.recordSuccess).toHaveBeenCalledWith('vectorOperations');
    });

    it('returns false when document not found', async () => {
      const notFoundErr = {
        isAxiosError: true,
        response: { status: 404, data: { detail: 'Not found' } },
        message: 'Not found',
      };
      mockAxiosInstance.delete.mockRejectedValueOnce(notFoundErr);

      const result = await client.delete('prompt_knowledge', 'nonexistent');

      expect(result).toBe(false);
    });

    it('returns false and records failure on other errors (graceful degradation)', async () => {
      const serverErr = {
        isAxiosError: true,
        response: { status: 500, data: { detail: 'Internal error' } },
        message: 'Server error',
      };
      mockAxiosInstance.delete.mockRejectedValueOnce(serverErr);

      const result = await client.delete('prompt_knowledge', 'doc-123');

      expect(result).toBe(false);
      expect(mockDegradation.recordFailure).toHaveBeenCalledWith(
        'vectorOperations',
        expect.stringContaining('Python Core API error (500)'),
      );
    });

    it('short-circuits when vectorOperations is degraded', async () => {
      (mockDegradation.isAvailable as jest.Mock).mockReturnValue(false);

      const result = await client.delete('prompt_knowledge', 'doc-123');

      expect(result).toBe(false);
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });
  });

  // ── Embed ───────────────────────────────────────────────────────

  describe('embed', () => {
    it('returns embeddings from Python Core', async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          model: 'all-MiniLM-L6-v2',
          dimensions: 384,
          embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
        },
      });

      const embeddings = await client.embed(['hello', 'world']);

      expect(embeddings).toHaveLength(2);
      expect(embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(mockDegradation.recordSuccess).toHaveBeenCalledWith('vectorOperations');
    });

    it('returns empty array and records failure on error (graceful degradation)', async () => {
      mockAxiosInstance.post.mockRejectedValueOnce(new Error('Network error'));

      const embeddings = await client.embed(['test']);

      expect(embeddings).toEqual([]);
      expect(mockDegradation.recordFailure).toHaveBeenCalledWith(
        'vectorOperations',
        'Network error',
      );
    });

    it('short-circuits when vectorOperations is degraded', async () => {
      (mockDegradation.isAvailable as jest.Mock).mockReturnValue(false);

      const embeddings = await client.embed(['test']);

      expect(embeddings).toEqual([]);
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });
  });

  // ── Health ──────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns true when service is healthy', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { status: 'healthy', database: true },
      });

      expect(await client.healthCheck()).toBe(true);
    });

    it('returns false when service is degraded', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { status: 'degraded', database: false },
      });

      expect(await client.healthCheck()).toBe(false);
    });

    it('returns false when service is unreachable', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      expect(await client.healthCheck()).toBe(false);
    });

    it('always makes HTTP call even when vectorOperations is degraded', async () => {
      (mockDegradation.isAvailable as jest.Mock).mockReturnValue(false);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { status: 'healthy', database: true },
      });

      const result = await client.healthCheck();

      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/health');
    });
  });
});
