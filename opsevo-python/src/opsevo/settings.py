"""Unified configuration via pydantic-settings.

All application configuration is loaded from environment variables (and an
optional `.env` file).  Pydantic-settings validates every field at startup,
so missing required values surface immediately as clear ``ValidationError``
messages instead of silent runtime failures.

No ROUTEROS_* environment variables are referenced anywhere — all naming
follows the generic convention (DATABASE_URL, AI_PROVIDER, etc.).
"""

from __future__ import annotations

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Central configuration for the entire Opsevo Python backend."""

    model_config = SettingsConfigDict(
        env_prefix="",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # ── Server ────────────────────────────────────────────────────────────
    port: int = Field(
        default=3099,
        description="HTTP server port",
    )
    env: str = Field(
        default="production",
        description="Runtime environment: development | production",
    )
    log_level: str = Field(
        default="info",
        description="Log level: debug | info | warn | error",
    )

    # ── Database ──────────────────────────────────────────────────────────
    database_url: str = Field(
        default="",
        description=(
            "PostgreSQL connection string. "
            "Example: postgresql://user:pass@host:5432/dbname"
        ),
    )
    pg_user: str = Field(
        default="opsevo",
        description="PostgreSQL user (used to build DATABASE_URL if not set directly)",
    )
    pg_password: str = Field(
        default="opsevo123",
        description="PostgreSQL password",
    )
    pg_host: str = Field(
        default="localhost",
        description="PostgreSQL host",
    )
    pg_port: int = Field(
        default=5432,
        description="PostgreSQL port",
    )
    pg_database: str = Field(
        default="opsevo",
        description="PostgreSQL database name",
    )
    pg_pool_min: int = Field(
        default=2,
        ge=1,
        description="Connection pool minimum size",
    )
    pg_pool_max: int = Field(
        default=10,
        ge=1,
        description="Connection pool maximum size",
    )
    pg_idle_timeout: int = Field(
        default=30000,
        ge=0,
        description="Connection pool idle timeout in milliseconds",
    )

    # ── AI Provider ───────────────────────────────────────────────────────
    ai_provider: str = Field(
        default="gemini",
        description="Active AI provider: openai | gemini | claude | deepseek | qwen | zhipu | custom",
    )
    ai_model_name: str = Field(
        default="gemini-1.5-flash",
        description="Default model name for the active AI provider",
    )
    openai_api_key: str = Field(
        default="",
        description="OpenAI API key",
    )
    openai_base_url: str = Field(
        default="https://api.openai.com/v1",
        description="OpenAI-compatible base URL (useful for proxies)",
    )
    gemini_api_key: str = Field(
        default="",
        description="Google Gemini API key",
    )
    claude_api_key: str = Field(
        default="",
        description="Anthropic Claude API key",
    )
    deepseek_api_key: str = Field(
        default="",
        description="DeepSeek API key",
    )
    qwen_api_key: str = Field(
        default="",
        description="Alibaba Qwen API key",
    )
    zhipu_api_key: str = Field(
        default="",
        description="Zhipu (GLM) API key",
    )

    # ── Embedding ─────────────────────────────────────────────────────────
    embedding_model: str = Field(
        default="all-MiniLM-L6-v2",
        description="Local sentence-transformers model name",
    )
    embedding_provider: str = Field(
        default="",
        description="Embedding provider override (defaults to ai_provider if empty)",
    )
    embedding_model_name: str = Field(
        default="",
        description="Embedding model name override for remote providers",
    )
    embedding_remote_url: str = Field(
        default="",
        description="Remote embedding API URL (empty = use local model)",
    )
    embedding_remote_api_key: str = Field(
        default="",
        description="Remote embedding API key",
    )

    # ── Reranker (optional) ───────────────────────────────────────────────
    rerank_api_key: str = Field(
        default="",
        description="Reranker API key",
    )
    rerank_base_url: str = Field(
        default="https://api.example.com/v1",
        description="Reranker API base URL",
    )
    rerank_model_name: str = Field(
        default="bge-reranker-v2-m3",
        description="Reranker model name",
    )
    rerank_top_k: int = Field(
        default=5,
        ge=1,
        description="Reranker top-K results",
    )
    rerank_threshold: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description="Reranker relevance threshold",
    )
    rerank_timeout: int = Field(
        default=30000,
        ge=0,
        description="Reranker request timeout in milliseconds",
    )

    # ── Security ──────────────────────────────────────────────────────────
    jwt_secret: str = Field(
        default="",
        description="JWT signing secret (required in production)",
    )
    jwt_access_token_expiry: int = Field(
        default=900,
        ge=1,
        description="JWT access token expiry in seconds (default 15 min)",
    )
    jwt_refresh_token_expiry: int = Field(
        default=604800,
        ge=1,
        description="JWT refresh token expiry in seconds (default 7 days)",
    )
    internal_api_key: str = Field(
        default="changeme-internal-key",
        description="Internal API authentication key",
    )
    encryption_key: str = Field(
        default="",
        description="Device credential encryption key",
    )
    ai_crypto_secret_key: str = Field(
        default="ai-ops-agent-secret-key-2024",
        description="AES secret key for AI API config encryption",
    )

    # ── Protocol Ports ────────────────────────────────────────────────────
    syslog_port: int = Field(
        default=514,
        ge=1,
        le=65535,
        description="Syslog UDP receiver port",
    )
    snmp_trap_port: int = Field(
        default=162,
        ge=1,
        le=65535,
        description="SNMP Trap UDP receiver port",
    )

    # ── Brain (Autonomous OODA) ───────────────────────────────────────────
    brain_enabled: bool = Field(
        default=False,
        description="Enable the autonomous brain OODA loop",
    )
    brain_tick_interval: int = Field(
        default=30,
        ge=1,
        description="Brain tick interval in minutes",
    )
    brain_session_max_ticks: int = Field(
        default=20,
        ge=1,
        description="Max ticks per brain session before rotation",
    )
    brain_token_budget: int = Field(
        default=500000,
        ge=0,
        description="Daily token budget for the brain service",
    )
    brain_auto_approve_high_risk: bool = Field(
        default=False,
        description="Allow brain to auto-execute high-risk actions without approval",
    )

    # ── Evolution Config ──────────────────────────────────────────────────
    evolution_config_path: str = Field(
        default="data/ai-ops/evolution-config.json",
        description="Path to the AI evolution configuration file",
    )

    # ── MCP Integration ───────────────────────────────────────────────────
    mcp_server_enabled: bool = Field(
        default=True,
        description="Enable the MCP protocol server endpoint",
    )
    mcp_server_port: int = Field(
        default=0,
        ge=0,
        le=65535,
        description="Dedicated MCP server port (0 = share main HTTP port)",
    )

    # ── Skill System ──────────────────────────────────────────────────────
    skill_system_enabled: bool = Field(
        default=True,
        description="Enable the pluggable skill system",
    )
    skills_dir: str = Field(
        default="data/ai-ops/skills",
        description="Directory containing skill definitions",
    )

    # ── Device Defaults ───────────────────────────────────────────────────
    device_host: str = Field(
        default="",
        description="Default device host (for legacy single-device setups)",
    )
    device_user: str = Field(
        default="",
        description="Default device username",
    )
    device_password: str = Field(
        default="",
        description="Default device password",
    )
    device_port: int = Field(
        default=8728,
        ge=1,
        le=65535,
        description="Default device connection port",
    )
    device_use_tls: bool = Field(
        default=False,
        description="Use TLS for default device connection",
    )
    device_encryption_key: str = Field(
        default="device-pool-encryption-key-2024",
        description="Encryption key for device credential storage",
    )

    # ── DeviceOrchestrator ────────────────────────────────────────────────
    orchestrator_health_check_interval_s: int = Field(
        default=60, ge=10, description="健康检查间隔（秒）",
    )
    orchestrator_metrics_interval_s: int = Field(
        default=120, ge=30, description="指标采集间隔（秒）",
    )
    orchestrator_max_concurrent_checks: int = Field(
        default=10, ge=1, description="最大并发检查数",
    )
    orchestrator_max_concurrent_connections: int = Field(
        default=5, ge=1, description="启动时最大并发连接数",
    )
    orchestrator_max_backoff_s: int = Field(
        default=300, ge=60, description="离线设备最大退避间隔（秒）",
    )
    orchestrator_auto_connect: bool = Field(
        default=True, description="启动时是否自动连接设备",
    )
    orchestrator_operation_timeout_s: int = Field(
        default=15, ge=5, description="单设备操作超时（秒）",
    )

    # ── Profiles ──────────────────────────────────────────────────────────
    profiles_dir: str = Field(
        default="profiles",
        description="Directory containing device driver profile YAML/JSON files",
    )

    # ── Misc / Python Executable ──────────────────────────────────────────
    python_executable: str = Field(
        default="python3",
        description="Python executable path for capsule execution",
    )

    # ── Validators ────────────────────────────────────────────────────────

    @field_validator("database_url", mode="before")
    @classmethod
    def _assemble_database_url(cls, v: str, info) -> str:  # noqa: N805
        """Build DATABASE_URL from PG_* parts when not provided directly."""
        if v:
            return v
        # Will be assembled in model_post_init from PG_* fields
        return v

    def model_post_init(self, __context) -> None:  # type: ignore[override]
        """Assemble database_url from PG_* components if not set explicitly."""
        if not self.database_url:
            object.__setattr__(
                self,
                "database_url",
                (
                    f"postgresql://{self.pg_user}:{self.pg_password}"
                    f"@{self.pg_host}:{self.pg_port}/{self.pg_database}"
                ),
            )

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, v: str) -> str:
        allowed = {"debug", "info", "warn", "warning", "error", "critical"}
        if v.lower() not in allowed:
            raise ValueError(
                f"log_level must be one of {sorted(allowed)}, got '{v}'"
            )
        return v.lower()

    @field_validator("ai_provider")
    @classmethod
    def _validate_ai_provider(cls, v: str) -> str:
        allowed = {"openai", "gemini", "claude", "deepseek", "qwen", "zhipu", "custom"}
        if v.lower() not in allowed:
            raise ValueError(
                f"ai_provider must be one of {sorted(allowed)}, got '{v}'"
            )
        return v.lower()

    @field_validator("env")
    @classmethod
    def _validate_env(cls, v: str) -> str:
        allowed = {"development", "production", "test"}
        if v.lower() not in allowed:
            raise ValueError(
                f"env must be one of {sorted(allowed)}, got '{v}'"
            )
        return v.lower()

    @field_validator("jwt_secret")
    @classmethod
    def _warn_empty_jwt_secret(cls, v: str) -> str:
        # Allow empty for development; production checks happen at startup
        return v

    @field_validator("pg_pool_max")
    @classmethod
    def _pool_max_gte_min(cls, v: int, info) -> int:
        pool_min = info.data.get("pg_pool_min", 2)
        if v < pool_min:
            raise ValueError(
                f"pg_pool_max ({v}) must be >= pg_pool_min ({pool_min})"
            )
        return v

    # ── Convenience helpers ───────────────────────────────────────────────

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def is_development(self) -> bool:
        return self.env == "development"

    def validate_production_requirements(self) -> list[str]:
        """Return a list of configuration problems for production deployments.

        Call this at startup and refuse to boot if the list is non-empty.
        """
        problems: list[str] = []
        if not self.database_url:
            problems.append("DATABASE_URL (or PG_* components) is required")
        if not self.jwt_secret:
            problems.append("JWT_SECRET is required")
        if self.jwt_secret == "changeme-jwt-secret":
            problems.append("JWT_SECRET must be changed from the default value")
        if self.internal_api_key == "changeme-internal-key":
            problems.append(
                "INTERNAL_API_KEY should be changed from the default value"
            )
        return problems
