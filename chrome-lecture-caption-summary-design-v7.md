# Chrome 강의 자막·요약 노트 설계서 v7

## 1. 문서 목적

이 문서는 V5의 Render·FastAPI·MongoDB Atlas·Chrome Extension 구조를 유지하면서, 사용자별 Gemini API 키를 제거하고 운영자가 관리하는 OpenAI API를 사용하는 V7 설계 기준입니다.

V7의 기본 흐름은 다음과 같습니다.

- 운영자는 Render 환경변수에 OpenAI API 키를 등록합니다.
- 사용자는 확장 프로그램에 사용자 ID와 접속 코드만 입력합니다.
- 한국어 음성은 그대로 한국어 자막으로 전사합니다.
- 영어 또는 기타 외국어 음성은 원문으로 전사한 뒤 GPT-5.6 Luna로 한국어로 변환합니다.
- 캡처 중에는 청크 자막만 표시하고 중간 요약은 생성하지 않습니다.
- 캡처 종료 시 모든 청크가 처리된 경우에만 전체 한국어 자막과 최종 요약을 생성합니다.
- Render 재시작·네트워크 오류·AI 일시 오류가 발생해도 IndexedDB와 Atlas 초안을 기준으로 복구합니다.

V7은 최대 7명의 초기 사용자를 대상으로 합니다. 회원가입, 소셜 로그인, 관리자 웹 콘솔, 결제 관리와 대규모 작업 큐는 범위에 포함하지 않습니다.

## 2. V5에서 V7로 바뀌는 내용

| 항목 | V5 | V7 |
|---|---|---|
| AI 공급자 | Gemini | OpenAI API |
| 오디오 전사 | Gemini 오디오 요청 | gpt-transcribe |
| 한국어 변환 | Gemini 전사 프롬프트 | 비한국어 원문을 gpt-5.6-luna로 번역 |
| 최종 요약 | 사용자 Gemini 키 | 운영자 OpenAI 키와 Luna |
| API 키 입력 | 사용자별 Gemini 키 입력 | 확장 프로그램 입력란 제거 |
| API 키 보관 | 세션 메모리 | Render Secret |
| API 키 오류 영향 | 해당 사용자 세션 중심 | 운영자 키 공유로 여러 사용자에게 영향 가능 |
| 기본 청크 | 300초·overlap 5초 | 60초·overlap 2초 |
| Render 재시작 | Gemini 키 재입력 | 환경변수에서 키 자동 재로딩 |
| 최종 결과 | 한국어 중심 | 한국어 자막 기본, 원문 전사 선택 보관 |
| 운영 비용 | 사용자별 부담 | 운영자 부담 |

gpt-5.6-luna는 오디오 입력 모델이 아니므로 오디오를 Luna에 직접 전달하지 않습니다. 음성 전사는 gpt-transcribe가 담당하고, Luna는 전사된 텍스트의 한국어 변환과 최종 요약을 담당합니다.

## 3. 전체 구조

~~~text
사용자 Chrome 확장 ── HTTPS ──> Render FastAPI
       │                              │
       │                              ├─ 운영자 OPENAI_API_KEY
       │                              │
       │                              ├─ gpt-transcribe
       │                              └─ gpt-5.6-luna
       │
       └─ IndexedDB outbox       MongoDB Atlas
                                  ├─ 세션 초안
                                  ├─ 청크 원문·한국어 결과
                                  └─ 완료 자막·요약 문서
~~~

사용자는 OpenAI API 키나 MongoDB에 접근하지 않습니다. 확장 프로그램은 오디오와 사용자 인증정보를 Render로 보내고, FastAPI가 Render Secret에서 읽은 OpenAI 키로 API를 호출합니다.

### 3.1 구성요소별 책임

