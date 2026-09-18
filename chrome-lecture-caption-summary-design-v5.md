# Chrome 강의 자막·요약 노트 설계서 v5

## 1. 문서 목적

이 문서는 Lecture Memo를 개인 PC에서만 사용하는 로컬 프로그램에서, Render에 FastAPI 서버를 배포하고 MongoDB Atlas에 최종 텍스트를 보관하는 소규모 다중 사용자 서비스로 확장하기 위한 설계 기준입니다.

v5는 현재 구현된 Gemini 기반 v3 흐름을 기준으로 합니다. OpenAI 기반 v4 문서는 별도 전환안이며, v5의 기본 공급자는 Gemini로 유지합니다.

목표 사용자는 최대 7명입니다. 회원가입·소셜 로그인·복잡한 권한 관리 대신 관리자가 미리 사용자 ID와 개별 접속 코드를 발급하는 방식을 사용합니다.

핵심 원칙은 다음과 같습니다.

- 확장 프로그램은 여러 사용자가 하나의 Render 서버를 사용합니다.
- 모든 사용자의 요청은 운영자의 Render 서버를 거쳐 각 사용자의 Gemini API로 전달됩니다.
- 최종 자막 TXT와 요약만 운영자의 MongoDB Atlas에 저장합니다.
- 오디오 청크와 Gemini API 키는 디스크나 Atlas에 저장하지 않습니다.
- 사용자 ID만으로 인증하지 않고 ID와 별도의 비밀 접속 코드를 함께 검증합니다.
- Atlas 문서는 반드시 `owner_id`로 소유자를 구분합니다.
- 로컬 개발 모드와 Render 운영 모드를 구분해 같은 확장 프로그램 구조로 지원합니다.

## 2. v3 대비 주요 변경점

| 항목 | v3 로컬 구조 | v5 운영 구조 |
|---|---|---|
| 서버 위치 | 사용자 PC의 `127.0.0.1:8050` | Render Web Service의 HTTPS 주소 |
| 실행 포트 | `8050` 고정 | Render가 제공하는 `$PORT` 사용 |
| 접근 인증 | 공용 `LOCAL_ACCESS_TOKEN` | 사용자별 ID + 개별 접속 코드 |
| Gemini API 키 | 사용자가 세션 시작 시 입력 | 동일하게 세션 메모리에서만 사용 |
| 오디오 보관 | 브라우저·서버 메모리 | 동일하게 메모리에서만 처리 |
| 자막·요약 보관 | 확장 프로그램 메모리와 로컬 내보내기 | 종료 시 Atlas에 최종 텍스트 저장 |
| 원본 오디오 보관 | 없음 | 없음 |
| 사용자 데이터 구분 | 해당 없음 | 모든 문서에 `owner_id` 저장 및 조회 필터 |
| 확장 배포 | GitHub ZIP 후 압축해제 로드 | 동일 방식 또는 Chrome Web Store |
| CORS | 로컬 확장 Origin | 배포된 확장 Origin 허용 목록 |
| 장애 영향 | PC 서버 종료 시 사용 불가 | Render 재시작 시 진행 중 세션만 중단, 저장 완료 문서는 유지 |
| 운영 규모 | 1명 중심 | 최대 7명 |

## 3. 전체 배포 구조

```text
사용자 A의 Chrome 확장 ─┐
사용자 B의 Chrome 확장 ─┼─ HTTPS ─→ Render FastAPI 서버
사용자 C의 Chrome 확장 ─┘                    │
                                             │ 오디오 + 사용자 Gemini 키
                                             ▼
                                        Gemini API
                                             │
                                             │ 전사·요약 응답
                                             ▼
                                      Render FastAPI 서버
                                       ├─→ 확장 프로그램
                                       │   (실시간 자막·요약)
                                       └─→ MongoDB Atlas
                                           (최종 TXT·요약만)
```

각 사용자는 자신의 Gemini API 키를 사이드패널에 입력합니다. 확장 프로그램은 오디오를 Render의 FastAPI로 보내고, FastAPI가 해당 키로 Gemini를 호출합니다. Gemini의 전사·요약 응답은 먼저 FastAPI가 받은 뒤 확장 프로그램에 실시간으로 전달하고, 최종 결과는 FastAPI가 `owner_id`를 붙여 Atlas에 저장합니다.

사용자는 Atlas에 직접 접속하지 않습니다. MongoDB URI, DB 사용자, Render 환경변수는 운영자만 관리합니다.

### 3.1 구성요소별 책임

