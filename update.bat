@echo off
setlocal

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0updater\updater.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%~1"=="" (
  echo.
  pause
)

exit /b %EXIT_CODE%
