-- ============================================================
-- Migration 006: Full-Stack Audit Fixes
-- 目的: 添加软删除支持、特性标志历史、系统配置、Prompt版本历史
-- 幂等: 全部使用 IF NOT EXISTS / IF EXISTS
-- ============================================================

-- ============================================================
-- 1. users 表 — 软删除支持 + 部分唯一索引
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- 将全局唯一约束改为部分唯一索引（仅活跃用户唯一）
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_active ON users(username) WHERE is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_active ON users(email) WHERE is_active = TRUE;

-- ============================================================
-- 2. feature_flag_history — 特性标志变更历史
-- ============================================================
CREATE TABLE IF NOT EXISTS feature_flag_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_name VARCHAR(255) NOT NULL,
    old_value VARCHAR(50),
    new_value VARCHAR(50) NOT NULL,
    changed_by UUID REFERENCES users(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feature_flag_history_ts ON feature_flag_history(changed_at DESC);

-- ============================================================
-- 3. system_config — 系统配置键值存储
-- ============================================================
CREATE TABLE IF NOT EXISTS system_config (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    description TEXT,
    source VARCHAR(50) DEFAULT 'user',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 4. system_config_history — 系统配置变更历史
-- ============================================================
CREATE TABLE IF NOT EXISTS system_config_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_key VARCHAR(255) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by UUID REFERENCES users(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_system_config_history_ts ON system_config_history(changed_at DESC);

-- ============================================================
-- 5. prompt_template_versions — Prompt 模板版本历史
-- ============================================================
CREATE TABLE IF NOT EXISTS prompt_template_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
    version INT NOT NULL,
    name VARCHAR(255),
    content TEXT,
    description TEXT,
    category VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_template_versions_unique ON prompt_template_versions(template_id, version);
CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_tid ON prompt_template_versions(template_id, version DESC);
