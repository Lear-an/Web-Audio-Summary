# Chrome 강의 자막·요약 노트 설계서 v8

## 1. 문서 목적과 운영 전제

V8은 V7의 GPT 기반 구조를 운영 가능한 형태로 구체화한 설계입니다. Chrome 확장 프로그램이 영상 탭의 오디오를 수집하고, Render의 FastAPI 서버가 OpenAI API로 전사·한국어 변환·최종 요약을 수행하며, MongoDB Atlas에 영상 요청별 문서를 저장합니다.

- 등록 사용자와 동시 사용 인원은 모두 최대 **5명**입니다.
- OpenAI API 키는 운영자가 Render Secret으로 한 번만 설정합니다.
- 사용자는 사용자 ID와 접속 코드만 입력합니다.
- 청크는 60초, 겹침은 2초입니다.
- 중간 요약 없이 캡처 종료 시 최종 요약을 한 번 생성합니다.
- 실패 오디오는 브라우저 IndexedDB에 72시간 보존합니다.
- 중단된 요청도 지금까지의 전사를 영상별 부분 문서로 남깁니다.
- Render 무료 Web Service와 Atlas를 사용하며 배포는 관리자가 수동 실행합니다.

회원가입, 결제, 관리자 웹 콘솔, 대규모 분산 작업 큐는 범위에서 제외합니다.

## 2. V7에서 보완한 내용

| 항목 | V7 | V8 |
|---|---|---|
| 최대 사용자 | 7명 | **5명** |
| 부분 문서 보존 | 7일 후 문서도 TTL 삭제 가능 | 문서는 유지하고 재개용 초안만 7일 후 만료 |
| 청크 번호 | 1 기반 표현과 구현의 0 기반 혼재 | **0 기반 통일** |
| 종료 범위 | `expected_end_sequence` | `expected_chunk_count` |
| 중복 방지 | 메모리 잠금 중심 | Atlas 처리 lease와 시도 ID |
| 무료 Render 복구 | 상주 정리 작업 전제 | 시작·조회·재개·종료 시 지연 세션 정리 |
| 공급자 상태·사용량 | 메모리 중심 | `service_state`, `daily_usage` 영속화 |
| OpenAI 계약 | 모델 역할 중심 | Responses API, `store:false`, 엄격한 JSON Schema |
| 문서 목록 | 상세 본문 포함 가능 | 목록은 메타데이터, 본문은 상세 API |
| URL | 원문 저장·검색 | 정규화·민감 쿼리 제거·해시 인덱스 |
| 용량 | 입력 글자 제한 중심 | 세션 시간·BSON 크기 상한과 실패 보존 |
| 재시도 | 고정 대기 | `Retry-After` 우선, 없으면 jitter |
| 삭제 | 범위 불명확 | 문서·서버 초안·브라우저 outbox 분리 |

## 3. 전체 구조

```text
Chrome 영상 탭
  └─ Extension Side Panel / Service Worker / Offscreen
       ├─ tabCapture + MediaRecorder
       ├─ 60초 WebM/Opus 청크, 2초 overlap
       ├─ IndexedDB outbox (최대 128 MiB, 72시간)
       └─ HTTPS + 사용자 인증
                 │
                 ▼
Render FastAPI Web Service
  ├─ 사용자 인증·실패 횟수 제한
  ├─ 최대 동시 사용자 5명
  ├─ 청크 검증·영속 lease·재시도 분류
  ├─ OpenAI gpt-transcribe 전사
  ├─ OpenAI gpt-5.6-luna 한국어 변환·최종 요약
  └─ MongoDB Atlas
       ├─ lecture_sessions
       ├─ lecture_session_chunks
       ├─ lecture_documents
       ├─ service_state
       └─ daily_usage
```

