# Lecture Memo

Chrome에서 재생 중인 강의 탭의 오디오를 60초 창·2초 겹침으로 캡처해 OpenAI로 전사하고, 종료 시 최종 요약을 생성하는 Manifest V3 확장 프로그램입니다. V8은 Render의 FastAPI 서버와 MongoDB Atlas를 이용해 등록 10명·동시 활성 5명을 기본 지원합니다.

설계 기준은 [V8 설계서](chrome-lecture-caption-summary-design-v8.md), 설치·사용 순서는 [사용 설명서](사용설명서.md)를 참고하세요.

## V8 구조

```text
Chrome 확장 프로그램
  ├─ IndexedDB: ACK 전 오디오 청크 임시 보관
  └─ HTTPS → Render FastAPI → OpenAI API
                              └→ MongoDB Atlas
                                  (전사 초안·최종 TXT·요약)
```

- 사용자는 관리자에게 받은 사용자 ID와 접속 코드만 입력합니다.
- OpenAI 키는 운영자가 Render Secret으로 관리하며 확장 프로그램·Atlas·GitHub에 저장하지 않습니다.
- 성공한 전사와 부분 문서가 Atlas에 저장된 뒤에만 ACK됩니다. 중간에 저장이 실패하면 동일 청크 재전송으로 세션 순번과 부분 문서를 복구하며, ACK 전 원본 오디오는 IndexedDB에 남습니다.
- 중간 요약은 만들지 않고 캡처 종료 시 최종 요약 결과를 문서에 한 번 확정합니다. 장애 후 재시도에서는 OpenAI 호출이 다시 발생할 수 있습니다.
- 최종 요약과 `completed` 상태는 한 번의 문서 쓰기로 확정합니다. 배속 재생의 자막 시각은 영상 시간축으로 환산해 저장합니다.
- 미처리 오디오는 최대 128 MiB, 72시간 보존하며 사용자 확인 없이 자동 삭제하지 않습니다.
- 완료 문서 저장 직후 Atlas 초안을 삭제하고, 미완료 초안은 7일간 보존합니다. Render 재시작 뒤 오래된 세션도 시작·조회·재개·종료 시 정리하며 부분 문서는 유지합니다.
- 세션 재개 시 만료 판정·초안 TTL 해제·활성 사용자 lease를 MongoDB 트랜잭션으로 확정합니다. 필요한 READY 청크가 사라졌다면 재개 성공으로 응답하지 않습니다.
- 서버는 원본 URL 대신 정리된 URL만 세션·문서에 저장합니다. YouTube는 영상 식별용 `v`만 유지하고 다른 사이트의 쿼리·fragment·URL 사용자 정보는 제거합니다.
- 서버 시작 시 기존 Atlas 세션·문서에 남은 URL도 같은 규칙으로 정리합니다.
- 보존 세션 폐기는 서버 초안 삭제가 확인된 뒤 로컬 청크를 삭제합니다. 서버 삭제 실패 시 청크를 유지하며, 서버에 남은 부분 문서는 재개 불가 상태로 표시합니다.

## 저장소 구성

```text
extension/      Chrome 116+ 확장 프로그램
server/         FastAPI 중계·보관 API
tests/          JavaScript·Python 테스트
render.yaml     Render 무료 Web Service 설정
.github/        GitHub Actions CI
```

## 로컬 개발

Windows에서는 프로젝트 루트의 `setup-and-run-server.cmd`를 더블클릭하면 Python 확인·설치, 가상환경 생성, 패키지 설치, 로컬 토큰 생성과 서버 실행을 순서대로 처리합니다.

PowerShell에서 실행할 때는 현재 폴더 실행 표시가 필요합니다.

```powershell
.\setup-and-run-server.cmd
```

설치만 하려면 다음 명령을 사용합니다.

```powershell
.\setup-and-run-server.cmd --install-only
```

수동 설치는 Python 3.11 이상에서 가능합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r server\requirements.txt
Copy-Item server\.env.example server\.env
python -m server.app
```

기본 로컬 주소는 `http://127.0.0.1:8050`입니다. 최초 자동 생성되는 `server/.env`는 60초 청크, 2초 겹침, `MOCK_OPENAI=true`입니다. 실제 호출은 `OPENAI_API_KEY`를 입력하고 `MOCK_OPENAI=false`로 변경합니다.

## Render·Atlas 운영 준비

