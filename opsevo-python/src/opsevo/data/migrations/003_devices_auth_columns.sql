-- ============================================================
-- Migration 003: 为 devices 表补充认证和 TLS 列
-- 目的: Python 后端 DeviceManager 使用 username/password/use_tls
--       作为独立列存储设备连接凭据
-- ============================================================

ALTER TABLE devices ADD COLUMN IF NOT EXISTS username VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS password TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS use_tls BOOLEAN NOT NULL DEFAULT false;
