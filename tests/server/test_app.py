from __future__ import annotations

import os


os.environ["LOCAL_ACCESS_TOKEN"] = "test-token"
os.environ["MOCK_GEMINI"] = "true"
os.environ["ALLOWED_EXTENSION_ORIGIN"] = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
os.environ["AUDIO_CHUNK_SECONDS"] = "10"
os.environ["AUDIO_CHUNK_OVERLAP_SECONDS"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app, sessions  # noqa: E402
from server.gemini_client import GeminiQuotaExhaustedError  # noqa: E402


ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEADERS = {
    "Origin": ORIGIN,
    "Authorization": "Bearer test-token",
}
SESSION_PAYLOAD = {
    "source_tab_id": 1,
    "source_url": "https://example.com/lecture",
    "language": "ko",
    "gemini_api_key": "test-gemini-key",
}


def test_health_and_mock_transcription_flow() -> None:
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["mock_mode"] is True
        assert health.json()["chunk_seconds"] == 10
        assert health.json()["chunk_overlap_seconds"] == 1

        created = client.post(
            "/v1/sessions",
            headers=HEADERS,
            json=SESSION_PAYLOAD,
        )
        assert created.status_code == 200
        session_id = created.json()["session_id"]

        data = {
            "sequence": "0",
            "capture_start_ms": "0",
            "capture_end_ms": "10000",
            "video_start_ms": "5000",
            "playback_rate": "1.0",
            "overlap_ms": "0",
            "mime_type": "audio/webm;codecs=opus",
        }
        first = client.post(
            f"/v1/sessions/{session_id}/chunks",
            headers=HEADERS,
            data=data,
            files={"audio": ("chunk-0.webm", b"webm-test-data", "audio/webm")},
        )
        assert first.status_code == 200
        assert first.json()["sequence"] == 0
        assert first.json()["segments"][0]["text"] == "[모의 자막] 청크 0"

        duplicate = client.post(
            f"/v1/sessions/{session_id}/chunks",
            headers=HEADERS,
            data=data,
            files={"audio": ("chunk-0.webm", b"different-data", "audio/webm")},
        )
        assert duplicate.status_code == 200
        assert duplicate.json() == first.json()

        summary = client.post(
            f"/v1/sessions/{session_id}/summaries/final",
            headers=HEADERS,
            json={
                "previous_summary": {},
                "transcript": "[00:05] 정규화는 데이터 중복을 줄이는 과정입니다.",
                "bookmarks": [],
            },
        )
        assert summary.status_code == 200
        assert "모의" in summary.json()["summary"]

        deleted = client.delete(f"/v1/sessions/{session_id}", headers=HEADERS)
        assert deleted.status_code == 200
        assert deleted.json() == {"deleted": True}


def test_rejects_bad_token() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/sessions",
            headers={"Origin": ORIGIN, "Authorization": "Bearer wrong"},
            json={"gemini_api_key": "test-gemini-key"},
        )
        assert response.status_code == 401


def test_rejects_missing_gemini_api_key() -> None:
    with TestClient(app) as client:
        response = client.post("/v1/sessions", headers=HEADERS, json={})
        assert response.status_code == 422


def test_rejects_oversized_key_without_echoing_it() -> None:
    oversized_key = "secret-marker-" + ("x" * 600)
    with TestClient(app) as client:
        response = client.post(
            "/v1/sessions",
            headers=HEADERS,
            json={"gemini_api_key": oversized_key},
        )
        assert response.status_code == 422
        assert oversized_key not in response.text


def test_each_session_uses_an_independent_gemini_client() -> None:
    with TestClient(app) as client:
        first = client.post("/v1/sessions", headers=HEADERS, json=SESSION_PAYLOAD)
        second = client.post(
            "/v1/sessions",
            headers=HEADERS,
            json={**SESSION_PAYLOAD, "gemini_api_key": "another-test-key"},
        )
        first_id = first.json()["session_id"]
        second_id = second.json()["session_id"]
        assert sessions[first_id].gemini is not sessions[second_id].gemini


def test_quota_exhaustion_is_returned_as_429(monkeypatch) -> None:
    async def raise_quota(**_kwargs):
        raise GeminiQuotaExhaustedError(retry_after_seconds=22)

    with TestClient(app) as client:
        created = client.post(
            "/v1/sessions",
            headers=HEADERS,
            json=SESSION_PAYLOAD,
        )
        session_id = created.json()["session_id"]
        monkeypatch.setattr(sessions[session_id].gemini, "transcribe", raise_quota)
        response = client.post(
            f"/v1/sessions/{session_id}/chunks",
            headers=HEADERS,
            data={
                "sequence": "0",
                "capture_start_ms": "0",
                "capture_end_ms": "10000",
                "video_start_ms": "0",
                "playback_rate": "1.0",
                "overlap_ms": "0",
                "mime_type": "audio/webm;codecs=opus",
            },
            files={"audio": ("chunk.webm", b"test-data", "audio/webm")},
        )
        assert response.status_code == 429
        assert response.headers["retry-after"] == "22"
        assert "할당량" in response.json()["detail"]
