# Chrome 강의 자막·요약 노트 확장 프로그램 설계서 v4

## 1. 목적

Chrome에서 선택한 강의 탭의 오디오를 캡처하고, 사용자가 캡처 시작 시 입력한 OpenAI API 키 하나로 전사와 요약을 처리합니다.

v4의 목표는 다음과 같습니다.

- Gemini 의존성 제거
- OpenAI API 키 한 개로 전사와 요약 처리
- 키는 캡처 세션 동안만 메모리에 유지하고 저장하지 않음
- 강의 전사에는 전용 Audio Transcriptions API 사용
- 요약에는 비용과 처리량의 균형이 좋은 일반 GPT 모델 사용
- 고정된 일일 20회 제한 대신 프로젝트 사용 등급에 맞춰 운용
- 청크 길이와 요약 주기는 `.env`에서 변경 가능

전사와 요약은 서로 다른 OpenAI 모델을 사용하지만 인증 키, SDK, 결제 프로젝트는 하나입니다.

## 2. v3 대비 주요 변경점

| 항목 | v3 | v4 |
|---|---|---|
| API 공급자 | Gemini | OpenAI |
| 사용자 입력 키 | Gemini API 키 | OpenAI API 키 한 개 |
| 전사 API | Gemini 멀티모달 | Audio Transcriptions API |
| 전사 기본 모델 | `gemini-3.6-flash` | `gpt-transcribe` |
| 요약 API | Gemini 텍스트 요청 | Responses API |
| 요약 기본 모델 | `gemini-3.6-flash` | `gpt-5-mini` |
| 응답 스키마 | 프롬프트 JSON 후 검증 | Structured Outputs 후 서버 검증 |
| 일일 요청 제한 | 무료 등급 20회 사례 | 고정 20회가 아닌 프로젝트 등급별 RPM·TPM |
| 중간 요약 | 청크 흐름에 결합 | 별도 주기로 제한 |

## 3. API 조사 및 선정

### 3.1 전사 모델

| 후보 | 장점 | 단점 | 용도 |
|---|---|---|---|
| `gpt-transcribe` | 고정밀, 파일·스트리밍 지원, 용어·다국어 힌트 지원 | 화자별 정밀 구간은 별도 처리 필요 | 기본값 |
| `gpt-4o-mini-transcribe` | 저렴하고 빠름 | 일반 JSON 중심이라 세밀한 구간 시간 처리에 제약 | 절약형 |
| `gpt-4o-transcribe-diarize` | 화자와 구간 시작·종료 시간 제공 | 강의 한 명 화자에는 복잡도와 비용 증가 | 정밀 타임라인형 |
| `gpt-live-transcribe` | 낮은 지연의 실시간 자막 | 더 높은 분당 비용과 WebSocket 관리 필요 | 향후 옵션 |

기본 모델은 `gpt-transcribe`입니다.

- 완성된 오디오 파일과 스트리밍 전사 지원
- 전문용어, 수업 주제, 코드 식별자를 문맥 힌트로 전달 가능
- 다국어 강의와 코드 스위칭 대응
- 공식 가격: 오디오 1분당 미화 0.0045달러
- 유료 Tier 1: 500 RPM, 200,000 TPM

공식 분당 가격으로 단순 계산하면 60분 강의 전사는 약 0.27달러입니다. 요약 토큰 비용, 세금, 환율은 제외한 값입니다.

### 3.2 요약 모델

| 후보 | 장점 | 단점 | 용도 |
|---|---|---|---|
| `gpt-5-mini` | 명확한 작업에 적합, 400K 컨텍스트, Structured Outputs, 낮은 단가 | 무료 API 등급 미지원 | 기본값 |
| `gpt-4o-mini` | 더 저렴하고 빠름 | 긴 강의의 복합 요약 품질은 검증 필요 | 최저비용형 |
| 대형 모델 | 복잡한 추론 품질 우수 | 강의 요약에는 비용·지연이 과도할 수 있음 | 기본값 제외 |

기본 요약 모델은 `gpt-5-mini`입니다.

