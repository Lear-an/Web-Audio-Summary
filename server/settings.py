from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field

from dotenv import load_dotenv


load_dotenv()


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name}은 정수여야 합니다.") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name}은 {minimum}~{maximum} 범위여야 합니다.")
    return value


def _origins() -> tuple[str, ...]:
    raw = os.getenv("ALLOWED_EXTENSION_ORIGINS", "").strip()
    if not raw:
        raw = os.getenv("ALLOWED_EXTENSION_ORIGIN", "").strip()
    return tuple(value.strip() for value in raw.split(",") if value.strip())


def _users() -> dict[str, str]:
    result: dict[str, str] = {}
    for index in range(1, 8):
        user_id = os.getenv(f"APP_USER_{index}_ID", "").strip()
        token = os.getenv(f"APP_USER_{index}_TOKEN", "").strip()
        if user_id and token:
            result[user_id] = token
    return result


_chunk_seconds = _bounded_int("AUDIO_CHUNK_SECONDS", 300, 5, 600)
_overlap_seconds = _bounded_int("AUDIO_CHUNK_OVERLAP_SECONDS", 5, 0, 30)
if _overlap_seconds >= _chunk_seconds:
    raise ValueError("AUDIO_CHUNK_OVERLAP_SECONDS는 AUDIO_CHUNK_SECONDS보다 작아야 합니다.")

_estimated_chunk_bytes = int(_chunk_seconds * 8_000 * 1.5) + 65_536
_max_chunk_bytes = max(_bounded_int("MAX_CHUNK_BYTES", 6_000_000, 100_000, 100_000_000), _estimated_chunk_bytes)
_max_request_bytes = max(
    _bounded_int("MAX_REQUEST_BYTES", 6_500_000, 200_000, 110_000_000),
    _max_chunk_bytes + 300_000,
)
_configured_local_token = os.getenv("LOCAL_ACCESS_TOKEN", "").strip()


@dataclass(frozen=True, slots=True)
class Settings:
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
    mock_gemini: bool = _as_bool(os.getenv("MOCK_GEMINI"), False)
    app_auth_mode: str = os.getenv("APP_AUTH_MODE", "local").strip().lower()
    local_access_token: str = _configured_local_token or secrets.token_urlsafe(24)
    generated_access_token: bool = not bool(_configured_local_token)
    app_users: dict[str, str] = field(default_factory=_users)
    allowed_extension_origins: tuple[str, ...] = field(default_factory=_origins)
    audio_chunk_seconds: int = _chunk_seconds
    audio_chunk_overlap_seconds: int = _overlap_seconds
    max_chunk_bytes: int = _max_chunk_bytes
    max_request_bytes: int = _max_request_bytes
    session_idle_ttl_seconds: int = _bounded_int("SESSION_IDLE_TTL_SECONDS", 1800, 60, 86400)
    mongodb_uri: str = os.getenv("MONGODB_URI", "").strip()
    mongodb_database: str = os.getenv("MONGODB_DATABASE", "lecture_memo").strip()
    mongodb_document_collection: str = os.getenv("MONGODB_DOCUMENT_COLLECTION", "lecture_documents").strip()
    mongodb_session_collection: str = os.getenv("MONGODB_SESSION_COLLECTION", "lecture_sessions").strip()
    mongodb_chunk_collection: str = os.getenv("MONGODB_CHUNK_COLLECTION", "lecture_session_chunks").strip()
    mongodb_required: bool = _as_bool(os.getenv("MONGODB_REQUIRED"), False)
    incomplete_draft_retention_days: int = _bounded_int("INCOMPLETE_DRAFT_RETENTION_DAYS", 7, 1, 90)

    def __post_init__(self) -> None:
        if self.app_auth_mode not in {"local", "multi_user"}:
            raise ValueError("APP_AUTH_MODE는 local 또는 multi_user여야 합니다.")
        if self.app_auth_mode == "multi_user" and not self.app_users:
            raise ValueError("multi_user 모드에는 APP_USER_n_ID/TOKEN이 하나 이상 필요합니다.")
        if self.mongodb_required and not self.mongodb_uri:
            raise ValueError("MONGODB_REQUIRED=true이면 MONGODB_URI가 필요합니다.")


settings = Settings()
