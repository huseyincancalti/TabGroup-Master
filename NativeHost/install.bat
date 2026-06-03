@echo off
python "%~dp0setup.py"
if errorlevel 1 (
    echo.
    echo Installation failed. Make sure Python is installed.
    pause
    exit /b 1
)
echo.
echo Checking dependencies...
python -c "import cramjam" 2>nul
if errorlevel 1 (
    echo Installing cramjam...
    python -m pip install cramjam
)
echo.
echo Done. Restart Chrome if it was open.
pause
