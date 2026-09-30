# Chrome 강의 자막·요약 노트 설계서 v8 — GPT 전사 전환안

## 1. 문서 목적과 운영 전제

V8은 V7의 GPT 기반 구조를 운영 가능한 형태로 구체화한 설계입니다. Chrome 확장 프로그램이 영상 탭의 오디오를 수집하고, Render의 FastAPI 서버가 OpenAI API로 전사·한국어 변환·최종 요약을 수행하며, MongoDB Atlas에 영상 요청별 문서를 저장합니다. GPT 전사·15초 청크·1초 겹침·부분 문서 증분 반영과 `ko/en` 언어 힌트는 로컬 코드와 Render 설정 파일에 반영했습니다. 빈 전사 응답의 침묵 판별·1회 재전사·`...` 표시·원본 보존·명시적 재전사 절차도 로컬 코드에 반영하고 모의 응답으로 시험했습니다. 새 전사 경로의 실제 OpenAI·Atlas 통합 시험과 Render·Atlas 무료 플랜 부하 시험은 아직 완료되지 않았으며, 이번 변경의 Render 배포는 별도 단계입니다. 동시 사용 가능 범위는 무료 플랜 부하 시험 결과로 결정합니다.

- 등록 가능 계정은 기본 **10명**, 실제 동시 활성 사용자는 **5명**입니다. 두 제한은 별도 설정입니다.
- OpenAI API 키는 운영자가 Render Secret으로 한 번만 설정합니다.
- `gpt-transcribe`가 한국어 중심 오디오를 전사하고, GPT-6 Luna(`gpt-6-luna`)가 필요한 비한국어 자막 변환과 종료 시 최종 요약을 담당합니다. GPT 전사는 구간 타임스탬프를 반환하지 않으므로 청크 단위의 대략적인 시각만 표시합니다.
- 사용자는 사용자 ID와 접속 코드만 입력합니다.
- 운영자가 발급한 계정이 유효하면 설치 PC나 확장 프로그램 ID와 관계없이 모든 사용자 기능을 이용합니다. 기기 등록은 하지 않습니다.
- 북마크 기능은 제품 UI와 신규 전사·요약 데이터 범위에서 제외합니다.
- 청크는 15초, 겹침은 1초, 시작 간격은 14초입니다.
- 중간 요약 없이 캡처 종료 시 최종 요약을 한 번 생성합니다.
- 실패 오디오는 브라우저 IndexedDB에 72시간 보존합니다.
- 중단된 요청도 지금까지의 전사를 영상별 부분 문서로 남깁니다.
- 사이드 패널을 열 때 비동기 `/health/live`로 Render 연결을 확인하고, 캡처 시작 시 `/health/ready`로 Atlas 저장소 준비를 확인합니다. GPT 상태는 실제 AI 처리 응답으로만 표시합니다.
- Render 무료 Web Service와 Atlas 무료 클러스터를 기준으로 설계·부하 검증하며 배포는 관리자가 수동 실행합니다.

회원가입, 결제, 관리자 웹 콘솔, 대규모 분산 작업 큐는 범위에서 제외합니다.

## 2. V7에서 보완한 내용

| 항목 | V7 | V8 |
|---|---|---|
| 사용자 한도 | 7명 단일 한도 | **등록 10명 / 동시 활성 5명 분리** |
| 부분 문서 저장 | 종료·중단 시 중심 | **READY 청크 ACK 전에 동일 문서에 write-through upsert** |
| 오디오 시간축 | overlap 정의가 모호함 | **15초 창·14초 stride, media timeline 기준으로 구현** |
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
       ├─ 패널 열림: 비차단 `/health/live` 연결 확인, 최근 2~5분 결과 재사용
       ├─ 캡처 시작: `/health/ready` 저장소 준비 확인
       ├─ 15초 WebM/Opus 청크, 1초 overlap
       ├─ IndexedDB outbox (최대 128 MiB, 72시간)
       └─ HTTPS + 사용자 인증
                 │
                 ▼
Render FastAPI Web Service
  ├─ 사용자 인증·소유권 격리
  ├─ 최대 동시 사용자 5명
  ├─ 청크 검증·영속 lease·재시도 분류
  ├─ OpenAI GPT-Transcribe 전사 (청크 단위의 대략적 시각)
  ├─ OpenAI GPT-6 Luna 한국어 변환·최종 요약
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
| GPT-Transcribe (`gpt-transcribe`) | 한국어 중심 원언어 전사; 청크별 텍스트와 감지 언어 반환 |
| GPT-6 Luna (`gpt-6-luna`) | 비한국어 전사의 한국어 변환, 종료 시 최종 요약 |
| Atlas | 처리 상태, 전사, 부분·완료 문서, 공급자 상태, 사용량 |

캡처 시작 한 번을 하나의 영상 요청으로 봅니다. 서버는 세션 생성 시 `session_id`와 `document_id`를 함께 발급합니다. 동일 URL을 다시 캡처해도 새 문서를 만들며 기존 문서를 덮어쓰지 않습니다.

```text
영상 요청 1회 = session 1개 = document 최대 1개 = chunk 여러 개
```

## 4. 인증과 비밀정보

### 4.1 사용자 인증

- 운영자가 최대 10개 계정을 발급할 수 있으며 활성 사용자 lease로 동시 사용자 ID를 5개로 제한합니다. 같은 계정으로 여러 PC에서 접속할 수 있으며 PC 수는 제한하지 않습니다.
- 사용자는 발급받은 사용자 ID와 접속 코드만 입력합니다. 설치 PC, 확장 프로그램 ID, 기기 식별자 등록은 인증 절차에 포함하지 않습니다.
- 계정은 Atlas의 `app_users` 컬렉션에 저장합니다. `user_id`는 고유하며 문서·세션의 기존 `owner_id`와 동일한 불변 식별자입니다. 계정 상태(`active`/`disabled`), 코드 해시, 생성·수정 시각을 보관합니다.
- 사용자마다 충분히 긴 무작위 접속 코드를 발급하고 Atlas에는 SHA-256 해시만 저장합니다. 코드는 발급·재발급 응답에 한 번만 표시하고 로그에 기록하지 않습니다.
- 서버는 각 사용자 요청에서 Atlas 계정의 활성 상태와 코드 해시를 확인하고 상수 시간 비교를 수행합니다. Atlas 조회 실패는 인증 성공으로 처리하지 않습니다. 계정 중지와 코드 재발급은 다음 요청부터 적용합니다.
- 인증 실패는 IP와 사용자 ID 해시 단위로 짧은 시간당 횟수를 제한합니다.
- 모든 조회·수정·삭제 쿼리는 인증된 `owner_id` 조건을 포함합니다.
- 계정 중지 후 기존 문서와 초안은 유지하되, 해당 계정의 조회·캡처·재개·삭제 요청을 모두 거부합니다. 코드를 재발급해도 `user_id`는 바꾸지 않으므로 기존 문서 소유권이 유지됩니다.

```dotenv
APP_AUTH_MODE=atlas_users
ADMIN_ACCESS_TOKEN=<관리자 전용 긴 무작위 비밀값>
MAX_REGISTERED_USERS=10
MAX_CONCURRENT_USERS=5
SAFETY_IDENTIFIER_SECRET=<랜덤 비밀값>
```

### 4.2 계정 발급과 관리

- 관리자는 계정 관리 명령으로 사용자 ID를 지정해 계정을 발급하고, 출력된 접속 코드를 사용자에게 전달합니다. 발급·중지·재발급·목록 확인은 관리자 전용 HTTPS API를 통해 처리하며 관리자 웹 콘솔은 만들지 않습니다.
- 관리자 API는 일반 사용자 접속 코드와 별도의 `ADMIN_ACCESS_TOKEN`으로 보호합니다. 이 값은 Render Secret과 관리자 비밀번호 관리 도구에만 보관하고 확장 프로그램에 전달하지 않습니다. 관리자 요청도 실패 횟수를 제한하며 비밀값과 발급 코드를 로그에 남기지 않습니다.
- 계정 발급 시 중복 사용자 ID와 등록 한도를 검사합니다. 중지된 계정을 재활성화하는 절차는 별도로 제공하며, 사용자 ID를 삭제·재사용하지 않습니다.
- 기존 `APP_USER_n_ID/TOKEN_SHA256`은 동일한 사용자 ID와 해시로 Atlas에 한 번 이관합니다. 전환 배포 시 변수가 남아 있으면 서버 시작 시 자동 이관하고, 먼저 제거되었다면 관리자 전용 해시 이관 명령을 사용합니다. 이관·검증 후 Render의 사용자별 환경변수를 제거합니다. 기존 사용자의 문서 소유권과 접속 코드는 유지됩니다.
- 평상시 계정 추가·중지·재발급에는 Render 설정 변경이나 재배포가 필요하지 않습니다.

