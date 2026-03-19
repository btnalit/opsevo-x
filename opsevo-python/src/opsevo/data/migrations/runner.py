"""SQL migration runner.

Reads ``.sql`` files from a migrations directory (including subdirectories
like ``pg/`` and ``vector/``), tracks applied migrations in a
``schema_migrations`` table, and executes pending ones in sorted order.

Requirements: 6.5, 22.1, 22.2, 22.3, 22.4
"""

from __future__ import annotations

import os
from pathlib import Path

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class MigrationRunner:
    """Execute SQL migration files that have not yet been applied.

    Parameters
    ----------
    datastore:
        A :class:`DataStore` instance used to run SQL and track state.
    migrations_dir:
        Root directory containing ``.sql`` migration files.  Sub-directories
        (e.g. ``pg/``, ``vector/``) are scanned recursively.
    """

    TRACKING_TABLE = "schema_migrations"

    def __init__(self, datastore: DataStore, migrations_dir: str) -> None:
        self._ds = datastore
        self._dir = migrations_dir

    # ── public API ────────────────────────────────────────────────────

    async def run(self) -> list[str]:
        """Run all pending migrations and return the names that were applied."""
        await self._ensure_tracking_table()
        applied = await self._get_applied()
        pending = self._discover_pending(applied)

        if not pending:
            logger.info("migrations_up_to_date")
            return []

        applied_names: list[str] = []
        for name, path in pending:
            await self._apply(name, path)
            applied_names.append(name)

        logger.info("migrations_complete", count=len(applied_names))
        return applied_names

    # ── internals ─────────────────────────────────────────────────────

    async def _ensure_tracking_table(self) -> None:
        await self._ds.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.TRACKING_TABLE} (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )

    async def _get_applied(self) -> set[str]:
        rows = await self._ds.query(
            f"SELECT name FROM {self.TRACKING_TABLE}"
        )
        return {r["name"] for r in rows}

    def _discover_pending(
        self, applied: set[str]
    ) -> list[tuple[str, Path]]:
        """Return ``(name, path)`` pairs for unapplied migrations, sorted."""
        root = Path(self._dir)
        if not root.is_dir():
            logger.warning("migrations_dir_missing", path=self._dir)
            return []

        candidates: list[tuple[str, Path]] = []
        for dirpath, _dirs, filenames in os.walk(root):
            for fname in filenames:
                if not fname.endswith(".sql"):
                    continue
                full = Path(dirpath) / fname
                # Use relative path from root as the migration name so
                # subdirectory files (pg/001-xxx.sql) are unique.
                rel = full.relative_to(root).as_posix()
                if rel not in applied:
                    candidates.append((rel, full))

        # Sort by name — files are expected to be prefixed with a numeric
        # sequence (001-xxx.sql, 002-xxx.sql, pg/001-xxx.sql, etc.).
        candidates.sort(key=lambda pair: pair[0])
        return candidates

    async def _apply(self, name: str, path: Path) -> None:
        sql = path.read_text(encoding="utf-8")
        logger.info("migration_applying", name=name)

        async def _run_in_tx(tx):  # noqa: ANN001
            # Execute the migration SQL
            await tx.execute(sql)
            # Record it in the tracking table
            await tx.execute(
                f"INSERT INTO {self.TRACKING_TABLE} (name) VALUES ($1)",
                (name,),
            )

        await self._ds.transaction(_run_in_tx)
        logger.info("migration_applied", name=name)