- Responses API와 Structured Outputs 지원
- 400,000 토큰 컨텍스트
- 유료 Tier 1: 500 RPM, 500,000 TPM
- 공식 단가: 입력 100만 토큰당 0.25달러, 출력 100만 토큰당 2달러

## 4. OpenAI 전환 이점

### 4.1 요청 한도

선정 모델에는 Gemini 무료 등급에서 경험한 “모델·프로젝트당 하루 20회” 같은 고정 한도가 표시되어 있지 않습니다.

| 모델 | Tier 1 RPM | Tier 1 TPM | 공식 페이지의 RPD |
|---|---:|---:|---|
| `gpt-transcribe` | 500 | 200,000 | 별도 값 없음 |
| `gpt-5-mini` | 500 | 500,000 | 별도 값 없음 |

60초 청크를 쓰는 개인용 강의 한 개는 분당 약 1회의 전사 요청을 만들므로 500 RPM과 큰 차이가 있습니다. 따라서 요청 횟수보다 결제 잔액과 프로젝트 사용 한도가 먼저 실질적인 제약이 될 가능성이 큽니다.

단, “일일 무제한”이라는 뜻은 아닙니다.

- 두 기본 모델 모두 무료 API 등급을 지원하지 않음
- 모델별 RPM·TPM 제한 적용
- 조직·프로젝트 결제 및 지출 한도 적용
- 사용 등급이 올라가면 한도가 자동 증가할 수 있음
- 프로젝트 관리자가 모델 한도를 더 낮출 수 있음
- 실제 값은 OpenAI Platform의 프로젝트 Limits 화면이 최종 기준

### 4.2 품질 및 운용

- 강의 주제와 용어 힌트로 고유명사·기술 용어 정확도 개선 가능
- 한국어와 영어가 섞인 강의에 다국어 힌트 사용 가능
- 파일 전사에서 시작해 추후 스트리밍 전사로 확장 가능
- 프로젝트·API 키·모델별 사용량 집계 가능
- Structured Outputs로 요약의 제목, 핵심 내용, 용어, 타임스탬프 형식 고정
- 긴 컨텍스트로 장시간 전사 내용을 한 번에 다루기 쉬움

### 4.3 구현 단순화

- 전사와 요약이 하나의 OpenAI Python SDK와 API 키를 공유
- 결제, 사용량 확인, 오류 형식이 한 공급자로 통합
- 세션별 클라이언트 한 개로 전사와 요약 수행
- Gemini 전용 JSON fence 제거 및 복구 코드 삭제 가능

## 5. 전체 구조

```text
Chrome action 클릭
→ 현재 탭 권한과 스트림 ID 확보
→ Side Panel에서 OpenAI API 키 입력
→ POST /v1/sessions로 키를 한 번 전달
→ 서버가 세션 전용 OpenAI 클라이언트 생성
→ Offscreen Document가 WebM/Opus 청크 녹음
→ Audio Transcriptions API의 gpt-transcribe로 전사
→ 타임라인 보정과 중복 제거
→ 설정 주기 또는 종료 시 Responses API의 gpt-5-mini로 요약
→ 사이드패널·영상 오버레이 갱신
→ 캡처 종료 시 클라이언트 참조 제거
```

역할:

- Service Worker: 권한, 스트림 ID, 메시지 라우팅
- Offscreen Document: 녹음, 큐, 재시도, 캡처 상태
- Content Script: 영상 시간 추적, 탐색, 자막 오버레이
- Side Panel: OpenAI 키 입력, 상태·자막·요약·북마크
- FastAPI 서버: 로컬 인증, 세션, OpenAI 호출, 응답 검증
- OpenAI Gateway: 전사와 요약 API의 차이를 서버 내부에서 통합

## 6. OpenAI API 키 수명주기

OpenAI 키는 `.env`, Chrome 저장소, IndexedDB, Local Storage 또는 파일에 저장하지 않습니다.

