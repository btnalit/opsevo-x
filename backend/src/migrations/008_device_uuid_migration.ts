/**
 * Migration 008: 将设备 ID 从 'default' 迁移为 UUID
 *
 * 背景：migration 004 创建了 id='default' 的占位设备，但实际生产中该设备被用作
 * 真实设备。为统一使用 UUID 作为设备标识，本迁移将：
 * 1. 生成一个 UUID v4
 * 2. 创建新设备记录（复制原 'default' 设备的所有字段）
 * 3. 更新所有子表的 FK 引用
 * 4. 删除旧的 'default' 设备记录
 *
 * 注意：采用 INSERT-UPDATE-DELETE 策略避免 FK 约束冲突
 */

import { MigrationDefinition } from '../services/core/dataStore';

const migration: MigrationDefinition = {
  version: 8,

  up: `
    -- 仅当 id='default' 的设备存在时才执行迁移
    -- 使用 SQLite 纯 SQL 生成 UUID v4
    CREATE TEMP TABLE IF NOT EXISTS _dev_uuid AS
      SELECT lower(hex(randomblob(4))) || '-' ||
             lower(hex(randomblob(2))) || '-4' ||
             substr(lower(hex(randomblob(2))), 2) || '-' ||
             substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(lower(hex(randomblob(2))), 2) || '-' ||
             lower(hex(randomblob(6))) AS new_id;

    -- Step 1: 复制 'default' 设备为新 UUID 设备
    INSERT OR IGNORE INTO devices (id, tenant_id, name, host, port, username, password_encrypted, use_tls, group_name, tags, status, last_seen, error_message, created_at, updated_at)
      SELECT (SELECT new_id FROM _dev_uuid),
             tenant_id, name, host, port, username, password_encrypted,
             use_tls, group_name, tags, status, last_seen, error_message,
             created_at, updated_at
      FROM devices WHERE id = 'default';

    -- Step 2: 更新所有子表 FK 引用
    UPDATE alert_rules SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';
    UPDATE alert_events SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';
    UPDATE config_snapshots SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';
    UPDATE chat_sessions SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';
    UPDATE scheduled_tasks SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';
    UPDATE health_metrics SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';
    UPDATE audit_logs SET device_id = (SELECT new_id FROM _dev_uuid) WHERE device_id = 'default';

    -- Step 3: 删除旧的 'default' 设备（所有 FK 引用已迁移）
    DELETE FROM devices WHERE id = 'default';

    -- Step 4: 清理临时表
    DROP TABLE IF EXISTS _dev_uuid;
  `,

  down: `
    -- 回滚：无法恢复原始 'default' ID（UUID 是随机生成的）
    -- 如需回滚，请手动处理或从备份恢复
  `,
};

export default migration;
