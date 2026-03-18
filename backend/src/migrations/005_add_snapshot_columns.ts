/**
 * Add checksum and metadata columns to config_snapshots table
 * Requirements: 5.3, 5.7 - Persist snapshot details
 */
import { MigrationDefinition } from '../types/migration';

const migration: MigrationDefinition = {
    version: 5,

    up: `
    ALTER TABLE config_snapshots ADD COLUMN checksum TEXT;
    ALTER TABLE config_snapshots ADD COLUMN metadata TEXT DEFAULT '{}';
  `,

    down: `
    ALTER TABLE config_snapshots DROP COLUMN checksum;
    ALTER TABLE config_snapshots DROP COLUMN metadata;
  `,
};

export default migration;
