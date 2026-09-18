from __future__ import annotations

import asyncio
import hmac
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .gemini_client import (
    GeminiClient,
    GeminiInvalidRequestError,
    GeminiQuotaExhaustedError,
    GeminiUnavailableError,
)
from .schemas import (
    ArchiveRequest,
    ArchiveResponse,
    ChunkResponse,
    DocumentListResponse,
    HealthResponse,
    SessionApiKeyUpdateRequest,
    SessionCreateRequest,
    SessionCreateResponse,
    SessionResumeRequest,
    SummaryResponse,
    TranscriptPayload,
    TranscriptSegment,
)
from .settings import settings
from .storage import create_store, utcnow


logger = logging.getLogger("lecture_memo")
store = create_store(settings)


class ApiError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        action: str | None = None,
        chunk_id: str | None = None,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable
        self.action = action
        self.chunk_id = chunk_id
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    user_id: str


@dataclass(slots=True)
class SessionRecord:
    session_id: str
    owner_id: str
    source_tab_id: int | None
    source_url: str
    language: str
    gemini: GeminiClient
    last_activity_monotonic: float = field(default_factory=time.monotonic)
    chunk_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    summary_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


sessions: dict[str, SessionRecord] = {}


def close_session(record: SessionRecord) -> None:
    try:
        record.gemini.close()
    except Exception:
        logger.exception("Gemini client cleanup failed for session %s", record.session_id)


async def expire_idle_sessions() -> None:
    while True:
        await asyncio.sleep(min(60, max(5, settings.session_idle_ttl_seconds // 2)))
        cutoff = time.monotonic() - settings.session_idle_ttl_seconds
        for session_id in [key for key, value in sessions.items() if value.last_activity_monotonic < cutoff]:
            record = sessions.pop(session_id, None)
            if record is not None:
                close_session(record)
                try:
                    expire_at = utcnow() + timedelta(days=settings.incomplete_draft_retention_days)
                    await store.update_session(
                        record.owner_id,
                        record.session_id,
                        {"status": "incomplete", "idle_expired": True},
                    )
                    await store.expire_drafts(record.owner_id, record.session_id, expire_at)
                except Exception:
                    logger.exception("Failed to expire idle draft session %s", record.session_id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.app_auth_mode == "local" and settings.generated_access_token:
        logger.warning("Lecture Memo local access token: %s", settings.local_access_token)
    if settings.mock_gemini:
        logger.warning("MOCK_GEMINI=true: 실제 Gemini API를 호출하지 않습니다.")
    await store.initialize()
    cleanup_task = asyncio.create_task(expire_idle_sessions())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
        for record in list(sessions.values()):
            close_session(record)
        sessions.clear()
        await store.close()


app = FastAPI(
    title="Lecture Memo Relay",
    version="0.5.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

if settings.allowed_extension_origins:
    allowed_origins = list(settings.allowed_extension_origins)
    allowed_origin_regex = None
elif settings.app_auth_mode == "local":
    allowed_origins = []
    allowed_origin_regex = r"^chrome-extension://[a-p]{32}$"
else:
    allowed_origins = []
    allowed_origin_regex = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allowed_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-User-ID"],
)


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    headers = {}
    if exc.retry_after_seconds is not None:
        headers["Retry-After"] = str(exc.retry_after_seconds)
    return JSONResponse(
        status_code=exc.status_code,
        headers=headers,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "retryable": exc.retryable,
                "action": exc.action,
                "chunk_id": exc.chunk_id,
                "retry_after_seconds": exc.retry_after_seconds,
            }
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, __: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "invalid_request",
                "message": "요청 형식이 올바르지 않습니다.",
                "retryable": False,
                "action": "check_request",
                "chunk_id": None,
                "retry_after_seconds": None,
            }
        },
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled API error", exc_info=exc)
    status_code = 500
    code = "server_error"
    message = "서버 처리 중 오류가 발생했습니다."
    try:
        from pymongo.errors import PyMongoError

        if isinstance(exc, PyMongoError):
            status_code = 503
            code = "atlas_unavailable"
            message = "Atlas 저장소를 사용할 수 없습니다. 원본 청크를 보존하고 다시 시도해 주세요."
    except ImportError:
        pass
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": code,
                "message": message,
                "retryable": True,
                "action": "retry_later",
                "chunk_id": None,
                "retry_after_seconds": None,
            }
        },
    )


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > settings.max_request_bytes:
                return await api_error_handler(
                    request,
                    ApiError(413, "payload_too_large", "요청 본문이 허용 크기를 초과했습니다.", action="keep_chunk"),
                )
        except ValueError:
            return await api_error_handler(request, ApiError(400, "invalid_content_length", "잘못된 Content-Length입니다."))
    return await call_next(request)