| 구성요소 | 책임 |
|---|---|
| Service Worker | 탭 권한, tabCapture 스트림 ID, 메시지 라우팅 |
| Offscreen Document | 녹음, 60초 청크, IndexedDB outbox, ACK·재시도 |
| Content Script | 영상 시간 추적, 자막 오버레이 |
| Side Panel | 사용자 인증, 캡처 상태, 한국어 자막, 오류 표시 |
| Render FastAPI | 인증, OpenAI 호출, 자막 정규화, Atlas 저장 |
| gpt-transcribe | 오디오의 입력 언어 전사 |
| gpt-5.6-luna | 비한국어 전사의 한국어 변환, 최종 요약 |
| MongoDB Atlas | 처리된 텍스트 초안과 완료 문서 보관 |

## 4. 인증과 OpenAI 키 정책

### 4.1 사용자 인증

V5의 수동 발급 방식을 유지합니다.

- 운영자가 user-001부터 user-007까지 사용자 ID를 발급합니다.
- 사용자별로 충분히 긴 접속 코드를 발급합니다.
- 인증 요청은 X-User-ID와 Bearer 접속 코드를 함께 사용합니다.
- 모든 Atlas 문서에 owner_id를 저장합니다.
- 인증된 사용자와 문서 소유자가 다르면 접근을 거부합니다.

### 4.2 운영자 OpenAI 키

OpenAI 키는 운영자 소유의 Render Secret으로만 관리합니다.

- 환경변수 이름은 OPENAI_API_KEY입니다.
- 확장 프로그램, IndexedDB, Atlas, 응답 JSON, URL, 로그에 기록하지 않습니다.
- 세션 생성 payload에 API 키를 포함하지 않습니다.
- 사용자용 OpenAI 키 입력·교체 API를 만들지 않습니다.
- 키를 교체할 때는 운영자가 Render 환경변수를 변경하고 수동 배포·재기동합니다.
- 키가 없거나 유효하지 않으면 health/ready를 준비되지 않은 상태로 반환합니다.

운영자 키 하나를 여러 사용자가 공유하므로 quota 소진은 전역 장애가 될 수 있습니다. quota 상태는 세션별 상태와 별도로 관리하고, 반복 요청을 막기 위해 전역 AI 일시정지 상태를 둡니다.

## 5. AI 처리 설계

### 5.1 언어 규칙

출력 언어는 한국어로 고정합니다.

1. gpt-transcribe에 오디오 청크를 전달합니다.
2. 입력 언어는 자동 감지를 기본으로 하고 선택적 언어 힌트를 지원합니다.
3. 원문이 한국어이면 원문 전사를 그대로 한국어 자막으로 사용합니다.
4. 원문이 영어 또는 기타 언어이면 Luna로 자연스러운 한국어로 변환합니다.
5. 한국어와 영어가 섞인 청크는 한국어 부분을 보존하고 비한국어 부분을 한국어로 통일합니다.
6. 원문 전사와 한국어 결과를 모두 저장하되 사용자 화면과 기본 TXT는 한국어 결과를 사용합니다.

영어 음성을 한국어로 출력하는 기본 경로는 다음과 같습니다.

~~~text
영어 오디오
  → gpt-transcribe
  → 영어 원문 전사
  → gpt-5.6-luna
  → 한국어 자막
~~~

### 5.2 청크 처리

~~~text
오디오 청크 수신
  ↓
gpt-transcribe 원문 전사
  ↓
한국어인가?
  ├─ 예: 전사 결과 확정
  └─ 아니오: gpt-5.6-luna로 한국어 변환
  ↓
2초 overlap 중복 제거
  ↓
Atlas 청크 upsert
  ↓
성공 ACK
~~~

전사와 번역 중 하나라도 완료되지 않으면 최종 READY ACK를 반환하지 않습니다. 전사 결과가 Atlas에 이미 저장된 경우 재전송 시 전사 API를 중복 호출하지 않고 번역 단계부터 재개합니다.

### 5.3 최종 요약

