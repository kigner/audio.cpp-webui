@echo off
cd /d "%~dp0"

set VENV_PYTHON=%~dp0..\audiocpp-portable\venv\python.exe
if not exist "%VENV_PYTHON%" set VENV_PYTHON=%~dp0..\venv\python.exe
if not exist "%VENV_PYTHON%" set VENV_PYTHON=%~dp0..\venv\Scripts\python.exe
if not exist "%VENV_PYTHON%" (
  echo venv python not found
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
REM    run_server.bat qwen3-tts 8080        (TTS, GPU)
REM    run_server.bat qwen3-asr 8081        (ASR, GPU or CPU)
REM
REM  English demo swaps the TTS model: run_server.bat pocket-tts 8080
REM  (and set AUDIOCPP_TTS_MODEL below to pocket-tts).
REM
REM  All values below are DEFAULTS -- the browser Settings panel overrides
REM  them per session (saved in localStorage) and pushes them via session.update.
REM ============================================================

REM --- TTS: audio.cpp C++ server (must be running on :8080) ---
REM     voice_ref uses an ABSOLUTE path so the C++ server finds it regardless
REM     of its working directory. %~dp0 = this bat's dir (webui\).
set AUDIOCPP_TTS_SERVER=http://127.0.0.1:8080
set AUDIOCPP_TTS_MODEL=qwen3-tts
set AUDIOCPP_TTS_VOICE_REF=%~dp0voice/demo_01_man.wav
set AUDIOCPP_TTS_REF_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice.

REM --- ASR: audio.cpp C++ server (must be running on :8081) ---
set AUDIOCPP_ASR_SERVER=http://127.0.0.1:8081
set AUDIOCPP_ASR_MODEL=qwen3-asr
set AUDIOCPP_ASR_LANGUAGE=zh

REM --- LLM: DeepSeek Chat Completions API ---
set AUDIOCPP_LLM_BASE_URL=https://api.deepseek.com/v1
set AUDIOCPP_LLM_API_KEY=sk-2920141d1b4643979055ebe2cc14809b
set AUDIOCPP_LLM_MODEL=deepseek-chat

REM --- Port for the realtime WebSocket backend ---
set AUDIOCPP_REALTIME_PORT=8765

echo [realtime] backend starting on ws://127.0.0.1:8765/v1/realtime
echo [realtime] UI at           http://127.0.0.1:8765/realtime/
echo [realtime] expects TTS @ http://127.0.0.1:8080  (run_server.bat qwen3-tts 8080)
echo [realtime] expects ASR @ http://127.0.0.1:8081  (run_server.bat qwen3-asr 8081)
echo.

cd /d "%~dp0"
"%VENV_PYTHON%" realtime_server.py
pause
