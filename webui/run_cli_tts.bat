@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM ============================================================
REM  Single-shot TTS from the command line.
REM  Usage: run_cli_tts.bat [model_id] ["text"] [voice_ref] [ref_text]
REM    e.g. run_cli_tts.bat qwen3-tts "Hello there"
REM         run_cli_tts.bat qwen3-tts "Hi" voice\demo_02_woman.wav "her ref line"
REM  model_id is an entry in configs\models_catalog.json.
REM  Backend auto-picks CUDA, falls back to CPU (set AUDIOCPP_BACKEND=cpu to force).
REM ============================================================

REM ==== params (positional overrides; defaults below) ====
set "MODEL_ID=qwen3-tts"
set "TEXT=Hello, this is a local test of audio dot cpp."
set "VOICE_REF=voice\demo_01_man.wav"
set "REF_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice."
set "LANGUAGE=english"
set "OUT=output\out_cli.wav"
if not "%~1"=="" set "MODEL_ID=%~1"
if not "%~2"=="" set "TEXT=%~2"
if not "%~3"=="" set "VOICE_REF=%~3"
if not "%~4"=="" set "REF_TEXT=%~4"
REM =======================================================

if not exist "%CLI_EXE%" ( echo [ERROR] cli exe not found: %CLI_EXE% & goto :end )

REM --- resolve family + absolute model path from the catalog id ---
set "STATUS="
for /f "usebackq tokens=1-4 delims=|" %%A in (`powershell -NoProfile -Command "$c=Get-Content -Raw 'configs\models_catalog.json' | ConvertFrom-Json; $m=$c.models | Where-Object { $_.id -eq '%MODEL_ID%' } | Select-Object -First 1; if (-not $m) { 'ERR|unknown id|.|.'; exit }; $p = Join-Path (Resolve-Path '%BUNDLE%').Path $m.path; if (-not (Test-Path $p)) { 'ERR|not installed|.|.'; exit }; 'OK|' + $m.family + '|' + $m.task + '|' + $p"`) do (
  set "STATUS=%%A" & set "FAMILY=%%B" & set "TASK=%%C" & set "MODEL=%%D"
)
if /I not "%STATUS%"=="OK" ( echo [ERROR] bad model id "%MODEL_ID%": %FAMILY% - see configs\models_catalog.json & goto :end )

set "VOICE_ARGS="
if not "%VOICE_REF%"=="" set "VOICE_ARGS=--voice-ref "%VOICE_REF%" --reference-text "%REF_TEXT%""

echo [run_cli_tts] model=%MODEL_ID% (%FAMILY%)  backend=%BACKEND%
echo [run_cli_tts] text=%TEXT%
echo.

"%CLI_EXE%" ^
  --task tts --family %FAMILY% --mode offline ^
  --model "%MODEL%" ^
  --backend %BACKEND% ^
  --language %LANGUAGE% ^
  --text "%TEXT%" ^
  %VOICE_ARGS% ^
  --max-tokens 1200 ^
  --seed 1234 ^
  --out "%OUT%"

echo.
if exist "%OUT%" ( echo Done -^> %OUT% ) else ( echo FAILED: no output )

:end
endlocal
pause
