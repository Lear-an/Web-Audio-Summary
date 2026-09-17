# Chrome 강의 자막·요약 노트 확장 프로그램 설계서 v3

## 1. 목적

이 문서는 Chrome에서 사용자가 선택한 강의 탭의 오디오를 캡처하고, 로컬 FastAPI 서버를 통해 Gemini API로 전사·요약하는 Lecture Memo의 구현 기준을 정의합니다.

v3는 v2의 Manifest V3 아키텍처를 유지하면서 실제 운용에서 확인된 다음 문제를 반영합니다.

- 무료 등급의 모델별·프로젝트별 요청 횟수 제한
- Gemini 429 할당량 소진 응답의 잘못된 502 변환
- 오디오와 Pydantic `response_schema` 조합에서 발생한 400 오류
- 확장 코드에 고정되어 있던 10초 청크 설정
- 청크 길이 변경 시 서버 시간·크기 제한이 불일치하는 문제

## 2. v2 대비 주요 변경점

| 항목 | v2 | v3 |
|---|---|---|
| 청크 길이 | 확장 코드에 10초 고정 | `server/.env`에서 5~600초 설정 |
| 겹침 길이 | 확장 코드에 1초 고정 | `server/.env`에서 0~30초 설정 |
| Gemini API 키 | 서버 `.env`에 저장 | 캡처 시작 시 사이드패널에서 입력, 세션 메모리에서만 사용 |
| 키 보존 | 서버 재시작 후에도 파일에 남음 | 저장하지 않으며 캡처 종료·서버 종료 시 제거 |
| 설정 전달 | 확장·서버를 각각 수정 | 서버 `/health`를 단일 설정 원천으로 사용 |
| 업로드 크기 | 1MB 고정 | 청크 시간과 64kbps 기준으로 자동 상향 |
| 서버 허용 시간 | 최대 15초 고정 | 설정 청크 길이 + 타이머 오차 5초 |
| 오디오 응답 | Pydantic 구조화 출력 직접 요청 | 프롬프트 JSON 출력 후 서버 Pydantic 검증 |
| Gemini 429 | 일반 502 | HTTP 429 전달, 재시도 중단, 캡처 일시정지 |
| Gemini 400 | 일반 502라 재시도 | HTTP 422로 전달, 재시도하지 않음 |
| 상태 모델 | 백프레셔 일시정지 | `PAUSED_QUOTA` 추가 |

## 3. 전체 구조

```text
Chrome action 클릭
→ Service Worker가 현재 탭 권한과 스트림 ID 확보
→ Offscreen Document가 탭 오디오 녹음
→ GET /health에서 청크 설정 조회
→ 설정된 길이와 겹침으로 WebM/Opus Blob 생성
→ FastAPI 서버에 multipart/form-data 전송
→ Gemini 오디오 전사 요청
→ 서버가 JSON을 Pydantic으로 검증
→ 자막 중복 제거와 타임라인 보정
→ 사이드패널·영상 오버레이 갱신
```

역할 분리는 다음과 같습니다.

- Service Worker: 권한 요청, 스트림 ID 발급, 메시지 라우팅
- Offscreen Document: 녹음창, 큐, 재시도, 세션 상태의 실제 소유자
- Content Script: 영상 시간 추적, 탐색, 오버레이
- Side Panel: 로컬 서버 토큰과 Gemini API 키 입력, 상태·자막·요약·북마크 표시
- FastAPI 서버: 인증, 세션별 Gemini 클라이언트, 설정 제공, 요청 제한, Gemini 호출과 응답 검증

## 4. 외부 청크 설정

설정 파일은 `server/.env`입니다.

```dotenv
AUDIO_CHUNK_SECONDS=10
AUDIO_CHUNK_OVERLAP_SECONDS=1
```

검증 규칙:

- `AUDIO_CHUNK_SECONDS`: 5~600 정수
- `AUDIO_CHUNK_OVERLAP_SECONDS`: 0~30 정수
- 겹침은 청크 길이보다 작아야 함
- 잘못된 값이면 서버 시작 단계에서 실패하여 조용히 잘못 동작하지 않게 함

설정 적용 흐름:

