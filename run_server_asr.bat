@echo off
setlocal
REM ============================================================
REM  Qwen3-ASR API server (speech-to-text; /v1/audio/transcriptions).
REM
REM  Usage:  run_server_asr.bat [port] [device] [model_id]
REM    e.g.  run_server_asr.bat                   (qwen3-asr on :8081)
REM          run_server_asr.bat 8082 0 qwen3-asr
REM
REM  Thin wrapper over run_server.bat with ASR defaults. Run it in a 2nd
REM  window next to a TTS server (run_server.bat qwen3-tts 8080, or the
REM  WebUI's built-in server); both models must fit in GPU memory.
REM ============================================================

set "PORT=%~1"
set "DEVICE=%~2"
set "MODEL_ID=%~3"
if "%PORT%"=="" set "PORT=8081"
if "%DEVICE%"=="" set "DEVICE=0"
if "%MODEL_ID%"=="" set "MODEL_ID=qwen3-asr"

call "%~dp0run_server.bat" %MODEL_ID% %PORT% %DEVICE%
endlocal
