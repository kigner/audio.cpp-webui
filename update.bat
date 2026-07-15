@echo off
setlocal

set "ROOT=%~dp0"
set "UPDATER=%ROOT%updater\updater.ps1"

if not exist "%UPDATER%" (
  echo [audio.cpp updater] Missing: "%UPDATER%"
  exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%UPDATER%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%~1"=="" (
  echo.
  pause
)

exit /b %EXIT_CODE%
