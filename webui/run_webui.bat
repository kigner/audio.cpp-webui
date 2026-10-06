@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0_env.bat"
call "%WEBUI_DIR%\start_webui.bat" %*
exit /b %errorlevel%
