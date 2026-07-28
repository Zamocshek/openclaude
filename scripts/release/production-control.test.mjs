import { describe, expect, test } from 'bun:test'
import { parseEnv, validateProductionEnv } from './production-control.mjs'

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
      OPENCLAUDE_DOCKER_TELEGRAM_ENABLED: '1',
      OPENCLAUDE_DOCKER_TELEGRAM_BOT_TOKEN: 'configured',
      OPENCLAUDE_DOCKER_TELEGRAM_ALLOWED_USER_IDS: '5117562403',
      OPENCLAUDE_OPEN_WEBUI_BIND_ADDRESS: '127.0.0.1',
    })).toEqual([])
  })
})
