@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0\..\.."
set "ROOT_DIR=%CD%"

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
if not "%OPENCLAUDE_OPENRAG_LLM_PROVIDER%"=="" set "LLM_PROVIDER=%OPENCLAUDE_OPENRAG_LLM_PROVIDER%"
if "%LLM_PROVIDER%"=="" set "LLM_PROVIDER=ollama"
if not "%OPENCLAUDE_OPENRAG_LLM_MODEL%"=="" set "LLM_MODEL=%OPENCLAUDE_OPENRAG_LLM_MODEL%"
if "%LLM_MODEL%"=="" set "LLM_MODEL=qwen3:1.7b"
if not "%OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER%"=="" set "EMBEDDING_PROVIDER=%OPENCLAUDE_OPENRAG_EMBEDDING_PROVIDER%"
if "%EMBEDDING_PROVIDER%"=="" set "EMBEDDING_PROVIDER=ollama"
if not "%OPENCLAUDE_OPENRAG_EMBEDDING_MODEL%"=="" set "EMBEDDING_MODEL=%OPENCLAUDE_OPENRAG_EMBEDDING_MODEL%"
if "%EMBEDDING_MODEL%"=="" set "EMBEDDING_MODEL=nomic-embed-text:latest"
if not "%OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT%"=="" set "OLLAMA_ENDPOINT=%OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT%"
if "%OLLAMA_ENDPOINT%"=="" set "OLLAMA_ENDPOINT=http://host.docker.internal:11434"
if not "%OPENCLAUDE_OPENRAG_VERSION%"=="" set "OPENRAG_VERSION=%OPENCLAUDE_OPENRAG_VERSION%"
if "%OPENRAG_VERSION%"=="" set "OPENRAG_VERSION=0.5.1"
if /I "%LLM_PROVIDER%"=="ollama" set "OPENAI_API_KEY="
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONLEGACYWINDOWSSTDIO=0"
set "NO_COLOR=1"
set "RICH_NO_COLOR=1"
set "FORCE_COLOR=0"
set "TERM=dumb"
if not exist "%OPENCLAUDE_OPENRAG_REPO_DIR%\.git" (
  git clone --depth 1 --branch "v%OPENRAG_VERSION%" https://github.com/langflow-ai/openrag.git "%OPENCLAUDE_OPENRAG_REPO_DIR%"
  if errorlevel 1 exit /b %errorlevel%
)
git -C "%OPENCLAUDE_OPENRAG_REPO_DIR%" diff --quiet
if errorlevel 1 (
  echo OpenRAG has tracked local changes. Commit or restore them before production deployment.
  exit /b 1
)
git -C "%OPENCLAUDE_OPENRAG_REPO_DIR%" diff --cached --quiet
if errorlevel 1 (
  echo OpenRAG has staged local changes. Commit or restore them before production deployment.
  exit /b 1
)
git -C "%OPENCLAUDE_OPENRAG_REPO_DIR%" rev-parse --verify --quiet "refs/tags/v%OPENRAG_VERSION%" >nul
if errorlevel 1 (
  git -C "%OPENCLAUDE_OPENRAG_REPO_DIR%" fetch --depth 1 origin tag "v%OPENRAG_VERSION%"
  if errorlevel 1 exit /b %errorlevel%
)
git -C "%OPENCLAUDE_OPENRAG_REPO_DIR%" checkout --detach "v%OPENRAG_VERSION%"
if errorlevel 1 exit /b %errorlevel%

cd /d "%OPENCLAUDE_OPENRAG_REPO_DIR%"
uv sync --python 3.13
if errorlevel 1 exit /b %errorlevel%
uv run --python 3.13 python "%ROOT_DIR%\scripts\release\sync-openrag-config.py" "%OPENCLAUDE_OPENRAG_REPO_DIR%\config\config.yaml"
if errorlevel 1 exit /b %errorlevel%
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
  echo     ports: !override
  echo       - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:9200:9200"
  echo       - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:9600:9600"
  echo     environment:
  echo       - OPENSEARCH_PASSWORD=${OPENSEARCH_PASSWORD}
  echo   dashboards:
  echo     restart: unless-stopped
  echo     ports: !override
  echo       - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:5601:5601"
  echo   openrag-backend:
  echo     restart: unless-stopped
  echo     environment:
  echo       DO_NOT_TRACK: "1"
  echo       LLM_PROVIDER: "${LLM_PROVIDER}"
  echo       LLM_MODEL: "${LLM_MODEL}"
  echo       EMBEDDING_PROVIDER: "${EMBEDDING_PROVIDER}"
  echo       EMBEDDING_MODEL: "${EMBEDDING_MODEL}"
  echo       OLLAMA_ENDPOINT: "${OLLAMA_ENDPOINT}"
  echo       OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
  echo   openrag-frontend:
  echo     restart: unless-stopped
  echo     ports: !override
  echo       - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:${FRONTEND_PORT:-3000}:3000"
  echo   langflow:
  echo     restart: unless-stopped
  echo     environment:
  echo       OPENAI_API_KEY: "${OPENAI_API_KEY:-}"
  echo       OLLAMA_BASE_URL: "${OLLAMA_ENDPOINT}"
  echo       SELECTED_EMBEDDING_MODEL: "${EMBEDDING_MODEL}"
  echo     ports: !override
  echo       - "${OPENCLAUDE_OPENRAG_BIND_ADDRESS:-127.0.0.1}:${LANGFLOW_PORT:-7860}:7860"
) > docker-compose.openclaude.override.yml
if "%OPENCLAUDE_OPENRAG_BUILD_LANGFLOW%"=="1" (
  docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml build langflow
  if errorlevel 1 exit /b %errorlevel%
)
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml pull opensearch openrag-backend openrag-frontend langflow
if errorlevel 1 exit /b %errorlevel%
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml up -d --no-build
if errorlevel 1 exit /b %errorlevel%
docker compose -f docker-compose.yml -f docker-compose.openclaude.override.yml restart openrag-backend
