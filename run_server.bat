@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM ============================================================
REM  API server mode (OpenAI-compatible HTTP; backend auto-detected:
REM  CUDA when an NVIDIA driver + gpu build exist, else CPU).
REM
REM  Usage:  run_server.bat <model_id> [port] [device] [voice_ref.wav]
REM    e.g.  run_server.bat qwen3-tts 8088        (TTS server on :8088)
REM          run_server.bat qwen3-asr 8081        (ASR server on :8081, 2nd window)
REM          run_server.bat qwen3-tts 8088 D:\voices\me.wav
REM                (bakes a default reference voice into the server, for clients
REM                 that have no field to send reference audio per request;
REM                 the wav goes in the 3rd or 4th slot - device defaults to 0)
REM
REM  Voice ref can also come from env vars (no need to pass port/device then):
REM    set AUDIOCPP_VOICE_REF=D:\voices\me.wav   (reference audio, wav)
REM    set AUDIOCPP_REF_TEXT=参考音频的文字内容    (transcript; qwen3-tts REQUIRES it)
REM  If AUDIOCPP_REF_TEXT is not set, the transcript is looked up by wav basename
REM  in %WEBUI_DIR%\voice\prompt_text (lines of "basename|transcript").
REM  The ref is registered as preset "default" AND aliased to the standard OpenAI
REM  voice names (alloy/echo/fable/onyx/nova/shimmer/...), so OpenAI-compatible
REM  clients that always send "voice":"alloy" still hit the baked-in voice.
REM  Per-request "voice_ref" in the JSON body still overrides it.
REM
REM  <model_id> is an entry in %WEBUI_DIR%\configs\models_catalog.json.
REM  Run it TWICE in two windows with different ids + ports to serve two models
REM  at once (e.g. one TTS + one ASR). Both models must fit in GPU memory.
REM  Set AUDIOCPP_HOST=0.0.0.0 to expose on the LAN (no auth — trusted nets only).
REM  Set AUDIOCPP_MODE=streaming to load the model in streaming mode (SSE
REM  endpoints; see run_server_asr_stream.bat). Default: offline.
REM ============================================================

set "MODEL_ID=%~1"
set "PORT=%~2"
set "DEVICE=%~3"
REM 3rd arg: device index if purely numeric, otherwise treat it as the voice ref wav
if not "%~3"=="" echo %~3| findstr /r /c:"^[0-9][0-9]*$" >nul || (
  set "AUDIOCPP_VOICE_REF=%~3"
  set "DEVICE="
)
if not "%~4"=="" set "AUDIOCPP_VOICE_REF=%~4"
if "%MODEL_ID%"=="" goto :usage
if "%PORT%"=="" set "PORT=8088"
if "%DEVICE%"=="" set "DEVICE=0"
if defined AUDIOCPP_VOICE_REF if not exist "%AUDIOCPP_VOICE_REF%" (
  echo [ERROR] voice ref audio not found: %AUDIOCPP_VOICE_REF%
  goto :end
)
set "HOST=%AUDIOCPP_HOST%"
if not defined HOST set "HOST=127.0.0.1"
if not defined AUDIOCPP_MODE set "AUDIOCPP_MODE=offline"
if /I not "%AUDIOCPP_MODE%"=="offline" if /I not "%AUDIOCPP_MODE%"=="streaming" (
  echo [ERROR] AUDIOCPP_MODE must be "offline" or "streaming", got: %AUDIOCPP_MODE%
  goto :end
)

if not exist "%SERVER_EXE%" ( echo [ERROR] server exe not found: %SERVER_EXE% & goto :end )
if /I "%BACKEND%"=="cpu" echo [run_server] no CUDA detected - CPU backend (slower; model coverage may be lower)

REM cpu backend: threads = ggml compute threads, keep one core for the system
set "SRV_THREADS=1"
if /I "%BACKEND%"=="cpu" set /a "SRV_THREADS=%NUMBER_OF_PROCESSORS%-1"
if %SRV_THREADS% LSS 1 set "SRV_THREADS=1"

REM --- resolve family/task + absolute model path from the catalog id ---
set "STATUS="
for /f "usebackq tokens=1-4 delims=|" %%A in (`powershell -NoProfile -Command "$c=Get-Content -Raw -Encoding utf8 '%WEBUI_DIR%\configs\models_catalog.json' | ConvertFrom-Json; $m=$c.models | Where-Object { $_.id -eq '%MODEL_ID%' } | Select-Object -First 1; if (-not $m) { 'ERR|unknown id|.|.'; exit }; $p = Join-Path (Resolve-Path '%BUNDLE%').Path $m.path; if (-not (Test-Path $p)) { 'ERR|not installed|.|.'; exit }; 'OK|' + $m.family + '|' + $m.task + '|' + $p"`) do (
  set "STATUS=%%A" & set "FAMILY=%%B" & set "TASK=%%C" & set "MODEL=%%D"
)
if /I not "%STATUS%"=="OK" ( echo [ERROR] bad model id "%MODEL_ID%": %FAMILY% - see %WEBUI_DIR%\configs\models_catalog.json & goto :end )

