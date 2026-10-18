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
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" if not exist "%BUNDLE%\vulkan\audiocpp_cli.exe" if not exist "%BUNDLE%\cpu\audiocpp_cli.exe" set "BUNDLE=%ROOT%\audiocpp-portable"
if not exist "%BUNDLE%\gpu\audiocpp_cli.exe" if not exist "%BUNDLE%\vulkan\audiocpp_cli.exe" if not exist "%BUNDLE%\cpu\audiocpp_cli.exe" set "BUNDLE=%ROOT%"

REM --- development build outputs: prefer freshly built exes under ROOT\build ---
set "BUILD_CUDA_BIN=%ROOT%\build\windows-cuda-release\bin"
set "BUILD_CPU_BIN=%ROOT%\build\windows-cpu-release\bin"
set "BUILD_CUDA_CLI=%BUILD_CUDA_BIN%\audiocpp_cli.exe"
set "BUILD_CUDA_SERVER=%BUILD_CUDA_BIN%\audiocpp_server.exe"
set "BUILD_CPU_CLI=%BUILD_CPU_BIN%\audiocpp_cli.exe"
set "BUILD_CPU_SERVER=%BUILD_CPU_BIN%\audiocpp_server.exe"
set "BUILD_VULKAN_BIN=%ROOT%\build\windows-vulkan-release\bin"
set "BUILD_VULKAN_CLI=%BUILD_VULKAN_BIN%\audiocpp_cli.exe"
set "BUILD_VULKAN_SERVER=%BUILD_VULKAN_BIN%\audiocpp_server.exe"

REM Preserve the source launcher's plain CMake build layouts as fallbacks.
set "PLAIN_BIN="
set "PLAIN_BACKEND="
if exist "%ROOT%\build\bin\audiocpp_server.exe" set "PLAIN_BIN=%ROOT%\build\bin"
if exist "%ROOT%\build\bin\Release\audiocpp_server.exe" set "PLAIN_BIN=%ROOT%\build\bin\Release"
if defined PLAIN_BIN (
  set "PLAIN_BACKEND=cpu"
  if exist "%ROOT%\build\CMakeCache.txt" (
    for /f "tokens=2 delims==" %%A in ('findstr /b /c:"GGML_CUDA:BOOL" /c:"ENGINE_ENABLE_CUDA:BOOL" "%ROOT%\build\CMakeCache.txt" 2^>nul') do if /I "%%A"=="ON" set "PLAIN_BACKEND=cuda"
    for /f "tokens=2 delims==" %%A in ('findstr /b /c:"GGML_VULKAN:BOOL" /c:"ENGINE_ENABLE_VULKAN:BOOL" "%ROOT%\build\CMakeCache.txt" 2^>nul') do if /I "%%A"=="ON" set "PLAIN_BACKEND=vulkan"
  )
)
if /I "%PLAIN_BACKEND%"=="cuda" if not exist "%BUILD_CUDA_SERVER%" (
  set "BUILD_CUDA_CLI=%PLAIN_BIN%\audiocpp_cli.exe"
  set "BUILD_CUDA_SERVER=%PLAIN_BIN%\audiocpp_server.exe"
)
if /I "%PLAIN_BACKEND%"=="vulkan" if not exist "%BUILD_VULKAN_SERVER%" (
  set "BUILD_VULKAN_CLI=%PLAIN_BIN%\audiocpp_cli.exe"
  set "BUILD_VULKAN_SERVER=%PLAIN_BIN%\audiocpp_server.exe"
)
if /I "%PLAIN_BACKEND%"=="cpu" if not exist "%BUILD_CPU_SERVER%" (
  set "BUILD_CPU_CLI=%PLAIN_BIN%\audiocpp_cli.exe"
  set "BUILD_CPU_SERVER=%PLAIN_BIN%\audiocpp_server.exe"
)

REM --- Python is also used for the dependency-free GPU/driver probe. ---
set "PY="
if defined AUDIOCPP_PYTHON if exist "%AUDIOCPP_PYTHON%" set "PY=%AUDIOCPP_PYTHON%"
if not defined PY if exist "%ROOT%\venv\Scripts\python.exe" set "PY=%ROOT%\venv\Scripts\python.exe"
if not defined PY if exist "%ROOT%\venv\python.exe" set "PY=%ROOT%\venv\python.exe"
if not defined PY if exist "%WEBUI_DIR%\venv\Scripts\python.exe" set "PY=%WEBUI_DIR%\venv\Scripts\python.exe"
if not defined PY if exist "%WEBUI_DIR%\venv\python.exe" set "PY=%WEBUI_DIR%\venv\python.exe"
if not defined PY if exist "%BUNDLE%\venv\python.exe" set "PY=%BUNDLE%\venv\python.exe"

