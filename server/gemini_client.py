from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from .schemas import SummaryResponse, TranscriptPayload, TranscriptSegment
from .settings import Settings


class GeminiQuotaExhaustedError(RuntimeError):
    def __init__(self, retry_after_seconds: int | None = None) -> None:
        super().__init__("Gemini API 할당량이 소진되었습니다.")
        self.retry_after_seconds = retry_after_seconds


class GeminiInvalidRequestError(RuntimeError):
    pass


class GeminiUnavailableError(RuntimeError):
    def __init__(self, retry_after_seconds: int = 5) -> None:
        super().__init__("Gemini 모델이 혼잡합니다. 잠시 후 자동으로 다시 시도합니다.")
        self.retry_after_seconds = max(1, retry_after_seconds)


def _quota_retry_after(error: Exception) -> int | None:
    message = str(error)
    code = getattr(error, "code", None)
    is_quota_error = code == 429 or "RESOURCE_EXHAUSTED" in message or "Quota exceeded" in message
    if not is_quota_error:
        return None
    match = re.search(r"retry(?:Delay| in)[^0-9]*(\d+)", message, flags=re.IGNORECASE)
    return int(match.group(1)) if match else 0


def _unavailable_retry_after(error: Exception) -> int | None:
    message = str(error)
    code = getattr(error, "code", None)
    is_unavailable = (
        code == 503
        or "503 UNAVAILABLE" in message
        or "status': 'UNAVAILABLE'" in message
        or "currently experiencing high demand" in message
    )
    if not is_unavailable:
        return None
    match = re.search(r"retry(?:Delay| in)[^0-9]*(\d+)", message, flags=re.IGNORECASE)
    return int(match.group(1)) if match else 5


def _is_invalid_request(error: Exception) -> bool:
    message = str(error)
    return getattr(error, "code", None) == 400 or "INVALID_ARGUMENT" in message


