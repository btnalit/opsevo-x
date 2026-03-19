"""Property-based tests for Settings configuration validation.

Property 1: 配置完整性 — 无效值必须被拒绝，有效值必须被接受。
Validates: Requirements 18.4

Tests cover:
- log_level validator rejects invalid values, accepts valid ones
- ai_provider validator rejects invalid values, accepts valid ones
- env validator rejects invalid values, accepts valid ones
- pg_pool_max >= pg_pool_min constraint
- validate_production_requirements() catches missing secrets
"""

from __future__ import annotations

import string

import pytest
from hypothesis import given, settings as h_settings, assume
from hypothesis import strategies as st
from pydantic import ValidationError

from opsevo.settings import Settings


# ── Strategies ────────────────────────────────────────────────────────────

VALID_LOG_LEVELS = ["debug", "info", "warn", "warning", "error", "critical"]
VALID_AI_PROVIDERS = ["openai", "gemini", "claude", "deepseek", "qwen", "zhipu", "custom"]
VALID_ENVS = ["development", "production", "test"]

# Generate arbitrary strings that are NOT in the valid set
_printable_no_whitespace = st.text(
    alphabet=string.ascii_letters + string.digits + "-_",
    min_size=1,
    max_size=30,
)


def _invalid_for(valid_set: list[str]) -> st.SearchStrategy[str]:
    """Strategy that generates strings NOT in *valid_set* (case-insensitive)."""
    lower_set = {v.lower() for v in valid_set}
    return _printable_no_whitespace.filter(lambda s: s.lower() not in lower_set)


# ── Property: log_level validation ────────────────────────────────────────

class TestLogLevelValidation:

    @given(level=st.sampled_from(VALID_LOG_LEVELS))
    @h_settings(max_examples=len(VALID_LOG_LEVELS))
    def test_valid_log_levels_accepted(self, level: str):
        """Every valid log level is accepted and normalized to lowercase."""
        s = Settings(env="test", log_level=level)
        assert s.log_level == level.lower()

    @given(level=st.sampled_from([v.upper() for v in VALID_LOG_LEVELS]))
    @h_settings(max_examples=len(VALID_LOG_LEVELS))
    def test_valid_log_levels_case_insensitive(self, level: str):
        """Log levels are case-insensitive."""
        s = Settings(env="test", log_level=level)
        assert s.log_level == level.lower()

    @given(level=_invalid_for(VALID_LOG_LEVELS))
    @h_settings(max_examples=20)
    def test_invalid_log_levels_rejected(self, level: str):
        """Invalid log levels raise ValidationError."""
        with pytest.raises(ValidationError, match="log_level"):
            Settings(env="test", log_level=level)


# ── Property: ai_provider validation ──────────────────────────────────────

class TestAiProviderValidation:

    @given(provider=st.sampled_from(VALID_AI_PROVIDERS))
    @h_settings(max_examples=len(VALID_AI_PROVIDERS))
    def test_valid_providers_accepted(self, provider: str):
        """Every valid AI provider is accepted and normalized."""
        s = Settings(env="test", ai_provider=provider)
        assert s.ai_provider == provider.lower()

    @given(provider=_invalid_for(VALID_AI_PROVIDERS))
    @h_settings(max_examples=20)
    def test_invalid_providers_rejected(self, provider: str):
        """Invalid AI providers raise ValidationError."""
        with pytest.raises(ValidationError, match="ai_provider"):
            Settings(env="test", ai_provider=provider)


# ── Property: env validation ──────────────────────────────────────────────

class TestEnvValidation:

    @given(env=st.sampled_from(VALID_ENVS))
    @h_settings(max_examples=len(VALID_ENVS))
    def test_valid_envs_accepted(self, env: str):
        """Every valid env is accepted and normalized."""
        s = Settings(env=env)
        assert s.env == env.lower()

    @given(env=_invalid_for(VALID_ENVS))
    @h_settings(max_examples=20)
    def test_invalid_envs_rejected(self, env: str):
        """Invalid env values raise ValidationError."""
        with pytest.raises(ValidationError, match="env"):
            Settings(env=env)


# ── Property: pg_pool_max >= pg_pool_min ──────────────────────────────────

class TestPoolConstraint:

    @given(
        pool_min=st.integers(min_value=1, max_value=50),
        pool_max=st.integers(min_value=1, max_value=50),
    )
    @h_settings(max_examples=50)
    def test_pool_max_gte_min_enforced(self, pool_min: int, pool_max: int):
        """pg_pool_max < pg_pool_min must raise ValidationError."""
        if pool_max < pool_min:
            with pytest.raises(ValidationError, match="pg_pool_max"):
                Settings(env="test", pg_pool_min=pool_min, pg_pool_max=pool_max)
        else:
            s = Settings(env="test", pg_pool_min=pool_min, pg_pool_max=pool_max)
            assert s.pg_pool_max >= s.pg_pool_min


# ── Property: production requirements ─────────────────────────────────────

class TestProductionRequirements:

    def test_empty_jwt_secret_flagged(self):
        """Production with empty JWT_SECRET is flagged."""
        s = Settings(env="production", jwt_secret="")
        problems = s.validate_production_requirements()
        assert any("JWT_SECRET" in p for p in problems)

    def test_default_jwt_secret_flagged(self):
        """Production with default JWT_SECRET is flagged."""
        s = Settings(env="production", jwt_secret="changeme-jwt-secret")
        problems = s.validate_production_requirements()
        assert any("JWT_SECRET" in p for p in problems)

    def test_default_internal_key_flagged(self):
        """Production with default INTERNAL_API_KEY is flagged."""
        s = Settings(env="production")
        problems = s.validate_production_requirements()
        assert any("INTERNAL_API_KEY" in p for p in problems)

    def test_proper_production_config_no_problems(self):
        """Properly configured production has no problems."""
        s = Settings(
            env="production",
            jwt_secret="a-real-secret-key-that-is-not-default",
            internal_api_key="a-real-internal-key",
            database_url="postgresql://user:pass@host:5432/db",
        )
        problems = s.validate_production_requirements()
        assert len(problems) == 0


# ── Property: database_url assembly ───────────────────────────────────────

class TestDatabaseUrlAssembly:

    def test_explicit_database_url_preserved(self):
        """Explicit DATABASE_URL takes precedence over PG_* components."""
        url = "postgresql://custom:pass@myhost:5433/mydb"
        s = Settings(env="test", database_url=url)
        assert s.database_url == url

    def test_pg_components_assembled(self):
        """When DATABASE_URL is empty, it's assembled from PG_* fields."""
        s = Settings(
            env="test",
            database_url="",
            pg_user="testuser",
            pg_password="testpass",
            pg_host="testhost",
            pg_port=5433,
            pg_database="testdb",
        )
        assert s.database_url == "postgresql://testuser:testpass@testhost:5433/testdb"