- 중간 요약은 생성하지 않습니다.
- archive 요청에서 Atlas의 한국어 청크를 sequence 순서로 합칩니다.
- 모든 필수 청크가 READY일 때만 Luna를 한 번 호출합니다.
- 요약 입력은 전체 한국어 자막과 강의 메타데이터·북마크입니다.
- 요약 출력은 summary, concepts, terms, highlights, checklist 구조로 저장합니다.
- 같은 archive 요청이 재전송되면 기존 문서를 반환하고 Luna를 재호출하지 않습니다.
- 누락 청크가 있으면 최종 요약을 만들지 않고 incomplete 초안으로 보관합니다.

## 6. 청크와 IndexedDB outbox

### 6.1 기본 설정

~~~dotenv
AUDIO_CHUNK_SECONDS=60
AUDIO_CHUNK_OVERLAP_SECONDS=2
~~~

청크 길이는 환경변수로 조정할 수 있으며 허용 범위는 5~600초입니다. 운영 기본값은 60초·overlap 2초로 합니다.

40분 강의는 약 40개 청크가 되며, 2초 overlap을 포함하면 세션당 실제 전사 처리량은 약 41분 18초입니다. 1분 청크는 요청 수가 증가하는 대신 장애 시 재처리 범위를 1분으로 줄입니다.

### 6.2 outbox 상태

~~~text
PENDING → SENDING → ACKED
             ├─ RETRY_WAIT
             ├─ PAUSED_QUOTA
             └─ NEEDS_ACTION
~~~

규칙:

- 원본 오디오는 서버 전송 전에 IndexedDB에 먼저 기록합니다.
- Atlas 저장과 서버 ACK 전에는 원본을 삭제하지 않습니다.
- 네트워크·OpenAI 일시 오류·Atlas 저장 실패 시 원본을 유지합니다.
- 같은 session_id와 sequence를 다시 보내면 기존 결과를 반환하고 AI를 중복 호출하지 않습니다.
- 사용자별 IndexedDB 상한은 128 MiB입니다.
- 미처리 청크는 72시간 보존하고 expired로 표시합니다.
- 폐기는 사용자 확인이 필요합니다.
- navigator.storage.estimate()로 실제 브라우저 할당량을 확인합니다.

## 7. Atlas 데이터 모델

원본 오디오는 Atlas에 저장하지 않습니다.

### 7.1 lecture_sessions

~~~json
{
  "session_id": "uuid",
  "owner_id": "user-001",
  "source_url": "https://example.com/lecture",
  "source_title": "강의 제목",
  "output_language": "ko",
  "provider": "openai",
  "transcription_model": "gpt-transcribe",
  "text_model": "gpt-5.6-luna",
  "chunk_seconds": 60,
  "overlap_seconds": 2,
  "status": "recording",
  "last_sequence": 12,
  "created_at": "2026-09-21T10:00:00Z",
  "updated_at": "2026-09-21T10:12:00Z",
  "expire_at": null,
  "schema_version": 7
}
~~~

세션 상태는 recording, processing, finalize_pending, completed, incomplete, paused_ai, paused_atlas, cancelled를 사용합니다.

### 7.2 lecture_session_chunks

~~~json
{
  "chunk_id": "session-uuid:12",
  "session_id": "uuid",
  "owner_id": "user-001",
  "sequence": 12,
  "start_ms": 660000,
  "end_ms": 720000,
  "source_language": "en",
  "source_transcript": "Original English transcript",
  "transcript_ko": "한국어로 변환된 전사",
  "transcription_status": "completed",
  "translation_status": "completed",
  "status": "ready",
  "created_at": "2026-09-21T10:12:00Z",
  "updated_at": "2026-09-21T10:12:20Z"
}
~~~

청크 상태는 received, transcribing, transcribed, translating, translation_pending, ready, failed를 사용합니다. API 키, 원본 오디오, OpenAI 요청 전문은 저장하지 않습니다.

### 7.3 lecture_documents

