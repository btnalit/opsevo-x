"""Property-based tests for DataStore transaction semantics.

Property 2: Transaction Atomicity — when an exception occurs inside a
transaction callback, ALL operations are rolled back with no partial commits.

Validates: Requirements 6.4
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings, strategies as st

from opsevo.data.datastore import DataStoreTransaction
from tests.helpers.mock_datastore import MockPgDataStore


# ── Strategies ────────────────────────────────────────────────────────────

safe_text = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
    min_size=1,
    max_size=20,
)


# ── Property: Transaction rollback on exception ──────────────────────────

class TestTransactionAtomicity:

    @pytest.mark.asyncio
    @given(
        name=safe_text,
        host=safe_text,
        fail_index=st.integers(min_value=0, max_value=2),
    )
    @settings(max_examples=30, deadline=None)
    async def test_rollback_on_exception_leaves_data_unchanged(
        self, name: str, host: str, fail_index: int
    ):
        """If the transaction callback raises, no inserts persist."""
        ds = MockPgDataStore()

        # Pre-seed a row so we can verify it survives
        await ds.execute(
            "INSERT INTO devices (id, name, host) VALUES ($1, $2, $3)",
            ["existing-1", "pre-existing", "10.0.0.1"],
        )
        rows_before = await ds.query("SELECT * FROM devices")
        count_before = len(rows_before)

        class _Boom(Exception):
            pass

        async def _failing_tx(tx: DataStoreTransaction):
            # Insert some rows inside the transaction
            for i in range(3):
                await tx.execute(
                    "INSERT INTO devices (id, name, host) VALUES ($1, $2, $3)",
                    [f"tx-{i}", name, host],
                )
                if i == fail_index:
                    raise _Boom("intentional failure")

        with pytest.raises(_Boom):
            await ds.transaction(_failing_tx)

        # After rollback, count must equal count_before
        rows_after = await ds.query("SELECT * FROM devices")
        assert len(rows_after) == count_before
        # The pre-existing row must still be there
        assert any(r["id"] == "existing-1" for r in rows_after)

    @pytest.mark.asyncio
    @given(name=safe_text, host=safe_text)
    @settings(max_examples=20, deadline=None)
    async def test_commit_on_success_persists_data(self, name: str, host: str):
        """If the transaction callback succeeds, inserts are visible."""
        ds = MockPgDataStore()

        async def _ok_tx(tx: DataStoreTransaction):
            await tx.execute(
                "INSERT INTO devices (id, name, host) VALUES ($1, $2, $3)",
                ["new-1", name, host],
            )

        await ds.transaction(_ok_tx)

        rows = await ds.query("SELECT * FROM devices")
        assert len(rows) == 1
        assert rows[0]["name"] == name
        assert rows[0]["host"] == host

    @pytest.mark.asyncio
    async def test_rollback_does_not_affect_other_tables(self):
        """Rollback in one table must not corrupt another table's data."""
        ds = MockPgDataStore()

        # Seed data in users table
        await ds.execute(
            "INSERT INTO users (id, username) VALUES ($1, $2)",
            ["u1", "alice"],
        )

        async def _failing_tx(tx: DataStoreTransaction):
            await tx.execute(
                "INSERT INTO devices (id, name) VALUES ($1, $2)",
                ["d1", "router"],
            )
            raise ValueError("boom")

        with pytest.raises(ValueError):
            await ds.transaction(_failing_tx)

        # users table untouched
        users = await ds.query("SELECT * FROM users")
        assert len(users) == 1
        assert users[0]["username"] == "alice"

        # devices table empty (rolled back)
        devices = await ds.query("SELECT * FROM devices")
        assert len(devices) == 0

    @pytest.mark.asyncio
    async def test_nested_operations_all_rollback(self):
        """Multiple inserts + updates inside a failing tx all roll back."""
        ds = MockPgDataStore()

        await ds.execute(
            "INSERT INTO devices (id, name, status) VALUES ($1, $2, $3)",
            ["d1", "router-1", "offline"],
        )

        async def _complex_failing_tx(tx: DataStoreTransaction):
            # Insert a new device
            await tx.execute(
                "INSERT INTO devices (id, name, status) VALUES ($1, $2, $3)",
                ["d2", "router-2", "online"],
            )
            # Update existing device
            await tx.execute(
                "UPDATE devices SET status = $1 WHERE id = $2",
                ["online", "d1"],
            )
            raise RuntimeError("abort")

        with pytest.raises(RuntimeError):
            await ds.transaction(_complex_failing_tx)

        rows = await ds.query("SELECT * FROM devices")
        assert len(rows) == 1
        assert rows[0]["id"] == "d1"
        assert rows[0]["status"] == "offline"  # update was rolled back
