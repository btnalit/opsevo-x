/**
 * Migration 003: Add actor column to audit_logs table
 *
 * The audit_logs table previously stored the actor value inside the details JSON
 * as a '_actor' field. This migration adds a dedicated 'actor' column for efficient
 * SQL-level filtering, migrates existing _actor data from details JSON to the new column,
 * and cleans up the _actor field from details.
 *
 * Requirements: 6.1, 6.4
 */

import { MigrationDefinition } from '../services/core/dataStore';

const migration: MigrationDefinition = {
  version: 3,

  up: `
    -- Add actor column with default value 'system'
    ALTER TABLE audit_logs ADD COLUMN actor TEXT DEFAULT 'system';

    -- Migrate existing _actor data from details JSON to the new actor column
    UPDATE audit_logs
    SET actor = COALESCE(json_extract(details, '$._actor'), 'system')
    WHERE json_extract(details, '$._actor') IS NOT NULL;

    -- Remove _actor field from details JSON
    UPDATE audit_logs
    SET details = json_remove(details, '$._actor')
    WHERE json_extract(details, '$._actor') IS NOT NULL;

    -- Create index for efficient actor-based queries
    CREATE INDEX idx_audit_logs_actor ON audit_logs(actor);
  `,

  down: `
    -- Drop the actor index
    DROP INDEX IF EXISTS idx_audit_logs_actor;

    -- SQLite does not support DROP COLUMN in older versions.
    -- For rollback, we would need to recreate the table.
    -- This is a no-op for the column removal for safety.
  `,
};

export default migration;
