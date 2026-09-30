from __future__ import annotations

import asyncio
import os
from datetime import timedelta
from types import SimpleNamespace

import pytest


os.environ["APP_AUTH_MODE"] = "local"
os.environ["LOCAL_ACCESS_TOKEN"] = "test-token"
os.environ["MOCK_OPENAI"] = "true"
os.environ["MONGODB_REQUIRED"] = "false"
os.environ["MONGODB_URI"] = ""
os.environ["ALLOWED_EXTENSION_ORIGINS"] = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
os.environ["AUDIO_CHUNK_SECONDS"] = "15"
os.environ["AUDIO_CHUNK_OVERLAP_SECONDS"] = "1"
os.environ["MAX_CHUNK_BYTES"] = "2000000"
os.environ["MAX_REQUEST_BYTES"] = "2500000"
os.environ["OPENAI_TRANSCRIBE_MODEL"] = "gpt-transcribe"
os.environ["OPENAI_TEXT_MODEL"] = "gpt-6-luna"

from fastapi.testclient import TestClient  # noqa: E402

from server.app import _absolute_segments, _provider_error, _source_metadata, _trim_repeated_prefix, app, auth_failures, gateway, sessions, settings, store  # noqa: E402
from server.openai_client import OpenAIGateway, OpenAIInvalidResponseError, OpenAIQuotaExhaustedError, OpenAIUnavailableError, TranscriptionResult  # noqa: E402
from server.schemas import SummaryResponse, TranscriptPayload, TranscriptSegment  # noqa: E402
from server.settings import Settings  # noqa: E402
from server.storage import utcnow  # noqa: E402


ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEADERS = {"Origin": ORIGIN, "Authorization": "Bearer test-token", "X-User-ID": "local"}
SESSION_PAYLOAD = {
    "source_tab_id": 1,
    "source_url": "https://example.com/lecture",
    "source_title": "강의",
    "language": "ko",
}


@pytest.fixture(autouse=True)
def reset_memory_store():
    asyncio.run(store.clear())
    sessions.clear()
    auth_failures.clear()
    yield
    sessions.clear()
    auth_failures.clear()
    asyncio.run(store.clear())


def test_transcription_model_requires_gpt_transcribe() -> None:
    with pytest.raises(ValueError, match="OPENAI_TRANSCRIBE_MODEL은 gpt-transcribe여야 합니다"):
        Settings(openai_transcribe_model="whisper-1")


def test_gpt_transcription_uses_coarse_timestamp_and_korean_language() -> None:
    calls = []

    async def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(text="한국어 강의와 API 설명", languages=[{"code": "ko"}, {"code": "en"}], model="gpt-transcribe", id="req-1", usage=None)

    client_gateway = object.__new__(OpenAIGateway)
    client_gateway.settings = Settings(mock_openai=False, openai_api_key="test", safety_identifier_secret="test")
    client_gateway.client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    result = asyncio.run(client_gateway.transcribe(audio_bytes=b"audio", mime_type="audio/webm", sequence=0, duration_ms=15_000, safety_identifier="test"))

    assert calls[0]["model"] == "gpt-transcribe"
    assert calls[0]["extra_body"] == {"languages": ["ko", "en"]}
    assert "response_format" not in calls[0]
    assert "timestamp_granularities" not in calls[0]
    assert result.language == "ko"
    assert [(item.relative_start_ms, item.relative_end_ms, item.uncertain) for item in result.transcript.segments] == [(0, 15_000, True)]


def test_gpt_transcription_missing_text_is_retryable_provider_error() -> None:
    async def create(**_kwargs):
        return SimpleNamespace(languages=[{"code": "ko"}])

    client_gateway = object.__new__(OpenAIGateway)
    client_gateway.settings = Settings(mock_openai=False, openai_api_key="test", safety_identifier_secret="test")
    client_gateway.client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    with pytest.raises(OpenAIInvalidResponseError):
        asyncio.run(client_gateway.transcribe(audio_bytes=b"audio", mime_type="audio/webm", sequence=0, duration_ms=15_000, safety_identifier="test"))