| 구성요소 | 책임 |
|---|---|
| 확장 프로그램 | 오디오 캡처, outbox 보존, 순차 업로드, 사용자 UI |
| FastAPI | 인증, 검증, 큐 제어, OpenAI 호출, 상태 전이, 저장 |
| gpt-transcribe | 원언어 전사와 세그먼트 타임스탬프 |
| gpt-5.6-luna | 비한국어 전사의 한국어 변환, 종료 시 최종 요약 |
| Atlas | 처리 상태, 전사, 부분·완료 문서, 공급자 상태, 사용량 |

캡처 시작 한 번을 하나의 영상 요청으로 봅니다. 서버는 세션 생성 시 `session_id`와 `document_id`를 함께 발급합니다. 동일 URL을 다시 캡처해도 새 문서를 만들며 기존 문서를 덮어쓰지 않습니다.

```text
영상 요청 1회 = session 1개 = document 최대 1개 = chunk 여러 개
```

## 4. 인증과 비밀정보

### 4.1 사용자 인증

- 운영자가 `user-001`부터 `user-005`까지 최대 5개 계정을 발급합니다.
- 사용자마다 서로 다른 충분히 긴 무작위 접속 코드를 전달합니다.
- Render에는 평문 코드 대신 SHA-256 해시만 저장합니다.
- 서버는 입력 코드를 해시한 뒤 상수 시간 비교를 수행합니다.
- 인증 실패는 IP와 사용자 ID 해시 단위로 짧은 시간당 횟수를 제한합니다.
- 모든 조회·수정·삭제 쿼리는 인증된 `owner_id` 조건을 포함합니다.

```dotenv
APP_USER_1_ID=user-001
APP_USER_1_TOKEN_SHA256=<sha256>
# ... APP_USER_5까지
AUTH_FAILURE_LIMIT_PER_MINUTE=10
SAFETY_IDENTIFIER_SECRET=<랜덤 비밀값>
```

### 4.2 OpenAI 키

- `OPENAI_API_KEY`는 Render Secret에만 저장합니다.
- 확장 프로그램, GitHub, Atlas 문서, 로그에는 키를 저장하지 않습니다.
- 브라우저가 OpenAI를 직접 호출하지 않습니다.
- `safety_identifier`는 `HMAC-SHA256(SAFETY_IDENTIFIER_SECRET, owner_id)`의 비식별 값으로 만듭니다.

## 5. AI 처리 계약

### 5.1 언어 처리

- 한국어 음성은 전사 결과를 한국어 자막으로 사용합니다.
- 비한국어 음성은 원문을 보존하고 Luna로 자연스러운 한국어 자막을 만듭니다.
- 혼합 언어의 코드·제품명·고유명사는 가능한 한 원문 표기를 유지합니다.
- 번역 reasoning effort는 `none`, 최종 요약은 `low`가 기본입니다.
- 한국어·영어·혼합 기술 강의 검증 코퍼스로 품질 회귀 테스트를 합니다.

### 5.2 전사 요청

`gpt-transcribe` 요청 계약:

- 확장자가 있는 파일명(예: `chunk-000012.webm`)과 `audio/webm` MIME을 전달합니다.
- `response_format=verbose_json`을 사용합니다.
- `timestamp_granularities=["segment"]`를 요청합니다.
- 가능한 경우 강의 도메인의 keyword·prompt 정보를 사용합니다.
- 세그먼트 타임스탬프가 없으면 청크 전체를 coarse segment 하나로 저장하고 `timestamp_uncertain=true`로 표시합니다.
- 브라우저 청크 시각을 서버 기준 절대 자막 시각으로 변환합니다.

### 5.3 한국어 변환과 최종 요약

Luna는 Responses API로 호출합니다.

- `model=gpt-5.6-luna`
- `store=false`
- 도구 호출 비활성화
- 엄격한 JSON Schema Structured Outputs
- 전사문은 신뢰할 수 없는 데이터로 취급하고 전사문 안의 명령을 수행하지 않도록 시스템 지침에 명시
- `prompt_version`, `schema_version`, `requested_model`, `resolved_model` 기록

