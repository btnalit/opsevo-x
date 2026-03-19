"""In-memory mock DataStore for unit tests.

Mirrors the TS ``createMockPgDataStore`` — supports INSERT, SELECT, UPDATE,
DELETE with ``$N`` / ``%s`` placeholders, ON CONFLICT (upsert), ORDER BY,
LIMIT, NOW(), and NULL assignments.  No real database required.

Requirements: 23.2
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, TypeVar

from opsevo.data.datastore import DataStore, DataStoreTransaction

T = TypeVar("T")

# ── SQL helpers ───────────────────────────────────────────────────────────

_PARAM_RE = re.compile(r"\$(\d+)")
_LIMIT_RE = re.compile(r"LIMIT\s+(\d+)", re.IGNORECASE)
_ORDER_RE = re.compile(r"\s+ORDER\s+BY\s+.+?(?=\s+LIMIT|\s*$)", re.IGNORECASE)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve(token: str, params: list[Any]) -> Any:
    token = token.strip()
    m = _PARAM_RE.fullmatch(token)
    if m:
        return params[int(m.group(1)) - 1]
    if token.upper() == "NULL":
        return None
    if token.upper() == "NOW()":
        return _now()
    # String literal
    sm = re.fullmatch(r"'(.*)'", token)
    if sm:
        return sm.group(1)
    return token


def _match_cond(cond: str, row: dict, params: list[Any]) -> bool:
    m = re.match(r"(\w+)\s*=\s*(\$\d+)", cond.strip())
    if not m:
        return True  # unsupported → pass through
    col, ref = m.group(1), m.group(2)
    idx = int(ref[1:]) - 1
    return row.get(col) == params[idx]


def _where_filter(
    where: str | None, params: list[Any]
) -> Callable[[dict], bool]:
    if not where:
        return lambda _row: True
    conds = re.split(r"\s+AND\s+", where, flags=re.IGNORECASE)
    return lambda row: all(_match_cond(c, row, params) for c in conds)


# ── Statement handlers ────────────────────────────────────────────────────


def _handle_insert(sql: str, params: list[Any], tables: dict[str, list[dict]]) -> int:
    m = re.search(
        r"INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)",
        sql,
        re.IGNORECASE,
    )
    if not m:
        return 0
    table = m.group(1)
    cols = [c.strip() for c in m.group(2).split(",")]
    vals = m.group(3).split(",")
    row: dict[str, Any] = {}
    for col, val in zip(cols, vals):
        row[col] = _resolve(val, params)
    row.setdefault("created_at", _now())
    row.setdefault("updated_at", _now())

    rows = tables.setdefault(table, [])

    if re.search(r"ON\s+CONFLICT", sql, re.IGNORECASE):
        pk = cols[0]
        for i, existing in enumerate(rows):
            if existing.get(pk) == row.get(pk):
                rows[i] = {**existing, **row, "updated_at": _now()}
                return 1

    rows.append(row)
    return 1


def _handle_insert_returning(sql: str, params: list[Any], tables: dict[str, list[dict]]) -> dict | None:
    """Handle INSERT ... RETURNING * — insert the row and return it as a dict."""
    m = re.search(
        r"INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)",
        sql,
        re.IGNORECASE,
    )
    if not m:
        return None
    table = m.group(1)
    cols = [c.strip() for c in m.group(2).split(",")]
    vals = m.group(3).split(",")
    row: dict[str, Any] = {}
    for col, val in zip(cols, vals):
        row[col] = _resolve(val, params)
    row.setdefault("id", row.get(cols[0], f"auto-{len(tables.get(table, []))+1}"))
    row.setdefault("created_at", _now())
    row.setdefault("updated_at", _now())

    rows = tables.setdefault(table, [])
    rows.append(row)
    return dict(row)


def _handle_update_returning(sql: str, params: list[Any], tables: dict[str, list[dict]]) -> list[dict]:
    """Handle UPDATE ... RETURNING * — update rows and return them."""
    m = re.match(
        r"UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+?)(?:\s+RETURNING\b.*)?$",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return []
    table, set_clause, where_clause = m.group(1), m.group(2), m.group(3)
    rows = tables.get(table, [])
    filt = _where_filter(where_clause, params)

    assignments: list[tuple[str, str]] = []
    for part in set_clause.split(","):
        am = re.match(r"\s*(\w+)\s*=\s*(.+)", part.strip())
        if am:
            assignments.append((am.group(1), am.group(2).strip()))

    result: list[dict] = []
    for row in rows:
        if filt(row):
            for col, val_token in assignments:
                row[col] = _resolve(val_token, params)
            result.append(dict(row))
    return result


def _handle_select(sql: str, params: list[Any], tables: dict[str, list[dict]]) -> list[dict]:
    cleaned = _ORDER_RE.sub("", sql)
    cleaned = _LIMIT_RE.sub("", cleaned)
    m = re.search(
        r"SELECT\s+.+?\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?",
        cleaned,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return []
    table = m.group(1)
    rows = tables.get(table, [])
    filt = _where_filter(m.group(2), params)
    result = [dict(r) for r in rows if filt(r)]

    lm = _LIMIT_RE.search(sql)
    if lm:
        result = result[: int(lm.group(1))]
    return result


def _handle_update(sql: str, params: list[Any], tables: dict[str, list[dict]]) -> int:
    m = re.match(
        r"UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return 0
    table, set_clause, where_clause = m.group(1), m.group(2), m.group(3)
    rows = tables.get(table, [])
    filt = _where_filter(where_clause, params)

    assignments: list[tuple[str, str]] = []
    for part in set_clause.split(","):
        am = re.match(r"\s*(\w+)\s*=\s*(.+)", part.strip())
        if am:
            assignments.append((am.group(1), am.group(2).strip()))

    updated = 0
    for row in rows:
        if filt(row):
            for col, val_token in assignments:
                row[col] = _resolve(val_token, params)
            updated += 1
    return updated


def _handle_delete(sql: str, params: list[Any], tables: dict[str, list[dict]]) -> int:
    m = re.match(
        r"DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return 0
    table = m.group(1)
    rows = tables.get(table, [])
    if not m.group(2):
        count = len(rows)
        tables[table] = []
        return count
    filt = _where_filter(m.group(2), params)
    remaining: list[dict] = []
    deleted = 0
    for row in rows:
        if filt(row):
            deleted += 1
        else:
            remaining.append(row)
    tables[table] = remaining
    return deleted


# ── MockPgDataStore ───────────────────────────────────────────────────────


class MockPgDataStore(DataStore):
    """Fully in-memory DataStore for tests — no database needed."""

    def __init__(self) -> None:
        self._tables: dict[str, list[dict]] = {}

    # ── DataStore interface ───────────────────────────────────────────

    async def query(self, sql: str, params: tuple | list | None = None) -> list[dict]:
        p = list(params or [])
        upper = sql.strip().upper()
        # INSERT ... RETURNING * → insert row and return it
        if upper.startswith("INSERT") and "RETURNING" in upper:
            row = _handle_insert_returning(sql, p, self._tables)
            return [row] if row else []
        # UPDATE ... RETURNING * → update and return affected rows
        if upper.startswith("UPDATE") and "RETURNING" in upper:
            rows = _handle_update_returning(sql, p, self._tables)
            return rows
        return _handle_select(sql, p, self._tables)

    async def query_one(self, sql: str, params: tuple | list | None = None) -> dict | None:
        rows = await self.query(sql, params)
        return rows[0] if rows else None

    async def execute(self, sql: str, params: tuple | list | None = None) -> int:
        p = list(params or [])
        upper = sql.strip().upper()
        if upper.startswith("INSERT"):
            return _handle_insert(sql, p, self._tables)
        if upper.startswith("UPDATE"):
            return _handle_update(sql, p, self._tables)
        if upper.startswith("DELETE"):
            return _handle_delete(sql, p, self._tables)
        if upper.startswith("CREATE"):
            return 0
        return 0

    async def transaction(self, fn: Callable[[DataStoreTransaction], Awaitable[T]]) -> T:
        import copy
        snapshot = copy.deepcopy(self._tables)
        tx = _MockTransaction(self)
        try:
            result = await fn(tx)
            return result
        except Exception:
            self._tables = snapshot
            raise

    async def health_check(self) -> bool:
        return True

    async def close(self) -> None:
        self._tables.clear()


class _MockTransaction(DataStoreTransaction):
    """Transaction proxy — delegates to the parent mock store."""

    def __init__(self, store: MockPgDataStore) -> None:
        self._store = store

    async def query(self, sql: str, params: tuple | list | None = None) -> list[dict]:
        return await self._store.query(sql, params)

    async def query_one(self, sql: str, params: tuple | list | None = None) -> dict | None:
        return await self._store.query_one(sql, params)

    async def execute(self, sql: str, params: tuple | list | None = None) -> int:
        return await self._store.execute(sql, params)
