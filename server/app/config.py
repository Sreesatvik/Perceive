from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    llm_provider: str = Field(pattern=r"^(groq|offline)$")
    model_name: str
    groq_api_key: str | None = None
    offline_api_base: str | None = None
    backend_host: str = "127.0.0.1"
    backend_port: int = Field(default=8000, ge=1024, le=65535)
    allowed_origins: str = ""
    backend_api_key: str | None = None

    def validate_runtime(self) -> None:
        if self.llm_provider == "groq" and not self.groq_api_key:
            raise ValueError("GROQ_API_KEY is required when LLM_PROVIDER=groq")
        if self.llm_provider == "offline" and not self.offline_api_base:
            raise ValueError("OFFLINE_API_BASE is required when LLM_PROVIDER=offline")
        if not self.backend_api_key:
            raise ValueError("BACKEND_API_KEY is required")
        if not self.allowed_origins:
            raise ValueError("ALLOWED_ORIGINS is required")

settings = Settings()
settings.validate_runtime()
