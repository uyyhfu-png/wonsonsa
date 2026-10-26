@echo off
rem Starts the customer management server (if not running) and opens it in the browser.
cd /d "%~dp0"
set PORT=4300

netstat -ano | findstr /R /C:":4300 .*LISTENING" >nul
if not errorlevel 1 goto open

start "customer-server (close this window to stop)" /min cmd /c "node server.js"

for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:4300/ -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
  if not errorlevel 1 goto open
  timeout /t 1 /nobreak >nul
)

:open
start "" "http://localhost:4300/app/"
