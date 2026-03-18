/**
 * SQLiteVectorStore - SQLite 向量存储服务
 *
 * 替代 LanceDB，使用 SQLite 存储向量数据，纯 TypeScript 实现余弦相似度搜索。
 * 利用 FTS5 全文搜索做预过滤，结合向量余弦相似度实现混合搜索。
 *
 * 设计决策：
 * - SQLite + 纯 TS 向量搜索（非 sqlite-vss），减少 native 依赖
 * - 向量存储为 Float32Array 序列化的 Buffer，存入 SQLite BLOB 字段
 * - FTS5 全文预过滤 + 向量余弦相似度混合搜索
 * - 对于 RAG 知识库规模（< 10 万条），纯 TS 余弦相似度性能足够
 *
 * Requirements: 3.1, 3.2, 3.4
 */

import { DataStore, DataStoreError } from '../../core/dataStore';
import { logger } from '../../../utils/logger';
import type {
  VectorDocument,
  VectorDocumentMetadata,
  SearchResult,
  SearchOptions,
  CollectionStats,
} from './vectorDatabase';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * SQLite 中的向量文档记录
 */
interface VectorRecord {
  id: string;
  tenant_id: string;
  collection: string;
  content: string;
  metadata: string;       // JSON 序列化
  embedding: Buffer | null; // Float32Array 序列化为 Buffer
  created_at: string;
  updated_at: string;
  rowid?: number;
}

/**
 * FTS5 搜索结果（带 rank 分数）
 */
interface FTSResult {
  id: string;
  rank: number;
  rowid: number;
}

/**
 * SQLiteVectorStore 配置
 */
export interface SQLiteVectorStoreConfig {
  /** 默认租户 ID（向后兼容，单租户模式使用） */
  defaultTenantId?: string;
  /** FTS5 预过滤候选数量上限 */
  ftsPreFilterLimit?: number;
  /** 混合搜索中 FTS5 分数权重（0-1） */
  ftsWeight?: number;
  /** 混合搜索中向量相似度权重（0-1） */
  vectorWeight?: number;
}

const DEFAULT_CONFIG: Required<SQLiteVectorStoreConfig> = {
  defaultTenantId: 'default',
  ftsPreFilterLimit: 200,
  ftsWeight: 0.3,
  vectorWeight: 0.7,
};

// ─── Vector Serialization Utilities ──────────────────────────────────────────

/**
 * 将 number[] 序列化为 Buffer（Float32Array → Buffer）
 * 用于将向量存储到 SQLite BLOB 字段
 */
