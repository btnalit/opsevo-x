/**
 * Mock PgDataStore for unit tests.
 *
 * Implements the DataStore interface (from services/dataStore.ts) using
 * in-memory Maps, so tests don't need PostgreSQL or better-sqlite3.
 *
 * Supports: INSERT, SELECT, UPDATE, DELETE with $N placeholders,
 * ON CONFLICT (upsert), ORDER BY, LIMIT, NOW(), NULL assignments.
 */

import type { DataStore, DataStoreTransaction } from '../../services/dataStore';

interface TableRow {
  [key: string]: unknown;
}

export function createMockPgDataStore(): DataStore & { _tables: Map<string, TableRow[]> } {
  const tables = new Map<string, TableRow[]>();

  function now(): string {
    return new Date().toISOString();
  }

  /** Resolve a value token — either $N param ref or literal like NULL / NOW() */
  function resolveValue(token: string, params: unknown[]): unknown {
    token = token.trim();
    if (/^\$\d+$/.test(token)) {
      return params[parseInt(token.slice(1), 10) - 1];
    }
    if (/^NULL$/i.test(token)) return null;
    if (/^NOW\(\)$/i.test(token)) return now();
    // Strip quotes for string literals
    const strMatch = token.match(/^'(.*)'$/);
    if (strMatch) return strMatch[1];
    return token;
  }

  /** Match a WHERE condition against a row */
  function matchCondition(cond: string, row: TableRow, params: unknown[]): boolean {
    const cm = cond.trim().match(/(\w+)\s*=\s*(\$\d+)/);
    if (!cm) return true; // unsupported condition — pass through
    return row[cm[1]] === params[parseInt(cm[2].slice(1), 10) - 1];
  }

  function getWhereFilter(wherePart: string | undefined, params: unknown[]): (row: TableRow) => boolean {
    if (!wherePart) return () => true;
    const conditions = wherePart.split(/\s+AND\s+/i);
    return (row) => conditions.every(c => matchCondition(c, row, params));
  }

  // ─── INSERT ────────────────────────────────────────────────────────────────

  function handleInsert(sql: string, params: unknown[]): number {
    const m = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (!m) return 0;
    const table = m[1];
    const cols = m[2].split(',').map(c => c.trim());
    const valTokens = m[3].split(',');
    const row: TableRow = {};
    cols.forEach((col, i) => {
      row[col] = resolveValue(valTokens[i], params);
    });
    // Auto-add timestamps
    if (!row.created_at) row.created_at = now();
    if (!row.updated_at) row.updated_at = now();

    // ON CONFLICT (upsert)
    if (/ON\s+CONFLICT/i.test(sql)) {
      const existing = tables.get(table) || [];
      const pkCol = cols[0];
      const idx = existing.findIndex(r => r[pkCol] === row[pkCol]);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...row, updated_at: now() };
        return 1;
      }
    }

    if (!tables.has(table)) tables.set(table, []);
    tables.get(table)!.push(row);
    return 1;
  }

  // ─── SELECT ────────────────────────────────────────────────────────────────

  function handleSelect(sql: string, params: unknown[]): TableRow[] {
    // Strip ORDER BY, LIMIT for parsing
    const cleaned = sql.replace(/\s+ORDER\s+BY\s+.+?(?=\s+LIMIT|\s*$)/i, '')
                       .replace(/\s+LIMIT\s+\d+/i, '');
    const m = cleaned.match(/SELECT\s+.+?\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (!m) return [];
    const table = m[1];
    const rows = tables.get(table) || [];
    const filter = getWhereFilter(m[2], params);
    let result = rows.filter(filter);

    // Handle LIMIT
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      result = result.slice(0, parseInt(limitMatch[1], 10));
    }
    return result.map(r => ({ ...r })); // return copies
  }

  // ─── UPDATE ────────────────────────────────────────────────────────────────

  function handleUpdate(sql: string, params: unknown[]): number {
    const m = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/i);
    if (!m) return 0;
    const table = m[1];
    const setClause = m[2];
    const whereClause = m[3];
    const rows = tables.get(table) || [];
    const filter = getWhereFilter(whereClause, params);

    // Parse SET assignments: col = $N, col = NULL, col = NOW()
    const assignments = setClause.split(',').map(a => {
      const am = a.trim().match(/(\w+)\s*=\s*(.+)/);
      if (!am) return null;
      return { col: am[1], valToken: am[2].trim() };
    }).filter(Boolean) as { col: string; valToken: string }[];

    let updated = 0;
    for (const row of rows) {
      if (filter(row)) {
        for (const { col, valToken } of assignments) {
          row[col] = resolveValue(valToken, params);
        }
        updated++;
      }
    }
    return updated;
  }

  // ─── DELETE ────────────────────────────────────────────────────────────────

  function handleDelete(sql: string, params: unknown[]): number {
    const m = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (!m) return 0;
    const table = m[1];
    const rows = tables.get(table) || [];
    if (!m[2]) {
      const count = rows.length;
      tables.set(table, []);
      return count;
    }
    const filter = getWhereFilter(m[2], params);
    const remaining: TableRow[] = [];
    let deleted = 0;
    for (const row of rows) {
      if (filter(row)) deleted++;
      else remaining.push(row);
    }
    tables.set(table, remaining);
    return deleted;
  }

  // ─── DataStore interface ───────────────────────────────────────────────────

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return handleSelect(sql, params) as T[];
  }

  async function execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('INSERT')) return { rowCount: handleInsert(sql, params) };
    if (upper.startsWith('UPDATE')) return { rowCount: handleUpdate(sql, params) };
    if (upper.startsWith('DELETE')) return { rowCount: handleDelete(sql, params) };
    if (upper.startsWith('CREATE')) return { rowCount: 0 };
    return { rowCount: 0 };
  }

  async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await query<T>(sql, params);
    return rows[0] ?? null;
  }

  const txProxy: DataStoreTransaction = { query, queryOne, execute };

  const store: DataStore & { _tables: Map<string, TableRow[]> } = {
    _tables: tables,
    query,
    queryOne,
    execute,
    transaction: async <T>(fn: (tx: DataStoreTransaction) => Promise<T>): Promise<T> => fn(txProxy),
    getPool: () => { throw new Error('Mock DataStore has no pool'); },
    healthCheck: async () => true,
    close: async () => { tables.clear(); },
  };

  return store;
}
