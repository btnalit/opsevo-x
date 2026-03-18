/**
 * @deprecated 此模块仅保留类型定义用于向后兼容。
 * 向量操作已迁移到 VectorStoreClient（通过 Python Core 执行）。
 * 新代码应从 `./vectorStoreClient` 导入 `VectorStoreClient`。
 * 类型定义（VectorDocument, SearchResult 等）仍可从此文件导入。
 */

// ==================== 类型定义（向后兼容导出） ====================

/**
 * 向量文档元数据
 */
export interface VectorDocumentMetadata {
  source: 'alert' | 'remediation' | 'config' | 'pattern' | 'manual' | 'feedback' | 'learning' | 'experience';
  category: string;
  timestamp: number;
  tags: string[];
  [key: string]: unknown;
}

/**
 * 向量文档
 */
export interface VectorDocument {
  id: string;
  content: string;
  vector: number[];
  metadata: VectorDocumentMetadata;
}

/**
 * 搜索结果
 */
export interface SearchResult {
  document: VectorDocument;
  score: number;    // 相似度分数 0-1
  distance: number; // 向量距离
}

/**
 * 搜索选项
 */
export interface SearchOptions {
  topK: number;                       // 返回结果数量，默认 5
  minScore?: number;                  // 最小相似度阈值
  filter?: Record<string, unknown>;   // 元数据过滤条件
  includeVector?: boolean;            // 是否返回向量
}

/**
 * 集合统计信息
 */
export interface CollectionStats {
  name: string;
  documentCount: number;
  indexSize: number;
  lastUpdated: number;
}

/**
 * 向量数据库配置
 */
export interface VectorDatabaseConfig {
  dbPath: string;         // 数据库路径
  collections: string[];  // 集合列表
}
