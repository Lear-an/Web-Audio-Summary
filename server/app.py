from __future__ import annotations

import asyncio
import hmac
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .gemini_client import GeminiClient, GeminiInvalidRequestError, GeminiQuotaExhaustedError
from .schemas import (
    ChunkResponse,
    HealthResponse,
    SessionCreateRequest,
    SessionCreateResponse,
    SummaryRequest,
    SummaryResponse,
    TranscriptPayload,
)
from .settings import settings


logger = logging.getLogger("lecture_memo")


@dataclass(slots=True)
class SessionRecord:
    session_id: str
    source_tab_id: int | None
    source_url: str
    language: str
    gemini: GeminiClient
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    last_activity_monotonic: float = field(default_factory=time.monotonic)
    chunk_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    summary_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    results: dict[int, ChunkResponse] = field(default_factory=dict)


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
        expired_ids = [
            session_id
            for session_id, record in sessions.items()
            if record.last_activity_monotonic < cutoff
        ]
        for session_id in expired_ids:
            record = sessions.pop(session_id, None)
            if record is not None:
                close_session(record)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.warning("Lecture Memo local access token: %s", settings.local_access_token)
    if settings.mock_gemini:
        logger.warning("MOCK_GEMINI=true: 실제 Gemini API를 호출하지 않습니다.")
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


app = FastAPI(
    title="Lecture Memo Local Relay",
    version="0.2.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)

if settings.allowed_extension_origin:
    allowed_origins = [settings.allowed_extension_origin]
    allowed_origin_regex = None
else:
    allowed_origins = []
    allowed_origin_regex = r"^chrome-extension://[a-p]{32}$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allowed_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > settings.max_request_bytes:
                return JSONResponse(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    content={"detail": "요청 본문이 허용 크기를 초과했습니다."},
                )
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "잘못된 Content-Length입니다."})
    return await call_next(request)


