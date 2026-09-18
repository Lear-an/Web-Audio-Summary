# Lecture Memo

Chrome에서 재생 중인 강의 탭의 오디오를 300초 단위로 캡처해 Gemini로 전사하고, 종료 시 최종 요약을 생성하는 Manifest V3 확장 프로그램입니다. V5는 Render의 FastAPI 서버와 MongoDB Atlas를 이용해 최대 7명의 소규모 사용자를 지원합니다.

설계 기준은 [V5 설계서](chrome-lecture-caption-summary-design-v5.md), 설치·사용 순서는 [사용 설명서](사용설명서.md)를 참고하세요.

## V5 구조

```text
Chrome 확장 프로그램
  ├─ IndexedDB: ACK 전 오디오 청크 임시 보관
  └─ HTTPS → Render FastAPI → Gemini API
                              └→ MongoDB Atlas
                                  (전사 초안·최종 TXT·요약)
```

- 사용자는 관리자에게 받은 사용자 ID·접속 코드와 본인의 Gemini API 키를 입력합니다.
- Gemini 키는 서버 세션 메모리에서만 사용하며 확장 저장소·Atlas·환경변수에 저장하지 않습니다.
- 성공한 전사는 Atlas에 저장된 뒤에만 ACK됩니다. ACK 전 원본 오디오는 IndexedDB에 남습니다.
- 중간 요약은 만들지 않고 캡처 종료 시 최종 요약을 한 번만 생성합니다.
- 미처리 오디오는 최대 128 MiB, 72시간 보존하며 사용자 확인 없이 자동 삭제하지 않습니다.
- 완료 문서 저장 직후 Atlas 초안을 삭제하고, 미완료 초안은 7일간 보존합니다.

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

기본 로컬 주소는 `http://127.0.0.1:8050`입니다. `server/.env` 기본값은 300초 청크, 5초 겹침, 실제 Gemini 호출입니다.

## Render·Atlas 운영 준비

1. MongoDB Atlas에서 데이터베이스 사용자와 연결 문자열을 준비합니다.
2. Render에서 이 GitHub 저장소의 Web Service를 만들고 `render.yaml`을 사용합니다.
3. Render 환경변수에 `MONGODB_URI`, 사용자별 `APP_USER_n_ID/TOKEN`, `ALLOWED_EXTENSION_ORIGINS`를 입력합니다.
4. `extension/config.js`의 `SERVER_BASE_URL`에는 실제 Render HTTPS URL이 반영되어 있습니다.
5. `extension/manifest.json`의 Render host permission에도 같은 URL이 반영되어 있습니다.
6. Chrome Developer Dashboard의 공개 키를 manifest의 `key`로 넣어 확장 ID를 고정합니다.
7. 고정된 확장 ID를 `chrome-extension://<확장-id>` 형식으로 Render의 `ALLOWED_EXTENSION_ORIGINS`에 등록합니다.

Render URL은 현재 `https://web-audio-summary.onrender.com`으로 반영되어 있습니다. Chrome Developer Dashboard의 manifest 공개 키와 확장 ID만 아직 운영자 입력값으로 남아 있습니다. Render Auto-Deploy는 꺼져 있으며, CI 통과 뒤 관리자가 수동 배포하는 정책입니다.

필수 Render 비밀 환경변수 예시는 다음과 같습니다.

```dotenv
APP_AUTH_MODE=multi_user
APP_USER_1_ID=user-001
APP_USER_1_TOKEN=<충분히 긴 무작위 접속 코드>
ALLOWED_EXTENSION_ORIGINS=chrome-extension://<고정 확장 ID>
MONGODB_URI=mongodb+srv://...
MONGODB_REQUIRED=true
```

## 장애·복구 동작

- Gemini `429`: 자동 재시도를 중단하고 원본 청크를 보존합니다. 다른 프로젝트의 유효한 키를 입력해 같은 세션을 계속할 수 있습니다.
- Gemini `503`: 청크를 보존하고 15초·30초·45초 간격으로 재시도합니다.
- Render/네트워크/Atlas 장애: ACK하지 않으며 IndexedDB 원본을 유지합니다.
- Render 재시작으로 서버 세션이 초기화된 경우: `서버 세션 복구`를 누르고 Gemini API 키를 다시 입력하면 `/resume` 후 보존 청크를 순서대로 재전송합니다.
- 종료 시 누락 청크 존재: 최종 요약 없이 Atlas에 `incomplete`로 자동 보관합니다.
- 브라우저 재시작: 동일한 강의 URL에서 캡처를 시작하면 보존 세션을 찾아 `/resume`으로 이어갑니다.
- 72시간 경과: 청크를 `EXPIRED`로 표시하며 사용자가 직접 내보내거나 폐기할 때까지 삭제하지 않습니다.

## 테스트

```powershell
node --test tests\extension\*.test.js
.\.venv\Scripts\python.exe -m pytest -q
Get-ChildItem extension\*.js | ForEach-Object { node --check $_.FullName }
```

GitHub Actions도 Python 3.12와 Node.js 22에서 같은 검사를 실행합니다.

## 보안 주의사항

- 접속 코드, Gemini API 키, MongoDB URI를 GitHub에 커밋하지 마세요.
- 오디오는 Render와 Gemini로 전송되고 최종 자막·요약은 Atlas에 저장됩니다. 사용자에게 이 사실을 안내해야 합니다.
- Atlas 조회 API는 인증된 `owner_id`로 필터링합니다.
- Render는 반드시 worker 1개로 실행합니다. 현재 Gemini 클라이언트가 프로세스 메모리에 있기 때문입니다.
