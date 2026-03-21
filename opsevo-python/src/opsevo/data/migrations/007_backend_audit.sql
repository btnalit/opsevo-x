-- ============================================================
-- Migration 007: Backend Deep Audit Fixes
-- 目的: 创建 ai_ops_kv 键值表（Brain 记忆持久化）
--       创建 knowledge_embeddings 向量表（RAG 知识库）
-- 幂等: 使用 IF NOT EXISTS
-- ============================================================

-- ============================================================
-- 1. ai_ops_kv — 通用键值存储（Brain episodic memory 等）
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_ops_kv (
  key   VARCHAR(500) PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_ops_kv_updated ON ai_ops_kv(updated_at DESC);

-- ============================================================
-- 2. knowledge_embeddings — RAG 向量知识库
--    维度 384 对应默认 all-MiniLM-L6-v2 模型
--    VectorStore.initialize() 会在运行时按实际维度补建索引
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding vector(384),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
