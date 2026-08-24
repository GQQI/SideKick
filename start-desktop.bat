@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo  Sidekick Desktop - live embedded browser
echo  ----------------------------------------------------
echo.

REM ---- Resolve Python (project .venv; portable, no machine-specific conda) ----
call "%~dp0scripts\ensure-python.bat"
if errorlevel 1 (
  pause
  exit /b 1
)
echo  Python: %SIDEKICK_PYTHON%

REM China-friendly mirrors (optional overrides still win)
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined PLAYWRIGHT_DOWNLOAD_HOST set "PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright"

echo.
echo [0/4] Installing Python packages...
call "%~dp0scripts\install-python-deps.bat"
if errorlevel 1 (
  echo.
  echo Failed: Python dependency install
  echo Tip: delete .venv and re-run, or install uv / ensurepip.
  pause
  exit /b 1
)

echo.
echo [0b] Ensuring Playwright Chromium (agent browser tools^)...
"%SIDEKICK_PYTHON%" -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); p.chromium.launch(headless=True).close(); p.stop()" 1>nul 2>nul
if errorlevel 1 (
  echo      Chromium missing - downloading...
  "%SIDEKICK_PYTHON%" -m playwright install chromium
  if errorlevel 1 (
    echo Warning: playwright install chromium failed. Live Electron preview still works;
    echo          agent browser_* / screenshot mode may fail until this succeeds.
  )
) else (
  echo      Playwright Chromium OK
)

echo.
if not exist "desktop\node_modules\electron\dist\electron.exe" (
  echo [1/4] Installing desktop dependencies...
  pushd desktop
  call npm install
  if errorlevel 1 (
    echo.
    echo Failed: npm install in desktop\
    popd
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo      Retrying Electron binary download...
    call node node_modules\electron\install.js
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo Still missing electron.exe - check network / antivirus.
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo [1/4] Desktop deps OK
)

echo.
if not exist "ui\node_modules\" (
  echo [2/4] Installing UI dependencies...
  pushd ui
  call npm install
  if errorlevel 1 (
    echo.
    echo Failed: npm install in ui\
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo [2/4] UI node_modules OK
)

echo.
echo [3/4] Building UI...
pushd ui
call npm run build
if errorlevel 1 (
  echo.
  echo Failed: npm run build in ui\
  popd
  pause
  exit /b 1
)
popd

echo.
echo [4/4] Launching Electron...
echo.
pushd desktop
call npm start
set ERR=%ERRORLEVEL%
popd
if not "%ERR%"=="0" (
  echo.
  echo Electron exited with code %ERR%
  pause
)
exit /b %ERR%
