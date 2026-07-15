@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM ============================================================
REM  SpeakType -- local voice dictation demo over the audio.cpp streaming ASR API.
REM
REM  PREREQUISITE: start the streaming ASR server FIRST, in a separate window:
REM      run_server_asr_stream.bat                (nemotron-asr on :8081)
REM
REM  SpeakType captures the microphone, runs silero VAD on the client, POSTs each
REM  speech segment to :8081  /v1/audio/transcriptions  (stream=true), and pastes
REM  the final text into the foreground window. A floating bar shows partial/final.
REM
REM  Hotkeys:  Ctrl+Alt+Space = start/stop,   Esc = cancel current.
REM  Config:   SpeakType\config.json  (asr on 127.0.0.1:8081, model nemotron-asr).
REM  No C++ server yet? demo the UI only:   run_speaktype.bat --mock
REM ============================================================

set "SPEAKTYPE_DIR=%ROOT%\SpeakType"

if not exist "%PY%" (
  echo [speaktype] venv python not found: %PY%
  pause
  exit /b 1
)
if not exist "%SPEAKTYPE_DIR%\run.py" (
  echo [speaktype] SpeakType not found at %SPEAKTYPE_DIR%
  echo [speaktype] sync it from the repo first ^(scripts\sync_speaktype.ps1^).
  pause
  exit /b 1
)

echo [speaktype] python   : %PY%
echo [speaktype] app dir  : %SPEAKTYPE_DIR%
echo [speaktype] expects ASR @ http://127.0.0.1:8081  (run_server_asr_stream.bat)
echo.

pushd "%SPEAKTYPE_DIR%"
"%PY%" "%SPEAKTYPE_DIR%\run.py" %*
popd
endlocal
pause