def test_gpt_transcription_rejects_malformed_languages() -> None:
    async def create(**_kwargs):
        return SimpleNamespace(text="강의 내용", languages="ko")

    client_gateway = object.__new__(OpenAIGateway)
    client_gateway.settings = Settings(mock_openai=False, openai_api_key="test", safety_identifier_secret="test")
    client_gateway.client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
    with pytest.raises(OpenAIInvalidResponseError):
        asyncio.run(client_gateway.transcribe(audio_bytes=b"audio", mime_type="audio/webm", sequence=0, duration_ms=15_000, safety_identifier="test"))


def test_chunk_boundary_text_is_trimmed_conservatively() -> None:
    assert _trim_repeated_prefix("오늘은 피리워드 설계 설명합니다", "설계 설명합니다 다음 단계입니다") == "다음 단계입니다"
    assert _trim_repeated_prefix("오늘은 API", "API 문서를 봅니다") == "API 문서를 봅니다"
    assert _trim_repeated_prefix("다음 단계입니다", "다음 단계입니다") == "다음 단계입니다"


def create_session(client: TestClient) -> str:
    response = client.post("/v1/sessions", headers=HEADERS, json=SESSION_PAYLOAD)
    assert response.status_code == 200
    return response.json()["session_id"]


def upload_chunk(client: TestClient, session_id: str, sequence: int = 0, audio_signal_status: str = "unknown"):
    return client.post(
        f"/v1/sessions/{session_id}/chunks",
        headers=HEADERS,
        data={
            "sequence": str(sequence),
            "capture_start_ms": str(sequence * 14_000),
            "capture_end_ms": str(sequence * 14_000 + 15_000),
            "video_start_ms": str(sequence * 14_000),
            "playback_rate": "1.0",
            "overlap_ms": "0" if sequence == 0 else "1000",
            "audio_signal_status": audio_signal_status,
            "mime_type": "audio/webm;codecs=opus",
        },
        files={"audio": (f"chunk-{sequence}.webm", b"webm-test-data", "audio/webm")},
    )


def test_health_chunk_ack_and_archive_flow() -> None:
    with TestClient(app) as client:
        health = client.get("/health/ready")
        assert health.status_code == 200
        assert health.json()["storage"] == "memory"
        assert health.json()["model"] == "gpt-6-luna"
        assert health.json()["transcription_model"] == "gpt-transcribe"
        assert health.json()["chunk_seconds"] == 15
        assert health.json()["chunk_overlap_seconds"] == 1
        assert health.json()["max_chunk_bytes"] >= 1_000_000

        session_id = create_session(client)
        first = upload_chunk(client, session_id)
        assert first.status_code == 200
        assert first.json()["acked"] is True
        assert first.json()["segments"][0]["text"] == "[모의 자막] 청크 0"

        partials = client.get("/v1/documents", headers=HEADERS)
        assert partials.status_code == 200
        assert partials.json()["items"][0]["status"] == "incomplete"
        document_id = partials.json()["items"][0]["document_id"]
        detail = client.get(f"/v1/documents/{document_id}", headers=HEADERS)
        assert detail.json()["transcript"]["segments"][0]["sequence"] == 0

        duplicate = upload_chunk(client, session_id)
        assert duplicate.status_code == 200
        assert duplicate.json() == first.json()

        archived = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={"source_title": "강의", "bookmarks": [], "duration_ms": 15_000, "expected_chunk_count": 1},
        )
        assert archived.status_code == 200
        assert archived.json()["saved"] is True
        assert archived.json()["status"] == "completed"
        assert "모의" in archived.json()["summary"]["summary"]

        repeated = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={"source_title": "강의", "bookmarks": [], "duration_ms": 15_000, "expected_chunk_count": 1},
        )
        assert repeated.status_code == 200
        assert repeated.json()["document_id"] == archived.json()["document_id"]


def test_new_chunks_append_to_partial_document_without_full_rebuild(monkeypatch) -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id, 0).status_code == 200

        async def no_full_scan(*_args):
            raise AssertionError("후속 청크에서 전체 청크를 다시 조회했습니다")

        monkeypatch.setattr(store, "list_chunks", no_full_scan)
        second = upload_chunk(client, session_id, 1)
        assert second.status_code == 200
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["transcript"]["ready_chunk_count"] == 2
        assert document["transcript"]["last_applied_sequence"] == 1
        assert len(document["transcript"]["segments"]) == 2
        assert document["transcript"]["text"] == "[모의 자막] 청크 0\n[모의 자막] 청크 1"


