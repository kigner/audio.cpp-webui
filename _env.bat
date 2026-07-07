@echo off
REM ============================================================
REM  Shared environment for launchers located at the package root.
REM  Dev layout:      ROOT\webui + ROOT\audiocpp-portable + ROOT\build
REM  Portable layout: ROOT\webui + ROOT\gpu/cpu + ROOT\models
REM  Sets: ROOT, WEBUI_DIR, BUNDLE, HAS_CUDA, BACKEND, CLI_EXE, SERVER_EXE, PY.
REM ============================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "WEBUI_DIR=%ROOT%\webui"

REM --- bundle root (holds gpu\ cpu\ models\ assets\ tools\) ---
set "BUNDLE=%ROOT%"
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" if not exist "%BUNDLE%\cpu\audiocpp_cli.exe" set "BUNDLE=%ROOT%\audiocpp-portable"
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" if not exist "%BUNDLE%\cpu\audiocpp_cli.exe" set "BUNDLE=%ROOT%"

REM --- development build outputs: prefer freshly built exes under ROOT\build ---
set "BUILD_CUDA_BIN=%ROOT%\build\windows-cuda-release\bin"
set "BUILD_CPU_BIN=%ROOT%\build\windows-cpu-release\bin"
set "BUILD_CUDA_CLI=%BUILD_CUDA_BIN%\audiocpp_cli.exe"
set "BUILD_CUDA_SERVER=%BUILD_CUDA_BIN%\audiocpp_server.exe"
set "BUILD_CPU_CLI=%BUILD_CPU_BIN%\audiocpp_cli.exe"
set "BUILD_CPU_SERVER=%BUILD_CPU_BIN%\audiocpp_server.exe"

REM --- CUDA present? driver DLL, or nvidia-smi on PATH ---
set "HAS_CUDA="
if exist "%SystemRoot%\System32\nvcuda.dll" set "HAS_CUDA=1"
if not defined HAS_CUDA ( where nvidia-smi >nul 2>nul && set "HAS_CUDA=1" )

REM --- backend: AUDIOCPP_BACKEND overrides; else CUDA only when hardware and exe exist ---
set "BACKEND="
if /I "%AUDIOCPP_BACKEND%"=="gpu"  set "BACKEND=cuda"
if /I "%AUDIOCPP_BACKEND%"=="cuda" set "BACKEND=cuda"
if /I "%AUDIOCPP_BACKEND%"=="cpu"  set "BACKEND=cpu"
if not defined BACKEND (
  if defined HAS_CUDA (
    if exist "%BUILD_CUDA_CLI%" set "BACKEND=cuda"
    if not exist "%BUILD_CUDA_CLI%" if exist "%BUNDLE%\gpu\audiocpp_cli.exe" set "BACKEND=cuda"
    if not defined BACKEND set "BACKEND=cpu"
  ) else (
    set "BACKEND=cpu"
  )
)

REM --- executable lookup: build first, bundled gpu/cpu second ---
if /I "%BACKEND%"=="cuda" (
  if exist "%BUILD_CUDA_CLI%" ( set "CLI_EXE=%BUILD_CUDA_CLI%" ) else ( set "CLI_EXE=%BUNDLE%\gpu\audiocpp_cli.exe" )
  if exist "%BUILD_CUDA_SERVER%" ( set "SERVER_EXE=%BUILD_CUDA_SERVER%" ) else ( set "SERVER_EXE=%BUNDLE%\gpu\audiocpp_server.exe" )
) else (
  if exist "%BUILD_CPU_CLI%" ( set "CLI_EXE=%BUILD_CPU_CLI%" ) else if exist "%BUNDLE%\cpu\audiocpp_cli.exe" ( set "CLI_EXE=%BUNDLE%\cpu\audiocpp_cli.exe" ) else ( set "CLI_EXE=%BUNDLE%\gpu\audiocpp_cli.exe" )
  if exist "%BUILD_CPU_SERVER%" ( set "SERVER_EXE=%BUILD_CPU_SERVER%" ) else if exist "%BUNDLE%\cpu\audiocpp_server.exe" ( set "SERVER_EXE=%BUNDLE%\cpu\audiocpp_server.exe" ) else ( set "SERVER_EXE=%BUNDLE%\gpu\audiocpp_server.exe" )
)

REM --- python with webui deps ---
set "PY=%BUNDLE%\venv\python.exe"
if not exist "%PY%" set "PY=%ROOT%\venv\python.exe"
if not exist "%PY%" set "PY=%ROOT%\venv\Scripts\python.exe"

REM --- bundled ffmpeg (webui.py transcodes non-WAV uploads with it): put webui folder on PATH ---
if exist "%WEBUI_DIR%\ffmpeg.exe" set "PATH=%WEBUI_DIR%;%PATH%"

goto :eof