### 4.3 OpenAI 키

- `OPENAI_API_KEY`는 Render Secret에만 저장합니다.
- 확장 프로그램, GitHub, Atlas 문서, 로그에는 키를 저장하지 않습니다.
- 브라우저가 OpenAI를 직접 호출하지 않습니다.
- `safety_identifier`는 `HMAC-SHA256(SAFETY_IDENTIFIER_SECRET, owner_id)`의 비식별 값으로 만듭니다.

## 5. AI 처리 계약

### 5.1 언어 처리

- 한국어 강의를 기본 입력으로 삼고, 감지 언어가 한국어이면 전사 결과를 한국어 자막으로 사용합니다. 기술 용어·제품명·영어 약어는 가능한 한 발화한 표기로 남깁니다.
- 한국어 중심·혼합 강의의 `gpt-transcribe` 요청에는 `languages=["ko", "en"]` 힌트와 한국어 강의 맥락의 `prompt`를 보냅니다. 언어 힌트는 예상 입력 언어이며 출력을 두 언어로 강제하거나 번역을 지시하지 않습니다. 영어 기술 용어는 발화한 표기로 보존합니다.
- `keywords`는 기본 요청에 넣지 않습니다. 실제 강의 검증에서 특정 제품명·약어가 반복해서 잘못 전사될 때만 해당 강의에 관련된 짧은 용어 목록을 선택적으로 전달합니다. 힌트에 든 단어가 실제 발화 없이 삽입되지 않았는지 회귀 검증합니다.
- 감지 언어 응답의 `languages[]`를 파싱합니다. 결과가 비거나 불확실하다는 이유만으로 한국어 전사를 번역하지 않습니다. 명확히 비한국어로 판정된 강의만 원문을 보존하고 GPT-6 Luna로 자연스러운 한국어 자막을 만듭니다.
- 혼합 언어의 코드·제품명·고유명사는 가능한 한 원문 표기를 유지합니다.
- 번역 reasoning effort는 `none`, 최종 요약은 `low`가 기본입니다.
- 한국어·영어·혼합 기술 강의 검증 코퍼스로 품질 회귀 테스트를 합니다.

### 5.2 전사 요청

`gpt-transcribe` 요청 계약(로컬 구현, 실제 API 검증 대기):

- 확장자가 있는 파일명(예: `chunk-000012.webm`)과 `audio/webm` MIME을 전달합니다.
- `model=gpt-transcribe`를 사용합니다. Whisper 전용 `response_format=verbose_json`·`timestamp_granularities`와 단일 `language` 요청·응답 가정을 제거합니다.
- 응답의 `text`와 `languages[]`를 검증합니다. `text` 누락·비문자열이나 잘못된 `languages` 형식은 공급자 응답 오류로 처리합니다. `languages=[]`는 언어 판정 불확실을 뜻하며 침묵 근거로 사용하지 않습니다. 사용자에게 보이는 자막의 원문과 공급자 메타데이터는 기존 청크 계약으로 변환합니다.
- 단어·문장 시각을 추정 사실처럼 저장하지 않습니다. 내용이 있는 청크는 청크 전체 구간의 coarse segment 하나로 저장하고 `uncertain=true` 및 청크 메타데이터의 `timestamp_uncertain=true`를 기록합니다. 문장별 강제 정렬 모델은 Render에서 실행하지 않습니다.
- 브라우저의 청크 시작 시각과 재생 배속으로 coarse segment의 절대 영상 시각을 계산합니다. 실시간 표시 지연은 최소 청크 종료 시점과 API 응답 시간의 합으로 취급합니다.
- 1초 겹침 구간의 중복 문구는 인접 청크의 접미·접두 텍스트를 순서대로 비교해 보수적으로 제거합니다. 확실하지 않은 문구는 자동 삭제하지 않고 검토 가능한 상태로 보존합니다. 문장 중간이 잘린 경우와 침묵 구간을 한국어 코퍼스로 검증합니다.

#### 빈 전사 응답 처리(로컬 구현, 실제 음성 검증 대기)

1. 브라우저는 기존 `AudioContext`에서 녹음 청크별 음량을 가볍게 측정하고 `quiet`·`non_silent`·`unknown` 중 하나를 오디오와 함께 outbox에 보존해 서버에 전달합니다. 충분한 측정값이 있고 청크 전체가 보수적으로 정한 무음 기준 아래일 때만 `quiet`로 분류합니다. 측정 누락·기존 확장 프로그램 요청은 `unknown`입니다. 음량은 음성 판정이 아니므로 음악·배경음이 있는 청크를 무음으로 단정하지 않습니다. 문턱값과 측정 범위는 실제 한국어 강의·조용한 발화·음악 자료로 검증합니다.
2. 정상 형식의 GPT 응답에서 `text`가 공백뿐이고 오디오가 `quiet`이면 침묵 청크로 `ready` 저장합니다. 자막 세그먼트는 비우고 침묵 판정 근거를 청크 메타데이터에 기록합니다. 세션 순번과 부분 문서 반영이 끝난 뒤에만 ACK를 반환합니다. 이 경우 재전사하지 않습니다.
3. `text`가 공백뿐인데 오디오가 `non_silent` 또는 `unknown`이면 같은 원본 오디오를 **최대 한 번만** 추가 전사합니다. 두 번째 응답에 내용이 있으면 정상 저장합니다. 다시 비어 있으면 `review_required=true`인 READY 청크와 청크 전체 구간의 `...` 세그먼트를 저장합니다. 화면에는 `...`만 표시하고 다음 순번으로 진행합니다. 이는 실제 무음 확정이 아니라 전사 확인 필요 상태입니다. 서버 응답에도 `review_required=true`를 넣어 확장이 ACK 후에도 IndexedDB 원본을 `REVIEW` 상태로 보존하게 합니다.
4. `text`가 누락되거나 형식이 잘못된 응답은 침묵으로 처리하지 않습니다. 제한된 공급자 오류 재시도 후에도 유효한 응답을 받지 못하면 ACK 없이 원본을 보존합니다. 추가 전사 요청도 호출·오디오 사용량 및 비용 기록에 포함하고, 사용자·전체 일일 한도를 넘지 않도록 검사합니다.

전사 확인 필요 청크는 순번 처리를 위해 READY로 계산하지만 완전한 최종 요약의 입력으로 사용하지 않습니다. 종료 시 `unverified_sequences`에 해당 순번을 기록하고 문서를 `incomplete`로 유지하며, `...`을 제외한 확보된 자막만 부분 요약합니다. 원본은 브라우저에서 72시간 보존하고 내보낼 수 있습니다. 사용자가 `보존 청크 재전사`를 누른 경우에만 `review_retry=true`로 같은 오디오를 다시 전사합니다. 음성 복구에 성공하면 기존 `...`을 교체하고 부분 문서를 재구성합니다. 다시 비면 `...`과 원본을 유지합니다. 모든 미확인 구간이 해결된 뒤 재종료하면 완전한 문서로 확정할 수 있습니다.

### 5.3 한국어 변환과 최종 요약

GPT-6 Luna는 이 구조에서 오디오 입력을 처리하지 않습니다. 오디오 전사는 `gpt-transcribe`, 필요한 비한국어 자막 변환과 최종 요약은 GPT-6 Luna의 Responses API가 담당합니다.

- `model=gpt-6-luna`
- `store=false`
- 도구 호출 비활성화
- 엄격한 JSON Schema Structured Outputs
- 전사문은 신뢰할 수 없는 데이터로 취급하고 전사문 안의 명령을 수행하지 않도록 시스템 지침에 명시
- `prompt_version`, `schema_version`, `requested_model`, `resolved_model` 기록

한국어 변환 출력은 `language`, `translated`, `segments[]`, `warnings[]`를 요구합니다. 최종 요약은 `summary`, `concepts`, `terms`, `highlights`, `checklist`를 요구하며 `summary`가 빈 문자열 또는 공백뿐이면 실패로 처리합니다. 최종 요약 입력은 완성된 전사만 사용하며 북마크·시점 메모는 생성하거나 포함하지 않습니다.

엄격한 스키마 검증 실패나 반복 번역 실패가 확인된 경우에만 선택적 fallback을 허용합니다.

