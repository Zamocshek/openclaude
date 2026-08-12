# ---- production dependencies ----
# Keep this stage independent from source files so ordinary TypeScript changes
# do not reinstall the complete MCP/runtime dependency tree.
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383 AS production-deps

RUN npm install -g bun@1.3.12

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# ---- build stage ----
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383 AS build

# Install Bun
RUN npm install -g bun@1.3.12

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY src/ src/
COPY scripts/build.ts scripts/no-telemetry-plugin.ts scripts/
COPY bin/ bin/
COPY tsconfig.json ./

# Build the CLI bundle
RUN bun run build

# ---- runtime stage ----
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383

WORKDIR /app

# System and Python toolchains are independent of application source. Keep
# them before app COPY layers so ordinary code edits retain the expensive cache.
RUN apt-get update && apt-get install -y --no-install-recommends \
      adb \
      ca-certificates \
      curl \
      dnsutils \
      ffmpeg \
      git \
      gosu \
      iputils-ping \
      jq \
      libgomp1 \
      netcat-openbsd \
      nmap \
      openssh-client \
      procps \
      ripgrep \
      python3 \
      python3-pip \
      python3-venv \
      sshpass \
      whois \
    && rm -rf /var/lib/apt/lists/*

COPY integrations/local-transcription/requirements.txt /tmp/openclaude-stt-requirements.txt
RUN python3 -m venv /opt/openclaude-stt \
    && /opt/openclaude-stt/bin/pip install --no-cache-dir \
      -r /tmp/openclaude-stt-requirements.txt \
    && rm -f /tmp/openclaude-stt-requirements.txt

ARG UV_VERSION=0.11.32
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
    && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv python install 3.13 \
    && uv tool install --python 3.13 "android-mcp==0.2.0" \
    && uv tool install --python 3.13 \
      "qwen-mm-plugins[core,api] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@8d6ea5a1f658260743307c52c2024ec87599fa48"

# Copy only what's needed to run
COPY --from=build /app/dist/cli.mjs dist/cli.mjs
COPY --from=build /app/bin/ bin/
COPY --from=production-deps /app/node_modules/ node_modules/
COPY --from=build /app/package.json package.json
COPY README.md ./
COPY .mcp.json .mcp.json
COPY scripts/docker-entrypoint.sh scripts/docker-entrypoint.sh
COPY scripts/codegraph-mcp.cjs scripts/codegraph-mcp.cjs
COPY scripts/mcp-router-launcher.cjs scripts/mcp-router-launcher.cjs
COPY scripts/release/lightrag-mcp-bridge.cjs scripts/release/lightrag-mcp-bridge.cjs
COPY scripts/release/test-lightrag-mcp-bridge.cjs scripts/release/test-lightrag-mcp-bridge.cjs
COPY scripts/release/camofox-mcp-bridge.cjs scripts/release/camofox-mcp-bridge.cjs
COPY scripts/release/browser-model-profiles.cjs scripts/release/browser-model-profiles.cjs
COPY scripts/release/camofox-control.mjs scripts/release/camofox-control.mjs
COPY scripts/release/hindsight-mcp-bridge.cjs scripts/release/hindsight-mcp-bridge.cjs
COPY scripts/release/hindsight-control.mjs scripts/release/hindsight-control.mjs
COPY scripts/release/test-hindsight-mcp-bridge.cjs scripts/release/test-hindsight-mcp-bridge.cjs
COPY scripts/run-project-mcp.cjs scripts/run-project-mcp.cjs
COPY scripts/capability-router-launcher.cjs scripts/capability-router-launcher.cjs
COPY scripts/run-npx-mcp.cjs scripts/run-npx-mcp.cjs
COPY scripts/pentest-mcp.cjs scripts/pentest-mcp.cjs

# Keep runtime script edits after the expensive system-package layer so MCP
# changes do not trigger a fresh apt install during every Docker rebuild.
COPY scripts/gateway-control-mcp.mjs scripts/gateway-control-mcp.mjs
COPY scripts/android-mcp-launcher.cjs scripts/android-mcp-launcher.cjs
COPY scripts/qwen-mm-launcher.cjs scripts/qwen-mm-launcher.cjs
COPY scripts/register-artifact.mjs scripts/register-artifact.mjs

COPY scripts/release/test-research-mcp.cjs scripts/release/test-research-mcp.cjs
COPY scripts/release/test-pentest-mcp.cjs scripts/release/test-pentest-mcp.cjs
COPY scripts/release/check-base-mcp.cjs scripts/release/check-base-mcp.cjs
COPY scripts/release/test-android-mcp.cjs scripts/release/test-android-mcp.cjs
COPY scripts/release/ssh-doctor.mjs scripts/release/ssh-doctor.mjs
COPY scripts/release/ssh-access.sh scripts/release/ssh-access.sh
COPY scripts/release/vps-ssh-bootstrap.sh scripts/release/vps-ssh-bootstrap.sh
COPY scripts/agent-migration/ scripts/agent-migration/
COPY integrations/local-transcription/ integrations/local-transcription/
COPY integrations/qwen-mm/ integrations/qwen-mm/
COPY capability-registry.json capability-registry.json
COPY packages/capability-router/ packages/capability-router/
COPY skills/agent-migration/ skills/agent-migration/
COPY skills/server-access/ skills/server-access/

RUN chmod +x scripts/docker-entrypoint.sh \
    && chmod +x scripts/android-mcp-launcher.cjs \
    && chmod +x scripts/register-artifact.mjs \
    && chmod +x scripts/release/ssh-doctor.mjs \
    && chmod +x scripts/release/ssh-access.sh \
    && chmod +x scripts/release/vps-ssh-bootstrap.sh \
    && chmod +x scripts/agent-migration/cli.mjs \
    && chmod +x integrations/local-transcription/transcribe.py \
    && chmod +x integrations/qwen-mm/local_server.py \
    && chmod +x scripts/qwen-mm-launcher.cjs \
    && ln -sf /app/scripts/release/ssh-doctor.mjs /usr/local/bin/openclaude-ssh-doctor \
    && ln -sf /app/scripts/release/ssh-access.sh /usr/local/bin/openclaude-ssh \
    && ln -sf /app/scripts/agent-migration/cli.mjs /usr/local/bin/openclaude-migrate \
    && ln -sf /app/scripts/register-artifact.mjs /usr/local/bin/openclaude-artifact \
    && ln -sf /app/integrations/local-transcription/transcribe.py /usr/local/bin/openclaude-transcribe \
    && ln -sf /app/node_modules/@colbymchenry/codegraph/npm-shim.js /usr/local/bin/codegraph \
    && ln -sf /app/node_modules/mcp-searxng/dist/cli.js /usr/local/bin/mcp-searxng \
    && ln -sf /app/node_modules/@upstash/context7-mcp/dist/index.js /usr/local/bin/context7-mcp \
    && mkdir -p /home/node/.openclaude \
    && chown -R node:node /home/node/.openclaude

EXPOSE 8642 8080

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