def _valid_origin(origin: str | None) -> bool:
    if settings.allowed_extension_origins:
        return bool(origin and origin in settings.allowed_extension_origins)
    if settings.app_auth_mode == "local":
        return bool(origin and re.fullmatch(r"chrome-extension://[a-p]{32}", origin))
    return False


async def authorize(
    origin: Annotated[str | None, Header()] = None,
    authorization: Annotated[str | None, Header()] = None,
    x_user_id: Annotated[str | None, Header(alias="X-User-ID")] = None,
) -> AuthenticatedUser:
    if not _valid_origin(origin):
        raise ApiError(403, "origin_forbidden", "허용되지 않은 확장 프로그램 Origin입니다.")

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "authentication_failed", "접속 코드가 올바르지 않습니다.", action="enter_access_code")

    if settings.app_auth_mode == "local":
        if not hmac.compare_digest(token, settings.local_access_token):
            raise ApiError(401, "authentication_failed", "접속 코드가 올바르지 않습니다.", action="enter_access_code")
        return AuthenticatedUser(user_id="local")

    requested_user = (x_user_id or "").strip()
    expected = settings.app_users.get(requested_user)
    if not expected or not hmac.compare_digest(token, expected):
        raise ApiError(401, "authentication_failed", "사용자 ID 또는 접속 코드가 올바르지 않습니다.", action="enter_access_code")
    return AuthenticatedUser(user_id=requested_user)


def _new_gemini(api_key: str) -> GeminiClient:
    normalized = api_key.strip()
    if not normalized or len(normalized) > 512:
        raise ApiError(422, "gemini_key_required", "Gemini 인증 키를 입력해 주세요.", action="enter_gemini_key")
    try:
        return GeminiClient(settings, normalized)
    except ValueError as exc:
        raise ApiError(422, "gemini_key_invalid", str(exc), action="enter_gemini_key") from exc
    except RuntimeError as exc:
        raise ApiError(503, "gemini_client_unavailable", str(exc), retryable=True) from exc


async def _owned_draft(user: AuthenticatedUser, session_id: str) -> dict[str, Any]:
    draft = await store.get_session(user.user_id, session_id)
    if draft is None:
        raise ApiError(404, "session_not_found", "세션을 찾을 수 없습니다.")
    return draft


async def _active_record(user: AuthenticatedUser, session_id: str) -> SessionRecord:
    record = sessions.get(session_id)
    if record is None or record.owner_id != user.user_id:
        await _owned_draft(user, session_id)
        raise ApiError(409, "session_resume_required", "서버 세션을 먼저 복구해 주세요.", action="resume_session")
    record.last_activity_monotonic = time.monotonic()
    return record


def _normalized_text(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣]+", "", value).lower()


def _canonical_segments(
    transcript: TranscriptPayload,
    duration_ms: int,
    overlap_ms: int,
    previous: dict[str, Any] | None,
) -> list[TranscriptSegment]:
    previous_texts = [
        _normalized_text(segment.get("text", ""))
        for segment in (previous or {}).get("segments", [])[-4:]
    ]
    result: list[TranscriptSegment] = []
    for raw in transcript.segments:
        start = min(duration_ms, raw.relative_start_ms)
        end = min(duration_ms, raw.relative_end_ms)
        if end < start:
            continue
        text = raw.text.strip()
        normalized = _normalized_text(text)
        duplicate = start <= overlap_ms + 1000 and any(
            len(normalized) >= 4 and (normalized == prior or normalized in prior or prior in normalized)
            for prior in previous_texts
            if prior
        )
        if duplicate:
            continue
        result.append(raw.model_copy(update={"relative_start_ms": start, "relative_end_ms": end, "text": text}))
    return result