def test_overlapping_words_are_removed_before_chunk_ack(monkeypatch) -> None:
    phrases = ["오늘은 데이터베이스 설계를 설명합니다", "설계를 설명합니다 다음은 인덱스입니다"]

    async def transcribe(**kwargs):
        text = phrases[kwargs["sequence"]]
        return TranscriptionResult(
            transcript=TranscriptPayload(segments=[TranscriptSegment(relative_start_ms=0, relative_end_ms=kwargs["duration_ms"], text=text, original_text=text, uncertain=True)]),
            language="ko", original_text=text, provider_request_id=None, resolved_model="gpt-transcribe", usage={},
        )

    monkeypatch.setattr(gateway, "transcribe", transcribe)
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id, 0).status_code == 200
        second = upload_chunk(client, session_id, 1)
        assert second.status_code == 200
        assert second.json()["segments"][0]["text"] == "다음은 인덱스입니다"
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["transcript"]["text"] == "오늘은 데이터베이스 설계를 설명합니다\n다음은 인덱스입니다"
        assert asyncio.run(store.get_chunk("local", session_id, 1))["timestamp_uncertain"] is True


def test_quiet_empty_transcript_is_acked_without_extra_request(monkeypatch) -> None:
    calls = []

    async def transcribe(**kwargs):
        calls.append(kwargs)
        return TranscriptionResult(transcript=TranscriptPayload(segments=[]), language="unknown", original_text="", provider_request_id=None, resolved_model="gpt-transcribe", usage={})

    monkeypatch.setattr(gateway, "transcribe", transcribe)
    with TestClient(app) as client:
        session_id = create_session(client)
        response = upload_chunk(client, session_id, audio_signal_status="quiet")
        assert response.status_code == 200
        assert response.json()["segments"] == []
        assert len(calls) == 1
        saved = asyncio.run(store.get_chunk("local", session_id, 0))
        assert saved["silence_confirmed"] is True
        assert saved["audio_signal_status"] == "quiet"
        assert asyncio.run(store.get_document_for_session("local", session_id))["transcript"]["ready_chunk_count"] == 1


def test_non_silent_empty_transcript_retries_once_and_counts_both_calls(monkeypatch) -> None:
    calls = []

    async def transcribe(**kwargs):
        calls.append(kwargs)
        text = "복구된 자막" if len(calls) == 2 else ""
        segments = [TranscriptSegment(relative_start_ms=0, relative_end_ms=kwargs["duration_ms"], text=text, original_text=text, uncertain=True)] if text else []
        return TranscriptionResult(transcript=TranscriptPayload(segments=segments), language="ko", original_text=text, provider_request_id=None, resolved_model="gpt-transcribe", usage={})

    monkeypatch.setattr(gateway, "transcribe", transcribe)
    with TestClient(app) as client:
        session_id = create_session(client)
        response = upload_chunk(client, session_id, audio_signal_status="non_silent")
        assert response.status_code == 200
        assert response.json()["segments"][0]["text"] == "복구된 자막"
        assert len(calls) == 2
        usage = store.daily_usage[("local", utcnow().date().isoformat())]
        assert usage["audio_ms"] == 30_000
        assert usage["transcription_requests"] == 2


def test_unknown_empty_transcript_blocks_without_ack(monkeypatch) -> None:
    calls = []

    async def transcribe(**kwargs):
        calls.append(kwargs)
        return TranscriptionResult(transcript=TranscriptPayload(segments=[]), language="unknown", original_text="", provider_request_id=None, resolved_model="gpt-transcribe", usage={})

    monkeypatch.setattr(gateway, "transcribe", transcribe)
    with TestClient(app) as client:
        session_id = create_session(client)
        response = upload_chunk(client, session_id)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "empty_transcript_unverified"
        assert response.json()["error"]["retryable"] is False
        assert len(calls) == 2
        saved = asyncio.run(store.get_chunk("local", session_id, 0))
        assert saved["status"] == "blocked"
        assert asyncio.run(store.get_document_for_session("local", session_id)) is None
        assert store.daily_usage[("local", utcnow().date().isoformat())]["transcription_requests"] == 2


