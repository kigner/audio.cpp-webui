@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"

REM ============================================================
REM  Long-text TTS  ->  synthesize a whole .txt into ONE wav.
REM
REM  Usage:  run_tts_long.bat <model_id> <text_file.txt> [out.wav]
REM    e.g.  run_tts_long.bat qwen3-tts "sample_long.txt"
REM          run_tts_long.bat qwen3-tts "D:\books\chapter1.txt" "output\ch1.wav"
REM
REM  <model_id> is an entry in configs\models_catalog.json.
REM  <text_file.txt> may be ANY path (relative to here, or a full absolute path).
REM  Output defaults to output\<txt name>.wav.
REM  Backend auto-picks CUDA, falls back to CPU (set AUDIOCPP_BACKEND=cpu to force).
REM
REM  How long text works here:
REM    The .txt is split by LINE. Every non-empty line becomes one generation,
REM    all run on a single loaded model, then every clip is concatenated into
REM    one wav (--batch-merge-audio concat). No file-size limit; 60+ min is fine.
REM
REM  IMPORTANT text-file rules:
REM    * One sentence / short paragraph per line. Each line must fit inside
REM      --max-tokens (a 12Hz model makes ~12 tokens/sec, so 1200 tokens ~=
REM      100 seconds/line); over-long lines get cut off. Split long paragraphs.
REM    * Blank lines are ignored (they do NOT add a pause).
REM    * Save the file as UTF-8 (needed for non-ASCII / Chinese text).
REM ============================================================

REM ---- editable voice defaults (blank VOICE_REF for non-clone models) ----
set "VOICE_REF=voice\demo_01_man.wav"
set "REF_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice."
set "LANGUAGE=english"
set "MAX_TOKENS=1200"
set "SEED=1234"
REM ------------------------------------------------------------------------

set "MODEL_ID=%~1"
set "TEXTFILE=%~2"
set "OUT=%~3"
if "%MODEL_ID%"=="" goto :usage
if "%TEXTFILE%"=="" goto :usage
if not exist "%TEXTFILE%" ( echo [ERROR] text file not found: %TEXTFILE% & goto :end )
if "%OUT%"=="" set "OUT=output\%~n2.wav"

if not exist "%CLI_EXE%" ( echo [ERROR] cli exe not found: %CLI_EXE% & goto :end )

REM --- resolve family + absolute model path from the catalog id ---
set "STATUS="
for /f "usebackq tokens=1-4 delims=|" %%A in (`powershell -NoProfile -Command "$c=Get-Content -Raw 'configs\models_catalog.json' | ConvertFrom-Json; $m=$c.models | Where-Object { $_.id -eq '%MODEL_ID%' } | Select-Object -First 1; if (-not $m) { 'ERR|unknown id|.|.'; exit }; $p = Join-Path (Resolve-Path '%BUNDLE%').Path $m.path; if (-not (Test-Path $p)) { 'ERR|not installed|.|.'; exit }; 'OK|' + $m.family + '|' + $m.task + '|' + $p"`) do (
  set "STATUS=%%A" & set "FAMILY=%%B" & set "TASK=%%C" & set "MODEL=%%D"
)
if /I not "%STATUS%"=="OK" ( echo [ERROR] bad model id "%MODEL_ID%": %FAMILY% - see configs\models_catalog.json & goto :end )

set "VOICE_ARGS="
if not "%VOICE_REF%"=="" set "VOICE_ARGS=--voice-ref "%VOICE_REF%" --reference-text "%REF_TEXT%""

for /f %%N in ('find /c /v "" ^< "%TEXTFILE%"') do set "LINES=%%N"
echo [long-tts] model=%MODEL_ID% (%FAMILY%)  backend=%BACKEND%
echo [long-tts] text=%TEXTFILE%  (~%LINES% lines)  -^>  out=%OUT%
echo.

"%CLI_EXE%" ^
  --task tts --family %FAMILY% --mode offline ^
  --model "%MODEL%" ^
  --backend %BACKEND% ^
  --language %LANGUAGE% ^
  --batch-text-file "%TEXTFILE%" ^
  --batch-merge-audio concat ^
  %VOICE_ARGS% ^
  --max-tokens %MAX_TOKENS% ^
  --seed %SEED% ^
  --out "%OUT%"

echo.
if exist "%OUT%" ( echo Done -^> %OUT% ) else ( echo FAILED: no output — see messages above )
goto :end

:usage
echo Usage: %~nx0 ^<model_id^> ^<text_file.txt^> [out.wav]
echo   e.g. %~nx0 qwen3-tts "sample_long.txt"
echo        %~nx0 qwen3-tts "D:\books\chapter1.txt" "output\ch1.wav"
echo Model ids are the entries in configs\models_catalog.json.
echo Edit VOICE_REF / REF_TEXT near the top for other voices; blank VOICE_REF for non-clone models.

:end
endlocal
pause