```text
OpenAI API 키 입력
→ 캡처 시작
→ START_SESSION 일회성 payload
→ POST /v1/sessions 본문
→ 세션 전용 OpenAI 클라이언트 생성
→ 세션 생성 성공 후 UI 입력란과 확장 임시 변수 초기화
→ session_id에 연결된 동일 클라이언트로 전사·요약
→ DELETE /v1/sessions/{session_id}
→ 클라이언트 참조 제거
```

```html
<input
  id="openaiApiKey"
  type="password"
  autocomplete="off"
  spellcheck="false"
  placeholder="sk-..."
>
```

```json
{
  "source_tab_id": 123,
  "source_url": "https://example.com/lecture",
  "language": "ko",
  "openai_api_key": "사용자가 입력한 키"
}
```

키를 저장하지 않는 위치:

- `chrome.storage.local`, `chrome.storage.sync`, `chrome.storage.session`
- `localStorage`, IndexedDB, Cache Storage
- Service Worker 전역 상태와 Offscreen 세션 스냅샷
- 서버 `.env`, 로그, 오류 응답, 임시 파일

세션 삭제, 서버 종료 또는 유휴 세션 만료 시 SDK 클라이언트 참조를 제거합니다.

## 7. 로컬 액세스 토큰

로컬 액세스 토큰은 계속 필요합니다.

| 값 | 목적 | 수명 |
|---|---|---|
| 로컬 액세스 토큰 | 임의 웹페이지가 `127.0.0.1` 서버를 호출하는 것 방지 | 사용자가 변경할 때까지 |
| OpenAI API 키 | OpenAI 전사·요약 인증 | 현재 캡처 세션 동안만 |

OpenAI 키는 URL이나 쿼리 문자열에 넣지 않고 세션 생성 POST 본문으로 한 번만 전달합니다.

## 8. 서버 환경 설정

```dotenv
# 전사 모델: gpt-transcribe, gpt-4o-mini-transcribe,
#             gpt-4o-transcribe-diarize 중 하나
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe

# 요약 모델: 기본 gpt-5-mini, 최저비용형 gpt-4o-mini
OPENAI_SUMMARY_MODEL=gpt-5-mini

# 청크 5~600초, 겹침 0~30초이며 청크보다 작아야 함
AUDIO_CHUNK_SECONDS=60
AUDIO_CHUNK_OVERLAP_SECONDS=3

# 0이면 중간 요약 없이 종료 시에만 요약
SUMMARY_INTERVAL_SECONDS=600

LOCAL_ACCESS_TOKEN=로컬_서버_토큰

# 0이면 청크 시간에서 자동 계산
MAX_CHUNK_BYTES=0
MAX_REQUEST_BYTES=0
SESSION_IDLE_TTL_SECONDS=1800
```

다음 항목은 제거합니다.

```dotenv
OPENAI_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=
```

`.env` 맨 위에 허용 범위를 `#` 주석으로 적어도 문제없습니다.

## 9. 전사 처리

```text
POST /v1/sessions/{session_id}/chunks
Content-Type: multipart/form-data
```

```text
로컬 토큰·Origin 검증
→ 세션, MIME, 크기, 시퀀스 검증
→ Audio Transcriptions API 호출
→ 텍스트와 언어 정보 파싱
→ 청크 시작·종료 영상 시간 연결
→ 겹침 구간 중복 제거
→ TranscriptPayload 검증
→ 확장 프로그램에 반환
```

`gpt-transcribe` 기본 모드에서는 청크 전체 텍스트를 청크 시간 범위와 연결합니다. 문장별 시간은 구두점과 글자 길이에 따라 청크 안에서 근사 배치합니다.

영상 클릭 탐색에 정밀한 구간 시간이 반드시 필요하면 `OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe-diarize`로 바꾸고 `diarized_json`의 구간 시작·종료 시간을 사용합니다.

전사 힌트에는 이전 청크 마지막 문장, 강의 제목, 전문용어 목록만 넣습니다. 전체 과거 전사를 매번 반복 전송하지 않습니다.

## 10. 요약 처리

Responses API와 `gpt-5-mini`를 사용합니다.

```json
{
  "model": "gpt-5-mini",
  "store": false,
  "input": "정리할 전사 텍스트와 타임라인",
  "text": {
    "format": {
      "type": "json_schema",
      "name": "lecture_summary",
      "strict": true,
      "schema": "서버가 정의한 요약 스키마"
    }
  }
}
```

