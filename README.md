# Lecture Memo

Chrome에서 재생 중인 강의 탭의 오디오를 캡처해 한국어 준실시간 자막, 영상 오버레이, 북마크, 요약 노트와 SRT/VTT 내보내기를 제공하는 Manifest V3 확장 프로그램입니다.

오디오는 확장 프로그램과 로컬 Python 서버의 메모리에서만 처리하며 디스크에 저장하지 않습니다. Gemini API 키는 캡처 시작 시 사이드패널에서 입력하고 서버 세션 메모리에서만 사용합니다.

## 구성

```text
extension/  Chrome 116+ 확장 프로그램
server/     FastAPI 로컬 중계 서버
tests/      JavaScript·Python 테스트
```

현재 구현 기준은 [chrome-lecture-caption-summary-design-v3.md](chrome-lecture-caption-summary-design-v3.md)를 참고하세요.

## 1. 서버 설치

### Windows 자동 설치 및 실행

프로젝트 폴더의 `setup-and-run-server.cmd`를 더블클릭하면 다음 작업을 한 번에 처리합니다.

- Python 3.11 이상 설치 여부 확인
- Python이 없으면 `winget`으로 Python 3.11 자동 설치
- `.venv` 가상환경 생성
- 서버 의존성 설치 및 업데이트
- `server/.env` 초기 설정 생성
- 로컬 액세스 토큰 생성
- 서버 실행

처음 설치할 때는 API 호출 없이 UI 흐름을 확인할 수 있도록 `MOCK_GEMINI=true`로 설정됩니다. 실제 Gemini를 사용하려면 `server/.env`에서 `MOCK_GEMINI=false`로 변경한 뒤 서버를 다시 실행하고, 캡처 시작 시 사이드패널에 Gemini API 키를 입력하세요.

설치만 하고 서버를 시작하지 않으려면 명령 프롬프트에서 다음과 같이 실행합니다.

```bat
.\setup-and-run-server.cmd --install-only
```

Python이 설치되어 있지 않은 경우에는 Windows 10 버전 1809 이상 또는 Windows 11에서 `App Installer`와 인터넷 연결이 필요합니다. `winget`을 사용할 수 없는 환경에서는 Python을 먼저 수동 설치해야 합니다.

설치 상태만 확인할 수도 있습니다.

```bat
.\setup-and-run-server.cmd --check
```

### 수동 설치

Python 3.11 이상을 권장합니다. PowerShell에서 프로젝트 폴더로 이동한 뒤 실행합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r server\requirements.txt
Copy-Item server\.env.example server\.env
```

`server/.env`에는 Gemini API 키를 저장하지 않습니다. 모델과 모의 실행 여부만 설정합니다.

```dotenv
GEMINI_MODEL=gemini-3.6-flash
MOCK_GEMINI=false
```

실제 API를 호출하지 않고 흐름만 확인하려면 다음처럼 설정합니다.

```dotenv
MOCK_GEMINI=true
```

한 번에 녹음해서 Gemini로 전송할 길이도 `server/.env`에서 조정할 수 있습니다. 서버를 재시작하고 확장 프로그램에서 새 캡처를 시작하면 자동 반영됩니다.

```dotenv
AUDIO_CHUNK_SECONDS=10
AUDIO_CHUNK_OVERLAP_SECONDS=1
```

`AUDIO_CHUNK_SECONDS`는 5~600초, `AUDIO_CHUNK_OVERLAP_SECONDS`는 0~30초 범위이며 겹침은 청크 길이보다 작아야 합니다. 긴 청크를 사용하면 자막 표시도 해당 청크가 끝난 뒤로 지연됩니다. 서버는 설정한 길이와 64kbps 녹음 기준에 맞춰 업로드 허용 크기를 자동으로 상향합니다.

서버를 시작합니다.

```powershell
python -m server.app
```

프로젝트 가상환경이 이미 준비되어 있다면 루트 폴더에서 다음 스크립트를 실행해도 됩니다.

```powershell
.\start-server.ps1
```

서버 시작 화면에 다음 형태로 로컬 액세스 토큰이 표시됩니다.

```text
Lecture Memo local access token: ...
```

이 토큰은 사이드패널에서 캡처를 시작할 때 입력합니다. `LOCAL_ACCESS_TOKEN`을 `.env`에 지정하면 매 실행 시 같은 토큰을 사용할 수 있습니다.

## 2. Chrome 확장 프로그램 로드

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 오른쪽 위의 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 선택합니다.
4. 이 프로젝트의 `extension` 폴더를 선택합니다.
5. 강의 페이지를 연 뒤 툴바의 Lecture Memo 아이콘을 클릭합니다.
6. 사이드패널에 서버 토큰과 Gemini API 키를 입력하고 `캡처 시작`을 누릅니다.

확장 아이콘을 통해 패널을 열어야 현재 탭에 `activeTab` 권한이 부여됩니다. `chrome://` 페이지, Chrome Web Store, 권한이 없는 `file://` 페이지에서는 실행할 수 없습니다.

## 3. 사용 흐름

- 영상이 일시정지 상태면 실제 재생이 시작될 때까지 녹음을 기다립니다.
- `.env`에 설정한 길이의 오디오 창을 생성하며, 설정한 겹침만큼 앞뒤 청크를 중복 녹음합니다.
- 최신 자막은 임시 상태로 표시되고 다음 청크가 도착하면 중복 제거 후 확정됩니다.
- 영상 탐색·일시정지·배속 변경 시 현재 창을 끊어 영상 타임스탬프를 다시 맞춥니다.
- 대기 오디오 큐가 10MB에 도달하면 캡처를 일시정지하고 6MB 이하에서 재개합니다.
- Gemini가 429 할당량 소진 응답을 반환하면 해당 요청을 재시도하지 않고 캡처를 일시정지하며, 사이드패널에 `할당량 소진` 상태를 표시합니다.
- Gemini API 키는 세션 생성 직후 사이드패널과 확장 프로그램 임시 변수에서 제거되며, 캡처 종료 또는 유휴 세션 만료 시 서버 메모리에서도 제거됩니다.
- 캡처 종료 후 확정 자막과 최종 요약을 MD, TXT, SRT, VTT로 내보낼 수 있습니다.

## 4. 테스트

JavaScript 공통 로직 테스트:

```powershell
node --test tests\extension\core.test.js
```

Python 서버 테스트:

```powershell
python -m pip install -r server\requirements-dev.txt
python -m pytest tests\server
```

모든 JavaScript 파일의 구문 검사:

```powershell
Get-ChildItem extension\*.js | ForEach-Object { node --check $_.FullName }
```

## 보안과 제한사항

- 서버는 `127.0.0.1:8050`에만 바인딩합니다.
- Gemini API 키는 `.env`나 Chrome 저장소에 기록하지 않으며 API 키, 액세스 토큰, 오디오와 자막 본문을 서버 로그에 기록하지 않습니다.
- 오디오는 Gemini API로 전송되므로 외부 전송 사실을 사용자에게 고지해야 합니다.
- DRM, 교차 출처 iframe, Chrome 내부 페이지의 접근 제한을 우회하지 않습니다.
- 브라우저 종료나 확장 프로그램 새로고침 후 세션 복원은 지원하지 않습니다.
- 완전한 단어 단위 실시간 자막이 필요하면 전용 스트리밍 Speech-to-Text 경로가 필요합니다.
