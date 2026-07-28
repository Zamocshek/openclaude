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
COPY scripts/ scripts/
COPY bin/ bin/
COPY tsconfig.json ./

# Build the CLI bundle
RUN bun run build

# ---- runtime stage ----
FROM node:22-slim@sha256:f3a68cf41a855d227d1b0ab832bed9749469ef38cf4f58182fb8c893bc462383

WORKDIR /app

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
COPY scripts/release/openrag-mcp-bridge.cjs scripts/release/openrag-mcp-bridge.cjs
COPY scripts/release/camofox-mcp-bridge.cjs scripts/release/camofox-mcp-bridge.cjs
COPY scripts/release/camofox-control.mjs scripts/release/camofox-control.mjs
COPY scripts/release/hindsight-mcp-bridge.cjs scripts/release/hindsight-mcp-bridge.cjs
COPY scripts/release/hindsight-control.mjs scripts/release/hindsight-control.mjs
COPY scripts/release/test-hindsight-mcp-bridge.cjs scripts/release/test-hindsight-mcp-bridge.cjs
COPY scripts/run-project-mcp.cjs scripts/run-project-mcp.cjs
COPY scripts/run-npx-mcp.cjs scripts/run-npx-mcp.cjs

# Install git and ripgrep - many CLI tool operations depend on them
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gosu \
      ripgrep \
      python3 \
      python3-pip \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Keep runtime script edits after the expensive system-package layer so MCP
# changes do not trigger a fresh apt install during every Docker rebuild.
COPY scripts/gateway-control-mcp.mjs scripts/gateway-control-mcp.mjs

ARG UV_VERSION=0.11.32
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
    && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

COPY --from=build /app/scripts/release/test-research-mcp.cjs scripts/release/test-research-mcp.cjs
COPY scripts/release/check-base-mcp.cjs scripts/release/check-base-mcp.cjs

RUN chmod +x scripts/docker-entrypoint.sh \
    && ln -sf /app/node_modules/@colbymchenry/codegraph/npm-shim.js /usr/local/bin/codegraph \
    && ln -sf /app/node_modules/mcp-searxng/dist/cli.js /usr/local/bin/mcp-searxng \
    && ln -sf /app/node_modules/@upstash/context7-mcp/dist/index.js /usr/local/bin/context7-mcp \
    && mkdir -p /home/node/.openclaude \
    && chown -R node:node /home/node/.openclaude

EXPOSE 8642 8080

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
