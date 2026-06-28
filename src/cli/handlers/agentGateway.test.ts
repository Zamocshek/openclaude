import { describe, expect, test } from 'bun:test'
import { getDefaultAgentGatewayConfig } from '../../services/agentGateway/config.js'
import {
  buildAgentGatewayAuthLoginConfig,
  buildAgentGatewayConfiguredConfig,
  buildAgentGatewayHeaders,
  buildCodexGatewayProfileFile,
  buildCodexGatewayProviderProfileInput,
  extractResponsesText,
  getAgentGatewayApiUrl,
} from './agentGateway.js'

describe('agent gateway CLI helpers', () => {
  test('builds gateway API URLs from config and trims /v1 overrides', () => {
    const config = getDefaultAgentGatewayConfig()

    expect(getAgentGatewayApiUrl(config, '/v1/responses')).toBe(
      'http://127.0.0.1:8642/v1/responses',
    )
    expect(
      getAgentGatewayApiUrl(config, '/health', 'http://localhost:9999/v1'),
    ).toBe('http://localhost:9999/health')
  })

  test('adds bearer auth only when an API key is available', () => {
    expect(buildAgentGatewayHeaders()).toEqual({
      'Content-Type': 'application/json',
    })
    expect(buildAgentGatewayHeaders('secret')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    })
  })

  test('extracts assistant text from Responses API output', () => {
    expect(
      extractResponsesText({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'hello' }],
          },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'world' }],
          },
        ],
      }),
    ).toBe('hello\nworld')
  })

  test('login config enables API, generates auth, and applies runner options', () => {
    const config = getDefaultAgentGatewayConfig()
    const next = buildAgentGatewayAuthLoginConfig(
      config,
      {
        host: '0.0.0.0',
        port: '8750',
        model: 'custom-agent',
        cwd: 'C:\\work',
        permissionMode: 'bypassPermissions',
        maxTurns: '5',
        timeoutMs: '120000',
        corsOrigins: 'http://localhost:3000,https://example.com',
      },
      'ocag_test_key',
    )

    expect(next.api).toMatchObject({
      enabled: true,
      host: '0.0.0.0',
      port: 8750,
      modelName: 'custom-agent',
      apiKey: 'ocag_test_key',
      corsOrigins: ['http://localhost:3000', 'https://example.com'],
    })
    expect(next.runner).toMatchObject({
      cwd: 'C:\\work',
      permissionMode: 'bypassPermissions',
      maxTurns: 5,
      timeoutMs: 120000,
    })
  })

  test('configure updates Telegram, cron, and tool lists without rotating auth', () => {
    const config = {
      ...getDefaultAgentGatewayConfig(),
      api: {
        ...getDefaultAgentGatewayConfig().api,
        apiKey: 'ocag_existing',
      },
    }

    const next = buildAgentGatewayConfiguredConfig(config, {
      enableTelegram: true,
      telegramBotToken: '123:bot',
      telegramHomeChatId: '42',
      telegramAllowedChatIds: '42,43',
      telegramAllowedUserIds: '7 8',
      enableCron: true,
      disableTools: true,
      tools: 'Bash,Read Edit',
      disallowedTools: 'WebSearch',
      disableMemory: true,
      disableUserProfile: true,
      memoryApproval: true,
    })

    expect(next.api.apiKey).toBe('ocag_existing')
    expect(next.telegram).toMatchObject({
      enabled: true,
      botToken: '123:bot',
      homeChatId: '42',
      allowedChatIds: ['42', '43'],
      allowedUserIds: ['7', '8'],
    })
    expect(next.cron.enabled).toBe(true)
    expect(next.memory).toMatchObject({
      enabled: false,
      userProfileEnabled: false,
      writeApproval: true,
    })
    expect(next.runner.availableTools).toEqual(['Bash', 'Read', 'Edit'])
    expect(next.runner.disableTools).toBe(false)
    expect(next.runner.disallowedTools).toEqual(['WebSearch'])
  })

  test('builds Codex OAuth provider profile defaults for gateway runners', () => {
    expect(buildCodexGatewayProviderProfileInput('codexspark')).toEqual({
      provider: 'openai',
      name: 'Codex OAuth',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexspark',
      apiKey: '',
    })

    const profileFile = buildCodexGatewayProfileFile(
      {
        accessToken: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_test',
          },
        }),
        accountId: 'acct_test',
      },
      'codexspark',
    )
    expect(profileFile?.profile).toBe('codex')
    expect(profileFile?.env).toMatchObject({
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexspark',
      CHATGPT_ACCOUNT_ID: 'acct_test',
      CODEX_CREDENTIAL_SOURCE: 'oauth',
    })
  })
})

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.')
}