~~~json
{
  "document_id": "uuid",
  "session_id": "uuid",
  "owner_id": "user-001",
  "source_languages": ["en"],
  "output_language": "ko",
  "transcript_txt": "전체 한국어 자막",
  "source_transcript_txt": "전체 원문 전사",
  "summary": {
    "summary": "핵심 요약",
    "concepts": ["핵심 개념"],
    "terms": ["전문 용어"],
    "highlights": ["중요 내용"],
    "checklist": ["복습 항목"]
  },
  "bookmarks": [],
  "chunk_count": 40,
  "missing_chunk_count": 0,
  "status": "completed",
  "schema_version": 7
}
~~~

완료 문서 저장 성공 후 세션·청크 초안은 즉시 삭제합니다. incomplete 초안은 마지막 활동 시각부터 7일 보존합니다.

### 7.4 필수 인덱스

~~~text
document_id: unique
(owner_id, session_id): unique on lecture_documents
(owner_id, created_at): descending
(owner_id, session_id): unique on lecture_sessions
(owner_id, session_id, sequence): unique on lecture_session_chunks
expire_at: TTL on incomplete drafts
~~~

## 8. FastAPI API

### 8.1 공통 인증

~~~http
Authorization: Bearer <user-access-token>
X-User-ID: user-001
~~~

### 8.2 세션 생성

~~~http
POST /v1/sessions
~~~

~~~json
{
  "source_tab_id": 123,
  "source_url": "https://example.com/lecture",
  "source_title": "강의 제목",
  "output_language": "ko",
  "transcription_language_hint": null
}
~~~

응답에는 session_id, 청크 설정, 공급자·모델 정보만 포함합니다. OpenAI 키·접속 코드·MongoDB URI는 응답하지 않습니다.

### 8.3 유지 API

~~~text
GET    /health/live
GET    /health/ready
POST   /v1/sessions
POST   /v1/sessions/{session_id}/resume
POST   /v1/sessions/{session_id}/chunks
POST   /v1/sessions/{session_id}/archive
DELETE /v1/sessions/{session_id}
GET    /v1/documents
GET    /v1/documents/{document_id}
DELETE /v1/documents/{document_id}
~~~

다음 Gemini 키 관련 API는 제거합니다.

~~~text
POST /v1/sessions/{session_id}/gemini-key
POST /v1/sessions/{session_id}/openai-key
~~~

### 8.4 청크 업로드

~~~http
POST /v1/sessions/{session_id}/chunks
Content-Type: multipart/form-data
~~~

필수 메타데이터는 chunk_id, sequence, start_ms, end_ms, duration_ms, audio file입니다.

서버 처리 순서:

1. 인증 사용자와 세션 소유자를 확인합니다.
2. 이미 READY인 sequence이면 기존 결과를 반환합니다.
3. 파일 크기와 MIME을 검증합니다.
4. gpt-transcribe로 원문 전사를 요청합니다.
5. 한국어가 아니면 gpt-5.6-luna로 한국어 변환을 요청합니다.
6. overlap 경계를 서버 기준으로 정규화합니다.
7. Atlas에 idempotent upsert합니다.
8. 저장 성공 후 한국어 자막과 ACK를 반환합니다.

### 8.5 archive

~~~http
POST /v1/sessions/{session_id}/archive
~~~

서버는 클라이언트가 보낸 전체 자막을 신뢰하지 않고 Atlas 초안을 기준으로 누락을 계산합니다.

- 누락이 없으면 한국어 전체 자막을 조합합니다.
- Luna 최종 요약을 최대 한 번 생성합니다.
- 최종 문서를 저장한 뒤 초안을 삭제합니다.
- 같은 archive 요청에는 기존 document_id를 반환합니다.
- 누락이 있으면 최종 요약 없이 incomplete 초안으로 보관합니다.

### 8.6 표준 오류

~~~json
{
  "error": {
    "code": "openai_quota_exhausted",
    "message": "운영자 OpenAI API 할당량이 소진되었습니다.",
    "retryable": false,
    "action": "operator_action_required",
    "chunk_id": "session-uuid:12",
    "retry_after_seconds": null
  }
}
~~~