1. MongoDB Atlas에서 데이터베이스 사용자와 연결 문자열을 준비합니다.
2. Render에서 이 GitHub 저장소의 Web Service를 만들고 `render.yaml`을 사용합니다.
3. Render 환경변수에 `OPENAI_API_KEY`, `MONGODB_URI`, 사용자별 `APP_USER_n_ID/TOKEN_SHA256`, `ALLOWED_EXTENSION_ORIGINS`를 입력합니다.
4. `extension/config.js`의 `SERVER_BASE_URL`에는 실제 Render HTTPS URL이 반영되어 있습니다.
5. `extension/manifest.json`의 Render host permission에도 같은 URL이 반영되어 있습니다.
6. Chrome Developer Dashboard의 공개 키를 manifest의 `key`로 넣어 확장 ID를 고정합니다.
7. 고정된 확장 ID를 `chrome-extension://<확장-id>` 형식으로 Render의 `ALLOWED_EXTENSION_ORIGINS`에 등록합니다.

Render URL은 현재 `https://web-audio-summary.onrender.com`으로 반영되어 있습니다. Chrome Developer Dashboard의 manifest 공개 키와 확장 ID만 아직 운영자 입력값으로 남아 있습니다. Render Auto-Deploy는 꺼져 있으며, CI 통과 뒤 관리자가 수동 배포하는 정책입니다.

필수 Render 비밀 환경변수 예시는 다음과 같습니다.

```dotenv
APP_AUTH_MODE=multi_user
APP_USER_1_ID=user-001
APP_USER_1_TOKEN_SHA256=<접속 코드의 SHA-256>
ALLOWED_EXTENSION_ORIGINS=chrome-extension://<고정 확장 ID>
MONGODB_URI=mongodb+srv://...
MONGODB_REQUIRED=true
OPENAI_API_KEY=<Render Secret>
SAFETY_IDENTIFIER_SECRET=<충분히 긴 무작위 비밀값>
```

## 장애·복구 동작

- OpenAI quota `429`: 자동 재시도를 중단하고 원본 청크를 보존합니다. 운영자가 결제·한도를 해결한 뒤 `처리 다시 시도`를 누릅니다.
- OpenAI rate limit/`503`: 청크를 보존하고 `Retry-After` 또는 15초·30초·45초 간격으로 재시도합니다.
- Render/네트워크/Atlas 장애: ACK하지 않으며 IndexedDB 원본을 유지합니다.
- Render 재시작으로 서버 세션이 초기화된 경우: `서버 세션 복구`를 누르면 `/resume` 후 보존 청크를 순서대로 재전송합니다.
- 처리 lease가 만료돼 다른 시도가 시작된 경우: 늦게 끝난 이전 시도는 새 청크 결과를 덮어쓰지 않으며 보존 원본으로 재시도합니다.
- 종료 시 누락 청크 존재: 최종 요약 없이 Atlas에 `incomplete`로 자동 보관합니다.
- 브라우저 재시작: 동일한 강의 URL에서 캡처를 시작하면 보존 세션을 찾아 `/resume`으로 이어갑니다.
- 72시간 경과: 청크를 `EXPIRED`로 표시하며 사용자가 직접 내보내거나 폐기할 때까지 삭제하지 않습니다.
- 보존 세션 폐기: 사용자 ID와 접속 코드를 입력한 뒤 서버 삭제를 확인합니다. 네트워크·인증 오류가 나면 로컬 청크가 남아 재시도할 수 있습니다.

## 테스트

```powershell
node --test tests\extension\core.test.js tests\extension\outbox.test.js tests\extension\discard.test.js tests\extension\offscreen_discard.test.js
.\.venv\Scripts\python.exe -m pytest -q
Get-ChildItem extension\*.js | ForEach-Object { node --check $_.FullName }
```

GitHub Actions도 Python 3.12와 Node.js 22에서 같은 검사를 실행합니다.

실제 MongoDB 트랜잭션 검증에는 비운영 테스트 클러스터가 필요합니다. 로컬 환경의 `MONGODB_TEST_URI` 또는 Git에서 제외되는 `tests/server/.env.test.local`에 새 URI를 설정하면 `python -m pytest tests/server/test_mongo_integration.py -q`로 고유한 임시 DB에서 재개·삭제를 확인한 뒤 해당 DB를 정리합니다. 변수가 없으면 이 테스트는 건너뜁니다. 운영 클러스터의 URI는 사용하지 마세요.

## 보안 주의사항

- 접속 코드, OpenAI API 키, MongoDB URI를 GitHub에 커밋하지 마세요.
- 오디오는 Render와 OpenAI로 전송되고 부분·최종 자막과 요약은 Atlas에 저장됩니다. 사용자에게 이 사실을 안내해야 합니다.
- Atlas 조회 API는 인증된 `owner_id`로 필터링합니다.
- 무료 Render에서는 worker 1개를 기본으로 사용합니다. 청크·최종화 중복 방지는 Atlas lease로 처리합니다.
