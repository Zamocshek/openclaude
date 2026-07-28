@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0\..\.."

where uv >nul 2>nul || (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
)

if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"

where uv >nul 2>nul || (
  echo uv installation completed but uv is not on PATH. Open a new terminal and retry.
  exit /b 1
)

uv tool install openrag --python 3.13
uv tool install openrag-mcp --python 3.13