```dotenv
OPENAI_TEXT_FALLBACK_MODEL=gpt-5.6-terra
TEXT_FALLBACK_ENABLED=false
```

fallback은 향후 선택 기능이며 현재 코드에는 호출 로직이 구현되어 있지 않습니다. 현재 운영 요청은 번역·요약 모두 GPT-6 Luna를 사용합니다. fallback을 구현할 때는 주관적인 품질 판단만으로 자동 전환하지 않고, fallback 비용을 별도로 기록합니다.

### 5.4 공급자 재시도

- 네트워크 오류와 5xx는 최대 3회 재시도합니다.
- `Retry-After`가 있으면 그 값을 우선합니다.
- 없으면 `15±3초`, `30±6초`, `45±9초` jitter를 적용합니다.
- 429의 code/type을 파싱해 순간 rate limit과 quota 소진을 구분합니다.
- quota 소진은 반복 재시도를 중단하고 `service_state`에 pause를 저장합니다.
- 실패 청크는 Atlas와 브라우저 outbox에 남깁니다.
- 공급자 호출의 정확히 한 번 실행을 보장한다고 주장하지 않습니다. `provider_request_id`, `attempt_id`를 기록하고 DB 결과를 멱등 반영합니다.

## 6. 오디오 청크와 브라우저 outbox

### 6.1 운영 설정

```dotenv
AUDIO_CHUNK_SECONDS=15
AUDIO_CHUNK_OVERLAP_SECONDS=1
AUDIO_BITS_PER_SECOND=64000
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
- 각 청크는 길이 15초, 시작 간격(stride)은 14초입니다. 한 시간 녹음은 끝 청크 처리 방식에 따라 약 257~258개의 청크를 만듭니다. `media_start_ms`는 영상 시간축 기준이며 서버는 이를 절대 자막 시각의 기준으로 사용합니다.
- 절대 자막 시각은 `round(media_start_ms + relative_ms × playback_rate)`로 계산합니다. 겹침 판정 범위도 `overlap_ms × playback_rate`로 환산해 배속 재생 시 화면 자막과 Atlas 문서가 같은 영상 시각을 사용합니다.
- GPT 전사 결과의 coarse segment는 청크 안의 세부 발화 시각을 보장하지 않습니다. overlap 구간에서 청크 전체 텍스트가 완전히 같을 때만 제거하는 기존 세그먼트 규칙은 충분하지 않으므로, 인접 청크의 접미·접두 중복을 별도로 비교합니다. 원문이 달라 자동 병합이 불확실한 경우 둘 다 보존하고 누락·중복 가능성을 검증합니다.

```text
CAPTURED → UPLOADING → ACKED
              ├─ REVIEW (ACK 뒤 원본 보존·명시적 재전사)
              ├─ RETRY_WAIT
              ├─ QUOTA_PAUSED
              └─ FAILED_PERMANENT