def test_legacy_bookmarks_are_ignored_but_existing_document_field_is_preserved() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        archived = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={
                "source_title": "호환성 강의",
                "bookmarks": [{"timestamp_ms": 1234, "memo": "legacy-only"}],
                "duration_ms": 15_000,
                "expected_chunk_count": 1,
            },
        )
        assert archived.status_code == 200
        document_id = archived.json()["document_id"]
        saved = asyncio.run(store.get_document_for_session("local", session_id))
        assert "bookmarks" not in saved
        assert saved["summary_provider"]["prompt_version"] == "summary-v2"

        legacy_field = [{"timestamp_ms": 1234, "memo": "keep-this-existing-atlas-value"}]
        asyncio.run(store.upsert_document({**saved, "bookmarks": legacy_field}))
        detail = client.get(f"/v1/documents/{document_id}", headers=HEADERS)
        assert detail.status_code == 200
        assert "bookmarks" not in detail.json()
        preserved = asyncio.run(store.get_document_for_session("local", session_id))
        assert preserved["bookmarks"] == legacy_field


def test_source_url_is_canonicalized_without_sensitive_query() -> None:
    payload = {**SESSION_PAYLOAD, "source_url": "https://viewer:password@www.youtube.com/watch?v=abc&utm_source=x&token=secret&session=private&fbclid=tracker#frag"}
    with TestClient(app) as client:
        created = client.post("/v1/sessions", headers=HEADERS, json=payload)
        assert created.status_code == 200
        draft = asyncio.run(store.get_session("local", created.json()["session_id"]))
        assert draft["canonical_url"] == "https://www.youtube.com/watch?v=abc"
        assert draft["source_url"] == draft["canonical_url"]
        assert draft["source_video_id"] == "abc"
        assert upload_chunk(client, created.json()["session_id"]).status_code == 200
        document = asyncio.run(store.get_document_for_session("local", created.json()["session_id"]))
        assert document["source"]["url"] == draft["canonical_url"]
        assert "private" not in str(document)


def test_unknown_site_query_is_not_persisted() -> None:
    payload = {**SESSION_PAYLOAD, "source_url": "https://example.com/lecture?session=private&course=123#part"}
    with TestClient(app) as client:
        session_id = client.post("/v1/sessions", headers=HEADERS, json=payload).json()["session_id"]
        draft = asyncio.run(store.get_session("local", session_id))
        assert draft["source_url"] == "https://example.com/lecture"


def test_existing_source_urls_are_scrubbed() -> None:
    raw = "https://example.com/lecture?session=private#part"
    store.sessions[("local", "old")] = {"owner_id": "local", "session_id": "old", "source_url": raw}
    store.documents[("local", "old")] = {"owner_id": "local", "session_id": "old", "source": {"url": raw}}
    asyncio.run(store.scrub_source_urls(_source_metadata))
    assert store.sessions[("local", "old")]["source_url"] == "https://example.com/lecture"
    assert store.documents[("local", "old")]["source"]["url"] == "https://example.com/lecture"


def test_sequence_gap_is_structured_and_original_can_be_kept() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        response = upload_chunk(client, session_id, sequence=1)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "sequence_gap"
        assert response.json()["error"]["action"] == "retry_in_order"


def test_incomplete_archive_is_saved_without_summary() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id, sequence=0).status_code == 200
        response = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={"source_title": "강의", "bookmarks": [], "duration_ms": 120_000, "expected_chunk_count": 2},
        )
        assert response.status_code == 200
        assert response.json()["saved"] is False
        assert response.json()["status"] == "incomplete"
        assert response.json()["missing_sequences"] == [1]


def test_session_can_resume_from_persisted_draft() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        sessions.pop(session_id)

        resumed = client.post(
            f"/v1/sessions/{session_id}/resume",
            headers=HEADERS,
            json={},
        )
        assert resumed.status_code == 200
        assert resumed.json()["resumed"] is True
        assert resumed.json()["next_sequence"] == 1
        assert resumed.json()["segments"][0]["text"] == "[모의 자막] 청크 0"


def test_next_chunk_automatically_restores_session_after_process_restart() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id, 0).status_code == 200
        sessions.clear()
        second = upload_chunk(client, session_id, 1)
        assert second.status_code == 200
        assert second.json()["sequence"] == 1
        assert upload_chunk(client, session_id, 1).status_code == 200
        assert asyncio.run(store.get_session("local", session_id))["next_sequence"] == 2


