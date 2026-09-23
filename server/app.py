from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Annotated, Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .openai_client import OpenAIGateway, OpenAIInvalidRequestError, OpenAIQuotaExhaustedError, OpenAIRateLimitError, OpenAIUnavailableError
from .schemas import ArchiveRequest, ArchiveResponse, ChunkResponse, DocumentListResponse, HealthResponse, SessionCreateRequest, SessionCreateResponse, SessionResumeRequest, SummaryResponse, TranscriptSegment
from .settings import settings
from .storage import create_store, utcnow

logger = logging.getLogger("lecture_memo")
store = create_store(settings)
gateway = OpenAIGateway(settings)
openai_slots = asyncio.Semaphore(settings.openai_max_in_flight)


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, *, retryable: bool = False, action: str | None = None, chunk_id: str | None = None, retry_after_seconds: int | None = None) -> None:
        super().__init__(message); self.status_code = status_code; self.code = code; self.message = message
        self.retryable = retryable; self.action = action; self.chunk_id = chunk_id; self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    user_id: str


@dataclass(slots=True)
class SessionRecord:
    session_id: str
    document_id: str
    owner_id: str
    source_url: str
    source_title: str
    language: str
    last_activity_monotonic: float = field(default_factory=time.monotonic)
    chunk_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


sessions: dict[str, SessionRecord] = {}


def _lease_until(seconds: int): return utcnow() + timedelta(seconds=seconds)