- 전사: 청크마다 호출
- 중간 요약: 기본 600초마다 호출
- 최종 요약: 캡처 종료 시 한 번
- `SUMMARY_INTERVAL_SECONDS=0`: 중간 요약 비활성화
- 직전 요약과 새 전사분으로 누적 요약 갱신

```json
{
  "title": "강의 제목",
  "overview": "전체 개요",
  "key_points": [
    {"timestamp_ms": 120000, "text": "핵심 내용"}
  ],
  "terms": [
    {"term": "용어", "description": "설명"}
  ],
  "action_items": []
}
```

타임스탬프는 모델이 임의로 만들지 않게 하고 서버가 실제 전사 구간 참조인지 검증합니다.

## 11. OpenAI Gateway

```python
class OpenAIGateway:
    async def transcribe(
        self,
        audio: bytes,
        filename: str,
        content_type: str,
        language: str | None,
        context_hint: str | None,
    ) -> TranscriptPayload: ...

    async def summarize(
        self,
        transcript: list[TranscriptSegment],
        previous_summary: SummaryPayload | None,
    ) -> SummaryPayload: ...

    async def close(self) -> None: ...
```

`SessionRecord`는 `OpenAIGateway` 참조만 보유합니다.

## 12. 오류와 재시도

| 오류 | HTTP | 내부 코드 | 확장 동작 |
|---|---:|---|---|
| OpenAI 키 누락 | 422 | `openai_key_missing` | 세션 생성 중단 |
| OpenAI 키 무효 | 401 | `openai_key_invalid` | 새 키 안내 |
| 결제·모델 접근 불가 | 403 | `openai_access_denied` | 결제·권한 안내 |
| 속도·토큰·사용 한도 | 429 | `openai_rate_limited` | 자동 재시도 중단, 일시정지 |
| 잘못된 오디오·요청 | 422 | `openai_bad_request` | 반복 재시도 금지 |
| 일시적 OpenAI 5xx | 502/503 | `openai_upstream_error` | 제한된 지수 백오프 |
| 로컬 토큰 오류 | 401 | `local_auth_failed` | 로컬 토큰 안내 |

429는 일일 소진만 뜻하지 않습니다. RPM, TPM, 프로젝트 지출 한도 또는 결제 한도 중 원인을 안전한 오류 코드와 응답 헤더로 구분해 표시합니다.

```text
OpenAI 429
→ 서버가 429와 openai_rate_limited 반환
→ 자동 재시도 중단
→ PAUSED_QUOTA
→ 녹음창과 대기 큐 중지
→ UI에 속도·토큰·결제 한도 확인 안내
```

## 13. UI와 상태

```text
┌──────────────────────────────────┐
│ Lecture Memo                     │
├──────────────────────────────────┤
│ 서버: http://127.0.0.1:8050      │
│ 로컬 액세스 토큰 [••••••••]      │
│ OpenAI API 키     [sk-••••••]     │
│ [캡처 시작]                       │
├──────────────────────────────────┤
│ 전사: gpt-transcribe             │
│ 요약: gpt-5-mini                 │
│ 상태: 캡처 중                     │
├──────────────────────────────────┤
│ 실시간 자막 / 요약 / 북마크       │
└──────────────────────────────────┘
```

```text
IDLE
STARTING
CAPTURING
PAUSED_BACKPRESSURE
PAUSED_QUOTA
STOPPING
STOPPED
ERROR
```

세션 생성 성공 즉시 API 키 입력란을 비웁니다. `PAUSED_QUOTA`는 자동 복구하지 않습니다.

## 14. `/health` 응답

```json
{
  "status": "ok",
  "provider": "openai",
  "transcribe_model": "gpt-transcribe",
  "summary_model": "gpt-5-mini",
  "chunk_seconds": 60,
  "chunk_overlap_seconds": 3,
  "summary_interval_seconds": 600
}
```

API 키와 결제 정보는 반환하지 않습니다.

