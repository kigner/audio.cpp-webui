@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PY=%~dp0..\venv\Scripts\python.exe"
if not exist "%PY%" (
  echo venv python not found at %PY%
  echo edit run_webui.bat and set PY to a python that has: gradio requests
  pause
  exit /b 1
)

echo [run_webui] the WebUI now starts/switches audiocpp_server on demand
echo [run_webui]   pick a model in the UI and click "load" (no need to run run_server.bat)
echo [run_webui]   set AUDIOCPP_BACKEND=cpu to use the CPU server build
echo [run_webui] UI -^> http://127.0.0.1:7860
"%PY%" webui.py

endlocal
pause
