import { MigrationDefinition } from '../types/migration';

/**
 * Migration: Add association columns to alert_events table
 * 
 * Adds:
 * - notify_channels: JSON string of notification channel IDs
 * - auto_response_config: JSON string of auto-response configuration
 * 
 * Requirements: System Association Persistence
 */
const migration: MigrationDefinition = {
    version: 6,

    up: `
    -- Add notify_channels column (JSON array of channel IDs)
    ALTER TABLE alert_events ADD COLUMN notify_channels TEXT DEFAULT '[]';

    -- Add auto_response_config column (JSON object)
    ALTER TABLE alert_events ADD COLUMN auto_response_config TEXT DEFAULT '{}';
  `,

    down: `
    -- SQLite does not support DROP COLUMN in older versions, but better-sqlite3 usually bundles a recent one.
    -- However, for safety and simplicity in SQLite, we often just ignore dropping columns or use a complex recreate table strategy.
    -- standard 'ALTER TABLE ... DROP COLUMN' is supported in SQLite 3.35.0+ (2021-03-12)
    
    ALTER TABLE alert_events DROP COLUMN notify_channels;
    ALTER TABLE alert_events DROP COLUMN auto_response_config;
  `,
};

export default migration;