```text
server/.env 변경
→ 서버 재시작
→ /health 응답에 chunk_seconds와 chunk_overlap_seconds 포함
→ 확장 프로그램이 캡처 시작 전에 조회
→ windowMs, overlapMs, windowIntervalMs 계산
→ 새 캡처 세션부터 적용
```

`/health` 응답 예시:

```json
{
  "status": "ok",
  "model": "gemini-3.6-flash",
  "mock_mode": false,
  "chunk_seconds": 10,
  "chunk_overlap_seconds": 1
}
```

실제 녹음 시작 간격은 다음과 같습니다.

```text
window_interval = chunk_seconds - overlap_seconds
```

예를 들어 300초 청크와 5초 겹침이면 녹음창은 `0~300초`, `295~595초`, `590~890초` 순서로 생성됩니다.

## 5. Gemini API 키 입력과 수명주기

Gemini API 키는 `.env`, Chrome 저장소, IndexedDB, Local Storage 또는 파일에 저장하지 않습니다. 사용자는 사이드패널에서 캡처를 시작할 때마다 키를 입력합니다.

사이드패널 구성:

```text
로컬 서버 주소
로컬 액세스 토큰
Gemini API 키 [password 입력]
캡처 시작
```

API 키 입력란은 다음 속성을 사용합니다.

```html
<input
  id="geminiApiKey"
  type="password"
  autocomplete="off"
  spellcheck="false"
>
```

키 전달과 제거 흐름:

```text
사용자가 Gemini API 키 입력
→ 캡처 시작 클릭
→ START_SESSION 메시지의 일회성 payload로 전달
→ Offscreen Document가 POST /v1/sessions 본문에 포함
→ 서버가 세션 전용 GeminiClient 생성
→ 세션 생성 성공 후 사이드패널 input과 확장 측 임시 변수 초기화
→ 전사·요약 요청은 session_id에 연결된 클라이언트 사용
→ 캡처 종료 시 DELETE /v1/sessions/{session_id}
→ SessionRecord와 GeminiClient 참조 제거
```

저장하지 않는 대상:

- `chrome.storage.local`
- `chrome.storage.sync`
- `chrome.storage.session`
- `localStorage`와 IndexedDB
- Offscreen 세션 스냅샷
- Service Worker 전역 상태
- 서버 `.env`
- 서버 로그와 오류 응답

세션 생성 요청 예시:

```json
{
  "source_tab_id": 123,
  "source_url": "https://example.com/lecture",
  "language": "ko",
  "gemini_api_key": "사용자가 입력한 키"
}
```

서버 변경 원칙:

- 전역 `GeminiClient`를 제거하고 `SessionRecord`마다 클라이언트를 생성
- 원문 키를 별도 문자열 필드로 보존하지 않고 Gemini 클라이언트 생성에만 사용
- 세션 생성 API는 로컬 액세스 토큰과 허용된 확장 Origin을 모두 검증
- 키가 비어 있으면 세션을 만들지 않고 422 반환
- 세션 삭제, 탭 종료, 서버 종료 시 클라이언트 참조 제거
- 비정상 종료로 DELETE가 오지 않는 경우를 위해 유휴 세션 만료 정책 추가
- API 키 유효성은 첫 실제 Gemini 요청에서 확인하며 키 내용을 오류에 포함하지 않음

확장 프로그램은 키를 저장하지 않으므로 `storage` 권한을 추가하지 않습니다. Chrome이나 확장을 다시 시작했을 때 복구할 키 상태도 없습니다.

로컬 서버와 확장 프로그램 사이가 `http://127.0.0.1`이므로 요청은 컴퓨터 밖으로 라우팅되지 않지만 TLS로 암호화되지는 않습니다. 따라서 Origin 검증과 로컬 액세스 토큰 인증을 유지하고, API 키를 URL·쿼리 문자열·로그에 넣지 않으며 POST 본문으로 한 번만 전달합니다.

`server/.env`에는 다음 항목만 둡니다.

```dotenv
GEMINI_MODEL=gemini-3.6-flash
LOCAL_ACCESS_TOKEN=로컬_서버_토큰
MOCK_GEMINI=false
AUDIO_CHUNK_SECONDS=10
AUDIO_CHUNK_OVERLAP_SECONDS=1
MAX_CHUNK_BYTES=1000000
MAX_REQUEST_BYTES=1300000
```

