from __future__ import annotations

import hashlib
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
    raw = os.getenv("ALLOWED_EXTENSION_ORIGINS", "").strip() or os.getenv("ALLOWED_EXTENSION_ORIGIN", "").strip()
    return tuple(value.strip() for value in raw.split(",") if value.strip())


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _users() -> dict[str, str]:
    result: dict[str, str] = {}
    for index in range(1, 21):
        user_id = os.getenv(f"APP_USER_{index}_ID", "").strip()
        token_hash = os.getenv(f"APP_USER_{index}_TOKEN_SHA256", "").strip().lower()
        legacy_token = os.getenv(f"APP_USER_{index}_TOKEN", "").strip()
        if user_id and (token_hash or legacy_token):
            result[user_id] = token_hash or _sha256(legacy_token)
    return result


_chunk_seconds = _bounded_int("AUDIO_CHUNK_SECONDS", 60, 15, 180)
_overlap_seconds = _bounded_int("AUDIO_CHUNK_OVERLAP_SECONDS", 2, 0, 30)
if _overlap_seconds >= _chunk_seconds:
    raise ValueError("AUDIO_CHUNK_OVERLAP_SECONDS는 AUDIO_CHUNK_SECONDS보다 작아야 합니다.")

_audio_bits_per_second = _bounded_int("AUDIO_BITS_PER_SECOND", 128_000, 32_000, 512_000)
_estimated_chunk_bytes = (
    ((_chunk_seconds + _overlap_seconds) * _audio_bits_per_second + 7) // 8 * 125 // 100
) + 65_536
_max_chunk_bytes = _bounded_int("MAX_CHUNK_BYTES", 6_000_000, 100_000, 25_000_000)
if _max_chunk_bytes < _estimated_chunk_bytes:
    raise ValueError(
        f"MAX_CHUNK_BYTES가 설정된 오디오에 비해 작습니다. 최소 {_estimated_chunk_bytes}바이트가 필요합니다."
    )
_max_request_bytes = _bounded_int("MAX_REQUEST_BYTES", 6_500_000, 200_000, 26_000_000)
if _max_request_bytes < _max_chunk_bytes + 300_000:
    raise ValueError("MAX_REQUEST_BYTES는 MAX_CHUNK_BYTES보다 최소 300000바이트 커야 합니다.")

_configured_local_token = os.getenv("LOCAL_ACCESS_TOKEN", "").strip()