def test_capture_gap_keeps_document_incomplete_with_partial_summary() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id, 0).status_code == 200
        response = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={"expected_chunk_count": 1, "capture_gaps": [{"start_ms": 60_000, "end_ms": 90_000, "reason": "server_recovery"}]},
        )
        assert response.status_code == 200
        assert response.json()["saved"] is False
        assert response.json()["missing_sequences"] == []
        assert response.json()["missing_time_ranges"][0]["end_ms"] == 90_000
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["status"] == "incomplete"
        assert document["summary_status"] == "completed"
        assert document["summary_scope"] == "partial"
        assert document["summary"]["summary"]
        assert response.json()["summary"]["summary"]
        repeated = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 1})
        assert repeated.status_code == 200
        assert repeated.json()["saved"] is False
        assert repeated.json()["missing_time_ranges"][0]["start_ms"] == 60_000
        assert repeated.json()["summary"]["summary"] == document["summary"]["summary"]


def test_incomplete_document_can_generate_partial_summary_on_retry(monkeypatch) -> None:
    original = gateway.summarize

    async def unavailable(**_kwargs):
        raise OpenAIUnavailableError()

    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        monkeypatch.setattr(gateway, "summarize", unavailable)
        first = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 2})
        assert first.status_code == 200
        assert first.json()["saved"] is False
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["summary_status"] == "failed"
        assert document["summary_error_code"] == "openai_overloaded"

        monkeypatch.setattr(gateway, "summarize", original)
        second = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 2})
        assert second.status_code == 200
        assert second.json()["saved"] is False
        assert second.json()["summary"]["summary"]
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["summary_status"] == "completed"
        assert document["summary_scope"] == "partial"


def test_incomplete_document_without_transcript_has_no_partial_summary() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        response = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 1})
        assert response.status_code == 200
        assert response.json()["summary"] is None
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["summary_status"] == "not_run"


def test_new_transcript_clears_stale_partial_summary() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id, 0).status_code == 200
        first = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 2})
        assert first.json()["summary"]
        assert upload_chunk(client, session_id, 1).status_code == 200
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["summary"] is None
        assert document["summary_scope"] is None


def test_resume_clears_incomplete_ttl_from_session_and_chunks() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        incomplete = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={"source_title": "강의", "bookmarks": [], "duration_ms": 120_000, "expected_chunk_count": 2},
        )
        assert incomplete.status_code == 200
        assert "expire_at" in asyncio.run(store.get_session("local", session_id))
        assert "expire_at" in asyncio.run(store.get_chunk("local", session_id, 0))

        resumed = client.post(
            f"/v1/sessions/{session_id}/resume",
            headers=HEADERS,
            json={},
        )
        assert resumed.status_code == 200
        assert "expire_at" not in asyncio.run(store.get_session("local", session_id))
        assert "expire_at" not in asyncio.run(store.get_chunk("local", session_id, 0))


def test_resume_rejects_missing_ready_chunk_without_clearing_ttl() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        assert client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 2}).status_code == 200
        asyncio.run(store.release_user_lease("local"))
        store.chunks.pop(("local", session_id, 0))
        resumed = client.post(f"/v1/sessions/{session_id}/resume", headers=HEADERS, json={})
        assert resumed.status_code == 409
        assert resumed.json()["error"]["code"] == "session_resume_incomplete"
        assert "expire_at" in asyncio.run(store.get_session("local", session_id))
        assert "active-user:local" not in store.service_state


def test_deleting_draft_expires_resume_but_keeps_partial_document() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        document_id = asyncio.run(store.get_document_for_session("local", session_id))["document_id"]
        deleted = client.delete(f"/v1/sessions/{session_id}", headers=HEADERS)
        assert deleted.status_code == 200
        assert asyncio.run(store.get_session("local", session_id)) is None
        assert asyncio.run(store.get_chunk("local", session_id, 0)) is None
        detail = client.get(f"/v1/documents/{document_id}", headers=HEADERS).json()
        assert detail["resume_status"] == "expired"
        assert detail["transcript"]["ready_chunk_count"] == 1


def test_request_size_middleware_returns_structured_error() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/sessions",
            headers={**HEADERS, "Content-Length": str(200_000_000)},
            content=b"{}",
        )
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "payload_too_large"