async def _write_partial(owner_id: str, session_id: str, *, status: str = "incomplete", missing: list[int] | None = None, expected: int | None = None, archive: ArchiveRequest | None = None, summary: SummaryResponse | None = None, summary_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    draft = await store.get_session(owner_id, session_id)
    if not draft: raise ApiError(404, "session_not_found", "세션을 찾을 수 없습니다.")
    chunks = [row for row in await store.list_chunks(owner_id, session_id) if row.get("status") == "ready"]
    segments = _absolute_segments(chunks)
    now = utcnow()
    existing = await store.get_document_for_session(owner_id, session_id)
    if existing and (
        (existing.get("status") == "completed" and status != "completed")
        or (existing.get("status") == "finalize_pending" and status == "incomplete" and archive is None)
    ):
        return existing
    value = {
        "schema_version": 8, "document_id": draft["document_id"], "session_id": session_id, "owner_id": owner_id,
        "status": status, "source": {"url": _canonical_url(draft.get("source_url", "")), "canonical_url": draft.get("canonical_url", ""), "url_hash": draft.get("source_url_hash", ""), "host": draft.get("source_host", ""), "video_id": draft.get("source_video_id", ""), "title": (archive.source_title if archive else "") or draft.get("source_title", "")},
        "requested_at": draft.get("created_at", now), "updated_at": now, "completed_at": now if status == "completed" else None,
        "language": draft.get("language", "auto"), "transcript": {"segments": segments, "text": "\n".join(v["text"] for v in segments), "ready_chunk_count": len(chunks), "expected_chunk_count": expected, "missing_sequences": missing or []},
        "chunk_state": {"ready_count": len(chunks), "expected_chunk_count": expected, "missing_sequences": missing or []},
        "summary_status": "completed" if status == "completed" else ("processing" if status == "finalize_pending" else "not_run"),
        "summary": summary.model_dump() if summary else (existing or {}).get("summary"), "bookmarks": archive.bookmarks if archive else (existing or {}).get("bookmarks", []),
        "duration_ms": archive.duration_ms if archive else (existing or {}).get("duration_ms", 0),
        "resume_status": "not_needed" if status == "completed" else "available", "resume_available_until": None if status == "completed" else draft.get("expire_at"),
    }
    if summary_meta is not None:
        value["summary_provider"] = {**summary_meta, "requested_model": settings.openai_text_model, "prompt_version": "summary-v1", "schema_version": 1}
    encoded = json.dumps(value, default=str, ensure_ascii=False).encode("utf-8")
    if len(encoded) > settings.max_document_bytes: raise ApiError(413, "document_too_large", "문서 크기가 Atlas 저장 한도를 초과합니다.")
    return await store.upsert_document(value)


async def _reconcile_state() -> None:
    now = utcnow()
    await store.reconcile(now)
    cutoff = now - timedelta(seconds=settings.session_idle_ttl_seconds)
    expire_at = now + timedelta(days=settings.incomplete_draft_retention_days)
    for draft in await store.expire_stale_sessions(cutoff, expire_at):
        try:
            await _write_partial(draft["owner_id"], draft["session_id"])
            await store.update_session(draft["owner_id"], draft["session_id"], {"partial_sync_pending": False})
            sessions.pop(draft["session_id"], None)
            await store.release_user_lease(draft["owner_id"])
        except Exception:
            logger.exception("stale session reconciliation failed: %s", draft["session_id"])


async def expire_idle_sessions() -> None:
    while True:
        await asyncio.sleep(min(60, max(5, settings.session_idle_ttl_seconds // 2)))
        cutoff = time.monotonic() - settings.session_idle_ttl_seconds
        for session_id in [key for key, row in sessions.items() if row.last_activity_monotonic < cutoff]:
            record = sessions.pop(session_id, None)
            if not record: continue
            try:
                expire_at = utcnow() + timedelta(days=settings.incomplete_draft_retention_days)
                await store.update_session(record.owner_id, session_id, {"status": "incomplete", "idle_expired": True, "expire_at": expire_at})
                await store.expire_drafts(record.owner_id, session_id, expire_at)
                await _write_partial(record.owner_id, session_id, status="incomplete")
                await store.release_user_lease(record.owner_id)
            except Exception: logger.exception("idle session expiration failed: %s", session_id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.app_auth_mode == "local" and settings.generated_access_token: logger.warning("Lecture Memo local access token: %s", settings.local_access_token)
    if settings.mock_openai: logger.warning("MOCK_OPENAI=true: 실제 OpenAI API를 호출하지 않습니다.")
    await store.initialize(); await store.scrub_source_urls(_source_metadata); await _reconcile_state()
    task = asyncio.create_task(expire_idle_sessions())
    try: yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError): await task
        sessions.clear(); await gateway.close(); await store.close()


app = FastAPI(title="Lecture Memo Relay", version="0.8.0", docs_url=None, redoc_url=None, lifespan=lifespan)
if settings.allowed_extension_origins: allowed_origins, allowed_origin_regex = list(settings.allowed_extension_origins), None
elif settings.app_auth_mode == "local": allowed_origins, allowed_origin_regex = [], r"^chrome-extension://[a-p]{32}$"
else: allowed_origins, allowed_origin_regex = [], None
app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_origin_regex=allowed_origin_regex, allow_credentials=False, allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "X-User-ID"])


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    headers = {"Retry-After": str(exc.retry_after_seconds)} if exc.retry_after_seconds is not None else {}
    return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message, "retryable": exc.retryable, "action": exc.action, "chunk_id": exc.chunk_id, "retry_after_seconds": exc.retry_after_seconds}}, headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, __: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": {"code": "invalid_request", "message": "요청 형식이 올바르지 않습니다.", "retryable": False, "action": "check_request"}})


@app.exception_handler(Exception)
async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled API error", exc_info=exc)
    return JSONResponse(status_code=500, content={"error": {"code": "server_error", "message": "서버 처리 중 오류가 발생했습니다.", "retryable": True}})


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    raw = request.headers.get("content-length")
    if raw and raw.isdigit() and int(raw) > settings.max_request_bytes:
        return JSONResponse(status_code=413, content={"error": {"code": "payload_too_large", "message": "요청 본문이 너무 큽니다.", "retryable": False}})
    return await call_next(request)


def _valid_origin(origin: str | None) -> bool:
    if not origin: return True
    if settings.allowed_extension_origins: return origin in settings.allowed_extension_origins
    return settings.app_auth_mode == "local" and bool(re.fullmatch(r"chrome-extension://[a-p]{32}", origin))


