@echo off
REM ============================================================
REM  Shared environment for the webui launchers.
REM  `call`ed by run_cli_tts.bat / run_tts_long.bat / run_server.bat / run_webui.bat.
REM  It sets: BUNDLE, HAS_CUDA, BACKEND, CLI_EXE, SERVER_EXE, PY.
REM  IMPORTANT: no setlocal/endlocal here on purpose, so the vars it
REM  sets survive back in the caller's scope.
REM ============================================================

REM --- bundle root (holds cpu\ gpu\ models\): sibling ..\audiocpp-portable, else this folder ---
set "BUNDLE=%~dp0..\audiocpp-portable"
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" if not exist "%BUNDLE%\cpu\audiocpp_cli.exe" set "BUNDLE=%~dp0."

REM --- CUDA present? driver DLL, or nvidia-smi on PATH ---
set "HAS_CUDA="
if exist "%SystemRoot%\System32\nvcuda.dll" set "HAS_CUDA=1"
if not defined HAS_CUDA ( where nvidia-smi >nul 2>nul && set "HAS_CUDA=1" )

REM --- backend + cli exe: AUDIOCPP_BACKEND overrides (gpu|cuda|cpu; 'gpu' aliases 'cuda',
REM     matching run_webui.bat's convention); else auto (cuda if CUDA+gpu exe, else cpu) ---
set "BACKEND="
if /I "%AUDIOCPP_BACKEND%"=="gpu"  set "BACKEND=cuda"
if /I "%AUDIOCPP_BACKEND%"=="cuda" set "BACKEND=cuda"
if /I "%AUDIOCPP_BACKEND%"=="cpu"  set "BACKEND=cpu"
if not defined BACKEND (
  if defined HAS_CUDA (
    if exist "%BUNDLE%\gpu\audiocpp_cli.exe" ( set "BACKEND=cuda" ) else ( set "BACKEND=cpu" )
  ) else (
    set "BACKEND=cpu"
  )
)
if /I "%BACKEND%"=="cuda" ( set "CLI_EXE=%BUNDLE%\gpu\audiocpp_cli.exe" ) else ( set "CLI_EXE=%BUNDLE%\cpu\audiocpp_cli.exe" )
REM cpu exe missing but gpu exe present -> the gpu build can also run --backend cpu
if /I "%BACKEND%"=="cpu" if not exist "%CLI_EXE%" if exist "%BUNDLE%\gpu\audiocpp_cli.exe" set "CLI_EXE=%BUNDLE%\gpu\audiocpp_cli.exe"

REM --- server exe follows BACKEND; cpu exe missing -> the gpu build can also run --backend cpu ---
if /I "%BACKEND%"=="cuda" ( set "SERVER_EXE=%BUNDLE%\gpu\audiocpp_server.exe" ) else ( set "SERVER_EXE=%BUNDLE%\cpu\audiocpp_server.exe" )
if /I "%BACKEND%"=="cpu" if not exist "%SERVER_EXE%" if exist "%BUNDLE%\gpu\audiocpp_server.exe" set "SERVER_EXE=%BUNDLE%\gpu\audiocpp_server.exe"

REM --- python with webui deps (bundle self-contained -> shipped bundle -> dev project venv) ---
set "PY=%~dp0..\audiocpp-portable\venv\python.exe"
if not exist "%PY%" set "PY=%~dp0..\venv\python.exe"
if not exist "%PY%" set "PY=%~dp0..\venv\Scripts\python.exe"

REM --- bundled ffmpeg (webui.py transcodes non-WAV uploads with it): put this folder on PATH ---
if exist "%~dp0ffmpeg.exe" set "PATH=%~dp0;%PATH%"

goto :eof
