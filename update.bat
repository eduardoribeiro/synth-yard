@echo off
rem Always run from the directory this bat file lives in (the repo root),
rem regardless of where it was launched from.
cd /d %~dp0

echo ============================================================
echo  Synth Yard Update
echo ============================================================
echo.

echo [1/4] Pulling latest code from GitHub...
git pull
if %errorlevel% neq 0 (
    echo.
    echo ERROR: git pull failed. Check your internet connection or resolve conflicts.
    pause
    exit /b 1
)
echo Done.
echo.

echo [2/4] Installing workspace dependencies...
call pnpm install --frozen-lockfile
if %errorlevel% neq 0 (
    echo.
    echo ERROR: pnpm install failed. Check that Node 26 and pnpm 12.3.4 are installed.
    pause
    exit /b 1
)
echo Done.
echo.

echo [3/4] Building client...
call pnpm build
if %errorlevel% neq 0 (
    echo.
    echo ERROR: client build failed. See output above.
    pause
    exit /b 1
)
echo Done.
echo.

echo [4/4] Restarting server...
rem Kill only the process on port 3000 — avoids accidentally killing this bat's own process tree.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R ":3000 "') do (
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul
echo.
echo ============================================================
echo  Update complete! Server starting below.
echo  Close this window to stop the server.
echo ============================================================
echo.
node server\index.js
