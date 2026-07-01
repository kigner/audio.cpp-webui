@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  Long-text TTS  ->  synthesize a whole .txt into ONE wav.
REM
REM  Usage:  run_tts_long.bat <model_dir> <text_file.txt> [out.wav]
REM    e.g.  run_tts_long.bat "models\Qwen3-TTS-12Hz-0.6B-Base" "sample_long.txt"
REM          run_tts_long.bat "models\OmniVoice" "book.txt" "book.wav"
REM
REM  A relative <model_dir> like models\X is resolved against the bundle.
REM  Output defaults to output\<txt name>.wav.
REM
REM  How long text works here:
REM    The .txt is split by LINE. Every non-empty line becomes one
REM    generation, all run on a single loaded model, then every clip
REM    is concatenated into one wav (--batch-merge-audio concat).
REM    There is NO limit on the file size, so 60+ minutes is fine.
REM
REM  IMPORTANT text-file rules:
REM    * Put ONE sentence / short paragraph per line. Each line must
REM      fit inside --max-tokens (a 12Hz model makes ~12 tokens/sec,
REM      so 1200 tokens ~= 100 seconds per line); over-long lines get
REM      cut off. Split long paragraphs into several lines.
REM    * Blank lines are ignored (they do NOT add a pause).
REM    * Save the file as UTF-8 (needed for non-ASCII / Chinese text).
REM ============================================================

REM Locate the integrated bundle (cpu/ gpu/ models/); sibling in the dev tree,
REM or this folder itself when copied into the bundle.
set "BUNDLE=%~dp0..\audiocpp-portable"
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" if not exist "%BUNDLE%\cpu\audiocpp_cli.exe" set "BUNDLE=%~dp0."

REM ---- editable defaults (match them to your model/voice) ----
set "FAMILY=qwen3_tts"
set "BACKEND=cuda"
set "LANGUAGE=english"
set "VOICE_REF=voice\demo_01_man.wav"
set "REF_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice."
set "MAX_TOKENS=1200"
set "SEED=1234"
REM Blank out VOICE_REF (set "VOICE_REF=") for non-voice-clone models.
REM ------------------------------------------------------------

set "MODEL=%~1"
set "TEXT=%~2"
set "OUT=%~3"

if "%MODEL%"=="" goto :usage
if "%TEXT%"=="" goto :usage
REM resolve a bundle-relative model path (e.g. models\Qwen3-...)
if not exist "%MODEL%" if exist "%BUNDLE%\%MODEL%" set "MODEL=%BUNDLE%\%MODEL%"
if not exist "%MODEL%" echo [ERROR] model not found: %MODEL% & goto :end
if not exist "%TEXT%" echo [ERROR] text file not found: %TEXT% & goto :end
if "%OUT%"=="" set "OUT=output\%~n2.wav"

if /I "%BACKEND%"=="cpu" (set "EXE=%BUNDLE%\cpu\audiocpp_cli.exe") else (set "EXE=%BUNDLE%\gpu\audiocpp_cli.exe")
if not exist "%EXE%" echo [ERROR] cli not found: %EXE%  (build it or switch BACKEND) & goto :end

REM Voice-clone args are added only when VOICE_REF is set.
set "VOICE_ARGS="
if not "%VOICE_REF%"=="" set "VOICE_ARGS=--voice-ref "%VOICE_REF%" --reference-text "%REF_TEXT%""

for /f %%N in ('find /c /v "" ^< "%TEXT%"') do set "LINES=%%N"
echo [long-tts] family=%FAMILY%  backend=%BACKEND%  model=%MODEL%
echo [long-tts] text=%TEXT%  (~%LINES% lines)  -^>  out=%OUT%
echo.

"%EXE%" ^
  --task tts --family %FAMILY% --mode offline ^
  --model "%MODEL%" ^
  --backend %BACKEND% ^
  --language %LANGUAGE% ^
  --batch-text-file "%TEXT%" ^
  --batch-merge-audio concat ^
  %VOICE_ARGS% ^
  --max-tokens %MAX_TOKENS% ^
  --seed %SEED% ^
  --out "%OUT%"

echo.
if exist "%OUT%" (echo Done -^> %OUT%) else (echo FAILED: no output — see messages above)
goto :end

:usage
echo Usage: %~nx0 ^<model_dir^> ^<text_file.txt^> [out.wav]
echo   e.g. %~nx0 "models\Qwen3-TTS-12Hz-0.6B-Base" "sample_long.txt"
echo Edit FAMILY / VOICE_REF / REF_TEXT / BACKEND near the top for other models.

:end
endlocal
pause
