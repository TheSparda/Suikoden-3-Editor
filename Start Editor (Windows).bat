@echo off
REM Double-click this file to launch the Suikoden III editor on Windows.
cd /d "%~dp0Editor"

set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"

if not defined PY (
  echo Python 3 is not installed.
  echo Install it from https://www.python.org/downloads/
  echo IMPORTANT: on the installer's first screen, tick "Add Python to PATH".
  echo Then double-click this file again.
  pause
  exit /b 1
)

echo Starting Suikoden III editor...
echo A browser tab will open. Pick your ISO there.
echo Keep this window open while editing. Close it (or press Ctrl+C) to stop.
echo.
%PY% s3editor.py
pause
