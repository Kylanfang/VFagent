@echo off
setlocal
title V-Fletch Stopper
echo Stopping V-Fletch (port 8787) ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":8787" ^| findstr /c:"LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
)
echo V-Fletch stopped. You can close the server window now.
timeout /t 3 >nul
exit /b 0