| 구성요소 | 책임 |
|---|---|
| Chrome Service Worker | 현재 탭 권한, `tabCapture` 스트림 ID, 메시지 라우팅 |
| Offscreen Document | 녹음, 청크 큐, 재시도, 캡션·노트의 실제 세션 상태 |
| Content Script | 영상 시간 추적, 탐색, 자막 오버레이 |
| Side Panel | 서버 주소, 사용자 인증정보, Gemini API 키 입력과 상태 표시 |
| Render FastAPI | 사용자 인증, 세션 소유권, Gemini 호출, Atlas 저장 API |
| Gemini API | 사용자 API 키를 이용한 전사·요약 |
| MongoDB Atlas | 최종 텍스트 문서의 영구 보관과 사용자별 조회 |

## 4. 사용자 인증 설계

### 4.1 최대 7명용 발급 방식

관리자가 사용자를 직접 만들어 개별 전달합니다.

```text
사용자 ID: user-001
접속 코드: 무작위 32자리 비밀값
```

사용자 ID는 식별자일 뿐 비밀번호가 아닙니다. `user-001`만 알고 있어도 접근할 수 있게 만들면 안 되며, 반드시 접속 코드와 함께 검증해야 합니다.

권장 발급 규칙:

- `user-001`부터 `user-007`까지 사용하거나, 개인정보가 드러나지 않는 별칭을 사용합니다.
- 접속 코드는 최소 32바이트 난수로 생성합니다.
- 사용자마다 서로 다른 접속 코드를 발급합니다.
- 접속 코드를 GitHub, 확장 프로그램 코드, 사용설명서에 넣지 않습니다.
- 사용자별로 따로 전달하고 공유 채팅방에는 전체 목록을 올리지 않습니다.
- 유출 시 해당 사용자 코드만 교체하고 다른 사용자는 그대로 둡니다.

### 4.2 v5 초기 구현: Render 환경변수 등록

사용자가 7명 이하이므로 초기에는 사용자 목록을 Render 환경변수에 등록합니다.

```dotenv
APP_AUTH_MODE=multi_user
APP_USER_1_ID=user-001
APP_USER_1_TOKEN=랜덤한_비밀값_1
APP_USER_2_ID=user-002
APP_USER_2_TOKEN=랜덤한_비밀값_2
APP_USER_3_ID=user-003
APP_USER_3_TOKEN=랜덤한_비밀값_3
APP_USER_4_ID=user-004
APP_USER_4_TOKEN=랜덤한_비밀값_4
APP_USER_5_ID=user-005
APP_USER_5_TOKEN=랜덤한_비밀값_5
APP_USER_6_ID=user-006
APP_USER_6_TOKEN=랜덤한_비밀값_6
APP_USER_7_ID=user-007
APP_USER_7_TOKEN=랜덤한_비밀값_7
```

이 값은 저장소의 `.env`, GitHub, 확장 프로그램에 기록하지 않습니다. Render Dashboard의 환경변수 또는 안전한 배포 시크릿으로만 관리합니다.

이 방식의 장점은 구현과 운영이 단순하다는 점입니다. 단점은 사용자를 추가·폐기할 때 Render 환경변수 변경과 재배포 또는 재시작이 필요하다는 점입니다. 7명 이하에서는 이 단점이 충분히 감수할 수 있는 범위입니다.

### 4.3 요청 인증 헤더

확장 프로그램은 사용자 ID를 별도 헤더로 보내고, 접속 코드는 Bearer 토큰으로 보냅니다.

```http
Authorization: Bearer <user-access-token>
X-User-ID: user-001
Origin: chrome-extension://<extension-id>
```

서버 검증 순서:

1. `Authorization`의 Bearer 토큰을 등록된 사용자 목록과 비교합니다.
2. 토큰이 매핑한 사용자 ID와 `X-User-ID`가 같은지 확인합니다.
3. 현재 세션의 `owner_id`와 인증된 사용자 ID가 같은지 확인합니다.
4. 하나라도 다르면 `401` 또는 `403`을 반환합니다.

클라이언트가 보낸 `X-User-ID`를 그대로 신뢰하지 않습니다. 실제 소유자는 서버가 접속 코드 매핑으로 결정합니다.

### 4.4 로컬 모드와 Render 모드

로컬 개발 모드는 기존 `LOCAL_ACCESS_TOKEN`을 유지할 수 있습니다.

| 모드 | 인증값 | 용도 |
|---|---|---|
| `local` | `LOCAL_ACCESS_TOKEN` | 운영자 PC에서 단독 테스트 |
| `multi_user` | 사용자 ID + 사용자별 접속 코드 | Render에서 여러 사용자 운영 |