class GeminiClient:
    def __init__(self, settings: Settings, api_key: str) -> None:
        self._settings = settings
        self._client: Any = None
        self._types: Any = None
        if self._settings.mock_gemini:
            return
        normalized_key = api_key.strip()
        if not normalized_key:
            raise ValueError("Gemini API 키를 입력해 주세요.")
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise RuntimeError("google-genai 패키지가 설치되지 않았습니다.") from exc
        self._client = genai.Client(api_key=normalized_key)
        self._types = types

    def close(self) -> None:
        client = self._client
        self._client = None
        self._types = None
        close = getattr(client, "close", None)
        if callable(close):
            close()

    async def transcribe(
        self,
        *,
        audio_bytes: bytes,
        mime_type: str,
        sequence: int,
        duration_ms: int,
        overlap_ms: int,
    ) -> TranscriptPayload:
        if self._settings.mock_gemini:
            return TranscriptPayload(
                segments=[
                    TranscriptSegment(
                        relative_start_ms=0,
                        relative_end_ms=max(1, duration_ms),
                        text=f"[모의 자막] 청크 {sequence}",
                        uncertain=False,
                    )
                ]
            )
        return await asyncio.to_thread(
            self._transcribe_sync,
            audio_bytes,
            mime_type,
            duration_ms,
            overlap_ms,
        )

    def _transcribe_sync(
        self,
        audio_bytes: bytes,
        mime_type: str,
        duration_ms: int,
        overlap_ms: int,
    ) -> TranscriptPayload:
        prompt = f"""
이 오디오를 정확하게 전사하세요.

규칙:
- 출력 언어는 한국어입니다. 원 발화가 한국어가 아니면 자연스러운 한국어로 번역합니다.
- 확실하지 않은 부분은 [불명]으로 적고 uncertain을 true로 설정합니다.
- 타임스탬프는 이 청크 시작을 0ms로 하는 상대 시간입니다.
- 모든 타임스탬프는 0 이상 {duration_ms} 이하입니다.
- 앞부분 {overlap_ms}ms는 이전 청크와 겹칠 수 있습니다.
- 들리지 않은 내용을 추측해서 만들지 않습니다.
- Markdown 코드 블록이나 설명 없이 아래 형태의 JSON 객체만 반환합니다.
- 음성이 없으면 segments를 빈 배열로 반환합니다.

출력 형식:
{{"segments":[{{"relative_start_ms":0,"relative_end_ms":1000,"text":"전사 내용","uncertain":false}}]}}
""".strip()
        try:
            response = self._client.models.generate_content(
                model=self._settings.gemini_model,
                contents=[
                    prompt,
                    self._types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
                ],
            )
        except Exception as exc:
            retry_after = _quota_retry_after(exc)
            if retry_after is not None:
                raise GeminiQuotaExhaustedError(retry_after or None) from exc
            unavailable_retry_after = _unavailable_retry_after(exc)
            if unavailable_retry_after is not None:
                raise GeminiUnavailableError(unavailable_retry_after) from exc
            if _is_invalid_request(exc):
                raise GeminiInvalidRequestError("Gemini가 오디오 전사 요청을 거부했습니다.") from exc
            raise
        return self._parse_model_response(response, TranscriptPayload)

    async def summarize(
        self,
        *,
        kind: str,
        previous_summary: dict[str, Any],
        transcript: str,
        bookmarks: list[dict[str, Any]],
    ) -> SummaryResponse:
        if self._settings.mock_gemini:
            excerpt = " ".join(transcript.split())[:180]
            return SummaryResponse(
                summary=f"모의 {kind} 요약입니다. {excerpt}".strip(),
                concepts=["모의 모드에서 생성된 주요 개념"],
                terms=[],
                highlights=[],
                checklist=["사이드패널에 실제 Gemini API 키를 입력해 자막과 요약 품질 확인하기"],
            )
        return await asyncio.to_thread(
            self._summarize_sync,
            kind,
            previous_summary,
            transcript,
            bookmarks,
        )

    def _summarize_sync(
        self,
        kind: str,
        previous_summary: dict[str, Any],
        transcript: str,
        bookmarks: list[dict[str, Any]],
    ) -> SummaryResponse:
        prompt = f"""
다음은 강의의 {kind} 요약 작업입니다.

이전 누적 요약:
{json.dumps(previous_summary, ensure_ascii=False)}

새로 확정된 자막:
{transcript}

사용자 북마크:
{json.dumps(bookmarks, ensure_ascii=False)}

규칙:
- 기존 요약과 새 자막을 통합합니다.
- summary는 핵심을 세 문장 안팎으로 작성합니다.
- concepts에는 주요 개념과 짧은 정의를 넣습니다.
- terms에는 중요한 전문 용어를 넣습니다.
- highlights에는 강사가 강조한 내용을 넣습니다.
- checklist에는 복습 질문이나 실천 항목을 넣습니다.
- 자막에 없는 사실을 만들어내지 않습니다.
- 지정된 구조화 출력 스키마만 반환합니다.
""".strip()
        try:
            response = self._client.models.generate_content(
                model=self._settings.gemini_model,
                contents=prompt,
                config=self._types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=SummaryResponse,
                ),
            )
        except Exception as exc:
            retry_after = _quota_retry_after(exc)
            if retry_after is not None:
                raise GeminiQuotaExhaustedError(retry_after or None) from exc
            unavailable_retry_after = _unavailable_retry_after(exc)
            if unavailable_retry_after is not None:
                raise GeminiUnavailableError(unavailable_retry_after) from exc
            if _is_invalid_request(exc):
                raise GeminiInvalidRequestError("Gemini가 요약 요청을 거부했습니다.") from exc
            raise
        return self._parse_model_response(response, SummaryResponse)

    @staticmethod
    def _parse_model_response(response: Any, schema: type[TranscriptPayload] | type[SummaryResponse]):
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, schema):
            return parsed
        if isinstance(parsed, dict):
            return schema.model_validate(parsed)
        text = getattr(response, "text", "")
        if not text:
            raise RuntimeError("Gemini가 빈 응답을 반환했습니다.")
        value = text.strip()
        if value.startswith("```"):
            lines = value.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            value = "\n".join(lines).strip()
        try:
            payload = json.loads(value)
        except json.JSONDecodeError:
            start = value.find("{")
            end = value.rfind("}")
            if start < 0 or end <= start:
                raise
            payload = json.loads(value[start : end + 1])
        return schema.model_validate(payload)
