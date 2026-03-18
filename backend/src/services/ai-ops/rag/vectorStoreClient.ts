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

      // Map Python Core response field 'content' → VectorSearchResult 'text'
      // Python Core SearchResultItem returns { id, content, score, metadata }
      // but VectorSearchResult interface expects { id, text, score, metadata }
      const rawResults: Array<Record<string, unknown>> = resp.data.results ?? [];
      return rawResults.map(r => ({
        id: String(r.id ?? ''),
        text: String(r.text ?? r.content ?? ''),
        score: Number(r.score ?? 0),
        metadata: (r.metadata as Record<string, unknown>) ?? {},
      }));
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

  // ── KnowledgeBase compatibility methods ──────────────────────────
  // These methods provide the same interface as the former SQLiteVectorStore
  // so that KnowledgeBase, ragRoutes, etc. can work without changes.

  private _initialized = false;

  /** Mark client as initialized (called after healthCheck succeeds). */
  isInitialized(): boolean {
    return this._initialized;
  }

  /** No-op initialize — Python Core manages its own state. */
  async initialize(): Promise<void> {
    const healthy = await this.healthCheck();
    this._initialized = healthy;
    if (!healthy) {
      logger.warn('VectorStoreClient initialize: Python Core not reachable, marking as initialized anyway');
      this._initialized = true; // Allow graceful degradation
    }
  }

  /** No-op close. */
  async close(): Promise<void> {
    this._initialized = false;
  }

  /**
   * Insert documents into a collection (delegates to upsert).
   * Compatible with SQLiteVectorStore.insert(collection, docs) signature.
   */
  async insert(collection: string, docs: VectorDocument[]): Promise<void> {
    await this.upsert(collection, docs);
  }

  /**
   * Get a single document by ID.
   * Returns null if not found or Python Core is unavailable.
   */
  async get(collection: string, id: string): Promise<VectorDocument | null> {
    // Use search with exact ID filter as a workaround
    // Python Core doesn't have a direct GET endpoint, so we return null gracefully
    if (!degradationManager.isAvailable('vectorOperations')) {
      return null;
    }
    try {
      // Search with a filter for the specific ID
      const results = await this.search(collection, {
        collection,
        query: '',
        top_k: 1,
        filter: { id },
        min_score: 0,
      });
      if (results.length > 0) {
        return {
          id: results[0].id,
          content: results[0].text,
          metadata: results[0].metadata,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Delete multiple documents by IDs.
   * Compatible with SQLiteVectorStore.delete(collection, ids) signature.
   */
  async bulkDelete(collection: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.delete(collection, id);
    }
  }

  /**
   * Search with raw embedding vector — compatibility with former SQLiteVectorStore.
   * Signature: searchByVector(collection, vector, options) → SearchResult[]
   * Returns results in the legacy { document, score } format.
   */
  async searchByVector(
    collection: string,
    vector: number[],
    options?: { topK?: number; minScore?: number; filter?: Record<string, unknown>; includeVector?: boolean },
  ): Promise<Array<{ document: { id: string; content: string; vector: number[]; metadata: Record<string, unknown> }; score: number; distance: number }>> {
    const results = await this.search(collection, {
      collection,
      query_embedding: vector,
      top_k: options?.topK ?? 5,
      filter: options?.filter,
      min_score: options?.minScore ?? 0,
    });

    return results.map(r => ({
      document: {
        id: r.id,
        content: r.text,
        vector: [], // Python Core doesn't return vectors
        metadata: r.metadata,
      },
      score: r.score,
      distance: 1 - r.score,
    }));
  }

  /** No-op — Python Core manages collections via pgvector tables. */
  async createCollection(_name: string): Promise<void> {
    // Collections are auto-created by Python Core on first upsert
  }

  /** No-op — dropping collections not supported via Python Core API. */
  async dropCollection(_name: string): Promise<void> {
    logger.warn('VectorStoreClient.dropCollection is a no-op; Python Core manages collections');
  }

  /** List known collections (returns static list). */
  async listCollections(): Promise<string[]> {
    return ['prompt_knowledge', 'tool_vectors', 'vector_documents'];
  }

  /** Get collection stats (returns placeholder). */
  async getCollectionStats(_name: string): Promise<{ documentCount: number; totalSize: number }> {
    return { documentCount: 0, totalSize: 0 };
  }

  /** Get overall stats (returns placeholder). */
  async getStats(): Promise<{ collections: Array<{ documentCount: number; totalSize: number }>; totalSize: number }> {
    return { collections: [], totalSize: 0 };
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
