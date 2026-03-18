/**
 * Tests for 001_initial_schema migration
 *
 * Validates:
 * - Migration file exports correct MigrationDefinition format
 * - All 12 tables are created by the up SQL
 * - FTS5 virtual table is created
 * - All indexes are created
 * - Down SQL drops all tables in correct order
 * - Migration is idempotent (up then down then up works)
 *
 * Requirements: 2.1, 2.4
 */
import Database from 'better-sqlite3';
import migration from './001_initial_schema';

describe('001_initial_schema migration', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('should export a valid MigrationDefinition', () => {
    expect(migration).toBeDefined();
    expect(migration.version).toBe(1);
    expect(typeof migration.up).toBe('string');
    expect(typeof migration.down).toBe('string');
    expect(migration.up.length).toBeGreaterThan(0);
    expect(migration.down.length).toBeGreaterThan(0);
  });

  it('should create all 12 tables with up SQL', () => {
    db.exec(migration.up);

    // Filter out FTS5 virtual table and its internal shadow tables
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'vector_documents_fts%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    const expectedTables = [
      'alert_events',
      'alert_rules',
      'audit_logs',
      'chat_sessions',
      'config_snapshots',
      'devices',
      'health_metrics',
      'notification_channels',
      'prompt_templates',
      'scheduled_tasks',
      'users',
      'vector_documents',
    ];

    for (const expected of expectedTables) {
      expect(tableNames).toContain(expected);
    }
    expect(tableNames.length).toBe(expectedTables.length);
  });

  it('should create FTS5 virtual table', () => {
    db.exec(migration.up);

    const vtables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='vector_documents_fts'",
      )
      .all() as Array<{ name: string }>;

    expect(vtables.length).toBe(1);
    expect(vtables[0].name).toBe('vector_documents_fts');
  });

  it('should create all indexes', () => {
    db.exec(migration.up);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);

    const expectedIndexes = [
      'idx_alert_events_tenant_device',
      'idx_alert_rules_tenant',
      'idx_audit_logs_tenant',
      'idx_chat_sessions_tenant_device',
      'idx_devices_tenant',
      'idx_health_metrics_device_time',
      'idx_health_metrics_tenant',
      'idx_vector_documents_tenant_collection',
    ];

    for (const expected of expectedIndexes) {
      expect(indexNames).toContain(expected);
    }
    expect(indexNames.length).toBe(expectedIndexes.length);
  });

  it('should drop all tables with down SQL', () => {
    db.exec(migration.up);
    // Need to disable foreign keys for clean drop
    db.pragma('foreign_keys = OFF');
    db.exec(migration.down);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;

    expect(tables.length).toBe(0);
  });

  it('should support up → down → up cycle (idempotent)', () => {
    // First up
    db.exec(migration.up);

    // Down
    db.pragma('foreign_keys = OFF');
    db.exec(migration.down);
    db.pragma('foreign_keys = ON');

    // Second up
    db.exec(migration.up);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'vector_documents_fts%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    // Should have all 12 tables again (excluding FTS5 virtual table and shadow tables)
    expect(tables.length).toBe(12);
  });

  it('should enforce foreign key constraints on devices table', () => {
    db.exec(migration.up);

    // Inserting a device with a non-existent tenant_id should fail
    expect(() => {
      db.prepare(
        `INSERT INTO devices (id, tenant_id, name, host, username, password_encrypted)
         VALUES ('d1', 'nonexistent', 'test', '192.168.1.1', 'admin', 'enc_pass')`,
      ).run();
    }).toThrow();
  });

  it('should allow inserting valid data into all tables', () => {
    db.exec(migration.up);

    // Insert a user first
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash)
       VALUES ('u1', 'testuser', 'test@example.com', 'hash123')`,
    ).run();

    // Insert a device
    db.prepare(
      `INSERT INTO devices (id, tenant_id, name, host, username, password_encrypted)
       VALUES ('d1', 'u1', 'Router1', '192.168.1.1', 'admin', 'enc_pass')`,
    ).run();

    // Insert alert rule
    db.prepare(
      `INSERT INTO alert_rules (id, tenant_id, device_id, name, metric, operator, threshold, severity)
       VALUES ('ar1', 'u1', 'd1', 'CPU High', 'cpu', '>', 90.0, 'warning')`,
    ).run();

    // Insert alert event
    db.prepare(
      `INSERT INTO alert_events (id, tenant_id, device_id, rule_id, severity, message)
       VALUES ('ae1', 'u1', 'd1', 'ar1', 'warning', 'CPU usage high')`,
    ).run();

    // Insert audit log
    db.prepare(
      `INSERT INTO audit_logs (id, tenant_id, device_id, action)
       VALUES ('al1', 'u1', 'd1', 'device.connect')`,
    ).run();

    // Insert config snapshot
    db.prepare(
      `INSERT INTO config_snapshots (id, tenant_id, device_id, snapshot_data)
       VALUES ('cs1', 'u1', 'd1', '{"interfaces": []}')`,
    ).run();

    // Insert chat session
    db.prepare(
      `INSERT INTO chat_sessions (id, tenant_id, device_id)
       VALUES ('ch1', 'u1', 'd1')`,
    ).run();

    // Insert scheduled task
    db.prepare(
      `INSERT INTO scheduled_tasks (id, tenant_id, device_id, name, type)
       VALUES ('st1', 'u1', 'd1', 'Backup', 'config_backup')`,
    ).run();

    // Insert vector document
    db.prepare(
      `INSERT INTO vector_documents (id, tenant_id, collection, content)
       VALUES ('vd1', 'u1', 'knowledge', 'RouterOS firewall guide')`,
    ).run();

    // Insert prompt template
    db.prepare(
      `INSERT INTO prompt_templates (id, tenant_id, name, content)
       VALUES ('pt1', 'u1', 'Diagnose', 'Diagnose the following issue...')`,
    ).run();

    // Insert notification channel
    db.prepare(
      `INSERT INTO notification_channels (id, tenant_id, name, type, config)
       VALUES ('nc1', 'u1', 'Email', 'email', '{"to": "admin@example.com"}')`,
    ).run();

    // Insert health metric
    db.prepare(
      `INSERT INTO health_metrics (tenant_id, device_id, metric_name, metric_value)
       VALUES ('u1', 'd1', 'cpu_usage', 45.5)`,
    ).run();

    // Verify counts
    const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
    expect(userCount.cnt).toBe(1);

    const deviceCount = db.prepare('SELECT COUNT(*) as cnt FROM devices').get() as { cnt: number };
    expect(deviceCount.cnt).toBe(1);

    const metricCount = db.prepare('SELECT COUNT(*) as cnt FROM health_metrics').get() as { cnt: number };
    expect(metricCount.cnt).toBe(1);
  });
});
