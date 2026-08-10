FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY src/ src/

ENV CAPABILITY_ROUTER_HOST=0.0.0.0 \
    CAPABILITY_ROUTER_PORT=8768 \
    CAPABILITY_ROUTER_STATE=/data/state.json \
    CAPABILITY_ROUTER_SKILL_STORE=/data/skills \
    CAPABILITY_ROUTER_WORKSPACE_ROOT=/workspace \
    CAPABILITY_ROUTER_REGISTRY=/workspace/capability-registry.json \
    CAPABILITY_ROUTER_MCP_CONFIG=/workspace/.mcp.json

VOLUME ["/data"]
EXPOSE 8768
CMD ["node", "src/http.mjs"]
