"""PostgreSQL DataStore implementation using psycopg3 async connection pool.

Requirements: 6.1, 6.2, 6.3, 6.4
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, TypeVar

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from opsevo.data.datastore import DataStore, DataStoreTransaction
from opsevo.settings import Settings
from opsevo.utils.logger import get_logger

T = TypeVar("T")
logger = get_logger(__name__)


class _PgTransaction(DataStoreTransaction):
    """Transaction handle backed by a live psycopg ``AsyncConnection``."""

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    async def query(self, sql: str, params: tuple | list | None = None) -> list[dict]:
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()  # type: ignore[return-value]

    async def query_one(self, sql: str, params: tuple | list | None = None) -> dict | None:
        async with self._conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
            return row  # type: ignore[return-value]

    async def execute(self, sql: str, params: tuple | list | None = None) -> int:
        async with self._conn.cursor() as cur:
            await cur.execute(sql, params)
            return cur.rowcount if cur.rowcount >= 0 else 0


class PgDataStore(DataStore):
    """Async PostgreSQL data store backed by :class:`AsyncConnectionPool`.

    Connection pool parameters are read from :class:`Settings`:

    * ``pg_pool_min`` → ``min_size``
    * ``pg_pool_max`` → ``max_size``
    * ``pg_idle_timeout`` (ms) → ``max_idle`` (seconds)
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._pool: AsyncConnectionPool | None = None

    async def initialize(self) -> None:
        """Open the connection pool.  Must be called once at startup."""
        idle_seconds = self._settings.pg_idle_timeout / 1000.0
        self._pool = AsyncConnectionPool(
            conninfo=self._settings.database_url,
            min_size=self._settings.pg_pool_min,
            max_size=self._settings.pg_pool_max,
            max_idle=idle_seconds,
            open=False,
        )
        await self._pool.open()
        logger.info(
            "pg_pool_opened",
            min_size=self._settings.pg_pool_min,
            max_size=self._settings.pg_pool_max,
            max_idle=idle_seconds,
        )

    def _ensure_pool(self) -> AsyncConnectionPool:
        if self._pool is None:
            raise RuntimeError(
                "PgDataStore not initialised — call initialize() first"
            )
        return self._pool

    # ── DataStore interface ───────────────────────────────────────────────

    async def query(self, sql: str, params: tuple | list | None = None) -> list[dict]:
        pool = self._ensure_pool()
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql, params)
                return await cur.fetchall()  # type: ignore[return-value]

    async def query_one(self, sql: str, params: tuple | list | None = None) -> dict | None:
        pool = self._ensure_pool()
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(sql, params)
                row = await cur.fetchone()
                return row  # type: ignore[return-value]

    async def execute(self, sql: str, params: tuple | list | None = None) -> int:
        pool = self._ensure_pool()
        async with pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(sql, params)
                return cur.rowcount if cur.rowcount >= 0 else 0

    async def transaction(self, fn: Callable[[DataStoreTransaction], Awaitable[T]]) -> T:
        """Run *fn* inside a BEGIN / COMMIT block.

        If *fn* raises, the transaction is automatically rolled back by
        psycopg's ``conn.transaction()`` context manager.
        """
        pool = self._ensure_pool()
        async with pool.connection() as conn:
            async with conn.transaction():
                tx = _PgTransaction(conn)
                return await fn(tx)

    async def health_check(self) -> bool:
        try:
            rows = await self.query("SELECT 1 AS ok")
            return bool(rows and rows[0].get("ok") == 1)
        except Exception:
            logger.warning("pg_health_check_failed", exc_info=True)
            return False

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
            logger.info("pg_pool_closed")