주요 오류 코드는 다음과 같습니다.

~~~text
openai_auth_failed
openai_quota_exhausted
openai_rate_limited
openai_unavailable
openai_timeout
transcription_failed
translation_failed
payload_too_large
unsupported_media
invalid_request
atlas_unavailable
session_resume_required
~~~

## 9. 오류·재시도·복구

| 상황 | 처리 |
|---|---|
| Render 절전 해제 지연 | health/ready 확인을 제한 횟수로 재시도하고 연결 중 표시 |
| Render 프로세스 재시작 | Atlas 초안과 IndexedDB outbox로 resume; 키는 환경변수에서 자동 복구 |
| OpenAI 401 | 자동 재시도하지 않고 운영자에게 키 확인 요청 |
| OpenAI quota 429 | 자동 재시도하지 않고 전역 PAUSED_QUOTA; 모든 원본 보존 |
| 일시적 rate limit 429 | retry-after를 따르고 제한된 횟수만 재시도 |
| OpenAI 503·5xx | 15초·30초·45초 간격 재시도 후 RETRY_WAIT |
| OpenAI timeout | 원본 보존 후 제한된 재시도 |
| 전사 성공·번역 실패 | Atlas 원문을 보존하고 번역 단계부터 재개 |
| Atlas 저장 실패 | ACK를 반환하지 않고 IndexedDB 원본 유지 |
| 413 | 원본 보존, 설정 오류 표시, WebM 바이트 자동 분할 금지 |
| 415 | 녹음 시작 전 MIME 검사, 실패 원본 보존 |
| 422 | 자동 반복하지 않고 NEEDS_ACTION |
| 브라우저 종료 | 다음 확장 실행에서 IndexedDB outbox 복구 |
| 일부 청크 처리 불가 | 처리 완료분을 incomplete로 자동 보관, 최종 요약은 보류 |

운영자 키 하나를 공유하므로 quota 소진은 여러 사용자에게 동시에 영향을 줄 수 있습니다. 사용자가 새 API 키를 입력하는 대신 운영자가 Render Secret을 교체하고 수동 배포합니다.

## 10. 확장 프로그램 UI

~~~text
LECTURE MEMO
강의 자막 노트

사용자 ID       [user-001]
접속 코드       [••••••••••••]

[캡처 시작] [캡처 종료]
[보존 오디오 내보내기] [보존 청크 폐기]

AI 상태: 운영 서버 연결됨
언어: 자동 감지 → 한국어 출력
상태: 캡처 중
~~~

변경 규칙:

- Gemini API 키 입력란을 제거합니다.
- OpenAI API 키 입력란도 제공하지 않습니다.
- Render 주소는 운영 빌드에 고정합니다.
- 캡처 전 health/ready를 확인합니다.
- 원문 언어와 한국어 출력 상태를 표시합니다.
- quota·인증 오류는 운영자 조치 필요로 표시합니다.
- ACK 전에는 저장 완료로 표시하지 않습니다.
- 누락 청크가 있으면 incomplete와 복구 가능한 sequence를 표시합니다.

## 11. 전사·번역·보관 흐름

~~~text
1. 사용자 ID·접속 코드 검증
2. Render health/ready 확인
3. 세션 생성
4. Offscreen이 60초 오디오 청크 생성
5. IndexedDB에 원본 청크 기록
6. Render FastAPI로 전송
7. gpt-transcribe 원문 전사
8. 비한국어이면 Luna 한국어 변환
9. overlap 정규화
10. Atlas에 원문·한국어 결과 upsert
11. 저장 성공 후 ACK 반환
12. ACK된 원본 삭제
13. 503·timeout은 15·30·45초 재시도
14. quota·인증 오류는 운영자 조치 대기
15. 종료 시 남은 청크 drain
16. archive에서 누락 여부 확인
17. 누락이 없으면 Luna 최종 요약 1회
18. 한국어 TXT·원문 TXT 선택본·요약 저장
19. 완료 문서 저장 후 초안 정리
~~~

