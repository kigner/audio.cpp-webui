@echo off
REM Shared dispatch after either existing _env.bat has selected Python/backend.
if not defined AUDIOCPP_BACKEND (
  if /I "%BACKEND%"=="cuda" (set "AUDIOCPP_BACKEND=gpu") else (set "AUDIOCPP_BACKEND=%BACKEND%")
)
if not exist "%PY%" (
  echo [run_webui] Python with WebUI dependencies was not found.
  echo Set AUDIOCPP_PYTHON to the installed Python executable and retry.
  echo Diagnostic entry: run_webui.bat --diagnostic
  pause
  exit /b 1
)
if /I "%~1"=="--stop" goto stop
:diagnostic
REM Keep this command window and tee live output to startup.log by default.
"%PY%" "%WEBUI_DIR%\workbench_launcher.py" --diagnostic %*
set "WEBUI_EXIT=%errorlevel%"
if not "%WEBUI_EXIT%"=="0" pause
exit /b %WEBUI_EXIT%

:stop
"%PY%" "%WEBUI_DIR%\workbench_launcher.py" --diagnostic --stop
exit /b %errorlevel%