```

일반 ACK를 받은 청크만 브라우저에서 삭제합니다. `review_required=true` 응답을 받은 청크는 ACK되더라도 원본을 `REVIEW`로 72시간 보존합니다. 일시 실패와 quota pause의 오디오도 보존합니다. 사용자별 128 MiB 상한 전에 캡처를 중지하고 내보내기 또는 폐기를 안내합니다.
`REVIEW` 청크는 자동 전송 반복 대상에서 제외하며, 사용자 명시적 재처리 때만 다시 보냅니다. 서버는 오디오 해시와 `review_required` 상태를 검사한 뒤 성공한 재전사를 기존 청크에 반영하고 부분 문서를 재구성합니다. 종료 대기 중 다른 청크에서 영구 오류가 발생하면 해당 오류 안내를 주기적인 대기 문구로 덮지 않습니다.

### 6.3 서버 동시성

```dotenv
MAX_CONCURRENT_USERS=5
OPENAI_MAX_IN_FLIGHT=3
OPENAI_QUEUE_WAIT_SECONDS=30
```

- 활성 사용자 lease로 동시 사용자를 5명으로 제한합니다.
- 같은 세션의 청크는 순차 처리합니다.
- 프로세스 전체 OpenAI 동시 호출은 3개로 시작하고 부하 테스트 후 조정합니다.
- semaphore를 30초 안에 얻지 못하면 `ai_backpressure`를 반환하고 오디오는 outbox에 남깁니다.
- 메모리 semaphore는 처리량 제어용이며 중복 방지 수단이 아닙니다.
- 15초·1초 조건의 유입률은 사용자당 약 1/14 청크/초, 동시 사용자 5명일 때 약 0.36 청크/초입니다. OpenAI 동시 호출 3개만 놓고 보면 평균 슬롯 점유 시간이 약 8.4초를 넘을 때 지속 대기열이 생길 수 있으므로, 공급자 응답과 저장 지연을 포함한 실측으로 판단합니다.

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
  "partial_sync_pending": false,
  "last_error_code": null,
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

`document_id`는 세션 생성 시 발급합니다. MongoDB 재개는 세션 만료 판정, 필요한 READY 청크 확인, 세션·청크의 `expire_at` 제거, 활성 사용자 lease 갱신을 한 트랜잭션으로 수행합니다. 누락 청크 또는 트랜잭션 충돌이 있으면 성공 응답을 반환하지 않습니다. 로컬 메모리 저장소는 같은 작업을 잠금으로 보호합니다.

### 7.2 `lecture_session_chunks`

```json
{
  "session_id": "uuid",
  "owner_id": "user-001",
  "sequence": 0,
  "status": "processing|ready|retry_wait|blocked|failed",
  "audio_sha256": "...",
  "original_text": "...",
  "korean_text": "...",
  "segments": [],
  "review_required": false,
  "timestamp_uncertain": true,
  "attempt_id": "uuid",
  "lease_until": "datetime",
  "attempt_count": 1,
  "provider_request_id": "...",
  "requested_model": "gpt-transcribe",
  "resolved_model": "...",
  "prompt_version": "transcribe-gpt-v1",
  "schema_version": 1,
  "expire_at": "datetime"
}
```

처리 시작은 상태와 만료된 lease를 조건으로 한 원자적 claim입니다. 결과와 오류 상태를 기록할 때도 `status=processing`과 해당 `attempt_id`를 조건으로 갱신합니다. lease 만료 뒤 새 시도가 시작되었다면 늦게 끝난 이전 시도는 DB 결과를 덮어쓰지 못하고 재시도 가능 응답을 반환합니다. `(session_id, sequence)` 유니크 인덱스와 처리 lease로 재시작·배포 후 중복 DB 반영을 막습니다.

### 7.3 `lecture_documents`

```json
{
  "document_id": "uuid",
  "session_id": "uuid",
  "owner_id": "user-001",
  "status": "incomplete|completed",
  "resume_status": "available|expired|not_needed",
  "summary_status": "not_run|processing|completed|failed|input_too_large",
  "summary_scope": "partial|complete|null",
  "summary_error_code": null,
  "requested_at": "datetime",
  "completed_at": null,
  "source": {
    "url": "sanitized canonical URL",
    "canonical_url": "canonical URL",
    "url_hash": "sha256",
    "host": "www.youtube.com",
    "video_id": "...",
    "title": "sanitized title"
  },
  "transcript": {
    "original_text": "...",
    "text": "...",
    "segments": [],
    "ready_chunk_count": 2,
    "last_applied_sequence": 1,
    "expected_chunk_count": 3,
    "missing_sequences": [2],
    "unverified_sequences": []
  },
  "summary": null,
  "requested_model": "gpt-6-luna",
  "resolved_model": null,
  "prompt_version": "summary-v1",
  "schema_version": 8,
  "document_bytes": 0,
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

READY 청크가 생길 때마다 서버는 같은 `document_id`의 부분 문서를 갱신합니다. 현재 로컬 코드는 첫 청크·검토 필요 청크·복구 시 전체 READY 청크를 재조회해 문서를 구성하고, 이후 정상 순번은 `sequence`와 마지막 반영 순번을 조건으로 증분 반영합니다. 청크 저장·세션 순번·부분 문서 반영이 확인된 뒤에만 브라우저에 ACK를 반환합니다. 일반 ACK에서는 원본을 삭제하지만 `review_required=true` ACK에서는 원본을 보존합니다. 재전송에서는 이미 반영된 순번을 중복 추가하지 않고, 검토 청크를 명시적으로 재전사해 성공하면 해당 세그먼트를 교체하고 문서를 재구성합니다. 부분 문서는 **7일 후에도 삭제하지 않습니다**. 7일 후 재개용 세션·청크 초안만 TTL 대상으로 삼고 문서는 `resume_status=expired`로 표시합니다.

Atlas 무료 클러스터에서는 청크 수 증가에 따른 문서 재작성량과 저장 크기를 함께 측정합니다. 과거 방식처럼 매 청크마다 누적 전사를 모두 다시 쓴다면, 한 시간의 약 257개 청크에서 세그먼트 반영량 합계가 약 3.3만 건으로 증가합니다. 현재 증분 반영의 실제 Atlas 동작과 성능은 무료 플랜 시험에서 검증해야 합니다.

북마크는 신규 문서 스키마와 신규 archive 결과에 포함하지 않습니다. 기존 Atlas 문서에 이미 존재하는 `bookmarks` 필드는 마이그레이션으로 삭제하지 않고 레거시 데이터로 보존하며, 새 확장 프로그램 UI에서는 표시하지 않습니다.

청크가 `ready`로 저장된 뒤 세션 순번 또는 부분 문서 갱신이 실패하면 ACK하지 않습니다. 동일 청크 재전송에서는 오디오 해시를 확인하고 `next_sequence`와 부분 문서를 다시 갱신한 뒤 기존 전사를 ACK합니다. 부분 문서가 `completed`로 확정된 뒤에는 늦은 부분 문서 쓰기로 상태를 되돌리지 않습니다.

최종 저장 전 BSON 크기를 계산합니다. `MAX_DOCUMENT_BYTES=12000000`을 넘으면 자르지 않고 부분 문서를 유지하며 `summary_status=input_too_large`, 세션을 `finalize_pending`으로 둡니다. 장시간 강의가 늘면 segments 전용 컬렉션 분리를 검토합니다.

### 7.4 `service_state`

```json
{
  "_id": "openai",
  "code": "openai_quota_exhausted",
  "retry_after_seconds": null,
  "updated_at": "datetime"
}
```

최근 공급자 오류와 재시도 정보를 저장해 재시작 후에도 운영자가 원인을 확인할 수 있게 합니다. quota 오류는 확장 프로그램이 자동 반복을 중단하고 운영자 조치 후 명시적으로 다시 시도합니다.w

### 7.5 `daily_usage`

```json
{
  "owner_id": "user-001",
  "day": "2026-09-21",
  "audio_ms": 2400000,
  "transcription_requests": 40,
  "text_input_tokens": 12000,
  "text_output_tokens": 3000,
  "estimated_cost_usd": 0.22,
  "updated_at": "datetime"
}
```

사용량은 `(owner_id, day)` 원자적 증가로 기록합니다. 사용자·전체 일일 오디오 제한은 OpenAI 호출 전에 확인합니다.

### 7.6 필수 인덱스

```text
lecture_sessions:       unique(session_id), (owner_id, requested_at), TTL(expire_at)
lecture_session_chunks: unique(session_id, sequence), (session_id, status), TTL(expire_at)
lecture_documents:      unique(document_id), unique(session_id),
                        (owner_id, requested_at desc), (owner_id, source.url_hash)
service_state:          unique(_id)
daily_usage:            unique(owner_id, day), (day)
```

완료·부분 문서에는 TTL 대상 `expire_at`을 넣지 않습니다.

### 7.7 URL 개인정보 처리

- fragment를 제거합니다.
- `token`, `key`, `auth`, `signature`, `session` 등 민감 쿼리를 제거합니다.
- `utm_*`, `fbclid` 등 추적 파라미터를 제거합니다.
- 지원 사이트는 영상 식별에 필요한 쿼리만 allowlist합니다.
- 정규화 URL의 SHA-256을 저장하고 해시 필드에 인덱스를 둡니다.
- 현재 YouTube 도메인은 영상 식별용 `v`만 허용하며 다른 도메인은 쿼리를 저장하지 않습니다. URL 사용자 정보도 제거하고, 서버의 세션·문서에는 정리된 URL만 저장합니다. 브라우저의 로컬 복구 매칭에는 원래 탭 URL을 사용할 수 있습니다.
- 서버 시작 시 기존 세션·문서의 URL도 같은 규칙으로 정리합니다.
- 제목과 클라이언트 메타데이터는 길이·제어문자·HTML을 검증합니다.

## 8. API 설계

사용자 `/v1` 요청은 `X-User-Id`, `Authorization: Bearer <접속 코드>`를 요구합니다. 관리자 전용 요청은 별도 관리자 비밀값을 사용합니다. 오류 응답은 `code`, `message`, `retryable`, `retry_after_seconds`, `request_id`를 공통으로 가집니다.

관리자 계정 API는 계정 발급, 목록 조회, 중지, 재활성화, 접속 코드 재발급을 제공합니다. 일반 사용자 인증 경로와 분리하며 계정 발급·재발급 응답 외에는 접속 코드를 반환하지 않습니다.

### 8.1 세션과 연결 확인

```text
GET  /health/live
GET  /health/ready
POST /v1/sessions
POST /v1/sessions/{session_id}/resume
```

사이드 패널을 열면 `/health/live`를 **비동기로 한 번** 호출해 Render 앱의 생존 여부만 확인합니다. 이 확인은 Atlas·OpenAI를 검사하지 않으며, UI나 캡처 시작 버튼을 막지 않습니다. 최근 확인 결과는 `chrome.storage.session`에 기록하며 기본 캐시 180초(허용 120~300초) 동안 재오픈 시 중복 호출을 줄입니다. 결과가 실패여도 패널 재오픈 확인은 캐시되지만, 캡처 시작의 저장소 확인은 별도 요청으로 다시 수행합니다. 주기적 폴링은 하지 않습니다.

캡처 시작 버튼을 누르면 `/health/ready`를 새로 호출해 Atlas 저장소 `ping()`을 확인합니다. HTTP 200과 `status=ok`일 때만 세션 생성 및 캡처를 진행합니다. `503 storage_unavailable`처럼 오류 HTTP 응답을 받았더라도 Render 앱이 응답한 사실은 분리 기록하므로 UI는 `Render 연결 완료`와 `저장소 확인 필요`를 동시에 표시합니다. 네트워크 오류·시간 초과로 응답 자체를 받지 못하면 Render 연결은 확인 실패, 저장소는 미확인으로 표시합니다.

`/health/ready`는 GPT 연결을 시험하지 않고 API 호출·비용·쿼터를 소비하지 않습니다. GPT 상태는 실제 청크 전사나 최종 요약의 성공·오류 응답으로만 갱신합니다. 따라서 Render와 Atlas가 준비돼 있어도 실제 GPT 요청 전에는 GPT 상태가 `실제 요청 전`이며, 이후에는 성공·할당량 소진·속도 제한·과부하·요청 오류 등을 구분합니다. 모의 모드가 서버 설정에서 확인되면 이를 GPT 성공과 구별해 표시합니다.

Chrome `tabCapture.getMediaStreamId()`는 사용자 동작 뒤 호출해야 하며 발급된 stream ID는 사용하지 않으면 몇 초 안에 만료됩니다. 따라서 캡처 시작의 저장소 확인에 2.5초 넘게 걸리면 첫 요청은 서버 준비까지만 완료하고, 패널에서 `서버가 준비됐습니다. 캡처 시작을 다시 눌러 주세요.`라고 안내합니다. 확인 중에도 다른 패널 UI는 계속 사용할 수 있습니다.

세션 생성은 정규화한 영상 메타데이터를 받고 `session_id`, `document_id`를 반환합니다. `/health/ready`가 성공했다는 사실만으로 사용자 ID·접속 코드 인증이나 동시 사용자 한도 확보가 완료된 것으로 간주하지 않습니다.

### 8.2 청크

```text
POST /v1/sessions/{session_id}/chunks
```

업로드는 `(session_id, sequence, audio_sha256)`로 멱등 처리합니다. 동일 순번·동일 해시는 기존 결과를 반환하고, 동일 순번·다른 해시는 `409 chunk_conflict`를 반환합니다.
청크 업로드에는 오디오와 함께 브라우저가 측정한 무음 근거를 전달합니다. 이 값은 인증 수단이나 GPT 결과의 대체물이 아니며, 빈 전사 응답을 보수적으로 분류할 때만 사용합니다. 새 확장은 `review_handling_version=1`을 보내 원본 보존 응답을 처리할 수 있음을 알립니다. 두 번 빈 전사의 응답은 `segments=[{"text":"...", ...}]`와 `review_required=true`를 포함합니다. 확장은 다음 청크로 진행하지만 원본 오디오는 `REVIEW`로 보존합니다. 구버전 확장이 이 기능을 알리지 않으면 서버는 기존 422를 반환해 원본을 삭제하지 않게 합니다. 사용자 명시적 재전사는 동일 해시의 원본과 `review_retry=true`를 보내며, 서버는 확인 필요 READY 청크만 교체할 수 있습니다.

### 8.3 종료와 복구

```text
POST /v1/sessions/{session_id}/archive
```

archive 순서:

1. 캡처 종료와 `expected_chunk_count` 확정
2. 업로드 중 요청 drain
3. `0..expected_chunk_count-1` 누락 검사와 브라우저가 전달한 녹음 중단 구간(`capture_gaps`) 검사
4. READY 청크로 부분 문서 원자적 upsert
5. 순번 누락, `unverified_sequences`, 길이가 0보다 큰 녹음 중단 구간 중 하나라도 있으면 `incomplete`를 유지한다. 확보된 전사가 있으면 `...`을 제외한 전사만 부분 요약하고 `summary_scope=partial`로 저장한다. 전사가 없으면 `summary_status=not_run`으로 둔다.
6. 세 종류의 미확인·누락이 모두 없으면 finalize lease를 획득해 완전한 요약을 진행한다.
7. 전체 한국어 자막 조합과 BSON·요약 입력 크기 검사
8. GPT-6 Luna 최종 요약 실행. 일시적 연결·시간 초과·속도 제한은 제한된 횟수로 재시도할 수 있으며, 최종 결과는 한 번만 DB에 확정
9. 요약 본문·요약 메타데이터·`summary_status=completed`·`status=completed`를 같은 문서의 단일 원자적 쓰기로 확정
10. 완료 저장 성공 후 세션·청크 초안 삭제

신규 확장 프로그램은 archive 요청에 북마크를 보내지 않으며 서버는 전사만으로 최종 요약을 생성합니다. 이전 확장 프로그램과의 전환 기간에는 레거시 `bookmarks` 입력 필드를 선택적으로 받아도 저장하거나 OpenAI 요약에 전달하지 않습니다. 기존 완료 문서의 필드는 보존하며, 레거시 입력 허용을 제거하는 변경은 구버전 확장 프로그램 지원 종료 후 별도로 수행합니다.

요약이 포함된 완료 문서가 이미 있으면 초안 정리를 다시 시도한 뒤 기존 결과를 반환합니다. finalization 도중 실패하면 자막 문서를 유지하고 `finalize_pending`과 오류 코드를 기록합니다. 요약이 없는 문서를 완료 응답으로 반환하지 않습니다.

최종 저장 요청은 클라이언트에서 최대 480초를 기다립니다. 서버의 GPT 요청은 건당 60초, 재시도 대기는 회당 최대 60초로 제한하고 finalize lease는 600초로 유지합니다. 캡처 종료 시 브라우저는 요청 전에 `FINALIZE_PENDING` 마커를 IndexedDB에 기록해 패널 종료·네트워크 단절 뒤에도 같은 세션을 재시도할 수 있게 합니다. `409 finalize_in_progress`, 재시도 가능한 `429`·`502`·`503` 응답은 지연 후 다시 요청하고, 할당량 소진과 영구적인 `422`는 자동 재시도하지 않습니다. 재시도 전에 완료 문서가 확인되면 기존 결과를 반환합니다.

요약 실패 시 문서의 `summary_status=failed`와 `summary_error_code`를 기록합니다. 구조화 응답의 요약 본문이 비어 있는 경우 서버 검증에서 거부하고 재시도 가능한 `openai_invalid_response`로 반환합니다. DB 저장 오류를 OpenAI 오류로 바꿔 표시하지 않으며, 오류가 나도 전사 초안과 보존 청크는 유지합니다. 미완료 문서의 부분 요약은 빠진 내용을 추측하지 않으며, 문서 상태를 `completed`로 바꾸지 않습니다. 같은 전사에 대해서는 재요청해도 기존 부분 요약을 반환하고, 청크가 추가되면 오래된 부분 요약을 지운 뒤 다시 생성합니다. 기존 미완료 문서는 상세 화면의 `확보된 자막으로 부분 요약 생성`으로 같은 archive 요청을 재실행합니다.

### 8.4 문서 조회

```text
GET /v1/documents?limit=20&cursor=<opaque>
GET /v1/documents/{document_id}
```

목록은 본문 전사와 공급자 응답 메타데이터를 제외하고 반환합니다. 전체 전사·세그먼트·요약은 상세 API에서만 반환합니다. 커서 페이지네이션은 문서 수가 증가할 때 추가하는 다음 단계 개선입니다.

### 8.5 삭제 정책

```text
DELETE /v1/documents/{document_id}
DELETE /v1/sessions/{session_id}
```

- 문서 삭제는 해당 사용자의 문서와 연결된 서버 세션·청크 초안을 cascade 삭제합니다.
- 복구 초안만 삭제하면 부분 문서는 유지하고 `resume_status=expired`로 바꿉니다.
- 브라우저 outbox는 확장 프로그램에서 별도 확인 후 삭제합니다.
- completed 문서 삭제는 복구 불가능하다는 확인 UI를 거칩니다.

확장 프로그램은 사용자 ID·접속 코드를 받아 서버 초안 삭제를 확인한 뒤 outbox를 지웁니다. 서버 삭제에 실패하면 로컬 청크와 세션 ID를 유지하고 재시도를 안내합니다. 서버 초안과 부분 문서의 재개 상태 갱신은 한 트랜잭션으로 처리합니다.

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

녹음 중단 구간은 청크 재전송만으로 채워지지 않습니다. 필요한 구간을 다시 캡처하거나 부분 문서로 유지해야 하며, `archive`의 HTTP 200만으로 완료를 판단하지 않고 응답의 `saved`와 `status`를 확인합니다. 브라우저는 누락 구간을 outbox 세션 마커에도 기록합니다.

## 10. 무료 Render 환경의 복구

무료 인스턴스는 절전·재시작·배포될 수 있으므로 메모리 타이머에 의존하지 않습니다. 서버 프로세스에 세션 기록이 없는데 청크가 도착하면 Atlas 초안과 READY 청크의 연속성을 확인하고, 사용자 lease와 TTL을 갱신한 뒤 같은 세션 ID로 자동 복원합니다. 중복 청크는 기존 멱등 규칙으로 ACK합니다. 복원 실패 중 일시적 오류는 원본 청크를 outbox에 보존하고 지연 재시도하며, 영구적인 인증·만료 오류는 녹음을 멈추고 사용자 조치를 요청합니다.

확장 프로그램이 이미 녹음 중인 경우 복구를 위해 새 tabCapture 스트림을 만들지 않습니다. 캡처가 종료되거나 스트림이 사라진 뒤에도 보존 청크가 있으면 사이드 패널에 `보존 청크 처리`를 제공하며, 이 경로는 tabCapture 권한 없이 인증 정보를 다시 받아 Atlas 초안을 복원하고 outbox를 전송한 뒤 `archive`를 다시 시도합니다. 전송 도중 패널 또는 offscreen 문서가 닫히면 outbox에서 다시 시작할 수 있습니다. 부분 문서와 원본 오디오는 처리 결과를 확인하기 전까지 삭제하지 않습니다.

다음 시점마다 stale-session reconciliation을 실행합니다.

- FastAPI 시작 시
- 문서 목록·상세 조회 시
- 세션 상태·재개 요청 시
- archive/finalize 요청 시

reconciliation은 만료된 processing lease를 해제하고, 오래된 processing 상태를 retryable로 되돌립니다. 마지막 갱신 후 `SESSION_IDLE_TTL_SECONDS`가 지난 활성 세션은 `incomplete`와 7일 뒤 `expire_at`으로 전환하고 청크 초안에도 만료 시각을 기록합니다. 해당 부분 문서 갱신에 실패하면 `partial_sync_pending`을 남겨 다음 시작·조회·재개·종료 시 다시 시도합니다. 7일이 지난 초안의 문서는 삭제하지 않고 `resume_status=expired`로 갱신합니다. 백그라운드 정리는 보조 수단입니다.

## 11. 확장 프로그램 UI

### 11.1 혼합형 사이드 패널

기본 화면은 기존 짙은 남색·파랑 강조색을 유지하면서 다음 순서로 배치합니다.

1. `LECTURE MEMO`와 `강의 자막 노트` 제목, 서버 상태 표시
2. 간결한 사용자 정보 영역
3. 현재 영상 정보와 주요 `캡처 시작` 버튼
4. 경과 시간·처리 청크·보존 큐 크기의 간결한 통계
5. `자막`, `요약`, `저장 문서` 결과 영역
6. 보존 오디오 내보내기와 확인 후 삭제 같은 보조 작업

사용자 정보는 사용자 ID와 접속 코드 입력란을 항상 크게 노출하지 않습니다. 사용자 ID와 접속 코드가 입력된 상태에서는 사용자 ID와 `접속 코드 입력됨` 표시만 간결하게 보여주고 `변경` 동작으로 입력란을 다시 엽니다. 최초 실행, 필수 정보 누락 또는 인증 실패 시에는 입력란을 펼쳐 수정할 수 있게 합니다. 접속 코드 원문은 요약 영역에 노출하지 않으며, 입력이 완료된 것만으로 서버 인증이 성공했다고 표시하지 않습니다. 캡처·복구 처리 중에는 인증 정보를 변경할 수 없습니다.

이 화면 축약은 자격정보를 영구 저장하는 기능을 뜻하지 않습니다. 새 `chrome.storage.local`/`sync` 저장을 도입하지 않고 기존의 메모리 기반 전달·세션 수명 정책을 유지합니다. OpenAI API 키는 운영자 Render Secret에 두므로 사용자 패널에 API 키 입력란을 두지 않습니다.

### 11.2 북마크 기능 제외

- 북마크 탭, 현재 위치 북마크 추가·삭제 UI와 목록을 제거합니다.
- 신규 클라이언트는 북마크 상태와 archive payload의 `bookmarks`를 만들거나 보내지 않습니다.
- 최종 요약은 전사만 입력으로 사용합니다. 기존 문서의 레거시 북마크는 보존하되 새 UI에서는 노출하지 않습니다.
- 보존 오디오 복구·내보내기·폐기는 북마크와 별개 기능으로 유지합니다.

### 11.3 상태와 복구

- 서비스 상태는 서로 독립된 세 줄로 표시합니다.
  - Render: `/health/live` 응답 기준 `연결 확인 중`, `연결 완료`, `연결 확인 필요` 또는 `응답 상태 비정상`
  - 저장소: `/health/ready` 기준 `캡처 시작 시 확인`, `확인 중`, `준비 완료`, `확인 필요`
  - GPT: 실제 요청 전 `실제 요청 전`; 이후 `최근 GPT 처리 성공`, `모의 모드`, `할당량 소진`, `요청 속도 제한`, `GPT 일시 과부하`, `요청 형식 오류`, `GPT 요청 실패`
- GPT 상태 확인용 시험 요청은 보내지 않습니다. 청크·최종 요약의 실제 응답만 GPT 상태를 바꿉니다. AI 오류가 발생해도 Render의 HTTP 응답이 확인됐다면 Render 연결 완료 상태는 유지합니다.
- 캡처 시작·종료와 경과 시간·현재 청크·outbox 용량
- 처리 중·재시도 대기·quota pause·사용자 조치 필요 상태
- 복구 가능한 세션 목록과 재개
- 부분·완료 문서 목록과 상세 보기
- 보존 오디오 내보내기·확인 후 폐기

패널 시작 시 `/health/live`를 비차단 호출해 Render 연결만 표시합니다. 캡처 시작 버튼은 이 확인 결과를 저장소 준비로 간주하지 않고 `/health/ready`를 별도로 확인한 뒤 세션 생성과 tabCapture 권한 확보를 진행합니다. 활성 스트림이 이미 있으면 중복 캡처 대신 기존 세션 복귀를 안내합니다.

패널을 반복해서 열어도 최근 120~300초 이내의 성공 또는 시도 기록이 있으면 중복 선행 호출을 만들지 않습니다. 단, 캡처 시작 시점의 최종 확인은 이 캐시와 별개로 처리하여 절전 재진입·네트워크 변경·서버 재시작을 감지합니다.

## 12. 오류 코드

| HTTP | code | 동작 |
|---:|---|---|
| 401 | invalid_credentials | 입력 확인, 재시도 제한 |
| 403 | extension_origin_not_allowed | 일반 웹사이트 origin에서 요청했는지 확인 |
| 404 | session_not_found | 문서 조회 후 복구 판단 |
| 409 | chunk_conflict | 다른 오디오로 같은 순번 사용 금지 |
| 409 | archive_in_progress | 기존 finalize 상태 조회 |
| 413 | chunk_too_large | outbox 보존, 설정 확인 |
| 422 | invalid_chunk_metadata | 메타데이터 수정 전 재시도 금지 |
| 200 | review_required | `...` 표시, 원본 `REVIEW` 보존, 다음 청크 처리 |
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
APP_AUTH_MODE=atlas_users
ADMIN_ACCESS_TOKEN=<Render Secret>
OPENAI_API_KEY=<Render Secret>
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
OPENAI_TEXT_MODEL=gpt-6-luna
OPENAI_TRANSCRIBE_TIMEOUT_SECONDS=90
OPENAI_TEXT_TIMEOUT_SECONDS=60
CLIENT_REQUEST_TIMEOUT_SECONDS=480
OPENAI_MAX_IN_FLIGHT=3
OPENAI_QUEUE_WAIT_SECONDS=30
MAX_CONCURRENT_USERS=5
MOCK_OPENAI=false
AUDIO_CHUNK_SECONDS=15
AUDIO_CHUNK_OVERLAP_SECONDS=1
AUDIO_BITS_PER_SECOND=64000
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
MAX_SESSION_DURATION_SECONDS=14400
MAX_DOCUMENT_BYTES=12000000
DRAFT_RETENTION_DAYS=7
SESSION_IDLE_TTL_SECONDS=1800
PROCESSING_LEASE_SECONDS=180
FINALIZE_LEASE_SECONDS=600
DAILY_AUDIO_MINUTES_LIMIT_PER_USER=0
DAILY_AUDIO_MINUTES_LIMIT_TOTAL=0
```

Start Command:

```text
uvicorn server.app:app --host 0.0.0.0 --port $PORT --workers 1
```

Health Check Path는 `/health/live`입니다. Render Auto-Deploy는 `Off`로 두고 관리자가 커밋을 확인한 뒤 `Deploy latest commit`을 실행합니다. 무료 플랜의 첫 요청 지연은 패널 연결 확인 단계에서 흡수합니다.

### 13.1 확장 프로그램 연결 선행 확인 설정

다음 값은 비밀정보가 아닌 확장 프로그램 클라이언트 설정입니다. Render 환경변수나 Atlas에 저장하지 않습니다.

```js
SERVER_LIVE_CACHE_SECONDS: 180
```

`extension/config.js`의 설정 항목이며 Render 환경변수가 아닙니다. 허용 범위는 120~300초입니다. 패널 열림 시 `/health/live` 결과를 캐시해 재호출을 억제합니다. 캡처 시작 시 `/health/ready`는 캐시와 공유하지 않고 새로 호출해 Atlas 준비를 검증합니다. 두 요청은 서로 다른 상태이며 같은 진행 중 요청으로 합치지 않습니다.

### 13.2 확장 프로그램 연결과 CORS

- 서버는 `chrome-extension://` 형식의 확장 프로그램 origin을 CORS에서 허용합니다. PC별 확장 ID를 Render에 등록하지 않습니다.
- CORS와 `Origin` 헤더는 사용자 신원 증명이 아닙니다. 어떤 확장 ID에서 왔든 Atlas 계정 인증이 성공해야 사용자 기능을 이용할 수 있습니다.
- 일반 웹사이트 origin은 CORS에서 허용하지 않으며, 출처가 없는 요청도 계정 또는 관리자 인증을 통과해야 합니다.
- Render URL은 확장 운영 설정에 고정하고 사용자 입력란에 두지 않습니다.

### 13.3 Atlas Network Access

Render outbound IP 대역이 고정·보장되는지 현재 요금제 문서를 확인해 allowlist합니다. 고정할 수 없는 시험 운영에서 넓은 허용 범위를 임시 사용하면 강한 DB 비밀번호, 최소 권한, 비밀 회전이 필수이며 운영 전 축소합니다.

## 14. 관측성과 로그

로그에 오디오, 접속 코드, OpenAI 키, 전사 본문, 전체 URL 쿼리를 남기지 않습니다. 다음만 구조화 기록합니다.

- `request_id`, 해시된 사용자 식별자
- `session_id`, `document_id`, `sequence`
- 상태·오류 코드·지연시간
- 공급자 request ID
- 토큰·추정 비용
- requested/resolved model, prompt/schema version
- `/health/live` Render 연결, `/health/ready` 저장소 준비, 실제 OpenAI 처리 결과를 각각 성공·실패·지연시간으로 구분 집계

`/health/ready`는 Atlas 연결과 설정을 검사하되 OpenAI 유료 요청을 만들지 않습니다. GPT 상태 시험을 위해 별도 provider API 요청을 보내지 않습니다.

## 15. 구현 순서

계정 인증 전환은 기존 기능 구현과 별도로 다음 순서로 진행합니다.

1. Atlas `app_users` 컬렉션, 고유 사용자 ID 인덱스, 계정 발급·조회·중지·재활성화·코드 재발급 관리 기능을 추가합니다.
2. 기존 Render 사용자 ID와 코드 해시를 같은 ID로 이관하고, 사용자별 문서 접근과 코드 검증을 확인합니다.
3. 사용자 인증을 Atlas 조회로 전환하고 PC별 확장 ID 제한을 제거합니다. Atlas 장애 시 인증은 실패하도록 처리합니다.
4. 서로 다른 PC·확장 ID에서 같은 계정으로 캡처·복구·문서 조회를 검증하고, 중지·재발급이 다음 요청부터 적용되는지 확인합니다.
5. 검증 후 Render의 `APP_USER_n_*`와 `ALLOWED_EXTENSION_ORIGINS`를 제거하고 운영 설명서를 갱신합니다.

기존 V8 기능의 구현 이력은 다음과 같습니다. 아래의 `whisper-1` 항목은 이전 구현의 이력이며 현재 전사 모델을 뜻하지 않습니다.

1. V8 환경변수와 시작 검증
2. 최대 사용자 5명, 토큰 해시, 인증 실패 제한
3. `service_state`, `daily_usage`와 인덱스
4. 세션 생성 시 `document_id` 선발급과 URL 정규화
5. 0 기반 sequence와 `expected_chunk_count`
6. Atlas 기반 chunk processing lease
7. whisper-1 verbose JSON·segment timestamp 계약
8. GPT-6 Luna Responses API의 `store:false`, structured output, prompt 방어
9. 부분 문서 upsert와 7일 후 `resume_status=expired`
10. archive 순서, finalize lease, 크기 검사
11. 메타데이터 목록·상세·삭제 API 분리
12. 사이드 패널 `/health/live` Render 확인, `/health/ready` 저장소 확인, 실제 GPT 처리 결과의 독립 상태 표시
13. 시작·조회·재개·종료 reconciliation
14. 혼합형 사이드 패널, 인증 정보 접기·변경, 북마크 제외 및 구버전 payload 호환, IndexedDB 복구·삭제 확인
15. 5명 동시 부하·중단·재시작·quota 시험과 수동 배포는 아직 미실행

`gpt-transcribe` 전환안의 구현·판정 순서는 다음과 같습니다. 2~4번의 로컬 코드 변경과 모의 응답 기반 기본 시험은 진행했습니다. 1번의 실제 음성 코퍼스 검증, 5~7번의 실제 공급자·무료 플랜 시험과 운영 전환은 미실행입니다.

1. 한국어 강의·영어 기술 용어·혼합 발화·침묵·청크 경계의 음성 자료와 기대 전사문을 준비합니다. 전사 정확도와 중복·누락을 현행 방식과 비교합니다.
2. 모델 설정 검사, GPT 전사 요청·`text`/`languages[]` 응답 변환, 불확실한 coarse segment, 한국어/비한국어 변환 분기를 구현합니다.
3. 15초 청크·1초 겹침과 인접 청크 중복 문구 처리, 배속 영상 시각 변환, 확장 프로그램의 표시·outbox 재시도를 구현·검증합니다.
4. Atlas 부분 문서 증분 반영과 순번 기반 멱등 복구를 구현합니다. 청크 READY·부분 문서 갱신 성공 전 ACK 금지, 최종 요약의 완전한 전사 입력 조건을 유지합니다.
5. 한국어 기능 시험과 모의 OpenAI 응답의 지연·실패 주입을 통과한 뒤, 실제 GPT 요청으로 응답 형식·전사 품질·청크 처리 지연·비용을 소규모 검증합니다.
6. Render 무료 Web Service와 Atlas 무료 클러스터에서 1명→3명→5명 동시 사용을 단계적으로 시험합니다. 15초·1초 실제 간격으로 청크를 보내고 유휴 후 기동, 429/503/timeout, 재시작·복구, 종료·부분/완료 요약을 포함합니다.
7. 처리 대기열과 오류가 안정적이고 문서가 완성되는 경우에만 운영 전환을 승인합니다. Render 설정 변경과 수동 배포는 별도 실행 단계입니다.

## 16. 검증 기준

### 기능

- 5명이 동시에 세션을 생성하고 자기 데이터만 조회합니다.
- 6번째 활성 사용자는 `too_many_active_users`를 받고 오디오를 잃지 않습니다.
- 사이드 패널을 열면 UI를 막지 않고 `/health/live`가 호출되어 Render 연결 상태만 표시됩니다.
- 같은 패널을 120~300초 안에 다시 열어도 Render 생존 확인 요청이 중복되지 않습니다.
- 캡처 시작은 패널 열림의 liveness 확인과 별도로 `/health/ready`를 호출하고, Atlas가 준비된 경우에만 진행합니다.
- `/health/ready`가 `503 storage_unavailable`을 반환하면 Render는 연결 완료, 저장소는 확인 필요로 표시됩니다.
- `/health/live` 또는 저장소 확인만으로 세션·사용자 lease·OpenAI 호출·Atlas 문서가 생성되지 않습니다.
- Render와 저장소가 준비돼 있어도 GPT 상태는 실제 처리 응답 전까지 `실제 요청 전`입니다.
- GPT 할당량·속도 제한·과부하 오류는 Render 연결 상태와 분리되며, `openai_rate_limited`는 Retry-After를 반영해 원본 청크를 보존·재시도하고 `openai_quota_exhausted`는 자동 반복을 중단합니다.
- 사용자 ID·접속 코드가 없으면 입력란이 열리고, 둘 다 입력된 뒤에는 사용자 정보가 간결 표시되며 `변경`으로 다시 수정할 수 있습니다.
- 인증 입력값만으로 인증 완료를 표시하지 않으며 실제 인증 오류 시 입력을 고칠 수 있습니다.
- 캡처·복구 중에는 사용자 인증 정보를 수정할 수 없습니다.
- 사이드 패널에 북마크 UI가 없고 신규 최종 요약은 전사만 입력으로 사용합니다.
- 레거시 확장 프로그램의 `bookmarks`는 최종 요약·신규 문서에 반영하지 않으며 기존 Atlas 문서를 삭제·변경하지 않습니다.
- 15초 청크·1초 overlap, 14초 시작 간격과 0 기반 누락 검사가 정확합니다.
- GPT 전사 응답의 `text`·`languages[]`를 처리하고 Whisper 전용 타임스탬프 파라미터를 보내지 않습니다. 한국어 또는 감지 불확실 청크가 `unknown`이라는 이유로 불필요하게 번역되지 않습니다.
- 한국어 중심 요청은 `languages=["ko", "en"]`를 보내며 `keywords`가 없어도 전사됩니다. 선택적 용어 힌트를 사용할 때는 발화하지 않은 용어 삽입 여부를 검사합니다.
- 무음으로 확인된 빈 응답은 재전사 없이 빈 READY 청크로 저장하고, 음량이 있거나 측정이 불확실한 빈 응답은 추가 전사를 최대 한 번만 수행합니다. 두 번 모두 비면 `...`과 `review_required`를 저장하고 다음 청크를 처리하되 원본은 `REVIEW`로 보존합니다. 응답 형식 오류와 `languages=[]`를 침묵으로 오인하지 않습니다.
- 청크당 coarse segment의 `uncertain`·`timestamp_uncertain` 값이 정확하며 문장별 시각을 제공한다고 표시하지 않습니다.
- 인접 청크의 1초 겹침에서 중복·누락과 강의 용어의 절단을 한국어·혼합 강의 자료로 검사합니다. 모호한 문구는 임의로 제거하지 않습니다.
- 동일 청크 재전송은 OpenAI 결과를 중복 저장하지 않습니다.
- 청크가 READY로 저장된 직후 세션 순번 또는 부분 문서 저장이 실패해도, 재전송 시 두 상태를 복구한 뒤에만 ACK합니다.
- 처리 lease가 만료돼 새 시도가 시작되면 이전 `attempt_id`의 늦은 결과가 READY 청크를 덮어쓰지 못합니다.
- 배속 재생 시 실시간 자막과 Atlas 문서의 영상 시간값이 일치합니다.
- 한국어·영어·혼합 강의가 스키마를 만족합니다.
- 누락이 있으면 미완료 문서로 유지하고 확보된 전사만 `summary_scope=partial`로 요약합니다. 전사가 없으면 요약하지 않습니다.
- Render 재시작 후 다음 청크 요청이 Atlas 초안을 복원하며 녹음 중인 탭 스트림과 청크 순번은 유지됩니다.
- 종료 후 보존 청크 재처리는 새 tabCapture 없이 가능하고, `saved=false`는 완료로 표시하지 않습니다.
- 녹음 중단 구간이 있으면 순번이 모두 READY여도 `missing_time_ranges`가 있는 미완료 문서로 남습니다.
- 모든 청크가 준비되고 녹음 중단 구간이 없는 경우에만 완전한 최종 요약이 DB 결과로 반영됩니다.
- 빈 문자열 또는 공백뿐인 요약은 완료로 저장하지 않습니다.
- 청크 간격보다 늦는 GPT 응답·일시적 `502`·처리 중 `409` 뒤에도 최종 저장을 재시도하고 중복 문서를 만들지 않습니다.
- 요약 실패 문서는 `summary_status=failed`와 원인 코드가 남으며, 재시도 성공 시 코드가 지워집니다.
- `completed` 문서는 요약 본문과 요약 메타데이터를 같은 원자적 쓰기로 포함합니다.

### 복구·데이터 수명

- 429/503/timeout 후 오디오가 outbox와 Atlas 상태에 남습니다.
- 재시작 뒤 만료된 처리 lease가 복구됩니다.
- Render 절전 후 첫 조회가 stale 세션을 정리합니다.
- stale 세션의 부분 문서 갱신이 실패하면 다음 reconciliation에서 다시 시도합니다.
- 7일 후 초안은 만료되지만 부분 문서는 남습니다.
- 재개와 TTL 만료가 겹쳐도 처리 중 초안이 삭제되지 않습니다.
- 완료 저장 전에는 초안이 삭제되지 않습니다.
- 12 MB 초과 문서는 잘리지 않고 `input_too_large`로 보존됩니다.

### 보안·운영

- 평문 접속 코드와 API 키가 Git·Atlas·로그에 없습니다.
- 다른 사용자의 리소스 접근은 거부됩니다.
- 동일 계정은 PC나 확장 ID가 달라도 모든 사용자 기능을 이용하며 기기 등록을 요구하지 않습니다.
- 일반 웹사이트 origin은 CORS에서 허용하지 않습니다. 허용된 확장 origin이나 출처가 없는 요청도 계정 인증 없이는 거부됩니다.
- 계정을 중지하거나 코드를 재발급하면 이전 코드는 모든 PC에서 거부됩니다. Atlas 장애 시 인증이 우회되지 않습니다.
- 관리자 비밀값 없이는 계정을 발급·변경할 수 없고, 계정 발급·재발급 응답 외에는 접속 코드가 표시되지 않습니다.
- OpenAI 요청에 `store:false`와 비식별 `safety_identifier`가 포함됩니다.
- 전사문에 삽입된 명령이 요약 지침을 바꾸지 못합니다.
- 사용량과 추정 비용이 날짜·사용자별로 집계됩니다.

### Render·Atlas 무료 플랜 부하 판정

- 실제 무료 플랜에서 먼저 모의 전사 응답에 실측 GPT 지연 분포를 주입해 OpenAI 과금 없이 서버·Atlas 경로를 시험하고, 소규모 실제 GPT 호출로 응답 형식과 공급자 지연을 별도 확인합니다. 즉시 응답하는 모의 모드의 성공만으로 실제 처리량을 판정하지 않습니다.
- 1명·3명·5명 동시 사용자별로 청크 업로드→ACK 지연의 p50/p95, OpenAI 슬롯 대기, 브라우저 outbox 길이, `ai_backpressure`·429·503·timeout 비율을 기록합니다. 지속 시험에서 대기열이 계속 증가하거나 세션 종료 후 READY 청크가 남으면 불합격입니다.
- Render 프로세스의 메모리 사용량·재시작·응답 시간을 보고 512 MB 제한 안에서 안정적인지 확인합니다. 유휴 15분 뒤 첫 요청의 기동 지연은 지속 처리 지연과 분리해 기록합니다.
- Atlas의 저장 공간, 읽기·쓰기 작업량, 인증 조회, 청크/부분 문서 갱신 지연과 쓰기 오류를 관찰합니다. 무료 클러스터의 512 MB 저장 제한과 초당 최대 100회 작업을 초과하지 않도록 실제 측정과 장기 저장량 추정을 함께 확인합니다. 테스트 자료는 운영 문서와 분리하고 종료 후 정리합니다.
- 완료 판정은 모든 순번의 단 한 번 반영, 부분 문서 복구, 최종 요약의 누락 없는 입력, 사용자 소유권 격리, 장시간 녹음 후 문서 크기 한도를 포함합니다. 5명 동시 상태에서 측정된 지연이나 오류가 기준을 만족하지 못하면 사용자 한도·청크 처리 방식 등을 다시 설계한 뒤 재시험합니다.

## 17. 운영자가 입력할 값

| 값 | 위치 |
|---|---|
| Render HTTPS URL | 확장 운영 설정 |
| MongoDB Atlas URI | Render Secret |
| OpenAI API 키 | Render Secret |
| 관리자 전용 접속 비밀값 | Render Secret, 관리자 비밀번호 관리 도구 |
| 사용자 ID·접속 코드 해시·계정 상태 | Atlas `app_users` 컬렉션 |
| safety identifier HMAC secret | Render Secret |
| 일일 사용자·전체 오디오 한도 | Render 환경변수, 0은 비활성 |

## 18. 비용 참고

2026-09-28 OpenAI 공개 표준 가격(입력 272K 토큰 이하) 기준 GPT-6 Luna는 입력 100만 토큰당 $0.10, 캐시 입력 $0.01, 캐시 쓰기 $0.125, 출력 $0.50입니다. 이전 GPT-5.6 Luna 가격($0.20 입력·$1.20 출력)과 비교하면 입력 단가는 50%, 출력 단가는 약 58% 낮습니다. 예시로 입력·출력 각 100만 토큰이면 $0.60이며, 이전 모델의 $1.40보다 $0.80 저렴합니다. 한 요청의 입력이 272K 토큰을 넘으면 입력·캐시 요금은 2배, 출력은 1.5배가 적용됩니다.

오디오 전사는 `gpt-transcribe`의 공개 추정 단가인 음성 분당 $0.0045를 기준으로 산정하며 GPT-6 Luna의 텍스트 단가를 적용하지 않습니다. 15초 청크·1초 겹침은 긴 녹음에서 전송 음성량을 약 15/14배로 늘리므로 강의 한 시간의 전사비는 재시도 제외 약 $0.289입니다. 100시간이면 약 $28.93입니다. 번역·요약 비용, 공급자 재시도, 실제 청구 방식은 별도이며 운영 비용은 사용량 기록과 청구 내역으로 검증합니다. Render와 Atlas는 무료 플랜의 자원·사용 한도 안에서 운영 가능한지 부하 테스트로 판정합니다.

## 19. 공식 참고 문서

- OpenAI GPT-6 Luna: https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI GPT-5.6 Luna (가격 비교 참고): https://developers.openai.com/api/docs/models/gpt-5.6-luna
- OpenAI Audio Transcriptions API: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- OpenAI 파일 전사 및 타임스탬프 지원: https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI 전사 가격: https://developers.openai.com/api/docs/pricing
- OpenAI Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI 데이터 제어: https://developers.openai.com/api/docs/guides/your-data
- Render Python 배포: https://render.com/docs/deploy-fastapi
- Render 무료 인스턴스: https://render.com/docs/free
- Render 무료 Web Service 사양: https://render.com/docs/compute-plans
- MongoDB Atlas 무료 플랜: https://www.mongodb.com/pricing
- MongoDB Atlas Network Access: https://www.mongodb.com/docs/atlas/security/ip-access-list/
- MongoDB TTL 인덱스: https://www.mongodb.com/docs/manual/core/index-ttl/
