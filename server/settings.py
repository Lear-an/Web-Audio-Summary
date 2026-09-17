from __future__ import annotations

import os
import secrets
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


_configured_token = os.getenv("LOCAL_ACCESS_TOKEN", "").strip()


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name}은 정수여야 합니다.") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name}은 {minimum}~{maximum} 범위여야 합니다.")
    return value


_audio_chunk_seconds = _bounded_int("AUDIO_CHUNK_SECONDS", 10, 5, 600)
_audio_chunk_overlap_seconds = _bounded_int("AUDIO_CHUNK_OVERLAP_SECONDS", 1, 0, 30)
_session_idle_ttl_seconds = _bounded_int("SESSION_IDLE_TTL_SECONDS", 1800, 60, 86400)
if _audio_chunk_overlap_seconds >= _audio_chunk_seconds:
    raise ValueError("AUDIO_CHUNK_OVERLAP_SECONDS는 AUDIO_CHUNK_SECONDS보다 작아야 합니다.")

# MediaRecorder 목표 비트레이트 64kbps에 컨테이너 오버헤드와 안전계수 1.5를 적용합니다.
_estimated_chunk_bytes = int(_audio_chunk_seconds * 8_000 * 1.5) + 65_536
_configured_max_chunk_bytes = int(os.getenv("MAX_CHUNK_BYTES", "1000000"))
_max_chunk_bytes = max(_configured_max_chunk_bytes, _estimated_chunk_bytes)
_configured_max_request_bytes = int(os.getenv("MAX_REQUEST_BYTES", "1300000"))
_max_request_bytes = max(_configured_max_request_bytes, _max_chunk_bytes + 300_000)


@dataclass(frozen=True, slots=True)
class Settings:
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
    local_access_token: str = _configured_token or secrets.token_urlsafe(24)
    generated_access_token: bool = not bool(_configured_token)
    allowed_extension_origin: str = os.getenv("ALLOWED_EXTENSION_ORIGIN", "").strip()
    mock_gemini: bool = _as_bool(os.getenv("MOCK_GEMINI"), False)
    audio_chunk_seconds: int = _audio_chunk_seconds
    audio_chunk_overlap_seconds: int = _audio_chunk_overlap_seconds
    max_chunk_bytes: int = _max_chunk_bytes
    max_request_bytes: int = _max_request_bytes
    session_idle_ttl_seconds: int = _session_idle_ttl_seconds


settings = Settings()