`GEMINI_API_KEY`는 `.env.example`, 자동 설치 스크립트 안내와 README에서도 제거합니다.

## 6. 동적 요청 크기 제한

MediaRecorder 목표 비트레이트는 64kbps입니다. 설정한 청크 길이로부터 예상 크기를 계산합니다.

```text
예상 청크 바이트 = 청크 초 × 8,000 × 1.5 + 65,536
```

- `8,000`: 64kbps를 초당 바이트로 변환한 값
- `1.5`: 브라우저 인코더 편차와 복사 비용 안전계수
- `65,536`: WebM 컨테이너와 multipart 여유

실제 `MAX_CHUNK_BYTES`는 `.env` 지정값과 계산값 중 큰 값을 사용합니다. `MAX_REQUEST_BYTES`도 청크 한도보다 최소 300KB 크게 자동 보정합니다.

Gemini 인라인 요청은 전체 20MB 미만을 유지해야 합니다. 64kbps 기준 600초 오디오는 약 4.8MB이므로 현재 허용 범위 안에 들어옵니다.

## 7. 전사 요청 형식

오디오 입력과 Pydantic `response_schema`를 함께 전달했을 때 `400 INVALID_ARGUMENT`이 발생하는 실제 동작을 반영했습니다.

v3 전사 흐름:

```text
오디오 + JSON 출력 지시 프롬프트
→ Gemini 일반 텍스트 응답
→ Markdown fence 제거
→ JSON 객체 범위 추출
→ json.loads
→ TranscriptPayload.model_validate
```

기대 JSON:

```json
{
  "segments": [
    {
      "relative_start_ms": 0,
      "relative_end_ms": 1000,
      "text": "전사 내용",
      "uncertain": false
    }
  ]
}
```

음성이 없으면 `{"segments":[]}`를 반환하도록 지시합니다. 서버가 세션 ID와 시퀀스를 직접 붙이므로 모델의 메타데이터는 신뢰하지 않습니다.

요약 요청은 텍스트 입력에서 구조화 출력이 정상 동작하므로 기존 Pydantic `response_schema`를 유지합니다.

## 8. 오류와 재시도 정책

| 오류 | 서버 응답 | 확장 동작 |
|---|---:|---|
| Gemini 할당량 소진 | 429 | 즉시 재시도 중단, 녹음·큐 중지, `할당량 소진` 표시 |
| Gemini 잘못된 요청 | 422 | 재시도하지 않고 청크 실패 표시 |
| 인증 실패 | 401 | 캡처 시작 실패, 토큰 재입력 안내 |
| Origin 불일치 | 403 | 요청 거부 |
| 일시적 서버 오류 | 5xx | 제한된 지수 백오프 재시도 |
| 요청 시간 초과 | 클라이언트 timeout | 제한된 지수 백오프 재시도 |

429 처리 순서:

```text
Gemini ClientError 429 감지
→ 서버가 HTTP 429와 안전한 안내 문구 반환
→ 확장이 현재 요청 재시도 중단
→ PAUSED_QUOTA 전환
→ 새 녹음창 스케줄 취소
→ 실행 중 Recorder 정지
→ 전송 대기 큐 해제
→ 누락 구간 gemini_quota_exhausted 기록
→ 사용자가 캡처 종료 가능
```

할당량 소진 상태에서는 최종 요약 요청도 보내지 않습니다.

## 9. 상태 모델

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

`PAUSED_QUOTA`는 자동 복구하지 않습니다. 일일 한도, 결제, 프로젝트 설정이 변경되어도 이미 열린 세션의 큐와 녹음 경계를 안전하게 복구하기 어렵기 때문입니다. 사용자가 기존 세션을 종료하고 새 캡처를 시작해야 합니다.

## 10. 청크 길이 선택 기준

청크가 길어질수록 API 요청 수는 감소하지만 자막 표시 지연과 실패 시 누락 범위가 증가합니다.

```text
요청 수 ≈ 강의 길이 ÷ (청크 길이 - 겹침)
첫 자막 지연 ≈ 청크 길이 + 업로드 + 모델 처리시간
```

