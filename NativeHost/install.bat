@echo off
setlocal
title TabGroup Master - Native Host Setup

echo ============================================================
echo TabGroup Master -- Native Host Setup (Windows)
echo ============================================================
echo.
echo This is OPTIONAL. The extension already works without it.
echo It only enables importing your CLOSED / saved tab groups.
echo No administrator rights are required.
echo.

:: Find Python
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python was not found on your PATH.
    echo         Install Python 3 from https://python.org and re-run this file.
    echo.
    pause
    exit /b 1
)

:: Dependency for reading Chrome's compressed database
python -c "import cramjam" >nul 2>&1
if errorlevel 1 (
    echo [1/2] Installing dependency 'cramjam'...
    python -m pip install --user --quiet cramjam
)

echo [2/2] Registering native host...
python "%~dp0setup.py"

echo.
echo Close this window, restart your browser, and reload the extension.
pause