async def authorize(authorization: Annotated[str | None, Header()] = None, x_user_id: Annotated[str | None, Header()] = None, origin: Annotated[str | None, Header()] = None) -> AuthenticatedUser:
    if not _valid_origin(origin): raise ApiError(403, "origin_not_allowed", "허용되지 않은 확장 프로그램 origin입니다.")
    token = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if settings.app_auth_mode == "local":
        if not hmac.compare_digest(token, settings.local_access_token): raise ApiError(401, "authentication_failed", "접속 토큰이 올바르지 않습니다.")
        return AuthenticatedUser("local")
    user_id = (x_user_id or "").strip(); expected = settings.app_users.get(user_id, "")
    actual_hash = hashlib.sha256(token.encode()).hexdigest()
    if not expected or not hmac.compare_digest(actual_hash, expected): raise ApiError(401, "authentication_failed", "사용자 ID 또는 접속 코드가 올바르지 않습니다.")
    return AuthenticatedUser(user_id)


def _canonical_url(raw: str) -> str:
    try:
        value = urlsplit(raw.strip())
        if value.scheme.lower() not in {"http", "https"} or not value.hostname: return ""
        host = value.hostname.lower()
        port = value.port
        netloc = f"{host}:{port}" if port else host
        query = []
        if host == "youtube.com" or host.endswith(".youtube.com"):
            query = [(k, v) for k, v in parse_qsl(value.query, keep_blank_values=True) if k.lower() == "v"]
        return urlunsplit((value.scheme.lower(), netloc, value.path, urlencode(query), ""))
    except Exception: return ""


def _source_metadata(raw: str) -> dict[str, str]:
    canonical = _canonical_url(raw)
    try:
        parsed = urlsplit(canonical)
        query = dict(parse_qsl(parsed.query))
        video_id = query.get("v", "") if parsed.netloc.endswith("youtube.com") else (parsed.path.strip("/") if parsed.netloc == "youtu.be" else "")
        return {"canonical_url": canonical, "url_hash": hashlib.sha256(canonical.encode()).hexdigest() if canonical else "", "host": parsed.netloc, "video_id": video_id}
    except Exception:
        return {"canonical_url": "", "url_hash": "", "host": "", "video_id": ""}


def _safety_id(owner_id: str) -> str:
    return hmac.new(settings.safety_identifier_secret.encode(), owner_id.encode(), hashlib.sha256).hexdigest()


async def _owned_draft(user: AuthenticatedUser, session_id: str) -> dict[str, Any]:
    row = await store.get_session(user.user_id, session_id)
    if not row: raise ApiError(404, "session_not_found", "세션을 찾을 수 없습니다.")
    return row


async def _active_record(user: AuthenticatedUser, session_id: str) -> SessionRecord:
    record = sessions.get(session_id)
    if not record or record.owner_id != user.user_id:
        await _owned_draft(user, session_id); raise ApiError(409, "session_resume_required", "서버 세션 복구가 필요합니다.", action="resume_session")
    record.last_activity_monotonic = time.monotonic()
    await store.acquire_user_lease(user.user_id, _lease_until(settings.active_user_lease_seconds), settings.max_concurrent_users, utcnow())
    return record


