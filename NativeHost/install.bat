@echo off
setlocal

:: ── Elevate to Administrator if not already ───────────────────────────────────
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"
    exit /b
)

echo ============================================================
echo TabGroup Master -- Install (Administrator)
echo ============================================================
echo.

:: ── 1. Python dependencies ────────────────────────────────────────────────────
echo [1/4] Checking Python dependencies...
python -c "import cramjam" >nul 2>&1
if errorlevel 1 (
    echo      Installing cramjam...
    python -m pip install cramjam --quiet
)
echo      OK.

:: ── 2. Native host + CRX packing ─────────────────────────────────────────────
echo [2/4] Running setup (native host + CRX pack)...
python "%~dp0setup.py"
if errorlevel 1 (
    echo      FAILED. Make sure Python is installed.
    pause
    exit /b 1
)

:: ── 3. Apply Chrome policy (force-install) ────────────────────────────────────
echo [3/4] Applying Chrome force-install policy...
regedit /s "%~dp0chrome_policy.reg"
if errorlevel 1 (
    echo      Policy apply failed. Try double-clicking chrome_policy.reg manually.
) else (
    echo      OK - extension will auto-install on next Chrome start.
)

:: ── 4. Scheduled task (auto re-register on Windows login) ────────────────────
echo [4/4] Creating scheduled task...
set TASK=TabGroupMaster_NativeHost
set PYTHON=python
set SCRIPT=%~dp0setup.py
schtasks /create /f /tn "%TASK%" /tr "\"%PYTHON%\" \"%SCRIPT%\"" /sc ONLOGON /rl HIGHEST /ru "%USERNAME%" >nul 2>&1
if errorlevel 1 (
    echo      Scheduled task skipped (optional).
) else (
    echo      OK.
)

echo.
echo ============================================================
echo Setup complete!
echo.
echo NEXT STEPS:
echo   1. Close Chrome (all windows).
echo   2. Reopen Chrome -- extension installs automatically.
echo   3. If you see 2 TabGroup Master entries, remove the old one.
echo ============================================================
echo.
pause
