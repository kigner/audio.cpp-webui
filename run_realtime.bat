@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

if not exist "%PY%" (
  echo [realtime] venv python not found: %PY%
  pause
  exit /b 1
)
REM ============================================================
REM  Realtime voice: VAD(silero) -> ASR -> LLM -> TTS, served on
REM  ws://127.0.0.1:8765/v1/realtime + http://127.0.0.1:8765/realtime/
REM
REM  This script starts ONLY the Python realtime backend. It needs TWO
REM  audio.cpp C++ servers already running (one TTS, one ASR) so both
REM  models can be served at the same time. Start them in separate windows:
REM
REM    run_server.bat qwen3-tts 8088        (TTS, GPU)
REM    run_server_asr.bat                   (ASR on :8081, GPU or CPU)
REM
REM  English demo swaps the TTS model: run_server.bat pocket-tts 8088
REM  (and set AUDIOCPP_TTS_MODEL below to pocket-tts).
REM
REM  All values below are DEFAULTS -- the browser Settings panel overrides
REM  them per session (saved in localStorage) and pushes them via session.update.
REM ============================================================

REM --- TTS: audio.cpp C++ server (must be running on :8088) ---
REM     voice_ref uses an ABSOLUTE path so the C++ server finds it regardless
REM     of its working directory. WEBUI_DIR points at the webui\ folder.
set AUDIOCPP_TTS_SERVER=http://127.0.0.1:8088
set AUDIOCPP_TTS_MODEL=qwen3-tts
set "AUDIOCPP_TTS_VOICE_REF=%WEBUI_DIR%\voice\demo_01_man.wav"
set AUDIOCPP_TTS_REF_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice.

REM --- ASR: audio.cpp C++ server (must be running on :8081) ---
set AUDIOCPP_ASR_SERVER=http://127.0.0.1:8081
set AUDIOCPP_ASR_MODEL=qwen3-asr
set AUDIOCPP_ASR_LANGUAGE=zh

REM --- LLM: DeepSeek Chat Completions API ---
set AUDIOCPP_LLM_BASE_URL=https://api.deepseek.com/v1
if not defined AUDIOCPP_LLM_API_KEY if exist "%WEBUI_DIR%\llm_api_key.txt" (
  for /f "usebackq delims=" %%K in ("%WEBUI_DIR%\llm_api_key.txt") do if not defined AUDIOCPP_LLM_API_KEY set "AUDIOCPP_LLM_API_KEY=%%K"
)
if not defined AUDIOCPP_LLM_API_KEY (
  echo [realtime] WARNING: AUDIOCPP_LLM_API_KEY is empty.
  echo [realtime] Set it in the environment or put the key in webui\llm_api_key.txt
)
set AUDIOCPP_LLM_MODEL=deepseek-chat

REM --- Port for the realtime WebSocket backend ---
set AUDIOCPP_REALTIME_PORT=8765

echo [realtime] backend starting on ws://127.0.0.1:8765/v1/realtime
echo [realtime] UI at           http://127.0.0.1:8765/realtime/
echo [realtime] expects TTS @ http://127.0.0.1:8088  (run_webui.bat, then load a TTS model in the WebUI)
echo [realtime] expects ASR @ http://127.0.0.1:8081  (run_server_asr.bat)
echo.

cd /d "%~dp0"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%AUDIOCPP_REALTIME_PORT%/realtime/'"
"%PY%" "%WEBUI_DIR%\realtime_server.py"
endlocal
pause
