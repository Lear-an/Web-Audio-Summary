from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    status: str
    model: str
    transcription_model: str
    mock_mode: bool
    storage: str
    chunk_seconds: int
    chunk_overlap_seconds: int
    max_chunk_bytes: int
    max_request_bytes: int
    max_concurrent_users: int


class SessionCreateRequest(BaseModel):
    source_tab_id: int | None = None
    source_url: str = Field(default="", max_length=4096)
    source_title: str = Field(default="", max_length=1000)
    language: str = Field(default="auto", min_length=2, max_length=16)


class SessionResumeRequest(BaseModel):
    pass


class SessionCreateResponse(BaseModel):
    session_id: str
    document_id: str
    model: str
    resumed: bool = False
    next_sequence: int = 0
    segments: list[dict[str, Any]] = Field(default_factory=list)


class TranscriptSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    relative_start_ms: int = Field(ge=0)
    relative_end_ms: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=4000)
    original_text: str | None = Field(max_length=4000)
    uncertain: bool


class TranscriptPayload(BaseModel):
    segments: list[TranscriptSegment] = Field(default_factory=list, max_length=500)


class TranslationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str = Field(max_length=32)
    translated: bool
    segments: list[TranscriptSegment] = Field(max_length=500)
    warnings: list[str] = Field(max_length=20)


class ChunkResponse(BaseModel):
    session_id: str
    sequence: int
    segments: list[TranscriptSegment]
    acked: bool = True


class SummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(max_length=8000)
    concepts: list[str] = Field(max_length=100)
    terms: list[str] = Field(max_length=100)
    highlights: list[str] = Field(max_length=100)
    checklist: list[str] = Field(max_length=100)


class ArchiveRequest(BaseModel):
    source_title: str = Field(default="", max_length=1000)
    bookmarks: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)
    duration_ms: int = Field(default=0, ge=0)
    expected_chunk_count: int = Field(default=0, ge=0)


class ArchiveResponse(BaseModel):
    saved: bool
    status: str
    document_id: str | None = None
    chunk_count: int
    missing_sequences: list[int] = Field(default_factory=list)
    summary: SummaryResponse | None = None


class DocumentListResponse(BaseModel):
    items: list[dict[str, Any]]
    next_cursor: str | None = None
