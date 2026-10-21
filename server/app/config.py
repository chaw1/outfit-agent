from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")
    database_url: str = "postgresql+psycopg://outfit:outfit@localhost:18432/outfit"
    media_dir: Path = Path("data/media")
    public_base_url: str = "http://localhost:18080"
    jwt_secret: str = "local-demo-only-change-before-public-deployment"
    jwt_days: int = 7
    admin_token: str = ""
    signed_url_seconds: int = 86400
    mock_providers: bool = True
    dashscope_api_key: str = ""
    deepseek_api_key: str = ""
    dashscope_base_url: str = "https://dashscope.aliyuncs.com/api/v1"
    dashscope_compatible_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    deepseek_base_url: str = "https://api.deepseek.com"
    # 火山方舟（豆包 Seedream 出图）：只在选用 doubao-seedream 系列时需要。
    ark_api_key: str = ""
    ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"
    text_model: str = "deepseek-flash"
    vision_model: str = "qwen3-vl-plus"
    image_model: str = "wan2.7-image-pro"
    video_model: str = "wan2.6-i2v-flash"
    model_budget_cny: float = 12.0
    worker_lease_seconds: int = 600
    worker_max_attempts: int = 3
    provider_poll_seconds: float = 3.0
    provider_timeout_seconds: float = 300.0
    video_timeout_seconds: float = 600.0
    worker_poll_seconds: float = 1.0
    max_upload_bytes: int = Field(default=15 * 1024 * 1024, ge=1, le=15 * 1024 * 1024)
    max_upload_edge: int = Field(default=6000, ge=1, le=6000)
    rate_limit_register: int = Field(default=120, ge=1)
    rate_limit_login: int = Field(default=120, ge=1)
    rate_limit_recover: int = Field(default=5, ge=1)
    rate_limit_upload: int = Field(default=60, ge=1)
    rate_limit_messages: int = Field(default=120, ge=1)
    rate_limit_window_seconds: int = Field(default=60, ge=1)
    cors_origins: str = "*"
    environment: str = "development"

    @property
    def checkpoint_url(self) -> str:
        return self.database_url.replace("postgresql+psycopg://", "postgresql://", 1)


settings = Settings()
