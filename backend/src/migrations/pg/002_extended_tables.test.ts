/**
 * Tests for PostgreSQL Migration 002: 23 张扩展表
 *
 * Validates:
 * - 002_extended_tables exports valid PgMigrationDefinition with version 2
 * - up SQL contains all 23 tables with correct columns
 * - up SQL contains pgvector extension and ivfflat indexes
 * - up SQL contains GIN indexes on JSONB columns
 * - down SQL drops all 23 tables in correct dependency order
 * - Foreign key constraints are correct (ON DELETE RESTRICT for KG edges)
 *
 * Requirements: C3.13
 */

import migration002 from './002_extended_tables';

// ─── Migration Definition Tests ──────────────────────────────────────────────

describe('002_extended_tables migration definition', () => {
  it('should export a valid PgMigrationDefinition with version 2', () => {
    expect(migration002).toBeDefined();
    expect(migration002.version).toBe(2);
    expect(typeof migration002.description).toBe('string');
    expect(typeof migration002.up).toBe('string');
    expect(typeof migration002.down).toBe('string');
    expect(migration002.up.length).toBeGreaterThan(0);
    expect(migration002.down.length).toBeGreaterThan(0);
  });

  it('should contain CREATE TABLE for all 23 extended tables', () => {
    const expectedTables = [
      'brain_memory',
      'evaluation_reports',
      'prompt_knowledge',
      'tool_vectors',
      'notification_channels',
      'notifications',
      'knowledge_graph_nodes',
      'knowledge_graph_edges',
      'traces',
      'trace_spans',
      'state_machine_executions',
      'degradation_states',
      'fingerprint_cache',
      'syslog_parse_rules',
      'syslog_source_mappings',
      'snmp_trap_oid_mappings',
      'snmp_v3_credentials',
      'api_profiles',
      'decision_rules',
      'decision_history',
      'feedback_records',
      'learned_patterns',
      'learning_records',
    ];

    for (const table of expectedTables) {
      expect(migration002.up).toContain(`CREATE TABLE ${table}`);
    }
    expect(expectedTables.length).toBe(23);
  });

  it('should enable pgvector and pg_trgm extensions', () => {
    expect(migration002.up).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(migration002.up).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  });

  it('should use vector(384) columns for prompt_knowledge and tool_vectors', () => {
    // prompt_knowledge embedding column
    const pkRegex = /CREATE TABLE prompt_knowledge[\s\S]*?embedding vector\(384\)/;
    expect(migration002.up).toMatch(pkRegex);

    // tool_vectors embedding column
    const tvRegex = /CREATE TABLE tool_vectors[\s\S]*?embedding vector\(384\)/;
    expect(migration002.up).toMatch(tvRegex);
  });

  it('should create ivfflat indexes on vector columns', () => {
    expect(migration002.up).toContain(
      'idx_prompt_knowledge_embedding ON prompt_knowledge USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)',
    );
    expect(migration002.up).toContain(
      'idx_tool_vectors_embedding ON tool_vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)',
    );
  });

  it('should use UUID primary keys with gen_random_uuid()', () => {
    const uuidTables = [
      'brain_memory', 'evaluation_reports', 'prompt_knowledge', 'tool_vectors',
      'notification_channels', 'notifications', 'knowledge_graph_nodes',
      'knowledge_graph_edges', 'traces', 'trace_spans',
      'state_machine_executions', 'degradation_states',
      'syslog_parse_rules', 'syslog_source_mappings',
      'snmp_trap_oid_mappings', 'snmp_v3_credentials', 'api_profiles',
      'decision_rules', 'decision_history', 'feedback_records',
      'learned_patterns', 'learning_records',
    ];

    for (const table of uuidTables) {
      const regex = new RegExp(
        `CREATE TABLE ${table}[\\s\\S]*?id UUID PRIMARY KEY DEFAULT gen_random_uuid\\(\\)`,
      );
      expect(migration002.up).toMatch(regex);
    }
  });

  it('should use fingerprint VARCHAR(64) as PRIMARY KEY for fingerprint_cache', () => {
    expect(migration002.up).toContain('fingerprint VARCHAR(64) PRIMARY KEY');
  });

  it('should use TIMESTAMPTZ for all timestamp columns', () => {
    expect(migration002.up).not.toContain("datetime('now')");
    const timestamptzCount = (migration002.up.match(/TIMESTAMPTZ/g) || []).length;
    expect(timestamptzCount).toBeGreaterThan(30);
  });

  it('should use JSONB for complex data columns', () => {
    expect(migration002.up).toContain('JSONB');
    const lines = migration002.up.split('\n');
    for (const line of lines) {
      if (line.includes("DEFAULT '{}'") || line.includes("DEFAULT '[]'")) {
        expect(line).toContain('JSONB');
      }
    }
  });

  it('should have ON DELETE RESTRICT for knowledge_graph_edges foreign keys', () => {
    const edgesSection = migration002.up.match(
      /CREATE TABLE knowledge_graph_edges[\s\S]*?\);/,
    );
    expect(edgesSection).not.toBeNull();
    const edgesSql = edgesSection![0];
    expect(edgesSql).toContain('REFERENCES knowledge_graph_nodes(id) ON DELETE RESTRICT');
    // Both source_id and target_id should have ON DELETE RESTRICT
    const restrictCount = (edgesSql.match(/ON DELETE RESTRICT/g) || []).length;
    expect(restrictCount).toBe(2);
  });

  it('should have ON DELETE CASCADE for trace_spans.trace_id', () => {
    const spansSection = migration002.up.match(
      /CREATE TABLE trace_spans[\s\S]*?\);/,
    );
    expect(spansSection).not.toBeNull();
    expect(spansSection![0]).toContain('REFERENCES traces(id) ON DELETE CASCADE');
  });

  it('should have expires_at column on fingerprint_cache', () => {
    const fpSection = migration002.up.match(
      /CREATE TABLE fingerprint_cache[\s\S]*?\);/,
    );
    expect(fpSection).not.toBeNull();
    expect(fpSection![0]).toContain('expires_at TIMESTAMPTZ NOT NULL');
  });

  it('should create GIN indexes on JSONB columns', () => {
    const expectedGinIndexes = [
      'idx_brain_memory_content_gin',
      'idx_brain_memory_context_gin',
      'idx_eval_reports_details_gin',
      'idx_notification_channels_config_gin',
      'idx_notification_channels_severity_gin',
      'idx_traces_tags_gin',
      'idx_traces_metadata_gin',
      'idx_trace_spans_tags_gin',
      'idx_trace_spans_logs_gin',
      'idx_sm_executions_context_gin',
      'idx_sm_executions_history_gin',
      'idx_syslog_parse_rules_fields_gin',
      'idx_api_profiles_config_gin',
      'idx_api_profiles_manifest_gin',
      'idx_decision_rules_condition_gin',
      'idx_decision_history_factors_gin',
      'idx_decision_history_scores_gin',
      'idx_feedback_context_gin',
      'idx_patterns_data_gin',
      'idx_learning_content_gin',
      'idx_tool_vectors_capabilities_gin',
      'idx_tool_vectors_metadata_gin',
      'idx_kg_edges_properties_gin',
      'idx_kg_nodes_properties',
      'idx_prompt_knowledge_metadata',
    ];

    for (const idx of expectedGinIndexes) {
      expect(migration002.up).toContain(idx);
    }
  });

  it('should create B-tree indexes on frequently queried columns', () => {
    const expectedIndexes = [
      'idx_brain_memory_tick',
      'idx_brain_memory_type',
      'idx_eval_reports_tick',
      'idx_eval_reports_score',
      'idx_notifications_channel',
      'idx_notifications_status',
      'idx_kg_nodes_type',
      'idx_kg_edges_source',
      'idx_kg_edges_target',
      'idx_traces_name',
      'idx_traces_status',
      'idx_trace_spans_trace',
      'idx_sm_executions_type',
      'idx_degradation_capability',
      'idx_fingerprint_expires',
      'idx_syslog_source_ip',
      'idx_api_profiles_profile_id',
      'idx_decision_rules_enabled',
      'idx_decision_history_event',
      'idx_decision_history_action',
      'idx_feedback_tick',
      'idx_patterns_type',
      'idx_learning_tick',
      'idx_learning_type',
      'idx_learning_intent',
    ];

    for (const idx of expectedIndexes) {
      expect(migration002.up).toContain(idx);
    }
  });

  it('should have partial index on feedback_records.processed', () => {
    expect(migration002.up).toContain('WHERE processed = false');
  });

  it('should have conditional index on knowledge_graph_nodes.expires_at', () => {
    expect(migration002.up).toContain('WHERE expires_at IS NOT NULL');
  });

  it('should drop all 23 tables in down SQL', () => {
    const expectedDrops = [
      'DROP TABLE IF EXISTS learning_records',
      'DROP TABLE IF EXISTS learned_patterns',
      'DROP TABLE IF EXISTS feedback_records',
      'DROP TABLE IF EXISTS decision_history',
      'DROP TABLE IF EXISTS decision_rules',
      'DROP TABLE IF EXISTS api_profiles',
      'DROP TABLE IF EXISTS snmp_v3_credentials',
      'DROP TABLE IF EXISTS snmp_trap_oid_mappings',
      'DROP TABLE IF EXISTS syslog_source_mappings',
      'DROP TABLE IF EXISTS syslog_parse_rules',
      'DROP TABLE IF EXISTS fingerprint_cache',
      'DROP TABLE IF EXISTS degradation_states',
      'DROP TABLE IF EXISTS state_machine_executions',
      'DROP TABLE IF EXISTS trace_spans',
      'DROP TABLE IF EXISTS traces',
      'DROP TABLE IF EXISTS knowledge_graph_edges',
      'DROP TABLE IF EXISTS knowledge_graph_nodes',
      'DROP TABLE IF EXISTS notifications',
      'DROP TABLE IF EXISTS notification_channels',
      'DROP TABLE IF EXISTS tool_vectors',
      'DROP TABLE IF EXISTS prompt_knowledge',
      'DROP TABLE IF EXISTS evaluation_reports',
      'DROP TABLE IF EXISTS brain_memory',
    ];

    for (const drop of expectedDrops) {
      expect(migration002.down).toContain(drop);
    }
    expect(expectedDrops.length).toBe(23);
  });

  it('should drop dependent tables before their parents in down SQL', () => {
    const down = migration002.down;

    // learning_records depends on evaluation_reports
    expect(down.indexOf('DROP TABLE IF EXISTS learning_records'))
      .toBeLessThan(down.indexOf('DROP TABLE IF EXISTS evaluation_reports'));

    // trace_spans depends on traces
    expect(down.indexOf('DROP TABLE IF EXISTS trace_spans'))
      .toBeLessThan(down.indexOf('DROP TABLE IF EXISTS traces'));

    // knowledge_graph_edges depends on knowledge_graph_nodes
    expect(down.indexOf('DROP TABLE IF EXISTS knowledge_graph_edges'))
      .toBeLessThan(down.indexOf('DROP TABLE IF EXISTS knowledge_graph_nodes'));

    // notifications depends on notification_channels
    expect(down.indexOf('DROP TABLE IF EXISTS notifications'))
      .toBeLessThan(down.indexOf('DROP TABLE IF EXISTS notification_channels'));
  });

  it('should have UNIQUE constraint on degradation_states.capability', () => {
    const dsSection = migration002.up.match(
      /CREATE TABLE degradation_states[\s\S]*?\);/,
    );
    expect(dsSection).not.toBeNull();
    expect(dsSection![0]).toContain('capability VARCHAR(100) NOT NULL UNIQUE');
  });

  it('should have UNIQUE constraint on tool_vectors.tool_id', () => {
    expect(migration002.up).toContain('tool_id VARCHAR(255) NOT NULL UNIQUE');
  });

  it('should have UNIQUE constraint on snmp_trap_oid_mappings.oid', () => {
    expect(migration002.up).toContain('oid VARCHAR(255) NOT NULL UNIQUE');
  });

  it('should have UNIQUE constraint on api_profiles.profile_id', () => {
    expect(migration002.up).toContain('profile_id VARCHAR(100) NOT NULL UNIQUE');
  });

  it('should reference devices(id) from syslog_source_mappings', () => {
    const ssmSection = migration002.up.match(
      /CREATE TABLE syslog_source_mappings[\s\S]*?\);/,
    );
    expect(ssmSection).not.toBeNull();
    expect(ssmSection![0]).toContain('REFERENCES devices(id)');
  });

  it('should reference evaluation_reports(id) from learning_records', () => {
    const lrSection = migration002.up.match(
      /CREATE TABLE learning_records[\s\S]*?\);/,
    );
    expect(lrSection).not.toBeNull();
    expect(lrSection![0]).toContain('REFERENCES evaluation_reports(id)');
  });
});
