from __future__ import annotations

import asyncio
import os

import pytest


os.environ["APP_AUTH_MODE"] = "local"
os.environ["LOCAL_ACCESS_TOKEN"] = "test-token"
os.environ["MOCK_OPENAI"] = "true"
os.environ["MONGODB_REQUIRED"] = "false"
os.environ["MONGODB_URI"] = ""
os.environ["ALLOWED_EXTENSION_ORIGINS"] = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
os.environ["AUDIO_CHUNK_SECONDS"] = "60"
os.environ["AUDIO_CHUNK_OVERLAP_SECONDS"] = "2"
os.environ["MAX_CHUNK_BYTES"] = "2000000"
os.environ["MAX_REQUEST_BYTES"] = "2500000"

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app, gateway, sessions, settings, store  # noqa: E402
from server.openai_client import OpenAIQuotaExhaustedError, OpenAIUnavailableError  # noqa: E402


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
    yield
    sessions.clear()
    asyncio.run(store.clear())


def create_session(client: TestClient) -> str:
    response = client.post("/v1/sessions", headers=HEADERS, json=SESSION_PAYLOAD)
    assert response.status_code == 200
    return response.json()["session_id"]


def upload_chunk(client: TestClient, session_id: str, sequence: int = 0):
    return client.post(
        f"/v1/sessions/{session_id}/chunks",
        headers=HEADERS,
        data={
            "sequence": str(sequence),
            "capture_start_ms": str(sequence * 58_000),
            "capture_end_ms": str(sequence * 58_000 + 60_000),
            "video_start_ms": str(sequence * 58_000),
            "playback_rate": "1.0",
            "overlap_ms": "0" if sequence == 0 else "2000",
            "mime_type": "audio/webm;codecs=opus",
        },
        files={"audio": (f"chunk-{sequence}.webm", b"webm-test-data", "audio/webm")},
    )


def test_health_chunk_ack_and_archive_flow() -> None:
    with TestClient(app) as client:
        health = client.get("/health/ready")
        assert health.status_code == 200
        assert health.json()["storage"] == "memory"
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
            json={"source_title": "강의", "bookmarks": [], "duration_ms": 60_000, "expected_chunk_count": 1},
        )
        assert archived.status_code == 200
        assert archived.json()["saved"] is True
        assert archived.json()["status"] == "completed"
        assert "모의" in archived.json()["summary"]["summary"]

        repeated = client.post(
            f"/v1/sessions/{session_id}/archive",
            headers=HEADERS,
            json={"source_title": "강의", "bookmarks": [], "duration_ms": 60_000, "expected_chunk_count": 1},
        )
        assert repeated.status_code == 200
        assert repeated.json()["document_id"] == archived.json()["document_id"]


def test_source_url_is_canonicalized_without_sensitive_query() -> None:
    payload = {**SESSION_PAYLOAD, "source_url": "https://www.youtube.com/watch?v=abc&utm_source=x&token=secret#frag"}
    with TestClient(app) as client:
        created = client.post("/v1/sessions", headers=HEADERS, json=payload)
        assert created.status_code == 200
        draft = asyncio.run(store.get_session("local", created.json()["session_id"]))
        assert draft["canonical_url"] == "https://www.youtube.com/watch?v=abc"
        assert draft["source_video_id"] == "abc"


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
