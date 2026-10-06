@echo off
setlocal
cd /d "%~dp0"

set "BASE_PY="
py -3.12 --version >nul 2>&1
if not errorlevel 1 set "BASE_PY=py -3.12"

if not defined BASE_PY (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" >nul 2>&1
    if not errorlevel 1 set "BASE_PY=python"
)

if not defined BASE_PY (
    echo DrugForge needs 64-bit Python 3.11 or 3.12.
    echo Install Python from https://www.python.org/downloads/ and enable the PATH option.
    pause
    exit /b 1
)

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" --version >nul 2>&1
    if errorlevel 1 (
        echo The existing .venv points to a Python installation that is no longer available.
        echo Remove only the .venv folder beside this launcher, then run it again.
        pause
        exit /b 1
    )
) else (
    echo Creating a project-local Python environment...
    call %BASE_PY% -m venv .venv
    if errorlevel 1 goto :failed
)

echo Installing or updating DrugForge requirements...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :failed

echo Starting DrugForge at http://127.0.0.1:5000
".venv\Scripts\python.exe" app.py
goto :end

:failed
echo.
echo Setup did not finish. Check your internet connection and Python installation, then try again.
pause

:end
endlocal
