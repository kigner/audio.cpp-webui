@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM ============================================================
REM  API server mode (OpenAI-compatible HTTP, GPU/CUDA only).
REM
REM  Usage:  run_server.bat <model_id> [port] [device]
REM    e.g.  run_server.bat qwen3-tts 8080        (TTS server on :8080)
REM          run_server.bat qwen3-asr 8081        (ASR server on :8081, 2nd window)
REM
REM  <model_id> is an entry in configs\models_catalog.json.
REM  Run it TWICE in two windows with different ids + ports to serve two models
REM  at once (e.g. one TTS + one ASR). Both models must fit in GPU memory.
REM  Set AUDIOCPP_HOST=0.0.0.0 to expose on the LAN (no auth — trusted nets only).
REM ============================================================

set "MODEL_ID=%~1"
set "PORT=%~2"
set "DEVICE=%~3"
if "%MODEL_ID%"=="" goto :usage
if "%PORT%"=="" set "PORT=8080"
if "%DEVICE%"=="" set "DEVICE=0"
set "HOST=%AUDIOCPP_HOST%"
if not defined HOST set "HOST=127.0.0.1"

if not defined HAS_CUDA ( echo [ERROR] server is GPU-only and no CUDA driver was detected. & goto :end )
if not exist "%SERVER_EXE%" ( echo [ERROR] gpu server not found: %SERVER_EXE% & goto :end )

REM --- resolve family/task + absolute model path from the catalog id ---
set "STATUS="
for /f "usebackq tokens=1-4 delims=|" %%A in (`powershell -NoProfile -Command "$c=Get-Content -Raw 'configs\models_catalog.json' | ConvertFrom-Json; $m=$c.models | Where-Object { $_.id -eq '%MODEL_ID%' } | Select-Object -First 1; if (-not $m) { 'ERR|unknown id|.|.'; exit }; $p = Join-Path (Resolve-Path '%BUNDLE%').Path $m.path; if (-not (Test-Path $p)) { 'ERR|not installed|.|.'; exit }; 'OK|' + $m.family + '|' + $m.task + '|' + $p"`) do (
  set "STATUS=%%A" & set "FAMILY=%%B" & set "TASK=%%C" & set "MODEL=%%D"
)
if /I not "%STATUS%"=="OK" ( echo [ERROR] bad model id "%MODEL_ID%": %FAMILY% - see configs\models_catalog.json & goto :end )

REM --- write a single-model temp config with an ABSOLUTE path, named per-port so
REM     two instances never clash. UTF-8, no BOM. Avoids the config-dir-relative
REM     path resolution in app/server/config.cpp. ---
set "RUNCONFIG=%TEMP%\audiocpp_server_%PORT%.json"
powershell -NoProfile -Command "$m=[ordered]@{id='%MODEL_ID%';family='%FAMILY%';path='%MODEL%';task='%TASK%';mode='offline'}; $c=[ordered]@{host='%HOST%';port=[int]'%PORT%';device=[int]'%DEVICE%';threads=1;models=@($m)}; [IO.File]::WriteAllText('%RUNCONFIG%', ($c | ConvertTo-Json -Depth 20))"
if not exist "%RUNCONFIG%" ( echo [ERROR] failed to write runtime config %RUNCONFIG% & goto :end )

echo [run_server] %MODEL_ID% (%FAMILY%, %TASK%)  GPU device %DEVICE%
echo   URL    : http://%HOST%:%PORT%
echo   Health : http://%HOST%:%PORT%/health
echo   Models : http://%HOST%:%PORT%/v1/models
echo   config : %RUNCONFIG%
echo   Ctrl+C to stop.  (VRAM: two servers must both fit in your GPU memory)
echo.

"%SERVER_EXE%" --config "%RUNCONFIG%" --host %HOST% --port %PORT% --device %DEVICE%
goto :end

:usage
echo Usage: %~nx0 ^<model_id^> [port] [device]
echo   e.g. %~nx0 qwen3-tts 8080        (TTS server on :8080)
echo        %~nx0 qwen3-asr 8081        (ASR server on :8081, run in a 2nd window)
echo Model ids are the entries in configs\models_catalog.json.
echo.
echo This server takes the reference voice PER REQUEST (not baked into the server).
echo TTS example (uses the ready template configs\req_speech.json):
echo   curl http://127.0.0.1:8080/v1/audio/speech -H "Content-Type: application/json" -o output\out_server.wav -d @configs\req_speech.json
echo ASR example:
echo   curl http://127.0.0.1:8081/v1/audio/transcriptions -H "Content-Type: application/json" -d "{\"model\":\"qwen3-asr\",\"audio\":\"D:/path/to/input.wav\"}"

:end
endlocal
pause
