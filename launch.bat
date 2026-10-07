@echo off
setlocal enabledelayedexpansion
title V-Fletch Launcher
cd /d "%~dp0"

rem ============================================================
rem  V-Fletch Office Agent - one-click launcher
rem  Double-click this file (or the shortcut) to start the app.
rem  It starts the local server in its own minimized window and
rem  opens the browser automatically. Closing this console is OK.
rem ============================================================

rem ---- 1. locate node.exe (managed first, then PATH) ----
set "NODE_EXE="
set "NODE_DIR=<USERPROFILE>\.workbuddy\binaries\node\versions\22.22.2-2"
if exist "%NODE_DIR%\node.exe" set "NODE_EXE=%NODE_DIR%\node.exe"
if not defined NODE_EXE (
  where node >nul 2>&1
  if !errorlevel! equ 0 (
    for /f "delims=" %%i in ('where node') do (
      set "NODE_EXE=%%i"
      goto :node_found
    )
  )
)
:node_found
if not defined NODE_EXE (
  echo [ERROR] Node.js 22+ not found. Install it first: https://nodejs.org
  echo Press any key to exit.
  pause >nul
  exit /b 1
)
for %%i in ("%NODE_EXE%") do set "NODE_BIN=%%~dpi"
set "PATH=%NODE_BIN%;%PATH%"
echo [1/4] Node: %NODE_EXE%

rem ---- 2. ensure dependencies ----
if not exist "node_modules" (
  echo [2/4] First run: installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Run "npm install" manually in this folder.
    pause
    exit /b 1
  )
) else (
  echo [2/4] Dependencies OK
)

rem ---- 3. already running? just open the browser ----
netstat -ano | findstr /c:":8787" | findstr /c:"LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [3/4] V-Fletch is already running at http://127.0.0.1:8787
  goto :open
)

rem ---- 4. start server in a separate minimized console ----
echo [3/4] Starting V-Fletch server...
start "V-Fletch Server - keep this window open" /min cmd /k ""%NODE_EXE%" server\main.mjs"

rem ---- 5. wait until healthy (max ~30s) ----
set /a tries=0
:wait
set /a tries+=1
if !tries! gtr 30 (
  echo [ERROR] Server did not become ready within 30s. Check the
  echo         "V-Fletch Server" window for errors, then retry.
  pause
  exit /b 1
)
curl -s -m 2 http://127.0.0.1:8787/api/health >nul 2>&1
if errorlevel 1 (
  ping -n 2 127.0.0.1 >nul
  goto :wait
)

:open
echo [4/4] V-Fletch is ready, opening browser...
start "" "http://127.0.0.1:8787"
timeout /t 2 >nul
exit /b 0
