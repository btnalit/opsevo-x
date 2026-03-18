/**
 * PostgreSQL Migration 003: feature_flags 表
 *
 * 创建 feature_flags 表，支持 FeatureFlagManager 的运行时切换与持久化。
 * 每个 Flag 包含：唯一键名、启用状态、描述、依赖关系（JSONB 数组）、时间戳。
 *
 * 依赖关系校验逻辑在应用层（FeatureFlagManager）实现，数据库仅存储声明。
 *
 * Requirements: I5.14
 */

import type { PgMigrationDefinition } from './pgMigrationRunner';

const migration: PgMigrationDefinition = {
  version: 3,
  description: 'feature_flags 表（FeatureFlagManager 持久化）',

  up: `
-- ============================================================
-- 36. feature_flags（特性开关持久化）
-- ============================================================
CREATE TABLE feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key VARCHAR(100) UNIQUE NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  dependencies JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feature_flags_key ON feature_flags(flag_key);
CREATE INDEX idx_feature_flags_enabled ON feature_flags(enabled);
  `,

  down: `
DROP TABLE IF EXISTS feature_flags;
  `,
};

export default migration;
