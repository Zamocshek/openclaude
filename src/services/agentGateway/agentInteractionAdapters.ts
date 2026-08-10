import {
  createAgentInteraction,
  validateAgentInteractionInput,
  type AgentRunPendingInteraction,
  type StoredAgentInteraction,
} from './agentInteractions.js'
import {
  submitTelegramMcpAuthorization,
  TELEGRAM_SESSION_AUTH_HANDLER,
} from './telegramMcpAuth.js'

export type AgentInteractionPrivateState = Record<string, string>

export type AgentInteractionContinuationResult =
  | { status: 'unsupported' }
  | { status: 'completed'; message: string }
  | { status: 'retry'; message: string }
  | { status: 'failed'; message: string }
  | {
      status: 'advanced'
      message: string
      interaction: AgentRunPendingInteraction
      privateState?: AgentInteractionPrivateState
    }

export type AgentInteractionAdapter = {
  handler: string
  continue: (
    stored: StoredAgentInteraction<AgentInteractionPrivateState>,
    value: string,
  ) => Promise<AgentInteractionContinuationResult>
}

const adapters = new Map<string, AgentInteractionAdapter>()

registerAgentInteractionAdapter({
  handler: TELEGRAM_SESSION_AUTH_HANDLER,
  continue: continueTelegramSessionAuthorization,
})

export function registerAgentInteractionAdapter(
  adapter: AgentInteractionAdapter,
): void {
  const handler = adapter.handler.trim()
  if (!handler) throw new Error('Agent interaction adapter handler is required')
  if (adapters.has(handler)) {
    throw new Error(`Agent interaction adapter '${handler}' is already registered`)
  }
  adapters.set(handler, { ...adapter, handler })
}

export function hasAgentInteractionAdapter(handler: string): boolean {
  return adapters.has(handler)
}

export async function continueAgentInteraction(
  stored: StoredAgentInteraction<AgentInteractionPrivateState>,
  rawValue: string,
): Promise<AgentInteractionContinuationResult> {
  const adapter = adapters.get(stored.interaction.handler)
  if (!adapter) return { status: 'unsupported' }
  const validated = validateAgentInteractionInput(stored.interaction.input, rawValue)
  if (!validated.ok) {
    return {
      status: 'retry',
      message: 'message' in validated
        ? validated.message
        : stored.interaction.input.prompt,
    }
  }
  return adapter.continue(stored, validated.value)
}

async function continueTelegramSessionAuthorization(
  stored: StoredAgentInteraction<AgentInteractionPrivateState>,
  value: string,
): Promise<AgentInteractionContinuationResult> {
  const { interaction } = stored
  const sessionName = typeof interaction.state.sessionName === 'string'
    ? interaction.state.sessionName
    : ''
  if (!sessionName) {
    return {
      status: 'failed',
      message: 'The Telegram authorization interaction has invalid state. Start it again.',
    }
  }

  const result = await submitTelegramMcpAuthorization({
    sessionName,
    code: interaction.stage === 'code' ? value : stored.privateState?.code || '',
    ...(interaction.stage === 'password' ? { password: value } : {}),
  })
  if (result.status === 'password_required') {
    return {
      status: 'advanced',
      message: 'Telegram accepted the code and requires the account 2FA password. Send it in the next message; it will not be added to the agent transcript or persistent memory.',
      interaction: createAgentInteraction({
        id: interaction.id,
        handler: interaction.handler,
        stage: 'password',
        prompt: 'Send the Telegram account 2FA password.',
        input: {
          name: 'password',
          kind: 'secret',
          prompt: 'Send the Telegram account 2FA password.',
        },
        state: interaction.state,
        sourceTool: interaction.sourceTool,
        expiresInMs: interaction.expiresInMs,
      }),
      privateState: { code: value },
    }
  }
  if (result.status === 'authorized') {
    return {
      status: 'completed',
      message: result.verified
        ? 'Telegram session authorized, saved, and verified in the active MCP account pool.'
        : 'Telegram session authorized and saved. The follow-up health probe was inconclusive; check the account before bulk actions.',
    }
  }
  if (result.status === 'invalid_password') {
    return {
      status: 'retry',
      message: 'The Telegram 2FA password was rejected. Send the correct password or cancel this interaction.',
    }
  }
  const message = result.status === 'expired_code'
    ? 'The Telegram confirmation code expired. Start the login again to request a new code.'
    : result.status === 'invalid_code'
      ? 'The Telegram confirmation code was rejected. Start the login again before retrying.'
      : result.status === 'pending_missing'
        ? 'The Telegram MCP process no longer has this pending login. Start the authorization again.'
        : 'Telegram authorization did not complete. Start the login again; no password or code was persisted.'
  return { status: 'failed', message }
}
