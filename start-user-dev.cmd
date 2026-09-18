@echo off
setlocal
cd /d "%~dp0"
echo Building latest source before launch...
call npm.cmd run build
if errorlevel 1 (
  echo Build failed. Application was not started. Fix the errors above and try again.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0dist\user"
