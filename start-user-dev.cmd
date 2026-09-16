@echo off
cd /d "%~dp0"
if not exist "dist\user\main.cjs" (
  echo Run npm run build first.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0dist\user"