## 12. 보안·개인정보

- OpenAI API 키는 Render Secret으로만 보관합니다.
- 키·접속 코드·MongoDB URI를 로그·URL·응답·Atlas에 기록하지 않습니다.
- 원본 오디오는 Render 디스크나 Atlas에 영구 저장하지 않습니다.
- ACK 전 원본 오디오만 브라우저 IndexedDB에 임시 보관합니다.
- Atlas에는 원문 전사와 한국어 전사가 저장될 수 있음을 안내합니다.
- 운영자는 Render와 Atlas를 관리하므로 모든 사용자 문서에 접근할 수 있습니다.
- 외부 전송이 제한된 민감한 강의는 사용하지 않도록 안내합니다.
- MongoDB 계정은 최소 권한으로 설정합니다.
- CORS에는 고정된 확장 Origin만 등록합니다.
- 모든 문서 API에 owner_id 필터를 강제합니다.
- API 키와 자막 전문을 로그에 남기지 않습니다.

## 13. 환경변수와 배포

### 13.1 로컬 개발

~~~dotenv
APP_AUTH_MODE=local
LOCAL_ACCESS_TOKEN=로컬_서버_토큰
ALLOWED_EXTENSION_ORIGINS=chrome-extension://개발용ID

OPENAI_API_KEY=로컬에서만_사용할_키
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
OPENAI_TEXT_MODEL=gpt-5.6-luna
OPENAI_TIMEOUT_SECONDS=45
OPENAI_MAX_IN_FLIGHT=2
MOCK_OPENAI=false

OUTPUT_LANGUAGE=ko
AUDIO_CHUNK_SECONDS=60
AUDIO_CHUNK_OVERLAP_SECONDS=2
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
FINAL_SUMMARY_REQUIRE_ALL_CHUNKS=true
SESSION_IDLE_TTL_SECONDS=1800

MONGODB_REQUIRED=false
MONGODB_URI=
MONGODB_DATABASE=lecture_memo
~~~

.env 주석은 #으로 작성합니다.

### 13.2 Render 운영

~~~dotenv
APP_AUTH_MODE=multi_user
ALLOWED_EXTENSION_ORIGINS=chrome-extension://운영_확장_ID

OPENAI_API_KEY=Render Secret에 직접 입력
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
OPENAI_TEXT_MODEL=gpt-5.6-luna
OPENAI_TIMEOUT_SECONDS=45
OPENAI_MAX_IN_FLIGHT=2
MOCK_OPENAI=false
OUTPUT_LANGUAGE=ko

AUDIO_CHUNK_SECONDS=60
AUDIO_CHUNK_OVERLAP_SECONDS=2
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
FINAL_SUMMARY_REQUIRE_ALL_CHUNKS=true
SESSION_IDLE_TTL_SECONDS=1800

APP_USER_1_ID=user-001
APP_USER_1_TOKEN=사용자별_랜덤_접속코드
APP_USER_2_ID=user-002
APP_USER_2_TOKEN=사용자별_랜덤_접속코드

MONGODB_URI=mongodb+srv://사용자:비밀번호@클러스터.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=lecture_memo
MONGODB_DOCUMENT_COLLECTION=lecture_documents
MONGODB_SESSION_COLLECTION=lecture_sessions
MONGODB_CHUNK_COLLECTION=lecture_session_chunks
MONGODB_REQUIRED=true
ARCHIVE_TRANSCRIPT=true
ARCHIVE_SOURCE_TRANSCRIPT=true
ARCHIVE_SUMMARY=true
INCOMPLETE_DRAFT_RETENTION_DAYS=7
~~~

Render Auto-Deploy는 Off로 두고 CI 통과 후 관리자가 Deploy latest commit으로 수동 배포합니다. OPENAI_API_KEY는 GitHub에 커밋하지 않습니다.

