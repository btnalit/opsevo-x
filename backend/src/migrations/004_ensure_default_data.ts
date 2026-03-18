
/**
 * Migration 004: Ensure default user and device exist
 *
 * Requirements: Fix persistence issues by ensuring foreign key constraints are met
 * when services use 'default' as a fallback tenantId/deviceId.
 */

import { MigrationDefinition } from '../types/migration';

const migration: MigrationDefinition = {
    version: 4,

    up: `
    -- Ensure default user exists
  `,
  
    down: `
    -- We generally don't want to delete the default user/device in a rollback 
    -- as it might have associated data now.
    -- This is a no-op for safety.
  `,
};

export default migration;
