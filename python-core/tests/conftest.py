"""Pytest configuration for python-core tests."""

import os
import sys
from pathlib import Path

# Ensure python-core root is on sys.path so imports like
# `from services.embedding_service import ...` work in tests.
_root = str(Path(__file__).resolve().parent.parent)
if _root not in sys.path:
    sys.path.insert(0, _root)

# Provide required env vars so Settings() can be instantiated in tests
# without a real .env file.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("INTERNAL_API_KEY", "test-key")