### 13.3 Health Check

~~~text
GET /health/live
~~~

프로세스 생존만 확인합니다.

~~~text
GET /health/ready
~~~

OpenAI 키 설정, 모델 설정, Atlas ping, 청크 제한, 전역 quota pause 상태를 확인합니다. 준비되지 않은 경우 503과 구조화된 원인을 반환합니다.

## 14. 구현 변경 범위

### 서버

- server/gemini_client.py를 제거하고 server/openai_client.py를 추가합니다.
- openai SDK를 추가하고 google-genai 의존성을 제거합니다.
- Render 환경변수에서 OpenAI 키를 읽는 단일 클라이언트를 구현합니다.
- transcribe_chunk, translate_to_korean, summarize_final을 분리합니다.
- 한국어 청크는 불필요한 번역 요청을 하지 않습니다.
- source_transcript와 transcript_ko를 별도로 저장합니다.
- 번역 실패 시 저장된 원문으로 번역부터 재개합니다.
- Gemini 키 라우트·모델·오류 코드를 제거합니다.
- 전역 quota pause와 사용자별 paused_ai 상태를 구현합니다.
- 기존 ACK·idempotency·resume·archive·문서 API를 유지합니다.
- Render worker 1개, Python 3.12, $PORT 실행을 유지합니다.

### 확장 프로그램

- Gemini API 키 입력·교체·복구 UI를 제거합니다.
- 세션 생성 payload에서 API 키를 제거합니다.
- 기본 청크 60초·overlap 2초를 반영합니다.
- 한국어 자막과 원문 언어 상태를 표시합니다.
- ACK 전 IndexedDB 보존·재시도·복구를 유지합니다.
- quota 메시지를 운영자 조치 필요로 변경합니다.
- Render 재시작 후 사용자 키 재입력 없이 resume을 호출합니다.

### 문서·배포

- README·사용설명서를 V7 기준으로 갱신합니다.
- Render 환경변수에서 Gemini 항목을 제거하고 OpenAI 항목을 추가합니다.
- 운영자 OpenAI 키 등록·교체·폐기 절차를 문서화합니다.
- 운영자 비용 부담과 외부 API 전송 사실을 안내합니다.
- CI 통과 후 Render 수동 배포 정책을 유지합니다.

## 15. 테스트 기준

### 인증·보안

- 사용자 ID와 접속 코드가 맞아야 세션이 생성됩니다.
- 세션 생성 요청에 API 키가 없어도 정상 동작합니다.
- 사용자 간 세션·문서 접근이 격리됩니다.
- OpenAI 키가 로그·응답·Atlas에 나타나지 않습니다.
- 운영 확장 프로그램에 API 키 입력란이 없습니다.

### OpenAI 처리

- 한국어 청크는 Luna 번역을 호출하지 않습니다.
- 영어 청크는 원문 전사 후 한국어 변환을 호출합니다.
- 혼합 언어는 한국어 출력으로 정규화됩니다.
- 같은 청크 재전송 시 전사 API를 중복 호출하지 않습니다.
- 번역 재시도는 저장된 원문으로 수행합니다.
- 최종 요약은 archive에서 최대 한 번만 호출합니다.
- 키 없음·401·quota 429는 자동 반복하지 않습니다.
- 일시적 503은 15·30·45초 재시도합니다.

### Render·Atlas·복구

- health/live와 health/ready가 분리됩니다.
- Atlas 저장 성공 전 청크 ACK를 반환하지 않습니다.
- Atlas 장애 시 IndexedDB 원본이 유지됩니다.
- Render 재시작 후 사용자 키 재입력 없이 초안을 복구합니다.
- 완료 문서 저장 후 초안이 삭제됩니다.
- incomplete 초안은 7일 TTL 정책을 따릅니다.
- 사용자별 문서 목록·상세·삭제가 격리됩니다.

### 회귀