@dataclass(frozen=True, slots=True)
class Settings:
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "").strip()
    openai_transcribe_model: str = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-transcribe").strip()
    openai_text_model: str = os.getenv("OPENAI_TEXT_MODEL", "gpt-5.6-luna").strip()
    openai_text_fallback_model: str = os.getenv("OPENAI_TEXT_FALLBACK_MODEL", "gpt-5.6-terra").strip()
    text_fallback_enabled: bool = _as_bool(os.getenv("TEXT_FALLBACK_ENABLED"), False)
    mock_openai: bool = _as_bool(os.getenv("MOCK_OPENAI"), False)
    openai_transcribe_timeout_seconds: int = _bounded_int("OPENAI_TRANSCRIBE_TIMEOUT_SECONDS", 90, 10, 300)
    openai_text_timeout_seconds: int = _bounded_int("OPENAI_TEXT_TIMEOUT_SECONDS", 60, 10, 300)
    openai_max_in_flight: int = _bounded_int("OPENAI_MAX_IN_FLIGHT", 3, 1, 20)
    openai_queue_wait_seconds: int = _bounded_int("OPENAI_QUEUE_WAIT_SECONDS", 30, 0, 300)
    safety_identifier_secret: str = os.getenv("SAFETY_IDENTIFIER_SECRET", "").strip()

    app_auth_mode: str = os.getenv("APP_AUTH_MODE", "local").strip().lower()
    local_access_token: str = _configured_local_token or secrets.token_urlsafe(24)
    generated_access_token: bool = not bool(_configured_local_token)
    app_users: dict[str, str] = field(default_factory=_users)
    max_registered_users: int = _bounded_int("MAX_REGISTERED_USERS", 10, 1, 20)
    max_concurrent_users: int = _bounded_int("MAX_CONCURRENT_USERS", 5, 1, 20)
    active_user_lease_seconds: int = _bounded_int("ACTIVE_USER_LEASE_SECONDS", 180, 30, 3600)
    allowed_extension_origins: tuple[str, ...] = field(default_factory=_origins)

    audio_chunk_seconds: int = _chunk_seconds
    audio_chunk_overlap_seconds: int = _overlap_seconds
    audio_bits_per_second: int = _audio_bits_per_second
    max_chunk_bytes: int = _max_chunk_bytes
    max_request_bytes: int = _max_request_bytes
    max_session_duration_seconds: int = _bounded_int("MAX_SESSION_DURATION_SECONDS", 14_400, 60, 86_400)
    max_document_bytes: int = _bounded_int("MAX_DOCUMENT_BYTES", 12_000_000, 1_000_000, 15_000_000)

    session_idle_ttl_seconds: int = _bounded_int("SESSION_IDLE_TTL_SECONDS", 1800, 60, 86_400)
    incomplete_draft_retention_days: int = _bounded_int("DRAFT_RETENTION_DAYS", 7, 1, 90)
    processing_lease_seconds: int = _bounded_int("PROCESSING_LEASE_SECONDS", 180, 30, 900)
    finalize_lease_seconds: int = _bounded_int("FINALIZE_LEASE_SECONDS", 180, 30, 900)

    mongodb_uri: str = os.getenv("MONGODB_URI", "").strip()
    mongodb_database: str = os.getenv("MONGODB_DATABASE", "lecture_memo").strip()
    mongodb_document_collection: str = os.getenv("MONGODB_DOCUMENT_COLLECTION", "lecture_documents").strip()
    mongodb_session_collection: str = os.getenv("MONGODB_SESSION_COLLECTION", "lecture_sessions").strip()
    mongodb_chunk_collection: str = os.getenv("MONGODB_CHUNK_COLLECTION", "lecture_session_chunks").strip()
    mongodb_service_state_collection: str = os.getenv("MONGODB_SERVICE_STATE_COLLECTION", "service_state").strip()
    mongodb_daily_usage_collection: str = os.getenv("MONGODB_DAILY_USAGE_COLLECTION", "daily_usage").strip()
    mongodb_required: bool = _as_bool(os.getenv("MONGODB_REQUIRED"), False)
    daily_audio_minutes_limit_per_user: int = _bounded_int("DAILY_AUDIO_MINUTES_LIMIT_PER_USER", 0, 0, 100_000)
    daily_audio_minutes_limit_total: int = _bounded_int("DAILY_AUDIO_MINUTES_LIMIT_TOTAL", 0, 0, 1_000_000)

    def __post_init__(self) -> None:
        if self.app_auth_mode not in {"local", "multi_user"}:
            raise ValueError("APP_AUTH_MODE는 local 또는 multi_user여야 합니다.")
        if self.app_auth_mode == "multi_user" and not self.app_users:
            raise ValueError("multi_user 모드에는 APP_USER_n_ID/TOKEN_SHA256이 하나 이상 필요합니다.")
        if len(self.app_users) > self.max_registered_users:
            raise ValueError("등록된 사용자가 MAX_REGISTERED_USERS를 초과했습니다.")
        if self.mongodb_required and not self.mongodb_uri:
            raise ValueError("MONGODB_REQUIRED=true이면 MONGODB_URI가 필요합니다.")
        if not self.mock_openai and not self.openai_api_key:
            raise ValueError("MOCK_OPENAI=false이면 OPENAI_API_KEY가 필요합니다.")
        if not self.mock_openai and not self.safety_identifier_secret:
            raise ValueError("운영 모드에는 SAFETY_IDENTIFIER_SECRET이 필요합니다.")


settings = Settings()
