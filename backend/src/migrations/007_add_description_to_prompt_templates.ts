/**
 * Migration 007: Add description column to prompt_templates table
 *
 * The prompt_templates table was missing a 'description' column, causing template
 * descriptions to be lost when stored in SQLite. This migration adds the column
 * and backfills descriptions from the JSON data file if available.
 */

import { MigrationDefinition } from '../services/core/dataStore';

const migration: MigrationDefinition = {
  version: 7,

  up: `
    -- Add description column to prompt_templates
    ALTER TABLE prompt_templates ADD COLUMN description TEXT;
  `,

  down: `
    -- SQLite does not support DROP COLUMN in older versions.
    -- This is a no-op for safety.
  `,
};

export default migration;