- 기본 설정이 60초·2초 overlap입니다.
- 5~600초 환경변수 범위가 검증됩니다.
- 413·415·422 청크가 삭제되지 않습니다.
- IndexedDB 128 MiB 상한과 72시간 보존 표시가 동작합니다.
- 한국어 TXT·원문 TXT·MD·SRT·VTT 내보내기가 유지됩니다.
- 다른 탭의 작업이 선택한 캡처 탭에 영향을 주지 않습니다.

## 16. 구현 순서

1. OpenAI 설정·오류 타입·클라이언트 모듈을 추가합니다.
2. Gemini 의존성·키 입력 API·키 입력 UI를 제거합니다.
3. gpt-transcribe 원문 전사와 Atlas 원문 저장을 구현합니다.
4. 비한국어 청크의 Luna 한국어 변환을 구현합니다.
5. 60초·2초 overlap과 서버 정규화를 연결합니다.
6. ACK·outbox·idempotency를 전사·번역 완료 기준으로 검증합니다.
7. archive의 한국어 자막 조합과 Luna 최종 요약을 연결합니다.
8. health/ready에 OpenAI 키·Atlas·quota 상태를 반영합니다.
9. 문서·사용설명서·Render 환경변수를 V7로 갱신합니다.
10. CI 통과 후 Render 수동 배포를 진행합니다.
11. 최대 7개 계정으로 한국어·영어·혼합 강의와 Render 재시작을 통합 검증합니다.

## 17. 운영자 입력값과 기본 결정

### 운영자 입력값

| 항목 | 용도 |
|---|---|
| Render HTTPS URL | 확장 프로그램의 고정 서버 주소 |
| Chrome Manifest 공개 키·확장 ID | 운영 확장 Origin과 CORS 허용 |
| OpenAI API 키 | Render Secret에서 전사·번역·요약에 사용 |
| MongoDB Atlas URI | 초안·완료 문서 저장 |
| 사용자 ID·접속 코드 | 최대 7명 수동 인증 |

### V7 기본 결정

- 출력 언어: 한국어
- 전사 모델: gpt-transcribe
- 번역·요약 모델: gpt-5.6-luna
- 기본 청크: 60초
- overlap: 2초
- 중간 요약: 사용하지 않음
- 최종 요약: 종료 시 1회
- API 키: 운영자 Render Secret 1개
- Render 배포: CI 통과 후 수동 배포
- Render 플랜: 무료로 시작
- 미완료 세션: incomplete 자동 보관 후 재개
- IndexedDB: 사용자별 128 MiB, 미처리 72시간 보존
- Atlas: 완료 직후 초안 삭제, incomplete 7일 보존

### 추가로 확정할 선택사항

- 실시간 화면에는 한국어 변환 자막만 표시하고, 원문은 문서에서 선택적으로 열람하는 방식으로 기본 설정합니다.
- 영어 강의의 원문 전사 TXT도 보관할지 여부는 개인정보·저작권 운영정책에 따라 결정합니다.
- OpenAI 키 교체 시 기존 진행 세션은 보존하고 운영자 배포 완료 후 재개합니다.

## 18. 공식 참고 문서

- GPT-5.6 Luna 모델 및 가격: https://developers.openai.com/api/docs/models/gpt-5.6-luna
- GPT-Transcribe 모델 및 분당 가격: https://developers.openai.com/api/docs/models/gpt-transcribe
- OpenAI API 요금표: https://developers.openai.com/ko-KR/api/docs/pricing
- 오디오 전사 API: https://developers.openai.com/api/reference/cli/resources/audio

## 19. 비용 참고(간략)

하루 3명, 1인 40분, 월 30일, 60초 청크·overlap 2초 기준으로 OpenAI 전사·한국어 변환·최종 요약 비용은 대략 **월 18~20달러 수준**으로 예상합니다. Render와 MongoDB Atlas 비용은 별도이며, 실제 금액은 음성 길이·토큰 수·재시도 횟수에 따라 달라집니다.

