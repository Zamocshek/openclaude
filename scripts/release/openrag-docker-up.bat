@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0\..\.."

if exist ".env" (
  for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)

if "%OPENCLAUDE_OPENRAG_REPO_DIR%"=="" set "OPENCLAUDE_OPENRAG_REPO_DIR=%USERPROFILE%\.openclaude\openrag"
if "%OPENCLAUDE_OPENRAG_DOCLING_PORT%"=="" set "OPENCLAUDE_OPENRAG_DOCLING_PORT=5001"
if "%OPENSEARCH_PASSWORD%"=="" if not "%OPENCLAUDE_OPENRAG_OPENSEARCH_PASSWORD%"=="" set "OPENSEARCH_PASSWORD=%OPENCLAUDE_OPENRAG_OPENSEARCH_PASSWORD%"
if "%LANGFLOW_SUPERUSER%"=="" if not "%OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER%"=="" set "LANGFLOW_SUPERUSER=%OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER%"
if "%LANGFLOW_SUPERUSER_PASSWORD%"=="" if not "%OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER_PASSWORD%"=="" set "LANGFLOW_SUPERUSER_PASSWORD=%OPENCLAUDE_OPENRAG_LANGFLOW_SUPERUSER_PASSWORD%"
if "%FRONTEND_PORT%"=="" if not "%OPENCLAUDE_OPENRAG_FRONTEND_PORT%"=="" set "FRONTEND_PORT=%OPENCLAUDE_OPENRAG_FRONTEND_PORT%"
if "%LANGFLOW_PORT%"=="" if not "%OPENCLAUDE_OPENRAG_LANGFLOW_PORT%"=="" set "LANGFLOW_PORT=%OPENCLAUDE_OPENRAG_LANGFLOW_PORT%"
if "%LLM_PROVIDER%"=="" if not "%OPENCLAUDE_OPENRAG_LLM_PROVIDER%"=="" set "LLM_PROVIDER=%OPENCLAUDE_OPENRAG_LLM_PROVIDER%"
if "%LLM_MODEL%"=="" if not "%OPENCLAUDE_OPENRAG_LLM_MODEL%"=="" set "LLM_MODEL=%OPENCLAUDE_OPENRAG_LLM_MODEL%"
if "%EMBEDDING_PROVIDER%"=="" if not "%OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER%"=="" set "EMBEDDING_PROVIDER=%OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER%"
if "%EMBEDDING_MODEL%"=="" if not "%OPENCLAUDE_OPENRAG_EMBEDDING_MODEL%"=="" set "EMBEDDING_MODEL=%OPENCLAUDE_OPENRAG_EMBEDDING_MODEL%"
if "%OLLAMA_ENDPOINT%"=="" if not "%OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT%"=="" set "OLLAMA_ENDPOINT=%OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONLEGACYWINDOWSSTDIO=0"
set "NO_COLOR=1"
set "RICH_NO_COLOR=1"
set "FORCE_COLOR=0"
set "TERM=dumb"
if not exist "%OPENCLAUDE_OPENRAG_REPO_DIR%\.git" (
  git clone --depth 1 https://github.com/langflow-ai/openrag.git "%OPENCLAUDE_OPENRAG_REPO_DIR%"
)

cd /d "%OPENCLAUDE_OPENRAG_REPO_DIR%"
uv sync --python 3.13
powershell.exe -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%OPENCLAUDE_OPENRAG_DOCLING_PORT%/docs' -TimeoutSec 3 > $null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  uv run --python 3.13 python scripts/docling_ctl.py start --port %OPENCLAUDE_OPENRAG_DOCLING_PORT%
) else (
  echo docling-serve already listening on port %OPENCLAUDE_OPENRAG_DOCLING_PORT%
)
(
  echo services:
  echo   opensearch:
  echo     restart: unless-stopped
  echo     environment:
  echo       - OPENSEARCH_PASSWORD=${OPENSEARCH_PASSWORD}
  echo   dashboards:
  echo     restart: unless-stopped
  echo   openrag-backend:
  echo     restart: unless-stopped
  echo   openrag-frontend:
  echo     restart: unless-stopped
  echo   langflow:
  echo     restart: unless-stopped
) > docker-compose.openclaude.override.yml
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml up -d