운영 모드에서는 공용 `LOCAL_ACCESS_TOKEN` 하나를 모든 사용자에게 배포하지 않습니다. 공용 토큰만 사용하면 사용자 구분이 불가능하고, 토큰을 아는 사용자가 다른 세션을 시도할 위험이 있습니다.

## 5. 세션과 소유권

### 5.1 세션 레코드

현재 메모리 세션에 다음 필드를 추가합니다.

```python
SessionRecord(
    session_id="...",
    owner_id="user-001",
    source_tab_id=123,
    source_url="https://www.youtube.com/watch?v=...",
    language="ko",
    gemini=<session-scoped client>,
    transcript_segments=<server-canonical segments>,
    latest_summary=<latest server summary>,
)
```

`session_id`는 추측하기 어려운 UUID를 사용하고, 모든 청크·요약·종료 요청에서 세션 소유자를 다시 검증합니다.

FastAPI는 Gemini 응답을 세션에 누적하고 청크 경계 중복을 서버에서도 조정해 Atlas에 저장할 기준 자막을 만듭니다. 확장 프로그램은 실시간 표시를 위해 같은 응답을 받으며, 화면 표시 과정에서 추가 중복을 방어적으로 제거할 수 있지만 Atlas 저장의 기준 데이터는 서버 세션입니다.

### 5.2 세션 흐름

```text
사이드패널에 사용자 ID·접속 코드·Gemini API 키 입력
→ /health 조회
→ 사용자 인증 헤더와 함께 POST /v1/sessions
→ 서버가 owner_id를 확정
→ Gemini 키로 세션 전용 클라이언트 생성
→ 세션 ID 발급
→ 청크 전사·중간 요약
→ 종료 시 최종 요약
→ /archive로 최종 저장 요청
→ 저장 성공 확인 후 서버 세션 삭제
→ Gemini 클라이언트 참조 제거
```

서버는 Gemini API 키를 `SessionRecord`의 전용 클라이언트 생성에만 사용합니다. 원문 키를 Atlas, 로그, 응답, 환경변수에 저장하지 않습니다.

## 6. Render 배포 설계

### 6.1 Render 서비스 유형

FastAPI 서버를 Render Web Service로 배포합니다. GitHub 저장소의 `main` 브랜치와 연결하고, 서버 프로세스는 Render가 전달하는 포트에 바인딩합니다.

```text
Build Command:
pip install -r server/requirements.txt

Start Command:
uvicorn server.app:app --host 0.0.0.0 --port $PORT

Health Check Path:
/health
```

로컬에서 사용하는 `127.0.0.1:8050`은 개발용으로만 남깁니다. Render에서는 `server.app`의 `__main__`에 고정된 8050 포트를 사용하지 않고 Start Command의 `$PORT`를 사용합니다.

### 6.2 Render 환경변수

운영 환경의 예시는 다음과 같습니다.

```dotenv
# Gemini
GEMINI_MODEL=gemini-3.6-flash
MOCK_GEMINI=false

# 청크
AUDIO_CHUNK_SECONDS=300
AUDIO_CHUNK_OVERLAP_SECONDS=5
SESSION_IDLE_TTL_SECONDS=1800

# 사용자 인증
APP_AUTH_MODE=multi_user
APP_USER_1_ID=user-001
APP_USER_1_TOKEN=...
APP_USER_2_ID=user-002
APP_USER_2_TOKEN=...
# 필요한 사용자 수만큼 3~7번 반복

# 확장 Origin
ALLOWED_EXTENSION_ORIGINS=chrome-extension://<배포된-확장-id>

# MongoDB Atlas
MONGODB_URI=mongodb+srv://...
MONGODB_DATABASE=lecture_memo
MONGODB_COLLECTION=lecture_documents
MONGODB_REQUIRED=true

# 보관 정책
ARCHIVE_TRANSCRIPT=true
ARCHIVE_SUMMARY=true
```

`MONGODB_URI`, 사용자 접속 코드, 로컬 토큰은 절대 GitHub에 커밋하지 않습니다. `.env.example`에는 키 이름만 남기고 실제 값은 비워 둡니다.

### 6.3 Render 운영 시 고려사항

