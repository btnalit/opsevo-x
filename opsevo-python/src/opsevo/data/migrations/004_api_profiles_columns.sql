-- Migration 004: Add columns needed by frontend profileApi
-- The original api_profiles table has: id, profile_id, display_name, config, capability_manifest, is_builtin
-- The frontend needs: id (text), name, target_system, version, endpoints (jsonb), auth (jsonb)
-- We add the missing columns so both old and new code can coexist.

-- Drop the UNIQUE constraint on profile_id since new rows won't populate it
ALTER TABLE api_profiles ALTER COLUMN profile_id SET DEFAULT '';
ALTER TABLE api_profiles DROP CONSTRAINT IF EXISTS api_profiles_profile_id_key;

ALTER TABLE api_profiles ADD COLUMN IF NOT EXISTS name VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE api_profiles ADD COLUMN IF NOT EXISTS target_system VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE api_profiles ADD COLUMN IF NOT EXISTS version VARCHAR(50) NOT NULL DEFAULT '1.0';
ALTER TABLE api_profiles ADD COLUMN IF NOT EXISTS endpoints JSONB NOT NULL DEFAULT '{}';
ALTER TABLE api_profiles ADD COLUMN IF NOT EXISTS auth JSONB NOT NULL DEFAULT '{}';
