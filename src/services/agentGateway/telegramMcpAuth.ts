export type TelegramMcpAuthStatus =
  | 'authorized'
  | 'password_required'
  | 'invalid_code'
  | 'expired_code'
  | 'invalid_password'
  | 'pending_missing'
  | 'failed'

export const TELEGRAM_SESSION_AUTH_HANDLER = 'telegram.session.authorize'

export type TelegramMcpAuthResult = {
  status: TelegramMcpAuthStatus
  verified: boolean
}

type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>

export async function submitTelegramMcpAuthorization(
  input: {
    sessionName: string
    code: string
    password?: string
  },
  callTool: CallTool = callTelegramMcpTool,
): Promise<TelegramMcpAuthResult> {
  const output = await callTool('authorize_complete', {
    session_name: input.sessionName,
    code: input.code,
    ...(input.password === undefined ? {} : { password: input.password }),
  })
  if (/2FA password required/iu.test(output)) {
    return { status: 'password_required', verified: false }
  }
  if (/No pending authorization/iu.test(output)) {
    return { status: 'pending_missing', verified: false }
  }
  if (/(?:PHONE_CODE_EXPIRED|code[^\n]*expired)/iu.test(output)) {
    return { status: 'expired_code', verified: false }
  }
  if (/(?:PHONE_CODE_INVALID|invalid[^\n]*code)/iu.test(output)) {
    return { status: 'invalid_code', verified: false }
  }
  if (/(?:PASSWORD_HASH_INVALID|invalid[^\n]*password)/iu.test(output)) {
    return { status: 'invalid_password', verified: false }
  }
  if (!/(?:Authorized as|saved and added to active pool)/iu.test(output)) {
    return { status: 'failed', verified: false }
  }

  const verification = await callTool('check_account', {
    account_id: input.sessionName,
  })
  const explicitlyFailed = /(?:\bnot\s+authorized\b|\bunauthorized\b|\bnot\s+healthy\b|\bunhealthy\b|\bfailed\b|\berror\b)/iu
    .test(verification)
  return {
    status: 'authorized',
    verified: !explicitlyFailed
      && /(?:\bauthorized\b|\bhealthy\b|status:\s*ok\b|\bOK\b)/iu.test(verification),
  }
}

async function callTelegramMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  const url = process.env.OPENCLAUDE_TELEGRAM_MCP_URL
    || 'http://telegram-mcp:8766/mcp'
  const client = new Client({
    name: 'openclaude-telegram-auth-continuation',
    version: '1.0.0',
  })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url)),
      { signal: AbortSignal.timeout(20_000) },
    )
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { signal: AbortSignal.timeout(30_000) },
    )
    if (result.isError) return 'Authorization failed: MCP tool error.'
    const content = Array.isArray(result.content) ? result.content : []
    return content
      .map(block => (
        block && typeof block === 'object' && block.type === 'text'
          ? String(block.text || '')
          : ''
      ))
      .filter(Boolean)
      .join('\n')
  } finally {
    await client.close().catch(() => {})
  }
}