- Render의 공개 URL은 HTTPS를 사용하므로 확장 프로그램은 `https://...onrender.com` 주소로 접속합니다.
- 무료 플랜은 일정 시간 요청이 없으면 절전될 수 있어 첫 요청에 지연이 생길 수 있습니다.
- Render 파일 시스템은 영구 저장소로 사용하지 않습니다. 텍스트 저장은 Atlas만 담당합니다.
- Render 프로세스가 재시작되면 메모리의 진행 중 세션과 대기 청크는 사라질 수 있습니다.
- 따라서 진행 중인 오디오 청크를 Atlas에 저장하지 않는 v5에서는 서버 재시작 후 해당 캡처를 자동 복구하지 않습니다.
- 종료 전에 Atlas 저장이 실패하면 확장 프로그램에서 TXT·MD 로컬 내보내기를 제공하고, 사용자에게 저장 실패를 명확히 표시합니다.
- 장시간 강의에서 청크 요청이 일정 주기로 발생하므로 정상 처리 중에는 서버가 계속 사용되지만, 일시정지 시간이 길면 재기동 지연을 고려합니다.

Render 공식 문서:

- [Render Web Services](https://render.com/docs/web-services)
- [Render FastAPI 배포](https://render.com/docs/deploy-fastapi)
- [Render Free 서비스 제한](https://render.com/docs/free)

## 7. 확장 프로그램 배포와 서버 주소

### 7.1 배포 방식

초기 7명은 다음 방식으로 배포할 수 있습니다.

1. GitHub에서 ZIP을 다운로드합니다.
2. 압축을 해제합니다.
3. `chrome://extensions`에서 개발자 모드를 켭니다.
4. 압축해제된 `extension` 폴더를 로드합니다.
5. 사이드패널의 서버 주소에 Render HTTPS 주소를 입력합니다.
6. 발급받은 사용자 ID와 접속 코드, 본인의 Gemini API 키를 입력합니다.

이 방식은 내부 사용자 배포에 적합하지만, 각 PC에서 확장 ID가 달라질 수 있습니다. 운영 Origin을 고정하려면 Chrome Web Store 배포 또는 고정 키를 사용하는 사내 배포를 검토합니다.

### 7.2 Manifest와 URL 허용

운영용 확장 프로그램은 로컬과 Render 주소를 모두 허용할 수 있습니다.

```json
"host_permissions": [
  "http://127.0.0.1:8050/*",
  "http://localhost:8050/*",
  "https://<render-service>.onrender.com/*"
]
```

서버 URL 검증 함수도 다음을 허용하도록 변경합니다.

- 로컬 개발: `http://127.0.0.1:8050`, `http://localhost:8050`
- 운영: `https://`이며 사전에 등록한 Render 호스트
- 그 밖의 임의 HTTP·HTTPS 주소: 거부

운영 배포에서는 `ALLOWED_EXTENSION_ORIGINS`에 Web Store 확장 ID를 정확히 등록합니다. 개발용 압축해제 확장은 ID가 달라질 수 있으므로 테스트 기간에만 여러 Origin을 등록하거나 개발 모드 정규식을 사용합니다.

### 7.3 CORS

Render API는 다음 헤더를 허용합니다.

```text
Authorization
Content-Type
X-User-ID
```

`Access-Control-Allow-Origin`은 허용된 `chrome-extension://<id>` 목록과 정확히 일치해야 합니다. `*`는 인증 요청과 운영 데이터 API에 사용하지 않습니다.

`/health`는 Render 상태 확인을 위해 인증 없이 열 수 있지만, API 키·사용자 토큰·MongoDB 정보는 반환하지 않습니다.

## 8. MongoDB Atlas 저장 설계

### 8.1 저장 범위

Atlas에는 최종 결과 텍스트만 저장합니다.

저장하지 않는 항목:

- WebM/Opus 오디오 청크
- Gemini API 키
- 사용자 접속 코드 원문
- 서버 인증 헤더
- 처리 중인 임시 청크 파일
- 전체 Gemini 원시 응답

저장하는 항목:

- 최종 자막 TXT
- 최종 요약
- 주요 개념·전문 용어·강조 내용·복습 체크리스트
- 사용자가 만든 북마크와 메모
- 강의 URL, 처리 시간, 청크 수, 누락 청크 수
- `owner_id`, 문서 ID, 생성·완료 시각

### 8.2 문서 구조

컬렉션 이름은 `lecture_documents`로 합니다.

```json
{
  "_id": "ObjectId",
  "document_id": "uuid",
  "owner_id": "user-001",
  "source_url": "https://www.youtube.com/watch?v=...",
  "source_title": "강의 제목",
  "language": "ko",
  "created_at": "2026-09-18T10:00:00Z",
  "completed_at": "2026-09-18T11:02:00Z",
  "duration_ms": 3600000,
  "transcript_txt": "전체 자막 텍스트",
  "summary": {
    "summary": "3줄 요약",
    "concepts": ["개념 1"],
    "terms": ["용어 1"],
    "highlights": ["강조 내용"],
    "checklist": ["복습 항목"]
  },
  "bookmarks": [
    {"timestamp_ms": 120000, "memo": "다시 볼 부분"}
  ],
  "chunk_count": 12,
  "missing_chunk_count": 0,
  "status": "completed",
  "schema_version": 5
}
```

자막 TXT와 요약은 모두 텍스트이므로 오디오에 비해 저장 용량 부담이 작습니다. 단, 장기간 사용 시 문서 개수와 보관 기간을 관리할 수 있도록 사용자별 삭제 기능과 생성일 인덱스를 제공합니다.

### 8.3 인덱스

필수 인덱스:

```text
document_id: unique
(owner_id, created_at): descending
```

모든 목록·상세·삭제 쿼리는 다음 조건을 포함해야 합니다.

```text
owner_id == authenticated_user_id
```

클라이언트가 `document_id`만 바꿔 다른 사용자의 문서를 읽거나 삭제할 수 없도록 합니다.

### 8.4 Atlas 연결

서버 시작 시 MongoDB 클라이언트를 생성하고 `ping`으로 연결을 확인합니다. 서버 종료 시 클라이언트를 닫습니다.

```text
Render 환경변수 MONGODB_URI 읽기
→ Atlas 연결
→ lecture_memo 데이터베이스 선택
→ lecture_documents 컬렉션 선택
→ 인덱스 보장
→ ping 성공 후 운영 요청 허용
```

Atlas Network Access에서는 Render에서 오는 연결을 허용해야 합니다. `0.0.0.0/0` 전체 허용은 개발용 임시 설정으로만 취급하고, 운영 시에는 가능한 범위에서 고정된 외부 IP·보안 연결·최소 권한 DB 계정을 사용합니다. DB 계정은 문서 저장에 필요한 데이터베이스에만 권한을 부여합니다.

MongoDB Atlas 공식 문서:

- [Atlas Free Cluster 배포](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/)
- [Atlas Free Cluster 제한](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)

## 9. API 설계

### 9.1 공통 인증

인증이 필요한 모든 요청은 다음을 사용합니다.

```http
Authorization: Bearer <user-access-token>
X-User-ID: user-001
```

인증 미들웨어는 `AuthenticatedUser(user_id)`를 반환하고, 각 핸들러는 세션·문서의 `owner_id`와 비교합니다.

### 9.2 세션 생성

```http
POST /v1/sessions
```

```json
{
  "source_tab_id": 123,
  "source_url": "https://example.com/lecture",
  "language": "ko",
  "gemini_api_key": "사용자가 입력한 키"
}
```

응답에는 `session_id`와 모델 정보만 포함합니다. Gemini API 키나 접속 코드는 응답하지 않습니다.

### 9.3 기존 처리 API

다음 API는 세션 소유자 검증을 추가하여 유지합니다.

```text
GET    /health
POST   /v1/sessions
POST   /v1/sessions/{session_id}/gemini-key
POST   /v1/sessions/{session_id}/chunks
POST   /v1/sessions/{session_id}/summaries/intermediate
POST   /v1/sessions/{session_id}/summaries/final
DELETE /v1/sessions/{session_id}
```

429 할당량 소진 시 자동 재시도를 중단하고 실패 청크를 보존하는 현재 정책을 유지합니다. 사용자가 새 Gemini 키를 입력하면 같은 소유자의 세션만 재개합니다.

### 9.4 최종 보관 API

캡처 종료 후 확장 프로그램은 최종 저장을 요청하고, FastAPI가 세션에 누적한 Gemini 전사·요약 결과를 조합해 명시적으로 저장합니다. 확장 프로그램이 Atlas에 직접 접근하거나, 클라이언트가 보낸 임의의 전체 자막을 그대로 신뢰하지 않습니다.

```http
POST /v1/sessions/{session_id}/archive
```

```json
{
  "source_title": "강의 제목",
  "bookmarks": [],
  "duration_ms": 3600000,
  "chunk_count": 12,
  "missing_chunk_count": 0
}
```

서버는 세션에서 확인한 `owner_id`와 인증 사용자 ID가 같은지 확인합니다. 그 후 서버 메모리에 누적한 Gemini 전사 결과와 최신 요약, 요청에 포함된 북마크·메타데이터를 조합해 Atlas에 저장합니다. 저장 성공 시 다음을 반환합니다.

```json
{
  "saved": true,
  "document_id": "uuid"
}
```

### 9.5 문서 조회·삭제 API

사용자별 기록을 제공하려면 다음 API를 추가합니다.

```text
GET    /v1/documents?limit=50&cursor=...
GET    /v1/documents/{document_id}
DELETE /v1/documents/{document_id}
```

조회 결과는 인증된 사용자의 `owner_id`에 해당하는 문서만 반환합니다. 관리자용 전체 조회 API는 v5 범위에 포함하지 않고, 운영자가 Atlas Dashboard에서 관리합니다.

## 10. 확장 프로그램 UI 변경

Render 운영용 사이드패널은 다음과 같이 구성합니다.

```text
서버 주소       [https://lecture-memo.onrender.com]
사용자 ID       [user-001]
접속 코드       [••••••••••••]
Gemini API 키   [••••••••••••]

[캡처 시작] [캡처 종료]
상태: 캡처 중
```

UI 동작:

- 사용자 ID와 접속 코드는 캡처 시작 요청에만 사용하고 저장하지 않습니다.
- Gemini API 키는 세션 생성 성공 직후 입력란과 확장 메모리에서 제거합니다.
- 서버 주소는 운영용 Render 주소를 기본값으로 제공하되 로컬 주소도 개발용으로 허용합니다.
- 401이면 사용자 ID·접속 코드 재입력을 안내합니다.
- 403이면 확장 Origin 또는 배포 버전이 허용되지 않은 상태로 표시합니다.
- 429이면 자동 재시도하지 않고 새 Gemini 키 입력을 안내합니다.
- Atlas 저장 성공 전에는 `저장 완료`를 표시하지 않습니다.
- Atlas 저장 실패 시 로컬 TXT·MD 내보내기 버튼을 우선 안내합니다.
- 저장 완료 후 `document_id`를 표시하고, 추후 문서 목록에서 다시 열 수 있게 합니다.

## 11. 전사·요약·보관 흐름

```text
1. 사용자 인증 확인
2. Render /health 조회
3. Gemini 키를 포함한 세션 생성
4. Offscreen이 300초 청크 녹음
5. Render FastAPI가 사용자 Gemini 키로 Gemini에 전사 요청
6. Gemini가 전사 결과를 Render FastAPI에 반환
7. Render FastAPI가 응답을 세션에 누적하고 서버 측 경계 중복을 조정
8. FastAPI가 정규화한 자막을 확장 프로그램에 전달하고, 확장 프로그램은 화면 표시를 갱신
9. 성공한 청크 3개마다 FastAPI가 중간 요약 요청
10. 429면 해당 세션만 PAUSED_QUOTA
11. 503이면 15·30·45초 대기 후 재시도
12. 캡처 종료 시 FastAPI가 최종 요약
13. 확장 프로그램이 종료·북마크 메타데이터로 archive 요청
14. FastAPI가 누적 전사·요약을 TXT로 조합하고 owner_id를 붙여 Atlas 저장
15. 저장 성공 응답 확인
16. 서버 메모리 세션과 Gemini 클라이언트 제거
```

Atlas 저장은 오디오 전사 처리와 분리합니다. 청크마다 Atlas에 저장하지 않으므로 DB 요청 수와 문서 중간 상태가 증가하지 않습니다.

## 12. 장애·복구 정책

| 상황 | 처리 |
|---|---|
| Render 첫 요청 지연 | 사이드패널에서 연결 중 상태를 표시하고 제한된 횟수로 `/health` 재시도 |
| Render 프로세스 재시작 | 진행 중 세션은 복구하지 않고 사용자에게 새 캡처 시작 안내; 이미 Atlas 저장된 문서는 유지 |
| Atlas 일시 장애 | 저장 실패를 표시하고 확장 메모리 유지 및 TXT·MD 로컬 내보내기 제공 |
| Gemini 429 | 해당 사용자 세션만 일시정지, 실패 청크 보존, 새 Gemini 키 대기 |
| Gemini 503 | 해당 청크를 큐 선두에 보존하고 15·30·45초 재시도 |
| 사용자 접속 코드 오류 | `401`, 세션 생성 중단, 다른 사용자 데이터에 접근하지 않음 |
| 다른 사용자의 문서 ID 요청 | `404` 또는 `403`, 실제 문서 존재 여부를 과도하게 노출하지 않음 |
| 브라우저 종료 | 서버 세션 만료 후 Gemini 클라이언트 제거; 아직 archive하지 않은 결과는 자동 보장하지 않음 |

현재 오디오와 진행 중 결과를 메모리에만 보관하는 정책은 개인정보와 비용 측면에서 유리하지만, Render 재시작 후 자동 이어받기를 제공하지 못한다는 트레이드오프가 있습니다. 자동 이어받기가 필요해질 때만 별도의 임시 청크 저장소를 검토합니다.

## 13. 보안·개인정보 정책

- 사용자 ID는 공개 식별자일 수 있지만 접속 코드와 함께 배포하지 않으면 인증이 되지 않게 합니다.
- 접속 코드와 Gemini API 키를 URL, 쿼리 문자열, 로그, Atlas 문서에 넣지 않습니다.
- Gemini API 키는 세션 메모리에서만 사용하고 `PAUSED_QUOTA`에서 새 키로 교체할 수 있게 합니다.
- Atlas에는 원본 오디오를 저장하지 않고 최종 텍스트만 저장합니다.
- 운영자는 자신의 Render와 Atlas를 관리하므로 모든 사용자의 최종 텍스트에 접근할 수 있습니다.
- 사용자에게 오디오가 운영자 Render와 Gemini API를 거쳐 처리되고 최종 텍스트가 Atlas에 저장된다는 사실을 안내합니다.
- 민감한 개인정보·저작권상 외부 전송이 제한된 강의는 사용하지 않도록 고지합니다.
- MongoDB DB 계정은 최소 권한으로 생성하고 URI는 Render Secret으로 관리합니다.
- 운영 CORS에는 `*`를 사용하지 않습니다.
- 문서 목록·상세·삭제 API는 항상 서버에서 `owner_id`를 필터링합니다.
- 서버 로그에는 API 키, 접속 코드, 오디오 본문, 자막 전문을 기록하지 않습니다.

## 14. 환경 설정 전체 예시

### 14.1 로컬 개발

```dotenv
APP_AUTH_MODE=local
LOCAL_ACCESS_TOKEN=로컬_서버_토큰
ALLOWED_EXTENSION_ORIGINS=chrome-extension://개발용ID

GEMINI_MODEL=gemini-3.6-flash
MOCK_GEMINI=false
AUDIO_CHUNK_SECONDS=300
AUDIO_CHUNK_OVERLAP_SECONDS=5
SESSION_IDLE_TTL_SECONDS=1800

# Atlas 없이 로컬 기능만 확인할 때 false
MONGODB_REQUIRED=false
```

### 14.2 Render 운영

```dotenv
APP_AUTH_MODE=multi_user
ALLOWED_EXTENSION_ORIGINS=chrome-extension://배포용ID

GEMINI_MODEL=gemini-3.6-flash
MOCK_GEMINI=false
AUDIO_CHUNK_SECONDS=300
AUDIO_CHUNK_OVERLAP_SECONDS=5
SESSION_IDLE_TTL_SECONDS=1800

APP_USER_1_ID=user-001
APP_USER_1_TOKEN=발급한_랜덤_토큰
APP_USER_2_ID=user-002
APP_USER_2_TOKEN=발급한_랜덤_토큰

MONGODB_URI=mongodb+srv://사용자:비밀번호@클러스터.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=lecture_memo
MONGODB_COLLECTION=lecture_documents
MONGODB_REQUIRED=true
ARCHIVE_TRANSCRIPT=true
ARCHIVE_SUMMARY=true
```

`.env` 파일에서 주석은 `#`으로 작성할 수 있습니다.

```dotenv
# 청크 길이는 5~600초 범위에서 지정합니다.
AUDIO_CHUNK_SECONDS=300
```

## 15. 구현 변경 범위

### 서버

- `Settings`에 Render·인증·Atlas 환경변수 추가
- `APP_AUTH_MODE`에 따른 인증 의존성 구현
- 사용자 토큰에서 `AuthenticatedUser` 생성
- `SessionRecord.owner_id` 추가
- 모든 세션 API에 소유권 검사 추가
- Render의 `$PORT`를 사용하는 실행 방식 지원
- `/health`에 저장소 상태를 안전하게 표시
- 공식 MongoDB 드라이버 추가 및 lifespan 연결 관리
- `lecture_documents` 인덱스 생성
- `/archive`, 문서 목록·상세·삭제 API 추가
- Atlas 저장 실패 예외와 재시도·오류 응답 구현
- 로그에서 민감 정보 제거

### 확장 프로그램

- Render HTTPS 주소 검증 허용
- Manifest에 운영 Render host permission 추가
- 사이드패널에 사용자 ID·접속 코드 입력란 추가
- `X-User-ID`와 Bearer 사용자 토큰 전송
- 종료·북마크·메타데이터를 `/archive`로 보내는 메시지 추가; 전체 자막·요약은 서버 세션에서 조합
- Atlas 저장 성공·실패 상태 표시
- 저장 실패 시 TXT·MD 로컬 내보내기 유지
- 개발용 로컬 주소와 운영용 Render 주소를 구분

### 문서·배포

- `사용설명서.md`에 Render URL, 사용자 인증정보, Atlas 저장 정책 추가
- `.env.example`에 실제 비밀값 없이 이름만 추가
- Render 배포 설정과 Atlas 초기 설정 절차 추가
- 접속 코드 발급·폐기 절차 추가
- 개인정보 및 외부 API 전송 안내 추가

## 16. 테스트 기준

### 인증

- 등록된 사용자 ID와 접속 코드 조합이 세션을 생성함
- 잘못된 접속 코드는 401
- 존재하지 않는 사용자 ID는 401
- 토큰이 `user-001`에 매핑되는데 `X-User-ID=user-002`이면 거부
- 사용자 A가 사용자 B의 세션 ID를 사용하면 403 또는 404
- 사용자 A가 사용자 B의 문서 ID를 조회·삭제할 수 없음
- 접속 코드와 Gemini 키가 로그·응답·Atlas에 남지 않음

### Render

- `0.0.0.0:$PORT`로 서버가 기동됨
- `/health`가 Render health check에 200을 반환함
- 잘못된 Origin이 거부됨
- 허용된 Render 확장 Origin만 CORS 응답을 받음
- 로컬 주소와 Render 주소 검증이 각각 동작함

### Atlas

- 서버 시작 시 Atlas 연결과 ping 확인
- `owner_id`와 `created_at` 인덱스 생성
- archive 성공 시 서버가 조합한 최종 텍스트와 요약이 저장됨
- 오디오 바이트와 Gemini API 키가 Atlas 문서에 없음
- Atlas 저장 실패 시 확장 프로그램이 성공으로 표시하지 않음
- 사용자별 목록·상세·삭제가 서로 격리됨
- 서버 재시작 후 이미 저장된 문서가 조회됨

### 기존 기능 회귀

- 청크 길이와 겹침 설정이 `/health`에서 확장으로 전달됨
- Gemini 429에서 자동 재시도하지 않고 새 키 입력을 기다림
- Gemini 503에서 15·30·45초 재시도
- 성공한 전사 청크 3개마다 중간 요약
- 자막은 성공 즉시 확정되고 경계 중복만 로컬 조정
- 큐 백프레셔와 종료 대기가 유지됨
- 로컬 MD·TXT·SRT·VTT 내보내기가 유지됨

## 17. 구현 순서

1. Render 실행 포트와 운영 URL 검증을 추가합니다.
2. `manifest.json`, CORS, `/health`를 Render 주소에 맞춥니다.
3. 사용자 ID·접속 코드 인증과 `SessionRecord.owner_id`를 구현합니다.
4. 세션·청크·요약 API의 소유권 검사를 추가합니다.
5. Atlas 연결 모듈과 최종 문서 스키마를 추가합니다.
6. 종료 시 archive 메시지와 저장 API를 연결합니다.
7. 사용자별 문서 조회·삭제를 추가합니다.
8. Render와 Atlas 환경변수를 설정합니다.
9. 최대 7개 테스트 계정으로 통합 테스트합니다.
10. 사용설명서와 개인정보 안내를 갱신합니다.

## 18. v5 범위 밖의 기능

다음 기능은 사용자 수가 늘거나 운영 요구가 생길 때 별도 버전에서 검토합니다.

- 이메일 회원가입과 비밀번호 재설정
- Google·GitHub OAuth
- 관리자 웹 콘솔
- 서버 재시작 후 진행 중 오디오 자동 이어받기
- 원본 오디오의 영구 보관
- 사용자별 Gemini API 키 서버 저장
- 결제·구독 관리
- 대규모 사용자용 Redis 작업 큐
- 임의 사용자가 직접 계정을 생성하는 공개 서비스

7명 이하의 초기 운영에서는 수동 발급형 인증과 Atlas 최종 텍스트 저장으로 충분합니다. 사용자가 늘어나면 Render 환경변수 기반 사용자 목록을 Atlas의 `users` 컬렉션으로 이전하되, 접속 코드는 평문 대신 해시로 저장해야 합니다.
