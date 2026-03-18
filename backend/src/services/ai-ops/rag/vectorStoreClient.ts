/**
 * VectorStoreClient — HTTP client that forwards all vector operations
 * to the Python Core service.
 *
 * Replaces direct pgvector SQL from Node.js (satisfies PC.2).
 * All embedding and vector search goes through Python Core REST API.
 *
 * Degradation-aware (PC.3): When Python Core is unavailable, returns
 * graceful fallback values instead of throwing, and records failures
 * via DegradationManager for automatic detection and recovery.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../../../utils/logger';
import { degradationManager } from '../degradationManager';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorDocument {
  id?: string;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorSearchQuery {
  collection: string;
  query?: string;
  query_embedding?: number[];
  top_k?: number;
  filter?: Record<string, unknown>;
  min_score?: number;
}

export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface EmbeddingResponse {
  model: string;
  dimensions: number;
  embeddings: number[][];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class VectorStoreClient {
  private client: AxiosInstance;

  constructor(
    private baseUrl: string = process.env.PYTHON_CORE_URL || 'http://localhost:8001',
    private apiKey: string = process.env.INTERNAL_API_KEY || '',
  ) {
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-API-Key': this.apiKey,
      },
    });
  }

  // ── Upsert ──────────────────────────────────────────────────────

  async upsert(collection: string, documents: VectorDocument[]): Promise<string[]> {
    // Short-circuit if vectorOperations is already degraded (avoid hammering a known-down service)
    if (!degradationManager.isAvailable('vectorOperations')) {
      logger.warn(`VectorStoreClient upsert skipped (vectorOperations degraded), collection=${collection}`);
      return [];
    }

    const ids: string[] = [];
    for (const doc of documents) {
      try {
        const resp = await this.client.post('/api/v1/vectors/upsert', {
          collection,
          id: doc.id,
          content: doc.content,
          embedding: doc.embedding,
          metadata: doc.metadata ?? {},
        });
        ids.push(resp.data.id);
      } catch (err) {
        logger.error(`VectorStoreClient upsert failed for collection=${collection}`, err);
        degradationManager.recordFailure('vectorOperations', this.extractErrorMessage(err));
        return ids; // Return whatever IDs we collected so far
      }
    }
    degradationManager.recordSuccess('vectorOperations');
    return ids;
  }

  // ── Search ──────────────────────────────────────────────────────

  async search(
    collection: string,
    query: VectorSearchQuery,
  ): Promise<VectorSearchResult[]> {
    // Short-circuit: return empty results when degraded (PC.3: 向量检索返回空结果)
    if (!degradationManager.isAvailable('vectorOperations')) {
      logger.warn(`VectorStoreClient search skipped (vectorOperations degraded), collection=${collection}`);
      return [];
    }

    try {
      const resp = await this.client.post('/api/v1/vectors/search', {
        collection,
        query: query.query,
        query_embedding: query.query_embedding,
        top_k: query.top_k ?? 5,
        filter: query.filter,
        min_score: query.min_score ?? 0,
      });
      degradationManager.recordSuccess('vectorOperations');
      return resp.data.results ?? [];
    } catch (err) {
      logger.error(`VectorStoreClient search failed for collection=${collection}`, err);
      degradationManager.recordFailure('vectorOperations', this.extractErrorMessage(err));
      return []; // Graceful degradation: return empty results
    }
  }

  // ── Delete ──────────────────────────────────────────────────────

  async delete(collection: string, id: string): Promise<boolean> {
    // Short-circuit if degraded
    if (!degradationManager.isAvailable('vectorOperations')) {
      logger.warn(`VectorStoreClient delete skipped (vectorOperations degraded), ${collection}/${id}`);
      return false;
    }

    try {
      await this.client.delete(`/api/v1/vectors/${collection}/${id}`);
      degradationManager.recordSuccess('vectorOperations');
      return true;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return false;
      }
      logger.error(`VectorStoreClient delete failed for ${collection}/${id}`, err);
      degradationManager.recordFailure('vectorOperations', this.extractErrorMessage(err));
      return false; // Graceful degradation
    }
  }

  // ── Embed ───────────────────────────────────────────────────────

  async embed(texts: string[]): Promise<number[][]> {
    // Short-circuit: return empty arrays when degraded (PC.3: Embedding 请求排队等待)
    if (!degradationManager.isAvailable('vectorOperations')) {
      logger.warn('VectorStoreClient embed skipped (vectorOperations degraded)');
      return [];
    }

    try {
      const resp = await this.client.post<EmbeddingResponse>(
        '/api/v1/embeddings',
        { texts },
      );
      degradationManager.recordSuccess('vectorOperations');
      return resp.data.embeddings;
    } catch (err) {
      logger.error('VectorStoreClient embed failed', err);
      degradationManager.recordFailure('vectorOperations', this.extractErrorMessage(err));
      return []; // Graceful degradation: return empty
    }
  }

  // ── Health ──────────────────────────────────────────────────────
  // healthCheck ALWAYS makes the actual HTTP call (never short-circuits),
  // because it's used to detect recovery of Python Core.

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await this.client.get('/health');
      return resp.data?.status === 'healthy';
    } catch {
      return false;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private extractErrorMessage(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const axErr = err as AxiosError;
      const status = axErr.response?.status ?? 0;
      const detail =
        (axErr.response?.data as Record<string, unknown>)?.detail ?? axErr.message;
      return `Python Core API error (${status}): ${detail}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
