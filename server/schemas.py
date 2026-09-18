from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, SecretStr


class HealthResponse(BaseModel):
    status: str = "ok"
    model: str
    mock_mode: bool
    chunk_seconds: int
    chunk_overlap_seconds: int


class SessionCreateRequest(BaseModel):
    source_tab_id: int | None = None
    source_url: str = Field(default="", max_length=4096)
    language: str = Field(default="ko", min_length=2, max_length=16)
    gemini_api_key: SecretStr


class SessionCreateResponse(BaseModel):
    session_id: str
    model: str


class SessionApiKeyUpdateRequest(BaseModel):
    gemini_api_key: SecretStr


class TranscriptSegment(BaseModel):
    relative_start_ms: int = Field(ge=0)
    relative_end_ms: int = Field(ge=0)
    text: str = Field(min_length=1, max_length=2000)
    uncertain: bool = False


class TranscriptPayload(BaseModel):
    segments: list[TranscriptSegment] = Field(default_factory=list, max_length=100)


class ChunkResponse(BaseModel):
    session_id: str
    sequence: int
    segments: list[TranscriptSegment]


class SummaryRequest(BaseModel):
    previous_summary: dict[str, Any] = Field(default_factory=dict)
    transcript: str = Field(default="", max_length=200_000)
    bookmarks: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)


class SummaryResponse(BaseModel):
    summary: str = Field(default="", max_length=8000)
    concepts: list[str] = Field(default_factory=list, max_length=100)
    terms: list[str] = Field(default_factory=list, max_length=100)
    highlights: list[str] = Field(default_factory=list, max_length=100)
    checklist: list[str] = Field(default_factory=list, max_length=100)
