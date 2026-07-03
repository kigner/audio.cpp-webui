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
REM    * VibeVoice: lines without an explicit "Speaker N:" tag are read as
REM      "Speaker 0:" automatically (for multi-speaker, prefix lines yourself).
REM ============================================================

REM ---- editable voice defaults (blank VOICE_REF for non-clone models) ----
set "VOICE_REF=voice\zh-Bowen_man.wav"
set "REF_TEXT=简单来说，人工智能是一门致力于让计算机和机器像人一样思考和行动的科学领域。它的目标是模拟、延伸和扩展人的智能，让机器能够胜任通常需要人类智慧才能完成的任务，比如解决问题、感知环境、理解语言，甚至进行创造。AI是一个非常广泛的领域，它包含了计算机科学、语言学、神经科学，甚至哲学和心理学等多个学科的知识。"
set "LANGUAGE=chinese"
set "MAX_TOKENS=1200"
set "SEED=42"
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

REM --- VibeVoice needs a "Speaker N:" script; default lines without one to Speaker 0 ---
set "VV_TMP="
if /I not "%FAMILY%"=="vibevoice" goto :vv_done
set "VV_TMP=%TEMP%\audiocpp_vv_%RANDOM%%RANDOM%.txt"
powershell -NoProfile -Command "$out = Get-Content -LiteralPath '%TEXTFILE%' -Encoding UTF8 | ForEach-Object { if ($_.Trim() -eq '' -or [regex]::IsMatch($_, '^\s*Speaker\s+\d+\s*:', 'IgnoreCase')) { $_ } else { 'Speaker 0: ' + $_ } }; [IO.File]::WriteAllLines('%VV_TMP%', [string[]]@($out), (New-Object System.Text.UTF8Encoding($false)))"
if not exist "%VV_TMP%" ( echo [ERROR] failed to prepare VibeVoice speaker script & goto :end )
set "TEXTFILE=%VV_TMP%"
:vv_done

set "VOICE_ARGS="
if not "%VOICE_REF%"=="" set "VOICE_ARGS=--voice-ref "%VOICE_REF%" --reference-text "%REF_TEXT%""

for /f %%N in ('find /c /v "" ^< "%TEXTFILE%"') do set "LINES=%%N"
echo [long-tts] model=%MODEL_ID% (%FAMILY%)  backend=%BACKEND%
echo [long-tts] text=%TEXTFILE%  (~%LINES% lines)  -^>  out=%OUT%
echo.

REM  set AUDIOCPP_LOG=1 to capture framework timing logs (incl. vibevoice.*.buffer_bytes VRAM)
REM  directly to vv_vram.log next to this script (flushed per line -> survives an OOM crash).
set "LOG_ARG="
if /I "%AUDIOCPP_LOG%"=="1" set "LOG_ARG=--log-file "%~dp0vv_vram.log""

"%CLI_EXE%" ^
  --task tts --family %FAMILY% --mode offline ^
  --model "%MODEL%" ^
  --backend %BACKEND% ^
  %LOG_ARG% ^
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
if not "%VV_TMP%"=="" if exist "%VV_TMP%" del /q "%VV_TMP%" >nul 2>&1
endlocal
pause
