# Chrome 강의 자막·요약 노트 설계서 v5

## 1. 문서 목적

이 문서는 Lecture Memo를 개인 PC에서만 사용하는 로컬 프로그램에서, Render에 FastAPI 서버를 배포하고 MongoDB Atlas에 처리된 전사 초안과 최종 텍스트를 보관하는 소규모 다중 사용자 서비스로 확장하기 위한 설계 기준입니다.

v5는 현재 구현된 Gemini 기반 v3 흐름을 기준으로 합니다. OpenAI 기반 v4 문서는 별도 전환안이며, v5의 기본 공급자는 Gemini로 유지합니다.

목표 사용자는 최대 7명입니다. 회원가입·소셜 로그인·복잡한 권한 관리 대신 관리자가 미리 사용자 ID와 개별 접속 코드를 발급하는 방식을 사용합니다.

핵심 원칙은 다음과 같습니다.

- 확장 프로그램은 여러 사용자가 하나의 Render 서버를 사용합니다.
- 모든 사용자의 요청은 운영자의 Render 서버를 거쳐 각 사용자의 Gemini API로 전달됩니다.
- 성공한 청크의 검증된 전사 텍스트를 Atlas 임시 세션 문서에 저장하고, 종료 시 최종 자막 TXT와 요약으로 확정합니다.
- 오디오 청크는 Render 파일 시스템이나 Atlas에 저장하지 않고, 유실 방지를 위해 처리 중인 항목만 브라우저 IndexedDB에 임시 보관합니다.
- Gemini API 키는 디스크, IndexedDB, Atlas에 저장하지 않고 세션 메모리에서만 사용합니다.
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
| 오디오 보관 | 브라우저·서버 메모리 | 처리 대기 청크만 브라우저 IndexedDB에 임시 보관 |
| 자막·요약 보관 | 확장 프로그램 메모리와 로컬 내보내기 | 청크 전사 텍스트는 Atlas 초안, 종료 시 최종 문서 확정 |
| 요약 주기 | 청크 흐름 중 중간 요약 가능 | 중간 요약 제거, 종료 시 최종 요약 1회 |
| 청크 삭제 기준 | 처리 흐름에 따라 삭제 | 서버 정상 응답과 ACK 확인 전 삭제 금지 |
| 실패 표시 | `chunk_failed` 중심 | quota·timeout·server·repair 대기 등 원인별 상태 |
| 원본 오디오 보관 | 없음 | 없음 |
| 사용자 데이터 구분 | 해당 없음 | 모든 문서에 `owner_id` 저장 및 조회 필터 |
| 확장 배포 | GitHub ZIP 후 압축해제 로드 | GitHub ZIP 유지 + manifest 공개 키로 ID 고정 |
| CORS | 로컬 확장 Origin | 배포된 확장 Origin 허용 목록 |
| 장애 영향 | PC 서버 종료 시 사용 불가 | Render 재시작 후 Atlas 초안과 IndexedDB outbox로 세션 재개 |
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
                                       │   (실시간 자막·종료 시 요약)
                                       └─→ MongoDB Atlas
                                           (청크 전사 초안 + 최종 TXT·요약)
```

각 사용자는 자신의 Gemini API 키를 사이드패널에 입력합니다. 확장 프로그램은 오디오를 Render의 FastAPI로 보내고, FastAPI가 해당 키로 Gemini를 호출합니다. Gemini의 전사·요약 응답은 먼저 FastAPI가 받은 뒤 확장 프로그램에 실시간으로 전달하고, 최종 결과는 FastAPI가 `owner_id`를 붙여 Atlas에 저장합니다.

사용자는 Atlas에 직접 접속하지 않습니다. MongoDB URI, DB 사용자, Render 환경변수는 운영자만 관리합니다.

### 3.1 구성요소별 책임

| 구성요소 | 책임 |
|---|---|
| Chrome Service Worker | 현재 탭 권한, `tabCapture` 스트림 ID, 메시지 라우팅 |
| Offscreen Document | 녹음, 청크 큐, 재시도, 캡션·노트의 실제 세션 상태 |
| Content Script | 영상 시간 추적, 탐색, 자막 오버레이 |
| Side Panel | 사용자 인증정보, Gemini API 키 입력과 상태 표시 |
| Render FastAPI | 사용자 인증, 세션 소유권, Gemini 호출, 서버 기준 자막 정규화, Atlas 저장 API |
| Gemini API | 사용자 API 키를 이용한 전사·요약 |
| MongoDB Atlas | 성공한 청크 전사 초안, 최종 텍스트 문서의 영구 보관과 사용자별 조회 |

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

### 4.5 관리자 사용자 발급대장

초기 사용자 슬롯은 다음과 같이 고정합니다. 실제 접속 코드 원문은 이 문서나 GitHub에 기록하지 않고, 관리자가 Render 환경변수와 별도의 비밀번호 관리 도구에서 관리합니다.

| 슬롯 | 사용자 ID | 발급 상태 | 접속 코드 관리 | 사용자 전달 |
|---|---|---|---|---|
| 1 | `user-001` | 미발급 | 관리자 보관 | 관리자 직접 전달 |
| 2 | `user-002` | 미발급 | 관리자 보관 | 관리자 직접 전달 |
| 3 | `user-003` | 미발급 | 관리자 보관 | 관리자 직접 전달 |
| 4 | `user-004` | 미발급 | 관리자 보관 | 관리자 직접 전달 |
| 5 | `user-005` | 미발급 | 관리자 보관 | 관리자 직접 전달 |
| 6 | `user-006` | 미발급 | 관리자 보관 | 관리자 직접 전달 |
| 7 | `user-007` | 미발급 | 관리자 보관 | 관리자 직접 전달 |

사용자는 직접 가입하거나 접속 코드를 생성할 수 없습니다. 관리자가 사용자별 난수 접속 코드를 생성해 `APP_USER_n_TOKEN`으로 Render에 등록하고 해당 사용자에게 개별 전달합니다. 사용 중지 시 해당 슬롯의 토큰만 새 값으로 교체하거나 환경변수에서 제거합니다.

## 5. 세션과 소유권

### 5.1 세션 레코드

현재 메모리 세션에는 Gemini 클라이언트와 처리 잠금만 유지하고, 재시작 후에도 필요한 전사 상태는 Atlas 초안 컬렉션에 저장합니다.

```python
SessionRecord(
    session_id="...",
    owner_id="user-001",
    source_tab_id=123,
    source_url="https://www.youtube.com/watch?v=...",
    language="ko",
    gemini=<session-scoped client>,
    draft_session_id="...",
)
```

`session_id`는 추측하기 어려운 UUID를 사용하고, 모든 청크·요약·종료 요청에서 세션 소유자를 다시 검증합니다.

FastAPI만 청크 경계 중복을 조정하고 Atlas에 저장할 기준 자막을 만듭니다. 확장 프로그램은 서버가 반환한 정규화 결과를 그대로 표시하며 내용 병합을 다시 수행하지 않습니다. 이를 통해 사이드패널·로컬 내보내기·Atlas 결과를 동일하게 유지합니다.

각 청크의 검증된 전사 결과는 `lecture_session_chunks`에 `(owner_id, session_id, sequence)` 기준으로 upsert합니다. Atlas 저장까지 성공한 뒤에만 확장 프로그램에 ACK를 반환합니다. Render가 재시작되면 사용자가 Gemini 키를 다시 입력해 서버 메모리 클라이언트를 복구하고, Atlas 초안에서 처리 상태를 다시 읽습니다.

서버는 세션별 잠금과 Atlas의 `next_sequence`를 함께 사용해 청크를 순서대로 처리합니다. 이미 처리된 시퀀스는 기존 결과를 반환하고, 아직 앞 시퀀스가 비어 있는 요청은 `409 sequence_gap`으로 보류합니다. 이 규칙이 있어야 5초 겹침 제거 결과가 재전송·재시작 뒤에도 동일합니다.

### 5.2 세션 흐름

```text
사이드패널에 사용자 ID·접속 코드·Gemini API 키 입력
→ /health/ready 조회
→ 사용자 인증 헤더와 함께 POST /v1/sessions
→ 서버가 owner_id를 확정
→ Gemini 키로 세션 전용 클라이언트 생성
→ 세션 ID 발급
→ 300초 청크 전사만 반복
→ 청크별 전사 텍스트를 Atlas 초안에 저장한 뒤 ACK
→ 종료 시 /archive로 최종 요약·저장 요청
→ 최종 저장 성공 확인 후 선택된 보존 정책에 따라 Atlas 초안과 서버 세션 정리
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
uvicorn server.app:app --host 0.0.0.0 --port $PORT --workers 1

