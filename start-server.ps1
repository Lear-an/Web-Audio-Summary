$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$pythonPath = Join-Path $projectRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "프로젝트 가상환경이 없습니다. README의 서버 설치 절차를 먼저 실행해 주세요."
}

Push-Location $projectRoot
try {
    & $pythonPath -m server.app
} finally {
    Pop-Location
}