권장 프로필:

| 목적 | 청크 | 겹침 | 특성 |
|---|---:|---:|---|
| 빠른 자막 확인 | 10~30초 | 1~2초 | 높은 요청 수 |
| 유료 API 균형형 | 60초 | 3초 | 약 1분 이상의 표시 지연 |
| 무료 60분 강의 절약형 | 205초 | 5초 | 중간 요약을 끄는 조건 |
| 무료 90분 강의 절약형 | 305초 | 5초 | 요청 18회와 최종 요약 1회 기준 |

무료 요청 20회에서 최종 요약 1회와 여유 1회를 남기면 전사에 18회를 사용할 수 있습니다.

```text
필요 청크 길이 = 강의 초 ÷ 18 + 겹침 초
```

중간 요약을 유지하면 각 청크당 전사와 요약으로 요청이 거의 두 배가 되므로 위 계산이 성립하지 않습니다. 무료 절약형에서는 중간 요약을 비활성화하거나 로컬에서 생성해야 합니다.

## 11. 보안과 개인정보

- Gemini API 키는 사이드패널에서 캡처 시작 시에만 입력하고 어디에도 저장하지 않음
- 로컬 액세스 토큰과 Gemini API 키의 용도를 UI에서 명확히 구분
- 서버는 세션별 Gemini 클라이언트만 메모리에 유지하고 세션 종료 시 참조 제거
- 서버는 `127.0.0.1:8000`에만 바인딩
- 오디오를 파일로 저장하지 않고 메모리에서 처리
- API 키, 오디오 본문, 자막 본문을 로그에 기록하지 않음
- Content Script는 사용자가 action을 클릭한 탭에만 주입
- DRM이나 교차 출처 접근 제한을 우회하지 않음

## 12. 적용과 운영

설정을 변경합니다.

```dotenv
AUDIO_CHUNK_SECONDS=300
AUDIO_CHUNK_OVERLAP_SECONDS=5
```

서버를 재시작합니다.

```powershell
.\setup-and-run-server.cmd
```

확장 프로그램 코드를 변경한 경우 `chrome://extensions`에서 확장을 새로고침합니다. `.env`의 청크 설정만 변경한 경우에는 서버만 재시작하고 새 캡처를 시작하면 됩니다.

캡처 시작 시에는 사이드패널에 로컬 액세스 토큰과 Gemini API 키를 각각 입력합니다. 캡처가 시작되면 Gemini API 키 입력란은 즉시 비워지며, 캡처 종료 후 같은 키를 자동 복원하지 않습니다.

## 13. 테스트 기준

- 기본 `/health`가 10초·1초 설정을 반환
- Gemini API 키가 없는 세션 생성은 422
- 세션 생성 후 사이드패널 API 키 입력란과 확장 임시 변수가 비워짐
- API 키가 세션 스냅샷·로그·오류 응답에 포함되지 않음
- 서로 다른 두 세션이 각자 전달한 Gemini 키로 독립 클라이언트를 사용
- 세션 DELETE와 서버 종료 시 Gemini 클라이언트 참조가 제거됨
- 환경 변수 범위와 겹침 관계 검증
- 확장이 `/health` 설정으로 Recorder 시간을 계산
- 429가 HTTP 429로 전달되고 재시도되지 않음
- 429에서 `PAUSED_QUOTA` 상태와 안내 표시
- 400이 HTTP 422로 전달되고 재시도되지 않음
- JSON fence 및 주변 텍스트가 포함된 전사 응답 파싱
- 실제 Gemini WAV 전사 요청 성공
- JavaScript 구문 검사와 공통 로직 테스트 통과

## 14. 향후 작업

- 중간 요약 주기를 `.env` 설정으로 분리
- 예상 강의 길이를 입력받아 청크 시간을 자동 계산하는 프로필
- 긴 청크의 네트워크 timeout을 실측 기반으로 동적 조정
- Gemini 3.5 Transcribe 또는 전용 Speech-to-Text 비교 평가
- 청크 실패 시 원본 오디오 저장 없이 선택적 재시도 정책 개선
- 무료·유료 요금제별 프리셋 제공
