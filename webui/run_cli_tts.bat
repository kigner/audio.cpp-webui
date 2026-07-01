@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM Locate the integrated bundle (cpu/ gpu/ models/); sibling in the dev tree,
REM or this folder itself when copied into the bundle.
set "BUNDLE=%~dp0..\audiocpp-portable"
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" set "BUNDLE=%~dp0."

REM ==== editable params ====
set "MODEL=%BUNDLE%\models\Qwen3-TTS-12Hz-0.6B-Base"
set "VOICE_REF=voice\demo_01_man.wav"
set "REF_TEXT=okay, I'm Cemo and what you just heard wasn't a human voice."
set "OUT=output\out_cli.wav"
set "TEXT=Hello, this is a local GPU test of audio dot cpp running on a laptop."
REM optional: pass custom text ->  run_cli_tts.bat "your text here"
if not "%~1"=="" set "TEXT=%~1"
REM =========================

echo [run_cli_tts] GPU TTS  model=%MODEL%
echo [run_cli_tts] text=%TEXT%
echo.

"%BUNDLE%\gpu\audiocpp_cli.exe" ^
  --task tts --family qwen3_tts ^
  --model "%MODEL%" ^
  --backend cuda ^
  --language english ^
  --text "%TEXT%" ^
  --voice-ref "%VOICE_REF%" ^
  --reference-text "%REF_TEXT%" ^
  --max-tokens 1200 ^
  --seed 1234 ^
  --out "%OUT%"

echo.
if exist "%OUT%" (echo Done -^> %OUT%) else (echo FAILED: no output)
endlocal
pause