한국어 변환 출력은 `language`, `translated`, `segments[]`, `warnings[]`를 요구합니다. 최종 요약은 `summary`, `concepts`, `terms`, `highlights`, `checklist`를 요구합니다.

엄격한 스키마 검증 실패나 반복 번역 실패가 확인된 경우에만 선택적 fallback을 허용합니다.

```dotenv
OPENAI_TEXT_FALLBACK_MODEL=gpt-5.6-terra
TEXT_FALLBACK_ENABLED=false
```

주관적인 품질 판단만으로 자동 fallback하지 않으며 fallback 비용을 별도로 기록합니다.

### 5.4 공급자 재시도

- 네트워크 오류와 5xx는 최대 3회 재시도합니다.
- `Retry-After`가 있으면 그 값을 우선합니다.
- 없으면 `15±3초`, `30±6초`, `45±9초` jitter를 적용합니다.
- 429의 code/type을 파싱해 순간 rate limit과 quota 소진을 구분합니다.
- quota 소진은 반복 재시도를 중단하고 `service_state`에 pause를 저장합니다.
- 실패 청크는 Atlas와 브라우저 outbox에 남깁니다.
- 공급자 호출의 정확히 한 번 실행을 보장한다고 주장하지 않습니다. `provider_request_id`, `processing_attempt_id`를 기록하고 DB 결과를 멱등 반영합니다.

## 6. 오디오 청크와 브라우저 outbox

### 6.1 운영 설정

```dotenv
AUDIO_CHUNK_SECONDS=60
AUDIO_CHUNK_OVERLAP_SECONDS=2
AUDIO_BITS_PER_SECOND=128000
MIN_AUDIO_CHUNK_SECONDS=15
MAX_AUDIO_CHUNK_SECONDS=180
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
INDEXED_DB_MAX_BYTES=134217728
INDEXED_DB_RETENTION_HOURS=72
MAX_SESSION_DURATION_SECONDS=14400
```

운영 청크 허용 범위는 15~180초입니다. 서버 시작 시 아래 근삿값보다 `MAX_CHUNK_BYTES`가 작으면 기동을 실패시킵니다.

```text
필요 바이트 ≈ ceil((chunk_seconds + overlap_seconds)
                  × audio_bits_per_second / 8 × 1.25) + 65,536
```

### 6.2 순번과 상태

- `sequence`는 **0부터 시작**합니다.
- 종료 시 `expected_chunk_count`는 생성된 전체 청크 개수입니다.
- 유효 범위는 `0 <= sequence < expected_chunk_count`입니다.

```text
CAPTURED → UPLOADING → ACKED
              ├─ RETRY_WAIT
              ├─ QUOTA_PAUSED
              └─ FAILED_PERMANENT
```

ACK를 받은 청크만 브라우저에서 삭제합니다. 일시 실패와 quota pause의 오디오는 72시간 보존합니다. 사용자별 128 MiB 상한 전에 캡처를 중지하고 내보내기 또는 폐기를 안내합니다.

### 6.3 서버 동시성

```dotenv
MAX_CONCURRENT_USERS=5
OPENAI_MAX_IN_FLIGHT=3
OPENAI_MAX_IN_FLIGHT_PER_SESSION=1
OPENAI_QUEUE_MAX=15
OPENAI_QUEUE_WAIT_SECONDS=30
```

- 활성 사용자 lease로 동시 사용자를 5명으로 제한합니다.
- 같은 세션의 청크는 순차 처리합니다.
- 프로세스 전체 OpenAI 동시 호출은 3개로 시작하고 부하 테스트 후 조정합니다.
- 대기열 초과 시 `ai_backpressure`를 반환하고 오디오는 outbox에 남깁니다.
- 메모리 semaphore는 처리량 제어용이며 중복 방지 수단이 아닙니다.

## 7. Atlas 데이터 모델

### 7.1 `lecture_sessions`

