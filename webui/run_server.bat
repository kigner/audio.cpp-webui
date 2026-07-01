@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM Locate the integrated bundle (cpu/ gpu/ models/). In the dev tree it is the
REM sibling ..\audiocpp-portable; if this script is copied into the bundle, it is
REM this folder itself.
set "BUNDLE=%~dp0..\audiocpp-portable"
if not exist "%BUNDLE%\gpu\audiocpp_server.exe" set "BUNDLE=%~dp0."

set "CONFIG=configs\server_qwen3tts.json"

echo [run_server] starting GPU server (CUDA) with %CONFIG%
echo   Health : http://127.0.0.1:8080/health
echo   Models : http://127.0.0.1:8080/v1/models
echo   Speech : POST http://127.0.0.1:8080/v1/audio/speech
echo   Ctrl+C to stop.
echo.

"%BUNDLE%\gpu\audiocpp_server.exe" --config "%CONFIG%"

endlocal
pause

REM ===== after the server is up, open another window in this folder and call: =====
REM   curl http://127.0.0.1:8080/health
REM   curl http://127.0.0.1:8080/v1/models
REM   curl -o output\out_server.wav -H "Content-Type: application/json" -d @configs\req_speech.json http://127.0.0.1:8080/v1/audio/speech
