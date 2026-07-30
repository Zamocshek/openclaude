import { describe, expect, test } from 'bun:test'
import {
  REQUIRED_BASE_MCP_SERVERS,
  PRODUCTION_BUILD_SERVICES,
  getOpenRagVerificationUrls,
  parseEnv,
  validateRequiredBaseMcpServers,
  validateProductionEnv,
  validateRequiredTelegramCapabilities,
} from './production-control.mjs'

describe('production control', () => {
  test('parses quoted dotenv values without exposing comments', () => {
    expect(parseEnv('A=1\nB="two words"\n# ignored\n')).toEqual({
      A: '1',
      B: 'two words',
    })
  })

  test('rejects weak keys, public binds, and an unbounded Telegram bot', () => {
    const errors = validateProductionEnv({
      OPENCLAUDE_AGENT_API_KEY: 'change-me',
      OPENCLAUDE_AGENT_INFERENCE_API_KEY: '',
      OMNIROUTE_API_KEY: 'sk_omniroute',
      OPENCLAUDE_ROUTER_AUTO_AUTH: '1',
      SESSION_SECRET: '',
      JWT_SIGNING_KEY: '',
      OPENRAG_ENCRYPTION_KEY: '',
      OPENCLAUDE_DOCKER_TELEGRAM_ENABLED: '1',
      OPENCLAUDE_DOCKER_TELEGRAM_BOT_TOKEN: 'configured',
      OPENCLAUDE_OPEN_WEBUI_BIND_ADDRESS: '0.0.0.0',
    })
    expect(errors.length).toBeGreaterThanOrEqual(5)
  })

  test('accepts a local-only allowlisted production environment', () => {
    expect(validateProductionEnv({
      OPENCLAUDE_AGENT_API_KEY: 'admin-secret',
      OPENCLAUDE_AGENT_INFERENCE_API_KEY: 'inference-secret',
      OPENCLAUDE_AGENT_WORKER_1_API_KEY: 'worker-one-secret',
      OPENCLAUDE_AGENT_WORKER_2_API_KEY: 'worker-two-secret',
      OMNIROUTE_API_KEY: 'omni-secret',
      OMNIROUTE_INITIAL_PASSWORD: 'initial-password',
      OMNIROUTE_STORAGE_ENCRYPTION_KEY: 'storage-secret',
      OMNIROUTE_JWT_SECRET: 'jwt-omni-secret',
      OMNIROUTE_API_KEY_SECRET: 'api-key-secret',
      OMNIROUTE_WS_BRIDGE_SECRET: 'bridge-secret',
      SEARXNG_SECRET: 'searxng-secret',
      OPENCLAUDE_ROUTER_AUTO_AUTH: '0',
      SESSION_SECRET: 'session-secret',
      JWT_SIGNING_KEY: 'jwt-secret',
      OPENRAG_ENCRYPTION_KEY: 'encryption-secret',
      PENTEST_GATEWAY_AUTH_TOKEN: 'pentest-gateway-secret',
      OPENCLAUDE_DOCKER_TELEGRAM_ENABLED: '1',
      OPENCLAUDE_DOCKER_TELEGRAM_BOT_TOKEN: 'configured',
      OPENCLAUDE_DOCKER_TELEGRAM_ALLOWED_USER_IDS: '5117562403',
      OPENCLAUDE_OPEN_WEBUI_BIND_ADDRESS: '127.0.0.1',
    })).toEqual([])
  })

  test('requires the Telegram MCP image in every production build', () => {
    expect(PRODUCTION_BUILD_SERVICES).toContain('openclaude-agent')
    expect(PRODUCTION_BUILD_SERVICES).toContain('telegram-mcp')
  })

  test('requires every base MCP server to remain enabled', () => {
    const servers = REQUIRED_BASE_MCP_SERVERS.map(name => ({
      name,
      enabled: true,
    }))
    expect(validateRequiredBaseMcpServers(servers)).toEqual([])
    expect(validateRequiredBaseMcpServers(
      servers.filter(server => server.name !== 'hindsight'),
    )).toContain('required base MCP server is missing: hindsight')
    expect(validateRequiredBaseMcpServers(
      servers.map(server =>
        server.name === 'searxng' ? { ...server, enabled: false } : server),
    )).toContain('required base MCP server is disabled: searxng')
  })

  test('checks Docling only when the OpenRAG stack explicitly publishes it', () => {
    expect(getOpenRagVerificationUrls({})).toEqual([
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:7860/health',
    ])
    expect(getOpenRagVerificationUrls({
      OPENCLAUDE_OPENRAG_FRONTEND_PORT: '3100',
      OPENCLAUDE_OPENRAG_LANGFLOW_PORT: '7861',
      OPENCLAUDE_OPENRAG_DOCLING_PORT: '5001',
    })).toEqual([
      'http://127.0.0.1:3100/',
      'http://127.0.0.1:7861/health',
      'http://127.0.0.1:5001/docs',
    ])
  })

  test('accepts an enabled Telegram MCP with all bundled skills', () => {
    expect(validateRequiredTelegramCapabilities([
      { name: 'pentest', enabled: true },
      { name: 'telegram-mcp-operations', enabled: true },
      { name: 'maton-api-gateway', enabled: true },
      { name: 'vpromotions', enabled: true },
    ], [{
      name: 'telegram-mcp',
      enabled: true,
      transport: 'http',
      target: 'http://telegram-mcp:8766/mcp',
    }])).toEqual([])
  })

  test('rejects missing or disabled Telegram capabilities', () => {
    const errors = validateRequiredTelegramCapabilities([
      { name: 'telegram-mcp-operations', enabled: false },
    ], [])
    expect(errors).toContain(
      'required Telegram skill is disabled: telegram-mcp-operations',
    )
    expect(errors).toContain('required MCP server is missing: telegram-mcp')
    expect(errors.length).toBe(5)
  })
})
