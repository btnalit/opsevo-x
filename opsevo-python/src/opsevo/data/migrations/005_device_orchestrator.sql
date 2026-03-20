-- ============================================================
-- Migration 005: DeviceOrchestrator 支持
-- 目的: 扩展 devices 表，新增生命周期事件表和编排器状态表
-- 幂等: 全部使用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- ============================================================

-- 1. 扩展 devices 表 — 编排器运行时字段
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS auto_connect BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- 2. 设备生命周期事件表 — 审计和故障排查
CREATE TABLE IF NOT EXISTS device_lifecycle_events (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dle_device_id ON device_lifecycle_events(device_id);
CREATE INDEX IF NOT EXISTS idx_dle_created_at ON device_lifecycle_events(created_at);
CREATE INDEX IF NOT EXISTS idx_dle_event_type ON device_lifecycle_events(event_type);

-- 3. 编排器持久化状态表 — 重启恢复
CREATE TABLE IF NOT EXISTS device_orchestrator_state (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
