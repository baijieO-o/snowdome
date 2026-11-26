@echo off
cd /d "%~dp0"
echo Starting Snowdome server...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000/"
npm start
pause
