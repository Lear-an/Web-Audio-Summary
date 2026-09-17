from __future__ import annotations

from types import SimpleNamespace

from server.gemini_client import GeminiClient
from server.schemas import TranscriptPayload


def test_parse_transcript_json_from_markdown_fence() -> None:
    response = SimpleNamespace(
        parsed=None,
        text='''```json
{"segments":[{"relative_start_ms":0,"relative_end_ms":1000,"text":"테스트","uncertain":false}]}
```''',
    )

    parsed = GeminiClient._parse_model_response(response, TranscriptPayload)

    assert parsed.segments[0].text == "테스트"
    assert parsed.segments[0].relative_end_ms == 1000


def test_parse_transcript_json_surrounded_by_text() -> None:
    response = SimpleNamespace(parsed=None, text='결과: {"segments":[]} 완료')

    parsed = GeminiClient._parse_model_response(response, TranscriptPayload)

    assert parsed.segments == []
