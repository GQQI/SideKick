@echo off
REM Resolve a portable project-local Python for Sidekick (no machine-specific paths).
REM Priority:
REM   1) SIDEKICK_PYTHON (env)
REM   2) .sidekick-python tip file
REM   3) existing .venv
REM   4) create .venv via uv / py / python
REM On success, sets SIDEKICK_PYTHON for the caller. Exit 1 on failure.
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0.."
set "REPO=%CD%"
set "VENV_PY=%REPO%\.venv\Scripts\python.exe"
set "TIP_OUT=%~dp0.ensure-python.tmp"
set "RESOLVED="

if defined SIDEKICK_PYTHON (
  set "RESOLVED=%SIDEKICK_PYTHON%"
  goto :export
)

if exist "%REPO%\.sidekick-python" (
  set /p RESOLVED=<"%REPO%\.sidekick-python"
)
if defined RESOLVED if exist "!RESOLVED!" goto :export
set "RESOLVED="

if exist "%VENV_PY%" (
  set "RESOLVED=%VENV_PY%"
  goto :export
)

echo  Creating project .venv (portable isolated env)...
where uv >nul 2>nul
if not errorlevel 1 (
  uv venv --seed "%REPO%\.venv"
  if exist "%VENV_PY%" (
    set "RESOLVED=%VENV_PY%"
    goto :export
  )
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m venv "%REPO%\.venv"
  if exist "%VENV_PY%" (
    set "RESOLVED=%VENV_PY%"
    goto :export
  )
)

where python >nul 2>nul
if not errorlevel 1 (
  python -m venv "%REPO%\.venv"
  if exist "%VENV_PY%" (
    set "RESOLVED=%VENV_PY%"
    goto :export
  )
)

echo.
echo Failed to create .venv. Install Python 3.11+ ^(or uv^), then re-run.
echo Or set SIDEKICK_PYTHON / write its path into .sidekick-python.
endlocal
exit /b 1

:export
> "%TIP_OUT%" echo(!RESOLVED!
endlocal

set "SIDEKICK_PYTHON="
set /p SIDEKICK_PYTHON=<"%~dp0.ensure-python.tmp"
del /q "%~dp0.ensure-python.tmp" 2>nul

if not defined SIDEKICK_PYTHON exit /b 1
if not exist "%SIDEKICK_PYTHON%" (
  echo ERROR: Python not found: %SIDEKICK_PYTHON%
  exit /b 1
)
exit /b 0