def _absolute_segments(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for chunk in chunks:
        base = int(chunk.get("video_start_ms", 0))
        rate = float(chunk.get("playback_rate", 1))
        sequence = int(chunk["sequence"])
        for segment in chunk.get("segments", []):
            start = round(base + int(segment["relative_start_ms"]) * rate)
            end = round(base + int(segment["relative_end_ms"]) * rate)
            result.append(
                {
                    "id": f"{sequence}-{segment['relative_start_ms']}-{segment['relative_end_ms']}",
                    "sequence": sequence,
                    "start_ms": start,
                    "end_ms": end,
                    "text": segment["text"],
                    "uncertain": bool(segment.get("uncertain")),
                    "status": "final",
                }
            )
    return sorted(result, key=lambda item: (item["start_ms"], item["sequence"]))


def _gemini_error(exc: Exception, chunk_id: str | None = None) -> ApiError:
    if isinstance(exc, GeminiQuotaExhaustedError):
        return ApiError(
            429,
            "gemini_quota_exhausted",
            "Gemini API 할당량이 소진되었습니다.",
            action="replace_gemini_key",
            chunk_id=chunk_id,
            retry_after_seconds=exc.retry_after_seconds,
        )
    if isinstance(exc, GeminiUnavailableError):
        return ApiError(
            503,
            "gemini_overloaded",
            "Gemini 모델이 혼잡합니다.",
            retryable=True,
            action="retry_later",
            chunk_id=chunk_id,
            retry_after_seconds=exc.retry_after_seconds,
        )
    if isinstance(exc, GeminiInvalidRequestError):
        return ApiError(422, "gemini_invalid_request", str(exc), action="keep_chunk", chunk_id=chunk_id)
    return ApiError(502, "gemini_request_failed", "Gemini 요청에 실패했습니다.", retryable=True, chunk_id=chunk_id)


@app.get("/health/live")
async def health_live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", response_model=HealthResponse)
@app.get("/health", response_model=HealthResponse, include_in_schema=False)
async def health_ready() -> HealthResponse:
    ready = await store.ping()
    if not ready:
        raise ApiError(503, "storage_unavailable", "저장소 연결을 확인할 수 없습니다.", retryable=True)
    return HealthResponse(
        status="ok",
        model=settings.gemini_model,
        mock_mode=settings.mock_gemini,
        storage=store.kind,
        chunk_seconds=settings.audio_chunk_seconds,
        chunk_overlap_seconds=settings.audio_chunk_overlap_seconds,
        max_chunk_bytes=settings.max_chunk_bytes,
        max_request_bytes=settings.max_request_bytes,
    )


@app.post("/v1/sessions", response_model=SessionCreateResponse)
async def create_session(payload: SessionCreateRequest, user: AuthenticatedUser = Depends(authorize)) -> SessionCreateResponse:
    gemini = _new_gemini(payload.gemini_api_key.get_secret_value())
    session_id = str(uuid.uuid4())
    now = utcnow()
    await store.create_session(
        {
            "session_id": session_id,
            "owner_id": user.user_id,
            "source_tab_id": payload.source_tab_id,
            "source_url": payload.source_url,
            "language": payload.language,
            "status": "active",
            "next_sequence": 0,
            "created_at": now,
            "updated_at": now,
            "schema_version": 5,
        }
    )
    sessions[session_id] = SessionRecord(
        session_id=session_id,
        owner_id=user.user_id,
        source_tab_id=payload.source_tab_id,
        source_url=payload.source_url,
        language=payload.language,
        gemini=gemini,
    )
    return SessionCreateResponse(session_id=session_id, model=settings.gemini_model)


@app.post("/v1/sessions/{session_id}/resume", response_model=SessionCreateResponse)
async def resume_session(
    session_id: str,
    payload: SessionResumeRequest,
    user: AuthenticatedUser = Depends(authorize),
) -> SessionCreateResponse:
    draft = await _owned_draft(user, session_id)
    if draft.get("status") == "completed":
        raise ApiError(409, "session_completed", "이미 완료된 세션입니다.")
    replacement = _new_gemini(payload.gemini_api_key.get_secret_value())
    previous = sessions.pop(session_id, None)
    if previous is not None:
        close_session(previous)
    sessions[session_id] = SessionRecord(
        session_id=session_id,
        owner_id=user.user_id,
        source_tab_id=draft.get("source_tab_id"),
        source_url=draft.get("source_url", ""),
        language=draft.get("language", "ko"),
        gemini=replacement,
    )
    await store.update_session(user.user_id, session_id, {"status": "active"})
    await store.activate_drafts(user.user_id, session_id)
    chunks = await store.list_chunks(user.user_id, session_id)
    next_sequence = max([int(value["sequence"]) for value in chunks], default=-1) + 1
    return SessionCreateResponse(
        session_id=session_id,
        model=settings.gemini_model,
        resumed=True,
        next_sequence=next_sequence,
        segments=_absolute_segments(chunks),
    )


@app.post("/v1/sessions/{session_id}/gemini-key", response_model=SessionCreateResponse)
async def update_session_gemini_key(
    session_id: str,
    payload: SessionApiKeyUpdateRequest,
    user: AuthenticatedUser = Depends(authorize),
) -> SessionCreateResponse:
    record = await _active_record(user, session_id)
    replacement = _new_gemini(payload.gemini_api_key.get_secret_value())
    async with record.chunk_lock, record.summary_lock:
        previous = record.gemini
        record.gemini = replacement
        try:
            previous.close()
        except Exception:
            logger.exception("Gemini client cleanup failed for session %s", session_id)
    return SessionCreateResponse(session_id=session_id, model=settings.gemini_model)


@app.post("/v1/sessions/{session_id}/chunks", response_model=ChunkResponse)
async def process_chunk(
    session_id: str,
    audio: Annotated[UploadFile, File()],
    sequence: Annotated[int, Form(ge=0)],
    capture_start_ms: Annotated[int, Form(ge=0)],
    capture_end_ms: Annotated[int, Form(ge=0)],
    video_start_ms: Annotated[int, Form(ge=0)],
    playback_rate: Annotated[float, Form(gt=0, le=16)],
    overlap_ms: Annotated[int, Form(ge=0)],
    mime_type: Annotated[str, Form(max_length=100)],
    user: AuthenticatedUser = Depends(authorize),
) -> ChunkResponse:
    record = await _active_record(user, session_id)
    chunk_id = f"{session_id}:{sequence}"
    if capture_end_ms <= capture_start_ms:
        raise ApiError(422, "invalid_chunk_duration", "청크 종료 시간은 시작 시간보다 커야 합니다.", action="keep_chunk", chunk_id=chunk_id)
    duration_ms = capture_end_ms - capture_start_ms
    if duration_ms > (settings.audio_chunk_seconds + 5) * 1000:
        raise ApiError(422, "invalid_chunk_duration", "오디오 청크 길이가 설정값을 초과했습니다.", action="keep_chunk", chunk_id=chunk_id)
    if overlap_ms > settings.audio_chunk_overlap_seconds * 1000:
        raise ApiError(422, "invalid_overlap", "오디오 겹침이 설정값을 초과했습니다.", action="keep_chunk", chunk_id=chunk_id)
    if not mime_type.startswith("audio/webm"):
        raise ApiError(415, "unsupported_media", "audio/webm 형식만 허용합니다.", action="keep_chunk", chunk_id=chunk_id)

    async with record.chunk_lock:
        draft = await _owned_draft(user, session_id)
        existing = await store.get_chunk(user.user_id, session_id, sequence)
        if existing is not None:
            await audio.close()
            if int(draft.get("next_sequence", 0)) <= sequence:
                await store.update_session(user.user_id, session_id, {"next_sequence": sequence + 1})
            return ChunkResponse(
                session_id=session_id,
                sequence=sequence,
                segments=[TranscriptSegment.model_validate(value) for value in existing.get("segments", [])],
            )
        expected = int(draft.get("next_sequence", 0))
        if sequence != expected:
            await audio.close()
            raise ApiError(409, "sequence_gap", f"다음 처리 순서는 {expected}입니다.", action="retry_in_order", chunk_id=chunk_id)

        audio_bytes = await audio.read(settings.max_chunk_bytes + 1)
        await audio.close()
        if not audio_bytes:
            raise ApiError(422, "empty_audio", "오디오 데이터가 비어 있습니다.", action="keep_chunk", chunk_id=chunk_id)
        if len(audio_bytes) > settings.max_chunk_bytes:
            raise ApiError(413, "payload_too_large", "오디오 청크가 허용 크기를 초과했습니다.", action="keep_chunk", chunk_id=chunk_id)

        try:
            transcript = await record.gemini.transcribe(
                audio_bytes=audio_bytes,
                mime_type=mime_type.split(";", maxsplit=1)[0],
                sequence=sequence,
                duration_ms=duration_ms,
                overlap_ms=overlap_ms,
            )
        except Exception as exc:
            if not isinstance(exc, (GeminiQuotaExhaustedError, GeminiUnavailableError, GeminiInvalidRequestError)):
                logger.exception("Gemini transcription failed for sequence %s", sequence)
            raise _gemini_error(exc, chunk_id) from exc

        previous = await store.get_chunk(user.user_id, session_id, sequence - 1) if sequence else None
        segments = _canonical_segments(transcript, duration_ms, overlap_ms, previous)
        now = utcnow()
        await store.upsert_chunk(
            {
                "owner_id": user.user_id,
                "session_id": session_id,
                "sequence": sequence,
                "chunk_id": chunk_id,
                "capture_start_ms": capture_start_ms,
                "capture_end_ms": capture_end_ms,
                "video_start_ms": video_start_ms,
                "playback_rate": playback_rate,
                "overlap_ms": overlap_ms,
                "mime_type": mime_type,
                "segments": [value.model_dump() for value in segments],
                "status": "transcribed",
                "created_at": now,
                "updated_at": now,
            }
        )
        await store.update_session(user.user_id, session_id, {"next_sequence": sequence + 1, "status": "active"})
        return ChunkResponse(session_id=session_id, sequence=sequence, segments=segments)


@app.post("/v1/sessions/{session_id}/archive", response_model=ArchiveResponse)
async def archive_session(
    session_id: str,
    payload: ArchiveRequest,
    user: AuthenticatedUser = Depends(authorize),
) -> ArchiveResponse:
    existing = await store.get_document_for_session(user.user_id, session_id)
    if existing is not None:
        return ArchiveResponse(
            saved=True,
            status="completed",
            document_id=existing["document_id"],
            chunk_count=int(existing.get("chunk_count", 0)),
            summary=SummaryResponse.model_validate(existing.get("summary", {})),
        )

    record = await _active_record(user, session_id)
    chunks = await store.list_chunks(user.user_id, session_id)
    sequences = {int(value["sequence"]) for value in chunks}
    expected_count = max(payload.expected_end_sequence, max(sequences, default=-1) + 1)
    missing = [sequence for sequence in range(expected_count) if sequence not in sequences]
    if missing:
        expire_at = utcnow() + timedelta(days=settings.incomplete_draft_retention_days)
        await store.update_session(
            user.user_id,
            session_id,
            {"status": "incomplete", "expected_end_sequence": expected_count, "missing_sequences": missing},
        )
        await store.expire_drafts(user.user_id, session_id, expire_at)
        return ArchiveResponse(
            saved=False,
            status="incomplete",
            chunk_count=len(chunks),
            missing_sequences=missing,
        )

    absolute = _absolute_segments(chunks)
    transcript_text = "\n".join(f"[{item['start_ms']}] {item['text']}" for item in absolute)
    async with record.summary_lock:
        try:
            summary = await record.gemini.summarize(
                kind="최종",
                previous_summary={},
                transcript=transcript_text[-200_000:],
                bookmarks=payload.bookmarks,
            )
        except Exception as exc:
            await store.update_session(user.user_id, session_id, {"status": "finalize_pending"})
            raise _gemini_error(exc) from exc

    document_id = str(uuid.uuid4())
    now = utcnow()
    document = await store.save_document(
        {
            "document_id": document_id,
            "session_id": session_id,
            "owner_id": user.user_id,
            "source_url": record.source_url,
            "source_title": payload.source_title,
            "language": record.language,
            "created_at": now,
            "completed_at": now,
            "duration_ms": payload.duration_ms,
            "transcript_txt": transcript_text,
            "segments": absolute,
            "summary": summary.model_dump(),
            "bookmarks": payload.bookmarks,
            "chunk_count": len(chunks),
            "missing_chunk_count": 0,
            "status": "completed",
            "schema_version": 5,
        }
    )
    await store.delete_drafts(user.user_id, session_id)
    active = sessions.pop(session_id, None)
    if active is not None:
        close_session(active)
    return ArchiveResponse(
        saved=True,
        status="completed",
        document_id=document["document_id"],
        chunk_count=len(chunks),
        summary=summary,
    )


@app.get("/v1/documents", response_model=DocumentListResponse)
async def list_documents(limit: int = 50, user: AuthenticatedUser = Depends(authorize)) -> DocumentListResponse:
    safe_limit = min(100, max(1, limit))
    values = await store.list_documents(user.user_id, safe_limit)
    return DocumentListResponse(items=values)


@app.get("/v1/documents/{document_id}")
async def get_document(document_id: str, user: AuthenticatedUser = Depends(authorize)) -> dict[str, Any]:
    value = await store.get_document(user.user_id, document_id)
    if value is None:
        raise ApiError(404, "document_not_found", "문서를 찾을 수 없습니다.")
    return value


@app.delete("/v1/documents/{document_id}")
async def delete_document(document_id: str, user: AuthenticatedUser = Depends(authorize)) -> dict[str, bool]:
    deleted = await store.delete_document(user.user_id, document_id)
    if not deleted:
        raise ApiError(404, "document_not_found", "문서를 찾을 수 없습니다.")
    return {"deleted": True}


@app.delete("/v1/sessions/{session_id}")
async def delete_session(session_id: str, user: AuthenticatedUser = Depends(authorize)) -> dict[str, bool]:
    await _owned_draft(user, session_id)
    active = sessions.pop(session_id, None)
    if active is not None:
        close_session(active)
    await store.delete_drafts(user.user_id, session_id)
    return {"deleted": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.app:app", host="127.0.0.1", port=8050, reload=False)