def _absolute_segments(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for chunk in chunks:
        base = int(chunk.get("media_start_ms", 0)); rate = float(chunk.get("playback_rate", 1)); overlap = round(int(chunk.get("overlap_ms", 0)) * rate)
        for raw in chunk.get("segments", []):
            item = dict(raw); item["start_ms"] = round(base + int(item.pop("relative_start_ms", 0)) * rate); item["end_ms"] = round(base + int(item.pop("relative_end_ms", 0)) * rate); item["sequence"] = chunk["sequence"]
            normalized = re.sub(r"\W+", "", item.get("text", "")).lower()
            if result and item["start_ms"] < base + overlap and normalized and normalized == re.sub(r"\W+", "", result[-1].get("text", "")).lower(): continue
            result.append(item)
    return result


def _provider_error(exc: Exception, chunk_id: str | None = None) -> ApiError:
    if isinstance(exc, OpenAIQuotaExhaustedError): return ApiError(429, "openai_quota_exhausted", str(exc), retryable=False, action="contact_operator", chunk_id=chunk_id, retry_after_seconds=exc.retry_after_seconds)
    if isinstance(exc, OpenAIRateLimitError): return ApiError(429, "openai_rate_limited", str(exc), retryable=True, action="retry_later", chunk_id=chunk_id, retry_after_seconds=exc.retry_after_seconds)
    if isinstance(exc, OpenAIUnavailableError): return ApiError(503, "openai_overloaded", str(exc), retryable=True, action="keep_chunk", chunk_id=chunk_id, retry_after_seconds=exc.retry_after_seconds)
    if isinstance(exc, OpenAIInvalidRequestError): return ApiError(422, "openai_invalid_request", str(exc), retryable=False, action="keep_chunk", chunk_id=chunk_id)
    return ApiError(502, "openai_request_failed", "OpenAI 요청에 실패했습니다.", retryable=True, action="keep_chunk", chunk_id=chunk_id)


async def _check_daily_budget(owner_id: str, additional_ms: int, chunk_id: str) -> None:
    day = utcnow().date().isoformat(); own, total = await store.get_daily_audio_ms(owner_id, day)
    own_limit = settings.daily_audio_minutes_limit_per_user * 60_000
    total_limit = settings.daily_audio_minutes_limit_total * 60_000
    if (own_limit and own + additional_ms > own_limit) or (total_limit and total + additional_ms > total_limit):
        raise ApiError(429, "operator_budget_limit", "운영자가 설정한 일일 오디오 한도에 도달했습니다.", retryable=False, action="contact_operator", chunk_id=chunk_id)


@app.get("/health/live")
async def health_live() -> dict[str, str]: return {"status": "ok"}


@app.get("/health/ready", response_model=HealthResponse)
@app.get("/health", response_model=HealthResponse, include_in_schema=False)
async def health_ready() -> HealthResponse:
    if not await store.ping(): raise ApiError(503, "storage_unavailable", "저장소 연결을 확인할 수 없습니다.", retryable=True)
    return HealthResponse(status="ok", model=settings.openai_text_model, transcription_model=settings.openai_transcribe_model, mock_mode=settings.mock_openai, storage=store.kind, chunk_seconds=settings.audio_chunk_seconds, chunk_overlap_seconds=settings.audio_chunk_overlap_seconds, max_chunk_bytes=settings.max_chunk_bytes, max_request_bytes=settings.max_request_bytes, max_concurrent_users=settings.max_concurrent_users)


@app.post("/v1/sessions", response_model=SessionCreateResponse)
async def create_session(payload: SessionCreateRequest, user: AuthenticatedUser = Depends(authorize)) -> SessionCreateResponse:
    now = utcnow()
    if not await store.acquire_user_lease(user.user_id, _lease_until(settings.active_user_lease_seconds), settings.max_concurrent_users, now): raise ApiError(429, "concurrent_user_limit", "현재 동시 사용자 한도에 도달했습니다.", retryable=True, retry_after_seconds=60)
    session_id, document_id = str(uuid.uuid4()), str(uuid.uuid4())
    source = _source_metadata(payload.source_url)
    row = {"schema_version": 8, "session_id": session_id, "document_id": document_id, "owner_id": user.user_id, "source_tab_id": payload.source_tab_id, "source_url": source["canonical_url"], "canonical_url": source["canonical_url"], "source_url_hash": source["url_hash"], "source_host": source["host"], "source_video_id": source["video_id"], "source_title": payload.source_title, "language": payload.language, "status": "recording", "next_sequence": 0, "created_at": now, "updated_at": now}
    await store.create_session(row); sessions[session_id] = SessionRecord(session_id, document_id, user.user_id, source["canonical_url"], payload.source_title, payload.language)
    return SessionCreateResponse(session_id=session_id, document_id=document_id, model=settings.openai_text_model)


@app.post("/v1/sessions/{session_id}/resume", response_model=SessionCreateResponse)
async def resume_session(session_id: str, _payload: SessionResumeRequest, user: AuthenticatedUser = Depends(authorize)) -> SessionCreateResponse:
    await _reconcile_state()
    now = utcnow()
    outcome, draft, chunks = await store.resume_drafts(user.user_id, session_id, now, now + timedelta(seconds=settings.active_user_lease_seconds), settings.max_concurrent_users)
    if outcome == "missing": raise ApiError(404, "session_not_found", "세션을 찾을 수 없습니다.")
    if outcome == "completed": raise ApiError(409, "session_completed", "이미 완료된 세션입니다.")
    if outcome == "expired": raise ApiError(410, "session_expired", "세션 복구 기간이 만료되었습니다.", action="start_new_session")
    if outcome == "limit": raise ApiError(429, "concurrent_user_limit", "현재 동시 사용자 한도에 도달했습니다.", retryable=True)
    if outcome != "ready": raise ApiError(409, "session_resume_incomplete", "서버 초안이 불완전합니다.", retryable=True, action="retry_later")
    chunks = [v for v in chunks if v.get("status") == "ready"]
    sessions[session_id] = SessionRecord(session_id, draft["document_id"], user.user_id, draft.get("source_url", ""), draft.get("source_title", ""), draft.get("language", "auto"))
    return SessionCreateResponse(session_id=session_id, document_id=draft["document_id"], model=settings.openai_text_model, resumed=True, next_sequence=int(draft.get("next_sequence", 0)), segments=_absolute_segments(chunks))


@app.post("/v1/sessions/{session_id}/chunks", response_model=ChunkResponse)
async def process_chunk(session_id: str, sequence: Annotated[int, Form(ge=0)], capture_start_ms: Annotated[int, Form(ge=0)], capture_end_ms: Annotated[int, Form(ge=1)], video_start_ms: Annotated[int, Form(ge=0)], playback_rate: Annotated[float, Form(gt=0, le=16)], overlap_ms: Annotated[int, Form(ge=0)], mime_type: Annotated[str, Form()], audio: Annotated[UploadFile, File()], user: AuthenticatedUser = Depends(authorize)) -> ChunkResponse:
    record = await _active_record(user, session_id); audio_bytes = await audio.read(settings.max_chunk_bytes + 1)
    if not audio_bytes or len(audio_bytes) > settings.max_chunk_bytes: raise ApiError(413, "chunk_too_large", "오디오 청크가 비어 있거나 너무 큽니다.", action="keep_chunk")
    duration_ms = capture_end_ms - capture_start_ms
    if duration_ms <= 0 or duration_ms > (settings.audio_chunk_seconds + settings.audio_chunk_overlap_seconds + 5) * 1000: raise ApiError(422, "invalid_chunk_duration", "청크 길이가 설정 범위를 벗어났습니다.", action="keep_chunk")
    chunk_id = f"{session_id}:{sequence}"; now = utcnow(); digest = hashlib.sha256(audio_bytes).hexdigest()
    async with record.chunk_lock:
        draft = await _owned_draft(user, session_id); expected = int(draft.get("next_sequence", 0))
        old = await store.get_chunk(user.user_id, session_id, sequence)
        if old and old.get("status") == "ready":
            if old.get("audio_sha256") != digest: raise ApiError(409, "chunk_conflict", "같은 순번의 청크 내용이 다릅니다.", action="keep_chunk")
            if expected <= sequence:
                await store.update_session(user.user_id, session_id, {"status": "processing", "next_sequence": sequence + 1})
            await _write_partial(user.user_id, session_id)
            return ChunkResponse(session_id=session_id, sequence=sequence, segments=[TranscriptSegment.model_validate(v) for v in old.get("segments", [])])
        if sequence != expected: raise ApiError(409, "sequence_gap", f"다음 청크 순번은 {expected}입니다.", retryable=True, action="retry_in_order", chunk_id=chunk_id)
        claim = {"owner_id": user.user_id, "session_id": session_id, "sequence": sequence, "audio_sha256": digest, "attempt_id": str(uuid.uuid4()), "lease_until": _lease_until(settings.processing_lease_seconds), "capture_start_ms": capture_start_ms, "capture_end_ms": capture_end_ms, "media_start_ms": video_start_ms, "playback_rate": playback_rate, "overlap_ms": overlap_ms, "mime_type": mime_type}
        state, cached = await store.claim_chunk(claim, now)
        if state == "conflict": raise ApiError(409, "chunk_conflict", "같은 순번의 청크 내용이 다릅니다.", action="keep_chunk")
        if state == "busy": raise ApiError(409, "chunk_processing", "같은 청크가 이미 처리 중입니다.", retryable=True, action="retry_later", chunk_id=chunk_id)
        if state == "ready":
            if expected <= sequence:
                await store.update_session(user.user_id, session_id, {"status": "processing", "next_sequence": sequence + 1})
            await _write_partial(user.user_id, session_id)
            return ChunkResponse(session_id=session_id, sequence=sequence, segments=[TranscriptSegment.model_validate(v) for v in cached.get("segments", [])])
        try:
            await _check_daily_budget(user.user_id, duration_ms, chunk_id)
        except ApiError as error:
            await store.finish_chunk(claim, {"status": "blocked", "last_error": error.code})
            raise
        try:
            await asyncio.wait_for(openai_slots.acquire(), timeout=settings.openai_queue_wait_seconds)
        except TimeoutError:
            await store.finish_chunk(claim, {"status": "retry_wait", "last_error": "ai_backpressure"}); raise ApiError(503, "ai_backpressure", "AI 처리 대기열이 가득 찼습니다.", retryable=True, action="keep_chunk", chunk_id=chunk_id, retry_after_seconds=15)
        try:
            result = await gateway.transcribe(audio_bytes=audio_bytes, mime_type=mime_type, sequence=sequence, duration_ms=duration_ms, safety_identifier=_safety_id(user.user_id), language_hint=record.language)
        except Exception as exc:
            error = _provider_error(exc, chunk_id); await store.record_provider_state(error.code, error.retry_after_seconds); await store.finish_chunk(claim, {"status": "retry_wait" if error.retryable else "blocked", "last_error": error.code}); raise error from exc
        finally: openai_slots.release()
        segments = [v.model_dump() for v in result.transcript.segments]
        saved = await store.finish_chunk(claim, {"status": "ready", "segments": segments, "detected_language": result.language, "original_text": result.original_text, "provider_request_id": result.provider_request_id, "requested_model": settings.openai_transcribe_model, "resolved_model": result.resolved_model, "prompt_version": "transcribe-v1", "schema_version": 1, "usage": result.usage, "updated_at": utcnow(), "lease_until": None})
        if not saved:
            raise ApiError(409, "chunk_processing", "다른 처리 시도가 이 청크를 갱신했습니다.", retryable=True, action="retry_later", chunk_id=chunk_id)
        await store.update_session(user.user_id, session_id, {"status": "processing", "next_sequence": sequence + 1}); await _write_partial(user.user_id, session_id)
        await store.record_usage(user.user_id, utcnow().date().isoformat(), {"audio_ms": duration_ms, "transcription_requests": 1})
        return ChunkResponse(session_id=session_id, sequence=sequence, segments=result.transcript.segments)


@app.post("/v1/sessions/{session_id}/archive", response_model=ArchiveResponse)
async def archive_session(session_id: str, payload: ArchiveRequest, user: AuthenticatedUser = Depends(authorize)) -> ArchiveResponse:
    await _reconcile_state()
    if payload.duration_ms > settings.max_session_duration_seconds * 1000:
        raise ApiError(422, "session_too_long", "세션 길이가 운영 상한을 초과했습니다.", action="keep_chunks")
    existing = await store.get_document_for_session(user.user_id, session_id)
    if existing and existing.get("status") == "completed" and existing.get("summary"):
        await store.delete_drafts(user.user_id, session_id); sessions.pop(session_id, None); await store.release_user_lease(user.user_id)
        return ArchiveResponse(saved=True, status="completed", document_id=existing["document_id"], chunk_count=existing.get("chunk_state", {}).get("ready_count", 0), summary=existing["summary"])
    draft = await _owned_draft(user, session_id); chunks = [v for v in await store.list_chunks(user.user_id, session_id) if v.get("status") == "ready"]
    expected = max(payload.expected_chunk_count, max((int(v["sequence"]) for v in chunks), default=-1) + 1); present = {int(v["sequence"]) for v in chunks}; missing = [v for v in range(expected) if v not in present]
    if missing:
        expire_at = utcnow() + timedelta(days=settings.incomplete_draft_retention_days); await store.update_session(user.user_id, session_id, {"status": "incomplete", "expected_chunk_count": expected, "missing_sequences": missing, "expire_at": expire_at}); await store.expire_drafts(user.user_id, session_id, expire_at)
        doc = await _write_partial(user.user_id, session_id, status="incomplete", missing=missing, expected=expected, archive=payload); sessions.pop(session_id, None); await store.release_user_lease(user.user_id)
        return ArchiveResponse(saved=False, status="incomplete", document_id=doc["document_id"], chunk_count=len(chunks), missing_sequences=missing)
    attempt_id = str(uuid.uuid4())
    if not await store.claim_finalize(user.user_id, session_id, attempt_id, _lease_until(settings.finalize_lease_seconds), utcnow()): raise ApiError(409, "finalize_in_progress", "최종 요약이 이미 처리 중입니다.", retryable=True, action="retry_later")
    try:
        interim = await _write_partial(user.user_id, session_id, status="finalize_pending", expected=expected, archive=payload); transcript = interim["transcript"]["text"]
        await asyncio.wait_for(openai_slots.acquire(), timeout=settings.openai_queue_wait_seconds)
        try: summary, summary_meta = await gateway.summarize(transcript=transcript, bookmarks=payload.bookmarks, safety_identifier=_safety_id(user.user_id))
        finally: openai_slots.release()
        doc = await _write_partial(user.user_id, session_id, status="completed", expected=expected, archive=payload, summary=summary, summary_meta=summary_meta)
        await store.record_usage(user.user_id, utcnow().date().isoformat(), {"summary_requests": 1}); await store.delete_drafts(user.user_id, session_id); sessions.pop(session_id, None); await store.release_user_lease(user.user_id)
        return ArchiveResponse(saved=True, status="completed", document_id=doc["document_id"], chunk_count=len(chunks), summary=summary)
    except ApiError: raise
    except Exception as exc:
        error = _provider_error(exc); await store.record_provider_state(error.code, error.retry_after_seconds); raise error from exc
    finally: await store.release_finalize(user.user_id, session_id)


@app.get("/v1/documents", response_model=DocumentListResponse)
async def list_documents(limit: int = 50, user: AuthenticatedUser = Depends(authorize)) -> DocumentListResponse:
    await _reconcile_state()
    rows = await store.list_documents(user.user_id, min(max(limit, 1), 100))
    items = [{k: v for k, v in row.items() if k not in {"transcript", "summary", "summary_provider", "bookmarks"}} for row in rows]
    return DocumentListResponse(items=items)


@app.get("/v1/documents/{document_id}")
async def get_document(document_id: str, user: AuthenticatedUser = Depends(authorize)) -> dict[str, Any]:
    await _reconcile_state()
    row = await store.get_document(user.user_id, document_id)
    if not row: raise ApiError(404, "document_not_found", "문서를 찾을 수 없습니다.")
    return row


@app.delete("/v1/documents/{document_id}")
async def delete_document(document_id: str, user: AuthenticatedUser = Depends(authorize)) -> dict[str, bool]:
    session_id = await store.delete_document(user.user_id, document_id)
    if not session_id: raise ApiError(404, "document_not_found", "문서를 찾을 수 없습니다.")
    await store.delete_drafts(user.user_id, session_id); return {"deleted": True}


@app.delete("/v1/sessions/{session_id}")
async def delete_session(session_id: str, user: AuthenticatedUser = Depends(authorize)) -> dict[str, bool]:
    await _owned_draft(user, session_id)
    await store.delete_drafts_and_expire_document(user.user_id, session_id)
    sessions.pop(session_id, None)
    await store.release_user_lease(user.user_id)
    return {"deleted": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.app:app", host="127.0.0.1", port=8050, reload=False)
