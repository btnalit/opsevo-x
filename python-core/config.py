"""Configuration management using pydantic-settings."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Database
    DATABASE_URL: str

    # Internal API authentication
    INTERNAL_API_KEY: str

    # Embedding model configuration
    EMBEDDING_MODEL: str = "all-MiniLM-L6-v2"
    EMBEDDING_REMOTE_URL: str | None = None
    EMBEDDING_REMOTE_API_KEY: str | None = None

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8001

    # App metadata
    APP_VERSION: str = "0.1.0"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