## 15. 청크 기준

```text
전사 요청 수 ≈ 강의 길이 ÷ (청크 길이 - 겹침)
첫 자막 지연 ≈ 청크 길이 + 업로드 + 전사 처리시간
```

| 목적 | 청크 | 겹침 | 요약 주기 |
|---|---:|---:|---:|
| 빠른 자막 | 20~30초 | 1~2초 | 600초 |
| 기본 균형형 | 60초 | 3초 | 600초 |
| 요청 수 절약 | 180~300초 | 5초 | 종료 시만 |

기본값은 `60초 / 3초 / 600초`입니다. 청크를 길게 잡는 목적은 일일 요청 제한 회피보다 비용, 실패 범위, 자막 지연의 균형입니다.

## 16. 보안

- OpenAI 키를 브라우저와 서버 파일에 저장하지 않음
- Responses 요청에 `store: false` 명시
- 서버는 `127.0.0.1`에만 바인딩
- 로컬 액세스 토큰과 Origin 검증 유지
- 오디오를 디스크 임시 파일로 남기지 않음
- API 키, 오디오, 자막, 요약을 일반 로그에 기록하지 않음
- 세션 종료·만료·서버 종료 시 클라이언트 참조 제거

## 17. 구현 변경 범위

### 확장 프로그램

- Gemini 키 입력을 OpenAI 키 입력으로 교체
- 키를 캡처 시작 시 한 번만 전달하고 즉시 제거
- OpenAI 상태·오류 문구와 `/health` 모델 정보 반영

### 서버

- `google-genai` 제거, OpenAI Python SDK 추가
- `GeminiClient`를 `OpenAIGateway`로 교체
- Audio Transcriptions API와 Responses API 적용
- 세션 필드를 `openai_api_key`로 변경
- OpenAI 오류와 한도 헤더 매핑
- `.env.example`, 설치 CMD, README에서 Gemini 설정 제거

### 유지 항목

- Manifest V3, Side Panel, Offscreen Document
- FastAPI와 로컬 액세스 토큰
- 세션·청크 REST 경로
- 외부 청크 설정, 중복 제거, 타임라인, 북마크, 오버레이
- API 키 비저장 원칙

## 18. 테스트 기준

- 키 누락 시 세션 생성 422
- 세션 생성 후 UI와 확장 임시 변수에서 키 제거
- 키가 저장소, 로그, 오류 응답, 스냅샷에 남지 않음
- 같은 세션의 전사·요약이 같은 OpenAI 클라이언트 사용
- 실제 WebM/Opus를 `gpt-transcribe`로 전사
- 문맥·전문용어 힌트 반영
- `gpt-5-mini` Structured Output 검증
- Responses 요청에 `store: false` 적용
- 401, 403, 429, 422, 5xx별 UI 동작 확인
- 429에서 자동 재시도와 녹음 큐 중단
- 세션 삭제·유휴 만료·종료 시 클라이언트 참조 제거

## 19. 구현 순서

1. 서버 의존성과 설정을 OpenAI 기준으로 변경
2. `OpenAIGateway.transcribe()`와 실제 오디오 테스트
3. `OpenAIGateway.summarize()`와 Structured Output 구현
4. 세션별 API 키 수명주기 적용
5. 확장 입력 필드와 메시지 계약 변경
6. 오류 매핑과 `PAUSED_QUOTA` 연결
7. `.env.example`, 설치 CMD, README 갱신
8. 실제 Chrome 캡처 통합 테스트

## 20. 공식 문서

- GPT Transcribe: https://developers.openai.com/api/docs/models/gpt-transcribe
- GPT-5 Mini: https://developers.openai.com/api/docs/models/gpt-5-mini
- GPT-4o Mini Transcribe: https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
- GPT-4o Transcribe Diarize: https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize
- GPT Live Transcribe: https://developers.openai.com/api/docs/models/gpt-live-transcribe
- Audio API: https://developers.openai.com/api/reference/typescript/resources/audio
- Project rate limits: https://developers.openai.com/api/reference/typescript/resources/admin/subresources/organization/subresources/projects
