/**
 * Migration 001 (Vector): Vector storage tables
 *
 * This migration creates the vector_documents table and its FTS5 full-text search
 * virtual table for the isolated vector database (vector.db).
 *
 * These tables are separated from the main database migrations to prevent
 * the vector DataStore instance from running business table migrations
 * (devices, users, etc.) in the vector database.
 *
 * Requirements: 7.1, 7.2
 */

import { MigrationDefinition } from '../../services/core/dataStore';

const migration: MigrationDefinition = {
  version: 1,

  up: `
    -- ============================================================
    -- 向量文档表（替代 LanceDB）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS vector_documents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 向量文档全文搜索索引 (FTS5)
    -- ============================================================
    CREATE VIRTUAL TABLE IF NOT EXISTS vector_documents_fts USING fts5(
      content,
      content='vector_documents',
      content_rowid='rowid'
    );

    -- ============================================================
    -- 索引
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_vector_documents_tenant_collection
      ON vector_documents(tenant_id, collection);
  `,

  down: `
    DROP INDEX IF EXISTS idx_vector_documents_tenant_collection;
    DROP TABLE IF EXISTS vector_documents_fts;
    DROP TABLE IF EXISTS vector_documents;
  `,
};

export default migration;
