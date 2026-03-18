/**
 * Migration 002: Add missing columns to chat_sessions table
 *
 * The initial schema only had basic columns (id, tenant_id, device_id, messages, created_at, updated_at).
 * The ChatSession interface requires additional columns for title, provider, model, mode, and config.
 *
 * Requirements: 8.4 - 对话历史按 tenant_id 和 device_id 隔离存储
 */

import { MigrationDefinition } from '../types/migration';

const migration: MigrationDefinition = {
  version: 2,
  up: `
    ALTER TABLE chat_sessions ADD COLUMN title TEXT DEFAULT '新会话';
    ALTER TABLE chat_sessions ADD COLUMN provider TEXT DEFAULT '';
    ALTER TABLE chat_sessions ADD COLUMN model TEXT DEFAULT '';
    ALTER TABLE chat_sessions ADD COLUMN mode TEXT DEFAULT 'standard';
    ALTER TABLE chat_sessions ADD COLUMN config TEXT DEFAULT '{}';
    ALTER TABLE chat_sessions ADD COLUMN collected_count INTEGER DEFAULT 0;
  `,
  down: `
    -- SQLite does not support DROP COLUMN in older versions.
    -- For rollback, we would need to recreate the table.
    -- This is a no-op for safety.
  `,
};

export default migration;
