"""DataStore abstract base class.

Defines the contract for all data store implementations (PostgreSQL,
mock in-memory, etc.).  Every method is async to support non-blocking I/O.

Requirements: 6.1, 6.2
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable, TypeVar

T = TypeVar("T")


class DataStoreTransaction(ABC):
    """Handle exposed inside a transaction callback for multi-statement ops."""

    @abstractmethod
    async def query(self, sql: str, params: tuple | list | None = None) -> list[dict]:
        ...

    @abstractmethod
    async def query_one(self, sql: str, params: tuple | list | None = None) -> dict | None:
        ...

    @abstractmethod
    async def execute(self, sql: str, params: tuple | list | None = None) -> int:
        """Execute a statement and return the number of affected rows."""
        ...


class DataStore(ABC):
    """Abstract data-access interface used throughout the application."""

    @abstractmethod
    async def query(self, sql: str, params: tuple | list | None = None) -> list[dict]:
        """Run a SELECT and return all rows as dicts."""
        ...

    @abstractmethod
    async def query_one(self, sql: str, params: tuple | list | None = None) -> dict | None:
        """Run a SELECT and return the first row, or ``None``."""
        ...

    @abstractmethod
    async def execute(self, sql: str, params: tuple | list | None = None) -> int:
        """Execute a DML statement and return the number of affected rows."""
        ...

    @abstractmethod
    async def transaction(self, fn: Callable[[DataStoreTransaction], Awaitable[T]]) -> T:
        """Run *fn* inside a transaction.

        The callback receives a :class:`DataStoreTransaction` handle.
        If *fn* raises, the transaction is rolled back automatically;
        otherwise it is committed.
        """
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """Return ``True`` when the underlying store is reachable."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Release all resources (connection pool, etc.)."""
        ...