def test_rejects_bad_token_and_does_not_echo_key() -> None:
    marker = "secret-marker-" + ("x" * 600)
    with TestClient(app) as client:
        bad_auth = client.post(
            "/v1/sessions",
            headers={"Origin": ORIGIN, "Authorization": "Bearer wrong"},
            json=SESSION_PAYLOAD,
        )
        assert bad_auth.status_code == 401
        assert bad_auth.json()["error"]["code"] == "authentication_failed"

        oversized = client.post("/v1/sessions", headers=HEADERS, json={"source_url": marker * 10})
        assert oversized.status_code == 422
        assert marker not in oversized.text


def test_quota_and_congestion_use_structured_errors(monkeypatch) -> None:
    async def raise_quota(**_kwargs):
        raise OpenAIQuotaExhaustedError(retry_after_seconds=22)

    async def raise_unavailable(**_kwargs):
        raise OpenAIUnavailableError(retry_after_seconds=5)

    with TestClient(app) as client:
        quota_session = create_session(client)
        monkeypatch.setattr(gateway, "transcribe", raise_quota)
        quota = upload_chunk(client, quota_session)
        assert quota.status_code == 429
        assert quota.headers["retry-after"] == "22"
        assert quota.json()["error"]["code"] == "openai_quota_exhausted"
        assert quota.json()["error"]["retryable"] is False

        busy_session = create_session(client)
        monkeypatch.setattr(gateway, "transcribe", raise_unavailable)
        busy = upload_chunk(client, busy_session)
        assert busy.status_code == 503
        assert busy.headers["retry-after"] == "5"
        assert busy.json()["error"]["code"] == "openai_overloaded"
        assert busy.json()["error"]["retryable"] is True


def test_multi_user_authentication_and_session_ownership() -> None:
    previous_mode = settings.app_auth_mode
    previous_users = settings.app_users
    object.__setattr__(settings, "app_auth_mode", "multi_user")
    import hashlib
    object.__setattr__(settings, "app_users", {"user-001": hashlib.sha256(b"token-one").hexdigest(), "user-002": hashlib.sha256(b"token-two").hexdigest()})
    first_headers = {"Origin": ORIGIN, "Authorization": "Bearer token-one", "X-User-ID": "user-001"}
    second_headers = {"Origin": ORIGIN, "Authorization": "Bearer token-two", "X-User-ID": "user-002"}
    try:
        with TestClient(app) as client:
            created = client.post("/v1/sessions", headers=first_headers, json=SESSION_PAYLOAD)
            assert created.status_code == 200
            session_id = created.json()["session_id"]

            wrong_pair = client.post(
                "/v1/sessions",
                headers={"Origin": ORIGIN, "Authorization": "Bearer token-one", "X-User-ID": "user-002"},
                json=SESSION_PAYLOAD,
            )
            assert wrong_pair.status_code == 401

            foreign = client.post(
                f"/v1/sessions/{session_id}/resume",
                headers=second_headers,
                json={},
            )
            assert foreign.status_code == 404
            assert foreign.json()["error"]["code"] == "session_not_found"
    finally:
        object.__setattr__(settings, "app_auth_mode", previous_mode)
        object.__setattr__(settings, "app_users", previous_users)


