-- ============================================================
-- Migration 002: 创建 scheduled_tasks 表
-- 目的: 持久化 Brain 通过 schedule_task 工具创建的定时任务
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    cron       TEXT NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    metadata   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
