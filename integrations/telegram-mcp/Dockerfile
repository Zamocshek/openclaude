# Use a supported Python runtime. Slim avoids Alpine musl edge cases with wheels.
FROM python:3.12-slim

# Set the working directory in the container
WORKDIR /app

# Prevent Python from writing pyc files to disc
ENV PYTHONDONTWRITEBYTECODE=1
# Ensure Python output is sent straight to terminal (useful for logs)
ENV PYTHONUNBUFFERED=1

# Keep runtime image small and predictable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the exact dependency graph committed with the integration.
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir uv==0.9.27 \
    && uv sync --frozen --no-dev --no-install-project
ENV PATH="/app/.venv/bin:${PATH}"

# Copy application code needed by both MCP and the web console.
COPY main.py account_admin.py assistant_memory.py content_workflow.py maton_client.py operator_config.py post_formatting.py runtime_config.py web_app.py session_string_generator.py stat_report_renderer.py vpromotions_client.py ./
COPY README.md LICENSE ./

# Create a non-root user and switch to it
RUN useradd --create-home --shell /bin/bash appuser \
    && mkdir -p /data/session /data/logs \
    && chown -R appuser:appuser /app /data
USER appuser

# Define environment variables needed by the application
# These should be provided at runtime, not hardcoded (especially secrets)
ENV TELEGRAM_API_ID=""
ENV TELEGRAM_API_HASH=""
ENV TELEGRAM_MCP_CONFIG_DIR="/app"
ENV TELEGRAM_MCP_DATA_DIR="/data"
ENV TELEGRAM_MCP_SESSION_DIR="/data/session"
ENV TELEGRAM_MCP_LOG_FILE="/data/logs/mcp_errors.log"
ENV TELEGRAM_MCP_ASSISTANT_DB="/data/session/assistant_memory.sqlite3"
ENV TELEGRAM_MCP_CONTENT_DB="/data/session/content_workflow.sqlite3"
# Specify one of the following at runtime:
# Default session filename
ENV TELEGRAM_SESSION_NAME="telegram_mcp_session"
# Or provide the session string directly
ENV TELEGRAM_SESSION_STRING=""
ENV TELEGRAM_MCP_WEB_HOST="0.0.0.0"
ENV TELEGRAM_MCP_WEB_PORT="8765"
ENV TELEGRAM_MCP_TRANSPORT="stdio"
ENV TELEGRAM_MCP_HOST="0.0.0.0"
ENV TELEGRAM_MCP_PORT="8000"
ENV VPROMOTIONS_API_URL="https://vpromotions.ru/api/v2"
ENV VPROMOTIONS_TIMEOUT="30"
ENV MATON_API_URL="https://api.maton.ai"
ENV MATON_TIMEOUT="30"

VOLUME ["/data"]
EXPOSE 8000 8765 8766

# Define the command to run the application
CMD ["python", "main.py"]
