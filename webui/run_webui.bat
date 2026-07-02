@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM Python (with gradio/requests/torch/safetensors/...) is located by _env.bat (PY).
if not exist "%PY%" (
  echo [run_webui] no Python with deps found. Looked for:
  echo   %~dp0..\audiocpp-portable\venv\python.exe   ^(dev: bundle venv^)
  echo   %~dp0..\venv\python.exe                     ^(shipped bundle venv^)
  echo   %~dp0..\venv\Scripts\python.exe             ^(dev: project venv^)
  echo Install into one of them: gradio requests torch safetensors pyyaml huggingface_hub
  pause
  exit /b 1
)
echo [run_webui] python: %PY%

echo [run_webui] the WebUI starts/switches audiocpp_server on demand
echo [run_webui]   pick a model in the UI and click "load" (no need to run run_server.bat)
echo [run_webui]   set AUDIOCPP_BACKEND=cpu to use the CPU server build
echo [run_webui] UI -^> http://127.0.0.1:7860
"%PY%" webui.py

endlocal
pause
