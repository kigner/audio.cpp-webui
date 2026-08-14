@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if /I "%~1"=="--help" goto :usage
if /I "%~1"=="-h" goto :usage

call "%~dp0_env.bat"

if not exist "%SERVER_EXE%" (
  echo [ERROR] native WebUI server was not found:
  echo   %SERVER_EXE%
  goto :end
)

REM Usage: run_native_webui.bat [port] [device]
REM _env.bat selects CUDA when an NVIDIA driver and GPU build are available,
REM otherwise CPU. AUDIOCPP_BACKEND=gpu or cpu overrides that selection.
set "NATIVE_PORT=%~1"
if not defined NATIVE_PORT set "NATIVE_PORT=%AUDIOCPP_NATIVE_PORT%"
if not defined NATIVE_PORT set "NATIVE_PORT=8080"

set "NATIVE_DEVICE=%~2"
if not defined NATIVE_DEVICE set "NATIVE_DEVICE=%AUDIOCPP_DEVICE%"
if not defined NATIVE_DEVICE set "NATIVE_DEVICE=0"

set "NATIVE_HOST=%AUDIOCPP_HOST%"
if not defined NATIVE_HOST set "NATIVE_HOST=127.0.0.1"

set "NATIVE_THREADS=%AUDIOCPP_THREADS%"
if not defined NATIVE_THREADS set "NATIVE_THREADS=1"
if /I "%BACKEND%"=="cpu" if not defined AUDIOCPP_THREADS set /a "NATIVE_THREADS=%NUMBER_OF_PROCESSORS%-1"
if %NATIVE_THREADS% LSS 1 set "NATIVE_THREADS=1"

REM Native model install/convert jobs use the upstream model_manager_v2.py.
REM Point them at the portable Python instead of relying on a system install.
if not defined AUDIOCPP_PYTHON if exist "%PY%" set "AUDIOCPP_PYTHON=%PY%"

REM The server's binary-local default would be gpu\models or cpu\models. After
REM startup, switch it to the portable bundle's shared models directory before
REM opening the browser so both WebUIs see the same installed model files.
set "AUDIOCPP_NATIVE_MODELS_ROOT=%BUNDLE%\models"
set "NATIVE_BROWSER_HOST=%NATIVE_HOST%"
if /I "%NATIVE_BROWSER_HOST%"=="0.0.0.0" set "NATIVE_BROWSER_HOST=127.0.0.1"
set "AUDIOCPP_NATIVE_URL=http://%NATIVE_BROWSER_HOST%:%NATIVE_PORT%"

echo [run_native_webui] server : %SERVER_EXE%
echo [run_native_webui] backend: %BACKEND%  device %NATIVE_DEVICE%  threads %NATIVE_THREADS%
echo [run_native_webui] models : %AUDIOCPP_NATIVE_MODELS_ROOT%
echo [run_native_webui] UI     : %AUDIOCPP_NATIVE_URL%
if not defined AUDIOCPP_PYTHON echo [run_native_webui] WARNING: Python was not found; inference works, but model install/convert jobs may fail.
echo [run_native_webui] Ctrl+C stops the native WebUI server.
echo.

REM Wait until the server is ready, select the shared portable models folder,
REM then open the native UI in the default browser. The server itself stays in
REM this console so Ctrl+C continues to stop it normally.
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$ErrorActionPreference='Stop'; for ($i=0; $i -lt 60; $i++) { try { $body=@{path=$env:AUDIOCPP_NATIVE_MODELS_ROOT} | ConvertTo-Json -Compress; Invoke-RestMethod -Uri ($env:AUDIOCPP_NATIVE_URL + '/v1/ui/models-root') -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 2 | Out-Null; Start-Process $env:AUDIOCPP_NATIVE_URL; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"

"%SERVER_EXE%" --ui --backend "%BACKEND%" --host "%NATIVE_HOST%" --port "%NATIVE_PORT%" --device "%NATIVE_DEVICE%" --threads "%NATIVE_THREADS%"
if errorlevel 1 echo [ERROR] native WebUI server exited with code %ERRORLEVEL%.
goto :end

:usage
echo Usage: %~nx0 [port] [device]
echo   Default: port 8080, device 0, backend auto-detected.
echo   Example: %~nx0 8080 0
echo.
echo Environment overrides:
echo   AUDIOCPP_BACKEND=gpu^|cpu
echo   AUDIOCPP_HOST=127.0.0.1
echo   AUDIOCPP_NATIVE_PORT=8080
echo   AUDIOCPP_DEVICE=0
echo   AUDIOCPP_THREADS=8
echo   AUDIOCPP_PYTHON=D:\path\to\python.exe
exit /b 0

:end
echo.
pause
endlocal