```json
{
  "session_id": "uuid",
  "document_id": "uuid-created-with-session",
  "owner_id": "user-001",
  "status": "recording|processing|incomplete|finalize_pending|completed|expired",
  "requested_at": "datetime",
  "capture_closed_at": null,
  "expected_chunk_count": null,
  "received_sequences": [0, 1],
  "source_url": "canonical URL",
  "source_url_hash": "sha256",
  "source_host": "www.youtube.com",
  "source_video_id": "...",
  "source_title": "sanitized title",
  "resume_available_until": "datetime",
  "expire_at": "datetime",
  "last_error_code": null,
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

`document_id`는 세션 생성 시 발급합니다. 재개는 만료 판정과 lease 획득을 한 번의 원자적 갱신으로 수행하며, 성공 시 세션·청크의 `expire_at`을 제거하거나 갱신합니다.

### 7.2 `lecture_session_chunks`

```json
{
  "session_id": "uuid",
  "owner_id": "user-001",
  "sequence": 0,
  "status": "received|processing|ready|retry_wait|quota_paused|failed",
  "audio_sha256": "...",
  "original_text": "...",
  "korean_text": "...",
  "segments": [],
  "timestamp_uncertain": false,
  "processing_attempt_id": "uuid",
  "processing_lease_until": "datetime",
  "attempt_count": 1,
  "provider_request_id": "...",
  "requested_model": "gpt-transcribe",
  "resolved_model": "...",
  "prompt_version": "transcribe-v1",
  "schema_version": "1",
  "expire_at": "datetime"
}
```

처리 시작은 상태와 만료된 lease를 조건으로 한 원자적 claim입니다. `(session_id, sequence)` 유니크 인덱스와 처리 lease로 재시작·배포 후 중복 DB 반영을 막습니다.

### 7.3 `lecture_documents`

```json
{
  "document_id": "uuid",
  "session_id": "uuid",
  "owner_id": "user-001",
  "status": "incomplete|completed",
  "resume_status": "available|expired|not_needed",
  "summary_status": "not_run|processing|completed|failed|input_too_large",
  "requested_at": "datetime",
  "completed_at": null,
  "source_url": "canonical URL",
  "source_url_hash": "sha256",
  "source_host": "www.youtube.com",
  "source_video_id": "...",
  "source_title": "sanitized title",
  "transcript": {
    "original_text": "...",
    "korean_text": "...",
    "segments": [],
    "ready_chunk_count": 2,
    "expected_chunk_count": 3,
    "missing_sequences": [2]
  },
  "summary": null,
  "requested_model": "gpt-5.6-luna",
  "resolved_model": null,
  "prompt_version": "summary-v1",
  "schema_version": "1",
  "document_bytes": 0,
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

부분 문서는 **7일 후에도 삭제하지 않습니다**. 7일 후 재개용 세션·청크 초안만 TTL 대상으로 삼고 문서는 `resume_status=expired`로 표시합니다. Atlas TTL 삭제는 비동기이므로 API가 `resume_available_until`을 직접 확인합니다.

최종 저장 전 BSON 크기를 계산합니다. `MAX_DOCUMENT_BYTES=12000000`을 넘으면 자르지 않고 부분 문서를 유지하며 `summary_status=input_too_large`, 세션을 `finalize_pending`으로 둡니다. 장시간 강의가 늘면 segments 전용 컬렉션 분리를 검토합니다.

### 7.4 `service_state`

```json
{
  "_id": "openai",
  "quota_pause_until": null,
  "quota_error_code": null,
  "updated_at": "datetime"
}
```

모든 인스턴스가 공유해야 하는 공급자 pause 상태를 저장합니다.

### 7.5 `daily_usage`

```json
{
  "owner_id": "user-001",
  "date_utc": "2026-09-21",
  "audio_seconds": 2400,
  "transcription_requests": 40,
  "text_input_tokens": 12000,
  "text_output_tokens": 3000,
  "estimated_cost_usd": 0.22,
  "updated_at": "datetime"
}
```

사용량은 `(owner_id, date_utc)` 원자적 증가로 기록합니다. 전체 한도는 날짜별 합계 또는 `_id=total:<date>` 문서로 제한합니다.

### 7.6 필수 인덱스

```text
lecture_sessions:       unique(session_id), (owner_id, requested_at), TTL(expire_at)
lecture_session_chunks: unique(session_id, sequence), (session_id, status), TTL(expire_at)
lecture_documents:      unique(document_id), unique(session_id),
                        (owner_id, requested_at desc), (owner_id, source_url_hash)
service_state:          unique(_id)
daily_usage:            unique(owner_id, date_utc), (date_utc)
```

완료·부분 문서에는 TTL 대상 `expire_at`을 넣지 않습니다.

### 7.7 URL 개인정보 처리

- fragment를 제거합니다.
- `token`, `key`, `auth`, `signature`, `session` 등 민감 쿼리를 제거합니다.
- `utm_*`, `fbclid` 등 추적 파라미터를 제거합니다.
- 지원 사이트는 영상 식별에 필요한 쿼리만 allowlist합니다.
- 정규화 URL의 SHA-256을 저장하고 해시 필드에 인덱스를 둡니다.
- 제목과 클라이언트 메타데이터는 길이·제어문자·HTML을 검증합니다.

## 8. API 설계

모든 `/v1` 요청은 `X-User-Id`, `Authorization: Bearer <접속 코드>`를 요구합니다. 오류 응답은 `code`, `message`, `retryable`, `retry_after_seconds`, `request_id`를 공통으로 가집니다.

### 8.1 세션과 연결 확인

```text
GET  /health/live
GET  /health/ready
POST /v1/auth/check
POST /v1/sessions
GET  /v1/sessions/{session_id}
POST /v1/sessions/{session_id}/resume
```

세션 생성은 정규화한 영상 메타데이터를 받고 `session_id`, `document_id`, 청크 설정을 반환합니다. `/v1/auth/check`는 오디오 전송 전 서버·인증·Atlas 연결을 확인합니다.

### 8.2 청크

```text
POST /v1/sessions/{session_id}/chunks
GET  /v1/sessions/{session_id}/chunks
POST /v1/sessions/{session_id}/chunks/{sequence}/retry
```

업로드는 `(session_id, sequence, audio_sha256)`로 멱등 처리합니다. 동일 순번·동일 해시는 기존 결과를 반환하고, 동일 순번·다른 해시는 `409 chunk_conflict`를 반환합니다.

### 8.3 종료와 복구

```text
POST /v1/sessions/{session_id}/archive
POST /v1/sessions/{session_id}/finalize
```

archive 순서:

1. 캡처 종료와 `expected_chunk_count` 확정
2. 업로드 중 요청 drain
3. `0..expected_chunk_count-1` 누락 검사
4. READY 청크로 부분 문서 원자적 upsert
5. 누락이 있으면 `incomplete` 반환하고 최종 요약 생략
6. 누락이 없을 때만 finalize lease 획득
7. 전체 한국어 자막 조합과 BSON·요약 입력 크기 검사
8. Luna 최종 요약 한 번 실행
9. 같은 문서를 `completed`로 전환
10. 완료 저장 성공 후 세션·청크 초안 삭제

완료 문서가 이미 있으면 먼저 반환합니다. finalization 도중 실패하면 자막 문서를 유지하고 `finalize_pending`과 오류 코드를 기록합니다.

### 8.4 문서 조회

```text
GET /v1/documents?limit=20&cursor=<opaque>
GET /v1/documents/{document_id}
GET /v1/documents/{document_id}/transcript.txt
```

목록은 문서 ID, 상태, 시각, 제목, host, video ID, 청크 수 등 메타데이터만 커서 페이지네이션으로 반환합니다. 전체 전사·세그먼트·요약은 상세 API에서만 반환합니다.

### 8.5 삭제 정책

```text
DELETE /v1/documents/{document_id}
DELETE /v1/sessions/{session_id}/draft
```

- 문서 삭제는 해당 사용자의 문서와 연결된 서버 세션·청크 초안을 cascade 삭제합니다.
- 복구 초안만 삭제하면 부분 문서는 유지하고 `resume_status=expired`로 바꿉니다.
- 브라우저 outbox는 확장 프로그램에서 별도 확인 후 삭제합니다.
- completed 문서 삭제는 복구 불가능하다는 확인 UI를 거칩니다.

## 9. 상태 전이와 불변조건

| 조건 | 세션 상태 | 문서 상태 | 요약 상태 | 재개 |
|---|---|---|---|---|
| 녹화 중 | recording/processing | incomplete 또는 미생성 | not_run | 가능 |
| 종료, 누락 있음 | incomplete | incomplete | not_run | 7일 내 가능 |
| 전사 완료, 요약 대기/실패 | finalize_pending | incomplete | processing/failed | 가능 |
| 전체 완료 | completed 후 초안 삭제 | completed | completed | 불필요 |
| 7일 경과 | expired 또는 TTL 삭제 | incomplete 유지 | 기존값 | 불가 |

- completed는 모든 예상 청크가 READY인 경우에만 가능합니다.
- incomplete 문서는 최종 요약을 자동 실행하지 않습니다.
- `ready_chunk_count + missing_sequences.length = expected_chunk_count`여야 합니다.
- 한 세션에는 하나의 `document_id`만 존재합니다.
- 부분 문서 저장 실패 시 원본 청크를 삭제하지 않습니다.
- finalization 성공 전에 세션·청크를 삭제하지 않습니다.

## 10. 무료 Render 환경의 복구

무료 인스턴스는 절전·재시작·배포될 수 있으므로 메모리 타이머에 의존하지 않습니다. 다음 시점마다 stale-session reconciliation을 실행합니다.

- FastAPI 시작 시
- 문서 목록·상세 조회 시
- 세션 상태·재개 요청 시
- archive/finalize 요청 시

reconciliation은 만료된 processing lease를 해제하고, 오래된 processing 상태를 retryable로 되돌리고, 7일이 지난 초안의 문서를 `resume_status=expired`로 갱신합니다. 백그라운드 정리는 보조 수단입니다.

## 11. 확장 프로그램 UI

- 사용자 ID, 접속 코드
- 서버 연결 확인 상태
- 캡처 시작·종료
- 경과 시간, 현재 청크, outbox 용량
- 처리 중·재시도 대기·quota pause·사용자 조치 필요 상태
- 복구 가능한 세션 목록과 재개
- 부분·완료 문서 목록과 상세 보기
- 보존 오디오 내보내기·확인 후 폐기

패널 시작 시 `/v1/auth/check`로 서버를 깨우고 연결 상태를 확인합니다. 세션 생성과 tabCapture 권한 확보 후에만 캡처를 시작합니다. 활성 스트림이 이미 있으면 중복 캡처 대신 기존 세션 복귀를 안내합니다.

## 12. 오류 코드

| HTTP | code | 동작 |
|---:|---|---|
| 401 | invalid_credentials | 입력 확인, 재시도 제한 |
| 403 | extension_origin_not_allowed | CORS/확장 ID 확인 |
| 404 | session_not_found | 문서 조회 후 복구 판단 |
| 409 | chunk_conflict | 다른 오디오로 같은 순번 사용 금지 |
| 409 | archive_in_progress | 기존 finalize 상태 조회 |
| 413 | chunk_too_large | outbox 보존, 설정 확인 |
| 422 | invalid_chunk_metadata | 메타데이터 수정 전 재시도 금지 |
| 429 | provider_rate_limited | Retry-After 후 재시도 |
| 429 | provider_quota_exhausted | 공급자 pause, 자동 반복 중단 |
| 429 | operator_budget_limit | 예산 한도, outbox 보존 |
| 429 | too_many_active_users | 활성 사용자 lease 해제 후 재시도 |
| 503 | provider_overloaded | jitter backoff 후 재시도 |
| 503 | ai_backpressure | 서버 큐가 빌 때 재시도 |
| 503 | storage_unavailable | Atlas 복구 후 재시도 |
| 504 | provider_timeout | outbox 보존 후 재시도 |

## 13. 환경변수와 배포

```dotenv
MONGODB_URI=<Render Secret>
MONGODB_DATABASE=lecture_memo
OPENAI_API_KEY=<Render Secret>
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
OPENAI_TEXT_MODEL=gpt-5.6-luna
OPENAI_TRANSCRIBE_TIMEOUT_SECONDS=90
OPENAI_TEXT_TIMEOUT_SECONDS=60
CLIENT_REQUEST_TIMEOUT_SECONDS=120
OPENAI_MAX_IN_FLIGHT=3
OPENAI_MAX_IN_FLIGHT_PER_SESSION=1
OPENAI_QUEUE_MAX=15
OPENAI_QUEUE_WAIT_SECONDS=30
MAX_CONCURRENT_USERS=5
MOCK_OPENAI=false
AUDIO_CHUNK_SECONDS=60
AUDIO_CHUNK_OVERLAP_SECONDS=2
AUDIO_BITS_PER_SECOND=128000
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
MAX_SESSION_DURATION_SECONDS=14400
MAX_DOCUMENT_BYTES=12000000
DRAFT_RETENTION_DAYS=7
DAILY_AUDIO_MINUTES_LIMIT_PER_USER=0
DAILY_AUDIO_MINUTES_LIMIT_TOTAL=0
```

Start Command:

```text
uvicorn server.app:app --host 0.0.0.0 --port $PORT --workers 1
```

Health Check Path는 `/health/live`입니다. Render Auto-Deploy는 `Off`로 두고 관리자가 커밋을 확인한 뒤 `Deploy latest commit`을 실행합니다. 무료 플랜의 첫 요청 지연은 패널 연결 확인 단계에서 흡수합니다.

### 13.1 확장 ID와 CORS

- 같은 개인키의 `manifest.key`로 확장 ID를 고정합니다.
- 서버에는 실제 `chrome-extension://<고정-ID>`만 허용합니다.
- 개발용 ID는 별도 설정하며 `*` CORS는 사용하지 않습니다.
- Render URL은 확장 운영 설정에 고정하고 사용자 입력란에 두지 않습니다.

### 13.2 Atlas Network Access

Render outbound IP 대역이 고정·보장되는지 현재 요금제 문서를 확인해 allowlist합니다. 고정할 수 없는 시험 운영에서 넓은 허용 범위를 임시 사용하면 강한 DB 비밀번호, 최소 권한, 비밀 회전이 필수이며 운영 전 축소합니다.

## 14. 관측성과 로그

로그에 오디오, 접속 코드, OpenAI 키, 전사 본문, 전체 URL 쿼리를 남기지 않습니다. 다음만 구조화 기록합니다.

- `request_id`, 해시된 사용자 식별자
- `session_id`, `document_id`, `sequence`
- 상태·오류 코드·지연시간
- 공급자 request ID
- 토큰·추정 비용
- requested/resolved model, prompt/schema version

`/health/ready`는 Atlas 연결과 설정을 검사하되 OpenAI 유료 요청을 만들지 않습니다.

## 15. 구현 순서

1. V8 환경변수와 시작 검증
2. 최대 사용자 5명, 토큰 해시, 인증 실패 제한
3. `service_state`, `daily_usage`와 인덱스
4. 세션 생성 시 `document_id` 선발급과 URL 정규화
5. 0 기반 sequence와 `expected_chunk_count`
6. Atlas 기반 chunk processing lease
7. gpt-transcribe verbose JSON·segment timestamp 계약
8. Luna Responses API의 `store:false`, structured output, prompt 방어
9. 부분 문서 upsert와 7일 후 `resume_status=expired`
10. archive 순서, finalize lease, 크기 검사
11. 목록 커서 페이지네이션·상세·삭제 API 분리
12. 시작·조회·재개·종료 reconciliation
13. 확장 UI와 IndexedDB 복구·삭제 확인
14. 5명 동시 부하·중단·재시작·quota 테스트 후 수동 배포

## 16. 검증 기준

### 기능

- 5명이 동시에 세션을 생성하고 자기 데이터만 조회합니다.
- 6번째 활성 사용자는 `too_many_active_users`를 받고 오디오를 잃지 않습니다.
- 60초 청크·2초 overlap과 0 기반 누락 검사가 정확합니다.
- 동일 청크 재전송은 OpenAI 결과를 중복 저장하지 않습니다.
- 한국어·영어·혼합 강의가 스키마를 만족합니다.
- 누락이 있으면 부분 문서만 저장되고 최종 요약은 호출되지 않습니다.
- 모든 청크가 준비된 경우에만 최종 요약이 한 번 DB 결과로 반영됩니다.

### 복구·데이터 수명

- 429/503/timeout 후 오디오가 outbox와 Atlas 상태에 남습니다.
- 재시작 뒤 만료된 처리 lease가 복구됩니다.
- Render 절전 후 첫 조회가 stale 세션을 정리합니다.
- 7일 후 초안은 만료되지만 부분 문서는 남습니다.
- 재개와 TTL 만료가 겹쳐도 처리 중 초안이 삭제되지 않습니다.
- 완료 저장 전에는 초안이 삭제되지 않습니다.
- 12 MB 초과 문서는 잘리지 않고 `input_too_large`로 보존됩니다.

### 보안·운영

- 평문 접속 코드와 API 키가 Git·Atlas·로그에 없습니다.
- 다른 사용자의 리소스 접근은 거부됩니다.
- 허용하지 않은 extension origin은 거부됩니다.
- OpenAI 요청에 `store:false`와 비식별 `safety_identifier`가 포함됩니다.
- 전사문에 삽입된 명령이 요약 지침을 바꾸지 못합니다.
- 사용량과 추정 비용이 날짜·사용자별로 집계됩니다.

## 17. 운영자가 입력할 값

| 값 | 위치 |
|---|---|
| Render HTTPS URL | 확장 운영 설정 |
| 고정 Chrome 확장 ID | 서버 CORS 설정 |
| MongoDB Atlas URI | Render Secret |
| OpenAI API 키 | Render Secret |
| 사용자 1~5 ID | Render 환경변수 |
| 사용자 1~5 접속 코드 SHA-256 | Render Secret |
| safety identifier HMAC secret | Render Secret |
| 일일 사용자·전체 오디오 한도 | Render 환경변수, 0은 비활성 |

## 18. 비용 참고

2026-09-21 공개 가격 기준으로 5명이 매일 40분씩 30일 사용하면 원본은 월 6,000분입니다. 60초 청크마다 2초가 겹치므로 약 1.0325배인 6,195분이 과금 대상 전사 시간의 보수적 근삿값입니다.

```text
전사: 6,195분 × $0.0045/분 ≈ $27.88/월
Luna 번역·요약 포함 추정: 약 $30~33/월
```

실제 금액은 비한국어 비율, 토큰 수, fallback, 재시도에 따라 달라지며 Render와 Atlas 비용은 별도입니다. 일일 예산 제한과 `daily_usage`를 먼저 적용한 뒤 실측값으로 보정합니다.

## 19. 공식 참고 문서

- OpenAI GPT-5.6 Luna: https://developers.openai.com/api/docs/models/gpt-5.6-luna
- OpenAI Audio Transcriptions API: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- OpenAI Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI 데이터 제어: https://developers.openai.com/api/docs/guides/your-data
- Render Python 배포: https://render.com/docs/deploy-fastapi
- Render 무료 인스턴스: https://render.com/docs/free
- MongoDB Atlas Network Access: https://www.mongodb.com/docs/atlas/security/ip-access-list/
- MongoDB TTL 인덱스: https://www.mongodb.com/docs/manual/core/index-ttl/