REM --- CUDA present? driver DLL, or nvidia-smi on PATH ---
set "HAS_CUDA="
if exist "%SystemRoot%\System32\nvcuda.dll" set "HAS_CUDA=1"
if not defined HAS_CUDA ( where nvidia-smi >nul 2>nul && set "HAS_CUDA=1" )

REM --- backend: AUDIOCPP_BACKEND overrides; else CUDA only when hardware and exe exist ---
set "BACKEND="
if /I "%AUDIOCPP_BACKEND%"=="gpu"  set "BACKEND=cuda"
if /I "%AUDIOCPP_BACKEND%"=="cuda" set "BACKEND=cuda"
if /I "%AUDIOCPP_BACKEND%"=="cpu"  set "BACKEND=cpu"
if /I "%AUDIOCPP_BACKEND%"=="vulkan" set "BACKEND=vulkan"
set "PROBE_CUDA=%BUNDLE%\gpu\audiocpp_server.exe"
set "PROBE_VULKAN=%BUNDLE%\vulkan\audiocpp_server.exe"
if exist "%BUILD_CUDA_SERVER%" set "PROBE_CUDA=%BUILD_CUDA_SERVER%"
if exist "%BUILD_VULKAN_SERVER%" set "PROBE_VULKAN=%BUILD_VULKAN_SERVER%"
if not defined BACKEND if defined PY for /f "delims=" %%B in ('""%PY%" "%WEBUI_DIR%\backend_probe.py" --cuda "%PROBE_CUDA%" --vulkan "%PROBE_VULKAN%""') do set "BACKEND=%%B"
if not defined BACKEND set "BACKEND=cpu"

REM --- executable lookup: build first, bundled gpu/cpu second ---
if /I "%BACKEND%"=="cuda" (
  if exist "%BUILD_CUDA_CLI%" ( set "CLI_EXE=%BUILD_CUDA_CLI%" ) else ( set "CLI_EXE=%BUNDLE%\gpu\audiocpp_cli.exe" )
  if exist "%BUILD_CUDA_SERVER%" ( set "SERVER_EXE=%BUILD_CUDA_SERVER%" ) else ( set "SERVER_EXE=%BUNDLE%\gpu\audiocpp_server.exe" )
) else if /I "%BACKEND%"=="vulkan" (
  if exist "%BUILD_VULKAN_CLI%" ( set "CLI_EXE=%BUILD_VULKAN_CLI%" ) else ( set "CLI_EXE=%BUNDLE%\vulkan\audiocpp_cli.exe" )
  if exist "%BUILD_VULKAN_SERVER%" ( set "SERVER_EXE=%BUILD_VULKAN_SERVER%" ) else ( set "SERVER_EXE=%BUNDLE%\vulkan\audiocpp_server.exe" )
) else (
  if exist "%BUILD_CPU_CLI%" ( set "CLI_EXE=%BUILD_CPU_CLI%" ) else if exist "%BUNDLE%\cpu\audiocpp_cli.exe" ( set "CLI_EXE=%BUNDLE%\cpu\audiocpp_cli.exe" ) else ( set "CLI_EXE=%BUNDLE%\gpu\audiocpp_cli.exe" )
  if exist "%BUILD_CPU_SERVER%" ( set "SERVER_EXE=%BUILD_CPU_SERVER%" ) else if exist "%BUNDLE%\cpu\audiocpp_server.exe" ( set "SERVER_EXE=%BUNDLE%\cpu\audiocpp_server.exe" ) else ( set "SERVER_EXE=%BUNDLE%\gpu\audiocpp_server.exe" )
)

REM --- bundled ffmpeg (webui.py transcodes non-WAV uploads with it): put webui folder on PATH ---
if exist "%WEBUI_DIR%\ffmpeg.exe" set "PATH=%WEBUI_DIR%;%PATH%"

goto :eof
