@echo off
REM Ensure pip exists for %SIDEKICK_PYTHON%, then install requirements.txt.
REM Prefers: uv pip -> python -m pip (after ensurepip bootstrap).
REM Requires SIDEKICK_PYTHON. Exit 1 on failure.
setlocal EnableExtensions

if not defined SIDEKICK_PYTHON (
  echo ERROR: SIDEKICK_PYTHON is not set
  exit /b 1
)
if not exist "%SIDEKICK_PYTHON%" (
  echo ERROR: Python not found: %SIDEKICK_PYTHON%
  exit /b 1
)

cd /d "%~dp0.."

"%SIDEKICK_PYTHON%" -m pip --version >nul 2>nul
if errorlevel 1 (
  echo  Bootstrapping pip into venv...
  "%SIDEKICK_PYTHON%" -m ensurepip --upgrade
  if errorlevel 1 (
    echo ensurepip failed - trying uv pip instead...
  ) else (
    "%SIDEKICK_PYTHON%" -m pip install --upgrade pip
  )
)

where uv >nul 2>nul
if not errorlevel 1 (
  uv pip install -r requirements.txt --python "%SIDEKICK_PYTHON%"
  if not errorlevel 1 exit /b 0
  echo uv pip failed - falling back to python -m pip...
)

"%SIDEKICK_PYTHON%" -m pip --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: No pip in this Python. Try:
  echo   1^) delete .venv and re-run
  echo   2^) install uv: https://docs.astral.sh/uv/
  echo   3^) "%SIDEKICK_PYTHON%" -m ensurepip --upgrade
  exit /b 1
)

"%SIDEKICK_PYTHON%" -m pip install -r requirements.txt
exit /b %ERRORLEVEL%