Health Check Path:
/health/live
```

로컬에서 사용하는 `127.0.0.1:8050`은 개발용으로만 남깁니다. Render에서는 `server.app`의 `__main__`에 고정된 8050 포트를 사용하지 않고 Start Command의 `$PORT`를 사용합니다.

초기 v5는 프로세스 메모리에 Gemini 클라이언트를 두므로 Render 인스턴스 1개와 Uvicorn worker 1개로 운영합니다. Python 런타임은 `.python-version`으로 3.12 계열을 고정해 배포 환경의 임의 업그레이드를 막습니다.

### 6.2 Render 환경변수

운영 환경의 예시는 다음과 같습니다.

```dotenv
# Gemini
GEMINI_MODEL=gemini-3.6-flash
MOCK_GEMINI=false

# 청크
AUDIO_CHUNK_SECONDS=300
AUDIO_CHUNK_OVERLAP_SECONDS=5
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
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
MONGODB_DOCUMENT_COLLECTION=lecture_documents
MONGODB_SESSION_COLLECTION=lecture_sessions
MONGODB_CHUNK_COLLECTION=lecture_session_chunks
MONGODB_REQUIRED=true

# 보관 정책
ARCHIVE_TRANSCRIPT=true
ARCHIVE_SUMMARY=true
INCOMPLETE_DRAFT_RETENTION_DAYS=7
```

`MONGODB_URI`, 사용자 접속 코드, 로컬 토큰은 절대 GitHub에 커밋하지 않습니다. `.env.example`에는 키 이름만 남기고 실제 값은 비워 둡니다.

### 6.3 Render 운영 시 고려사항

- Render의 공개 URL은 HTTPS를 사용하므로 확장 프로그램은 `https://...onrender.com` 주소로 접속합니다.
- 초기 운영은 Render 무료 플랜으로 진행합니다. 일정 시간 요청이 없으면 절전될 수 있어 첫 요청 지연을 UI에서 안내합니다.
- Render 파일 시스템은 영구 저장소로 사용하지 않습니다. 텍스트 저장은 Atlas만 담당합니다.
- Render 프로세스가 재시작되면 서버 메모리의 Gemini 클라이언트는 사라지지만, Atlas의 세션·청크 전사 초안은 유지됩니다.
- 사용자가 Gemini 키를 다시 입력하면 `/resume`이 Atlas의 초안과 처리 상태를 읽어 세션을 복구합니다. 이미 ACK된 청크는 Gemini에 다시 보내지 않습니다.
- 브라우저 IndexedDB의 `PENDING`, `RETRY_WAIT`, `NEEDS_ACTION` 청크도 유지되며 복구된 세션으로 재전송합니다.
- 초기 운영은 인스턴스 1개·worker 1개로 제한합니다. 수평 확장이 필요해지면 Gemini 클라이언트 상태도 외부 저장소로 옮겨야 합니다.
- 종료 전에 Atlas 저장이 실패하면 확장 프로그램에서 TXT·MD 로컬 내보내기를 제공하고, 사용자에게 저장 실패를 명확히 표시합니다.
- 장시간 강의에서 청크 요청이 일정 주기로 발생하므로 정상 처리 중에는 서버가 계속 사용되지만, 일시정지 시간이 길면 재기동 지연을 고려합니다.

Render 공식 문서:

- [Render Web Services](https://render.com/docs/web-services)
- [Render FastAPI 배포](https://render.com/docs/deploy-fastapi)
- [Render Free 서비스 제한](https://render.com/docs/free)

### 6.4 배포 정책 선택지

Render의 배포 트리거는 다음처럼 구분합니다.

| 방식 | 동작 | 장점 | 주의점 |
|---|---|---|---|
| 커밋 즉시 자동 배포 | 연결 브랜치에 push되면 바로 빌드·배포 | 가장 단순하고 빠름 | 테스트 실패 커밋도 배포를 시도할 수 있음 |
| CI 통과 후 자동 배포 | GitHub 등의 상태 검사가 모두 통과한 커밋만 배포 | 문제 있는 코드의 운영 반영을 차단 | 먼저 GitHub Actions 등 CI 검사를 구성해야 함 |
| 수동 배포 | 자동 배포를 끄고 관리자가 Dashboard나 API에서 실행 | 배포 시점을 관리자가 완전히 통제 | 업데이트 누락 가능성이 있고 매번 직접 실행해야 함 |

초기 운영 정책은 **CI 검사 후 관리자 수동 배포**로 확정합니다. GitHub Actions는 push와 pull request마다 서버·확장 프로그램 검사를 실행하지만, Render의 Auto-Deploy는 `Off`로 설정합니다. 관리자는 CI 통과를 확인하고 사용자가 캡처 중이지 않은 시간에 Render Dashboard의 `Manual Deploy > Deploy latest commit`을 실행합니다. 커밋 즉시 자동 배포와 `checksPass` 자동 배포는 초기 운영에서 사용하지 않습니다.

향후 Gemini 클라이언트와 세션 상태를 완전히 외부 저장소로 이전해 배포 중 키 재입력이 필요 없어지면 `checksPass` 자동 배포 전환을 다시 검토합니다.

Render Web Service 자체는 새 인스턴스가 준비된 뒤 트래픽을 전환하는 무중단 배포를 지원합니다. 다만 이 서비스의 Gemini 클라이언트는 프로세스 메모리에 있으므로 인스턴스 교체 뒤 다음 요청에서 키 재입력과 `/resume`이 필요할 수 있습니다. 전사 초안과 미처리 오디오는 Atlas와 IndexedDB에 남으므로 데이터는 유실하지 않습니다.

## 7. 확장 프로그램 배포와 고정 서버 주소

### 7.1 배포 방식

초기 7명은 **GitHub ZIP + manifest 공개 키 고정** 방식으로 배포합니다.

1. GitHub에서 ZIP을 다운로드합니다.
2. 압축을 해제합니다.
3. `chrome://extensions`에서 개발자 모드를 켭니다.
4. 압축해제된 `extension` 폴더를 로드합니다.
5. 발급받은 사용자 ID와 접속 코드, 본인의 Gemini 인증 키를 입력합니다.

운영 빌드에는 `PRODUCTION_SERVER_URL`을 고정하여 사용자가 Render 주소를 입력하지 않게 합니다. 로컬 개발 주소는 개발 빌드에서만 선택할 수 있게 분리합니다.

고정 ID 준비 절차는 다음과 같습니다.

1. 관리자가 운영용 확장 ZIP을 Chrome Developer Dashboard에 한 번 업로드합니다.
2. 게시하지 않은 상태에서도 Dashboard의 Package 화면에서 공개 키를 확인합니다.
3. 공개 키의 헤더·푸터와 줄바꿈을 제거한 값을 운영용 `manifest.json`의 `key`에 넣습니다.
4. 압축해제 로드 후 표시되는 확장 ID가 Developer Dashboard의 Item ID와 같은지 확인합니다.
5. 확정된 ID를 Render의 `ALLOWED_EXTENSION_ORIGINS`에 등록합니다.

```json
{
  "manifest_version": 3,
  "key": "<Chrome-Developer-Dashboard에서-받은-공개-키>"
}
```

manifest `key`는 확장 ID를 고정하는 공개값이며 사용자 접속 코드, `LOCAL_ACCESS_TOKEN`, Gemini 인증 키와 무관합니다. 비밀 접속 코드는 manifest와 GitHub에 절대 넣지 않습니다.

### 7.2 Manifest와 URL 허용

운영용 확장 프로그램은 고정된 Render 주소만 허용하고, 개발용 빌드만 로컬 주소를 허용합니다.

```json
"host_permissions": [
  "https://<render-service>.onrender.com/*"
]
```

개발용 manifest에는 다음 주소를 별도로 추가합니다.

- 로컬 개발: `http://127.0.0.1:8050`, `http://localhost:8050`
- 운영 빌드: 사전에 등록한 Render HTTPS 호스트만 허용
- 그 밖의 임의 HTTP·HTTPS 주소와 사용자 입력 URL: 거부

운영 배포에서는 `ALLOWED_EXTENSION_ORIGINS`에 공개 키로 계산된 고정 확장 ID 하나를 정확히 등록합니다. 개발용 확장은 별도의 manifest와 개발 Origin 설정을 사용합니다.

### 7.3 CORS

Render API는 다음 헤더를 허용합니다.

```text
Authorization
Content-Type
X-User-ID
```

`Access-Control-Allow-Origin`은 허용된 `chrome-extension://<id>` 목록과 정확히 일치해야 합니다. `*`는 인증 요청과 운영 데이터 API에 사용하지 않습니다.

`/health/live`는 프로세스 생존 확인용으로 인증 없이 열고, `/health/ready`는 Atlas 연결 등 요청 처리 가능 여부를 반환합니다. 두 응답 모두 API 키·사용자 토큰·MongoDB URI를 반환하지 않습니다.

## 8. MongoDB Atlas 저장 설계

### 8.1 저장 범위

Atlas에는 검증된 청크 전사 텍스트 초안과 최종 결과 텍스트를 저장합니다. 원본 오디오는 저장하지 않습니다.

저장하지 않는 항목:

- WebM/Opus 오디오 청크
- Gemini API 키
- 사용자 접속 코드 원문
- 서버 인증 헤더
- 처리 중인 임시 청크 파일
- 전체 Gemini 원시 응답

저장하는 항목:

- 진행 중 세션의 소유자·상태·처리된 시퀀스
- 청크별 정규화·경계 조정이 끝난 전사 텍스트
- 최종 자막 TXT
- 최종 요약
- 주요 개념·전문 용어·강조 내용·복습 체크리스트
- 사용자가 만든 북마크와 메모
- 강의 URL, 처리 시간, 청크 수, 누락 청크 수
- `owner_id`, 문서 ID, 생성·완료 시각

### 8.2 문서 구조

세 컬렉션을 사용합니다.

- `lecture_sessions`: 진행 중·미완료·완료 세션의 메타데이터와 처리 상태
- `lecture_session_chunks`: 청크별 확정 전사 초안
- `lecture_documents`: 최종 자막과 최종 요약

청크 초안 예시는 다음과 같습니다.

```json
{
  "owner_id": "user-001",
  "session_id": "uuid",
  "sequence": 1,
  "chunk_id": "uuid:1",
  "start_ms": 0,
  "end_ms": 300000,
  "canonical_transcript": "경계 조정이 끝난 전사 텍스트",
  "status": "transcribed",
  "created_at": "2026-09-18T10:05:00Z",
  "updated_at": "2026-09-18T10:05:20Z"
}
```

최종 문서 예시는 다음과 같습니다.

```json
{
  "_id": "ObjectId",
  "document_id": "uuid",
  "session_id": "uuid",
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
(owner_id, session_id): unique on lecture_documents
(owner_id, created_at): descending
(owner_id, session_id): unique on lecture_sessions
(owner_id, session_id, sequence): unique on lecture_session_chunks
expire_at: TTL on lecture_sessions and lecture_session_chunks
```

`incomplete` 전환 시 세션과 해당 청크의 `expire_at`을 7일 뒤로 설정합니다. 완료 문서 저장에 성공하면 초안을 즉시 삭제합니다. 세션을 재개하면 `expire_at`을 새 활동 시각 기준으로 갱신하고, 완료 문서에는 TTL을 적용하지 않습니다.

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
→ lecture_sessions, lecture_session_chunks, lecture_documents 컬렉션 선택
→ 인덱스 보장
→ ping 성공 후 운영 요청 허용
```

Atlas Network Access에는 Render Dashboard의 Connect 화면에 표시되는 서비스 Outbound CIDR 범위를 등록합니다. `0.0.0.0/0` 전체 허용은 개발용 임시 설정으로만 취급합니다. DB 계정은 세 컬렉션을 사용하는 데이터베이스에만 최소 권한을 부여합니다.

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

### 9.3 처리·복구 API

다음 API는 세션 소유자 검증을 추가하여 유지합니다.

```text
GET    /health/live
GET    /health/ready
POST   /v1/sessions/{session_id}/resume
POST   /v1/sessions/{session_id}/gemini-key
POST   /v1/sessions/{session_id}/chunks
DELETE /v1/sessions/{session_id}
```

중간 요약 API와 별도 최종 요약 API는 제거합니다. `/archive`가 누락 청크 검증, 최종 요약 1회 생성, 최종 문서 저장을 하나의 idempotent 종료 작업으로 수행합니다. 처리되지 않은 청크가 남아 있으면 종료 작업을 보류합니다. 429 할당량 소진 시 자동 재시도를 중단하고 실패 청크를 보존합니다. 사용자가 남은 할당량이 있는 다른 프로젝트의 Gemini 인증 키를 입력하면 같은 소유자의 세션만 재개합니다.

`/resume`은 Atlas의 `lecture_sessions`와 `lecture_session_chunks`를 읽어 이미 처리한 시퀀스를 복원합니다. Gemini 키는 Atlas에 저장하지 않으므로 Render 재시작 후 사용자가 다시 입력해야 합니다.

### 9.4 최종 보관 API

캡처 종료 후 확장 프로그램은 최종 저장을 요청하고, FastAPI가 Atlas의 청크 초안과 최종 요약을 조합해 명시적으로 저장합니다. 확장 프로그램이 Atlas에 직접 접근하거나, 클라이언트가 보낸 임의의 전체 자막을 그대로 신뢰하지 않습니다.

```http
POST /v1/sessions/{session_id}/archive
```

```json
{
  "source_title": "강의 제목",
  "bookmarks": [],
  "duration_ms": 3600000,
  "expected_end_sequence": 12
}
```

서버는 세션에서 확인한 `owner_id`와 인증 사용자 ID가 같은지 확인합니다. `chunk_count`와 `missing_chunk_count`는 Atlas의 청크 초안을 기준으로 서버가 계산하며 클라이언트 값을 신뢰하지 않습니다. 누락이 없으면 최종 요약을 한 번 생성하고 최종 문서를 저장합니다. 저장 성공 시 다음을 반환합니다.

```json
{
  "saved": true,
  "document_id": "uuid"
}
```

같은 세션의 archive 요청이 재전송되면 `(owner_id, session_id)` unique 인덱스로 기존 문서를 반환합니다. 최종 요약 도중 429·503이 발생하면 세션을 `finalize_pending`으로 유지하고, 새 키 입력 또는 제한된 재시도 뒤 같은 요청을 이어갑니다.

처리 불가능한 청크가 남으면 별도 확인 창 없이 처리 완료분을 `lecture_sessions.status=incomplete`로 자동 저장하고 부분 자막 TXT 내보내기를 허용합니다. 완전한 문서로 표시하거나 최종 요약을 생성하지 않으며, 사용자는 나중에 키를 다시 입력해 재개하거나 미완료 세션 폐기를 선택할 수 있습니다.

### 9.5 문서 조회·삭제 API

사용자별 기록을 제공하려면 다음 API를 추가합니다.

```text
GET    /v1/documents?limit=50&cursor=...
GET    /v1/documents/{document_id}
DELETE /v1/documents/{document_id}
```

조회 결과는 인증된 사용자의 `owner_id`에 해당하는 문서만 반환합니다. 관리자용 전체 조회 API는 v5 범위에 포함하지 않고, 운영자가 Atlas Dashboard에서 관리합니다.

### 9.6 표준 오류 응답

모든 API 오류는 확장 프로그램이 재시도 여부를 판단할 수 있도록 다음 구조를 사용합니다.

```json
{
  "error": {
    "code": "gemini_quota_exhausted",
    "message": "Gemini 할당량이 소진되었습니다.",
    "retryable": false,
    "action": "replace_gemini_key",
    "chunk_id": "uuid:3",
    "retry_after_seconds": null
  }
}
```

`code`는 `gemini_quota_exhausted`, `gemini_overloaded`, `network_timeout`, `payload_too_large`, `unsupported_media`, `invalid_request`, `atlas_unavailable`처럼 원인을 구분합니다. 내부 예외 전문과 비밀값은 응답하지 않습니다.

## 10. 확장 프로그램 UI 변경

Render 운영용 사이드패널은 다음과 같이 구성합니다.

```text
사용자 ID       [user-001]
접속 코드       [••••••••••••]
Gemini 인증 키  [••••••••••••]

[캡처 시작] [캡처 종료]
상태: 캡처 중
```

UI 동작:

- 사용자 ID와 접속 코드는 캡처 시작 요청과 세션 복구 인증에 사용하며, 브라우저 영구 저장소에는 저장하지 않습니다.
- Gemini 인증 키는 세션 생성 성공 직후 입력란과 확장 메모리에서 제거합니다. Render 재시작 후에는 다시 입력받습니다.
- 운영 서버 주소는 확장 프로그램의 `PRODUCTION_SERVER_URL`에 고정하고 사이드패널 입력란을 제공하지 않습니다.
- 401이면 사용자 ID·접속 코드 재입력을 안내합니다.
- 403이면 확장 Origin 또는 배포 버전이 허용되지 않은 상태로 표시합니다.
- 429이면 자동 재시도하지 않고 남은 할당량이 있는 다른 프로젝트의 Gemini 인증 키 입력을 안내합니다. 같은 프로젝트의 키 교체만으로는 프로젝트 할당량이 복구되지 않습니다.
- Atlas 저장 성공 전에는 `저장 완료`를 표시하지 않습니다.
- Atlas 저장 실패 시 로컬 TXT·MD 내보내기 버튼을 우선 안내합니다.
- 저장 완료 후 `document_id`를 표시하고, 추후 문서 목록에서 다시 열 수 있게 합니다.
- 요약은 캡처 종료 전에는 요청하지 않으며, 종료 시 처리되지 않은 청크가 있으면 최종 요약을 보류합니다.

## 11. 전사·요약·보관 흐름

```text
1. 사용자 인증 확인
2. Render /health/ready 조회
3. Gemini 키를 포함한 세션 생성
4. Offscreen이 300초 오디오 청크를 만들고 IndexedDB outbox에 먼저 기록
5. outbox 상태를 `PENDING`으로 저장한 뒤 Render FastAPI에 전송
6. Render FastAPI가 사용자 Gemini 키로 Gemini에 전사 요청
7. Gemini가 전사 결과를 Render FastAPI에 반환
8. Render FastAPI만 청크 경계 중복을 조정해 정규화된 전사를 확정
9. FastAPI가 해당 전사를 Atlas `lecture_session_chunks`에 idempotent upsert
10. Atlas 저장 성공 후 FastAPI가 정규화한 자막과 ACK를 확장 프로그램에 전달
11. 확장 프로그램이 ACK를 검증한 뒤 해당 원본 오디오를 삭제
12. 429면 해당 세션만 `PAUSED_QUOTA`로 전환하고 청크를 보존
13. 503·타임아웃이면 청크를 `RETRY_WAIT`로 보존하고 15·30·45초 재시도
14. 413·415·422면 원본을 보존한 채 `NEEDS_ACTION`으로 표시
15. 캡처 종료 후 대기·실패 청크가 모두 처리될 때까지 drain
16. 확장 프로그램이 종료·북마크 메타데이터로 idempotent archive 요청
17. FastAPI가 누락 여부를 검증하고 Atlas 초안을 읽어 최종 요약을 한 번 생성
18. FastAPI가 Atlas 초안·최종 요약을 TXT로 조합하고 owner_id를 붙여 최종 문서 저장
19. 최종 문서 저장 성공 후 세션 초안과 남은 outbox 메타데이터를 정리
20. Gemini 클라이언트 참조 제거
```

원본 오디오는 Atlas에 저장하지 않지만, 검증된 청크 전사는 매 청크마다 저장합니다. 이 쓰기 1회가 Render 재시작과 브라우저 원본 삭제 사이의 유실을 막는 필수 안전장치입니다.

### 11.1 청크 outbox와 ACK 규칙

각 청크는 다음 식별자와 상태를 가집니다.

```text
chunk_id = session_id + sequence
PENDING → SENDING → ACKED
                    ├─ RETRY_WAIT
                    ├─ PAUSED_QUOTA
                    └─ NEEDS_ACTION
```

삭제 규칙:

- 오디오 청크는 서버가 전사 검증과 Atlas upsert까지 끝낸 뒤 `2xx` ACK를 반환하기 전까지 삭제하지 않습니다.
- 서버가 같은 `owner_id + session_id + sequence`를 다시 받으면 Atlas의 기존 결과를 반환하고 Gemini를 중복 호출하지 않습니다.
- 429·503·네트워크 오류는 원본 Blob과 메타데이터를 그대로 보존합니다.
- 413은 설정 오류로 취급하고 원본을 보존합니다. 완성된 WebM 파일을 바이트 단위로 나누어 재전송하지 않습니다.
- 녹음 시작 전에 `MediaRecorder.isTypeSupported()`로 MIME을 검사해 415를 예방합니다. 예상하지 못한 415가 발생하면 원본을 보존하고 사용자 조치를 요청합니다.
- 422처럼 같은 요청을 반복해도 해결되지 않는 오류는 `NEEDS_ACTION`으로 보존하고 사용자에게 원인을 표시합니다.
- Atlas upsert가 실패하면 ACK하지 않으므로 원본 오디오가 IndexedDB에 남습니다.

IndexedDB는 처리 중인 오디오 청크의 임시 outbox로만 사용합니다. 사용자별 상한은 128 MiB(`134217728` bytes), 미처리 청크 보존 기간은 72시간으로 확정합니다. 확장 프로그램은 `navigator.storage.estimate()`로 브라우저 실제 사용량도 확인하고 상한 초과 전에 캡처를 멈춰야 합니다. ACK된 오디오는 즉시 삭제하며, 미처리 청크는 브라우저 재실행 후 복구합니다. 72시간이 지난 outbox는 `expired`로 표시하고 사용자에게 내보내기 또는 수동 폐기를 요구하며, 사용자 확인 없이 원본을 자동 삭제하지 않습니다.

### 11.2 요청 수와 업로드 크기 사전 점검

캡처 시작 전에 예상 강의 길이를 알 수 있으면 `ceil(강의 초 / 300) + 최종 요약 1회`로 최소 Gemini 요청 수를 표시합니다. 90분 강의는 최소 19회이며 마지막 부분 청크와 장애 재시도 여유까지 고려해 20회 이상 남아 있어야 안전하다고 안내합니다. 503·타임아웃 재시도도 실제 요청으로 집계될 수 있다고 가정해 보수적으로 계산합니다.

확장 프로그램은 `/health/ready`에서 `chunk_seconds`, `max_chunk_bytes`, `max_request_bytes`를 받아 녹음 설정과 맞는지 확인합니다. 현재 300초·64 kbps 녹음과 관측된 약 4.3 MB 청크를 수용하도록 운영 기본값을 6 MB/6.5 MB로 두며, 초과가 예상되면 녹음을 시작하지 않습니다.

## 12. 장애·복구 정책

| 상황 | 처리 |
|---|---|
| Render 첫 요청 지연 | 사이드패널에서 연결 중 상태를 표시하고 제한된 횟수로 `/health/ready` 재시도 |
| Render 프로세스 재시작 | 사용자가 Gemini 키를 다시 입력하면 `/resume`이 Atlas 초안을 복원; ACK된 청크는 재전사하지 않음 |
| Atlas 일시 장애 | 청크 ACK를 반환하지 않고 IndexedDB 원본과 Atlas에 이미 저장된 초안을 유지 |
| Gemini 429 | 해당 사용자 세션만 일시정지하고 원본 청크를 보존한 뒤 새 Gemini 키 대기 |
| Gemini 503 | 해당 청크를 `RETRY_WAIT`로 보존하고 15·30·45초 재시도 |
| 네트워크·타임아웃 | 원본 청크를 보존하고 제한된 재시도 후 `RETRY_WAIT` 유지 |
| 413 용량 초과 | 원본 보존, 설정 오류 표시, 다음 캡처부터 청크 길이·비트레이트 조정; 현재 WebM 자동 바이트 분할 금지 |
| 415 MIME 오류 | 녹음 시작 전 지원 MIME 검사; 예상하지 못한 오류는 원본 보존 후 사용자 조치 대기 |
| 422 요청 오류 | 원본을 삭제하지 않고 `NEEDS_ACTION`으로 표시해 사용자 조치 대기 |
| 사용자 접속 코드 오류 | `401`, 세션 생성 중단, 다른 사용자 데이터에 접근하지 않음 |
| 다른 사용자의 문서 ID 요청 | `404` 또는 `403`, 실제 문서 존재 여부를 과도하게 노출하지 않음 |
| 브라우저 종료 | IndexedDB의 미처리 outbox를 유지하고 다음 확장 실행 시 세션 복구 |
| 일부 청크를 끝내 처리할 수 없음 | 확인 없이 처리 완료분을 `incomplete` 초안으로 자동 저장하고 부분 TXT 내보내기 제공; 최종 요약은 생성하지 않음 |

브라우저 IndexedDB에는 미처리 원본 오디오만, Atlas에는 처리된 전사 텍스트만 남습니다. 따라서 어느 한쪽이 재시작되더라도 마지막으로 ACK된 경계를 기준으로 복구할 수 있습니다.

## 13. 보안·개인정보 정책

- 사용자 ID는 공개 식별자일 수 있지만 접속 코드와 함께 배포하지 않으면 인증이 되지 않게 합니다.
- 접속 코드와 Gemini API 키를 URL, 쿼리 문자열, 로그, Atlas 문서에 넣지 않습니다.
- Gemini API 키는 세션 메모리에서만 사용하고 `PAUSED_QUOTA`에서 새 키로 교체할 수 있게 합니다.
- Atlas에는 원본 오디오를 저장하지 않고 처리된 전사 초안과 최종 텍스트만 저장합니다.
- 오디오 청크는 처리 중에만 브라우저 IndexedDB에 임시 저장하며, 해당 전사가 Atlas에 저장됐다는 ACK 후 삭제합니다.
- IndexedDB 임시 저장 사실과 브라우저 종료 후 미처리 청크 복구 정책을 사용자에게 안내합니다.
- 사용량 상한, 보존 기간, 세션별 수동 폐기 기능으로 IndexedDB 무한 증가를 방지합니다.
- 완료 문서 저장 성공 직후 해당 세션·청크 초안을 삭제하고, `incomplete` 초안에는 7일 만료 시각을 기록해 TTL 인덱스로 정리합니다.
- 사용자는 자신의 Gemini 인증 키를 세션 시작 때 직접 입력하며 운영자는 사용자별 Gemini 키를 수집하거나 제공하지 않습니다.
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
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
FINAL_SUMMARY_REQUIRE_ALL_CHUNKS=true
SESSION_IDLE_TTL_SECONDS=1800

# Atlas 없이 로컬 기능만 확인할 때 false. 이 모드에는 재시작 복구 보장이 없습니다.
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
MAX_CHUNK_BYTES=6000000
MAX_REQUEST_BYTES=6500000
FINAL_SUMMARY_REQUIRE_ALL_CHUNKS=true
SESSION_IDLE_TTL_SECONDS=1800

APP_USER_1_ID=user-001
APP_USER_1_TOKEN=발급한_랜덤_토큰
APP_USER_2_ID=user-002
APP_USER_2_TOKEN=발급한_랜덤_토큰

MONGODB_URI=mongodb+srv://사용자:비밀번호@클러스터.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=lecture_memo
MONGODB_DOCUMENT_COLLECTION=lecture_documents
MONGODB_SESSION_COLLECTION=lecture_sessions
MONGODB_CHUNK_COLLECTION=lecture_session_chunks
MONGODB_REQUIRED=true
ARCHIVE_TRANSCRIPT=true
ARCHIVE_SUMMARY=true
INCOMPLETE_DRAFT_RETENTION_DAYS=7
```

`.env` 파일에서 주석은 `#`으로 작성할 수 있습니다.

```dotenv
# 청크 길이는 5~600초 범위에서 지정합니다.
AUDIO_CHUNK_SECONDS=300
```

다음은 Render 환경변수가 아니라 확장 프로그램 빌드 설정입니다.

```text
PRODUCTION_SERVER_URL=https://<render-service>.onrender.com
QUEUE_STORAGE=indexeddb
OUTBOX_MAX_BYTES=134217728
OUTBOX_RETENTION_HOURS=72
```

## 15. 구현 변경 범위

### 서버

- `Settings`에 Render·인증·Atlas 환경변수 추가
- 운영 기본 청크 길이를 300초로 유지하고 중간 요약 경로 제거
- `APP_AUTH_MODE`에 따른 인증 의존성 구현
- 사용자 토큰에서 `AuthenticatedUser` 생성
- `SessionRecord.owner_id` 추가
- FastAPI를 유일한 경계 중복 조정 주체로 지정
- 청크별 상태·시퀀스·정규화 전사를 Atlas 초안에 즉시 upsert
- `owner_id + session_id + sequence` 중복 요청에 대한 영속 idempotency 응답 구현
- 모든 세션 API에 소유권 검사 추가
- Render의 `$PORT`, Uvicorn worker 1개, Python 3.12 고정 실행 방식 지원
- `/health/live`와 `/health/ready` 분리
- 공식 MongoDB 드라이버 추가 및 lifespan 연결 관리
- 세 Atlas 컬렉션과 필수 unique 인덱스 생성
- `/resume`에서 Atlas 초안과 처리 시퀀스 복구
- idempotent `/archive`, 문서 목록·상세·삭제 API 추가
- 중간·별도 최종 요약 API를 제거하고 `/archive`에서 최종 요약 1회만 허용
- 미처리 청크가 있으면 확인 없이 `incomplete` 초안을 자동 저장하고 최종 요약·완료 보관은 보류
- 완료 초안 즉시 삭제와 `incomplete` 7일 TTL 정리 구현
- 429·503·413·415·422·timeout·Atlas 장애를 구조화된 오류 코드로 반환
- Atlas 저장 실패 예외와 재시도·오류 응답 구현
- 로그에서 민감 정보 제거

### 확장 프로그램

- 운영 Render HTTPS 주소를 빌드 설정에 고정하고 서버 주소 입력란 제거
- 운영·개발 Manifest와 URL 설정 분리
- 운영 manifest에 Chrome Developer Dashboard 공개 키를 넣어 확장 ID 고정
- 사이드패널에 사용자 ID·접속 코드 입력란 추가
- `X-User-ID`와 Bearer 사용자 토큰 전송
- 300초 청크를 IndexedDB outbox에 먼저 기록
- `PENDING`·`SENDING`·`ACKED`·`RETRY_WAIT`·`PAUSED_QUOTA`·`NEEDS_ACTION` 상태 구현
- Atlas 청크 초안 저장이 확인된 ACK 전에는 원본 청크를 삭제하지 않음
- 녹음 전 지원 MIME 검사, 413·415·422 원본 보존과 사용자 조치 흐름 구현
- IndexedDB 사용량 검사, 128 MiB 상한, 72시간 만료 표시, 세션별 수동 폐기 구현
- 중간·별도 최종 요약 요청 제거; 종료 시 `/archive`만 요청
- 종료·북마크·메타데이터를 `/archive`로 보내는 메시지 추가; 전체 자막·요약과 청크 통계는 서버가 Atlas 초안에서 조합
- Atlas 저장 성공·실패 상태 표시
- 저장 실패 시 TXT·MD 로컬 내보내기 유지
- Render 재시작 뒤 키 재입력과 `/resume` 호출 흐름 구현

### 문서·배포

- `사용설명서.md`에 고정 Render 연결, 사용자 인증정보, Atlas 초안·최종 저장 정책 추가
- `.env.example`에 실제 비밀값 없이 이름만 추가
- Render 배포 설정과 Atlas 초기 설정 절차 추가
- 접속 코드 발급·폐기 절차 추가
- 개인정보 및 외부 API 전송 안내 추가
- `.python-version`과 Render 배포 설정 추가
- GitHub Actions CI 워크플로 추가 및 Render Auto-Deploy `Off` 설정
- 관리자 수동 배포 절차와 배포 전 활성 캡처 확인 절차 문서화
- GitHub ZIP 다운로드·압축 해제·확장 새로고침 방식의 수동 업데이트 절차 문서화

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
- `/health/live`가 Render health check에 200을 반환함
- Atlas 장애 시 `/health/ready`는 준비되지 않은 상태를 반환함
- 잘못된 Origin이 거부됨
- 허용된 Render 확장 Origin만 CORS 응답을 받음
- 운영 빌드에 서버 주소 입력란이 없고 고정 Render 주소만 사용함
- 개발 빌드는 로컬 주소만 별도 설정으로 사용함
- 동일한 운영 ZIP을 서로 다른 PC에 설치해도 확장 ID가 동일함
- manifest 공개 키가 접속 코드나 Gemini 키로 사용되지 않음
- GitHub Actions CI 실패 커밋은 관리자가 배포하지 않음
- Render Auto-Deploy가 `Off`이며 push만으로 배포되지 않음
- CI 통과 후 관리자의 `Deploy latest commit`으로만 운영 버전이 변경됨

### Atlas

- 서버 시작 시 Atlas 연결과 ping 확인
- 문서·세션·청크 unique 인덱스 생성
- 청크 전사 upsert 성공 전에 ACK가 반환되지 않음
- 같은 청크 재전송이 Atlas 결과를 반환하고 Gemini를 다시 호출하지 않음
- archive 성공 시 서버가 조합한 최종 텍스트와 요약이 저장됨
- 오디오 바이트와 Gemini API 키가 Atlas 문서에 없음
- 중간 요약 API가 호출되지 않음
- Atlas 저장 실패 시 확장 프로그램이 성공으로 표시하지 않음
- 사용자별 목록·상세·삭제가 서로 격리됨
- 서버 재시작 후 이미 저장된 문서가 조회됨
- 서버 재시작 후 초안을 복구해 ACK된 청크 이후부터 재개함
- 완료 문서 저장 직후 세션 초안이 삭제됨
- `incomplete` 초안이 마지막 활동부터 7일 뒤 TTL로 정리됨

### 기존 기능 회귀

- 청크 길이 300초, 겹침, 최대 업로드 크기가 `/health/ready`에서 확장으로 전달됨
- 관측된 약 4.3 MB 청크가 6 MB 제한에서 정상 처리됨
- Gemini 429에서 자동 재시도하지 않고 새 키 입력을 기다림
- Gemini 503에서 15·30·45초 재시도
- 캡처 중 중간 요약 요청이 발생하지 않음
- 캡처 종료 후 최종 요약 요청이 최대 1회 발생함
- 서버 성공 ACK 전에는 IndexedDB 청크가 삭제되지 않음
- 녹음 시작 전 지원되지 않는 MIME이 차단됨
- 413·415·422 반려 청크가 자동 바이트 분할 없이 `NEEDS_ACTION` 원본으로 보존됨
- 동일 `session_id + sequence` 재전송이 Gemini 중복 호출을 만들지 않음
- 미처리 청크가 남아 있으면 확인 창 없이 처리 완료분이 `incomplete`로 자동 저장되고 최종 요약은 생성되지 않음
- 브라우저 재시작 후 IndexedDB 미처리 outbox를 다시 읽음
- 자막은 FastAPI가 경계 중복을 조정한 결과만 확정되며 확장 프로그램은 다시 병합하지 않음
- 큐 백프레셔와 종료 대기가 유지됨
- 로컬 MD·TXT·SRT·VTT 내보내기가 유지됨
- IndexedDB 상한 도달 전 캡처가 안전하게 중단되고 수동 폐기가 가능함
- IndexedDB 미처리 청크가 72시간 뒤 `expired`로 표시되며 사용자 확인 없이 삭제되지 않음
- 사용자가 입력한 Gemini 키가 브라우저 영구 저장소·Atlas·로그에 남지 않음

## 17. 구현 순서

1. Atlas 세션·청크 초안 스키마와 unique 인덱스를 먼저 구현합니다.
2. 청크 전사 저장 후에만 ACK하는 영속 idempotency를 구현합니다.
3. 사용자 ID·접속 코드 인증과 `SessionRecord.owner_id`를 구현합니다.
4. 세션·청크 API의 소유권 검사와 `/resume`을 추가합니다.
5. IndexedDB outbox와 ACK·재시도·반려·용량 관리 상태를 구현합니다.
6. FastAPI 단독 경계 조정과 확장 프로그램 표시 흐름을 연결합니다.
7. 중간·별도 최종 요약 API를 제거하고 종료 시 idempotent `/archive`만 연결합니다.
8. 미처리 청크가 없을 때 완료 문서를 만들고, 있으면 `incomplete` 초안을 유지합니다.
9. 사용자별 문서 조회·삭제를 추가합니다.
10. 고정 Render URL, Manifest, CORS, health check, Python 버전을 설정합니다.
11. GitHub Actions CI를 추가하고 Render Auto-Deploy를 `Off`로 설정합니다.
12. 최대 7개 테스트 계정으로 재시작·장애 포함 통합 테스트합니다.
13. 관리자 수동 배포 절차, 사용설명서와 개인정보 안내를 갱신합니다.

## 18. v5 범위 밖의 기능

다음 기능은 사용자 수가 늘거나 운영 요구가 생길 때 별도 버전에서 검토합니다.

- 이메일 회원가입과 비밀번호 재설정
- Google·GitHub OAuth
- 관리자 웹 콘솔
- 사용자 키 재입력 없이 서버 재시작을 완전히 투명하게 복구하는 기능
- 원본 오디오의 영구 보관
- 사용자별 Gemini API 키 서버 저장
- 결제·구독 관리
- 대규모 사용자용 Redis 작업 큐
- 임의 사용자가 직접 계정을 생성하는 공개 서비스

7명 이하의 초기 운영에서는 수동 발급형 인증과 Atlas 전사 초안·최종 텍스트 저장으로 충분합니다. 사용자가 늘어나면 Render 환경변수 기반 사용자 목록을 Atlas의 `users` 컬렉션으로 이전하되, 접속 코드는 평문 대신 해시로 저장해야 합니다.

## 19. 확정 사항과 남은 입력값

| 번호 | 항목 | 상태 | 적용 내용 |
|---:|---|---|---|
| 1 | 실제 Render 서비스 URL | **입력 대기** | 서비스 생성 후 HTTPS URL을 운영 확장 프로그램에 고정 |
| 2 | 확장 배포와 고정 ID | **방식 확정·값 대기** | GitHub ZIP + manifest 공개 키; Dashboard 공개 키와 계산된 확장 ID 필요 |
| 3 | 미완료 세션 처리 | **확정** | 처리 완료분을 `incomplete`로 자동 저장하고 최종 요약 없이 재개 가능하게 처리 |
| 4 | IndexedDB 정책 | **확정** | 128 MiB 상한, 미처리 청크 72시간 보존, 세션별 수동 폐기 제공 |
| 5 | Atlas 초안 정리 | **확정** | 완료 시 즉시 삭제, `incomplete` 초안은 마지막 활동부터 7일 보존 |
| 6 | Render 배포 정책 | **확정** | GitHub Actions CI 검사 후 관리자가 Render에서 수동 배포; Auto-Deploy `Off` |
| 7 | Render 요금제 | **확정** | 무료 플랜으로 시작하고 절전 해제 지연을 UI에 표시 |
| 8 | 초기 사용자 관리 | **확정** | `user-001`~`user-007` 슬롯을 관리자가 발급·보관·개별 전달 |
| 9 | Gemini 사용 정책 | **확정** | 각 사용자가 자신의 Gemini 인증 키를 세션 시작 때 직접 입력 |

현재 구현 전에 반드시 추가로 필요한 값은 실제 Render URL, Chrome Developer Dashboard 공개 키와 그 공개 키로 계산된 확장 ID입니다. 배포는 GitHub Actions CI 통과를 확인한 관리자가 사용자가 캡처 중이지 않은 시간에 수동으로 진행합니다.
