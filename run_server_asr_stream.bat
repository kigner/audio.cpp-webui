@echo off
setlocal
REM ============================================================
REM  Streaming ASR API server (/v1/audio/transcriptions + stream=true).
REM
REM  Usage:  run_server_asr_stream.bat [port] [device] [model_id]
REM    e.g.  run_server_asr_stream.bat                      (nemotron-asr on :8081)
REM          run_server_asr_stream.bat 8082 0 higgs-audio-stt
REM
REM  Same as run_server_asr.bat but the model is loaded with mode=streaming:
REM  pass "stream": true in the request to get transcript.text.delta SSE
REM  events while the audio is being decoded, then transcript.text.done.
REM  Streaming-capable ASR ids: nemotron-asr / higgs-audio-stt / vibevoice-asr.
REM
REM  NOTE: input is still ONE complete audio per request (server-local path in
REM  JSON, or multipart file upload) — the stream is the incremental TEXT
REM  output. For a realtime mic app, run VAD on the client, cut segments at
REM  silence, and POST each segment; webui\realtime_server.py shows the pattern
REM  (silero VAD -> per-segment POST to the ASR server on :8081).
REM
REM    curl -N http://127.0.0.1:8081/v1/audio/transcriptions ^
REM      -H "Content-Type: application/json" ^
REM      -d "{\"model\":\"nemotron-asr\",\"audio\":\"D:/path/in.wav\",\"stream\":true}"
REM ============================================================

set "PORT=%~1"
set "DEVICE=%~2"
set "MODEL_ID=%~3"
if "%PORT%"=="" set "PORT=8081"
if "%DEVICE%"=="" set "DEVICE=0"
if "%MODEL_ID%"=="" set "MODEL_ID=nemotron-asr"

set "AUDIOCPP_MODE=streaming"
call "%~dp0run_server.bat" %MODEL_ID% %PORT% %DEVICE%
endlocal