def test_atlas_accounts_work_from_any_extension_and_can_be_revoked() -> None:
    previous_mode = settings.app_auth_mode
    previous_admin = settings.admin_access_token
    previous_users = settings.app_users
    object.__setattr__(settings, "app_auth_mode", "atlas_users")
    object.__setattr__(settings, "admin_access_token", "a" * 40)
    object.__setattr__(settings, "app_users", {})
    admin = {"X-Admin-Token": "a" * 40}
    try:
        with TestClient(app) as client:
            assert client.post("/v1/admin/users", json={"user_id": "user-001"}).status_code == 401
            created = client.post("/v1/admin/users", headers=admin, json={"user_id": "user-001"})
            assert created.status_code == 200
            code = created.json()["access_code"]
            assert len(code) >= 40
            assert client.post("/v1/admin/users", headers=admin, json={"user_id": "user-001"}).status_code == 409
            listed = client.get("/v1/admin/users", headers=admin).json()["users"]
            assert listed[0]["user_id"] == "user-001"
            assert "token_hash" not in listed[0] and "access_code" not in listed[0]
            import hashlib
            imported = client.post("/v1/admin/users/import", headers=admin, json={"user_id": "existing", "token_sha256": hashlib.sha256(b"existing-code").hexdigest()})
            assert imported.status_code == 200
            assert client.get("/v1/documents", headers={"X-User-ID": "existing", "Authorization": "Bearer existing-code"}).status_code == 200

            first = {"Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "X-User-ID": "user-001", "Authorization": f"Bearer {code}"}
            second = {**first, "Origin": "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
            assert client.post("/v1/sessions", headers=first, json=SESSION_PAYLOAD).status_code == 200
            assert client.get("/v1/documents", headers=second).status_code == 200
            assert client.get("/v1/documents", headers={**second, "Origin": "https://example.com"}).status_code == 403

            assert client.post("/v1/admin/users/user-001/disable", headers=admin).status_code == 200
            assert client.get("/v1/documents", headers=first).status_code == 401
            assert client.post("/v1/admin/users/user-001/enable", headers=admin).status_code == 200
            assert client.get("/v1/documents", headers=second).status_code == 200
            rotated = client.post("/v1/admin/users/user-001/rotate", headers=admin)
            assert rotated.status_code == 200
            assert client.get("/v1/documents", headers=first).status_code == 401
            assert client.get("/v1/documents", headers={**second, "Authorization": f"Bearer {rotated.json()['access_code']}"}).status_code == 200
    finally:
        object.__setattr__(settings, "app_auth_mode", previous_mode)
        object.__setattr__(settings, "admin_access_token", previous_admin)
        object.__setattr__(settings, "app_users", previous_users)


def test_atlas_mode_imports_existing_hashes_and_limits_failed_logins() -> None:
    import hashlib

    previous_mode = settings.app_auth_mode
    previous_admin = settings.admin_access_token
    previous_users = settings.app_users
    object.__setattr__(settings, "app_auth_mode", "atlas_users")
    object.__setattr__(settings, "admin_access_token", "a" * 40)
    object.__setattr__(settings, "app_users", {"existing": hashlib.sha256(b"old-code").hexdigest()})
    try:
        with TestClient(app) as client:
            headers = {"Origin": ORIGIN, "X-User-ID": "existing", "Authorization": "Bearer old-code"}
            assert client.get("/v1/documents", headers=headers).status_code == 200
            bad = {**headers, "Authorization": "Bearer invalid"}
            for _ in range(5):
                assert client.get("/v1/documents", headers=bad).status_code == 401
            limited = client.get("/v1/documents", headers=headers)
            assert limited.status_code == 429
            assert limited.json()["error"]["code"] == "authentication_rate_limited"
            assert limited.headers["retry-after"] == "60"
    finally:
        object.__setattr__(settings, "app_auth_mode", previous_mode)
        object.__setattr__(settings, "admin_access_token", previous_admin)
        object.__setattr__(settings, "app_users", previous_users)


def test_ready_chunk_retry_repairs_partial_document_before_ack(monkeypatch) -> None:
    original = store.upsert_document
    failed = False

    async def fail_once(value):
        nonlocal failed
        if not failed:
            failed = True
            raise RuntimeError("temporary document write failure")
        return await original(value)

    with TestClient(app, raise_server_exceptions=False) as client:
        session_id = create_session(client)
        monkeypatch.setattr(store, "upsert_document", fail_once)
        first = upload_chunk(client, session_id)
        assert first.status_code == 500
        assert (asyncio.run(store.get_chunk("local", session_id, 0)) or {})["status"] == "ready"

        second = upload_chunk(client, session_id)
        assert second.status_code == 200
        assert second.json()["acked"] is True
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["transcript"]["ready_chunk_count"] == 1


def test_ready_chunk_retry_repairs_sequence_after_interrupted_session_update(monkeypatch) -> None:
    original = store.update_session
    failed = False

    async def fail_once(owner_id, session_id, values):
        nonlocal failed
        if not failed and values.get("next_sequence") == 1:
            failed = True
            raise RuntimeError("temporary session write failure")
        return await original(owner_id, session_id, values)

    with TestClient(app, raise_server_exceptions=False) as client:
        session_id = create_session(client)
        monkeypatch.setattr(store, "update_session", fail_once)
        assert upload_chunk(client, session_id).status_code == 500
        assert upload_chunk(client, session_id).status_code == 200
        assert (asyncio.run(store.get_session("local", session_id)) or {})["next_sequence"] == 1
        assert upload_chunk(client, session_id, sequence=1).status_code == 200


def test_completed_document_is_written_with_summary_in_same_update(monkeypatch) -> None:
    original = store.upsert_document
    completed_writes = []

    async def inspect_write(value):
        if value.get("status") == "completed":
            completed_writes.append(value)
            assert value["summary"]["summary"]
            assert value["summary_status"] == "completed"
        return await original(value)

    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        monkeypatch.setattr(store, "upsert_document", inspect_write)
        response = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 1})
        assert response.status_code == 200
        assert len(completed_writes) == 1


