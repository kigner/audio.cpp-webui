@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM ============================================================
REM  Qwen3-TTS optimized API server for realtime voice demos.
REM
REM  Usage:  run_server_qwen3tts.bat [port] [device] [model_id]
REM    e.g.  run_server_qwen3tts.bat
REM          run_server_qwen3tts.bat 8080 0 qwen3-tts
REM
REM  Defaults:
REM    model_id = qwen3-tts
REM    port     = 8080
REM    device   = 0
REM
REM  Realtime-friendly defaults:
REM    - qwen3_tts.mem_saver=false, so cached graphs stay reusable.
REM    - fixed reference voice warmup after server starts.
REM    - server stays foreground; Ctrl+C stops it.
REM
REM  Optional env:
REM    AUDIOCPP_QWEN3TTS_WEIGHT_TYPE=q8_0|f16|bf16|f32|native
REM      Leave empty by default. Quantized weights can reduce VRAM, but may not
REM      always be faster on every GPU.
REM    AUDIOCPP_QWEN3TTS_WARMUP=0
REM      Disable automatic warmup request.
REM ============================================================

set "PORT=%~1"
set "DEVICE=%~2"
set "MODEL_ID=%~3"
if "%PORT%"=="" set "PORT=8080"
if "%DEVICE%"=="" set "DEVICE=0"
if "%MODEL_ID%"=="" set "MODEL_ID=qwen3-tts"
set "HOST=%AUDIOCPP_HOST%"
if not defined HOST set "HOST=127.0.0.1"
set "WARMUP=%AUDIOCPP_QWEN3TTS_WARMUP%"
if not defined WARMUP set "WARMUP=1"
set "WEIGHT_TYPE=%AUDIOCPP_QWEN3TTS_WEIGHT_TYPE%"

if not exist "%SERVER_EXE%" ( echo [ERROR] server exe not found: %SERVER_EXE% & goto :end )
if /I "%BACKEND%"=="cpu" echo [qwen3tts] no CUDA detected - CPU backend will be slow for Qwen3-TTS

REM cpu backend: threads = ggml compute threads, keep one core for the system
set "SRV_THREADS=1"
if /I "%BACKEND%"=="cpu" set /a "SRV_THREADS=%NUMBER_OF_PROCESSORS%-1"
if %SRV_THREADS% LSS 1 set "SRV_THREADS=1"

REM --- resolve family/task + absolute model path from the catalog id ---
set "STATUS="
for /f "usebackq tokens=1-4 delims=|" %%A in (`powershell -NoProfile -Command "$c=Get-Content -Raw -Encoding utf8 '%WEBUI_DIR%\configs\models_catalog.json' | ConvertFrom-Json; $m=$c.models | Where-Object { $_.id -eq '%MODEL_ID%' } | Select-Object -First 1; if (-not $m) { 'ERR|unknown id|.|.'; exit }; if ($m.family -ne 'qwen3_tts' -or $m.task -ne 'tts') { 'ERR|not qwen3_tts tts|.|.'; exit }; $p = Join-Path (Resolve-Path '%BUNDLE%').Path $m.path; if (-not (Test-Path $p)) { 'ERR|not installed|.|.'; exit }; 'OK|' + $m.family + '|' + $m.task + '|' + $p"`) do (
  set "STATUS=%%A" & set "FAMILY=%%B" & set "TASK=%%C" & set "MODEL=%%D"
)
if /I not "%STATUS%"=="OK" ( echo [ERROR] bad Qwen3-TTS model id "%MODEL_ID%": %FAMILY% - see %WEBUI_DIR%\configs\models_catalog.json & goto :end )

REM --- write a single-model runtime config. Explicit mem_saver=false matters for
REM     realtime short-turn reuse: do not release cached step graphs per request. ---
set "RUNCONFIG=%TEMP%\audiocpp_server_qwen3tts_%PORT%.json"
powershell -NoProfile -Command "$opts=[ordered]@{'qwen3_tts.mem_saver'='false'}; if ('%WEIGHT_TYPE%'.Trim().Length -gt 0) { $opts['qwen3_tts.weight_type']='%WEIGHT_TYPE%' }; $m=[ordered]@{id='%MODEL_ID%';family='%FAMILY%';path='%MODEL%';task='%TASK%';mode='offline';session_options=$opts}; $c=[ordered]@{host='%HOST%';port=[int]'%PORT%';backend='%BACKEND%';device=[int]'%DEVICE%';threads=[int]'%SRV_THREADS%';models=@($m)}; [IO.File]::WriteAllText('%RUNCONFIG%', ($c | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))"
if not exist "%RUNCONFIG%" ( echo [ERROR] failed to write runtime config %RUNCONFIG% & goto :end )

if not "%WARMUP%"=="0" (
  set "WARMUP_VOICE=%WEBUI_DIR%\voice\demo_01_man.wav"
  set "WARMUP_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice."
  start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 8; $body=@{model='%MODEL_ID%';input='Hi.';voice_ref='%WARMUP_VOICE:\=/%';reference_text='%WARMUP_TEXT%';max_tokens=80;response_format='json'} | ConvertTo-Json -Depth 5; try { Invoke-RestMethod -Uri 'http://%HOST%:%PORT%/v1/audio/speech' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 300 | Out-Null; Write-Host '[qwen3tts] warmup done' } catch { Write-Host ('[qwen3tts] warmup skipped: ' + $_.Exception.Message) }"
)

echo [qwen3tts] %MODEL_ID% (%FAMILY%, %TASK%)  backend %BACKEND%  device %DEVICE%
echo   URL      : http://%HOST%:%PORT%
echo   Health   : http://%HOST%:%PORT%/health
echo   Models   : http://%HOST%:%PORT%/v1/models
echo   config   : %RUNCONFIG%
echo   mem_saver: false
if defined WEIGHT_TYPE echo   weight  : %WEIGHT_TYPE%
if not "%WARMUP%"=="0" echo   warmup  : enabled ^(short request after startup^)
echo   Ctrl+C to stop.
echo.

"%SERVER_EXE%" --config "%RUNCONFIG%" --host %HOST% --port %PORT% --device %DEVICE%
goto :end

:end
endlocal
pause
