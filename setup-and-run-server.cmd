@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"
title Lecture Memo Server Setup

set "VENV_PYTHON=%CD%\.venv\Scripts\python.exe"
set "REQUIREMENTS=%CD%\server\requirements.txt"
set "ENV_FILE=%CD%\server\.env"
set "ENV_EXAMPLE=%CD%\server\.env.example"
set "PYTHON_PACKAGE_ID=Python.Python.3.11"
set "INSTALL_ONLY=0"

if /I "%~1"=="--install-only" set "INSTALL_ONLY=1"
if /I "%~1"=="--check" goto :check_only

echo.
echo ============================================================
echo   Lecture Memo - Local Server Setup and Run
echo ============================================================
echo.

if exist "%VENV_PYTHON%" (
    echo [OK] Using Python from the existing virtual environment.
    "%VENV_PYTHON%" --version
) else (
    call :find_python
    if errorlevel 1 (
        call :install_python
        if errorlevel 1 goto :failed

        call :find_python
        if errorlevel 1 (
            echo [ERROR] Python was installed, but this window could not find it yet.
            echo Close this window and run the command again so Windows can refresh PATH.
            goto :failed
        )
    )
)

if not exist "%VENV_PYTHON%" (
    echo [1/4] Creating the Python virtual environment...
    %PYTHON_CMD% -m venv "%CD%\.venv"
    if errorlevel 1 (
        echo [ERROR] Failed to create the virtual environment.
        goto :failed
    )
) else (
    echo [1/4] Using the existing Python virtual environment.
)

echo [2/4] Installing or updating server dependencies...
"%VENV_PYTHON%" -m pip install --disable-pip-version-check -r "%REQUIREMENTS%"
if errorlevel 1 (
    echo [ERROR] Failed to install Python packages.
    echo Check the internet connection and proxy settings.
    goto :failed
)

if not exist "%ENV_FILE%" (
    echo [3/4] Creating the server configuration...
    copy /Y "%ENV_EXAMPLE%" "%ENV_FILE%" >nul
    if errorlevel 1 (
        echo [ERROR] Failed to create server\.env.
        goto :failed
    )

    "%VENV_PYTHON%" -c "from pathlib import Path; import secrets; p=Path(r'%ENV_FILE%'); s=p.read_text(encoding='utf-8'); s=s.replace('LOCAL_ACCESS_TOKEN=', 'LOCAL_ACCESS_TOKEN='+secrets.token_urlsafe(24), 1); s=s.replace('MOCK_GEMINI=false', 'MOCK_GEMINI=true', 1); p.write_text(s, encoding='utf-8')"
    if errorlevel 1 (
        echo [ERROR] Failed to write the initial server configuration.
        goto :failed
    )

    echo       First-time setup uses MOCK_GEMINI=true.
    echo       For real Gemini calls, change MOCK_GEMINI to false.
    echo       Enter the Gemini API key in the extension side panel.
) else (
    echo [3/4] Keeping the existing server\.env configuration.
)

if "%INSTALL_ONLY%"=="1" (
    echo [4/4] Installation complete. Server startup was skipped.
    echo.
    echo Run later with: .\setup-and-run-server.cmd
    goto :success
)

echo [4/4] Starting the server...
echo.
echo Server URL : http://127.0.0.1:8050
echo Stop server: Press Ctrl+C in this window
echo Config file: %ENV_FILE%
echo.

"%VENV_PYTHON%" -m server.app
set "SERVER_EXIT=%ERRORLEVEL%"
if not "%SERVER_EXIT%"=="0" (
    echo.
    echo [ERROR] Server exited with code %SERVER_EXIT%.
    goto :failed
)
goto :success

:check_only
echo Checking the Lecture Memo server installation...
if exist "%VENV_PYTHON%" (
    "%VENV_PYTHON%" --version
    echo [OK] Virtual environment: %VENV_PYTHON%
) else (
    call :find_python
    if errorlevel 1 goto :failed
    echo [WAITING] Virtual environment has not been created yet.
)
if exist "%ENV_FILE%" (
    echo [OK] Configuration: %ENV_FILE%
) else (
    echo [WAITING] Configuration has not been created yet.
)
goto :success

:find_python
set "PYTHON_CMD="
set "PYTHON_VERSION="

where py >nul 2>nul
if not errorlevel 1 (
    py -3.11 --version >nul 2>nul
    if not errorlevel 1 set "PYTHON_CMD=py -3.11"
)

if not defined PYTHON_CMD (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3 -c "import sys; raise SystemExit(sys.version_info[0] < 3 or sys.version_info[0] == 3 and sys.version_info[1] < 11)" >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=py -3"
    )
)

if not defined PYTHON_CMD (
    where python >nul 2>nul
    if not errorlevel 1 (
        python -c "import sys; raise SystemExit(sys.version_info[0] < 3 or sys.version_info[0] == 3 and sys.version_info[1] < 11)" >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=python"
    )
)

if not defined PYTHON_CMD (
    echo [ERROR] Python 3.11 or newer was not found.
    exit /b 1
)

for /f "tokens=2" %%V in ('%PYTHON_CMD% --version 2^>^&1') do set "PYTHON_VERSION=%%V"
echo [OK] Python %PYTHON_VERSION%
exit /b 0

:install_python
echo [INFO] Python 3.11 or newer was not found. Trying to install Python 3.11 with winget...

where winget.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] winget was not found.
    echo Install or update the Microsoft Store App Installer, then run this file again.
    echo See: https://learn.microsoft.com/en-us/windows/package-manager/winget/
    exit /b 1
)

winget.exe install --id "%PYTHON_PACKAGE_ID%" -e --scope user --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo [ERROR] Python installation through winget failed.
    echo Check the network connection and Windows app installation permissions.
    exit /b 1
)

rem A newly installed user Python is not always added to this process PATH.
rem Add the default per-user Python 3.11 directories before searching again.
set "PYTHON_INSTALL_DIR=%LocalAppData%\Programs\Python\Python311"
if exist "%PYTHON_INSTALL_DIR%\python.exe" set "PATH=%PYTHON_INSTALL_DIR%;%PYTHON_INSTALL_DIR%\Scripts;%PATH%"

set "PYTHON_LAUNCHER_DIR=%LocalAppData%\Programs\Python\Launcher"
if exist "%PYTHON_LAUNCHER_DIR%\py.exe" set "PATH=%PYTHON_LAUNCHER_DIR%;%PATH%"

echo [OK] Python installation completed.
exit /b 0

:failed
echo.
echo Setup did not complete. Review the error message above.
echo.
pause
exit /b 1

:success
echo.
echo Done.
if /I not "%~1"=="--check" pause
exit /b 0