def test_blank_summary_is_rejected() -> None:
    for value in ("", "  \n  "):
        with pytest.raises(ValueError):
            SummaryResponse(summary=value, concepts=[], terms=[], highlights=[], checklist=[])


def test_provider_timeout_is_retryable() -> None:
    assert isinstance(gateway._map_error(TimeoutError()), OpenAIUnavailableError)


def test_invalid_provider_response_is_retryable() -> None:
    error = _provider_error(OpenAIInvalidResponseError("빈 요약"))
    assert error.status_code == 502
    assert error.retryable is True


def test_summary_failure_is_recorded_and_archive_can_retry(monkeypatch) -> None:
    original = gateway.summarize

    async def unavailable(**_kwargs):
        raise OpenAIUnavailableError()

    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        monkeypatch.setattr(gateway, "summarize", unavailable)
        failed = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 1})
        assert failed.status_code == 503
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["status"] == "finalize_pending"
        assert document["summary_status"] == "failed"
        assert document["summary_error_code"] == "openai_overloaded"

        monkeypatch.setattr(gateway, "summarize", original)
        recovered = client.post(f"/v1/sessions/{session_id}/archive", headers=HEADERS, json={"expected_chunk_count": 1})
        assert recovered.status_code == 200
        assert recovered.json()["saved"] is True
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert document["summary_status"] == "completed"
        assert document["summary_error_code"] is None


def test_reconcile_expires_stale_session_after_restart() -> None:
    with TestClient(app) as client:
        session_id = create_session(client)
        assert upload_chunk(client, session_id).status_code == 200
        sessions.pop(session_id)
        store.sessions[("local", session_id)]["updated_at"] = utcnow() - timedelta(seconds=settings.session_idle_ttl_seconds + 1)
        listed = client.get("/v1/documents", headers=HEADERS)
        assert listed.status_code == 200
        draft = asyncio.run(store.get_session("local", session_id))
        document = asyncio.run(store.get_document_for_session("local", session_id))
        assert draft["status"] == "incomplete"
        assert draft["expire_at"] > utcnow()
        assert document["resume_available_until"] == draft["expire_at"]


def test_old_chunk_attempt_cannot_overwrite_new_attempt() -> None:
    async def check() -> None:
        now = utcnow()
        first = {"owner_id": "local", "session_id": "s", "sequence": 0, "audio_sha256": "hash", "attempt_id": "first", "lease_until": now - timedelta(seconds=1)}
        second = {**first, "attempt_id": "second", "lease_until": now + timedelta(seconds=60)}
        assert (await store.claim_chunk(first, now))[0] == "claimed"
        assert (await store.claim_chunk(second, now))[0] == "claimed"
        assert await store.finish_chunk(first, {"status": "ready", "segments": []}) is False
        assert await store.finish_chunk(second, {"status": "ready", "segments": []}) is True
        assert (await store.get_chunk("local", "s", 0))["attempt_id"] == "second"

    asyncio.run(check())


def test_document_timestamps_follow_playback_rate() -> None:
    chunks = [{"sequence": 0, "media_start_ms": 10_000, "playback_rate": 1.5, "overlap_ms": 0, "segments": [{"relative_start_ms": 2_000, "relative_end_ms": 4_000, "text": "자막"}]}]
    result = _absolute_segments(chunks)
    assert (result[0]["start_ms"], result[0]["end_ms"]) == (13_000, 16_000)