async def authorize(
    origin: Annotated[str | None, Header()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    expected_origin = settings.allowed_extension_origin
    if expected_origin:
        valid_origin = origin == expected_origin
    else:
        valid_origin = bool(origin and re.fullmatch(r"chrome-extension://[a-p]{32}", origin))
    if not valid_origin:
        raise HTTPException(status_code=403, detail="허용되지 않은 확장 프로그램 Origin입니다.")

    scheme, _, token = (authorization or "").partition(" ")
    valid_token = scheme.lower() == "bearer" and hmac.compare_digest(token, settings.local_access_token)
    if not valid_token:
        raise HTTPException(status_code=401, detail="로컬 액세스 토큰이 올바르지 않습니다.")


def get_session(session_id: str) -> SessionRecord:
    record = sessions.get(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    record.last_activity_monotonic = time.monotonic()
    return record


def quota_http_exception(error: GeminiQuotaExhaustedError) -> HTTPException:
    headers = None
    if error.retry_after_seconds:
        headers = {"Retry-After": str(error.retry_after_seconds)}
    return HTTPException(
        status_code=429,
        detail="Gemini API 할당량이 소진되었습니다. 사용량 및 결제 설정을 확인해 주세요.",
        headers=headers,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model=settings.gemini_model,
        mock_mode=settings.mock_gemini,
        chunk_seconds=settings.audio_chunk_seconds,
        chunk_overlap_seconds=settings.audio_chunk_overlap_seconds,
    )


@app.post(
    "/v1/sessions",
    response_model=SessionCreateResponse,
    dependencies=[Depends(authorize)],
)
async def create_session(payload: SessionCreateRequest) -> SessionCreateResponse:
    api_key = payload.gemini_api_key.get_secret_value().strip()
    if not api_key or len(api_key) > 512:
        raise HTTPException(status_code=422, detail="Gemini API 키를 입력해 주세요.")
    try:
        gemini_client = GeminiClient(settings, api_key)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    session_id = str(uuid.uuid4())
    sessions[session_id] = SessionRecord(
        session_id=session_id,
        source_tab_id=payload.source_tab_id,
        source_url=payload.source_url,
        language=payload.language,
        gemini=gemini_client,
    )
    return SessionCreateResponse(session_id=session_id, model=settings.gemini_model)


@app.post(
    "/v1/sessions/{session_id}/chunks",
    response_model=ChunkResponse,
    dependencies=[Depends(authorize)],
)
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
) -> ChunkResponse:
    del video_start_ms, playback_rate
    record = get_session(session_id)
    if capture_end_ms <= capture_start_ms:
        raise HTTPException(status_code=422, detail="capture_end_ms는 시작 시간보다 커야 합니다.")
    duration_ms = capture_end_ms - capture_start_ms
    maximum_duration_ms = (settings.audio_chunk_seconds + 5) * 1000
    if duration_ms > maximum_duration_ms:
        raise HTTPException(
            status_code=422,
            detail=f"오디오 청크 길이는 설정값보다 길 수 없습니다. 최대 {maximum_duration_ms}ms",
        )
    maximum_overlap_ms = settings.audio_chunk_overlap_seconds * 1000
    if overlap_ms > maximum_overlap_ms:
        raise HTTPException(
            status_code=422,
            detail=f"오디오 겹침은 최대 {maximum_overlap_ms}ms입니다.",
        )
    if not mime_type.startswith("audio/webm"):
        raise HTTPException(status_code=415, detail="audio/webm 형식만 허용합니다.")

    async with record.chunk_lock:
        existing = record.results.get(sequence)
        if existing is not None:
            await audio.close()
            return existing

        audio_bytes = await audio.read(settings.max_chunk_bytes + 1)
        await audio.close()
        if not audio_bytes:
            raise HTTPException(status_code=422, detail="오디오 데이터가 비어 있습니다.")
        if len(audio_bytes) > settings.max_chunk_bytes:
            raise HTTPException(status_code=413, detail="오디오 청크가 허용 크기를 초과했습니다.")

        try:
            transcript: TranscriptPayload = await record.gemini.transcribe(
                audio_bytes=audio_bytes,
                mime_type=mime_type.split(";", maxsplit=1)[0],
                sequence=sequence,
                duration_ms=duration_ms,
                overlap_ms=overlap_ms,
            )
        except GeminiQuotaExhaustedError as exc:
            raise quota_http_exception(exc) from exc
        except GeminiInvalidRequestError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=502, detail="Gemini 응답 형식이 올바르지 않습니다.") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Gemini transcription failed for sequence %s", sequence)
            raise HTTPException(status_code=502, detail="Gemini 자막 요청에 실패했습니다.") from exc

        valid_segments = []
        for segment in transcript.segments:
            if segment.relative_end_ms < segment.relative_start_ms:
                continue
            if segment.relative_end_ms > duration_ms:
                segment = segment.model_copy(update={"relative_end_ms": duration_ms})
            valid_segments.append(segment)

        response = ChunkResponse(
            session_id=session_id,
            sequence=sequence,
            segments=valid_segments,
        )
        record.results[sequence] = response
        return response


async def create_summary(session_id: str, kind: str, payload: SummaryRequest) -> SummaryResponse:
    record = get_session(session_id)
    async with record.summary_lock:
        try:
            return await record.gemini.summarize(
                kind=kind,
                previous_summary=payload.previous_summary,
                transcript=payload.transcript,
                bookmarks=payload.bookmarks,
            )
        except GeminiQuotaExhaustedError as exc:
            raise quota_http_exception(exc) from exc
        except GeminiInvalidRequestError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=502, detail="Gemini 요약 응답 형식이 올바르지 않습니다.") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Gemini summary failed for session %s", session_id)
            raise HTTPException(status_code=502, detail="Gemini 요약 요청에 실패했습니다.") from exc


@app.post(
    "/v1/sessions/{session_id}/summaries/intermediate",
    response_model=SummaryResponse,
    dependencies=[Depends(authorize)],
)
async def intermediate_summary(session_id: str, payload: SummaryRequest) -> SummaryResponse:
    return await create_summary(session_id, "중간", payload)


@app.post(
    "/v1/sessions/{session_id}/summaries/final",
    response_model=SummaryResponse,
    dependencies=[Depends(authorize)],
)
async def final_summary(session_id: str, payload: SummaryRequest) -> SummaryResponse:
    return await create_summary(session_id, "최종", payload)


@app.delete(
    "/v1/sessions/{session_id}",
    dependencies=[Depends(authorize)],
)
async def delete_session(session_id: str) -> dict[str, bool]:
    record = get_session(session_id)
    sessions.pop(session_id, None)
    close_session(record)
    return {"deleted": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.app:app", host="127.0.0.1", port=8050, reload=False)