export function vectorToBuffer(vector: number[]): Buffer {
  const float32 = new Float32Array(vector);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

/**
 * 将 Buffer 反序列化为 number[]（Buffer → Float32Array → number[]）
 * 用于从 SQLite BLOB 字段读取向量
 */
export function bufferToVector(buffer: Buffer): number[] {
  const float32 = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(float32);
}

// ─── Cosine Similarity ───────────────────────────────────────────────────────

/**
 * 计算两个向量的余弦相似度
 *
 * cosine_similarity(A, B) = (A · B) / (||A|| * ||B||)
 *
 * 返回值范围 [-1, 1]，1 表示完全相同，0 表示正交，-1 表示完全相反
 * 对于归一化向量，等价于点积
 *
 * @param a 向量 A
 * @param b 向量 B
 * @returns 余弦相似度分数
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  if (a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  if (denominator === 0) {
    return 0; // 零向量的相似度定义为 0
  }

  return dotProduct / denominator;
}

// ─── SQLiteVectorStore Class ─────────────────────────────────────────────────

/**
 * SQLiteVectorStore - 基于 SQLite 的向量存储
 *
 * 实现与现有 VectorDatabase 相同的接口契约，
 * 使用 DataStore 进行数据持久化。
 */
export class SQLiteVectorStore {
  private dataStore: DataStore;
  private config: Required<SQLiteVectorStoreConfig>;
  private initialized = false;

  constructor(dataStore: DataStore, config?: SQLiteVectorStoreConfig) {
    this.dataStore = dataStore;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * 初始化向量存储
   * 确保 DataStore 已初始化（表和 FTS5 索引由迁移创建）
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('SQLiteVectorStore 已初始化，跳过重复初始化');
      return;
    }

    if (!this.dataStore.isInitialized()) {
      throw new DataStoreError(
        'DataStore 未初始化，请先初始化 DataStore',
        'SQLiteVectorStore.initialize',
      );
    }

    // Ensure FTS triggers exist for keeping FTS5 index in sync
    this.ensureFTSTriggers();

    this.initialized = true;
    logger.info('SQLiteVectorStore 初始化完成');
  }

  /**
   * 关闭向量存储
   */
  async close(): Promise<void> {
    this.initialized = false;
    logger.info('SQLiteVectorStore 已关闭');
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ─── Collection Management ───────────────────────────────────────────────

  /**
   * 创建集合
   * SQLite 实现中，集合是 vector_documents 表中的逻辑分区（通过 collection 字段区分）
   * 此方法主要用于兼容接口，实际不需要创建物理表
   */
  async createCollection(name: string): Promise<void> {
    this.ensureInitialized();
    // 集合是逻辑概念，无需物理创建
    // 记录日志以便追踪
    logger.info(`集合 "${name}" 已就绪（逻辑集合）`);
  }

  /**
   * 删除集合（删除该集合下的所有文档）
   *
   * @param name 集合名称
   */
  async dropCollection(name: string): Promise<void> {
    this.ensureInitialized();

    try {
      // First remove FTS entries for all documents in this collection
      const rows = this.dataStore.query<{ rowid: number; content: string }>(
        `SELECT rowid, content FROM vector_documents WHERE collection = ?`,
        [name],
      );

      this.dataStore.transaction(() => {
        for (const row of rows) {
          try {
            this.dataStore.run(
              `INSERT INTO vector_documents_fts(vector_documents_fts, rowid, content) VALUES('delete', ?, ?)`,
              [row.rowid, row.content],
            );
          } catch {
            // Ignore FTS cleanup errors
          }
        }

        this.dataStore.run(
          `DELETE FROM vector_documents WHERE collection = ?`,
          [name],
        );
      });

      logger.info(`集合 "${name}" 已删除（${rows.length} 条文档）`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`删除集合失败: ${err.message}`, { collection: name });
      throw error;
    }
  }

  /**
   * 列出所有集合
   *
   * @returns 集合名称数组
   */
  async listCollections(): Promise<string[]> {
    this.ensureInitialized();

    try {
      const rows = this.dataStore.query<{ collection: string }>(
        `SELECT DISTINCT collection FROM vector_documents`,
      );
      return rows.map((r) => r.collection);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`列出集合失败: ${err.message}`);
      throw error;
    }
  }

  /**
   * 获取集合统计信息
   *
   * @param name 集合名称
   * @returns 集合统计信息
   */
  async getCollectionStats(name: string): Promise<CollectionStats> {
    this.ensureInitialized();

    try {
      const countRow = this.dataStore.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vector_documents WHERE collection = ?`,
        [name],
      );

      const lastUpdatedRow = this.dataStore.query<{ max_updated: string | null }>(
        `SELECT MAX(updated_at) as max_updated FROM vector_documents WHERE collection = ?`,
        [name],
      );

      // Estimate index size based on document count and average embedding size
      const sizeRow = this.dataStore.query<{ total_size: number }>(
        `SELECT COALESCE(SUM(LENGTH(embedding)), 0) as total_size FROM vector_documents WHERE collection = ?`,
        [name],
      );

      const documentCount = countRow[0]?.cnt ?? 0;
      const lastUpdatedStr = lastUpdatedRow[0]?.max_updated;
      const lastUpdated = lastUpdatedStr ? new Date(lastUpdatedStr).getTime() : 0;
      const indexSize = sizeRow[0]?.total_size ?? 0;

      return {
        name,
        documentCount,
        indexSize,
        lastUpdated,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`获取集合统计失败: ${err.message}`, { collection: name });
      throw error;
    }
  }

  /**
   * 获取所有集合的统计信息
   *
   * @returns 统计信息对象
   */
  async getStats(): Promise<{ collections: CollectionStats[]; totalSize: number }> {
    this.ensureInitialized();

    try {
      const collectionNames = await this.listCollections();
      const collections: CollectionStats[] = [];
      let totalSize = 0;

      for (const name of collectionNames) {
        const stats = await this.getCollectionStats(name);
        collections.push(stats);
        totalSize += stats.indexSize;
      }

      return { collections, totalSize };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`获取统计信息失败: ${err.message}`);
      throw error;
    }
  }

  /**
   * 批量删除文档（按过滤条件）
   *
   * @param collection 集合名称
   * @param filter 过滤条件
   * @returns 删除的文档数量
   */
  async bulkDelete(collection: string, filter: Record<string, unknown>): Promise<number> {
    this.ensureInitialized();

    try {
      // Get all documents in the collection
      const allDocs = this.dataStore.query<VectorRecord>(
        `SELECT * FROM vector_documents WHERE collection = ?`,
        [collection],
      );

      // Apply metadata filter to find matching documents
      const toDelete = this.applyMetadataFilter(allDocs, filter);

      if (toDelete.length === 0) return 0;

      const ids = toDelete.map((d) => d.id);
      await this.delete(collection, ids);

      return ids.length;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`批量删除失败: ${err.message}`, { collection });
      throw error;
    }
  }

  /**
   * 压缩集合（SQLite 实现中为 no-op，保持接口兼容）
   *
   * @param _collection 集合名称
   */
  async compact(_collection: string): Promise<void> {
    this.ensureInitialized();
    // SQLite 不需要手动压缩，此方法为接口兼容保留
    logger.debug(`集合压缩为 no-op（SQLite 自动管理）`);
  }

  /**
   * 获取配置
   */
  getConfig(): SQLiteVectorStoreConfig {
    return { ...this.config };
  }


  // ─── CRUD Operations ─────────────────────────────────────────────────────

  /**
   * 插入文档到集合
   *
   * @param collection 集合名称
   * @param documents 要插入的文档数组
   * @param tenantId 租户 ID（可选，默认使用配置中的 defaultTenantId）
   */
  async insert(
    collection: string,
    documents: VectorDocument[],
    tenantId?: string,
  ): Promise<void> {
    this.ensureInitialized();

    if (documents.length === 0) return;

    const tid = tenantId ?? this.config.defaultTenantId;
    const now = new Date().toISOString();

    try {
      this.dataStore.transaction(() => {
        for (const doc of documents) {
          const embeddingBuffer = doc.vector && doc.vector.length > 0
            ? vectorToBuffer(doc.vector)
            : null;

          this.dataStore.run(
            `INSERT OR REPLACE INTO vector_documents (id, tenant_id, collection, content, metadata, embedding, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              doc.id,
              tid,
              collection,
              doc.content,
              JSON.stringify(doc.metadata),
              embeddingBuffer,
              now,
              now,
            ],
          );

          // Sync FTS5 index manually (trigger-based sync is set up in ensureFTSTriggers)
          // For INSERT OR REPLACE, we need to handle FTS manually since triggers
          // may not fire correctly for REPLACE operations
          this.syncFTSForDocument(doc.id, doc.content);
        }
      });

      logger.debug(`插入 ${documents.length} 条文档到集合 "${collection}"`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`插入文档失败: ${err.message}`, { collection, count: documents.length });
      throw error;
    }
  }

  /**
   * 批量插入文档（与 insert 相同实现，保持接口兼容）
   */
  async bulkInsert(
    collection: string,
    documents: VectorDocument[],
    tenantId?: string,
  ): Promise<void> {
    return this.insert(collection, documents, tenantId);
  }

  /**
   * 获取单个文档
   *
   * @param collection 集合名称
   * @param id 文档 ID
   * @param tenantId 租户 ID（可选）
   * @returns 文档或 null
   */
  async get(
    collection: string,
    id: string,
    tenantId?: string,
  ): Promise<VectorDocument | null> {
    this.ensureInitialized();

    const tid = tenantId ?? this.config.defaultTenantId;

    try {
      const rows = this.dataStore.query<VectorRecord>(
        `SELECT * FROM vector_documents WHERE id = ? AND collection = ? AND tenant_id = ?`,
        [id, collection, tid],
      );

      if (rows.length === 0) return null;

      return this.recordToDocument(rows[0]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`获取文档失败: ${err.message}`, { collection, id });
      throw error;
    }
  }

  /**
   * 向量搜索
   *
   * 搜索策略：
   * 1. 如果提供了 filter.textQuery，先用 FTS5 全文预过滤缩小候选集
   * 2. 对候选集计算余弦相似度
   * 3. 综合 FTS5 分数和向量相似度排序
   * 4. 如果没有文本查询，直接对集合内所有文档计算向量相似度
   *
   * @param collection 集合名称
   * @param queryVector 查询向量
   * @param options 搜索选项
   * @param tenantId 租户 ID（可选）
   * @returns 搜索结果数组（按相似度降序）
   */
  async search(
    collection: string,
    queryVector: number[],
    options: SearchOptions = { topK: 5 },
    tenantId?: string,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();

    const tid = tenantId ?? this.config.defaultTenantId;
    const { topK = 5, minScore, filter, includeVector = false } = options;

    try {
      // Determine if we should use FTS5 pre-filtering
      const textQuery = filter?.textQuery as string | undefined;

      let candidates: VectorRecord[];

      if (textQuery && textQuery.trim().length > 0) {
        // Strategy 1: FTS5 pre-filtering + vector similarity
        candidates = this.ftsPreFilter(collection, tid, textQuery);
      } else {
        // Strategy 2: Full collection scan with vector similarity
        candidates = this.dataStore.query<VectorRecord>(
          `SELECT * FROM vector_documents WHERE collection = ? AND tenant_id = ? AND embedding IS NOT NULL`,
          [collection, tid],
        );
      }

      // Apply metadata filters
      if (filter) {
        candidates = this.applyMetadataFilter(candidates, filter);
      }

      // Compute cosine similarity for all candidates
      const results: SearchResult[] = [];

      for (const record of candidates) {
        if (!record.embedding) continue;

        const docVector = bufferToVector(record.embedding as unknown as Buffer);
        const similarity = cosineSimilarity(queryVector, docVector);

        // Apply minimum score filter
        if (minScore !== undefined && similarity < minScore) continue;

        const document = this.recordToDocument(record, includeVector);
        const distance = 1 - similarity; // cosine distance

        results.push({
          document,
          score: similarity,
          distance,
        });
      }

      // Sort by similarity descending
      results.sort((a, b) => b.score - a.score);

      // Return top-K results
      const topResults = results.slice(0, topK);

      logger.debug(`搜索集合 "${collection}": 候选 ${candidates.length} 条, 返回 ${topResults.length} 条`);
      return topResults;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`搜索失败: ${err.message}`, { collection });
      throw error;
    }
  }

  /**
   * 混合搜索（FTS5 + 向量相似度）
   *
   * 结合全文搜索分数和向量相似度分数，适用于同时有文本查询和向量查询的场景。
   *
   * @param collection 集合名称
   * @param queryVector 查询向量
   * @param textQuery 文本查询
   * @param options 搜索选项
   * @param tenantId 租户 ID（可选）
   * @returns 搜索结果数组
   */
  async hybridSearch(
    collection: string,
    queryVector: number[],
    textQuery: string,
    options: SearchOptions = { topK: 5 },
    tenantId?: string,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();

    const tid = tenantId ?? this.config.defaultTenantId;
    const { topK = 5, minScore } = options;

    try {
      // Step 1: Get FTS5 results with scores
      const ftsResults = this.getFTSResultsWithScores(collection, tid, textQuery);
      const ftsScoreMap = new Map<string, number>();

      // Normalize FTS scores to [0, 1]
      let maxFtsScore = 0;
      for (const r of ftsResults) {
        // FTS5 rank is negative (more negative = better match), negate it
        const absRank = Math.abs(r.rank);
        if (absRank > maxFtsScore) maxFtsScore = absRank;
      }

      for (const r of ftsResults) {
        const normalizedScore = maxFtsScore > 0 ? Math.abs(r.rank) / maxFtsScore : 0;
        ftsScoreMap.set(r.id, normalizedScore);
      }

      // Step 2: Get all candidates (union of FTS results and collection)
      const candidates = this.dataStore.query<VectorRecord>(
        `SELECT * FROM vector_documents WHERE collection = ? AND tenant_id = ? AND embedding IS NOT NULL`,
        [collection, tid],
      );

      // Step 3: Compute hybrid scores
      const results: SearchResult[] = [];

      for (const record of candidates) {
        if (!record.embedding) continue;

        const docVector = bufferToVector(record.embedding as unknown as Buffer);
        const vectorSimilarity = cosineSimilarity(queryVector, docVector);
        const ftsScore = ftsScoreMap.get(record.id) ?? 0;

        // Hybrid score = weighted combination
        const hybridScore =
          this.config.vectorWeight * vectorSimilarity +
          this.config.ftsWeight * ftsScore;

        if (minScore !== undefined && hybridScore < minScore) continue;

        const document = this.recordToDocument(record, false);

        results.push({
          document,
          score: hybridScore,
          distance: 1 - hybridScore,
        });
      }

      // Sort by hybrid score descending
      results.sort((a, b) => b.score - a.score);

      return results.slice(0, topK);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`混合搜索失败: ${err.message}`, { collection, textQuery });
      throw error;
    }
  }

  /**
   * 删除文档
   *
   * @param collection 集合名称
   * @param ids 要删除的文档 ID 数组
   * @param tenantId 租户 ID（可选）
   */
  async delete(
    collection: string,
    ids: string[],
    tenantId?: string,
  ): Promise<void> {
    this.ensureInitialized();

    if (ids.length === 0) return;

    const tid = tenantId ?? this.config.defaultTenantId;

    try {
      this.dataStore.transaction(() => {
        for (const id of ids) {
          // Get rowid and content for FTS cleanup BEFORE deleting
          const rows = this.dataStore.query<{ rowid: number; content: string }>(
            `SELECT rowid, content FROM vector_documents WHERE id = ? AND collection = ? AND tenant_id = ?`,
            [id, collection, tid],
          );

          if (rows.length > 0) {
            // Remove from FTS index first (need original content for external content table)
            try {
              this.dataStore.run(
                `INSERT INTO vector_documents_fts(vector_documents_fts, rowid, content) VALUES('delete', ?, ?)`,
                [rows[0].rowid, rows[0].content],
              );
            } catch {
              // Ignore FTS cleanup errors
            }

            // Delete from main table
            this.dataStore.run(
              `DELETE FROM vector_documents WHERE id = ? AND collection = ? AND tenant_id = ?`,
              [id, collection, tid],
            );
          }
        }
      });

      logger.debug(`删除 ${ids.length} 条文档从集合 "${collection}"`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`删除文档失败: ${err.message}`, { collection, ids });
      throw error;
    }
  }

  /**
   * 更新文档
   *
   * @param collection 集合名称
   * @param id 文档 ID
   * @param document 要更新的字段
   * @param tenantId 租户 ID（可选）
   */
  async update(
    collection: string,
    id: string,
    document: Partial<VectorDocument>,
    tenantId?: string,
  ): Promise<void> {
    this.ensureInitialized();

    const tid = tenantId ?? this.config.defaultTenantId;
    const now = new Date().toISOString();

    try {
      // Get existing document
      const existing = this.dataStore.query<VectorRecord>(
        `SELECT * FROM vector_documents WHERE id = ? AND collection = ? AND tenant_id = ?`,
        [id, collection, tid],
      );

      if (existing.length === 0) {
        throw new Error(`文档 ${id} 在集合 "${collection}" 中不存在`);
      }

      const record = existing[0];

      // Build update fields
      const updates: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];

      if (document.content !== undefined) {
        updates.push('content = ?');
        params.push(document.content);
      }

      if (document.metadata !== undefined) {
        updates.push('metadata = ?');
        params.push(JSON.stringify(document.metadata));
      }

      if (document.vector !== undefined) {
        updates.push('embedding = ?');
        params.push(
          document.vector.length > 0 ? vectorToBuffer(document.vector) : null,
        );
      }

      // Add WHERE clause params
      params.push(id, collection, tid);

      this.dataStore.transaction(() => {
        this.dataStore.run(
          `UPDATE vector_documents SET ${updates.join(', ')} WHERE id = ? AND collection = ? AND tenant_id = ?`,
          params,
        );

        // Update FTS index if content changed
        if (document.content !== undefined) {
          const rowRows = this.dataStore.query<{ rowid: number; content: string }>(
            `SELECT rowid, content FROM vector_documents WHERE id = ? AND collection = ? AND tenant_id = ?`,
            [id, collection, tid],
          );
          if (rowRows.length > 0) {
            // Remove old FTS entry using old content
            try {
              this.dataStore.run(
                `INSERT INTO vector_documents_fts(vector_documents_fts, rowid, content) VALUES('delete', ?, ?)`,
                [rowRows[0].rowid, record.content], // use old content from the record we fetched earlier
              );
            } catch {
              // Ignore FTS cleanup errors
            }
            this.insertFTSForRowid(rowRows[0].rowid, document.content);
          }
        }
      });

      logger.debug(`更新文档 ${id} 在集合 "${collection}"`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`更新文档失败: ${err.message}`, { collection, id });
      throw error;
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new DataStoreError(
        'SQLiteVectorStore 未初始化，请先调用 initialize()',
        'ensureInitialized',
      );
    }
  }

  /**
   * 确保 FTS5 触发器存在
   * 用于在 INSERT/UPDATE/DELETE 时自动同步 FTS5 索引
   *
   * 注意：由于使用 content= 外部内容表，需要手动管理 FTS 同步
   * 我们在 CRUD 方法中手动同步，而不是依赖触发器，
   * 因为 INSERT OR REPLACE 和事务中的触发器行为可能不一致
   */
  private ensureFTSTriggers(): void {
    // We manage FTS sync manually in CRUD methods for reliability
    // This method is a placeholder for any future trigger-based optimization
    logger.debug('FTS5 索引同步由 CRUD 方法手动管理');
  }

  /**
   * 为文档同步 FTS5 索引
   * 注意：对于新插入的文档，直接插入 FTS 即可
   * 对于 INSERT OR REPLACE，旧的 rowid 已被删除，FTS 中的旧条目会变成孤立的
   * 但这不影响搜索正确性（只是 FTS 中可能有少量孤立条目）
   */
  private syncFTSForDocument(docId: string, content: string): void {
    try {
      // Get the rowid of the document
      const rows = this.dataStore.query<{ rowid: number }>(
        `SELECT rowid FROM vector_documents WHERE id = ?`,
        [docId],
      );

      if (rows.length === 0) return;

      const rowid = rows[0].rowid;

      // Insert FTS entry (for new documents or replaced documents with new rowid)
      this.insertFTSForRowid(rowid, content);
    } catch (error) {
      // FTS sync failure should not block the main operation
      logger.debug(`FTS 同步失败 (docId: ${docId}): ${error}`);
    }
  }

  /**
   * 插入 FTS 索引条目
   */
  private insertFTSForRowid(rowid: number, content: string): void {
    this.dataStore.run(
      `INSERT INTO vector_documents_fts(rowid, content) VALUES(?, ?)`,
      [rowid, content],
    );
  }

  /**
   * FTS5 预过滤：使用全文搜索缩小候选集
   */
  private ftsPreFilter(
    collection: string,
    tenantId: string,
    textQuery: string,
  ): VectorRecord[] {
    try {
      // Sanitize the text query for FTS5 (escape special characters)
      const sanitizedQuery = this.sanitizeFTSQuery(textQuery);

      if (!sanitizedQuery) {
        // If query is empty after sanitization, fall back to full scan
        return this.dataStore.query<VectorRecord>(
          `SELECT * FROM vector_documents WHERE collection = ? AND tenant_id = ? AND embedding IS NOT NULL`,
          [collection, tenantId],
        );
      }

      // Use FTS5 to find matching rowids, then join with main table
      const results = this.dataStore.query<VectorRecord>(
        `SELECT vd.* FROM vector_documents vd
         INNER JOIN vector_documents_fts fts ON vd.rowid = fts.rowid
         WHERE fts.content MATCH ?
           AND vd.collection = ?
           AND vd.tenant_id = ?
           AND vd.embedding IS NOT NULL
         LIMIT ?`,
        [sanitizedQuery, collection, tenantId, this.config.ftsPreFilterLimit],
      );

      return results;
    } catch (error) {
      // FTS query failure: fall back to full scan
      logger.debug(`FTS 预过滤失败，回退到全量扫描: ${error}`);
      return this.dataStore.query<VectorRecord>(
        `SELECT * FROM vector_documents WHERE collection = ? AND tenant_id = ? AND embedding IS NOT NULL`,
        [collection, tenantId],
      );
    }
  }

  /**
   * 获取 FTS5 搜索结果及分数
   */
  private getFTSResultsWithScores(
    collection: string,
    tenantId: string,
    textQuery: string,
  ): FTSResult[] {
    try {
      const sanitizedQuery = this.sanitizeFTSQuery(textQuery);
      if (!sanitizedQuery) return [];

      return this.dataStore.query<FTSResult>(
        `SELECT vd.id, rank, vd.rowid FROM vector_documents_fts fts
         INNER JOIN vector_documents vd ON vd.rowid = fts.rowid
         WHERE fts.content MATCH ?
           AND vd.collection = ?
           AND vd.tenant_id = ?
         ORDER BY rank
         LIMIT ?`,
        [sanitizedQuery, collection, tenantId, this.config.ftsPreFilterLimit],
      );
    } catch (error) {
      logger.debug(`FTS 搜索失败: ${error}`);
      return [];
    }
  }

  /**
   * 清理 FTS5 查询字符串
   * FTS5 有特殊语法，需要转义用户输入
   */
  private sanitizeFTSQuery(query: string): string {
    // Remove FTS5 special operators and wrap each term in quotes
    const terms = query
      .replace(/['"]/g, '') // Remove quotes
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t}"`) // Quote each term for exact matching
      .join(' OR '); // Use OR to match any term

    return terms;
  }

  /**
   * 应用元数据过滤
   */
  private applyMetadataFilter(
    records: VectorRecord[],
    filter: Record<string, unknown>,
  ): VectorRecord[] {
    return records.filter((record) => {
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(record.metadata);
      } catch {
        return true; // If metadata can't be parsed, don't filter it out
      }

      for (const [key, value] of Object.entries(filter)) {
        // Skip special filter keys
        if (key === 'textQuery' || key === 'includeVector') continue;
        if (value === undefined || value === null) continue;

        // Check metadata fields
        if (key.startsWith('metadata.')) {
          const metaKey = key.substring('metadata.'.length);
          if (metadata[metaKey] !== value) return false;
        } else {
          // Check top-level record fields
          if ((record as unknown as Record<string, unknown>)[key] !== value) return false;
        }
      }

      return true;
    });
  }

  /**
   * 将数据库记录转换为 VectorDocument
   */
  private recordToDocument(
    record: VectorRecord,
    includeVector = true,
  ): VectorDocument {
    let metadata: VectorDocumentMetadata;
    try {
      metadata = JSON.parse(record.metadata) as VectorDocumentMetadata;
    } catch {
      metadata = {} as VectorDocumentMetadata;
    }

    let vector: number[] = [];
    if (includeVector && record.embedding) {
      vector = bufferToVector(record.embedding as unknown as Buffer);
    }

    return {
      id: record.id,
      content: record.content,
      vector,
      metadata,
    };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export type { VectorRecord, SQLiteVectorStoreConfig as VectorStoreConfig };
