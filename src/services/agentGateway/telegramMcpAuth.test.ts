import { describe, expect, test } from 'bun:test'
import { submitTelegramMcpAuthorization } from './telegramMcpAuth.js'

describe('Telegram MCP authorization continuation', () => {
  test('continues from code to 2FA without exposing the supplied values', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const result = await submitTelegramMcpAuthorization({
      sessionName: 'account-1',
      code: '12345',
    }, async (name, args) => {
      calls.push({ name, args })
      return '2FA password required.'
    })

    expect(result).toEqual({ status: 'password_required', verified: false })
    expect(calls).toEqual([{
      name: 'authorize_complete',
      args: { session_name: 'account-1', code: '12345' },
    }])
    expect(JSON.stringify(result)).not.toContain('12345')
  })

  test('verifies an authorized account through the same MCP connection contract', async () => {
    const names: string[] = []
    const result = await submitTelegramMcpAuthorization({
      sessionName: 'account-1',
      code: '12345',
      password: 'secret',
    }, async name => {
      names.push(name)
      return name === 'authorize_complete'
        ? "Authorized as Test. Session 'account-1' saved and added to active pool."
        : 'Account is authorized and healthy.'
    })

    expect(result).toEqual({ status: 'authorized', verified: true })
    expect(names).toEqual(['authorize_complete', 'check_account'])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  test('does not verify negative authorization or health text', async () => {
    for (const verification of [
      'Error: session not authorized.',
      'Account is unauthorized and unhealthy.',
      'Status: not healthy.',
    ]) {
      const result = await submitTelegramMcpAuthorization({
        sessionName: 'account-1',
        code: '12345',
      }, async name => name === 'authorize_complete'
        ? "Authorized as Test. Session 'account-1' saved and added to active pool."
        : verification)
      expect(result).toEqual({ status: 'authorized', verified: false })
    }
  })
})