REM --- write a single-model temp config with an ABSOLUTE path, named per-port so
REM     two instances never clash. UTF-8, no BOM. Avoids the config-dir-relative
REM     path resolution in app/server/config.cpp. ---
set "RUNCONFIG=%TEMP%\audiocpp_server_%PORT%.json"
powershell -NoProfile -Command "$m=[ordered]@{id='%MODEL_ID%';family='%FAMILY%';path='%MODEL%';task='%TASK%';mode='%AUDIOCPP_MODE%'}; $vr=$env:AUDIOCPP_VOICE_REF; if ($vr -and '%TASK%' -eq 'tts') { $p=[ordered]@{voice_ref=$vr}; if ($env:AUDIOCPP_REF_TEXT) { $p.reference_text=$env:AUDIOCPP_REF_TEXT } else { $pt=Join-Path $env:WEBUI_DIR 'voice\prompt_text'; if (Test-Path $pt) { $bn=[IO.Path]::GetFileNameWithoutExtension($vr); $ln=Get-Content $pt -Encoding utf8 | Where-Object { $_.Split('|')[0] -eq $bn } | Select-Object -First 1; if ($ln) { $p.reference_text=$ln.Substring($ln.IndexOf('|')+1) } } }; $vp=[ordered]@{}; foreach($n in @('default','alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse')) { $vp[$n]=$p }; $m.voice_presets=$vp; $m.default_voice_preset='default' }; $c=[ordered]@{host='%HOST%';port=[int]'%PORT%';backend='%BACKEND%';device=[int]'%DEVICE%';threads=[int]'%SRV_THREADS%';models=@($m)}; [IO.File]::WriteAllText('%RUNCONFIG%', ($c | ConvertTo-Json -Depth 20))"
if not exist "%RUNCONFIG%" ( echo [ERROR] failed to write runtime config %RUNCONFIG% & goto :end )

echo [run_server] %MODEL_ID% (%FAMILY%, %TASK%, mode %AUDIOCPP_MODE%)  backend %BACKEND%  device %DEVICE%
if defined AUDIOCPP_VOICE_REF if /I "%TASK%"=="tts" (
  echo   voice  : baked-in default ref %AUDIOCPP_VOICE_REF%  ^(preset "default" + OpenAI voice-name aliases^)
  if defined AUDIOCPP_REF_TEXT ( echo   reftext: %AUDIOCPP_REF_TEXT% ) else ( echo   reftext: auto-lookup by basename in %WEBUI_DIR%\voice\prompt_text )
)
echo   URL    : http://%HOST%:%PORT%
echo   Health : http://%HOST%:%PORT%/health
echo   Models : http://%HOST%:%PORT%/v1/models
echo   config : %RUNCONFIG%
echo   Ctrl+C to stop.  (VRAM: two servers must both fit in your GPU memory)
echo.

"%SERVER_EXE%" --config "%RUNCONFIG%" --host %HOST% --port %PORT% --device %DEVICE%
goto :end

:usage
echo Usage: %~nx0 ^<model_id^> [port] [device] [voice_ref.wav]
echo   e.g. %~nx0 qwen3-tts 8088        (TTS server on :8088)
echo        %~nx0 qwen3-asr 8081        (ASR server on :8081, run in a 2nd window)
echo        %~nx0 qwen3-tts 8088 D:\voices\me.wav   (bake a default reference voice)
echo Model ids are the entries in %WEBUI_DIR%\configs\models_catalog.json.
echo.
echo Reference voice: per-request "voice_ref" in the JSON body always works. For
echo clients that cannot send reference audio, pass a wav as the 4th argument (or
echo set AUDIOCPP_VOICE_REF, optionally AUDIOCPP_REF_TEXT) to bake it into the
echo server as the default voice; OpenAI voice names (alloy etc.) map to it too.
echo Without AUDIOCPP_REF_TEXT the transcript is looked up by wav basename in
echo %WEBUI_DIR%\voice\prompt_text (qwen3-tts needs a matching transcript).
echo TTS example (uses the ready template %WEBUI_DIR%\configs\req_speech.json):
echo   curl http://127.0.0.1:8088/v1/audio/speech -H "Content-Type: application/json" -o %WEBUI_DIR%\output\out_server.wav -d @%WEBUI_DIR%\configs\req_speech.json
echo ASR example:
echo   curl http://127.0.0.1:8081/v1/audio/transcriptions -H "Content-Type: application/json" -d "{\"model\":\"qwen3-asr\",\"audio\":\"D:/path/to/input.wav\"}"

:end
endlocal
pause
